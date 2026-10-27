import { spawn } from "node:child_process"
import { quotePosix } from "./lanes"

/** Keep raw output in memory only; redact the whole snapshot so split chunks cannot expose tokens. */
export function redactLaneOutput(value: string) {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\b(?:sk-(?:proj-)?|sec_|svc_|mcp_|gh[pousr]_|github_pat_|lov_)[A-Za-z0-9_\-]{12,}/g, "[redacted]")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
}

/** The bundled engine emits JSONL. Show its replies, tool results and errors, without protocol bookkeeping. */
export function engineOutput(value: string) {
  return value.split('\n').flatMap(line => {
    if (!line.trim()) return []
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { return line.startsWith('{') ? [] : [line] }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const event = parsed as Record<string, unknown>
    const part = event.part && typeof event.part === 'object' ? event.part as Record<string, unknown> : undefined
    if (event.type === 'text' && typeof part?.text === 'string') return [part.text]
    if (event.type === 'error' && event.error && typeof event.error === 'object') {
      const error = event.error as Record<string, unknown>
      return typeof error.message === 'string' ? [error.message] : []
    }
    if (event.type !== 'tool_use' || !part?.state || typeof part.state !== 'object') return []
    const state = part.state as Record<string, unknown>
    if (state.status !== 'completed' && state.status !== 'error') return []
    const title = typeof state.title === 'string' ? state.title : typeof part.tool === 'string' ? part.tool : ''
    const result = typeof state.output === 'string' ? state.output : typeof state.error === 'string' ? state.error : ''
    return [title, result].filter(Boolean)
  }).join('\n')
}

// stdin remains open for the lifetime of SSH. EOF means the desktop disconnected: stop the
// entire remote child group. Existing flash-do.py then cancels its Orchestra request on SIGTERM.
export const REMOTE_SUPERVISOR = String.raw`import json,os,signal,subprocess,sys,tempfile,threading,time
p=json.loads(sys.stdin.readline())
taskfile=None
child=None
stopping=threading.Event()
def stop(*args):
    stopping.set()
    if child and child.poll() is None:
        try: os.killpg(child.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        def force():
            time.sleep(65)
            if child.poll() is None:
                try: os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError: pass
        threading.Thread(target=force,daemon=True).start()
for sig in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT): signal.signal(sig,stop)
try:
    if not os.path.isdir(p['cwd']): raise RuntimeError('Remote project directory does not exist: '+p['cwd'])
    command=p['command']
    if p.get('orchestra'):
        f=tempfile.NamedTemporaryFile(mode='w',prefix='secretary-code-',suffix='.txt',delete=False)
        taskfile=f.name
        with f: f.write(p['prompt'])
        command=['/usr/bin/python3','/home/nez/.local/share/newsroom/flash-do.py',p['cwd'],taskfile,'--worker',p['worker'],'--wait-min','30']
    child=subprocess.Popen(command,cwd=p['cwd'],stdin=subprocess.PIPE,start_new_session=True)
    if p.get('input'): child.stdin.write(p['input'].encode())
    child.stdin.close()
    def disconnect():
        sys.stdin.read()
        stop()
    threading.Thread(target=disconnect,daemon=True).start()
    if stopping.is_set(): stop()
    sys.exit(child.wait())
finally:
    if taskfile:
        try: os.unlink(taskfile)
        except FileNotFoundError: pass
`

export function supervisedSSH(host: string) {
  return { executable: "/usr/bin/ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", host, ["/usr/bin/python3", "-u", "-c", REMOTE_SUPERVISOR].map(quotePosix).join(" ")] }
}

/**
 * Runs one fixed remote check on each host in order and returns the first host that answered with its exit
 * code. SSH reserves exit 255 for its own connection failures, so only that moves on to the fallback host.
 */
export async function reach(hosts: readonly string[], command: string) {
  for (const host of hosts) {
    const code = await new Promise<number | null>(resolve => {
      const child = spawn("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", host, command], { stdio: "ignore", shell: false })
      const timer = setTimeout(() => child.kill(), 12_000)
      child.on("error", () => { clearTimeout(timer); resolve(255) })
      child.on("close", code => { clearTimeout(timer); resolve(code) })
    })
    if (code !== 255) return { host, code }
  }
  return undefined
}
