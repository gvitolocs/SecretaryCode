/// Maps capture timestamps (host-clock seconds, shared by every ScreenCaptureKit and AVAudioEngine
/// buffer) onto the output timeline, removing pauses so all tracks stay aligned with each other.
///
/// Buffers can arrive after `resume` with timestamps from inside the pause, so every pause interval is
/// kept instead of only a running total.
public struct Timeline: Equatable {
    public private(set) var origin: Double?
    private var pauses: [(start: Double, end: Double?)] = []

    public init() {}

    public var isStarted: Bool { origin != nil }
    public var isPaused: Bool { pauses.last.map { $0.end == nil } ?? false }

    public mutating func start(at time: Double) {
        origin = time
        pauses = []
    }

    public mutating func pause(at time: Double) {
        guard isStarted, !isPaused else { return }
        pauses.append((time, nil))
    }

    public mutating func resume(at time: Double) {
        guard isPaused, let index = pauses.indices.last else { return }
        pauses[index].end = max(time, pauses[index].start)
    }

    /// The output timestamp for a sample captured at `time`, or nil when it must be dropped because
    /// it precedes the start or falls inside a pause.
    public func map(_ time: Double) -> Double? {
        guard let origin, time >= origin else { return nil }
        var removed = 0.0
        for pause in pauses {
            guard time >= pause.start else { break }
            guard let end = pause.end, time >= end else { return nil }
            removed += end - pause.start
        }
        return time - removed
    }

    /// The output timestamp for a buffer covering `start`..<`end`, or nil when any of it falls
    /// before the start or inside a pause.
    public func map(start: Double, end: Double) -> Double? {
        guard let mapped = map(start) else { return nil }
        guard end > start else { return mapped }
        // Probe just before `end`: a buffer ending exactly where a pause starts is complete.
        let last = end - min(1e-6, (end - start) / 2)
        guard let mappedLast = map(last), abs((last - mappedLast) - (start - mapped)) < 1e-9 else { return nil }
        return mapped
    }

    /// Recorded seconds so far, excluding pauses.
    public func elapsed(at now: Double) -> Double {
        guard let origin else { return 0 }
        let paused = pauses.reduce(0.0) { $0 + (min($1.end ?? now, now) - min($1.start, now)) }
        return max(0, now - origin - paused)
    }

    public static func == (lhs: Timeline, rhs: Timeline) -> Bool {
        lhs.origin == rhs.origin && lhs.pauses.count == rhs.pauses.count && zip(lhs.pauses, rhs.pauses).allSatisfy { $0.start == $1.start && $0.end == $1.end }
    }
}
