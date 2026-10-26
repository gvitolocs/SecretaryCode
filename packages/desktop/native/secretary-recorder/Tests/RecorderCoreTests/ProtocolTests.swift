import XCTest
@testable import RecorderCore

final class ProtocolTests: XCTestCase {
    func testParsesEveryCommand() throws {
        let cases: [(String, Command)] = [
            (#"{"id":"1","cmd":"list-sources"}"#, .listSources),
            (#"{"id":"2","cmd":"running-apps"}"#, .runningApps),
            (#"{"id":"3","cmd":"permissions"}"#, .permissions),
            (#"{"id":"4","cmd":"request-permission","permission":"microphone"}"#, .requestPermission(.microphone)),
            (#"{"id":"5","cmd":"pause"}"#, .pause),
            (#"{"id":"6","cmd":"resume"}"#, .resume),
            (#"{"id":"7","cmd":"stop"}"#, .stop),
        ]
        for (line, command) in cases {
            XCTAssertEqual(try parseRequest(line).command, command, line)
        }
        let start = try parseRequest(#"{"id":"8","cmd":"start","settings":{"outputDirectory":"/r","source":{"kind":"display","displayId":2}}}"#)
        XCTAssertEqual(start.id, "8")
        guard case .start(let settings) = start.command else { return XCTFail("expected start") }
        XCTAssertEqual(settings.source, .display(id: 2))
    }

    func testReportsErrorsWithTheRequestIDWhenThereIsOne() {
        let cases: [(String, ProtocolError)] = [
            ("not json", .malformed),
            (#"["list-sources"]"#, .malformed),
            (#"{"cmd":"stop"}"#, .malformed),
            (#"{"id":"9","cmd":"explode"}"#, .unknownCommand(id: "9", name: "explode")),
            (#"{"id":"10"}"#, .unknownCommand(id: "10", name: "")),
            (#"{"id":"11","cmd":"request-permission","permission":"camera"}"#, .invalidArgument(id: "11", "permission must be 'screen' or 'microphone'")),
            (#"{"id":"12","cmd":"start"}"#, .invalidSettings(id: "12", .invalid("settings", "must be an object"))),
        ]
        for (line, expected) in cases {
            XCTAssertThrowsError(try parseRequest(line), line) { error in
                XCTAssertEqual(error as? ProtocolError, expected, line)
                XCTAssertEqual((error as? ProtocolError)?.id, expected.id)
            }
        }
    }

    func testEncodesOutputLinesElectronParses() {
        XCTAssertEqual(encodeLine(Message.result("3", ["bytes": 1024])), #"{"id":"3","ok":true,"result":{"bytes":1024}}"#)
        XCTAssertEqual(encodeLine(Message.failure("4", code: "permission-screen", message: "Screen Recording is off")), #"{"error":{"code":"permission-screen","message":"Screen Recording is off"},"id":"4","ok":false}"#)
        XCTAssertEqual(encodeLine(Message.event("status", ["elapsed": 1.5, "path": "/a/b", "level": .number(-.infinity)])), #"{"elapsed":1.5,"event":"status","level":null,"path":"/a/b"}"#)
    }

    func testLevelMeter() {
        XCTAssertEqual(levelDecibels([Float]()), -80)
        XCTAssertEqual(levelDecibels([Float](repeating: 0, count: 64)), -80)
        XCTAssertEqual(levelDecibels([Float](repeating: 1, count: 64)), 0, accuracy: 0.0001)
        XCTAssertEqual(levelDecibels([Float](repeating: 0.1, count: 64)), -20, accuracy: 0.0001)
        XCTAssertEqual(levelDecibels([Float](repeating: 2, count: 64)), 0)
    }
}
