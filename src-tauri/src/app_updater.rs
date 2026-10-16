use std::time::Duration;

use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let env = app.env();
        let binary = tauri::process::current_binary(&env).map_err(|error| error.to_string())?;
        if let Some(bundle) = macos_app_bundle(&binary) {
            let args = env.args_os.iter().skip(1).cloned().collect::<Vec<_>>();
            // Keep Launch Services activation, but let the old instance exit before
            // opening the same bundle. Do not force a simultaneous instance (-n).
            let _helper = start_macos_restart_helper(macos_restart_command(
                std::process::id(),
                std::path::Path::new("/usr/bin/open"),
                std::path::Path::new("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"),
                bundle,
                &args,
            ))
            .await?;
            crate::logger::log_entry(
                crate::logger::LogLevel::Info,
                crate::logger::LogChannel::Core,
                "Restarting macOS application after current process exits",
                Some(format!(
                    "version={} pid={} bundle={} method=launch-services-after-exit",
                    app.package_info().version,
                    std::process::id(),
                    bundle.display()
                )),
                None,
                None,
            );
            app.exit(0);
            return Ok(());
        }
    }
    // Unbundled development binaries and other platforms keep Tauri's restart.
    app.request_restart();
    Ok(())
}

#[cfg(target_os = "macos")]
const MACOS_RESTART_SCRIPT: &str = r#"
parent_pid=$1
opener=$2
registrar=$3
bundle=$4
shift 4
printf 'ready\n'
exec 1>/dev/null
attempt=0
while /bin/kill -0 "$parent_pid" 2>/dev/null; do
    attempt=$((attempt + 1))
    # If shutdown stalls, leave the running app alone instead of duplicating it.
    if [ "$attempt" -ge 300 ]; then exit 1; fi
    /bin/sleep 0.1
done
# Replacing the bundle changes its file identity. Refresh Launch Services for
# this exact app path before asking it to activate the installed version.
if [ -x "$registrar" ]; then "$registrar" -f "$bundle" >/dev/null 2>&1; fi
exec "$opener" "$bundle" --args "$@"
"#;

#[cfg(target_os = "macos")]
fn macos_restart_command(
    parent_pid: u32,
    opener: &std::path::Path,
    registrar: &std::path::Path,
    bundle: &std::path::Path,
    args: &[std::ffi::OsString],
) -> tokio::process::Command {
    use std::process::Stdio;

    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(MACOS_RESTART_SCRIPT)
        .arg("versiondock-restart")
        .arg(parent_pid.to_string())
        .arg(opener)
        .arg(registrar)
        .arg(bundle)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    command
}

#[cfg(target_os = "macos")]
async fn start_macos_restart_helper(
    mut command: tokio::process::Command,
) -> Result<tokio::process::Child, String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to restart application: {error}"))?;
    let mut ready = String::new();
    let stdout = child.stdout.take().expect("restart helper stdout is piped");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        BufReader::new(stdout).read_line(&mut ready),
    )
    .await;
    if !matches!(result, Ok(Ok(_))) || ready != "ready\n" {
        let _ = child.kill().await;
        return Err("Unable to start application restart helper".into());
    }
    // The helper has its own process group and no app-owned stdio. Dropping the
    // Child must leave it alive to observe this process terminating.
    Ok(child)
}

#[cfg(target_os = "macos")]
fn macos_app_bundle(binary: &std::path::Path) -> Option<&std::path::Path> {
    let macos = binary.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then_some(bundle)
}

#[cfg(all(test, target_os = "macos"))]
mod restart_tests {
    use super::{macos_app_bundle, macos_restart_command, start_macos_restart_helper};
    use std::{ffi::OsString, os::unix::fs::PermissionsExt, path::Path, time::Duration};

    #[test]
    fn restart_resolves_the_bundle_with_spaces_and_unicode() {
        let binary =
            Path::new("/Applications/版本工具 VersionDock.app/Contents/MacOS/versiondock-desktop");
        assert_eq!(
            macos_app_bundle(binary),
            Some(Path::new("/Applications/版本工具 VersionDock.app"))
        );
        assert!(macos_app_bundle(Path::new("/tmp/target/debug/versiondock-desktop")).is_none());
        assert!(macos_app_bundle(Path::new(
            "/tmp/VersionDock.app/Other/MacOS/versiondock-desktop"
        ))
        .is_none());
    }

    #[tokio::test]
    async fn restart_helper_survives_drop_and_opens_only_after_old_process_exits() {
        let directory = tempfile::tempdir().unwrap();
        let opener = directory.path().join("fake opener");
        let recorded_args = directory.path().join("args");
        std::fs::write(
            &opener,
            "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$VD_RESTART_ARGS_FILE\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&opener, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bundle = directory.path().join("VersionDock's $literal 版本.app");
        let args = [
            OsString::from("--project"),
            OsString::from("a ' \" $()\n树"),
        ];
        let mut old_process = tokio::process::Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let registrar = directory.path().join("fake registrar");
        let registered_args = directory.path().join("registered");
        std::fs::write(
            &registrar,
            "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$VD_RESTART_REGISTER_FILE\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&registrar, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = macos_restart_command(
            old_process.id().unwrap(),
            &opener,
            &registrar,
            &bundle,
            &args,
        );
        command.env("VD_RESTART_ARGS_FILE", &recorded_args);
        command.env("VD_RESTART_REGISTER_FILE", &registered_args);
        let helper = start_macos_restart_helper(command).await.unwrap();
        let helper_pid = helper.id().unwrap();
        // The real caller also drops this handle as it exits.
        drop(helper);
        assert_eq!(
            unsafe { libc::getpgid(helper_pid as i32) },
            helper_pid as i32
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!recorded_args.exists());
        assert!(!registered_args.exists());
        old_process.kill().await.unwrap();
        let captured = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(bytes) = std::fs::read(&recorded_args) {
                    if bytes.ends_with(&[0]) {
                        break bytes;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let actual: Vec<_> = captured[..captured.len() - 1]
            .split(|byte| *byte == 0)
            .map(|bytes| String::from_utf8(bytes.to_vec()).unwrap())
            .collect();
        assert_eq!(
            actual,
            [
                bundle.to_string_lossy().into_owned(),
                "--args".into(),
                "--project".into(),
                "a ' \" $()\n树".into(),
            ]
        );
        assert_eq!(
            std::fs::read(registered_args).unwrap(),
            format!("-f\0{}\0", bundle.display()).into_bytes()
        );
    }

    #[tokio::test]
    async fn restart_helper_reports_failure_before_app_exit() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "exit 1"])
            .stdout(std::process::Stdio::piped());
        assert!(start_macos_restart_helper(command).await.is_err());
        let command = tokio::process::Command::new("/nonexistent/versiondock-restart-helper");
        assert!(start_macos_restart_helper(command).await.is_err());
    }
}

// Select only configured mirrors. No URL or publishing credential comes from
// the webview, and installation still uses the official signature verifier.
#[tauri::command]
pub async fn check_update_mirror(
    webview: tauri::Webview,
) -> Result<Option<serde_json::Value>, String> {
    let config: tauri_plugin_updater::Config = serde_json::from_value(
        webview
            .config()
            .plugins
            .0
            .get("updater")
            .cloned()
            .ok_or("Updater configuration is missing")?,
    )
    .map_err(|error| error.to_string())?;
    let endpoints = config.endpoints.into_iter().skip(1).collect::<Vec<_>>();
    if endpoints.is_empty() {
        return Ok(None);
    }
    let update = webview
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(15))
        .header("Cache-Control", "no-cache")
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| {
        let metadata = serde_json::json!({
            "currentVersion": update.current_version,
            "version": update.version,
            "date": update.raw_json.get("pub_date"),
            "body": update.body,
            "rawJson": update.raw_json,
        });
        let rid = webview.resources_table().add(update);
        let mut metadata = metadata;
        metadata["rid"] = serde_json::json!(rid);
        metadata
    }))
}
