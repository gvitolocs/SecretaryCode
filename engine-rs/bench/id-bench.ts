// Identifier generation benchmark — upstream algorithm verbatim from
// packages/opencode (schema/src/identifier.ts at v2.1.4), run with bun.
const length = 26;
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastTimestamp = 0;
let counter = 0;

function create(descending, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12));
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("");
}

const N = Number(process.argv[2] ?? 1_000_000);
// Same monotonic-timestamp trick the Rust bench uses so counters behave.
let fakeNow = 1_700_000_000_000;
const realDateNow = Date.now;
Date.now = () => fakeNow;
const t0 = performance.now();
let sink = 0;
for (let i = 0; i < N; i++) {
  if (i % 64 === 0) fakeNow += 1; // advance 1ms every 64 ids
  sink += create(i % 2 === 0).length;
}
const dt = performance.now() - t0;
Date.now = realDateNow;
console.log(JSON.stringify({
  lang: "ts/bun",
  ids: N,
  seconds: Number((dt / 1000).toFixed(3)),
  ids_per_s: Math.round(N / (dt / 1000)),
  sink_check: sink > 0,
}));
