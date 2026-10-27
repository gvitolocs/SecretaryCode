//! Port of `packages/schema/src/identifier.ts` — sortable 26-char IDs.
//!
//! Layout (identical to upstream): the first 12 chars are a hex encoding of
//! a 48-bit sort key — `timestamp_ms * 0x1000 + counter`, bitwise-inverted
//! when descending — and the remaining 14 chars are random over the same
//! 62-char alphabet. Lexicographic order of the first 12 chars therefore
//! matches creation order (ascending) or reverse-creation order
//! (descending, used for `ses_` IDs so newest sorts first).

const LENGTH: usize = 26;
const CHARS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

#[derive(Debug, thiserror::Error)]
#[error("invalid identifier: {0}")]
pub struct InvalidId(pub String);

/// Sortable creation-order suffix (used by `msg_` IDs).
pub fn ascending() -> String {
    create(false, now_ms())
}

/// Sortable reverse-creation-order suffix (used by `ses_` IDs).
pub fn descending() -> String {
    create(true, now_ms())
}

/// Exact port of upstream `create(descending, timestamp)`, with the
/// timestamp injectable so tests are deterministic. Not thread-safe across
/// counters, mirroring upstream's module-global counter.
pub fn create(descending: bool, timestamp_ms: u64) -> String {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<(u64, u32)> = const { Cell::new((0, 0)) };
    }
    let counter = STATE.with(|s| {
        let (last, mut counter) = s.get();
        if timestamp_ms != last {
            counter = 0;
        }
        counter += 1;
        s.set((timestamp_ms, counter));
        counter as u64
    });

    let current = timestamp_ms * 0x1000 + counter;
    let value = if descending { !current } else { current };
    let mut out = String::with_capacity(LENGTH);
    for i in 0..6 {
        let byte = (value >> (40 - 8 * i)) & 0xff;
        out.push_str(&format!("{byte:02x}"));
    }
    let mut seed = timestamp_ms ^ u64::from(counter).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for _ in 0..(LENGTH - 12) {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        out.push(CHARS[(seed % 62) as usize] as char);
    }
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Validate the shared 26-char shape.
pub fn validate(id: &str) -> Result<(), InvalidId> {
    if id.len() != LENGTH {
        return Err(InvalidId(id.to_string()));
    }
    if !id.chars().take(12).all(|c| c.is_ascii_hexdigit()) {
        return Err(InvalidId(id.to_string()));
    }
    if !id.chars().skip(12).all(|c| CHARS.contains(&(c as u8))) {
        return Err(InvalidId(id.to_string()));
    }
    Ok(())
}

/// Sort key bytes (the 12-char hex prefix interpreted per direction).
pub fn sort_prefix(id: &str) -> Result<u64, InvalidId> {
    validate(id)?;
    u64::from_str_radix(&id[..12], 16).map_err(|_| InvalidId(id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_matches_upstream() {
        let a = create(false, 1_000_000);
        let d = create(true, 1_000_000);
        assert_eq!(a.len(), 26);
        assert_eq!(d.len(), 26);
        assert!(a.chars().take(12).all(|c| c.is_ascii_hexdigit()));
        assert!(a.chars().skip(12).all(|c| CHARS.contains(&(c as u8))));
    }

    #[test]
    fn ascending_sorts_forward_within_same_timestamp() {
        let a = create(false, 5_000);
        let b = create(false, 5_000);
        assert!(a < b, "counter increments must sort forward: {a} vs {b}");
    }

    #[test]
    fn descending_sorts_backward() {
        let a = create(true, 5_000);
        let b = create(true, 6_000);
        assert!(a > b, "newer descending IDs must sort first: {a} vs {b}");
    }

    #[test]
    fn descending_band_sits_above_ascending() {
        // Upstream two's-complement encoding: descending keys (negated)
        // live in the 0xFF… band, ascending keys in the 0x00… band. The
        // newest-first property holds *within* the descending band (see
        // descending_sorts_backward); the bands themselves are disjoint.
        let d = create(true, 5_000);
        let a = create(false, 5_000);
        assert!(d > a);
    }

    #[test]
    fn timestamp_drives_prefix() {
        let early = sort_prefix(&create(false, 1_000)).unwrap();
        let late = sort_prefix(&create(false, 2_000)).unwrap();
        assert!(early < late);
    }

    #[test]
    fn validate_rejects_garbage() {
        assert!(validate("").is_err());
        assert!(validate("zzzz").is_err());
        assert!(validate(&"0".repeat(26)).is_ok());
    }
}
