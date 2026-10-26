#if os(macOS)
import AppKit
import AVFoundation
import Foundation
import RecorderCore

/// Owns at most one capture session. Every method runs on the main queue; capture work hops to the
/// session's sample queue and reports back through `Output`.
final class Controller {
    private var session: CaptureSession?
    private var statusTimer: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []
    private var exiting = false

    func announce() {
        Output.send(Message.event("ready", [
            "version": "1.0.0",
            "macos": .string(ProcessInfo.processInfo.operatingSystemVersionString),
            "nativeMicrophone": .bool(CaptureSession.supportsNativeMicrophone),
        ]))
        Output.send(Message.event("permissions", Permissions.snapshot()))
        watchApplications()
    }

    func handle(line: String) {
        let request: Request
        do {
            request = try parseRequest(line)
        } catch let error as ProtocolError {
            if let id = error.id { Output.send(Message.failure(id, code: error.code, message: error.message)) }
            else { Output.send(Message.event("error", ["code": .string(error.code), "message": .string(error.message), "fatal": false])) }
            return
        } catch {
            return
        }

        let id = request.id
        switch request.command {
        case .listSources:
            Task {
                Output.send(Message.result(id, await SourceCatalog.list()))
            }
        case .runningApps:
            Output.send(Message.result(id, ["apps": .array(SourceCatalog.runningApps())]))
        case .permissions:
            Output.send(Message.result(id, Permissions.snapshot()))
        case .requestPermission(let permission):
            Task {
                await Permissions.request(permission)
                let snapshot = Permissions.snapshot()
                Output.send(Message.event("permissions", snapshot))
                Output.send(Message.result(id, snapshot))
            }
        case .start(let settings):
            start(id: id, settings: settings)
        case .pause, .resume:
            guard let session else { return fail(id, RecorderError.notRecording) }
            if request.command == .pause { session.pause() } else { session.resume() }
            Output.send(Message.result(id))
            sendStatus()
        case .stop:
            guard let session else { return fail(id, RecorderError.notRecording) }
            finish(session, reply: id, error: nil)
        }
    }

    /// stdin closed. Stop any recording cleanly, then exit.
    func shutdown() {
        exiting = true
        guard let session else { exit(0) }
        finish(session, reply: nil, error: nil)
    }

    private func start(id: String, settings: RecordingSettings) {
        guard session == nil else { return fail(id, RecorderError.busy) }
        guard Permissions.screenGranted() else {
            // Shows the system prompt the first time; afterwards the owner must use System Settings.
            Permissions.requestScreenPrompt()
            Output.send(Message.event("permissions", Permissions.snapshot()))
            return fail(id, RecorderError.screenPermission)
        }

        let session = CaptureSession(settings: settings)
        self.session = session
        session.onFailure = { [weak self, weak session] error in
            DispatchQueue.main.async {
                guard let self, let session, self.session === session else { return }
                self.finish(session, reply: nil, error: error)
            }
        }
        Task {
            do {
                if settings.microphone.enabled, !(await Permissions.microphoneAllowed()) { throw RecorderError.microphonePermission }
                let info = try await session.start()
                DispatchQueue.main.async { self.startStatusTimer() }
                Output.send(Message.result(id, info))
                Output.send(Message.event("started", info.objectFields))
            } catch {
                await session.stop()
                DispatchQueue.main.async { if self.session === session { self.session = nil } }
                Output.send(Message.event("permissions", Permissions.snapshot()))
                fail(id, error)
            }
        }
    }

    private func finish(_ session: CaptureSession, reply id: String?, error: Error?) {
        guard !session.isStopping else { return }
        session.isStopping = true
        stopStatusTimer()
        if let error {
            let failure = RecorderError.from(error)
            Output.send(Message.event("error", ["code": .string(failure.code), "message": .string(failure.message), "fatal": true]))
        }
        Task {
            let summary = await session.stop()
            Output.send(Message.event("stopped", summary.objectFields))
            if let id { Output.send(Message.result(id, summary)) }
            DispatchQueue.main.async {
                if self.session === session { self.session = nil }
                if self.exiting { exit(0) }
            }
        }
    }

    private func fail(_ id: String, _ error: Error) {
        let failure = RecorderError.from(error)
        Output.send(Message.failure(id, code: failure.code, message: failure.message))
    }

    private func startStatusTimer() {
        stopStatusTimer()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(500))
        timer.setEventHandler { [weak self] in self?.sendStatus() }
        timer.resume()
        statusTimer = timer
    }

    private func stopStatusTimer() {
        statusTimer?.cancel()
        statusTimer = nil
    }

    private func sendStatus() {
        guard let session, !session.isStopping else { return }
        Output.send(Message.event("status", session.status().objectFields))
    }

    /// Lets Secretary Code suggest a recording when a meeting app opens. It never starts one.
    private func watchApplications() {
        let center = NSWorkspace.shared.notificationCenter
        for (name, event) in [(NSWorkspace.didLaunchApplicationNotification, "app-launched"), (NSWorkspace.didTerminateApplicationNotification, "app-terminated")] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { notification in
                guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, let bundle = app.bundleIdentifier else { return }
                Output.send(Message.event(event, ["bundleId": .string(bundle), "name": JSONValue(app.localizedName)]))
            })
        }
    }
}

extension JSONValue {
    var objectFields: [String: JSONValue] {
        if case .object(let fields) = self { return fields }
        return [:]
    }
}
#endif
