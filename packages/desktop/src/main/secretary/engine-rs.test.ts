import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRustEnginePreview,
  engineConfigPaths,
  freeLoopbackPort,
  readRustProvider,
  resolveRustProvider,
  rustEngineDataDir,
  rustEngineExecutable,
  rustLanePlan,
  type RustEnginePreview,
} from "./engine-rs"
import { LaneError } from "./lanes"
import { redactLaneOutput } from "./lane-process"

const SECRET = "sk-proj-abcdefghijklmnopqrst"

function code(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return error instanceof LaneError ? error.code : "not_a_lane_error"
  }
  return undefined
}

function openaiConfig(overrides: Record<string, unknown> = {}) {
  return {
    model: "openai/gpt-4o-mini",
    provider: { openai: { settings: { baseURL: "https://api.example.test/v1/" } } },
    ...overrides,
  }
}

async function configDir(root: string, config: unknown, auth: unknown) {
  const files = {
    config: join(root, "config", "opencode", "opencode.json"),
    auth: join(root, "data", "opencode", "auth.json"),
  }
  await mkdir(join(root, "config", "opencode"), { recursive: true })
  await mkdir(join(root, "data", "opencode"), { recursive: true })
  await writeFile(files.config, JSON.stringify(config))
  await writeFile(files.auth, JSON.stringify(auth))
  return files
}

const saved = Object.fromEntries(
  ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "SECRETARY_ENGINE_RS_DIR", "SECRETARY_ENGINE_RS_DATA"].map((key) => [
    key,
    process.env[key],
  ]),
)
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("provider selection", () => {
  test("an OpenAI-compatible selection yields the protocol, base URL and key the server reads from env", () => {
    const provider = resolveRustProvider(openaiConfig(), { openai: { type: "api", key: SECRET } })
    expect(provider).toEqual({
      providerID: "openai",
      protocol: "openai",
      model: "openai/gpt-4o-mini",
      baseURL: "https://api.example.test/v1",
      apiKey: SECRET,
    })
  })

  test("Anthropic is recognized by provider id, package and OAuth tokens", () => {
    expect(resolveRustProvider({ model: "anthropic/claude-sonnet-4" }, undefined).protocol).toBe("anthropic")
    expect(
      resolveRustProvider({ model: "custom/some-model", provider: { custom: { package: "@ai-sdk/anthropic" } } }, undefined)
        .protocol,
    ).toBe("anthropic")
    expect(
      resolveRustProvider(
        { model: "claude/claude-sonnet-4" },
        { claude: { type: "oauth", access: SECRET, refresh: "refresh", expires: 0 } },
      ).apiKey,
    ).toBe(SECRET)
  })

  test("a model selection with a variant keeps the provider and drops the variant", () => {
    expect(resolveRustProvider({ model: "openai/gpt-4o-mini#high" }, undefined).model).toBe("openai/gpt-4o-mini")
    expect(resolveRustProvider({ model: { providerID: "openai", model: "gpt-4o-mini" } }, undefined).model).toBe(
      "openai/gpt-4o-mini",
    )
  })

  test("a local endpoint needs no credential and a configured base URL is kept", () => {
    const provider = resolveRustProvider(
      { model: "ollama/qwen3", provider: { ollama: { options: { baseURL: "http://127.0.0.1:11434/v1" } } } },
      {},
    )
    expect(provider).toEqual({
      providerID: "ollama",
      protocol: "openai",
      model: "ollama/qwen3",
      baseURL: "http://127.0.0.1:11434/v1",
    })
  })

  test("providers the Rust client cannot speak report unsupported_provider without echoing the key", () => {
    for (const model of ["google/gemini-3-pro", "amazon-bedrock/anthropic.claude", "cohere/command-r"]) {
      const failure = (() => {
        try {
          resolveRustProvider({ model }, { google: { type: "api", key: SECRET } })
        } catch (error) {
          return error
        }
        return undefined
      })()
      expect(failure).toBeInstanceOf(LaneError)
      expect((failure as LaneError).code).toBe("unsupported_provider")
      expect((failure as LaneError).message).not.toContain(SECRET)
    }
  })

  test("no selection or an unusable base URL is a clear error, not a guessed provider", () => {
    expect(code(() => resolveRustProvider({}, {}))).toBe("unsupported_provider")
    expect(code(() => resolveRustProvider({ model: "openai/gpt-4o-mini", provider: { openai: { settings: {} } } }))).toBeUndefined()
    const invalid = (() => {
      try {
        resolveRustProvider({ model: "openai/gpt-4o-mini", provider: { openai: { settings: { baseURL: "ftp://x" } } } })
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(invalid).toBeInstanceOf(LaneError)
    expect((invalid as LaneError).code).toBe("invalid_provider")
  })

  test("reads the engine's own config and credential files and tolerates missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "secretary-rust-provider-"))
    try {
      const files = await configDir(root, openaiConfig(), { openai: { type: "api", key: SECRET } })
      const provider = await readRustProvider(files)
      expect(provider).toMatchObject({ protocol: "openai", apiKey: SECRET })
      await rm(files.auth)
      expect((await readRustProvider(files)).apiKey).toBeUndefined()
      await rm(files.config)
      // Without an engine config there is no selected model, so the lane reports the unsupported state.
      await expect(readRustProvider(files)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("engineConfigPaths follows the app's XDG roots and the default macOS layout", () => {
    expect(engineConfigPaths({ XDG_CONFIG_HOME: "/x/config", XDG_DATA_HOME: "/x/data" })).toEqual({
      config: "/x/config/opencode/opencode.json",
      auth: "/x/data/opencode/auth.json",
    })
    expect(engineConfigPaths({}).config).toContain("Library/Application Support/app.secretary.code/engine/config/opencode/opencode.json")
  })
})

describe("lane plan", () => {
  const provider = {
    providerID: "openai",
    protocol: "openai" as const,
    model: "openai/gpt-4o-mini",
    baseURL: "https://api.example.test/v1",
    apiKey: SECRET,
  }
  const plan = (prompt = "Review; $(id) and `whoami`") =>
    rustLanePlan({
      cli: "/Applications/Secretary Code.app/Contents/Resources/engine-rs/oc-cli",
      project: "/Users/giuseppe/Projects/My Project",
      prompt,
      data: "/Users/giuseppe/Library/Application Support/app.secretary.code/engine-rs/data/lane",
      provider,
    })

  test("oc-cli --local ask receives the prompt and project as argv, with no shell", () => {
    const value = plan()
    expect(value.cli.executable).toBe("/Applications/Secretary Code.app/Contents/Resources/engine-rs/oc-cli")
    expect(value.cli.args).toEqual(["--local", "ask", "Review; $(id) and `whoami`", "/Users/giuseppe/Projects/My Project"])
    // Embedded mode: no server endpoint, so oc-cli runs the turn (and the Claude Code layer) itself.
    expect(value.cli.env.OC_BASE).toBeUndefined()
    expect(value.cli.env.OC_CWD).toBe("/Users/giuseppe/Projects/My Project")
  })

  test("a prompt that starts with a dash can never be read as an oc-cli or Claude Code flag", () => {
    for (const prompt of ["--review the diff", "--local", "--no-claude", "--settings={}", "--permission-mode=plan", "-x"]) {
      const args = plan(prompt).cli.args
      expect(args.slice(0, 2)).toEqual(["--local", "ask"])
      expect(args[2]).toBe(` ${prompt}`)
      expect(args).toHaveLength(4)
    }
  })

  test("the provider and its key reach the CLI environment only, never argv", () => {
    const value = plan()
    expect(value.cli.env).toMatchObject({
      OC_PROVIDER: "openai",
      OC_MODEL: "openai/gpt-4o-mini",
      OC_BASE_URL: "https://api.example.test/v1",
      OC_API_KEY: SECRET,
      OC_DATA: "/Users/giuseppe/Library/Application Support/app.secretary.code/engine-rs/data/lane",
    })
    expect(JSON.stringify(value.cli.args)).not.toContain(SECRET)
    // Anything that does reach a lane log is redacted.
    expect(redactLaneOutput(`provider rejected ${SECRET}`)).not.toContain(SECRET)
  })

  test("unmatched tools are allowed as in 2.1.4, through a ruleset the engine parses", () => {
    const rules = JSON.parse(plan().cli.env.OC_PERMISSIONS ?? "null")
    expect(rules).toEqual([{ action: "*", resource: "*", effect: "allow" }])
  })

  test("a missing provider leaves the provider variables unset", () => {
    const value = rustLanePlan({ cli: "/srv/oc-cli", project: "/p", prompt: "Review", data: "/d" })
    expect(value.cli.env.OC_API_KEY).toBeUndefined()
    expect(value.cli.env.OC_PROVIDER).toBeUndefined()
    expect(value.cli.env.OC_CWD).toBe("/p")
  })

  test("the bundled binaries come from the shipped directory or fail clearly", () => {
    expect(code(() => rustEngineExecutable("oc-cli", {}))).toBe("engine_unavailable")
    expect(rustEngineExecutable("oc-cli", { SECRETARY_ENGINE_RS_DIR: "/app/engine-rs" })).toBe("/app/engine-rs/oc-cli")
    expect(code(() => rustEngineExecutable("oc-server", { SECRETARY_ENGINE_RS_DIR: "relative" }))).toBe("invalid_path")
    expect(rustEngineDataDir({ SECRETARY_ENGINE_RS_DATA: "/data/engine-rs" })).toBe("/data/engine-rs")
    expect(rustEngineDataDir({})).toContain("engine-rs/data")
  })

  test("a free loopback port is a real ephemeral port", async () => {
    const port = await freeLoopbackPort()
    expect(port).toBeGreaterThan(1_024)
    expect(port).toBeLessThan(65_536)
  })
})

describe("preview server lifecycle", () => {
  const temporary: Array<{ root: string; previews: RustEnginePreview[] }> = []

  afterEach(async () => {
    const items = temporary.splice(0)
    await Promise.all(items.flatMap((item) => item.previews.map((preview) => preview.stop())))
    await Promise.all(items.map((item) => rm(item.root, { recursive: true, force: true })))
  })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "secretary-rust-preview-"))
    const binaries = join(root, "engine-rs")
    await mkdir(binaries, { recursive: true })
    const server = join(binaries, "oc-server")
    // Stands in for the real server: answers /health with a version, records its environment, exits on SIGTERM.
    await writeFile(
      server,
      String.raw`#!/usr/bin/env python3
import json, os, signal, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
host, port = os.environ["OC_BIND"].split(":")
os.makedirs(os.environ["OC_DATA"], exist_ok=True)
with open(os.path.join(os.environ["OC_DATA"], "server-env.json"), "w") as f:
    json.dump({k: os.environ.get(k) for k in ("OC_BIND", "OC_WORKTREE", "OC_DATA")}, f)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"status": "ok", "version": "9.9.9"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(401)
        self.end_headers()
    def log_message(self, *args):
        pass
signal.signal(signal.SIGTERM, lambda *args: sys.exit(0))
HTTPServer((host, int(port)), Handler).serve_forever()
`,
    )
    await chmod(server, 0o755)
    const paths = {
      serverExecutable: server,
      dataDir: join(root, "data"),
      settingsFile: join(root, "preview.json"),
      configPath: join(root, "missing-config.json"),
      authPath: join(root, "missing-auth.json"),
      worktree: root,
    }
    const record = { root, previews: [] as RustEnginePreview[] }
    temporary.push(record)
    const preview = (overrides: { serverExecutable?: string } = {}) => {
      const created = createRustEnginePreview({ ...paths, ...overrides })
      record.previews.push(created)
      return created
    }
    return { paths, preview }
  }

  test("the toggle starts, health-checks, pings and stops the bundled server", async () => {
    const { paths, preview: create } = await fixture()
    const preview = create()
    expect(preview.status()).toMatchObject({ enabled: false, running: false })
    expect(preview.status().routes).toMatchObject({ portedTotal: 12, portedMatched: 8, v2Total: 45 })

    const started = await preview.setEnabled(true)
    expect(started).toMatchObject({ enabled: true, running: true, version: "9.9.9" })
    expect(started.port).toBeGreaterThan(1_024)

    const environment = JSON.parse(await readFile(join(paths.dataDir, "server-env.json"), "utf8")) as Record<string, string>
    expect(environment.OC_BIND).toBe(`127.0.0.1:${started.port}`)
    expect(environment.OC_WORKTREE).toBe(paths.worktree)
    expect(environment.OC_DATA).toBe(paths.dataDir)

    // The TypeScript engine is pinged by URL; both answers prove a round trip.
    const latency = await preview.ping(`http://127.0.0.1:${started.port}`)
    expect(latency.rust?.ok).toBe(true)
    expect(latency.ts?.ok).toBe(true)
    expect(latency.rust?.ms).toBeGreaterThanOrEqual(0)

    const stopped = await preview.setEnabled(false)
    expect(stopped).toMatchObject({ enabled: false, running: false })
    expect(stopped.error).toBeUndefined()
    expect(stopped.port).toBeUndefined()
    expect(JSON.parse(await readFile(paths.settingsFile, "utf8"))).toEqual({ enabled: false })
    expect((await stat(paths.settingsFile)).mode & 0o777).toBe(0o600)
  })

  test("a reloaded preview restarts only when the toggle was left on", async () => {
    const { preview: create } = await fixture()
    const first = create()
    await first.setEnabled(true)
    await first.stop()
    expect(first.status()).toMatchObject({ enabled: true, running: false })

    const reloaded = create()
    await reloaded.load()
    expect(reloaded.status()).toMatchObject({ enabled: true, running: true, version: "9.9.9" })
    await reloaded.setEnabled(false)
    expect(reloaded.status()).toMatchObject({ enabled: false, running: false })

    const off = create()
    await off.load()
    expect(off.status()).toMatchObject({ enabled: false, running: false })
  })

  test("a missing binary reports the failure instead of claiming a running server", async () => {
    const { paths, preview: create } = await fixture()
    const preview = create({ serverExecutable: join(paths.worktree, "not-installed") })
    await expect(preview.setEnabled(true)).rejects.toThrow()
    expect(preview.status()).toMatchObject({ enabled: true, running: false })
    expect(preview.status().error).toBeString()
    expect(preview.status().error).not.toContain("OC_API_KEY")
  })

  test("loading a malformed settings file keeps the preview off", async () => {
    const { paths, preview: create } = await fixture()
    await writeFile(paths.settingsFile, "{not json")
    const preview = create()
    await preview.load()
    expect(preview.status()).toMatchObject({ enabled: false, running: false })
  })
})
