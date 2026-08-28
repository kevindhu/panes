use anyhow::{bail, Context};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engines::events::CodexNativeEvent;

use super::Database;

const PENDING_ITEM_TYPE: &str = "__pending__";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnRecord {
    pub id: String,
    pub thread_id: String,
    pub message_id: String,
    pub native_thread_id: String,
    pub native_turn_id: Option<String>,
    pub status: String,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub first_event_at_ms: Option<i64>,
    pub last_event_at_ms: Option<i64>,
    pub last_source_sequence: u64,
    pub started_json: Option<String>,
    pub completed_json: Option<String>,
    pub plan_json: Option<String>,
    pub usage_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnEventRecord {
    pub id: i64,
    pub source_sequence: u64,
    pub event_kind: String,
    pub method: String,
    pub request_id: Option<String>,
    pub native_thread_id: String,
    pub native_turn_id: Option<String>,
    pub params_json: String,
    pub observed_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnItemRecord {
    pub item_id: String,
    pub item_type: String,
    pub status: String,
    pub phase: Option<String>,
    pub first_source_sequence: u64,
    pub last_source_sequence: u64,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub started_json: Option<String>,
    pub completed_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexItemStreamChunkRecord {
    pub id: i64,
    pub event_id: i64,
    pub item_id: Option<String>,
    pub source_sequence: u64,
    pub chunk_index: u32,
    pub stream_kind: String,
    pub summary_index: Option<i64>,
    pub content: String,
    pub metadata_json: Option<String>,
    pub observed_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnSnapshot {
    pub turn: CodexTurnRecord,
    pub events: Vec<CodexTurnEventRecord>,
    pub items: Vec<CodexTurnItemRecord>,
    pub chunks: Vec<CodexItemStreamChunkRecord>,
}

#[derive(Debug)]
struct ChunkProjection {
    item_id: Option<String>,
    stream_kind: &'static str,
    summary_index: Option<i64>,
    content: String,
    metadata_json: Option<String>,
}

/// Records an ordered batch without applying any legacy output cap.
///
/// Replaying the same source sequence with identical bytes is idempotent. Reusing a sequence
/// for different bytes is a hard error because silently choosing one would corrupt ordering.
#[allow(clippy::too_many_arguments)]
pub fn record_native_event_batch(
    db: &Database,
    local_thread_id: &str,
    assistant_message_id: &str,
    native_thread_id: &str,
    events: &[CodexNativeEvent],
) -> anyhow::Result<()> {
    if events.is_empty() {
        return Ok(());
    }

    let mut conn = db.connect()?;
    let transaction = conn
        .transaction()
        .context("failed to start Codex transcript transaction")?;

    ensure_turn_row(
        &transaction,
        local_thread_id,
        assistant_message_id,
        native_thread_id,
        events,
    )?;

    for event in events {
        if event.native_thread_id != native_thread_id {
            bail!(
                "Codex native event thread mismatch: expected {native_thread_id}, got {}",
                event.native_thread_id
            );
        }
        record_one_event(&transaction, assistant_message_id, event)?;
    }

    transaction
        .commit()
        .context("failed to commit Codex transcript transaction")?;
    Ok(())
}

fn ensure_turn_row(
    transaction: &Transaction<'_>,
    local_thread_id: &str,
    assistant_message_id: &str,
    native_thread_id: &str,
    events: &[CodexNativeEvent],
) -> anyhow::Result<()> {
    let native_turn_id = events.iter().find_map(|event| event.native_turn_id.as_deref());
    let first_observed_at = events.iter().map(|event| event.observed_at_ms).min();
    let last_observed_at = events.iter().map(|event| event.observed_at_ms).max();

    transaction
        .execute(
            "INSERT INTO codex_turns (
               id, thread_id, message_id, native_thread_id, native_turn_id,
               first_event_at_ms, last_event_at_ms
             ) VALUES (?1, ?2, ?1, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               native_turn_id = COALESCE(codex_turns.native_turn_id, excluded.native_turn_id),
               first_event_at_ms = CASE
                 WHEN codex_turns.first_event_at_ms IS NULL THEN excluded.first_event_at_ms
                 WHEN excluded.first_event_at_ms IS NULL THEN codex_turns.first_event_at_ms
                 ELSE MIN(codex_turns.first_event_at_ms, excluded.first_event_at_ms)
               END,
               last_event_at_ms = CASE
                 WHEN codex_turns.last_event_at_ms IS NULL THEN excluded.last_event_at_ms
                 WHEN excluded.last_event_at_ms IS NULL THEN codex_turns.last_event_at_ms
                 ELSE MAX(codex_turns.last_event_at_ms, excluded.last_event_at_ms)
               END,
               updated_at = datetime('now')",
            params![
                assistant_message_id,
                local_thread_id,
                native_thread_id,
                native_turn_id,
                first_observed_at,
                last_observed_at,
            ],
        )
        .context("failed to create Codex turn ledger row")?;

    let existing: (String, String, Option<String>) = transaction
        .query_row(
            "SELECT thread_id, native_thread_id, native_turn_id
             FROM codex_turns WHERE id = ?1",
            params![assistant_message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .context("failed to validate Codex turn ledger owner")?;
    if existing.0 != local_thread_id || existing.1 != native_thread_id {
        bail!("Codex turn ledger owner changed for message {assistant_message_id}");
    }
    if let (Some(existing_turn_id), Some(incoming_turn_id)) =
        (existing.2.as_deref(), native_turn_id)
    {
        if existing_turn_id != incoming_turn_id {
            bail!(
                "Codex native turn id changed for message {assistant_message_id}: \
                 {existing_turn_id} -> {incoming_turn_id}"
            );
        }
    }
    Ok(())
}

fn record_one_event(
    transaction: &Transaction<'_>,
    turn_record_id: &str,
    event: &CodexNativeEvent,
) -> anyhow::Result<()> {
    let params: Value = serde_json::from_str(&event.params_json)
        .with_context(|| format!("invalid params JSON for Codex method {}", event.method))?;
    let source_sequence = i64::try_from(event.source_sequence)
        .context("Codex source sequence exceeds SQLite integer range")?;

    let inserted = transaction
        .execute(
            "INSERT INTO codex_turn_events (
               turn_id, source_sequence, event_kind, method, request_id,
               native_thread_id, native_turn_id, params_json, observed_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(turn_id, source_sequence) DO NOTHING",
            params![
                turn_record_id,
                source_sequence,
                event.event_kind.as_str(),
                event.method,
                event.request_id,
                event.native_thread_id,
                event.native_turn_id,
                event.params_json,
                event.observed_at_ms,
            ],
        )
        .with_context(|| format!("failed to append native Codex event {}", event.method))?;

    let existing = transaction
        .query_row(
            "SELECT id, event_kind, method, request_id, native_thread_id,
                    native_turn_id, params_json, observed_at_ms
             FROM codex_turn_events
             WHERE turn_id = ?1 AND source_sequence = ?2",
            params![turn_record_id, source_sequence],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
        .context("failed to reload native Codex event")?;

    if inserted == 0 {
        let matches = existing.1 == event.event_kind.as_str()
            && existing.2 == event.method
            && existing.3 == event.request_id
            && existing.4 == event.native_thread_id
            && existing.5 == event.native_turn_id
            && existing.6 == event.params_json
            && existing.7 == event.observed_at_ms;
        if !matches {
            bail!(
                "conflicting Codex replay at turn {turn_record_id}, source sequence {}",
                event.source_sequence
            );
        }
        return Ok(());
    }

    update_turn_from_event(transaction, turn_record_id, event, &params)?;
    update_item_from_event(transaction, turn_record_id, event, &params)?;

    for (chunk_index, chunk) in project_chunks(&event.method, &params).into_iter().enumerate() {
        if let Some(item_id) = chunk.item_id.as_deref() {
            ensure_pending_item(transaction, turn_record_id, item_id, event)?;
        }
        transaction
            .execute(
                "INSERT INTO codex_item_stream_chunks (
                   turn_id, event_id, item_id, source_sequence, chunk_index, stream_kind,
                   summary_index, content, metadata_json, observed_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    turn_record_id,
                    existing.0,
                    chunk.item_id,
                    source_sequence,
                    chunk_index as i64,
                    chunk.stream_kind,
                    chunk.summary_index,
                    chunk.content,
                    chunk.metadata_json,
                    event.observed_at_ms,
                ],
            )
            .context("failed to append Codex item stream chunk")?;
    }

    transaction
        .execute(
            "UPDATE codex_turns
             SET native_turn_id = COALESCE(native_turn_id, ?1),
                 first_event_at_ms = COALESCE(first_event_at_ms, ?2),
                 last_event_at_ms = CASE
                   WHEN last_event_at_ms IS NULL THEN ?2
                   ELSE MAX(last_event_at_ms, ?2)
                 END,
                 last_source_sequence = MAX(last_source_sequence, ?3),
                 updated_at = datetime('now')
             WHERE id = ?4",
            params![
                event.native_turn_id,
                event.observed_at_ms,
                source_sequence,
                turn_record_id,
            ],
        )
        .context("failed to advance Codex turn ledger")?;
    Ok(())
}

fn update_turn_from_event(
    transaction: &Transaction<'_>,
    turn_record_id: &str,
    event: &CodexNativeEvent,
    params_value: &Value,
) -> anyhow::Result<()> {
    let signature = method_signature(&event.method);
    match signature.as_str() {
        "turnstarted" => {
            let status = extract_turn_status(params_value).unwrap_or("in_progress");
            transaction.execute(
                "UPDATE codex_turns
                 SET status = ?1,
                     started_at_ms = COALESCE(started_at_ms, ?2),
                     started_json = COALESCE(started_json, ?3),
                     updated_at = datetime('now')
                 WHERE id = ?4",
                params![status, event.observed_at_ms, event.params_json, turn_record_id],
            )?;
        }
        "turncompleted" => {
            let status = extract_turn_status(params_value).unwrap_or("completed");
            transaction.execute(
                "UPDATE codex_turns
                 SET status = ?1,
                     completed_at_ms = ?2,
                     completed_json = ?3,
                     updated_at = datetime('now')
                 WHERE id = ?4",
                params![status, event.observed_at_ms, event.params_json, turn_record_id],
            )?;
        }
        "turnplanupdated" => {
            transaction.execute(
                "UPDATE codex_turns SET plan_json = ?1, updated_at = datetime('now') WHERE id = ?2",
                params![event.params_json, turn_record_id],
            )?;
        }
        "threadtokenusageupdated" => {
            let usage_json = params_value
                .get("tokenUsage")
                .map(serde_json::to_string)
                .transpose()?
                .unwrap_or_else(|| event.params_json.clone());
            transaction.execute(
                "UPDATE codex_turns SET usage_json = ?1, updated_at = datetime('now') WHERE id = ?2",
                params![usage_json, turn_record_id],
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn update_item_from_event(
    transaction: &Transaction<'_>,
    turn_record_id: &str,
    event: &CodexNativeEvent,
    params_value: &Value,
) -> anyhow::Result<()> {
    let signature = method_signature(&event.method);
    if signature != "itemstarted" && signature != "itemcompleted" {
        return Ok(());
    }
    let Some(item) = params_value.get("item").and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(item_id) = item.get("id").and_then(Value::as_str) else {
        return Ok(());
    };
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(PENDING_ITEM_TYPE);
    let phase = item.get("phase").and_then(Value::as_str);
    let status = item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(if signature == "itemcompleted" {
            "completed"
        } else {
            "in_progress"
        });
    let item_json = serde_json::to_string(item)?;
    let sequence = i64::try_from(event.source_sequence)?;

    if signature == "itemstarted" {
        transaction.execute(
            "INSERT INTO codex_turn_items (
               turn_id, item_id, item_type, status, phase,
               first_source_sequence, last_source_sequence, started_at_ms, started_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
             ON CONFLICT(turn_id, item_id) DO UPDATE SET
               item_type = CASE
                 WHEN codex_turn_items.item_type = ?9 THEN excluded.item_type
                 ELSE codex_turn_items.item_type
               END,
               status = excluded.status,
               phase = COALESCE(excluded.phase, codex_turn_items.phase),
               first_source_sequence = MIN(codex_turn_items.first_source_sequence, excluded.first_source_sequence),
               last_source_sequence = MAX(codex_turn_items.last_source_sequence, excluded.last_source_sequence),
               started_at_ms = COALESCE(codex_turn_items.started_at_ms, excluded.started_at_ms),
               started_json = COALESCE(codex_turn_items.started_json, excluded.started_json),
               updated_at = datetime('now')",
            params![
                turn_record_id,
                item_id,
                item_type,
                status,
                phase,
                sequence,
                event.observed_at_ms,
                item_json,
                PENDING_ITEM_TYPE,
            ],
        )?;
    } else {
        // Codex item completion is authoritative. It replaces final type/status/phase fields but
        // never deletes the independently stored started payload or streamed chunks.
        transaction.execute(
            "INSERT INTO codex_turn_items (
               turn_id, item_id, item_type, status, phase,
               first_source_sequence, last_source_sequence, completed_at_ms, completed_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
             ON CONFLICT(turn_id, item_id) DO UPDATE SET
               item_type = excluded.item_type,
               status = excluded.status,
               phase = COALESCE(excluded.phase, codex_turn_items.phase),
               first_source_sequence = MIN(codex_turn_items.first_source_sequence, excluded.first_source_sequence),
               last_source_sequence = MAX(codex_turn_items.last_source_sequence, excluded.last_source_sequence),
               completed_at_ms = excluded.completed_at_ms,
               completed_json = excluded.completed_json,
               updated_at = datetime('now')",
            params![
                turn_record_id,
                item_id,
                item_type,
                status,
                phase,
                sequence,
                event.observed_at_ms,
                item_json,
            ],
        )?;
    }
    Ok(())
}

fn ensure_pending_item(
    transaction: &Transaction<'_>,
    turn_record_id: &str,
    item_id: &str,
    event: &CodexNativeEvent,
) -> anyhow::Result<()> {
    let sequence = i64::try_from(event.source_sequence)?;
    transaction.execute(
        "INSERT INTO codex_turn_items (
           turn_id, item_id, item_type, status, first_source_sequence, last_source_sequence
         ) VALUES (?1, ?2, ?3, 'in_progress', ?4, ?4)
         ON CONFLICT(turn_id, item_id) DO UPDATE SET
           first_source_sequence = MIN(codex_turn_items.first_source_sequence, excluded.first_source_sequence),
           last_source_sequence = MAX(codex_turn_items.last_source_sequence, excluded.last_source_sequence),
           updated_at = datetime('now')",
        params![turn_record_id, item_id, PENDING_ITEM_TYPE, sequence],
    )?;
    Ok(())
}

fn project_chunks(method: &str, params_value: &Value) -> Vec<ChunkProjection> {
    let signature = method_signature(method);
    let item_id = params_value
        .get("itemId")
        .or_else(|| params_value.get("item_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let summary_index = params_value
        .get("summaryIndex")
        .or_else(|| params_value.get("summary_index"))
        .and_then(Value::as_i64);

    let (stream_kind, content_key) = match signature.as_str() {
        "itemagentmessagedelta" => ("agent_text", "delta"),
        "itemplandelta" => ("plan", "delta"),
        "itemreasoningsummarytextdelta" => ("reasoning_summary", "delta"),
        "itemreasoningtextdelta" => ("reasoning", "delta"),
        "itemcommandexecutionoutputdelta" => ("command_output", "delta"),
        "itemfilechangeoutputdelta" => ("file_change_output", "delta"),
        "itemcommandexecutionterminalinteraction" | "terminalinteraction" => {
            ("terminal_input", "stdin")
        }
        "itemmcptoolcallprogress" => ("mcp_progress", "message"),
        "threadrealtimetranscriptdelta" => ("realtime_transcript", "delta"),
        _ => ("", ""),
    };

    if !stream_kind.is_empty() {
        if let Some(content) = params_value.get(content_key).and_then(Value::as_str) {
            return vec![ChunkProjection {
                item_id,
                stream_kind,
                summary_index,
                content: content.to_string(),
                metadata_json: None,
            }];
        }
    }

    if signature == "itemfilechangepatchupdated" {
        return params_value
            .get("changes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|change| {
                let content = change.get("diff")?.as_str()?.to_string();
                let metadata_json = serde_json::to_string(&serde_json::json!({
                    "path": change.get("path"),
                    "kind": change.get("kind"),
                }))
                .ok();
                Some(ChunkProjection {
                    item_id: item_id.clone(),
                    stream_kind: "file_patch",
                    summary_index: None,
                    content,
                    metadata_json,
                })
            })
            .collect();
    }

    Vec::new()
}

fn extract_turn_status(value: &Value) -> Option<&str> {
    value
        .get("turn")
        .and_then(|turn| turn.get("status"))
        .or_else(|| value.get("status"))
        .and_then(Value::as_str)
        .map(normalize_status)
}

fn normalize_status(status: &str) -> &str {
    match status {
        "inProgress" | "in_progress" | "running" | "streaming" => "in_progress",
        "completed" => "completed",
        "interrupted" | "cancelled" | "canceled" => "interrupted",
        "failed" | "error" => "failed",
        other => other,
    }
}

fn method_signature(method: &str) -> String {
    method
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub fn load_turn_snapshot(
    db: &Database,
    assistant_message_id: &str,
) -> anyhow::Result<Option<CodexTurnSnapshot>> {
    let conn = db.connect()?;
    let turn = conn
        .query_row(
            "SELECT id, thread_id, message_id, native_thread_id, native_turn_id, status,
                    started_at_ms, completed_at_ms, first_event_at_ms, last_event_at_ms,
                    last_source_sequence, started_json, completed_json, plan_json, usage_json
             FROM codex_turns WHERE id = ?1",
            params![assistant_message_id],
            |row| {
                Ok(CodexTurnRecord {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    message_id: row.get(2)?,
                    native_thread_id: row.get(3)?,
                    native_turn_id: row.get(4)?,
                    status: row.get(5)?,
                    started_at_ms: row.get(6)?,
                    completed_at_ms: row.get(7)?,
                    first_event_at_ms: row.get(8)?,
                    last_event_at_ms: row.get(9)?,
                    last_source_sequence: row.get::<_, i64>(10)? as u64,
                    started_json: row.get(11)?,
                    completed_json: row.get(12)?,
                    plan_json: row.get(13)?,
                    usage_json: row.get(14)?,
                })
            },
        )
        .optional()
        .context("failed to load Codex turn snapshot")?;
    let Some(turn) = turn else {
        return Ok(None);
    };

    let mut event_statement = conn.prepare(
        "SELECT id, source_sequence, event_kind, method, request_id, native_thread_id,
                native_turn_id, params_json, observed_at_ms
         FROM codex_turn_events WHERE turn_id = ?1 ORDER BY source_sequence ASC",
    )?;
    let events = event_statement
        .query_map(params![assistant_message_id], |row| {
            Ok(CodexTurnEventRecord {
                id: row.get(0)?,
                source_sequence: row.get::<_, i64>(1)? as u64,
                event_kind: row.get(2)?,
                method: row.get(3)?,
                request_id: row.get(4)?,
                native_thread_id: row.get(5)?,
                native_turn_id: row.get(6)?,
                params_json: row.get(7)?,
                observed_at_ms: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut item_statement = conn.prepare(
        "SELECT item_id, item_type, status, phase, first_source_sequence,
                last_source_sequence, started_at_ms, completed_at_ms, started_json, completed_json
         FROM codex_turn_items
         WHERE turn_id = ?1
         ORDER BY first_source_sequence ASC, item_id ASC",
    )?;
    let items = item_statement
        .query_map(params![assistant_message_id], |row| {
            Ok(CodexTurnItemRecord {
                item_id: row.get(0)?,
                item_type: row.get(1)?,
                status: row.get(2)?,
                phase: row.get(3)?,
                first_source_sequence: row.get::<_, i64>(4)? as u64,
                last_source_sequence: row.get::<_, i64>(5)? as u64,
                started_at_ms: row.get(6)?,
                completed_at_ms: row.get(7)?,
                started_json: row.get(8)?,
                completed_json: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut chunk_statement = conn.prepare(
        "SELECT id, event_id, item_id, source_sequence, chunk_index, stream_kind,
                summary_index, content, metadata_json, observed_at_ms
         FROM codex_item_stream_chunks
         WHERE turn_id = ?1
         ORDER BY source_sequence ASC, chunk_index ASC",
    )?;
    let chunks = chunk_statement
        .query_map(params![assistant_message_id], |row| {
            Ok(CodexItemStreamChunkRecord {
                id: row.get(0)?,
                event_id: row.get(1)?,
                item_id: row.get(2)?,
                source_sequence: row.get::<_, i64>(3)? as u64,
                chunk_index: row.get::<_, i64>(4)? as u32,
                stream_kind: row.get(5)?,
                summary_index: row.get(6)?,
                content: row.get(7)?,
                metadata_json: row.get(8)?,
                observed_at_ms: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Some(CodexTurnSnapshot {
        turn,
        events,
        items,
        chunks,
    }))
}

