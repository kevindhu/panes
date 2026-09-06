mod codex_thread_metadata;
mod commands;
mod config;
mod db;
mod diagnostic_logs;
mod engines;
#[cfg(target_os = "linux")]
mod linux_appimage;
mod linux_webkit;
mod locale;
mod models;
mod path_utils;
mod power;
mod process_utils;
mod runtime_env;
mod state;

// Tauri's generated manifest is normally linked only into application binaries.
// The Windows unit-test harness also needs its Common Controls v6 dependency or
// the process exits before running tests with STATUS_ENTRYPOINT_NOT_FOUND.
#[cfg(all(test, target_os = "windows"))]
#[link(name = "resource", kind = "static")]
extern "C" {}

use std::sync::Arc;

use anyhow::Context;
use rusqlite::OptionalExtension;

use config::app_config::AppConfig;
use db::Database;
use engines::{CodexRuntimeEvent, EngineManager};
#[cfg(target_os = "macos")]
use locale::native_strings;
use models::{
    EngineRuntimeUpdatedDto, MessageStatusDto, RuntimeToastDto, ThreadDto, ThreadStatusDto,
};
use power::KeepAwakeManager;
use state::{AppState, TurnManager};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tauri::image::Image;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{menu::Menu, Emitter, Manager, RunEvent, WebviewWindowBuilder};
pub fn maybe_handle_cli_subcommand() -> anyhow::Result<bool> {
    Ok(false)
}

fn initialize_app_state() -> anyhow::Result<AppState> {
    let db = Database::init().context("failed to initialize database")?;
    match db::threads::reconcile_runtime_state(&db) {
        Ok(report) => {
            if report.messages_marked_interrupted > 0 || report.thread_status_updates > 0 {
                log::info!(
                    "runtime recovery applied: interrupted_messages={}, thread_status_updates={}",
                    report.messages_marked_interrupted,
                    report.thread_status_updates
                );
            }
        }
        Err(error) => {
            log::warn!("runtime recovery failed, continuing startup: {error}");
        }
    }

    let app_config = AppConfig::load_or_create().context("failed to load config")?;
    let keep_awake = Arc::new(KeepAwakeManager::new());
    if let Err(error) = keep_awake.reclaim_stale_helpers() {
        log::warn!("failed to reclaim stale keep awake helper: {error}");
    }
    if app_config.power.keep_awake_enabled {
        if let Err(error) =
            tauri::async_runtime::block_on(keep_awake.enable_with_config(&app_config.power))
        {
            log::warn!("failed to reapply keep awake on startup: {error}");
        }
    }

    let _ = db::workspaces::ensure_default_workspace(&db)
        .context("failed to ensure default workspace")?;

    Ok(AppState {
        db,
        config: Arc::new(app_config),
        engines: Arc::new(EngineManager::new()),
        keep_awake,
        turns: Arc::new(TurnManager::default()),
        pending_forks: Arc::new(crate::state::PendingThreadMutationManager::default()),
        pending_rollbacks: Arc::new(crate::state::PendingThreadMutationManager::default()),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    linux_webkit::apply_webkit_display_workarounds();

    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    let app = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .menu(build_app_menu)
        .setup(|app| {
            // The single-instance plugin is registered before this setup
            // callback, so a duplicate launch exits before touching SQLite.
            let _ = app.manage(initialize_app_state()?);

            let main_window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .or_else(|| app.config().app.windows.first())
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("main window config not found"))?;

            #[cfg(any(target_os = "linux", target_os = "windows"))]
            let main_window_config = {
                let mut main_window_config = main_window_config;
                main_window_config.decorations = false;
                main_window_config
            };

            let main_window = WebviewWindowBuilder::from_config(app.handle(), &main_window_config)?
                .enable_clipboard_access()
                .build()?;
            #[cfg(not(target_os = "linux"))]
            let _ = &main_window;

            #[cfg(target_os = "linux")]
            {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    if let Err(error) = main_window.set_icon(icon) {
                        log::warn!("failed to apply linux window icon: {error}");
                    }
                }
            }

            #[cfg(target_os = "linux")]
            tauri::async_runtime::spawn_blocking(|| {
                match linux_appimage::ensure_appimage_desktop_integration() {
                    Ok(status) => {
                        if !matches!(
                            status,
                            linux_appimage::AppImageIntegrationStatus::SkippedNotAppImage
                        ) {
                            log::info!("linux AppImage desktop integration status: {status:?}");
                        }
                    }
                    Err(error) => {
                        log::warn!("failed to ensure linux AppImage desktop integration: {error}");
                    }
                }
            });

            let handle = app.handle().clone();
            let state = app.state::<AppState>().inner().clone();
            tauri::async_runtime::spawn(run_codex_runtime_bridge(handle.clone(), state.clone()));
            app.on_menu_event(move |_app, event| {
                let id = event.id().as_ref();
                match id {
                    "toggle-sidebar" | "toggle-fullscreen" | "toggle-search" | "zoom-in"
                    | "zoom-out" | "reset-zoom" | "close-window" | "edit-undo" | "edit-redo"
                    | "edit-cut" | "edit-copy" | "edit-paste" | "edit-select-all" => {
                        let _ = handle.emit("menu-action", id);
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::power::get_keep_awake_state,
            commands::power::set_keep_awake_enabled,
            commands::power::get_power_settings,
            commands::power::set_power_settings,
            commands::power::get_helper_status,
            commands::power::register_keep_awake_helper,
            commands::chat::save_pasted_image_attachment,
            commands::chat::cache_embedded_chat_image,
            commands::chat::prepare_attachment_image_asset,
            commands::chat::read_attachment_image_bytes,
            commands::chat::copy_attachment_image_to_clipboard,
            commands::chat::send_message,
            commands::chat::start_codex_review,
            commands::chat::steer_message,
            commands::chat::cancel_turn,
            commands::chat::respond_to_approval,
            commands::chat::get_thread_messages,
            commands::chat::get_thread_messages_window,
            commands::chat::get_message_blocks,
            commands::chat::get_action_output,
            commands::chat::search_messages,
            commands::codex_transcript::get_codex_turn_snapshot,
            commands::workspace::open_workspace,
            commands::workspace::retarget_workspace,
            commands::workspace::list_workspaces,
            commands::workspace::set_workspace_order,
            commands::workspace::list_archived_workspaces,
            commands::workspace::get_repos,
            commands::workspace::set_repo_trust_level,
            commands::workspace::archive_workspace,
            commands::workspace::restore_workspace,
            commands::workspace::delete_workspace,
            commands::app::show_agent_notification,
            commands::files::open_path_with_default_app,
            commands::engines::list_engines,
            commands::engines::engine_health,
            commands::engines::prewarm_engine,
            commands::engines::list_codex_skills,
            commands::engines::list_codex_apps,
            commands::engines::run_engine_check,
            commands::threads::list_threads,
            commands::threads::list_archived_threads,
            commands::threads::list_codex_remote_threads,
            commands::threads::attach_codex_remote_thread,
            commands::threads::create_thread,
            commands::threads::rename_thread,
            commands::threads::confirm_workspace_thread,
            commands::threads::set_thread_reasoning_effort,
            commands::threads::set_thread_execution_policy,
            commands::threads::set_thread_codex_config,
            commands::threads::archive_thread,
            commands::threads::restore_thread,
            commands::threads::sync_thread_from_engine,
            commands::threads::refresh_thread_usage_limits,
            commands::threads::append_branch_profile_log,
            commands::threads::fork_codex_thread,
            commands::threads::fork_codex_thread_at_turn,
            commands::threads::rollback_codex_thread,
            commands::threads::compact_codex_thread,
            commands::threads::delete_thread,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            let keep_awake = app_handle.state::<AppState>().keep_awake.clone();
            tauri::async_runtime::block_on(async move {
                if let Err(error) = keep_awake.shutdown().await {
                    log::warn!("failed to release keep awake on shutdown: {error}");
                }
            });
        }
        _ => {}
    });
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadUpdatedEvent {
    thread_id: String,
    workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread: Option<ThreadDto>,
}

async fn run_codex_runtime_bridge(app: tauri::AppHandle, state: AppState) {
    let mut rx = state.engines.subscribe_codex_runtime_events();
    loop {
        match rx.recv().await {
            Ok(event) => handle_codex_runtime_event(&app, &state, event).await,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                log::warn!("codex runtime bridge lagged and skipped {skipped} events");
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn handle_codex_runtime_event(
    app: &tauri::AppHandle,
    state: &AppState,
    event: CodexRuntimeEvent,
) {
    match event {
        CodexRuntimeEvent::DiagnosticsUpdated { diagnostics, toast } => {
            let _ = app.emit(
                "engine-runtime-updated",
                EngineRuntimeUpdatedDto {
                    engine_id: "codex".to_string(),
                    protocol_diagnostics: Some(diagnostics),
                    toast,
                },
            );
        }
        CodexRuntimeEvent::ApprovalResolved { approval_id } => {
            resolve_codex_runtime_approval(app, state, &approval_id).await;
        }
        CodexRuntimeEvent::ThreadStatusChanged {
            engine_thread_id,
            status_type,
            active_flags,
        } => {
            if let Some(updated_thread) = apply_codex_runtime_thread_update(
                state,
                &engine_thread_id,
                None,
                Some(status_type.as_str()),
                &active_flags,
                None,
                None,
                None,
            )
            .await
            {
                let _ = app.emit(
                    "thread-updated",
                    ThreadUpdatedEvent {
                        thread_id: updated_thread.id.clone(),
                        workspace_id: updated_thread.workspace_id.clone(),
                        thread: Some(updated_thread),
                    },
                );
            }
        }
        CodexRuntimeEvent::ThreadNameUpdated {
            engine_thread_id,
            thread_name,
        } => {
            let normalized_thread_name = thread_name.and_then(|name| {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            });
            let sync_required = if normalized_thread_name.is_some() {
                Some(false)
            } else {
                Some(true)
            };
            let sync_reason = if normalized_thread_name.is_some() {
                None
            } else {
                Some("thread_name_updated")
            };
            if let Some(updated_thread) = apply_codex_runtime_thread_update(
                state,
                &engine_thread_id,
                normalized_thread_name.as_deref(),
                None,
                &[],
                None,
                sync_required,
                sync_reason,
            )
            .await
            {
                let _ = app.emit(
                    "thread-updated",
                    ThreadUpdatedEvent {
                        thread_id: updated_thread.id.clone(),
                        workspace_id: updated_thread.workspace_id.clone(),
                        thread: Some(updated_thread),
                    },
                );
            }
        }
        CodexRuntimeEvent::ThreadSnapshotUpdated {
            engine_thread_id,
            thread_name,
            status_type,
            active_flags,
            preview,
        } => {
            if let Some(updated_thread) = apply_codex_runtime_thread_update(
                state,
                &engine_thread_id,
                thread_name.as_deref(),
                status_type.as_deref(),
                &active_flags,
                preview.as_deref(),
                Some(false),
                None,
            )
            .await
            {
                let _ = app.emit(
                    "thread-updated",
                    ThreadUpdatedEvent {
                        thread_id: updated_thread.id.clone(),
                        workspace_id: updated_thread.workspace_id.clone(),
                        thread: Some(updated_thread),
                    },
                );
            }
        }
        CodexRuntimeEvent::ThreadArchived { engine_thread_id } => {
            if let Some((thread_id, workspace_id)) =
                archive_codex_runtime_thread(state, &engine_thread_id).await
            {
                let _ = app.emit(
                    "thread-updated",
                    ThreadUpdatedEvent {
                        thread_id,
                        workspace_id,
                        thread: None,
                    },
                );
            }
        }
        CodexRuntimeEvent::ThreadUnarchived { engine_thread_id } => {
            if let Some(updated_thread) =
                restore_codex_runtime_thread(state, &engine_thread_id).await
            {
                let _ = app.emit(
                    "thread-updated",
                    ThreadUpdatedEvent {
                        thread_id: updated_thread.id.clone(),
                        workspace_id: updated_thread.workspace_id.clone(),
                        thread: Some(updated_thread),
                    },
                );
            }
        }
        CodexRuntimeEvent::ThreadReverted { engine_thread_id } => {
            let thread = run_db(state.db.clone(), {
                let id = engine_thread_id.clone();
                move |db| db::threads::find_thread_by_engine_thread_id(db, "codex", &id)
            })
            .await
            .ok()
            .flatten();
            if let Some(thread) = thread {
                let _guard = state.pending_rollbacks.lock_history(&thread.id).await;
                let local_ids = run_db(state.db.clone(), {
                    let id = thread.id.clone();
                    move |db| db::messages::thread_native_turn_ids(db, &id)
                })
                .await;
                let remote = state.engines.read_thread_sync_snapshot(&thread).await;
                // Our own revert has already committed under the same lock. Only
                // invalidate the transcript if it actually differs (or cannot be read).
                let matches = match (local_ids, remote) {
                    (Ok(local), Ok(Some(remote))) => local == remote.native_turn_ids,
                    _ => false,
                };
                if !matches {
                    if let Some(updated) = apply_codex_runtime_thread_update(
                        state,
                        &engine_thread_id,
                        None,
                        None,
                        &[],
                        None,
                        Some(true),
                        Some("thread_reverted"),
                    )
                    .await
                    {
                        let _ = app.emit(
                            "thread-updated",
                            ThreadUpdatedEvent {
                                thread_id: updated.id.clone(),
                                workspace_id: updated.workspace_id.clone(),
                                thread: Some(updated),
                            },
                        );
                        let _ = app.emit(
                            "codex-rollback-materialized",
                            serde_json::json!({"threadId": thread.id}),
                        );
                    }
                }
            }
        }
        CodexRuntimeEvent::ThreadCompacted { engine_thread_id } => {
            if let Some(updated_thread) = apply_codex_runtime_thread_update(
                state,
                &engine_thread_id,
                None,
                None,
                &[],
                None,
                Some(true),
                Some("thread_compacted"),
            )
            .await
            {
                let _ = app.emit(
                    "thread-updated",
                    ThreadUpdatedEvent {
                        thread_id: updated_thread.id.clone(),
                        workspace_id: updated_thread.workspace_id.clone(),
                        thread: Some(updated_thread),
                    },
                );
                let _ = app.emit(
                    "engine-runtime-updated",
                    EngineRuntimeUpdatedDto {
                        engine_id: "codex".to_string(),
                        protocol_diagnostics: None,
                        toast: Some(RuntimeToastDto {
                            variant: "info".to_string(),
                            message: "Context compacted".to_string(),
                        }),
                    },
                );
            }
        }
    }
}

async fn resolve_codex_runtime_approval(
    app: &tauri::AppHandle,
    state: &AppState,
    approval_id: &str,
) {
    let Some((thread_id, message_id)) = run_db(state.db.clone(), {
        let approval_id = approval_id.to_string();
        move |db| db::actions::find_approval_context(db, &approval_id)
    })
    .await
    .ok()
    .flatten() else {
        return;
    };

    let has_local_turn = state.turns.get(&thread_id).await.is_some();
    let updated_thread = match run_db(state.db.clone(), {
        let approval_id = approval_id.to_string();
        let thread_id = thread_id.clone();
        let message_id = message_id.clone();
        move |db| {
            let mut conn = db.connect()?;
            let tx = conn
                .transaction()
                .context("failed to start approval resolution transaction")?;

            // Resolve the approval record.
            tx.execute(
                "UPDATE approvals
                 SET status = 'answered', answered_at = COALESCE(answered_at, datetime('now'))
                 WHERE id = ?1",
                rusqlite::params![approval_id],
            )
            .context("failed to resolve approval")?;

            // Update the approval block inside the message's blocks_json (best-effort).
            let raw_blocks: Option<String> = tx
                .query_row(
                    "SELECT blocks_json FROM messages WHERE id = ?1",
                    rusqlite::params![message_id],
                    |row| row.get(0),
                )
                .optional()
                .context("failed to load message blocks for approval update")?;
            if let Some(raw_blocks) = raw_blocks {
                let mut blocks_value: serde_json::Value =
                    serde_json::from_str(&raw_blocks).unwrap_or_else(|_| serde_json::json!([]));
                let changed = if let Some(items) = blocks_value.as_array_mut() {
                    let mut any_changed = false;
                    for block in items.iter_mut() {
                        let Some(object) = block.as_object_mut() else {
                            continue;
                        };
                        if object.get("type").and_then(serde_json::Value::as_str)
                            != Some("approval")
                        {
                            continue;
                        }
                        let bid = object
                            .get("approvalId")
                            .and_then(serde_json::Value::as_str)
                            .or_else(|| {
                                object
                                    .get("approval_id")
                                    .and_then(serde_json::Value::as_str)
                            });
                        if bid != Some(approval_id.as_str()) {
                            continue;
                        }
                        let should_update = object
                            .get("status")
                            .and_then(serde_json::Value::as_str)
                            .map(|v| v != "answered")
                            .unwrap_or(true);
                        if should_update {
                            object.insert(
                                "status".to_string(),
                                serde_json::Value::String("answered".to_string()),
                            );
                            any_changed = true;
                        }
                    }
                    any_changed
                } else {
                    false
                };
                if changed {
                    tx.execute(
                        "UPDATE messages SET blocks_json = ?1 WHERE id = ?2",
                        rusqlite::params![blocks_value.to_string(), message_id],
                    )
                    .context("failed to persist answered approval in message blocks")?;
                }
            }

            let recovered_status = db::threads::derive_thread_status_for_recovery(&tx, &thread_id)?;
            let next_thread_status =
                if has_local_turn && recovered_status != ThreadStatusDto::AwaitingApproval {
                    ThreadStatusDto::Streaming
                } else {
                    recovered_status
                };
            tx.execute(
                "UPDATE threads
                 SET status = ?1, last_activity_at = datetime('now')
                 WHERE id = ?2
                   AND status != ?1",
                rusqlite::params![next_thread_status.as_str(), &thread_id],
            )
            .context("failed to update thread status after runtime approval resolution")?;

            tx.commit()
                .context("failed to commit approval resolution transaction")?;

            db::threads::get_thread(db, &thread_id)
        }
    })
    .await
    {
        Ok(updated_thread) => updated_thread,
        Err(error) => {
            log::warn!("failed to reconcile resolved runtime approval {approval_id}: {error}");
            return;
        }
    };

    let stream_event_topic = format!("stream-event-{thread_id}");
    let _ = app.emit(
        &stream_event_topic,
        serde_json::json!({
            "type": "ApprovalResolved",
            "approval_id": approval_id,
        }),
    );

    if let Some(thread) = updated_thread {
        let _ = app.emit(
            "thread-updated",
            ThreadUpdatedEvent {
                thread_id: thread.id.clone(),
                workspace_id: thread.workspace_id.clone(),
                thread: Some(thread),
            },
        );
    }
}

// This helper mirrors the independent fields supplied by Codex runtime status
// events; keeping them explicit avoids lossy intermediate JSON conversion.
#[allow(clippy::too_many_arguments)]
async fn apply_codex_runtime_thread_update(
    state: &AppState,
    engine_thread_id: &str,
    title: Option<&str>,
    raw_status: Option<&str>,
    active_flags: &[String],
    preview: Option<&str>,
    sync_required: Option<bool>,
    sync_reason: Option<&str>,
) -> Option<ThreadDto> {
    let thread = run_db(state.db.clone(), {
        let engine_thread_id = engine_thread_id.to_string();
        move |db| db::threads::find_thread_by_engine_thread_id(db, "codex", &engine_thread_id)
    })
    .await
    .ok()??;

    let has_local_turn = state.turns.get(&thread.id).await.is_some();
    run_db(state.db.clone(), {
        let thread_id = thread.id.clone();
        let title = title.map(str::to_string);
        let raw_status = raw_status.map(str::to_string);
        let active_flags = active_flags.to_vec();
        let preview = preview.map(str::to_string);
        let sync_reason = sync_reason.map(str::to_string);
        move |db| {
            // Re-read both the thread and its transcript immediately before
            // applying the runtime summary. This avoids merging metadata or
            // status from an earlier snapshot after a turn has just finished.
            let current_thread = db::threads::get_thread(db, &thread_id)?
                .ok_or_else(|| anyhow::anyhow!("thread not found: {thread_id}"))?;
            let latest_assistant =
                db::messages::get_latest_assistant_identity_and_status(db, &thread_id)?;
            let had_confirmed_remote_turn = codex_thread_metadata::has_confirmed_remote_turn(
                current_thread.engine_metadata.as_ref(),
            );
            let status_update = resolve_codex_runtime_status_update(
                raw_status.as_deref(),
                &active_flags,
                has_local_turn,
                latest_assistant.as_ref().map(|(_, status)| status),
                &current_thread.status,
                had_confirmed_remote_turn,
            );
            let effective_sync_required = status_update.sync_required.or(sync_required);
            let effective_sync_reason = if status_update.sync_required.is_some() {
                status_update.sync_reason
            } else {
                sync_reason.as_deref()
            };
            let mut metadata = merge_codex_runtime_metadata(
                current_thread.engine_metadata,
                raw_status.as_deref(),
                &active_flags,
                preview.as_deref(),
                effective_sync_required,
                effective_sync_reason,
            );
            if let Some(active) = status_update.confirmed_remote_turn_active {
                codex_thread_metadata::set_confirmed_remote_turn(&mut metadata, active);
            }
            let updated = db::threads::update_thread_runtime_snapshot(
                db,
                &thread_id,
                title.as_deref(),
                status_update.status,
                Some(&metadata),
            )?;

            // The opposite race is also possible: a newer assistant can start
            // or finish after the summary read but before this write. Runtime
            // data for the previous transcript must not overwrite that newer
            // message's exact state.
            let latest_assistant_after =
                db::messages::get_latest_assistant_identity_and_status(db, &thread_id)?;
            if latest_assistant_after != latest_assistant {
                let Some((_, latest_status)) = latest_assistant_after else {
                    return Ok(updated);
                };
                db::threads::update_thread_status(
                    db,
                    &thread_id,
                    thread_status_from_message_status(&latest_status),
                )?;
                return db::threads::get_thread(db, &thread_id)?.ok_or_else(|| {
                    anyhow::anyhow!(
                        "thread not found after newer transcript reconciliation: {thread_id}"
                    )
                });
            }

            // Close the remaining read/write race: if terminal transcript
            // persistence won while the runtime update was being applied, the
            // single-statement reconciliation restores the terminal status.
            if db::threads::reconcile_stale_running_thread_status_from_transcript(db, &thread_id)? {
                return db::threads::get_thread(db, &thread_id)?.ok_or_else(|| {
                    anyhow::anyhow!("thread not found after transcript reconciliation: {thread_id}")
                });
            }

            Ok(updated)
        }
    })
    .await
    .ok()
}

async fn archive_codex_runtime_thread(
    state: &AppState,
    engine_thread_id: &str,
) -> Option<(String, String)> {
    let thread = run_db(state.db.clone(), {
        let engine_thread_id = engine_thread_id.to_string();
        move |db| db::threads::find_thread_by_engine_thread_id(db, "codex", &engine_thread_id)
    })
    .await
    .ok()??;

    run_db(state.db.clone(), {
        let thread_id = thread.id.clone();
        move |db| match db::threads::archive_thread(db, &thread_id) {
            Ok(()) => Ok(()),
            Err(error) if error.to_string().contains("already archived") => Ok(()),
            Err(error) => Err(error),
        }
    })
    .await
    .ok()?;

    Some((thread.id, thread.workspace_id))
}

async fn restore_codex_runtime_thread(
    state: &AppState,
    engine_thread_id: &str,
) -> Option<ThreadDto> {
    let thread = run_db(state.db.clone(), {
        let engine_thread_id = engine_thread_id.to_string();
        move |db| db::threads::find_thread_by_engine_thread_id(db, "codex", &engine_thread_id)
    })
    .await
    .ok()??;

    run_db(state.db.clone(), {
        let thread_id = thread.id.clone();
        let existing = thread.clone();
        move |db| match db::threads::restore_thread(db, &thread_id) {
            Ok(restored) => Ok(restored),
            Err(error) if error.to_string().contains("not archived") => Ok(existing),
            Err(error) => Err(error),
        }
    })
    .await
    .ok()
}

fn merge_codex_runtime_metadata(
    existing: Option<serde_json::Value>,
    raw_status: Option<&str>,
    active_flags: &[String],
    preview: Option<&str>,
    sync_required: Option<bool>,
    sync_reason: Option<&str>,
) -> serde_json::Value {
    let mut metadata = existing.unwrap_or_else(|| serde_json::json!({}));
    if !metadata.is_object() {
        metadata = serde_json::json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        if raw_status.is_some() {
            match raw_status.map(str::trim).filter(|value| !value.is_empty()) {
                Some(status) => {
                    object.insert("codexThreadStatus".to_string(), serde_json::json!(status));
                }
                None => {
                    object.remove("codexThreadStatus");
                }
            }

            if active_flags.is_empty() {
                object.remove("codexThreadActiveFlags");
            } else {
                object.insert(
                    "codexThreadActiveFlags".to_string(),
                    serde_json::json!(active_flags),
                );
            }
        }

        if preview.is_some() {
            match preview.map(str::trim).filter(|value| !value.is_empty()) {
                Some(preview) => {
                    object.insert("codexPreview".to_string(), serde_json::json!(preview));
                }
                None => {
                    object.remove("codexPreview");
                }
            }
        }

        if let Some(sync_required) = sync_required {
            object.insert(
                "codexSyncRequired".to_string(),
                serde_json::json!(sync_required),
            );
            object.insert(
                "codexSyncUpdatedAt".to_string(),
                serde_json::json!(chrono::Utc::now().to_rfc3339()),
            );
            match sync_reason.map(str::trim).filter(|value| !value.is_empty()) {
                Some(reason) => {
                    object.insert("codexSyncReason".to_string(), serde_json::json!(reason));
                }
                None => {
                    object.insert("codexSyncReason".to_string(), serde_json::Value::Null);
                }
            }
        }
    }

    metadata
}

#[derive(Debug, Default, PartialEq, Eq)]
struct CodexRuntimeStatusUpdate {
    status: Option<ThreadStatusDto>,
    sync_required: Option<bool>,
    sync_reason: Option<&'static str>,
    confirmed_remote_turn_active: Option<bool>,
}

fn thread_status_from_message_status(status: &MessageStatusDto) -> ThreadStatusDto {
    match status {
        MessageStatusDto::Completed => ThreadStatusDto::Completed,
        MessageStatusDto::Interrupted => ThreadStatusDto::Idle,
        MessageStatusDto::Error => ThreadStatusDto::Error,
        MessageStatusDto::Streaming => ThreadStatusDto::Streaming,
    }
}

fn terminal_thread_status_from_message(
    status: Option<&MessageStatusDto>,
) -> Option<ThreadStatusDto> {
    status.and_then(|status| match status {
        MessageStatusDto::Streaming => None,
        status => Some(thread_status_from_message_status(status)),
    })
}

fn resolve_codex_runtime_status_update(
    raw_status: Option<&str>,
    active_flags: &[String],
    has_local_turn: bool,
    latest_assistant_status: Option<&MessageStatusDto>,
    current_thread_status: &ThreadStatusDto,
    had_confirmed_remote_turn: bool,
) -> CodexRuntimeStatusUpdate {
    if has_local_turn {
        return CodexRuntimeStatusUpdate::default();
    }

    let terminal_transcript_status = terminal_thread_status_from_message(latest_assistant_status);
    match raw_status.map(str::trim).filter(|value| !value.is_empty()) {
        Some("systemError") => CodexRuntimeStatusUpdate {
            status: Some(ThreadStatusDto::Error),
            sync_required: Some(false),
            sync_reason: None,
            confirmed_remote_turn_active: Some(false),
        },
        Some("idle") | Some("notLoaded") => {
            if matches!(latest_assistant_status, Some(MessageStatusDto::Streaming)) {
                CodexRuntimeStatusUpdate {
                    status: Some(ThreadStatusDto::Streaming),
                    sync_required: Some(true),
                    sync_reason: Some("runtime_idle_with_open_transcript"),
                    confirmed_remote_turn_active: Some(false),
                }
            } else if had_confirmed_remote_turn {
                CodexRuntimeStatusUpdate {
                    status: terminal_transcript_status.or(Some(ThreadStatusDto::Idle)),
                    sync_required: Some(true),
                    sync_reason: Some("runtime_remote_turn_finished_requires_sync"),
                    confirmed_remote_turn_active: Some(false),
                }
            } else {
                CodexRuntimeStatusUpdate {
                    status: terminal_transcript_status.or(Some(ThreadStatusDto::Idle)),
                    sync_required: Some(false),
                    sync_reason: None,
                    confirmed_remote_turn_active: Some(false),
                }
            }
        }
        Some("active") => {
            let transcript_is_streaming =
                matches!(latest_assistant_status, Some(MessageStatusDto::Streaming));
            let status = if let Some(terminal_status) = terminal_transcript_status {
                // A late generic `active` snapshot must never resurrect a turn
                // whose persisted assistant message is already terminal.
                Some(terminal_status)
            } else if transcript_is_streaming
                && active_flags
                    .iter()
                    .any(|flag| matches!(flag.as_str(), "waitingOnApproval" | "waitingOnUserInput"))
            {
                Some(ThreadStatusDto::AwaitingApproval)
            } else if transcript_is_streaming {
                Some(ThreadStatusDto::Streaming)
            } else {
                // A generic active summary without an open local transcript is
                // only a request to sync. Never preserve an old running row
                // while that remote state is still unverified.
                Some(match current_thread_status {
                    ThreadStatusDto::Streaming | ThreadStatusDto::AwaitingApproval => {
                        ThreadStatusDto::Idle
                    }
                    status => status.clone(),
                })
            };

            CodexRuntimeStatusUpdate {
                status,
                sync_required: Some(true),
                sync_reason: Some("runtime_active_status_requires_sync"),
                // Runtime summaries can preserve a prior full-snapshot
                // confirmation, but cannot establish one on their own.
                confirmed_remote_turn_active: Some(had_confirmed_remote_turn),
            }
        }
        _ => CodexRuntimeStatusUpdate::default(),
    }
}

#[cfg(test)]
// Platform menu construction follows these runtime-status reducer tests.
#[allow(clippy::items_after_test_module)]
mod codex_runtime_status_tests {
    use super::*;

    #[test]
    fn late_active_snapshot_cannot_resurrect_terminal_transcript() {
        let completed = resolve_codex_runtime_status_update(
            Some("active"),
            &[],
            false,
            Some(&MessageStatusDto::Completed),
            &ThreadStatusDto::Streaming,
            false,
        );
        assert_eq!(completed.status, Some(ThreadStatusDto::Completed));
        assert_eq!(completed.sync_required, Some(true));
        assert_eq!(completed.confirmed_remote_turn_active, Some(false));

        let interrupted = resolve_codex_runtime_status_update(
            Some("active"),
            &["waitingOnApproval".to_string()],
            false,
            Some(&MessageStatusDto::Interrupted),
            &ThreadStatusDto::AwaitingApproval,
            false,
        );
        assert_eq!(interrupted.status, Some(ThreadStatusDto::Idle));
        assert_eq!(interrupted.sync_required, Some(true));
    }

    #[test]
    fn active_snapshot_requires_streaming_transcript_evidence_before_showing_progress() {
        let unverified = resolve_codex_runtime_status_update(
            Some("active"),
            &[],
            false,
            None,
            &ThreadStatusDto::Streaming,
            false,
        );
        assert_eq!(unverified.status, Some(ThreadStatusDto::Idle));
        assert_eq!(unverified.sync_required, Some(true));
        assert_eq!(unverified.confirmed_remote_turn_active, Some(false));

        let previously_completed = resolve_codex_runtime_status_update(
            Some("active"),
            &[],
            false,
            None,
            &ThreadStatusDto::Completed,
            false,
        );
        assert_eq!(
            previously_completed.status,
            Some(ThreadStatusDto::Completed)
        );

        let streaming = resolve_codex_runtime_status_update(
            Some("active"),
            &[],
            false,
            Some(&MessageStatusDto::Streaming),
            &ThreadStatusDto::Idle,
            false,
        );
        assert_eq!(streaming.status, Some(ThreadStatusDto::Streaming));

        let awaiting = resolve_codex_runtime_status_update(
            Some("active"),
            &["waitingOnUserInput".to_string()],
            false,
            Some(&MessageStatusDto::Streaming),
            &ThreadStatusDto::Idle,
            false,
        );
        assert_eq!(awaiting.status, Some(ThreadStatusDto::AwaitingApproval));
    }

    #[test]
    fn local_turn_and_idle_runtime_updates_preserve_authoritative_evidence() {
        assert_eq!(
            resolve_codex_runtime_status_update(
                Some("active"),
                &[],
                true,
                Some(&MessageStatusDto::Completed),
                &ThreadStatusDto::Streaming,
                false,
            ),
            CodexRuntimeStatusUpdate::default()
        );

        let completed = resolve_codex_runtime_status_update(
            Some("idle"),
            &[],
            false,
            Some(&MessageStatusDto::Completed),
            &ThreadStatusDto::Streaming,
            false,
        );
        assert_eq!(completed.status, Some(ThreadStatusDto::Completed));
        assert_eq!(completed.sync_required, Some(false));

        let remote_finished = resolve_codex_runtime_status_update(
            Some("idle"),
            &[],
            false,
            Some(&MessageStatusDto::Completed),
            &ThreadStatusDto::Streaming,
            true,
        );
        assert_eq!(remote_finished.status, Some(ThreadStatusDto::Completed));
        assert_eq!(remote_finished.sync_required, Some(true));
        assert_eq!(remote_finished.confirmed_remote_turn_active, Some(false));
        assert_eq!(
            remote_finished.sync_reason,
            Some("runtime_remote_turn_finished_requires_sync")
        );

        let open_transcript = resolve_codex_runtime_status_update(
            Some("idle"),
            &[],
            false,
            Some(&MessageStatusDto::Streaming),
            &ThreadStatusDto::Streaming,
            false,
        );
        assert_eq!(open_transcript.status, Some(ThreadStatusDto::Streaming));
        assert_eq!(open_transcript.sync_required, Some(true));
        assert_eq!(open_transcript.confirmed_remote_turn_active, Some(false));

        let still_active = resolve_codex_runtime_status_update(
            Some("active"),
            &[],
            false,
            None,
            &ThreadStatusDto::Completed,
            true,
        );
        assert_eq!(still_active.confirmed_remote_turn_active, Some(true));
    }
}

async fn run_db<T, F>(db: crate::db::Database, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&crate::db::Database) -> anyhow::Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || operation(&db))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn build_app_menu(handle: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        return Menu::with_items(handle, &[]);
    }

    #[cfg(target_os = "macos")]
    {
        let strings = native_strings();

        let app_menu = SubmenuBuilder::new(handle, strings.app_menu)
            .about(Some(AboutMetadata {
                name: Some("Panes".to_string()),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
                authors: Some(vec!["Wygor Alves".to_string()]),
                comments: Some(strings.about_comments.to_string()),
                copyright: Some("Copyright © 2026 Wygor Alves".to_string()),
                license: Some("MIT".to_string()),
                website: Some("https://github.com/kevindhu/panes".to_string()),
                website_label: Some("GitHub".to_string()),
                icon: match Image::from_bytes(include_bytes!("../icons/128x128@2x.png")) {
                    Ok(img) => Some(img),
                    Err(e) => {
                        log::warn!("failed to load about icon: {e}");
                        None
                    }
                },
                ..Default::default()
            }))
            .separator()
            .item(&PredefinedMenuItem::services(handle, None)?)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        let edit_menu = SubmenuBuilder::new(handle, strings.edit_menu)
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let toggle_sidebar = MenuItem::with_id(
            handle,
            "toggle-sidebar",
            strings.toggle_sidebar,
            true,
            Some("CmdOrCtrl+B"),
        )?;
        let zoom_in = MenuItem::with_id(
            handle,
            "zoom-in",
            strings.zoom_in,
            true,
            Some("CmdOrCtrl+Equal"),
        )?;
        let zoom_out = MenuItem::with_id(
            handle,
            "zoom-out",
            strings.zoom_out,
            true,
            Some("CmdOrCtrl+Minus"),
        )?;
        let reset_zoom = MenuItem::with_id(
            handle,
            "reset-zoom",
            strings.reset_zoom,
            true,
            Some("CmdOrCtrl+0"),
        )?;
        let toggle_fullscreen = MenuItem::with_id(
            handle,
            "toggle-fullscreen",
            strings.toggle_fullscreen,
            true,
            Some("F11"),
        )?;
        let toggle_search = MenuItem::with_id(
            handle,
            "toggle-search",
            strings.search,
            true,
            Some("CmdOrCtrl+Shift+F"),
        )?;
        let view_menu = SubmenuBuilder::new(handle, strings.view_menu)
            .item(&toggle_sidebar)
            .separator()
            .item(&zoom_in)
            .item(&zoom_out)
            .item(&reset_zoom)
            .separator()
            .item(&toggle_fullscreen)
            .separator()
            .item(&toggle_search)
            .build()?;

        let close_window = MenuItem::with_id(
            handle,
            "close-window",
            strings.close,
            true,
            Some("CmdOrCtrl+W"),
        )?;
        let window_menu = SubmenuBuilder::new(handle, strings.window_menu)
            .minimize()
            .item(&PredefinedMenuItem::maximize(handle, None)?)
            .separator()
            .item(&close_window)
            .build()?;

        return Menu::with_items(handle, &[&app_menu, &edit_menu, &view_menu, &window_menu]);
    }

    #[allow(unreachable_code)]
    Menu::with_items(handle, &[])
}
