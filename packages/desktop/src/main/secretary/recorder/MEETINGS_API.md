# Meetings upload contract

What Secretary Code's recorder sends to the server and expects back. The transcription pipeline (SecretaryIOS, branch `meetings`) implements the server side; both must match this file.

- Base URL: `https://getsecretary.tech`
- Auth: the companion's device token, `Authorization: Bearer sec_…`, plus `X-Secretary-Client: web`.
- `401` means the token is no longer valid: the app stops and asks the owner to sign in again.
- `408`, `429` and `5xx`, and lost connections, are retried with backoff (0 s, 1 s, 2 s, 5 s, 10 s, 30 s, then every 60 s).
- Any other `4xx` fails the upload; the owner can retry it from the Recordings list.

## 1. Create the meeting

`POST /v1/meetings`, `Content-Type: application/json`, `Idempotency-Key: <local recording UUID>`

```json
{
  "title": "Weekly sync",
  "started_at": "2026-10-26T13:30:00.000Z",
  "ended_at": "2026-10-26T14:31:02.000Z",
  "source_app": { "bundle_id": "com.microsoft.teams2", "name": "Microsoft Teams" },
  "calendar_event_id": "evt_123",
  "tracks": [
    { "name": "video.mp4", "bytes": 734003200, "sha256": "…64 hex…", "mime": "video/mp4", "start_offset_ms": 0 },
    { "name": "system.m4a", "bytes": 58720256, "sha256": "…", "mime": "audio/mp4", "start_offset_ms": 12 },
    { "name": "mic.m4a", "bytes": 29360128, "sha256": "…", "mime": "audio/mp4", "start_offset_ms": 21 }
  ]
}
```

- `source_app.bundle_id` and `name` are null when a whole display was recorded; `calendar_event_id` is null when no event matched.
- `tracks` lists only files that exist, so 1 to 3 entries. `mic.m4a` is always the owner's microphone alone, the reference for "who is the owner" in speaker recognition. `system.m4a` is everyone else (the meeting app, or all system audio).
- `start_offset_ms` (extra, optional to use): milliseconds from the shared recording start to the track's first sample. All tracks share one timeline with pauses removed.
- `sha256` is lowercase hex of the whole file.
- The `Idempotency-Key` lets a retried create (after a lost response) return the same meeting instead of a second one.

Response `201` (or `200`): `{ "id": "mtg_…" }`, id matching `^[A-Za-z0-9_-]{1,128}$`.

## 2. Upload each track (resumable)

`PUT /v1/meetings/{id}/tracks/{name}` with `Content-Type: <mime>` and a `Content-Range` header. Chunks are 8 MiB.

Ask for the stored offset (sent first, and again after every failure): empty body, `Content-Range: bytes */<total>`.

Send bytes: `Content-Range: bytes <start>-<end>/<total>` (inclusive end), body = those bytes.

Responses:

| Status            | Meaning                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `308`             | Stored so far, not complete. `Range: bytes=0-<last stored byte>`; no `Range` header means 0 bytes. Not a redirect: no `Location`.              |
| `200` / `201`     | All `<total>` bytes stored. JSON `{ "name": "mic.m4a", "bytes": 29360128, "sha256": "<sha256 of the stored file>" }`. Also the answer to a `*/<total>` query once complete. |
| `409` / `416`     | `<start>` is not the server's offset. The client asks for the offset again.                                                                    |

The server must keep the bytes it received before a connection dropped and report them in the next `308`; the client always resumes from the server's offset, never from its own.

The client marks a track confirmed only when the returned `sha256` equals its own. A different digest keeps the local copy and shows an error.

## 3. Complete

`POST /v1/meetings/{id}/complete`, no body, after every track is confirmed. Response `200`/`202`, e.g. `{ "id": "mtg_…", "status": "processing" }`. The server then transcribes with speaker recognition, writes the brief, files it under the calendar event and company, and sends the owner the transcript.

## 4. Status

`GET /v1/meetings/{id}`, polled every 15 s while processing:

```json
{
  "id": "mtg_…",
  "status": "processing",
  "brief": null,
  "transcript": null,
  "transcript_url": null,
  "error": null
}
```

- `status`: `uploading` | `processing` | `ready` | `failed`.
- When `ready`: `brief` (plain text), `transcript` (plain text with speaker labels, e.g. `Professor: …`) and/or `transcript_url` (an `https:` link the app opens in the browser).
- When `failed`: `error` (text).

## Local copies

A recording's media files are deleted from the Mac only when every track was confirmed by sha256, the meeting was completed, and the owner's "Keep local copy" period has passed since the recording ended. `meeting.json` stays so the brief remains listed.
