use std::time::Duration;

use anyhow::Context;
#[cfg(not(test))]
use serde::Serialize;
use tauri::AppHandle;
#[cfg(not(test))]
use tauri::Emitter;
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{sleep_until, Instant},
};

use crate::{
    db::{self, codex_transcript::CodexTurnSnapshot, Database},
    engines::CodexNativeEvent,
    state::AppState,
};

const RECORDER_QUEUE_CAPACITY: usize = 1024;
const RECORDER_BATCH_MAX_EVENTS: usize = 128;
const RECORDER_BATCH_MAX_BYTES: usize = 4 * 1024 * 1024;
const RECORDER_BATCH_MAX_LATENCY: Duration = Duration::from_millis(25);

#[cfg(not(test))]
type CodexTranscriptUpdateTarget = AppHandle;
#[cfg(test)]
type CodexTranscriptUpdateTarget = ();

/// Lossless, bounded turn recorder. Sending applies backpressure; finishing closes the queue,
/// commits the final batch, and joins the worker before the assistant turn is finalized.
pub(super) struct CodexTranscriptRecorder {
    sender: Option<mpsc::Sender<CodexNativeEvent>>,
    worker: JoinHandle<anyhow::Result<()>>,
}

#[cfg(not(test))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexTranscriptUpdatedEvent {
    assistant_message_id: String,
    last_source_sequence: u64,
}

#[cfg(not(test))]
fn emit_transcript_updated(
    app: Option<&CodexTranscriptUpdateTarget>,
    assistant_message_id: &str,
    last_source_sequence: u64,
) {
    let Some(app) = app else {
        return;
    };
    if let Err(error) = app.emit(
        "codex-transcript-updated",
        CodexTranscriptUpdatedEvent {
            assistant_message_id: assistant_message_id.to_owned(),
            last_source_sequence,
        },
    ) {
        log::warn!(
            "failed to emit Codex transcript update for {}: {error}",
            assistant_message_id
        );
    }
}

// Tauri embeds the Common Controls v6 manifest in the desktop binary, but Rust's unit-test
// harness does not. Keeping the desktop-only emit call out of unit-test linkage avoids loading
// the legacy comctl32 v5 entry points before the test harness can start.
#[cfg(test)]
fn emit_transcript_updated(
    _app: Option<&CodexTranscriptUpdateTarget>,
    _assistant_message_id: &str,
    _last_source_sequence: u64,
) {
}

impl CodexTranscriptRecorder {
    pub(super) fn start(
        db: Database,
        local_thread_id: String,
        assistant_message_id: String,
        app: &AppHandle,
    ) -> Self {
        #[cfg(not(test))]
        let update_target = Some(app.clone());
        #[cfg(test)]
        let update_target = {
            let _ = app;
            None
        };
        Self::start_with_target(db, local_thread_id, assistant_message_id, update_target)
    }

    fn start_with_target(
        db: Database,
        local_thread_id: String,
        assistant_message_id: String,
        update_target: Option<CodexTranscriptUpdateTarget>,
    ) -> Self {
        let (sender, receiver) = mpsc::channel(RECORDER_QUEUE_CAPACITY);
        let worker = tokio::spawn(run_recorder(
            db,
            local_thread_id,
            assistant_message_id,
            update_target,
            receiver,
        ));
        Self {
            sender: Some(sender),
            worker,
        }
    }

    #[cfg(test)]
    fn start_for_test(db: Database, local_thread_id: String, assistant_message_id: String) -> Self {
        Self::start_with_target(db, local_thread_id, assistant_message_id, None)
    }

    pub(super) async fn record(&self, event: CodexNativeEvent) -> anyhow::Result<()> {
        self.sender
            .as_ref()
            .context("Codex transcript recorder is already closed")?
            .send(event)
            .await
            .map_err(|_| anyhow::anyhow!("Codex transcript recorder worker stopped"))
    }

    pub(super) async fn finish(mut self) -> anyhow::Result<()> {
        self.sender.take();
        self.worker
            .await
            .context("Codex transcript recorder task failed to join")?
    }
}

async fn run_recorder(
    db: Database,
    local_thread_id: String,
    assistant_message_id: String,
    app: Option<CodexTranscriptUpdateTarget>,
    mut receiver: mpsc::Receiver<CodexNativeEvent>,
) -> anyhow::Result<()> {
    while let Some(first) = receiver.recv().await {
        let mut batch = vec![first];
        let mut batch_bytes = event_size(&batch[0]);
        let deadline = Instant::now() + RECORDER_BATCH_MAX_LATENCY;
        let mut channel_closed = false;

        loop {
            if batch.len() >= RECORDER_BATCH_MAX_EVENTS || batch_bytes >= RECORDER_BATCH_MAX_BYTES {
                break;
            }

            tokio::select! {
                _ = sleep_until(deadline) => break,
                next = receiver.recv() => {
                    match next {
                        Some(event) => {
                            batch_bytes = batch_bytes.saturating_add(event_size(&event));
                            batch.push(event);
                        }
                        None => {
                            channel_closed = true;
                            break;
                        }
                    }
                }
            }
        }

        let last_source_sequence = batch
            .iter()
            .map(|event| event.source_sequence)
            .max()
            .context("Codex transcript batch unexpectedly empty")?;
        let batch_db = db.clone();
        let batch_thread_id = local_thread_id.clone();
        let batch_message_id = assistant_message_id.clone();
        tokio::task::spawn_blocking(move || {
            db::codex_transcript::record_native_event_batch(
                &batch_db,
                &batch_thread_id,
                &batch_message_id,
                &batch,
            )
        })
        .await
        .context("Codex transcript database task failed to join")??;

        emit_transcript_updated(app.as_ref(), &assistant_message_id, last_source_sequence);

        if channel_closed {
            break;
        }
    }

    Ok(())
}

fn event_size(event: &CodexNativeEvent) -> usize {
    event
        .params_json
        .len()
        .saturating_add(event.method.len())
        .saturating_add(event.request_id.as_deref().map(str::len).unwrap_or(0))
        .saturating_add(event.native_thread_id.len())
        .saturating_add(event.native_turn_id.as_deref().map(str::len).unwrap_or(0))
}

#[tauri::command]
pub async fn get_codex_turn_snapshot(
    state: tauri::State<'_, AppState>,
    assistant_message_id: String,
    after_source_sequence: Option<u64>,
) -> Result<Option<CodexTurnSnapshot>, String> {
    let database = state.db.clone();
    tokio::task::spawn_blocking(move || match after_source_sequence {
        Some(cursor) => {
            db::codex_transcript::load_turn_snapshot_after(&database, &assistant_message_id, cursor)
        }
        None => db::codex_transcript::load_turn_snapshot(&database, &assistant_message_id),
    })
    .await
    .map_err(|error| format!("Codex snapshot task failed to join: {error}"))?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use rusqlite::params;
    use uuid::Uuid;

    use super::*;
    use crate::engines::CodexNativeEventKind;

    #[tokio::test]
    async fn finish_flushes_the_final_partial_batch() {
        let path =
            std::env::temp_dir().join(format!("panes-codex-recorder-{}.sqlite", Uuid::new_v4()));
        let database = Database::open(path.clone()).expect("test database");
        let connection = database.connect().expect("test connection");
        connection
            .execute(
                "INSERT INTO workspaces (id, name, root_path) VALUES ('workspace', 'Test', ?1)",
                params![format!("C:\\panes-recorder-tests\\{}", Uuid::new_v4())],
            )
            .expect("workspace fixture");
        connection
            .execute(
                "INSERT INTO threads (
                   id, workspace_id, engine_id, model_id, engine_thread_id
                 ) VALUES ('thread', 'workspace', 'codex', 'gpt-test', 'native-thread')",
                [],
            )
            .expect("thread fixture");
        connection
            .execute(
                "INSERT INTO messages (id, thread_id, role, blocks_json, status)
                 VALUES ('message', 'thread', 'assistant', '[]', 'streaming')",
                [],
            )
            .expect("message fixture");
        drop(connection);

        let recorder = CodexTranscriptRecorder::start_for_test(
            database.clone(),
            "thread".into(),
            "message".into(),
        );
        for source_sequence in 1..=3 {
            recorder
                .record(CodexNativeEvent {
                    source_sequence,
                    observed_at_ms: source_sequence as i64,
                    event_kind: CodexNativeEventKind::Notification,
                    method: "item/agentMessage/delta".into(),
                    request_id: None,
                    native_thread_id: "native-thread".into(),
                    native_turn_id: Some("native-turn".into()),
                    params_json: format!(
                        r#"{{"threadId":"native-thread","turnId":"native-turn","itemId":"agent","delta":"{source_sequence}"}}"#
                    ),
                })
                .await
                .expect("event should enter recorder");
        }
        recorder.finish().await.expect("final batch should flush");

        let snapshot = db::codex_transcript::load_turn_snapshot(&database, "message")
            .expect("snapshot query")
            .expect("snapshot exists");
        assert_eq!(snapshot.events.len(), 3);
        assert_eq!(
            snapshot
                .chunks
                .iter()
                .map(|chunk| chunk.content.as_str())
                .collect::<Vec<_>>(),
            vec!["1", "2", "3"]
        );

        drop(database);
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(PathBuf::from(format!("{}{suffix}", path.display())));
        }
    }
}
