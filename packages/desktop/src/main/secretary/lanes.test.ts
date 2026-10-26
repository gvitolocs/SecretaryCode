import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { LANES, ORCHESTRA_WORKERS, launchPlan, orchestraRequest, projectPath, quotePosix, remoteProject } from './lanes'

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
  test('Claude uses argv plus local cwd with no shell', () => {
    const plan = launchPlan('claude', { project: '/Users/giuseppe/Projects/My Project', prompt: 'Review; $(id)' })
    expect(plan).toEqual({ executable: '/Users/giuseppe/.local/bin/claude', args: ['-p', 'Review; $(id)'], cwd: '/Users/giuseppe/Projects/My Project' })
  })
  test('ZCode uses real remote CLI, not Electron launcher', () => {
    const interactive = launchPlan('zcode', { project: mounted })
    expect(interactive.args[0]).toBe('-t')
    expect(interactive.remote?.args).toEqual(['/home/nez/opt/zcode-appimage/resources/glm/zcode.cjs', '--cwd', '/home/nez/Projects/SecretaryIOS'])
    const headless = launchPlan('zcode', { project: mounted, prompt: 'Review' })
    expect(headless.remote?.args).toContain('--prompt')
    expect(headless.remote?.args).not.toContain('--mode')
  })
  test('Qwen refuses occupied and unknown slot, uses existing serialized wrapper', () => {
    for (const qwenSlot of ['busy', 'unknown', undefined] as const)
      expect(() => launchPlan('qwen', { project: mounted, prompt: 'Review', qwenSlot })).toThrow('one shared slot')
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

test('Orchestra carries strict worker pin and leaves prompt authorization intact', () => {
  const request = orchestraRequest({ project: mounted, prompt: 'Read-only review. Do not edit.', requestID: 'secretary-review-1', worker: 'opencode-openrouter' })
  expect(request).toEqual({ name: 'dsh_prompt', arguments: { workspace: '/home/nez/Projects/SecretaryIOS', prompt: 'Read-only review. Do not edit.', request_id: 'secretary-review-1', preferred_worker: 'opencode-openrouter', new_session: true, wait_seconds: 0 } })
  for (const worker of ['opencode', 'big-pickle', '__proto__', 'zen-minimax-flash'])
    expect(() => orchestraRequest({ project: mounted, prompt: 'Review', requestID: 'a', worker })).toThrow()
  expect(() => orchestraRequest({ project: mounted, prompt: '', requestID: 'a' })).toThrow()
  expect(() => orchestraRequest({ project: mounted, prompt: 'Read', requestID: '' })).toThrow()
  expect(JSON.stringify({ LANES, ORCHESTRA_WORKERS })).not.toContain('big-pickle')
})
