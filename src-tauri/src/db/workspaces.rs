use std::path::Path;

use anyhow::Context;
use rusqlite::{params, OptionalExtension};
use uuid::Uuid;

use crate::models::WorkspaceDto;
use crate::path_utils;
use crate::runtime_env;

use super::Database;

const DEFAULT_SCAN_DEPTH: i64 = 3;

pub fn upsert_workspace(
    db: &Database,
    root_path: &str,
    scan_depth: Option<i64>,
) -> anyhow::Result<WorkspaceDto> {
    let conn = db.connect()?;
    let canonical_path = path_utils::canonicalize_path(Path::new(root_path))
        .unwrap_or_else(|_| path_utils::normalize_windows_path(Path::new(root_path).to_path_buf()));
    let canonical = canonical_path.to_string_lossy().to_string();
    let legacy_canonical = path_utils::legacy_windows_verbatim_path(&canonical_path)
        .filter(|legacy| legacy != &canonical);

    let existing = if let Some(id) = find_workspace_id_by_root(&conn, &canonical)? {
        Some(id)
    } else if let Some(legacy_canonical) = legacy_canonical.as_deref() {
        find_workspace_id_by_root(&conn, legacy_canonical)?
    } else {
        None
    };

    if let Some(id) = existing {
        let top_sort_order = next_workspace_top_sort_order(&conn)?;
        conn.execute(
            "UPDATE workspaces
       SET root_path = ?2,
           last_opened_at = datetime('now'),
           scan_depth = COALESCE(?3, scan_depth),
           sort_order = CASE
               WHEN archived_at IS NOT NULL THEN ?4
               ELSE sort_order
           END,
           archived_at = NULL
       WHERE id = ?1",
            params![id, canonical, scan_depth, top_sort_order],
        )
        .context("failed to update workspace last_opened_at")?;
    } else {
        let id = Uuid::new_v4().to_string();
        let name = workspace_name_from_path(&canonical);
        let scan_depth = scan_depth.unwrap_or(DEFAULT_SCAN_DEPTH);
        let sort_order = next_workspace_top_sort_order(&conn)?;
        conn.execute(
            "INSERT INTO workspaces (id, name, root_path, scan_depth, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, canonical, scan_depth, sort_order],
        )
        .context("failed to insert workspace")?;
    }

    get_workspace_by_root(&conn, &canonical)
}

pub fn retarget_workspace(
    db: &Database,
    workspace_id: &str,
    root_path: &str,
) -> anyhow::Result<WorkspaceDto> {
    let canonical_path = path_utils::canonicalize_path(Path::new(root_path))
        .with_context(|| format!("failed to resolve workspace directory '{root_path}'"))?;
    if !canonical_path.is_dir() {
        anyhow::bail!("workspace path is not a directory: {root_path}");
    }

    let canonical = canonical_path.to_string_lossy().to_string();
    let legacy_canonical = path_utils::legacy_windows_verbatim_path(&canonical_path)
        .filter(|legacy| legacy != &canonical);
    let mut conn = db.connect()?;

    let existing = if let Some(id) = find_workspace_id_by_root(&conn, &canonical)? {
        Some(id)
    } else if let Some(legacy_canonical) = legacy_canonical.as_deref() {
        find_workspace_id_by_root(&conn, legacy_canonical)?
    } else {
        None
    };

    if existing.as_deref().is_some_and(|id| id != workspace_id) {
        anyhow::bail!("directory is already used by another workspace: {canonical}");
    }

    let previous_root = conn
        .query_row(
            "SELECT root_path FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("failed to load current workspace directory")?
        .ok_or_else(|| anyhow::anyhow!("workspace not found: {workspace_id}"))?;

    let tx = conn
        .transaction()
        .context("failed to start workspace directory transaction")?;
    let affected = tx
        .execute(
            "UPDATE workspaces
             SET root_path = ?2,
                 last_opened_at = datetime('now')
             WHERE id = ?1",
            params![workspace_id, canonical],
        )
        .context("failed to update workspace directory")?;

    if affected == 0 {
        anyhow::bail!("workspace not found: {workspace_id}");
    }

    let repo_paths = {
        let mut stmt = tx
            .prepare("SELECT id, path FROM repos WHERE workspace_id = ?1")
            .context("failed to prepare workspace repository paths")?;
        let rows = stmt
            .query_map(params![workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .context("failed to load workspace repository paths")?;
        let mut paths = Vec::new();
        for row in rows {
            paths.push(row.context("failed to decode workspace repository path")?);
        }
        paths
    };

    for (repo_id, repo_path) in repo_paths {
        let Ok(relative_path) = Path::new(&repo_path).strip_prefix(Path::new(&previous_root))
        else {
            continue;
        };
        let rebased_path = if relative_path.as_os_str().is_empty() {
            canonical.clone()
        } else {
            path_utils::normalize_windows_path(canonical_path.join(relative_path))
                .to_string_lossy()
                .to_string()
        };
        tx.execute(
            "UPDATE repos SET path = ?2 WHERE id = ?1",
            params![repo_id, rebased_path],
        )
        .context("failed to retarget workspace repository path")?;
    }

    tx.commit()
        .context("failed to commit workspace directory update")?;

    get_workspace_by_id(&conn, workspace_id)
}

pub fn list_workspaces(db: &Database) -> anyhow::Result<Vec<WorkspaceDto>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, root_path, scan_depth, created_at, last_opened_at
     FROM workspaces
     WHERE archived_at IS NULL
     ORDER BY sort_order ASC, last_opened_at DESC, id ASC",
    )?;

    let rows = stmt.query_map([], map_workspace_row)?;
    let mut out = Vec::new();

    for item in rows {
        out.push(item?);
    }

    Ok(out)
}

pub fn list_archived_workspaces(db: &Database) -> anyhow::Result<Vec<WorkspaceDto>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, root_path, scan_depth, created_at, last_opened_at
     FROM workspaces
     WHERE archived_at IS NOT NULL
     ORDER BY archived_at DESC",
    )?;

    let rows = stmt.query_map([], map_workspace_row)?;
    let mut out = Vec::new();

    for item in rows {
        out.push(item?);
    }

    Ok(out)
}

pub fn ensure_default_workspace(db: &Database) -> anyhow::Result<WorkspaceDto> {
    let current_exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let temp_dir = std::env::temp_dir();
    let windows_dir = windows_system_dir();
    if let Some(first) = list_workspaces(db)?.into_iter().find(|workspace| {
        is_viable_workspace_root(
            Path::new(&workspace.root_path),
            current_exe_dir.as_deref(),
            cfg!(target_os = "windows"),
            Some(temp_dir.as_path()),
            windows_dir.as_deref(),
        )
    }) {
        return Ok(first);
    }

    let root = preferred_default_workspace_root();
    let root = root.to_string_lossy().to_string();
    upsert_workspace(db, &root, None)
}

fn preferred_default_workspace_root() -> std::path::PathBuf {
    let cwd = std::env::current_dir().ok();
    let home = runtime_env::home_dir();
    let current_exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let temp_dir = std::env::temp_dir();
    let windows_dir = windows_system_dir();
    preferred_default_workspace_root_for(
        cwd.as_deref(),
        home.as_deref(),
        current_exe_dir.as_deref(),
        cfg!(target_os = "windows"),
        Some(temp_dir.as_path()),
        windows_dir.as_deref(),
    )
}

fn preferred_default_workspace_root_for(
    cwd: Option<&Path>,
    home: Option<&Path>,
    current_exe_dir: Option<&Path>,
    is_windows: bool,
    temp_dir: Option<&Path>,
    windows_dir: Option<&Path>,
) -> std::path::PathBuf {
    cwd.filter(|path| {
        is_viable_workspace_root(path, current_exe_dir, is_windows, temp_dir, windows_dir)
    })
    .or_else(|| {
        home.filter(|path| {
            is_viable_workspace_root(path, current_exe_dir, is_windows, temp_dir, windows_dir)
        })
    })
    .map(Path::to_path_buf)
    .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn is_viable_workspace_root(
    path: &Path,
    current_exe_dir: Option<&Path>,
    is_windows: bool,
    temp_dir: Option<&Path>,
    windows_dir: Option<&Path>,
) -> bool {
    path.is_dir()
        && !is_transient_appimage_mount(path)
        && !is_current_executable_tree(path, current_exe_dir)
        && !is_unsafe_windows_default_root(path, is_windows, temp_dir, windows_dir)
}

fn is_transient_appimage_mount(path: &Path) -> bool {
    let rendered = path.to_string_lossy();
    rendered.starts_with("/tmp/.mount_") || rendered.starts_with("/var/tmp/.mount_")
}

fn is_current_executable_tree(path: &Path, current_exe_dir: Option<&Path>) -> bool {
    current_exe_dir.is_some_and(|dir| path == dir || path.starts_with(dir))
}

fn is_unsafe_windows_default_root(
    path: &Path,
    is_windows: bool,
    temp_dir: Option<&Path>,
    windows_dir: Option<&Path>,
) -> bool {
    if !is_windows {
        return false;
    }

    temp_dir.is_some_and(|dir| path.starts_with(dir))
        || windows_dir.is_some_and(|dir| path.starts_with(dir))
}

fn windows_system_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("WINDIR")
        .or_else(|| std::env::var_os("SystemRoot"))
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
}

pub fn delete_workspace(db: &Database, workspace_id: &str) -> anyhow::Result<()> {
    let conn = db.connect()?;
    let affected = conn
        .execute(
            "DELETE FROM workspaces WHERE id = ?1",
            params![workspace_id],
        )
        .context("failed to delete workspace")?;

    if affected == 0 {
        anyhow::bail!("workspace not found: {workspace_id}");
    }

    Ok(())
}

pub fn archive_workspace(db: &Database, workspace_id: &str) -> anyhow::Result<()> {
    let conn = db.connect()?;
    let affected = conn
        .execute(
            "UPDATE workspaces
       SET archived_at = datetime('now')
       WHERE id = ?1
         AND archived_at IS NULL",
            params![workspace_id],
        )
        .context("failed to archive workspace")?;

    if affected == 0 {
        anyhow::bail!("workspace not found or already archived: {workspace_id}");
    }

    Ok(())
}

pub fn restore_workspace(db: &Database, workspace_id: &str) -> anyhow::Result<WorkspaceDto> {
    let conn = db.connect()?;
    let sort_order = next_workspace_top_sort_order(&conn)?;
    let affected = conn
        .execute(
            "UPDATE workspaces
       SET archived_at = NULL,
           last_opened_at = datetime('now'),
           sort_order = ?2
       WHERE id = ?1
         AND archived_at IS NOT NULL",
            params![workspace_id, sort_order],
        )
        .context("failed to restore workspace")?;

    if affected == 0 {
        anyhow::bail!("workspace not found or not archived: {workspace_id}");
    }

    get_workspace_by_id(&conn, workspace_id)
}

pub fn find_workspace_by_id(
    db: &Database,
    workspace_id: &str,
) -> anyhow::Result<Option<WorkspaceDto>> {
    let conn = db.connect()?;
    get_workspace_by_id_optional(&conn, workspace_id)
}

pub fn set_workspace_order(db: &Database, workspace_ids: &[String]) -> anyhow::Result<()> {
    let mut conn = db.connect()?;
    let mut stmt = conn
        .prepare(
            "SELECT id
             FROM workspaces
             WHERE archived_at IS NULL
             ORDER BY sort_order ASC, last_opened_at DESC, id ASC",
        )
        .context("failed to load active workspace ids")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut active_ids = Vec::new();
    for row in rows {
        active_ids.push(row?);
    }
    drop(stmt);

    let active_id_set = active_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut seen = std::collections::HashSet::<&str>::new();

    for workspace_id in workspace_ids {
        if !seen.insert(workspace_id.as_str()) {
            anyhow::bail!("workspace order contains a duplicate workspace: {workspace_id}");
        }
        if !active_id_set.contains(workspace_id.as_str()) {
            anyhow::bail!("workspace is not active: {workspace_id}");
        }
    }

    let provided_id_set = workspace_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut ordered_ids = workspace_ids.to_vec();
    ordered_ids.extend(
        active_ids
            .into_iter()
            .filter(|workspace_id| !provided_id_set.contains(workspace_id.as_str())),
    );

    let tx = conn
        .transaction()
        .context("failed to start workspace order transaction")?;
    for (index, workspace_id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE workspaces
             SET sort_order = ?1
             WHERE id = ?2
               AND archived_at IS NULL",
            params![index as i64, workspace_id],
        )
        .context("failed to persist workspace sort order")?;
    }
    tx.commit()
        .context("failed to commit workspace sort order")?;

    Ok(())
}

fn get_workspace_by_root(
    conn: &rusqlite::Connection,
    root_path: &str,
) -> anyhow::Result<WorkspaceDto> {
    conn.query_row(
        "SELECT id, name, root_path, scan_depth, created_at, last_opened_at
     FROM workspaces
     WHERE root_path = ?1",
        params![root_path],
        map_workspace_row,
    )
    .context("failed to load workspace by root")
}

fn find_workspace_id_by_root(
    conn: &rusqlite::Connection,
    root_path: &str,
) -> anyhow::Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM workspaces WHERE root_path = ?1",
        params![root_path],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .context("failed to query workspace")
}

fn get_workspace_by_id(
    conn: &rusqlite::Connection,
    workspace_id: &str,
) -> anyhow::Result<WorkspaceDto> {
    get_workspace_by_id_optional(conn, workspace_id)?
        .ok_or_else(|| anyhow::anyhow!("workspace not found: {workspace_id}"))
}

fn get_workspace_by_id_optional(
    conn: &rusqlite::Connection,
    workspace_id: &str,
) -> anyhow::Result<Option<WorkspaceDto>> {
    conn.query_row(
        "SELECT id, name, root_path, scan_depth, created_at, last_opened_at
     FROM workspaces
     WHERE id = ?1",
        params![workspace_id],
        map_workspace_row,
    )
    .optional()
    .context("failed to load workspace by id")
}

fn next_workspace_top_sort_order(conn: &rusqlite::Connection) -> anyhow::Result<i64> {
    let current_min = conn
        .query_row(
            "SELECT MIN(sort_order)
             FROM workspaces
             WHERE archived_at IS NULL",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .context("failed to compute workspace sort order")?;

    Ok(current_min.unwrap_or(1024).saturating_sub(1024))
}

fn workspace_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".to_string())
}

fn map_workspace_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceDto> {
    let root_path = path_utils::normalize_windows_path_string(&row.get::<_, String>(2)?);
    Ok(WorkspaceDto {
        id: row.get(0)?,
        name: row.get(1)?,
        root_path,
        scan_depth: row.get(3)?,
        created_at: row.get(4)?,
        last_opened_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{Arc, Mutex},
    };

    use uuid::Uuid;

    use crate::db::{ConnectionPool, SQLITE_POOL_MAX_IDLE};

    use super::*;

    fn test_db() -> Database {
        let path = std::env::temp_dir().join(format!("panes-workspaces-{}.db", Uuid::new_v4()));
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

    #[test]
    fn upsert_workspace_preserves_existing_scan_depth_when_none_is_provided() {
        let db = test_db();
        let root = std::env::temp_dir().join(format!("panes-workspace-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("failed to create temp workspace root");
        let root = root.to_string_lossy().to_string();

        let created = upsert_workspace(&db, &root, Some(7)).expect("failed to create workspace");
        let reopened =
            upsert_workspace(&db, &root, None).expect("failed to reopen workspace without depth");

        assert_eq!(created.id, reopened.id);
        assert_eq!(reopened.scan_depth, 7);
    }

    #[test]
    fn retarget_workspace_preserves_identity_and_settings() {
        let db = test_db();
        let old_root = std::env::temp_dir().join(format!("panes-workspace-old-{}", Uuid::new_v4()));
        let new_root = std::env::temp_dir().join(format!("panes-workspace-new-{}", Uuid::new_v4()));
        fs::create_dir_all(&old_root).expect("failed to create old workspace root");
        fs::create_dir_all(&new_root).expect("failed to create new workspace root");

        let created = upsert_workspace(&db, old_root.to_string_lossy().as_ref(), Some(7))
            .expect("failed to create workspace");
        let repo = crate::db::repos::upsert_repo(
            &db,
            &created.id,
            "repo",
            old_root.to_string_lossy().as_ref(),
            "main",
            true,
        )
        .expect("failed to create workspace repo");
        crate::db::repos::set_repo_trust_level(
            &db,
            &repo.id,
            crate::models::TrustLevelDto::Trusted,
        )
        .expect("failed to set repo trust");

        let updated = retarget_workspace(&db, &created.id, new_root.to_string_lossy().as_ref())
            .expect("failed to retarget workspace");

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, created.name);
        assert_eq!(updated.scan_depth, 7);
        assert_eq!(
            updated.root_path,
            path_utils::canonicalize_path(&new_root)
                .expect("failed to canonicalize new root")
                .to_string_lossy()
        );
        let repos =
            crate::db::repos::get_repos(&db, &created.id).expect("failed to read retargeted repos");
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].id, repo.id);
        assert_eq!(repos[0].path, updated.root_path);
        assert_eq!(repos[0].trust_level, crate::models::TrustLevelDto::Trusted);
    }

    #[test]
    fn retarget_workspace_rejects_a_directory_used_by_another_workspace() {
        let db = test_db();
        let root_a = std::env::temp_dir().join(format!("panes-workspace-a-{}", Uuid::new_v4()));
        let root_b = std::env::temp_dir().join(format!("panes-workspace-b-{}", Uuid::new_v4()));
        fs::create_dir_all(&root_a).expect("failed to create workspace a root");
        fs::create_dir_all(&root_b).expect("failed to create workspace b root");

        let workspace_a =
            upsert_workspace(&db, root_a.to_string_lossy().as_ref(), None).expect("create a");
        upsert_workspace(&db, root_b.to_string_lossy().as_ref(), None).expect("create b");

        let error = retarget_workspace(&db, &workspace_a.id, root_b.to_string_lossy().as_ref())
            .expect_err("duplicate directory should fail");
        assert!(error
            .to_string()
            .contains("directory is already used by another workspace"));
    }

    #[test]
    fn list_workspaces_uses_persisted_manual_order() {
        let db = test_db();
        let root_a = std::env::temp_dir().join(format!("panes-workspace-a-{}", Uuid::new_v4()));
        let root_b = std::env::temp_dir().join(format!("panes-workspace-b-{}", Uuid::new_v4()));
        let root_c = std::env::temp_dir().join(format!("panes-workspace-c-{}", Uuid::new_v4()));
        fs::create_dir_all(&root_a).expect("failed to create temp workspace root");
        fs::create_dir_all(&root_b).expect("failed to create temp workspace root");
        fs::create_dir_all(&root_c).expect("failed to create temp workspace root");

        let workspace_a =
            upsert_workspace(&db, root_a.to_string_lossy().as_ref(), None).expect("create a");
        let workspace_b =
            upsert_workspace(&db, root_b.to_string_lossy().as_ref(), None).expect("create b");
        let workspace_c =
            upsert_workspace(&db, root_c.to_string_lossy().as_ref(), None).expect("create c");

        set_workspace_order(
            &db,
            &[
                workspace_a.id.clone(),
                workspace_c.id.clone(),
                workspace_b.id.clone(),
            ],
        )
        .expect("persist workspace order");

        let listed = list_workspaces(&db).expect("list workspaces");
        let ids = listed
            .into_iter()
            .map(|workspace| workspace.id)
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![workspace_a.id, workspace_c.id, workspace_b.id]);
    }

    #[test]
    fn set_workspace_order_accepts_visible_subset_and_preserves_extra_active_rows() {
        let db = test_db();
        let root_a = std::env::temp_dir().join(format!("panes-workspace-a-{}", Uuid::new_v4()));
        let root_b = std::env::temp_dir().join(format!("panes-workspace-b-{}", Uuid::new_v4()));
        let root_c = std::env::temp_dir().join(format!("panes-workspace-c-{}", Uuid::new_v4()));
        fs::create_dir_all(&root_a).expect("failed to create temp workspace root");
        fs::create_dir_all(&root_b).expect("failed to create temp workspace root");
        fs::create_dir_all(&root_c).expect("failed to create temp workspace root");

        let workspace_a =
            upsert_workspace(&db, root_a.to_string_lossy().as_ref(), None).expect("create a");
        let workspace_b =
            upsert_workspace(&db, root_b.to_string_lossy().as_ref(), None).expect("create b");
        let workspace_c =
            upsert_workspace(&db, root_c.to_string_lossy().as_ref(), None).expect("create c");

        set_workspace_order(&db, &[workspace_b.id.clone(), workspace_a.id.clone()])
            .expect("partial visible order should persist");

        let ids = list_workspaces(&db)
            .expect("list workspaces")
            .into_iter()
            .map(|workspace| workspace.id)
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![workspace_b.id, workspace_a.id, workspace_c.id]);
    }

    #[test]
    fn set_workspace_order_rejects_duplicate_and_inactive_ids() {
        let db = test_db();
        let root_a = std::env::temp_dir().join(format!("panes-workspace-a-{}", Uuid::new_v4()));
        let root_b = std::env::temp_dir().join(format!("panes-workspace-b-{}", Uuid::new_v4()));
        fs::create_dir_all(&root_a).expect("failed to create temp workspace root");
        fs::create_dir_all(&root_b).expect("failed to create temp workspace root");

        let workspace_a =
            upsert_workspace(&db, root_a.to_string_lossy().as_ref(), None).expect("create a");
        let workspace_b =
            upsert_workspace(&db, root_b.to_string_lossy().as_ref(), None).expect("create b");
        archive_workspace(&db, &workspace_b.id).expect("archive b");

        let duplicate_error =
            set_workspace_order(&db, &[workspace_a.id.clone(), workspace_a.id.clone()])
                .expect_err("duplicate order should fail");
        assert!(duplicate_error
            .to_string()
            .contains("workspace order contains a duplicate workspace"));

        let inactive_error = set_workspace_order(&db, std::slice::from_ref(&workspace_b.id))
            .expect_err("inactive order should fail");
        assert!(inactive_error
            .to_string()
            .contains("workspace is not active"));
    }

    #[test]
    fn new_and_restored_workspaces_appear_at_top_without_moving_existing_reopens() {
        let db = test_db();
        let root_a = std::env::temp_dir().join(format!("panes-workspace-a-{}", Uuid::new_v4()));
        let root_b = std::env::temp_dir().join(format!("panes-workspace-b-{}", Uuid::new_v4()));
        let root_c = std::env::temp_dir().join(format!("panes-workspace-c-{}", Uuid::new_v4()));
        fs::create_dir_all(&root_a).expect("failed to create temp workspace root");
        fs::create_dir_all(&root_b).expect("failed to create temp workspace root");
        fs::create_dir_all(&root_c).expect("failed to create temp workspace root");

        let workspace_a =
            upsert_workspace(&db, root_a.to_string_lossy().as_ref(), None).expect("create a");
        let workspace_b =
            upsert_workspace(&db, root_b.to_string_lossy().as_ref(), None).expect("create b");
        set_workspace_order(&db, &[workspace_a.id.clone(), workspace_b.id.clone()])
            .expect("persist workspace order");

        let reopened_a =
            upsert_workspace(&db, root_a.to_string_lossy().as_ref(), None).expect("reopen a");
        assert_eq!(reopened_a.id, workspace_a.id);
        let ids_after_reopen = list_workspaces(&db)
            .expect("list workspaces")
            .into_iter()
            .map(|workspace| workspace.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ids_after_reopen,
            vec![workspace_a.id.clone(), workspace_b.id.clone()]
        );

        let workspace_c =
            upsert_workspace(&db, root_c.to_string_lossy().as_ref(), None).expect("create c");
        let ids_after_new = list_workspaces(&db)
            .expect("list workspaces")
            .into_iter()
            .map(|workspace| workspace.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ids_after_new,
            vec![
                workspace_c.id.clone(),
                workspace_a.id.clone(),
                workspace_b.id.clone()
            ]
        );

        archive_workspace(&db, &workspace_a.id).expect("archive a");
        restore_workspace(&db, &workspace_a.id).expect("restore a");
        let ids_after_restore = list_workspaces(&db)
            .expect("list workspaces")
            .into_iter()
            .map(|workspace| workspace.id)
            .collect::<Vec<_>>();
        assert_eq!(ids_after_restore.first(), Some(&workspace_a.id));
    }

    #[test]
    fn preferred_default_workspace_root_skips_transient_appimage_mounts() {
        let home = std::env::temp_dir().join(format!("panes-home-{}", Uuid::new_v4()));
        fs::create_dir_all(&home).expect("failed to create temp home");

        let cwd = std::path::Path::new("/tmp/.mount_PanesTest/usr");
        let selected =
            preferred_default_workspace_root_for(Some(cwd), Some(&home), None, false, None, None);

        assert_eq!(selected, home);
    }

    #[test]
    fn preferred_default_workspace_root_keeps_existing_directory_cwd() {
        let cwd = std::env::temp_dir().join(format!("panes-cwd-{}", Uuid::new_v4()));
        let home = std::env::temp_dir().join(format!("panes-home-{}", Uuid::new_v4()));
        fs::create_dir_all(&cwd).expect("failed to create temp cwd");
        fs::create_dir_all(&home).expect("failed to create temp home");

        let selected =
            preferred_default_workspace_root_for(Some(&cwd), Some(&home), None, false, None, None);

        assert_eq!(selected, cwd);
    }

    #[test]
    fn preferred_default_workspace_root_skips_current_executable_directory() {
        let cwd = std::env::temp_dir().join(format!("panes-install-{}", Uuid::new_v4()));
        let home = std::env::temp_dir().join(format!("panes-home-{}", Uuid::new_v4()));
        fs::create_dir_all(&cwd).expect("failed to create temp install root");
        fs::create_dir_all(&home).expect("failed to create temp home");

        let selected = preferred_default_workspace_root_for(
            Some(&cwd),
            Some(&home),
            Some(&cwd),
            false,
            None,
            None,
        );

        assert_eq!(selected, home);
    }

    #[test]
    fn preferred_default_workspace_root_keeps_windows_home_when_executable_is_nested_inside_it() {
        let home = std::env::temp_dir()
            .join(format!("panes-home-{}", Uuid::new_v4()))
            .join("Users")
            .join("panes");
        let install_dir = home.join("AppData").join("Local").join("Panes");
        fs::create_dir_all(&install_dir).expect("failed to create fake install dir");
        fs::create_dir_all(&home).expect("failed to create temp home");

        let selected = preferred_default_workspace_root_for(
            Some(&install_dir),
            Some(&home),
            Some(&install_dir),
            true,
            None,
            None,
        );

        assert_eq!(selected, home);
    }

    #[test]
    fn preferred_default_workspace_root_skips_windows_system_dirs() {
        let windows_dir =
            std::env::temp_dir().join(format!("panes-windows-dir-{}", Uuid::new_v4()));
        let home = std::env::temp_dir().join(format!("panes-home-{}", Uuid::new_v4()));
        let cwd = windows_dir.join("System32");
        fs::create_dir_all(&cwd).expect("failed to create fake windows cwd");
        fs::create_dir_all(&home).expect("failed to create temp home");

        let selected = preferred_default_workspace_root_for(
            Some(&cwd),
            Some(&home),
            None,
            true,
            None,
            Some(&windows_dir),
        );

        assert_eq!(selected, home);
    }

    #[test]
    fn preferred_default_workspace_root_skips_windows_temp_dirs() {
        let temp_dir = std::env::temp_dir().join(format!("panes-temp-{}", Uuid::new_v4()));
        let home = std::env::temp_dir().join(format!("panes-home-{}", Uuid::new_v4()));
        let cwd = temp_dir.join("nsis");
        fs::create_dir_all(&cwd).expect("failed to create fake temp cwd");
        fs::create_dir_all(&home).expect("failed to create temp home");

        let selected = preferred_default_workspace_root_for(
            Some(&cwd),
            Some(&home),
            None,
            true,
            Some(&temp_dir),
            None,
        );

        assert_eq!(selected, home);
    }
}
