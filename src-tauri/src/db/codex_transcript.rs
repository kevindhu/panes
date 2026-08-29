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
    events: &[CodexNativeEvent],
) -> anyhow::Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let native_thread_id = events[0].native_thread_id.as_str();

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
    let native_turn_id = events
        .iter()
        .find_map(|event| event.native_turn_id.as_deref());
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

    for (chunk_index, chunk) in project_chunks(&event.method, &params)
        .into_iter()
        .enumerate()
    {
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
                params![
                    status,
                    event.observed_at_ms,
                    event.params_json,
                    turn_record_id
                ],
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
                params![
                    status,
                    event.observed_at_ms,
                    event.params_json,
                    turn_record_id
                ],
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
    let status =
        item.get("status")
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
               status = CASE
                 WHEN codex_turn_items.completed_json IS NOT NULL THEN codex_turn_items.status
                 ELSE excluded.status
               END,
               phase = CASE
                 WHEN codex_turn_items.completed_json IS NOT NULL THEN codex_turn_items.phase
                 ELSE COALESCE(excluded.phase, codex_turn_items.phase)
               END,
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

    if signature == "itemreasoningsummarypartadded" {
        return vec![ChunkProjection {
            item_id,
            stream_kind: "reasoning_summary_boundary",
            summary_index,
            content: String::new(),
            metadata_json: project_chunk_metadata(params_value, &["summaryIndex"]),
        }];
    }

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
            let metadata_keys: &[&str] = match signature.as_str() {
                "itemagentmessagedelta" => &["phase"],
                "itemreasoningsummarytextdelta" => &["summaryIndex"],
                "itemreasoningtextdelta" => &["contentIndex"],
                "itemcommandexecutionoutputdelta" | "itemfilechangeoutputdelta" => &["stream"],
                "itemcommandexecutionterminalinteraction" | "terminalinteraction" => &["processId"],
                _ => &[],
            };
            return vec![ChunkProjection {
                item_id,
                stream_kind,
                summary_index,
                content: content.to_string(),
                metadata_json: project_chunk_metadata(params_value, metadata_keys),
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

fn project_chunk_metadata(params_value: &Value, keys: &[&str]) -> Option<String> {
    let mut metadata = serde_json::Map::new();
    for key in keys {
        if let Some(value) = params_value.get(*key) {
            metadata.insert((*key).to_owned(), value.clone());
        }
    }
    (!metadata.is_empty())
        .then(|| serde_json::to_string(&Value::Object(metadata)).ok())
        .flatten()
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
    load_turn_snapshot_after(db, assistant_message_id, 0)
}

/// Loads an ordered replay slice after `after_source_sequence` while always returning the
/// current turn record. Items are returned when they changed after the cursor, allowing the
/// frontend to replace their authoritative snapshot without reloading the entire turn.
pub fn load_turn_snapshot_after(
    db: &Database,
    assistant_message_id: &str,
    after_source_sequence: u64,
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
    let after_source_sequence = i64::try_from(after_source_sequence)
        .context("Codex snapshot cursor exceeds SQLite integer range")?;

    let mut event_statement = conn.prepare(
        "SELECT id, source_sequence, event_kind, method, request_id, native_thread_id,
                native_turn_id, params_json, observed_at_ms
         FROM codex_turn_events
         WHERE turn_id = ?1 AND source_sequence > ?2
         ORDER BY source_sequence ASC",
    )?;
    let events = event_statement
        .query_map(
            params![assistant_message_id, after_source_sequence],
            |row| {
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
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;

    let mut item_statement = conn.prepare(
        "SELECT item_id, item_type, status, phase, first_source_sequence,
                last_source_sequence, started_at_ms, completed_at_ms, started_json, completed_json
         FROM codex_turn_items
         WHERE turn_id = ?1 AND last_source_sequence > ?2
         ORDER BY first_source_sequence ASC, item_id ASC",
    )?;
    let items = item_statement
        .query_map(
            params![assistant_message_id, after_source_sequence],
            |row| {
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
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;

    let mut chunk_statement = conn.prepare(
        "SELECT id, event_id, item_id, source_sequence, chunk_index, stream_kind,
                summary_index, content, metadata_json, observed_at_ms
         FROM codex_item_stream_chunks
         WHERE turn_id = ?1 AND source_sequence > ?2
         ORDER BY source_sequence ASC, chunk_index ASC",
    )?;
    let chunks = chunk_statement
        .query_map(
            params![assistant_message_id, after_source_sequence],
            |row| {
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
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Some(CodexTurnSnapshot {
        turn,
        events,
        items,
        chunks,
    }))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        fs,
        path::{Path, PathBuf},
    };

    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::engines::{
        codex_protocol::{parse_incoming, IncomingMessage},
        CodexNativeEventKind, STREAMED_DIFF_MAX_CHARS,
    };

    const LOCAL_THREAD_ID: &str = "local-thread-1";
    const ASSISTANT_MESSAGE_ID: &str = "assistant-message-1";
    const NATIVE_THREAD_ID: &str = "native-thread-1";
    const NATIVE_TURN_ID: &str = "native-turn-1";

    fn create_test_database(name: &str) -> (Database, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "panes-codex-transcript-{name}-{}.sqlite",
            Uuid::new_v4()
        ));
        let db = Database::open(path.clone()).expect("test database should open");
        let conn = db.connect().expect("test database connection");
        conn.execute(
            "INSERT INTO workspaces (id, name, root_path) VALUES ('workspace-1', 'Test', ?1)",
            params![format!("C:\\panes-tests\\{}", Uuid::new_v4())],
        )
        .expect("workspace fixture");
        conn.execute(
            "INSERT INTO threads (
               id, workspace_id, engine_id, model_id, engine_thread_id, title
             ) VALUES (?1, 'workspace-1', 'codex', 'gpt-test', ?2, 'Transcript test')",
            params![LOCAL_THREAD_ID, NATIVE_THREAD_ID],
        )
        .expect("thread fixture");
        conn.execute(
            "INSERT INTO messages (
               id, thread_id, role, blocks_json, status, turn_engine_id, turn_model_id
             ) VALUES (?1, ?2, 'assistant', '[]', 'streaming', 'codex', 'gpt-test')",
            params![ASSISTANT_MESSAGE_ID, LOCAL_THREAD_ID],
        )
        .expect("message fixture");
        drop(conn);
        (db, path)
    }

    fn remove_test_database(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let candidate = PathBuf::from(format!("{}{suffix}", path.display()));
            let _ = fs::remove_file(candidate);
        }
    }

    fn event(source_sequence: u64, method: &str, params_value: Value) -> CodexNativeEvent {
        CodexNativeEvent {
            source_sequence,
            observed_at_ms: 1_700_000_000_000 + source_sequence as i64,
            event_kind: CodexNativeEventKind::Notification,
            method: method.to_owned(),
            request_id: None,
            native_thread_id: NATIVE_THREAD_ID.to_owned(),
            native_turn_id: Some(NATIVE_TURN_ID.to_owned()),
            params_json: serde_json::to_string(&params_value).expect("valid event params"),
        }
    }

    fn replay_fixture_events() -> Vec<CodexNativeEvent> {
        include_str!("../../tests/fixtures/codex_transcript_replay.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .enumerate()
            .map(|(index, line)| {
                let source_sequence = index as u64 + 1;
                let (event_kind, method, request_id, params_json) =
                    match parse_incoming(line).expect("fixture envelope should parse") {
                        IncomingMessage::Notification { method, params } => (
                            CodexNativeEventKind::Notification,
                            method,
                            None,
                            params.get().to_owned(),
                        ),
                        IncomingMessage::Request {
                            id, method, params, ..
                        } => (
                            CodexNativeEventKind::Request,
                            method,
                            Some(id),
                            params.get().to_owned(),
                        ),
                        IncomingMessage::Response(_) => {
                            panic!("replay fixture responses must name their semantic method")
                        }
                    };
                CodexNativeEvent {
                    source_sequence,
                    observed_at_ms: 1_700_000_000_000 + source_sequence as i64,
                    event_kind,
                    method,
                    request_id,
                    native_thread_id: NATIVE_THREAD_ID.to_owned(),
                    native_turn_id: Some(NATIVE_TURN_ID.to_owned()),
                    params_json,
                }
            })
            .collect()
    }

    #[test]
    fn fixture_replay_is_ordered_idempotent_and_restart_safe() {
        let (db, path) = create_test_database("replay");
        let events = replay_fixture_events();

        record_native_event_batch(&db, LOCAL_THREAD_ID, ASSISTANT_MESSAGE_ID, &events)
            .expect("first fixture replay");
        let first = load_turn_snapshot(&db, ASSISTANT_MESSAGE_ID)
            .expect("snapshot query")
            .expect("snapshot should exist");

        record_native_event_batch(&db, LOCAL_THREAD_ID, ASSISTANT_MESSAGE_ID, &events)
            .expect("identical replay should be a no-op");
        let second = load_turn_snapshot(&db, ASSISTANT_MESSAGE_ID)
            .expect("snapshot query")
            .expect("snapshot should exist");
        assert_eq!(second, first);

        assert_eq!(first.events.len(), events.len());
        assert!(first
            .events
            .windows(2)
            .all(|pair| pair[0].source_sequence < pair[1].source_sequence));
        assert!(first.chunks.windows(2).all(|pair| {
            (pair[0].source_sequence, pair[0].chunk_index)
                < (pair[1].source_sequence, pair[1].chunk_index)
        }));
        assert_eq!(first.turn.status, "completed");
        assert!(first.turn.plan_json.is_some());
        assert!(first.turn.usage_json.is_some());
        assert!(first.events.iter().any(|event| {
            event.method == "future/turnArtifact" && event.params_json.contains("\"retain me\"")
        }));

        let plan = first
            .items
            .iter()
            .find(|item| item.item_id == "plan-1")
            .expect("plan item");
        assert_eq!(plan.first_source_sequence, 2, "delta arrived before start");
        assert!(plan
            .started_json
            .as_deref()
            .is_some_and(|json| json.contains("Initial plan")));
        assert!(plan
            .completed_json
            .as_deref()
            .is_some_and(|json| json.contains("Authoritative final plan")));
        assert!(first.chunks.iter().any(|chunk| {
            chunk.item_id.as_deref() == Some("plan-1")
                && chunk.content == "Inspect the protocol before editing."
        }));
        assert!(first.chunks.iter().any(|chunk| {
            chunk.item_id.as_deref() == Some("reason-1")
                && chunk.stream_kind == "reasoning_summary_boundary"
                && chunk.summary_index == Some(0)
        }));
        assert!(first.chunks.iter().any(|chunk| {
            chunk.item_id.as_deref() == Some("cmd-1")
                && chunk.metadata_json.as_deref() == Some(r#"{"stream":"stdout"}"#)
        }));

        let replay_tail = load_turn_snapshot_after(&db, ASSISTANT_MESSAGE_ID, 20)
            .expect("incremental snapshot query")
            .expect("incremental snapshot should exist");
        assert_eq!(replay_tail.turn.last_source_sequence, events.len() as u64);
        assert_eq!(
            replay_tail
                .events
                .iter()
                .map(|event| event.source_sequence)
                .collect::<Vec<_>>(),
            vec![21, 22, 23, 24, 25, 26]
        );
        assert_eq!(
            replay_tail
                .items
                .iter()
                .map(|item| item.item_id.as_str())
                .collect::<Vec<_>>(),
            vec!["agent-1"]
        );
        assert_eq!(
            replay_tail
                .chunks
                .iter()
                .map(|chunk| (chunk.source_sequence, chunk.content.as_str()))
                .collect::<Vec<_>>(),
            vec![(21, "Final answer.")]
        );

        drop(db);
        let reopened = Database::open(path.clone()).expect("database should reopen and remigrate");
        let after_restart = load_turn_snapshot(&reopened, ASSISTANT_MESSAGE_ID)
            .expect("snapshot query after restart")
            .expect("snapshot should survive restart");
        assert_eq!(after_restart, first);

        drop(reopened);
        remove_test_database(&path);
    }

    #[test]
    fn conflicting_duplicate_sequence_fails_loudly() {
        let (db, path) = create_test_database("conflict");
        let original = event(
            1,
            "turn/started",
            json!({"threadId": NATIVE_THREAD_ID, "turnId": NATIVE_TURN_ID}),
        );
        record_native_event_batch(
            &db,
            LOCAL_THREAD_ID,
            ASSISTANT_MESSAGE_ID,
            std::slice::from_ref(&original),
        )
        .expect("original event");

        let mut conflicting = original;
        conflicting.params_json =
            r#"{"threadId":"native-thread-1","turnId":"different"}"#.to_owned();
        let error =
            record_native_event_batch(&db, LOCAL_THREAD_ID, ASSISTANT_MESSAGE_ID, &[conflicting])
                .expect_err("conflicting replay must fail");
        assert!(error.to_string().contains("conflicting Codex replay"));

        drop(db);
        remove_test_database(&path);
    }

    #[test]
    fn client_steer_markers_survive_replay_without_becoming_fake_items() {
        let (db, path) = create_test_database("client-steer");
        let mut submitted = event(
            1,
            "turn/steer",
            json!({
                "steerId": "steer-1",
                "messageId": "message-1",
                "status": "submitted",
                "display": {"content": "Focus on failures first."},
                "request": {"method": "turn/steer", "params": {"expectedTurnId": NATIVE_TURN_ID}}
            }),
        );
        submitted.event_kind = CodexNativeEventKind::ClientRequest;
        submitted.request_id = Some("steer-1".to_owned());
        let mut accepted = event(
            2,
            "turn/steer",
            json!({
                "steerId": "steer-1",
                "messageId": "message-1",
                "status": "accepted",
                "result": {"turnId": NATIVE_TURN_ID}
            }),
        );
        accepted.event_kind = CodexNativeEventKind::ClientResponse;
        accepted.request_id = Some("steer-1".to_owned());

        record_native_event_batch(
            &db,
            LOCAL_THREAD_ID,
            ASSISTANT_MESSAGE_ID,
            &[submitted, accepted],
        )
        .expect("client steer markers should persist");
        let snapshot = load_turn_snapshot(&db, ASSISTANT_MESSAGE_ID)
            .expect("snapshot query")
            .expect("snapshot should exist");

        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[0].event_kind, "client_request");
        assert_eq!(snapshot.events[1].event_kind, "client_response");
        assert!(snapshot.events[0]
            .params_json
            .contains("Focus on failures first."));
        assert!(snapshot.items.is_empty());
        assert!(snapshot.chunks.is_empty());

        drop(db);
        remove_test_database(&path);
    }

    #[test]
    fn migration_upgrades_an_existing_database_and_is_idempotent() {
        let path = std::env::temp_dir().join(format!(
            "panes-codex-transcript-legacy-{}.sqlite",
            Uuid::new_v4()
        ));
        let legacy = rusqlite::Connection::open(&path).expect("legacy database");
        legacy
            .execute_batch(include_str!("migrations/001_initial.sql"))
            .expect("legacy schema");
        legacy
            .execute(
                "INSERT INTO workspaces (id, name, root_path)
                 VALUES ('legacy-workspace', 'Legacy', ?1)",
                params![format!("C:\\panes-legacy-tests\\{}", Uuid::new_v4())],
            )
            .expect("legacy workspace");
        legacy
            .execute(
                "INSERT INTO threads (id, workspace_id, engine_id, model_id)
                 VALUES ('legacy-thread', 'legacy-workspace', 'codex', 'gpt-test')",
                [],
            )
            .expect("legacy thread");
        legacy
            .execute(
                "INSERT INTO messages (id, thread_id, role, status)
                 VALUES ('legacy-message', 'legacy-thread', 'assistant', 'completed')",
                [],
            )
            .expect("legacy message");
        drop(legacy);

        for pass in 0..2 {
            let upgraded = Database::open(path.clone()).expect("migration should apply");
            let connection = upgraded.connect().expect("upgraded connection");
            let table_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'table'
                       AND name IN (
                         'codex_turns',
                         'codex_turn_events',
                         'codex_turn_items',
                         'codex_item_stream_chunks'
                       )",
                    [],
                    |row| row.get(0),
                )
                .expect("transcript tables query");
            let legacy_message_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM messages WHERE id = 'legacy-message'",
                    [],
                    |row| row.get(0),
                )
                .expect("legacy data query");
            assert_eq!(table_count, 4, "migration pass {pass}");
            assert_eq!(legacy_message_count, 1, "migration pass {pass}");
            drop(connection);
            drop(upgraded);
        }

        remove_test_database(&path);
    }

    #[test]
    fn completed_item_remains_authoritative_when_start_arrives_late() {
        let (db, path) = create_test_database("completion-authority");
        let completed = event(
            1,
            "item/completed",
            json!({
                "threadId": NATIVE_THREAD_ID,
                "turnId": NATIVE_TURN_ID,
                "item": {
                    "id": "late-item",
                    "type": "agentMessage",
                    "status": "completed",
                    "phase": "final",
                    "text": "authoritative"
                }
            }),
        );
        let started = event(
            2,
            "item/started",
            json!({
                "threadId": NATIVE_THREAD_ID,
                "turnId": NATIVE_TURN_ID,
                "item": {
                    "id": "late-item",
                    "type": "agentMessage",
                    "status": "inProgress",
                    "phase": "commentary",
                    "text": "stale start"
                }
            }),
        );

        record_native_event_batch(
            &db,
            LOCAL_THREAD_ID,
            ASSISTANT_MESSAGE_ID,
            &[completed, started],
        )
        .expect("out-of-order lifecycle should replay");
        let snapshot = load_turn_snapshot(&db, ASSISTANT_MESSAGE_ID)
            .expect("snapshot query")
            .expect("snapshot should exist");
        let item = &snapshot.items[0];

        assert_eq!(item.status, "completed");
        assert_eq!(item.phase.as_deref(), Some("final"));
        assert!(item
            .completed_json
            .as_deref()
            .is_some_and(|json| json.contains("authoritative")));
        assert!(item
            .started_json
            .as_deref()
            .is_some_and(|json| json.contains("stale start")));

        drop(db);
        remove_test_database(&path);
    }

    #[test]
    fn every_reviewed_item_and_unknown_future_item_survive_completion_without_start() {
        let (db, path) = create_test_database("item-types");
        let contract: Value = serde_json::from_str(include_str!(
            "../../../scripts/codex-app-server-contract.json"
        ))
        .expect("reviewed contract JSON");
        let reviewed = contract["threadItemTypes"]
            .as_object()
            .expect("thread item contract")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut expected = reviewed.iter().cloned().collect::<BTreeSet<_>>();
        expected.insert("futureArtifact".to_owned());
        let mut item_types = reviewed;
        item_types.push("futureArtifact".to_owned());

        let events = item_types
            .iter()
            .enumerate()
            .map(|(index, item_type)| {
                event(
                    index as u64 + 1,
                    "item/completed",
                    json!({
                        "threadId": NATIVE_THREAD_ID,
                        "turnId": NATIVE_TURN_ID,
                        "item": {
                            "id": format!("item-{index}"),
                            "type": item_type,
                            "status": "completed",
                            "opaque": {"retained": true}
                        }
                    }),
                )
            })
            .collect::<Vec<_>>();

        record_native_event_batch(&db, LOCAL_THREAD_ID, ASSISTANT_MESSAGE_ID, &events)
            .expect("all item completions should replay");
        let snapshot = load_turn_snapshot(&db, ASSISTANT_MESSAGE_ID)
            .expect("snapshot query")
            .expect("snapshot should exist");
        let actual = snapshot
            .items
            .iter()
            .map(|item| item.item_type.clone())
            .collect::<BTreeSet<_>>();

        assert_eq!(actual, expected);
        assert!(snapshot.items.iter().all(|item| {
            item.started_json.is_none()
                && item
                    .completed_json
                    .as_deref()
                    .is_some_and(|json| json.contains("\"retained\":true"))
        }));

        drop(db);
        remove_test_database(&path);
    }

    #[test]
    fn fifty_megabyte_output_is_preserved_exactly() {
        let (db, path) = create_test_database("large-output");
        let content = format!(
            "begin:{}:end",
            "x".repeat(50 * 1024 * 1024 + STREAMED_DIFF_MAX_CHARS)
        );
        let large_event = event(
            1,
            "item/commandExecution/outputDelta",
            json!({
                "threadId": NATIVE_THREAD_ID,
                "turnId": NATIVE_TURN_ID,
                "itemId": "large-command",
                "stream": "stdout",
                "delta": &content
            }),
        );
        let exact_params = large_event.params_json.clone();

        record_native_event_batch(&db, LOCAL_THREAD_ID, ASSISTANT_MESSAGE_ID, &[large_event])
            .expect("large output should persist");
        let snapshot = load_turn_snapshot(&db, ASSISTANT_MESSAGE_ID)
            .expect("snapshot query")
            .expect("snapshot should exist");

        assert_eq!(snapshot.events[0].params_json, exact_params);
        assert_eq!(snapshot.chunks.len(), 1);
        assert_eq!(snapshot.chunks[0].content, content);

        drop(db);
        remove_test_database(&path);
    }
}
