use std::path::PathBuf;

#[cfg(not(test))]
use chrono::{SecondsFormat, Utc};
#[cfg(not(test))]
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    sync::{Mutex, OnceLock},
};

use crate::runtime_env;

#[cfg_attr(test, allow(dead_code))]
pub fn codex_event_routing_log_path() -> PathBuf {
    runtime_env::app_data_dir()
        .join("logs")
        .join("codex-event-routing.log")
}

pub fn append_codex_event_routing_log(message: &str) {
    #[cfg(test)]
    let _ = message;

    #[cfg(not(test))]
    let _ = append_codex_event_routing_log_inner(message);
}

#[cfg(not(test))]
fn append_codex_event_routing_log_inner(message: &str) -> io::Result<()> {
    let _guard = codex_event_routing_log_lock().lock().map_err(|_| {
        io::Error::new(
            io::ErrorKind::Other,
            "codex event routing log lock poisoned",
        )
    })?;
    let path = codex_event_routing_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{timestamp} {message}")?;
    Ok(())
}

#[cfg(not(test))]
fn codex_event_routing_log_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
