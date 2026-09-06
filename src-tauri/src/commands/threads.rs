use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::Instant,
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, State};

use crate::{
    codex_thread_metadata::{self, REMOTE_TURN_ACTIVE_SYNC_REASON},
    db,
    engines::validate_engine_sandbox_mode,
    engines::CodexRemoteThreadSummary,
    engines::ImportedThreadMessage,
    engines::SandboxPolicy,
    engines::ThreadSyncSnapshot,
    models::{
        CodexRemoteThreadDto, CodexRemoteThreadPageDto, MessageDto, MessageStatusDto,
        ReasoningEffortOptionDto, RepoDto, ThreadDto, ThreadStatusDto, TrustLevelDto,
    },
    state::AppState,
};

const MAX_THREAD_TITLE_CHARS: usize = 120;
const BRANCH_PROFILE_LOG_FILE_NAME: &str = "codex-branch-profile.log";
const CONTEXT_USAGE_CACHE_METADATA_KEY: &str = "contextUsageCache";

fn branch_profile_log_path() -> PathBuf {
    crate::runtime_env::app_data_dir()
        .join("logs")
        .join(BRANCH_PROFILE_LOG_FILE_NAME)
}

fn sanitize_branch_profile_field(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

fn format_elapsed_ms(started_at: Instant) -> String {
    format!("{:.1}", started_at.elapsed().as_secs_f64() * 1000.0)
}

fn append_branch_profile_log_entry(
    operation_id: &str,
    step: &str,
    details: Option<&str>,
) -> std::io::Result<PathBuf> {
    let path = branch_profile_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    write!(
        file,
        "{}\top={}\tstep={}",
        timestamp,
        sanitize_branch_profile_field(operation_id),
        sanitize_branch_profile_field(step)
    )?;
    if let Some(details) = details.filter(|value| !value.is_empty()) {
        write!(file, "\tdetails={}", sanitize_branch_profile_field(details))?;
    }
    writeln!(file)?;
    Ok(path)
}

fn log_branch_profile_step(operation_id: Option<&str>, step: &str, details: Option<String>) {
    let Some(operation_id) = operation_id.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    if let Err(error) = append_branch_profile_log_entry(operation_id, step, details.as_deref()) {
        log::warn!("failed to append branch profile log entry for {operation_id}: {error}");
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshThreadUsageLimitsDiagnosticsDto {
    pub thread_id: String,
    pub engine_id: String,
    pub model_id: String,
    pub thread_status: String,
    pub message_count: i64,
    pub last_activity_at: String,
    pub engine_thread_id: Option<String>,
    pub thread_read_attempted: bool,
    pub thread_read_succeeded: bool,
    pub latest_turn_read_attempted: bool,
    pub latest_turn_read_succeeded: bool,
    pub latest_turn_source: Option<String>,
    pub latest_turn_id: Option<String>,
    pub latest_turn_had_token_usage: bool,
    pub cached_context_available: bool,
    pub cached_context_used: bool,
    pub account_read_attempted: bool,
    pub account_read_succeeded: bool,
    pub current_tokens: Option<u64>,
    pub max_context_tokens: Option<u64>,
    pub context_window_percent: Option<u8>,
    pub five_hour_percent: Option<u8>,
    pub weekly_percent: Option<u8>,
    pub five_hour_resets_at: Option<i64>,
    pub weekly_resets_at: Option<i64>,
    pub thread_read_error: Option<String>,
    pub latest_turn_read_error: Option<String>,
    pub account_read_error: Option<String>,
    pub fatal_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshThreadUsageLimitsResultDto {
    pub refreshed: bool,
    pub missing_context: bool,
    pub diagnostics: RefreshThreadUsageLimitsDiagnosticsDto,
}

fn usage_snapshot_missing_context(usage: Option<&crate::engines::UsageLimitsSnapshot>) -> bool {
    let Some(usage) = usage else {
        return true;
    };

    usage.current_tokens.is_none()
        && usage.max_context_tokens.is_none()
        && usage.context_window_percent.is_none()
        && usage.input_tokens.is_none()
        && usage.cached_input_tokens.is_none()
        && usage.cache_write_input_tokens.is_none()
        && usage.output_tokens.is_none()
        && usage.reasoning_output_tokens.is_none()
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

fn cached_context_usage_from_metadata(
    metadata: Option<&Value>,
) -> Option<crate::engines::UsageLimitsSnapshot> {
    let cache = metadata
        .and_then(Value::as_object)
        .and_then(|object| object.get(CONTEXT_USAGE_CACHE_METADATA_KEY))
        .and_then(Value::as_object)?;

    let current_tokens = cache.get("currentTokens").and_then(Value::as_u64);
    let max_context_tokens = cache.get("maxContextTokens").and_then(Value::as_u64);
    let context_window_percent = cache
        .get("contextWindowPercent")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok());
    let input_tokens = cache.get("inputTokens").and_then(Value::as_u64);
    let cached_input_tokens = cache.get("cachedInputTokens").and_then(Value::as_u64);
    let cache_write_input_tokens = cache.get("cacheWriteInputTokens").and_then(Value::as_u64);
    let output_tokens = cache.get("outputTokens").and_then(Value::as_u64);
    let reasoning_output_tokens = cache.get("reasoningOutputTokens").and_then(Value::as_u64);

    if current_tokens.is_none()
        && max_context_tokens.is_none()
        && context_window_percent.is_none()
        && input_tokens.is_none()
        && cached_input_tokens.is_none()
        && cache_write_input_tokens.is_none()
        && output_tokens.is_none()
        && reasoning_output_tokens.is_none()
    {
        return None;
    }

    Some(crate::engines::UsageLimitsSnapshot {
        current_tokens,
        max_context_tokens,
        context_window_percent,
        input_tokens,
        cached_input_tokens,
        cache_write_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        ..crate::engines::UsageLimitsSnapshot::default()
    })
}

fn merge_cached_context_usage(
    usage: Option<crate::engines::UsageLimitsSnapshot>,
    cached: &crate::engines::UsageLimitsSnapshot,
) -> crate::engines::UsageLimitsSnapshot {
    let mut merged = usage.unwrap_or_default();
    if merged.current_tokens.is_none() {
        merged.current_tokens = cached.current_tokens;
    }
    if merged.max_context_tokens.is_none() {
        merged.max_context_tokens = cached.max_context_tokens;
    }
    if merged.context_window_percent.is_none() {
        merged.context_window_percent = cached.context_window_percent;
    }
    if merged.input_tokens.is_none() {
        merged.input_tokens = cached.input_tokens;
    }
    if merged.cached_input_tokens.is_none() {
        merged.cached_input_tokens = cached.cached_input_tokens;
    }
    if merged.cache_write_input_tokens.is_none() {
        merged.cache_write_input_tokens = cached.cache_write_input_tokens;
    }
    if merged.output_tokens.is_none() {
        merged.output_tokens = cached.output_tokens;
    }
    if merged.reasoning_output_tokens.is_none() {
        merged.reasoning_output_tokens = cached.reasoning_output_tokens;
    }
    merged
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

fn checkpoint_context_usage(
    db: &crate::db::Database,
    thread_id: &str,
    metadata: Option<&Value>,
    engine_thread_id: Option<&str>,
) -> Option<crate::engines::UsageLimitsSnapshot> {
    let native_thread_id = if is_codex_compatibility_fork(metadata) {
        // The copied ledger describes the original full native context, not the
        // sanitized text injected into a compatibility fork.
        Some(engine_thread_id?)
    } else {
        None
    };
    match db::codex_transcript::load_latest_context_usage(db, thread_id, native_thread_id) {
        Ok(Some(usage)) => {
            let mut mapper = crate::engines::codex_event_mapper::TurnEventMapper::default();
            let payload = if usage.get("tokenUsage").is_some() {
                usage
            } else {
                json!({ "tokenUsage": usage })
            };
            mapper.merge_usage_snapshot_payload(&payload);
            mapper.latest_usage_limits_snapshot()
        }
        Ok(None) => None,
        Err(error) => {
            log::warn!("failed to restore checkpoint context usage for {thread_id}: {error}");
            None
        }
    }
}

fn restore_checkpoint_context_usage(
    db: &crate::db::Database,
    thread_id: &str,
    mut metadata: Value,
    engine_thread_id: Option<&str>,
) -> Value {
    if let Some(object) = metadata.as_object_mut() {
        object.remove(CONTEXT_USAGE_CACHE_METADATA_KEY);
    }
    match checkpoint_context_usage(db, thread_id, Some(&metadata), engine_thread_id) {
        Some(usage) => merge_context_usage_cache_into_metadata(Some(metadata), &usage),
        None => metadata,
    }
}

#[tauri::command]
pub async fn append_branch_profile_log(
    operation_id: String,
    step: String,
    details: Option<String>,
) -> Result<String, String> {
    append_branch_profile_log_entry(&operation_id, &step, details.as_deref())
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(err_to_string)
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

#[tauri::command]
pub async fn list_threads(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<ThreadDto>, String> {
    run_db(state.db.clone(), move |db| {
        db::threads::list_threads_for_workspace(db, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn list_archived_threads(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<ThreadDto>, String> {
    run_db(state.db.clone(), move |db| {
        db::threads::list_archived_threads_for_workspace(db, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn list_codex_remote_threads(
    state: State<'_, AppState>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    search_term: Option<String>,
    archived: Option<bool>,
) -> Result<CodexRemoteThreadPageDto, String> {
    let db = state.db.clone();
    let (workspace_root, repos) = run_db(db.clone(), {
        let workspace_id = workspace_id.clone();
        move |db| {
            let workspace = db::workspaces::find_workspace_by_id(db, &workspace_id)?
                .ok_or_else(|| anyhow::anyhow!("workspace not found: {workspace_id}"))?;
            let repos = db::repos::get_repos(db, &workspace_id)?;
            Ok((workspace.root_path, repos))
        }
    })
    .await?;

    let allowed_roots = collect_remote_thread_roots(&workspace_root, &repos);
    let normalized_search_term = normalize_remote_thread_search_term(search_term);
    let remote_threads = state
        .engines
        .list_codex_remote_threads(normalized_search_term.as_deref(), archived)
        .await
        .map_err(err_to_string)?;
    let matching_threads = remote_threads
        .into_iter()
        .filter(|thread| allowed_roots.contains(thread.cwd.as_str()))
        .collect::<Vec<_>>();

    let offset = parse_codex_remote_thread_cursor(cursor.as_deref())?;
    let page_size = normalize_codex_remote_thread_limit(limit);
    let page_end = offset.saturating_add(page_size).min(matching_threads.len());
    let page_threads = if offset >= matching_threads.len() {
        Vec::new()
    } else {
        matching_threads[offset..page_end].to_vec()
    };
    let next_cursor = (page_end < matching_threads.len()).then(|| page_end.to_string());

    run_db(db, move |db| {
        let threads = page_threads
            .into_iter()
            .map(|thread| {
                let local_thread_id = db::threads::find_thread_by_engine_thread_id(
                    db,
                    "codex",
                    &thread.engine_thread_id,
                )?
                .filter(|local| local.workspace_id == workspace_id)
                .map(|local| local.id);
                Ok(map_codex_remote_thread_dto(thread, local_thread_id))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        Ok(CodexRemoteThreadPageDto {
            threads,
            next_cursor,
        })
    })
    .await
}

#[tauri::command]
pub async fn attach_codex_remote_thread(
    state: State<'_, AppState>,
    workspace_id: String,
    engine_thread_id: String,
    model_id: String,
) -> Result<ThreadDto, String> {
    let normalized_model_id =
        validate_model_for_engine(state.inner(), "codex", model_id.trim()).await?;
    let db = state.db.clone();
    let (workspace_root, repos, existing_local_thread) = run_db(db.clone(), {
        let workspace_id = workspace_id.clone();
        let engine_thread_id = engine_thread_id.clone();
        move |db| {
            let workspace = db::workspaces::find_workspace_by_id(db, &workspace_id)?
                .ok_or_else(|| anyhow::anyhow!("workspace not found: {workspace_id}"))?;
            let repos = db::repos::get_repos(db, &workspace_id)?;
            let existing =
                db::threads::find_thread_by_engine_thread_id(db, "codex", &engine_thread_id)?
                    .filter(|thread| thread.workspace_id == workspace_id);
            Ok((workspace.root_path, repos, existing))
        }
    })
    .await?;

    let mut remote_thread = state
        .engines
        .read_codex_remote_thread(&engine_thread_id)
        .await
        .map_err(err_to_string)?;
    if remote_thread.archived {
        state
            .engines
            .unarchive_codex_remote_thread(&engine_thread_id)
            .await
            .map_err(err_to_string)?;
        remote_thread.archived = false;
    }
    let repo_id = resolve_codex_remote_thread_repo_id(&workspace_root, &repos, &remote_thread.cwd)?;
    let title = build_codex_remote_thread_title(&remote_thread);
    let metadata = build_codex_remote_thread_metadata(&remote_thread, &normalized_model_id);

    if let Some(existing) = existing_local_thread {
        return run_db(db, move |db| {
            let thread = match db::threads::restore_thread(db, &existing.id) {
                Ok(restored) => restored,
                Err(_) => existing,
            };
            db::threads::update_thread_runtime_snapshot(
                db,
                &thread.id,
                Some(&title),
                map_codex_thread_status_to_local(
                    Some(remote_thread.status_type.as_str()),
                    &remote_thread.active_flags,
                    false,
                ),
                Some(&metadata),
            )
        })
        .await;
    }

    run_db(db, move |db| {
        let created = db::threads::create_thread(
            db,
            &workspace_id,
            repo_id.as_deref(),
            "codex",
            &normalized_model_id,
            &title,
        )?;
        db::threads::set_engine_thread_id(db, &created.id, &engine_thread_id)?;
        db::threads::update_thread_runtime_snapshot(
            db,
            &created.id,
            Some(&title),
            map_codex_thread_status_to_local(
                Some(remote_thread.status_type.as_str()),
                &remote_thread.active_flags,
                false,
            ),
            Some(&metadata),
        )
    })
    .await
}

async fn validate_model_for_engine(
    state: &AppState,
    engine_id: &str,
    requested_model_id: &str,
) -> Result<String, String> {
    let normalized_model_id = requested_model_id.trim();
    if normalized_model_id.is_empty() {
        return Err("model id cannot be empty".to_string());
    }

    if let Ok(engines) = state.engines.list_engines().await {
        if let Some(engine) = engines.iter().find(|engine| engine.id == engine_id) {
            if engine
                .models
                .iter()
                .any(|model| model.id == normalized_model_id)
            {
                return Ok(normalized_model_id.to_string());
            }

            let available = engine
                .models
                .iter()
                .map(|model| model.id.clone())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "model `{normalized_model_id}` is not supported by engine `{engine_id}`. available models: {available}"
            ));
        }
    }

    Ok(normalized_model_id.to_string())
}

fn collect_remote_thread_roots(
    workspace_root: &str,
    repos: &[RepoDto],
) -> std::collections::HashSet<String> {
    let mut roots = std::collections::HashSet::with_capacity(repos.len() + 1);
    roots.insert(workspace_root.to_string());
    for repo in repos {
        roots.insert(repo.path.clone());
    }
    roots
}

fn normalize_remote_thread_search_term(search_term: Option<String>) -> Option<String> {
    search_term
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_codex_remote_thread_cursor(cursor: Option<&str>) -> Result<usize, String> {
    let Some(cursor) = cursor.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(0);
    };

    cursor.parse::<usize>().map_err(|_| {
        format!("invalid Codex remote thread cursor `{cursor}`. expected a non-negative offset")
    })
}

fn normalize_codex_remote_thread_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(20).clamp(1, 100) as usize
}

fn map_codex_remote_thread_dto(
    thread: CodexRemoteThreadSummary,
    local_thread_id: Option<String>,
) -> CodexRemoteThreadDto {
    CodexRemoteThreadDto {
        engine_thread_id: thread.engine_thread_id,
        title: thread.title,
        preview: thread.preview,
        cwd: thread.cwd,
        created_at: codex_remote_thread_timestamp_to_rfc3339(thread.created_at),
        updated_at: codex_remote_thread_timestamp_to_rfc3339(thread.updated_at),
        model_provider: thread.model_provider,
        source_kind: thread.source_kind,
        status_type: thread.status_type,
        active_flags: thread.active_flags,
        archived: thread.archived,
        local_thread_id,
    }
}

fn codex_remote_thread_timestamp_to_rfc3339(timestamp: i64) -> String {
    let (seconds, nanos) = if timestamp > 10_000_000_000 {
        (timestamp / 1000, ((timestamp % 1000) as u32) * 1_000_000)
    } else {
        (timestamp, 0)
    };

    DateTime::<Utc>::from_timestamp(seconds, nanos)
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

fn resolve_codex_remote_thread_repo_id(
    workspace_root: &str,
    repos: &[RepoDto],
    cwd: &str,
) -> Result<Option<String>, String> {
    if cwd == workspace_root {
        return Ok(None);
    }

    if let Some(repo) = repos.iter().find(|repo| repo.path == cwd) {
        return Ok(Some(repo.id.clone()));
    }

    Err(format!(
        "Codex thread cwd `{cwd}` is outside the active workspace and cannot be attached"
    ))
}

fn build_codex_remote_thread_title(thread: &CodexRemoteThreadSummary) -> String {
    if let Some(title) = thread
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return normalize_thread_title(title).unwrap_or_else(|_| {
            format!(
                "Codex thread {}",
                short_thread_label(&thread.engine_thread_id)
            )
        });
    }

    if let Some(preview) = thread
        .preview
        .trim()
        .split('\n')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return normalize_thread_title(preview).unwrap_or_else(|_| {
            format!(
                "Codex thread {}",
                short_thread_label(&thread.engine_thread_id)
            )
        });
    }

    format!(
        "Codex thread {}",
        short_thread_label(&thread.engine_thread_id)
    )
}

fn short_thread_label(engine_thread_id: &str) -> String {
    engine_thread_id.chars().take(8).collect()
}

fn build_codex_remote_thread_metadata(thread: &CodexRemoteThreadSummary, model_id: &str) -> Value {
    let mut metadata = merge_codex_runtime_metadata(
        None,
        Some(thread.status_type.as_str()),
        &thread.active_flags,
        Some(thread.preview.as_str()),
        true,
        Some("remote_thread_attached"),
    );
    // The remote-list summary is advisory. Only the full sync snapshot is
    // allowed to assert that a remote turn is still active.
    codex_thread_metadata::set_confirmed_remote_turn(&mut metadata, false);

    if let Some(object) = metadata.as_object_mut() {
        object.insert("lastModelId".to_string(), json!(model_id));
        object.insert("codexTranscriptImported".to_string(), json!(false));
        object.insert(
            "codexModelProvider".to_string(),
            json!(thread.model_provider),
        );
        object.insert("codexSourceKind".to_string(), json!(thread.source_kind));
        object.insert("codexRemoteArchived".to_string(), json!(thread.archived));
        object.insert("codexRemoteCwd".to_string(), json!(thread.cwd));
        object.insert(
            "codexRemoteCreatedAt".to_string(),
            json!(codex_remote_thread_timestamp_to_rfc3339(thread.created_at)),
        );
        object.insert(
            "codexRemoteUpdatedAt".to_string(),
            json!(codex_remote_thread_timestamp_to_rfc3339(thread.updated_at)),
        );
    }

    metadata
}

// Tauri maps these individually named fields directly from the existing IPC
// request, so changing this to a nested DTO would be a wire-format change.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_thread(
    state: State<'_, AppState>,
    workspace_id: String,
    repo_id: Option<String>,
    engine_id: String,
    model_id: String,
    title: String,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
) -> Result<ThreadDto, String> {
    create_thread_inner(
        state.inner(),
        workspace_id,
        repo_id,
        engine_id,
        model_id,
        title,
        reasoning_effort,
        service_tier,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn create_thread_inner(
    state: &AppState,
    workspace_id: String,
    repo_id: Option<String>,
    engine_id: String,
    model_id: String,
    title: String,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
) -> Result<ThreadDto, String> {
    if engine_id != "codex" {
        return Err("only Codex threads are supported".to_string());
    }
    let effective_model_id = validate_model_for_engine(state, &engine_id, model_id.trim()).await?;
    let normalized_reasoning_effort = reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    let validated_reasoning_effort =
        if let Some(requested_effort) = normalized_reasoning_effort.as_deref() {
            Some(
                validate_reasoning_effort(state, &engine_id, &effective_model_id, requested_effort)
                    .await?,
            )
        } else {
            None
        };
    let normalized_service_tier = normalize_thread_service_tier(service_tier)?;

    let metadata = if validated_reasoning_effort.is_some() || normalized_service_tier.is_some() {
        let mut object = serde_json::Map::new();
        if let Some(value) = validated_reasoning_effort {
            object.insert("reasoningEffort".to_string(), json!(value));
        }
        if let Some(value) = normalized_service_tier {
            object.insert("serviceTier".to_string(), json!(value));
        }
        Some(Value::Object(object))
    } else {
        None
    };

    run_db(state.db.clone(), move |db| {
        let created = db::threads::create_thread(
            db,
            &workspace_id,
            repo_id.as_deref(),
            &engine_id,
            &effective_model_id,
            &title,
        )?;
        if let Some(metadata) = metadata.as_ref() {
            db::threads::update_engine_metadata(db, &created.id, metadata)?;
        }
        db::threads::get_thread(db, &created.id)?
            .ok_or_else(|| anyhow::anyhow!("thread not found after insert: {}", created.id))
    })
    .await
}

#[tauri::command]
pub async fn confirm_workspace_thread(
    state: State<'_, AppState>,
    thread_id: String,
    writable_roots: Vec<String>,
) -> Result<(), String> {
    let db = state.db.clone();
    let (thread, workspace_root, repo_paths) = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| {
            let thread = db::threads::get_thread(db, &thread_id)?
                .ok_or_else(|| anyhow::anyhow!("thread not found: {thread_id}"))?;
            let workspace = db::workspaces::list_workspaces(db)?
                .into_iter()
                .find(|item| item.id == thread.workspace_id)
                .ok_or_else(|| anyhow::anyhow!("workspace not found for thread {thread_id}"))?;
            let repo_paths = db::repos::get_repos(db, &thread.workspace_id)?
                .into_iter()
                .map(|repo| repo.path)
                .collect::<Vec<_>>();
            Ok((thread, workspace.root_path, repo_paths))
        }
    })
    .await?;

    if thread.repo_id.is_some() {
        return Err("confirmation only applies to workspace threads".to_string());
    }

    let normalized_writable_roots =
        normalize_workspace_confirmation_roots(&writable_roots, &workspace_root, &repo_paths)?;

    let mut metadata = thread.engine_metadata.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        object.insert("workspaceWriteOptIn".to_string(), json!(true));
        object.insert(
            "workspaceWritableRoots".to_string(),
            json!(normalized_writable_roots),
        );
        object.insert(
            "workspaceWriteConfirmedAt".to_string(),
            json!(Utc::now().to_rfc3339()),
        );
    }

    run_db(db, move |db| {
        db::threads::update_engine_metadata(db, &thread_id, &metadata)
    })
    .await
}

#[tauri::command]
pub async fn set_thread_reasoning_effort(
    state: State<'_, AppState>,
    thread_id: String,
    reasoning_effort: Option<String>,
    model_id: Option<String>,
) -> Result<(), String> {
    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;
    let normalized_model_id = model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let effective_model_id = match normalized_model_id {
        Some(model_id) => {
            validate_model_for_thread_engine(state.inner(), &thread, model_id).await?
        }
        None => thread.model_id.clone(),
    };

    let normalized_effort = reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);

    let validated_effort = if let Some(value) = normalized_effort.as_deref() {
        Some(
            validate_reasoning_effort(
                state.inner(),
                &thread.engine_id,
                effective_model_id.as_str(),
                value,
            )
            .await?,
        )
    } else {
        None
    };

    let mut metadata = thread.engine_metadata.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        match validated_effort {
            Some(value) => {
                object.insert("reasoningEffort".to_string(), json!(value));
            }
            None => {
                object.remove("reasoningEffort");
            }
        };
    }

    run_db(db, move |db| {
        db::threads::update_engine_metadata(db, &thread_id, &metadata)
    })
    .await
}

#[tauri::command]
pub async fn rename_thread(
    state: State<'_, AppState>,
    thread_id: String,
    title: String,
) -> Result<ThreadDto, String> {
    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;

    let normalized_title = normalize_thread_title(&title)?;

    run_db(db.clone(), {
        let thread_id = thread_id.clone();
        let normalized_title = normalized_title.clone();
        move |db| db::threads::update_thread_title(db, &thread_id, &normalized_title)
    })
    .await?;

    let mut metadata = thread.engine_metadata.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        object.insert("manualTitle".to_string(), json!(true));
        object.insert(
            "manualTitleUpdatedAt".to_string(),
            json!(Utc::now().to_rfc3339()),
        );
    }

    run_db(db.clone(), {
        let thread_id = thread_id.clone();
        let metadata = metadata.clone();
        move |db| db::threads::update_engine_metadata(db, &thread_id, &metadata)
    })
    .await?;

    run_db(db, {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found after rename: {thread_id}"))
}

#[tauri::command]
pub async fn delete_thread(state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    state.turns.cancel(&thread_id).await;

    let db = state.db.clone();
    if let Some(thread) = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    {
        if let Err(error) = state.engines.interrupt(&thread).await {
            log::warn!("failed to interrupt thread before deletion: {error}");
        }
    } else {
        state.turns.finish(&thread_id).await;
        return Err(format!("thread not found: {thread_id}"));
    }

    run_db(db, {
        let thread_id = thread_id.clone();
        move |db| db::threads::delete_thread(db, &thread_id)
    })
    .await?;
    state.turns.finish(&thread_id).await;
    Ok(())
}

#[tauri::command]
pub async fn archive_thread(state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    state.turns.cancel(&thread_id).await;

    let db = state.db.clone();
    let result = async {
        let thread = run_db(db.clone(), {
            let thread_id = thread_id.clone();
            move |db| db::threads::get_thread(db, &thread_id)
        })
        .await?
        .ok_or_else(|| format!("thread not found: {thread_id}"))?;

        if let Err(error) = state.engines.interrupt(&thread).await {
            log::warn!("failed to interrupt thread before archive: {error}");
        }

        state
            .engines
            .archive_thread(&thread)
            .await
            .map_err(err_to_string)?;

        run_db(db, {
            let thread_id = thread_id.clone();
            move |db| db::threads::archive_thread(db, &thread_id)
        })
        .await?;

        Ok(())
    }
    .await;

    state.turns.finish(&thread_id).await;
    result
}

#[tauri::command]
pub async fn restore_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<ThreadDto, String> {
    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;

    state
        .engines
        .unarchive_thread(&thread)
        .await
        .map_err(err_to_string)?;

    let restored = run_db(db, move |db| db::threads::restore_thread(db, &thread_id)).await?;

    Ok(restored)
}

#[tauri::command]
pub async fn sync_thread_from_engine(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<ThreadDto, String> {
    let _history_guard = state.pending_rollbacks.lock_history(&thread_id).await;
    let db = state.db.clone();
    let mut thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;

    if thread.engine_id != "codex" {
        return Ok(thread);
    }

    if is_engine_fork_pending(thread.engine_metadata.as_ref()) {
        thread = resolve_pending_engine_fork(state.inner(), &thread.id).await?;
    }
    if is_engine_rollback_pending(thread.engine_metadata.as_ref()) {
        let result = resolve_pending_engine_rollback(state.inner(), &thread.id, None).await;
        if result.is_err() {
            // Recovery may deliberately cancel an old/conflicting edit. Return the
            // reconciled thread to refresh UI state, while send/fork still fail closed.
            let current = run_db(db.clone(), {
                let id = thread.id.clone();
                move |db| db::threads::get_thread(db, &id)
            })
            .await?
            .ok_or("thread disappeared during recovery")?;
            if !is_engine_rollback_pending(current.engine_metadata.as_ref()) {
                return Ok(current);
            }
        }
        return result;
    }

    let Some(snapshot) = state
        .engines
        .read_thread_sync_snapshot(&thread)
        .await
        .map_err(err_to_string)?
    else {
        return Ok(thread);
    };

    let has_local_turn = state.turns.get(&thread_id).await.is_some();
    let has_active_remote_turn =
        !snapshot.active_flags.is_empty() || imported_messages_have_streaming_turn(&snapshot);
    let compatibility_fork = is_codex_compatibility_fork(thread.engine_metadata.as_ref());
    let should_import_messages = !has_local_turn && !has_active_remote_turn;
    if should_import_messages {
        let imported_messages = snapshot
            .imported_messages
            .iter()
            .map(|message| db::messages::ImportedMessageRecord {
                role: message.role.clone(),
                content: message.content.clone(),
                blocks: message.blocks.clone(),
                status: MessageStatusDto::from_str(message.status.as_str()),
                native_turn_id: message.native_turn_id.clone(),
                turn_engine_id: message.turn_engine_id.clone(),
                turn_model_id: message.turn_model_id.clone(),
                turn_reasoning_effort: message.turn_reasoning_effort.clone(),
                token_input: message.token_input,
                token_output: message.token_output,
                created_at: message.created_at.clone(),
            })
            .collect::<Vec<_>>();
        run_db(db.clone(), {
            let thread_id = thread_id.clone();
            move |db| {
                db::messages::replace_thread_messages(db, &thread_id, &imported_messages)?;
                Ok::<_, anyhow::Error>(())
            }
        })
        .await?;
    }

    let sync_required = !has_local_turn && has_active_remote_turn;
    let mut metadata = merge_codex_runtime_metadata(
        thread.engine_metadata.clone(),
        snapshot.raw_status.as_deref(),
        &snapshot.active_flags,
        snapshot.preview.as_deref(),
        sync_required,
        sync_required.then_some(REMOTE_TURN_ACTIVE_SYNC_REASON),
    );
    if let Some(mode) = &snapshot.history_mode {
        metadata["codexHistoryMode"] = json!(mode);
    }
    codex_thread_metadata::set_confirmed_remote_turn(&mut metadata, has_active_remote_turn);
    let metadata = mark_codex_transcript_imported(metadata, should_import_messages);
    let metadata = if compatibility_fork && !has_local_turn && !has_active_remote_turn {
        mark_codex_compatibility_history_complete(metadata)
    } else {
        metadata
    };
    let next_status = resolve_codex_sync_thread_status(&snapshot, has_local_turn);

    run_db(db, {
        let thread_id = thread_id.clone();
        let title = snapshot.title.clone();
        let metadata = metadata.clone();
        let next_status = next_status.clone();
        move |db| {
            db::threads::update_thread_runtime_snapshot(
                db,
                &thread_id,
                title.as_deref(),
                next_status,
                Some(&metadata),
            )
        }
    })
    .await
}

#[tauri::command]
pub async fn refresh_thread_usage_limits(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<RefreshThreadUsageLimitsResultDto, String> {
    let db = state.db.clone();
    let thread = run_db(db, {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;

    let read_result = match state.engines.read_thread_usage_limits(&thread).await {
        Ok(read_result) => read_result,
        Err(error) => crate::engines::UsageLimitsReadResult {
            usage: None,
            diagnostics: crate::engines::UsageLimitsReadDiagnostics {
                fatal_error: Some(err_to_string(error)),
                ..crate::engines::UsageLimitsReadDiagnostics::default()
            },
        },
    };

    let cached_context = cached_context_usage_from_metadata(thread.engine_metadata.as_ref());
    let cached_context_available = cached_context.is_some();
    let should_apply_cached_context =
        usage_snapshot_missing_context(read_result.usage.as_ref()) && cached_context.is_some();
    let effective_usage = if let Some(cached_context) = cached_context.as_ref() {
        if should_apply_cached_context {
            Some(merge_cached_context_usage(
                read_result.usage.clone(),
                cached_context,
            ))
        } else {
            read_result.usage.clone()
        }
    } else {
        read_result.usage.clone()
    };

    if let Some(usage) = effective_usage
        .as_ref()
        .filter(|usage| usage_snapshot_has_context_metrics(usage))
    {
        if let Err(error) = run_db(state.db.clone(), {
            let thread_id = thread_id.clone();
            let metadata =
                merge_context_usage_cache_into_metadata(thread.engine_metadata.clone(), usage);
            move |db| db::threads::update_engine_metadata(db, &thread_id, &metadata)
        })
        .await
        {
            log::warn!("failed to persist context usage cache during refresh: {error}");
        }
    }

    let refreshed = if let Some(usage) = effective_usage.clone() {
        let stream_event_topic = format!("stream-event-{thread_id}");
        let _ = app.emit(
            &stream_event_topic,
            serde_json::json!({
                "type": "UsageLimitsUpdated",
                "usage": usage,
            }),
        );
        true
    } else {
        false
    };

    let usage = effective_usage.as_ref();
    Ok(RefreshThreadUsageLimitsResultDto {
        refreshed,
        missing_context: usage_snapshot_missing_context(usage),
        diagnostics: RefreshThreadUsageLimitsDiagnosticsDto {
            thread_id,
            engine_id: thread.engine_id.clone(),
            model_id: thread.model_id.clone(),
            thread_status: thread.status.as_str().to_string(),
            message_count: thread.message_count,
            last_activity_at: thread.last_activity_at.clone(),
            engine_thread_id: thread.engine_thread_id.clone(),
            thread_read_attempted: read_result.diagnostics.thread_read_attempted,
            thread_read_succeeded: read_result.diagnostics.thread_read_succeeded,
            latest_turn_read_attempted: read_result.diagnostics.latest_turn_read_attempted,
            latest_turn_read_succeeded: read_result.diagnostics.latest_turn_read_succeeded,
            latest_turn_source: read_result.diagnostics.latest_turn_source.clone(),
            latest_turn_id: read_result.diagnostics.latest_turn_id.clone(),
            latest_turn_had_token_usage: read_result.diagnostics.latest_turn_had_token_usage,
            cached_context_available,
            cached_context_used: should_apply_cached_context,
            account_read_attempted: read_result.diagnostics.account_read_attempted,
            account_read_succeeded: read_result.diagnostics.account_read_succeeded,
            current_tokens: usage.and_then(|value| value.current_tokens),
            max_context_tokens: usage.and_then(|value| value.max_context_tokens),
            context_window_percent: usage.and_then(|value| value.context_window_percent),
            five_hour_percent: usage.and_then(|value| value.five_hour_percent),
            weekly_percent: usage.and_then(|value| value.weekly_percent),
            five_hour_resets_at: usage.and_then(|value| value.five_hour_resets_at),
            weekly_resets_at: usage.and_then(|value| value.weekly_resets_at),
            thread_read_error: read_result.diagnostics.thread_read_error.clone(),
            latest_turn_read_error: read_result.diagnostics.latest_turn_read_error.clone(),
            account_read_error: read_result.diagnostics.account_read_error.clone(),
            fatal_error: read_result.diagnostics.fatal_error.clone(),
        },
    })
}

fn mark_codex_transcript_imported(mut metadata: Value, imported: bool) -> Value {
    if imported {
        if let Some(object) = metadata.as_object_mut() {
            object.insert("codexTranscriptImported".to_string(), json!(true));
        }
    }

    metadata
}

fn imported_messages_have_streaming_turn(snapshot: &ThreadSyncSnapshot) -> bool {
    snapshot
        .imported_messages
        .iter()
        .any(|message| message.status == "streaming")
}

struct CodexForkPoint {
    source_message_id: Option<String>,
    last_turn_id: Option<String>,
    turns_after: u32,
}

fn has_stable_active_fork_boundary(fork_point: Option<&CodexForkPoint>) -> bool {
    // The database validates that this exact message is a completed assistant
    // response. A native turn id keeps the fast native-fork path; a legacy message
    // without one is materialized through the compatibility path instead.
    fork_point.is_some_and(|fork_point| fork_point.source_message_id.is_some())
}

/// Metadata key marking a branch whose engine-level Codex fork has not completed yet.
const ENGINE_FORK_PENDING_KEY: &str = "engineForkPending";
/// The source engine thread id the deferred fork must branch from.
const ENGINE_FORK_SOURCE_KEY: &str = "engineForkSourceEngineThreadId";
/// Optional explicit turn id to fork at (supplied by the message-edit branch flow).
const ENGINE_FORK_LAST_TURN_KEY: &str = "engineForkLastTurnId";
/// Optional number of trailing turns to drop when resolving the fork point.
const ENGINE_FORK_TURNS_AFTER_KEY: &str = "engineForkTurnsAfter";
const ENGINE_FORK_ERROR_KEY: &str = "engineForkError";
/// Marks a branch whose engine thread was rebuilt from sanitized visible history.
const CODEX_COMPATIBILITY_FORK_KEY: &str = "codexCompatibilityFork";
/// Confirms that the display mirror contains both the durable injected prefix and
/// native app-server turns for a compatibility fork.
const CODEX_COMPATIBILITY_HISTORY_COMPLETE_KEY: &str = "codexCompatibilityHistoryComplete";

/// Everything the deferred background fork needs to materialize the engine thread for a
/// branch, captured from the source thread at branch-creation time.
#[derive(Clone, Debug, PartialEq)]
struct EngineForkIntent {
    source_engine_thread_id: String,
    last_turn_id: Option<String>,
    turns_after: Option<u32>,
}

fn fork_boundary_requires_compatibility(intent: &EngineForkIntent) -> bool {
    intent.turns_after.is_some() && intent.last_turn_id.is_none()
}

pub fn is_engine_fork_pending(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(|value| value.get(ENGINE_FORK_PENDING_KEY))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn engine_fork_intent(metadata: Option<&Value>) -> Option<EngineForkIntent> {
    let metadata = metadata?;
    if !metadata
        .get(ENGINE_FORK_PENDING_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let source_engine_thread_id = metadata
        .get(ENGINE_FORK_SOURCE_KEY)
        .and_then(Value::as_str)
        .map(str::to_string)?;
    let last_turn_id = metadata
        .get(ENGINE_FORK_LAST_TURN_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let turns_after = metadata
        .get(ENGINE_FORK_TURNS_AFTER_KEY)
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    Some(EngineForkIntent {
        source_engine_thread_id,
        last_turn_id,
        turns_after,
    })
}

/// Records the fork intent onto a branch's metadata so the engine thread can be
/// materialized later (in the background, or on first use of the branch).
fn mark_engine_fork_pending(mut metadata: Value, intent: &EngineForkIntent) -> Value {
    if !metadata.is_object() {
        metadata = json!({});
    }
    if let Some(object) = metadata.as_object_mut() {
        object.insert(ENGINE_FORK_PENDING_KEY.to_string(), json!(true));
        object.remove(ENGINE_FORK_ERROR_KEY);
        object.insert(
            ENGINE_FORK_SOURCE_KEY.to_string(),
            json!(intent.source_engine_thread_id),
        );
        match intent.last_turn_id.as_deref() {
            Some(last_turn_id) => {
                object.insert(ENGINE_FORK_LAST_TURN_KEY.to_string(), json!(last_turn_id));
            }
            None => {
                object.remove(ENGINE_FORK_LAST_TURN_KEY);
            }
        }
        match intent.turns_after {
            Some(turns_after) => {
                object.insert(ENGINE_FORK_TURNS_AFTER_KEY.to_string(), json!(turns_after));
            }
            None => {
                object.remove(ENGINE_FORK_TURNS_AFTER_KEY);
            }
        }
    }
    metadata
}

/// Removes all deferred-fork bookkeeping once the engine thread has been attached.
fn clear_engine_fork_pending(mut metadata: Value) -> Value {
    if let Some(object) = metadata.as_object_mut() {
        object.remove(ENGINE_FORK_PENDING_KEY);
        object.remove(ENGINE_FORK_SOURCE_KEY);
        object.remove(ENGINE_FORK_LAST_TURN_KEY);
        object.remove(ENGINE_FORK_TURNS_AFTER_KEY);
        object.remove(ENGINE_FORK_ERROR_KEY);
    }
    metadata
}

fn is_codex_compatibility_fork(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(|value| value.get(CODEX_COMPATIBILITY_FORK_KEY))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn mark_codex_compatibility_history_complete(mut metadata: Value) -> Value {
    if !metadata.is_object() {
        metadata = json!({});
    }
    if let Some(object) = metadata.as_object_mut() {
        object.insert(
            CODEX_COMPATIBILITY_HISTORY_COMPLETE_KEY.to_string(),
            json!(true),
        );
    }
    metadata
}

/// Durable history intent. Old records have already projected locally; new
/// records set `engineRollbackRemoteFirst` and preserve the original transcript.
const ENGINE_ROLLBACK_PENDING_KEY: &str = "engineRollbackPending";
const ENGINE_ROLLBACK_PHASE_KEY: &str = "engineRollbackPhase";
const ENGINE_ROLLBACK_NUM_TURNS_KEY: &str = "engineRollbackNumTurns";
const ENGINE_ROLLBACK_SOURCE_TURN_COUNT_KEY: &str = "engineRollbackSourceTurnCount";
const ENGINE_ROLLBACK_TARGET_TURN_COUNT_KEY: &str = "engineRollbackTargetTurnCount";
const ENGINE_ROLLBACK_ERROR_KEY: &str = "engineRollbackError";
const ENGINE_ROLLBACK_REMOTE_FIRST_KEY: &str = "engineRollbackRemoteFirst";
const ENGINE_ROLLBACK_SOURCE_IDS_KEY: &str = "engineRollbackSourceTurnIds";
const ENGINE_ROLLBACK_REJECTED_KEY: &str = "engineRollbackRejected";
/// Codex-owned durable marker counts bracketing a compatibility rollback request.
/// Unlike `Thread.turns`, these include a definitive persisted completion signal even
/// when most model-visible history came from `thread/inject_items`.
const ENGINE_ROLLBACK_MARKERS_BEFORE_KEY: &str = "engineRollbackMarkersBefore";
const ENGINE_ROLLBACK_MARKERS_AFTER_KEY: &str = "engineRollbackMarkersAfter";

#[derive(Clone, Copy, Debug, PartialEq)]
enum EngineRollbackPhase {
    Prepared,
    Started,
}

#[derive(Clone, Debug, PartialEq)]
struct EngineRollbackIntent {
    num_turns: u32,
    source_turn_count: u32,
    target_turn_count: u32,
    phase: EngineRollbackPhase,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexRollbackMaterializedEvent {
    thread_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexCompatibilityForkMaterializedEvent {
    thread_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadUpdatedEvent {
    thread_id: String,
    workspace_id: String,
    thread: Option<ThreadDto>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexHistoryMutationFailedEvent {
    thread_id: String,
    operation: String,
    message: String,
}

fn emit_codex_compatibility_fork_materialized(app: &tauri::AppHandle, thread_id: &str) {
    if let Err(error) = app.emit(
        "codex-compatibility-fork-materialized",
        CodexCompatibilityForkMaterializedEvent {
            thread_id: thread_id.to_string(),
        },
    ) {
        log::warn!(
            "failed to emit materialized compatibility fork for thread {thread_id}: {error}"
        );
    }
}

fn emit_thread_updated(app: &tauri::AppHandle, thread: ThreadDto) {
    let event = ThreadUpdatedEvent {
        thread_id: thread.id.clone(),
        workspace_id: thread.workspace_id.clone(),
        thread: Some(thread),
    };
    if let Err(error) = app.emit("thread-updated", event) {
        log::warn!("failed to emit materialized thread update: {error}");
    }
}

/// Backfill old records without loading or replacing their transcript, and without
/// delaying opening/sending. The conditional DB update preserves concurrent edits.
pub fn backfill_codex_history_mode(app: tauri::AppHandle, state: AppState, thread_id: String) {
    tokio::spawn(async move {
        let result: Result<(), String> = async {
            let thread = run_db(state.db.clone(), {
                let id = thread_id.clone();
                move |db| db::threads::get_thread(db, &id)
            })
            .await?;
            let Some(thread) = thread.filter(|t| {
                t.engine_id == "codex"
                    && !matches!(
                        t.engine_metadata
                            .as_ref()
                            .and_then(|m| m.get("codexHistoryMode"))
                            .and_then(Value::as_str),
                        Some("legacy" | "paginated")
                    )
            }) else {
                return Ok(());
            };
            let Some(engine_id) = thread.engine_thread_id else {
                return Ok(());
            };
            let Some(mode) = state.engines.read_codex_history_mode(&engine_id).await else {
                return Ok(());
            };
            let updated = run_db(state.db.clone(), move |db| {
                db::threads::backfill_codex_history_mode(db, &thread.id, &engine_id, &mode)
            })
            .await?;
            if let Some(updated) = updated {
                emit_thread_updated(&app, updated);
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            log::debug!("history mode backfill for {thread_id} deferred: {error}");
        }
    });
}

fn emit_codex_history_mutation_failed(
    app: &tauri::AppHandle,
    thread_id: &str,
    operation: &str,
    message: &str,
) {
    if let Err(error) = app.emit(
        "codex-history-mutation-failed",
        CodexHistoryMutationFailedEvent {
            thread_id: thread_id.to_string(),
            operation: operation.to_string(),
            message: message.to_string(),
        },
    ) {
        log::warn!("failed to emit Codex {operation} failure for thread {thread_id}: {error}");
    }
}

pub fn emit_codex_rollback_materialized(app: &tauri::AppHandle, thread_id: &str) {
    if let Err(error) = app.emit(
        "codex-rollback-materialized",
        CodexRollbackMaterializedEvent {
            thread_id: thread_id.to_string(),
        },
    ) {
        log::warn!("failed to emit materialized rollback for thread {thread_id}: {error}");
    }
}

pub fn is_engine_rollback_pending(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(|value| value.get(ENGINE_ROLLBACK_PENDING_KEY))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn engine_rollback_intent(metadata: Option<&Value>) -> Option<EngineRollbackIntent> {
    let metadata = metadata?;
    if !is_engine_rollback_pending(Some(metadata)) {
        return None;
    }

    let read_u32 = |key: &str| {
        metadata
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
    };
    let num_turns = read_u32(ENGINE_ROLLBACK_NUM_TURNS_KEY)?;
    let source_turn_count = read_u32(ENGINE_ROLLBACK_SOURCE_TURN_COUNT_KEY)?;
    let target_turn_count = read_u32(ENGINE_ROLLBACK_TARGET_TURN_COUNT_KEY)?;
    let phase = match metadata
        .get(ENGINE_ROLLBACK_PHASE_KEY)
        .and_then(Value::as_str)
    {
        Some("prepared") => EngineRollbackPhase::Prepared,
        Some("started") => EngineRollbackPhase::Started,
        _ => return None,
    };
    if num_turns == 0 || source_turn_count.checked_sub(num_turns) != Some(target_turn_count) {
        return None;
    }

    Some(EngineRollbackIntent {
        num_turns,
        source_turn_count,
        target_turn_count,
        phase,
    })
}

fn mark_engine_rollback_pending(mut metadata: Value, intent: &EngineRollbackIntent) -> Value {
    if !metadata.is_object() {
        metadata = json!({});
    }
    if let Some(object) = metadata.as_object_mut() {
        object.insert(ENGINE_ROLLBACK_PENDING_KEY.to_string(), json!(true));
        object.insert(
            ENGINE_ROLLBACK_PHASE_KEY.to_string(),
            json!(match intent.phase {
                EngineRollbackPhase::Prepared => "prepared",
                EngineRollbackPhase::Started => "started",
            }),
        );
        object.insert(
            ENGINE_ROLLBACK_NUM_TURNS_KEY.to_string(),
            json!(intent.num_turns),
        );
        object.insert(
            ENGINE_ROLLBACK_SOURCE_TURN_COUNT_KEY.to_string(),
            json!(intent.source_turn_count),
        );
        object.insert(
            ENGINE_ROLLBACK_TARGET_TURN_COUNT_KEY.to_string(),
            json!(intent.target_turn_count),
        );
        object.remove(ENGINE_ROLLBACK_ERROR_KEY);
        object.remove(ENGINE_ROLLBACK_MARKERS_BEFORE_KEY);
        object.remove(ENGINE_ROLLBACK_MARKERS_AFTER_KEY);
    }
    metadata
}

fn clear_engine_rollback_pending(mut metadata: Value) -> Value {
    if let Some(object) = metadata.as_object_mut() {
        object.remove(ENGINE_ROLLBACK_REMOTE_FIRST_KEY);
        object.remove(ENGINE_ROLLBACK_SOURCE_IDS_KEY);
        object.remove(ENGINE_ROLLBACK_REJECTED_KEY);
        object.remove(ENGINE_ROLLBACK_PENDING_KEY);
        object.remove(ENGINE_ROLLBACK_PHASE_KEY);
        object.remove(ENGINE_ROLLBACK_NUM_TURNS_KEY);
        object.remove(ENGINE_ROLLBACK_SOURCE_TURN_COUNT_KEY);
        object.remove(ENGINE_ROLLBACK_TARGET_TURN_COUNT_KEY);
        object.remove(ENGINE_ROLLBACK_ERROR_KEY);
        object.remove(ENGINE_ROLLBACK_MARKERS_BEFORE_KEY);
        object.remove(ENGINE_ROLLBACK_MARKERS_AFTER_KEY);
    }
    metadata
}

fn engine_rollback_marker_expectation(metadata: Option<&Value>) -> Option<(u64, u64)> {
    let metadata = metadata?;
    let before = metadata
        .get(ENGINE_ROLLBACK_MARKERS_BEFORE_KEY)
        .and_then(Value::as_u64)?;
    let after = metadata
        .get(ENGINE_ROLLBACK_MARKERS_AFTER_KEY)
        .and_then(Value::as_u64)?;
    (before.checked_add(1) == Some(after)).then_some((before, after))
}

fn mark_engine_rollback_marker_expectation(
    mut metadata: Value,
    before: u64,
) -> Result<Value, String> {
    let after = next_engine_rollback_marker_count(before)?;
    if !metadata.is_object() {
        metadata = json!({});
    }
    if let Some(object) = metadata.as_object_mut() {
        object.insert(
            ENGINE_ROLLBACK_MARKERS_BEFORE_KEY.to_string(),
            json!(before),
        );
        object.insert(ENGINE_ROLLBACK_MARKERS_AFTER_KEY.to_string(), json!(after));
    }
    Ok(metadata)
}

fn next_engine_rollback_marker_count(before: u64) -> Result<u64, String> {
    before
        .checked_add(1)
        .ok_or_else(|| "Codex rollback marker count overflow".to_string())
}

#[tauri::command]
pub async fn fork_codex_thread(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    profile_operation_id: Option<String>,
) -> Result<ThreadDto, String> {
    fork_codex_thread_inner(
        state.inner(),
        thread_id,
        None,
        profile_operation_id,
        Some(app),
    )
    .await
}

#[tauri::command]
pub async fn fork_codex_thread_at_turn(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    source_message_id: Option<String>,
    last_turn_id: Option<String>,
    turns_after: u32,
    profile_operation_id: Option<String>,
) -> Result<ThreadDto, String> {
    fork_codex_thread_inner(
        state.inner(),
        thread_id,
        Some(CodexForkPoint {
            source_message_id: source_message_id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            last_turn_id: last_turn_id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            turns_after,
        }),
        profile_operation_id,
        Some(app),
    )
    .await
}

async fn fork_codex_thread_inner(
    state: &AppState,
    thread_id: String,
    fork_point: Option<CodexForkPoint>,
    profile_operation_id: Option<String>,
    app: Option<tauri::AppHandle>,
) -> Result<ThreadDto, String> {
    let _history_guard = state.pending_rollbacks.lock_history(&thread_id).await;
    let profile_operation_id = profile_operation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let total_started_at = Instant::now();
    log_branch_profile_step(
        profile_operation_id,
        "backend.fork.command.start",
        Some(format!("thread_id={thread_id}")),
    );
    let source_turn_registered = state.turns.get(&thread_id).await.is_some();

    let load_thread_started_at = Instant::now();
    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;
    log_branch_profile_step(
        profile_operation_id,
        "backend.fork.load_thread.done",
        Some(format!(
            "elapsed_ms={}; engine_id={}; has_engine_thread_id={}",
            format_elapsed_ms(load_thread_started_at),
            thread.engine_id,
            thread.engine_thread_id.is_some()
        )),
    );

    let source_turn_active = source_turn_registered
        || matches!(
            thread.status,
            ThreadStatusDto::Streaming | ThreadStatusDto::AwaitingApproval
        );
    if source_turn_active && !has_stable_active_fork_boundary(fork_point.as_ref()) {
        log_branch_profile_step(
            profile_operation_id,
            "backend.fork.command.rejected_active_turn",
            Some(format!("thread_id={thread_id}")),
        );
        return Err(
            "cannot fork an active thread without a completed message and native turn boundary"
                .to_string(),
        );
    }

    if thread.engine_id != "codex" {
        log_branch_profile_step(
            profile_operation_id,
            "backend.fork.command.rejected_non_codex",
            Some(format!(
                "thread_id={thread_id}; engine_id={}",
                thread.engine_id
            )),
        );
        return Err("native fork is only available for Codex threads".to_string());
    }
    // Forking from a branch whose own engine thread has not been materialized yet
    // requires that source fork to complete first, so we can read its engine thread id.
    let thread = if is_engine_fork_pending(thread.engine_metadata.as_ref()) {
        resolve_pending_engine_fork(state, &thread.id).await?
    } else {
        thread
    };
    let thread = if is_engine_rollback_pending(thread.engine_metadata.as_ref()) {
        resolve_pending_engine_rollback(state, &thread.id, None).await?
    } else {
        thread
    };
    let engine_thread_id = thread
        .engine_thread_id
        .clone()
        .ok_or_else(|| "Codex thread has not been initialized yet".to_string())?;

    let (source_message_id, last_turn_id, turns_after, rollback_turns) = if let Some(fork_point) =
        fork_point
    {
        let validate_cutoff_started_at = Instant::now();
        run_db(db.clone(), {
            let thread_id = thread.id.clone();
            let source_message_id = fork_point.source_message_id.clone();
            let last_turn_id = fork_point.last_turn_id.clone();
            let turns_after = fork_point.turns_after;
            move |db| match source_message_id.as_deref() {
                Some(source_message_id) => db::messages::validate_thread_branch_message_cutoff(
                    db,
                    &thread_id,
                    source_message_id,
                    last_turn_id.as_deref(),
                ),
                None => db::messages::validate_thread_branch_cutoff(db, &thread_id, turns_after),
            }
        })
        .await?;
        log_branch_profile_step(
            profile_operation_id,
            "backend.fork.validate_cutoff.done",
            Some(format!(
                "elapsed_ms={}; turns_after={}",
                format_elapsed_ms(validate_cutoff_started_at),
                fork_point.turns_after
            )),
        );
        (
            fork_point.source_message_id.clone(),
            fork_point.last_turn_id,
            Some(fork_point.turns_after),
            (fork_point.source_message_id.is_none() && fork_point.turns_after > 0)
                .then_some(fork_point.turns_after),
        )
    } else {
        (None, None, None, None)
    };

    // Keep native fork materialization off the UI round trip. Current Codex releases
    // complete this quickly, while older app-server versions may still take many seconds.
    // The durable pending intent also lets Panes retry safely after a process restart.
    let intent = EngineForkIntent {
        source_engine_thread_id: engine_thread_id,
        last_turn_id,
        turns_after,
    };
    let create_branch_started_at = Instant::now();
    let created = create_pending_codex_branch_thread(
        state,
        &thread,
        &intent,
        source_message_id.as_deref(),
        rollback_turns,
        profile_operation_id,
    )
    .await?;
    log_branch_profile_step(
        profile_operation_id,
        "backend.fork.local_branch_create.done",
        Some(format!(
            "elapsed_ms={}; created_thread_id={}; total_elapsed_ms={}",
            format_elapsed_ms(create_branch_started_at),
            created.id,
            format_elapsed_ms(total_started_at)
        )),
    );

    // Best-effort prefetch so the engine thread is usually ready before the user sends.
    spawn_engine_fork_prefetch(app, state.clone(), created.id.clone());

    Ok(created)
}

/// Materializes the engine-level Codex thread for a branch created with a pending fork.
///
/// Runs at most once per branch across all racing callers (the background prefetch and
/// any first use of the branch) via the shared
/// [`crate::state::PendingThreadMutationManager`] cell.
/// On success the branch is durably updated with its engine thread id and cleared of the
/// pending markers; the returned [`ThreadDto`] reflects that state. If no fork is pending
/// (already materialized, or not a branch), the current thread is returned unchanged.
pub async fn resolve_pending_engine_fork(
    state: &AppState,
    thread_id: &str,
) -> Result<ThreadDto, String> {
    let cell = state.pending_forks.cell(thread_id).await;
    let result = cell
        .get_or_try_init(|| async {
            let thread = run_db(state.db.clone(), {
                let thread_id = thread_id.to_string();
                move |db| db::threads::get_thread(db, &thread_id)
            })
            .await?
            .ok_or_else(|| format!("thread not found: {thread_id}"))?;

            match engine_fork_intent(thread.engine_metadata.as_ref()) {
                Some(intent) => perform_engine_fork(state, &thread, &intent).await,
                // Nothing pending: another caller already materialized it, or this thread
                // was never a deferred branch. Return whatever is persisted.
                None => Ok(thread),
            }
        })
        .await
        .cloned();

    if result.is_ok() {
        state.pending_forks.forget(thread_id).await;
    }
    result
}

/// Executes the codex `thread/fork` and persists the resulting engine thread onto the
/// branch, clearing the pending markers. It is only ever reached from
/// [`resolve_pending_engine_fork`].
async fn perform_engine_fork(
    state: &AppState,
    branch: &ThreadDto,
    intent: &EngineForkIntent,
) -> Result<ThreadDto, String> {
    let (cwd, model_id, sandbox) = build_codex_branch_context(state, branch).await?;
    // A partial fork without a native turn id points inside injected/legacy history.
    // `Thread.turns` cannot represent that boundary, even when the current rollout is
    // otherwise safe to fork natively, so materialize the exact cloned prefix.
    let compatibility_fork = if fork_boundary_requires_compatibility(intent) {
        true
    } else {
        match state
            .engines
            .codex_fork_requires_compatibility(&intent.source_engine_thread_id)
            .await
        {
            Ok(required) => required,
            Err(error) => {
                // An unreadable or malformed lineage cannot be proven safe for opaque
                // encrypted reasoning, so prefer the sanitized path.
                log::warn!(
                    "could not verify native fork safety for Codex thread {}; using compatibility fork: {error:#}",
                    intent.source_engine_thread_id
                );
                true
            }
        }
    };

    let remote_fork_started_at = Instant::now();
    let forked = if compatibility_fork {
        let history_items = run_db(state.db.clone(), {
            let branch_id = branch.id.clone();
            move |db| {
                let messages = db::messages::get_thread_messages(db, &branch_id)?;
                Ok(build_codex_compatibility_history_items(&messages))
            }
        })
        .await?;
        state
            .engines
            .create_codex_compatibility_fork(&cwd, &model_id, sandbox, history_items)
            .await
            .map_err(err_to_string)?
    } else {
        let last_turn_id = match intent.last_turn_id.clone() {
            Some(last_turn_id) => Some(last_turn_id),
            None => match intent.turns_after {
                Some(turns_after) if turns_after > 0 => Some(
                    state
                        .engines
                        .resolve_codex_fork_turn_id(&intent.source_engine_thread_id, turns_after)
                        .await
                        .map_err(err_to_string)?,
                ),
                _ => None,
            },
        };
        state
            .engines
            .fork_codex_thread(
                &intent.source_engine_thread_id,
                &cwd,
                &model_id,
                last_turn_id.as_deref(),
                sandbox,
            )
            .await
            .map_err(err_to_string)?
    };
    log::info!(
        "materialized deferred codex {} fork for thread {} in {}ms (engine_thread_id={})",
        if forked.compatibility_fork {
            "compatibility"
        } else {
            "native"
        },
        branch.id,
        format_elapsed_ms(remote_fork_started_at),
        forked.engine_thread_id,
    );

    attach_forked_engine_to_branch(state, branch, &forked).await
}

fn build_codex_compatibility_history_items(messages: &[MessageDto]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| {
            let role = match message.role.as_str() {
                "user" => "user",
                "assistant" => "assistant",
                _ => return None,
            };
            let text = compatibility_message_text(message)?;
            let content_type = if role == "assistant" {
                "output_text"
            } else {
                "input_text"
            };
            Some(json!({
                "type": "message",
                "role": role,
                "content": [{
                    "type": content_type,
                    "text": text,
                }],
            }))
        })
        .collect()
}

fn compatibility_message_text(message: &MessageDto) -> Option<String> {
    if let Some(content) = message
        .content
        .as_ref()
        .filter(|content| !content.trim().is_empty())
    {
        return Some(content.clone());
    }

    let text = message
        .blocks
        .as_ref()
        .and_then(Value::as_array)?
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("content").and_then(Value::as_str))
        .filter(|content| !content.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

async fn persist_pending_mutation_error(
    state: &AppState,
    thread_id: &str,
    metadata_key: &'static str,
    error: &str,
) -> Result<ThreadDto, String> {
    let message = error.chars().take(600).collect::<String>();
    run_db(state.db.clone(), {
        let thread_id = thread_id.to_string();
        move |db| {
            let thread = db::threads::get_thread(db, &thread_id)?
                .ok_or_else(|| anyhow::anyhow!("thread not found: {thread_id}"))?;
            let mutation_is_still_pending = match metadata_key {
                ENGINE_FORK_ERROR_KEY => is_engine_fork_pending(thread.engine_metadata.as_ref()),
                ENGINE_ROLLBACK_ERROR_KEY => {
                    is_engine_rollback_pending(thread.engine_metadata.as_ref())
                }
                _ => false,
            };
            if !mutation_is_still_pending {
                return Ok(thread);
            }

            let mut metadata = thread.engine_metadata.clone().unwrap_or_else(|| json!({}));
            if !metadata.is_object() {
                metadata = json!({});
            }
            if let Some(object) = metadata.as_object_mut() {
                object.insert(metadata_key.to_string(), json!(message));
            }
            db::threads::update_engine_metadata(db, &thread_id, &metadata)?;
            db::threads::get_thread(db, &thread_id)?.ok_or_else(|| {
                anyhow::anyhow!("thread not found after recording error: {thread_id}")
            })
        }
    })
    .await
}

/// Fires off the background prefetch that materializes a branch's engine thread. Errors
/// are swallowed — the fork will simply be retried on first use of the branch.
fn spawn_engine_fork_prefetch(app: Option<tauri::AppHandle>, state: AppState, thread_id: String) {
    tokio::spawn(async move {
        match resolve_pending_engine_fork(&state, &thread_id).await {
            Ok(thread) => {
                let compatibility_fork =
                    is_codex_compatibility_fork(thread.engine_metadata.as_ref());
                if let Some(app) = app.as_ref() {
                    emit_thread_updated(app, thread);
                    if compatibility_fork {
                        emit_codex_compatibility_fork_materialized(app, &thread_id);
                    }
                }
            }
            Err(error) => {
                log::warn!("background codex fork prefetch for thread {thread_id} failed: {error}");
                if let Some(app) = app.as_ref() {
                    if let Ok(thread) = persist_pending_mutation_error(
                        &state,
                        &thread_id,
                        ENGINE_FORK_ERROR_KEY,
                        &error,
                    )
                    .await
                    {
                        emit_thread_updated(app, thread);
                    }
                    emit_codex_history_mutation_failed(app, &thread_id, "fork", &error);
                }
            }
        }
    });
}

#[tauri::command]
pub async fn rollback_codex_thread(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    num_turns: u32,
    profile_operation_id: Option<String>,
) -> Result<ThreadDto, String> {
    let _history_guard = state.pending_rollbacks.lock_history(&thread_id).await;
    let profile_operation_id = profile_operation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let total_started_at = Instant::now();
    log_branch_profile_step(
        profile_operation_id,
        "backend.rollback.command.start",
        Some(format!("thread_id={thread_id}; num_turns={num_turns}")),
    );
    if num_turns == 0 {
        log_branch_profile_step(
            profile_operation_id,
            "backend.rollback.command.rejected_zero_turns",
            Some(format!("thread_id={thread_id}")),
        );
        return Err("rollback requires at least one turn".to_string());
    }
    if state.turns.get(&thread_id).await.is_some() {
        log_branch_profile_step(
            profile_operation_id,
            "backend.rollback.command.rejected_active_turn",
            Some(format!("thread_id={thread_id}")),
        );
        return Err("cannot rollback a thread while a turn is still active".to_string());
    }

    let load_thread_started_at = Instant::now();
    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;
    log_branch_profile_step(
        profile_operation_id,
        "backend.rollback.load_thread.done",
        Some(format!(
            "elapsed_ms={}; engine_id={}; has_engine_thread_id={}",
            format_elapsed_ms(load_thread_started_at),
            thread.engine_id,
            thread.engine_thread_id.is_some()
        )),
    );

    if thread.engine_id != "codex" {
        log_branch_profile_step(
            profile_operation_id,
            "backend.rollback.command.rejected_non_codex",
            Some(format!(
                "thread_id={thread_id}; engine_id={}",
                thread.engine_id
            )),
        );
        return Err("native rollback is only available for Codex threads".to_string());
    }
    // Resolve earlier deferred mutations before preparing another rollback so the
    // new local projection always starts from Codex's authoritative current history.
    let thread = if is_engine_fork_pending(thread.engine_metadata.as_ref()) {
        resolve_pending_engine_fork(state.inner(), &thread.id).await?
    } else {
        thread
    };
    let thread = if is_engine_rollback_pending(thread.engine_metadata.as_ref()) {
        resolve_pending_engine_rollback(state.inner(), &thread.id, Some(&app)).await?
    } else {
        thread
    };
    thread
        .engine_thread_id
        .as_deref()
        .ok_or_else(|| "Codex thread has not been initialized yet".to_string())?;
    if !codex_thread_has_local_transcript_for_history_tools(&thread)
        || is_codex_thread_sync_required(thread.engine_metadata.as_ref())
    {
        return Err(
            "native Codex history tools require a locally mirrored transcript. Attached remote threads without imported history cannot be forked or rolled back yet."
                .to_string(),
        );
    }

    let source_turn_count = run_db(db.clone(), {
        let thread_id = thread.id.clone();
        move |db| db::messages::thread_turn_count(db, &thread_id)
    })
    .await?;
    let target_turn_count = source_turn_count.checked_sub(num_turns).ok_or_else(|| {
        format!(
            "cannot drop {num_turns} turns from local thread history with only {source_turn_count} turns"
        )
    })?;
    let intent = EngineRollbackIntent {
        num_turns,
        source_turn_count,
        target_turn_count,
        phase: EngineRollbackPhase::Prepared,
    };
    // Resolve the API and exact native boundary before any local mutation.
    let snapshot = read_codex_rollback_snapshot(state.inner(), &thread).await?;
    let compatibility = is_codex_compatibility_fork(thread.engine_metadata.as_ref());
    let mode = snapshot.history_mode.as_deref().unwrap_or("legacy");
    if !matches!(mode, "legacy" | "paginated") {
        return Err(format!("Unsupported Codex history mode: {mode}"));
    }
    if mode == "paginated" || !compatibility {
        if snapshot.native_turn_ids.len() != source_turn_count as usize {
            return Err("Codex history does not match the local turn boundaries. Refresh this thread before editing it.".into());
        }
        let local_ids = run_db(db.clone(), {
            let id = thread.id.clone();
            move |db| db::messages::thread_native_turn_ids(db, &id)
        })
        .await?;
        if snapshot.native_turn_ids != local_ids {
            return Err("Codex history has no verified native boundary for this edit. Refresh the thread first.".into());
        }
    }
    if !snapshot.active_flags.is_empty() || imported_messages_have_streaming_turn(&snapshot) {
        return Err("Cannot edit history while Codex has an active turn.".into());
    }
    let mut pending_metadata = mark_engine_rollback_pending(
        thread.engine_metadata.clone().unwrap_or_else(|| json!({})),
        &intent,
    );
    pending_metadata["codexHistoryMode"] = json!(mode);
    pending_metadata[ENGINE_ROLLBACK_REMOTE_FIRST_KEY] = json!(true);
    pending_metadata[ENGINE_ROLLBACK_SOURCE_IDS_KEY] = json!(snapshot.native_turn_ids);
    let local_rollback_started_at = Instant::now();
    let projected = run_db(db, {
        let thread = thread.clone();
        let pending_metadata = pending_metadata.clone();
        move |db| {
            db::messages::prepare_pending_thread_rollback(
                db,
                &thread.id,
                num_turns,
                &pending_metadata,
            )?;
            db::threads::get_thread(db, &thread.id)?.ok_or_else(|| {
                anyhow::anyhow!("thread not found after preparing rollback: {}", thread.id)
            })
        }
    })
    .await?;
    log_branch_profile_step(
        profile_operation_id,
        "backend.rollback.local_projection.done",
        Some(format!(
            "elapsed_ms={}; thread_id={}; source_turns={}; target_turns={}; total_elapsed_ms={}",
            format_elapsed_ms(local_rollback_started_at),
            projected.id,
            source_turn_count,
            target_turn_count,
            format_elapsed_ms(total_started_at)
        )),
    );

    // The caller only moves the selected message into the composer after success.
    emit_thread_updated(&app, projected.clone());
    resolve_pending_engine_rollback(state.inner(), &projected.id, Some(&app)).await
}

pub async fn resolve_pending_engine_rollback(
    state: &AppState,
    thread_id: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<ThreadDto, String> {
    let cell = state.pending_rollbacks.cell(thread_id).await;
    let result: Result<ThreadDto, String> = cell
        .get_or_try_init(|| async {
            let thread = run_db(state.db.clone(), {
                let thread_id = thread_id.to_string();
                move |db| db::threads::get_thread(db, &thread_id)
            })
            .await?
            .ok_or_else(|| format!("thread not found: {thread_id}"))?;

            if !is_engine_rollback_pending(thread.engine_metadata.as_ref()) {
                return Ok(thread);
            }
            let Some(intent) = engine_rollback_intent(thread.engine_metadata.as_ref()) else {
                let snapshot = read_codex_rollback_snapshot(state, &thread).await?;
                reconcile_cancelled_rollback(state, &thread, &snapshot, true).await?;
                return Err(
                    "The invalid history edit was cancelled and Codex history restored.".into(),
                );
            };
            let updated = perform_engine_rollback(state, &thread, &intent).await?;
            if let Some(app) = app {
                emit_codex_rollback_materialized(app, thread_id);
            }
            Ok(updated)
        })
        .await
        .cloned();

    if let Err(error) = &result {
        if let Ok(current) =
            persist_pending_mutation_error(state, thread_id, ENGINE_ROLLBACK_ERROR_KEY, error).await
        {
            if let Some(app) = app {
                if !is_engine_rollback_pending(current.engine_metadata.as_ref()) {
                    emit_codex_rollback_materialized(app, thread_id);
                }
                emit_thread_updated(app, current);
            }
        }
    } else {
        state.pending_rollbacks.forget(thread_id).await;
    }
    result
}

async fn perform_engine_rollback(
    state: &AppState,
    thread: &ThreadDto,
    intent: &EngineRollbackIntent,
) -> Result<ThreadDto, String> {
    let current = read_codex_rollback_snapshot(state, thread).await?;
    let mode = current.history_mode.as_deref().unwrap_or("legacy");
    if !matches!(mode, "legacy" | "paginated") {
        return Err(format!("Unsupported Codex history mode: {mode}"));
    }
    if thread
        .engine_metadata
        .as_ref()
        .and_then(|m| m.get(ENGINE_ROLLBACK_REJECTED_KEY))
        .and_then(Value::as_bool)
        == Some(true)
        && mode == "legacy"
        && is_codex_compatibility_fork(thread.engine_metadata.as_ref())
    {
        if !current.active_flags.is_empty() || imported_messages_have_streaming_turn(&current) {
            return Err("Waiting for the active Codex turn before reconciling history.".into());
        }
        reconcile_cancelled_rollback(state, thread, &current, true).await?;
        return Err("Codex rejected this compatibility history edit. Authoritative history has been restored.".into());
    }
    if mode == "legacy" && is_codex_compatibility_fork(thread.engine_metadata.as_ref()) {
        return perform_compatibility_engine_rollback(state, thread, intent).await;
    }
    if !current.active_flags.is_empty() || imported_messages_have_streaming_turn(&current) {
        return Err("Waiting for the active Codex turn before reconciling history.".into());
    }
    let source_ids: Option<Vec<String>> = thread
        .engine_metadata
        .as_ref()
        .and_then(|m| m.get(ENGINE_ROLLBACK_SOURCE_IDS_KEY))
        .and_then(|ids| serde_json::from_value(ids.clone()).ok());
    let Some(source_ids) = source_ids.filter(|ids| ids.len() == intent.source_turn_count as usize)
    else {
        // Old records already deleted local history and contain only counts. Restore
        // the authoritative transcript instead of guessing a destructive boundary.
        reconcile_cancelled_rollback(state, thread, &current, true).await?;
        return Err("The unfinished history edit was cancelled and Codex history restored. Review the thread before trying again.".into());
    };
    let target_ids = &source_ids[..intent.target_turn_count as usize];
    if current.native_turn_ids == target_ids {
        let thread = thread.clone();
        return run_db(state.db.clone(), move |db| {
            persist_codex_in_place_rollback(db, &thread, &current)
        })
        .await;
    }
    if current.native_turn_ids != source_ids {
        reconcile_cancelled_rollback(state, thread, &current, true).await?;
        return Err("Codex history changed during the edit. The edit was cancelled and the transcript refreshed.".into());
    }
    if thread
        .engine_metadata
        .as_ref()
        .and_then(|m| m.get(ENGINE_ROLLBACK_REJECTED_KEY))
        .and_then(Value::as_bool)
        == Some(true)
    {
        reconcile_cancelled_rollback(state, thread, &current, false).await?;
        return Err(
            "Codex rejected the history edit. Your original history has been preserved.".into(),
        );
    }
    let persistence_thread = run_db(state.db.clone(), {
        let id = thread.id.clone();
        move |db| db::threads::mark_pending_rollback_started(db, &id)
    })
    .await?;
    let id = thread
        .engine_thread_id
        .as_deref()
        .ok_or("Codex thread is not initialized")?;
    let result = if mode == "paginated" {
        state
            .engines
            .revert_codex_thread(id, &source_ids[intent.target_turn_count as usize])
            .await
    } else {
        state
            .engines
            .rollback_codex_thread(id, intent.num_turns)
            .await
    };
    let snapshot = match result {
        Ok(snapshot) => snapshot,
        Err(error) => {
            if crate::engines::codex::is_history_mutation_rejected(&error) {
                mark_history_mutation_rejected(state, &thread.id).await?;
                if let Ok(verified) = read_codex_rollback_snapshot(state, thread).await {
                    if verified.native_turn_ids == target_ids {
                        return run_db(state.db.clone(), move |db| {
                            persist_codex_in_place_rollback(db, &persistence_thread, &verified)
                        })
                        .await;
                    }
                    if verified.native_turn_ids == source_ids {
                        reconcile_cancelled_rollback(state, thread, &verified, false).await?;
                    }
                }
            }
            // A transport failure may have occurred AFTER the remote commit. Leave
            // the intent intact; recovery compares IDs before considering any retry.
            return Err(err_to_string(error));
        }
    };
    if snapshot.native_turn_ids != target_ids {
        return Err("Codex returned an unexpected history boundary; refresh to reconcile before continuing.".into());
    }
    run_db(state.db.clone(), move |db| {
        persist_codex_in_place_rollback(db, &persistence_thread, &snapshot)
    })
    .await
}

async fn mark_history_mutation_rejected(state: &AppState, thread_id: &str) -> Result<(), String> {
    let id = thread_id.to_owned();
    run_db(state.db.clone(), move |db| {
        let current =
            db::threads::get_thread(db, &id)?.ok_or_else(|| anyhow::anyhow!("thread missing"))?;
        let mut metadata = current.engine_metadata.unwrap_or_else(|| json!({}));
        metadata[ENGINE_ROLLBACK_REJECTED_KEY] = json!(true);
        db::threads::update_engine_metadata(db, &id, &metadata)
    })
    .await
}

async fn reconcile_cancelled_rollback(
    state: &AppState,
    thread: &ThreadDto,
    snapshot: &ThreadSyncSnapshot,
    import: bool,
) -> Result<(), String> {
    if !snapshot.active_flags.is_empty() || imported_messages_have_streaming_turn(snapshot) {
        return Err("Waiting for the active Codex turn before restoring history.".into());
    }
    let thread = thread.clone();
    let snapshot = snapshot.clone();
    run_db(state.db.clone(), move |db| {
        let current = db::threads::get_thread(db, &thread.id)?
            .ok_or_else(|| anyhow::anyhow!("thread missing"))?;
        let mut metadata =
            clear_engine_rollback_pending(current.engine_metadata.unwrap_or_else(|| json!({})));
        metadata = mark_codex_transcript_imported(
            merge_codex_runtime_metadata(
                Some(metadata),
                snapshot.raw_status.as_deref(),
                &snapshot.active_flags,
                snapshot.preview.as_deref(),
                false,
                None,
            ),
            true,
        );
        if let Some(mode) = &snapshot.history_mode {
            metadata["codexHistoryMode"] = json!(mode);
        }
        if import {
            let messages = snapshot
                .imported_messages
                .iter()
                .map(|m| db::messages::ImportedMessageRecord {
                    role: m.role.clone(),
                    content: m.content.clone(),
                    blocks: m.blocks.clone(),
                    status: MessageStatusDto::from_str(&m.status),
                    native_turn_id: m.native_turn_id.clone(),
                    turn_engine_id: m.turn_engine_id.clone(),
                    turn_model_id: m.turn_model_id.clone(),
                    turn_reasoning_effort: m.turn_reasoning_effort.clone(),
                    token_input: m.token_input,
                    token_output: m.token_output,
                    created_at: m.created_at.clone(),
                })
                .collect::<Vec<_>>();
            db::messages::replace_thread_messages_and_metadata(
                db,
                &thread.id,
                &messages,
                Some(&metadata),
            )?;
        } else {
            db::threads::update_engine_metadata(db, &thread.id, &metadata)?;
        }
        Ok(())
    })
    .await
}

async fn perform_compatibility_engine_rollback(
    state: &AppState,
    thread: &ThreadDto,
    intent: &EngineRollbackIntent,
) -> Result<ThreadDto, String> {
    let engine_thread_id = thread
        .engine_thread_id
        .as_deref()
        .ok_or_else(|| "Codex thread has not been initialized yet".to_string())?;
    let mut persistence_thread = thread.clone();

    let rollback_snapshot = match intent.phase {
        EngineRollbackPhase::Prepared => {
            let marker_state = state
                .engines
                .codex_rollback_marker_state(engine_thread_id)
                .await
                .map_err(err_to_string)?;
            persistence_thread = persist_compatibility_rollback_marker_expectation(
                state,
                thread,
                marker_state.count,
                true,
            )
            .await?;
            let expected_marker_count = next_engine_rollback_marker_count(marker_state.count)?;
            execute_compatibility_engine_rollback(
                state,
                &persistence_thread,
                intent,
                expected_marker_count,
            )
            .await?
        }
        EngineRollbackPhase::Started => {
            let marker_state = state
                .engines
                .codex_rollback_marker_state(engine_thread_id)
                .await
                .map_err(err_to_string)?;

            if let Some((before, after)) =
                engine_rollback_marker_expectation(thread.engine_metadata.as_ref())
            {
                if marker_state.count == after {
                    read_codex_rollback_snapshot(state, thread).await?
                } else if marker_state.count == before {
                    execute_compatibility_engine_rollback(state, thread, intent, after).await?
                } else {
                    let current = read_codex_rollback_snapshot(state, thread).await?;
                    reconcile_cancelled_rollback(state, thread, &current, true).await?;
                    return Err("Codex compatibility history changed during the edit. Authoritative history has been restored.".into());
                }
            } else if legacy_compatibility_rollback_completed(thread, &marker_state) {
                // Compatibility rollbacks created before durable marker expectations were
                // added can still be recovered without guessing from the lossy native turn
                // list. A newer Codex-owned marker proves that the remote request completed.
                read_codex_rollback_snapshot(state, thread).await?
            } else {
                let current = read_codex_rollback_snapshot(state, thread).await?;
                reconcile_cancelled_rollback(state, thread, &current, true).await?;
                return Err("The old compatibility edit had no verifiable completion marker. Authoritative history has been restored.".into());
            }
        }
    };

    run_db(state.db.clone(), move |db| {
        persist_codex_in_place_rollback(db, &persistence_thread, &rollback_snapshot)
    })
    .await
}

async fn persist_compatibility_rollback_marker_expectation(
    state: &AppState,
    thread: &ThreadDto,
    before: u64,
    mark_started: bool,
) -> Result<ThreadDto, String> {
    run_db(state.db.clone(), {
        let thread_id = thread.id.clone();
        move |db| {
            let current = if mark_started {
                db::threads::mark_pending_rollback_started(db, &thread_id)?
            } else {
                db::threads::get_thread(db, &thread_id)?.ok_or_else(|| {
                    anyhow::anyhow!("thread not found while recording rollback marker: {thread_id}")
                })?
            };
            let metadata = mark_engine_rollback_marker_expectation(
                current.engine_metadata.clone().unwrap_or_else(|| json!({})),
                before,
            )
            .map_err(anyhow::Error::msg)?;
            db::threads::update_engine_metadata(db, &thread_id, &metadata)?;
            db::threads::get_thread(db, &thread_id)?.ok_or_else(|| {
                anyhow::anyhow!("thread not found after recording rollback marker: {thread_id}")
            })
        }
    })
    .await
}

fn legacy_compatibility_rollback_completed(
    thread: &ThreadDto,
    marker_state: &crate::engines::codex::CodexRollbackMarkerState,
) -> bool {
    let Some(marker_timestamp) = marker_state.latest_timestamp.as_deref() else {
        return false;
    };
    let Some(sync_timestamp) = thread
        .engine_metadata
        .as_ref()
        .and_then(|metadata| metadata.get("codexSyncUpdatedAt"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    let Ok(marker_timestamp) = DateTime::parse_from_rfc3339(marker_timestamp) else {
        return false;
    };
    let Ok(sync_timestamp) = DateTime::parse_from_rfc3339(sync_timestamp) else {
        return false;
    };
    marker_timestamp > sync_timestamp
}

async fn read_codex_rollback_snapshot(
    state: &AppState,
    thread: &ThreadDto,
) -> Result<ThreadSyncSnapshot, String> {
    let engine_thread_id = thread
        .engine_thread_id
        .as_deref()
        .ok_or_else(|| "Codex thread has not been initialized yet".to_string())?;
    state
        .engines
        .read_thread_sync_snapshot(thread)
        .await
        .map_err(err_to_string)?
        .ok_or_else(|| format!("Codex thread {engine_thread_id} could not be read"))
}

async fn execute_compatibility_engine_rollback(
    state: &AppState,
    thread: &ThreadDto,
    intent: &EngineRollbackIntent,
    expected_marker_count: u64,
) -> Result<ThreadSyncSnapshot, String> {
    let engine_thread_id = thread
        .engine_thread_id
        .as_deref()
        .ok_or_else(|| "Codex thread has not been initialized yet".to_string())?;
    let remote_rollback_started_at = Instant::now();
    let result = state
        .engines
        .rollback_codex_thread(engine_thread_id, intent.num_turns)
        .await;
    let snapshot = match result {
        Ok(snapshot) => snapshot,
        Err(error) => {
            if crate::engines::codex::is_history_mutation_rejected(&error) {
                mark_history_mutation_rejected(state, &thread.id).await?;
            }
            return Err(err_to_string(error));
        }
    };
    let marker_state = state
        .engines
        .codex_rollback_marker_state(engine_thread_id)
        .await
        .map_err(err_to_string)?;
    if marker_state.count != expected_marker_count {
        return Err(format!(
            "Codex compatibility rollback for thread {} returned without its durable marker: found {} markers, expected {expected_marker_count}",
            thread.id, marker_state.count
        ));
    }
    log::info!(
        "materialized remote-authoritative compatibility rollback for thread {} in {}ms (durable_markers={})",
        thread.id,
        format_elapsed_ms(remote_rollback_started_at),
        marker_state.count,
    );
    Ok(snapshot)
}

#[tauri::command]
pub async fn compact_codex_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<ThreadDto, String> {
    let _history_guard = state.pending_rollbacks.lock_history(&thread_id).await;
    if state.turns.get(&thread_id).await.is_some() {
        return Err("cannot compact a thread while a turn is still active".to_string());
    }

    let db = state.db.clone();
    let mut thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;

    if thread.engine_id != "codex" {
        return Err("native compact is only available for Codex threads".to_string());
    }
    if is_engine_fork_pending(thread.engine_metadata.as_ref()) {
        thread = resolve_pending_engine_fork(state.inner(), &thread.id).await?;
    }
    if is_engine_rollback_pending(thread.engine_metadata.as_ref()) {
        thread = resolve_pending_engine_rollback(state.inner(), &thread.id, None).await?;
    }
    let engine_thread_id = thread
        .engine_thread_id
        .clone()
        .ok_or_else(|| "Codex thread has not been initialized yet".to_string())?;

    state
        .engines
        .compact_codex_thread(&engine_thread_id)
        .await
        .map_err(err_to_string)?;

    Ok(thread)
}

// The paired update flags distinguish "leave unchanged" from "clear value" in
// the current IPC contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn set_thread_execution_policy(
    state: State<'_, AppState>,
    thread_id: String,
    update_approval_policy: bool,
    approval_policy: Option<Value>,
    update_sandbox_mode: bool,
    sandbox_mode: Option<String>,
    update_allow_network: bool,
    allow_network: Option<bool>,
    update_permission_profile: bool,
    permission_profile: Option<Value>,
    update_approvals_reviewer: bool,
    approvals_reviewer: Option<String>,
) -> Result<ThreadDto, String> {
    set_thread_execution_policy_inner(
        state.inner(),
        thread_id,
        update_approval_policy,
        approval_policy,
        update_sandbox_mode,
        sandbox_mode,
        update_allow_network,
        allow_network,
        update_permission_profile,
        permission_profile,
        update_approvals_reviewer,
        approvals_reviewer,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn set_thread_execution_policy_inner(
    state: &AppState,
    thread_id: String,
    update_approval_policy: bool,
    approval_policy: Option<Value>,
    update_sandbox_mode: bool,
    sandbox_mode: Option<String>,
    update_allow_network: bool,
    allow_network: Option<bool>,
    update_permission_profile: bool,
    permission_profile: Option<Value>,
    update_approvals_reviewer: bool,
    approvals_reviewer: Option<String>,
) -> Result<ThreadDto, String> {
    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;

    let normalized_approval_policy = if update_approval_policy {
        normalize_thread_approval_policy_for_engine(thread.engine_id.as_str(), approval_policy)?
    } else {
        None
    };
    let normalized_sandbox_mode = if update_sandbox_mode {
        let normalized = normalize_thread_sandbox_mode(sandbox_mode)?;
        validate_engine_sandbox_mode(thread.engine_id.as_str(), normalized.as_deref())?;
        normalized
    } else {
        None
    };
    let normalized_permission_profile = if update_permission_profile {
        if thread.engine_id != "codex" {
            return Err("Codex permission profile is only available for Codex threads".to_string());
        }
        normalize_thread_permission_profile(permission_profile)?
    } else {
        None
    };
    let normalized_approvals_reviewer = if update_approvals_reviewer {
        if thread.engine_id != "codex" {
            return Err("Codex approvals reviewer is only available for Codex threads".to_string());
        }
        normalize_thread_approvals_reviewer(approvals_reviewer)?
    } else {
        None
    };
    let external_sandbox_active = state.engines.codex_uses_external_sandbox().await;

    if external_sandbox_active
        && thread.engine_id == "codex"
        && matches!(
            normalized_sandbox_mode.as_deref(),
            Some("read-only" | "workspace-write")
        )
    {
        return Err(
            "Codex read-only and workspace-write sandbox overrides are unavailable while Panes is using external sandbox mode."
                .to_string(),
        );
    }

    let mut metadata = thread.engine_metadata.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        if update_approval_policy {
            let approval_policy_key = approval_policy_metadata_key(thread.engine_id.as_str());
            match normalized_approval_policy {
                Some(value) => {
                    object.insert(approval_policy_key.to_string(), json!(value));
                }
                None => {
                    object.remove(approval_policy_key);
                }
            }
        }

        if update_sandbox_mode {
            match normalized_sandbox_mode {
                Some(value) => {
                    object.insert("sandboxMode".to_string(), json!(value));
                }
                None => {
                    object.remove("sandboxMode");
                }
            }
        }

        if update_allow_network {
            match allow_network {
                Some(value) => {
                    object.insert("sandboxAllowNetwork".to_string(), json!(value));
                }
                None => {
                    object.remove("sandboxAllowNetwork");
                }
            }
        }

        if (update_sandbox_mode || update_allow_network) && !update_permission_profile {
            object.remove("permissionProfile");
        }

        if update_permission_profile {
            match normalized_permission_profile {
                Some(value) => {
                    object.insert("permissionProfile".to_string(), value);
                    object.remove("sandboxMode");
                    object.remove("sandboxAllowNetwork");
                }
                None => {
                    object.remove("permissionProfile");
                }
            }
        }

        if update_approvals_reviewer {
            match normalized_approvals_reviewer {
                Some(value) => {
                    object.insert("approvalsReviewer".to_string(), json!(value));
                }
                None => {
                    object.remove("approvalsReviewer");
                }
            }
        }
    }

    run_db(db.clone(), {
        let thread_id = thread_id.clone();
        let metadata = metadata.clone();
        move |db| db::threads::update_engine_metadata(db, &thread_id, &metadata)
    })
    .await?;

    run_db(db, {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found after execution policy update: {thread_id}"))
}

// The paired update flags preserve patch semantics across Tauri's flat command
// argument mapping.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn set_thread_codex_config(
    state: State<'_, AppState>,
    thread_id: String,
    update_personality: bool,
    personality: Option<String>,
    update_service_tier: bool,
    service_tier: Option<String>,
    update_output_schema: bool,
    output_schema: Option<Value>,
) -> Result<ThreadDto, String> {
    set_thread_codex_config_inner(
        state.inner(),
        thread_id,
        update_personality,
        personality,
        update_service_tier,
        service_tier,
        update_output_schema,
        output_schema,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn set_thread_codex_config_inner(
    state: &AppState,
    thread_id: String,
    update_personality: bool,
    personality: Option<String>,
    update_service_tier: bool,
    service_tier: Option<String>,
    update_output_schema: bool,
    output_schema: Option<Value>,
) -> Result<ThreadDto, String> {
    let db = state.db.clone();
    let thread = run_db(db.clone(), {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found: {thread_id}"))?;

    if thread.engine_id != "codex" {
        return Err("Codex thread config is only available for Codex threads".to_string());
    }

    let normalized_personality = if update_personality {
        normalize_thread_personality(personality)?
    } else {
        None
    };
    let normalized_service_tier = if update_service_tier {
        normalize_thread_service_tier(service_tier)?
    } else {
        None
    };
    let normalized_output_schema = if update_output_schema {
        normalize_thread_output_schema(output_schema)?
    } else {
        None
    };

    let mut metadata = thread.engine_metadata.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        if update_personality {
            match normalized_personality {
                Some(value) => {
                    object.insert("personality".to_string(), json!(value));
                }
                None => {
                    object.remove("personality");
                }
            }
        }

        if update_service_tier {
            match normalized_service_tier {
                Some(value) => {
                    object.insert("serviceTier".to_string(), json!(value));
                }
                None => {
                    object.remove("serviceTier");
                }
            }
        }

        if update_output_schema {
            match normalized_output_schema {
                Some(value) => {
                    object.insert("outputSchema".to_string(), value);
                }
                None => {
                    object.remove("outputSchema");
                }
            }
        }
    }

    run_db(db.clone(), {
        let thread_id = thread_id.clone();
        let metadata = metadata.clone();
        move |db| db::threads::update_engine_metadata(db, &thread_id, &metadata)
    })
    .await?;

    run_db(db, {
        let thread_id = thread_id.clone();
        move |db| db::threads::get_thread(db, &thread_id)
    })
    .await?
    .ok_or_else(|| format!("thread not found after Codex config update: {thread_id}"))
}

async fn validate_reasoning_effort(
    state: &AppState,
    engine_id: &str,
    model_id: &str,
    requested_effort: &str,
) -> Result<String, String> {
    if let Ok(engines) = state.engines.list_engines().await {
        if let Some(engine) = engines.iter().find(|engine| engine.id == engine_id) {
            if let Some(model) = engine.models.iter().find(|model| model.id == model_id) {
                return validate_reasoning_effort_for_model(
                    &model.id,
                    &model.supported_reasoning_efforts,
                    requested_effort,
                );
            }
        }
    }

    validate_known_reasoning_effort(requested_effort)?;
    Ok(requested_effort.to_string())
}

fn validate_reasoning_effort_for_model(
    model_id: &str,
    supported_efforts: &[ReasoningEffortOptionDto],
    requested_effort: &str,
) -> Result<String, String> {
    if let Some(option) = supported_efforts
        .iter()
        .find(|option| option.reasoning_effort == requested_effort)
    {
        return Ok(option.reasoning_effort.clone());
    }

    validate_known_reasoning_effort(requested_effort)?;

    let supported = supported_efforts
        .iter()
        .map(|option| option.reasoning_effort.clone())
        .collect::<Vec<_>>()
        .join(", ");

    Err(format!(
        "reasoning effort `{requested_effort}` is not supported by model `{model_id}`. supported values: {supported}"
    ))
}

fn validate_known_reasoning_effort(requested_effort: &str) -> Result<(), String> {
    const KNOWN_REASONING_EFFORTS: &[&str] = &[
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ];
    if KNOWN_REASONING_EFFORTS.contains(&requested_effort) {
        return Ok(());
    }

    Err(format!(
        "invalid reasoning effort `{requested_effort}`. expected one of: {}",
        KNOWN_REASONING_EFFORTS.join(", ")
    ))
}

async fn validate_model_for_thread_engine(
    state: &AppState,
    thread: &ThreadDto,
    requested_model_id: &str,
) -> Result<String, String> {
    if requested_model_id == thread.model_id {
        return Ok(thread.model_id.clone());
    }

    validate_model_for_engine(state, &thread.engine_id, requested_model_id).await
}

fn merge_codex_runtime_metadata(
    existing: Option<serde_json::Value>,
    raw_status: Option<&str>,
    active_flags: &[String],
    preview: Option<&str>,
    sync_required: bool,
    sync_reason: Option<&str>,
) -> serde_json::Value {
    let mut metadata = existing.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        match raw_status.map(str::trim).filter(|value| !value.is_empty()) {
            Some(status) => {
                object.insert("codexThreadStatus".to_string(), json!(status));
            }
            None => {
                object.remove("codexThreadStatus");
            }
        }

        if active_flags.is_empty() {
            object.remove("codexThreadActiveFlags");
        } else {
            object.insert("codexThreadActiveFlags".to_string(), json!(active_flags));
        }

        match preview.map(str::trim).filter(|value| !value.is_empty()) {
            Some(preview) => {
                object.insert("codexPreview".to_string(), json!(preview));
            }
            None => {
                object.remove("codexPreview");
            }
        }

        object.insert("codexSyncRequired".to_string(), json!(sync_required));
        if sync_required {
            object.insert(
                "codexSyncUpdatedAt".to_string(),
                json!(Utc::now().to_rfc3339()),
            );
            if let Some(reason) = sync_reason.map(str::trim).filter(|value| !value.is_empty()) {
                object.insert("codexSyncReason".to_string(), json!(reason));
            }
        } else {
            object.insert(
                "codexSyncUpdatedAt".to_string(),
                json!(Utc::now().to_rfc3339()),
            );
            object.insert("codexSyncReason".to_string(), serde_json::Value::Null);
        }
    }

    metadata
}

async fn build_codex_branch_context(
    state: &AppState,
    thread: &ThreadDto,
) -> Result<(String, String, SandboxPolicy), String> {
    let db = state.db.clone();
    let (workspace, repos, selected_repo) = run_db(db, {
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
    let sandbox_mode_override = thread_sandbox_mode(thread.engine_metadata.as_ref())?;
    let sandbox_mode = sandbox_mode_override
        .clone()
        .unwrap_or_else(|| default_sandbox_mode_for_engine(thread.engine_id.as_str()).to_string());
    let workspace_writable_roots = if selected_repo.is_some() {
        None
    } else {
        Some(resolve_workspace_writable_roots(
            repos.iter().map(|repo| repo.path.as_str()),
            workspace_root.as_str(),
            thread.engine_metadata.as_ref(),
        )?)
    };
    let trust_level = selected_repo
        .as_ref()
        .map(|repo| repo.trust_level.clone())
        .unwrap_or_else(|| aggregate_workspace_trust_level(&repos));
    let codex_external_sandbox_active = state.engines.codex_uses_external_sandbox().await;
    let permission_profile = thread_permission_profile(thread.engine_metadata.as_ref());

    if permission_profile.is_none() {
        if unsupported_thread_sandbox_override_for_external_sandbox(
            sandbox_mode_override.as_deref(),
            codex_external_sandbox_active,
        ) {
            return Err(
                "Codex read-only and workspace-write sandbox overrides are unavailable while Panes is using external sandbox mode. Clear the override or restore local Codex sandboxing first.".to_string(),
            );
        }

        validate_engine_sandbox_mode(thread.engine_id.as_str(), Some(sandbox_mode.as_str()))?;

        if workspace_write_confirmation_required(
            workspace_writable_roots.as_ref(),
            sandbox_mode.as_str(),
            workspace_write_opt_in_enabled(thread.engine_metadata.as_ref()),
        ) {
            return Err(
                "Workspace thread with multiple writable repositories requires explicit confirmation before execution.".to_string(),
            );
        }
    }

    let writable_roots = match selected_repo.as_ref() {
        Some(repo) => vec![repo.path.clone()],
        None => workspace_writable_roots
            .as_ref()
            .map(|resolution| resolution.roots.clone())
            .unwrap_or_else(|| vec![workspace_root.clone()]),
    };
    let allow_network = if sandbox_mode.eq_ignore_ascii_case("danger-full-access") {
        true
    } else {
        thread_allow_network_override(thread.engine_metadata.as_ref())
            .unwrap_or_else(|| allow_network_for_trust_level(&trust_level))
    };
    let approval_policy_override = thread_approval_policy_override_value(
        thread.engine_id.as_str(),
        thread.engine_metadata.as_ref(),
    )?;

    Ok((
        selected_repo
            .as_ref()
            .map(|repo| repo.path.clone())
            .unwrap_or(workspace_root),
        thread_last_model_id(thread.engine_metadata.as_ref())
            .unwrap_or_else(|| thread.model_id.clone()),
        SandboxPolicy {
            writable_roots,
            allow_network,
            approval_policy: Some(approval_policy_override.unwrap_or_else(|| {
                Value::String(
                    approval_policy_for_engine_and_trust_level(
                        thread.engine_id.as_str(),
                        &trust_level,
                    )
                    .to_string(),
                )
            })),
            permission_profile,
            approvals_reviewer: thread_approvals_reviewer(thread.engine_metadata.as_ref()),
            reasoning_effort: thread_reasoning_effort(thread.engine_metadata.as_ref()),
            sandbox_mode: Some(sandbox_mode),
            service_tier: thread_service_tier(thread.engine_metadata.as_ref()),
            personality: thread_personality(thread.engine_metadata.as_ref()),
            output_schema: thread_output_schema(thread.engine_metadata.as_ref()),
        },
    ))
}

/// Creates the local branch thread immediately, cloning the source transcript, and
/// records the engine-level fork as pending so it can be materialized later. Does no
/// engine/network work, so it returns in a few milliseconds.
async fn create_pending_codex_branch_thread(
    state: &AppState,
    source_thread: &ThreadDto,
    intent: &EngineForkIntent,
    source_message_id: Option<&str>,
    rollback_turns: Option<u32>,
    profile_operation_id: Option<&str>,
) -> Result<ThreadDto, String> {
    let profile_operation_id = profile_operation_id.map(str::to_string);
    let total_started_at = Instant::now();
    let model_id = thread_last_model_id(source_thread.engine_metadata.as_ref())
        .unwrap_or_else(|| source_thread.model_id.clone());
    log_branch_profile_step(
        profile_operation_id.as_deref(),
        "backend.branch.create_local.start",
        Some(format!(
            "source_thread_id={}; model_id={}; rollback_turns={}; pending_fork=true",
            source_thread.id,
            model_id,
            rollback_turns
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        )),
    );
    if !codex_thread_has_local_transcript_for_history_tools(source_thread) {
        log_branch_profile_step(
            profile_operation_id.as_deref(),
            "backend.branch.create_local.rejected_transcript_unimported",
            Some(format!("source_thread_id={}", source_thread.id)),
        );
        return Err(
            "native Codex history tools require a locally mirrored transcript. Attached remote threads without imported history cannot be forked or rolled back yet."
                .to_string(),
        );
    }

    let db = state.db.clone();
    run_db(db.clone(), {
        let source_thread = source_thread.clone();
        let model_id = model_id.clone();
        let intent = intent.clone();
        let source_message_id = source_message_id.map(str::to_string);
        let profile_operation_id = profile_operation_id.clone();
        move |db| {
            let clone_local_history = should_clone_local_branch_history(&source_thread);
            let create_thread_started_at = Instant::now();
            let created = db::threads::create_thread(
                db,
                &source_thread.workspace_id,
                source_thread.repo_id.as_deref(),
                &source_thread.engine_id,
                &model_id,
                &source_thread.title,
            )?;
            log_branch_profile_step(
                profile_operation_id.as_deref(),
                "backend.branch.db_create_thread.done",
                Some(format!(
                    "elapsed_ms={}; created_thread_id={}",
                    format_elapsed_ms(create_thread_started_at),
                    created.id
                )),
            );
            if clone_local_history {
                let clone_history_started_at = Instant::now();
                let cloned_count = match source_message_id.as_deref() {
                    Some(source_message_id) => {
                        db::messages::clone_thread_messages_for_branch_at_message(
                            db,
                            &source_thread.id,
                            &created.id,
                            source_message_id,
                            intent.last_turn_id.as_deref(),
                        )?
                    }
                    None => db::messages::clone_thread_messages_for_branch(
                        db,
                        &source_thread.id,
                        &created.id,
                        rollback_turns,
                    )?,
                };
                log_branch_profile_step(
                    profile_operation_id.as_deref(),
                    "backend.branch.db_clone_history.done",
                    Some(format!(
                        "elapsed_ms={}; created_thread_id={}; cloned_messages={}; rollback_turns={}",
                        format_elapsed_ms(clone_history_started_at),
                        created.id,
                        cloned_count,
                        rollback_turns
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "none".to_string())
                    )),
                );
            } else {
                log_branch_profile_step(
                    profile_operation_id.as_deref(),
                    "backend.branch.db_clone_history.skipped",
                    Some(format!(
                        "created_thread_id={}; reason=sync_required_or_no_local_messages",
                        created.id
                    )),
                );
            }
            db::threads::refresh_thread_message_stats(db, &created.id)?;
            // Cloned messages retain their original timestamps, but creating the branch is
            // fresh activity and should place it at the top of the sessions list.
            db::threads::touch_thread_activity(db, &created.id)?;

            let metadata = clone_codex_branch_metadata(
                source_thread.engine_metadata.as_ref(),
                &model_id,
                None,
                &[],
                None,
                !clone_local_history,
                (!clone_local_history).then_some("branch_thread_requires_sync"),
            );
            let metadata = restore_checkpoint_context_usage(
                db,
                &created.id,
                metadata,
                source_thread.engine_thread_id.as_deref(),
            );
            let metadata = mark_engine_fork_pending(metadata, &intent);
            let next_status = map_codex_thread_status_to_local(None, &[], false);
            let update_snapshot_started_at = Instant::now();
            let updated = db::threads::update_thread_runtime_snapshot(
                db,
                &created.id,
                None,
                next_status,
                Some(&metadata),
            )?;
            log_branch_profile_step(
                profile_operation_id.as_deref(),
                "backend.branch.db_update_snapshot.done",
                Some(format!(
                    "elapsed_ms={}; created_thread_id={}; total_elapsed_ms={}",
                    format_elapsed_ms(update_snapshot_started_at),
                    created.id,
                    format_elapsed_ms(total_started_at)
                )),
            );
            Ok(updated)
        }
    })
    .await
}

/// Attaches a freshly-forked engine thread to an existing pending branch, clearing the
/// deferred-fork markers and applying the forked runtime snapshot.
async fn attach_forked_engine_to_branch(
    state: &AppState,
    branch: &ThreadDto,
    forked: &crate::engines::codex::CodexForkedThread,
) -> Result<ThreadDto, String> {
    let db = state.db.clone();
    run_db(db, {
        let branch = branch.clone();
        let forked_engine_thread_id = forked.engine_thread_id.clone();
        let forked_model_id = forked.model_id.clone();
        let title = forked.title.clone();
        let preview = forked.preview.clone();
        let raw_status = forked.raw_status.clone();
        let active_flags = forked.active_flags.clone();
        let compatibility_fork = forked.compatibility_fork;
        let history_mode = forked.history_mode.clone();
        move |db| {
            db::threads::set_engine_thread_id(db, &branch.id, &forked_engine_thread_id)?;

            let mut metadata = clear_engine_fork_pending(
                branch.engine_metadata.clone().unwrap_or_else(|| json!({})),
            );
            if let Some(object) = metadata.as_object_mut() {
                object.insert("codexHistoryMode".to_string(), json!(history_mode));
                object.insert("lastModelId".to_string(), json!(forked_model_id));
                object.insert("codexTranscriptImported".to_string(), json!(true));
                if compatibility_fork {
                    object.remove(CONTEXT_USAGE_CACHE_METADATA_KEY);
                    object.insert(CODEX_COMPATIBILITY_FORK_KEY.to_string(), json!(true));
                    object.insert(
                        CODEX_COMPATIBILITY_HISTORY_COMPLETE_KEY.to_string(),
                        json!(true),
                    );
                } else {
                    object.remove(CODEX_COMPATIBILITY_FORK_KEY);
                    object.remove(CODEX_COMPATIBILITY_HISTORY_COMPLETE_KEY);
                }
            }
            let mut metadata = merge_codex_runtime_metadata(
                Some(metadata),
                raw_status.as_deref(),
                &active_flags,
                preview.as_deref(),
                false,
                None,
            );
            // A branch starts a distinct engine thread; do not inherit a confirmed-active
            // bit before the branch receives a full sync.
            codex_thread_metadata::set_confirmed_remote_turn(&mut metadata, false);

            let next_status =
                map_codex_thread_status_to_local(raw_status.as_deref(), &active_flags, false);
            let updated = db::threads::update_thread_runtime_snapshot(
                db,
                &branch.id,
                title.as_deref(),
                next_status,
                Some(&metadata),
            )?;
            Ok(updated)
        }
    })
    .await
}

fn is_codex_thread_sync_required(metadata: Option<&Value>) -> bool {
    let Some(metadata) = metadata else {
        return false;
    };
    metadata
        .get("codexSyncRequired")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || metadata
            .get(ENGINE_FORK_PENDING_KEY)
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || metadata
            .get(ENGINE_ROLLBACK_PENDING_KEY)
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || (is_codex_compatibility_fork(Some(metadata))
            && metadata
                .get(CODEX_COMPATIBILITY_HISTORY_COMPLETE_KEY)
                .and_then(Value::as_bool)
                != Some(true))
}

fn should_clone_local_branch_history(source_thread: &ThreadDto) -> bool {
    !is_codex_thread_sync_required(source_thread.engine_metadata.as_ref())
        && source_thread.message_count > 0
}

fn codex_thread_has_local_transcript_for_history_tools(thread: &ThreadDto) -> bool {
    if is_codex_thread_sync_required(thread.engine_metadata.as_ref()) {
        return false;
    }
    if codex_transcript_imported(thread.engine_metadata.as_ref()) {
        return true;
    }

    thread.message_count > 0
}

fn persist_codex_in_place_rollback(
    db: &crate::db::Database,
    thread: &ThreadDto,
    rollback_snapshot: &ThreadSyncSnapshot,
) -> anyhow::Result<ThreadDto> {
    // The deferred native call may overlap harmless local settings updates. Reload
    // metadata after the native call so clearing the rollback intent does not overwrite
    // settings saved while the native operation was in flight.
    let current_thread = db::threads::get_thread(db, &thread.id)?.ok_or_else(|| {
        anyhow::anyhow!("thread not found while persisting rollback: {}", thread.id)
    })?;
    let mut metadata = clear_engine_rollback_pending(
        current_thread
            .engine_metadata
            .clone()
            .unwrap_or_else(|| json!({})),
    );
    if let Some(mode) = &rollback_snapshot.history_mode {
        metadata["codexHistoryMode"] = json!(mode);
    }
    let metadata = mark_codex_transcript_imported(
        merge_codex_runtime_metadata(
            Some(metadata),
            rollback_snapshot.raw_status.as_deref(),
            &rollback_snapshot.active_flags,
            rollback_snapshot.preview.as_deref(),
            false,
            None,
        ),
        true,
    );
    let next_status = map_codex_thread_status_to_local(
        rollback_snapshot.raw_status.as_deref(),
        &rollback_snapshot.active_flags,
        false,
    );

    if current_thread
        .engine_metadata
        .as_ref()
        .and_then(|m| m.get(ENGINE_ROLLBACK_REMOTE_FIRST_KEY))
        .and_then(Value::as_bool)
        == Some(true)
    {
        let intent = engine_rollback_intent(current_thread.engine_metadata.as_ref())
            .ok_or_else(|| anyhow::anyhow!("invalid pending history mutation"))?;
        if db::messages::thread_turn_count(db, &thread.id)? != intent.source_turn_count {
            anyhow::bail!("local history changed during the edit; reconcile before continuing");
        }
        db::messages::finish_pending_thread_rollback(db, &thread.id, intent.num_turns, &metadata)?;
    }
    // Both native rollback and paginated revert commit through this path. Read
    // the retained ledger only after the discarded local turns have been removed.
    let metadata = restore_checkpoint_context_usage(
        db,
        &thread.id,
        metadata,
        thread.engine_thread_id.as_deref(),
    );
    db::threads::update_thread_runtime_snapshot(
        db,
        &thread.id,
        rollback_snapshot.title.as_deref(),
        next_status,
        Some(&metadata),
    )
}

fn clone_codex_branch_metadata(
    existing: Option<&Value>,
    model_id: &str,
    raw_status: Option<&str>,
    active_flags: &[String],
    preview: Option<&str>,
    sync_required: bool,
    sync_reason: Option<&str>,
) -> Value {
    let mut metadata = existing.cloned().unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        object.remove("manualTitle");
        object.remove("manualTitleUpdatedAt");
        object.remove(CONTEXT_USAGE_CACHE_METADATA_KEY);
        object.insert("lastModelId".to_string(), json!(model_id));
        object.insert("codexTranscriptImported".to_string(), json!(true));
    }

    let mut metadata = merge_codex_runtime_metadata(
        Some(metadata),
        raw_status,
        active_flags,
        preview,
        sync_required,
        sync_reason,
    );
    // A branch starts a distinct engine thread. Do not inherit the source
    // thread's confirmed-active bit before the branch receives a full sync.
    codex_thread_metadata::set_confirmed_remote_turn(&mut metadata, false);
    metadata
}

fn codex_transcript_imported(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(|value| value.get("codexTranscriptImported"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
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
        .cloned()
        .map(normalize_codex_approval_policy)
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
        "dangerfullaccess" | "danger-full-access" | "danger_full_access" => "danger-full-access",
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
        let root = root
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "invalid `workspaceWritableRoots` on thread metadata. expected non-empty string paths"
                    .to_string()
            })?;
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

fn map_codex_thread_status_to_local(
    raw_status: Option<&str>,
    active_flags: &[String],
    has_local_turn: bool,
) -> Option<ThreadStatusDto> {
    if has_local_turn {
        return None;
    }

    match raw_status.map(str::trim).filter(|value| !value.is_empty()) {
        Some("systemError") => Some(ThreadStatusDto::Error),
        Some("idle") | Some("notLoaded") => Some(ThreadStatusDto::Idle),
        Some("active") => {
            if active_flags
                .iter()
                .any(|flag| matches!(flag.as_str(), "waitingOnApproval" | "waitingOnUserInput"))
            {
                Some(ThreadStatusDto::AwaitingApproval)
            } else {
                Some(ThreadStatusDto::Streaming)
            }
        }
        _ => None,
    }
}

fn imported_messages_thread_status(messages: &[ImportedThreadMessage]) -> Option<ThreadStatusDto> {
    let latest_assistant = messages
        .iter()
        .rev()
        .find(|message| message.role == "assistant")?;

    match latest_assistant.status.trim() {
        "streaming" => Some(ThreadStatusDto::Streaming),
        "completed" => Some(ThreadStatusDto::Completed),
        "error" => Some(ThreadStatusDto::Error),
        "interrupted" => Some(ThreadStatusDto::Idle),
        _ => None,
    }
}

fn resolve_codex_sync_thread_status(
    snapshot: &ThreadSyncSnapshot,
    has_local_turn: bool,
) -> Option<ThreadStatusDto> {
    if has_local_turn {
        return None;
    }

    if snapshot.raw_status.as_deref() == Some("systemError") {
        return Some(ThreadStatusDto::Error);
    }

    if snapshot
        .active_flags
        .iter()
        .any(|flag| matches!(flag.as_str(), "waitingOnApproval" | "waitingOnUserInput"))
    {
        return Some(ThreadStatusDto::AwaitingApproval);
    }

    let imported_status = imported_messages_thread_status(&snapshot.imported_messages);
    if imported_status == Some(ThreadStatusDto::Streaming) || !snapshot.active_flags.is_empty() {
        return Some(ThreadStatusDto::Streaming);
    }
    if imported_status.is_some() {
        return imported_status;
    }

    match snapshot.raw_status.as_deref() {
        Some("idle") | Some("notLoaded") => Some(ThreadStatusDto::Idle),
        // An unflagged `active` summary is not enough to resurrect a running
        // state when the sync snapshot contains no active turn evidence.
        _ => None,
    }
}

fn err_to_string(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}

fn approval_policy_metadata_key(engine_id: &str) -> &'static str {
    let _ = engine_id;
    "sandboxApprovalPolicy"
}

fn normalize_thread_approval_policy_for_engine(
    engine_id: &str,
    value: Option<Value>,
) -> Result<Option<Value>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    if engine_id != "codex" {
        return Err(format!("unsupported engine_id {engine_id}"));
    }
    normalize_codex_approval_policy(value).map(Some)
}

fn normalize_codex_approval_policy(value: Value) -> Result<Value, String> {
    match value {
        Value::String(raw) => {
            let normalized = raw.trim().to_lowercase();
            match normalized.as_str() {
                "untrusted" | "on-failure" | "on-request" | "never" => {
                    Ok(Value::String(normalized))
                }
                _ => Err(format!(
                    "invalid approval policy `{normalized}`. expected one of: untrusted, on-failure, on-request, never"
                )),
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

            Ok(Value::Object(object))
        }
        _ => Err(
            "invalid approval policy. expected a string mode or structured reject object"
                .to_string(),
        ),
    }
}

fn normalize_thread_personality(value: Option<String>) -> Result<Option<String>, String> {
    let normalized = value
        .as_deref()
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(str::to_lowercase);

    let Some(normalized) = normalized else {
        return Ok(None);
    };

    match normalized.as_str() {
        "none" | "friendly" | "pragmatic" => Ok(Some(normalized)),
        _ => Err(format!(
            "invalid personality `{normalized}`. expected one of: none, friendly, pragmatic"
        )),
    }
}

fn normalize_thread_service_tier(value: Option<String>) -> Result<Option<String>, String> {
    let normalized = value
        .as_deref()
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(str::to_lowercase);

    let Some(normalized) = normalized else {
        return Ok(None);
    };

    match normalized.as_str() {
        "fast" | "flex" => Ok(Some(normalized)),
        _ => Err(format!(
            "invalid service tier `{normalized}`. expected one of: fast, flex"
        )),
    }
}

fn normalize_thread_output_schema(value: Option<Value>) -> Result<Option<Value>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    match value {
        Value::Object(_) | Value::Bool(_) => Ok(Some(value)),
        _ => Err("invalid output schema. expected a JSON Schema object or boolean".to_string()),
    }
}

fn normalize_thread_permission_profile(value: Option<Value>) -> Result<Option<Value>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(object) = value.as_object() else {
        return Err("invalid permission profile. expected a profile object".to_string());
    };
    let profile_type = object
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| "invalid permission profile. missing string `type`".to_string())?;
    match profile_type {
        "managed" => {
            validate_permission_profile_file_system(object.get("fileSystem"))?;
            validate_permission_profile_network(object.get("network"))?;
        }
        "external" => {
            validate_permission_profile_network(object.get("network"))?;
        }
        "disabled" => {}
        _ => {
            return Err(format!(
                "invalid permission profile type `{profile_type}`. expected one of: managed, external, disabled"
            ));
        }
    }
    Ok(Some(value))
}

fn validate_permission_profile_file_system(value: Option<&Value>) -> Result<(), String> {
    let Some(file_system) = value.and_then(Value::as_object) else {
        return Err("invalid permission profile. managed.fileSystem must be an object".to_string());
    };
    let fs_type = file_system
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| {
            "invalid permission profile. managed.fileSystem.type must be a string".to_string()
        })?;
    match fs_type {
        "unrestricted" => Ok(()),
        "restricted" => {
            let entries = file_system.get("entries").and_then(Value::as_array).ok_or_else(
                || {
                    "invalid permission profile. managed.fileSystem.entries must be an array"
                        .to_string()
                },
            )?;
            for entry in entries {
                validate_permission_profile_file_system_entry(entry)?;
            }
            Ok(())
        }
        _ => Err(format!(
            "invalid permission profile filesystem type `{fs_type}`. expected one of: restricted, unrestricted"
        )),
    }
}

fn validate_permission_profile_file_system_entry(value: &Value) -> Result<(), String> {
    let Some(entry) = value.as_object() else {
        return Err("invalid permission profile. fileSystem entry must be an object".to_string());
    };
    let access = entry
        .get("access")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| {
            "invalid permission profile. fileSystem entry access must be a string".to_string()
        })?;
    if !matches!(access, "read" | "write" | "none") {
        return Err(format!(
            "invalid permission profile fileSystem entry access `{access}`. expected one of: read, write, none"
        ));
    }
    let Some(path) = entry.get("path").and_then(Value::as_object) else {
        return Err(
            "invalid permission profile. fileSystem entry path must be an object".to_string(),
        );
    };
    if path.get("type").and_then(Value::as_str).is_none() {
        return Err(
            "invalid permission profile. fileSystem entry path.type must be a string".to_string(),
        );
    }
    Ok(())
}

fn validate_permission_profile_network(value: Option<&Value>) -> Result<(), String> {
    let Some(network) = value.and_then(Value::as_object) else {
        return Err("invalid permission profile. network must be an object".to_string());
    };
    if network.get("enabled").and_then(Value::as_bool).is_none() {
        return Err("invalid permission profile. network.enabled must be a boolean".to_string());
    }
    Ok(())
}

fn normalize_thread_approvals_reviewer(value: Option<String>) -> Result<Option<String>, String> {
    let normalized = value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let Some(normalized) = normalized else {
        return Ok(None);
    };
    match normalized.as_str() {
        "user" | "auto_review" | "guardian_subagent" => Ok(Some(normalized)),
        _ => Err(format!(
            "invalid approvals reviewer `{normalized}`. expected one of: user, auto_review, guardian_subagent"
        )),
    }
}

fn normalize_thread_sandbox_mode(value: Option<String>) -> Result<Option<String>, String> {
    let normalized = value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());

    let Some(normalized) = normalized else {
        return Ok(None);
    };

    let canonical = match normalized.as_str() {
        "readonly" | "read-only" | "read_only" => "read-only",
        "workspacewrite" | "workspace-write" | "workspace_write" => "workspace-write",
        "dangerfullaccess" | "danger-full-access" | "danger_full_access" => {
            "danger-full-access"
        }
        _ => {
            return Err(format!(
                "invalid sandbox mode `{normalized}`. expected one of: read-only, workspace-write, danger-full-access"
            ))
        }
    };

    Ok(Some(canonical.to_string()))
}

#[cfg(test)]
fn thread_allow_network(metadata: Option<&serde_json::Value>) -> Option<bool> {
    metadata
        .and_then(serde_json::Value::as_object)
        .and_then(|value| value.get("sandboxAllowNetwork"))
        .and_then(serde_json::Value::as_bool)
}

fn normalize_thread_title(raw: &str) -> Result<String, String> {
    let compact = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim();
    if trimmed.is_empty() {
        return Err("thread title cannot be empty".to_string());
    }

    let title = if trimmed.chars().count() > MAX_THREAD_TITLE_CHARS {
        trimmed
            .chars()
            .take(MAX_THREAD_TITLE_CHARS)
            .collect::<String>()
    } else {
        trimmed.to_string()
    };

    Ok(title)
}

fn normalize_workspace_confirmation_roots(
    writable_roots: &[String],
    _workspace_root: &str,
    repo_paths: &[String],
) -> Result<Vec<String>, String> {
    if writable_roots.is_empty() {
        return Err(
            "workspace writable roots must include at least one active repository".to_string(),
        );
    }

    let allowed_roots: std::collections::HashSet<&str> =
        repo_paths.iter().map(String::as_str).collect();
    let mut normalized = Vec::with_capacity(writable_roots.len());
    for root in writable_roots {
        let root = root.trim();
        if root.is_empty() {
            return Err("workspace writable roots must be non-empty paths".to_string());
        }
        if !allowed_roots.contains(root) {
            return Err(format!(
                "workspace writable root `{root}` is not an active repository in this workspace"
            ));
        }
        if !normalized.iter().any(|value: &String| value == root) {
            normalized.push(root.to_string());
        }
    }

    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc};

    use super::*;
    use crate::{
        config::app_config::AppConfig,
        engines::EngineManager,
        power::KeepAwakeManager,
        state::{AppState, TurnManager},
    };
    use uuid::Uuid;

    fn test_app_state() -> AppState {
        let root = std::env::temp_dir().join(format!("panes-threads-cmd-{}", Uuid::new_v4()));
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

    fn test_workspace(state: &AppState) -> crate::models::WorkspaceDto {
        let workspace_root =
            std::env::temp_dir().join(format!("panes-threads-workspace-{}", Uuid::new_v4()));
        fs::create_dir_all(&workspace_root).expect("failed to create workspace root");
        crate::db::workspaces::upsert_workspace(
            &state.db,
            workspace_root.to_string_lossy().as_ref(),
            Some(1),
        )
        .expect("failed to create workspace")
    }

    fn test_thread(state: &AppState, engine_id: &str, model_id: &str) -> ThreadDto {
        let workspace = test_workspace(state);
        crate::db::threads::create_thread(
            &state.db,
            &workspace.id,
            None,
            engine_id,
            model_id,
            "Thread",
        )
        .expect("failed to create thread")
    }

    fn record_checkpoint_usage(
        state: &AppState,
        thread_id: &str,
        message: &MessageDto,
        tokens: u64,
    ) {
        db::codex_transcript::record_native_event_batch(
            &state.db,
            thread_id,
            &message.id,
            &[crate::engines::events::CodexNativeEvent {
                source_sequence: 1,
                observed_at_ms: 1,
                event_kind: crate::engines::events::CodexNativeEventKind::Notification,
                method: "thread/tokenUsage/updated".into(),
                request_id: None,
                native_thread_id: "engine-source".into(),
                native_turn_id: message.native_turn_id.clone(),
                params_json: json!({
                    "tokenUsage": {
                        "last": { "totalTokens": tokens, "inputTokens": tokens - 1000, "outputTokens": 1000 },
                        "total": { "totalTokens": 999999 },
                        "modelContextWindow": 112000
                    }
                })
                .to_string(),
            }],
        )
        .expect("record checkpoint usage");
    }

    #[test]
    fn checkpoint_usage_requires_the_retained_turn_and_matching_compatibility_engine() {
        let state = test_app_state();
        let (thread, _) = history_fixture(&state, true);
        let messages = db::messages::get_thread_messages(&state.db, &thread.id).unwrap();
        record_checkpoint_usage(&state, &thread.id, &messages[1], 32000);
        let stale_metadata = json!({ "contextUsageCache": { "currentTokens": 92000 } });
        let restored =
            restore_checkpoint_context_usage(&state.db, &thread.id, stale_metadata, None);
        assert!(
            restored.get(CONTEXT_USAGE_CACHE_METADATA_KEY).is_none(),
            "a missing final measurement must not reuse an older turn or the latest cache"
        );

        record_checkpoint_usage(&state, &thread.id, &messages[5], 92000);
        let compatibility = json!({ "codexCompatibilityFork": true });
        assert!(
            checkpoint_context_usage(
                &state.db,
                &thread.id,
                Some(&compatibility),
                Some("new-engine")
            )
            .is_none(),
            "injected history must not inherit the original context size"
        );
        let measured = checkpoint_context_usage(
            &state.db,
            &thread.id,
            Some(&compatibility),
            Some("engine-source"),
        )
        .unwrap();
        assert_eq!(measured.current_tokens, Some(92000));
    }

    #[test]
    fn rollback_clears_stale_usage_for_unmeasured_or_empty_history() {
        for retained_turns in [0, 1] {
            let state = test_app_state();
            let (thread, mut snapshot) = history_fixture(&state, true);
            let messages = db::messages::get_thread_messages(&state.db, &thread.id).unwrap();
            record_checkpoint_usage(&state, &thread.id, &messages[5], 92000);
            let mut metadata = thread.engine_metadata.clone().unwrap();
            metadata[CONTEXT_USAGE_CACHE_METADATA_KEY] = json!({ "currentTokens": 92000 });
            metadata[ENGINE_ROLLBACK_NUM_TURNS_KEY] = json!(3 - retained_turns);
            metadata[ENGINE_ROLLBACK_TARGET_TURN_COUNT_KEY] = json!(retained_turns);
            db::threads::update_engine_metadata(&state.db, &thread.id, &metadata).unwrap();
            snapshot.native_turn_ids.truncate(retained_turns);
            snapshot.imported_messages.truncate(retained_turns * 2);

            let updated = persist_codex_in_place_rollback(&state.db, &thread, &snapshot).unwrap();
            assert!(cached_context_usage_from_metadata(updated.engine_metadata.as_ref()).is_none());
            assert_eq!(updated.message_count, (retained_turns * 2) as i64);
        }
    }

    #[test]
    fn rollback_and_revert_restore_usage_after_committing_the_retained_prefix() {
        for history_mode in ["legacy", "paginated"] {
            let state = test_app_state();
            let (thread, mut snapshot) = history_fixture(&state, true);
            let messages = db::messages::get_thread_messages(&state.db, &thread.id).unwrap();
            record_checkpoint_usage(&state, &thread.id, &messages[1], 32000);
            record_checkpoint_usage(&state, &thread.id, &messages[5], 92000);
            let mut metadata = thread.engine_metadata.clone().unwrap();
            metadata[CONTEXT_USAGE_CACHE_METADATA_KEY] = json!({ "currentTokens": 92000 });
            db::threads::update_engine_metadata(&state.db, &thread.id, &metadata).unwrap();
            snapshot.history_mode = Some(history_mode.into());
            snapshot.native_turn_ids.truncate(1);
            snapshot.imported_messages.truncate(2);

            let updated = persist_codex_in_place_rollback(&state.db, &thread, &snapshot).unwrap();
            let usage =
                cached_context_usage_from_metadata(updated.engine_metadata.as_ref()).unwrap();
            assert_eq!(usage.current_tokens, Some(32000), "{history_mode}");
            assert_eq!(
                usage.context_window_percent,
                Some(80),
                "20% used, not 80% used"
            );
            assert_eq!(updated.message_count, 2);
        }
    }

    fn history_fixture(state: &AppState, remote_first: bool) -> (ThreadDto, ThreadSyncSnapshot) {
        let thread = test_thread(state, "codex", "gpt-5.4");
        let messages = (0..6)
            .map(|i| crate::engines::ImportedThreadMessage {
                role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
                content: Some(format!("message {i}")),
                blocks: json!([]),
                status: "completed".into(),
                native_turn_id: Some(format!("turn-{}", i / 2)),
                turn_engine_id: Some("codex".into()),
                turn_model_id: None,
                turn_reasoning_effort: None,
                token_input: 1,
                token_output: 2,
                created_at: None,
            })
            .collect::<Vec<_>>();
        let snapshot = ThreadSyncSnapshot {
            history_mode: Some("paginated".into()),
            native_turn_ids: vec!["turn-0".into(), "turn-1".into(), "turn-2".into()],
            imported_messages: messages,
            ..Default::default()
        };
        let records = snapshot
            .imported_messages
            .iter()
            .map(|m| db::messages::ImportedMessageRecord {
                role: m.role.clone(),
                content: m.content.clone(),
                blocks: m.blocks.clone(),
                status: MessageStatusDto::Completed,
                native_turn_id: m.native_turn_id.clone(),
                turn_engine_id: m.turn_engine_id.clone(),
                turn_model_id: None,
                turn_reasoning_effort: None,
                token_input: m.token_input,
                token_output: m.token_output,
                created_at: None,
            })
            .collect::<Vec<_>>();
        db::messages::replace_thread_messages(&state.db, &thread.id, &records).unwrap();
        let intent = EngineRollbackIntent {
            num_turns: 2,
            source_turn_count: 3,
            target_turn_count: 1,
            phase: EngineRollbackPhase::Prepared,
        };
        let mut metadata = mark_engine_rollback_pending(json!({"manualTitle": "Keep me"}), &intent);
        if remote_first {
            metadata[ENGINE_ROLLBACK_REMOTE_FIRST_KEY] = json!(true);
            metadata[ENGINE_ROLLBACK_SOURCE_IDS_KEY] = json!(snapshot.native_turn_ids);
        }
        db::messages::prepare_pending_thread_rollback(&state.db, &thread.id, 2, &metadata).unwrap();
        (
            db::threads::get_thread(&state.db, &thread.id)
                .unwrap()
                .unwrap(),
            snapshot,
        )
    }

    #[test]
    fn remote_first_history_commit_preserves_prefix_and_is_restart_idempotent() {
        let state = test_app_state();
        let (thread, mut snapshot) = history_fixture(&state, true);
        let before = db::messages::get_thread_messages(&state.db, &thread.id).unwrap();
        assert_eq!(before.len(), 6, "prepared intent must not delete messages");
        assert_eq!(
            db::messages::thread_native_turn_ids(&state.db, &thread.id).unwrap(),
            snapshot.native_turn_ids
        );
        let started = db::threads::mark_pending_rollback_started(&state.db, &thread.id).unwrap();
        assert_eq!(
            engine_rollback_intent(started.engine_metadata.as_ref())
                .unwrap()
                .phase,
            EngineRollbackPhase::Started
        );
        // Simulate Codex committing before the process stopped. Only its native
        // target IDs are needed to finish the durable local transaction.
        snapshot.native_turn_ids.truncate(1);
        snapshot.imported_messages.truncate(2);
        let recovered = db::threads::get_thread(&state.db, &thread.id)
            .unwrap()
            .unwrap();
        let finished = persist_codex_in_place_rollback(&state.db, &recovered, &snapshot).unwrap();
        assert!(!is_engine_rollback_pending(
            finished.engine_metadata.as_ref()
        ));
        assert_eq!(finished.message_count, 2);
        assert_eq!(finished.total_tokens, 6);
        assert_eq!(
            finished.engine_metadata.as_ref().unwrap()["manualTitle"],
            "Keep me"
        );
        let after = db::messages::get_thread_messages(&state.db, &thread.id).unwrap();
        assert_eq!(
            after
                .iter()
                .map(|m| (&m.id, &m.created_at))
                .collect::<Vec<_>>(),
            before[..2]
                .iter()
                .map(|m| (&m.id, &m.created_at))
                .collect::<Vec<_>>()
        );
        persist_codex_in_place_rollback(&state.db, &finished, &snapshot).unwrap();
        assert_eq!(
            db::messages::thread_turn_count(&state.db, &thread.id).unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn rejected_edit_preserves_original_messages_and_clears_all_intent_fields() {
        let state = test_app_state();
        let (thread, snapshot) = history_fixture(&state, true);
        let before = db::messages::get_thread_messages(&state.db, &thread.id).unwrap();
        mark_history_mutation_rejected(&state, &thread.id)
            .await
            .unwrap();
        reconcile_cancelled_rollback(&state, &thread, &snapshot, false)
            .await
            .unwrap();
        let after = db::messages::get_thread_messages(&state.db, &thread.id).unwrap();
        assert_eq!(
            before.iter().map(|m| &m.id).collect::<Vec<_>>(),
            after.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        let restored = db::threads::get_thread(&state.db, &thread.id)
            .unwrap()
            .unwrap();
        let metadata = restored.engine_metadata.as_ref().unwrap();
        assert!(!is_engine_rollback_pending(Some(metadata)));
        assert!(metadata.get(ENGINE_ROLLBACK_SOURCE_IDS_KEY).is_none());
        assert!(metadata.get(ENGINE_ROLLBACK_REJECTED_KEY).is_none());
        // Fork and send join the resolver: once reconciled, neither repeats the RPC.
        assert_eq!(
            resolve_pending_engine_rollback(&state, &thread.id, None)
                .await
                .unwrap()
                .message_count,
            6
        );
    }

    #[tokio::test]
    async fn failed_local_history_transactions_keep_both_messages_and_pending_intent() {
        let state = test_app_state();
        let (thread, mut snapshot) = history_fixture(&state, true);
        snapshot.native_turn_ids.truncate(1);
        snapshot.imported_messages.truncate(2);
        state.db.connect().unwrap().execute_batch(
            "CREATE TRIGGER fail_history_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;"
        ).unwrap();
        assert!(persist_codex_in_place_rollback(&state.db, &thread, &snapshot).is_err());
        assert!(
            reconcile_cancelled_rollback(&state, &thread, &snapshot, true)
                .await
                .is_err()
        );
        let current = db::threads::get_thread(&state.db, &thread.id)
            .unwrap()
            .unwrap();
        assert!(is_engine_rollback_pending(current.engine_metadata.as_ref()));
        assert_eq!(
            db::messages::get_thread_messages(&state.db, &thread.id)
                .unwrap()
                .len(),
            6
        );
    }

    #[tokio::test]
    async fn old_projected_history_is_restored_including_an_empty_remote_history() {
        let state = test_app_state();
        let (thread, mut snapshot) = history_fixture(&state, false);
        assert_eq!(thread.message_count, 2);
        reconcile_cancelled_rollback(&state, &thread, &snapshot, true)
            .await
            .unwrap();
        let restored = resolve_pending_engine_rollback(&state, &thread.id, None)
            .await
            .unwrap();
        assert_eq!(restored.message_count, 6);
        assert!(!is_engine_rollback_pending(
            restored.engine_metadata.as_ref()
        ));
        snapshot.imported_messages.clear();
        snapshot.native_turn_ids.clear();
        reconcile_cancelled_rollback(&state, &restored, &snapshot, true)
            .await
            .unwrap();
        assert_eq!(
            db::threads::get_thread(&state.db, &thread.id)
                .unwrap()
                .unwrap()
                .message_count,
            0
        );
    }

    fn compatibility_test_message(
        role: &str,
        content: Option<&str>,
        blocks: Option<Value>,
    ) -> MessageDto {
        MessageDto {
            id: Uuid::new_v4().to_string(),
            thread_id: "thread".to_string(),
            role: role.to_string(),
            content: content.map(str::to_string),
            blocks,
            native_turn_id: None,
            turn_engine_id: Some("codex".to_string()),
            turn_model_id: Some("gpt-5.4".to_string()),
            turn_reasoning_effort: None,
            schema_version: 1,
            status: MessageStatusDto::Completed,
            token_usage: None,
            created_at: "2026-08-29T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn compatibility_history_contains_only_visible_user_and_assistant_text() {
        let messages = vec![
            compatibility_test_message("user", Some("Old question"), None),
            compatibility_test_message(
                "assistant",
                None,
                Some(json!([
                    { "type": "thinking", "content": "hidden reasoning" },
                    { "type": "text", "content": "Old answer" },
                    { "type": "action", "actionId": "stale-call" }
                ])),
            ),
            compatibility_test_message("system", Some("do not replay"), None),
            compatibility_test_message("assistant", Some("   "), None),
        ];

        let items = build_codex_compatibility_history_items(&messages);

        assert_eq!(
            items,
            vec![
                json!({
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "Old question" }]
                }),
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Old answer" }]
                }),
            ]
        );
        let serialized = serde_json::to_string(&items).expect("serialize compatibility history");
        assert!(!serialized.contains("encrypted_content"));
        assert!(!serialized.contains("stale-call"));
        assert!(!serialized.contains("hidden reasoning"));
    }

    #[test]
    fn thread_allow_network_reads_explicit_override_in_full_access_mode() {
        let metadata = json!({
            "sandboxMode": "danger-full-access",
            "sandboxAllowNetwork": false,
        });

        assert_eq!(thread_allow_network(Some(&metadata)), Some(false));
    }

    #[test]
    fn permission_defaults_use_max_privilege_modes() {
        assert_eq!(
            approval_policy_for_engine_and_trust_level("codex", &TrustLevelDto::Restricted),
            "never"
        );
        assert!(allow_network_for_trust_level(&TrustLevelDto::Restricted));
        assert_eq!(
            default_sandbox_mode_for_engine("codex"),
            "danger-full-access"
        );
    }

    #[test]
    fn normalize_thread_sandbox_mode_accepts_aliases() {
        assert_eq!(
            normalize_thread_sandbox_mode(Some("danger_full_access".to_string())).unwrap(),
            Some("danger-full-access".to_string())
        );
        assert_eq!(
            normalize_thread_sandbox_mode(Some("read_only".to_string())).unwrap(),
            Some("read-only".to_string())
        );
    }

    #[test]
    fn normalize_thread_approval_policy_accepts_structured_codex_policy() {
        let normalized = normalize_thread_approval_policy_for_engine(
            "codex",
            Some(json!({
                "reject": {
                    "mcp_elicitations": false,
                    "request_permissions": true,
                    "rules": true,
                    "sandbox_approval": false
                }
            })),
        )
        .expect("expected structured policy to validate");

        assert_eq!(
            normalized,
            Some(json!({
                "reject": {
                    "mcp_elicitations": false,
                    "request_permissions": true,
                    "rules": true,
                    "sandbox_approval": false
                }
            }))
        );
    }

    #[test]
    fn normalize_thread_personality_accepts_known_values() {
        assert_eq!(
            normalize_thread_personality(Some("Friendly".to_string())).unwrap(),
            Some("friendly".to_string())
        );
        assert_eq!(
            normalize_thread_service_tier(Some(" FLEX ".to_string())).unwrap(),
            Some("flex".to_string())
        );
        assert_eq!(
            normalize_thread_output_schema(Some(json!(true))).unwrap(),
            Some(json!(true))
        );
    }

    #[test]
    fn normalize_workspace_confirmation_roots_rejects_unknown_paths() {
        let error = normalize_workspace_confirmation_roots(
            &[String::from("/workspace/unknown")],
            "/workspace",
            &[
                String::from("/workspace/repo-a"),
                String::from("/workspace/repo-b"),
            ],
        )
        .expect_err("expected unknown path to be rejected");

        assert!(error.contains("is not an active repository"));
    }

    #[test]
    fn normalize_workspace_confirmation_roots_rejects_empty_lists() {
        let error = normalize_workspace_confirmation_roots(
            &[],
            "/workspace",
            &[
                String::from("/workspace/repo-a"),
                String::from("/workspace/repo-b"),
            ],
        )
        .expect_err("expected empty roots to be rejected");

        assert!(error.contains("must include at least one active repository"));
    }

    #[test]
    fn normalize_workspace_confirmation_roots_deduplicates_confirmed_paths() {
        let roots = normalize_workspace_confirmation_roots(
            &[
                String::from("/workspace/repo-a"),
                String::from("/workspace/repo-a"),
                String::from("/workspace/repo-b"),
            ],
            "/workspace",
            &[
                String::from("/workspace/repo-a"),
                String::from("/workspace/repo-b"),
            ],
        )
        .expect("expected roots to normalize");

        assert_eq!(
            roots,
            vec![
                String::from("/workspace/repo-a"),
                String::from("/workspace/repo-b")
            ]
        );
    }

    #[test]
    fn merge_codex_runtime_metadata_sets_runtime_fields() {
        let metadata = merge_codex_runtime_metadata(
            Some(json!({
                "existing": true,
                "codexSyncRequired": true,
                "codexSyncReason": "stale",
            })),
            Some("active"),
            &["waitingOnApproval".to_string()],
            Some("Preview"),
            false,
            None,
        );

        assert_eq!(metadata.get("existing"), Some(&json!(true)));
        assert_eq!(metadata.get("codexThreadStatus"), Some(&json!("active")));
        assert_eq!(
            metadata.get("codexThreadActiveFlags"),
            Some(&json!(["waitingOnApproval"]))
        );
        assert_eq!(metadata.get("codexPreview"), Some(&json!("Preview")));
        assert_eq!(metadata.get("codexSyncRequired"), Some(&json!(false)));
        assert_eq!(
            metadata.get("codexSyncReason"),
            Some(&serde_json::Value::Null)
        );
    }

    #[test]
    fn map_codex_thread_status_to_local_honors_waiting_flags() {
        assert_eq!(
            map_codex_thread_status_to_local(
                Some("active"),
                &["waitingOnApproval".to_string()],
                false,
            ),
            Some(ThreadStatusDto::AwaitingApproval)
        );
        assert_eq!(
            map_codex_thread_status_to_local(Some("systemError"), &[], false),
            Some(ThreadStatusDto::Error)
        );
        assert_eq!(
            map_codex_thread_status_to_local(Some("active"), &[], true),
            None
        );
    }

    #[test]
    fn codex_sync_does_not_resurrect_a_completed_transcript_from_unflagged_active_metadata() {
        let snapshot = ThreadSyncSnapshot {
            history_mode: None,
            native_turn_ids: Vec::new(),
            title: Some("Completed thread".to_string()),
            preview: Some("Done".to_string()),
            raw_status: Some("active".to_string()),
            active_flags: Vec::new(),
            imported_messages: vec![ImportedThreadMessage {
                role: "assistant".to_string(),
                content: Some("Finished".to_string()),
                blocks: json!([]),
                status: "completed".to_string(),
                native_turn_id: None,
                turn_engine_id: Some("codex".to_string()),
                turn_model_id: Some("gpt-5.4".to_string()),
                turn_reasoning_effort: Some("high".to_string()),
                token_input: 0,
                token_output: 0,
                created_at: Some("2026-07-10T09:11:28Z".to_string()),
            }],
        };

        assert_eq!(
            resolve_codex_sync_thread_status(&snapshot, false),
            Some(ThreadStatusDto::Completed)
        );
    }

    #[test]
    fn codex_sync_preserves_real_active_turn_evidence() {
        let mut snapshot = ThreadSyncSnapshot {
            history_mode: None,
            native_turn_ids: Vec::new(),
            title: None,
            preview: None,
            raw_status: Some("active".to_string()),
            active_flags: Vec::new(),
            imported_messages: vec![ImportedThreadMessage {
                role: "assistant".to_string(),
                content: None,
                blocks: json!([]),
                status: "streaming".to_string(),
                native_turn_id: None,
                turn_engine_id: Some("codex".to_string()),
                turn_model_id: Some("gpt-5.4".to_string()),
                turn_reasoning_effort: None,
                token_input: 0,
                token_output: 0,
                created_at: None,
            }],
        };

        assert_eq!(
            resolve_codex_sync_thread_status(&snapshot, false),
            Some(ThreadStatusDto::Streaming)
        );

        snapshot.imported_messages[0].status = "completed".to_string();
        snapshot.active_flags = vec!["waitingOnApproval".to_string()];
        assert_eq!(
            resolve_codex_sync_thread_status(&snapshot, false),
            Some(ThreadStatusDto::AwaitingApproval)
        );
        assert_eq!(resolve_codex_sync_thread_status(&snapshot, true), None);
    }

    #[test]
    fn resolve_codex_remote_thread_repo_id_accepts_workspace_root_and_repo_roots() {
        let repos = vec![RepoDto {
            id: "repo-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            name: "repo".to_string(),
            path: "/workspace/repo".to_string(),
            default_branch: "main".to_string(),
            is_active: true,
            trust_level: TrustLevelDto::Standard,
        }];

        assert_eq!(
            resolve_codex_remote_thread_repo_id("/workspace", &repos, "/workspace").unwrap(),
            None
        );
        assert_eq!(
            resolve_codex_remote_thread_repo_id("/workspace", &repos, "/workspace/repo").unwrap(),
            Some("repo-1".to_string())
        );
        assert!(resolve_codex_remote_thread_repo_id("/workspace", &repos, "/elsewhere").is_err());
    }

    #[test]
    fn build_codex_remote_thread_title_prefers_thread_title_then_preview() {
        let titled = CodexRemoteThreadSummary {
            engine_thread_id: "thread-12345678".to_string(),
            title: Some("  Remote title  ".to_string()),
            preview: "Preview line".to_string(),
            cwd: "/workspace".to_string(),
            created_at: 1_710_000_000,
            updated_at: 1_710_000_001,
            model_provider: "openai".to_string(),
            source_kind: "appServer".to_string(),
            status_type: "idle".to_string(),
            active_flags: Vec::new(),
            archived: false,
        };
        let preview_only = CodexRemoteThreadSummary {
            title: None,
            preview: "First line\nSecond line".to_string(),
            ..titled.clone()
        };

        assert_eq!(build_codex_remote_thread_title(&titled), "Remote title");
        assert_eq!(build_codex_remote_thread_title(&preview_only), "First line");
    }

    #[test]
    fn build_codex_remote_thread_metadata_sets_remote_fields() {
        let summary = CodexRemoteThreadSummary {
            engine_thread_id: "thread-12345678".to_string(),
            title: Some("Remote title".to_string()),
            preview: "Preview line".to_string(),
            cwd: "/workspace".to_string(),
            created_at: 1_710_000_000,
            updated_at: 1_710_000_001,
            model_provider: "openai".to_string(),
            source_kind: "appServer".to_string(),
            status_type: "active".to_string(),
            active_flags: vec!["waitingOnApproval".to_string()],
            archived: true,
        };

        let metadata = build_codex_remote_thread_metadata(&summary, "gpt-5.4");

        assert_eq!(metadata.get("lastModelId"), Some(&json!("gpt-5.4")));
        assert_eq!(metadata.get("codexTranscriptImported"), Some(&json!(false)));
        assert_eq!(metadata.get("codexModelProvider"), Some(&json!("openai")));
        assert_eq!(metadata.get("codexSourceKind"), Some(&json!("appServer")));
        assert_eq!(metadata.get("codexRemoteArchived"), Some(&json!(true)));
        assert_eq!(metadata.get("codexRemoteCwd"), Some(&json!("/workspace")));
        assert_eq!(metadata.get("codexThreadStatus"), Some(&json!("active")));
        assert_eq!(
            metadata.get("codexThreadActiveFlags"),
            Some(&json!(["waitingOnApproval"]))
        );
        assert_eq!(metadata.get("codexPreview"), Some(&json!("Preview line")));
        assert_eq!(metadata.get("codexSyncRequired"), Some(&json!(true)));
        assert_eq!(
            metadata.get(codex_thread_metadata::REMOTE_TURN_ACTIVE_KEY),
            Some(&json!(false))
        );
        assert_eq!(
            metadata.get("codexSyncReason"),
            Some(&json!("remote_thread_attached"))
        );
    }

    #[test]
    fn remote_timestamp_format_accepts_milliseconds() {
        assert_eq!(
            codex_remote_thread_timestamp_to_rfc3339(1_777_155_663_506),
            "2026-04-25T22:21:03.506+00:00"
        );
    }

    #[test]
    fn clone_codex_branch_metadata_marks_local_transcript_as_imported() {
        let metadata = clone_codex_branch_metadata(
            Some(&json!({
                "codexTranscriptImported": false,
                "manualTitle": true,
                "contextUsageCache": { "currentTokens": 92000 },
            })),
            "gpt-5.4",
            Some("idle"),
            &[],
            Some("Preview"),
            false,
            None,
        );

        assert_eq!(metadata.get("codexTranscriptImported"), Some(&json!(true)));
        assert_eq!(metadata.get("lastModelId"), Some(&json!("gpt-5.4")));
        assert_eq!(metadata.get("manualTitle"), None);
        assert_eq!(metadata.get(CONTEXT_USAGE_CACHE_METADATA_KEY), None);
    }

    #[test]
    fn should_clone_local_branch_history_requires_synced_local_messages() {
        let mut thread = ThreadDto {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            repo_id: None,
            engine_id: "codex".to_string(),
            model_id: "gpt-5.4".to_string(),
            engine_thread_id: Some("engine-thread-1".to_string()),
            engine_metadata: Some(json!({
                "codexSyncRequired": false,
            })),
            title: "Thread".to_string(),
            status: ThreadStatusDto::Idle,
            message_count: 2,
            total_tokens: 0,
            created_at: "2026-03-13T00:00:00Z".to_string(),
            last_activity_at: "2026-03-13T00:00:00Z".to_string(),
        };

        assert!(should_clone_local_branch_history(&thread));

        thread.message_count = 0;
        assert!(!should_clone_local_branch_history(&thread));

        thread.message_count = 2;
        thread.engine_metadata = Some(json!({
            "codexSyncRequired": true,
        }));
        assert!(!should_clone_local_branch_history(&thread));

        thread.engine_metadata = Some(json!({
            "codexCompatibilityFork": true,
        }));
        assert!(!should_clone_local_branch_history(&thread));

        thread.engine_metadata = Some(json!({
            "codexCompatibilityFork": true,
            "codexCompatibilityHistoryComplete": true,
        }));
        assert!(should_clone_local_branch_history(&thread));
    }

    #[test]
    fn codex_history_tools_allow_legacy_local_history_marked_unimported() {
        let mut thread = ThreadDto {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            repo_id: None,
            engine_id: "codex".to_string(),
            model_id: "gpt-5.4".to_string(),
            engine_thread_id: Some("engine-thread-1".to_string()),
            engine_metadata: Some(json!({
                "codexTranscriptImported": false,
                "codexSyncRequired": false,
            })),
            title: "Thread".to_string(),
            status: ThreadStatusDto::Idle,
            message_count: 2,
            total_tokens: 0,
            created_at: "2026-03-13T00:00:00Z".to_string(),
            last_activity_at: "2026-03-13T00:00:00Z".to_string(),
        };

        assert!(codex_thread_has_local_transcript_for_history_tools(&thread));

        thread.message_count = 0;
        assert!(!codex_thread_has_local_transcript_for_history_tools(
            &thread
        ));

        thread.message_count = 2;
        thread.engine_metadata = Some(json!({
            "codexTranscriptImported": false,
            "codexSyncRequired": true,
        }));
        assert!(!codex_thread_has_local_transcript_for_history_tools(
            &thread
        ));

        thread.engine_metadata = Some(json!({
            "codexTranscriptImported": true,
            "codexCompatibilityFork": true,
        }));
        assert!(!codex_thread_has_local_transcript_for_history_tools(
            &thread
        ));

        thread.engine_metadata = Some(json!({
            "codexTranscriptImported": true,
            "codexCompatibilityFork": true,
            "codexCompatibilityHistoryComplete": true,
        }));
        assert!(codex_thread_has_local_transcript_for_history_tools(&thread));
    }

    #[test]
    fn active_codex_fork_boundary_accepts_an_exact_completed_local_message() {
        assert!(!has_stable_active_fork_boundary(None));
        assert!(has_stable_active_fork_boundary(Some(&CodexForkPoint {
            source_message_id: Some("assistant-message-1".to_string()),
            last_turn_id: None,
            turns_after: 1,
        })));
        assert!(!has_stable_active_fork_boundary(Some(&CodexForkPoint {
            source_message_id: None,
            last_turn_id: Some("native-turn-1".to_string()),
            turns_after: 1,
        })));
        assert!(has_stable_active_fork_boundary(Some(&CodexForkPoint {
            source_message_id: Some("assistant-message-1".to_string()),
            last_turn_id: Some("native-turn-1".to_string()),
            turns_after: 1,
        })));
    }

    #[test]
    fn missing_native_boundary_forces_a_compatibility_fork() {
        assert!(fork_boundary_requires_compatibility(&EngineForkIntent {
            source_engine_thread_id: "legacy".to_string(),
            last_turn_id: None,
            turns_after: Some(4),
        }));
        assert!(!fork_boundary_requires_compatibility(&EngineForkIntent {
            source_engine_thread_id: "native".to_string(),
            last_turn_id: Some("turn-1".to_string()),
            turns_after: Some(4),
        }));
        assert!(!fork_boundary_requires_compatibility(&EngineForkIntent {
            source_engine_thread_id: "whole-thread".to_string(),
            last_turn_id: None,
            turns_after: None,
        }));
    }

    #[tokio::test]
    async fn active_codex_fork_rejects_unbounded_requests_but_accepts_stable_gate() {
        let state = test_app_state();
        let source = test_thread(&state, "codex", "gpt-5.4");
        assert!(
            state
                .turns
                .try_register(&source.id, tokio_util::sync::CancellationToken::new(),)
                .await
        );

        let unbounded_error = fork_codex_thread_inner(&state, source.id.clone(), None, None, None)
            .await
            .expect_err("an unbounded active-source fork must remain blocked");
        assert!(unbounded_error.contains("cannot fork an active thread"));

        let stable_error = fork_codex_thread_inner(
            &state,
            source.id.clone(),
            Some(CodexForkPoint {
                source_message_id: Some("assistant-message-1".to_string()),
                last_turn_id: Some("native-turn-1".to_string()),
                turns_after: 1,
            }),
            None,
            None,
        )
        .await
        .expect_err("the fixture has no initialized engine thread");
        assert_eq!(stable_error, "Codex thread has not been initialized yet");
        assert!(state.turns.get(&source.id).await.is_some());

        state.turns.finish(&source.id).await;
        db::threads::update_thread_status(&state.db, &source.id, ThreadStatusDto::Streaming)
            .expect("mark the persisted source runtime active");
        let persisted_active_error =
            fork_codex_thread_inner(&state, source.id.clone(), None, None, None)
                .await
                .expect_err("persisted active runtime must enforce the same stable boundary");
        assert!(persisted_active_error.contains("cannot fork an active thread"));
    }

    #[tokio::test]
    async fn create_codex_branch_thread_rejects_threads_without_imported_transcript() {
        let state = test_app_state();
        let mut thread = test_thread(&state, "codex", "gpt-5.4");
        thread.engine_metadata = Some(json!({
            "codexTranscriptImported": false,
        }));

        let intent = EngineForkIntent {
            source_engine_thread_id: "engine-thread-source".to_string(),
            last_turn_id: None,
            turns_after: None,
        };
        let error = create_pending_codex_branch_thread(&state, &thread, &intent, None, None, None)
            .await
            .expect_err("expected branch creation to reject missing local transcript");

        assert!(error.contains("locally mirrored transcript"));
    }

    #[test]
    fn engine_fork_intent_round_trips_through_metadata() {
        let intent = EngineForkIntent {
            source_engine_thread_id: "engine-source".to_string(),
            last_turn_id: Some("turn-7".to_string()),
            turns_after: Some(2),
        };
        let metadata = mark_engine_fork_pending(json!({ "lastModelId": "gpt-5.4" }), &intent);

        assert!(is_engine_fork_pending(Some(&metadata)));
        assert_eq!(engine_fork_intent(Some(&metadata)), Some(intent));
        // Unrelated metadata is preserved.
        assert_eq!(metadata.get("lastModelId"), Some(&json!("gpt-5.4")));

        let cleared = clear_engine_fork_pending(metadata);
        assert!(!is_engine_fork_pending(Some(&cleared)));
        assert_eq!(engine_fork_intent(Some(&cleared)), None);
        assert_eq!(cleared.get("lastModelId"), Some(&json!("gpt-5.4")));
    }

    #[test]
    fn engine_fork_intent_ignores_pending_flag_without_source() {
        // A pending flag with no recorded source engine id cannot be acted on.
        let metadata = json!({ "engineForkPending": true });
        assert!(is_engine_fork_pending(Some(&metadata)));
        assert_eq!(engine_fork_intent(Some(&metadata)), None);
    }

    #[test]
    fn engine_rollback_intent_round_trips_through_metadata() {
        let intent = EngineRollbackIntent {
            num_turns: 2,
            source_turn_count: 5,
            target_turn_count: 3,
            phase: EngineRollbackPhase::Prepared,
        };
        let metadata = mark_engine_rollback_pending(json!({ "lastModelId": "gpt-5.4" }), &intent);

        assert!(is_engine_rollback_pending(Some(&metadata)));
        assert_eq!(engine_rollback_intent(Some(&metadata)), Some(intent));
        assert_eq!(metadata.get("lastModelId"), Some(&json!("gpt-5.4")));

        let cleared = clear_engine_rollback_pending(metadata);
        assert!(!is_engine_rollback_pending(Some(&cleared)));
        assert_eq!(engine_rollback_intent(Some(&cleared)), None);
        assert_eq!(cleared.get("lastModelId"), Some(&json!("gpt-5.4")));
    }

    #[test]
    fn compatibility_rollback_marker_expectation_round_trips_and_clears() {
        let metadata = mark_engine_rollback_marker_expectation(
            json!({
                "engineRollbackPending": true,
                "engineRollbackError": "old background failure",
                "lastModelId": "gpt-5.6-luna"
            }),
            4,
        )
        .expect("expected marker metadata");

        assert_eq!(
            engine_rollback_marker_expectation(Some(&metadata)),
            Some((4, 5))
        );
        let cleared = clear_engine_rollback_pending(metadata);
        assert_eq!(engine_rollback_marker_expectation(Some(&cleared)), None);
        assert_eq!(cleared.get(ENGINE_ROLLBACK_ERROR_KEY), None);
        assert_eq!(cleared.get("lastModelId"), Some(&json!("gpt-5.6-luna")));
    }

    #[test]
    fn legacy_compatibility_rollback_uses_newer_codex_marker_not_native_turn_count() {
        let state = test_app_state();
        let mut thread = test_thread(&state, "codex", "gpt-5.6-luna");
        thread.engine_metadata = Some(json!({
            "codexCompatibilityFork": true,
            "codexSyncUpdatedAt": "2026-08-30T06:39:22.772146900+00:00",
            "engineRollbackPending": true,
            "engineRollbackPhase": "started"
        }));
        let completed = crate::engines::codex::CodexRollbackMarkerState {
            count: 1,
            latest_timestamp: Some("2026-08-30T06:40:48.615Z".to_string()),
        };
        let stale = crate::engines::codex::CodexRollbackMarkerState {
            count: 1,
            latest_timestamp: Some("2026-08-30T06:38:48.615Z".to_string()),
        };

        assert!(legacy_compatibility_rollback_completed(&thread, &completed));
        assert!(!legacy_compatibility_rollback_completed(&thread, &stale));
    }

    #[test]
    fn engine_rollback_intent_rejects_inconsistent_counts() {
        let metadata = json!({
            "engineRollbackPending": true,
            "engineRollbackPhase": "prepared",
            "engineRollbackNumTurns": 2,
            "engineRollbackSourceTurnCount": 5,
            "engineRollbackTargetTurnCount": 4,
        });

        assert!(is_engine_rollback_pending(Some(&metadata)));
        assert_eq!(engine_rollback_intent(Some(&metadata)), None);
    }

    #[tokio::test]
    async fn create_pending_codex_branch_thread_marks_fork_and_clones_history() {
        let state = test_app_state();
        let source = test_thread(&state, "codex", "gpt-5.4");
        let imported = [
            ("user", "First"),
            ("assistant", "Reply 1"),
            ("user", "Second"),
            ("assistant", "Reply 2"),
        ]
        .into_iter()
        .map(|(role, content)| db::messages::ImportedMessageRecord {
            role: role.to_string(),
            content: Some(content.to_string()),
            blocks: json!([{ "type": "text", "content": content }]),
            status: MessageStatusDto::Completed,
            native_turn_id: None,
            turn_engine_id: Some("codex".to_string()),
            turn_model_id: Some("gpt-5.4".to_string()),
            turn_reasoning_effort: None,
            token_input: u64::from(role == "user"),
            token_output: u64::from(role == "assistant"),
            created_at: Some("2020-01-01 00:00:00.000".to_string()),
        })
        .collect::<Vec<_>>();
        db::messages::replace_thread_messages(&state.db, &source.id, &imported)
            .expect("expected source messages to be inserted");
        let source = db::threads::get_thread(&state.db, &source.id)
            .expect("get source thread")
            .expect("source thread exists");

        let intent = EngineForkIntent {
            source_engine_thread_id: "engine-source".to_string(),
            last_turn_id: None,
            turns_after: None,
        };
        let branch = create_pending_codex_branch_thread(&state, &source, &intent, None, None, None)
            .await
            .expect("expected pending branch creation to succeed");

        // The branch has no engine thread yet, but the fork intent is recorded.
        assert!(branch.engine_thread_id.is_none());
        assert!(is_engine_fork_pending(branch.engine_metadata.as_ref()));
        assert_eq!(
            engine_fork_intent(branch.engine_metadata.as_ref()),
            Some(intent)
        );
        // The transcript was cloned locally so the branch is immediately readable.
        assert_eq!(branch.message_count, 4);
        assert!(branch.last_activity_at > source.last_activity_at);
        let listed = db::threads::list_threads_for_workspace(&state.db, &source.workspace_id)
            .expect("expected workspace threads to be listed");
        assert_eq!(
            listed.first().map(|thread| thread.id.as_str()),
            Some(branch.id.as_str())
        );
    }

    #[tokio::test]
    async fn create_pending_codex_branch_thread_uses_exact_message_boundary() {
        let state = test_app_state();
        let source = test_thread(&state, "codex", "gpt-5.4");
        let imported = [
            ("user", "First", MessageStatusDto::Completed, None),
            (
                "assistant",
                "Reply 1",
                MessageStatusDto::Completed,
                Some("native-turn-1"),
            ),
            ("user", "Second", MessageStatusDto::Completed, None),
            (
                "assistant",
                "Partial reply 2",
                MessageStatusDto::Streaming,
                Some("native-turn-2"),
            ),
        ]
        .into_iter()
        .map(
            |(role, content, status, native_turn_id)| db::messages::ImportedMessageRecord {
                role: role.to_string(),
                content: Some(content.to_string()),
                blocks: json!([{ "type": "text", "content": content }]),
                status,
                native_turn_id: native_turn_id.map(str::to_string),
                turn_engine_id: Some("codex".to_string()),
                turn_model_id: Some("gpt-5.4".to_string()),
                turn_reasoning_effort: None,
                token_input: u64::from(role == "user"),
                token_output: u64::from(role == "assistant"),
                created_at: None,
            },
        )
        .collect::<Vec<_>>();
        db::messages::replace_thread_messages(&state.db, &source.id, &imported)
            .expect("expected source messages to be inserted");
        let source_messages =
            db::messages::get_thread_messages(&state.db, &source.id).expect("load source messages");
        let completed_assistant_id = source_messages[1].id.clone();
        record_checkpoint_usage(&state, &source.id, &source_messages[1], 32000);
        record_checkpoint_usage(&state, &source.id, &source_messages[3], 92000);
        db::threads::update_engine_metadata(
            &state.db,
            &source.id,
            &json!({ "contextUsageCache": { "currentTokens": 92000 } }),
        )
        .unwrap();
        let source = db::threads::get_thread(&state.db, &source.id)
            .expect("get source thread")
            .expect("source thread exists");

        let intent = EngineForkIntent {
            source_engine_thread_id: "engine-source".to_string(),
            last_turn_id: Some("native-turn-1".to_string()),
            turns_after: Some(1),
        };
        let branch = create_pending_codex_branch_thread(
            &state,
            &source,
            &intent,
            Some(&completed_assistant_id),
            None,
            None,
        )
        .await
        .expect("expected exact pending branch creation to succeed");

        assert_eq!(branch.message_count, 2);
        let usage = cached_context_usage_from_metadata(branch.engine_metadata.as_ref()).unwrap();
        assert_eq!(usage.current_tokens, Some(32000));
        assert_eq!(
            usage.context_window_percent,
            Some(80),
            "20% used, not the parent's 80%"
        );
        let branch_messages =
            db::messages::get_thread_messages(&state.db, &branch.id).expect("load branch messages");
        assert_eq!(branch_messages.len(), 2);
        assert_eq!(branch_messages[1].content.as_deref(), Some("Reply 1"));
        assert_eq!(
            branch_messages[1].native_turn_id.as_deref(),
            Some("native-turn-1")
        );
    }

    /// Measures the user-perceived fork latency after deferring the engine `thread/fork`.
    /// The slow codex session-init (~10-26s) is now a background prefetch, so the fork
    /// command's synchronous return is just a local thread load + branch creation (the
    /// remaining active-turn check and the `tokio::spawn` of the prefetch are effectively
    /// free). This times exactly that critical path. Run with:
    ///   cargo test --lib -- fork_command_round_trip_is_fast --nocapture
    #[tokio::test]
    async fn fork_command_round_trip_is_fast() {
        let state = test_app_state();

        for message_count in [6usize, 100, 500] {
            let source = test_thread(&state, "codex", "gpt-5.4");
            db::threads::set_engine_thread_id(&state.db, &source.id, "engine-source")
                .expect("set engine thread id");
            let imported = (0..message_count)
                .map(|index| {
                    let role = if index % 2 == 0 { "user" } else { "assistant" };
                    db::messages::ImportedMessageRecord {
                        role: role.to_string(),
                        content: Some(format!("message {index}")),
                        blocks: json!([{ "type": "text", "content": format!("message {index}") }]),
                        status: MessageStatusDto::Completed,
                        native_turn_id: Some(format!("turn-{}", index / 2)),
                        turn_engine_id: Some("codex".to_string()),
                        turn_model_id: Some("gpt-5.4".to_string()),
                        turn_reasoning_effort: None,
                        token_input: u64::from(role == "user"),
                        token_output: u64::from(role == "assistant"),
                        created_at: None,
                    }
                })
                .collect::<Vec<_>>();
            db::messages::replace_thread_messages(&state.db, &source.id, &imported)
                .expect("insert source messages");
            db::threads::update_engine_metadata(
                &state.db,
                &source.id,
                &json!({ "codexTranscriptImported": true }),
            )
            .expect("mark transcript imported");

            let intent = EngineForkIntent {
                source_engine_thread_id: "engine-source".to_string(),
                last_turn_id: None,
                turns_after: None,
            };

            // Time the exact synchronous work the fork command does before returning.
            let started = Instant::now();
            let source = run_db(state.db.clone(), {
                let source_id = source.id.clone();
                move |db| db::threads::get_thread(db, &source_id)
            })
            .await
            .expect("load source")
            .expect("source exists");
            let branch =
                create_pending_codex_branch_thread(&state, &source, &intent, None, None, None)
                    .await
                    .expect("branch creation should succeed");
            let elapsed = started.elapsed();

            assert!(is_engine_fork_pending(branch.engine_metadata.as_ref()));
            assert!(branch.engine_thread_id.is_none());
            assert_eq!(branch.message_count, message_count as i64);

            println!(
                "fork round trip: {message_count} messages -> {:.2} ms (returned pending, transcript cloned)",
                elapsed.as_secs_f64() * 1000.0
            );
            assert!(
                elapsed.as_millis() < 500,
                "fork round trip took {:?} for {message_count} messages",
                elapsed
            );
        }
    }

    /// Old-format pending records remain readable for compatibility recovery.
    #[tokio::test]
    async fn legacy_pending_rollback_records_remain_readable() {
        let state = test_app_state();

        for message_count in [6usize, 100, 500] {
            let source = test_thread(&state, "codex", "gpt-5.4");
            db::threads::set_engine_thread_id(&state.db, &source.id, "engine-source")
                .expect("set engine thread id");
            let imported = (0..message_count)
                .map(|index| {
                    let role = if index % 2 == 0 { "user" } else { "assistant" };
                    db::messages::ImportedMessageRecord {
                        role: role.to_string(),
                        content: Some(format!("message {index}")),
                        blocks: json!([{ "type": "text", "content": format!("message {index}") }]),
                        status: MessageStatusDto::Completed,
                        native_turn_id: Some(format!("turn-{}", index / 2)),
                        turn_engine_id: Some("codex".to_string()),
                        turn_model_id: Some("gpt-5.4".to_string()),
                        turn_reasoning_effort: None,
                        token_input: u64::from(role == "user"),
                        token_output: u64::from(role == "assistant"),
                        created_at: None,
                    }
                })
                .collect::<Vec<_>>();
            db::messages::replace_thread_messages(&state.db, &source.id, &imported)
                .expect("insert source messages");
            db::threads::update_engine_metadata(
                &state.db,
                &source.id,
                &json!({ "codexTranscriptImported": true }),
            )
            .expect("mark transcript imported");

            let started = Instant::now();
            let source_turn_count =
                db::messages::thread_turn_count(&state.db, &source.id).expect("count source turns");
            let intent = EngineRollbackIntent {
                num_turns: 1,
                source_turn_count,
                target_turn_count: source_turn_count - 1,
                phase: EngineRollbackPhase::Prepared,
            };
            let pending_metadata =
                mark_engine_rollback_pending(json!({ "codexTranscriptImported": true }), &intent);
            db::messages::prepare_pending_thread_rollback(
                &state.db,
                &source.id,
                1,
                &pending_metadata,
            )
            .expect("prepare local rollback");
            let projected = db::threads::get_thread(&state.db, &source.id)
                .expect("load projected thread")
                .expect("projected thread exists");
            let elapsed = started.elapsed();

            assert_eq!(projected.id, source.id);
            assert_eq!(projected.engine_thread_id.as_deref(), Some("engine-source"));
            assert_eq!(projected.message_count, message_count as i64 - 2);
            assert_eq!(
                engine_rollback_intent(projected.engine_metadata.as_ref()),
                Some(intent.clone())
            );
            let started = db::threads::mark_pending_rollback_started(&state.db, &source.id)
                .expect("mark rollback started");
            assert_eq!(
                engine_rollback_intent(started.engine_metadata.as_ref()),
                Some(EngineRollbackIntent {
                    phase: EngineRollbackPhase::Started,
                    ..intent
                })
            );
            println!(
                "rollback round trip: {message_count} messages -> {:.2} ms (returned pending, transcript projected)",
                elapsed.as_secs_f64() * 1000.0
            );
            assert!(
                elapsed.as_millis() < 500,
                "rollback round trip took {:?} for {message_count} messages",
                elapsed
            );
        }
    }

    #[test]
    fn persist_codex_in_place_rollback_keeps_the_projected_local_prefix() {
        let state = test_app_state();
        let thread = test_thread(&state, "codex", "gpt-5.4");
        let imported = [
            ("user", "First"),
            ("assistant", "Reply 1"),
            ("user", "Second"),
            ("assistant", "Reply 2"),
        ]
        .into_iter()
        .map(|(role, content)| db::messages::ImportedMessageRecord {
            role: role.to_string(),
            content: Some(content.to_string()),
            blocks: json!([{ "type": "text", "content": content }]),
            status: MessageStatusDto::Completed,
            native_turn_id: None,
            turn_engine_id: Some("codex".to_string()),
            turn_model_id: Some("gpt-5.4".to_string()),
            turn_reasoning_effort: None,
            token_input: u64::from(role == "user"),
            token_output: u64::from(role == "assistant"),
            created_at: None,
        })
        .collect::<Vec<_>>();
        db::messages::replace_thread_messages(&state.db, &thread.id, &imported)
            .expect("expected thread messages to be inserted");

        let intent = EngineRollbackIntent {
            num_turns: 1,
            source_turn_count: 2,
            target_turn_count: 1,
            phase: EngineRollbackPhase::Prepared,
        };
        let pending_metadata = mark_engine_rollback_pending(
            thread.engine_metadata.clone().unwrap_or_else(|| json!({})),
            &intent,
        );
        db::messages::prepare_pending_thread_rollback(
            &state.db,
            &thread.id,
            intent.num_turns,
            &pending_metadata,
        )
        .expect("expected local rollback projection");
        let projected = db::threads::mark_pending_rollback_started(&state.db, &thread.id)
            .expect("expected rollback to be marked started");
        let retained_before = db::messages::get_thread_messages(&state.db, &thread.id)
            .expect("expected projected messages")
            .into_iter()
            .map(|message| (message.id, message.created_at, message.content))
            .collect::<Vec<_>>();

        let updated = persist_codex_in_place_rollback(
            &state.db,
            &projected,
            &ThreadSyncSnapshot {
                history_mode: None,
                native_turn_ids: Vec::new(),
                title: Some("Rolled back".to_string()),
                preview: Some("First".to_string()),
                raw_status: Some("idle".to_string()),
                active_flags: Vec::new(),
                imported_messages: vec![
                    ImportedThreadMessage {
                        role: "user".to_string(),
                        content: Some("First".to_string()),
                        blocks: json!([{ "type": "text", "content": "First" }]),
                        status: "completed".to_string(),
                        native_turn_id: Some("turn-1".to_string()),
                        turn_engine_id: Some("codex".to_string()),
                        turn_model_id: Some("gpt-5.4".to_string()),
                        turn_reasoning_effort: None,
                        token_input: 1,
                        token_output: 0,
                        created_at: None,
                    },
                    ImportedThreadMessage {
                        role: "assistant".to_string(),
                        content: Some("Codex reply 1".to_string()),
                        blocks: json!([{ "type": "text", "content": "Codex reply 1" }]),
                        status: "completed".to_string(),
                        native_turn_id: Some("turn-1".to_string()),
                        turn_engine_id: Some("codex".to_string()),
                        turn_model_id: Some("gpt-5.4".to_string()),
                        turn_reasoning_effort: None,
                        token_input: 0,
                        token_output: 1,
                        created_at: None,
                    },
                ],
            },
        )
        .expect("expected rollback persistence to succeed");

        let messages =
            db::messages::get_thread_messages(&state.db, &thread.id).expect("expected messages");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content.as_deref(), Some("First"));
        assert_eq!(messages[1].content.as_deref(), Some("Reply 1"));
        assert_eq!(messages[1].native_turn_id, None);
        assert_eq!(
            messages
                .into_iter()
                .map(|message| (message.id, message.created_at, message.content))
                .collect::<Vec<_>>(),
            retained_before
        );
        assert_eq!(updated.id, thread.id);
        assert_eq!(updated.message_count, 2);
        assert_eq!(updated.title, "Rolled back");
        assert!(!is_engine_rollback_pending(
            updated.engine_metadata.as_ref()
        ));
        assert_eq!(
            updated
                .engine_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("codexTranscriptImported")),
            Some(&json!(true))
        );
        assert_eq!(
            updated
                .engine_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("codexPreview")),
            Some(&json!("First"))
        );
    }

    #[test]
    fn clone_codex_branch_metadata_preserves_sync_needed_state() {
        let metadata = clone_codex_branch_metadata(
            Some(&json!({
                "manualTitle": true,
                "manualTitleUpdatedAt": "2026-03-12T00:00:00Z",
                "codexPreview": "old preview",
                "codexThreadStatus": "active",
                "codexThreadActiveFlags": ["waitingOnApproval"],
                "codexSyncRequired": false,
                "codexRemoteTurnActive": true,
                "serviceTier": "fast",
            })),
            "gpt-5.4",
            Some("active"),
            &["waitingOnApproval".to_string()],
            Some("Fresh preview"),
            true,
            Some("branch_thread_requires_sync"),
        );

        assert_eq!(metadata.get("manualTitle"), None);
        assert_eq!(metadata.get("manualTitleUpdatedAt"), None);
        assert_eq!(metadata.get("lastModelId"), Some(&json!("gpt-5.4")));
        assert_eq!(metadata.get("codexPreview"), Some(&json!("Fresh preview")));
        assert_eq!(metadata.get("codexThreadStatus"), Some(&json!("active")));
        assert_eq!(
            metadata.get("codexThreadActiveFlags"),
            Some(&json!(["waitingOnApproval"]))
        );
        assert_eq!(metadata.get("codexSyncRequired"), Some(&json!(true)));
        assert_eq!(
            metadata.get(codex_thread_metadata::REMOTE_TURN_ACTIVE_KEY),
            Some(&json!(false))
        );
        assert_eq!(
            metadata.get("codexSyncReason"),
            Some(&json!("branch_thread_requires_sync"))
        );
        assert_eq!(metadata.get("serviceTier"), Some(&json!("fast")));
    }

    #[tokio::test]
    async fn create_thread_inner_persists_initial_runtime_metadata() {
        let state = test_app_state();
        let workspace = test_workspace(&state);

        let created = create_thread_inner(
            &state,
            workspace.id,
            None,
            "codex".to_string(),
            "gpt-5.4".to_string(),
            "Thread".to_string(),
            Some("HIGH".to_string()),
            Some("FAST".to_string()),
        )
        .await
        .expect("expected thread creation to succeed");

        let metadata = created
            .engine_metadata
            .expect("expected runtime metadata to be stored");
        assert_eq!(metadata.get("reasoningEffort"), Some(&json!("high")));
        assert_eq!(metadata.get("serviceTier"), Some(&json!("fast")));
    }

    #[tokio::test]
    async fn create_thread_inner_rejects_invalid_reasoning_effort() {
        let state = test_app_state();
        let workspace = test_workspace(&state);

        let error = create_thread_inner(
            &state,
            workspace.id,
            None,
            "codex".to_string(),
            "gpt-5.4".to_string(),
            "Thread".to_string(),
            Some("turbo".to_string()),
            None,
        )
        .await
        .expect_err("expected invalid effort to be rejected");

        assert!(error.contains("invalid reasoning effort `turbo`"));
    }

    #[test]
    fn validate_reasoning_effort_for_model_accepts_catalog_provided_future_effort() {
        let supported = vec![ReasoningEffortOptionDto {
            reasoning_effort: "solar".to_string(),
            description: "Preview reasoning mode".to_string(),
        }];

        assert_eq!(
            validate_reasoning_effort_for_model("gpt-preview", &supported, "solar")
                .expect("catalog-provided effort should be accepted"),
            "solar"
        );
    }

    #[test]
    fn validate_known_reasoning_effort_rejects_unknown_without_catalog_match() {
        let error = validate_known_reasoning_effort("solar")
            .expect_err("unknown effort should be rejected without model catalog support");

        assert!(error.contains("invalid reasoning effort `solar`"));
    }

    #[tokio::test]
    async fn set_thread_execution_policy_clears_permission_profile_when_sandbox_changes() {
        let state = test_app_state();
        let thread = test_thread(&state, "codex", "gpt-5.4");

        let profile = json!({
            "type": "managed",
            "fileSystem": {
                "type": "unrestricted"
            },
            "network": {
                "enabled": true
            }
        });
        let updated = set_thread_execution_policy_inner(
            &state,
            thread.id.clone(),
            false,
            None,
            false,
            None,
            false,
            None,
            true,
            Some(profile),
            false,
            None,
        )
        .await
        .expect("expected permission profile update to succeed");
        assert!(updated
            .engine_metadata
            .as_ref()
            .and_then(|value| value.get("permissionProfile"))
            .is_some());

        let updated = set_thread_execution_policy_inner(
            &state,
            thread.id.clone(),
            false,
            None,
            true,
            Some("danger-full-access".to_string()),
            false,
            None,
            false,
            None,
            false,
            None,
        )
        .await
        .expect("expected sandbox update to succeed");
        let metadata = updated
            .engine_metadata
            .expect("expected engine metadata to be present");
        assert_eq!(metadata.get("permissionProfile"), None);
        assert_eq!(
            metadata.get("sandboxMode"),
            Some(&json!("danger-full-access"))
        );
    }

    #[test]
    fn normalize_thread_permission_profile_rejects_incomplete_profiles() {
        let error = normalize_thread_permission_profile(Some(json!({
            "type": "managed",
            "fileSystem": {
                "type": "unrestricted"
            }
        })))
        .expect_err("expected missing network to be rejected");

        assert!(error.contains("network must be an object"));
    }

    #[test]
    fn normalize_thread_approvals_reviewer_rejects_unknown_values() {
        let error = normalize_thread_approvals_reviewer(Some("robot".to_string()))
            .expect_err("expected unknown reviewer to be rejected");

        assert!(error.contains("invalid approvals reviewer `robot`"));
    }

    #[tokio::test]
    async fn set_thread_codex_config_persists_values() {
        let state = test_app_state();
        let thread = test_thread(&state, "codex", "gpt-5.4");

        let updated = set_thread_codex_config_inner(
            &state,
            thread.id.clone(),
            true,
            Some("Friendly".to_string()),
            true,
            Some("FLEX".to_string()),
            true,
            Some(json!({
                "type": "object",
                "properties": {
                    "summary": { "type": "string" }
                }
            })),
        )
        .await
        .expect("expected codex config update to succeed");

        let metadata = updated
            .engine_metadata
            .expect("expected engine metadata to be present");
        assert_eq!(metadata.get("personality"), Some(&json!("friendly")));
        assert_eq!(metadata.get("serviceTier"), Some(&json!("flex")));
        assert_eq!(
            metadata.get("outputSchema"),
            Some(&json!({
                "type": "object",
                "properties": {
                    "summary": { "type": "string" }
                }
            }))
        );
    }

    #[tokio::test]
    async fn set_thread_codex_config_rejects_non_codex_threads() {
        let state = test_app_state();
        let thread = test_thread(&state, "unsupported", "unsupported-model");

        let error = set_thread_codex_config_inner(
            &state,
            thread.id.clone(),
            true,
            Some("friendly".to_string()),
            false,
            None,
            false,
            None,
        )
        .await
        .expect_err("expected non-codex thread to be rejected");

        assert!(error.contains("Codex thread config is only available for Codex threads"));
    }

    #[test]
    fn cached_context_usage_reads_from_engine_metadata() {
        let cached = cached_context_usage_from_metadata(Some(&json!({
            CONTEXT_USAGE_CACHE_METADATA_KEY: {
                "currentTokens": 42000,
                "maxContextTokens": 200000,
                "contextWindowPercent": 84,
                "inputTokens": 34000,
                "cachedInputTokens": 12000,
                "cacheWriteInputTokens": 2000,
                "outputTokens": 8000,
                "reasoningOutputTokens": 3000,
            }
        })))
        .expect("expected cached context usage to deserialize");

        assert_eq!(cached.current_tokens, Some(42000));
        assert_eq!(cached.max_context_tokens, Some(200000));
        assert_eq!(cached.context_window_percent, Some(84));
        assert_eq!(cached.input_tokens, Some(34000));
        assert_eq!(cached.cached_input_tokens, Some(12000));
        assert_eq!(cached.cache_write_input_tokens, Some(2000));
        assert_eq!(cached.output_tokens, Some(8000));
        assert_eq!(cached.reasoning_output_tokens, Some(3000));
    }

    #[test]
    fn merge_cached_context_usage_only_fills_missing_context_fields() {
        let cached = crate::engines::UsageLimitsSnapshot {
            current_tokens: Some(42000),
            max_context_tokens: Some(200000),
            context_window_percent: Some(84),
            input_tokens: Some(34000),
            cached_input_tokens: Some(12000),
            cache_write_input_tokens: Some(2000),
            output_tokens: Some(8000),
            reasoning_output_tokens: Some(3000),
            ..crate::engines::UsageLimitsSnapshot::default()
        };
        let usage = crate::engines::UsageLimitsSnapshot {
            current_tokens: None,
            max_context_tokens: Some(160000),
            context_window_percent: None,
            five_hour_percent: Some(11),
            ..crate::engines::UsageLimitsSnapshot::default()
        };

        let merged = merge_cached_context_usage(Some(usage), &cached);

        assert_eq!(merged.current_tokens, Some(42000));
        assert_eq!(merged.max_context_tokens, Some(160000));
        assert_eq!(merged.context_window_percent, Some(84));
        assert_eq!(merged.input_tokens, Some(34000));
        assert_eq!(merged.cached_input_tokens, Some(12000));
        assert_eq!(merged.cache_write_input_tokens, Some(2000));
        assert_eq!(merged.output_tokens, Some(8000));
        assert_eq!(merged.reasoning_output_tokens, Some(3000));
        assert_eq!(merged.five_hour_percent, Some(11));
    }
}
