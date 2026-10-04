//! Display-only comparisons. Never apply patches or filters to the user's index/worktree.
use crate::{
    cli,
    models::{
        CatFileFilterMode, DesktopError, DiffDocument, RepositoryMeta, ShelveComparisonBase,
        VcsKind,
    },
    state::safe_relative,
    vcs,
};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

async fn git(
    repo: &RepositoryMeta,
    args: Vec<String>,
    token: &CancellationToken,
) -> Result<Vec<u8>, DesktopError> {
    Ok(cli::run(
        "git",
        &args,
        Path::new(&repo.root_path),
        None,
        Duration::from_secs(120),
        token,
    )
    .await?
    .stdout)
}

pub(crate) async fn raw_blob(
    repo: &RepositoryMeta,
    spec: &str,
    token: &CancellationToken,
) -> Result<Option<Vec<u8>>, DesktopError> {
    let input = format!("{spec}\0");
    let output = cli::run(
        "git",
        &["cat-file".into(), "--batch".into(), "-z".into()],
        Path::new(&repo.root_path),
        Some(input.as_bytes()),
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await?;
    let Some(header_end) = output.stdout.iter().position(|byte| *byte == b'\n') else {
        return Err(DesktopError::new(
            "GIT_BLOB_RESPONSE_INVALID",
            "Invalid Git blob response",
            true,
        ));
    };
    let header = String::from_utf8_lossy(&output.stdout[..header_end]);
    if header.ends_with(" missing") {
        return Ok(None);
    }
    let size = header
        .split_whitespace()
        .last()
        .and_then(|size| size.parse::<usize>().ok())
        .ok_or_else(|| {
            DesktopError::new("GIT_BLOB_RESPONSE_INVALID", "Invalid Git blob size", true)
        })?;
    let bytes = output
        .stdout
        .get(header_end + 1..header_end + 1 + size)
        .ok_or_else(|| {
            DesktopError::new(
                "GIT_BLOB_RESPONSE_INVALID",
                "Incomplete Git blob response",
                true,
            )
        })?;
    Ok(Some(bytes.to_vec()))
}
pub(crate) async fn blob(
    repo: &RepositoryMeta,
    spec: &str,
    mode: &CatFileFilterMode,
    token: &CancellationToken,
) -> Result<Vec<u8>, DesktopError> {
    let Some(raw) = raw_blob(repo, spec, token).await? else {
        return Ok(Vec::new());
    };
    let flag = match mode {
        CatFileFilterMode::None => return Ok(raw),
        CatFileFilterMode::Filters => "--filters",
        CatFileFilterMode::Textconv => "--textconv",
    };
    match git(
        repo,
        vec!["cat-file".into(), flag.into(), spec.into()],
        token,
    )
    .await
    {
        Ok(bytes) => Ok(bytes),
        Err(error) if error.code == "REQUEST_CANCELLED" => Err(error),
        Err(_) => Ok(raw),
    }
}
pub(crate) async fn working(repo: &RepositoryMeta, path: &str) -> Result<Vec<u8>, DesktopError> {
    let resolved = safe_relative(Path::new(&repo.root_path), path, false)?;
    if tokio::fs::symlink_metadata(&resolved)
        .await
        .is_ok_and(|meta| meta.file_type().is_symlink())
    {
        let target = tokio::fs::read_link(&resolved).await.map_err(io_error)?;
        return Ok(target.as_os_str().as_encoded_bytes().to_vec());
    }
    match tokio::fs::read(resolved).await {
        Ok(bytes) => Ok(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(DesktopError::new(
            "FILE_READ_FAILED",
            error.to_string(),
            true,
        )),
    }
}

pub(crate) async fn compare(
    path: &str,
    left: &[u8],
    right: &[u8],
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    let right_lines = right.iter().filter(|byte| **byte == b'\n').count()
        + usize::from(!right.is_empty() && right.last() != Some(&b'\n'));
    let left_lines = left.iter().filter(|byte| **byte == b'\n').count()
        + usize::from(!left.is_empty() && left.last() != Some(&b'\n'));
    if left.len().max(right.len()) > 5 * 1024 * 1024 || left_lines.max(right_lines) > 50_000 {
        let mut doc = vcs::make_diff(path, Vec::new())?;
        doc.truncated = true;
        doc.line_count = right_lines.min(u32::MAX as usize) as u32;
        return Ok(doc);
    }
    if token.is_cancelled() {
        return Err(DesktopError::new(
            "REQUEST_CANCELLED",
            "Request cancelled",
            true,
        ));
    }
    let binary = left.contains(&0)
        || right.contains(&0)
        || std::str::from_utf8(left).is_err()
        || std::str::from_utf8(right).is_err();
    if binary {
        let mut doc = vcs::make_diff(path, Vec::new())?;
        doc.binary = true;
        return Ok(doc);
    }
    let temp = tempfile::tempdir().map_err(io_error)?;
    tokio::fs::write(temp.path().join("before"), left)
        .await
        .map_err(io_error)?;
    tokio::fs::write(temp.path().join("after"), right)
        .await
        .map_err(io_error)?;
    let output = cli::compare_files(
        &[
            "-c".into(),
            "core.autocrlf=false".into(),
            "diff".into(),
            "--no-index".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "--no-color".into(),
            "--binary".into(),
            "-U999999".into(),
            "--".into(),
            "before".into(),
            "after".into(),
        ],
        temp.path(),
        token,
    )
    .await?;
    let content = output
        .stdout_text()
        .split_inclusive('\n')
        .map(|line| {
            if line.starts_with("diff --git ") {
                format!("diff --git a/{path} b/{path}\n")
            } else if line.starts_with("--- ") {
                if left.is_empty() {
                    "--- /dev/null\n".into()
                } else {
                    format!("--- a/{path}\n")
                }
            } else if line.starts_with("+++ ") {
                if right.is_empty() {
                    "+++ /dev/null\n".into()
                } else {
                    format!("+++ b/{path}\n")
                }
            } else {
                line.to_string()
            }
        })
        .collect::<String>();
    let mut doc = vcs::make_diff(path, content.into_bytes())?;
    doc.line_count = doc
        .line_count
        .max(String::from_utf8_lossy(right).lines().count() as u32);
    // An empty patch still needs source content to display identical versions.
    if doc.content.is_empty() && !right.is_empty() && !right.contains(&0) {
        let text = String::from_utf8_lossy(right);
        let count = text.lines().count();
        doc.content = format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,{count} +1,{count} @@\n");
        for line in text.split_inclusive('\n') {
            doc.content.push(' ');
            doc.content.push_str(line);
        }
        if !text.ends_with('\n') {
            doc.content.push_str("\n\\ No newline at end of file\n");
        }
    }
    Ok(doc)
}
fn io_error(error: std::io::Error) -> DesktopError {
    DesktopError::new("DIFF_PREVIEW_FAILED", error.to_string(), true)
}

pub(crate) async fn file_diff(
    repo: &RepositoryMeta,
    path: &str,
    staged: bool,
    revision: Option<String>,
    from: Option<String>,
    to: Option<String>,
    mode: &CatFileFilterMode,
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    let original = vcs::diff(
        repo,
        path,
        staged,
        revision.clone(),
        from.clone(),
        to.clone(),
        token,
    )
    .await?;
    if repo.kind != VcsKind::Git || original.binary || original.truncated {
        return Ok(original);
    }
    let old_path = patch_path(&original.content, "--- ", path);
    let new_path = patch_path(&original.content, "+++ ", path);
    let (left_spec, right_spec) = if let (Some(from), Some(to)) = (from, to) {
        (
            format!("{from}:{old_path}"),
            Some(format!("{to}:{new_path}")),
        )
    } else if let Some(rev) = revision {
        let parents = git(
            repo,
            vec![
                "rev-list".into(),
                "--parents".into(),
                "-n".into(),
                "1".into(),
                rev.clone(),
            ],
            token,
        )
        .await?;
        let parent = String::from_utf8_lossy(&parents)
            .split_whitespace()
            .nth(1)
            .map(str::to_string);
        (
            parent
                .map(|p| format!("{p}:{old_path}"))
                .unwrap_or_default(),
            Some(format!("{rev}:{new_path}")),
        )
    } else if staged {
        (format!("HEAD:{old_path}"), Some(format!(":{new_path}")))
    } else {
        (format!(":{old_path}"), None)
    };
    let left = if left_spec.is_empty() || original.content.contains("--- /dev/null") {
        Vec::new()
    } else {
        blob(repo, &left_spec, mode, token).await?
    };
    let right = if original.content.contains("+++ /dev/null") {
        Vec::new()
    } else if let Some(spec) = right_spec {
        blob(repo, &spec, mode, token).await?
    } else {
        working(repo, path).await?
    };
    compare(path, &left, &right, token).await
}
pub(crate) fn patch_path(content: &str, prefix: &str, fallback: &str) -> String {
    if let Some(value) = content.lines().find_map(|line| line.strip_prefix(prefix)) {
        let value = value.trim_end_matches('\t');
        let value = if value.starts_with('"') {
            decode_git_path(value)
        } else {
            value.to_string()
        };
        return value
            .strip_prefix(if prefix == "--- " { "a/" } else { "b/" })
            .unwrap_or(&value)
            .to_string();
    }
    content
        .lines()
        .find_map(|line| {
            line.strip_prefix(if prefix == "--- " {
                "rename from "
            } else {
                "rename to "
            })
        })
        .map(decode_git_path)
        .unwrap_or_else(|| fallback.to_string())
}
// Git quotes UTF-8 paths using octal bytes, which JSON decoding cannot handle.
pub(crate) fn decode_git_path(value: &str) -> String {
    let bytes = value.trim_matches('"').as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 1;
            if i + 2 < bytes.len() && bytes[i..i + 3].iter().all(|b| (b'0'..=b'7').contains(b)) {
                out.push((bytes[i] - b'0') * 64 + (bytes[i + 1] - b'0') * 8 + bytes[i + 2] - b'0');
                i += 3;
                continue;
            }
            out.push(match bytes[i] {
                b't' => b'\t',
                b'n' => b'\n',
                b'r' => b'\r',
                b => b,
            });
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) async fn stash_diff(
    repo: &RepositoryMeta,
    reference: &str,
    path: &str,
    base: &ShelveComparisonBase,
    mode: &CatFileFilterMode,
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    // Retain validation and existing binary/size limits.
    let original = vcs::stash_file_diff(repo, reference, path, token).await?;
    if original.binary || original.truncated {
        return Ok(original);
    }
    let left = if *base == ShelveComparisonBase::Local {
        working(repo, path).await?
    } else {
        blob(repo, &format!("{reference}^1:{path}"), mode, token).await?
    };
    let target = if raw_blob(repo, &format!("{reference}:{path}"), token)
        .await?
        .is_some()
    {
        format!("{reference}:{path}")
    } else {
        format!("{reference}^3:{path}")
    };
    let right = blob(repo, &target, mode, token).await?;
    compare(path, &left, &right, token).await
}

pub(crate) async fn shelf_diff(
    repo: &RepositoryMeta,
    document: DiffDocument,
    base: &ShelveComparisonBase,
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    if document.binary || document.truncated {
        return Ok(document);
    }
    let left = if *base == ShelveComparisonBase::Local {
        working(repo, &document.path).await?
    } else {
        let oid = document.content.lines().find_map(|line| {
            line.strip_prefix("index ")
                .and_then(|value| value.split_once(".."))
                .map(|(old, _)| old)
        });
        match oid {
            Some(oid)
                if oid.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && !oid.chars().all(|ch| ch == '0') =>
            {
                match raw_blob(repo, oid, token).await? {
                    Some(bytes) => bytes,
                    None => return Ok(document),
                }
            }
            _ if document.content.lines().any(|line| line == "--- /dev/null") => Vec::new(),
            _ => return Ok(document),
        }
    };
    let after = apply_preview(&document.content, &String::from_utf8_lossy(&left));
    compare(&document.path, &left, after.as_bytes(), token).await
}

/// Apply display hunks by position, retaining current context, just as the plugin preview does.
pub(crate) fn apply_preview(patch: &str, current: &str) -> String {
    if patch.lines().any(|l| l == "+++ /dev/null") {
        return String::new();
    }
    let is_new = patch.lines().any(|l| l == "--- /dev/null");
    let input: Vec<_> = current.split_inclusive('\n').collect();
    let mut out = String::new();
    let mut cursor = 0usize;
    let mut in_hunk = false;
    let mut last_kind = ' ';
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            let start = line
                .split_whitespace()
                .nth(1)
                .and_then(|v| v.trim_start_matches('-').split(',').next())
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(1)
                .saturating_sub(1);
            while !is_new && cursor < start.min(input.len()) {
                out.push_str(input[cursor]);
                cursor += 1;
            }
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        match line.chars().next().unwrap_or(' ') {
            ' ' => {
                out.push_str(input.get(cursor).copied().unwrap_or(&line[1..]));
                cursor += 1;
                last_kind = ' ';
            }
            '-' => {
                cursor += 1;
                last_kind = '-';
            }
            '+' => {
                out.push_str(&line[1..]);
                last_kind = '+';
            }
            '\\' if last_kind != '-' && out.ends_with('\n') => {
                out.pop();
            }
            _ => {}
        }
    }
    if !is_new {
        while cursor < input.len() {
            out.push_str(input[cursor]);
            cursor += 1;
        }
    }
    out
}
