#if os(macOS)
import AppKit
import AVFoundation
import CoreMedia
import Foundation
import RecorderCore
import ScreenCaptureKit

/// One recording: up to two ScreenCaptureKit streams (the chosen source, plus the whole display when
/// system audio is wanted for an app or window) and an optional AVAudioEngine microphone fallback,
/// each feeding its own file through the shared timeline so pauses stay aligned across tracks.
final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    static var supportsNativeMicrophone: Bool {
        if #available(macOS 15.0, *) { return true }
        return false
    }

    let settings: RecordingSettings
    var onFailure: ((Error) -> Void)?
    /// Read and written on the main queue only; set when a stop begins so it runs once.
    var isStopping = false

    private let queue = DispatchQueue(label: "app.secretary.recorder.samples", qos: .userInitiated)
    // Confined to `queue`.
    private var timeline = Timeline()
    private var writers: [String: TrackWriter] = [:]
    private var levels: [String: Double] = [:]
    private var accepting = false
    private var failed = false
    private var stopTask: Task<JSONValue, Never>?

    private var mainStream: SCStream?
    private var systemStream: SCStream?
    private var microphone: MicrophoneEngine?
    private var startedAt = Date()
    private var source: [String: JSONValue] = [:]

    init(settings: RecordingSettings) {
        self.settings = settings
    }

    func start() async throws -> JSONValue {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let target = try Target.resolve(settings.source, in: content)
        let directory = URL(fileURLWithPath: settings.outputDirectory, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let systemAudio = settings.effectiveSystemAudio
        // A content filter decides both picture and sound, so "whole system" audio for an app or a
        // window needs its own display-wide, audio-only stream.
        let separateSystemStream = systemAudio == .system && !target.isDisplay
        let nativeMicrophone = settings.microphone.enabled && Self.supportsNativeMicrophone
        let size = settings.video.enabled
            ? outputDimensions(sourceWidth: target.pixelWidth, sourceHeight: target.pixelHeight, resolution: settings.video.resolution, codec: settings.video.codec)
            : (width: 2, height: 2)

        let config = Self.configuration(width: size.width, height: size.height, fps: settings.video.enabled ? settings.video.fps : 1, audio: systemAudio != .off && !separateSystemStream)
        if nativeMicrophone, #available(macOS 15.0, *) {
            config.captureMicrophone = true
            config.microphoneCaptureDeviceID = settings.microphone.deviceID
        }
        let main = SCStream(filter: target.filter, configuration: config, delegate: self)
        // A screen output is always attached: without one ScreenCaptureKit logs every dropped frame.
        try main.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if config.capturesAudio { try main.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
        if nativeMicrophone, #available(macOS 15.0, *) { try main.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }

        var system: SCStream?
        if separateSystemStream {
            let filter = SCContentFilter(display: target.display, excludingApplications: [], exceptingWindows: [])
            let stream = SCStream(filter: filter, configuration: Self.configuration(width: 2, height: 2, fps: 1, audio: true), delegate: self)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            system = stream
        }

        let origin = hostSeconds()
        let originTime = CMTime(seconds: origin, preferredTimescale: 1_000_000_000)
        let writers = Dictionary(uniqueKeysWithValues: settings.trackNames.map { name in
            (name, TrackWriter(name: name, url: directory.appendingPathComponent(name), video: name == TrackName.video ? settings.video : nil, origin: originTime))
        })
        mainStream = main
        systemStream = system
        source = target.description
        startedAt = Date()
        queue.sync {
            self.writers = writers
            self.timeline.start(at: origin)
            self.accepting = true
        }

        try await main.startCapture()
        if let system { try await system.startCapture() }
        if settings.microphone.enabled, !nativeMicrophone {
            let engine = try MicrophoneEngine(deviceID: settings.microphone.deviceID, queue: queue) { [weak self] buffer in
                self?.append(buffer, to: TrackName.microphone, meter: "mic")
            }
            try engine.start()
            microphone = engine
        }

        return [
            "startedAt": .string(iso8601(startedAt)),
            "directory": .string(settings.outputDirectory),
            "tracks": .array(settings.trackNames.map(JSONValue.string)),
            "source": .object(source),
            "nativeMicrophone": .bool(nativeMicrophone),
        ]
    }

    func pause() {
        let now = hostSeconds()
        queue.sync {
            timeline.pause(at: now)
            levels = [:]
        }
    }

    func resume() {
        let now = hostSeconds()
        queue.sync { timeline.resume(at: now) }
    }

    func status() -> JSONValue {
        let now = hostSeconds()
        let snapshot = queue.sync { (elapsed: timeline.elapsed(at: now), paused: timeline.isPaused, levels: levels, writers: Array(writers.values)) }
        return [
            "state": snapshot.paused ? "paused" : "recording",
            "elapsed": .number(snapshot.elapsed),
            "levels": .object(snapshot.levels.mapValues(JSONValue.number)),
            "files": .object(Dictionary(uniqueKeysWithValues: snapshot.writers.map { ($0.name, JSONValue($0.fileSize())) })),
        ]
    }

    /// Stops capture and finalizes every file. Safe to call after a failed or partial start, and
    /// more than once: every caller awaits the same stop, because finishing an AVAssetWriter twice
    /// raises an Objective-C exception.
    @discardableResult
    func stop() async -> JSONValue {
        let task = queue.sync { () -> Task<JSONValue, Never> in
            if let stopTask { return stopTask }
            let task = Task { await self.finishCapture() }
            stopTask = task
            return task
        }
        return await task.value
    }

    private func finishCapture() async -> JSONValue {
        let ended = hostSeconds()
        let endedAt = Date()
        if let mainStream { try? await mainStream.stopCapture() }
        if let systemStream { try? await systemStream.stopCapture() }
        microphone?.stop()
        let snapshot = queue.sync { () -> (writers: [TrackWriter], elapsed: Double) in
            accepting = false
            return (writers.values.sorted { $0.name < $1.name }, timeline.elapsed(at: ended))
        }
        var tracks: [JSONValue] = []
        for writer in snapshot.writers {
            await writer.finish()
            tracks.append(writer.summary())
        }
        return [
            "startedAt": .string(iso8601(startedAt)),
            "endedAt": .string(iso8601(endedAt)),
            "duration": .number(snapshot.elapsed),
            "directory": .string(settings.outputDirectory),
            "tracks": .array(tracks),
            "source": .object(source),
        ]
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }
        if type == .screen {
            guard stream === mainStream, settings.video.enabled, Self.isCompleteFrame(sampleBuffer) else { return }
            append(sampleBuffer, to: TrackName.video, meter: nil)
        } else if type == .audio {
            append(sampleBuffer, to: TrackName.system, meter: "system")
        } else if #available(macOS 15.0, *), type == .microphone {
            append(sampleBuffer, to: TrackName.microphone, meter: "mic")
        }
    }

    // MARK: SCStreamDelegate

    /// Also called when the owner stops sharing from the menu bar; the recording then ends normally.
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onFailure?(error)
    }

    // MARK: Samples (on `queue`)

    private func append(_ buffer: CMSampleBuffer, to name: String, meter: String?) {
        guard accepting, !failed, let writer = writers[name] else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(buffer)
        let duration = CMSampleBufferGetDuration(buffer)
        // Audio buffers span time; one that runs into a pause would overlap the first buffer after it.
        let end = duration.isNumeric ? time.seconds + duration.seconds : time.seconds
        guard time.isNumeric, let mapped = timeline.map(start: time.seconds, end: end) else { return }
        if let meter, let level = Self.level(of: buffer) { levels[meter] = level }
        let shift = time.seconds - mapped
        let output: CMSampleBuffer? = shift > 0 ? buffer.shifted(back: CMTime(seconds: shift, preferredTimescale: 1_000_000_000)) : buffer
        guard let output else { return }
        do {
            try writer.append(output)
        } catch {
            failed = true
            onFailure?(error)
        }
    }

    private static func configuration(width: Int, height: Int, fps: Int, audio: Bool) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.queueDepth = 6
        config.showsCursor = true
        config.scalesToFit = true
        config.capturesAudio = audio
        config.sampleRate = 48_000
        config.channelCount = 2
        config.excludesCurrentProcessAudio = true
        return config
    }

    /// ScreenCaptureKit also delivers idle and blank frames; only complete frames carry new pixels.
    private static func isCompleteFrame(_ buffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: raw) else { return false }
        return status == .complete
    }

    private static func level(of buffer: CMSampleBuffer) -> Double? {
        guard let description = buffer.formatDescription?.audioStreamBasicDescription,
              description.mFormatID == kAudioFormatLinearPCM,
              description.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              description.mBitsPerChannel == 32 else { return nil }
        return try? buffer.withAudioBufferList { list, _ -> Double in
            guard let first = list.first, let data = first.mData else { return -80 }
            let samples = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: Int(first.mDataByteSize) / MemoryLayout<Float>.size)
            return levelDecibels(samples)
        }
    }
}

/// The resolved ScreenCaptureKit filter for a source, with its size in pixels.
struct Target {
    let filter: SCContentFilter
    let display: SCDisplay
    let pixelWidth: Int
    let pixelHeight: Int
    let isDisplay: Bool
    let description: [String: JSONValue]

    static func resolve(_ source: CaptureSource, in content: SCShareableContent) throws -> Target {
        switch source {
        case .app(let bundleID):
            guard let app = content.applications.first(where: { $0.bundleIdentifier == bundleID }) else { throw RecorderError.sourceNotFound(bundleID) }
            let largest = content.windows
                .filter { $0.owningApplication?.processID == app.processID && $0.windowLayer == 0 }
                .max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
            guard let display = displayContaining(largest?.frame, in: content.displays) else { throw RecorderError.sourceNotFound("display") }
            // Including the app (not one window) follows it across its windows and captures only its audio.
            let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
            let size = pixelSize(filter, points: display.frame.size, displayID: display.displayID)
            return Target(filter: filter, display: display, pixelWidth: size.width, pixelHeight: size.height, isDisplay: false,
                          description: ["kind": "app", "bundleId": .string(bundleID), "name": .string(app.applicationName)])
        case .window(let id):
            guard let window = content.windows.first(where: { $0.windowID == id }) else { throw RecorderError.sourceNotFound("window") }
            guard let display = displayContaining(window.frame, in: content.displays) else { throw RecorderError.sourceNotFound("display") }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let size = pixelSize(filter, points: window.frame.size, displayID: display.displayID)
            return Target(filter: filter, display: display, pixelWidth: size.width, pixelHeight: size.height, isDisplay: false, description: [
                "kind": "window", "windowId": JSONValue(Int(id)), "title": JSONValue(window.title),
                "bundleId": JSONValue(window.owningApplication?.bundleIdentifier), "name": JSONValue(window.owningApplication?.applicationName),
            ])
        case .display(let id):
            guard let display = content.displays.first(where: { $0.displayID == id }) else { throw RecorderError.sourceNotFound("display") }
            let own = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
            let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
            let size = pixelSize(filter, points: display.frame.size, displayID: id)
            return Target(filter: filter, display: display, pixelWidth: size.width, pixelHeight: size.height, isDisplay: true,
                          description: ["kind": "display", "displayId": JSONValue(Int(id)), "name": JSONValue(screen(for: id)?.localizedName)])
        }
    }

    private static func displayContaining(_ frame: CGRect?, in displays: [SCDisplay]) -> SCDisplay? {
        if let frame, let match = displays.first(where: { $0.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) }) { return match }
        return displays.first { $0.displayID == CGMainDisplayID() } ?? displays.first
    }

    private static func pixelSize(_ filter: SCContentFilter, points: CGSize, displayID: CGDirectDisplayID) -> (width: Int, height: Int) {
        if #available(macOS 14.0, *) {
            let scale = CGFloat(filter.pointPixelScale)
            return (Int(filter.contentRect.width * scale), Int(filter.contentRect.height * scale))
        }
        let scale = screen(for: displayID)?.backingScaleFactor ?? 2
        return (Int(points.width * scale), Int(points.height * scale))
    }
}

func screen(for displayID: CGDirectDisplayID) -> NSScreen? {
    NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID }
}

func iso8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

extension CMSampleBuffer {
    /// A copy whose timestamps are moved earlier by `offset`, used to close the gap a pause leaves.
    func shifted(back offset: CMTime) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        guard CMSampleBufferGetSampleTimingInfoArray(self, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count) == noErr, count > 0 else { return nil }
        var timings = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        guard CMSampleBufferGetSampleTimingInfoArray(self, entryCount: count, arrayToFill: &timings, entriesNeededOut: &count) == noErr else { return nil }
        for index in timings.indices {
            timings[index].presentationTimeStamp = CMTimeSubtract(timings[index].presentationTimeStamp, offset)
            if timings[index].decodeTimeStamp.isValid {
                timings[index].decodeTimeStamp = CMTimeSubtract(timings[index].decodeTimeStamp, offset)
            }
        }
        var output: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: self, sampleTimingEntryCount: count, sampleTimingArray: &timings, sampleBufferOut: &output) == noErr else { return nil }
        return output
    }
}
#endif
