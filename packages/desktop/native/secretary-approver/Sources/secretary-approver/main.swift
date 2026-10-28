import CryptoKit
import Foundation
import LocalAuthentication
import Security

// See README.md: one command per run, JSON in on stdin, one JSON line out.

struct Failure: Error {
    let code: String
    let message: String
}

func reply(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data(#"{"ok":false,"code":"encode","message":"encode"}"#.utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(object["ok"] as? Bool == true ? 0 : 1)
}

func fail(_ f: Failure) -> Never { reply(["ok": false, "code": f.code, "message": f.message]) }

func string(_ input: [String: Any], _ key: String, _ pattern: String) throws -> String {
    guard let value = input[key] as? String, value.range(of: pattern, options: .regularExpression) != nil else {
        throw Failure(code: "invalidRequest", message: "\(key) is missing or malformed")
    }
    return value
}

let idPattern = #"^apr_[A-Za-z0-9_-]{1,64}$"#
let devicePattern = #"^dev_[A-Za-z0-9_-]{1,64}$"#
let hashPattern = #"^sha256:[0-9a-f]{64}$"#
let keyIdPattern = #"^[0-9a-f]{8}$"#

struct Stored: Codable {
    var data: String
    var keyId: String?
    var version: Int
}

func keyFile(_ dir: String) -> URL { URL(fileURLWithPath: dir).appendingPathComponent("approval-key.json") }

func load(_ dir: String) -> Stored? {
    guard let data = try? Data(contentsOf: keyFile(dir)), let s = try? JSONDecoder().decode(Stored.self, from: data), s.version == 1 else { return nil }
    return s
}

func save(_ dir: String, _ s: Stored) throws {
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let data = try JSONEncoder().encode(s)
    let url = keyFile(dir)
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

/// Touch ID (or the login password), then the Secure Enclave signature (base64 DER) over `message`.
func sign(_ message: String, blob: Data, reason: String) throws -> String {
    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    let done = DispatchSemaphore(value: 0)
    var authError: Error?
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
        if !ok { authError = error ?? Failure(code: "cancelled", message: "") }
        done.signal()
    }
    done.wait()
    if let e = authError as? LAError {
        switch e.code {
        case .userCancel, .appCancel, .systemCancel, .userFallback: throw Failure(code: "cancelled", message: "")
        case .biometryNotEnrolled, .biometryLockout, .passcodeNotSet, .biometryNotAvailable:
            throw Failure(code: "unavailable", message: e.localizedDescription)
        default: throw Failure(code: "failed", message: e.localizedDescription)
        }
    } else if let e = authError {
        throw Failure(code: "cancelled", message: "\(e)")
    }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
        return try key.signature(for: Data(message.utf8)).derRepresentation.base64EncodedString()
    } catch {
        throw Failure(code: "failed", message: "\(error)")
    }
}

func reasonText(_ input: [String: Any]) -> String {
    let r = (input["reason"] as? String ?? "").replacingOccurrences(of: "\n", with: " ")
    return r.isEmpty ? "approve a request" : String(r.prefix(300))
}

func run(_ command: String, _ input: [String: Any]) throws -> [String: Any] {
    let dir = try string(input, "dir", #"^/.+"#)
    switch command {
    case "status":
        let ctx = LAContext()
        let available = SecureEnclave.isAvailable && ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
        var out: [String: Any] = ["available": available, "hasKey": load(dir) != nil]
        if let id = load(dir)?.keyId { out["keyId"] = id }
        return out
    case "create":
        let deviceId = try string(input, "deviceId", devicePattern)
        guard SecureEnclave.isAvailable else { throw Failure(code: "unavailable", message: "no Secure Enclave") }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .userPresence], &error) else {
            _ = error?.takeRetainedValue()
            throw Failure(code: "unavailable", message: "set a login password and Touch ID first")
        }
        let key: SecureEnclave.P256.Signing.PrivateKey
        do { key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access) } catch {
            throw Failure(code: "unavailable", message: "\(error)")
        }
        let publicKey = key.publicKey.x963Representation.base64EncodedString()
        let signature = try sign("secretary-approval-key-v1\n\(deviceId)\n\(publicKey)", blob: key.dataRepresentation, reason: reasonText(input))
        // Only a key that signed its own registration is kept; it replaces any earlier one.
        try save(dir, Stored(data: key.dataRepresentation.base64EncodedString(), keyId: nil, version: 1))
        return ["publicKey": publicKey, "signature": signature]
    case "set-key-id":
        let keyId = try string(input, "keyId", keyIdPattern)
        guard var s = load(dir) else { throw Failure(code: "needsSetup", message: "no key") }
        s.keyId = keyId
        try save(dir, s)
        return [:]
    case "sign-approve", "sign-revoke":
        guard let s = load(dir), let keyId = s.keyId, let blob = Data(base64Encoded: s.data) else {
            throw Failure(code: "needsSetup", message: "this Mac has no approval key")
        }
        let message: String
        if command == "sign-approve" {
            message = "secretary-approval-v1\n\(try string(input, "id", idPattern))\n\(try string(input, "payloadHash", hashPattern))\napprove"
        } else {
            message = "secretary-approval-revoke-v1\n\(try string(input, "callerId", devicePattern))\n\(try string(input, "targetId", devicePattern))"
        }
        return ["keyId": keyId, "signature": try sign(message, blob: blob, reason: reasonText(input))]
    case "remove":
        try? FileManager.default.removeItem(at: keyFile(dir))
        return [:]
    default:
        throw Failure(code: "invalidRequest", message: "unknown command")
    }
}

let args = CommandLine.arguments
guard args.count == 2 else { fail(Failure(code: "invalidRequest", message: "usage: secretary-approver <command> < input.json")) }
let raw = FileHandle.standardInput.readDataToEndOfFile()
guard let input = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else {
    fail(Failure(code: "invalidRequest", message: "stdin must be a JSON object"))
}
do {
    var out = try run(args[1], input)
    out["ok"] = true
    reply(out)
} catch let f as Failure {
    fail(f)
} catch {
    fail(Failure(code: "failed", message: "\(error)"))
}
