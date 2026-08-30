use tauri::State;

use crate::{
    db,
    models::{RepoDto, TrustLevelDto, WorkspaceDto},
    state::AppState,
};

const MIN_SCAN_DEPTH: i64 = 0;
const MAX_SCAN_DEPTH: i64 = 12;

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
pub async fn open_workspace(
    state: State<'_, AppState>,
    path: String,
    scan_depth: Option<i64>,
) -> Result<WorkspaceDto, String> {
    let scan_depth = normalize_scan_depth(scan_depth);
    run_db(state.db.clone(), move |db| {
        let workspace = db::workspaces::upsert_workspace(db, &path, scan_depth)?;
        db::repos::reconcile_workspace_repos(
            db,
            &workspace.id,
            std::slice::from_ref(&workspace.root_path),
        )?;
        let _ = db::repos::upsert_repo(
            db,
            &workspace.id,
            &workspace.name,
            &workspace.root_path,
            "",
            true,
        )?;

        Ok(workspace)
    })
    .await
}

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<WorkspaceDto>, String> {
    run_db(state.db.clone(), db::workspaces::list_workspaces).await
}

#[tauri::command]
pub async fn set_workspace_order(
    state: State<'_, AppState>,
    workspace_ids: Vec<String>,
) -> Result<(), String> {
    run_db(state.db.clone(), move |db| {
        db::workspaces::set_workspace_order(db, &workspace_ids)
    })
    .await
}

#[tauri::command]
pub async fn retarget_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<WorkspaceDto, String> {
    run_db(state.db.clone(), move |db| {
        let workspace = db::workspaces::retarget_workspace(db, &workspace_id, &path)?;
        db::repos::reconcile_workspace_repos(
            db,
            &workspace.id,
            std::slice::from_ref(&workspace.root_path),
        )?;
        let _ = db::repos::upsert_repo(
            db,
            &workspace.id,
            &workspace.name,
            &workspace.root_path,
            "",
            true,
        )?;

        Ok(workspace)
    })
    .await
}

#[tauri::command]
pub async fn list_archived_workspaces(
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceDto>, String> {
    run_db(state.db.clone(), db::workspaces::list_archived_workspaces).await
}

#[tauri::command]
pub async fn get_repos(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<RepoDto>, String> {
    run_db(state.db.clone(), move |db| {
        db::repos::get_repos(db, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn set_repo_trust_level(
    state: State<'_, AppState>,
    repo_id: String,
    trust_level: TrustLevelDto,
) -> Result<(), String> {
    run_db(state.db.clone(), move |db| {
        db::repos::set_repo_trust_level(db, &repo_id, trust_level)
    })
    .await
}

#[tauri::command]
pub async fn delete_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), String> {
    run_db(state.db.clone(), move |db| {
        db::workspaces::delete_workspace(db, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn archive_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), String> {
    run_db(state.db.clone(), move |db| {
        db::workspaces::archive_workspace(db, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn restore_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<WorkspaceDto, String> {
    run_db(state.db.clone(), move |db| {
        db::workspaces::restore_workspace(db, &workspace_id)
    })
    .await
}

fn err_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn normalize_scan_depth(value: Option<i64>) -> Option<i64> {
    value.map(|depth| depth.clamp(MIN_SCAN_DEPTH, MAX_SCAN_DEPTH))
}
