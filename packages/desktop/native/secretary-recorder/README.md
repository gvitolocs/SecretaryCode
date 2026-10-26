# secretary-recorder

The native meeting recorder bundled in Secretary Code's `Contents/Resources`. It records one app, window or display with ScreenCaptureKit and writes separate files into the folder Electron gives it:

| File         | Contents                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------- |
| `video.mp4`  | Optional. HEVC or H.264, chosen resolution, frame rate and bitrate. Fragmented every 10 s. |
| `system.m4a` | AAC 48 kHz. The recorded app's audio, or all system audio.                                  |
| `mic.m4a`    | AAC 48 kHz. The owner's microphone. The server treats it as the owner's voice.              |

All three start their timeline at the same host-clock instant and pauses are removed from all of them, so the server can line the tracks up sample for sample. The microphone comes from `SCStreamConfiguration.captureMicrophone` on macOS 15 and later, and from AVAudioEngine on macOS 13 and 14.

## Build and test

```sh
swift build -c release --arch arm64      # or: bun ./scripts/build-recorder.ts from packages/desktop
swift test                               # RecorderCore: settings parsing, protocol, timeline
```

`bun run prebuild` (part of packaging) runs `scripts/build-recorder.ts`, which builds for the packaging architecture and copies the binary to `packages/desktop/resources/secretary-recorder`. Development runs use that copy too.

`RecorderCore` is platform independent and its tests also run on Linux. Everything that touches ScreenCaptureKit and AVFoundation is in the `secretary-recorder` target behind `#if os(macOS)`.

## Protocol

One JSON object per line. Requests carry an `id` and a `cmd`; every request gets exactly one reply.

```jsonc
// stdin
{"id":"1","cmd":"list-sources"}
{"id":"2","cmd":"running-apps"}
{"id":"3","cmd":"permissions"}
{"id":"4","cmd":"request-permission","permission":"screen"}   // or "microphone"
{"id":"5","cmd":"start","settings":{
  "outputDirectory":"/Users/me/Movies/Secretary Recordings/2026-10-26 1430 Weekly sync",
  "source":{"kind":"app","bundleId":"com.microsoft.teams2"},   // or {"kind":"window","windowId":4242} / {"kind":"display","displayId":1}
  "video":{"enabled":true,"resolution":"1080p","fps":30,"codec":"hevc","bitrateKbps":6000},
  "systemAudio":"app",                                          // "app" | "system" | "off"
  "microphone":{"enabled":true,"deviceId":null}}}
{"id":"6","cmd":"pause"}
{"id":"7","cmd":"resume"}
{"id":"8","cmd":"stop"}

// stdout: replies
{"id":"5","ok":true,"result":{…}}
{"id":"5","ok":false,"error":{"code":"permission-screen","message":"…"}}

// stdout: events
{"event":"ready","version":"1.0.0","nativeMicrophone":true}
{"event":"permissions","screen":"granted","microphone":"undetermined"}
{"event":"started","startedAt":"…","tracks":["video.mp4","system.m4a","mic.m4a"],"source":{…}}
{"event":"status","state":"recording","elapsed":61.5,"levels":{"system":-18,"mic":-31},"files":{"system.m4a":1048576}}
{"event":"error","code":"capture-failed","message":"…","fatal":true}
{"event":"stopped","startedAt":"…","endedAt":"…","duration":3605.2,"tracks":[{"name":"mic.m4a","bytes":…,"status":"complete","startOffset":0.021}]}
{"event":"app-launched","bundleId":"us.zoom.xos","name":"zoom.us"}
```

Error codes: `permission-screen`, `permission-microphone`, `microphone-unavailable`, `source-not-found`, `busy`, `not-recording`, `capture-failed`, `writer-failed`, `invalid-settings`, `unknown-command`, `malformed`. A missing permission is an error reply plus a `permissions` event, never a crash.

Closing stdin stops any recording, finalizes its files and exits, so a crash or quit of Secretary Code does not lose the recording.

## Permissions

The helper is a child of Secretary Code, so macOS attributes both permissions to Secretary Code:

- **Screen & System Audio Recording** (Privacy & Security). Requested on the first recording; macOS then asks to quit and reopen the app.
- **Microphone**. Requested on the first recording with the microphone on.

`entitlements.plist` adds `com.apple.security.device.audio-input`, which the hardened runtime requires for the microphone. `Info.plist` is embedded in the binary for the usage strings.
