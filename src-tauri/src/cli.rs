use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

use crate::models::DesktopError;

pub const MAX_OUTPUT_BYTES: usize = 20 * 1024 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
}

impl CommandOutput {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

pub fn resolve_executable(program: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        use std::path::PathBuf;
        let exe_name = if program.ends_with(".exe") {
            program.to_string()
        } else {
            format!("{program}.exe")
        };
        if let Ok(output) = std::process::Command::new(program)
            .arg("--version")
            .output()
        {
            if output.status.success() {
                return PathBuf::from(program);
            }
        }

        let fallback_dirs = [
            r"C:\Program Files\SlikSvn\bin",
            r"C:\Program Files (x86)\SlikSvn\bin",
            r"C:\Program Files\TortoiseSVN\bin",
            r"C:\Program Files (x86)\TortoiseSVN\bin",
            r"C:\Program Files\VisualSVN\bin",
            r"C:\Program Files (x86)\VisualSVN\bin",
            r"C:\ProgramData\chocolatey\bin",
            r"C:\ProgramData\chocolatey\lib\svn\tools",
        ];

        for dir in fallback_dirs {
            let candidate = PathBuf::from(dir).join(&exe_name);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    std::path::PathBuf::from(program)
}

pub async fn run(
    program: &str,
    args: &[String],
    cwd: &Path,
    stdin: Option<&[u8]>,
    timeout: Duration,
    cancellation: &CancellationToken,
) -> Result<CommandOutput, DesktopError> {
    run_with_env(program, args, cwd, stdin, timeout, cancellation, &[]).await
}

pub async fn run_with_env(
    program: &str,
    args: &[String],
    cwd: &Path,
    stdin: Option<&[u8]>,
    timeout: Duration,
    cancellation: &CancellationToken,
    secret_env: &[(String, String)],
) -> Result<CommandOutput, DesktopError> {
    let git_write = is_git_program(program) && !is_read_only_command(program, args);
    if git_write {
        wait_for_git_index_lock(cwd, cancellation).await?;
    }
    for attempt in 0..=2 {
        match run_once(program, args, cwd, stdin, timeout, cancellation, secret_env).await {
            Err(error) if git_write && attempt < 2 && is_git_index_lock_error(&error) => {
                wait_for_git_index_lock(cwd, cancellation).await?;
            }
            result => return result,
        }
    }
    unreachable!("Git index-lock retry loop always returns")
}

// Isolated Git indexes and ref/object-only commands do not use the current worktree index.
// Keep normal process handling, but avoid waiting on or cleaning a different client's index lock.
pub(crate) async fn run_with_isolated_git_index(
    args: &[String],
    cwd: &Path,
    stdin: Option<&[u8]>,
    timeout: Duration,
    cancellation: &CancellationToken,
    env: &[(String, String)],
) -> Result<CommandOutput, DesktopError> {
    run_once("git", args, cwd, stdin, timeout, cancellation, env).await
}

async fn run_once(
    program: &str,
    args: &[String],
    cwd: &Path,
    stdin: Option<&[u8]>,
    timeout: Duration,
    cancellation: &CancellationToken,
    secret_env: &[(String, String)],
) -> Result<CommandOutput, DesktopError> {
    let start_time = std::time::Instant::now();
    let channel = if program.contains("svn") {
        crate::logger::LogChannel::Svn
    } else {
        crate::logger::LogChannel::Git
    };
    let formatted_cmd = format_command_for_log(program, args);

    let resolved = resolve_executable(program);
    let mut command = Command::new(&resolved);
    command
        .args(args)
        .current_dir(cwd)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    command.envs(secret_env.iter().map(|(key, value)| (key, value)));
    if is_git_program(program) {
        // Read-only Git commands must not refresh the index and contend with
        // VersionDock or another Git client for index.lock.
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }

    #[cfg(unix)]
    command.process_group(0);

    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let cwd_str = Some(cwd.to_string_lossy().into_owned());

    let mut child = command.spawn().map_err(|error| {
        let duration_ms = start_time.elapsed().as_millis() as u32;
        crate::logger::log_entry_with_cwd(
            crate::logger::LogLevel::Error,
            channel,
            &formatted_cmd,
            Some(format!("Unable to start {program}: {error}")),
            Some(duration_ms),
            None,
            cwd_str.clone(),
        );
        DesktopError::new(
            "TOOL_START_FAILED",
            format!("Unable to start {program}: {error}"),
            true,
        )
    })?;

    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(input).await.map_err(|error| {
                DesktopError::new("COMMAND_STDIN_FAILED", error.to_string(), true)
            })?;
        }
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        DesktopError::new("COMMAND_PIPE_FAILED", "Unable to capture stdout", true)
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        DesktopError::new("COMMAND_PIPE_FAILED", "Unable to capture stderr", true)
    })?;
    let stdout_task = tokio::spawn(read_capped(stdout));
    let stderr_task = tokio::spawn(read_capped(stderr));

    let status = tokio::select! {
        _ = cancellation.cancelled() => {
            terminate_process_tree(&mut child).await;
            stdout_task.abort();
            stderr_task.abort();
            let duration_ms = start_time.elapsed().as_millis() as u32;
            crate::logger::log_entry_with_cwd(
                crate::logger::LogLevel::Warn,
                channel,
                &formatted_cmd,
                Some("Operation cancelled".to_string()),
                Some(duration_ms),
                None,
                cwd_str.clone(),
            );
            return Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true));
        }
        result = tokio::time::timeout(timeout, child.wait()) => {
            match result {
                Ok(value) => value.map_err(|error| DesktopError::new("COMMAND_IO_FAILED", error.to_string(), true))?,
                Err(_) => {
                    terminate_process_tree(&mut child).await;
                    stdout_task.abort();
                    stderr_task.abort();
                    let duration_ms = start_time.elapsed().as_millis() as u32;
                    crate::logger::log_entry_with_cwd(
                        crate::logger::LogLevel::Error,
                        channel,
                        &formatted_cmd,
                        Some(format!("{program} timed out")),
                        Some(duration_ms),
                        None,
                        cwd_str.clone(),
                    );
                    return Err(DesktopError::new("COMMAND_TIMEOUT", format!("{program} timed out"), true));
                },
            }
        }
    };
    let (stdout, stdout_exceeded) = stdout_task
        .await
        .map_err(|error| DesktopError::new("COMMAND_IO_FAILED", error.to_string(), true))?
        .map_err(|error| DesktopError::new("COMMAND_IO_FAILED", error.to_string(), true))?;
    let (stderr, stderr_exceeded) = stderr_task
        .await
        .map_err(|error| DesktopError::new("COMMAND_IO_FAILED", error.to_string(), true))?
        .map_err(|error| DesktopError::new("COMMAND_IO_FAILED", error.to_string(), true))?;
    if stdout_exceeded || stderr_exceeded {
        return Err(DesktopError::new(
            "OUTPUT_LIMIT_EXCEEDED",
            format!(
                "{program} output exceeded {} MiB",
                MAX_OUTPUT_BYTES / 1024 / 1024
            ),
            true,
        ));
    }

    let result = CommandOutput {
        stdout,
        stderr,
        exit_code: status.code(),
    };
    let duration_ms = start_time.elapsed().as_millis() as u32;
    if !status.success() {
        let stderr = redact(&String::from_utf8_lossy(&result.stderr));
        let (code, hint) = classify_failure(program, &stderr);
        // `git config --get` uses exit 1 with no output for an absent key.
        // Preserve the result for callers' fallback logic without logging it as
        // an operational failure. Malformed config and other failures stay errors.
        let missing_config = is_git_program(program)
            && args.first().is_some_and(|argument| argument == "config")
            && args.iter().any(|argument| argument == "--get")
            && result.exit_code == Some(1)
            && result.stdout.is_empty()
            && result.stderr.is_empty();
        crate::logger::log_entry_with_cwd(
            if missing_config {
                crate::logger::LogLevel::Debug
            } else {
                crate::logger::LogLevel::Error
            },
            channel,
            &formatted_cmd,
            Some(stderr.clone()),
            Some(duration_ms),
            result.exit_code,
            cwd_str.clone(),
        );
        return Err(DesktopError {
            code: code.into(),
            message: stderr
                .lines()
                .next()
                .unwrap_or("Command failed")
                .to_string(),
            command: Some(program.to_string()),
            exit_code: result.exit_code,
            stderr: Some(truncate_text(&stderr, 16 * 1024)),
            recoverable: true,
            operation: None,
            workspace_id: None,
            repository_id: None,
            subject: None,
            hint: hint.map(str::to_string),
            restore_warning: None,
        });
    }
    let level = if is_read_only_command(program, args) {
        crate::logger::LogLevel::Debug
    } else {
        crate::logger::LogLevel::Info
    };
    crate::logger::log_entry_with_cwd(
        level,
        channel,
        &formatted_cmd,
        None,
        Some(duration_ms),
        result.exit_code,
        cwd_str,
    );
    Ok(result)
}

fn is_git_program(program: &str) -> bool {
    Path::new(program)
        .file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("git"))
}

fn resolve_git_dir(cwd: &Path) -> Option<PathBuf> {
    let dot_git = cwd.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let value = std::fs::read_to_string(&dot_git).ok()?;
    let path = value.trim().strip_prefix("gitdir:")?.trim();
    let git_dir = PathBuf::from(path);
    Some(if git_dir.is_absolute() {
        git_dir
    } else {
        cwd.join(git_dir)
    })
}

fn git_index_lock_path(cwd: &Path) -> Option<PathBuf> {
    resolve_git_dir(cwd).map(|directory| directory.join("index.lock"))
}

pub fn unlock_git_index(cwd: &Path) -> Result<(), DesktopError> {
    let path = git_index_lock_path(cwd).ok_or_else(|| {
        DesktopError::new(
            "NOT_A_GIT_REPOSITORY",
            "Git metadata directory was not found",
            false,
        )
    })?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(DesktopError::new(
                "GIT_UNLOCK_FAILED",
                error.to_string(),
                true,
            ))
        }
    };
    if !metadata.file_type().is_file() {
        return Err(DesktopError::new(
            "GIT_UNLOCK_FAILED",
            "Git index lock must be a regular file",
            false,
        ));
    }
    std::fs::remove_file(path)
        .map_err(|error| DesktopError::new("GIT_UNLOCK_FAILED", error.to_string(), true))
}

fn try_remove_stale_index_lock(lock_path: &Path, reason: &str) -> bool {
    match std::fs::remove_file(lock_path) {
        Ok(_) => {
            eprintln!(
                "[VersionDock] Automatically removed {} Git index lock: {}",
                reason,
                lock_path.display()
            );
            true
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
        Err(err) => {
            eprintln!(
                "[VersionDock] Failed to remove Git index lock {}: {}",
                lock_path.display(),
                err
            );
            false
        }
    }
}

async fn wait_for_git_index_lock(
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Result<(), DesktopError> {
    let Some(lock_path) = git_index_lock_path(cwd) else {
        return Ok(());
    };
    if !lock_path.exists() {
        return Ok(());
    }

    let initial_meta = std::fs::metadata(&lock_path).ok();
    let initial_mtime = initial_meta.as_ref().and_then(|m| m.modified().ok());
    let initial_size = initial_meta.as_ref().map(|m| m.len()).unwrap_or(0);

    // Fast path: if the lock file already existed more than 10 seconds ago,
    // verify it is static for 200ms and remove it safely.
    if let Some(mtime) = initial_mtime {
        if let Ok(age) = mtime.elapsed() {
            if age >= Duration::from_secs(10) {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if let Ok(meta) = std::fs::metadata(&lock_path) {
                    if meta.len() == initial_size
                        && meta.modified().ok() == initial_mtime
                        && try_remove_stale_index_lock(
                            &lock_path,
                            &format!("stale ({}s old)", age.as_secs()),
                        )
                    {
                        return Ok(());
                    }
                } else {
                    return Ok(());
                }
            }
        }
    }

    let started = tokio::time::Instant::now();
    let mut delay = Duration::from_millis(50);
    let mut last_mtime = initial_mtime;
    let mut last_size = initial_size;

    while lock_path.exists() {
        if started.elapsed() >= Duration::from_secs(5) {
            if let Ok(final_meta) = std::fs::metadata(&lock_path) {
                let final_mtime = final_meta.modified().ok();
                let final_size = final_meta.len();
                if final_mtime == last_mtime
                    && final_size == last_size
                    && try_remove_stale_index_lock(&lock_path, "abandoned")
                {
                    return Ok(());
                }
            } else {
                return Ok(());
            }
            return Err(DesktopError::new(
                "GIT_INDEX_BUSY",
                format!(
                    "Git index is busy: {}. Retry after the other Git process finishes.",
                    lock_path.display()
                ),
                true,
            ));
        }
        tokio::select! {
            _ = cancellation.cancelled() => {
                return Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true));
            }
            _ = tokio::time::sleep(delay) => {}
        }
        if let Ok(meta) = std::fs::metadata(&lock_path) {
            last_mtime = meta.modified().ok();
            last_size = meta.len();
        } else {
            return Ok(());
        }
        delay = (delay * 2).min(Duration::from_millis(250));
    }
    Ok(())
}

fn is_git_index_lock_error(error: &DesktopError) -> bool {
    let detail = format!(
        "{}\n{}",
        error.message,
        error.stderr.as_deref().unwrap_or_default()
    )
    .to_ascii_lowercase();
    detail.contains("index.lock")
        || detail.contains("unable to create") && detail.contains("index")
        || detail.contains("another git process") && detail.contains("repository")
}

fn is_read_only_command(program: &str, args: &[String]) -> bool {
    let lower_prog = program.to_ascii_lowercase();
    if lower_prog.ends_with("git") {
        let first_cmd = args
            .iter()
            .find(|arg| !arg.starts_with('-') && !arg.contains('='))
            .map(|s| s.as_str());
        match first_cmd {
            Some(
                "status" | "rev-parse" | "check-ref-format" | "for-each-ref" | "rev-list" | "show"
                | "diff" | "log",
            ) => true,
            Some("remote") => !args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "add" | "remove" | "rename" | "set-url" | "prune" | "update"
                )
            }),
            Some("config") => args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "--get" | "--get-all" | "--get-regexp" | "--get-urlmatch" | "--list" | "-l"
                )
            }),
            Some("stash") => args.iter().any(|arg| arg == "list" || arg == "show"),
            Some("worktree") => args.iter().any(|arg| arg == "list"),
            Some("branch" | "tag") => args.iter().any(|arg| {
                arg == "--contains"
                    || arg == "-l"
                    || arg == "--list"
                    || arg == "-a"
                    || arg == "-r"
                    || arg.starts_with("--format")
            }),
            _ => false,
        }
    } else if lower_prog.ends_with("svn") {
        let first_cmd = args
            .iter()
            .find(|arg| !arg.starts_with('-'))
            .map(|s| s.as_str());
        matches!(
            first_cmd,
            Some("status" | "info" | "log" | "diff" | "cat" | "list" | "ls")
        )
    } else {
        false
    }
}

fn escape_control_chars(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\x7f' => {
                out.push_str(&format!("\\x{:02x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

fn format_command_for_log(program: &str, args: &[String]) -> String {
    let mut parts = vec![program.to_string()];
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            parts.push("<redacted>".into());
            skip_next = false;
            continue;
        }
        let lower = arg.to_ascii_lowercase();
        let value = if lower == "--password"
            || lower == "-m"
            || lower == "--message"
            || lower == "--token"
            || lower == "--auth-password"
        {
            skip_next = true;
            arg.clone()
        } else if lower.starts_with("--password=")
            || lower.starts_with("--token=")
            || lower.starts_with("--auth-password=")
            || lower.starts_with("-m=")
            || lower.starts_with("--message=")
        {
            let key = arg.split('=').next().unwrap_or(arg);
            format!("{}=<redacted>", key)
        } else {
            redact(arg)
        };
        let escaped = escape_control_chars(&value);
        if escaped.contains(' ') || escaped.contains('\\') || escaped.contains('"') {
            parts.push(format!("\"{}\"", escaped.replace('"', "\\\"")));
        } else {
            parts.push(escaped);
        }
    }
    parts.join(" ")
}

async fn terminate_process_tree(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // Commands run in an isolated process group, so this also terminates
        // credential helpers and other subprocesses spawned by Git or SVN.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .status()
            .await;
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn classify_failure(program: &str, stderr: &str) -> (&'static str, Option<&'static str>) {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("authentication failed")
        || lower.contains("authorization failed")
        || lower.contains("e170001")
        || lower.contains("e215004")
        || lower.contains("can't get username or password")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
    {
        return (
            if program == "svn" {
                "SVN_AUTH_FAILED"
            } else {
                "GIT_AUTH_FAILED"
            },
            Some("Check the selected account or system credential cache"),
        );
    }
    if lower.contains("certificate")
        && (lower.contains("verification") || lower.contains("issuer") || lower.contains("trust"))
    {
        return (
            "CERTIFICATE_ERROR",
            Some("Review and trust the server certificate with the system client"),
        );
    }
    if lower.contains("out of date") || lower.contains("out-of-date") {
        return (
            "SVN_OUT_OF_DATE",
            Some("Update the working copy and resolve conflicts before retrying"),
        );
    }
    if lower.contains("working copy locked") || lower.contains("is already locked") {
        return (
            "SVN_WORKING_COPY_LOCKED",
            Some("Run SVN cleanup after ensuring no other SVN operation is active"),
        );
    }
    if lower.contains("no upstream") || lower.contains("has no upstream branch") {
        return (
            "UPSTREAM_MISSING",
            Some("Configure an upstream branch before synchronizing"),
        );
    }
    if lower.contains("would be overwritten by checkout")
        || lower.contains("would be overwritten by merge")
        || lower.contains("your local changes to the following files would be overwritten")
        || lower.contains("please commit your changes or stash them")
    {
        return (
            "DIRTY_WORKTREE",
            Some("Commit, stash, carry, or discard local changes before retrying"),
        );
    }
    if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("rejected")
    {
        return (
            "REMOTE_REJECTED",
            Some("Fetch remote changes and review branch divergence before retrying"),
        );
    }
    if lower.contains("could not resolve host")
        || lower.contains("connection timed out")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
    {
        return (
            "NETWORK_ERROR",
            Some("Check network connectivity, proxy settings and the remote URL"),
        );
    }
    ("COMMAND_FAILED", None)
}

async fn read_capped<R: AsyncRead + Unpin>(
    mut reader: R,
) -> Result<(Vec<u8>, bool), std::io::Error> {
    let mut output = Vec::with_capacity(64 * 1024);
    let mut buffer = vec![0_u8; 16 * 1024];
    let mut exceeded = false;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..read.min(remaining)]);
        exceeded |= read > remaining;
    }
    Ok((output, exceeded))
}

fn truncate_text(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &value[..end])
}

pub fn redact(value: &str) -> String {
    value
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("authorization:")
                || lower.contains("proxy-authorization:")
                || lower.contains("bearer ")
                || lower.contains("password=")
                || lower.contains("password:")
                || lower.contains("\"password\"")
                || lower.contains("token=")
                || lower.contains("token:")
                || lower.contains("\"token\"")
                || lower.contains("api_key")
                || lower.contains("apikey")
            {
                "<redacted>".to_string()
            } else {
                let with_url = redact_url_userinfo(line);
                redact_email_and_identities(&with_url)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_email_and_identities(line: &str) -> String {
    if !line.contains('@') && !line.contains("user.name") {
        return line.to_string();
    }
    let mut words = Vec::new();
    for word in line.split(' ') {
        if word.starts_with("user.name=") {
            words.push("user.name=<redacted>");
        } else if word.starts_with("user.email=") {
            words.push("user.email=<redacted-email>");
        } else if word.contains('@') && !word.contains("://") && word.contains('.') {
            let clean = word.trim_matches(|c| {
                c == '<' || c == '>' || c == '"' || c == '\'' || c == ',' || c == ';'
            });
            if clean.contains('@')
                && clean.contains('.')
                && !clean.starts_with('@')
                && !clean.ends_with('@')
            {
                words.push("<redacted-email>");
            } else {
                words.push(word);
            }
        } else {
            words.push(word);
        }
    }
    words.join(" ")
}

fn redact_url_userinfo(value: &str) -> String {
    let mut output = value.to_string();
    let mut offset = 0;
    while let Some(scheme) = output[offset..].find("://").map(|index| offset + index) {
        let authority_start = scheme + 3;
        let authority_end = output[authority_start..]
            .find(|character: char| {
                character == '/'
                    || character == '?'
                    || character == '#'
                    || character.is_whitespace()
                    || matches!(character, '\'' | '"' | ')' | ']')
            })
            .map(|index| authority_start + index)
            .unwrap_or(output.len());
        let authority = &output[authority_start..authority_end];
        if let Some(userinfo_end) = authority.rfind('@') {
            output.replace_range(
                authority_start..authority_start + userinfo_end,
                "<redacted>",
            );
            offset = authority_start + "<redacted>".len() + 1;
        } else {
            offset = authority_end;
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_redacted() {
        let value = redact(
            "ok https://user:secret@example.test/repo\nAuthorization: bearer secret\npassword=hunter2\n{\"token\":\"secret\"}\nAuthor: developer <alice@example.com>\nconfig user.name=Alice user.email=alice@example.com",
        );
        assert_eq!(
            value,
            "ok https://<redacted>@example.test/repo\n<redacted>\n<redacted>\n<redacted>\nAuthor: developer <redacted-email>\nconfig user.name=<redacted> user.email=<redacted-email>"
        );
    }

    #[test]
    fn classifies_recoverable_git_and_svn_failures() {
        assert_eq!(
            classify_failure("git", "fatal: could not read Username"),
            (
                "GIT_AUTH_FAILED",
                Some("Check the selected account or system credential cache")
            )
        );
        assert_eq!(
            classify_failure("svn", "E155004: Working copy locked"),
            (
                "SVN_WORKING_COPY_LOCKED",
                Some("Run SVN cleanup after ensuring no other SVN operation is active")
            )
        );
        assert_eq!(
            classify_failure("git", "rejected non-fast-forward"),
            (
                "REMOTE_REJECTED",
                Some("Fetch remote changes and review branch divergence before retrying")
            )
        );
        assert_eq!(
            classify_failure("git", "Your local changes would be overwritten by checkout"),
            (
                "DIRTY_WORKTREE",
                Some("Commit, stash, carry, or discard local changes before retrying")
            )
        );
    }

    #[tokio::test]
    async fn resolves_git_index_locks_and_waits_without_deleting_them() {
        let root = tempfile::tempdir().unwrap();
        let git_dir = root.path().join("actual-git-dir");
        std::fs::create_dir(&git_dir).unwrap();
        std::fs::write(root.path().join(".git"), "gitdir: actual-git-dir\n").unwrap();
        let lock = git_dir.join("index.lock");
        std::fs::write(&lock, b"owned elsewhere").unwrap();
        let release = lock.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            std::fs::remove_file(release).unwrap();
        });
        wait_for_git_index_lock(root.path(), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(git_index_lock_path(root.path()), Some(lock));
    }

    #[test]
    fn recognizes_index_lock_failures_for_retry() {
        let error = DesktopError::new(
            "COMMAND_FAILED",
            "fatal: Unable to create '.git/index.lock': File exists.",
            true,
        );
        assert!(is_git_index_lock_error(&error));
        assert!(!is_git_index_lock_error(&DesktopError::new(
            "COMMAND_FAILED",
            "fatal: unrelated failure",
            true,
        )));
    }

    #[test]
    fn distinguishes_remote_and_config_reads_from_writes() {
        assert!(is_read_only_command("git", &["remote".into()]));
        assert!(is_read_only_command(
            "git",
            &["remote".into(), "get-url".into(), "origin".into()]
        ));
        assert!(!is_read_only_command(
            "git",
            &[
                "remote".into(),
                "set-url".into(),
                "origin".into(),
                "url".into()
            ]
        ));
        assert!(is_read_only_command(
            "git",
            &[
                "config".into(),
                "--local".into(),
                "--get".into(),
                "user.name".into()
            ]
        ));
        assert!(!is_read_only_command(
            "git",
            &[
                "config".into(),
                "--local".into(),
                "user.name".into(),
                "Ada".into()
            ]
        ));
    }

    #[tokio::test]
    async fn missing_git_config_logs_debug_and_preserves_global_fallback_and_real_errors() {
        use crate::logger::{LogLevel, LogManager};
        fn latest_level(logger: &LogManager, cwd: &Path, args: &[String]) -> LogLevel {
            logger
                .get_entries(None, None, None)
                .into_iter()
                .rev()
                .find(|entry| {
                    entry.cwd.as_deref() == cwd.to_str()
                        && entry.message == format_command_for_log("git", args)
                })
                .expect("the real command must have a log entry")
                .level
        }
        let root = tempfile::tempdir().unwrap();
        let logger = crate::logger::get_logger()
            .unwrap_or_else(|| crate::logger::init_global_logger(root.path().join("logs")));
        let token = CancellationToken::new();
        let init = run(
            "git",
            &["init".into()],
            root.path(),
            None,
            DEFAULT_TIMEOUT,
            &token,
        )
        .await
        .unwrap();
        assert_eq!(init.exit_code, Some(0));
        let global = root.path().join("global.gitconfig");
        std::fs::write(
            &global,
            "[user]\nname = Global User\nemail = global@example.test\n",
        )
        .unwrap();
        let env = vec![
            (
                "GIT_CONFIG_GLOBAL".into(),
                global.to_string_lossy().into_owned(),
            ),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ];
        for (key, value) in [
            ("user.name", "Global User"),
            ("user.email", "global@example.test"),
        ] {
            let args = vec![
                "config".into(),
                "--local".into(),
                "--get".into(),
                key.into(),
            ];
            let missing = run_with_env(
                "git",
                &args,
                root.path(),
                None,
                DEFAULT_TIMEOUT,
                &token,
                &env,
            )
            .await
            .unwrap_err();
            assert_eq!(missing.exit_code, Some(1));
            assert_eq!(latest_level(&logger, root.path(), &args), LogLevel::Debug);
            let args = vec![
                "config".into(),
                "--global".into(),
                "--get".into(),
                key.into(),
            ];
            let fallback = run_with_env(
                "git",
                &args,
                root.path(),
                None,
                DEFAULT_TIMEOUT,
                &token,
                &env,
            )
            .await
            .unwrap();
            assert_eq!(fallback.stdout_text().trim(), value);
        }
        let missing_ref = vec![
            "show-ref".into(),
            "--verify".into(),
            "--quiet".into(),
            "refs/heads/not-present".into(),
        ];
        let error = run(
            "git",
            &missing_ref,
            root.path(),
            None,
            DEFAULT_TIMEOUT,
            &token,
        )
        .await
        .unwrap_err();
        assert_eq!(error.exit_code, Some(1));
        assert_eq!(
            latest_level(&logger, root.path(), &missing_ref),
            LogLevel::Error
        );
        std::fs::write(root.path().join(".git/config"), "[broken\n").unwrap();
        let args = vec![
            "config".into(),
            "--local".into(),
            "--get".into(),
            "user.name".into(),
        ];
        let error = run("git", &args, root.path(), None, DEFAULT_TIMEOUT, &token)
            .await
            .unwrap_err();
        assert!(!error.stderr.unwrap_or_default().is_empty());
        assert_eq!(latest_level(&logger, root.path(), &args), LogLevel::Error);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn enforces_timeout_cancellation_and_output_limit() {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let timeout = run(
            "sh",
            &["-c".into(), "sleep 2".into()],
            root.path(),
            None,
            Duration::from_millis(20),
            &token,
        )
        .await
        .unwrap_err();
        assert_eq!(timeout.code, "COMMAND_TIMEOUT");

        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancel.cancel();
        });
        let cancelled = run(
            "sh",
            &["-c".into(), "sleep 2".into()],
            root.path(),
            None,
            DEFAULT_TIMEOUT,
            &token,
        )
        .await
        .unwrap_err();
        assert_eq!(cancelled.code, "REQUEST_CANCELLED");

        let limited = run(
            "sh",
            &[
                "-c".into(),
                format!("head -c {} /dev/zero", MAX_OUTPUT_BYTES + 1),
            ],
            root.path(),
            None,
            DEFAULT_TIMEOUT,
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(limited.code, "OUTPUT_LIMIT_EXCEEDED");
    }
}
