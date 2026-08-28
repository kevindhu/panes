use std::{
    collections::HashMap,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::Context;

use crate::{models::{FileTreeEntryDto, FileTreePageDto}, path_utils};

const DEFAULT_PAGE_SIZE: usize = 2_000;
const MAX_PAGE_SIZE: usize = 5_000;
const MAX_SCAN_ENTRIES: usize = 50_000;
const SCAN_TIMEOUT: Duration = Duration::from_secs(2);
const CACHE_TTL: Duration = Duration::from_secs(30);
const EXCLUDED_DIR_NAMES: &[&str] = &[
    ".cache", ".git", ".next", ".nuxt", ".pnpm-store", ".turbo", ".yarn",
    "build", "coverage", "dist", "node_modules", "out", "target",
];

struct CacheEntry {
    entries: Arc<Vec<FileTreeEntryDto>>,
    truncated: bool,
    populated_at: Instant,
}

pub struct FileTreeCache {
    inner: Mutex<HashMap<String, CacheEntry>>,
}

impl FileTreeCache {
    pub fn new() -> Self { Self { inner: Mutex::new(HashMap::new()) } }

    fn get(&self, root_path: &str) -> Option<(Arc<Vec<FileTreeEntryDto>>, bool)> {
        let mut map = self.inner.lock().unwrap();
        map.retain(|_, entry| entry.populated_at.elapsed() < CACHE_TTL);
        let entry = map.get(root_path)?;
        Some((Arc::clone(&entry.entries), entry.truncated))
    }

    fn insert(&self, root_path: &str, entries: Vec<FileTreeEntryDto>, truncated: bool) -> Arc<Vec<FileTreeEntryDto>> {
        let entries = Arc::new(entries);
        self.inner.lock().unwrap().insert(root_path.to_string(), CacheEntry {
            entries: Arc::clone(&entries), truncated, populated_at: Instant::now(),
        });
        entries
    }

    pub fn invalidate_workspace(&self, root_path: &str) { self.inner.lock().unwrap().remove(root_path); }

    pub fn invalidate_containing_path(&self, path: &str) {
        let normalized = path_utils::normalize_windows_path_string(path);
        self.inner.lock().unwrap().retain(|root, _| {
            !path_utils::is_path_within_root(&normalized, root)
                && !path_utils::is_path_within_root(root, &normalized)
        });
    }
}

pub fn get_workspace_file_tree_page(
    root_path: &str,
    offset: usize,
    limit: usize,
    cache: &FileTreeCache,
) -> anyhow::Result<FileTreePageDto> {
    let (entries, truncated) = cached_entries(root_path, cache)?;
    page(&entries, truncated, offset, limit)
}

pub fn search_workspace_files(
    root_path: &str,
    query: &str,
    offset: usize,
    limit: usize,
    cache: &FileTreeCache,
) -> anyhow::Result<FileTreePageDto> {
    let (entries, truncated) = cached_entries(root_path, cache)?;
    let query = query.trim().to_lowercase().replace('\\', "/");
    let mut matches = entries.iter().filter(|entry| !entry.is_dir).filter_map(|entry| {
        let path = entry.path.to_lowercase().replace('\\', "/");
        fuzzy_score(&query, &path).map(|score| (score, entry))
    }).collect::<Vec<_>>();
    matches.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.path.cmp(&right.1.path)));
    let matched = matches.into_iter().map(|(_, entry)| entry.clone()).collect::<Vec<_>>();
    page(&matched, truncated, offset, limit)
}

fn page(entries: &[FileTreeEntryDto], truncated: bool, offset: usize, limit: usize) -> anyhow::Result<FileTreePageDto> {
    let limit = limit.clamp(1, MAX_PAGE_SIZE);
    let total = entries.len();
    let offset = offset.min(total);
    let end = offset.saturating_add(limit).min(total);
    Ok(FileTreePageDto { entries: entries[offset..end].to_vec(), offset, limit, total, has_more: end < total, scan_truncated: truncated })
}

fn cached_entries(root_path: &str, cache: &FileTreeCache) -> anyhow::Result<(Arc<Vec<FileTreeEntryDto>>, bool)> {
    if let Some(hit) = cache.get(root_path) { return Ok(hit); }
    let (entries, truncated) = scan(root_path)?;
    let entries = cache.insert(root_path, entries, truncated);
    Ok((entries, truncated))
}

fn should_skip(name: &OsStr) -> bool {
    EXCLUDED_DIR_NAMES.contains(&name.to_string_lossy().to_ascii_lowercase().as_str())
}

fn scan(root_path: &str) -> anyhow::Result<(Vec<FileTreeEntryDto>, bool)> {
    let root = PathBuf::from(root_path).canonicalize().context("failed to canonicalize file tree root")?;
    let deadline = Instant::now() + SCAN_TIMEOUT;
    let mut entries = Vec::with_capacity(DEFAULT_PAGE_SIZE);
    let mut truncated = false;
    visit(&root, &root, deadline, &mut entries, &mut truncated)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok((entries, truncated))
}

fn visit(root: &Path, current: &Path, deadline: Instant, entries: &mut Vec<FileTreeEntryDto>, truncated: &mut bool) -> anyhow::Result<()> {
    if Instant::now() >= deadline || entries.len() >= MAX_SCAN_ENTRIES { *truncated = true; return Ok(()); }
    for item in fs::read_dir(current).context("failed reading workspace directory")? {
        if *truncated { break; }
        if Instant::now() >= deadline || entries.len() >= MAX_SCAN_ENTRIES { *truncated = true; break; }
        let Ok(item) = item else { continue };
        let path = item.path();
        if path.is_dir() && path.file_name().is_some_and(should_skip) { continue; }
        if path.is_symlink() {
            let Ok(canonical) = path.canonicalize() else { continue };
            if !canonical.starts_with(root) { continue; }
        }
        let relative = path.strip_prefix(root).map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
        let is_dir = path.is_dir();
        entries.push(FileTreeEntryDto { path: relative, is_dir });
        if is_dir { visit(root, &path, deadline, entries, truncated)?; }
    }
    Ok(())
}

fn fuzzy_score(pattern: &str, text: &str) -> Option<i32> {
    if pattern.is_empty() { return Some(0); }
    if text.contains(pattern) { return Some(100 + pattern.len() as i32); }
    let mut chars = pattern.chars();
    let mut next = chars.next()?;
    let mut score = 0;
    for character in text.chars() {
        if character == next {
            score += 1;
            match chars.next() { Some(value) => next = value, None => return Some(score) }
        }
    }
    None
}
