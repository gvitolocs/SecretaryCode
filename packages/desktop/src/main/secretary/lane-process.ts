import { quotePosix } from "./lanes"

/** Keep raw output in memory only; redact the whole snapshot so split chunks cannot expose tokens. */
export function redactLaneOutput(value: string) {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\b(?:sk-(?:proj-)?|sec_|svc_|gh[pousr]_|github_pat_|lov_)[A-Za-z0-9_\-]{12,}/g, "[redacted]")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
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

export function supervisedSSH() {
  return { executable: "/usr/bin/ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", "nezopt", ["/usr/bin/python3", "-u", "-c", REMOTE_SUPERVISOR].map(quotePosix).join(" ")] }
}
