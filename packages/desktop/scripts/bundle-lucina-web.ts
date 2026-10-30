#!/usr/bin/env bun
// Bundles Lucina's web app (SecretaryIOS `web/`) into resources/lucina-web, where electron-builder copies it into
// Contents/Resources. The desktop serves it as https://getsecretary.tech in the persist:lucina-web partition
// (src/main/secretary/lucina-web.ts), so the UI opens offline and updates with each app build; data still comes
// from the server.
// - Default: the newest `deploy/web/*` tag of the SecretaryIOS checkout at SECRETARY_IOS_REPO
//   (~/Projects/Lucina/SecretaryIOS), which is what p1 serves; `origin/main` when there is none (one trunk since
//   2026-10-30, SecretaryIOS docs/repo-workflow.md). Exported with `git archive` and built there: lucina-stage first,
//   then web.
// - LUCINA_WEB_REF picks another ref; LUCINA_WEB_DIST copies an already built dist instead.
// - SECRETARY_SKIP_LUCINA_WEB=1 skips it: the app then loads the web app live.
import { $ } from "bun"
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

export const LUCINA_WEB_RESOURCES = path.resolve(import.meta.dirname, "..", "resources", "lucina-web")

async function isFile(file: string) {
  return stat(file).then((s) => s.isFile()).catch(() => false)
}

async function install(dist: string, source: Record<string, string>) {
  if (!(await isFile(path.join(dist, "index.html")))) throw new Error(`no index.html in ${dist}`)
  await rm(LUCINA_WEB_RESOURCES, { recursive: true, force: true })
  await mkdir(path.dirname(LUCINA_WEB_RESOURCES), { recursive: true })
  await cp(dist, LUCINA_WEB_RESOURCES, { recursive: true })
  await writeFile(path.join(LUCINA_WEB_RESOURCES, ".source.json"), JSON.stringify({ ...source, builtAt: new Date().toISOString() }, null, 2))
  // The live page CSP, so bundled pages carry the server's policy (the app falls back to its known copy).
  const csp = await fetch("https://getsecretary.tech/", { method: "HEAD", signal: AbortSignal.timeout(10_000) })
    .then((r) => r.headers.get("content-security-policy"))
    .catch(() => null)
  if (csp) await writeFile(path.join(LUCINA_WEB_RESOURCES, "headers.json"), JSON.stringify({ contentSecurityPolicy: csp }, null, 2))
  console.log(`Lucina web bundled into ${LUCINA_WEB_RESOURCES} (${JSON.stringify(source)})`)
}

// deploy-guard tags every web deploy deploy/web/<UTC yyyymmddThhmmZ>-<sha8>, so the name order is the deploy order.
async function liveWebRef(repo: string) {
  // Interpolated so Bun's shell passes the patterns to git instead of globbing them; offline, the local tags are used.
  const fetched = await $`git -C ${repo} fetch --quiet origin main ${"+refs/tags/deploy/web/*:refs/tags/deploy/web/*"}`.quiet().nothrow()
  if (fetched.exitCode !== 0) console.warn(`could not fetch the web deploy tags in ${repo}; using the local ones`)
  const tags = (await $`git -C ${repo} tag --list ${"deploy/web/*"} --sort=-refname`.text()).split("\n").filter(Boolean)
  return tags[0] ?? "origin/main"
}

async function build(repo: string, ref: string) {
  if (ref.startsWith("origin/")) await $`git -C ${repo} fetch --quiet origin ${ref.slice("origin/".length)}`
  const commit = (await $`git -C ${repo} rev-parse ${ref}`.text()).trim()
  const work = await mkdtemp(path.join(tmpdir(), "lucina-web-"))
  try {
    // web/src/lib/itemArt.ts globs ../../../assets/icons; without it every shopping item falls back to its emoji.
    await $`git -C ${repo} archive ${commit} packages/lucina-stage web assets/icons | tar -x -C ${work}`
    // The web app links the stage package from ../packages; its dist must exist before the web build.
    await $`npm ci --no-audit --no-fund && npm run build`.cwd(path.join(work, "packages", "lucina-stage")).quiet()
    await $`npm ci --no-audit --no-fund && npm run build`.cwd(path.join(work, "web")).quiet()
    const dist = path.join(work, "web", "dist")
    const art = (await readdir(path.join(dist, "assets"))).filter((name) => name.endsWith(".svg")).length
    if (art === 0) throw new Error(`the Lucina web build at ${commit} has no item art (.svg) in dist/assets`)
    await install(dist, { ref, commit })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  if (Bun.env.SECRETARY_SKIP_LUCINA_WEB === "1") {
    console.log("Skipping the Lucina web bundle (SECRETARY_SKIP_LUCINA_WEB=1): the app loads it live")
  } else if (Bun.env.LUCINA_WEB_DIST) {
    await install(path.resolve(Bun.env.LUCINA_WEB_DIST), { dist: Bun.env.LUCINA_WEB_DIST })
  } else {
    const repo = Bun.env.SECRETARY_IOS_REPO ?? path.join(homedir(), "Projects", "Lucina", "SecretaryIOS")
    await build(repo, Bun.env.LUCINA_WEB_REF ?? (await liveWebRef(repo)))
  }
}
