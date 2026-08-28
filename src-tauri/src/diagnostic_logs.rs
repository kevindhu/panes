use std::path::PathBuf;

#[cfg(not(test))]
use chrono::{SecondsFormat, Utc};
#[cfg(not(test))]
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::runtime_env;

#[cfg(not(test))]
const CODEX_EVENT_ROUTING_LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;
#[cfg(not(test))]
const CODEX_EVENT_ROUTING_LOG_MAX_LINES_PER_SECOND: u32 = 50;
#[cfg(not(test))]
const CODEX_EVENT_ROUTING_LOG_MAX_MESSAGE_CHARS: usize = 8 * 1024;

#[cfg(not(test))]
struct CodexEventRoutingLogState {
    window_started_at: Instant,
    lines_in_window: u32,
    suppressed_in_window: u64,
}

#[cfg(not(test))]
impl Default for CodexEventRoutingLogState {
    fn default() -> Self {
        Self {
            window_started_at: Instant::now(),
            lines_in_window: 0,
            suppressed_in_window: 0,
        }
    }
}

#[cfg_attr(test, allow(dead_code))]
pub fn codex_event_routing_log_path() -> PathBuf {
    runtime_env::app_data_dir()
        .join("logs")
        .join("codex-event-routing.log")
}

#[must_use]
pub fn append_codex_event_routing_log(message: &str) -> bool {
    #[cfg(test)]
    {
        let _ = message;
        true
    }

    #[cfg(not(test))]
    {
        append_codex_event_routing_log_inner(message).unwrap_or(false)
    }
}

#[cfg(not(test))]
fn append_codex_event_routing_log_inner(message: &str) -> io::Result<bool> {
    let mut state = codex_event_routing_log_state().lock().map_err(|_| {
        io::Error::new(
            io::ErrorKind::Other,
            "codex event routing log lock poisoned",
        )
    })?;

    let now = Instant::now();
    let suppressed = if now.duration_since(state.window_started_at) >= Duration::from_secs(1) {
        let suppressed = state.suppressed_in_window;
        state.window_started_at = now;
        state.lines_in_window = 0;
        state.suppressed_in_window = 0;
        suppressed
    } else {
        0
    };

    if state.lines_in_window >= CODEX_EVENT_ROUTING_LOG_MAX_LINES_PER_SECOND {
        state.suppressed_in_window = state.suppressed_in_window.saturating_add(1);
        return Ok(false);
    }
    state.lines_in_window += 1;

    let path = codex_event_routing_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let should_truncate = fs::metadata(&path)
        .map(|metadata| metadata.len() >= CODEX_EVENT_ROUTING_LOG_MAX_BYTES)
        .unwrap_or(false);
    let mut file = OpenOptions::new()
        .create(true)
        .append(!should_truncate)
        .write(should_truncate)
        .truncate(should_truncate)
        .open(path)?;

    if should_truncate {
        writeln!(
            file,
            "{timestamp} codex event routing log truncated after reaching {} bytes",
            CODEX_EVENT_ROUTING_LOG_MAX_BYTES
        )?;
    }
    if suppressed > 0 {
        writeln!(
            file,
            "{timestamp} suppressed {suppressed} codex event routing log entries during the previous one-second window"
        )?;
    }

    let message = truncate_chars(message, CODEX_EVENT_ROUTING_LOG_MAX_MESSAGE_CHARS);
    writeln!(file, "{timestamp} {message}")?;
    Ok(true)
}

#[cfg(not(test))]
fn codex_event_routing_log_state() -> &'static Mutex<CodexEventRoutingLogState> {
    static STATE: OnceLock<Mutex<CodexEventRoutingLogState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CodexEventRoutingLogState::default()))
}

#[cfg(not(test))]
fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let mut output = value.chars().take(max_chars).collect::<String>();
    output.push_str("... [diagnostic message truncated]");
    output
}
