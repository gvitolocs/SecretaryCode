# Secretary Code for Mac

Secretary Code is the private Mac application built from the OpenCode v2.1.4 fork. It retains the coding engine and workspace, uses the Lucina app logo, and adds Lucina, coding-agent launchers, and meeting recording.

The desktop has projects and sessions on the left, the active coding workspace in the center, and a resizable Lucina/Agents panel on the right. Both side panels can be collapsed. The companion is part of the main workspace.

The checkout lives at `/Users/giuseppe/Projects/Secretary/SecretaryCode` and is also accessible through the `LucinaCode` folder alias. The installed app is `/Applications/Secretary Code.app`.

## Build the private Mac app

Use Bun 1.4.4 or a compatible version, then run from this package:

```bash
bun scripts/package-secretary-mac.ts
```

This builds the engine on its `latest` release channel, builds the native recording helper, and packages the desktop with its `prod` identity. The distinction matters: branch-channel engine builds register a different service filename and cannot be discovered by the desktop client. Each build receives a unique engine version so an older staged executable cannot be reused.

The script selects an existing Apple Development identity. Set `SECRETARY_SIGN_IDENTITY` to choose one explicitly. Stable signing preserves the app's macOS privacy grants between builds. The package is a private local build and is not notarized for public distribution.

After quitting the installed app, install the built bundle with:

```bash
ditto "dist/mac-arm64/Secretary Code.app" "/Applications/Secretary Code.app"
open "/Applications/Secretary Code.app"
```

App state and encrypted device credentials live under `~/Library/Application Support/app.secretary.code`. The engine has separate config, data, cache, and service registration below `engine/`; the owner's existing OpenCode installation keeps its own state.

Lucina uses the Secretary device sign-in and private avatar transport. The engine also supplies a Lucina agent and MCP integration, configured through `LUCINA_MCP_TOKEN` or a stored integration credential. External coding lanes use their installed CLIs and accounts; login failures and exhausted quotas are displayed in their output. Qwen respects its single shared slot.

The Agents panel defaults to **Secretary Code · built-in**, which runs the bundled engine locally and saves sessions in the same workspace. It uses the workspace model unless a `provider/model` is entered. Tasks receive their project directory as both the process directory and `PWD`; prompts are sent through stdin. Stop interrupts the engine session rather than only disconnecting its client. Claude, ZCode, Qwen, and Orchestra remain optional lanes.

The recorder's upload contract is documented in [`MEETINGS_API.md`](src/main/secretary/recorder/MEETINGS_API.md). Microphone and screen recording are started through the recorder's controls and macOS permission flow.

## Upstream developer reference

The following sections describe the inherited Electron build and development workflow. Secretary's packaging, identity, URL scheme, and disabled upstream updater take precedence over upstream release references below.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

Production builds require a prebuilt V2 CLI distribution. The release workflow supplies the artifact from the same run:

```bash
OPENCODE_CHANNEL=prod OPENCODE_CLI_DIST=/absolute/path/to/packages/cli/dist bun run build
OPENCODE_CHANNEL=prod bun run package
```

Set `OPENCODE_CLI_TARGET` when packaging for a different architecture. The CLI is placed outside `app.asar` in the
application's resources directory, and packaging fails if it is missing.

CLI preparation uses these channel rules:

| Channel                                | Without `OPENCODE_CLI_DIST`    | With `OPENCODE_CLI_DIST`                      |
| -------------------------------------- | ------------------------------ | --------------------------------------------- |
| `dev`, `local`, unset, or unrecognized | Download the dev CLI           | Download the dev CLI; ignore the distribution |
| `beta`                                 | Download the beta CLI          | Copy the supplied CLI; fail if it is missing  |
| `prod`, `latest`                       | Fail before changing resources | Copy the supplied CLI; fail if it is missing  |

`bun dev` is separate from packaging: it uses local renderer/server mode, the dev app identity, and the CLI source by
default. `bun dev --download-server <version>` instead downloads that CLI version for local development. Neither path
requires `OPENCODE_CLI_DIST` or runs the production prebuild.

## Beta channel

Every push to the `beta` branch publishes OpenCode Beta (`ai.opencode.desktop.beta`) as version `0.0.0-beta-<run>` to
the `beta` update channel. Beta publishes only the desktop app and `beta.opencode.ai`; the CLI and SDK packages ship
from `dev`. Install it from `https://opencode.ai/download/beta/<platform>`, for example `darwin-aarch64-dmg` or
`windows-x64-nsis`. Installed builds update in place on every platform.

## Startup benchmark

`bun run bench:startup` measures a **packaged** build from process spawn to the restored tab being ready and the
renderer going idle, so dev-server and bundling costs are not part of the numbers.

```bash
OPENCODE_CHANNEL=dev bun run build && bunx electron-builder --win --dir --config electron-builder.config.ts
bun run bench:startup -- --runs 5                                  # warm service (started once, reused by every launch)
bun run bench:startup -- --runs 5 --compare dist/other/OpenCode\ Dev.exe   # A/B: alternate launches of two builds
bun run bench:startup -- --service cold                            # each launch spawns the service
bun run bench:startup -- --fresh                                   # first launch after an install (profile wiped each time)
bun run bench:startup -- --profile-main --profile-renderer --trace # CPU profiles and a Chromium startup trace
bun run bench:startup -- --seed "%APPDATA%\ai.opencode.desktop.dev"   # restore tabs and drafts from an existing profile
```

The app runs in an isolated home (`%TEMP%\opencode-bench-startup`): its own `%APPDATA%`, XDG directories, OpenCode
database, config and service registration, with the developer's `OPENCODE_*` and `OTEL_*` environment stripped
(an inherited OTLP endpoint alone adds a network round trip to every CLI exit). It never attaches to or restarts the
developer's live service, and only ever kills the process tree it spawned. `--service cold` stops the service before
each launch so the desktop has to spawn it; the isolated config directory gives that service a private port. One
`--warmup` launch per build is discarded by default because the first launch of a new binary pays the antivirus scan.
`--compare` alternates two builds so machine drift affects both equally; they must bundle the same CLI or the desktop
restarts the service on the version mismatch.

Milestones (ms since spawn) come from the main log, the renderer's performance timeline and DOM readiness polled over
CDP. Node's bootstrap timing is read from the main process after each run over `--inspect` (nothing attaches until the
run is over): `processCreated` → `nodeStart` is Electron's native init, `nodeStart` → `nodeBootstrapped` is Node
itself, and `nodeBootstrapped` → `appStarting` is Electron's JavaScript init plus our main bundle up to its first
log line. Renderer idle is the start of the first 500 ms window with under 10 % main-thread task time that stays quiet
for `--settle-ms`; `rendererTaskMs` is the renderer's total main-thread task time until then. Raw samples are
written to `dist/bench-startup`.

A packaged beta or prod build registers itself as the `opencode://` handler when it starts, even from the bench; the
installed app takes the registration back on its next launch. Those channels run with `HTTPS_PROXY` pointed at a
closed port (`--offline` forces it for dev) so the updater's first check fails fast instead of reaching GitHub.

See [Mac image viewer](./IMAGE_VIEWER.md) for Finder default-app setup, Preview recovery, and release verification.
