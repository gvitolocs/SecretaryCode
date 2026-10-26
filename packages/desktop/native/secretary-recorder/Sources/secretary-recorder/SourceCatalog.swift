#if os(macOS)
import AppKit
import AVFoundation
import Foundation
import RecorderCore
import ScreenCaptureKit

enum SourceCatalog {
    private static var icons: [String: String] = [:]
    private static let iconLock = NSLock()

    /// Apps, windows, displays and microphones. Without Screen Recording permission ScreenCaptureKit
    /// lists nothing, so running apps still come from NSWorkspace and the result says why the rest is empty.
    static func list() async -> JSONValue {
        let microphones = Self.microphones()
        let permissions = Permissions.snapshot()
        guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else {
            return ["apps": .array(runningApps()), "windows": [], "displays": [], "microphones": microphones, "permissions": permissions]
        }

        let ownPID = ProcessInfo.processInfo.processIdentifier
        let windows = content.windows.filter { window in
            guard let app = window.owningApplication, app.processID != ownPID, !isSecretary(app.bundleIdentifier) else { return false }
            return window.windowLayer == 0 && window.frame.width >= 120 && window.frame.height >= 80
        }
        let withWindows = Set(windows.compactMap { $0.owningApplication?.processID })
        let apps = content.applications.filter { app in
            guard !app.bundleIdentifier.isEmpty, app.processID != ownPID, !isSecretary(app.bundleIdentifier) else { return false }
            return withWindows.contains(app.processID) || NSRunningApplication(processIdentifier: app.processID)?.activationPolicy == .regular
        }

        return [
            "apps": .array(apps.sorted { $0.applicationName.localizedCaseInsensitiveCompare($1.applicationName) == .orderedAscending }.map { app -> JSONValue in
                [
                    "bundleId": .string(app.bundleIdentifier),
                    "name": .string(app.applicationName),
                    "pid": JSONValue(Int(app.processID)),
                    "windows": JSONValue(windows.filter { $0.owningApplication?.processID == app.processID }.count),
                    "icon": JSONValue(icon(for: app.bundleIdentifier, pid: app.processID)),
                ]
            }),
            "windows": .array(windows.map { window -> JSONValue in
                [
                    "id": JSONValue(Int(window.windowID)),
                    "title": JSONValue(window.title),
                    "bundleId": JSONValue(window.owningApplication?.bundleIdentifier),
                    "app": JSONValue(window.owningApplication?.applicationName),
                    "width": JSONValue(Int(window.frame.width)),
                    "height": JSONValue(Int(window.frame.height)),
                ]
            }),
            "displays": .array(content.displays.map { display -> JSONValue in
                [
                    "id": JSONValue(Int(display.displayID)),
                    "name": JSONValue(screen(for: display.displayID)?.localizedName),
                    "width": JSONValue(display.width),
                    "height": JSONValue(display.height),
                    "main": .bool(display.displayID == CGMainDisplayID()),
                ]
            }),
            "microphones": microphones,
            "permissions": permissions,
        ]
    }

    /// Regular (Dock) apps. Needs no permission, so it also drives meeting suggestions.
    static func runningApps() -> [JSONValue] {
        NSWorkspace.shared.runningApplications.compactMap { app -> JSONValue? in
            guard app.activationPolicy == .regular, let bundle = app.bundleIdentifier, !isSecretary(bundle) else { return nil }
            return ["bundleId": .string(bundle), "name": JSONValue(app.localizedName), "pid": JSONValue(Int(app.processIdentifier)), "windows": 0, "icon": JSONValue(icon(for: bundle, pid: app.processIdentifier))]
        }
    }

    static func microphones() -> JSONValue {
        let types: [AVCaptureDevice.DeviceType]
        if #available(macOS 14.0, *) { types = [.microphone, .external] } else { types = [.builtInMicrophone, .externalUnknown] }
        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .audio, position: .unspecified).devices
        let preferred = AVCaptureDevice.default(for: .audio)?.uniqueID
        return .array(devices.map { device -> JSONValue in
            ["id": .string(device.uniqueID), "name": .string(device.localizedName), "default": .bool(device.uniqueID == preferred)]
        })
    }

    private static func isSecretary(_ bundleID: String) -> Bool {
        bundleID.hasPrefix("app.secretary.code")
    }

    /// A 64-pixel PNG of the app icon, base64 encoded and cached per bundle.
    private static func icon(for bundleID: String, pid: pid_t) -> String? {
        iconLock.lock()
        defer { iconLock.unlock() }
        if let cached = icons[bundleID] { return cached }
        guard let image = NSRunningApplication(processIdentifier: pid)?.icon,
              let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        bitmap.size = NSSize(width: 64, height: 64)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(in: NSRect(x: 0, y: 0, width: 64, height: 64), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        let encoded = bitmap.representation(using: .png, properties: [:])?.base64EncodedString()
        icons[bundleID] = encoded
        return encoded
    }
}

enum Permissions {
    /// Screen Recording has no "not determined" query: it is either granted or still missing.
    static func screenGranted() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    static func requestScreenPrompt() {
        _ = CGRequestScreenCaptureAccess()
    }

    static func snapshot() -> JSONValue {
        let microphone: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: microphone = "granted"
        case .notDetermined: microphone = "undetermined"
        default: microphone = "denied"
        }
        return ["screen": .string(screenGranted() ? "granted" : "missing"), "microphone": .string(microphone)]
    }

    static func microphoneAllowed() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    static func request(_ permission: Permission) async {
        switch permission {
        case .screen: requestScreenPrompt()
        case .microphone: _ = await microphoneAllowed()
        }
    }
}
#endif
