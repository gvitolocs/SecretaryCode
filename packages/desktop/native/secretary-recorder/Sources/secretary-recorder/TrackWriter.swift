#if os(macOS)
import AVFoundation
import CoreMedia
import Foundation
import RecorderCore

/// Writes one track to its own file. The file is created from the first sample's real format (the
/// microphone's channel count, the captured frame size), and every track starts its session at the
/// shared recording origin so the server can line the files up sample for sample.
final class TrackWriter {
    let name: String
    let url: URL
    private let video: VideoSettings?
    private let origin: CMTime
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var firstTime: CMTime?
    private var samples = 0
    private var dropped = 0

    init(name: String, url: URL, video: VideoSettings?, origin: CMTime) {
        self.name = name
        self.url = url
        self.video = video
        self.origin = origin
    }

    func append(_ buffer: CMSampleBuffer) throws {
        if writer == nil { try open(with: buffer) }
        guard let writer, let input else { return }
        guard writer.status == .writing else { throw RecorderError.writer(name, writer.error) }
        guard input.isReadyForMoreMediaData else {
            dropped += 1
            return
        }
        guard input.append(buffer) else { throw RecorderError.writer(name, writer.error) }
        if firstTime == nil { firstTime = CMSampleBufferGetPresentationTimeStamp(buffer) }
        samples += 1
    }

    func finish() async {
        guard let writer, let input, writer.status == .writing else { return }
        input.markAsFinished()
        await writer.finishWriting()
    }

    func fileSize() -> Int64 {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path), let size = attributes[.size] as? NSNumber else { return 0 }
        return size.int64Value
    }

    func summary() -> JSONValue {
        let status: String
        switch writer?.status {
        case .none: status = "empty"
        case .some(.completed): status = "complete"
        default: status = "failed"
        }
        return [
            "name": .string(name),
            "path": .string(url.path),
            "bytes": JSONValue(fileSize()),
            "status": .string(status),
            "samples": JSONValue(samples),
            "dropped": JSONValue(dropped),
            // Seconds between the recording origin and this track's first sample.
            "startOffset": firstTime.map { JSONValue(CMTimeSubtract($0, origin).seconds) } ?? .null,
            "error": JSONValue(writer?.error?.localizedDescription),
        ]
    }

    private func open(with buffer: CMSampleBuffer) throws {
        guard let format = CMSampleBufferGetFormatDescription(buffer) else { return }
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: video == nil ? .m4a : .mp4)
        let input: AVAssetWriterInput
        if let video {
            // Fragments keep the video playable up to the last 10 seconds if the helper is killed.
            writer.movieFragmentInterval = CMTime(seconds: 10, preferredTimescale: 600)
            let dimensions = CMVideoFormatDescriptionGetDimensions(format)
            input = AVAssetWriterInput(mediaType: .video, outputSettings: Self.videoSettings(video, width: Int(dimensions.width), height: Int(dimensions.height)))
        } else {
            let channels = Int(CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee.mChannelsPerFrame ?? 1)
            input = AVAssetWriterInput(mediaType: .audio, outputSettings: Self.audioSettings(channels: max(1, min(2, channels))))
        }
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw RecorderError.writer(name, writer.error) }
        writer.add(input)
        guard writer.startWriting() else { throw RecorderError.writer(name, writer.error) }
        writer.startSession(atSourceTime: origin)
        self.writer = writer
        self.input = input
    }

    /// AAC at 48 kHz, as the transcription pipeline expects.
    private static func audioSettings(channels: Int) -> [String: Any] {
        [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: channels == 1 ? 96_000 : 160_000,
        ]
    }

    private static func videoSettings(_ video: VideoSettings, width: Int, height: Int) -> [String: Any] {
        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: video.bitrateKbps * 1000,
            AVVideoExpectedSourceFrameRateKey: video.fps,
            AVVideoMaxKeyFrameIntervalKey: video.fps * 2,
        ]
        if video.codec == .h264 { compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }
        return [
            AVVideoCodecKey: video.codec == .hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: compression,
        ]
    }
}
#endif
