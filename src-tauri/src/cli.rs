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

pub async fn run(
    program: &str,
    args: &[String],
    cwd: &Path,
    stdin: Option<&[u8]>,
    timeout: Duration,
    cancellation: &CancellationToken,
) -> Result<CommandOutput, DesktopError> {
    let mut command = Command::new(program);
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

    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command.spawn().map_err(|error| {
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
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true));
        }
        result = tokio::time::timeout(timeout, child.wait()) => {
            match result {
                Ok(value) => value.map_err(|error| DesktopError::new("COMMAND_IO_FAILED", error.to_string(), true))?,
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    stdout_task.abort();
                    stderr_task.abort();
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
    if !status.success() {
        let stderr = redact(&String::from_utf8_lossy(&result.stderr));
        let (code, hint) = classify_failure(program, &stderr);
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
    Ok(result)
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
                || lower.contains("password=")
                || lower.contains("token=")
            {
                "<redacted>".to_string()
            } else {
                redact_url_userinfo(line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
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
            "ok https://user:secret@example.test/repo\nAuthorization: bearer secret\npassword=hunter2",
        );
        assert_eq!(
            value,
            "ok https://<redacted>@example.test/repo\n<redacted>\n<redacted>"
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
