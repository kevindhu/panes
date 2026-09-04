use anyhow::Context;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::models::{ThreadDto, ThreadStatusDto};

use super::Database;

#[derive(Debug, Default, Clone, Copy)]
pub struct RuntimeRecoveryReport {
    pub messages_marked_interrupted: usize,
    pub thread_status_updates: usize,
}

pub fn create_thread(
    db: &Database,
    workspace_id: &str,
    repo_id: Option<&str>,
    engine_id: &str,
    model_id: &str,
    title: &str,
) -> anyhow::Result<ThreadDto> {
    let id = Uuid::new_v4().to_string();
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO threads (id, workspace_id, repo_id, engine_id, model_id, title, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'idle')",
        params![id, workspace_id, repo_id, engine_id, model_id, title],
    )
    .context("failed to create thread")?;

    get_thread(db, &id)?.context("thread not found after insert")
}

pub fn get_thread(db: &Database, thread_id: &str) -> anyhow::Result<Option<ThreadDto>> {
    let conn = db.connect()?;
    get_thread_with_connection(&conn, thread_id)
}

fn get_thread_with_connection(
    conn: &Connection,
    thread_id: &str,
) -> anyhow::Result<Option<ThreadDto>> {
    conn.query_row(
    "SELECT id, workspace_id, repo_id, engine_id, model_id, engine_thread_id, engine_metadata_json,
            COALESCE(title, ''), status, message_count, total_tokens, created_at, last_activity_at
     FROM threads WHERE id = ?1",
    params![thread_id],
    map_thread_row,
  )
  .optional()
  .context("failed to query thread")
}

pub fn find_thread_by_engine_thread_id(
    db: &Database,
    engine_id: &str,
    engine_thread_id: &str,
) -> anyhow::Result<Option<ThreadDto>> {
    let conn = db.connect()?;
    conn.query_row(
        "SELECT id, workspace_id, repo_id, engine_id, model_id, engine_thread_id, engine_metadata_json,
                COALESCE(title, ''), status, message_count, total_tokens, created_at, last_activity_at
         FROM threads
         WHERE engine_id = ?1
           AND engine_thread_id = ?2
         LIMIT 1",
        params![engine_id, engine_thread_id],
        map_thread_row,
    )
    .optional()
    .context("failed to query thread by engine thread id")
}

pub fn list_threads_for_workspace(
    db: &Database,
    workspace_id: &str,
) -> anyhow::Result<Vec<ThreadDto>> {
    reconcile_stale_running_thread_statuses(db, None, Some(workspace_id))?;
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
    "SELECT id, workspace_id, repo_id, engine_id, model_id, engine_thread_id, engine_metadata_json,
            COALESCE(title, ''), status, message_count, total_tokens, created_at, last_activity_at
     FROM threads
     WHERE workspace_id = ?1
       AND engine_id = 'codex'
       AND archived_at IS NULL
       AND (
         engine_thread_id IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM messages
           WHERE messages.thread_id = threads.id
         )
       )
     ORDER BY last_activity_at DESC",
  )?;

    let rows = stmt.query_map(params![workspace_id], map_thread_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_archived_threads_for_workspace(
    db: &Database,
    workspace_id: &str,
) -> anyhow::Result<Vec<ThreadDto>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
    "SELECT id, workspace_id, repo_id, engine_id, model_id, engine_thread_id, engine_metadata_json,
            COALESCE(title, ''), status, message_count, total_tokens, created_at, last_activity_at
     FROM threads
     WHERE workspace_id = ?1
       AND engine_id = 'codex'
       AND archived_at IS NOT NULL
       AND (
         engine_thread_id IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM messages
           WHERE messages.thread_id = threads.id
         )
       )
     ORDER BY archived_at DESC",
  )?;

    let rows = stmt.query_map(params![workspace_id], map_thread_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn update_thread_status(
    db: &Database,
    thread_id: &str,
    status: ThreadStatusDto,
) -> anyhow::Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE threads
     SET status = ?1, last_activity_at = datetime('now')
     WHERE id = ?2
       AND status != ?1",
        params![status.as_str(), thread_id],
    )
    .context("failed to update thread status")?;
    Ok(())
}

pub fn set_engine_thread_id(
    db: &Database,
    thread_id: &str,
    engine_thread_id: &str,
) -> anyhow::Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE threads SET engine_thread_id = ?1 WHERE id = ?2",
        params![engine_thread_id, thread_id],
    )
    .context("failed to set engine thread id")?;
    Ok(())
}

pub fn delete_thread(db: &Database, thread_id: &str) -> anyhow::Result<()> {
    let conn = db.connect()?;
    let affected = conn
        .execute("DELETE FROM threads WHERE id = ?1", params![thread_id])
        .context("failed to delete thread")?;

    if affected == 0 {
        anyhow::bail!("thread not found: {thread_id}");
    }

    Ok(())
}

pub fn archive_thread(db: &Database, thread_id: &str) -> anyhow::Result<()> {
    let conn = db.connect()?;
    let affected = conn
        .execute(
            "UPDATE threads
       SET archived_at = datetime('now')
       WHERE id = ?1
         AND archived_at IS NULL",
            params![thread_id],
        )
        .context("failed to archive thread")?;
    drop(conn);

    if affected == 0 && get_thread(db, thread_id)?.is_none() {
        anyhow::bail!("thread not found after archive: {thread_id}");
    }

    Ok(())
}

pub fn restore_thread(db: &Database, thread_id: &str) -> anyhow::Result<ThreadDto> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE threads
       SET archived_at = NULL
       WHERE id = ?1
         AND archived_at IS NOT NULL",
        params![thread_id],
    )
    .context("failed to restore thread")?;
    drop(conn);

    get_thread(db, thread_id)?
        .ok_or_else(|| anyhow::anyhow!("thread not found after restore: {thread_id}"))
}

pub fn update_engine_metadata(
    db: &Database,
    thread_id: &str,
    metadata: &serde_json::Value,
) -> anyhow::Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE threads SET engine_metadata_json = ?1 WHERE id = ?2",
        params![metadata.to_string(), thread_id],
    )
    .context("failed to update engine metadata")?;
    Ok(())
}

pub fn backfill_codex_history_mode(
    db: &Database,
    thread_id: &str,
    engine_thread_id: &str,
    mode: &str,
) -> anyhow::Result<Option<ThreadDto>> {
    if !matches!(mode, "legacy" | "paginated") {
        return Ok(None);
    }
    let changed = db.connect()?.execute(
        "UPDATE threads SET engine_metadata_json = json_set(COALESCE(engine_metadata_json, '{}'), '$.codexHistoryMode', ?1)
         WHERE id = ?2 AND engine_id = 'codex' AND engine_thread_id = ?3
           AND COALESCE(json_extract(engine_metadata_json, '$.codexHistoryMode'), '') NOT IN ('legacy', 'paginated')",
        params![mode, thread_id, engine_thread_id],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    get_thread(db, thread_id)
}

pub fn mark_pending_rollback_started(db: &Database, thread_id: &str) -> anyhow::Result<ThreadDto> {
    let conn = db.connect()?;
    let affected = conn
        .execute(
            "UPDATE threads
             SET engine_metadata_json = json_set(
                   COALESCE(engine_metadata_json, '{}'),
                   '$.engineRollbackPhase',
                   'started'
                 )
             WHERE id = ?1
               AND json_extract(engine_metadata_json, '$.engineRollbackPending') = 1
               AND json_extract(engine_metadata_json, '$.engineRollbackPhase') = 'prepared'",
            params![thread_id],
        )
        .context("failed to mark pending rollback as started")?;
    if affected == 0 {
        anyhow::bail!("pending rollback is no longer prepared: {thread_id}");
    }

    get_thread_with_connection(&conn, thread_id)?
        .ok_or_else(|| anyhow::anyhow!("thread not found after starting rollback: {thread_id}"))
}

pub fn bump_message_counters(
    db: &Database,
    thread_id: &str,
    tokens: Option<(u64, u64)>,
) -> anyhow::Result<()> {
    let (input, output) = tokens.unwrap_or((0, 0));
    let conn = db.connect()?;
    conn.execute(
        "UPDATE threads
     SET message_count = message_count + 1,
         total_tokens = total_tokens + ?1 + ?2,
         last_activity_at = datetime('now')
     WHERE id = ?3",
        params![input as i64, output as i64, thread_id],
    )
    .context("failed to bump thread counters")?;
    Ok(())
}

pub fn update_thread_title(db: &Database, thread_id: &str, title: &str) -> anyhow::Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE threads SET title = ?1 WHERE id = ?2",
        params![title, thread_id],
    )
    .context("failed to update thread title")?;
    Ok(())
}

pub fn refresh_thread_message_stats(db: &Database, thread_id: &str) -> anyhow::Result<()> {
    let conn = db.connect()?;
    let (message_count, total_tokens, latest_message_at): (i64, i64, Option<String>) = conn
        .query_row(
            "SELECT
                COUNT(*),
                COALESCE(SUM(COALESCE(token_input, 0) + COALESCE(token_output, 0)), 0),
                MAX(created_at)
             FROM messages
             WHERE thread_id = ?1",
            params![thread_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .context("failed to recalculate thread message stats")?;

    conn.execute(
        "UPDATE threads
         SET message_count = ?1,
             total_tokens = ?2,
             last_activity_at = COALESCE(?3, datetime('now'))
         WHERE id = ?4",
        params![message_count, total_tokens, latest_message_at, thread_id],
    )
    .context("failed to persist recalculated thread message stats")?;

    Ok(())
}

pub fn touch_thread_activity(db: &Database, thread_id: &str) -> anyhow::Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE threads SET last_activity_at = datetime('now') WHERE id = ?1",
        params![thread_id],
    )
    .context("failed to update thread activity")?;
    Ok(())
}

pub fn update_thread_runtime_snapshot(
    db: &Database,
    thread_id: &str,
    title: Option<&str>,
    status: Option<ThreadStatusDto>,
    metadata: Option<&serde_json::Value>,
) -> anyhow::Result<ThreadDto> {
    let conn = db.connect()?;
    let existing = get_thread_with_connection(&conn, thread_id)?
        .ok_or_else(|| anyhow::anyhow!("thread not found: {thread_id}"))?;

    let next_title =
        title.filter(|_| !thread_manual_title_locked(existing.engine_metadata.as_ref()));
    let next_status = status.as_ref().map(ThreadStatusDto::as_str);
    let next_metadata = metadata.map(serde_json::Value::to_string);
    let updated = conn
        .execute(
            "UPDATE threads
             SET title = COALESCE(?1, title),
                 last_activity_at = CASE
                   WHEN ?2 IS NOT NULL AND status != ?2 THEN datetime('now')
                   ELSE last_activity_at
                 END,
                 status = COALESCE(?2, status),
                 engine_metadata_json = COALESCE(?3, engine_metadata_json)
             WHERE id = ?4",
            params![next_title, next_status, next_metadata, thread_id],
        )
        .context("failed to update thread runtime snapshot")?;
    if updated == 0 {
        anyhow::bail!("thread not found while updating runtime snapshot: {thread_id}");
    }

    get_thread_with_connection(&conn, thread_id)?.ok_or_else(|| {
        anyhow::anyhow!("thread not found after runtime snapshot update: {thread_id}")
    })
}

fn thread_manual_title_locked(metadata: Option<&serde_json::Value>) -> bool {
    metadata
        .and_then(serde_json::Value::as_object)
        .and_then(|object| object.get("manualTitle"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// Repairs a running thread row when its persisted transcript already has a
/// terminal assistant message. The decision and update share one SQLite
/// statement, so a newer streaming placeholder that is already committed
/// cannot slip between a separate read and write.
///
/// A pending Codex sync is kept in metadata, but it does not make an
/// unverified running status authoritative. The one exception is the typed
/// flag written after a full engine snapshot confirms an active remote turn;
/// that status remains running until the engine reports it finished.
pub fn reconcile_stale_running_thread_status_from_transcript(
    db: &Database,
    thread_id: &str,
) -> anyhow::Result<bool> {
    Ok(reconcile_stale_running_thread_statuses(db, Some(thread_id), None)? > 0)
}

fn reconcile_stale_running_thread_statuses(
    db: &Database,
    thread_id: Option<&str>,
    workspace_id: Option<&str>,
) -> anyhow::Result<usize> {
    let conn = db.connect()?;
    let changed = conn
        .execute(
            "UPDATE threads
             SET status = (
               SELECT CASE m.status
                 WHEN 'completed' THEN 'completed'
                 WHEN 'error' THEN 'error'
                 WHEN 'interrupted' THEN 'idle'
               END
               FROM messages m
               WHERE m.thread_id = threads.id
                 AND m.role = 'assistant'
               ORDER BY m.created_at DESC, m.rowid DESC
               LIMIT 1
             )
             WHERE (?1 IS NULL OR id = ?1)
               AND (?2 IS NULL OR workspace_id = ?2)
               AND status IN ('streaming', 'awaiting_approval')
               AND NOT (
                 engine_id = 'codex'
                 AND COALESCE(
                   json_extract(
                     CASE
                       WHEN json_valid(engine_metadata_json) THEN engine_metadata_json
                       ELSE '{}'
                     END,
                     ?3
                   ),
                   0
                 ) = 1
               )
               AND (
                 SELECT m.status
                 FROM messages m
                 WHERE m.thread_id = threads.id
                   AND m.role = 'assistant'
                 ORDER BY m.created_at DESC, m.rowid DESC
                 LIMIT 1
               ) IN ('completed', 'error', 'interrupted')",
            params![
                thread_id,
                workspace_id,
                format!("$.{}", crate::codex_thread_metadata::REMOTE_TURN_ACTIVE_KEY),
            ],
        )
        .context("failed to reconcile stale running thread status from transcript")?;

    Ok(changed)
}

pub fn reconcile_runtime_state(db: &Database) -> anyhow::Result<RuntimeRecoveryReport> {
    let mut conn = db.connect()?;
    let tx = conn
        .transaction()
        .context("failed to start runtime recovery transaction")?;

    // Live approval request IDs belong to the engine process that issued them.
    // Once that runtime is gone, a pending request on a terminalized
    // assistant message cannot be answered and must be recorded as canceled.
    tx.execute(
        "UPDATE approvals
         SET status = 'answered',
             decision = COALESCE(decision, 'cancel'),
             answered_at = COALESCE(answered_at, datetime('now'))
         WHERE status = 'pending'
           AND EXISTS (
             SELECT 1
             FROM messages m
             WHERE m.id = approvals.message_id
               AND m.role = 'assistant'
               AND m.status IN ('streaming', 'completed', 'error', 'interrupted')
           )",
        [],
    )
    .context("failed to cancel stale approvals during runtime recovery")?;

    let messages_marked_interrupted = tx
        .execute(
            "UPDATE messages
       SET status = 'interrupted'
       WHERE role = 'assistant'
         AND status = 'streaming'",
            [],
        )
        .context("failed to normalize stale streaming assistant messages")?;

    let thread_ids = {
        let mut stmt = tx
            .prepare("SELECT id FROM threads")
            .context("failed to load threads for runtime recovery")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .context("failed to iterate threads for runtime recovery")?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.context("failed to decode thread id during runtime recovery")?);
        }
        out
    };

    let mut thread_status_updates = 0usize;
    for thread_id in thread_ids {
        let next_status = derive_thread_status_for_recovery(&tx, &thread_id)?;
        let changed = tx
            .execute(
                "UPDATE threads
           SET status = ?1
           WHERE id = ?2
             AND status != ?1",
                params![next_status.as_str(), thread_id],
            )
            .context("failed to apply runtime recovery thread status")?;
        thread_status_updates += changed;
    }

    tx.commit()
        .context("failed to commit runtime recovery transaction")?;

    Ok(RuntimeRecoveryReport {
        messages_marked_interrupted,
        thread_status_updates,
    })
}

pub(crate) fn derive_thread_status_for_recovery(
    conn: &rusqlite::Connection,
    thread_id: &str,
) -> anyhow::Result<ThreadStatusDto> {
    let has_pending_approval = conn
        .query_row(
            "SELECT 1
       FROM approvals a
       JOIN messages m ON m.id = a.message_id
       WHERE a.thread_id = ?1
         AND a.status = 'pending'
         AND m.status = 'streaming'
       LIMIT 1",
            params![thread_id],
            |_| Ok(()),
        )
        .optional()
        .context("failed to inspect pending approvals during runtime recovery")?
        .is_some();

    if has_pending_approval {
        return Ok(ThreadStatusDto::AwaitingApproval);
    }

    let last_assistant_status = conn
        .query_row(
            "SELECT status
       FROM messages
       WHERE thread_id = ?1
         AND role = 'assistant'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1",
            params![thread_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("failed to inspect latest assistant message during runtime recovery")?;

    let status = match last_assistant_status.as_deref() {
        Some("error") => ThreadStatusDto::Error,
        Some("completed") => ThreadStatusDto::Completed,
        Some("streaming") | Some("interrupted") => ThreadStatusDto::Idle,
        _ => ThreadStatusDto::Idle,
    };

    Ok(status)
}

fn map_thread_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadDto> {
    let metadata_raw: Option<String> = row.get(6)?;
    let metadata = metadata_raw.and_then(|raw| serde_json::from_str(&raw).ok());

    Ok(ThreadDto {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        repo_id: row.get(2)?,
        engine_id: row.get(3)?,
        model_id: row.get(4)?,
        engine_thread_id: row.get(5)?,
        engine_metadata: metadata,
        title: row.get(7)?,
        status: ThreadStatusDto::from_str(&row.get::<_, String>(8)?),
        message_count: row.get(9)?,
        total_tokens: row.get(10)?,
        created_at: row.get(11)?,
        last_activity_at: row.get(12)?,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{Arc, Mutex},
    };

    use serde_json::json;
    use uuid::Uuid;

    use crate::{
        db::{actions, messages, workspaces, ConnectionPool, SQLITE_POOL_MAX_IDLE},
        engines::events::ActionType,
    };

    use super::*;

    fn test_db() -> Database {
        let path = std::env::temp_dir().join(format!("panes-threads-{}.db", Uuid::new_v4()));
        let db = Database {
            path,
            pool: Arc::new(ConnectionPool {
                idle: Mutex::new(Vec::new()),
                max_idle: SQLITE_POOL_MAX_IDLE,
            }),
        };
        db.run_migrations().expect("failed to run test migrations");
        db
    }

    fn test_thread(db: &Database, title: &str) -> ThreadDto {
        let root = std::env::temp_dir().join(format!("panes-workspace-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("failed to create temp workspace root");
        let workspace =
            workspaces::upsert_workspace(db, root.to_string_lossy().as_ref(), Some(1)).unwrap();
        create_thread(db, &workspace.id, None, "codex", "gpt-5.3-codex", title).unwrap()
    }

    #[test]
    fn history_mode_backfill_changes_only_missing_metadata_and_rejects_stale_results() {
        let db = test_db();
        let thread = test_thread(&db, "Old thread");
        set_engine_thread_id(&db, &thread.id, "native-thread").unwrap();
        let message =
            messages::insert_assistant_placeholder(&db, &thread.id, Some("codex"), None, None)
                .unwrap();
        for mode in ["legacy", "paginated"] {
            update_engine_metadata(
                &db,
                &thread.id,
                &json!({"manualTitle": true, "codexSyncRequired": false}),
            )
            .unwrap();
            let before = get_thread(&db, &thread.id).unwrap().unwrap();
            let updated = backfill_codex_history_mode(&db, &thread.id, "native-thread", mode)
                .unwrap()
                .unwrap();
            assert_eq!(
                updated.engine_metadata,
                Some(
                    json!({"manualTitle": true, "codexSyncRequired": false, "codexHistoryMode": mode})
                )
            );
            assert_eq!(updated.title, before.title);
            assert_eq!(updated.status, before.status);
            assert_eq!(updated.message_count, before.message_count);
            assert_eq!(updated.last_activity_at, before.last_activity_at);
            assert_eq!(
                messages::get_thread_messages(&db, &thread.id).unwrap()[0].id,
                message.id
            );
            assert!(backfill_codex_history_mode(
                &db,
                &thread.id,
                "native-thread",
                if mode == "legacy" {
                    "paginated"
                } else {
                    "legacy"
                }
            )
            .unwrap()
            .is_none());
        }
        update_engine_metadata(&db, &thread.id, &json!({"codexHistoryMode": null})).unwrap();
        assert!(
            backfill_codex_history_mode(&db, &thread.id, "old-native-id", "legacy")
                .unwrap()
                .is_none()
        );
        assert!(
            backfill_codex_history_mode(&db, &thread.id, "native-thread", "unknown")
                .unwrap()
                .is_none()
        );
        assert!(
            backfill_codex_history_mode(&db, &thread.id, "native-thread", "legacy")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn update_thread_runtime_snapshot_preserves_manual_title() {
        let db = test_db();
        let thread = test_thread(&db, "Manual title");
        let manual_metadata = json!({
            "manualTitle": true,
            "manualTitleUpdatedAt": "2026-03-06T12:00:00Z",
        });
        update_engine_metadata(&db, &thread.id, &manual_metadata).unwrap();

        let updated = update_thread_runtime_snapshot(
            &db,
            &thread.id,
            Some("Engine renamed title"),
            Some(ThreadStatusDto::Idle),
            Some(&json!({
                "manualTitle": true,
                "codexThreadStatus": "idle",
                "codexSyncRequired": false,
            })),
        )
        .unwrap();

        assert_eq!(updated.title, "Manual title");
        assert_eq!(updated.status, ThreadStatusDto::Idle);
        assert_eq!(
            updated
                .engine_metadata
                .as_ref()
                .and_then(|value| value.get("codexThreadStatus"))
                .and_then(serde_json::Value::as_str),
            Some("idle")
        );
        assert_eq!(
            updated
                .engine_metadata
                .as_ref()
                .and_then(|value| value.get("manualTitle"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn refresh_thread_message_stats_recomputes_counters_from_messages() {
        let db = test_db();
        let thread = test_thread(&db, "Stats");
        messages::insert_user_message(
            &db,
            &thread.id,
            "Count this turn",
            None,
            Some("codex"),
            Some("gpt-5.3-codex"),
            Some("low"),
        )
        .unwrap();
        let assistant = messages::insert_assistant_placeholder(
            &db,
            &thread.id,
            Some("codex"),
            Some("gpt-5.3-codex"),
            Some("low"),
        )
        .unwrap();
        messages::complete_assistant_message(
            &db,
            &assistant.id,
            crate::models::MessageStatusDto::Completed,
            Some((13, 21)),
            Some("gpt-5.3-codex"),
        )
        .unwrap();

        refresh_thread_message_stats(&db, &thread.id).unwrap();

        let refreshed = get_thread(&db, &thread.id).unwrap().unwrap();
        assert_eq!(refreshed.message_count, 2);
        assert_eq!(refreshed.total_tokens, 34);
        assert!(!refreshed.last_activity_at.is_empty());
    }

    #[test]
    fn recovery_ignores_pending_approvals_on_terminal_assistant_messages() {
        let db = test_db();
        let thread = test_thread(&db, "Approval recovery");
        let assistant = messages::insert_assistant_placeholder(
            &db,
            &thread.id,
            Some("codex"),
            Some("gpt-5.3-codex"),
            Some("low"),
        )
        .unwrap();
        actions::insert_approval(
            &db,
            "approval-terminal",
            &thread.id,
            &assistant.id,
            &ActionType::Command,
            "Run command",
            &json!({}),
        )
        .unwrap();

        let conn = db.connect().unwrap();
        assert_eq!(
            derive_thread_status_for_recovery(&conn, &thread.id).unwrap(),
            ThreadStatusDto::AwaitingApproval
        );
        drop(conn);

        messages::complete_assistant_message(
            &db,
            &assistant.id,
            crate::models::MessageStatusDto::Completed,
            None,
            Some("gpt-5.3-codex"),
        )
        .unwrap();

        let conn = db.connect().unwrap();
        assert_eq!(
            derive_thread_status_for_recovery(&conn, &thread.id).unwrap(),
            ThreadStatusDto::Completed
        );
    }

    #[test]
    fn runtime_recovery_cancels_approval_before_interrupting_its_message() {
        let db = test_db();
        let thread = test_thread(&db, "Questionnaire recovery");
        let assistant = messages::insert_assistant_placeholder(
            &db,
            &thread.id,
            Some("codex"),
            Some("gpt-5.3-codex"),
            Some("low"),
        )
        .unwrap();
        let approval_id = "questionnaire-pending-at-restart";
        let details = json!({
            "_serverMethod": "item/tool/requestUserInput",
            "questions": [{ "id": "scope", "question": "Which scope?" }],
        });
        let blocks = json!([{
            "type": "approval",
            "approvalId": approval_id,
            "actionType": "other",
            "summary": "Codex requested input",
            "details": details,
            "status": "pending",
        }]);
        messages::update_assistant_blocks_json(
            &db,
            &assistant.id,
            &blocks.to_string(),
            crate::models::MessageStatusDto::Streaming,
            None,
        )
        .unwrap();
        actions::insert_approval(
            &db,
            approval_id,
            &thread.id,
            &assistant.id,
            &ActionType::Other,
            "Codex requested input",
            &details,
        )
        .unwrap();
        update_thread_status(&db, &thread.id, ThreadStatusDto::AwaitingApproval).unwrap();

        let report = reconcile_runtime_state(&db).unwrap();

        assert_eq!(report.messages_marked_interrupted, 1);
        let conn = db.connect().unwrap();
        let approval: (String, Option<String>) = conn
            .query_row(
                "SELECT status, decision FROM approvals WHERE id = ?1",
                params![approval_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            approval,
            ("answered".to_string(), Some("cancel".to_string()))
        );
        drop(conn);

        let recovered = messages::get_thread_messages(&db, &thread.id).unwrap();
        assert_eq!(
            recovered[0].status,
            crate::models::MessageStatusDto::Interrupted
        );
        let approval_block = recovered[0]
            .blocks
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .unwrap();
        assert_eq!(approval_block.get("status"), Some(&json!("answered")));
        assert_eq!(approval_block.get("decision"), Some(&json!("cancel")));
        assert_eq!(
            get_thread(&db, &thread.id).unwrap().unwrap().status,
            ThreadStatusDto::Idle
        );
    }

    #[test]
    fn transcript_reconciliation_durably_repairs_stale_running_rows() {
        let cases = [
            (
                crate::models::MessageStatusDto::Completed,
                ThreadStatusDto::Completed,
            ),
            (
                crate::models::MessageStatusDto::Interrupted,
                ThreadStatusDto::Idle,
            ),
            (
                crate::models::MessageStatusDto::Error,
                ThreadStatusDto::Error,
            ),
        ];

        for (message_status, expected_thread_status) in cases {
            let db = test_db();
            let thread = test_thread(&db, "Stale running status");
            let assistant = messages::insert_assistant_placeholder(
                &db,
                &thread.id,
                Some("codex"),
                Some("gpt-5.3-codex"),
                Some("low"),
            )
            .unwrap();
            messages::complete_assistant_message(
                &db,
                &assistant.id,
                message_status,
                None,
                Some("gpt-5.3-codex"),
            )
            .unwrap();
            update_thread_status(&db, &thread.id, ThreadStatusDto::Streaming).unwrap();

            assert!(
                reconcile_stale_running_thread_status_from_transcript(&db, &thread.id).unwrap()
            );
            assert_eq!(
                get_thread(&db, &thread.id).unwrap().unwrap().status,
                expected_thread_status
            );
            assert!(
                !reconcile_stale_running_thread_status_from_transcript(&db, &thread.id).unwrap()
            );
        }
    }

    #[test]
    fn transcript_reconciliation_preserves_open_and_engine_confirmed_remote_turns() {
        let db = test_db();
        let open_thread = test_thread(&db, "Open turn");
        messages::insert_assistant_placeholder(
            &db,
            &open_thread.id,
            Some("codex"),
            Some("gpt-5.3-codex"),
            Some("low"),
        )
        .unwrap();
        update_thread_status(&db, &open_thread.id, ThreadStatusDto::Streaming).unwrap();

        assert!(
            !reconcile_stale_running_thread_status_from_transcript(&db, &open_thread.id).unwrap()
        );
        assert_eq!(
            get_thread(&db, &open_thread.id).unwrap().unwrap().status,
            ThreadStatusDto::Streaming
        );

        let remote_thread = test_thread(&db, "Remote active turn");
        let assistant = messages::insert_assistant_placeholder(
            &db,
            &remote_thread.id,
            Some("codex"),
            Some("gpt-5.3-codex"),
            Some("low"),
        )
        .unwrap();
        messages::complete_assistant_message(
            &db,
            &assistant.id,
            crate::models::MessageStatusDto::Completed,
            None,
            Some("gpt-5.3-codex"),
        )
        .unwrap();
        update_engine_metadata(
            &db,
            &remote_thread.id,
            &json!({ "codexSyncRequired": true }),
        )
        .unwrap();
        update_thread_status(&db, &remote_thread.id, ThreadStatusDto::Streaming).unwrap();

        assert!(
            reconcile_stale_running_thread_status_from_transcript(&db, &remote_thread.id).unwrap()
        );
        let reconciled = get_thread(&db, &remote_thread.id).unwrap().unwrap();
        assert_eq!(reconciled.status, ThreadStatusDto::Completed);
        assert_eq!(
            reconciled
                .engine_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("codexSyncRequired"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );

        let confirmed_remote_thread = test_thread(&db, "Confirmed remote active turn");
        let confirmed_assistant = messages::insert_assistant_placeholder(
            &db,
            &confirmed_remote_thread.id,
            Some("codex"),
            Some("gpt-5.3-codex"),
            Some("low"),
        )
        .unwrap();
        messages::complete_assistant_message(
            &db,
            &confirmed_assistant.id,
            crate::models::MessageStatusDto::Completed,
            None,
            Some("gpt-5.3-codex"),
        )
        .unwrap();
        update_engine_metadata(
            &db,
            &confirmed_remote_thread.id,
            &json!({
                "codexRemoteTurnActive": true,
            }),
        )
        .unwrap();
        update_thread_status(&db, &confirmed_remote_thread.id, ThreadStatusDto::Streaming).unwrap();

        assert!(!reconcile_stale_running_thread_status_from_transcript(
            &db,
            &confirmed_remote_thread.id,
        )
        .unwrap());
        assert_eq!(
            get_thread(&db, &confirmed_remote_thread.id)
                .unwrap()
                .unwrap()
                .status,
            ThreadStatusDto::Streaming
        );
    }

    #[test]
    fn list_threads_for_workspace_includes_engine_backed_threads_without_messages() {
        let db = test_db();
        let visible = test_thread(&db, "Remote");
        let hidden = test_thread(&db, "Hidden");
        set_engine_thread_id(&db, &visible.id, "codex-thread-123").unwrap();
        let assistant = messages::insert_assistant_placeholder(
            &db,
            &visible.id,
            Some("codex"),
            Some("gpt-5.3-codex"),
            Some("low"),
        )
        .unwrap();
        messages::complete_assistant_message(
            &db,
            &assistant.id,
            crate::models::MessageStatusDto::Completed,
            None,
            Some("gpt-5.3-codex"),
        )
        .unwrap();
        update_thread_status(&db, &visible.id, ThreadStatusDto::Streaming).unwrap();

        let listed = list_threads_for_workspace(&db, &visible.workspace_id).unwrap();
        assert_eq!(
            listed
                .iter()
                .find(|thread| thread.id == visible.id)
                .map(|thread| &thread.status),
            Some(&ThreadStatusDto::Completed)
        );
        assert!(!listed.iter().any(|thread| thread.id == hidden.id));
    }

    #[test]
    fn list_archived_threads_for_workspace_includes_engine_backed_threads_without_messages() {
        let db = test_db();
        let visible = test_thread(&db, "Archived remote");
        let hidden = test_thread(&db, "Archived hidden");
        set_engine_thread_id(&db, &visible.id, "codex-thread-archived").unwrap();
        archive_thread(&db, &visible.id).unwrap();
        archive_thread(&db, &hidden.id).unwrap();

        let listed = list_archived_threads_for_workspace(&db, &visible.workspace_id).unwrap();
        let listed_ids = listed
            .into_iter()
            .map(|thread| thread.id)
            .collect::<Vec<_>>();

        assert!(listed_ids.contains(&visible.id));
        assert!(!listed_ids.contains(&hidden.id));
    }

    #[test]
    fn archive_and_restore_thread_are_idempotent() {
        let db = test_db();
        let thread = test_thread(&db, "Archived");
        archive_thread(&db, &thread.id).unwrap();
        archive_thread(&db, &thread.id).unwrap();

        let restored = restore_thread(&db, &thread.id).unwrap();
        let restored_again = restore_thread(&db, &thread.id).unwrap();

        assert_eq!(restored.id, thread.id);
        assert_eq!(restored_again.id, thread.id);
    }
}
