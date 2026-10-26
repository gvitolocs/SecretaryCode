import { posix } from 'node:path'

export const LANES = [
  { id: 'claude', name: 'Claude Code', location: 'mac', model: 'Account default' },
  { id: 'zcode', name: 'ZCode', location: 'nezopt', model: 'Z.AI account default' },
  { id: 'qwen', name: 'Qwen Code', location: 'nezopt', model: 'qwen3.8:27b-q4-72k' },
  { id: 'orchestra', name: 'Orchestra OpenCode', location: 'nezopt', model: 'opencode/glm-5.3-flash-free' },
] as const

export type LaneID = typeof LANES[number]['id']
export const ORCHESTRA_WORKERS = {
  'zen-glm-flash': 'opencode/glm-5.3-flash-free',
  'zen-beam': 'opencode/beam-free',
  'zen-deepseek-flash': 'opencode/deepseek-v4.1-flash-free',
  'opencode-openrouter': 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
} as const
export type OrchestraWorker = keyof typeof ORCHESTRA_WORKERS
export type QwenSlot = 'free' | 'busy' | 'unknown'

export class LaneError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'LaneError' }
}

const MOUNT = '/Users/giuseppe/mnt/nezopt/Projects'
const REMOTE = '/home/nez/Projects'

function text(value: unknown, label: string, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u
  if (typeof value !== 'string' || !value.trim() || controls.test(value))
    throw new LaneError('invalid_input', `${label} must be nonempty and contain no unsupported control characters`)
  return value
}

export function projectPath(value: unknown): string {
  const raw = text(value, 'Project path')
  if (!raw.startsWith('/')) throw new LaneError('invalid_path', 'Project path must be absolute')
  // Reject traversal before normalization; a path must never escape a root then reenter it.
  if (raw.split('/').includes('..')) throw new LaneError('path_traversal', 'Parent traversal is not allowed')
  return posix.normalize(raw)
}

function within(path: string, root: string): boolean { return path === root || path.startsWith(root + '/') }

export function remoteProject(localPath: string, explicitRemotePath?: string): string {
  const local = projectPath(localPath)
  if (explicitRemotePath !== undefined) {
    const remote = projectPath(explicitRemotePath)
    if (!within(remote, REMOTE)) throw new LaneError('remote_path_outside_root', `Remote project must be within ${REMOTE}`)
    return remote
  }
  if (!within(local, MOUNT)) throw new LaneError('remote_path_required', 'Select an existing nezopt project; local Mac projects are not synchronized automatically')
  return REMOTE + local.slice(MOUNT.length)
}

export function quotePosix(argument: string): string {
  if (typeof argument !== 'string' || argument.includes('\u0000'))
    throw new LaneError('invalid_argument', 'Arguments cannot contain NUL')
  return "'" + argument.replaceAll("'", "'\\''") + "'"
}

export interface LaunchPlan {
  executable: string
  args: string[]
  cwd: string
  stdin?: string
  remote?: { host: 'nezopt'; executable: string; args: string[]; project: string }
}

export interface LaunchOptions {
  project: string
  remoteProject?: string
  prompt?: string
  interactive?: boolean
  qwenSlot?: QwenSlot
}

function sshPlan(cwd: string, project: string, executable: string, args: string[], interactive: boolean, stdin?: string): LaunchPlan {
  // SSH passes its final argument to a remote shell. Quote every fixed and variable argument here.
  const command = [executable, ...args].map(quotePosix).join(' ')
  return {
    executable: '/usr/bin/ssh', args: [...(interactive ? ['-t'] : []), '-o', 'ConnectTimeout=15', '--', 'nezopt', command], cwd,
    ...(stdin !== undefined ? { stdin } : {}),
    remote: { host: 'nezopt', executable, args, project },
  }
}

export function launchPlan(lane: LaneID | string, options: LaunchOptions): LaunchPlan {
  if (!LANES.some(item => item.id === lane)) throw new LaneError('unknown_lane', 'Unknown coding lane')
  const cwd = projectPath(options.project)
  if (lane === 'orchestra') throw new LaneError('mcp_required', 'Use orchestraRequest to dispatch through the existing authenticated bridge')
  if (lane === 'claude') {
    return { executable: '/Users/giuseppe/.local/bin/claude', args: options.prompt === undefined ? [] : ['-p', text(options.prompt, 'Prompt', true)], cwd }
  }
  const remote = remoteProject(cwd, options.remoteProject)
  if (lane === 'zcode') {
    if (options.interactive !== false && options.prompt === undefined)
      return sshPlan(cwd, remote, '/usr/bin/node', ['/home/nez/opt/zcode-appimage/resources/glm/zcode.cjs', '--cwd', remote], true)
    // Invoke the CLI directly so its normal permission defaults remain under user control.
    return sshPlan(cwd, remote, '/usr/bin/node', ['/home/nez/opt/zcode-appimage/resources/glm/zcode.cjs', '--cwd', remote, '--prompt', text(options.prompt, 'Prompt', true), '--json', '--no-color'], false)
  }
  if (options.qwenSlot !== 'free') throw new LaneError(options.qwenSlot === 'busy' ? 'qwen_busy' : 'qwen_status_unknown', 'Qwen has one shared slot. Wait for a confirmed free slot before launching')
  return sshPlan(cwd, remote, '/home/nez/.local/bin/qcode-run', ['-d', remote, '-t', '30m', '-n', '60', '-'], false, text(options.prompt, 'Prompt', true))
}

export function orchestraRequest(options: {
  project: string; remoteProject?: string; prompt: string; requestID: string; worker?: OrchestraWorker | string
}) {
  const worker = options.worker ?? 'zen-glm-flash'
  if (!Object.hasOwn(ORCHESTRA_WORKERS, worker)) throw new LaneError('unknown_worker', 'Select an available OpenCode Orchestra worker')
  return {
    name: 'dsh_prompt' as const,
    arguments: {
      workspace: remoteProject(options.project, options.remoteProject),
      prompt: text(options.prompt, 'Prompt', true), request_id: text(options.requestID, 'Request ID'),
      preferred_worker: worker, new_session: true, wait_seconds: 0,
    },
  }
}
