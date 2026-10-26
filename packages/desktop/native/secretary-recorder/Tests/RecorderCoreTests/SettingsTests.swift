import XCTest
@testable import RecorderCore

final class SettingsTests: XCTestCase {
    private func settings(_ json: String) throws -> RecordingSettings {
        try parseRecordingSettings(try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
    }

    func testParsesTheFullStartPayloadElectronSends() throws {
        let parsed = try settings("""
        {"outputDirectory":"/Users/me/Movies/Secretary Recordings/2026-10-26 1430 Standup",
         "source":{"kind":"app","bundleId":"com.microsoft.teams2"},
         "video":{"enabled":true,"resolution":"720p","fps":60,"codec":"h264","bitrateKbps":4000},
         "systemAudio":"system","microphone":{"enabled":true,"deviceId":"BuiltInMicrophoneDevice"}}
        """)
        XCTAssertEqual(parsed, RecordingSettings(
            outputDirectory: "/Users/me/Movies/Secretary Recordings/2026-10-26 1430 Standup",
            source: .app(bundleID: "com.microsoft.teams2"),
            video: VideoSettings(enabled: true, resolution: .p720, fps: 60, codec: .h264, bitrateKbps: 4000),
            systemAudio: .system,
            microphone: MicrophoneSettings(enabled: true, deviceID: "BuiltInMicrophoneDevice")
        ))
        XCTAssertEqual(parsed.trackNames, ["video.mp4", "system.m4a", "mic.m4a"])
    }

    func testDefaultsForOmittedOptionalFields() throws {
        let parsed = try settings(#"{"outputDirectory":"/tmp/r","source":{"kind":"window","windowId":4242},"video":{"enabled":true}}"#)
        XCTAssertEqual(parsed.source, .window(id: 4242))
        XCTAssertEqual(parsed.video, VideoSettings(enabled: true, resolution: .p1080, fps: 30, codec: .hevc, bitrateKbps: 8000))
        XCTAssertEqual(parsed.systemAudio, .app)
        XCTAssertEqual(parsed.microphone, MicrophoneSettings(enabled: true, deviceID: nil))
    }

    func testAudioOnlyModeWritesOnlyTheTwoAudioTracks() throws {
        let parsed = try settings(#"{"outputDirectory":"/tmp/r","source":{"kind":"app","bundleId":"us.zoom.xos"},"video":{"enabled":false,"fps":7}}"#)
        XCTAssertFalse(parsed.video.enabled)
        XCTAssertEqual(parsed.trackNames, ["system.m4a", "mic.m4a"])
    }

    func testDisplaySourceRecordsSystemAudioWhenAppAudioIsRequested() throws {
        let parsed = try settings(#"{"outputDirectory":"/tmp/r","source":{"kind":"display","displayId":1},"video":{"enabled":false},"systemAudio":"app","microphone":{"enabled":false}}"#)
        XCTAssertEqual(parsed.effectiveSystemAudio, .system)
        XCTAssertEqual(parsed.trackNames, ["system.m4a"])
    }

    func testRejectsInvalidSettings() {
        let cases: [(String, SettingsError)] = [
            (#"{"source":{"kind":"display","displayId":1}}"#, .missing("outputDirectory")),
            (#"{"outputDirectory":"relative/path","source":{"kind":"display","displayId":1}}"#, .invalid("outputDirectory", "must be an absolute path without '..'")),
            (#"{"outputDirectory":"/a/../b","source":{"kind":"display","displayId":1}}"#, .invalid("outputDirectory", "must be an absolute path without '..'")),
            (#"{"outputDirectory":"/r"}"#, .missing("source")),
            (#"{"outputDirectory":"/r","source":{"kind":"tab"}}"#, .invalid("source.kind", "unknown kind 'tab'")),
            (#"{"outputDirectory":"/r","source":{"kind":"app","bundleId":""}}"#, .invalid("source.bundleId", "must be a bundle identifier")),
            (#"{"outputDirectory":"/r","source":{"kind":"window","windowId":-1}}"#, .invalid("source.windowId", "must be a whole number")),
            (#"{"outputDirectory":"/r","source":{"kind":"window","windowId":1.5}}"#, .invalid("source.windowId", "must be a whole number")),
            (#"{"outputDirectory":"/r","source":{"kind":"display"}}"#, .missing("source.displayId")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"video":{"enabled":true,"fps":24}}"#, .invalid("video.fps", "must be 15, 30 or 60")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"video":{"enabled":true,"fps":30.5}}"#, .invalid("video.fps", "must be 15, 30 or 60")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"video":{"enabled":true,"codec":"av1"}}"#, .invalid("video.codec", "unsupported value")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"video":{"enabled":true,"resolution":"4k"}}"#, .invalid("video.resolution", "unsupported value")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"video":{"enabled":true,"bitrateKbps":100}}"#, .invalid("video.bitrateKbps", "must be between 500 and 100000")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"video":{"enabled":true,"bitrateKbps":"fast"}}"#, .invalid("video.bitrateKbps", "must be a number")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"video":{"fps":30}}"#, .missing("video.enabled")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"systemAudio":"loud"}"#, .invalid("systemAudio", "unsupported value")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"microphone":{"enabled":true,"deviceId":7}}"#, .invalid("microphone.deviceId", "must be a device id or null")),
            (#"{"outputDirectory":"/r","source":{"kind":"display","displayId":1},"systemAudio":"off","microphone":{"enabled":false}}"#, .invalid("tracks", "enable video, system audio or the microphone")),
        ]
        for (json, expected) in cases {
            XCTAssertThrowsError(try settings(json), json) { error in
                XCTAssertEqual(error as? SettingsError, expected, json)
            }
        }
    }

    func testOutputDimensionsOnlyScaleDownAndStayEven() {
        let cases: [(Int, Int, Resolution, VideoCodec, Int, Int)] = [
            (3024, 1964, .native, .hevc, 3024, 1964),
            (3024, 1964, .p1080, .hevc, 1662, 1080),
            (3024, 1964, .p720, .h264, 1108, 720),
            (1280, 720, .p1080, .hevc, 1280, 720),
            (5120, 1440, .p1080, .hevc, 1920, 540),
            (1001, 1601, .p720, .hevc, 720, 1152),
            (801, 601, .native, .hevc, 802, 602),
            // Hardware H.264 tops out at 4096×2304, so native 5K and 6K are scaled to fit.
            (5120, 2880, .native, .h264, 4096, 2304),
            (6016, 3384, .native, .hevc, 6016, 3384),
            (3024, 1964, .native, .h264, 3024, 1964),
        ]
        for (width, height, resolution, codec, expectedWidth, expectedHeight) in cases {
            let size = outputDimensions(sourceWidth: width, sourceHeight: height, resolution: resolution, codec: codec)
            XCTAssertEqual(size.width, expectedWidth, "\(width)x\(height) \(resolution) \(codec)")
            XCTAssertEqual(size.height, expectedHeight, "\(width)x\(height) \(resolution) \(codec)")
        }
    }
}
