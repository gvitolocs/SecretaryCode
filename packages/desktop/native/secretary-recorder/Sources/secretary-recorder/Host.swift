#if os(macOS)
import AppKit
import AVFoundation
import CoreMedia
import Foundation
import RecorderCore
import ScreenCaptureKit

/// Thread-safe JSON-lines writer for stdout. A closed pipe means Electron is gone; writes are dropped.
enum Output {
    private static let lock = NSLock()

    static func send(_ value: JSONValue) {
        let data = Data((encodeLine(value) + "\n").utf8)
        lock.lock()
        defer { lock.unlock() }
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
}

struct RecorderError: Error {
    let code: String
    let message: String

    static let busy = RecorderError(code: "busy", message: "A recording is already running")
    static let notRecording = RecorderError(code: "not-recording", message: "No recording is running")
    static let screenPermission = RecorderError(code: "permission-screen", message: "Screen Recording is not allowed for Secretary Code")
    static let microphonePermission = RecorderError(code: "permission-microphone", message: "Microphone access is not allowed for Secretary Code")
    static let microphoneUnavailable = RecorderError(code: "microphone-unavailable", message: "The selected microphone is not available")

    static func sourceNotFound(_ source: String) -> RecorderError {
        RecorderError(code: "source-not-found", message: "\(source) is no longer available")
    }

    static func writer(_ track: String, _ error: Error?) -> RecorderError {
        RecorderError(code: "writer-failed", message: "Could not write \(track): \(error?.localizedDescription ?? "unknown error")")
    }

    /// Maps any thrown error onto a stable code Electron can show as a clear state.
    static func from(_ error: Error) -> RecorderError {
        if let error = error as? RecorderError { return error }
        let nsError = error as NSError
        if nsError.domain == SCStreamErrorDomain, nsError.code == SCStreamError.Code.userDeclined.rawValue { return .screenPermission }
        return RecorderError(code: "capture-failed", message: error.localizedDescription)
    }
}

/// Seconds on the host clock, the clock every ScreenCaptureKit and AVAudioEngine timestamp uses.
func hostSeconds() -> Double {
    CMClockGetTime(CMClockGetHostTimeClock()).seconds
}

enum Host {
    static func run() -> Never {
        // Electron may exit first; a write to the closed pipe must fail instead of killing the helper
        // before it finalizes the recording.
        signal(SIGPIPE, SIG_IGN)
        // NSScreen, NSWorkspace notifications and ScreenCaptureKit expect an application object
        // (and its window-server connection); the helper never shows UI or a Dock icon.
        NSApplication.shared.setActivationPolicy(.prohibited)
        let controller = Controller()
        controller.announce()
        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                if line.allSatisfy(\.isWhitespace) { continue }
                DispatchQueue.main.async { controller.handle(line: line) }
            }
            // stdin closed: Secretary Code quit or crashed. Finish the files so the recording survives.
            DispatchQueue.main.async { controller.shutdown() }
        }
        RunLoop.main.run()
        exit(0)
    }
}
#endif
