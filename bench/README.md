# Harness checks, 2026-11-04

These are small, controlled checks, not a general coding-agent leaderboard.
All candidates used existing credentials; no fallback model or second Qwen
instance was started. Each task began with independent, identical files and
the same user prompt. Harness system prompts and tool catalogs differ.

## Mistral Small: one shell bug

Exact prompt:

> Fix calc.sh so sh test.sh passes. Read the files, make the smallest correction, and run sh test.sh. Do not change test.sh.

`calc.sh` incorrectly subtracts in `add`; the unchanged test checks positive
and negative operands. All four candidates fixed the file and independently
passed `sh test.sh`. Model: `mistral-small-latest`, direct Mistral HTTPS.

| Harness on nezopt | Process wall time | Peak RSS | Total input including cache | Output |
| --- | ---: | ---: | ---: | ---: |
| LucinaCode Rust, optimized | 4.420 s | 7.3 MiB | 11,987 | 243 |
| DSH 0.2.0-rc.2 headless | 4.971 s | not measured | 31,215 | 296 |
| Goose 1.57.0 static musl | 6.273 s | 82.0 MiB | 14,657 | 470 |
| Mistral Vibe 3.0.4 | 7.077 s | 170.8 MiB | 35,049 | 179 |

Only one run each: API latency, cache state, model sampling, and tool selection
affect the result. Goose recovered from six inappropriate image-tool calls;
its larger tool catalog matters with this model. Vibe's separate attempt to
write Rust regression tests guessed nonexistent APIs and required independent
correction. Neither observation establishes general model or harness quality.

On real Juno, the static Rust CLI also passed the same task with edit/shell
approvals in 2.9 s of runner time. That time excludes process startup and is
not directly comparable to the process wall times above. Native Vibe execution
on Juno is a separate deployment check; its server run is not a Juno result.

Mistral API keys and Vibe-scoped credentials may have different product scope.
These runs used the existing supplied Mistral credential; they do not prove
which included allowance was consumed. No pay-as-you-go setting was changed.

## Qwen 3.8 27B: CSV timesheet repair

`compare_qwen.py` seeds an identical Python project for each harness. The task
requires strict duration parsing, aggregation, CSV/BOM support, useful CLI
errors, and regression tests. Independent assertions live outside the
candidate's tests. The buggy baseline passes 7 of 25 checks.

Both clients use the same existing gateway and model. A loopback proxy pins
temperature 0.2, top_p 0.95, seed 42, max_tokens 8192 and medium thinking for
both. It records usage and model settings, never Authorization headers.
Runs are sequential because the GPU has one inference slot.

| Completed run | Independent checks | Candidate tests | Process wall time |
| --- | ---: | --- | ---: |
| LucinaCode Rust | 25/25 | PASS | 229.944 s |
| DSH headless | 25/25 | PASS | 164.418 s |

These single runs favor DSH on elapsed time for this task. They do not support
claiming the Rust port makes model generation faster. The first Rust run had
background jobs but preceded final task-tool registration. An extra Rust run
was cancelled after the user's focus shifted to Mistral; its files also passed
25/25, but its time and interrupted exit are excluded. DSH setup failures
(profile migration, then missing local-proxy credential) occurred before model
execution and are excluded from coding results.

### After reasoning replay and the output-limit fix (same day, later)

Codex traced the gap above to two things:
- **Reasoning was dropped between steps.** Qwen redid its analysis at every
  step. On a frozen request it hit the 8,192-token limit after 131.8 s; with
  its reasoning kept it answered in 199 tokens and 3.0 s.
- **A truncated response counted as success.** A turn that stopped on
  `length` before any edit still reported "succeeded".

Both are fixed as upstream does them; see the main README.

The rerun used the same task, proxy and inference settings, with release
`oc-cli` at 969609c and DSH 0.2.0-rc.2. Runs were sequential and held the
Qwen Code lock, so no other Qwen Code task overlapped.

How each run's wall time is split (`bench_split`, a Rust example in oc-agent):
- prompt processing and generation: llama.cpp's own per-request `timings`
- queue: the rest of each request's HTTP time (gateway admission, the slot
  busy with another client), minus a run's own overlapping requests
- preempted: requests the gateway cut so the owner's DSH session could go
  first, which is work thrown away

| Run | Checks | Wall | Queue | Prompt | Generation | Outside model | Tokens out |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| LucinaCode A | 25/25 | 155.9 s | 1.9 s | 9.4 s | 144.4 s | 0.3 s | 8,211 |
| LucinaCode B | 25/25 | 131.3 s | 1.0 s | 11.7 s | 118.3 s | 0.3 s | 6,755 |
| DSH A | 25/25 | 174.6 s | 3.4 s | 20.9 s | 147.0 s | 3.2 s | 7,695 |
| DSH B | 25/25 | 209.7 s | 2.0 s | 18.5 s | 187.6 s | 1.5 s | 11,406 |
| DSH C | 25/25 | 200.1 s | 2.8 s | 20.3 s | 175.4 s | 1.5 s | 10,490 |

Every run's own tests passed as well.

- **Means:** LucinaCode 143.6 s and 7,483 tokens; DSH 194.8 s and 9,864 tokens.
  Before the fix LucinaCode took 229.9 s and 13,361 tokens.
- **Where the time goes:** generation is 84-93 % of every run, so the harness
  work is not the difference. The difference is how many tokens Qwen writes.
- **What the trace shows:** after the roughly 11-15 KB analysis step,
  LucinaCode's write step now needs about 0.9 KB of reasoning. Before the fix
  it needed 7,531 tokens.
- **What these runs do not show:** that LucinaCode is faster than DSH. Two and
  three runs of a sampled model at seed 42 are not enough. The fair reading is
  that LucinaCode now matches DSH on this task.
- **Excluded run:** one LucinaCode run (725.5 s wall). The gateway preempted
  it once for the owner's session (130.9 s of generation thrown away) and held
  it for 354 s of queue. Even so, it scored 25/25.
- **Conditions:** Tctl was 88-96 °C, so generation ran at 52-61 tokens/s
  against about 63 earlier.
- **Data:** normalized results are in `results/2026-11-04-reasoning-replay.json`.

Re-run with a dedicated DSH home configured to use
`http://127.0.0.1:18436/dsh/v1`, provider credential environment variable
`BENCH_LOCAL_KEY`, and model `qwen3.8:27b-q4-72k`:

```sh
python3 bench/compare_qwen.py \
  --output /absolute/path/to/new-results \
  --rust /absolute/path/to/oc-cli \
  --dsh-home /absolute/path/to/isolated-dsh-home --rounds 1
```

Run it from a shell that has `~/.local/bin` on `PATH`: a non-interactive SSH
shell finds `/usr/bin/dsh` 0.1.2 instead, which needs `--profile` and fails.
Then `cargo run -p oc-agent --example bench_split -- OUT [gateway.jsonl] [tctl.log]`
writes `OUT/split.json` and prints the table.

The output directory must be new. `--harnesses dsh` or `--harnesses rust`
selects one client. The proxy forwards to loopback `:11436`; when present it
reads `~/.config/llama-server-api.key` without printing it. Do not point a live
DSH profile at the temporary proxy or alter a shared model service for this test.

Full local traces and JSON results are under
`/home/nez/scratch/lucinacode-parity-20261104/`. The normalized checked-in results
omit prompt traces, credentials, and provider account details.
