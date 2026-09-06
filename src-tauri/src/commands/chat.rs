use std::{
    borrow::Cow,
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};

use anyhow::Context;
use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, value::RawValue, Value};
use tauri::{Emitter, Manager, State};
use tokio::fs as tokio_fs;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    db,
    engines::{
        approval_response_route_for_engine, normalize_approval_response_for_engine,
        trim_action_output_delta_content, validate_engine_sandbox_mode, ApprovalRequestRoute,
        EngineEvent, OutputStream, SandboxPolicy, SteerMarker, SteerReceipt, ThreadScope,
        TurnAttachment, TurnCompletionSource, TurnCompletionStatus, TurnInput, TurnInputItem,
        STREAMED_DIFF_MAX_CHARS,
    },
    models::{
        ActionOutputDto, EngineInfoDto, EngineModelDto, MessageDto, MessageStatusDto,
        MessageWindowCursorDto, MessageWindowDto, RepoDto, SearchResultDto, ThreadDto,
        ThreadStatusDto, TrustLevelDto,
    },
    runtime_env,
    state::AppState,
};

use super::codex_transcript::CodexTranscriptRecorder;

const MAX_THREAD_TITLE_CHARS: usize = 72;
const STREAM_EVENT_COALESCE_MAX_CHARS: usize = 8_192;
const STREAM_EVENT_COALESCE_IDLE_FLUSH_INTERVAL: Duration = Duration::from_millis(24);
const STREAM_DB_FLUSH_INTERVAL: Duration = Duration::from_millis(250);
const STREAM_DB_BLOCKS_FLUSH_INTERVAL: Duration = Duration::from_millis(900);
const ENGINE_EVENT_QUEUE_CAPACITY: usize = 128;
const ACTION_OUTPUT_MAX_CHUNKS: usize = 240;
const ENGINE_EVENT_LOG_ACTION_OUTPUT_MAX_CHARS: usize = 4_096;
const TRUNCATED_SUFFIX: &str = "\n... [truncated]";
const MAX_ATTACHMENTS_PER_TURN: usize = 10;
const MAX_PASTED_IMAGE_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_EMBEDDED_CHAT_IMAGE_CACHE_FILES: usize = 5_000;
const MAX_EMBEDDED_CHAT_IMAGE_CACHE_BYTES: u64 = 10_000_000_000;
const TEXT_ATTACHMENT_EXTENSIONS: &[&str] = &[
    "txt", "md", "json", "js", "ts", "tsx", "jsx", "py", "rs", "go", "css", "html", "yaml", "yml",
    "toml", "xml", "sql", "sh", "csv",
];
const IMAGE_ATTACHMENT_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg",
];
const MESSAGE_WINDOW_DEFAULT_LIMIT: usize = 120;
const MESSAGE_WINDOW_MAX_LIMIT: usize = 400;
const MAX_CHAT_NOTIFICATION_PREVIEW_CHARS: usize = 240;
const CONTEXT_USAGE_CACHE_METADATA_KEY: &str = "contextUsageCache";

fn value_to_raw(value: &Value) -> Box<RawValue> {
    serde_json::value::to_raw_value(value).unwrap_or_else(|_| empty_raw_value())
}

fn empty_raw_value() -> Box<RawValue> {
    RawValue::from_string("null".to_string()).expect("\"null\" is a valid JSON literal")
}

fn usage_snapshot_has_context_metrics(usage: &crate::engines::UsageLimitsSnapshot) -> bool {
    usage.current_tokens.is_some()
        || usage.max_context_tokens.is_some()
        || usage.context_window_percent.is_some()
        || usage.input_tokens.is_some()
        || usage.cached_input_tokens.is_some()
        || usage.cache_write_input_tokens.is_some()
        || usage.output_tokens.is_some()
        || usage.reasoning_output_tokens.is_some()
}

fn merge_context_usage_cache_into_metadata(
    mut metadata: Option<Value>,
    usage: &crate::engines::UsageLimitsSnapshot,
) -> Value {
    let mut metadata = metadata.take().unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        object.insert(
            CONTEXT_USAGE_CACHE_METADATA_KEY.to_string(),
            json!({
                "currentTokens": usage.current_tokens,
                "maxContextTokens": usage.max_context_tokens,
                "contextWindowPercent": usage.context_window_percent,
                "inputTokens": usage.input_tokens,
                "cachedInputTokens": usage.cached_input_tokens,
                "cacheWriteInputTokens": usage.cache_write_input_tokens,
                "outputTokens": usage.output_tokens,
                "reasoningOutputTokens": usage.reasoning_output_tokens,
            }),
        );
    }

    metadata
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum ContentBlock {
    #[serde(rename = "text")]
    Text {
        content: String,
        #[serde(rename = "planMode", skip_serializing_if = "Option::is_none")]
        plan_mode: Option<bool>,
        #[serde(rename = "isSteer", skip_serializing_if = "Option::is_none")]
        is_steer: Option<bool>,
    },

    #[serde(rename = "diff")]
    Diff { diff: String, scope: String },

    #[serde(rename = "action")]
    Action {
        #[serde(rename = "actionId")]
        action_id: String,
        #[serde(rename = "engineActionId", skip_serializing_if = "Option::is_none")]
        engine_action_id: Option<String>,
        #[serde(rename = "actionType")]
        action_type: String,
        summary: String,
        details: Box<RawValue>,
        #[serde(rename = "outputChunks")]
        output_chunks: Vec<ActionOutputChunk>,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<ActionBlockResult>,
    },

    #[serde(rename = "approval")]
    Approval {
        #[serde(rename = "approvalId")]
        approval_id: String,
        #[serde(rename = "actionType")]
        action_type: String,
        summary: String,
        details: Box<RawValue>,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        decision: Option<String>,
    },

    #[serde(rename = "thinking")]
    Thinking {
        content: String,
        #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
        started_at: Option<f64>,
        #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
        duration_ms: Option<f64>,
    },

    #[serde(rename = "notice")]
    Notice {
        kind: String,
        level: String,
        title: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Vec<String>>,
    },

    #[serde(rename = "error")]
    Error { message: String },

    #[serde(rename = "attachment")]
    Attachment {
        #[serde(rename = "fileName")]
        file_name: String,
        #[serde(rename = "filePath")]
        file_path: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },

    #[serde(rename = "skill")]
    Skill { name: String, path: String },

    #[serde(rename = "mention")]
    Mention { name: String, path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActionOutputChunk {
    stream: String,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionBlockResult {
    success: bool,
    output: Option<String>,
    error: Option<String>,
    diff: Option<String>,
    duration_ms: u64,
}

#[derive(Default)]
struct EventProgress {
    message_status: Option<MessageStatusDto>,
    thread_status: Option<ThreadStatusDto>,
    token_usage: Option<(u64, u64)>,
    turn_model_id: Option<String>,
    blocks_changed: bool,
    force_persist: bool,
}

fn unresolved_action_terminal_error(
    status: &TurnCompletionStatus,
    source: Option<&TurnCompletionSource>,
) -> &'static str {
    if matches!(source, Some(TurnCompletionSource::ReconciledStreamLost)) {
        return "Panes lost the live Codex stream before this action reported completion.";
    }
    if matches!(source, Some(TurnCompletionSource::ReconciledTimeout)) {
        return "Panes recovered the turn completion before this action reported completion.";
    }

    match status {
        TurnCompletionStatus::Completed => {
            "The turn completed before this action reported completion."
        }
        TurnCompletionStatus::Interrupted => {
            "The turn was interrupted before this action reported completion."
        }
        TurnCompletionStatus::Failed => "The turn failed before this action reported completion.",
    }
}

fn terminalize_unresolved_action_blocks(
    blocks: &mut [ContentBlock],
    status: &TurnCompletionStatus,
    source: Option<&TurnCompletionSource>,
) -> bool {
    let error = unresolved_action_terminal_error(status, source);
    let mut changed = false;

    for block in blocks {
        if let ContentBlock::Action {
            status: block_status,
            result,
            ..
        } = block
        {
            if block_status == "running" || block_status == "pending" {
                *block_status = "error".to_string();
                if result.is_none() {
                    *result = Some(ActionBlockResult {
                        success: false,
                        output: None,
                        error: Some(error.to_string()),
                        diff: None,
                        duration_ms: 0,
                    });
                }
                changed = true;
            }
        }
    }

    changed
}

fn terminalize_pending_approval_blocks(blocks: &mut [ContentBlock]) -> bool {
    let mut changed = false;

    for block in blocks {
        if let ContentBlock::Approval {
            status, decision, ..
        } = block
        {
            if status == "pending" {
                *status = "answered".to_string();
                if decision.is_none() {
                    *decision = Some("cancel".to_string());
                }
                changed = true;
            }
        }
    }

    changed
}

fn terminalize_unresolved_turn_blocks(
    blocks: &mut [ContentBlock],
    status: &TurnCompletionStatus,
    source: Option<&TurnCompletionSource>,
) -> bool {
    let action_changed = terminalize_unresolved_action_blocks(blocks, status, source);
    let approval_changed = terminalize_pending_approval_blocks(blocks);
    action_changed || approval_changed
}

fn terminalize_unresolved_turn_blocks_json(
    blocks: &mut Value,
    status: &TurnCompletionStatus,
    source: Option<&TurnCompletionSource>,
) -> bool {
    let Some(items) = blocks.as_array_mut() else {
        return false;
    };

    let error = unresolved_action_terminal_error(status, source);
    let mut changed = false;

    for item in items {
        let Some(object) = item.as_object_mut() else {
            continue;
        };

        match object.get("type").and_then(Value::as_str) {
            Some("action") => {
                let is_unresolved = object
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| status == "running" || status == "pending");
                if is_unresolved {
                    object.insert("status".to_string(), json!("error"));
                    if !object.contains_key("result")
                        || object.get("result").is_some_and(Value::is_null)
                    {
                        object.insert(
                            "result".to_string(),
                            json!({
                                "success": false,
                                "output": null,
                                "error": error,
                                "diff": null,
                                "durationMs": 0
                            }),
                        );
                    }
                    changed = true;
                }
            }
            Some("approval") => {
                let is_pending = object.get("status").and_then(Value::as_str) == Some("pending");
                if is_pending {
                    object.insert("status".to_string(), json!("answered"));
                    if !object.contains_key("decision")
                        || object.get("decision").is_some_and(Value::is_null)
                    {
                        object.insert("decision".to_string(), json!("cancel"));
                    }
                    changed = true;
                }
            }
            _ => {}
        }
    }

    changed
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadUpdatedEvent {
    thread_id: String,
    workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread: Option<ThreadDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatTurnFinishedEvent {
    thread_id: String,
    workspace_id: String,
    repo_id: Option<String>,
    engine_id: String,
    thread_title: String,
    assistant_message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_turn_id: Option<String>,
    thread_status: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachmentPayload {
    pub file_name: String,
    pub file_path: String,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAttachmentImageAssetPayload {
    pub file_path: String,
    pub mime_type: String,
    pub version: String,
}

#[tauri::command]
pub async fn cache_embedded_chat_image(
    mime_type: String,
    data_base64: String,
) -> Result<PreparedAttachmentImageAssetPayload, String> {
    let normalized_mime = match mime_type.trim().to_lowercase().as_str() {
        "image/jpg" => "image/jpeg".to_string(),
        value => value.to_string(),
    };
    let extension = pasted_image_extension("embedded-image", &normalized_mime)
        .ok_or_else(|| "Embedded chat image type is not supported.".to_string())?;
    let encoded = data_base64
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_base64.as_str())
        .trim();
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Embedded chat image data is not valid base64.".to_string())?;
    if bytes.is_empty() {
        return Err("Embedded chat image is empty.".to_string());
    }
    if bytes.len() > MAX_PASTED_IMAGE_ATTACHMENT_BYTES {
        return Err("Embedded chat image exceeds the 10 MB preview limit.".to_string());
    }
    if !attachment_image_signature_matches(&bytes, &normalized_mime) {
        return Err("Embedded chat image data does not match its image type.".to_string());
    }

    let mut hasher = DefaultHasher::new();
    normalized_mime.hash(&mut hasher);
    bytes.hash(&mut hasher);
    let content_hash = hasher.finish();
    let cache_dir = runtime_env::app_data_dir()
        .join("cache")
        .join("chat-images");
    tokio_fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("failed to create embedded image cache: {error}"))?;
    let file_path = cache_dir.join(format!("{content_hash:016x}.{extension}"));

    if !file_path.is_file() {
        let temporary_path = cache_dir.join(format!(
            ".{content_hash:016x}-{}.tmp.{extension}",
            Uuid::new_v4().simple()
        ));
        tokio_fs::write(&temporary_path, &bytes)
            .await
            .map_err(|error| format!("failed to cache embedded chat image: {error}"))?;
        match tokio_fs::rename(&temporary_path, &file_path).await {
            Ok(()) => {}
            Err(_) if file_path.is_file() => {
                let _ = tokio_fs::remove_file(&temporary_path).await;
            }
            Err(error) => {
                let _ = tokio_fs::remove_file(&temporary_path).await;
                return Err(format!("failed to finalize embedded image cache: {error}"));
            }
        }
    }

    let metadata = tokio_fs::metadata(&file_path)
        .await
        .map_err(|error| format!("failed to read cached embedded image: {error}"))?;
    let cache_dir_for_prune = cache_dir.clone();
    let file_path_for_prune = file_path.clone();
    drop(tokio::task::spawn_blocking(move || {
        if let Err(error) =
            prune_embedded_chat_image_cache(&cache_dir_for_prune, &file_path_for_prune)
        {
            log::warn!("failed to prune embedded chat image cache: {error}");
        }
    }));

    Ok(PreparedAttachmentImageAssetPayload {
        file_path: file_path.to_string_lossy().into_owned(),
        mime_type: normalized_mime,
        version: attachment_asset_version(&metadata),
    })
}

#[tauri::command]
pub async fn save_pasted_image_attachment(
    file_name: String,
    mime_type: String,
    data_base64: String,
) -> Result<ChatAttachmentPayload, String> {
    let normalized_mime = mime_type.trim().to_lowercase();
    if !normalized_mime.starts_with("image/") {
        return Err("Pasted attachment is not an image.".to_string());
    }

    let encoded = data_base64
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_base64.as_str())
        .trim();
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Pasted image data is not valid base64.".to_string())?;
    if bytes.is_empty() {
        return Err("Pasted image data is empty.".to_string());
    }
    if bytes.len() > MAX_PASTED_IMAGE_ATTACHMENT_BYTES {
        return Err("Pasted image exceeds the 10 MB attachment limit.".to_string());
    }

    let extension = pasted_image_extension(&file_name, &normalized_mime)
        .ok_or_else(|| "Pasted image type is not supported.".to_string())?;
    let stored_file_name = format!("pasted-image-{}.{}", Uuid::new_v4().simple(), extension);
    let attachment_dir = runtime_env::app_data_dir()
        .join("attachments")
        .join("pasted-images");
    tokio_fs::create_dir_all(&attachment_dir)
        .await
        .map_err(|error| format!("failed to create pasted image attachment directory: {error}"))?;
    let file_path = attachment_dir.join(&stored_file_name);
    tokio_fs::write(&file_path, &bytes)
        .await
        .map_err(|error| format!("failed to save pasted image attachment: {error}"))?;

    Ok(ChatAttachmentPayload {
        file_name: stored_file_name,
        file_path: file_path.display().to_string(),
        size_bytes: bytes.len() as u64,
        mime_type: Some(normalized_mime),
    })
}

#[tauri::command]
pub async fn prepare_attachment_image_asset(
    app: tauri::AppHandle,
    file_path: String,
    mime_type: Option<String>,
    max_width: Option<u32>,
    max_height: Option<u32>,
) -> Result<PreparedAttachmentImageAssetPayload, String> {
    let (source_path, source_mime_type, metadata) =
        validate_attachment_image_file(&file_path, mime_type.as_deref()).await?;
    let source_version = attachment_asset_version(&metadata);
    let thumbnail_bounds = match (max_width, max_height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => {
            Some((width.min(2_048), height.min(2_048)))
        }
        _ => None,
    };

    let (asset_path, asset_mime_type, version) = if let Some((max_width, max_height)) =
        thumbnail_bounds
    {
        let cache_dir = runtime_env::app_data_dir()
            .join("cache")
            .join("image-thumbnails");
        tokio_fs::create_dir_all(&cache_dir)
            .await
            .map_err(|error| format!("failed to create image thumbnail cache: {error}"))?;

        let source_path_for_thumbnail = source_path.clone();
        let source_mime_for_thumbnail = source_mime_type.clone();
        let source_version_for_thumbnail = source_version.clone();
        let thumbnail = tokio::task::spawn_blocking(move || {
            prepare_cached_attachment_thumbnail(
                &source_path_for_thumbnail,
                &source_mime_for_thumbnail,
                &source_version_for_thumbnail,
                &cache_dir,
                max_width,
                max_height,
            )
        })
        .await
        .map_err(|error| format!("failed to join image thumbnail task: {error}"))?;

        match thumbnail {
            Ok(Some(thumbnail_path)) => {
                let thumbnail_metadata = std::fs::metadata(&thumbnail_path)
                    .map_err(|error| format!("failed to read cached image thumbnail: {error}"))?;
                (
                    thumbnail_path,
                    "image/png".to_string(),
                    attachment_asset_version(&thumbnail_metadata),
                )
            }
            Ok(None) => (source_path, source_mime_type, source_version),
            Err(error) => {
                log::warn!(
                    "failed to prepare thumbnail for `{}`; using original image: {error}",
                    source_path.display()
                );
                (source_path, source_mime_type, source_version)
            }
        }
    } else {
        (source_path, source_mime_type, source_version)
    };

    app.asset_protocol_scope()
        .allow_file(&asset_path)
        .map_err(|error| format!("failed to authorize attachment image asset: {error}"))?;

    Ok(PreparedAttachmentImageAssetPayload {
        file_path: asset_path.to_string_lossy().into_owned(),
        mime_type: asset_mime_type,
        version,
    })
}

#[tauri::command]
pub async fn read_attachment_image_bytes(
    file_path: String,
    mime_type: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let (file_path, _, _) =
        validate_attachment_image_file(&file_path, mime_type.as_deref()).await?;
    let bytes = tokio_fs::read(&file_path)
        .await
        .map_err(|error| format!("failed to read attachment image: {error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn copy_attachment_image_to_clipboard(
    file_path: String,
    mime_type: Option<String>,
) -> Result<(), String> {
    let normalized_file_path = file_path.trim().to_string();
    if normalized_file_path.is_empty() {
        return Err("Attachment path is empty.".to_string());
    }

    let Some(normalized_mime_type) =
        normalize_image_preview_mime_type(&normalized_file_path, mime_type.as_deref())
    else {
        return Err("Attachment is not an image.".to_string());
    };

    if !supports_native_clipboard_image_copy(&normalized_mime_type) {
        return Err("Attachment image type does not support native clipboard copy.".to_string());
    }

    tokio::task::spawn_blocking(move || {
        copy_attachment_image_to_clipboard_blocking(&normalized_file_path)
    })
    .await
    .map_err(|error| format!("failed to join clipboard image copy task: {error}"))??;

    Ok(())
}

fn pasted_image_extension(_file_name: &str, mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

fn normalize_image_preview_mime_type(file_path: &str, mime_type: Option<&str>) -> Option<String> {
    if let Some(mime_type) = mime_type.map(str::trim).filter(|value| !value.is_empty()) {
        let normalized = mime_type.to_lowercase();
        if normalized.starts_with("image/") {
            return Some(match normalized.as_str() {
                "image/jpg" => "image/jpeg".to_string(),
                _ => normalized,
            });
        }
    }

    let extension = Path::new(file_path)
        .extension()
        .and_then(|value| value.to_str())?
        .to_lowercase();
    image_mime_type_for_extension(&extension).map(ToOwned::to_owned)
}

async fn validate_attachment_image_file(
    file_path: &str,
    mime_type: Option<&str>,
) -> Result<(PathBuf, String, std::fs::Metadata), String> {
    let normalized_file_path = file_path.trim();
    if normalized_file_path.is_empty() {
        return Err("Attachment path is empty.".to_string());
    }

    let canonical_path = tokio_fs::canonicalize(normalized_file_path)
        .await
        .map(normalize_canonical_asset_path)
        .map_err(|error| format!("failed to resolve attachment image path: {error}"))?;
    let resolved_mime_type = attachment_image_mime_type(&canonical_path, mime_type)
        .ok_or_else(|| "Attachment is not a supported image.".to_string())?;
    let metadata = tokio_fs::metadata(&canonical_path)
        .await
        .map_err(|error| format!("failed to read attachment image metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("Attachment image path does not point to a file.".to_string());
    }
    if metadata.len() == 0 {
        return Err("Attachment image is empty.".to_string());
    }
    if metadata.len() > MAX_PASTED_IMAGE_ATTACHMENT_BYTES as u64 {
        return Err("Attachment image exceeds the 10 MB preview limit.".to_string());
    }
    validate_attachment_image_signature(&canonical_path, &resolved_mime_type).await?;

    Ok((canonical_path, resolved_mime_type, metadata))
}

fn attachment_image_mime_type(
    file_path: &Path,
    fallback_mime_type: Option<&str>,
) -> Option<String> {
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    let extension_mime_type = extension.as_deref().and_then(image_mime_type_for_extension);
    extension_mime_type.map(ToOwned::to_owned).or_else(|| {
        let normalized = fallback_mime_type?.trim().to_lowercase();
        matches!(
            normalized.as_str(),
            "image/png"
                | "image/jpeg"
                | "image/jpg"
                | "image/gif"
                | "image/webp"
                | "image/bmp"
                | "image/tiff"
                | "image/svg+xml"
        )
        .then(|| {
            if normalized == "image/jpg" {
                "image/jpeg".to_string()
            } else {
                normalized
            }
        })
    })
}

async fn validate_attachment_image_signature(
    file_path: &Path,
    mime_type: &str,
) -> Result<(), String> {
    let mut file = tokio_fs::File::open(file_path)
        .await
        .map_err(|error| format!("failed to inspect attachment image: {error}"))?;
    let mut header = vec![0_u8; 8_192];
    let read = file
        .read(&mut header)
        .await
        .map_err(|error| format!("failed to inspect attachment image: {error}"))?;
    header.truncate(read);

    if attachment_image_signature_matches(&header, mime_type) {
        Ok(())
    } else {
        Err("Attachment file contents do not match a supported image format.".to_string())
    }
}

fn attachment_image_signature_matches(header: &[u8], mime_type: &str) -> bool {
    match mime_type {
        "image/png" => header.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => header.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a"),
        "image/webp" => {
            header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WEBP"
        }
        "image/bmp" => header.starts_with(b"BM"),
        "image/tiff" => {
            header.starts_with(b"II*\0")
                || header.starts_with(b"MM\0*")
                || header.starts_with(b"II+\0")
                || header.starts_with(b"MM\0+")
        }
        "image/svg+xml" => String::from_utf8_lossy(header)
            .to_ascii_lowercase()
            .contains("<svg"),
        _ => false,
    }
}

fn prune_embedded_chat_image_cache(cache_dir: &Path, keep_path: &Path) -> Result<(), String> {
    let mut files = std::fs::read_dir(cache_dir)
        .map_err(|error| format!("failed to read cache directory: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
                (path, metadata.len(), modified)
            })
        })
        .collect::<Vec<_>>();
    let mut total_bytes = files.iter().map(|(_, size, _)| *size).sum::<u64>();
    if files.len() <= MAX_EMBEDDED_CHAT_IMAGE_CACHE_FILES
        && total_bytes <= MAX_EMBEDDED_CHAT_IMAGE_CACHE_BYTES
    {
        return Ok(());
    }

    files.sort_by_key(|(_, _, modified)| *modified);
    let mut remaining_files = files.len();
    for (path, size, _) in files {
        if remaining_files <= MAX_EMBEDDED_CHAT_IMAGE_CACHE_FILES
            && total_bytes <= MAX_EMBEDDED_CHAT_IMAGE_CACHE_BYTES
        {
            break;
        }
        if path == keep_path {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            remaining_files = remaining_files.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(size);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn normalize_canonical_asset_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(unc_path) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc_path}"));
    }
    if let Some(drive_path) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(drive_path);
    }
    path
}

#[cfg(not(target_os = "windows"))]
fn normalize_canonical_asset_path(path: PathBuf) -> PathBuf {
    path
}

fn attachment_asset_version(metadata: &std::fs::Metadata) -> String {
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{:x}-{modified_nanos:x}", metadata.len())
}

fn prepare_cached_attachment_thumbnail(
    source_path: &Path,
    source_mime_type: &str,
    source_version: &str,
    cache_dir: &Path,
    max_width: u32,
    max_height: u32,
) -> Result<Option<PathBuf>, String> {
    if source_mime_type == "image/svg+xml" {
        return Ok(None);
    }

    let mut hasher = DefaultHasher::new();
    source_path.hash(&mut hasher);
    source_version.hash(&mut hasher);
    max_width.hash(&mut hasher);
    max_height.hash(&mut hasher);
    let cache_path = cache_dir.join(format!("{:016x}.png", hasher.finish()));
    if cache_path.is_file() {
        return Ok(Some(cache_path));
    }

    let image = image::ImageReader::open(source_path)
        .map_err(|error| format!("failed to open image: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("failed to detect image format: {error}"))?
        .decode()
        .map_err(|error| format!("failed to decode image: {error}"))?;
    if image.width() <= max_width && image.height() <= max_height {
        return Ok(None);
    }

    let thumbnail = image.thumbnail(max_width, max_height);
    let temporary_path = cache_dir.join(format!(
        ".{:016x}-{}.tmp.png",
        hasher.finish(),
        Uuid::new_v4().simple()
    ));
    thumbnail
        .save_with_format(&temporary_path, image::ImageFormat::Png)
        .map_err(|error| format!("failed to encode image thumbnail: {error}"))?;

    match std::fs::rename(&temporary_path, &cache_path) {
        Ok(()) => Ok(Some(cache_path)),
        Err(_) if cache_path.is_file() => {
            let _ = std::fs::remove_file(&temporary_path);
            Ok(Some(cache_path))
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temporary_path);
            Err(format!("failed to cache image thumbnail: {error}"))
        }
    }
}

fn image_mime_type_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "tif" | "tiff" => Some("image/tiff"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

fn supports_native_clipboard_image_copy(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/tiff"
    )
}

fn copy_attachment_image_to_clipboard_blocking(file_path: &str) -> Result<(), String> {
    let metadata = std::fs::metadata(file_path)
        .map_err(|error| format!("failed to read attachment metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("Attachment path does not point to a file.".to_string());
    }

    let image = image::ImageReader::open(file_path)
        .map_err(|error| format!("failed to open attachment image: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("failed to detect attachment image format: {error}"))?
        .decode()
        .map_err(|error| format!("failed to decode attachment image: {error}"))?;
    let rgba = image.into_rgba8();
    let (width, height) = rgba.dimensions();
    let bytes = rgba.into_raw();

    let mut clipboard =
        Clipboard::new().map_err(|error| format!("failed to access clipboard: {error}"))?;
    clipboard
        .set_image(ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(bytes),
        })
        .map_err(|error| format!("failed to write attachment image to clipboard: {error}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatInputItemPayload {
    Text { text: String },
    Skill { name: String, path: String },
    Mention { name: String, path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CodexReviewTargetPayload {
    #[serde(rename = "uncommittedChanges")]
    UncommittedChanges,
    #[serde(rename = "baseBranch")]
    BaseBranch { branch: String },
    #[serde(rename = "commit")]
    Commit {
        sha: String,
        #[serde(default)]
        title: Option<String>,
    },
    #[serde(rename = "custom")]
    Custom { instructions: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexReviewDeliveryPayload {
    Inline,
    Detached,
}

async fn run_db<T, F>(db: crate::db::Database, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&crate::db::Database) -> anyhow::Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || operation(&db))
        .await
        .map_err(|error| error.to_string())?
        .map_err(err_to_string)
}

// Tauri exposes command arguments as individually named IPC fields. Keeping
// this signature flat preserves the existing frontend contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn send_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    message: String,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
    attachments: Option<Vec<ChatAttachmentPayload>>,
    input_items: Option<Vec<ChatInputItemPayload>>,
    plan_mode: Option<bool>,
    client_turn_id: Option<String>,
) -> Result<String, String> {
    let _history_guard = state.pending_rollbacks.lock_history(&thread_id).await;
    let already_running = state.turns.get(&thread_id).await.is_some();
    if already_running {
        return Err(
            "A turn is already running for this thread. Cancel it before sending another message."
                .to_string(),
        );
    }

    let db = state.db.clone();
    let mut thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;
    // Branch threads defer their (slow) engine-level Codex fork until first use. Ensure the
    // engine thread is materialized before the turn starts; the background prefetch has
    // usually already done this, so this is normally instant.
    if crate::commands::threads::is_engine_fork_pending(thread.engine_metadata.as_ref()) {
        thread = crate::commands::threads::resolve_pending_engine_fork(state.inner(), &thread.id)
            .await?;
    }
    if crate::commands::threads::is_engine_rollback_pending(thread.engine_metadata.as_ref()) {
        thread = crate::commands::threads::resolve_pending_engine_rollback(
            state.inner(),
            &thread.id,
            Some(&app),
        )
        .await?;
    }
    let requested_model_id = model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let attachments = normalize_attachments(attachments)?;
    let input_items = normalize_input_items(message.as_str(), input_items)?;
    let plan_mode = plan_mode.unwrap_or(false);
    let turn_input = TurnInput {
        message: message.clone(),
        attachments: attachments.clone(),
        plan_mode,
        input_items: input_items.clone(),
    };
    let current_turn_model_id = thread_last_model_id(thread.engine_metadata.as_ref())
        .unwrap_or_else(|| thread.model_id.clone());
    let model_switch_requested = requested_model_id
        .map(|value| value != current_turn_model_id.as_str())
        .unwrap_or(false);
    let validation_catalog = if model_switch_requested {
        state.engines.list_engines().await.ok()
    } else {
        None
    };
    let effective_model_id =
        resolve_turn_model_id(&thread, requested_model_id, validation_catalog.as_deref())?;
    let attachment_catalog = if attachments.is_empty() {
        None
    } else if let Some(catalog) = validation_catalog.as_ref() {
        Some(catalog.clone())
    } else {
        Some(state.engines.list_engines().await.map_err(err_to_string)?)
    };
    validate_attachments_for_engine_model(
        &attachments,
        &thread.engine_id,
        &effective_model_id,
        attachment_catalog.as_deref(),
    )?;

    let (workspace, repos, selected_repo) = run_db(db.clone(), {
        let workspace_id = thread.workspace_id.clone();
        let thread_id = thread.id.clone();
        let repo_id = thread.repo_id.clone();
        move |db| {
            let workspace = db::workspaces::list_workspaces(db)?
                .into_iter()
                .find(|item| item.id == workspace_id)
                .ok_or_else(|| anyhow::anyhow!("workspace not found for thread {thread_id}"))?;
            let repos = db::repos::get_repos(db, &workspace_id)?;
            let selected_repo = if let Some(repo_id) = repo_id.as_deref() {
                db::repos::find_repo_by_id(db, repo_id)?
            } else {
                None
            };
            Ok((workspace, repos, selected_repo))
        }
    })
    .await?;

    let workspace_root = workspace.root_path.clone();
    let requested_reasoning_effort = normalize_reasoning_effort_value(reasoning_effort.as_deref());
    let stored_reasoning_effort = thread_reasoning_effort(thread.engine_metadata.as_ref());
    let configured_reasoning_effort = requested_reasoning_effort
        .clone()
        .or_else(|| stored_reasoning_effort.clone());
    let reasoning_effort = if requested_reasoning_effort.is_some() {
        requested_reasoning_effort
    } else if model_switch_requested {
        validation_catalog
            .as_deref()
            .map(|engines| {
                resolve_reasoning_effort_from_catalog(
                    engines,
                    thread.engine_id.as_str(),
                    effective_model_id.as_str(),
                    configured_reasoning_effort.as_deref(),
                )
            })
            .unwrap_or_else(|| {
                normalize_reasoning_effort_value(configured_reasoning_effort.as_deref())
            })
    } else {
        configured_reasoning_effort.clone()
    };
    let sandbox_mode_override = thread_sandbox_mode(thread.engine_metadata.as_ref())?;
    let sandbox_mode =
        Some(sandbox_mode_override.clone().unwrap_or_else(|| {
            default_sandbox_mode_for_engine(thread.engine_id.as_str()).to_string()
        }));
    let workspace_writable_roots = if selected_repo.is_some() {
        None
    } else {
        Some(resolve_workspace_writable_roots(
            repos.iter().map(|repo| repo.path.as_str()),
            workspace_root.as_str(),
            thread.engine_metadata.as_ref(),
        )?)
    };
    let scope = if let Some(repo) = selected_repo.as_ref() {
        ThreadScope::Repo {
            repo_path: repo.path.clone(),
        }
    } else {
        ThreadScope::Workspace {
            root_path: workspace_root,
            writable_roots: workspace_writable_roots
                .as_ref()
                .map(|resolution| resolution.roots.clone())
                .unwrap_or_default(),
        }
    };

    let trust_level = selected_repo
        .as_ref()
        .map(|repo| repo.trust_level.clone())
        .unwrap_or_else(|| aggregate_workspace_trust_level(&repos));
    let codex_external_sandbox_active = if thread.engine_id == "codex" {
        state.engines.codex_uses_external_sandbox().await
    } else {
        false
    };
    let permission_profile = if thread.engine_id == "codex" {
        thread_permission_profile(thread.engine_metadata.as_ref())
    } else {
        None
    };

    if permission_profile.is_none() {
        if let Some(sandbox_mode) = sandbox_mode.as_deref() {
            if unsupported_thread_sandbox_override_for_external_sandbox(
                sandbox_mode_override.as_deref(),
                codex_external_sandbox_active,
            ) {
                return Err(
                "Codex read-only and workspace-write sandbox overrides are unavailable while Panes is using external sandbox mode. Clear the override or restore local Codex sandboxing first.".to_string(),
            );
            }

            validate_engine_sandbox_mode(thread.engine_id.as_str(), Some(sandbox_mode))?;

            if workspace_write_confirmation_required(
                workspace_writable_roots.as_ref(),
                sandbox_mode,
                workspace_write_opt_in_enabled(thread.engine_metadata.as_ref()),
            ) {
                return Err(
                "Workspace thread with multiple writable repositories requires explicit confirmation before execution.".to_string(),
            );
            }
        }
    }

    if requested_model_id.is_some() || reasoning_effort != stored_reasoning_effort {
        let mut metadata = thread
            .engine_metadata
            .clone()
            .unwrap_or_else(|| serde_json::json!({}));
        if !metadata.is_object() {
            metadata = serde_json::json!({});
        }
        if let Some(object) = metadata.as_object_mut() {
            if requested_model_id.is_some() {
                object.insert(
                    "lastModelId".to_string(),
                    Value::String(effective_model_id.clone()),
                );
            }
            match reasoning_effort.as_ref() {
                Some(value) => {
                    object.insert("reasoningEffort".to_string(), Value::String(value.clone()));
                }
                None => {
                    object.remove("reasoningEffort");
                }
            }
        }
        run_db(db.clone(), {
            let thread_id = thread.id.clone();
            let metadata = metadata.clone();
            move |db| db::threads::update_engine_metadata(db, &thread_id, &metadata)
        })
        .await?;
        thread.engine_metadata = Some(metadata);
    }

    let writable_roots = match &scope {
        ThreadScope::Repo { repo_path } => vec![repo_path.clone()],
        ThreadScope::Workspace {
            writable_roots,
            root_path,
        } => {
            if writable_roots.is_empty() {
                vec![root_path.clone()]
            } else {
                writable_roots.clone()
            }
        }
    };

    let allow_network =
        if thread.engine_id == "codex" && sandbox_mode.as_deref() == Some("danger-full-access") {
            true
        } else {
            thread_allow_network_override(thread.engine_metadata.as_ref())
                .unwrap_or_else(|| allow_network_for_trust_level(&trust_level))
        };
    let personality = if thread.engine_id == "codex"
        && model_supports_personality(state.inner(), &thread.engine_id, &effective_model_id).await
    {
        thread_personality(thread.engine_metadata.as_ref())
    } else {
        None
    };

    let approval_policy_override = thread_approval_policy_override_value(
        thread.engine_id.as_str(),
        thread.engine_metadata.as_ref(),
    )?;

    let sandbox = SandboxPolicy {
        writable_roots,
        allow_network,
        approval_policy: Some(approval_policy_override.unwrap_or_else(|| {
            Value::String(
                approval_policy_for_engine_and_trust_level(thread.engine_id.as_str(), &trust_level)
                    .to_string(),
            )
        })),
        permission_profile,
        approvals_reviewer: if thread.engine_id == "codex" {
            thread_approvals_reviewer(thread.engine_metadata.as_ref())
        } else {
            None
        },
        reasoning_effort: reasoning_effort.clone(),
        sandbox_mode,
        service_tier: thread_service_tier(thread.engine_metadata.as_ref()),
        personality,
        output_schema: thread_output_schema(thread.engine_metadata.as_ref()),
    };

    let initialized_thread = state
        .engines
        .ensure_engine_thread(&thread, Some(effective_model_id.as_str()), scope, sandbox)
        .await
        .map_err(err_to_string)?;
    let engine_thread_id = initialized_thread.engine_thread_id;
    if let Some(mode) = initialized_thread.history_mode {
        let mut metadata = thread.engine_metadata.clone().unwrap_or_else(|| json!({}));
        metadata["codexHistoryMode"] = json!(mode);
        run_db(db.clone(), {
            let id = thread.id.clone();
            let metadata = metadata.clone();
            move |db| db::threads::update_engine_metadata(db, &id, &metadata)
        })
        .await?;
        thread.engine_metadata = Some(metadata);
    }

    if thread.engine_thread_id.as_deref() != Some(&engine_thread_id) {
        run_db(db.clone(), {
            let thread_id = thread.id.clone();
            let engine_thread_id = engine_thread_id.clone();
            move |db| db::threads::set_engine_thread_id(db, &thread_id, &engine_thread_id)
        })
        .await?;
        thread.engine_thread_id = Some(engine_thread_id.clone());
    }

    let cancellation = CancellationToken::new();
    if !state
        .turns
        .try_register(&thread.id, cancellation.clone())
        .await
    {
        return Err(
            "A turn is already running for this thread. Cancel it before sending another message."
                .to_string(),
        );
    }

    let (assistant_message, streaming_thread) = match run_db(db.clone(), {
        let thread_id = thread.id.clone();
        let message = message.clone();
        let attachments = attachments.clone();
        let input_items = input_items.clone();
        let plan_mode_enabled = plan_mode;
        let engine_id = thread.engine_id.clone();
        let model_id = effective_model_id.clone();
        let reasoning_effort = reasoning_effort.clone();
        move |db| {
            let user_blocks = build_user_blocks(
                &message,
                &input_items,
                &attachments,
                plan_mode_enabled,
                false,
            );
            db::messages::insert_user_message(
                db,
                &thread_id,
                &message,
                Some(serde_json::to_value(&user_blocks)?),
                Some(engine_id.as_str()),
                Some(model_id.as_str()),
                reasoning_effort.as_deref(),
            )?;
            let assistant_message = db::messages::insert_assistant_placeholder(
                db,
                &thread_id,
                Some(engine_id.as_str()),
                Some(model_id.as_str()),
                reasoning_effort.as_deref(),
            )?;
            db::threads::update_thread_status(db, &thread_id, ThreadStatusDto::Streaming)?;
            let streaming_thread = db::threads::get_thread(db, &thread_id)?
                .ok_or_else(|| anyhow::anyhow!("thread not found after turn start: {thread_id}"))?;
            Ok((assistant_message, streaming_thread))
        }
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            state.turns.finish(&thread.id).await;
            return Err(error);
        }
    };

    let _ = app.emit(
        "thread-updated",
        ThreadUpdatedEvent {
            thread_id: streaming_thread.id.clone(),
            workspace_id: streaming_thread.workspace_id.clone(),
            thread: Some(streaming_thread),
        },
    );

    let state_cloned = state.inner().clone();
    let app_handle = app.clone();
    let assistant_message_id = assistant_message.id.clone();
    let turn_input_for_task = turn_input.clone();
    let thread_for_task = thread.clone();
    let initial_turn_model_id = effective_model_id.clone();

    tokio::spawn(async move {
        run_turn(
            app_handle,
            state_cloned,
            thread_for_task,
            engine_thread_id,
            assistant_message_id,
            initial_turn_model_id,
            turn_input_for_task,
            client_turn_id,
            cancellation,
        )
        .await;
    });

    crate::commands::threads::backfill_codex_history_mode(app, state.inner().clone(), thread_id);
    Ok(assistant_message.id)
}

#[tauri::command]
pub async fn start_codex_review(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    target: CodexReviewTargetPayload,
    delivery: Option<CodexReviewDeliveryPayload>,
) -> Result<ThreadDto, String> {
    let _history_guard = state.pending_rollbacks.lock_history(&thread_id).await;
    if state.turns.get(&thread_id).await.is_some() {
        return Err(
            "A turn is already running for this thread. Cancel it before starting a review."
                .to_string(),
        );
    }

    let db = state.db.clone();
    let mut source_thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;

    if source_thread.engine_id != "codex" {
        return Err("Native review is only available for Codex threads.".to_string());
    }

    if crate::commands::threads::is_engine_fork_pending(source_thread.engine_metadata.as_ref()) {
        source_thread =
            crate::commands::threads::resolve_pending_engine_fork(state.inner(), &source_thread.id)
                .await?;
    }
    if crate::commands::threads::is_engine_rollback_pending(source_thread.engine_metadata.as_ref())
    {
        source_thread = crate::commands::threads::resolve_pending_engine_rollback(
            state.inner(),
            &source_thread.id,
            Some(&app),
        )
        .await?;
    }

    let source_engine_thread_id = source_thread
        .engine_thread_id
        .clone()
        .ok_or_else(|| "Codex review requires an initialized server-backed thread.".to_string())?;
    let effective_delivery = delivery.unwrap_or(CodexReviewDeliveryPayload::Inline);
    let (target_payload, review_message, review_title) = normalize_codex_review_target(&target)?;
    let initial_turn_model_id = thread_last_model_id(source_thread.engine_metadata.as_ref())
        .unwrap_or_else(|| source_thread.model_id.clone());
    let reasoning_effort = thread_reasoning_effort(source_thread.engine_metadata.as_ref());

    let cancellation = CancellationToken::new();
    if !state
        .turns
        .try_register(&source_thread.id, cancellation.clone())
        .await
    {
        return Err(
            "A turn is already running for this thread. Cancel it before starting a review."
                .to_string(),
        );
    }

    let (review_thread, assistant_message_id) = match run_db(db.clone(), {
        let source_thread = source_thread.clone();
        let review_message = review_message.clone();
        let review_title = review_title.clone();
        let initial_turn_model_id = initial_turn_model_id.clone();
        let reasoning_effort = reasoning_effort.clone();
        let detached = matches!(effective_delivery, CodexReviewDeliveryPayload::Detached);
        move |db| {
            let review_thread = if detached {
                let created = db::threads::create_thread(
                    db,
                    &source_thread.workspace_id,
                    source_thread.repo_id.as_deref(),
                    &source_thread.engine_id,
                    &initial_turn_model_id,
                    &review_title,
                )?;
                if let Some(metadata) = clone_codex_review_metadata(
                    source_thread.engine_metadata.as_ref(),
                    &initial_turn_model_id,
                ) {
                    db::threads::update_engine_metadata(db, &created.id, &metadata)?;
                }
                created
            } else {
                source_thread.clone()
            };

            let user_blocks = build_user_blocks(&review_message, &[], &[], false, false);
            db::messages::insert_user_message(
                db,
                &review_thread.id,
                &review_message,
                Some(serde_json::to_value(&user_blocks)?),
                Some(source_thread.engine_id.as_str()),
                Some(initial_turn_model_id.as_str()),
                reasoning_effort.as_deref(),
            )?;
            let assistant_message = db::messages::insert_assistant_placeholder(
                db,
                &review_thread.id,
                Some(source_thread.engine_id.as_str()),
                Some(initial_turn_model_id.as_str()),
                reasoning_effort.as_deref(),
            )?;
            db::threads::update_thread_status(db, &review_thread.id, ThreadStatusDto::Streaming)?;
            let updated_thread = db::threads::get_thread(db, &review_thread.id)?
                .ok_or_else(|| anyhow::anyhow!("review thread not found after setup"))?;
            Ok((updated_thread, assistant_message.id))
        }
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            state.turns.finish(&source_thread.id).await;
            return Err(error);
        }
    };

    if matches!(effective_delivery, CodexReviewDeliveryPayload::Detached)
        && !state
            .turns
            .try_register(&review_thread.id, cancellation.clone())
            .await
    {
        log::warn!(
            "failed to register cancellation token for detached review thread {}",
            review_thread.id
        );
    }

    let state_cloned = state.inner().clone();
    let app_handle = app.clone();
    let review_thread_for_task = review_thread.clone();
    let review_target_for_task = target_payload.clone();
    let source_engine_thread_id_for_task = source_engine_thread_id.clone();
    let assistant_message_id_for_task = assistant_message_id.clone();
    let delivery_label = match effective_delivery {
        CodexReviewDeliveryPayload::Inline => "inline".to_string(),
        CodexReviewDeliveryPayload::Detached => "detached".to_string(),
    };

    tokio::spawn(async move {
        run_codex_review_turn(
            app_handle,
            state_cloned,
            source_thread,
            review_thread_for_task,
            source_engine_thread_id_for_task,
            assistant_message_id_for_task,
            initial_turn_model_id,
            review_target_for_task,
            delivery_label,
            cancellation,
        )
        .await;
    });

    Ok(review_thread)
}

#[tauri::command]
pub async fn steer_message(
    state: State<'_, AppState>,
    thread_id: String,
    message: String,
    attachments: Option<Vec<ChatAttachmentPayload>>,
    input_items: Option<Vec<ChatInputItemPayload>>,
    plan_mode: Option<bool>,
    steer_id: Option<String>,
) -> Result<SteerReceipt, String> {
    if state.turns.get(&thread_id).await.is_none() {
        return Err(
            "No active turn is running for this thread yet. Wait for Codex to start the turn before steering."
                .to_string(),
        );
    }

    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;

    if thread.engine_id != "codex" {
        return Err("Mid-turn steering is only available for Codex threads.".to_string());
    }

    let engine_thread_id = thread
        .engine_thread_id
        .clone()
        .ok_or_else(|| format!("thread `{thread_id}` has no active engine thread id"))?;
    let attachments = normalize_attachments(attachments)?;
    let input_items = normalize_input_items(message.as_str(), input_items)?;
    let plan_mode = plan_mode.unwrap_or(false);
    let steer_id = steer_id
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if steer_id.len() > 128 {
        return Err("Steer id cannot exceed 128 characters.".to_string());
    }
    let turn_input = TurnInput {
        message: message.clone(),
        attachments: attachments.clone(),
        plan_mode,
        input_items: input_items.clone(),
    };
    let effective_model_id = thread_last_model_id(thread.engine_metadata.as_ref())
        .unwrap_or_else(|| thread.model_id.clone());
    let reasoning_effort = thread_reasoning_effort(thread.engine_metadata.as_ref());
    let user_blocks = build_user_blocks(&message, &input_items, &attachments, plan_mode, true);

    let user_message = run_db(db.clone(), {
        let thread_id = thread.id.clone();
        let message = message.clone();
        let user_blocks = user_blocks.clone();
        let engine_id = thread.engine_id.clone();
        let model_id = effective_model_id.clone();
        let reasoning_effort = reasoning_effort.clone();
        move |db| {
            db::messages::insert_user_message(
                db,
                &thread_id,
                &message,
                Some(serde_json::to_value(&user_blocks)?),
                Some(engine_id.as_str()),
                Some(model_id.as_str()),
                reasoning_effort.as_deref(),
            )
        }
    })
    .await?;

    let steer_marker = SteerMarker {
        steer_id,
        message_id: user_message.id.clone(),
        display: json!({
            "content": message,
            "planMode": plan_mode,
            "blocks": user_blocks,
        }),
    };

    let receipt = match state
        .engines
        .steer_message(&thread, &engine_thread_id, turn_input, steer_marker)
        .await
    {
        Ok(receipt) => receipt,
        Err(error) => {
            let rollback_result = run_db(db, {
                let message_id = user_message.id.clone();
                move |db| db::messages::delete_message(db, &message_id)
            })
            .await;
            if let Err(rollback_error) = rollback_result {
                log::warn!(
                    "failed to roll back persisted steer message {} after steer error: {}",
                    user_message.id,
                    rollback_error
                );
            }

            return Err(err_to_string(error));
        }
    };

    Ok(receipt)
}

fn build_user_blocks(
    message: &str,
    input_items: &[TurnInputItem],
    attachments: &[TurnAttachment],
    plan_mode: bool,
    is_steer: bool,
) -> Vec<ContentBlock> {
    let mut user_blocks = Vec::with_capacity(
        input_items
            .len()
            .saturating_add(attachments.len())
            .saturating_add(1),
    );

    let mut structured_text_parts: Vec<String> = Vec::new();

    for item in input_items {
        match item {
            TurnInputItem::Skill { name, path } => {
                user_blocks.push(ContentBlock::Skill {
                    name: name.clone(),
                    path: path.clone(),
                });
            }
            TurnInputItem::Mention { name, path } => {
                user_blocks.push(ContentBlock::Mention {
                    name: name.clone(),
                    path: path.clone(),
                });
            }
            TurnInputItem::Text { text } => {
                structured_text_parts.push(text.clone());
            }
        }
    }

    for attachment in attachments {
        user_blocks.push(ContentBlock::Attachment {
            file_name: attachment.file_name.clone(),
            file_path: attachment.file_path.clone(),
            size_bytes: attachment.size_bytes,
            mime_type: attachment.mime_type.clone(),
        });
    }

    let final_text = if structured_text_parts.is_empty() {
        message.to_string()
    } else {
        structured_text_parts.join("\n")
    };
    user_blocks.push(ContentBlock::Text {
        content: final_text,
        plan_mode: if plan_mode { Some(true) } else { None },
        is_steer: if is_steer { Some(true) } else { None },
    });

    user_blocks
}

fn normalize_input_items(
    message: &str,
    input_items: Option<Vec<ChatInputItemPayload>>,
) -> Result<Vec<TurnInputItem>, String> {
    let mut normalized = Vec::new();

    for item in input_items.unwrap_or_default() {
        match item {
            ChatInputItemPayload::Text { text } => {
                if !text.is_empty() {
                    normalized.push(TurnInputItem::Text { text });
                }
            }
            ChatInputItemPayload::Skill { name, path } => {
                let name = name.trim();
                let path = path.trim();
                if name.is_empty() || path.is_empty() {
                    return Err("skill input items require non-empty name and path".to_string());
                }
                normalized.push(TurnInputItem::Skill {
                    name: name.to_string(),
                    path: path.to_string(),
                });
            }
            ChatInputItemPayload::Mention { name, path } => {
                let name = name.trim();
                let path = path.trim();
                if name.is_empty() || path.is_empty() {
                    return Err("mention input items require non-empty name and path".to_string());
                }
                normalized.push(TurnInputItem::Mention {
                    name: name.to_string(),
                    path: path.to_string(),
                });
            }
        }
    }

    if normalized.is_empty() {
        normalized.push(TurnInputItem::Text {
            text: message.to_string(),
        });
        return Ok(normalized);
    }

    let has_text_item = normalized
        .iter()
        .any(|item| matches!(item, TurnInputItem::Text { text } if !text.is_empty()));
    if !has_text_item && !message.trim().is_empty() {
        return Err(
            "input items must include at least one text segment when message text is provided"
                .to_string(),
        );
    }

    let mut merged = Vec::with_capacity(normalized.len());
    for item in normalized {
        match item {
            TurnInputItem::Text { text } => {
                if let Some(TurnInputItem::Text { text: current }) = merged.last_mut() {
                    current.push_str(&text);
                } else {
                    merged.push(TurnInputItem::Text { text });
                }
            }
            other => merged.push(other),
        }
    }

    Ok(merged)
}

fn normalize_attachments(
    attachments: Option<Vec<ChatAttachmentPayload>>,
) -> Result<Vec<TurnAttachment>, String> {
    let attachments = attachments.unwrap_or_default();
    if attachments.len() > MAX_ATTACHMENTS_PER_TURN {
        return Err(format!(
            "You can attach at most {MAX_ATTACHMENTS_PER_TURN} files per turn."
        ));
    }

    let mut normalized = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let file_path = attachment.file_path.trim().to_string();
        if file_path.is_empty() {
            return Err("Attachment path cannot be empty.".to_string());
        }

        let file_name = if attachment.file_name.trim().is_empty() {
            Path::new(&file_path)
                .file_name()
                .and_then(|value| value.to_str())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| file_path.clone())
        } else {
            attachment.file_name.trim().to_string()
        };

        normalized.push(TurnAttachment {
            file_name,
            file_path,
            size_bytes: attachment.size_bytes,
            mime_type: attachment.mime_type,
        });
    }

    Ok(normalized)
}

fn validate_attachments_for_engine_model(
    attachments: &[TurnAttachment],
    engine_id: &str,
    model_id: &str,
    catalog: Option<&[EngineInfoDto]>,
) -> Result<(), String> {
    if attachments.is_empty() {
        return Ok(());
    }

    let Some(model) = catalog
        .and_then(|engines| engines.iter().find(|engine| engine.id == engine_id))
        .and_then(|engine| engine.models.iter().find(|model| model.id == model_id))
    else {
        return Ok(());
    };

    let allowed_modalities = if model.attachment_modalities.is_empty() {
        HashSet::new()
    } else {
        model
            .attachment_modalities
            .iter()
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
            .collect::<HashSet<_>>()
    };

    if allowed_modalities.is_empty() {
        return Err(format!(
            "{} does not support file attachments.",
            model.display_name
        ));
    }

    for attachment in attachments {
        let Some(modality) = attachment_modality(attachment) else {
            return Err(format!(
                "{} is not a supported attachment type for {}.",
                attachment.file_name, model.display_name
            ));
        };
        if !allowed_modalities.contains(modality) {
            return Err(format!(
                "{} attachments are not supported by {}.",
                attachment_modality_label(modality),
                model.display_name
            ));
        }
    }

    Ok(())
}

fn attachment_modality(attachment: &TurnAttachment) -> Option<&'static str> {
    let extension = Path::new(&attachment.file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase);
    let mime_type = attachment
        .mime_type
        .as_deref()
        .map(str::trim)
        .map(str::to_lowercase);

    if extension.as_deref() == Some("pdf") || mime_type.as_deref() == Some("application/pdf") {
        return Some("pdf");
    }
    if extension
        .as_deref()
        .map(|value| IMAGE_ATTACHMENT_EXTENSIONS.contains(&value))
        .unwrap_or(false)
        || mime_type
            .as_deref()
            .map(|value| value.starts_with("image/"))
            .unwrap_or(false)
    {
        return Some("image");
    }
    if extension
        .as_deref()
        .map(|value| TEXT_ATTACHMENT_EXTENSIONS.contains(&value))
        .unwrap_or(false)
        || mime_type
            .as_deref()
            .map(is_text_attachment_mime_type)
            .unwrap_or(false)
    {
        return Some("text");
    }

    None
}

fn is_text_attachment_mime_type(value: &str) -> bool {
    value.starts_with("text/")
        || matches!(
            value,
            "application/json"
                | "application/javascript"
                | "application/typescript"
                | "application/xml"
                | "application/x-sh"
                | "application/x-yaml"
                | "application/yaml"
                | "text/csv"
        )
}

fn attachment_modality_label(modality: &str) -> &'static str {
    match modality {
        "image" => "Image",
        "pdf" => "PDF",
        _ => "Text file",
    }
}

#[tauri::command]
pub async fn cancel_turn(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    state.turns.cancel(&thread_id).await;

    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?;

    if let Some(thread) = thread.as_ref() {
        let cancel_snapshot = run_db(db.clone(), {
            let thread_id = thread_id.clone();
            move |db| persist_cancelled_turn_snapshot(db, &thread_id)
        })
        .await?;

        if let Some(message_id) = cancel_snapshot.assistant_message_id.as_deref() {
            resolve_pending_approvals_for_terminal_message(state.inner(), message_id).await;
        }

        let latest_thread = cancel_snapshot.thread.or_else(|| Some(thread.clone()));
        let (thread_updated_event, _) = build_final_thread_event(latest_thread, thread);
        let _ = app.emit("thread-updated", thread_updated_event);

        state
            .engines
            .interrupt(thread)
            .await
            .map_err(err_to_string)?;
    }
    Ok(())
}

#[derive(Debug, Default)]
struct CancelledTurnSnapshot {
    thread: Option<ThreadDto>,
    assistant_message_id: Option<String>,
}

fn persist_cancelled_turn_snapshot(
    db: &crate::db::Database,
    thread_id: &str,
) -> anyhow::Result<CancelledTurnSnapshot> {
    let latest_streaming_assistant: Option<(String, Option<String>)> = {
        let conn = db.connect()?;
        conn.query_row(
            "SELECT id, blocks_json
             FROM messages
             WHERE thread_id = ?1
               AND role = 'assistant'
               AND status = 'streaming'
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1",
            params![thread_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .context("failed to load latest streaming assistant message for cancellation")?
    };

    let mut assistant_message_id: Option<String> = None;
    if let Some((message_id, blocks_json)) = latest_streaming_assistant {
        db::actions::resolve_pending_approvals_for_message(db, &message_id, Some("cancel"))?;

        let mut updated_blocks = match blocks_json.as_deref() {
            Some(blocks_json) => match serde_json::from_str::<Value>(blocks_json) {
                Ok(blocks) => Some(blocks),
                Err(error) => {
                    log::warn!("failed to parse streaming assistant blocks during cancel: {error}");
                    None
                }
            },
            None => Some(Value::Array(Vec::new())),
        };
        if let Some(blocks) = updated_blocks.as_mut() {
            terminalize_unresolved_turn_blocks_json(
                blocks,
                &TurnCompletionStatus::Interrupted,
                None,
            );
        }

        if let Some(blocks_json) = updated_blocks.map(|blocks| blocks.to_string()) {
            db::messages::update_assistant_blocks_json(
                db,
                &message_id,
                &blocks_json,
                MessageStatusDto::Interrupted,
                None,
            )?;
        } else {
            db::messages::update_assistant_status(db, &message_id, MessageStatusDto::Interrupted)?;
        }

        assistant_message_id = Some(message_id);
    }

    db::threads::update_thread_status(db, thread_id, ThreadStatusDto::Idle)?;
    let thread = db::threads::get_thread(db, thread_id)?;

    Ok(CancelledTurnSnapshot {
        thread,
        assistant_message_id,
    })
}

#[tauri::command]
pub async fn respond_to_approval(
    state: State<'_, AppState>,
    thread_id: String,
    approval_id: String,
    response: Value,
) -> Result<(), String> {
    respond_to_approval_inner(state.inner(), thread_id, approval_id, response).await
}

async fn respond_to_approval_inner(
    state: &AppState,
    thread_id: String,
    approval_id: String,
    response: Value,
) -> Result<(), String> {
    if !response.is_object() {
        return Err("approval response must be a JSON object".to_string());
    }

    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;
    let has_local_turn = state.turns.get(&thread_id).await.is_some();
    let normalized_response =
        normalize_approval_response_for_engine(thread.engine_id.as_str(), response)?;
    let approval_route =
        load_approval_response_route(db.clone(), thread.engine_id.as_str(), &approval_id).await?;

    state
        .engines
        .respond_to_approval(
            &thread,
            &approval_id,
            normalized_response.clone(),
            approval_route,
        )
        .await
        .map_err(err_to_string)?;

    let decision = approval_response_decision_for_persistence(&normalized_response);
    run_db(db, {
        let approval_id = approval_id.clone();
        let thread_id = thread_id.clone();
        let decision = decision.to_string();
        let normalized_response = normalized_response.clone();
        move |db| {
            db::actions::answer_approval_with_response(
                db,
                &approval_id,
                &decision,
                Some(&normalized_response),
            )?;
            if let Some(message_id) = db::actions::find_approval_message_id(db, &approval_id)? {
                let _ = db::messages::mark_approval_block_answered(
                    db,
                    &message_id,
                    &approval_id,
                    &decision,
                    Some(&normalized_response),
                );
            }
            let recovered_status = {
                let conn = db.connect()?;
                db::threads::derive_thread_status_for_recovery(&conn, &thread_id)?
            };
            let next_thread_status =
                if has_local_turn && recovered_status != ThreadStatusDto::AwaitingApproval {
                    ThreadStatusDto::Streaming
                } else {
                    recovered_status
                };
            db::threads::update_thread_status(db, &thread_id, next_thread_status)?;
            Ok(())
        }
    })
    .await?;

    Ok(())
}

async fn load_approval_response_route(
    db: crate::db::Database,
    engine_id: &str,
    approval_id: &str,
) -> Result<Option<ApprovalRequestRoute>, String> {
    let engine_id = engine_id.to_string();
    let approval_id = approval_id.to_string();
    run_db(db, move |db| {
        let details = db::actions::find_approval_details(db, &approval_id)?;
        Ok(details.and_then(|details| approval_response_route_for_engine(&engine_id, &details)))
    })
    .await
}

fn approval_response_decision_for_persistence(response: &Value) -> &'static str {
    if let Some(decision) = response.get("decision").and_then(Value::as_str) {
        return match decision {
            "deny" => "decline",
            "acceptForSession" => "accept_for_session",
            "accept" => "accept",
            "decline" => "decline",
            "cancel" => "cancel",
            "accept_for_session" => "accept_for_session",
            _ => "custom",
        };
    }

    if let Some(action) = response.get("action").and_then(Value::as_str) {
        return match action {
            "accept" => "accept",
            "decline" => "decline",
            "cancel" => "cancel",
            _ => "custom",
        };
    }

    if response.get("permissions").is_some() {
        if permission_profile_is_empty(response.get("permissions")) {
            return "decline";
        }
        if matches!(
            response.get("scope").and_then(Value::as_str),
            Some("session")
        ) {
            return "accept_for_session";
        }
        return "accept";
    }

    "custom"
}

fn permission_profile_is_empty(value: Option<&Value>) -> bool {
    fn has_granted_permission(value: &Value) -> bool {
        match value {
            Value::Bool(value) => *value,
            Value::String(value) => !value.trim().is_empty() && value != "none",
            Value::Array(items) => items.iter().any(has_granted_permission),
            Value::Object(map) => map.values().any(has_granted_permission),
            _ => false,
        }
    }

    match value {
        Some(value) => !has_granted_permission(value),
        None => true,
    }
}

#[tauri::command]
pub async fn get_thread_messages(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<MessageDto>, String> {
    run_db(state.db.clone(), move |db| {
        let messages = db::messages::get_thread_messages(db, &thread_id)?;
        db::threads::reconcile_stale_running_thread_status_from_transcript(db, &thread_id)?;
        Ok(messages)
    })
    .await
}

#[tauri::command]
pub async fn get_thread_messages_window(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    cursor: Option<MessageWindowCursorDto>,
    limit: Option<usize>,
) -> Result<MessageWindowDto, String> {
    if cursor.is_none() {
        crate::commands::threads::backfill_codex_history_mode(
            app,
            state.inner().clone(),
            thread_id.clone(),
        );
    }
    let requested_limit = limit.unwrap_or(MESSAGE_WINDOW_DEFAULT_LIMIT);
    let clamped_limit = requested_limit.clamp(1, MESSAGE_WINDOW_MAX_LIMIT);

    run_db(state.db.clone(), move |db| {
        let window = db::messages::get_thread_messages_window(
            db,
            &thread_id,
            cursor.as_ref(),
            clamped_limit,
        )?;
        db::threads::reconcile_stale_running_thread_status_from_transcript(db, &thread_id)?;
        Ok(window)
    })
    .await
}

#[tauri::command]
pub async fn get_message_blocks(
    state: State<'_, AppState>,
    message_id: String,
) -> Result<Option<Value>, String> {
    run_db(state.db.clone(), move |db| {
        db::messages::get_message_blocks(db, &message_id)
    })
    .await
}

#[tauri::command]
pub async fn get_action_output(
    state: State<'_, AppState>,
    message_id: String,
    action_id: String,
) -> Result<ActionOutputDto, String> {
    run_db(state.db.clone(), move |db| {
        db::messages::get_action_output(db, &message_id, &action_id)
    })
    .await
}

#[tauri::command]
pub async fn search_messages(
    state: State<'_, AppState>,
    workspace_id: String,
    query: String,
) -> Result<Vec<SearchResultDto>, String> {
    run_db(state.db.clone(), move |db| {
        db::messages::search_messages(db, &workspace_id, &query)
    })
    .await
}

fn normalize_codex_review_target(
    target: &CodexReviewTargetPayload,
) -> Result<(Value, String, String), String> {
    match target {
        CodexReviewTargetPayload::UncommittedChanges => Ok((
            serde_json::json!({
                "type": "uncommittedChanges",
            }),
            "Review uncommitted changes.".to_string(),
            "Review: Uncommitted changes".to_string(),
        )),
        CodexReviewTargetPayload::BaseBranch { branch } => {
            let branch = branch.trim();
            if branch.is_empty() {
                return Err("Base branch review requires a branch name.".to_string());
            }
            Ok((
                serde_json::json!({
                    "type": "baseBranch",
                    "branch": branch,
                }),
                format!("Review changes against base branch `{branch}`."),
                truncate_title(format!("Review: {branch}"), MAX_THREAD_TITLE_CHARS),
            ))
        }
        CodexReviewTargetPayload::Commit { sha, title } => {
            let sha = sha.trim();
            if sha.is_empty() {
                return Err("Commit review requires a commit SHA.".to_string());
            }
            let short_sha = sha.chars().take(12).collect::<String>();
            let normalized_title = title
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let message = match normalized_title.as_deref() {
                Some(title) => format!("Review commit `{sha}`: {title}"),
                None => format!("Review commit `{sha}`."),
            };
            let target = match normalized_title {
                Some(title) => serde_json::json!({
                    "type": "commit",
                    "sha": sha,
                    "title": title,
                }),
                None => serde_json::json!({
                    "type": "commit",
                    "sha": sha,
                }),
            };
            Ok((
                target,
                message,
                truncate_title(format!("Review: {short_sha}"), MAX_THREAD_TITLE_CHARS),
            ))
        }
        CodexReviewTargetPayload::Custom { instructions } => {
            let instructions = instructions.trim();
            if instructions.is_empty() {
                return Err("Custom review requires instructions.".to_string());
            }
            Ok((
                serde_json::json!({
                    "type": "custom",
                    "instructions": instructions,
                }),
                instructions.to_string(),
                "Review: Custom".to_string(),
            ))
        }
    }
}

fn clone_codex_review_metadata(existing: Option<&Value>, model_id: &str) -> Option<Value> {
    let mut metadata = existing.cloned().unwrap_or_else(|| serde_json::json!({}));
    if !metadata.is_object() {
        metadata = serde_json::json!({});
    }

    let object = metadata.as_object_mut()?;
    object.remove("manualTitle");
    object.remove("manualTitleUpdatedAt");
    object.remove("codexPreview");
    object.remove("codexThreadStatus");
    object.remove("codexThreadActiveFlags");
    object.remove("codexSyncRequired");
    object.remove("codexSyncReason");
    object.remove(crate::codex_thread_metadata::REMOTE_TURN_ACTIVE_KEY);
    object.insert(
        "lastModelId".to_string(),
        Value::String(model_id.to_string()),
    );
    Some(metadata)
}

// This is an internal orchestration boundary whose inputs deliberately make
// turn ownership and persistence state explicit.
#[allow(clippy::too_many_arguments)]
async fn run_turn(
    app: tauri::AppHandle,
    state: AppState,
    thread: crate::models::ThreadDto,
    engine_thread_id: String,
    assistant_message_id: String,
    initial_turn_model_id: String,
    turn_input: TurnInput,
    client_turn_id: Option<String>,
    cancellation: CancellationToken,
) {
    let max_output_chars = state.config.debug.max_action_output_chars;
    let turn_started_at = Instant::now();
    let (event_tx, mut event_rx) = mpsc::channel::<EngineEvent>(ENGINE_EVENT_QUEUE_CAPACITY);
    let mut transcript_recorder = (thread.engine_id == "codex").then(|| {
        CodexTranscriptRecorder::start(
            state.db.clone(),
            thread.id.clone(),
            assistant_message_id.clone(),
            &app,
        )
    });
    let mut transcript_recording_error: Option<String> = None;

    if thread.engine_id == "codex" && turn_input.plan_mode {
        let message = format!(
            "codex plan turn bridge started: local_thread_id={}, engine_thread_id={}, assistant_message_id={}, client_turn_id={:?}, model_id={}",
            thread.id,
            engine_thread_id,
            assistant_message_id,
            client_turn_id,
            initial_turn_model_id
        );
        log::info!("{message}");
        let _ = crate::diagnostic_logs::append_codex_event_routing_log(&message);
    }

    let engines = state.engines.clone();
    let thread_for_engine = thread.clone();
    let input_for_engine = turn_input.clone();
    let engine_thread_for_engine = engine_thread_id.clone();
    let cancellation_for_engine = cancellation.clone();

    let engine_task = tokio::spawn(async move {
        engines
            .send_message(
                &thread_for_engine,
                &engine_thread_for_engine,
                input_for_engine,
                event_tx,
                cancellation_for_engine,
            )
            .await
    });

    let codex_title_generation_started = should_generate_codex_thread_title(&thread);
    if codex_title_generation_started {
        spawn_codex_thread_title_generation(
            app.clone(),
            state.clone(),
            thread.clone(),
            engine_thread_id.clone(),
            turn_input.message.clone(),
        );
    }

    let mut blocks: Vec<ContentBlock> = Vec::new();
    let mut action_index: HashMap<String, usize> = HashMap::new();
    let mut approval_index: HashMap<String, usize> = HashMap::new();
    let mut message_status = MessageStatusDto::Streaming;
    let mut thread_status = ThreadStatusDto::Streaming;
    let mut turn_model_id = initial_turn_model_id;
    let mut token_usage: Option<(u64, u64)> = None;
    let mut blocks_dirty = false;
    let mut message_state_dirty = false;
    let mut thread_status_dirty = false;
    let mut turn_model_dirty = false;
    let mut last_persist_at = Instant::now();
    let mut last_blocks_persist_at = Instant::now();
    let mut last_persisted_thread_status = thread_status.clone();
    let stream_event_topic = format!("stream-event-{}", thread.id);
    let approval_event_topic = format!("approval-request-{}", thread.id);
    let mut pending_event: Option<EngineEvent> = None;

    let initial_turn_started_event = EngineEvent::TurnStarted {
        client_turn_id: client_turn_id.clone(),
        native_turn_id: None,
    };
    let initial_progress = process_stream_event(
        &app,
        &state,
        &thread,
        &assistant_message_id,
        &stream_event_topic,
        &approval_event_topic,
        &initial_turn_started_event,
        &mut blocks,
        &mut action_index,
        &mut approval_index,
        max_output_chars,
        turn_started_at,
    )
    .await;
    let initial_force_persist = apply_stream_progress(
        initial_progress,
        &mut message_status,
        &mut thread_status,
        &mut turn_model_id,
        &mut token_usage,
        &mut blocks_dirty,
        &mut message_state_dirty,
        &mut thread_status_dirty,
        &mut turn_model_dirty,
    );
    flush_stream_state(
        &app,
        &state,
        &thread,
        &assistant_message_id,
        &blocks,
        &message_status,
        &thread_status,
        &turn_model_id,
        &mut blocks_dirty,
        &mut message_state_dirty,
        &mut thread_status_dirty,
        &mut turn_model_dirty,
        &mut last_persisted_thread_status,
        &mut last_persist_at,
        &mut last_blocks_persist_at,
        initial_force_persist,
    )
    .await;

    loop {
        let incoming_event = if pending_event.is_some() {
            match tokio::time::timeout(STREAM_EVENT_COALESCE_IDLE_FLUSH_INTERVAL, event_rx.recv())
                .await
            {
                Ok(event) => event,
                Err(_) => {
                    if let Some(event) = pending_event.take() {
                        let progress = process_stream_event(
                            &app,
                            &state,
                            &thread,
                            &assistant_message_id,
                            &stream_event_topic,
                            &approval_event_topic,
                            &event,
                            &mut blocks,
                            &mut action_index,
                            &mut approval_index,
                            max_output_chars,
                            turn_started_at,
                        )
                        .await;
                        let force_persist = apply_stream_progress(
                            progress,
                            &mut message_status,
                            &mut thread_status,
                            &mut turn_model_id,
                            &mut token_usage,
                            &mut blocks_dirty,
                            &mut message_state_dirty,
                            &mut thread_status_dirty,
                            &mut turn_model_dirty,
                        );
                        flush_stream_state(
                            &app,
                            &state,
                            &thread,
                            &assistant_message_id,
                            &blocks,
                            &message_status,
                            &thread_status,
                            &turn_model_id,
                            &mut blocks_dirty,
                            &mut message_state_dirty,
                            &mut thread_status_dirty,
                            &mut turn_model_dirty,
                            &mut last_persisted_thread_status,
                            &mut last_persist_at,
                            &mut last_blocks_persist_at,
                            force_persist,
                        )
                        .await;
                    }
                    continue;
                }
            }
        } else {
            event_rx.recv().await
        };

        let Some(incoming_event) = incoming_event else {
            break;
        };

        if let EngineEvent::CodexNativeEvent { event } = incoming_event {
            if transcript_recording_error.is_none() {
                let record_result = match transcript_recorder.as_ref() {
                    Some(recorder) => recorder.record(event).await,
                    None => Err(anyhow::anyhow!(
                        "received a Codex native event without a transcript recorder"
                    )),
                };
                if let Err(error) = record_result {
                    let message = format!("Codex transcript recording failed: {error}");
                    log::error!("{message}");
                    transcript_recording_error = Some(message);
                    cancellation.cancel();
                }
            }
            continue;
        }

        let mut current_event = incoming_event;

        loop {
            if let Some(previous_event) = pending_event.take() {
                match try_coalesce_stream_events(previous_event, current_event) {
                    Ok(merged_event) => {
                        if coalesced_event_content_len(&merged_event)
                            >= STREAM_EVENT_COALESCE_MAX_CHARS
                        {
                            let progress = process_stream_event(
                                &app,
                                &state,
                                &thread,
                                &assistant_message_id,
                                &stream_event_topic,
                                &approval_event_topic,
                                &merged_event,
                                &mut blocks,
                                &mut action_index,
                                &mut approval_index,
                                max_output_chars,
                                turn_started_at,
                            )
                            .await;
                            let force_persist = apply_stream_progress(
                                progress,
                                &mut message_status,
                                &mut thread_status,
                                &mut turn_model_id,
                                &mut token_usage,
                                &mut blocks_dirty,
                                &mut message_state_dirty,
                                &mut thread_status_dirty,
                                &mut turn_model_dirty,
                            );
                            flush_stream_state(
                                &app,
                                &state,
                                &thread,
                                &assistant_message_id,
                                &blocks,
                                &message_status,
                                &thread_status,
                                &turn_model_id,
                                &mut blocks_dirty,
                                &mut message_state_dirty,
                                &mut thread_status_dirty,
                                &mut turn_model_dirty,
                                &mut last_persisted_thread_status,
                                &mut last_persist_at,
                                &mut last_blocks_persist_at,
                                force_persist,
                            )
                            .await;
                        } else {
                            pending_event = Some(merged_event);
                        }
                        break;
                    }
                    Err((unmerged_previous_event, unmerged_current_event)) => {
                        let progress = process_stream_event(
                            &app,
                            &state,
                            &thread,
                            &assistant_message_id,
                            &stream_event_topic,
                            &approval_event_topic,
                            &unmerged_previous_event,
                            &mut blocks,
                            &mut action_index,
                            &mut approval_index,
                            max_output_chars,
                            turn_started_at,
                        )
                        .await;
                        let force_persist = apply_stream_progress(
                            progress,
                            &mut message_status,
                            &mut thread_status,
                            &mut turn_model_id,
                            &mut token_usage,
                            &mut blocks_dirty,
                            &mut message_state_dirty,
                            &mut thread_status_dirty,
                            &mut turn_model_dirty,
                        );
                        flush_stream_state(
                            &app,
                            &state,
                            &thread,
                            &assistant_message_id,
                            &blocks,
                            &message_status,
                            &thread_status,
                            &turn_model_id,
                            &mut blocks_dirty,
                            &mut message_state_dirty,
                            &mut thread_status_dirty,
                            &mut turn_model_dirty,
                            &mut last_persisted_thread_status,
                            &mut last_persist_at,
                            &mut last_blocks_persist_at,
                            force_persist,
                        )
                        .await;
                        current_event = unmerged_current_event;
                    }
                }
            } else if is_coalescable_stream_event(&current_event) {
                pending_event = Some(current_event);
                break;
            } else {
                let progress = process_stream_event(
                    &app,
                    &state,
                    &thread,
                    &assistant_message_id,
                    &stream_event_topic,
                    &approval_event_topic,
                    &current_event,
                    &mut blocks,
                    &mut action_index,
                    &mut approval_index,
                    max_output_chars,
                    turn_started_at,
                )
                .await;
                let force_persist = apply_stream_progress(
                    progress,
                    &mut message_status,
                    &mut thread_status,
                    &mut turn_model_id,
                    &mut token_usage,
                    &mut blocks_dirty,
                    &mut message_state_dirty,
                    &mut thread_status_dirty,
                    &mut turn_model_dirty,
                );
                flush_stream_state(
                    &app,
                    &state,
                    &thread,
                    &assistant_message_id,
                    &blocks,
                    &message_status,
                    &thread_status,
                    &turn_model_id,
                    &mut blocks_dirty,
                    &mut message_state_dirty,
                    &mut thread_status_dirty,
                    &mut turn_model_dirty,
                    &mut last_persisted_thread_status,
                    &mut last_persist_at,
                    &mut last_blocks_persist_at,
                    force_persist,
                )
                .await;
                break;
            }
        }
    }

    if let Some(event) = pending_event.take() {
        let progress = process_stream_event(
            &app,
            &state,
            &thread,
            &assistant_message_id,
            &stream_event_topic,
            &approval_event_topic,
            &event,
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            max_output_chars,
            turn_started_at,
        )
        .await;
        let force_persist = apply_stream_progress(
            progress,
            &mut message_status,
            &mut thread_status,
            &mut turn_model_id,
            &mut token_usage,
            &mut blocks_dirty,
            &mut message_state_dirty,
            &mut thread_status_dirty,
            &mut turn_model_dirty,
        );
        flush_stream_state(
            &app,
            &state,
            &thread,
            &assistant_message_id,
            &blocks,
            &message_status,
            &thread_status,
            &turn_model_id,
            &mut blocks_dirty,
            &mut message_state_dirty,
            &mut thread_status_dirty,
            &mut turn_model_dirty,
            &mut last_persisted_thread_status,
            &mut last_persist_at,
            &mut last_blocks_persist_at,
            force_persist,
        )
        .await;
    }

    if let Some(recorder) = transcript_recorder.take() {
        if let Err(error) = recorder.finish().await {
            let message = format!("Codex transcript flush failed: {error}");
            log::error!("{message}");
            transcript_recording_error.get_or_insert(message);
        }
    }

    match engine_task.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let error_message = err_to_string(error);
            blocks.push(ContentBlock::Error {
                message: format!("Engine error: {error_message}"),
            });
            blocks_dirty = true;
            if message_status != MessageStatusDto::Error {
                message_status = MessageStatusDto::Error;
                message_state_dirty = true;
            }
            if thread_status != ThreadStatusDto::Error {
                thread_status = ThreadStatusDto::Error;
                thread_status_dirty = true;
            }
            if terminalize_unresolved_turn_blocks(&mut blocks, &TurnCompletionStatus::Failed, None)
            {
                blocks_dirty = true;
            }
            resolve_pending_approvals_for_terminal_message(&state, &assistant_message_id).await;
            let _ = app.emit(
                &stream_event_topic,
                EngineEvent::Error {
                    message: error_message,
                    recoverable: false,
                },
            );
        }
        Err(error) => {
            blocks.push(ContentBlock::Error {
                message: format!("Engine task join error: {error}"),
            });
            blocks_dirty = true;
            if message_status != MessageStatusDto::Error {
                message_status = MessageStatusDto::Error;
                message_state_dirty = true;
            }
            if thread_status != ThreadStatusDto::Error {
                thread_status = ThreadStatusDto::Error;
                thread_status_dirty = true;
            }
            if terminalize_unresolved_turn_blocks(&mut blocks, &TurnCompletionStatus::Failed, None)
            {
                blocks_dirty = true;
            }
            resolve_pending_approvals_for_terminal_message(&state, &assistant_message_id).await;
        }
    }

    if let Some(error_message) = transcript_recording_error {
        blocks.push(ContentBlock::Error {
            message: error_message.clone(),
        });
        blocks_dirty = true;
        if message_status != MessageStatusDto::Error {
            message_status = MessageStatusDto::Error;
            message_state_dirty = true;
        }
        if thread_status != ThreadStatusDto::Error {
            thread_status = ThreadStatusDto::Error;
            thread_status_dirty = true;
        }
        let _ = app.emit(
            &stream_event_topic,
            EngineEvent::Error {
                message: error_message,
                recoverable: false,
            },
        );
    }

    if cancellation.is_cancelled() && matches!(message_status, MessageStatusDto::Streaming) {
        message_status = MessageStatusDto::Interrupted;
        message_state_dirty = true;
        thread_status = ThreadStatusDto::Idle;
        thread_status_dirty = true;
        if terminalize_unresolved_turn_blocks(&mut blocks, &TurnCompletionStatus::Interrupted, None)
        {
            blocks_dirty = true;
        }
        resolve_pending_approvals_for_terminal_message(&state, &assistant_message_id).await;
    }

    flush_stream_state(
        &app,
        &state,
        &thread,
        &assistant_message_id,
        &blocks,
        &message_status,
        &thread_status,
        &turn_model_id,
        &mut blocks_dirty,
        &mut message_state_dirty,
        &mut thread_status_dirty,
        &mut turn_model_dirty,
        &mut last_persisted_thread_status,
        &mut last_persist_at,
        &mut last_blocks_persist_at,
        true,
    )
    .await;

    state.turns.finish(&thread.id).await;

    if let Err(error) = run_db(state.db.clone(), {
        let assistant_message_id = assistant_message_id.clone();
        let message_status = message_status.clone();
        let token_usage = token_usage;
        move |db| {
            db::messages::complete_assistant_message(
                db,
                &assistant_message_id,
                message_status,
                token_usage,
                Some(turn_model_id.as_str()),
            )
        }
    })
    .await
    {
        log::warn!("failed to complete assistant message: {error}");
    }

    if matches!(message_status, MessageStatusDto::Completed) {
        if let Err(error) = run_db(state.db.clone(), {
            let thread_id = thread.id.clone();
            let token_usage = token_usage;
            move |db| db::threads::bump_message_counters(db, &thread_id, token_usage)
        })
        .await
        {
            log::warn!("failed to bump thread counters: {error}");
        }
    }

    if !codex_title_generation_started {
        let _ = maybe_update_thread_title(&state, &thread, &engine_thread_id, &turn_input.message)
            .await;
    }

    let latest_thread = run_db(state.db.clone(), {
        let thread_id = thread.id.clone();
        move |db| {
            db::threads::reconcile_stale_running_thread_status_from_transcript(db, &thread_id)?;
            db::threads::get_thread(db, &thread_id)
        }
    })
    .await
    .unwrap_or_else(|error| {
        log::warn!("failed to load thread before final thread-updated emit: {error}");
        None
    });

    let (thread_updated_event, final_thread) = build_final_thread_event(latest_thread, &thread);
    let _ = app.emit("thread-updated", thread_updated_event);
    if let Some(final_thread) = final_thread.as_ref() {
        emit_chat_turn_finished(
            &app,
            final_thread,
            &assistant_message_id,
            client_turn_id.as_deref(),
            &message_status,
            &blocks,
        );
    }
}

// Review execution mirrors the normal turn runner and keeps its runtime inputs
// explicit until the two orchestration paths are consolidated.
#[allow(clippy::too_many_arguments)]
async fn run_codex_review_turn(
    app: tauri::AppHandle,
    state: AppState,
    source_thread: crate::models::ThreadDto,
    review_thread: crate::models::ThreadDto,
    source_engine_thread_id: String,
    assistant_message_id: String,
    initial_turn_model_id: String,
    target: Value,
    delivery: String,
    cancellation: CancellationToken,
) {
    let max_output_chars = state.config.debug.max_action_output_chars;
    let turn_started_at = Instant::now();
    let (event_tx, mut event_rx) = mpsc::channel::<EngineEvent>(ENGINE_EVENT_QUEUE_CAPACITY);
    let (started_tx, started_rx) = oneshot::channel();
    let mut transcript_recorder = Some(CodexTranscriptRecorder::start(
        state.db.clone(),
        review_thread.id.clone(),
        assistant_message_id.clone(),
        &app,
    ));
    let mut transcript_recording_error: Option<String> = None;

    let engines = state.engines.clone();
    let source_engine_thread_id_for_engine = source_engine_thread_id.clone();
    let target_for_engine = target.clone();
    let delivery_for_engine = delivery.clone();
    let cancellation_for_engine = cancellation.clone();

    let engine_task = tokio::spawn(async move {
        engines
            .start_codex_review(
                &source_engine_thread_id_for_engine,
                target_for_engine,
                Some(delivery_for_engine.as_str()),
                event_tx,
                cancellation_for_engine,
                started_tx,
            )
            .await
    });

    let state_for_started = state.clone();
    let app_for_started = app.clone();
    let review_thread_for_started = review_thread.clone();
    let started_task = tokio::spawn(async move {
        let Ok(started) = started_rx.await else {
            return;
        };

        let updated_thread = match run_db(state_for_started.db.clone(), {
            let review_thread_id = review_thread_for_started.id.clone();
            let review_thread_engine_id = review_thread_for_started.engine_thread_id.clone();
            let review_thread_model_id = review_thread_for_started.model_id.clone();
            let review_thread_metadata = review_thread_for_started.engine_metadata.clone();
            let review_thread_status = review_thread_for_started.status.clone();
            let review_thread_title = review_thread_for_started.title.clone();
            let review_thread_workspace_id = review_thread_for_started.workspace_id.clone();
            let review_thread_repo_id = review_thread_for_started.repo_id.clone();
            move |db| {
                if review_thread_engine_id.as_deref() == Some(started.review_thread_id.as_str()) {
                    return db::threads::get_thread(db, &review_thread_id)?.ok_or_else(|| {
                        anyhow::anyhow!(
                            "review thread not found after review/start: {review_thread_id}"
                        )
                    });
                }

                db::threads::set_engine_thread_id(db, &review_thread_id, &started.review_thread_id)?;
                let current = db::threads::get_thread(db, &review_thread_id)?.ok_or_else(|| {
                    anyhow::anyhow!("review thread not found after engine thread update")
                })?;
                let metadata = current.engine_metadata.or(review_thread_metadata.clone());
                db::threads::update_thread_runtime_snapshot(
                    db,
                    &review_thread_id,
                    Some(&review_thread_title),
                    Some(review_thread_status.clone()),
                    metadata.as_ref(),
                )?;
                db::threads::get_thread(db, &review_thread_id)?.ok_or_else(|| {
                    anyhow::anyhow!(
                        "review thread not found after runtime snapshot update: {review_thread_workspace_id}:{review_thread_repo_id:?}:{review_thread_model_id}"
                    )
                })
            }
        })
        .await
        {
            Ok(thread) => thread,
            Err(error) => {
                log::warn!("failed to persist codex review thread id: {error}");
                return;
            }
        };

        let _ = app_for_started.emit(
            "thread-updated",
            ThreadUpdatedEvent {
                thread_id: updated_thread.id.clone(),
                workspace_id: updated_thread.workspace_id.clone(),
                thread: Some(updated_thread),
            },
        );
    });

    let mut blocks: Vec<ContentBlock> = Vec::new();
    let mut action_index: HashMap<String, usize> = HashMap::new();
    let mut approval_index: HashMap<String, usize> = HashMap::new();
    let mut message_status = MessageStatusDto::Streaming;
    let mut thread_status = ThreadStatusDto::Streaming;
    let mut turn_model_id = initial_turn_model_id;
    let mut token_usage: Option<(u64, u64)> = None;
    let mut blocks_dirty = false;
    let mut message_state_dirty = false;
    let mut thread_status_dirty = false;
    let mut turn_model_dirty = false;
    let mut last_persist_at = Instant::now();
    let mut last_blocks_persist_at = Instant::now();
    let mut last_persisted_thread_status = thread_status.clone();
    let stream_event_topic = format!("stream-event-{}", review_thread.id);
    let approval_event_topic = format!("approval-request-{}", review_thread.id);
    let mut pending_event: Option<EngineEvent> = None;

    let initial_turn_started_event = EngineEvent::TurnStarted {
        client_turn_id: None,
        native_turn_id: None,
    };
    let initial_progress = process_stream_event(
        &app,
        &state,
        &review_thread,
        &assistant_message_id,
        &stream_event_topic,
        &approval_event_topic,
        &initial_turn_started_event,
        &mut blocks,
        &mut action_index,
        &mut approval_index,
        max_output_chars,
        turn_started_at,
    )
    .await;
    let initial_force_persist = apply_stream_progress(
        initial_progress,
        &mut message_status,
        &mut thread_status,
        &mut turn_model_id,
        &mut token_usage,
        &mut blocks_dirty,
        &mut message_state_dirty,
        &mut thread_status_dirty,
        &mut turn_model_dirty,
    );
    flush_stream_state(
        &app,
        &state,
        &review_thread,
        &assistant_message_id,
        &blocks,
        &message_status,
        &thread_status,
        &turn_model_id,
        &mut blocks_dirty,
        &mut message_state_dirty,
        &mut thread_status_dirty,
        &mut turn_model_dirty,
        &mut last_persisted_thread_status,
        &mut last_persist_at,
        &mut last_blocks_persist_at,
        initial_force_persist,
    )
    .await;

    if let Err(error) = started_task.await {
        log::warn!("failed to join codex review start task: {error}");
    }

    loop {
        let incoming_event = if pending_event.is_some() {
            match tokio::time::timeout(STREAM_EVENT_COALESCE_IDLE_FLUSH_INTERVAL, event_rx.recv())
                .await
            {
                Ok(event) => event,
                Err(_) => {
                    if let Some(event) = pending_event.take() {
                        let progress = process_stream_event(
                            &app,
                            &state,
                            &review_thread,
                            &assistant_message_id,
                            &stream_event_topic,
                            &approval_event_topic,
                            &event,
                            &mut blocks,
                            &mut action_index,
                            &mut approval_index,
                            max_output_chars,
                            turn_started_at,
                        )
                        .await;
                        let force_persist = apply_stream_progress(
                            progress,
                            &mut message_status,
                            &mut thread_status,
                            &mut turn_model_id,
                            &mut token_usage,
                            &mut blocks_dirty,
                            &mut message_state_dirty,
                            &mut thread_status_dirty,
                            &mut turn_model_dirty,
                        );
                        flush_stream_state(
                            &app,
                            &state,
                            &review_thread,
                            &assistant_message_id,
                            &blocks,
                            &message_status,
                            &thread_status,
                            &turn_model_id,
                            &mut blocks_dirty,
                            &mut message_state_dirty,
                            &mut thread_status_dirty,
                            &mut turn_model_dirty,
                            &mut last_persisted_thread_status,
                            &mut last_persist_at,
                            &mut last_blocks_persist_at,
                            force_persist,
                        )
                        .await;
                    }
                    continue;
                }
            }
        } else {
            event_rx.recv().await
        };

        let Some(incoming_event) = incoming_event else {
            break;
        };

        if let EngineEvent::CodexNativeEvent { event } = incoming_event {
            if transcript_recording_error.is_none() {
                let record_result = match transcript_recorder.as_ref() {
                    Some(recorder) => recorder.record(event).await,
                    None => Err(anyhow::anyhow!(
                        "received a Codex review event without a transcript recorder"
                    )),
                };
                if let Err(error) = record_result {
                    let message = format!("Codex review transcript recording failed: {error}");
                    log::error!("{message}");
                    transcript_recording_error = Some(message);
                    cancellation.cancel();
                }
            }
            continue;
        }

        let mut current_event = incoming_event;

        loop {
            if let Some(previous_event) = pending_event.take() {
                match try_coalesce_stream_events(previous_event, current_event) {
                    Ok(merged_event) => {
                        if coalesced_event_content_len(&merged_event)
                            >= STREAM_EVENT_COALESCE_MAX_CHARS
                        {
                            let progress = process_stream_event(
                                &app,
                                &state,
                                &review_thread,
                                &assistant_message_id,
                                &stream_event_topic,
                                &approval_event_topic,
                                &merged_event,
                                &mut blocks,
                                &mut action_index,
                                &mut approval_index,
                                max_output_chars,
                                turn_started_at,
                            )
                            .await;
                            let force_persist = apply_stream_progress(
                                progress,
                                &mut message_status,
                                &mut thread_status,
                                &mut turn_model_id,
                                &mut token_usage,
                                &mut blocks_dirty,
                                &mut message_state_dirty,
                                &mut thread_status_dirty,
                                &mut turn_model_dirty,
                            );
                            flush_stream_state(
                                &app,
                                &state,
                                &review_thread,
                                &assistant_message_id,
                                &blocks,
                                &message_status,
                                &thread_status,
                                &turn_model_id,
                                &mut blocks_dirty,
                                &mut message_state_dirty,
                                &mut thread_status_dirty,
                                &mut turn_model_dirty,
                                &mut last_persisted_thread_status,
                                &mut last_persist_at,
                                &mut last_blocks_persist_at,
                                force_persist,
                            )
                            .await;
                        } else {
                            pending_event = Some(merged_event);
                        }
                        break;
                    }
                    Err((unmerged_previous_event, unmerged_current_event)) => {
                        let progress = process_stream_event(
                            &app,
                            &state,
                            &review_thread,
                            &assistant_message_id,
                            &stream_event_topic,
                            &approval_event_topic,
                            &unmerged_previous_event,
                            &mut blocks,
                            &mut action_index,
                            &mut approval_index,
                            max_output_chars,
                            turn_started_at,
                        )
                        .await;
                        let force_persist = apply_stream_progress(
                            progress,
                            &mut message_status,
                            &mut thread_status,
                            &mut turn_model_id,
                            &mut token_usage,
                            &mut blocks_dirty,
                            &mut message_state_dirty,
                            &mut thread_status_dirty,
                            &mut turn_model_dirty,
                        );
                        flush_stream_state(
                            &app,
                            &state,
                            &review_thread,
                            &assistant_message_id,
                            &blocks,
                            &message_status,
                            &thread_status,
                            &turn_model_id,
                            &mut blocks_dirty,
                            &mut message_state_dirty,
                            &mut thread_status_dirty,
                            &mut turn_model_dirty,
                            &mut last_persisted_thread_status,
                            &mut last_persist_at,
                            &mut last_blocks_persist_at,
                            force_persist,
                        )
                        .await;
                        current_event = unmerged_current_event;
                    }
                }
            } else if is_coalescable_stream_event(&current_event) {
                pending_event = Some(current_event);
                break;
            } else {
                let progress = process_stream_event(
                    &app,
                    &state,
                    &review_thread,
                    &assistant_message_id,
                    &stream_event_topic,
                    &approval_event_topic,
                    &current_event,
                    &mut blocks,
                    &mut action_index,
                    &mut approval_index,
                    max_output_chars,
                    turn_started_at,
                )
                .await;
                let force_persist = apply_stream_progress(
                    progress,
                    &mut message_status,
                    &mut thread_status,
                    &mut turn_model_id,
                    &mut token_usage,
                    &mut blocks_dirty,
                    &mut message_state_dirty,
                    &mut thread_status_dirty,
                    &mut turn_model_dirty,
                );
                flush_stream_state(
                    &app,
                    &state,
                    &review_thread,
                    &assistant_message_id,
                    &blocks,
                    &message_status,
                    &thread_status,
                    &turn_model_id,
                    &mut blocks_dirty,
                    &mut message_state_dirty,
                    &mut thread_status_dirty,
                    &mut turn_model_dirty,
                    &mut last_persisted_thread_status,
                    &mut last_persist_at,
                    &mut last_blocks_persist_at,
                    force_persist,
                )
                .await;
                break;
            }
        }
    }

    if let Some(event) = pending_event.take() {
        let progress = process_stream_event(
            &app,
            &state,
            &review_thread,
            &assistant_message_id,
            &stream_event_topic,
            &approval_event_topic,
            &event,
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            max_output_chars,
            turn_started_at,
        )
        .await;
        let force_persist = apply_stream_progress(
            progress,
            &mut message_status,
            &mut thread_status,
            &mut turn_model_id,
            &mut token_usage,
            &mut blocks_dirty,
            &mut message_state_dirty,
            &mut thread_status_dirty,
            &mut turn_model_dirty,
        );
        flush_stream_state(
            &app,
            &state,
            &review_thread,
            &assistant_message_id,
            &blocks,
            &message_status,
            &thread_status,
            &turn_model_id,
            &mut blocks_dirty,
            &mut message_state_dirty,
            &mut thread_status_dirty,
            &mut turn_model_dirty,
            &mut last_persisted_thread_status,
            &mut last_persist_at,
            &mut last_blocks_persist_at,
            force_persist,
        )
        .await;
    }

    if let Some(recorder) = transcript_recorder.take() {
        if let Err(error) = recorder.finish().await {
            let message = format!("Codex review transcript flush failed: {error}");
            log::error!("{message}");
            transcript_recording_error.get_or_insert(message);
        }
    }

    match engine_task.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let error_message = err_to_string(error);
            blocks.push(ContentBlock::Error {
                message: format!("Engine error: {error_message}"),
            });
            blocks_dirty = true;
            if message_status != MessageStatusDto::Error {
                message_status = MessageStatusDto::Error;
                message_state_dirty = true;
            }
            if thread_status != ThreadStatusDto::Error {
                thread_status = ThreadStatusDto::Error;
                thread_status_dirty = true;
            }
            if terminalize_unresolved_turn_blocks(&mut blocks, &TurnCompletionStatus::Failed, None)
            {
                blocks_dirty = true;
            }
            resolve_pending_approvals_for_terminal_message(&state, &assistant_message_id).await;
            let _ = app.emit(
                &stream_event_topic,
                EngineEvent::Error {
                    message: error_message,
                    recoverable: false,
                },
            );
        }
        Err(error) => {
            blocks.push(ContentBlock::Error {
                message: format!("Engine task join error: {error}"),
            });
            blocks_dirty = true;
            if message_status != MessageStatusDto::Error {
                message_status = MessageStatusDto::Error;
                message_state_dirty = true;
            }
            if thread_status != ThreadStatusDto::Error {
                thread_status = ThreadStatusDto::Error;
                thread_status_dirty = true;
            }
            if terminalize_unresolved_turn_blocks(&mut blocks, &TurnCompletionStatus::Failed, None)
            {
                blocks_dirty = true;
            }
            resolve_pending_approvals_for_terminal_message(&state, &assistant_message_id).await;
        }
    }

    if let Some(error_message) = transcript_recording_error {
        blocks.push(ContentBlock::Error {
            message: error_message.clone(),
        });
        blocks_dirty = true;
        if message_status != MessageStatusDto::Error {
            message_status = MessageStatusDto::Error;
            message_state_dirty = true;
        }
        if thread_status != ThreadStatusDto::Error {
            thread_status = ThreadStatusDto::Error;
            thread_status_dirty = true;
        }
        let _ = app.emit(
            &stream_event_topic,
            EngineEvent::Error {
                message: error_message,
                recoverable: false,
            },
        );
    }

    if cancellation.is_cancelled() && matches!(message_status, MessageStatusDto::Streaming) {
        message_status = MessageStatusDto::Interrupted;
        message_state_dirty = true;
        thread_status = ThreadStatusDto::Idle;
        thread_status_dirty = true;
        if terminalize_unresolved_turn_blocks(&mut blocks, &TurnCompletionStatus::Interrupted, None)
        {
            blocks_dirty = true;
        }
        resolve_pending_approvals_for_terminal_message(&state, &assistant_message_id).await;
    }

    flush_stream_state(
        &app,
        &state,
        &review_thread,
        &assistant_message_id,
        &blocks,
        &message_status,
        &thread_status,
        &turn_model_id,
        &mut blocks_dirty,
        &mut message_state_dirty,
        &mut thread_status_dirty,
        &mut turn_model_dirty,
        &mut last_persisted_thread_status,
        &mut last_persist_at,
        &mut last_blocks_persist_at,
        true,
    )
    .await;

    state.turns.finish(&source_thread.id).await;
    state.turns.finish(&review_thread.id).await;

    if let Err(error) = run_db(state.db.clone(), {
        let assistant_message_id = assistant_message_id.clone();
        let message_status = message_status.clone();
        let token_usage = token_usage;
        move |db| {
            db::messages::complete_assistant_message(
                db,
                &assistant_message_id,
                message_status,
                token_usage,
                Some(turn_model_id.as_str()),
            )
        }
    })
    .await
    {
        log::warn!("failed to complete review assistant message: {error}");
    }

    if matches!(message_status, MessageStatusDto::Completed) {
        if let Err(error) = run_db(state.db.clone(), {
            let thread_id = review_thread.id.clone();
            let token_usage = token_usage;
            move |db| db::threads::bump_message_counters(db, &thread_id, token_usage)
        })
        .await
        {
            log::warn!("failed to bump review thread counters: {error}");
        }
    }

    let latest_review_thread = run_db(state.db.clone(), {
        let review_thread_id = review_thread.id.clone();
        move |db| {
            db::threads::reconcile_stale_running_thread_status_from_transcript(
                db,
                &review_thread_id,
            )?;
            db::threads::get_thread(db, &review_thread_id)
        }
    })
    .await
    .unwrap_or_else(|error| {
        log::warn!("failed to load review thread before final thread-updated emit: {error}");
        None
    });
    let (thread_updated_event, final_review_thread) =
        build_final_thread_event(latest_review_thread, &review_thread);
    let _ = app.emit("thread-updated", thread_updated_event);
    if let Some(final_review_thread) = final_review_thread.as_ref() {
        emit_chat_turn_finished(
            &app,
            final_review_thread,
            &assistant_message_id,
            None,
            &message_status,
            &blocks,
        );
    }
}

fn is_coalescable_stream_event(event: &EngineEvent) -> bool {
    matches!(
        event,
        EngineEvent::TextDelta { .. }
            | EngineEvent::ThinkingDelta { .. }
            | EngineEvent::ActionOutputDelta { .. }
            | EngineEvent::ActionProgressUpdated { .. }
    )
}

fn coalesced_event_content_len(event: &EngineEvent) -> usize {
    match event {
        EngineEvent::TextDelta { content }
        | EngineEvent::ThinkingDelta { content }
        | EngineEvent::ActionOutputDelta { content, .. } => content.len(),
        EngineEvent::ActionProgressUpdated { message, .. } => message.len(),
        _ => 0,
    }
}

fn same_output_stream(left: &OutputStream, right: &OutputStream) -> bool {
    matches!(
        (left, right),
        (OutputStream::Stdout, OutputStream::Stdout)
            | (OutputStream::Stderr, OutputStream::Stderr)
            | (OutputStream::Stdin, OutputStream::Stdin)
    )
}

#[allow(clippy::result_large_err)]
fn try_coalesce_stream_events(
    previous: EngineEvent,
    next: EngineEvent,
) -> Result<EngineEvent, (EngineEvent, EngineEvent)> {
    match (previous, next) {
        (
            EngineEvent::TextDelta { mut content },
            EngineEvent::TextDelta {
                content: next_content,
            },
        ) => {
            content.push_str(&next_content);
            Ok(EngineEvent::TextDelta { content })
        }
        (
            EngineEvent::ThinkingDelta { mut content },
            EngineEvent::ThinkingDelta {
                content: next_content,
            },
        ) => {
            content.push_str(&next_content);
            Ok(EngineEvent::ThinkingDelta { content })
        }
        (
            EngineEvent::ActionOutputDelta {
                action_id,
                stream,
                mut content,
            },
            EngineEvent::ActionOutputDelta {
                action_id: next_action_id,
                stream: next_stream,
                content: next_content,
            },
        ) => {
            if action_id == next_action_id && same_output_stream(&stream, &next_stream) {
                content.push_str(&next_content);
                Ok(EngineEvent::ActionOutputDelta {
                    action_id,
                    stream,
                    content,
                })
            } else {
                Err((
                    EngineEvent::ActionOutputDelta {
                        action_id,
                        stream,
                        content,
                    },
                    EngineEvent::ActionOutputDelta {
                        action_id: next_action_id,
                        stream: next_stream,
                        content: next_content,
                    },
                ))
            }
        }
        (
            EngineEvent::ActionProgressUpdated {
                action_id,
                message: _,
            },
            EngineEvent::ActionProgressUpdated {
                action_id: next_action_id,
                message: next_message,
            },
        ) if action_id == next_action_id => Ok(EngineEvent::ActionProgressUpdated {
            action_id,
            message: next_message,
        }),
        (previous, next) => Err((previous, next)),
    }
}

fn elapsed_duration_ms(started_at: Instant) -> u64 {
    let elapsed_ms = started_at.elapsed().as_millis();
    elapsed_ms.min(u128::from(u64::MAX)) as u64
}

fn emit_stream_event_with_duration(
    app: &tauri::AppHandle,
    stream_event_topic: &str,
    event: &EngineEvent,
    turn_duration_ms: Option<u64>,
) {
    if let Some(duration_ms) = turn_duration_ms {
        if matches!(event, EngineEvent::TurnCompleted { .. }) {
            match serde_json::to_value(event) {
                Ok(mut value) => {
                    if let Some(object) = value.as_object_mut() {
                        object.insert("duration_ms".to_string(), json!(duration_ms));
                    }
                    let _ = app.emit(stream_event_topic, value);
                }
                Err(error) => {
                    log::warn!("failed to serialize turn completion event with duration: {error}");
                    let _ = app.emit(stream_event_topic, event);
                }
            }
            return;
        }
    }

    let _ = app.emit(stream_event_topic, event);
}

async fn resolve_pending_approvals_for_terminal_message(
    state: &AppState,
    assistant_message_id: &str,
) {
    if let Err(error) = run_db(state.db.clone(), {
        let assistant_message_id = assistant_message_id.to_string();
        move |db| {
            db::actions::resolve_pending_approvals_for_message(
                db,
                &assistant_message_id,
                Some("cancel"),
            )
        }
    })
    .await
    {
        log::warn!("failed to resolve pending approvals for terminal message: {error}");
    }
}

#[allow(clippy::too_many_arguments)]
async fn process_stream_event(
    app: &tauri::AppHandle,
    state: &AppState,
    thread: &ThreadDto,
    assistant_message_id: &str,
    stream_event_topic: &str,
    approval_event_topic: &str,
    event: &EngineEvent,
    blocks: &mut Vec<ContentBlock>,
    action_index: &mut HashMap<String, usize>,
    approval_index: &mut HashMap<String, usize>,
    max_output_chars: usize,
    turn_started_at: Instant,
) -> EventProgress {
    let mut normalized_event = event.clone();
    match &mut normalized_event {
        EngineEvent::ActionOutputDelta { content, .. } => {
            *content = trim_action_output_delta_content(content);
        }
        EngineEvent::ActionCompleted { result, .. } => {
            truncate_action_result_output(result, max_output_chars);
        }
        EngineEvent::DiffUpdated { diff, .. } => {
            *diff = truncate_chars(diff, STREAMED_DIFF_MAX_CHARS);
        }
        _ => {}
    }

    let turn_duration_ms = if matches!(&normalized_event, EngineEvent::TurnCompleted { .. }) {
        Some(elapsed_duration_ms(turn_started_at))
    } else {
        None
    };

    emit_stream_event_with_duration(app, stream_event_topic, &normalized_event, turn_duration_ms);
    if matches!(&normalized_event, EngineEvent::ApprovalRequested { .. }) {
        let _ = app.emit(approval_event_topic, &normalized_event);
    }

    if state.config.debug.persist_engine_event_logs {
        let log_event = engine_event_for_debug_log(&normalized_event);
        if let Ok(value) = serde_json::to_value(&log_event) {
            if let Err(error) = run_db(state.db.clone(), {
                let thread_id = thread.id.clone();
                let assistant_message_id = assistant_message_id.to_string();
                let value = value.clone();
                move |db| {
                    db::actions::append_event_log(db, &thread_id, &assistant_message_id, &value)
                }
            })
            .await
            {
                log::warn!("failed to append engine event log: {error}");
            }
        }
    }

    match &normalized_event {
        EngineEvent::TurnStarted {
            native_turn_id: Some(native_turn_id),
            ..
        } => {
            if let Err(error) = run_db(state.db.clone(), {
                let assistant_message_id = assistant_message_id.to_string();
                let native_turn_id = native_turn_id.clone();
                move |db| {
                    db::messages::update_assistant_native_turn_id(
                        db,
                        &assistant_message_id,
                        &native_turn_id,
                    )
                }
            })
            .await
            {
                log::warn!("failed to persist Codex native turn id: {error}");
            }
        }
        EngineEvent::ActionStarted {
            action_id,
            engine_action_id,
            action_type,
            summary,
            details,
        } => {
            if let Err(error) = run_db(state.db.clone(), {
                let action_id = action_id.clone();
                let thread_id = thread.id.clone();
                let assistant_message_id = assistant_message_id.to_string();
                let engine_action_id = engine_action_id.clone();
                let action_type = action_type.clone();
                let summary = summary.clone();
                let details = details.clone();
                move |db| {
                    db::actions::insert_action_started(
                        db,
                        &action_id,
                        &thread_id,
                        &assistant_message_id,
                        engine_action_id.as_deref(),
                        &action_type,
                        &summary,
                        &details,
                    )
                }
            })
            .await
            {
                log::warn!("failed to persist action start: {error}");
            }
        }
        EngineEvent::ActionCompleted {
            action_id,
            result,
            details,
        } => {
            if let Err(error) = run_db(state.db.clone(), {
                let action_id = action_id.clone();
                let result = result.clone();
                let details = details.clone();
                move |db| {
                    db::actions::update_action_completed(db, &action_id, &result, details.as_ref())
                }
            })
            .await
            {
                log::warn!("failed to persist action completion: {error}");
            }
        }
        EngineEvent::ApprovalRequested {
            approval_id,
            action_type,
            summary,
            details,
        } => {
            match run_db(state.db.clone(), {
                let approval_id = approval_id.clone();
                let thread_id = thread.id.clone();
                let assistant_message_id = assistant_message_id.to_string();
                let action_type = action_type.clone();
                let summary = summary.clone();
                let details = details.clone();
                move |db| {
                    db::actions::insert_approval(
                        db,
                        &approval_id,
                        &thread_id,
                        &assistant_message_id,
                        &action_type,
                        &summary,
                        &details,
                    )
                }
            })
            .await
            {
                Ok(()) => {
                    emit_latest_thread_updated(app, state, thread, "approval request persist")
                        .await;
                }
                Err(error) => {
                    log::warn!("failed to persist approval: {error}");
                }
            }
        }
        EngineEvent::UsageLimitsUpdated { usage } if usage_snapshot_has_context_metrics(usage) => {
            if let Err(error) = run_db(state.db.clone(), {
                let thread_id = thread.id.clone();
                let usage = usage.clone();
                move |db| {
                    let current_thread = db::threads::get_thread(db, &thread_id)?
                        .ok_or_else(|| anyhow::anyhow!("thread not found: {thread_id}"))?;
                    let metadata = merge_context_usage_cache_into_metadata(
                        current_thread.engine_metadata,
                        &usage,
                    );
                    db::threads::update_engine_metadata(db, &thread_id, &metadata)
                }
            })
            .await
            {
                log::warn!("failed to persist context usage cache: {error}");
            }
        }
        _ => {}
    }

    let mut progress = apply_event_to_blocks(
        blocks,
        action_index,
        approval_index,
        &normalized_event,
        max_output_chars,
        turn_duration_ms,
    );

    if matches!(&normalized_event, EngineEvent::ApprovalRequested { .. }) {
        // Answers are persisted outside the streaming loop. Its block snapshot
        // may still contain an older pending request, so use persisted request
        // state when a new question arrives.
        match run_db(state.db.clone(), {
            let thread_id = thread.id.clone();
            move |db| {
                let conn = db.connect()?;
                db::threads::derive_thread_status_for_recovery(&conn, &thread_id)
            }
        })
        .await
        {
            Ok(status) => {
                progress.thread_status = Some(if status == ThreadStatusDto::AwaitingApproval {
                    status
                } else {
                    ThreadStatusDto::Streaming
                });
            }
            Err(error) => log::warn!("failed to reconcile question waiting state: {error}"),
        }
    }

    if matches!(&normalized_event, EngineEvent::TurnCompleted { .. }) {
        resolve_pending_approvals_for_terminal_message(state, assistant_message_id).await;
    }

    progress
}

#[allow(clippy::too_many_arguments)]
fn apply_stream_progress(
    progress: EventProgress,
    message_status: &mut MessageStatusDto,
    thread_status: &mut ThreadStatusDto,
    turn_model_id: &mut String,
    token_usage: &mut Option<(u64, u64)>,
    blocks_dirty: &mut bool,
    message_state_dirty: &mut bool,
    thread_status_dirty: &mut bool,
    turn_model_dirty: &mut bool,
) -> bool {
    if progress.blocks_changed {
        *blocks_dirty = true;
    }

    if let Some(status) = progress.message_status {
        if *message_status != status {
            *message_status = status;
            *message_state_dirty = true;
        }
    }

    if let Some(status) = progress.thread_status {
        if *thread_status != status {
            *thread_status = status;
            *thread_status_dirty = true;
        }
    }

    if let Some(next_turn_model_id) = progress.turn_model_id {
        if *turn_model_id != next_turn_model_id {
            *turn_model_id = next_turn_model_id;
            *turn_model_dirty = true;
        }
    }

    if let Some(tokens) = progress.token_usage {
        *token_usage = Some(tokens);
    }

    progress.force_persist
}

#[allow(clippy::too_many_arguments)]
async fn flush_stream_state(
    app: &tauri::AppHandle,
    state: &AppState,
    thread: &ThreadDto,
    assistant_message_id: &str,
    blocks: &[ContentBlock],
    message_status: &MessageStatusDto,
    thread_status: &ThreadStatusDto,
    turn_model_id: &str,
    blocks_dirty: &mut bool,
    message_state_dirty: &mut bool,
    thread_status_dirty: &mut bool,
    turn_model_dirty: &mut bool,
    last_persisted_thread_status: &mut ThreadStatusDto,
    last_persist_at: &mut Instant,
    last_blocks_persist_at: &mut Instant,
    force: bool,
) {
    if !*blocks_dirty && !*message_state_dirty && !*thread_status_dirty && !*turn_model_dirty {
        return;
    }

    let now = Instant::now();

    if *thread_status_dirty && *last_persisted_thread_status == *thread_status {
        *thread_status_dirty = false;
    }

    let should_flush_state =
        force || now.duration_since(*last_persist_at) >= STREAM_DB_FLUSH_INTERVAL;
    let should_flush_blocks =
        force || now.duration_since(*last_blocks_persist_at) >= STREAM_DB_BLOCKS_FLUSH_INTERVAL;

    if !should_flush_blocks && !should_flush_state {
        return;
    }

    let mut did_flush_state = false;
    let mut did_flush_blocks = false;

    if *blocks_dirty && should_flush_blocks {
        match serde_json::to_string(blocks) {
            Ok(blocks_json) => {
                if let Err(error) = run_db(state.db.clone(), {
                    let assistant_message_id = assistant_message_id.to_string();
                    let message_status = message_status.clone();
                    let turn_model_id = turn_model_id.to_string();
                    move |db| {
                        db::messages::update_assistant_blocks_json(
                            db,
                            &assistant_message_id,
                            &blocks_json,
                            message_status,
                            Some(turn_model_id.as_str()),
                        )
                    }
                })
                .await
                {
                    log::warn!("failed to persist assistant stream blocks: {error}");
                } else {
                    *blocks_dirty = false;
                    *message_state_dirty = false;
                    *turn_model_dirty = false;
                    did_flush_blocks = true;
                    did_flush_state = true;
                }
            }
            Err(error) => {
                log::warn!("failed to serialize assistant stream blocks: {error}");
            }
        }
    } else if *message_state_dirty && should_flush_state {
        if let Err(error) = run_db(state.db.clone(), {
            let assistant_message_id = assistant_message_id.to_string();
            let message_status = message_status.clone();
            move |db| {
                db::messages::update_assistant_status(db, &assistant_message_id, message_status)
            }
        })
        .await
        {
            log::warn!("failed to persist assistant stream status: {error}");
        } else {
            *message_state_dirty = false;
            did_flush_state = true;
        }
    }

    if *turn_model_dirty && should_flush_state {
        if let Err(error) = run_db(state.db.clone(), {
            let assistant_message_id = assistant_message_id.to_string();
            let turn_model_id = turn_model_id.to_string();
            move |db| {
                db::messages::update_assistant_turn_model_id(
                    db,
                    &assistant_message_id,
                    &turn_model_id,
                )
            }
        })
        .await
        {
            log::warn!("failed to persist assistant turn model id during stream: {error}");
        } else {
            *turn_model_dirty = false;
            did_flush_state = true;
        }
    }

    if *thread_status_dirty && should_flush_state && *last_persisted_thread_status != *thread_status
    {
        if let Err(error) = run_db(state.db.clone(), {
            let thread_id = thread.id.clone();
            let thread_status = thread_status.clone();
            move |db| db::threads::update_thread_status(db, &thread_id, thread_status)
        })
        .await
        {
            log::warn!("failed to persist thread status during stream: {error}");
        } else {
            *last_persisted_thread_status = thread_status.clone();
            *thread_status_dirty = false;
            did_flush_state = true;
            emit_latest_thread_updated(app, state, thread, "stream status persist").await;
        }
    }

    if did_flush_blocks {
        *last_blocks_persist_at = now;
    }
    if did_flush_state {
        *last_persist_at = now;
    }
}

async fn maybe_update_thread_title(
    state: &AppState,
    thread: &ThreadDto,
    engine_thread_id: &str,
    user_message: &str,
) -> Option<ThreadDto> {
    if !should_autotitle_thread(thread) {
        return None;
    }

    let candidate = state
        .engines
        .read_thread_preview(thread, engine_thread_id)
        .await
        .as_deref()
        .and_then(normalize_thread_title)
        .or_else(|| normalize_thread_title(user_message))?;

    if candidate == thread.title {
        return None;
    }

    let updated_thread = match run_db(state.db.clone(), {
        let thread_id = thread.id.clone();
        let expected_title = thread.title.clone();
        let candidate = candidate.clone();
        move |db| {
            let current_thread = db::threads::get_thread(db, &thread_id)?
                .ok_or_else(|| anyhow::anyhow!("thread not found: {thread_id}"))?;
            if !should_replace_automatic_thread_title(&current_thread, &expected_title) {
                return Ok(None);
            }

            db::threads::update_thread_title(db, &thread_id, &candidate)?;
            db::threads::get_thread(db, &thread_id)
        }
    })
    .await
    {
        Ok(Some(updated_thread)) => updated_thread,
        Ok(None) => return None,
        Err(error) => {
            log::warn!("failed to update thread title: {error}");
            return None;
        }
    };

    if let Err(error) = state
        .engines
        .set_thread_name(thread, engine_thread_id, &candidate)
        .await
    {
        log::debug!("failed to sync thread name with engine: {error}");
    }

    Some(updated_thread)
}

fn spawn_codex_thread_title_generation(
    app: tauri::AppHandle,
    state: AppState,
    thread: ThreadDto,
    engine_thread_id: String,
    opening_message: String,
) {
    tokio::spawn(async move {
        let generated = maybe_generate_thread_title(
            &app,
            &state,
            &thread,
            &engine_thread_id,
            &opening_message,
            &thread.title,
        )
        .await;

        if !generated
            && maybe_update_thread_title(&state, &thread, &engine_thread_id, &opening_message)
                .await
                .is_some()
        {
            emit_latest_thread_updated(&app, &state, &thread, "fallback title update").await;
        }
    });
}

async fn maybe_generate_thread_title(
    app: &tauri::AppHandle,
    state: &AppState,
    thread: &ThreadDto,
    engine_thread_id: &str,
    opening_message: &str,
    expected_title: &str,
) -> bool {
    let generated_title = match state
        .engines
        .generate_codex_thread_title(opening_message)
        .await
    {
        Ok(title) => title,
        Err(error) => {
            log::debug!("failed to generate AI thread title: {error:#}");
            return false;
        }
    };
    let Some(candidate) = normalize_thread_title(&generated_title) else {
        return false;
    };
    if candidate == expected_title {
        return false;
    }

    let applied = match run_db(state.db.clone(), {
        let thread_id = thread.id.clone();
        let expected_title = expected_title.to_string();
        let candidate = candidate.clone();
        move |db| {
            let current_thread = db::threads::get_thread(db, &thread_id)?
                .ok_or_else(|| anyhow::anyhow!("thread not found: {thread_id}"))?;
            if !should_replace_automatic_thread_title(&current_thread, &expected_title) {
                return Ok(false);
            }

            db::threads::update_thread_title(db, &thread_id, &candidate)?;
            Ok(true)
        }
    })
    .await
    {
        Ok(applied) => applied,
        Err(error) => {
            log::warn!("failed to apply AI thread title: {error}");
            return false;
        }
    };
    if !applied {
        return false;
    }

    emit_latest_thread_updated(app, state, thread, "AI title update").await;

    if let Err(error) = state
        .engines
        .set_thread_name(thread, engine_thread_id, &candidate)
        .await
    {
        log::debug!("failed to sync AI thread title with engine: {error}");
    }

    emit_latest_thread_updated(app, state, thread, "AI title sync completion").await;

    true
}

fn should_replace_automatic_thread_title(thread: &ThreadDto, expected_title: &str) -> bool {
    thread.title == expected_title && !thread_manual_title_locked(thread.engine_metadata.as_ref())
}

fn should_generate_codex_thread_title(thread: &ThreadDto) -> bool {
    thread.engine_id == "codex" && should_autotitle_thread(thread)
}

fn should_autotitle_thread(thread: &ThreadDto) -> bool {
    thread.message_count == 0 && !thread_manual_title_locked(thread.engine_metadata.as_ref())
}

fn thread_manual_title_locked(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(|value| value.get("manualTitle"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn normalize_thread_title(raw: &str) -> Option<String> {
    let compact = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title = compact.trim_matches(|c| c == '"' || c == '\'').to_string();
    if title.is_empty() {
        return None;
    }

    if title.chars().count() > MAX_THREAD_TITLE_CHARS {
        title = truncate_title(title, MAX_THREAD_TITLE_CHARS);
    }

    Some(title)
}

fn truncate_title(value: String, max_chars: usize) -> String {
    let count = value.chars().count();
    if count <= max_chars {
        return value;
    }

    if max_chars <= 3 {
        return value.chars().take(max_chars).collect::<String>();
    }

    let mut output = value.chars().take(max_chars - 3).collect::<String>();
    output.push_str("...");
    output
}

fn normalize_chat_notification_preview(raw: &str) -> Option<String> {
    let compact = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = compact.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(truncate_title(
        trimmed.to_string(),
        MAX_CHAT_NOTIFICATION_PREVIEW_CHARS,
    ))
}

fn chat_notification_preview(blocks: &[ContentBlock]) -> Option<String> {
    for block in blocks {
        match block {
            ContentBlock::Text {
                is_steer: Some(true),
                ..
            } => {}
            ContentBlock::Text { content, .. }
            | ContentBlock::Thinking { content, .. }
            | ContentBlock::Error { message: content } => {
                if let Some(preview) = normalize_chat_notification_preview(content) {
                    return Some(preview);
                }
            }
            ContentBlock::Notice {
                kind,
                message,
                title,
                ..
            } => {
                if kind == "context_compacted" || kind.starts_with("codex_context_compaction_") {
                    continue;
                }
                if let Some(preview) = normalize_chat_notification_preview(message) {
                    return Some(preview);
                }
                if let Some(preview) = normalize_chat_notification_preview(title) {
                    return Some(preview);
                }
            }
            _ => {}
        }
    }

    None
}

fn emit_chat_turn_finished(
    app: &tauri::AppHandle,
    thread: &ThreadDto,
    assistant_message_id: &str,
    client_turn_id: Option<&str>,
    status: &MessageStatusDto,
    blocks: &[ContentBlock],
) {
    let event = build_chat_turn_finished_event(
        thread,
        assistant_message_id,
        client_turn_id,
        status,
        blocks,
    );
    let _ = app.emit("chat-turn-finished", event);
}

fn build_chat_turn_finished_event(
    thread: &ThreadDto,
    assistant_message_id: &str,
    client_turn_id: Option<&str>,
    status: &MessageStatusDto,
    blocks: &[ContentBlock],
) -> ChatTurnFinishedEvent {
    ChatTurnFinishedEvent {
        thread_id: thread.id.clone(),
        workspace_id: thread.workspace_id.clone(),
        repo_id: thread.repo_id.clone(),
        engine_id: thread.engine_id.clone(),
        thread_title: thread.title.clone(),
        assistant_message_id: assistant_message_id.to_string(),
        client_turn_id: client_turn_id.map(ToOwned::to_owned),
        thread_status: thread.status.as_str().to_string(),
        status: match status {
            MessageStatusDto::Completed => "completed",
            MessageStatusDto::Interrupted => "interrupted",
            MessageStatusDto::Error => "error",
            MessageStatusDto::Streaming => "completed",
        }
        .to_string(),
        preview: chat_notification_preview(blocks),
    }
}

fn build_final_thread_event(
    latest_thread: Option<ThreadDto>,
    fallback_thread: &ThreadDto,
) -> (ThreadUpdatedEvent, Option<ThreadDto>) {
    match latest_thread {
        Some(latest_thread) => (
            ThreadUpdatedEvent {
                thread_id: latest_thread.id.clone(),
                workspace_id: latest_thread.workspace_id.clone(),
                thread: Some(latest_thread.clone()),
            },
            Some(latest_thread),
        ),
        None => (
            ThreadUpdatedEvent {
                thread_id: fallback_thread.id.clone(),
                workspace_id: fallback_thread.workspace_id.clone(),
                thread: None,
            },
            None,
        ),
    }
}

async fn emit_latest_thread_updated(
    app: &tauri::AppHandle,
    state: &AppState,
    thread: &ThreadDto,
    log_context: &str,
) {
    let latest_thread = run_db(state.db.clone(), {
        let thread_id = thread.id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await
    .unwrap_or_else(|error| {
        log::warn!("failed to load thread for {log_context}: {error}");
        None
    });
    let (thread_updated_event, _) = build_final_thread_event(latest_thread, thread);
    let _ = app.emit("thread-updated", thread_updated_event);
}

fn apply_event_to_blocks(
    blocks: &mut Vec<ContentBlock>,
    action_index: &mut HashMap<String, usize>,
    approval_index: &mut HashMap<String, usize>,
    event: &EngineEvent,
    max_output_chars: usize,
    _turn_duration_ms: Option<u64>,
) -> EventProgress {
    let mut progress = EventProgress::default();

    match event {
        EngineEvent::TurnStarted { .. } => {
            progress.thread_status = Some(ThreadStatusDto::Streaming);
        }
        EngineEvent::TurnSnapshotRecovered { blocks: recovered } => {
            let mut next_blocks = Vec::with_capacity(recovered.len());
            for block in recovered {
                match serde_json::from_value::<ContentBlock>(block.clone()) {
                    Ok(ContentBlock::Notice { kind, .. }) if kind == "turn_status" => {}
                    Ok(block) => next_blocks.push(block),
                    Err(error) => {
                        log::warn!("failed to decode recovered turn block: {error}");
                    }
                }
            }

            if !next_blocks.is_empty() {
                *blocks = next_blocks;
                rebuild_block_indexes(blocks, action_index, approval_index);
                progress.blocks_changed = true;
                progress.force_persist = true;
            }
        }
        EngineEvent::TurnCompleted {
            token_usage,
            status,
            diagnostics,
        } => {
            progress.force_persist = true;
            let source = diagnostics.as_ref().map(|value| &value.source);
            progress.blocks_changed |= terminalize_unresolved_turn_blocks(blocks, status, source);
            progress.message_status = Some(match status {
                TurnCompletionStatus::Completed => MessageStatusDto::Completed,
                TurnCompletionStatus::Interrupted => MessageStatusDto::Interrupted,
                TurnCompletionStatus::Failed => MessageStatusDto::Error,
            });
            progress.thread_status = Some(match status {
                TurnCompletionStatus::Completed => ThreadStatusDto::Completed,
                TurnCompletionStatus::Interrupted => ThreadStatusDto::Idle,
                TurnCompletionStatus::Failed => ThreadStatusDto::Error,
            });
            progress.token_usage = token_usage
                .as_ref()
                .map(|usage| (usage.input, usage.output));
        }
        EngineEvent::TextDelta { content } => {
            progress.blocks_changed = append_text_delta(blocks, content);
        }
        EngineEvent::ThinkingDelta { content } => {
            progress.blocks_changed = append_thinking_delta(blocks, content);
        }
        EngineEvent::ActionStarted {
            action_id,
            engine_action_id,
            action_type,
            summary,
            details,
        } => {
            let block = ContentBlock::Action {
                action_id: action_id.to_string(),
                engine_action_id: engine_action_id.clone(),
                action_type: action_type.as_str().to_string(),
                summary: summary.to_string(),
                details: value_to_raw(details),
                output_chunks: Vec::new(),
                status: "running".to_string(),
                result: None,
            };
            progress.blocks_changed = upsert_action_block(blocks, action_index, action_id, block);
        }
        EngineEvent::ActionOutputDelta {
            action_id,
            stream,
            content,
        } => {
            if let Some(index) = action_index.get(action_id).copied() {
                if let Some(ContentBlock::Action {
                    output_chunks,
                    details,
                    ..
                }) = blocks.get_mut(index)
                {
                    let stream_name = match stream {
                        OutputStream::Stdout => "stdout",
                        OutputStream::Stderr => "stderr",
                        OutputStream::Stdin => "stdin",
                    };
                    let chunk_content = truncate_chars(content, max_output_chars);
                    if chunk_content.is_empty() {
                        return progress;
                    }

                    if let Some(previous_chunk) = output_chunks.last_mut() {
                        if previous_chunk.stream == stream_name {
                            previous_chunk.content.push_str(&chunk_content);
                        } else {
                            output_chunks.push(ActionOutputChunk {
                                stream: stream_name.to_string(),
                                content: chunk_content,
                            });
                        }
                    } else {
                        output_chunks.push(ActionOutputChunk {
                            stream: stream_name.to_string(),
                            content: chunk_content,
                        });
                    }

                    if trim_action_output_chunks(output_chunks, max_output_chars) {
                        mark_output_truncated(details);
                    }
                    progress.blocks_changed = true;
                }
            }
        }
        EngineEvent::ActionProgressUpdated { action_id, message } => {
            if let Some(index) = action_index.get(action_id).copied() {
                if let Some(ContentBlock::Action { details, .. }) = blocks.get_mut(index) {
                    progress.blocks_changed = update_action_progress(details, message);
                }
            }
        }
        EngineEvent::ActionCompleted {
            action_id,
            result,
            details: completed_details,
        } => {
            if let Some(index) = action_index.get(action_id).copied() {
                if let Some(ContentBlock::Action {
                    details,
                    status,
                    result: block_result,
                    ..
                }) = blocks.get_mut(index)
                {
                    if let Some(completed_details) = completed_details {
                        merge_action_details(details, completed_details);
                    }
                    *status = if result.success { "done" } else { "error" }.to_string();
                    *block_result = Some(ActionBlockResult {
                        success: result.success,
                        output: result.output.clone(),
                        error: result.error.clone(),
                        diff: result.diff.clone(),
                        duration_ms: result.duration_ms,
                    });
                    progress.blocks_changed = true;
                }
            }
        }
        EngineEvent::DiffUpdated { diff, scope } => {
            let scope = match scope {
                crate::engines::DiffScope::Turn => "turn",
                crate::engines::DiffScope::File => "file",
                crate::engines::DiffScope::Workspace => "workspace",
            }
            .to_string();

            let latest_matching_index =
                blocks.iter().enumerate().rev().find_map(|(index, block)| {
                    if let ContentBlock::Diff {
                        scope: block_scope, ..
                    } = block
                    {
                        if block_scope == &scope {
                            return Some(index);
                        }
                    }
                    None
                });

            if let Some(latest_matching_index) = latest_matching_index {
                let mut next_blocks = Vec::with_capacity(blocks.len());
                for (index, mut block) in blocks.drain(..).enumerate() {
                    if let ContentBlock::Diff {
                        diff: block_diff,
                        scope: block_scope,
                    } = &mut block
                    {
                        if block_scope == &scope {
                            if index == latest_matching_index {
                                if block_diff != diff {
                                    *block_diff = diff.to_string();
                                }
                                next_blocks.push(block);
                            }
                            continue;
                        }
                    }
                    next_blocks.push(block);
                }
                *blocks = next_blocks;
                rebuild_block_indexes(blocks, action_index, approval_index);
            } else {
                blocks.push(ContentBlock::Diff {
                    diff: diff.to_string(),
                    scope,
                });
            }
            progress.blocks_changed = true;
        }
        EngineEvent::ModelRerouted {
            from_model,
            to_model,
            reason,
        } => {
            let block = ContentBlock::Notice {
                kind: "model_rerouted".to_string(),
                level: "info".to_string(),
                title: "Model rerouted".to_string(),
                message: format_model_reroute_notice(from_model, to_model, reason),
                details: None,
            };
            progress.blocks_changed = upsert_notice_block(
                blocks,
                action_index,
                approval_index,
                "model_rerouted",
                block,
            );
            progress.turn_model_id = Some(to_model.to_string());
            progress.force_persist = true;
        }
        EngineEvent::Notice {
            kind,
            level,
            title,
            message,
            details,
        } => {
            if kind == "turn_status" {
                return progress;
            }
            let block = ContentBlock::Notice {
                kind: kind.to_string(),
                level: level.to_string(),
                title: title.to_string(),
                message: message.to_string(),
                details: details.as_ref().filter(|items| !items.is_empty()).cloned(),
            };
            progress.blocks_changed =
                upsert_notice_block(blocks, action_index, approval_index, kind, block);
            progress.force_persist = true;
        }
        EngineEvent::ApprovalRequested {
            approval_id,
            action_type,
            summary,
            details,
        } => {
            let block = ContentBlock::Approval {
                approval_id: approval_id.to_string(),
                action_type: action_type.as_str().to_string(),
                summary: summary.to_string(),
                details: value_to_raw(details),
                status: "pending".to_string(),
                decision: None,
            };
            progress.blocks_changed =
                upsert_approval_block(blocks, approval_index, approval_id, block);
            let has_blocking_request = blocks.iter().any(|block| match block {
                ContentBlock::Approval {
                    details, status, ..
                } if status == "pending" => {
                    let details = serde_json::from_str(details.get()).unwrap_or(Value::Null);
                    crate::engines::is_blocking_approval(&details)
                }
                _ => false,
            });
            progress.thread_status = Some(if has_blocking_request {
                ThreadStatusDto::AwaitingApproval
            } else {
                ThreadStatusDto::Streaming
            });
            progress.force_persist = true;
        }
        EngineEvent::Error {
            message,
            recoverable,
        } => {
            blocks.push(ContentBlock::Error {
                message: message.to_string(),
            });
            progress.blocks_changed = true;
            if !recoverable {
                progress.message_status = Some(MessageStatusDto::Error);
                progress.thread_status = Some(ThreadStatusDto::Error);
                progress.force_persist = true;
            }
        }
        EngineEvent::UsageLimitsUpdated { .. } => {}
        EngineEvent::CodexNativeEvent { .. } => {}
    }

    progress
}

fn append_text_delta(blocks: &mut Vec<ContentBlock>, content: &str) -> bool {
    if content.is_empty() {
        return false;
    }

    if let Some(ContentBlock::Text {
        content: current, ..
    }) = blocks.last_mut()
    {
        current.push_str(content);
        return true;
    }

    blocks.push(ContentBlock::Text {
        content: content.to_string(),
        plan_mode: None,
        is_steer: None,
    });
    true
}

fn append_thinking_delta(blocks: &mut Vec<ContentBlock>, content: &str) -> bool {
    if content.is_empty() {
        return false;
    }

    if let Some(ContentBlock::Thinking {
        content: current, ..
    }) = blocks.last_mut()
    {
        current.push_str(content);
        return true;
    }

    blocks.push(ContentBlock::Thinking {
        content: content.to_string(),
        started_at: None,
        duration_ms: None,
    });
    true
}

fn update_action_progress(details: &mut Box<RawValue>, message: &str) -> bool {
    let mut value: Value = serde_json::from_str(details.get())
        .unwrap_or_else(|_| Value::Object(serde_json::Map::new()));

    let current_message = value
        .get("progressMessage")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let current_kind = value
        .get("progressKind")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    if current_message.as_deref() == Some(message) && current_kind.as_deref() == Some("mcp") {
        return false;
    }

    if !value.is_object() {
        value = Value::Object(serde_json::Map::new());
    }

    if let Some(details_object) = value.as_object_mut() {
        details_object.insert("progressKind".to_string(), Value::String("mcp".to_string()));
        details_object.insert(
            "progressMessage".to_string(),
            Value::String(message.to_string()),
        );
        *details = value_to_raw(&value);
        return true;
    }

    false
}

fn merge_action_details(details: &mut Box<RawValue>, completed_details: &Value) {
    let mut value: Value = serde_json::from_str(details.get())
        .unwrap_or_else(|_| Value::Object(serde_json::Map::new()));
    match (&mut value, completed_details) {
        (Value::Object(existing), Value::Object(completed)) => {
            for (key, completed_value) in completed {
                existing.insert(key.clone(), completed_value.clone());
            }
        }
        (_, completed) => value = completed.clone(),
    }
    *details = value_to_raw(&value);
}

fn upsert_action_block(
    blocks: &mut Vec<ContentBlock>,
    action_index: &mut HashMap<String, usize>,
    action_id: &str,
    block: ContentBlock,
) -> bool {
    if let Some(index) = action_index.get(action_id).copied() {
        if let Some(existing) = blocks.get_mut(index) {
            *existing = block;
            return true;
        }
    }

    let index = blocks.len();
    blocks.push(block);
    action_index.insert(action_id.to_string(), index);
    true
}

fn upsert_approval_block(
    blocks: &mut Vec<ContentBlock>,
    approval_index: &mut HashMap<String, usize>,
    approval_id: &str,
    block: ContentBlock,
) -> bool {
    if let Some(index) = approval_index.get(approval_id).copied() {
        if let Some(existing) = blocks.get_mut(index) {
            *existing = block;
            return true;
        }
    }

    let index = blocks.len();
    blocks.push(block);
    approval_index.insert(approval_id.to_string(), index);
    true
}

fn upsert_notice_block(
    blocks: &mut Vec<ContentBlock>,
    action_index: &mut HashMap<String, usize>,
    approval_index: &mut HashMap<String, usize>,
    kind: &str,
    block: ContentBlock,
) -> bool {
    if let Some(index) = blocks.iter().position(|existing| {
        matches!(
            existing,
            ContentBlock::Notice {
                kind: existing_kind,
                ..
            } if existing_kind == kind
        )
    }) {
        if let Some(existing) = blocks.get_mut(index) {
            *existing = block;
            return true;
        }
    }

    // A notice is part of the event stream, not message metadata. Keep its
    // first-observed position; later updates of the same kind stay in place.
    blocks.push(block);
    rebuild_block_indexes(blocks, action_index, approval_index);
    true
}

fn rebuild_block_indexes(
    blocks: &[ContentBlock],
    action_index: &mut HashMap<String, usize>,
    approval_index: &mut HashMap<String, usize>,
) {
    action_index.clear();
    approval_index.clear();

    for (index, block) in blocks.iter().enumerate() {
        match block {
            ContentBlock::Action { action_id, .. } => {
                action_index.insert(action_id.clone(), index);
            }
            ContentBlock::Approval { approval_id, .. } => {
                approval_index.insert(approval_id.clone(), index);
            }
            _ => {}
        }
    }
}

fn format_model_reroute_notice(from_model: &str, to_model: &str, reason: &str) -> String {
    format!("Switched from {from_model} to {to_model} ({reason}).")
}

fn trim_action_output_chunks(
    output_chunks: &mut Vec<ActionOutputChunk>,
    max_output_chars: usize,
) -> bool {
    let mut truncated = false;

    if output_chunks.len() > ACTION_OUTPUT_MAX_CHUNKS {
        let overflow = output_chunks.len() - ACTION_OUTPUT_MAX_CHUNKS;
        output_chunks.drain(0..overflow);
        truncated = true;
    }

    let max_chars = max_output_chars.max(1);
    let total_chars: usize = output_chunks.iter().map(|chunk| chunk.content.len()).sum();
    if total_chars <= max_chars {
        return truncated;
    }

    let target_chars = max_chars.saturating_mul(2) / 3;
    let chars_to_trim = total_chars.saturating_sub(target_chars.max(1));
    if chars_to_trim == 0 {
        return truncated;
    }

    let mut remaining_to_trim = chars_to_trim;
    let mut remove_count = 0usize;
    for chunk in output_chunks.iter_mut() {
        if remaining_to_trim == 0 {
            break;
        }
        let chunk_len = chunk.content.len();
        if chunk_len <= remaining_to_trim {
            remaining_to_trim -= chunk_len;
            remove_count += 1;
            continue;
        }

        chunk.content = trim_string_start_bytes(&chunk.content, remaining_to_trim);
        remaining_to_trim = 0;
        truncated = true;
    }

    if remove_count > 0 {
        output_chunks.drain(0..remove_count);
        truncated = true;
    }

    truncated
}

fn engine_event_for_debug_log(event: &EngineEvent) -> EngineEvent {
    match event {
        EngineEvent::ActionOutputDelta {
            action_id,
            stream,
            content,
        } => EngineEvent::ActionOutputDelta {
            action_id: action_id.clone(),
            stream: stream.clone(),
            content: truncate_chars_within_limit(content, ENGINE_EVENT_LOG_ACTION_OUTPUT_MAX_CHARS),
        },
        _ => event.clone(),
    }
}

fn trim_string_start_bytes(value: &str, bytes_to_trim: usize) -> String {
    if bytes_to_trim == 0 {
        return value.to_string();
    }
    if bytes_to_trim >= value.len() {
        return String::new();
    }

    let start = value
        .char_indices()
        .map(|(index, _)| index)
        .find(|index| *index >= bytes_to_trim)
        .unwrap_or(value.len());
    value[start..].to_string()
}

fn mark_output_truncated(details: &mut Box<RawValue>) {
    let mut value: Value = serde_json::from_str(details.get())
        .unwrap_or_else(|_| Value::Object(serde_json::Map::new()));

    if !value.is_object() {
        value = Value::Object(serde_json::Map::new());
    }

    if let Some(details_object) = value.as_object_mut() {
        details_object.insert("outputTruncated".to_string(), Value::Bool(true));
        *details = value_to_raw(&value);
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let mut output = value.chars().take(max_chars).collect::<String>();
    output.push_str(TRUNCATED_SUFFIX);
    output
}

fn truncate_chars_within_limit(value: &str, max_chars: usize) -> String {
    let max_chars = max_chars.max(1);
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    if max_chars <= TRUNCATED_SUFFIX.len() {
        return value.chars().take(max_chars).collect();
    }

    let mut output = value
        .chars()
        .take(max_chars - TRUNCATED_SUFFIX.len())
        .collect::<String>();
    output.push_str(TRUNCATED_SUFFIX);
    output
}

fn truncate_action_result_output(
    result: &mut crate::engines::events::ActionResult,
    max_chars: usize,
) {
    let Some(output) = result.output.as_ref() else {
        return;
    };

    let truncated = truncate_chars(output, max_chars.max(1));
    if truncated != *output {
        result.output = Some(truncated);
    }
}

fn workspace_write_opt_in_enabled(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(|value| value.get("workspaceWriteOptIn"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn aggregate_workspace_trust_level(repos: &[RepoDto]) -> TrustLevelDto {
    if repos
        .iter()
        .any(|repo| matches!(repo.trust_level, TrustLevelDto::Restricted))
    {
        return TrustLevelDto::Restricted;
    }

    if !repos.is_empty()
        && repos
            .iter()
            .all(|repo| matches!(repo.trust_level, TrustLevelDto::Trusted))
    {
        return TrustLevelDto::Trusted;
    }

    TrustLevelDto::Standard
}

fn approval_policy_for_engine_and_trust_level(
    _engine_id: &str,
    _trust_level: &TrustLevelDto,
) -> &'static str {
    "never"
}

fn allow_network_for_trust_level(_trust_level: &TrustLevelDto) -> bool {
    true
}

fn default_sandbox_mode_for_engine(_engine_id: &str) -> &'static str {
    "danger-full-access"
}

fn thread_approval_policy_override_value(
    _engine_id: &str,
    metadata: Option<&Value>,
) -> Result<Option<Value>, String> {
    metadata
        .and_then(|value| value.get("sandboxApprovalPolicy"))
        .map(normalize_codex_approval_policy_value)
        .transpose()
}

fn thread_allow_network_override(metadata: Option<&Value>) -> Option<bool> {
    metadata
        .and_then(|value| value.get("sandboxAllowNetwork"))
        .and_then(Value::as_bool)
}

fn thread_sandbox_mode(metadata: Option<&Value>) -> Result<Option<String>, String> {
    let value = metadata
        .and_then(|value| value.get("sandboxMode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let Some(value) = value else {
        return Ok(None);
    };

    let normalized = match value.to_lowercase().as_str() {
        "readonly" | "read-only" | "read_only" => "read-only",
        "workspacewrite" | "workspace-write" | "workspace_write" => "workspace-write",
        "dangerfullaccess" | "danger-full-access" | "danger_full_access" => {
            "danger-full-access"
        }
        _ => {
            return Err(format!(
                "invalid sandbox mode `{value}` on thread metadata. expected one of: read-only, workspace-write, danger-full-access"
            ))
        }
    };

    Ok(Some(normalized.to_string()))
}

fn workspace_writable_roots_from_metadata(
    metadata: Option<&Value>,
) -> Result<Option<Vec<String>>, String> {
    let Some(raw_roots) = metadata.and_then(|value| value.get("workspaceWritableRoots")) else {
        return Ok(None);
    };

    let roots = raw_roots.as_array().ok_or_else(|| {
        "invalid `workspaceWritableRoots` on thread metadata. expected an array of paths"
            .to_string()
    })?;

    let mut normalized = Vec::with_capacity(roots.len());
    for root in roots {
        let root = root.as_str().map(str::trim).filter(|value| !value.is_empty()).ok_or_else(
            || {
                "invalid `workspaceWritableRoots` on thread metadata. expected non-empty string paths"
                    .to_string()
            },
        )?;
        normalized.push(root.to_string());
    }

    Ok(Some(normalized))
}

struct WorkspaceWritableRootsResolution {
    roots: Vec<String>,
    requires_confirmation: bool,
}

fn resolve_workspace_writable_roots<'a>(
    repo_paths: impl IntoIterator<Item = &'a str>,
    workspace_root: &str,
    metadata: Option<&Value>,
) -> Result<WorkspaceWritableRootsResolution, String> {
    let available_roots: Vec<String> = repo_paths.into_iter().map(ToOwned::to_owned).collect();
    let confirmed_roots = workspace_writable_roots_from_metadata(metadata)?;

    if let Some(confirmed_roots) = confirmed_roots {
        if confirmed_roots.is_empty() {
            return Ok(WorkspaceWritableRootsResolution {
                roots: vec![workspace_root.to_string()],
                requires_confirmation: false,
            });
        }

        let available_set: std::collections::HashSet<&str> =
            available_roots.iter().map(String::as_str).collect();
        let mut filtered_roots = Vec::with_capacity(confirmed_roots.len());
        for root in confirmed_roots {
            if available_set.contains(root.as_str()) {
                filtered_roots.push(root);
            }
        }
        if !filtered_roots.is_empty() {
            return Ok(WorkspaceWritableRootsResolution {
                roots: filtered_roots,
                requires_confirmation: false,
            });
        }

        return Ok(match available_roots.len() {
            0 => WorkspaceWritableRootsResolution {
                roots: vec![workspace_root.to_string()],
                requires_confirmation: false,
            },
            1 => WorkspaceWritableRootsResolution {
                roots: available_roots,
                requires_confirmation: false,
            },
            _ => WorkspaceWritableRootsResolution {
                roots: available_roots,
                requires_confirmation: true,
            },
        });
    }

    if available_roots.is_empty() {
        Ok(WorkspaceWritableRootsResolution {
            roots: vec![workspace_root.to_string()],
            requires_confirmation: false,
        })
    } else {
        Ok(WorkspaceWritableRootsResolution {
            roots: available_roots,
            requires_confirmation: false,
        })
    }
}

fn sandbox_mode_requires_workspace_opt_in(mode: &str) -> bool {
    mode.eq_ignore_ascii_case("workspace-write")
}

fn workspace_write_confirmation_required(
    resolution: Option<&WorkspaceWritableRootsResolution>,
    sandbox_mode: &str,
    opt_in_enabled: bool,
) -> bool {
    let Some(resolution) = resolution else {
        return false;
    };

    sandbox_mode_requires_workspace_opt_in(sandbox_mode)
        && (resolution.requires_confirmation || (resolution.roots.len() > 1 && !opt_in_enabled))
}

fn unsupported_thread_sandbox_override_for_external_sandbox(
    sandbox_mode: Option<&str>,
    external_sandbox_active: bool,
) -> bool {
    external_sandbox_active && matches!(sandbox_mode, Some("read-only" | "workspace-write"))
}

fn thread_reasoning_effort(metadata: Option<&Value>) -> Option<String> {
    metadata
        .and_then(|value| value.get("reasoningEffort"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn thread_last_model_id(metadata: Option<&Value>) -> Option<String> {
    metadata
        .and_then(|value| value.get("lastModelId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn thread_service_tier(metadata: Option<&Value>) -> Option<String> {
    metadata
        .and_then(|value| value.get("serviceTier"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| matches!(*value, "fast" | "flex"))
        .map(ToOwned::to_owned)
}

fn thread_personality(metadata: Option<&Value>) -> Option<String> {
    metadata
        .and_then(|value| value.get("personality"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| matches!(*value, "none" | "friendly" | "pragmatic"))
        .map(ToOwned::to_owned)
}

fn thread_output_schema(metadata: Option<&Value>) -> Option<Value> {
    metadata
        .and_then(|value| value.get("outputSchema"))
        .cloned()
}

fn thread_permission_profile(metadata: Option<&Value>) -> Option<Value> {
    metadata
        .and_then(|value| value.get("permissionProfile"))
        .cloned()
}

fn thread_approvals_reviewer(metadata: Option<&Value>) -> Option<String> {
    metadata
        .and_then(|value| value.get("approvalsReviewer"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_reasoning_effort_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
}

fn resolve_reasoning_effort_for_model(
    model: &EngineModelDto,
    requested_effort: Option<&str>,
) -> Option<String> {
    let normalized_requested = normalize_reasoning_effort_value(requested_effort);
    if let Some(requested) = normalized_requested.as_ref() {
        if model
            .supported_reasoning_efforts
            .iter()
            .any(|option| option.reasoning_effort == *requested)
        {
            return Some(requested.clone());
        }
    }

    let normalized_default =
        normalize_reasoning_effort_value(Some(model.default_reasoning_effort.as_str()));
    if let Some(default_effort) = normalized_default.as_ref() {
        if model
            .supported_reasoning_efforts
            .iter()
            .any(|option| option.reasoning_effort == *default_effort)
        {
            return Some(default_effort.clone());
        }
    }

    model
        .supported_reasoning_efforts
        .iter()
        .map(|option| option.reasoning_effort.trim())
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or(normalized_default)
        .or(normalized_requested)
}

fn resolve_reasoning_effort_from_catalog(
    engines: &[EngineInfoDto],
    engine_id: &str,
    model_id: &str,
    requested_effort: Option<&str>,
) -> Option<String> {
    let normalized_requested = normalize_reasoning_effort_value(requested_effort);
    let Some(model) = engines
        .iter()
        .find(|engine| engine.id == engine_id)
        .and_then(|engine| engine.models.iter().find(|model| model.id == model_id))
    else {
        return normalized_requested;
    };

    resolve_reasoning_effort_for_model(model, normalized_requested.as_deref())
}

fn normalize_codex_approval_policy_value(value: &Value) -> Result<Value, String> {
    match value {
        Value::String(raw) => {
            let normalized = raw.trim().to_lowercase();
            let normalized = normalized.as_str();
            if matches!(
                normalized,
                "untrusted" | "on-failure" | "on-request" | "never"
            ) {
                Ok(Value::String(normalized.to_string()))
            } else {
                Err(format!(
                    "invalid approval policy `{normalized}`. expected one of: untrusted, on-failure, on-request, never"
                ))
            }
        }
        Value::Object(object) => {
            let reject = object
                .get("reject")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    "invalid structured approval policy. expected a `reject` object".to_string()
                })?;

            for required_key in ["mcp_elicitations", "rules", "sandbox_approval"] {
                if reject.get(required_key).and_then(Value::as_bool).is_none() {
                    return Err(format!(
                        "invalid structured approval policy. missing boolean reject.{required_key}"
                    ));
                }
            }

            if reject.contains_key("request_permissions")
                && reject
                    .get("request_permissions")
                    .and_then(Value::as_bool)
                    .is_none()
            {
                return Err(
                    "invalid structured approval policy. reject.request_permissions must be a boolean"
                        .to_string(),
                );
            }

            Ok(Value::Object(object.clone()))
        }
        _ => Err(
            "invalid approval policy. expected a string mode or structured reject object"
                .to_string(),
        ),
    }
}

#[cfg(test)]
// Catalog helpers follow this long-established inline command-test module.
#[allow(clippy::items_after_test_module)]
mod tests {
    use std::{fs, sync::Arc};

    use super::*;
    use crate::{
        config::app_config::AppConfig,
        db,
        engines::EngineManager,
        models::{EngineCapabilitiesDto, ReasoningEffortOptionDto},
        power::KeepAwakeManager,
        state::{AppState, TurnManager},
    };
    use rusqlite::params;
    use uuid::Uuid;

    fn test_app_state() -> AppState {
        let root = std::env::temp_dir().join(format!("panes-chat-cmd-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("failed to create temp root");
        let db = crate::db::Database::open(root.join("workspaces.db"))
            .expect("failed to create test database");
        AppState {
            db,
            config: Arc::new(AppConfig::default()),
            engines: Arc::new(EngineManager::new()),
            keep_awake: Arc::new(KeepAwakeManager::new()),
            turns: Arc::new(TurnManager::default()),
            pending_forks: Arc::new(crate::state::PendingThreadMutationManager::default()),
            pending_rollbacks: Arc::new(crate::state::PendingThreadMutationManager::default()),
        }
    }

    fn test_thread(state: &AppState, engine_id: &str, model_id: &str) -> ThreadDto {
        let workspace_root =
            std::env::temp_dir().join(format!("panes-chat-workspace-{}", Uuid::new_v4()));
        fs::create_dir_all(&workspace_root).expect("failed to create workspace root");
        let workspace = db::workspaces::upsert_workspace(
            &state.db,
            workspace_root.to_string_lossy().as_ref(),
            Some(1),
        )
        .expect("failed to create workspace");
        db::threads::create_thread(
            &state.db,
            &workspace.id,
            None,
            engine_id,
            model_id,
            "Thread",
        )
        .expect("failed to create thread")
    }

    #[test]
    fn automatic_title_only_replaces_the_untouched_title() {
        let state = test_app_state();
        let mut thread = test_thread(&state, "codex", "gpt-test");
        thread.title = "Opening prompt".to_string();

        assert!(should_replace_automatic_thread_title(
            &thread,
            "Opening prompt"
        ));

        thread.title = "A newer title".to_string();
        assert!(!should_replace_automatic_thread_title(
            &thread,
            "Opening prompt"
        ));

        thread.title = "Opening prompt".to_string();
        thread.engine_metadata = Some(json!({ "manualTitle": true }));
        assert!(!should_replace_automatic_thread_title(
            &thread,
            "Opening prompt"
        ));
    }

    #[test]
    fn codex_title_generation_only_starts_for_an_unrenamed_first_turn() {
        let state = test_app_state();
        let mut thread = test_thread(&state, "codex", "gpt-test");

        assert!(should_generate_codex_thread_title(&thread));

        thread.message_count = 1;
        assert!(!should_generate_codex_thread_title(&thread));

        thread.message_count = 0;
        thread.engine_metadata = Some(json!({ "manualTitle": true }));
        assert!(!should_generate_codex_thread_title(&thread));

        thread.engine_metadata = None;
        thread.engine_id = "claude".to_string();
        assert!(!should_generate_codex_thread_title(&thread));
    }

    fn attachment_validation_catalog(attachment_modalities: Vec<&str>) -> Vec<EngineInfoDto> {
        vec![EngineInfoDto {
            id: "codex".to_string(),
            name: "Codex".to_string(),
            models: vec![EngineModelDto {
                id: "gpt-test".to_string(),
                display_name: "Codex Test".to_string(),
                description: String::new(),
                hidden: false,
                is_default: true,
                upgrade: None,
                availability_nux: None,
                upgrade_info: None,
                input_modalities: vec!["text".to_string(), "image".to_string(), "pdf".to_string()],
                attachment_modalities: attachment_modalities
                    .into_iter()
                    .map(ToOwned::to_owned)
                    .collect(),
                limits: None,
                supports_personality: false,
                default_reasoning_effort: "medium".to_string(),
                supported_reasoning_efforts: Vec::new(),
            }],
            capabilities: EngineCapabilitiesDto {
                permission_modes: Vec::new(),
                sandbox_modes: Vec::new(),
                approval_decisions: Vec::new(),
            },
        }]
    }

    fn test_attachment(file_name: &str, mime_type: Option<&str>) -> TurnAttachment {
        TurnAttachment {
            file_name: file_name.to_string(),
            file_path: format!("/tmp/{file_name}"),
            size_bytes: 1,
            mime_type: mime_type.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn validates_attachments_against_model_attachment_modalities() {
        let catalog = attachment_validation_catalog(vec!["text", "image"]);
        let attachments = vec![
            test_attachment("notes.md", Some("text/markdown")),
            test_attachment("screenshot.png", Some("image/png")),
        ];

        assert!(validate_attachments_for_engine_model(
            &attachments,
            "codex",
            "gpt-test",
            Some(&catalog),
        )
        .is_ok());
    }

    #[test]
    fn rejects_attachments_when_model_disables_files() {
        let catalog = attachment_validation_catalog(Vec::new());
        let attachments = vec![test_attachment("notes.md", Some("text/markdown"))];

        let error = validate_attachments_for_engine_model(
            &attachments,
            "codex",
            "gpt-test",
            Some(&catalog),
        )
        .expect_err("model without attachment modalities should reject files");

        assert!(error.contains("does not support file attachments"));
    }

    #[test]
    fn rejects_attachment_modalities_not_allowed_by_model() {
        let catalog = attachment_validation_catalog(vec!["text"]);
        let attachments = vec![test_attachment("diagram.png", Some("image/png"))];

        let error = validate_attachments_for_engine_model(
            &attachments,
            "codex",
            "gpt-test",
            Some(&catalog),
        )
        .expect_err("image should be blocked for text-only models");

        assert!(error.contains("Image attachments are not supported"));
    }

    fn insert_pending_approval_with_details(
        state: &AppState,
        thread: &ThreadDto,
        approval_id: &str,
        details: Value,
    ) -> String {
        let assistant_message = db::messages::insert_assistant_placeholder(
            &state.db,
            &thread.id,
            Some(thread.engine_id.as_str()),
            Some(thread.model_id.as_str()),
            None,
        )
        .expect("failed to create assistant message");
        db::actions::insert_approval(
            &state.db,
            approval_id,
            &thread.id,
            &assistant_message.id,
            &crate::engines::events::ActionType::Command,
            "Run command",
            &details,
        )
        .expect("failed to insert approval");
        db::threads::update_thread_status(&state.db, &thread.id, ThreadStatusDto::AwaitingApproval)
            .expect("failed to set thread status");

        let blocks = serde_json::json!([
            {
                "type": "approval",
                "approvalId": approval_id,
                "actionType": "command",
                "summary": "Run command",
                "details": details,
                "status": "pending"
            }
        ]);
        let conn = state.db.connect().expect("failed to open db connection");
        conn.execute(
            "UPDATE messages SET blocks_json = ?1 WHERE id = ?2",
            params![blocks.to_string(), assistant_message.id],
        )
        .expect("failed to persist approval block");
        assistant_message.id
    }

    #[test]
    fn build_final_thread_event_uses_latest_thread_when_present() {
        let state = test_app_state();
        let fallback_thread = test_thread(&state, "codex", "gpt-5.5-codex");
        let mut latest_thread = fallback_thread.clone();
        latest_thread.title = "Renamed".to_string();

        let (event, final_thread) =
            build_final_thread_event(Some(latest_thread.clone()), &fallback_thread);

        assert_eq!(event.thread_id, latest_thread.id);
        assert_eq!(event.workspace_id, latest_thread.workspace_id);
        assert_eq!(
            event.thread.as_ref().map(|thread| thread.title.as_str()),
            Some("Renamed")
        );
        assert_eq!(
            final_thread.as_ref().map(|thread| thread.title.as_str()),
            Some("Renamed")
        );
    }

    #[test]
    fn build_final_thread_event_emits_removal_when_thread_is_missing() {
        let state = test_app_state();
        let fallback_thread = test_thread(&state, "codex", "gpt-5.5-codex");

        let (event, final_thread) = build_final_thread_event(None, &fallback_thread);

        assert_eq!(event.thread_id, fallback_thread.id);
        assert_eq!(event.workspace_id, fallback_thread.workspace_id);
        assert!(event.thread.is_none());
        assert!(final_thread.is_none());
    }

    #[test]
    fn build_chat_turn_finished_event_includes_turn_identity_and_thread_status() {
        let state = test_app_state();
        let mut thread = test_thread(&state, "codex", "gpt-5.5-codex");
        thread.repo_id = Some("repo-1".to_string());
        thread.status = ThreadStatusDto::Completed;
        let event = build_chat_turn_finished_event(
            &thread,
            "assistant-1",
            Some("client-turn-1"),
            &MessageStatusDto::Completed,
            &[],
        );

        assert_eq!(event.thread_id, thread.id);
        assert_eq!(event.workspace_id, thread.workspace_id);
        assert_eq!(event.repo_id.as_deref(), Some("repo-1"));
        assert_eq!(event.assistant_message_id, "assistant-1");
        assert_eq!(event.client_turn_id.as_deref(), Some("client-turn-1"));
        assert_eq!(event.thread_status, "completed");
        assert_eq!(event.status, "completed");
    }

    #[test]
    fn persist_cancelled_turn_snapshot_marks_streaming_turn_interrupted_and_thread_idle() {
        let state = test_app_state();
        let thread = test_thread(&state, "codex", "gpt-5.5-codex");
        db::threads::update_thread_status(&state.db, &thread.id, ThreadStatusDto::Streaming)
            .expect("failed to set thread streaming");
        let assistant_message = db::messages::insert_assistant_placeholder(
            &state.db,
            &thread.id,
            Some(thread.engine_id.as_str()),
            Some(thread.model_id.as_str()),
            None,
        )
        .expect("failed to insert assistant placeholder");
        let approval_id = "approval-cancel";
        db::actions::insert_approval(
            &state.db,
            approval_id,
            &thread.id,
            &assistant_message.id,
            &crate::engines::events::ActionType::Command,
            "Run command",
            &json!({}),
        )
        .expect("failed to insert approval");
        let blocks = json!([
            {
                "type": "action",
                "actionId": "action-running",
                "engineActionId": "item-running",
                "actionType": "command",
                "summary": "pnpm test",
                "details": {},
                "outputChunks": [],
                "outputDeferred": false,
                "outputDeferredLoaded": true,
                "status": "running"
            },
            {
                "type": "approval",
                "approvalId": approval_id,
                "actionType": "command",
                "summary": "Run command",
                "details": {},
                "status": "pending"
            }
        ]);
        db::messages::update_assistant_blocks_json(
            &state.db,
            &assistant_message.id,
            &blocks.to_string(),
            MessageStatusDto::Streaming,
            None,
        )
        .expect("failed to store streaming blocks");

        let snapshot = persist_cancelled_turn_snapshot(&state.db, &thread.id)
            .expect("failed to persist cancelled turn snapshot");

        assert_eq!(
            snapshot.assistant_message_id.as_deref(),
            Some(assistant_message.id.as_str())
        );
        assert_eq!(
            snapshot.thread.as_ref().map(|thread| &thread.status),
            Some(&ThreadStatusDto::Idle)
        );
        let messages = db::messages::get_thread_messages(&state.db, &thread.id)
            .expect("failed to load messages");
        let assistant = messages
            .iter()
            .find(|message| message.id == assistant_message.id)
            .expect("assistant message should exist");
        assert_eq!(assistant.status, MessageStatusDto::Interrupted);
        let blocks = assistant
            .blocks
            .as_ref()
            .and_then(Value::as_array)
            .expect("assistant blocks should be an array");
        assert_eq!(
            blocks[0].get("status").and_then(Value::as_str),
            Some("error")
        );
        assert_eq!(
            blocks[0]
                .get("result")
                .and_then(|value| value.get("error"))
                .and_then(Value::as_str),
            Some("The turn was interrupted before this action reported completion.")
        );
        assert_eq!(
            blocks[1].get("status").and_then(Value::as_str),
            Some("answered")
        );
        assert_eq!(
            blocks[1].get("decision").and_then(Value::as_str),
            Some("cancel")
        );
        assert_eq!(blocks.len(), 2);
        assert!(!blocks
            .iter()
            .any(|block| { block.get("type").and_then(Value::as_str) == Some("notice") }));
    }

    #[test]
    fn external_sandbox_allows_default_workspace_write_mode() {
        assert!(!unsupported_thread_sandbox_override_for_external_sandbox(
            None, true,
        ));
    }

    #[test]
    fn normalize_input_items_merges_adjacent_text_and_preserves_typed_items() {
        let normalized = normalize_input_items(
            "fallback",
            Some(vec![
                ChatInputItemPayload::Text {
                    text: "Use ".to_string(),
                },
                ChatInputItemPayload::Text {
                    text: "$lint".to_string(),
                },
                ChatInputItemPayload::Skill {
                    name: "lint".to_string(),
                    path: "/tmp/skills/lint".to_string(),
                },
                ChatInputItemPayload::Mention {
                    name: "Docs".to_string(),
                    path: "app://docs".to_string(),
                },
                ChatInputItemPayload::Text {
                    text: " now".to_string(),
                },
            ]),
        )
        .expect("input items should normalize");

        assert_eq!(
            normalized,
            vec![
                TurnInputItem::Text {
                    text: "Use $lint".to_string(),
                },
                TurnInputItem::Skill {
                    name: "lint".to_string(),
                    path: "/tmp/skills/lint".to_string(),
                },
                TurnInputItem::Mention {
                    name: "Docs".to_string(),
                    path: "app://docs".to_string(),
                },
                TurnInputItem::Text {
                    text: " now".to_string(),
                },
            ]
        );
    }

    #[test]
    fn chat_notification_preview_ignores_steer_blocks_and_uses_first_text_block() {
        let preview = chat_notification_preview(&[
            ContentBlock::Text {
                content: "hidden steer".to_string(),
                plan_mode: None,
                is_steer: Some(true),
            },
            ContentBlock::Text {
                content: "  First line\n\nSecond line  ".to_string(),
                plan_mode: None,
                is_steer: None,
            },
        ]);

        assert_eq!(preview.as_deref(), Some("First line Second line"));
    }

    #[test]
    fn chat_notification_preview_falls_back_to_error_blocks() {
        let preview = chat_notification_preview(&[ContentBlock::Error {
            message: "Command failed".to_string(),
        }]);

        assert_eq!(preview.as_deref(), Some("Command failed"));
    }

    #[test]
    fn normalize_input_items_rejects_blank_typed_entries() {
        let error = normalize_input_items(
            "fallback",
            Some(vec![ChatInputItemPayload::Skill {
                name: " ".to_string(),
                path: "/tmp/skills/lint".to_string(),
            }]),
        )
        .expect_err("blank skill names should be rejected");

        assert!(error.contains("skill input items require non-empty name and path"));
    }

    #[test]
    fn normalize_codex_review_target_builds_commit_payload() {
        let (target, message, title) =
            normalize_codex_review_target(&CodexReviewTargetPayload::Commit {
                sha: "abcdef1234567890".to_string(),
                title: Some("Refactor auth flow".to_string()),
            })
            .expect("commit target should normalize");

        assert_eq!(
            target,
            serde_json::json!({
                "type": "commit",
                "sha": "abcdef1234567890",
                "title": "Refactor auth flow",
            })
        );
        assert_eq!(
            message,
            "Review commit `abcdef1234567890`: Refactor auth flow"
        );
        assert_eq!(title, "Review: abcdef123456");
    }

    #[test]
    fn clone_codex_review_metadata_clears_runtime_only_fields() {
        let metadata = clone_codex_review_metadata(
            Some(&serde_json::json!({
                "manualTitle": true,
                "manualTitleUpdatedAt": "2026-03-12T00:00:00Z",
                "codexPreview": "old preview",
                "codexThreadStatus": "active",
                "codexThreadActiveFlags": ["waitingOnApproval"],
                "codexSyncRequired": true,
                "codexSyncReason": "stale",
                "codexRemoteTurnActive": true,
                "serviceTier": "fast",
            })),
            "gpt-5.4",
        )
        .expect("metadata should clone");

        assert_eq!(metadata.get("manualTitle"), None);
        assert_eq!(metadata.get("codexPreview"), None);
        assert_eq!(metadata.get("codexThreadStatus"), None);
        assert_eq!(metadata.get("codexThreadActiveFlags"), None);
        assert_eq!(metadata.get("codexSyncRequired"), None);
        assert_eq!(metadata.get("codexSyncReason"), None);
        assert_eq!(
            metadata.get(crate::codex_thread_metadata::REMOTE_TURN_ACTIVE_KEY),
            None
        );
        assert_eq!(
            metadata.get("serviceTier"),
            Some(&serde_json::json!("fast"))
        );
        assert_eq!(
            metadata.get("lastModelId"),
            Some(&serde_json::json!("gpt-5.4"))
        );
    }

    #[test]
    fn normalize_input_items_rejects_non_empty_message_without_text_segments() {
        let error = normalize_input_items(
            "Use lint",
            Some(vec![ChatInputItemPayload::Skill {
                name: "lint".to_string(),
                path: "/tmp/skills/lint".to_string(),
            }]),
        )
        .expect_err("non-empty message text requires a text segment");

        assert!(error.contains("input items must include at least one text segment"));
    }

    #[test]
    fn external_sandbox_blocks_explicit_workspace_write_override() {
        assert!(unsupported_thread_sandbox_override_for_external_sandbox(
            Some("workspace-write"),
            true,
        ));
        assert!(unsupported_thread_sandbox_override_for_external_sandbox(
            Some("read-only"),
            true,
        ));
        assert!(!unsupported_thread_sandbox_override_for_external_sandbox(
            Some("danger-full-access"),
            true,
        ));
    }

    #[test]
    fn resolve_workspace_writable_roots_prefers_confirmed_subset() {
        let roots = resolve_workspace_writable_roots(
            ["/workspace/repo-a", "/workspace/repo-b"],
            "/workspace",
            Some(&serde_json::json!({
                "workspaceWritableRoots": ["/workspace/repo-b"]
            })),
        )
        .expect("expected confirmed roots to resolve");

        assert_eq!(roots.roots, vec![String::from("/workspace/repo-b")]);
        assert!(!roots.requires_confirmation);
    }

    #[test]
    fn resolve_workspace_writable_roots_drops_stale_confirmed_paths() {
        let roots = resolve_workspace_writable_roots(
            ["/workspace/repo-a", "/workspace/repo-b"],
            "/workspace",
            Some(&serde_json::json!({
                "workspaceWritableRoots": ["/workspace/repo-b", "/workspace/repo-c"]
            })),
        )
        .expect("expected stale confirmed roots to be ignored");

        assert_eq!(roots.roots, vec![String::from("/workspace/repo-b")]);
        assert!(!roots.requires_confirmation);
    }

    #[test]
    fn resolve_workspace_writable_roots_requires_reconfirmation_when_all_confirmed_roots_are_stale()
    {
        let roots = resolve_workspace_writable_roots(
            ["/workspace/repo-a", "/workspace/repo-b"],
            "/workspace",
            Some(&serde_json::json!({
                "workspaceWritableRoots": ["/workspace/repo-c"]
            })),
        )
        .expect("expected stale confirmed roots to resolve to current repos");

        assert_eq!(
            roots.roots,
            vec![
                String::from("/workspace/repo-a"),
                String::from("/workspace/repo-b")
            ]
        );
        assert!(roots.requires_confirmation);
    }

    #[test]
    fn non_workspace_write_modes_ignore_workspace_confirmation_requirements() {
        let resolution = WorkspaceWritableRootsResolution {
            roots: vec![
                String::from("/workspace/repo-a"),
                String::from("/workspace/repo-b"),
            ],
            requires_confirmation: true,
        };

        assert!(!workspace_write_confirmation_required(
            Some(&resolution),
            "read-only",
            true,
        ));
        assert!(!workspace_write_confirmation_required(
            Some(&resolution),
            "danger-full-access",
            true,
        ));
        assert!(workspace_write_confirmation_required(
            Some(&resolution),
            "workspace-write",
            true,
        ));
    }

    #[test]
    fn permission_defaults_use_max_privilege_modes() {
        assert_eq!(
            approval_policy_for_engine_and_trust_level("codex", &TrustLevelDto::Trusted),
            "never"
        );
        assert_eq!(
            approval_policy_for_engine_and_trust_level("codex", &TrustLevelDto::Standard),
            "never"
        );
        assert_eq!(
            approval_policy_for_engine_and_trust_level("codex", &TrustLevelDto::Restricted),
            "never"
        );
    }

    #[test]
    fn invalid_structured_codex_approval_policy_is_rejected() {
        let metadata = serde_json::json!({
            "sandboxApprovalPolicy": {
                "reject": {
                    "rules": true,
                    "sandbox_approval": false
                }
            }
        });

        let error = thread_approval_policy_override_value("codex", Some(&metadata))
            .expect_err("expected malformed structured approval policy to fail");

        assert!(error.contains("reject.mcp_elicitations"));
    }

    #[test]
    fn action_progress_coalescing_keeps_latest_message() {
        let merged = try_coalesce_stream_events(
            EngineEvent::ActionProgressUpdated {
                action_id: "action-1".to_string(),
                message: "Connecting".to_string(),
            },
            EngineEvent::ActionProgressUpdated {
                action_id: "action-1".to_string(),
                message: "Fetching results".to_string(),
            },
        )
        .expect("expected coalesced action progress");

        match merged {
            EngineEvent::ActionProgressUpdated { action_id, message } => {
                assert_eq!(action_id, "action-1");
                assert_eq!(message, "Fetching results");
            }
            other => panic!("expected action progress event, got {other:?}"),
        }
    }

    #[test]
    fn debug_event_log_trims_action_output_payload() {
        let content = "x".repeat(ENGINE_EVENT_LOG_ACTION_OUTPUT_MAX_CHARS + 128);
        let event = EngineEvent::ActionOutputDelta {
            action_id: "action-1".to_string(),
            stream: OutputStream::Stdout,
            content,
        };

        let log_event = engine_event_for_debug_log(&event);

        match log_event {
            EngineEvent::ActionOutputDelta { content, .. } => {
                assert_eq!(content.len(), ENGINE_EVENT_LOG_ACTION_OUTPUT_MAX_CHARS);
            }
            other => panic!("expected action output event, got {other:?}"),
        }
    }

    #[test]
    fn trim_action_output_chunks_keeps_tail_of_oversized_chunk() {
        let mut chunks = vec![ActionOutputChunk {
            stream: "stdout".to_string(),
            content: "0123456789".to_string(),
        }];

        assert!(trim_action_output_chunks(&mut chunks, 6));
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "6789");
    }

    #[test]
    fn model_reroute_notice_preserves_arrival_order_and_action_updates() {
        let mut blocks = Vec::new();
        let mut action_index = HashMap::new();
        let mut approval_index = HashMap::new();

        let started = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::ActionStarted {
                action_id: "action-1".to_string(),
                engine_action_id: Some("item-1".to_string()),
                action_type: crate::engines::events::ActionType::Other,
                summary: "search_docs".to_string(),
                details: serde_json::json!({}),
            },
            1000,
            None,
        );
        assert!(started.blocks_changed);

        let rerouted = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::ModelRerouted {
                from_model: "gpt-5.1-codex-mini".to_string(),
                to_model: "gpt-5.3-codex".to_string(),
                reason: "highRiskCyberActivity".to_string(),
            },
            1000,
            None,
        );
        assert!(rerouted.blocks_changed);
        assert_eq!(rerouted.turn_model_id.as_deref(), Some("gpt-5.3-codex"));

        let progress = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::ActionProgressUpdated {
                action_id: "action-1".to_string(),
                message: "Fetching results".to_string(),
            },
            1000,
            None,
        );
        assert!(progress.blocks_changed);

        assert!(matches!(
            &blocks[1],
            ContentBlock::Notice {
                kind,
                level,
                title,
                ..
            } if kind == "model_rerouted" && level == "info" && title == "Model rerouted"
        ));
        match &blocks[0] {
            ContentBlock::Action { details, .. } => {
                let details_value: Value = serde_json::from_str(details.get())
                    .expect("action details should parse as JSON");
                assert_eq!(
                    details_value
                        .get("progressKind")
                        .and_then(serde_json::Value::as_str),
                    Some("mcp")
                );
                assert_eq!(
                    details_value
                        .get("progressMessage")
                        .and_then(serde_json::Value::as_str),
                    Some("Fetching results")
                );
            }
            other => panic!("expected action block, got {other:?}"),
        }
    }

    #[test]
    fn action_completion_replaces_empty_web_search_start_details() {
        let mut blocks = Vec::new();
        let mut action_index = HashMap::new();
        let mut approval_index = HashMap::new();

        let started = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::ActionStarted {
                action_id: "search-action".to_string(),
                engine_action_id: Some("search-item".to_string()),
                action_type: crate::engines::events::ActionType::Search,
                summary: "Web search".to_string(),
                details: serde_json::json!({
                    "query": "",
                    "action": null,
                    "results": null
                }),
            },
            1000,
            None,
        );
        assert!(started.blocks_changed);

        let completed = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::ActionCompleted {
                action_id: "search-action".to_string(),
                result: crate::engines::ActionResult {
                    success: true,
                    output: None,
                    error: None,
                    diff: None,
                    duration_ms: 25,
                },
                details: Some(serde_json::json!({
                    "query": "Shiro no Yakata game",
                    "action": { "type": "search", "query": "Shiro no Yakata game" },
                    "results": [{
                        "title": "Developer blog",
                        "url": "https://zell23.livedoor.blog/"
                    }]
                })),
            },
            1000,
            None,
        );
        assert!(completed.blocks_changed);

        match &blocks[0] {
            ContentBlock::Action {
                details,
                status,
                result,
                ..
            } => {
                let details: Value = serde_json::from_str(details.get())
                    .expect("completed search details should remain valid JSON");
                assert_eq!(status, "done");
                assert_eq!(
                    details.get("query").and_then(Value::as_str),
                    Some("Shiro no Yakata game")
                );
                assert_eq!(
                    details
                        .get("results")
                        .and_then(Value::as_array)
                        .map(Vec::len),
                    Some(1)
                );
                assert_eq!(result.as_ref().map(|result| result.duration_ms), Some(25));
            }
            other => panic!("expected completed search action block, got {other:?}"),
        }
    }

    #[test]
    fn diff_update_collapses_existing_same_scope_diff_blocks() {
        let mut blocks = vec![
            ContentBlock::Diff {
                diff: "old diff 1".to_string(),
                scope: "turn".to_string(),
            },
            ContentBlock::Text {
                content: "kept".to_string(),
                plan_mode: None,
                is_steer: None,
            },
            ContentBlock::Diff {
                diff: "old diff 2".to_string(),
                scope: "turn".to_string(),
            },
            ContentBlock::Action {
                action_id: "action-after-diff".to_string(),
                engine_action_id: None,
                action_type: "other".to_string(),
                summary: "Continue".to_string(),
                details: empty_raw_value(),
                output_chunks: Vec::new(),
                status: "running".to_string(),
                result: None,
            },
        ];
        let mut action_index = HashMap::new();
        let mut approval_index = HashMap::new();
        rebuild_block_indexes(&blocks, &mut action_index, &mut approval_index);

        let progress = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::DiffUpdated {
                diff: "new diff".to_string(),
                scope: crate::engines::DiffScope::Turn,
            },
            1000,
            None,
        );

        assert!(progress.blocks_changed);
        assert_eq!(blocks.len(), 3);
        assert!(matches!(
            &blocks[0],
            ContentBlock::Text { content, .. } if content == "kept"
        ));
        assert!(matches!(
            &blocks[1],
            ContentBlock::Diff { diff, scope } if diff == "new diff" && scope == "turn"
        ));

        let follow_up = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::ActionProgressUpdated {
                action_id: "action-after-diff".to_string(),
                message: "Still in sequence".to_string(),
            },
            1000,
            None,
        );
        assert!(follow_up.blocks_changed);
        match &blocks[2] {
            ContentBlock::Action { details, .. } => {
                let details: Value = serde_json::from_str(details.get())
                    .expect("action details should remain valid JSON");
                assert_eq!(
                    details.get("progressMessage").and_then(Value::as_str),
                    Some("Still in sequence")
                );
            }
            other => panic!("expected action after collapsed diff, got {other:?}"),
        }
    }

    #[test]
    fn pasted_image_extension_rejects_unknown_image_mime() {
        assert_eq!(
            pasted_image_extension("pasted-image-1.png", "image/heic"),
            None
        );
    }

    #[test]
    fn cached_attachment_thumbnail_is_bounded_and_reused() {
        let root = std::env::temp_dir().join(format!("panes-image-thumbnail-{}", Uuid::new_v4()));
        let cache_dir = root.join("cache");
        fs::create_dir_all(&cache_dir).expect("create thumbnail cache");
        let source_path = root.join("source.png");
        image::RgbaImage::from_pixel(120, 80, image::Rgba([12, 34, 56, 255]))
            .save(&source_path)
            .expect("save source image");
        let metadata = fs::metadata(&source_path).expect("source metadata");
        let version = attachment_asset_version(&metadata);

        let first = prepare_cached_attachment_thumbnail(
            &source_path,
            "image/png",
            &version,
            &cache_dir,
            30,
            30,
        )
        .expect("prepare first thumbnail")
        .expect("large source should produce a thumbnail");
        let decoded = image::open(&first).expect("decode cached thumbnail");
        assert!(decoded.width() <= 30);
        assert!(decoded.height() <= 30);

        let second = prepare_cached_attachment_thumbnail(
            &source_path,
            "image/png",
            &version,
            &cache_dir,
            30,
            30,
        )
        .expect("reuse cached thumbnail")
        .expect("cached thumbnail should exist");
        assert_eq!(first, second);

        fs::remove_dir_all(&root).expect("remove thumbnail test directory");
    }

    #[test]
    fn svg_thumbnail_preparation_uses_the_original_asset() {
        let source_path = Path::new("example.svg");
        let cache_dir = Path::new("unused-cache");
        assert_eq!(
            prepare_cached_attachment_thumbnail(
                source_path,
                "image/svg+xml",
                "version",
                cache_dir,
                720,
                440,
            )
            .expect("SVG thumbnail preparation should not fail"),
            None
        );
    }

    #[tokio::test]
    async fn attachment_asset_validation_rejects_non_image_contents() {
        let root = std::env::temp_dir().join(format!("panes-image-validation-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create image validation directory");
        let fake_image = root.join("not-an-image.png");
        fs::write(&fake_image, b"not actually a PNG").expect("write fake image");

        let error = validate_attachment_image_file(
            fake_image.to_string_lossy().as_ref(),
            Some("image/png"),
        )
        .await
        .expect_err("fake image should be rejected");
        assert!(error.contains("do not match"));

        fs::remove_dir_all(&root).expect("remove image validation directory");
    }

    #[test]
    fn embedded_image_signature_validation_covers_supported_formats() {
        assert!(attachment_image_signature_matches(
            b"\x89PNG\r\n\x1a\nrest",
            "image/png"
        ));
        assert!(attachment_image_signature_matches(
            &[0xff, 0xd8, 0xff, 0xe0],
            "image/jpeg"
        ));
        assert!(attachment_image_signature_matches(b"GIF89a", "image/gif"));
        assert!(attachment_image_signature_matches(
            b"RIFF\x00\x00\x00\x00WEBP",
            "image/webp"
        ));
        assert!(attachment_image_signature_matches(
            b"BMpayload",
            "image/bmp"
        ));
        assert!(attachment_image_signature_matches(
            b"II*\0payload",
            "image/tiff"
        ));
        assert!(attachment_image_signature_matches(
            b"<?xml version='1.0'?><SVG viewBox='0 0 1 1'/>",
            "image/svg+xml"
        ));
        assert!(!attachment_image_signature_matches(
            b"not an image",
            "image/png"
        ));
        assert!(!attachment_image_signature_matches(
            b"\x89PNG\r\n\x1a\nrest",
            "text/plain"
        ));
    }

    #[test]
    fn generic_notice_blocks_are_upserted_by_kind() {
        let mut blocks = Vec::new();
        let mut action_index = HashMap::new();
        let mut approval_index = HashMap::new();

        let first = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::Notice {
                kind: "deprecation_notice".to_string(),
                level: "warning".to_string(),
                title: "Deprecation notice".to_string(),
                message: "Use the newer API.".to_string(),
                details: None,
            },
            1000,
            None,
        );
        assert!(first.blocks_changed);

        let second = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::Notice {
                kind: "deprecation_notice".to_string(),
                level: "warning".to_string(),
                title: "Deprecation notice".to_string(),
                message: "Use the newer permissions API.".to_string(),
                details: None,
            },
            1000,
            None,
        );
        assert!(second.blocks_changed);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(
            &blocks[0],
            ContentBlock::Notice { message, .. } if message == "Use the newer permissions API."
        ));
    }

    #[test]
    fn generic_notice_blocks_preserve_details() {
        let mut blocks = Vec::new();
        let mut action_index = HashMap::new();
        let mut approval_index = HashMap::new();

        let progress = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::Notice {
                kind: "context_compacted".to_string(),
                level: "info".to_string(),
                title: "Context compacted".to_string(),
                message: "Codex compacted the active thread context.".to_string(),
                details: Some(vec![
                    "summary::Kept the repo goal and recent edits.".to_string(),
                    "prompt::Continue from the persisted thread summary.".to_string(),
                ]),
            },
            1000,
            None,
        );

        assert!(progress.blocks_changed);
        assert!(matches!(
            &blocks[0],
            ContentBlock::Notice {
                kind,
                details: Some(details),
                ..
            } if kind == "context_compacted"
                && details.iter().any(|detail| detail.starts_with("summary::"))
                && details.iter().any(|detail| detail.starts_with("prompt::"))
        ));
    }

    #[test]
    fn turn_completed_updates_state_without_adding_a_notice() {
        let mut blocks = vec![ContentBlock::Action {
            action_id: "action-1".to_string(),
            engine_action_id: Some("item-1".to_string()),
            action_type: "command".to_string(),
            summary: "Run tests".to_string(),
            details: empty_raw_value(),
            output_chunks: Vec::new(),
            status: "done".to_string(),
            result: None,
        }];
        let mut action_index = HashMap::new();
        let mut approval_index = HashMap::new();
        rebuild_block_indexes(&blocks, &mut action_index, &mut approval_index);

        let progress = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::TurnCompleted {
                token_usage: Some(crate::engines::TokenUsage {
                    input: 12,
                    output: 34,
                    reasoning: None,
                    cache_read: None,
                    cache_write: None,
                    cost_usd: None,
                }),
                status: TurnCompletionStatus::Completed,
                diagnostics: Some(crate::engines::TurnCompletionDiagnostics {
                    source: TurnCompletionSource::Engine,
                }),
            },
            1000,
            Some(123_456),
        );

        assert!(!progress.blocks_changed);
        assert!(progress.force_persist);
        assert_eq!(progress.message_status, Some(MessageStatusDto::Completed));
        assert_eq!(progress.thread_status, Some(ThreadStatusDto::Completed));
        assert_eq!(progress.token_usage, Some((12, 34)));
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn turn_completed_terminalizes_unresolved_action_blocks() {
        let mut blocks = vec![ContentBlock::Action {
            action_id: "action-1".to_string(),
            engine_action_id: Some("item-1".to_string()),
            action_type: "command".to_string(),
            summary: "Run tests".to_string(),
            details: empty_raw_value(),
            output_chunks: Vec::new(),
            status: "running".to_string(),
            result: None,
        }];
        let mut action_index = HashMap::new();
        let mut approval_index = HashMap::new();
        rebuild_block_indexes(&blocks, &mut action_index, &mut approval_index);

        let progress = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::TurnCompleted {
                token_usage: None,
                status: TurnCompletionStatus::Interrupted,
                diagnostics: Some(crate::engines::TurnCompletionDiagnostics {
                    source: TurnCompletionSource::ReconciledStreamLost,
                }),
            },
            1000,
            None,
        );

        assert!(progress.blocks_changed);
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            ContentBlock::Action { status, result, .. } => {
                assert_eq!(status, "error");
                let result = result.as_ref().expect("expected synthetic action result");
                assert!(!result.success);
                assert_eq!(
                    result.error.as_deref(),
                    Some(
                        "Panes lost the live Codex stream before this action reported completion."
                    )
                );
                assert_eq!(result.duration_ms, 0);
            }
            other => panic!("expected action block, got {other:?}"),
        }
    }

    #[test]
    fn turn_completed_resolves_pending_approval_without_adding_a_notice() {
        let mut blocks = vec![ContentBlock::Approval {
            approval_id: "approval-1".to_string(),
            action_type: "command".to_string(),
            summary: "Run command".to_string(),
            details: empty_raw_value(),
            status: "pending".to_string(),
            decision: None,
        }];
        let mut action_index = HashMap::new();
        let mut approval_index = HashMap::new();
        rebuild_block_indexes(&blocks, &mut action_index, &mut approval_index);

        let progress = apply_event_to_blocks(
            &mut blocks,
            &mut action_index,
            &mut approval_index,
            &EngineEvent::TurnCompleted {
                token_usage: Some(crate::engines::TokenUsage {
                    input: 12,
                    output: 34,
                    reasoning: None,
                    cache_read: None,
                    cache_write: None,
                    cost_usd: None,
                }),
                status: TurnCompletionStatus::Completed,
                diagnostics: Some(crate::engines::TurnCompletionDiagnostics {
                    source: TurnCompletionSource::Engine,
                }),
            },
            1000,
            Some(42_000),
        );

        assert_eq!(progress.message_status, Some(MessageStatusDto::Completed));
        assert_eq!(progress.thread_status, Some(ThreadStatusDto::Completed));
        assert!(matches!(
            &blocks[0],
            ContentBlock::Approval {
                status,
                decision: Some(decision),
                ..
            } if status == "answered" && decision == "cancel"
        ));
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn async_questions_preserve_other_blocking_requests() {
        let mut blocks = Vec::new();
        let mut actions = HashMap::new();
        let mut approvals = HashMap::new();
        for (id, blocking, expected) in [
            ("async-1", false, ThreadStatusDto::Streaming),
            ("blocking", true, ThreadStatusDto::AwaitingApproval),
            ("async-2", false, ThreadStatusDto::AwaitingApproval),
        ] {
            let progress = apply_event_to_blocks(
                &mut blocks,
                &mut actions,
                &mut approvals,
                &EngineEvent::ApprovalRequested {
                    approval_id: id.to_string(),
                    action_type: crate::engines::ActionType::Other,
                    summary: "Scope?".to_string(),
                    details: json!({"_serverMethod": "item/tool/requestUserInput", "isBlocking": blocking}),
                },
                1000,
                None,
            );
            assert_eq!(progress.thread_status, Some(expected));
        }
        assert_eq!(blocks.len(), 3);
    }

    #[test]
    fn approval_response_persistence_tracks_permissions_session_scope() {
        let response = serde_json::json!({
            "permissions": {
                "network": {
                    "enabled": true
                }
            },
            "scope": "session"
        });

        assert_eq!(
            approval_response_decision_for_persistence(&response),
            "accept_for_session"
        );
    }

    #[test]
    fn approval_response_persistence_tracks_mcp_elicitation_actions() {
        let response = serde_json::json!({
            "action": "decline"
        });

        assert_eq!(
            approval_response_decision_for_persistence(&response),
            "decline"
        );
    }

    #[test]
    fn approval_response_persistence_treats_empty_permissions_as_decline() {
        let response = serde_json::json!({
            "permissions": {},
            "scope": "turn"
        });

        assert_eq!(
            approval_response_decision_for_persistence(&response),
            "decline"
        );
    }

    #[tokio::test]
    async fn missing_live_codex_approval_request_keeps_approval_pending() {
        let state = test_app_state();
        let thread = test_thread(&state, "codex", "gpt-5.5-codex");
        let approval_id = "approval-reset";
        let message_id = insert_pending_approval_with_details(
            &state,
            &thread,
            approval_id,
            serde_json::json!({
                "command": "touch file.txt",
                "_serverMethod": "item/fileChange/requestApproval",
                "_rawRequestId": 42
            }),
        );

        let error = respond_to_approval_inner(
            &state,
            thread.id.clone(),
            approval_id.to_string(),
            serde_json::json!({ "decision": "accept" }),
        )
        .await
        .expect_err("expected codex approval without live request to fail");

        assert!(error.contains("runtime connection was reset"));

        let conn = state.db.connect().expect("failed to open db connection");
        let approval_row = conn
            .query_row(
                "SELECT status, decision FROM approvals WHERE id = ?1",
                params![approval_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .expect("failed to load approval row");
        assert_eq!(approval_row.0, "pending");
        assert_eq!(approval_row.1, None);

        let thread_status = conn
            .query_row(
                "SELECT status FROM threads WHERE id = ?1",
                params![thread.id],
                |row| row.get::<_, String>(0),
            )
            .expect("failed to load thread status");
        assert_eq!(thread_status, "awaiting_approval");

        let raw_blocks = conn
            .query_row(
                "SELECT blocks_json FROM messages WHERE id = ?1",
                params![message_id],
                |row| row.get::<_, String>(0),
            )
            .expect("failed to load message blocks");
        let blocks: Value =
            serde_json::from_str(&raw_blocks).expect("message blocks should deserialize");
        assert_eq!(
            blocks
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item.get("status"))
                .and_then(Value::as_str),
            Some("pending")
        );
        assert!(blocks
            .as_array()
            .and_then(|items| items.first())
            .and_then(|item| item.get("decision"))
            .is_none());
    }

    #[tokio::test]
    async fn load_codex_approval_response_route_reads_persisted_transport_metadata() {
        let state = test_app_state();
        let thread = test_thread(&state, "codex", "gpt-5.5-codex");
        insert_pending_approval_with_details(
            &state,
            &thread,
            "approval-route",
            serde_json::json!({
                "command": "touch file.txt",
                "_serverMethod": "item/fileChange/requestApproval",
                "_rawRequestId": 42
            }),
        );

        let route = load_approval_response_route(state.db.clone(), "codex", "approval-route")
            .await
            .unwrap();

        assert_eq!(
            route,
            Some(ApprovalRequestRoute {
                server_method: "item/fileChange/requestApproval".to_string(),
                raw_request_id: serde_json::json!(42),
            })
        );
    }

    #[test]
    fn resolve_reasoning_effort_from_catalog_falls_back_to_model_default() {
        let engines = vec![EngineInfoDto {
            id: "codex".to_string(),
            name: "Codex".to_string(),
            models: vec![EngineModelDto {
                id: "gpt-5.1-codex-mini".to_string(),
                display_name: "GPT-5.1 Codex Mini".to_string(),
                description: String::new(),
                hidden: false,
                is_default: false,
                upgrade: None,
                availability_nux: None,
                upgrade_info: None,
                input_modalities: vec!["text".to_string()],
                attachment_modalities: vec!["text".to_string()],
                limits: None,
                supports_personality: false,
                default_reasoning_effort: "medium".to_string(),
                supported_reasoning_efforts: vec![
                    ReasoningEffortOptionDto {
                        reasoning_effort: "medium".to_string(),
                        description: String::new(),
                    },
                    ReasoningEffortOptionDto {
                        reasoning_effort: "high".to_string(),
                        description: String::new(),
                    },
                ],
            }],
            capabilities: EngineCapabilitiesDto {
                permission_modes: Vec::new(),
                sandbox_modes: Vec::new(),
                approval_decisions: Vec::new(),
            },
        }];

        assert_eq!(
            resolve_reasoning_effort_from_catalog(
                &engines,
                "codex",
                "gpt-5.1-codex-mini",
                Some("xhigh"),
            ),
            Some("medium".to_string())
        );
    }

    #[test]
    fn resolve_reasoning_effort_from_catalog_keeps_supported_effort() {
        let engines = vec![EngineInfoDto {
            id: "codex".to_string(),
            name: "Codex".to_string(),
            models: vec![EngineModelDto {
                id: "gpt-5.1-codex-mini".to_string(),
                display_name: "GPT-5.1 Codex Mini".to_string(),
                description: String::new(),
                hidden: false,
                is_default: false,
                upgrade: None,
                availability_nux: None,
                upgrade_info: None,
                input_modalities: vec!["text".to_string()],
                attachment_modalities: vec!["text".to_string()],
                limits: None,
                supports_personality: false,
                default_reasoning_effort: "medium".to_string(),
                supported_reasoning_efforts: vec![
                    ReasoningEffortOptionDto {
                        reasoning_effort: "medium".to_string(),
                        description: String::new(),
                    },
                    ReasoningEffortOptionDto {
                        reasoning_effort: "high".to_string(),
                        description: String::new(),
                    },
                ],
            }],
            capabilities: EngineCapabilitiesDto {
                permission_modes: Vec::new(),
                sandbox_modes: Vec::new(),
                approval_decisions: Vec::new(),
            },
        }];

        assert_eq!(
            resolve_reasoning_effort_from_catalog(
                &engines,
                "codex",
                "gpt-5.1-codex-mini",
                Some("high"),
            ),
            Some("high".to_string())
        );
    }

    #[test]
    fn resolve_turn_model_id_accepts_thread_last_model_without_catalog() {
        let state = test_app_state();
        let mut thread = test_thread(&state, "codex", "gpt-5.5-codex");
        thread.engine_metadata = Some(serde_json::json!({
            "lastModelId": "gpt-5.1-codex-mini"
        }));

        assert_eq!(
            resolve_turn_model_id(&thread, Some("gpt-5.1-codex-mini"), None)
                .expect("last model should resolve without a catalog"),
            "gpt-5.1-codex-mini"
        );
    }
}

fn resolve_turn_model_id(
    thread: &ThreadDto,
    requested_model_id: Option<&str>,
    engines: Option<&[EngineInfoDto]>,
) -> Result<String, String> {
    let Some(requested_model_id) = requested_model_id else {
        return Ok(thread.model_id.clone());
    };

    if requested_model_id == thread.model_id {
        return Ok(thread.model_id.clone());
    }

    if thread_last_model_id(thread.engine_metadata.as_ref()).as_deref() == Some(requested_model_id)
    {
        return Ok(requested_model_id.to_string());
    }

    if let Some(engines) = engines {
        if let Some(engine) = engines.iter().find(|engine| engine.id == thread.engine_id) {
            if engine
                .models
                .iter()
                .any(|model| model.id == requested_model_id)
            {
                return Ok(requested_model_id.to_string());
            }

            let available = engine
                .models
                .iter()
                .map(|model| model.id.clone())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "model `{requested_model_id}` is not supported by engine `{}`. available models: {available}",
                thread.engine_id
            ));
        }
    }

    Ok(requested_model_id.to_string())
}

async fn model_supports_personality(state: &AppState, engine_id: &str, model_id: &str) -> bool {
    let Ok(engines) = state.engines.list_engines().await else {
        return false;
    };

    engines
        .iter()
        .find(|engine| engine.id == engine_id)
        .and_then(|engine| engine.models.iter().find(|model| model.id == model_id))
        .map(|model| model.supports_personality)
        .unwrap_or(false)
}

fn err_to_string(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}
