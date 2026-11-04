//! Compare working files across a turn, including edits made by shell/MCP tools.
//! The temporary index and object store never change the user's staging area or refs.
use std::{
    path::{Path, PathBuf},
    sync::Once,
    time::Duration,
};

use anyhow::{bail, Context};
use tokio::process::Command;
use uuid::Uuid;

use crate::{process_utils::configure_tokio_command, runtime_env};

/// Older than any realistic turn, so the sweep never touches a live snapshot.
const STALE_STORAGE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Earlier versions kept snapshots directly in the system temp directory.
const LEGACY_TEMP_STORAGE_PREFIX: &str = "panes-turn-diff-";

struct Snapshot {
    root: PathBuf,
    storage: PathBuf,
    objects: PathBuf,
    before: String,
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        // A just-killed Git can hold object files open briefly after termination.
        for attempt in 0..5 {
            match std::fs::remove_dir_all(&self.storage) {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(error) if attempt == 4 => log::warn!(
                    "failed to remove turn diff storage {}: {error}",
                    self.storage.display()
                ),
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    }
}

/// Snapshots live outside the system temp directory: Windows re-tags every file in
/// %TEMP% at each logon, so a leaked object store there slows sign-in.
fn storage_dir() -> PathBuf {
    if cfg!(test) {
        std::env::temp_dir().join("panes-turn-diff-tests")
    } else {
        runtime_env::app_data_dir().join("turn-diff")
    }
}

/// Removes snapshot stores orphaned by crashes or forced exits, once per process.
fn remove_stale_storage() {
    static SWEEP: Once = Once::new();
    SWEEP.call_once(|| {
        tokio::task::spawn_blocking(|| {
            remove_stale_entries(&storage_dir(), "");
            remove_stale_entries(&std::env::temp_dir(), LEGACY_TEMP_STORAGE_PREFIX);
        });
    });
}

fn remove_stale_entries(dir: &Path, prefix: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(prefix) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > STALE_STORAGE_AGE);
        if stale {
            if let Err(error) = std::fs::remove_dir_all(entry.path()) {
                log::warn!(
                    "failed to remove stale turn diff storage {}: {error}",
                    entry.path().display()
                );
            }
        }
    }
}

/// Git for Windows' `cmd\git.exe` and `bin\git.exe` are launchers that run the real
/// binary as a child. Killing a launcher on timeout or cancellation orphans that child,
/// which keeps writing objects into a store this module has already tried to delete.
fn git_executable() -> Option<PathBuf> {
    let resolved = runtime_env::resolve_executable("git")?;
    Some(real_git_for_launcher(&resolved).unwrap_or(resolved))
}

fn real_git_for_launcher(resolved: &Path) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let launcher_dir = resolved.parent()?;
    let is_launcher_dir = launcher_dir
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("cmd") || name.eq_ignore_ascii_case("bin"));
    if !is_launcher_dir {
        return None;
    }
    let install_root = launcher_dir.parent()?;
    ["mingw64", "clangarm64", "mingw32"]
        .iter()
        .map(|prefix| install_root.join(prefix).join("bin").join("git.exe"))
        .find(|candidate| candidate.is_file())
}

async fn git(root: &Path, snapshot: Option<&Snapshot>, args: &[&str]) -> anyhow::Result<String> {
    let mut command = Command::new(git_executable().context("Git not found")?);
    configure_tokio_command(&mut command);
    command
        .current_dir(root)
        .kill_on_drop(true)
        .args([
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            "-c",
            "core.splitIndex=false",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0");
    if let Some(snapshot) = snapshot {
        command
            .env("GIT_INDEX_FILE", snapshot.storage.join("index"))
            .env("GIT_OBJECT_DIRECTORY", snapshot.storage.join("objects"))
            .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &snapshot.objects);
    }
    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .context("turn diff Git operation timed out")??;
    if !output.status.success() {
        bail!(
            "turn diff Git operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8(output.stdout).context("Git returned non-UTF-8 diff data")?)
}

impl Snapshot {
    async fn capture(root: PathBuf) -> anyhow::Result<Self> {
        let objects = git(
            &root,
            None,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects",
            ],
        )
        .await?;
        let index = git(
            &root,
            None,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .await?;
        let mut snapshot = Self {
            root,
            storage: storage_dir().join(Uuid::new_v4().to_string()),
            objects: PathBuf::from(objects.trim()),
            before: String::new(),
        };
        tokio::fs::create_dir_all(snapshot.storage.join("objects")).await?;
        // Retain tracked ignored files and support repositories without a first commit.
        if Path::new(index.trim()).exists() {
            tokio::fs::copy(index.trim(), snapshot.storage.join("index")).await?;
        }
        snapshot.before = snapshot.tree().await?;
        Ok(snapshot)
    }

    async fn tree(&self) -> anyhow::Result<String> {
        git(&self.root, Some(self), &["add", "--all", "--", "."]).await?;
        Ok(git(&self.root, Some(self), &["write-tree"])
            .await?
            .trim()
            .to_owned())
    }

    async fn diff(&self, multiple_repos: bool) -> anyhow::Result<String> {
        let after = self.tree().await?;
        let prefix = if multiple_repos {
            format!("{}/", self.root.to_string_lossy().replace('\\', "/"))
        } else {
            String::new()
        };
        git(
            &self.root,
            Some(self),
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--no-renames",
                &format!("--src-prefix=a/{prefix}"),
                &format!("--dst-prefix=b/{prefix}"),
                &self.before,
                &after,
                "--",
                ".",
            ],
        )
        .await
    }
}

pub(super) struct TurnDiffCapture(Vec<Snapshot>);

impl TurnDiffCapture {
    pub(super) async fn start(paths: &[String]) -> anyhow::Result<Self> {
        remove_stale_storage();
        let mut snapshots = Vec::new();
        for path in paths {
            let root = PathBuf::from(
                git(Path::new(path), None, &["rev-parse", "--show-toplevel"])
                    .await?
                    .trim(),
            );
            if snapshots
                .iter()
                .any(|snapshot: &Snapshot| snapshot.root == root)
            {
                continue;
            }
            snapshots.push(Snapshot::capture(root).await?);
        }
        if snapshots.is_empty() {
            bail!("no Git working directories for turn diff");
        }
        Ok(Self(snapshots))
    }

    pub(super) async fn finish(self) -> anyhow::Result<String> {
        let mut diff = String::new();
        for snapshot in &self.0 {
            diff.push_str(&snapshot.diff(self.0.len() > 1).await?);
        }
        Ok(diff)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Repo(PathBuf);
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    impl Repo {
        async fn new() -> Self {
            let repo =
                Self(std::env::temp_dir().join(format!("panes-turn-diff-test-{}", Uuid::new_v4())));
            tokio::fs::create_dir_all(&repo.0).await.unwrap();
            git(&repo.0, None, &["init"]).await.unwrap();
            git(&repo.0, None, &["config", "core.autocrlf", "false"])
                .await
                .unwrap();
            git(&repo.0, None, &["config", "user.name", "Test"])
                .await
                .unwrap();
            git(
                &repo.0,
                None,
                &["config", "user.email", "test@example.invalid"],
            )
            .await
            .unwrap();
            repo
        }

        fn write(&self, path: &str, content: &str) {
            std::fs::write(self.0.join(path), content).unwrap();
        }
        fn paths(&self) -> Vec<String> {
            vec![self.0.to_str().unwrap().into()]
        }
        async fn commit(&self) {
            git(&self.0, None, &["add", "--all"]).await.unwrap();
            git(
                &self.0,
                None,
                &[
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=",
                    "commit",
                    "-m",
                    "fixture",
                ],
            )
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn shell_edits_exclude_existing_changes_and_preserve_index_refs_and_objects() {
        let repo = Repo::new().await;
        repo.write("edit.txt", "committed\n");
        repo.write("remove.txt", "remove me\n");
        repo.write(".gitignore", "ignored.txt\n");
        repo.commit().await;
        repo.write("edit.txt", "staged\n");
        git(&repo.0, None, &["add", "edit.txt"]).await.unwrap();
        repo.write("edit.txt", "before turn\n");
        repo.write("existing.txt", "already untracked\n");
        repo.write("ignored.txt", "ignored\n");
        let index = std::fs::read(repo.0.join(".git/index")).unwrap();
        let head = git(&repo.0, None, &["rev-parse", "HEAD"]).await.unwrap();
        let objects = git(&repo.0, None, &["count-objects", "-v"]).await.unwrap();
        let capture = TurnDiffCapture::start(&repo.paths()).await.unwrap();
        let storage = capture.0[0].storage.clone();
        repo.write("edit.txt", "after shell edit\n");
        repo.write("new file.txt", "new file\n");
        repo.write("ignored.txt", "still ignored\n");
        std::fs::remove_file(repo.0.join("remove.txt")).unwrap();
        let diff = capture.finish().await.unwrap();
        assert!(diff.contains("-before turn\n+after shell edit"), "{diff}");
        assert!(diff.contains("+new file"));
        assert!(diff.contains("-remove me"));
        assert!(!diff.contains("staged") && !diff.contains("committed"));
        assert!(!diff.contains("existing.txt") && !diff.contains("ignored.txt"));
        assert_eq!(std::fs::read(repo.0.join(".git/index")).unwrap(), index);
        assert_eq!(
            git(&repo.0, None, &["rev-parse", "HEAD"]).await.unwrap(),
            head
        );
        assert_eq!(
            git(&repo.0, None, &["count-objects", "-v"]).await.unwrap(),
            objects
        );
        assert!(!storage.exists());
    }

    #[tokio::test]
    async fn captures_committed_edits_and_next_turn_has_an_independent_baseline() {
        let repo = Repo::new().await;
        repo.write("main.txt", "original\n");
        repo.commit().await;
        let capture = TurnDiffCapture::start(&repo.paths()).await.unwrap();
        repo.write("main.txt", "committed during turn\n");
        repo.commit().await;
        let diff = capture.finish().await.unwrap();
        assert!(diff.contains("-original\n+committed during turn"));
        let capture = TurnDiffCapture::start(&repo.paths()).await.unwrap();
        repo.write("main.txt", "temporary\n");
        repo.write("main.txt", "committed during turn\n");
        assert_eq!(capture.finish().await.unwrap(), "");
    }

    #[tokio::test]
    async fn captures_unborn_repositories_and_deduplicates_roots() {
        let repo = Repo::new().await;
        repo.write("before.txt", "already present\n");
        let mut paths = repo.paths();
        paths.extend(repo.paths());
        let capture = TurnDiffCapture::start(&paths).await.unwrap();
        assert_eq!(capture.0.len(), 1);
        repo.write("before.txt", "changed\n");
        assert!(capture
            .finish()
            .await
            .unwrap()
            .contains("-already present\n+changed"));
        assert!(!repo.0.join(".git/index").exists());
    }

    #[tokio::test]
    async fn captures_each_workspace_repository() {
        let first = Repo::new().await;
        let second = Repo::new().await;
        first.write("main.txt", "first\n");
        second.write("main.txt", "second\n");
        let mut paths = first.paths();
        paths.extend(second.paths());
        let capture = TurnDiffCapture::start(&paths).await.unwrap();
        first.write("main.txt", "first updated\n");
        second.write("main.txt", "second updated\n");
        let diff = capture.finish().await.unwrap();
        assert!(diff.contains("-first\n+first updated"));
        assert!(diff.contains("-second\n+second updated"));
    }

    fn make_stale(path: &Path) {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_WRITE_ATTRIBUTES on a directory handle (FILE_FLAG_BACKUP_SEMANTICS).
            options.access_mode(0x100).custom_flags(0x0200_0000);
        }
        options
            .open(path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - STALE_STORAGE_AGE * 2)
            .unwrap();
    }

    #[test]
    fn sweep_removes_only_stale_prefixed_storage() {
        let dir = Repo(std::env::temp_dir().join(format!("panes-sweep-test-{}", Uuid::new_v4())));
        let stale = dir.0.join("panes-turn-diff-stale");
        let fresh = dir.0.join("panes-turn-diff-fresh");
        let unrelated = dir.0.join("unrelated");
        for path in [&stale, &fresh, &unrelated] {
            std::fs::create_dir_all(path.join("objects")).unwrap();
            std::fs::write(path.join("objects").join("blob"), "x").unwrap();
        }
        make_stale(&stale);
        make_stale(&unrelated);
        remove_stale_entries(&dir.0, LEGACY_TEMP_STORAGE_PREFIX);
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn launcher_resolves_to_real_git_on_windows() {
        let install =
            Repo(std::env::temp_dir().join(format!("panes-git-layout-{}", Uuid::new_v4())));
        let launcher = install.0.join("cmd").join("git.exe");
        let real = install.0.join("mingw64").join("bin").join("git.exe");
        for path in [&launcher, &real] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        if cfg!(windows) {
            assert_eq!(real_git_for_launcher(&launcher), Some(real.clone()));
        } else {
            assert_eq!(real_git_for_launcher(&launcher), None);
        }
        assert_eq!(real_git_for_launcher(&real), None);
    }
}
