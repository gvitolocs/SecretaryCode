import XCTest
@testable import RecorderCore

final class TimelineTests: XCTestCase {
    func testDropsSamplesBeforeStartAndDuringPauses() {
        var timeline = Timeline()
        XCTAssertNil(timeline.map(5))
        timeline.start(at: 100)
        XCTAssertNil(timeline.map(99.9))
        XCTAssertEqual(timeline.map(100), 100)
        timeline.pause(at: 110)
        XCTAssertTrue(timeline.isPaused)
        XCTAssertEqual(timeline.map(109.99), 109.99)
        XCTAssertNil(timeline.map(112))
        timeline.resume(at: 115)
        // A buffer delivered after resume but captured during the pause is still dropped.
        XCTAssertNil(timeline.map(114))
        XCTAssertEqual(timeline.map(115), 110)
        XCTAssertEqual(timeline.map(120), 115)
        timeline.pause(at: 130)
        timeline.resume(at: 140)
        XCTAssertEqual(timeline.map(141), 126)
    }

    func testDropsBuffersThatRunIntoAPause() {
        var timeline = Timeline()
        timeline.start(at: 100)
        timeline.pause(at: 110)
        timeline.resume(at: 120)
        // 20 ms audio buffers at host-clock scale, where rounding matters.
        XCTAssertEqual(timeline.map(start: 109.98, end: 110.0), 109.98)
        XCTAssertNil(timeline.map(start: 109.99, end: 110.01))
        XCTAssertNil(timeline.map(start: 119.99, end: 120.01))
        XCTAssertEqual(timeline.map(start: 120.0, end: 120.02)!, 110.0, accuracy: 1e-9)
        XCTAssertEqual(timeline.map(start: 105, end: 105), 105)

        // Host-clock seconds are large, where floating-point rounding could hide a pause boundary.
        var host = Timeline()
        host.start(at: 734_512.0)
        host.pause(at: 734_522.5)
        host.resume(at: 734_530.0)
        XCTAssertNotNil(host.map(start: 734_522.48, end: 734_522.5))
        XCTAssertNil(host.map(start: 734_522.49, end: 734_522.51))
        XCTAssertEqual(host.map(start: 734_530.0, end: 734_530.02)!, 734_522.5, accuracy: 1e-6)
    }

    func testElapsedExcludesPauses() {
        var timeline = Timeline()
        XCTAssertEqual(timeline.elapsed(at: 50), 0)
        timeline.start(at: 100)
        XCTAssertEqual(timeline.elapsed(at: 110), 10)
        timeline.pause(at: 110)
        XCTAssertEqual(timeline.elapsed(at: 125), 10)
        timeline.resume(at: 130)
        XCTAssertEqual(timeline.elapsed(at: 140), 20)
    }

    func testIgnoresRedundantPauseAndResume() {
        var timeline = Timeline()
        timeline.pause(at: 1)
        XCTAssertFalse(timeline.isPaused)
        timeline.start(at: 10)
        timeline.resume(at: 11)
        timeline.pause(at: 12)
        timeline.pause(at: 13)
        timeline.resume(at: 14)
        timeline.resume(at: 20)
        XCTAssertEqual(timeline.elapsed(at: 24), 12)
    }
}
