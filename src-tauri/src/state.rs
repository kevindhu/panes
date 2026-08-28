use std::{collections::HashMap, sync::Arc};

use tokio::sync::{Mutex, OnceCell, RwLock};
use tokio_util::sync::CancellationToken;

use crate::{
    config::app_config::AppConfig, db::Database, engines::EngineManager, file_tree::FileTreeCache,
    models::ThreadDto, power::KeepAwakeManager,
};

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub config: Arc<AppConfig>,
    pub engines: Arc<EngineManager>,
    pub keep_awake: Arc<KeepAwakeManager>,
    pub turns: Arc<TurnManager>,
    pub file_tree_cache: Arc<FileTreeCache>,
    pub pending_forks: Arc<PendingForkManager>,
}

/// Coordinates the deferred engine-level fork of branched Codex threads.
///
/// A branch thread is created locally and returned to the UI immediately, while the
/// slow `thread/fork` call to the Codex app-server (which spins up a whole new session,
/// re-initializing MCP servers and auth) runs in the background. A best-effort prefetch
/// task and the first use of the branch (a send, rollback, or re-fork) may race to
/// materialize the engine thread; this manager guarantees the fork runs exactly once by
/// funneling every caller through a shared [`OnceCell`] keyed by the branch thread id.
///
/// The cell stores the fork result on success only (via `get_or_try_init`), so a failed
/// fork leaves the slot empty and the next caller retries.
#[derive(Default)]
pub struct PendingForkManager {
    cells: Mutex<HashMap<String, Arc<OnceCell<ThreadDto>>>>,
}

impl PendingForkManager {
    /// Returns the shared once-cell for `thread_id`, creating it on first request.
    pub async fn cell(&self, thread_id: &str) -> Arc<OnceCell<ThreadDto>> {
        let mut cells = self.cells.lock().await;
        cells
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(OnceCell::new()))
            .clone()
    }

    /// Drops any coordination slot for `thread_id`. Called once the fork has been
    /// durably persisted so the map does not grow without bound.
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
