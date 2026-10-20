//! Open a registered task through Codex's documented desktop launcher.
use crate::models::DesktopError;
use tokio_util::sync::CancellationToken;

pub(super) async fn open(path: &str, token: &CancellationToken) -> Result<(), DesktopError> {
    #[cfg(target_os = "macos")]
    {
        let path = std::fs::canonicalize(path)
            .ok()
            .filter(|path| path.is_dir())
            .ok_or_else(|| super::failure("Task directory is unavailable"))?;
        let application = installed_application()
            .ok_or_else(|| super::failure("Codex desktop app is not installed"))?;
        let executable = launcher(&application).ok_or_else(|| {
            super::failure("Codex CLI is unavailable; copy the task path and open it in Codex.")
        })?;
        run(&executable, &path, token).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, token);
        Err(super::failure(
            "Opening task directories in Codex is currently supported on macOS.",
        ))
    }
}

#[cfg(target_os = "macos")]
fn installed_application() -> Option<std::path::PathBuf> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;
    NSWorkspace::sharedWorkspace()
        .URLForApplicationWithBundleIdentifier(&NSString::from_str("com.openai.codex"))
        .and_then(|url| url.path())
        .map(|path| std::path::PathBuf::from(path.to_string()))
}

#[cfg(target_os = "macos")]
fn launcher(application: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    // Prefer the app's own version; this also works when Finder omits npm from PATH.
    [
        application.join("Contents/Resources/codex-cli/bin/codex"),
        application.join("Contents/Resources/codex"),
        application.join("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
        crate::cli::resolve_executable("codex"),
    ]
    .into_iter()
    .find(|candidate| {
        candidate
            .metadata()
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    })
}

#[cfg(target_os = "macos")]
async fn run(
    executable: &std::path::Path,
    directory: &std::path::Path,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    crate::cli::run(
        &executable.to_string_lossy(),
        &["app".into(), directory.to_string_lossy().into_owned()],
        directory,
        None,
        std::time::Duration::from_secs(30),
        token,
    )
    .await
    .map(|_| ())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn prefers_the_installed_apps_bundled_cli() {
        let temporary = tempfile::tempdir().unwrap();
        let executable = temporary
            .path()
            .join("Contents/Resources/codex-cli/bin/codex");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(launcher(temporary.path()), Some(executable));
    }

    #[tokio::test]
    async fn cancelling_the_launcher_stops_its_process_group() {
        let temporary = tempfile::tempdir().unwrap();
        let executable = temporary.path().join("launcher");
        fs::write(&executable, "#!/bin/sh\nsleep 30\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            cancel.cancel();
        });
        let started = std::time::Instant::now();
        assert_eq!(
            run(&executable, temporary.path(), &token)
                .await
                .unwrap_err()
                .code,
            "REQUEST_CANCELLED"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[tokio::test]
    async fn passes_unicode_and_shell_characters_as_a_single_path_without_modifying_sources() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("任务 空格 $(touch INJECTED)");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("source"), "original").unwrap();
        let executable = temporary.path().join("launcher");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > arguments\npwd > working-directory\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        run(&executable, &directory, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("arguments")).unwrap(),
            format!("app\n{}\n", directory.display())
        );
        assert_eq!(
            fs::read_to_string(directory.join("working-directory"))
                .unwrap()
                .trim(),
            fs::canonicalize(&directory).unwrap().to_string_lossy()
        );
        assert_eq!(
            fs::read_to_string(directory.join("source")).unwrap(),
            "original"
        );
        assert!(!directory.join("INJECTED").exists());
    }

    #[tokio::test]
    async fn missing_directory_and_launcher_failure_are_reported() {
        let temporary = tempfile::tempdir().unwrap();
        assert!(open(
            temporary.path().join("missing").to_str().unwrap(),
            &CancellationToken::new()
        )
        .await
        .unwrap_err()
        .message
        .contains("Task directory is unavailable"));
        let executable = temporary.path().join("launcher");
        fs::write(&executable, "#!/bin/sh\necho 'launch failed' >&2\nexit 7\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            run(&executable, temporary.path(), &CancellationToken::new())
                .await
                .is_err()
        );
    }
}
