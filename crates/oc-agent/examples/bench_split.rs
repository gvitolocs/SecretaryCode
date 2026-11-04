//! Split a `bench/compare_qwen.py` run's wall time into queue, prompt
//! processing, generation and the rest, per harness run.
//!
//! Usage: bench_split OUT_DIR [GATEWAY_JSONL] [TCTL_LOG]
//!
//! OUT_DIR holds `results.json` and `requests.json` from compare_qwen.py.
//! Per request, llama.cpp's own `timings` give prompt and generation time;
//! the rest of the request's HTTP time is waiting (gateway admission, the
//! single slot busy with someone else, model load). Waiting while another
//! request of the same run is in flight (DSH's title request) is the run's
//! own and is counted apart from waiting on other clients. The gateway log,
//! when given, adds owner-priority holds; the Tctl log the hottest reading.
//! Writes OUT_DIR/split.json and prints a Markdown table.
use serde_json::{json, Value};

fn read(path: &std::path::Path) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
}

fn num(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Total length covered by at least `depth` of the intervals.
fn covered(intervals: &[(f64, f64)], depth: usize) -> f64 {
    let mut edges: Vec<(f64, i32)> = intervals
        .iter()
        .flat_map(|&(a, b)| [(a, 1), (b, -1)])
        .collect();
    edges.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
    let (mut level, mut last, mut total) = (0i32, 0.0, 0.0);
    for (t, d) in edges {
        if level as usize >= depth {
            total += t - last;
        }
        level += d;
        last = t;
    }
    total
}

/// RFC 3339 UTC (`2026-11-04T14:09:23Z`) to Unix seconds.
fn unix(ts: &str) -> Option<f64> {
    let b = ts.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    // days_from_civil (Howard Hinnant)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + hh * 3600 + mm * 60 + ss) as f64)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(dir) = args.first().map(std::path::PathBuf::from) else {
        return Err("usage: bench_split OUT_DIR [GATEWAY_JSONL] [TCTL_LOG]".into());
    };
    let results = read(&dir.join("results.json"))?;
    let requests = read(&dir.join("requests.json"))?;
    let requests = requests.as_array().ok_or("requests.json is not a list")?;
    let gateway: Vec<Value> = match args.get(1) {
        Some(p) => std::fs::read_to_string(p)?
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect(),
        None => Vec::new(),
    };
    let tctl: Vec<(f64, f64)> = match args.get(2) {
        Some(p) => std::fs::read_to_string(p)?
            .lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                let t = it.next()?.parse().ok()?;
                let c = it.next()?.trim_start_matches('+').trim_end_matches("°C").parse().ok()?;
                Some((t, c))
            })
            .collect(),
        None => Vec::new(),
    };

    let mut rows = Vec::new();
    for run in results["runs"].as_array().ok_or("results.json has no runs")? {
        let label = run["label"].as_str().unwrap_or_default();
        let mine: Vec<&Value> = requests
            .iter()
            .filter(|r| r["run_label"].as_str() == Some(label))
            .collect();
        let spans: Vec<(f64, f64)> = mine
            .iter()
            .map(|r| (num(r, "started"), num(r, "started") + num(r, "elapsed_seconds")))
            .collect();
        let (mut prompt, mut generation, mut waiting) = (0.0, 0.0, 0.0);
        let (mut generated, mut prompt_tokens, mut cached, mut missing_timings) = (0.0, 0.0, 0.0, 0);
        for r in &mine {
            let t = &r["provider_timings"];
            if t.is_null() {
                missing_timings += 1;
            }
            let p = num(t, "prompt_ms") / 1000.0;
            let g = num(t, "predicted_ms") / 1000.0;
            prompt += p;
            generation += g;
            waiting += (num(r, "elapsed_seconds") - p - g).max(0.0);
            generated += t
                .get("predicted_n")
                .and_then(Value::as_f64)
                .unwrap_or_else(|| num(&r["usage"], "completion_tokens"));
            prompt_tokens += num(t, "prompt_n");
            cached += num(t, "cache_n");
        }
        // Waiting while another request of this run was in flight is the run's own.
        let own_overlap = covered(&spans, 2);
        let foreign_wait = (waiting - own_overlap).max(0.0);
        let wall = num(run, "elapsed_seconds");
        let http = covered(&spans, 1);
        let (lo, hi) = spans
            .iter()
            .fold((f64::MAX, f64::MIN), |(a, b), &(s, e)| (a.min(s), b.max(e)));
        let in_window = |ts: &Value| {
            ts.as_str().and_then(unix).is_some_and(|t| t >= lo.floor() - 1.0 && t <= hi.ceil() + 1.0)
        };
        let holds = gateway
            .iter()
            .filter(|e| e["event"] == "human_hold" && e["peer_cmd"] == "python3" && in_window(&e["ts"]))
            .count();
        let admit_wait: f64 = gateway
            .iter()
            .filter(|e| e["event"] == "admitted" && in_window(&e["ts"]))
            .filter_map(|e| e["admit_s"].as_f64())
            .sum();
        let foreign_requests = gateway
            .iter()
            .filter(|e| e["event"] == "admit" && e["peer_cmd"] != "python3" && in_window(&e["ts"]))
            .count();
        let hottest = tctl
            .iter()
            .filter(|(t, _)| *t >= lo - 10.0 && *t <= hi + 10.0)
            .map(|(_, c)| *c)
            .fold(f64::NAN, f64::max);
        rows.push(json!({
            "label": label,
            "harness": run["harness"],
            "exit": run["exit"],
            "checks_passed": run["passed"],
            "checks": run["checks"],
            "candidate_tests_exit": run["tests_exit"],
            "requests": mine.len(),
            "requests_without_timings": missing_timings,
            "wall_seconds": wall,
            "queue_seconds": foreign_wait,
            "own_overlap_seconds": own_overlap,
            "prompt_seconds": prompt,
            "generation_seconds": generation,
            "outside_model_seconds": (wall - http).max(0.0),
            "wall_minus_queue_seconds": wall - foreign_wait,
            "generated_tokens": generated,
            "generation_tokens_per_second": if generation > 0.0 { generated / generation } else { 0.0 },
            "prompt_tokens_processed": prompt_tokens,
            "prompt_tokens_cached": cached,
            "gateway_admit_wait_seconds": admit_wait,
            "gateway_owner_holds": holds,
            "gateway_foreign_requests": foreign_requests,
            "max_tctl_c": if hottest.is_nan() { Value::Null } else { json!(hottest) },
        }));
    }
    std::fs::write(dir.join("split.json"), serde_json::to_string_pretty(&rows)? + "\n")?;
    println!("| Run | Checks | Wall | Queue | Prompt | Generation | Outside model | Wall − queue | Tokens out | tok/s | Owner holds | Max Tctl |");
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for r in &rows {
        println!(
            "| {} {} | {}/{} | {:.1} s | {:.1} s | {:.1} s | {:.1} s | {:.1} s | {:.1} s | {} | {:.1} | {} | {} |",
            r["label"].as_str().unwrap_or_default(),
            r["harness"].as_str().unwrap_or_default(),
            r["checks_passed"],
            r["checks"],
            num(r, "wall_seconds"),
            num(r, "queue_seconds"),
            num(r, "prompt_seconds"),
            num(r, "generation_seconds"),
            num(r, "outside_model_seconds"),
            num(r, "wall_minus_queue_seconds"),
            num(r, "generated_tokens"),
            num(r, "generation_tokens_per_second"),
            r["gateway_owner_holds"],
            r["max_tctl_c"],
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn coverage_and_overlap() {
        let spans = [(0.0, 10.0), (5.0, 12.0), (20.0, 21.0)];
        assert_eq!(super::covered(&spans, 1), 13.0);
        assert_eq!(super::covered(&spans, 2), 5.0);
    }

    #[test]
    fn rfc3339_utc() {
        assert_eq!(super::unix("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(super::unix("2026-11-04T14:09:23Z"), Some(1_793_801_363.0));
    }
}
