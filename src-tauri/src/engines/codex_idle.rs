use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

// Codex 0.156 unloads an unsubscribed thread after roughly one minute. Keep a
// small working set subscribed ourselves so ordinary pauses retain its model
// connection, HTTP fallback decision, and MCP runtime.
const IDLE_RETENTION: Duration = Duration::from_secs(30 * 60);
const MAX_IDLE_SUBSCRIPTIONS: usize = 4;

#[derive(Default)]
pub(super) struct IdleSubscriptions {
    idle_since: HashMap<String, Instant>,
}

impl IdleSubscriptions {
    pub fn retain(&mut self, thread_id: &str, now: Instant) {
        self.idle_since.insert(thread_id.to_owned(), now);
    }

    pub fn remove(&mut self, thread_id: &str) {
        self.idle_since.remove(thread_id);
    }

    pub fn clear(&mut self) {
        self.idle_since.clear();
    }

    pub fn release_candidates(&self, now: Instant) -> Vec<String> {
        let mut idle: Vec<_> = self.idle_since.iter().collect();
        idle.sort_by(|(left_id, left_time), (right_id, right_time)| {
            left_time
                .cmp(right_time)
                .then_with(|| left_id.cmp(right_id))
        });
        let excess = idle.len().saturating_sub(MAX_IDLE_SUBSCRIPTIONS);
        idle.into_iter()
            .enumerate()
            .filter(|(index, (_, since))| {
                *index < excess || now.saturating_duration_since(**since) >= IDLE_RETENTION
            })
            .map(|(_, (id, _))| id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_pause_does_not_discard_codex_transport_state() {
        let now = Instant::now();
        let mut idle = IdleSubscriptions::default();
        idle.retain("thread", now);
        assert!(idle
            .release_candidates(now + Duration::from_secs(61))
            .is_empty());
        assert!(idle
            .release_candidates(now + IDLE_RETENTION - Duration::from_secs(1))
            .is_empty());
        assert_eq!(idle.release_candidates(now + IDLE_RETENTION), ["thread"]);
    }

    #[test]
    fn follow_up_cancels_old_cleanup_and_restarts_idle_deadline() {
        let now = Instant::now();
        let mut idle = IdleSubscriptions::default();
        idle.retain("thread", now);
        // A pending turn is protected even before Codex sends turn/started.
        idle.remove("thread");
        assert!(idle.release_candidates(now + IDLE_RETENTION).is_empty());
        idle.retain("thread", now + Duration::from_secs(20 * 60));
        assert!(idle.release_candidates(now + IDLE_RETENTION).is_empty());
        assert_eq!(
            idle.release_candidates(now + Duration::from_secs(50 * 60)),
            ["thread"]
        );
    }

    #[test]
    fn working_set_evicts_oldest_idle_threads_and_keeps_recent_ones() {
        let now = Instant::now();
        let mut idle = IdleSubscriptions::default();
        for index in 0..6 {
            idle.retain(&format!("thread-{index}"), now + Duration::from_secs(index));
        }
        assert_eq!(
            idle.release_candidates(now + Duration::from_secs(6)),
            ["thread-0", "thread-1"]
        );
        idle.remove("thread-0");
        // A candidate that becomes active while cleanup waits for its lock must
        // be rechecked, not unsubscribed using the old candidate list.
        idle.remove("thread-1");
        assert!(idle
            .release_candidates(now + Duration::from_secs(6))
            .is_empty());
        idle.clear();
        assert!(idle.release_candidates(now + IDLE_RETENTION).is_empty());
    }
}
