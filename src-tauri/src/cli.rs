use std::{path::Path, process::Stdio, time::Duration};

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

    #[cfg(unix)]
    command.process_group(0);

    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command.spawn().map_err(|error| {
        let duration_ms = start_time.elapsed().as_millis() as u32;
        crate::logger::log_entry(
            crate::logger::LogLevel::Error,
            channel,
            &formatted_cmd,
            Some(format!("Unable to start {program}: {error}")),
            Some(duration_ms),
            None,
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
            crate::logger::log_entry(
                crate::logger::LogLevel::Warn,
                channel,
                &formatted_cmd,
                Some("Operation cancelled".to_string()),
                Some(duration_ms),
                None,
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
                    crate::logger::log_entry(
                        crate::logger::LogLevel::Error,
                        channel,
                        &formatted_cmd,
                        Some(format!("{program} timed out")),
                        Some(duration_ms),
                        None,
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
        crate::logger::log_entry(
            crate::logger::LogLevel::Error,
            channel,
            &formatted_cmd,
            Some(stderr.clone()),
            Some(duration_ms),
            result.exit_code,
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
        });
    }
    let level = if is_read_only_command(program, args) {
        crate::logger::LogLevel::Debug
    } else {
        crate::logger::LogLevel::Info
    };
    crate::logger::log_entry(
        level,
        channel,
        &formatted_cmd,
        None,
        Some(duration_ms),
        result.exit_code,
    );
    Ok(result)
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
                | "diff" | "log" | "remote" | "config",
            ) => true,
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
    let mut buffer = [0_u8; 16 * 1024];
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
