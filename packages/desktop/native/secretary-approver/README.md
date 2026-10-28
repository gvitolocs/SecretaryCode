# secretary-approver

The Mac's approval key for Secretary's owner approvals (`/v1/approvals`, SecretaryIOS
`crates/secretary-server/src/approvals.rs`): a P-256 key in the Secure Enclave, usable only after Touch ID or the login
password (`[.privateKeyUsage, .userPresence]`, the same as the iPhone's Face ID key with its passcode fallback). The
key never leaves the Secure Enclave; its opaque `dataRepresentation` (useless on any other Mac) sits in
`<userData>/approver/approval-key.json` (0600).

One command per run: `secretary-approver <command>`, a JSON object on stdin, one JSON line on stdout
(`{"ok":true,...}` or `{"ok":false,"code":"...","message":"..."}`). The main process (`src/main/secretary/approver.ts`)
runs it; the web page never reaches it directly.

| command | input | output |
|---|---|---|
| `status` | `{dir}` | `{available, hasKey, keyId?}` |
| `create` | `{dir, deviceId, reason}` | `{publicKey, signature}`: a new key, and its signature over `secretary-approval-key-v1\n{deviceId}\n{publicKey}` |
| `set-key-id` | `{dir, keyId}` | `{}` |
| `sign-approve` | `{dir, id, payloadHash, reason}` | `{keyId, signature}` over `secretary-approval-v1\n{id}\n{payloadHash}\napprove` |
| `sign-revoke` | `{dir, callerId, targetId, reason}` | `{keyId, signature}` over `secretary-approval-revoke-v1\n{callerId}\n{targetId}` |
| `remove` | `{dir}` | `{}` |

It only ever signs these formats, built here from validated fields, and every signature asks for Touch ID with the
reason the main process wrote from the server's own copy of the request.
