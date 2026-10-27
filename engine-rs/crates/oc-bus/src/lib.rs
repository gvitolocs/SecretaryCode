//! oc-bus: port of the publish/subscribe event bus from
//! `packages/core/src/bus.ts` (subset). Upstream fans out typed domain
//! events to in-process subscribers and the server's event feed; here the
//! envelope is the v2 wire shape `{"type": "<domain>.<verb>", "properties":
//! {...}}` delivered over a tokio broadcast channel so the SSE feed and any
//! in-process consumers share one stream.

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// Wire envelope for a published event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    #[serde(rename = "type")]
    pub kind: String,
    pub properties: serde_json::Value,
}

impl EventEnvelope {
    pub fn new(kind: impl Into<String>, properties: serde_json::Value) -> Self {
        Self { kind: kind.into(), properties }
    }
}

/// Broadcast bus. `subscribe` returns a receiver that sees every event
/// published from this point on (LagRecv on slow consumers, like SSE
/// backpressure upstream).
#[derive(Clone)]
pub struct Bus {
    tx: broadcast::Sender<EventEnvelope>,
}

#[derive(Debug, thiserror::Error)]
#[error("no active subscribers")]
pub struct NoSubscribers;

impl Default for Bus {
    fn default() -> Self {
        Self::new(1024)
    }
}

impl Bus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(1));
        Self { tx }
    }

    /// Publish to all subscribers. Returns an error when nobody is
    /// listening (mirrors upstream ignoring publishes without receivers;
    /// callers may discard it).
    pub fn publish(&self, event: EventEnvelope) -> Result<(), NoSubscribers> {
        self.tx.send(event).map(|_| ()).map_err(|_| NoSubscribers)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.tx.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fanout_to_all_subscribers() {
        let bus = Bus::new(8);
        let mut r1 = bus.subscribe();
        let mut r2 = bus.subscribe();
        let event = EventEnvelope::new(
            "session.updated",
            serde_json::json!({"info": {"id": "ses_x"}}),
        );
        bus.publish(event.clone()).unwrap();
        assert_eq!(r1.recv().await.unwrap(), event);
        assert_eq!(r2.recv().await.unwrap(), event);
    }

    #[tokio::test]
    async fn publish_without_subscribers_is_reported() {
        let bus = Bus::default();
        assert!(bus.publish(EventEnvelope::new("session.idle", serde_json::json!({}))).is_err());
    }

    #[tokio::test]
    async fn subscriber_added_after_publish_misses_old_events() {
        let bus = Bus::new(8);
        bus.publish(EventEnvelope::new("a.b", serde_json::json!(1))).ok();
        let mut late = bus.subscribe();
        bus.publish(EventEnvelope::new("a.b", serde_json::json!(2))).unwrap();
        assert_eq!(late.recv().await.unwrap().properties, serde_json::json!(2));
    }

    #[tokio::test]
    async fn lagged_receiver_reports_lag() {
        let bus = Bus::new(1);
        let mut r = bus.subscribe();
        for i in 0..4 {
            bus.publish(EventEnvelope::new("a.b", serde_json::json!(i))).unwrap();
        }
        // Ring capacity 1 holds the newest event; the other three are
        // reported as lag on the next recv.
        assert!(matches!(
            r.recv().await,
            Err(broadcast::error::RecvError::Lagged(3))
        ));
        // And the newest event still arrives after the lag notice.
        assert_eq!(r.recv().await.unwrap().properties, serde_json::json!(3));
    }
}
