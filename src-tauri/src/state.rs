use std::{collections::HashMap, sync::Arc};

use tokio::sync::{Mutex, OnceCell, RwLock};
use tokio_util::sync::CancellationToken;

use crate::{
    config::app_config::AppConfig, db::Database, engines::EngineManager, models::ThreadDto,
    power::KeepAwakeManager,
};

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub config: Arc<AppConfig>,
    pub engines: Arc<EngineManager>,
    pub keep_awake: Arc<KeepAwakeManager>,
    pub turns: Arc<TurnManager>,
    pub pending_forks: Arc<PendingThreadMutationManager>,
    pub pending_rollbacks: Arc<PendingThreadMutationManager>,
}

/// Coordinates a deferred engine-level mutation for Codex threads.
///
/// Fork and rollback each own a manager instance. Their local projection is returned to
/// the UI immediately, while a prefetch task and first use may race to materialize the
/// native operation. The shared [`OnceCell`] guarantees one in-flight call per thread.
///
/// The cell stores successful results only, so a failed mutation remains retryable.
#[derive(Default)]
pub struct PendingThreadMutationManager {
    cells: Mutex<HashMap<String, Arc<OnceCell<ThreadDto>>>>,
    history_locks: Mutex<HashMap<String, std::sync::Weak<Mutex<()>>>>,
}

impl PendingThreadMutationManager {
    /// Serialize history preparation with send/fork/sync, before any caller reads
    /// thread metadata. Weak entries avoid retaining one mutex per historical thread.
    pub async fn lock_history(&self, thread_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.history_locks.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            let lock = locks
                .get(thread_id)
                .and_then(std::sync::Weak::upgrade)
                .unwrap_or_else(|| Arc::new(Mutex::new(())));
            locks.insert(thread_id.to_owned(), Arc::downgrade(&lock));
            lock
        };
        lock.lock_owned().await
    }

    /// Returns the shared once-cell for `thread_id`, creating it on first request.
    pub async fn cell(&self, thread_id: &str) -> Arc<OnceCell<ThreadDto>> {
        let mut cells = self.cells.lock().await;
        cells
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(OnceCell::new()))
            .clone()
    }

    /// Drops a coordination slot after the mutation has been durably persisted.
    pub async fn forget(&self, thread_id: &str) {
        self.cells.lock().await.remove(thread_id);
    }
}

#[derive(Default)]
pub struct TurnManager {
    active: RwLock<HashMap<String, CancellationToken>>,
}

impl TurnManager {
    pub async fn try_register(&self, thread_id: &str, token: CancellationToken) -> bool {
        let mut active = self.active.write().await;
        if active.contains_key(thread_id) {
            return false;
        }

        active.insert(thread_id.to_string(), token);
        true
    }

    pub async fn get(&self, thread_id: &str) -> Option<CancellationToken> {
        self.active.read().await.get(thread_id).cloned()
    }

    pub async fn cancel(&self, thread_id: &str) {
        if let Some(token) = self.active.read().await.get(thread_id).cloned() {
            token.cancel();
        }
    }

    pub async fn finish(&self, thread_id: &str) {
        self.active.write().await.remove(thread_id);
    }
}
