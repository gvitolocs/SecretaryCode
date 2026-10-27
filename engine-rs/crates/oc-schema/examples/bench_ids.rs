//! Identifier generation benchmark for the Rust port.
//! Run: cargo run --release -p oc-schema --example bench_ids [N]

use oc_schema::identifier;

fn main() {
    let n: u64 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(1_000_000);
    // Feed deterministic timestamps through the public create() so the
    // counter behaves like production (1ms advances every 64 ids).
    let mut fake_now: u64 = 1_700_000_000_000;
    let mut sink: usize = 0;
    let t0 = std::time::Instant::now();
    for i in 0..n {
        if i % 64 == 0 {
            fake_now += 1;
        }
        sink += identifier::create(i % 2 == 0, fake_now).len();
    }
    let dt = t0.elapsed().as_secs_f64();
    println!(
        "{}",
        serde_json::json!({
            "lang": "rust",
            "ids": n,
            "seconds": (dt * 1000.0).round() / 1000.0,
            "ids_per_s": (n as f64 / dt) as u64,
            "sink_check": sink > 0,
        })
    );
}
