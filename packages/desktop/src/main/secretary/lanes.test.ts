import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LANES, LaneError, ORCHESTRA_WORKERS, launchPlan, orchestraRequest, projectPath, quotePosix, remoteProject, sshHosts } from './lanes'

const configured = ['SECRETARY_SSH_HOST', 'SECRETARY_SSH_FALLBACK_HOST', 'SECRETARY_CLAUDE_PATH'] as const
const saved = Object.fromEntries(configured.map(key => [key, process.env[key]]))
afterEach(() => {
  for (const key of configured) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
for (const key of configured) delete process.env[key]

function code(run: () => unknown) {
  try { run() } catch (error) { return error instanceof LaneError ? error.code : 'not_a_lane_error' }
  return undefined
}

const mounted = '/Users/giuseppe/mnt/nezopt/Projects/SecretaryIOS'
describe('project boundaries', () => {
  test('maps only explicit mounted root and normalizes dot', () => {
    expect(remoteProject(mounted + '/./web/')).toBe('/home/nez/Projects/SecretaryIOS/web/')
    expect(remoteProject('/Users/giuseppe/mnt/nezopt/Projects')).toBe('/home/nez/Projects')
  })
  test('Mac project never silently maps to different remote contents', () => {
    expect(() => remoteProject('/Users/giuseppe/Projects/SecretaryIOS')).toThrow('not synchronized')
    expect(remoteProject('/Users/giuseppe/Projects/SecretaryIOS', '/home/nez/Projects/SecretaryIOS')).toBe('/home/nez/Projects/SecretaryIOS')
    expect(() => remoteProject(mounted, '/tmp/other')).toThrow()
    expect(() => remoteProject('/Users/giuseppe/mnt/nezopt/Projects-sibling/P')).toThrow()
  })
  test('rejects relative paths, traversal, controls', () => {
    for (const path of ['x', '', '/x/../y', mounted + '/../secret', '/x\nwhoami', '/x\u0000y', '/x\ty'])
      expect(() => projectPath(path)).toThrow()
  })
})

describe('process construction', () => {
  test('shell metacharacters and apostrophes survive SSH boundary as literal argv', () => {
    const suspicious = ["/home/nez/Projects/it's fine", '/home/nez/Projects/$USER;echo pwned', '/home/nez/Projects/`id`', '/home/nez/Projects/日本語', '', 'Multiline\nprompt $(id)']
    const result = spawnSync('/bin/sh', ['-c', "printf '%s\\0' " + suspicious.map(quotePosix).join(' ')])
    expect(result.status).toBe(0)
    expect(result.stdout.toString().split('\0').slice(0, -1)).toEqual(suspicious)
  })
  test('Claude uses argv plus local cwd with no shell and reads the prompt from stdin', () => {
    const plan = launchPlan('claude', { project: '/Users/giuseppe/Projects/My Project', prompt: 'Review; $(id)' })
    expect(plan).toEqual({ executable: join(homedir(), '.local', 'bin', 'claude'), args: ['-p'], cwd: '/Users/giuseppe/Projects/My Project', stdin: 'Review; $(id)' })
    process.env.SECRETARY_CLAUDE_PATH = '/opt/claude/bin/claude'
    expect(launchPlan('claude', { project: '/x', prompt: 'Review' }).executable).toBe('/opt/claude/bin/claude')
    process.env.SECRETARY_CLAUDE_PATH = 'claude'
    expect(code(() => launchPlan('claude', { project: '/x', prompt: 'Review' }))).toBe('invalid_path')
  })
  test('a prompt shaped like a flag never becomes an option', () => {
    const prompt = '--dangerously-skip-permissions'
    expect(launchPlan('claude', { project: '/x', prompt }).args).toEqual(['-p'])
    expect(launchPlan('zcode', { project: mounted, prompt }).remote?.args).toContain('--prompt=--dangerously-skip-permissions')
    expect(launchPlan('qwen', { project: mounted, prompt, qwenSlot: 'free' }).remote?.args).not.toContain(prompt)
    for (const lane of ['claude', 'zcode', 'qwen'] as const) {
      const plan = launchPlan(lane, { project: mounted, prompt: 'Review', qwenSlot: 'free' })
      for (const flag of ['--dangerously-skip-permissions', '--yolo', '--permission-mode', '--approval-mode'])
        expect([...plan.args, ...plan.remote?.args ?? []].some(arg => arg.startsWith(flag))).toBe(false)
    }
  })
  test('ZCode uses real remote CLI, not Electron launcher', () => {
    const interactive = launchPlan('zcode', { project: mounted })
    expect(interactive.args[0]).toBe('-t')
    expect(interactive.remote?.args).toEqual(['/home/nez/opt/zcode-appimage/resources/glm/zcode.cjs', '--cwd', '/home/nez/Projects/SecretaryIOS'])
    const headless = launchPlan('zcode', { project: mounted, prompt: 'Review' })
    expect(headless.remote?.args).toContain('--prompt=Review')
    expect(headless.remote?.args).not.toContain('--mode')
  })
  test('Qwen reports a busy slot, refuses an unknown one, uses existing serialized wrapper', () => {
    expect(code(() => launchPlan('qwen', { project: mounted, prompt: 'Review', qwenSlot: 'busy' }))).toBe('qwen_busy')
    for (const qwenSlot of ['unknown', undefined] as const)
      expect(code(() => launchPlan('qwen', { project: mounted, prompt: 'Review', qwenSlot }))).toBe('qwen_status_unknown')
    const plan = launchPlan('qwen', { project: mounted, prompt: 'Review', qwenSlot: 'free' })
    expect(plan.remote?.executable).toBe('/home/nez/.local/bin/qcode-run')
    expect(plan.stdin).toBe('Review')
    expect(plan.remote?.args.at(-1)).toBe('-')
    expect(plan.remote?.args).not.toContain('--yolo')
  })
  test('invalid lanes, missing prompts, control args fail before spawn', () => {
    expect(() => launchPlan('invented', { project: mounted })).toThrow()
    expect(() => launchPlan('qwen', { project: mounted, qwenSlot: 'free' })).toThrow()
    expect(() => launchPlan('zcode', { project: mounted, interactive: false })).toThrow()
    expect(() => quotePosix('x\u0000whoami')).toThrow()
  })
})

describe('SSH hosts', () => {
  test('default to nezopt with a nezopt-remote fallback and follow configuration', () => {
    expect(sshHosts()).toEqual(['nezopt', 'nezopt-remote'])
    expect(launchPlan('zcode', { project: mounted, prompt: 'Review' }).args.slice(-2, -1)).toEqual(['nezopt'])
    process.env.SECRETARY_SSH_HOST = 'nez@10.0.0.4'
    expect(sshHosts()).toEqual(['nez@10.0.0.4', 'nezopt-remote'])
    process.env.SECRETARY_SSH_FALLBACK_HOST = 'nez@10.0.0.4'
    expect(sshHosts()).toEqual(['nez@10.0.0.4'])
    const plan = launchPlan('qwen', { project: mounted, prompt: 'Review', qwenSlot: 'free', host: 'nezopt-remote' })
    expect(plan.args.slice(-3, -1)).toEqual(['--', 'nezopt-remote'])
    expect(plan.remote?.host).toBe('nezopt-remote')
  })
  test('reject destinations that SSH would read as options or that carry shell syntax', () => {
    for (const host of ['-oProxyCommand=id', 'nez opt', 'nezopt;id', '$(id)', 'a\nb']) {
      process.env.SECRETARY_SSH_HOST = host
      expect(code(sshHosts)).toBe('invalid_host')
    }
  })
})

test('Orchestra carries strict worker pin and leaves prompt authorization intact', () => {
  const request = orchestraRequest({ project: mounted, prompt: 'Read-only review. Do not edit.', requestID: 'secretary-review-1', worker: 'opencode-openrouter' })
  expect(request).toEqual({ name: 'dsh_prompt', arguments: { workspace: '/home/nez/Projects/SecretaryIOS', prompt: 'Read-only review. Do not edit.', request_id: 'secretary-review-1', preferred_worker: 'opencode-openrouter', new_session: true, wait_seconds: 0 } })
  for (const worker of ['opencode', 'big-pickle', '__proto__', 'zen-minimax-flash'])
    expect(() => orchestraRequest({ project: mounted, prompt: 'Review', requestID: 'a', worker })).toThrow()
  expect(() => orchestraRequest({ project: mounted, prompt: '', requestID: 'a' })).toThrow()
  expect(() => orchestraRequest({ project: mounted, prompt: 'Read', requestID: '' })).toThrow()
  expect(JSON.stringify({ LANES, ORCHESTRA_WORKERS })).not.toContain('big-pickle')
})
