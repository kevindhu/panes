use std::{
    ffi::c_void,
    io,
    os::windows::io::{FromRawHandle, OwnedHandle},
};

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn GetProcessTimes(
        process: *mut c_void,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
}

/// Read process identity directly instead of starting PowerShell and WMI on
/// every application launch, even when keep-awake is disabled.
pub(super) fn read_process_start_marker(pid: u32) -> io::Result<Option<String>> {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const ERROR_INVALID_PARAMETER: i32 = 87;
    // SAFETY: OpenProcess has no pointer inputs; the returned handle is owned.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER) {
            Ok(None) // The PID no longer exists.
        } else {
            Err(error) // An inaccessible process must not be treated as dead.
        };
    }
    // SAFETY: handle is a valid owned process handle; RAII closes it on all paths.
    let _owned = unsafe { OwnedHandle::from_raw_handle(handle) };
    let (mut creation, mut exit, mut kernel, mut user) = (
        FileTime::default(),
        FileTime::default(),
        FileTime::default(),
        FileTime::default(),
    );
    // SAFETY: the handle stays open and all four outputs are valid FILETIMEs.
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // FILETIME counts 100ns intervals since 1601. Match the precision of legacy
    // CIM CreationDate values so persisted helper identities survive upgrades.
    let ticks = ((creation.high as u64) << 32) | creation.low as u64;
    let unix_micros = (ticks / 10) as i64 - 11_644_473_600_000_000;
    let created = chrono::DateTime::from_timestamp_micros(unix_micros)
        .ok_or_else(|| io::Error::other("invalid Windows process creation time"))?;
    Ok(Some(
        created.to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_process_identity_is_stable_and_matches_legacy_cim_timestamps() {
        let pid = std::process::id();
        let first = read_process_start_marker(pid).unwrap().unwrap();
        assert_eq!(
            read_process_start_marker(pid).unwrap().as_deref(),
            Some(first.as_str())
        );
        let created = chrono::DateTime::parse_from_rfc3339(&first).unwrap();
        assert!(created <= chrono::Utc::now());
        let legacy = super::super::read_windows_process_property(pid, "CreationDate", true)
            .unwrap()
            .expect("current process should be visible to CIM");
        assert!(super::super::start_markers_match(&legacy, &first));
        let reused_pid = (created + chrono::Duration::microseconds(1)).to_rfc3339();
        assert!(!super::super::start_markers_match(&reused_pid, &first));
    }

    #[test]
    fn nonexistent_process_has_no_identity() {
        assert_eq!(read_process_start_marker(u32::MAX).unwrap(), None);
    }
}
