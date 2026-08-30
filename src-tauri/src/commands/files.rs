use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
};

#[tauri::command]
pub async fn open_path_with_default_app(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        open_path_with_default_app_impl(PathBuf::from(path)).map_err(err_to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenCommandPlan {
    program: OsString,
    args: Vec<OsString>,
    display_target: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum OpenPlatform {
    Macos,
    Windows,
    Linux,
    Unsupported,
}

fn open_path_with_default_app_impl(path: PathBuf) -> anyhow::Result<()> {
    if !path.exists() {
        anyhow::bail!("path does not exist: {}", path.display());
    }

    let platform = open_platform();
    let (xdg_open, gio) = resolve_linux_openers(platform);

    let Some(plan) = build_open_command_plan(&path, platform, xdg_open, gio)? else {
        return Ok(());
    };

    let mut command = Command::new(&plan.program);
    command.args(&plan.args);
    spawn_open_command(command, &plan.display_target)
}

fn open_platform() -> OpenPlatform {
    #[cfg(target_os = "macos")]
    {
        OpenPlatform::Macos
    }

    #[cfg(target_os = "windows")]
    {
        OpenPlatform::Windows
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        OpenPlatform::Linux
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
    {
        OpenPlatform::Unsupported
    }
}

fn resolve_linux_openers(platform: OpenPlatform) -> (Option<PathBuf>, Option<PathBuf>) {
    if platform == OpenPlatform::Linux {
        (
            crate::runtime_env::resolve_executable("xdg-open"),
            crate::runtime_env::resolve_executable("gio"),
        )
    } else {
        (None, None)
    }
}

fn build_open_command_plan(
    path: &Path,
    platform: OpenPlatform,
    xdg_open: Option<PathBuf>,
    gio: Option<PathBuf>,
) -> anyhow::Result<Option<OpenCommandPlan>> {
    let path_arg = path.as_os_str().to_os_string();

    match platform {
        OpenPlatform::Macos => Ok(Some(OpenCommandPlan {
            program: OsString::from("open"),
            args: vec![path_arg],
            display_target: path.to_path_buf(),
        })),
        OpenPlatform::Windows => Ok(Some(OpenCommandPlan {
            program: OsString::from("cmd"),
            args: vec![
                OsString::from("/C"),
                OsString::from("start"),
                OsString::from(""),
                path_arg,
            ],
            display_target: path.to_path_buf(),
        })),
        OpenPlatform::Linux => {
            if let Some(program) = xdg_open {
                return Ok(Some(OpenCommandPlan {
                    program: program.into_os_string(),
                    args: vec![path.as_os_str().to_os_string()],
                    display_target: path.to_path_buf(),
                }));
            }

            if let Some(program) = gio {
                return Ok(Some(OpenCommandPlan {
                    program: program.into_os_string(),
                    args: vec![OsString::from("open"), path.as_os_str().to_os_string()],
                    display_target: path.to_path_buf(),
                }));
            }

            anyhow::bail!(
                "failed to open {}: neither xdg-open nor gio open is available",
                path.display()
            );
        }
        OpenPlatform::Unsupported => Ok(None),
    }
}

fn spawn_open_command(mut command: Command, path: &Path) -> anyhow::Result<()> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!("failed to open {}: {error}", path.display()))
}

fn err_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, fs, path::PathBuf};

    use super::{build_open_command_plan, OpenPlatform};
    use uuid::Uuid;

    fn with_temp_file<T>(f: impl FnOnce(PathBuf) -> T) -> T {
        let root = std::env::temp_dir().join(format!("panes-open-path-{}", Uuid::new_v4()));
        let file = root.join("file.txt");
        fs::create_dir_all(&root).expect("temp dir should exist");
        fs::write(&file, "hello").expect("temp file should exist");
        let result = f(file);
        let _ = fs::remove_dir_all(&root);
        result
    }

    #[test]
    fn mac_files_use_open_for_default_app() {
        with_temp_file(|file| {
            let plan = build_open_command_plan(&file, OpenPlatform::Macos, None, None)
                .expect("plan should build")
                .expect("plan should exist");

            assert_eq!(plan.program.to_string_lossy(), "open");
            assert_eq!(plan.args, vec![file.as_os_str().to_os_string()]);
            assert_eq!(plan.display_target, file);
        });
    }

    #[test]
    fn windows_files_use_cmd_start_for_default_app() {
        with_temp_file(|file| {
            let plan = build_open_command_plan(&file, OpenPlatform::Windows, None, None)
                .expect("plan should build")
                .expect("plan should exist");

            assert_eq!(plan.program.to_string_lossy(), "cmd");
            assert_eq!(
                plan.args,
                vec![
                    OsString::from("/C"),
                    OsString::from("start"),
                    OsString::from(""),
                    file.as_os_str().to_os_string(),
                ]
            );
            assert_eq!(plan.display_target, file);
        });
    }

    #[test]
    fn linux_prefers_xdg_open_for_default_app() {
        with_temp_file(|file| {
            let plan = build_open_command_plan(
                &file,
                OpenPlatform::Linux,
                Some(PathBuf::from("/usr/bin/xdg-open")),
                Some(PathBuf::from("/usr/bin/gio")),
            )
            .expect("plan should build")
            .expect("plan should exist");

            assert_eq!(plan.program.to_string_lossy(), "/usr/bin/xdg-open");
            assert_eq!(plan.args, vec![file.as_os_str().to_os_string()]);
            assert_eq!(plan.display_target, file);
        });
    }

    #[test]
    fn linux_falls_back_to_gio_for_default_app() {
        with_temp_file(|file| {
            let plan = build_open_command_plan(
                &file,
                OpenPlatform::Linux,
                None,
                Some(PathBuf::from("/usr/bin/gio")),
            )
            .expect("plan should build")
            .expect("plan should exist");

            assert_eq!(plan.program.to_string_lossy(), "/usr/bin/gio");
            assert_eq!(
                plan.args,
                vec![OsString::from("open"), file.as_os_str().to_os_string()]
            );
            assert_eq!(plan.display_target, file);
        });
    }

    #[test]
    fn linux_returns_a_clear_error_without_openers() {
        with_temp_file(|file| {
            let error = build_open_command_plan(&file, OpenPlatform::Linux, None, None)
                .expect_err("missing openers should fail");

            assert!(error
                .to_string()
                .contains("neither xdg-open nor gio open is available"));
        });
    }
}
