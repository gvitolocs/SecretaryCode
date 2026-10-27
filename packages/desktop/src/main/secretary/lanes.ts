import { homedir } from 'node:os'
import { posix } from 'node:path'
import copy from '../../renderer/secretary-lanes/en.json'

export const LANES = [
  { id: 'secretary', name: 'Secretary Code', location: 'mac', model: 'Workspace selection' },
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
const DEFAULT_HOSTS = ['nezopt', 'nezopt-remote']
// An SSH destination: an ssh_config alias or [user@]host. A leading '-' would read as an option.
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,252}$/

/** Remote lanes try SECRETARY_SSH_HOST, then SECRETARY_SSH_FALLBACK_HOST (defaults: nezopt, nezopt-remote). */
export function sshHosts(): string[] {
  const hosts = [process.env.SECRETARY_SSH_HOST || DEFAULT_HOSTS[0], process.env.SECRETARY_SSH_FALLBACK_HOST || DEFAULT_HOSTS[1]]
  const invalid = hosts.find(host => !HOST.test(host))
  if (invalid !== undefined) throw new LaneError('invalid_host', `SSH host ${JSON.stringify(invalid)} is not a valid host name or ssh_config alias`)
  return [...new Set(hosts)]
}

/** SECRETARY_CLAUDE_PATH overrides the native installer location, ~/.local/bin/claude. */
export function claudeExecutable(): string {
  const configured = process.env.SECRETARY_CLAUDE_PATH
  if (!configured) return posix.join(homedir(), '.local', 'bin', 'claude')
  if (!configured.startsWith('/')) throw new LaneError('invalid_path', 'SECRETARY_CLAUDE_PATH must be absolute')
  return configured
}

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
  interruptSignal?: 'SIGINT'
  outputFormat?: 'opencode-json'
  remote?: { host: string; executable: string; args: string[]; project: string }
}

export interface LaunchOptions {
  project: string
  remoteProject?: string
  prompt?: string
  model?: string
  interactive?: boolean
  qwenSlot?: QwenSlot
  /** SSH destination for remote lanes; defaults to the first of sshHosts(). */
  host?: string
}

function sshPlan(host: string, cwd: string, project: string, executable: string, args: string[], interactive: boolean, stdin?: string): LaunchPlan {
  // SSH passes its final argument to a remote shell. Quote every fixed and variable argument here.
  const command = [executable, ...args].map(quotePosix).join(' ')
  return {
    executable: '/usr/bin/ssh', args: [...(interactive ? ['-t'] : []), '-o', 'ConnectTimeout=15', '--', host, command], cwd,
    ...(stdin !== undefined ? { stdin } : {}),
    remote: { host, executable, args, project },
  }
}

export function launchPlan(lane: LaneID | string, options: LaunchOptions): LaunchPlan {
  if (!LANES.some(item => item.id === lane)) throw new LaneError('unknown_lane', 'Unknown coding lane')
  const cwd = projectPath(options.project)
  if (lane === 'secretary') {
    const executable = process.env.SECRETARY_ENGINE_PATH
    if (!executable || !executable.startsWith('/')) throw new LaneError('engine_unavailable', copy.engineUnavailable)
    const model = options.model?.trim()
    if (model && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[^\s\u0000-\u001f]+$/u.test(model))
      throw new LaneError('invalid_model', copy.invalidModel)
    return { executable, args: ['run', '--format', 'json', ...(model ? ['--model', model] : [])], cwd, stdin: text(options.prompt, 'Prompt', true), interruptSignal: 'SIGINT', outputFormat: 'opencode-json' }
  }
  if (lane === 'orchestra') throw new LaneError('mcp_required', 'Use orchestraRequest to dispatch through the existing authenticated bridge')
  if (lane === 'claude') {
    // `-p` is a boolean flag and the prompt a positional argument, so a prompt in argv that looks like a
    // flag (`--dangerously-skip-permissions`) would be parsed as one. Print mode reads the prompt from stdin.
    const executable = claudeExecutable()
    return options.prompt === undefined ? { executable, args: [], cwd } : { executable, args: ['-p'], cwd, stdin: text(options.prompt, 'Prompt', true) }
  }
  const remote = remoteProject(cwd, options.remoteProject)
  const host = options.host ?? sshHosts()[0]!
  if (lane === 'zcode') {
    if (options.interactive !== false && options.prompt === undefined)
      return sshPlan(host, cwd, remote, '/usr/bin/node', ['/home/nez/opt/zcode-appimage/resources/glm/zcode.cjs', '--cwd', remote], true)
    // Invoke the CLI directly so its normal permission defaults remain under user control. The attached
    // `--prompt=` form keeps a prompt that starts with `-` from being read as another option.
    return sshPlan(host, cwd, remote, '/usr/bin/node', ['/home/nez/opt/zcode-appimage/resources/glm/zcode.cjs', '--cwd', remote, `--prompt=${text(options.prompt, 'Prompt', true)}`, '--json', '--no-color'], false)
  }
  if (options.qwenSlot === 'busy') throw new LaneError('qwen_busy', 'Qwen is busy with another task. It has one shared slot, so try again when that task finishes')
  if (options.qwenSlot !== 'free') throw new LaneError('qwen_status_unknown', 'Could not confirm that the shared Qwen slot is free, so Qwen was not started')
  return sshPlan(host, cwd, remote, '/home/nez/.local/bin/qcode-run', ['-d', remote, '-t', '30m', '-n', '60', '-'], false, text(options.prompt, 'Prompt', true))
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
