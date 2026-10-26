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
