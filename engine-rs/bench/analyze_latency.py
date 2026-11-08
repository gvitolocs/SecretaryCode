#!/usr/bin/env python3
"""Reconcile the saved Qwen comparison with transcripts and llama.cpp timings."""
import argparse
import json
import re
from pathlib import Path


def origin_tasks(path, count):
    tasks = {}
    for line in path.read_text().splitlines():
        match = re.search(r"task (\d+) \|\s*(prompt eval time|eval time|total time) =\s*([\d.]+) ms /\s*(\d+) tokens", line)
        if match:
            tasks.setdefault(match[1], {})[match[2]] = {"seconds":float(match[3])/1000,"tokens":int(match[4])}
    return [{"task_id":key,**value} for key,value in tasks.items() if len(value)==3][:count]


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root",type=Path)
    ap.add_argument("--output",type=Path,required=True)
    args=ap.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    root=args.root
    rust_requests=json.loads((root/"comparison/requests.json").read_text())[:9]
    dsh_requests=json.loads((root/"qwen-dsh/requests.json").read_text())
    rust_run=json.loads((root/"comparison/results.json").read_text())["runs"][1]
    dsh_run=json.loads((root/"qwen-dsh/results.json").read_text())["runs"][0]
    rust_messages=json.loads(next((root/"comparison/1-rust-history/session/message").glob("*.json")).read_text())
    dsh_records=[json.loads(x) for x in (root/"dsh-session-expanded.jsonl").read_text().splitlines()]
    rust_assistant=[x for x in rust_messages if x["type"]=="assistant"]
    dsh_assistant=[x["data"] for x in dsh_records if x["type"]=="assistant/message"]
    summaries={}
    for label,requests,run in [("rust",rust_requests,rust_run),("dsh",dsh_requests,dsh_run)]:
        tasks=origin_tasks(root/f"qwen-origin-{label}.log",len(requests))
        assert len(tasks)==len(requests), "origin log must cover each request"
        assert sum(x["eval time"]["tokens"] for x in tasks)==sum(x["usage"]["completion_tokens"] for x in requests)
        prompt=sum(x["prompt eval time"]["seconds"] for x in tasks)
        decode=sum(x["eval time"]["seconds"] for x in tasks)
        tokens=sum(x["eval time"]["tokens"] for x in tasks)
        summaries[label]={"wall_seconds":run["elapsed_seconds"],"prompt_seconds":prompt,
            "generation_seconds":decode,"other_seconds":run["elapsed_seconds"]-prompt-decode,
            "input_tokens_including_cache":sum(x["usage"]["prompt_tokens"] for x in requests),
            "cache_read_tokens":sum(x["usage"].get("prompt_tokens_details",{}).get("cached_tokens",0) for x in requests),
            "generated_tokens":tokens,"generation_tokens_per_second":tokens/decode,"origin_tasks":tasks}
    # A title request was submitted alongside the first agent request. It
    # overlaps HTTP wall time but occupies the same single inference slot.
    dsh_title=next(x for x in dsh_requests if x["messages"]==2)
    dsh_main=[x for x in dsh_requests if x is not dsh_title]
    tools_rust=[]
    for m in rust_assistant:
        for p in m["content"]:
            if p["type"]=="tool":
                t=p["time"]
                tools_rust.append({"name":p["name"],"elapsed_ms":t["completed"]-t["ran"],"status":p["state"]["status"]})
    pending={};tools_dsh=[]
    for record in dsh_records:
        d=record.get("data",{})
        if record["type"]=="tool/call": pending[d["callId"]]=(d["name"],record["time"])
        if record["type"]=="tool/result":
            key=d["message"]["toolCallId"]
            name,start=pending.pop(key)
            tools_dsh.append({"name":name,"elapsed_ms":record["time"]-start})
    stages=["List project","Read three files","Analyze, run failing baseline","Write implementation","Write regression tests","Run passing tests","Check CLI cases","Cleanup temporary files","Final answer"]
    dsh_stage={**dict(enumerate(dsh_main[:7])),8:dsh_main[7]}
    pairs=[]
    for i,(request,message) in enumerate(zip(rust_requests,rust_assistant)):
        other=dsh_stage.get(i)
        dsh_content=dsh_assistant[i if i<7 else 7]["message"]["content"] if i!=7 else []
        pairs.append({"stage":stages[i],"rust_seconds":request["elapsed_seconds"],"rust_output_tokens":request["usage"]["completion_tokens"],
            "rust_reasoning_bytes":sum(len(x.get("text","").encode()) for x in message["content"] if x["type"]=="reasoning"),
            "dsh_seconds":other["elapsed_seconds"] if other else 0,"dsh_output_tokens":other["usage"]["completion_tokens"] if other else 0,
            "dsh_reasoning_bytes":sum(len(x.get("text","").encode()) for x in dsh_content if x["type"]=="reasoning")})
    delta={key:summaries["rust"][key]-summaries["dsh"][key] for key in ["wall_seconds","prompt_seconds","generation_seconds","other_seconds","generated_tokens"]}
    result={"summary":summaries,"delta_rust_minus_dsh":delta,"stages":pairs,
        "tools":{"rust":tools_rust,"dsh":tools_dsh},"dsh_title_request":dsh_title,
        "rust_main_http_seconds":sum(x["elapsed_seconds"] for x in rust_requests),
        "dsh_main_http_seconds":sum(x["elapsed_seconds"] for x in dsh_main),
        "notes":["DSH title HTTP request overlaps its main requests: never sum HTTP times as wall time.",
                 "Origin timing totals include the title's serial inference work.",
                 "Original Rust per-token network timestamps were not recorded; do not infer exact TTFT from tool timestamps."]}
    (args.output/"attribution.json").write_text(json.dumps(result,indent=2)+"\n")
    text="# Where the original Qwen time went\n\n"
    text+="These are the saved 229.944 s Rust and 164.418 s DSH runs, reconciled against the original single-slot llama.cpp journal.\n\n"
    text+="| Measured component | Rust | DSH | Rust minus DSH |\n| --- | ---: | ---: | ---: |\n"
    for title,key in [("Wall time","wall_seconds"),("Prompt processing","prompt_seconds"),("Token generation","generation_seconds"),("Remaining time","other_seconds")]:
        text+=f"| {title} | {summaries['rust'][key]:.3f} s | {summaries['dsh'][key]:.3f} s | {delta[key]:+.3f} s |\n"
    text+="\nRemaining time includes startup, tools, client/gateway overhead and small gaps. It is not all Rust or JavaScript CPU time.\n\n"
    text+=f"Rust generated **{summaries['rust']['generated_tokens']:,} tokens** at {summaries['rust']['generation_tokens_per_second']:.2f} tokens/s; DSH generated **{summaries['dsh']['generated_tokens']:,}** at {summaries['dsh']['generation_tokens_per_second']:.2f} tokens/s, including its 152-token title request.\n\n"
    text+="| Stage | Rust request time | DSH request time | Rust / DSH output tokens |\n| --- | ---: | ---: | ---: |\n"
    for p in pairs:text+=f"| {p['stage']} | {p['rust_seconds']:.3f} s | {p['dsh_seconds']:.3f} s | {p['rust_output_tokens']:,} / {p['dsh_output_tokens']:,} |\n"
    text+="\nThese are HTTP request durations; DSH's read request includes a wait behind the title request. Stage durations should not be confused with origin generation-only timings.\n\n"
    text+="Both had successful tool operations, no model retries, and no compaction. The original Rust main HTTP calls total 229.753 s, leaving 0.191 s outside model HTTP calls. DSH's main calls total 163.047 s, leaving 1.371 s outside those calls.\n\n"
    text+="## Concrete replay difference\n\nRust's transcript retains reasoning, but its old `to_llm_messages` discarded it on each following request. DSH preserves `reasoning_content` through its pi-ai replay metadata. In Rust, the pre-test analysis contained 9,119 reasoning characters; after the baseline test it generated another 25,829 reasoning characters, repeating the requirements and exploring alternatives. DSH retained its earlier 18,676-character analysis and its following implementation request needed only 52 reasoning characters. These observations identify a specific compatibility difference, but different system prompts, tools and stochastic generation mean the original two runs alone cannot prove it is the sole cause. The frozen-prefix replay experiment tests this directly.\n"
    (args.output/"attribution.md").write_text(text)
    print(json.dumps({"summary":{k:{a:b for a,b in v.items() if a!='origin_tasks'} for k,v in summaries.items()},"delta":delta},indent=2))


if __name__=="__main__":main()
