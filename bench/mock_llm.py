#!/usr/bin/env python3
"""A scripted OpenAI-compatible endpoint for the live smoke.

First completion returns a bash tool call; every later one returns a final
text. Run it, point oc-server at it, and `oc-cli ask` exercises the whole
stack: server -> agent loop -> provider (real HTTP) -> real tool execution ->
persistence -> transcript.

Usage: python3 mock_llm.py [port]   (default 18901)
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18901
calls = {"count": 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        calls["count"] += 1
        n = calls["count"]
        if n == 1:
            resp = {
                "id": "chatcmpl-mock1",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_smoke_1",
                            "type": "function",
                            "function": {
                                "name": "shell",
                                "arguments": json.dumps({
                                    "command": "printf 'smoke-%s' oc-rust > smoke.txt",
                                }),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 42, "completion_tokens": 17},
            }
        else:
            resp = {
                "id": f"chatcmpl-mock{n}",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "Smoke complete: the file was written by the bash tool."},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 84, "completion_tokens": 9},
            }
        out = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


if __name__ == "__main__":
    print(f"mock llm on http://127.0.0.1:{PORT}/v1 (scripted, {calls})")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
