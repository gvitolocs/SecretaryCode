#if os(macOS)
import AudioToolbox
import AVFoundation
import CoreAudio
import CoreMedia
import Foundation

/// Microphone capture for macOS 13 and 14, where ScreenCaptureKit cannot record the microphone.
/// Buffers are converted to 48 kHz mono float and stamped with host time, the same clock the
/// ScreenCaptureKit buffers use, so `mic.m4a` lines up with `system.m4a`.
final class MicrophoneEngine {
    private let engine = AVAudioEngine()
    private let queue: DispatchQueue
    private let handler: (CMSampleBuffer) -> Void
    private let format: AVAudioFormat
    private var converter: AVAudioConverter?
    /// Where the previous converted buffer ended. Resampling changes buffer lengths, so stamping each
    /// buffer with its input's host time would leave small gaps and overlaps between buffers.
    private var nextTime: CMTime?

    init(deviceID: String?, queue: DispatchQueue, handler: @escaping (CMSampleBuffer) -> Void) throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false) else { throw RecorderError.microphoneUnavailable }
        self.format = format
        self.queue = queue
        self.handler = handler
        if let deviceID { try select(deviceUID: deviceID) }
    }

    func start() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { throw RecorderError.microphoneUnavailable }
        converter = AVAudioConverter(from: inputFormat, to: format)
        input.installTap(onBus: 0, bufferSize: 4800, format: inputFormat) { [weak self] buffer, time in
            self?.process(buffer, at: time)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func process(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        guard let converter, time.isHostTimeValid else { return }
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate).rounded(.up)) + 64
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, converted.frameLength > 0 else { return }
        let captured = CMClockMakeHostTimeFromSystemUnits(time.hostTime)
        // Follow on from the previous buffer unless the device clock drifted or input stalled.
        let start = nextTime.map { abs(CMTimeSubtract($0, captured).seconds) < 0.1 ? $0 : captured } ?? captured
        nextTime = CMTimeAdd(start, CMTime(value: CMTimeValue(converted.frameLength), timescale: CMTimeScale(format.sampleRate)))
        guard let sample = converted.sampleBuffer(at: start) else { return }
        queue.async { self.handler(sample) }
    }

    /// Points the engine's input unit at the device whose Core Audio UID matches AVCaptureDevice.uniqueID.
    private func select(deviceUID: String) throws {
        var uid = deviceUID as CFString
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslateUIDToDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = withUnsafeMutablePointer(to: &uid) { pointer in
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<CFString>.size), pointer, &size, &device)
        }
        guard status == noErr, device != 0, let unit = engine.inputNode.audioUnit else { throw RecorderError.microphoneUnavailable }
        let result = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard result == noErr else { throw RecorderError.microphoneUnavailable }
    }
}

extension AVAudioPCMBuffer {
    /// Wraps a copy of these frames in a sample buffer starting at `time`.
    func sampleBuffer(at time: CMTime) -> CMSampleBuffer? {
        var description: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description) == noErr,
              let description else { return nil }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(format.sampleRate)), presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil, formatDescription: description,
                                   sampleCount: CMItemCount(frameLength), sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample) == noErr,
              let sample,
              CMSampleBufferSetDataBufferFromAudioBufferList(sample, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: audioBufferList) == noErr else { return nil }
        return sample
    }
}
#endif
