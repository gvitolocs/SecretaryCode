#!/usr/bin/env python3
"""Sequential DSH/LucinaCode test, one existing Qwen endpoint, no dependencies.

Uses separate workspaces, histories and the exact same user prompt. The proxy
pins inference settings for both harnesses; their system prompts/tools differ.
No Authorization headers or secret values are recorded.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROMPT = """Fix the bugs in this small Python timesheet project. Read README.md and the code, run the existing tests, implement the documented behavior, and add regression tests for the edge cases you fix. Keep the public function names and command-line interface. Use only the Python standard library. Do not weaken or remove tests. Run python3 -m unittest -v and report what changed and whether tests pass."""
README = """# Timesheet
timesheet.py exposes parse_minutes(text), summarize(rows), and main(argv=None).
parse_minutes accepts a nonnegative integer number of minutes, optionally
surrounded by whitespace, or H:MM with minutes exactly two digits in 00..59.
Hours have one or more digits. Reject signs, decimals, empty input, and other
malformed values with ValueError. Zero is valid.
summarize takes iterable dicts with project and duration fields. Strip project
whitespace, match project names case-insensitively, ignore blank project names,
add every duration (including duplicates), and return sorted lowercase keys
mapped to integer minutes. Invalid durations on nonblank projects raise ValueError.
CLI: python3 timesheet.py FILE.csv reads a UTF-8 CSV with project,duration headers
and prints one JSON object containing those totals. Never print logging on stdout.
Missing required headers or an invalid duration must produce an explanatory
stderr message and exit status 2, without a traceback. Accept UTF-8 BOM headers.
"""
SOURCE = '''import csv
import json
import sys


def parse_minutes(text):
    if ":" in text:
        hours, minutes = text.split(":")
        return int(hours) * 100 + int(minutes)
    return int(text)


def summarize(rows):
    totals = {}
    for row in rows:
        project = row["project"].strip()
        if project:
            totals[project] = parse_minutes(row["duration"])
    return totals


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    with open(argv[0], encoding="utf-8") as stream:
        result = summarize(csv.DictReader(stream))
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''
TESTS = '''import unittest
from timesheet import parse_minutes, summarize

class TimesheetTests(unittest.TestCase):
    def test_minutes(self):
        self.assertEqual(parse_minutes("15"), 15)
    def test_hours(self):
        self.assertEqual(parse_minutes("1:30"), 90)
    def test_accumulates(self):
        self.assertEqual(summarize([{"project": "Work", "duration": "5"}, {"project": " work ", "duration": "7"}]), {"work": 12})

if __name__ == "__main__":
    unittest.main()
'''


def evaluate(work):
    """Independent assertions outside model-written tests; each reports pass/fail."""
    code = r'''
import contextlib, importlib.util, io, json, pathlib, tempfile
spec = importlib.util.spec_from_file_location("candidate", "timesheet.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
results = {}
def check(name, fn):
    try:
        fn()
        results[name] = True
    except Exception:
        results[name] = False
def eq(a, b):
    assert a == b, (a, b)
def invalid(s):
    try: m.parse_minutes(s)
    except ValueError: return
    raise AssertionError(s)
for s, expected in [("0",0),(" 15 ",15),("2:05",125),("000:59",59),(" 1:00 ",60),("123:00",7380)]:
    check("parse:"+s, lambda s=s,e=expected: eq(m.parse_minutes(s),e))
for s in ["", "-1", "+1", "1.5", "1:60", "1:5", "1:005", "1:00:00", "-1:00", "1 :00", "1: 00", "abc", "1_0"]:
    check("reject:"+s, lambda s=s: invalid(s))
check("totals",lambda: eq(m.summarize(iter([{"project":" B ","duration":"1:00"},{"project":"a","duration":"2"},{"project":"b","duration":"5"},{"project":"A","duration":"2"},{"project":"  ","duration":"bad"} ])),{"a":4,"b":65}))
check("sort",lambda: eq(list(m.summarize([{"project":"z","duration":"0"},{"project":"A","duration":"0"}])),["a","z"]))
def cli(data, expected, status):
    import subprocess, sys
    with tempfile.TemporaryDirectory() as d:
        p=pathlib.Path(d)/"input.csv"; p.write_text(data,encoding="utf-8")
        out=subprocess.run([sys.executable,"timesheet.py",str(p)],capture_output=True,text=True,timeout=10)
        eq(out.returncode,status)
        if status==0: eq(json.loads(out.stdout),expected)
        else:
            assert out.stderr.strip() and "Traceback" not in out.stderr
            assert not out.stdout.strip()
check("cli",lambda: cli("project,duration\nWork,1:30\nwork,5\n",{"work":95},0))
check("bom",lambda: cli("\ufeffproject,duration\na,3\n",{"a":3},0))
check("missing-header",lambda: cli("project,other\na,3\n",None,2))
check("bad-duration",lambda: cli("project,duration\na,1:60\n",None,2))
print(json.dumps(results))
'''
    result = subprocess.run(["python3", "-c", code], cwd=work, capture_output=True, text=True, timeout=40)
    return json.loads(result.stdout) if result.returncode == 0 else {"evaluator_error": result.stderr}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--rust", type=Path, required=True)
    ap.add_argument("--dsh-home", type=Path, required=True)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--harnesses", nargs="+", choices=["dsh", "rust"], default=["dsh", "rust"])
    args = ap.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    lock = threading.Lock()
    records = []
    active_run = {"label": None}
    settings = {"model":"qwen3.8:27b-q4-72k", "temperature":0.2, "top_p":0.95,
                "seed":42, "max_tokens":8192, "reasoning_effort":"medium",
                "chat_template_kwargs":{"enable_thinking":True,"reasoning_effort":"medium"}}

    class Proxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"
        def log_message(self, *_):
            pass
        def do_POST(self):
            started = time.monotonic()
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            label = self.path.split("/")[1]
            body.update(settings)
            entry = {"harness":label,"run_label":active_run["label"],"started":time.time(),"settings":settings,
                     "messages":len(body.get("messages",[])),
                     "tools":[t.get("function",{}).get("name") for t in body.get("tools",[])],
                     "user_prompt_sha256":hashlib.sha256(PROMPT.encode()).hexdigest()}
            conn = http.client.HTTPConnection("127.0.0.1",11436,timeout=args.timeout)
            headers={"Content-Type":"application/json"}
            keyfile=Path.home()/".config/llama-server-api.key"
            if keyfile.exists(): headers["Authorization"]="Bearer "+keyfile.read_text().strip()
            try:
                conn.request("POST","/v1/chat/completions",json.dumps(body),headers)
                response=conn.getresponse()
                entry["status"]=response.status
                entry["response_headers_ms"]=(time.monotonic()-started)*1000
                self.send_response(response.status)
                self.send_header("Content-Type",response.getheader("Content-Type","application/json"))
                self.end_headers()
                buf=b""
                while chunk:=response.read1(16384):
                    entry.setdefault("first_bytes_ms",(time.monotonic()-started)*1000)
                    self.wfile.write(chunk); self.wfile.flush()
                    buf+=chunk
                    while b"\n" in buf:
                        line,buf=buf.split(b"\n",1)
                        if line.startswith(b"data: {"):
                            packet=json.loads(line[6:])
                            if packet.get("usage"): entry["usage"]=packet["usage"]
                            if packet.get("timings"):
                                entry["provider_timings"]={k:v for k,v in packet["timings"].items() if isinstance(v,(int,float))}
                            for choice in packet.get("choices",[]):
                                delta=choice.get("delta",{})
                                for key,metric in [("reasoning_content","reasoning_bytes"),("content","text_bytes")]:
                                    if isinstance(delta.get(key),str) and delta[key]:
                                        entry[metric]=entry.get(metric,0)+len(delta[key].encode())
                                        entry.setdefault("first_delta_ms",(time.monotonic()-started)*1000)

            except Exception as exc:
                entry["error"]=str(exc)
            finally:
                conn.close()
                entry["elapsed_seconds"]=round(time.monotonic()-started,3)
                with lock:
                    records.append(entry)
                    (args.output/"requests.json").write_text(json.dumps(records,indent=2))

    proxy=ThreadingHTTPServer(("127.0.0.1",18436),Proxy)
    threading.Thread(target=proxy.serve_forever,daemon=True).start()
    results=[]
    try:
        for n in range(args.rounds):
            for harness in ([h for h in (["dsh","rust"] if n%2==0 else ["rust","dsh"]) if h in args.harnesses]):
                label=f"{n+1}-{harness}"
                active_run["label"]=label
                work=args.output/label
                work.mkdir()
                for name,text in {"README.md":README,"timesheet.py":SOURCE,"test_timesheet.py":TESTS}.items():
                    (work/name).write_text(text)
                subprocess.run(["git","init","-q",str(work)],check=True)
                before=evaluate(work)
                env=os.environ.copy()
                env.pop("OC_BASE",None)
                env.update(OC_BASE_URL="http://127.0.0.1:18436/rust/v1",OC_MODEL="openai/"+settings["model"],
                           OC_DATA=str(args.output/(label+"-history")),OC_CONTEXT_WINDOW="122880",OC_MAX_STEPS="24",
                           OC_PERMISSIONS='[{"action":"*","resource":"*","effect":"allow"}]',OC_VERBOSE="1",
                           BENCH_LOCAL_KEY="benchmark-local-proxy",DSH_HOME=str(args.dsh_home),DSH_PERMISSION_MODE="danger-full-access",DSH_CWD=str(work))
                command=[str(args.rust),"--local","ask",PROMPT,str(work)] if harness=="rust" else ["dsh","headless",PROMPT]
                started=time.monotonic()
                with (work/"stdout.log").open("w") as stdout,(work/"stderr.log").open("w") as stderr:
                    proc=subprocess.Popen(command,cwd=work,env=env,stdout=stdout,stderr=stderr,start_new_session=True)
                    try: code=proc.wait(timeout=args.timeout)
                    except subprocess.TimeoutExpired:
                        import signal
                        os.killpg(proc.pid,signal.SIGTERM)
                        try: proc.wait(timeout=10)
                        except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL); proc.wait()
                        code=124
                elapsed=round(time.monotonic()-started,3)
                after=evaluate(work)
                check=subprocess.run(["python3","-m","unittest","-v"],cwd=work,capture_output=True,text=True,timeout=30)
                (work/"test-result.log").write_text(check.stdout+check.stderr)
                row={"label":label,"harness":harness,"exit":code,"elapsed_seconds":elapsed,
                     "baseline_passed":sum(v is True for v in before.values()),"checks":len(after),
                     "passed":sum(v is True for v in after.values()),"details":after,"tests_exit":check.returncode}
                results.append(row)
                (args.output/"results.json").write_text(json.dumps({"prompt":PROMPT,"inference":settings,"runs":results},indent=2))
                print(json.dumps(row),flush=True)
    finally:
        proxy.shutdown()


if __name__=="__main__":
    main()
