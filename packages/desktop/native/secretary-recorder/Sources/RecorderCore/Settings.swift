import Foundation

public enum CaptureSource: Equatable {
    case app(bundleID: String)
    case window(id: UInt32)
    case display(id: UInt32)
}

public enum Resolution: String, CaseIterable {
    case native
    case p1080 = "1080p"
    case p720 = "720p"
}

public enum VideoCodec: String, CaseIterable {
    case hevc
    case h264
}

/// Where the `system.m4a` track comes from: only the captured app, the whole Mac, or nowhere.
public enum SystemAudioMode: String, CaseIterable {
    case app
    case system
    case off
}

public struct VideoSettings: Equatable {
    public var enabled: Bool
    public var resolution: Resolution
    public var fps: Int
    public var codec: VideoCodec
    public var bitrateKbps: Int

    public static let disabled = VideoSettings(enabled: false, resolution: .p720, fps: 15, codec: .h264, bitrateKbps: 1000)

    public init(enabled: Bool, resolution: Resolution, fps: Int, codec: VideoCodec, bitrateKbps: Int) {
        self.enabled = enabled
        self.resolution = resolution
        self.fps = fps
        self.codec = codec
        self.bitrateKbps = bitrateKbps
    }
}

public struct MicrophoneSettings: Equatable {
    public var enabled: Bool
    /// An AVCaptureDevice unique ID (the Core Audio device UID). Nil records the default input.
    public var deviceID: String?

    public init(enabled: Bool, deviceID: String?) {
        self.enabled = enabled
        self.deviceID = deviceID
    }
}

public struct RecordingSettings: Equatable {
    public var outputDirectory: String
    public var source: CaptureSource
    public var video: VideoSettings
    public var systemAudio: SystemAudioMode
    public var microphone: MicrophoneSettings

    public init(outputDirectory: String, source: CaptureSource, video: VideoSettings, systemAudio: SystemAudioMode, microphone: MicrophoneSettings) {
        self.outputDirectory = outputDirectory
        self.source = source
        self.video = video
        self.systemAudio = systemAudio
        self.microphone = microphone
    }

    /// A display has no single owning app, so "this app's audio" means the whole system there.
    public var effectiveSystemAudio: SystemAudioMode {
        if case .display = source, systemAudio == .app { return .system }
        return systemAudio
    }

    /// The files this recording writes, in a stable order. The names are part of the upload contract.
    public var trackNames: [String] {
        (video.enabled ? [TrackName.video] : []) + (effectiveSystemAudio == .off ? [] : [TrackName.system]) + (microphone.enabled ? [TrackName.microphone] : [])
    }
}

public enum TrackName {
    public static let video = "video.mp4"
    public static let system = "system.m4a"
    public static let microphone = "mic.m4a"
}

public enum SettingsError: Error, Equatable, CustomStringConvertible {
    case missing(String)
    case invalid(String, String)

    public var description: String {
        switch self {
        case .missing(let field): return "Missing setting: \(field)"
        case .invalid(let field, let reason): return "Invalid setting \(field): \(reason)"
        }
    }
}

public let supportedFrameRates = [15, 30, 60]
public let bitrateRangeKbps = 500...100_000

/// Parses the `settings` object of a `start` command. Every field the Electron side sends is
/// validated here once; omitted optional fields take the documented defaults.
public func parseRecordingSettings(_ value: JSONValue) throws -> RecordingSettings {
    guard case .object = value else { throw SettingsError.invalid("settings", "must be an object") }

    guard let output = value["outputDirectory"]?.string else { throw SettingsError.missing("outputDirectory") }
    guard output.hasPrefix("/"), !output.contains("\u{0}"), !output.split(separator: "/").contains("..") else {
        throw SettingsError.invalid("outputDirectory", "must be an absolute path without '..'")
    }

    let settings = RecordingSettings(
        outputDirectory: output,
        source: try parseSource(value["source"]),
        video: try parseVideo(value["video"]),
        systemAudio: try parseSystemAudio(value["systemAudio"]),
        microphone: try parseMicrophone(value["microphone"])
    )
    if settings.trackNames.isEmpty { throw SettingsError.invalid("tracks", "enable video, system audio or the microphone") }
    return settings
}

private func parseSource(_ value: JSONValue?) throws -> CaptureSource {
    guard let value, case .object = value else { throw SettingsError.missing("source") }
    switch value["kind"]?.string {
    case "app":
        guard let bundle = value["bundleId"]?.string, !bundle.isEmpty, bundle.count <= 255 else { throw SettingsError.invalid("source.bundleId", "must be a bundle identifier") }
        return .app(bundleID: bundle)
    case "window":
        return .window(id: try parseIdentifier(value["windowId"], field: "source.windowId"))
    case "display":
        return .display(id: try parseIdentifier(value["displayId"], field: "source.displayId"))
    case .some(let kind):
        throw SettingsError.invalid("source.kind", "unknown kind '\(kind)'")
    case .none:
        throw SettingsError.missing("source.kind")
    }
}

private func parseIdentifier(_ value: JSONValue?, field: String) throws -> UInt32 {
    guard let number = value?.number else { throw SettingsError.missing(field) }
    guard number >= 0, number <= Double(UInt32.max), number.rounded() == number else { throw SettingsError.invalid(field, "must be a whole number") }
    return UInt32(number)
}

private func parseVideo(_ value: JSONValue?) throws -> VideoSettings {
    guard let value, !value.isNull else { return .disabled }
    guard case .object = value else { throw SettingsError.invalid("video", "must be an object") }
    guard let enabled = value["enabled"]?.bool else { throw SettingsError.missing("video.enabled") }
    if !enabled { return .disabled }

    let resolution = try parseEnum(value["resolution"], field: "video.resolution", default: Resolution.p1080)
    let codec = try parseEnum(value["codec"], field: "video.codec", default: VideoCodec.hevc)
    let fps = value["fps"].map { $0.number.flatMap { $0.rounded() == $0 ? Int(exactly: $0) : nil } ?? -1 } ?? 30
    guard supportedFrameRates.contains(fps) else { throw SettingsError.invalid("video.fps", "must be 15, 30 or 60") }
    guard let bitrate = value["bitrateKbps"].map({ $0.number }) ?? 8000 else { throw SettingsError.invalid("video.bitrateKbps", "must be a number") }
    guard bitrate.rounded() == bitrate, bitrateRangeKbps.contains(Int(bitrate)) else {
        throw SettingsError.invalid("video.bitrateKbps", "must be between \(bitrateRangeKbps.lowerBound) and \(bitrateRangeKbps.upperBound)")
    }
    return VideoSettings(enabled: true, resolution: resolution, fps: fps, codec: codec, bitrateKbps: Int(bitrate))
}

private func parseSystemAudio(_ value: JSONValue?) throws -> SystemAudioMode {
    try parseEnum(value, field: "systemAudio", default: SystemAudioMode.app)
}

private func parseMicrophone(_ value: JSONValue?) throws -> MicrophoneSettings {
    guard let value, !value.isNull else { return MicrophoneSettings(enabled: true, deviceID: nil) }
    guard case .object = value else { throw SettingsError.invalid("microphone", "must be an object") }
    guard let enabled = value["enabled"]?.bool else { throw SettingsError.missing("microphone.enabled") }
    switch value["deviceId"] {
    case .none, .some(.null): return MicrophoneSettings(enabled: enabled, deviceID: nil)
    case .some(.string(let id)) where !id.isEmpty && id.count <= 512: return MicrophoneSettings(enabled: enabled, deviceID: id)
    default: throw SettingsError.invalid("microphone.deviceId", "must be a device id or null")
    }
}

private func parseEnum<T: RawRepresentable>(_ value: JSONValue?, field: String, default fallback: T) throws -> T where T.RawValue == String {
    guard let value, !value.isNull else { return fallback }
    guard let raw = value.string, let parsed = T(rawValue: raw) else { throw SettingsError.invalid(field, "unsupported value") }
    return parsed
}

/// The encoded frame size for a source of `width`×`height` pixels. Presets only scale down, keep the
/// aspect ratio and round to even sizes, which every hardware encoder requires.
public func outputDimensions(sourceWidth: Int, sourceHeight: Int, resolution: Resolution, codec: VideoCodec) -> (width: Int, height: Int) {
    let box: (Double, Double)? = switch (resolution, codec) {
    case (.p1080, _): (1920, 1080)
    case (.p720, _): (1280, 720)
    // Hardware H.264 stops at 4096×2304; a 5K or 6K display at native size would fail on the first frame.
    case (.native, .h264): (4096, 2304)
    case (.native, .hevc): nil
    }
    let width = Double(max(sourceWidth, 2))
    let height = Double(max(sourceHeight, 2))
    // Compare the long side with the long side so portrait windows are not squeezed into a landscape box.
    let scale = box.map { box in
        let long = max(box.0, box.1), short = min(box.0, box.1)
        return min(1, long / max(width, height), short / min(width, height))
    } ?? 1
    return (even(width * scale), even(height * scale))
}

private func even(_ value: Double) -> Int { max(2, Int((value / 2).rounded()) * 2) }
