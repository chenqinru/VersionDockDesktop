//! Keep a development self-update alive when Tauri's source watcher restarts the UI.
//! The worker executes the same update transaction, without starting a Tauri window.
use crate::models::{
    DesktopError, DesktopSettings, RepositoryMeta, SyncAction, SyncResult, VcsKind,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const WORKER_ARGUMENT: &str = "--versiondock-update-worker";

pub(crate) async fn repository_lock(
    config_dir: &Path,
    repo_id: &str,
    token: &CancellationToken,
) -> Result<std::fs::File, DesktopError> {
    use sha2::{Digest, Sha256};
    let directory = config_dir.join("update-locks");
    std::fs::create_dir_all(&directory).map_err(worker_error)?;
    let path = directory.join(format!(
        "{}.lock",
        hex::encode(Sha256::digest(repo_id.as_bytes()))
    ));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(worker_error)?;
    loop {
        if token.is_cancelled() {
            return Err(DesktopError::new(
                "REQUEST_CANCELLED",
                "Operation cancelled",
                true,
            ));
        }
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(error) => return Err(worker_error(error)),
        }
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct UpdateRequest {
    #[serde(default)]
    pub log_context: Option<crate::logger::LogContext>,
    pub config_dir: PathBuf,
    pub repo: RepositoryMeta,
    pub action: SyncAction,
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub force: bool,
    pub settings: DesktopSettings,
}

pub(crate) fn needs_worker(repo: &RepositoryMeta, action: &SyncAction) -> bool {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    cfg!(dev)
        && repo.kind == VcsKind::Git
        && matches!(
            action,
            SyncAction::Pull | SyncAction::PullRebase | SyncAction::PullFfOnly
        )
        && source
            .canonicalize()
            .unwrap_or_else(|_| source.to_path_buf())
            .starts_with(
                Path::new(&repo.root_path)
                    .canonicalize()
                    .unwrap_or_else(|_| PathBuf::from(&repo.root_path)),
            )
}

fn worker_error(error: impl std::fmt::Display) -> DesktopError {
    DesktopError::new("UPDATE_WORKER_FAILED", error.to_string(), true)
}

// Copy the executable out of target/: the watcher may replace it during this update.
// No working-copy files are changed until this worker has successfully started.
pub(crate) fn launch(
    executable: &Path,
    request: &UpdateRequest,
    arguments: &[&str],
) -> Result<(Child, PathBuf), DesktopError> {
    let directory = tempfile::Builder::new()
        .prefix("versiondock-update-")
        .tempdir()
        .map_err(worker_error)?;
    let copied = directory.path().join(if cfg!(windows) {
        "worker.exe"
    } else {
        "worker"
    });
    std::fs::copy(executable, &copied).map_err(worker_error)?;
    let request_file = directory.path().join("request.json");
    std::fs::write(
        &request_file,
        serde_json::to_vec(request).map_err(worker_error)?,
    )
    .map_err(worker_error)?;
    let mut command = Command::new(copied);
    if arguments.is_empty() {
        command.arg(WORKER_ARGUMENT).arg(directory.path());
    }
    #[cfg(test)]
    if !arguments.is_empty() {
        command
            .args(arguments)
            .env("VERSIONDOCK_UPDATE_WORKER_DIR", directory.path());
    }
    command
        .current_dir(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command.spawn().map_err(worker_error)?;
    Ok((child, directory.keep()))
}

pub(crate) async fn wait(
    mut child: Child,
    directory: PathBuf,
    token: &CancellationToken,
) -> Result<SyncResult, DesktopError> {
    let mut cancelled = false;
    let mut log_offset = 0;
    let mut log_error = None;
    loop {
        relay_worker_logs(&directory, &mut log_offset, &mut log_error);
        // Send cancellation once, then wait for the worker's restoration and final result.
        if token.is_cancelled() && !cancelled {
            if let Some(input) = child.stdin.as_mut() {
                let _ = input.write_all(&[1]);
            }
            cancelled = true;
        }
        if let Some(status) = child.try_wait().map_err(worker_error)? {
            relay_worker_logs(&directory, &mut log_offset, &mut log_error);
            let result = std::fs::read(directory.join("result.json"))
                .map_err(|error| {
                    worker_error(format!(
                        "Update worker exited ({status}) without a result: {error}"
                    ))
                })
                .and_then(|bytes| {
                    serde_json::from_slice::<Result<SyncResult, DesktopError>>(&bytes)
                        .map_err(worker_error)
                });
            let _ = std::fs::remove_dir_all(&directory);
            return result?;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// Logging failures must never interrupt cancellation or worktree restoration.
fn relay_worker_logs(directory: &Path, offset: &mut u64, previous_error: &mut Option<String>) {
    let error = forward_worker_logs(directory, offset)
        .err()
        .map(|error| error.message);
    if error != *previous_error {
        if let Some(message) = &error {
            crate::logger::log_entry(
                crate::logger::LogLevel::Warn,
                crate::logger::LogChannel::Core,
                "Update worker log relay is unavailable.",
                Some(message.clone()),
                None,
                None,
            );
        }
        *previous_error = error;
    }
}

fn forward_worker_logs(directory: &Path, offset: &mut u64) -> Result<(), DesktopError> {
    use std::io::{BufRead, Seek, SeekFrom};
    let path = directory.join("logs.jsonl");
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(worker_error(error)),
    };
    let mut reader = std::io::BufReader::new(file);
    reader
        .seek(SeekFrom::Start(*offset))
        .map_err(worker_error)?;
    let mut line = String::new();
    let mut parse_error = None;
    loop {
        line.clear();
        let count = reader.read_line(&mut line).map_err(worker_error)?;
        if count == 0 || !line.ends_with('\n') {
            break;
        }
        // Skip a damaged record so later complete records remain readable.
        *offset += count as u64;
        let entry = match serde_json::from_str::<crate::logger::LogEntry>(&line) {
            Ok(entry) => entry,
            Err(error) => {
                parse_error = Some(worker_error(error));
                continue;
            }
        };
        if let Some(logger) = crate::logger::get_logger() {
            logger.forward(entry);
        }
    }
    parse_error.map_or(Ok(()), Err)
}

pub(crate) async fn execute(
    directory: &Path,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let input = directory.join("request.json");
    let request: UpdateRequest =
        serde_json::from_slice(&std::fs::read(&input).map_err(worker_error)?)
            .map_err(worker_error)?;
    // Settings can contain private configuration; discard the transfer file immediately.
    let _ = std::fs::remove_file(input);
    let logger = crate::logger::init_global_logger(request.config_dir.join("logs"));
    logger.set_relay_path(directory.join("logs.jsonl"));
    let context = request
        .log_context
        .clone()
        .unwrap_or_else(|| crate::logger::LogContext {
            repository_id: Some(request.repo.id.clone()),
            repository_name: Some(request.repo.name.clone()),
            ..Default::default()
        });
    let result = crate::logger::with_log_context(context, async {
        match repository_lock(&request.config_dir, &request.repo.id, token).await {
            Ok(_guard) => {
                Box::pin(crate::vcs::sync_with_worktree_backup(
                    &request.config_dir,
                    &request.repo,
                    request.action,
                    request.remote,
                    request.branch,
                    request.force,
                    &request.settings,
                    token,
                ))
                .await
            }
            Err(error) => Err(error),
        }
    })
    .await;
    // The parent must drain every record before observing worker completion.
    let _ = logger.flush();
    let temporary = directory.join("result.json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec(&result).map_err(worker_error)?,
    )
    .map_err(worker_error)?;
    std::fs::rename(temporary, directory.join("result.json")).map_err(worker_error)?;
    Ok(())
}

pub(crate) fn run_if_worker() -> bool {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new(WORKER_ARGUMENT)) {
        return false;
    }
    let Some(directory) = arguments.next().map(PathBuf::from) else {
        std::process::exit(1);
    };
    if run_worker(&directory).is_err() {
        std::process::exit(1);
    }
    true
}

fn run_worker(directory: &Path) -> Result<(), DesktopError> {
    let token = CancellationToken::new();
    let cancel = token.clone();
    let disconnected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let parent_gone = disconnected.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        // Parent disconnection is a UI restart, not a request to cancel the update.
        // Only an explicit byte cancels; EOF lets the transaction finish and restore.
        match std::io::stdin().read(&mut [0]) {
            Ok(count) if count > 0 => cancel.cancel(),
            _ => parent_gone.store(true, std::sync::atomic::Ordering::Release),
        }
    });
    let result = tauri::async_runtime::block_on(execute(directory, &token));
    if disconnected.load(std::sync::atomic::Ordering::Acquire) {
        let _ = std::fs::remove_dir_all(directory);
    }
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn relay_keeps_partial_records_and_skips_corrupt_lines() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("logs.jsonl");
        let entry = serde_json::json!({"id":"relay-read-test", "timestamp":"2026-10-04T00:00:00Z",
            "level":"info", "channel":"git", "message":"worker record", "details":null,
            "durationMs":null, "exitCode":null, "cwd":null});
        let valid = entry.to_string();
        std::fs::write(&path, format!("invalid json\n{valid}\n{valid}")).unwrap();
        let mut offset = 0;
        assert!(super::forward_worker_logs(directory.path(), &mut offset).is_err());
        assert_eq!(offset as usize, "invalid json\n".len() + valid.len() + 1);
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        super::forward_worker_logs(directory.path(), &mut offset).unwrap();
        assert_eq!(offset, std::fs::metadata(&path).unwrap().len());
    }

    #[tokio::test]
    async fn broken_log_relay_cannot_interrupt_worker_result_waiting() {
        let directory = tempfile::tempdir().unwrap();
        // A directory where the relay file should be forces a read failure.
        std::fs::create_dir(directory.path().join("logs.jsonl")).unwrap();
        let error =
            crate::models::DesktopError::new("REQUEST_CANCELLED", "restoration finished", true);
        let result: Result<crate::models::SyncResult, crate::models::DesktopError> = Err(error);
        std::fs::write(
            directory.path().join("result.json"),
            serde_json::to_vec(&result).unwrap(),
        )
        .unwrap();
        #[cfg(unix)]
        let child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        #[cfg(windows)]
        let child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        let result = super::wait(
            child,
            directory.keep(),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await;
        assert_eq!(result.unwrap_err().code, "REQUEST_CANCELLED");
    }

    #[test]
    #[ignore = "worker subprocess entry invoked by integration tests"]
    fn worker_entry() {
        let directory =
            std::path::PathBuf::from(std::env::var_os("VERSIONDOCK_UPDATE_WORKER_DIR").unwrap());
        super::run_worker(&directory).unwrap();
    }
}
