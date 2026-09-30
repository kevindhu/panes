//! Read-side presentation only. The captured ledger is never modified.
use crate::{db, state::AppState};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

const IMAGE_PREFIX: &str = "panes-image:";

pub fn defer_item_images(value: &mut Value, message: &str, item: &str, column: &str) {
    fn walk(
        value: &mut Value,
        path: &str,
        mime: &str,
        image: bool,
        message: &str,
        item: &str,
        column: &str,
    ) {
        match value {
            Value::Object(object) => {
                let mime = object
                    .get("mimeType")
                    .or_else(|| object.get("mime_type"))
                    .and_then(Value::as_str)
                    .unwrap_or(mime)
                    .to_string();
                let image = image
                    || object
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| {
                            matches!(kind, "image" | "image_url" | "inputImage" | "outputImage")
                        })
                    || mime.starts_with("image/");
                for (key, value) in object.iter_mut() {
                    let escaped = key.replace('~', "~0").replace('/', "~1");
                    walk(
                        value,
                        &format!("{path}/{escaped}"),
                        &mime,
                        image
                            && matches!(
                                key.as_str(),
                                "data" | "blob" | "base64" | "b64_json" | "url" | "image_url"
                            ),
                        message,
                        item,
                        column,
                    );
                }
            }
            Value::Array(values) => {
                for (index, value) in values.iter_mut().enumerate() {
                    walk(
                        value,
                        &format!("{path}/{index}"),
                        mime,
                        image,
                        message,
                        item,
                        column,
                    );
                }
            }
            Value::String(text)
                if text.starts_with("data:image/") || (image && text.len() > 4096) =>
            {
                let detected_mime = text
                    .strip_prefix("data:")
                    .and_then(|s| s.split(';').next())
                    .unwrap_or(if mime.is_empty() { "image/png" } else { mime });
                *text = format!(
                    "{IMAGE_PREFIX}{}",
                    serde_json::json!([message, item, column, path, detected_mime])
                );
            }
            _ => {}
        }
    }
    walk(value, "", "", false, message, item, column);
}

pub fn compact_snapshot(
    snapshot: &mut db::codex_transcript::CodexTurnSnapshot,
) -> anyhow::Result<()> {
    snapshot.turn.started_json = None;
    snapshot.turn.completed_json = None;
    for item in &mut snapshot.items {
        for (column, raw) in [
            ("started_json", &mut item.started_json),
            ("completed_json", &mut item.completed_json),
        ] {
            if let Some(json) = raw {
                let mut value: Value = serde_json::from_str(json)?;
                defer_item_images(&mut value, &snapshot.turn.message_id, &item.item_id, column);
                *json = serde_json::to_string(&value)?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_codex_turn_events(
    state: tauri::State<'_, AppState>,
    assistant_message_id: String,
    offset: u32,
) -> Result<Vec<db::codex_transcript::CodexTurnEventRecord>, String> {
    let database = state.db.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let conn = database.connect()?;
        let mut statement = conn.prepare("SELECT id, source_sequence, event_kind, method, request_id, native_thread_id, native_turn_id, observed_at_ms FROM codex_turn_events WHERE turn_id = ?1 ORDER BY source_sequence LIMIT 100 OFFSET ?2")?;
        let rows = statement.query_map(params![assistant_message_id, offset], |row| Ok(db::codex_transcript::CodexTurnEventRecord {
            id: row.get(0)?, source_sequence: row.get::<_, i64>(1)? as u64,
            event_kind: row.get(2)?, method: row.get(3)?, request_id: row.get(4)?,
            native_thread_id: row.get(5)?, native_turn_id: row.get(6)?,
            params_json: "{}".into(), observed_at_ms: row.get(7)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_codex_turn_event(
    state: tauri::State<'_, AppState>,
    assistant_message_id: String,
    source_sequence: u64,
) -> Result<String, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let conn = db.connect()?;
        Ok(conn.query_row(
            "SELECT params_json FROM codex_turn_events WHERE turn_id = ?1 AND source_sequence = ?2",
            params![assistant_message_id, source_sequence],
            |row| row.get(0),
        )?)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_codex_turn_item(
    state: tauri::State<'_, AppState>,
    assistant_message_id: String,
    item_id: String,
) -> Result<Value, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<Value> {
        let conn = db.connect()?;
        let (started, completed): (Option<String>, Option<String>) = conn.query_row(
            "SELECT started_json, completed_json FROM codex_turn_items WHERE turn_id = ?1 AND item_id = ?2",
            params![assistant_message_id, item_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(serde_json::json!({"started": started, "completed": completed}))
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn prepare_codex_transcript_image(
    state: tauri::State<'_, AppState>,
    source: String,
) -> Result<super::chat::PreparedAttachmentImageAssetPayload, String> {
    let parts: Vec<String> = serde_json::from_str(
        source
            .strip_prefix(IMAGE_PREFIX)
            .ok_or("Invalid transcript image")?,
    )
    .map_err(|e| format!("Invalid transcript image reference: {e}"))?;
    if parts.len() != 5 || !matches!(parts[2].as_str(), "started_json" | "completed_json") {
        return Err("Invalid transcript image reference".into());
    }
    let db = state.db.clone();
    let mime = parts[4].clone();
    let data = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let conn = db.connect()?;
        // Column is validated above; values remain bound parameters.
        let json: Option<String> = conn
            .query_row(
                &format!(
                    "SELECT {} FROM codex_turn_items WHERE turn_id = ?1 AND item_id = ?2",
                    parts[2]
                ),
                params![parts[0], parts[1]],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let value: Value = serde_json::from_str(
            &json.ok_or_else(|| anyhow::anyhow!("Transcript image no longer exists"))?,
        )?;
        Ok(value
            .pointer(&parts[3])
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Transcript image no longer exists"))?
            .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    super::chat::cache_embedded_chat_image(mime, data).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Explicit local audit against a disposable database copy, never production.
    #[test]
    #[ignore]
    fn export_local_virtualization_fixture() {
        let path = std::env::var("PANES_SCROLL_AUDIT_DB").expect("path to disposable copied DB");
        let thread = std::env::var("PANES_SCROLL_AUDIT_THREAD").expect("thread ID");
        let output = std::env::var("PANES_SCROLL_AUDIT_OUTPUT").expect("local fixture output path");
        let database = db::Database::open(path.into()).unwrap();
        let started = std::time::Instant::now();
        let messages = db::messages::get_thread_messages_window_for_display(
            &database, &thread, None, 10000, true,
        )
        .unwrap()
        .messages;
        let message_bytes = serde_json::to_vec(&messages).unwrap().len();
        let mut snapshots = Vec::new();
        let mut full_bytes = 0;
        for message in &messages {
            if let Some(mut snapshot) =
                db::codex_transcript::load_turn_snapshot_view(&database, &message.id, 0, true)
                    .unwrap()
            {
                full_bytes += serde_json::to_vec(
                    &db::codex_transcript::load_turn_snapshot(&database, &message.id).unwrap(),
                )
                .unwrap()
                .len();
                compact_snapshot(&mut snapshot).unwrap();
                snapshots.push(snapshot);
            }
        }
        let display_bytes = serde_json::to_vec(&snapshots).unwrap().len();
        println!("{} messages, {} turns; message DTO bytes={}, exact snapshots bytes={}, display snapshots bytes={}, elapsed={:?}", messages.len(), snapshots.len(), message_bytes, full_bytes, display_bytes, started.elapsed());
        std::fs::write(
            output,
            serde_json::to_vec(&json!({ "messages": messages, "snapshots": snapshots })).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn image_references_resolve_nested_payloads_without_rewriting_text() {
        let image = format!("data:image/png;base64,{}", "A".repeat(10000));
        let mut payload = json!({"content": [{"type": "image", "data": "A".repeat(9000), "mimeType": "image/png"}], "a/b~c": {"url": image}, "data": "ordinary text".repeat(1000), "command": "echo hello"});
        let original = payload.clone();
        defer_item_images(&mut payload, "message", "item", "completed_json");
        for path in ["/content/0/data", "/a~1b~0c/url"] {
            let source = payload.pointer(path).unwrap().as_str().unwrap();
            let reference: Vec<String> =
                serde_json::from_str(source.strip_prefix(IMAGE_PREFIX).unwrap()).unwrap();
            assert_eq!(reference[3], path);
            assert_eq!(original.pointer(&reference[3]), original.pointer(path));
            assert!(source.len() < 150);
        }
        assert_eq!(payload["data"], original["data"]);
        assert_eq!(payload["command"], original["command"]);
    }
}
