import Foundation

public enum Permission: String, CaseIterable {
    case screen
    case microphone
}

public enum Command: Equatable {
    case listSources
    case runningApps
    case permissions
    case requestPermission(Permission)
    case start(RecordingSettings)
    case pause
    case resume
    case stop
}

public struct Request: Equatable {
    public let id: String
    public let command: Command
}

public enum ProtocolError: Error, Equatable {
    /// Not a JSON object with a string `id`; there is nothing to answer to.
    case malformed
    case unknownCommand(id: String, name: String)
    case invalidSettings(id: String, SettingsError)
    case invalidArgument(id: String, String)

    public var id: String? {
        switch self {
        case .malformed: return nil
        case .unknownCommand(let id, _), .invalidSettings(let id, _), .invalidArgument(let id, _): return id
        }
    }

    public var code: String {
        switch self {
        case .malformed: return "malformed"
        case .unknownCommand: return "unknown-command"
        case .invalidSettings, .invalidArgument: return "invalid-settings"
        }
    }

    public var message: String {
        switch self {
        case .malformed: return "Expected one JSON object with an id and cmd per line"
        case .unknownCommand(_, let name): return "Unknown command '\(name)'"
        case .invalidSettings(_, let error): return error.description
        case .invalidArgument(_, let reason): return reason
        }
    }
}

/// Decodes one stdin line: `{"id":"7","cmd":"start","settings":{…}}`.
public func parseRequest(_ line: String) throws -> Request {
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)), case .object = value,
          let id = value["id"]?.string, !id.isEmpty, id.count <= 64 else { throw ProtocolError.malformed }
    guard let name = value["cmd"]?.string else { throw ProtocolError.unknownCommand(id: id, name: "") }

    switch name {
    case "list-sources": return Request(id: id, command: .listSources)
    case "running-apps": return Request(id: id, command: .runningApps)
    case "permissions": return Request(id: id, command: .permissions)
    case "request-permission":
        guard let raw = value["permission"]?.string, let permission = Permission(rawValue: raw) else {
            throw ProtocolError.invalidArgument(id: id, "permission must be 'screen' or 'microphone'")
        }
        return Request(id: id, command: .requestPermission(permission))
    case "start":
        do { return Request(id: id, command: .start(try parseRecordingSettings(value["settings"] ?? .null))) }
        catch let error as SettingsError { throw ProtocolError.invalidSettings(id: id, error) }
    case "pause": return Request(id: id, command: .pause)
    case "resume": return Request(id: id, command: .resume)
    case "stop": return Request(id: id, command: .stop)
    default: throw ProtocolError.unknownCommand(id: id, name: name)
    }
}

/// Builders for every line the helper writes, so the shapes live next to the parser and are tested.
public enum Message {
    public static func result(_ id: String, _ result: JSONValue = .object([:])) -> JSONValue {
        ["id": .string(id), "ok": true, "result": result]
    }

    public static func failure(_ id: String, code: String, message: String) -> JSONValue {
        ["id": .string(id), "ok": false, "error": ["code": .string(code), "message": .string(message)]]
    }

    public static func event(_ name: String, _ fields: [String: JSONValue] = [:]) -> JSONValue {
        .object(fields.merging(["event": .string(name)]) { _, event in event })
    }
}

/// Root-mean-square level of float samples in dBFS, clamped to [-80, 0] for meters.
public func levelDecibels<C: Collection>(_ samples: C) -> Double where C.Element == Float {
    if samples.isEmpty { return -80 }
    let power = samples.reduce(Double(0)) { $0 + Double($1) * Double($1) } / Double(samples.count)
    if power <= 0 { return -80 }
    return min(0, max(-80, 10 * log10(power)))
}
