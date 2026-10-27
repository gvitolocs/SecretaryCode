// HTTP benchmark for the opencode v2 session surface.
// Usage: bun http-bench.ts <base-url> <duration-seconds> <concurrency>
// Measures ops/s and latency percentiles for the same four operations
// against both the original TypeScript server and oc-server (Rust).

const [base, durArg, concArg, user, pass] = process.argv.slice(2);
const durationS = Number(durArg ?? 10);
const concurrency = Number(concArg ?? 16);

if (!base) {
  console.error("usage: bun http-bench.ts <base-url> [duration-s] [concurrency] [user] [pass]");
  process.exit(64);
}

const AUTH = user && pass ? "Basic " + btoa(`${user}:${pass}`) : undefined;
const headers = AUTH ? { authorization: AUTH } : {};
const latencies = [];
let ops = 0;
let errors = 0;
let stop = false;

async function worker() {
  while (!stop) {
    const t0 = performance.now();
    try {
      const ok = await oneRound(base);
      if (!ok) errors++;
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t0);
    ops++;
  }
}

// One mixed round: create -> get -> list -> synthetic-message.
async function oneRound(base) {
  const create = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ title: "bench", agent: "build" }),
  });
  if (create.status !== 200 && create.status !== 201) return false;
  const body = await create.json();
  const info = body.info ?? body.data ?? body;
  const id = info.id;
  if (!id) return false;

  const get = await fetch(`${base}/api/session/${id}`, { headers });
  if (get.status !== 200) return false;

  const list = await fetch(`${base}/api/session?order=desc`, { headers });
  if (list.status !== 200) return false;
  await list.json();

  const synth = await fetch(`${base}/api/session/${id}/synthetic`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ text: "bench message" }),
  });
  return synth.status === 200 || synth.status === 201;
}

process.on("SIGINT", () => { stop = true; });

const workers = [];
const t0 = performance.now();
for (let i = 0; i < concurrency; i++) workers.push(worker());
setTimeout(() => { stop = true; }, durationS * 1000);
await Promise.allSettled(workers);
const wall = (performance.now() - t0) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? NaN;
console.log(JSON.stringify({
  base,
  wall_s: Number(wall.toFixed(2)),
  ops_total: ops,
  rounds_per_s: Number((ops / wall).toFixed(1)),
  http_errors: errors,
  latency_ms: {
    p50: Number(pct(0.5).toFixed(2)),
    p90: Number(pct(0.9).toFixed(2)),
    p99: Number(pct(0.99).toFixed(2)),
  },
  concurrency,
}, null, 2));
