use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cli,
    models::{
        BranchCompareResult, BranchInfo, BranchOperation, BranchOperationResult,
        BranchRecoveryOperation, BranchRecoveryResult, BranchRecoveryStatus, CommitBranches,
        CommitDetail, CommitFile, CommitNode, CommitPathOperationEntry, ConflictBlock,
        ConflictChoice, DesktopError, DiffDocument, EffectiveGitIdentity, FileHistoryEntry,
        FileHistoryPage, FileRevisionDocument, GraphCommitNode, HistoryOperation, HistoryPage,
        HistoryQuery, IgnoreRules, MergeCommitSummary, MergeParentChange, MergeVersions,
        PatchDocument, RecentCommitMessage, RemoteInfo, RemoteOperation, RepositoryMeta,
        RepositoryUpdateResult, RestoreConflictFailure, RestoreConflictsResult, ShelfFileEntry,
        StashEntry, StashOperation, SubmoduleEntry, SubmoduleOperation, SubtreeEntry,
        SubtreeOperation, SubtreeState, SvnOperation, SyncAction, SyncResult, TagInfo,
        TagOperation, UnpushedCommit, UnpushedOperation, UpdateDetail, UpdateKind, UpdateSummary,
        VcsKind, WorktreeDiffResult, WorktreeEntry, WorktreeOperation,
    },
    state::safe_relative,
};

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';
const DIFF_MAX_BYTES: usize = 5 * 1024 * 1024;
const DIFF_MAX_LINES: usize = 50_000;
const SUBTREE_CONFIG_PREFIX: &str = "versiondock.subtree.";

#[derive(Debug, Clone, Default)]
struct PendingSvnMerge {
    paths: Vec<String>,
    added_paths: Vec<String>,
}

static SVN_MERGES: OnceLock<Mutex<HashMap<String, PendingSvnMerge>>> = OnceLock::new();

fn svn_merges() -> &'static Mutex<HashMap<String, PendingSvnMerge>> {
    SVN_MERGES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn validate_commit_selection_paths(
    repo: &RepositoryMeta,
    paths: &[String],
) -> Result<Vec<String>, DesktopError> {
    paths
        .iter()
        .map(|path| relative_path(Path::new(&repo.root_path), path, true))
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHistoryCursor {
    repo_id: String,
    path: String,
    vcs: VcsKind,
    offset: u32,
    anchor_revision: String,
    peg_revision: Option<String>,
}

fn encode_file_history_cursor(cursor: &FileHistoryCursor) -> Result<String, DesktopError> {
    serde_json::to_vec(cursor)
        .map(hex::encode)
        .map_err(|error| DesktopError::new("FILE_HISTORY_CURSOR_INVALID", error.to_string(), false))
}

fn decode_file_history_cursor(value: &str) -> Result<FileHistoryCursor, DesktopError> {
    let bytes = hex::decode(value).map_err(|_| {
        DesktopError::new(
            "FILE_HISTORY_CURSOR_INVALID",
            "Invalid file history cursor",
            false,
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        DesktopError::new(
            "FILE_HISTORY_CURSOR_INVALID",
            "Invalid file history cursor",
            false,
        )
    })
}

pub(crate) fn bytes_are_binary(bytes: &[u8]) -> bool {
    const BINARY_PREFIXES: &[&[u8]] = &[
        b"\x89PNG\r\n\x1a\n",
        b"\xff\xd8\xff",
        b"GIF87a",
        b"GIF89a",
        b"%PDF-",
        b"PK\x03\x04",
        b"\x1f\x8b",
        b"\x7fELF",
        b"\0asm",
        b"\xfe\xed\xfa\xce",
        b"\xfe\xed\xfa\xcf",
        b"\xce\xfa\xed\xfe",
        b"\xcf\xfa\xed\xfe",
    ];
    if bytes.is_empty() {
        return false;
    }
    if bytes.contains(&0)
        || BINARY_PREFIXES
            .iter()
            .any(|prefix| bytes.starts_with(prefix))
    {
        return true;
    }
    let sample = &bytes[..bytes.len().min(8192)];
    let controls = sample
        .iter()
        .filter(|byte| matches!(byte, 0x01..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f))
        .count();
    controls > sample.len().max(100) / 100
}

async fn execute(
    program: &str,
    args: Vec<String>,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<cli::CommandOutput, DesktopError> {
    cli::run(
        program,
        &args,
        Path::new(&repo.root_path),
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
}

async fn git(
    args: Vec<String>,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<cli::CommandOutput, DesktopError> {
    let mut safe = vec!["-c".into(), "core.quotepath=false".into()];
    safe.extend(args);
    execute("git", safe, repo, token).await
}

async fn git_network(
    args: Vec<String>,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<cli::CommandOutput, DesktopError> {
    let mut safe = vec!["-c".into(), "core.quotepath=false".into()];
    safe.extend(args);
    cli::run(
        "git",
        &safe,
        Path::new(&repo.root_path),
        None,
        cli::NETWORK_TIMEOUT,
        token,
    )
    .await
}

async fn svn(
    args: Vec<String>,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<cli::CommandOutput, DesktopError> {
    let auth = crate::svn_account::cached_auth(repo);
    let mut safe = vec!["--non-interactive".into()];
    if let Some((username, _)) = &auth {
        safe.extend([
            "--username".into(),
            username.clone(),
            "--password-from-stdin".into(),
            "--no-auth-cache".into(),
        ]);
    }
    safe.extend(args);
    let auth_input = auth.as_ref().map(|(_, password)| format!("{password}\n"));
    cli::run(
        "svn",
        &safe,
        Path::new(&repo.root_path),
        auth_input.as_ref().map(|value| value.as_bytes()),
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
}

fn literal_path(root: &Path, value: &str, include_leaf: bool) -> Result<String, DesktopError> {
    safe_relative(root, value, include_leaf)?;
    Ok(format!(":(literal){value}"))
}

fn relative_path(root: &Path, value: &str, include_leaf: bool) -> Result<String, DesktopError> {
    safe_relative(root, value, include_leaf)?;
    Ok(value.replace('\\', "/"))
}

fn option_like(value: &str) -> bool {
    value.trim_start().starts_with('-')
}

fn regex_literal(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            if matches!(
                character,
                '.' | '^' | '$' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\'
            ) {
                vec!['\\', character]
            } else {
                vec![character]
            }
        })
        .collect()
}

pub async fn initialize_repository(
    target: &Path,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    cli::run(
        "git",
        &[
            "init".into(),
            "--".into(),
            target.to_string_lossy().into_owned(),
        ],
        target,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await?;
    Ok(())
}

pub async fn existing_repository(target: &Path, token: &CancellationToken) -> Option<VcsKind> {
    if cli::run(
        "git",
        &["rev-parse".into(), "--show-toplevel".into()],
        target,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
    .is_ok()
    {
        return Some(VcsKind::Git);
    }
    cli::run(
        "svn",
        &["--non-interactive".into(), "info".into(), "--xml".into()],
        target,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
    .is_ok()
    .then_some(VcsKind::Svn)
}

pub async fn clone_repository(
    url: &str,
    parent: &Path,
    target_name: &str,
    credentials: Option<&(String, String)>,
    token: &CancellationToken,
) -> Result<PathBuf, DesktopError> {
    let url = url.trim();
    if url.is_empty() || url.contains('\0') || option_like(url) {
        return Err(DesktopError::new(
            "INVALID_CLONE_URL",
            "Invalid Git clone URL",
            false,
        ));
    }
    let supported = url.starts_with("https://")
        || url.starts_with("ssh://")
        || url.starts_with("file://")
        || (!url.contains("://")
            && (parent.join(url).exists()
                || Path::new(url).is_absolute() && Path::new(url).exists()
                || url
                    .split_once(':')
                    .is_some_and(|(host, path)| !host.is_empty() && !path.is_empty())));
    if !supported {
        return Err(DesktopError::new(
            "UNSUPPORTED_CLONE_URL",
            "Clone URL must use HTTPS, SSH, file://, or a local path",
            false,
        ));
    }
    if target_name.is_empty()
        || target_name.contains('\0')
        || option_like(target_name)
        || Path::new(target_name).components().count() != 1
        || matches!(target_name, "." | "..")
    {
        return Err(DesktopError::new(
            "INVALID_TARGET_NAME",
            "Invalid clone target name",
            false,
        ));
    }
    let target = safe_relative(parent, target_name, true)?;
    if target.exists()
        && (!target.is_dir()
            || target
                .read_dir()
                .map_or(true, |mut entries| entries.next().is_some()))
    {
        return Err(DesktopError::new(
            "CLONE_TARGET_NOT_EMPTY",
            "Clone target already exists and is not empty",
            true,
        ));
    }
    let existed = target.exists();
    let askpass = credentials.map(|_| create_askpass()).transpose()?;
    let mut environment = Vec::new();
    if let (Some((username, password)), Some(path)) = (credentials, askpass.as_ref()) {
        environment.extend([
            ("GIT_ASKPASS".into(), path.to_string_lossy().into_owned()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
            ("VERSIONDOCK_GIT_USERNAME".into(), username.clone()),
            ("VERSIONDOCK_GIT_PASSWORD".into(), password.clone()),
        ]);
    }
    let result = cli::run_with_env(
        "git",
        &[
            "-c".into(),
            "core.quotepath=false".into(),
            "clone".into(),
            "--".into(),
            url.into(),
            target_name.into(),
        ],
        parent,
        None,
        cli::NETWORK_TIMEOUT,
        token,
        &environment,
    )
    .await;
    if let Some(path) = askpass {
        let _ = std::fs::remove_file(path);
    }
    if let Err(error) = result {
        if !existed
            && target.is_dir()
            && target
                .read_dir()
                .is_ok_and(|mut entries| entries.next().is_none())
        {
            let _ = std::fs::remove_dir(&target);
        }
        return Err(error);
    }
    std::fs::canonicalize(&target)
        .map_err(|error| DesktopError::new("CLONE_TARGET_UNAVAILABLE", error.to_string(), true))
}

pub async fn publish_preflight(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    ensure_git(repo)?;
    if !remotes(repo, token).await?.is_empty() {
        return Err(DesktopError::new(
            "REMOTE_ALREADY_EXISTS",
            "Repository already has a remote",
            false,
        ));
    }
    git(
        vec!["rev-parse".into(), "--verify".into(), "HEAD".into()],
        repo,
        token,
    )
    .await
    .map_err(|_| {
        DesktopError::new(
            "HEAD_MISSING",
            "Create the initial commit before publishing",
            false,
        )
    })?;
    let branch = git(
        vec![
            "symbolic-ref".into(),
            "--short".into(),
            "-q".into(),
            "HEAD".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text()
    .trim()
    .to_string();
    if branch.is_empty() {
        return Err(DesktopError::new(
            "DETACHED_HEAD",
            "Check out a local branch before publishing",
            false,
        ));
    }
    Ok(branch)
}

pub async fn push_published(
    repo: &RepositoryMeta,
    branch: &str,
    credentials: &(String, String),
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    validate_ref(branch)?;
    let askpass = create_askpass()?;
    let environment = vec![
        ("GIT_ASKPASS".into(), askpass.to_string_lossy().into_owned()),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("VERSIONDOCK_GIT_USERNAME".into(), credentials.0.clone()),
        ("VERSIONDOCK_GIT_PASSWORD".into(), credentials.1.clone()),
    ];
    let result = cli::run_with_env(
        "git",
        &[
            "-c".into(),
            "core.quotepath=false".into(),
            "push".into(),
            "--set-upstream".into(),
            "origin".into(),
            branch.into(),
        ],
        Path::new(&repo.root_path),
        None,
        cli::NETWORK_TIMEOUT,
        token,
        &environment,
    )
    .await;
    let _ = std::fs::remove_file(askpass);
    result.map(|_| ())
}

fn create_askpass() -> Result<PathBuf, DesktopError> {
    let extension = if cfg!(windows) { "cmd" } else { "sh" };
    let path = std::env::temp_dir().join(format!(
        "versiondock-askpass-{}.{}",
        uuid::Uuid::new_v4(),
        extension
    ));
    let body = if cfg!(windows) {
        "@echo off\r\necho %1 | findstr /I username >nul\r\nif %errorlevel%==0 (echo %VERSIONDOCK_GIT_USERNAME%) else (echo %VERSIONDOCK_GIT_PASSWORD%)\r\n"
    } else {
        "#!/bin/sh\ncase \"$1\" in *sername*) printf '%s\\n' \"$VERSIONDOCK_GIT_USERNAME\" ;; *) printf '%s\\n' \"$VERSIONDOCK_GIT_PASSWORD\" ;; esac\n"
    };
    std::fs::write(&path, body)
        .map_err(|e| DesktopError::new("ASKPASS_CREATE_FAILED", e.to_string(), true))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| DesktopError::new("ASKPASS_CREATE_FAILED", e.to_string(), true))?;
    }
    Ok(path)
}

fn normalize_commit_message(value: &str) -> Option<String> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub async fn recent_commit_messages(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<RecentCommitMessage>, DesktopError> {
    match repo.kind {
        VcsKind::Git => {
            let format = format!("%H{FIELD}%cI{FIELD}%B{RECORD}");
            let raw = git(
                vec![
                    "log".into(),
                    "--max-count=100".into(),
                    format!("--format={format}"),
                ],
                repo,
                token,
            )
            .await;
            let raw = match raw {
                Ok(value) => value.stdout_text(),
                Err(error)
                    if error.stderr.as_deref().is_some_and(|value| {
                        value.contains("does not have any commits yet")
                            || value.contains("unknown revision")
                    }) =>
                {
                    return Ok(Vec::new())
                }
                Err(error) => return Err(error),
            };
            Ok(raw
                .split(RECORD)
                .filter_map(|record| {
                    let mut fields = record.trim().splitn(3, FIELD);
                    let revision = fields.next()?.trim();
                    let committed_at = fields.next()?.trim();
                    let message = normalize_commit_message(fields.next()?)?;
                    Some(RecentCommitMessage {
                        repo_id: repo.id.clone(),
                        revision: revision.into(),
                        committed_at: committed_at.into(),
                        message,
                    })
                })
                .collect())
        }
        VcsKind::Svn => {
            let raw = svn(
                vec!["log".into(), "--xml".into(), "--limit".into(), "100".into()],
                repo,
                token,
            )
            .await?
            .stdout_text();
            let document = roxmltree::Document::parse(&raw)
                .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
            Ok(document
                .descendants()
                .filter(|node| node.has_tag_name("logentry"))
                .filter_map(|entry| {
                    let text = |name| {
                        entry
                            .children()
                            .find(|child| child.has_tag_name(name))
                            .and_then(|child| child.text())
                            .unwrap_or("")
                    };
                    Some(RecentCommitMessage {
                        repo_id: repo.id.clone(),
                        revision: entry.attribute("revision")?.into(),
                        committed_at: text("date").into(),
                        message: normalize_commit_message(text("msg"))?,
                    })
                })
                .collect())
        }
    }
}

pub async fn last_commit_message(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Option<String>, DesktopError> {
    if repo.kind == VcsKind::Git {
        return Ok(recent_commit_messages(repo, token)
            .await?
            .into_iter()
            .next()
            .map(|item| item.message));
    }
    let revision = current_revision(repo, token).await?;
    let raw = svn(
        vec!["log".into(), "--xml".into(), "-r".into(), revision],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    Ok(document
        .descendants()
        .find(|node| node.has_tag_name("msg"))
        .and_then(|node| node.text())
        .and_then(normalize_commit_message))
}

pub async fn diff(
    repo: &RepositoryMeta,
    path: &str,
    staged: bool,
    revision: Option<String>,
    from_revision: Option<String>,
    to_revision: Option<String>,
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, false)?;
    if revision.is_none() && from_revision.is_none() && to_revision.is_none() {
        let untracked = match repo.kind {
            VcsKind::Git => git(
                vec![
                    "status".into(),
                    "--porcelain=v1".into(),
                    "--".into(),
                    format!(":(literal){safe}"),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text()
            .lines()
            .any(|line| line.starts_with("??")),
            VcsKind::Svn => svn(
                vec!["status".into(), "--".into(), safe.clone()],
                repo,
                token,
            )
            .await?
            .stdout_text()
            .lines()
            .any(|line| line.starts_with('?')),
        };
        if untracked {
            return untracked_diff(root, path, &safe);
        }
    }
    let output = match repo.kind {
        VcsKind::Git => {
            if from_revision.is_some() || to_revision.is_some() {
                let from = from_revision.ok_or_else(|| {
                    DesktopError::new(
                        "INVALID_REVISION_RANGE",
                        "Both range revisions are required",
                        false,
                    )
                })?;
                let to = to_revision.ok_or_else(|| {
                    DesktopError::new(
                        "INVALID_REVISION_RANGE",
                        "Both range revisions are required",
                        false,
                    )
                })?;
                validate_revision_or_ref(&from)?;
                validate_revision_or_ref(&to)?;
                git(
                    vec![
                        "diff".into(),
                        "-U999999".into(),
                        "--no-ext-diff".into(),
                        "--no-color".into(),
                        "--binary".into(),
                        from,
                        to,
                        "--".into(),
                        format!(":(literal){safe}"),
                    ],
                    repo,
                    token,
                )
                .await?
            } else if let Some(value) = revision {
                validate_revision(&value)?;
                git(
                    vec![
                        "show".into(),
                        "-U999999".into(),
                        "--format=".into(),
                        "--no-ext-diff".into(),
                        "--no-color".into(),
                        "--binary".into(),
                        value,
                        "--".into(),
                        format!(":(literal){safe}"),
                    ],
                    repo,
                    token,
                )
                .await?
            } else {
                let mut args = vec![
                    "diff".into(),
                    "-U999999".into(),
                    "--no-ext-diff".into(),
                    "--no-color".into(),
                    "--binary".into(),
                ];
                if staged {
                    args.push("--cached".into());
                }
                args.push("--".into());
                args.push(format!(":(literal){safe}"));
                git(args, repo, token).await?
            }
        }
        VcsKind::Svn => {
            let mut args = vec!["diff".into()];
            if from_revision.is_some() || to_revision.is_some() {
                let from = from_revision.ok_or_else(|| {
                    DesktopError::new(
                        "INVALID_REVISION_RANGE",
                        "Both range revisions are required",
                        false,
                    )
                })?;
                let to = to_revision.ok_or_else(|| {
                    DesktopError::new(
                        "INVALID_REVISION_RANGE",
                        "Both range revisions are required",
                        false,
                    )
                })?;
                validate_svn_revision(&from)?;
                validate_svn_revision(&to)?;
                args.extend(["-r".into(), format!("{from}:{to}")]);
            } else if let Some(value) = revision {
                validate_svn_revision(&value)?;
                args.extend(["-c".into(), value]);
            }
            args.extend(["--".into(), safe]);
            svn(args, repo, token).await?
        }
    };
    make_diff(path, output.stdout)
}

fn make_diff(path: &str, bytes: Vec<u8>) -> Result<DiffDocument, DesktopError> {
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let binary = bytes_are_binary(&bytes)
        || content.contains("Binary files")
        || content.contains("GIT binary patch")
        || content.contains("Cannot display: file marked as a binary type.");
    let line_count = content.lines().count();
    let truncated = bytes.len() > DIFF_MAX_BYTES || line_count > DIFF_MAX_LINES;
    Ok(DiffDocument {
        path: path.into(),
        content: if truncated { String::new() } else { content },
        language: language_for(path),
        binary,
        truncated,
        line_count: line_count.min(u32::MAX as usize) as u32,
    })
}

fn untracked_diff(
    root: &Path,
    display_path: &str,
    safe: &str,
) -> Result<DiffDocument, DesktopError> {
    let bytes = std::fs::read(root.join(safe))
        .map_err(|error| DesktopError::new("FILE_READ_FAILED", error.to_string(), true))?;
    let binary = bytes_are_binary(&bytes);
    let text = String::from_utf8_lossy(&bytes);
    let line_count = text.lines().count();
    let truncated = bytes.len() > DIFF_MAX_BYTES || line_count > DIFF_MAX_LINES;
    let content = if binary || truncated {
        String::new()
    } else {
        let mut patch = format!(
            "diff --git a/{safe} b/{safe}\nnew file mode 100644\n--- /dev/null\n+++ b/{safe}\n@@ -0,0 +1,{} @@\n",
            line_count
        );
        for line in text.split_inclusive('\n') {
            patch.push('+');
            patch.push_str(line);
        }
        if !text.is_empty() && !text.ends_with('\n') {
            patch.push_str("\n\\ No newline at end of file\n");
        }
        patch
    };
    Ok(DiffDocument {
        path: display_path.into(),
        content,
        language: language_for(display_path),
        binary,
        truncated,
        line_count: line_count.min(u32::MAX as usize) as u32,
    })
}

pub async fn stage(
    repo: &RepositoryMeta,
    paths: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if paths.is_empty() {
        return Ok(());
    }
    let root = Path::new(&repo.root_path);
    match repo.kind {
        VcsKind::Git => {
            for path in paths {
                let safe = relative_path(root, path, true)?;
                let index_entry = git(
                    vec![
                        "ls-files".into(),
                        "--stage".into(),
                        "--".into(),
                        format!(":(literal){safe}"),
                    ],
                    repo,
                    token,
                )
                .await?
                .stdout_text();
                if index_entry.starts_with("160000 ") {
                    let pointer_diff = git(
                        vec![
                            "diff".into(),
                            "--raw".into(),
                            "--".into(),
                            format!(":(literal){safe}"),
                        ],
                        repo,
                        token,
                    )
                    .await?
                    .stdout_text();
                    if pointer_diff.trim().is_empty() {
                        return Err(DesktopError::new(
                            "SUBMODULE_POINTER_UNCHANGED",
                            format!(
                                "{safe} has nested changes but no new submodule commit to stage"
                            ),
                            true,
                        )
                        .hint("Commit inside the submodule first, then stage its pointer"));
                    }
                }
            }
            let mut args = vec!["add".into(), "--".into()];
            args.extend(
                paths
                    .iter()
                    .map(|path| literal_path(root, path, true))
                    .collect::<Result<Vec<_>, _>>()?,
            );
            git(args, repo, token).await?;
        }
        VcsKind::Svn => {
            let mut args = vec![
                "add".into(),
                "--parents".into(),
                "--force".into(),
                "--".into(),
            ];
            args.extend(
                paths
                    .iter()
                    .map(|path| relative_path(root, path, true))
                    .collect::<Result<Vec<_>, _>>()?,
            );
            svn(args, repo, token).await?;
        }
    }
    Ok(())
}

pub async fn delete_paths(repo: &RepositoryMeta, paths: &[String]) -> Result<(), DesktopError> {
    let root = Path::new(&repo.root_path);
    let targets = paths
        .iter()
        .map(|path| safe_relative(root, path, true))
        .collect::<Result<Vec<_>, _>>()?;
    tokio::task::spawn_blocking(move || {
        for target in targets {
            if target.exists() {
                trash::delete(&target)
                    .map_err(|error| DesktopError::new("TRASH_FAILED", error.to_string(), true))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| DesktopError::new("TRASH_FAILED", error.to_string(), true))?
}

pub async fn add_ignore(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Result<IgnoreRules, DesktopError> {
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, false)?;
    let target = root.join(&safe);
    let is_directory = target.is_dir();
    match repo.kind {
        VcsKind::Git => {
            let pattern = if is_directory {
                format!("/{}/", safe.trim_end_matches('/'))
            } else {
                format!("/{safe}")
            };
            let mut rules = ignore_rules(repo, "", token).await?;
            if !rules.patterns.contains(&pattern) {
                rules.patterns.push(pattern);
            }
            update_ignore_rules(repo, "", &rules.patterns, token).await?;
            ignore_rules(repo, "", token).await
        }
        VcsKind::Svn => {
            let parent = Path::new(&safe)
                .parent()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .replace('\\', "/");
            let name = Path::new(&safe)
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| {
                    DesktopError::new("INVALID_PATH", "Ignore target has no file name", false)
                })?
                .to_string();
            let mut rules = ignore_rules(repo, &parent, token).await?;
            if !rules.patterns.contains(&name) {
                rules.patterns.push(name);
            }
            update_ignore_rules(repo, &parent, &rules.patterns, token).await?;
            ignore_rules(repo, &parent, token).await
        }
    }
}

pub async fn ignore_rules(
    repo: &RepositoryMeta,
    directory: &str,
    token: &CancellationToken,
) -> Result<IgnoreRules, DesktopError> {
    let root = Path::new(&repo.root_path);
    let directory = relative_path(root, directory, false)?;
    match repo.kind {
        VcsKind::Git => {
            let path = root.join(".gitignore");
            let content = std::fs::read_to_string(path).unwrap_or_default();
            Ok(IgnoreRules {
                directory,
                source: ".gitignore".into(),
                patterns: content.lines().map(str::to_string).collect(),
            })
        }
        VcsKind::Svn => {
            let target = if directory.is_empty() {
                ".".into()
            } else {
                directory.clone()
            };
            let content = svn(
                vec!["propget".into(), "svn:ignore".into(), "--".into(), target],
                repo,
                token,
            )
            .await
            .map(|value| value.stdout_text())
            .unwrap_or_default();
            Ok(IgnoreRules {
                directory,
                source: "svn:ignore".into(),
                patterns: content.lines().map(str::to_string).collect(),
            })
        }
    }
}

pub async fn update_ignore_rules(
    repo: &RepositoryMeta,
    directory: &str,
    patterns: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let normalized = patterns
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.contains(['\0', '\r', '\n']))
        .collect::<Vec<_>>();
    if normalized.len()
        != patterns
            .iter()
            .filter(|value| !value.trim().is_empty())
            .count()
    {
        return Err(DesktopError::new(
            "INVALID_IGNORE_PATTERN",
            "Ignore patterns cannot contain control characters",
            false,
        ));
    }
    match repo.kind {
        VcsKind::Git => {
            let target = Path::new(&repo.root_path).join(".gitignore");
            let temporary = Path::new(&repo.root_path).join(".gitignore.versiondock.tmp");
            let content = if normalized.is_empty() {
                String::new()
            } else {
                format!("{}\n", normalized.join("\n"))
            };
            tokio::fs::write(&temporary, content)
                .await
                .map_err(|error| {
                    DesktopError::new("IGNORE_WRITE_FAILED", error.to_string(), true)
                })?;
            tokio::fs::rename(temporary, target)
                .await
                .map_err(|error| {
                    DesktopError::new("IGNORE_WRITE_FAILED", error.to_string(), true)
                })?;
        }
        VcsKind::Svn => {
            let root = Path::new(&repo.root_path);
            let directory = relative_path(root, directory, false)?;
            let target = if directory.is_empty() {
                ".".into()
            } else {
                directory
            };
            if normalized.is_empty() {
                let _ = svn(
                    vec!["propdel".into(), "svn:ignore".into(), "--".into(), target],
                    repo,
                    token,
                )
                .await;
            } else {
                svn(
                    vec![
                        "propset".into(),
                        "svn:ignore".into(),
                        normalized.join("\n"),
                        "--".into(),
                        target,
                    ],
                    repo,
                    token,
                )
                .await?;
            }
        }
    }
    Ok(())
}

pub async fn unstage(
    repo: &RepositoryMeta,
    paths: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    if paths.is_empty() {
        return Ok(());
    }
    let root = Path::new(&repo.root_path);
    let mut args = vec!["reset".into(), "--".into()];
    args.extend(
        paths
            .iter()
            .map(|path| literal_path(root, path, false))
            .collect::<Result<Vec<_>, _>>()?,
    );
    git(args, repo, token).await?;
    Ok(())
}

pub async fn discard(
    repo: &RepositoryMeta,
    paths: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if paths.is_empty() {
        return Ok(());
    }
    let root = Path::new(&repo.root_path);
    for path in paths {
        let safe = relative_path(root, path, true)?;
        match repo.kind {
            VcsKind::Git => {
                let pathspec = format!(":(literal){safe}");
                let status = git(
                    vec![
                        "status".into(),
                        "--porcelain".into(),
                        "--".into(),
                        pathspec.clone(),
                    ],
                    repo,
                    token,
                )
                .await?
                .stdout_text();
                if status.trim_start().starts_with("??") {
                    let target = root.join(&safe);
                    let metadata = std::fs::symlink_metadata(&target).map_err(|error| {
                        DesktopError::new("DISCARD_FAILED", error.to_string(), true)
                    })?;
                    if metadata.is_dir() {
                        std::fs::remove_dir_all(&target)
                    } else {
                        std::fs::remove_file(&target)
                    }
                    .map_err(|error| {
                        DesktopError::new("DISCARD_FAILED", error.to_string(), true)
                    })?;
                } else {
                    git(
                        vec![
                            "restore".into(),
                            "--source=HEAD".into(),
                            "--staged".into(),
                            "--worktree".into(),
                            "--".into(),
                            pathspec,
                        ],
                        repo,
                        token,
                    )
                    .await?;
                }
            }
            VcsKind::Svn => {
                let status = svn(
                    vec!["status".into(), "--".into(), safe.clone()],
                    repo,
                    token,
                )
                .await?
                .stdout_text();
                if status.starts_with('?') {
                    let target = root.join(&safe);
                    let metadata = std::fs::symlink_metadata(&target).map_err(|error| {
                        DesktopError::new("DISCARD_FAILED", error.to_string(), true)
                    })?;
                    if metadata.is_dir() {
                        std::fs::remove_dir_all(&target)
                    } else {
                        std::fs::remove_file(&target)
                    }
                    .map_err(|error| {
                        DesktopError::new("DISCARD_FAILED", error.to_string(), true)
                    })?;
                } else {
                    let remove_after_revert = status.starts_with('A');
                    svn(
                        vec![
                            "revert".into(),
                            "--depth".into(),
                            "infinity".into(),
                            "--".into(),
                            safe.clone(),
                        ],
                        repo,
                        token,
                    )
                    .await?;
                    if remove_after_revert {
                        let target = root.join(&safe);
                        if let Ok(metadata) = std::fs::symlink_metadata(&target) {
                            if metadata.is_dir() {
                                std::fs::remove_dir_all(&target)
                            } else {
                                std::fs::remove_file(&target)
                            }
                            .map_err(|error| {
                                DesktopError::new("DISCARD_FAILED", error.to_string(), true)
                            })?;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
pub async fn commit(
    repo: &RepositoryMeta,
    message: &str,
    amend: bool,
    paths: &[String],
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    commit_with_identity(repo, message, amend, paths, None, token).await
}

pub async fn commit_with_identity(
    repo: &RepositoryMeta,
    message: &str,
    amend: bool,
    paths: &[String],
    identity: Option<&EffectiveGitIdentity>,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let message = validate_message(message)?;
    match repo.kind {
        VcsKind::Git => {
            if !paths.is_empty() {
                stage(repo, paths, token).await?;
            }
            let mut args = vec!["commit".into(), "--file=-".into()];
            if amend {
                args.push("--amend".into());
            }
            let mut safe = vec!["-c".into(), "core.quotepath=false".into()];
            if let Some(identity) = identity {
                if !identity.valid {
                    return Err(DesktopError::new(
                        "GIT_IDENTITY_MISSING",
                        "A valid Git user.name and user.email are required before committing",
                        true,
                    )
                    .hint(
                        "Choose a Git identity profile or configure repository/global Git identity",
                    ));
                }
                safe.extend([
                    "-c".into(),
                    format!("user.name={}", identity.user_name),
                    "-c".into(),
                    format!("user.email={}", identity.email),
                ]);
            }
            safe.extend(args);
            cli::run(
                "git",
                &safe,
                Path::new(&repo.root_path),
                Some(message.as_bytes()),
                cli::DEFAULT_TIMEOUT,
                token,
            )
            .await?;
            Ok(git(vec!["rev-parse".into(), "HEAD".into()], repo, token)
                .await?
                .stdout_text()
                .trim()
                .into())
        }
        VcsKind::Svn => {
            if amend {
                return Err(DesktopError::new(
                    "UNSUPPORTED_OPERATION",
                    "SVN does not support amend",
                    false,
                ));
            }
            let root = Path::new(&repo.root_path);
            prepare_svn_commit(repo, paths, token).await?;
            let mut args = vec!["commit".into(), "--file".into(), "-".into()];
            if paths.is_empty() {
                args.push(".".into());
            } else {
                args.extend(
                    paths
                        .iter()
                        .map(|path| relative_path(root, path, true))
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            let mut safe = vec!["--non-interactive".into()];
            safe.extend(args);
            let output = cli::run(
                "svn",
                &safe,
                root,
                Some(message.as_bytes()),
                cli::NETWORK_TIMEOUT,
                token,
            )
            .await?;
            refresh_svn_merge(repo, token).await;
            Ok(output.stdout_text())
        }
    }
}

pub async fn file_history(
    repo: &RepositoryMeta,
    relative_path_value: &str,
    cursor: Option<&str>,
    limit: u32,
    token: &CancellationToken,
) -> Result<FileHistoryPage, DesktopError> {
    let path = relative_path(Path::new(&repo.root_path), relative_path_value, true)?;
    let cursor = match cursor {
        Some(value) => {
            let cursor = decode_file_history_cursor(value)?;
            if cursor.repo_id != repo.id || cursor.path != path || cursor.vcs != repo.kind {
                return Err(DesktopError::new(
                    "FILE_HISTORY_CURSOR_CONTEXT_MISMATCH",
                    "File history cursor belongs to another repository or path",
                    false,
                ));
            }
            cursor
        }
        None => {
            let anchor_revision = match repo.kind {
                VcsKind::Git => git(vec!["rev-parse".into(), "HEAD".into()], repo, token)
                    .await?
                    .stdout_text()
                    .trim()
                    .to_string(),
                VcsKind::Svn => svn(
                    vec![
                        "info".into(),
                        "--show-item".into(),
                        "revision".into(),
                        "--".into(),
                        format!("{}@", path),
                    ],
                    repo,
                    token,
                )
                .await?
                .stdout_text()
                .trim()
                .to_string(),
            };
            FileHistoryCursor {
                repo_id: repo.id.clone(),
                path: path.clone(),
                vcs: repo.kind,
                offset: 0,
                peg_revision: (repo.kind == VcsKind::Svn).then(|| anchor_revision.clone()),
                anchor_revision,
            }
        }
    };
    let skip = cursor.offset;
    let limit = limit.clamp(1, 200);
    match repo.kind {
        VcsKind::Git => {
            let format = format!("{RECORD}%H{FIELD}%P{FIELD}%an{FIELD}%aI{FIELD}%s");
            let output = git(
                vec![
                    "log".into(),
                    "--follow".into(),
                    "--find-renames=1%".into(),
                    "--find-copies=1%".into(),
                    "--find-copies-harder".into(),
                    "--name-status".into(),
                    format!("--format={format}"),
                    format!("--max-count={}", skip + limit + 1),
                    cursor.anchor_revision.clone(),
                    "--".into(),
                    path.clone(),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text();
            let mut entries = parse_git_file_history(&output, &path);
            if skip > 0 {
                entries.drain(..entries.len().min(skip as usize));
            }
            let has_more = entries.len() > limit as usize;
            entries.truncate(limit as usize);
            Ok(FileHistoryPage {
                entries,
                next_cursor: has_more
                    .then(|| {
                        encode_file_history_cursor(&FileHistoryCursor {
                            offset: skip + limit,
                            ..cursor
                        })
                    })
                    .transpose()?,
            })
        }
        VcsKind::Svn => {
            let output = svn(
                vec![
                    "log".into(),
                    "--xml".into(),
                    "--verbose".into(),
                    "--limit".into(),
                    (skip + limit + 1).to_string(),
                    "--revision".into(),
                    format!("{}:1", cursor.anchor_revision),
                    "--".into(),
                    format!(
                        "{}@{}",
                        path,
                        cursor.peg_revision.as_deref().unwrap_or("HEAD")
                    ),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text();
            let document = roxmltree::Document::parse(&output)
                .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
            let mut entries = Vec::new();
            for node in document
                .descendants()
                .filter(|node| node.has_tag_name("logentry"))
            {
                let revision = node.attribute("revision").unwrap_or_default().to_string();
                if revision.is_empty() {
                    continue;
                }
                let author = node
                    .children()
                    .find(|item| item.has_tag_name("author"))
                    .and_then(|item| item.text())
                    .unwrap_or_default()
                    .to_string();
                let date = node
                    .children()
                    .find(|item| item.has_tag_name("date"))
                    .and_then(|item| item.text())
                    .unwrap_or_default()
                    .to_string();
                let message = node
                    .children()
                    .find(|item| item.has_tag_name("msg"))
                    .and_then(|item| item.text())
                    .unwrap_or_default()
                    .to_string();
                let changed = node
                    .descendants()
                    .find(|item| item.has_tag_name("path") && item.text().is_some());
                let status = changed
                    .and_then(|item| item.attribute("action"))
                    .unwrap_or("M")
                    .to_string();
                entries.push(FileHistoryEntry {
                    previous_revision: revision
                        .parse::<u64>()
                        .ok()
                        .and_then(|value| value.checked_sub(1))
                        .map(|value| value.to_string()),
                    revision,
                    path: path.clone(),
                    previous_path: None,
                    author,
                    date,
                    message,
                    status,
                });
            }
            if skip > 0 {
                entries.drain(..entries.len().min(skip as usize));
            }
            let has_more = entries.len() > limit as usize;
            entries.truncate(limit as usize);
            Ok(FileHistoryPage {
                entries,
                next_cursor: has_more
                    .then(|| {
                        encode_file_history_cursor(&FileHistoryCursor {
                            offset: skip + limit,
                            ..cursor
                        })
                    })
                    .transpose()?,
            })
        }
    }
}

fn parse_git_file_history(output: &str, initial_path: &str) -> Vec<FileHistoryEntry> {
    let mut entries = Vec::new();
    let mut current_path = initial_path.to_string();
    for record in output
        .split(RECORD)
        .filter(|value| !value.trim().is_empty())
    {
        let mut lines = record.trim().lines();
        let Some(header) = lines.next() else {
            continue;
        };
        let fields = header.split(FIELD).collect::<Vec<_>>();
        if fields.len() < 5 {
            continue;
        }
        let changed = lines.find(|line| !line.trim().is_empty()).unwrap_or("M");
        let parts = changed.split('\t').collect::<Vec<_>>();
        let status = parts.first().copied().unwrap_or("M").to_string();
        let moved_or_copied =
            if (status.starts_with('R') || status.starts_with('C')) && parts.len() >= 3 {
                Some((parts[1], parts[2]))
            } else {
                None
            };
        let path_at_revision = moved_or_copied
            .map(|(_, next)| next.to_string())
            .or_else(|| parts.get(1).map(|value| (*value).to_string()))
            .unwrap_or_else(|| current_path.clone());
        let previous_path = moved_or_copied.map(|(previous, _)| previous.to_string());
        entries.push(FileHistoryEntry {
            revision: fields[0].to_string(),
            previous_revision: fields[1].split_whitespace().next().map(str::to_string),
            path: path_at_revision.clone(),
            previous_path: previous_path.clone(),
            author: fields[2].to_string(),
            date: fields[3].to_string(),
            message: fields[4].to_string(),
            status,
        });
        current_path = previous_path.unwrap_or(path_at_revision);
    }
    entries
}

pub async fn file_revision_content(
    repo: &RepositoryMeta,
    relative_path_value: &str,
    revision: &str,
    token: &CancellationToken,
) -> Result<FileRevisionDocument, DesktopError> {
    let path = relative_path(Path::new(&repo.root_path), relative_path_value, true)?;
    match repo.kind {
        VcsKind::Git => validate_revision(revision)?,
        VcsKind::Svn => validate_svn_revision(revision)?,
    }
    let bytes = match repo.kind {
        VcsKind::Git => {
            git(
                vec!["show".into(), format!("{revision}:{path}")],
                repo,
                token,
            )
            .await?
            .stdout
        }
        VcsKind::Svn => {
            svn(
                vec![
                    "cat".into(),
                    "-r".into(),
                    revision.into(),
                    "--".into(),
                    format!("{path}@{revision}"),
                ],
                repo,
                token,
            )
            .await?
            .stdout
        }
    };
    let binary = bytes_are_binary(&bytes);
    let truncated = bytes.len() > DIFF_MAX_BYTES;
    let content = if binary || truncated {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(FileRevisionDocument {
        revision: revision.into(),
        path,
        content,
        binary,
        truncated,
    })
}

pub async fn abort_operation(
    repo: &RepositoryMeta,
    operation: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if repo.kind == VcsKind::Svn {
        if operation != "merge" {
            return Err(DesktopError::new(
                "OPERATION_NOT_ACTIVE",
                "The requested SVN operation is not active",
                true,
            ));
        }
        let pending = svn_merges()
            .lock()
            .ok()
            .and_then(|merges| merges.get(&repo.id).cloned())
            .ok_or_else(|| {
                DesktopError::new(
                    "OPERATION_NOT_ACTIVE",
                    "No VersionDock-managed SVN merge is active",
                    true,
                )
            })?;
        if !pending.paths.is_empty() {
            let mut args = vec![
                "revert".into(),
                "--depth".into(),
                "infinity".into(),
                "--".into(),
            ];
            args.extend(pending.paths.iter().cloned());
            svn(args, repo, token).await?;
        }
        for path in &pending.added_paths {
            let target = safe_relative(Path::new(&repo.root_path), path, true)?;
            let Ok(metadata) = std::fs::symlink_metadata(&target) else {
                continue;
            };
            if metadata.is_dir() {
                std::fs::remove_dir_all(&target)
            } else {
                std::fs::remove_file(&target)
            }
            .map_err(|error| DesktopError::new("SVN_ABORT_FAILED", error.to_string(), true))?;
        }
        if let Ok(mut merges) = svn_merges().lock() {
            merges.remove(&repo.id);
        }
        return Ok(());
    }
    let args = match operation {
        "merge" => vec!["merge".into(), "--abort".into()],
        "rebase" => vec!["rebase".into(), "--abort".into()],
        "cherry-pick" => vec!["cherry-pick".into(), "--abort".into()],
        _ => {
            return Err(DesktopError::new(
                "OPERATION_NOT_ACTIVE",
                "The requested repository operation is not active",
                true,
            ))
        }
    };
    git(args, repo, token).await?;
    Ok(())
}

fn git_operation_name(root: &Path) -> Option<&'static str> {
    let marker = root.join(".git");
    let git_dir = if marker.is_dir() {
        marker
    } else {
        let value = std::fs::read_to_string(marker).ok()?;
        let target = value.trim().strip_prefix("gitdir: ")?;
        let target = Path::new(target);
        if target.is_absolute() {
            target.to_path_buf()
        } else {
            root.join(target)
        }
    };
    if git_dir.join("MERGE_HEAD").exists() {
        Some("merge")
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("rebase")
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick")
    } else {
        None
    }
}

pub async fn restore_conflicts(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<RestoreConflictsResult, DesktopError> {
    ensure_git(repo)?;
    let root = Path::new(&repo.root_path);
    if let Some(operation) = git_operation_name(root) {
        return Err(DesktopError::new(
            "OPERATION_IN_PROGRESS",
            format!("Cannot restore conflicts while {operation} is in progress"),
            true,
        ));
    }
    let output = git(
        vec![
            "diff".into(),
            "--name-only".into(),
            "--diff-filter=U".into(),
            "-z".into(),
        ],
        repo,
        token,
    )
    .await?;
    let paths = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Err(DesktopError::new(
            "NO_RESTORABLE_CONFLICTS",
            "No restorable Git conflicts were found",
            true,
        ));
    }
    let mut result = RestoreConflictsResult {
        restored_paths: Vec::new(),
        failures: Vec::new(),
    };
    for path in paths {
        let safe = match relative_path(root, &path, true) {
            Ok(value) => value,
            Err(error) => {
                result.failures.push(RestoreConflictFailure { path, error });
                continue;
            }
        };
        let pathspec = format!(":(literal){safe}");
        let tracked = git(
            vec![
                "ls-tree".into(),
                "-r".into(),
                "--name-only".into(),
                "HEAD".into(),
                "--".into(),
                pathspec.clone(),
            ],
            repo,
            token,
        )
        .await
        .is_ok_and(|value| !value.stdout_text().trim().is_empty());
        let restored = if tracked {
            git(
                vec![
                    "restore".into(),
                    "--source=HEAD".into(),
                    "--staged".into(),
                    "--worktree".into(),
                    "--".into(),
                    pathspec,
                ],
                repo,
                token,
            )
            .await
            .map(|_| ())
        } else {
            let removed_index = git(
                vec![
                    "rm".into(),
                    "-f".into(),
                    "--cached".into(),
                    "--ignore-unmatch".into(),
                    "--".into(),
                    pathspec,
                ],
                repo,
                token,
            )
            .await
            .map(|_| ());
            if removed_index.is_ok() {
                let target = match safe_relative(root, &safe, true) {
                    Ok(value) => value,
                    Err(error) => {
                        result
                            .failures
                            .push(RestoreConflictFailure { path: safe, error });
                        continue;
                    }
                };
                if target.exists() {
                    let metadata = std::fs::symlink_metadata(&target).map_err(|error| {
                        DesktopError::new("RESTORE_CONFLICT_FAILED", error.to_string(), true)
                    })?;
                    let removal = if metadata.is_dir() {
                        std::fs::remove_dir_all(&target)
                    } else {
                        std::fs::remove_file(&target)
                    };
                    removal.map_err(|error| {
                        DesktopError::new("RESTORE_CONFLICT_FAILED", error.to_string(), true)
                    })?;
                }
            }
            removed_index
        };
        match restored {
            Ok(()) => result.restored_paths.push(safe),
            Err(error) => result
                .failures
                .push(RestoreConflictFailure { path: safe, error }),
        }
    }
    Ok(result)
}

async fn prepare_svn_commit(
    repo: &RepositoryMeta,
    paths: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if paths.is_empty() {
        return Ok(());
    }
    let root = Path::new(&repo.root_path);
    let status = svn(vec!["status".into(), "--xml".into()], repo, token)
        .await?
        .stdout_text();
    let document = roxmltree::Document::parse(&status)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let selected = paths
        .iter()
        .map(|path| relative_path(root, path, true))
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    for entry in document
        .descendants()
        .filter(|node| node.has_tag_name("entry"))
    {
        let Some(path) = entry.attribute("path") else {
            continue;
        };
        let normalized = path.replace('\\', "/");
        if !selected.contains(&normalized) {
            continue;
        }
        let item = entry
            .children()
            .find(|node| node.has_tag_name("wc-status"))
            .and_then(|node| node.attribute("item"))
            .unwrap_or("normal");
        if item == "unversioned" {
            svn(
                vec!["add".into(), "--parents".into(), "--".into(), normalized],
                repo,
                token,
            )
            .await?;
        } else if item == "missing" {
            svn(
                vec!["delete".into(), "--force".into(), "--".into(), normalized],
                repo,
                token,
            )
            .await?;
        }
    }
    Ok(())
}

fn explicit_remote_branch(
    remote: Option<&str>,
    branch: Option<&str>,
) -> Result<Option<(String, String)>, DesktopError> {
    let Some(remote) = remote else {
        return Ok(None);
    };
    let Some(branch) = branch else {
        return Err(DesktopError::new(
            "REMOTE_BRANCH_INVALID",
            "A remote branch is required when a remote is selected",
            true,
        ));
    };
    validate_ref(remote)?;
    validate_ref(branch)?;
    let short = branch.trim_start_matches("refs/remotes/");
    let Some(remote_branch) = short.strip_prefix(&format!("{remote}/")) else {
        return Err(DesktopError::new(
            "REMOTE_BRANCH_INVALID",
            format!("Remote branch {branch} does not belong to {remote}"),
            true,
        ));
    };
    validate_ref(remote_branch)?;
    Ok(Some((remote.into(), remote_branch.into())))
}

async fn pull_non_current_branch(
    repo: &RepositoryMeta,
    branch: &str,
    token: &CancellationToken,
) -> Result<SyncResult, DesktopError> {
    validate_ref(branch)?;
    let full_ref = format!("refs/heads/{branch}");
    let raw = git(
        vec![
            "for-each-ref".into(),
            "--format=%(upstream:remotename)%00%(upstream:remoteref)".into(),
            full_ref.clone(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let mut fields = raw.trim().split('\0');
    let remote = fields.next().unwrap_or_default().trim();
    let upstream = fields.next().unwrap_or_default().trim();
    if remote.is_empty() || upstream.is_empty() {
        return Ok(SyncResult {
            output: format!("No remote tracking branch for {branch} — skipped"),
            update: None,
        });
    }
    validate_ref(remote)?;
    validate_ref(upstream)?;
    git_network(
        vec![
            "fetch".into(),
            remote.into(),
            format!("{upstream}:{full_ref}"),
        ],
        repo,
        token,
    )
    .await?;
    Ok(SyncResult {
        output: format!("pulled {branch}"),
        update: None,
    })
}

pub async fn sync(
    repo: &RepositoryMeta,
    action: SyncAction,
    remote: Option<String>,
    branch: Option<String>,
    token: &CancellationToken,
) -> Result<SyncResult, DesktopError> {
    if repo.kind == VcsKind::Git && matches!(action, SyncAction::Push) {
        return Ok(SyncResult {
            output: git_push(repo, remote, token).await?,
            update: None,
        });
    }
    if repo.kind == VcsKind::Git
        && matches!(action, SyncAction::Pull | SyncAction::PullRebase)
        && (git_has_conflicts(repo, token).await
            || git_operation_name(Path::new(&repo.root_path)).is_some())
    {
        return Err(DesktopError::new(
            "GIT_UPDATE_BLOCKED",
            "Cannot pull while conflicts are unresolved or another Git operation is in progress. Resolve, continue, or abort it first.",
            true,
        ));
    }
    if repo.kind == VcsKind::Svn {
        if let Some(branch_name) = branch.as_deref() {
            let relative = svn_relative_url(repo, token).await?;
            let (current, _) = svn_display_ref(&relative);
            let requested = branch_name
                .trim_start_matches("branches/")
                .trim_start_matches("tags/");
            let current = current.trim_start_matches("tags/");
            if requested != current {
                return Err(DesktopError::new(
                    "SVN_UPDATE_BRANCH_MISMATCH",
                    "SVN Update can only update the currently switched working-copy branch",
                    true,
                ));
            }
        }
    }
    let captures_update = matches!(
        action,
        SyncAction::Pull | SyncAction::PullRebase | SyncAction::Update
    );
    let before_revision = if captures_update {
        current_revision(repo, token).await.unwrap_or_default()
    } else {
        String::new()
    };
    let before_status = if captures_update {
        status_fingerprint(repo, token).await.unwrap_or_default()
    } else {
        String::new()
    };
    let explicit_remote_branch = if repo.kind == VcsKind::Git {
        explicit_remote_branch(remote.as_deref(), branch.as_deref())?
    } else {
        None
    };
    if repo.kind == VcsKind::Git {
        if let Some(branch_name) = branch.as_deref() {
            validate_ref(branch_name)?;
            let current = git(vec!["branch".into(), "--show-current".into()], repo, token)
                .await?
                .stdout_text()
                .trim()
                .to_string();
            if explicit_remote_branch.is_none() && !current.is_empty() && current != branch_name {
                return pull_non_current_branch(repo, branch_name, token).await;
            }
        }
    }
    if repo.kind == VcsKind::Git
        && matches!(action, SyncAction::Pull | SyncAction::PullRebase)
        && explicit_remote_branch.is_none()
    {
        let has_upstream = git(
            vec![
                "rev-parse".into(),
                "--abbrev-ref".into(),
                "--symbolic-full-name".into(),
                "@{u}".into(),
            ],
            repo,
            token,
        )
        .await
        .is_ok();
        if !has_upstream {
            return Ok(SyncResult {
                output: "No remote tracking branch — skipped".into(),
                update: Some(RepositoryUpdateResult {
                    repo_id: repo.id.clone(),
                    before_revision: before_revision.clone(),
                    after_revision: before_revision,
                    summary: Some(UpdateSummary {
                        kind: UpdateKind::NoChanges,
                        commit_count: 0,
                        file_count: 0,
                        contains_merge: false,
                        detail: UpdateDetail {
                            commits: Vec::new(),
                            files: Vec::new(),
                        },
                    }),
                    summary_error: None,
                    before_status: before_status.clone(),
                    after_status: before_status,
                }),
            });
        }
    }
    let (program, args) = match (repo.kind, action) {
        (VcsKind::Git, SyncAction::Fetch) => (
            "git",
            vec!["fetch".into(), "--all".into(), "--prune".into()],
        ),
        (VcsKind::Git, SyncAction::Pull | SyncAction::PullRebase) => {
            let mut args = vec!["pull".into()];
            if matches!(action, SyncAction::PullRebase) {
                args.push("--rebase".into());
            } else {
                args.extend(["--no-rebase".into(), "--ff".into()]);
            }
            if let Some((remote_name, remote_branch)) = explicit_remote_branch {
                args.extend([remote_name, remote_branch]);
            }
            ("git", args)
        }
        (VcsKind::Git, SyncAction::Push) => unreachable!(),
        (VcsKind::Svn, SyncAction::Update) | (VcsKind::Svn, SyncAction::Pull) => {
            ("svn", vec!["update".into()])
        }
        _ => {
            return Err(DesktopError::new(
                "UNSUPPORTED_OPERATION",
                "Operation is not supported by this repository",
                false,
            ))
        }
    };
    let mut safe = Vec::new();
    if program == "git" {
        safe.extend(["-c".into(), "core.quotepath=false".into()]);
    } else {
        safe.push("--non-interactive".into());
    }
    safe.extend(args);
    let auto_stash = if repo.kind == VcsKind::Git && captures_update {
        create_pull_auto_stash(repo, token).await?
    } else {
        None
    };
    let operation = cli::run(
        program,
        &safe,
        Path::new(&repo.root_path),
        None,
        cli::NETWORK_TIMEOUT,
        token,
    )
    .await;
    let output = match operation {
        Ok(output) => output.stdout_text(),
        Err(error) => {
            if let Some(auto_stash) = auto_stash.as_ref() {
                if git_has_conflicts(repo, token).await
                    || git_operation_name(Path::new(&repo.root_path)).is_some()
                {
                    return Err(pull_auto_stash_error(
                        "GIT_PULL_CONFLICT_WITH_AUTO_STASH",
                        format!(
                            "Update stopped with conflicts. Local tracked changes remain safe in VersionDock auto-stash {}. Resolve or abort the update, then restore the stash from the Stash panel.",
                            auto_stash.short_hash
                        ),
                        auto_stash,
                        Some(error),
                    ));
                }
                restore_pull_auto_stash(repo, auto_stash, token)
                    .await
                    .map_err(|restore_error| {
                        pull_auto_stash_error(
                            "GIT_PULL_FAILED_RESTORE_FAILED",
                            format!(
                                "Update failed, and VersionDock could not restore local changes from auto-stash {}.",
                                auto_stash.short_hash
                            ),
                            auto_stash,
                            Some(restore_error),
                        )
                    })?;
            }
            return Err(error);
        }
    };
    if let Some(auto_stash) = auto_stash.as_ref() {
        if let Err(error) = restore_pull_auto_stash(repo, auto_stash, token).await {
            let code = if git_has_conflicts(repo, token).await || git_has_conflict_error(&error) {
                "GIT_AUTO_STASH_CONFLICT"
            } else {
                "GIT_AUTO_STASH_RESTORE_FAILED"
            };
            return Err(pull_auto_stash_error(
                code,
                format!(
                    "Update completed, but VersionDock could not restore local changes from auto-stash {}. The stash was kept for recovery.",
                    auto_stash.short_hash
                ),
                auto_stash,
                Some(error),
            ));
        }
    }
    if !captures_update {
        return Ok(SyncResult {
            output,
            update: None,
        });
    }
    let after_result = current_revision(repo, token).await;
    let after_revision = after_result
        .as_ref()
        .cloned()
        .unwrap_or_else(|_| before_revision.clone());
    let after_status = status_fingerprint(repo, token)
        .await
        .unwrap_or_else(|_| before_status.clone());
    let summary = match after_result {
        Ok(_) => update_summary(repo, &before_revision, &after_revision, token).await,
        Err(error) => Err(error),
    };
    let (summary, summary_error) = match summary {
        Ok(summary) => (Some(summary), None),
        Err(error) => (None, Some(error)),
    };
    Ok(SyncResult {
        output,
        update: Some(RepositoryUpdateResult {
            repo_id: repo.id.clone(),
            before_revision,
            after_revision,
            summary,
            summary_error,
            before_status,
            after_status,
        }),
    })
}

#[derive(Debug, Clone)]
struct PullAutoStash {
    hash: String,
    short_hash: String,
}

async fn pull_stash_head(repo: &RepositoryMeta, token: &CancellationToken) -> Option<String> {
    git(
        vec!["rev-parse".into(), "--verify".into(), "refs/stash".into()],
        repo,
        token,
    )
    .await
    .ok()
    .map(|output| output.stdout_text().trim().to_string())
    .filter(|value| !value.is_empty())
}

async fn create_pull_auto_stash(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Option<PullAutoStash>, DesktopError> {
    let tracked_status = git(
        vec![
            "status".into(),
            "--porcelain=v1".into(),
            "--untracked-files=no".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    if tracked_status.trim().is_empty() {
        return Ok(None);
    }
    let before = pull_stash_head(repo, token).await;
    let marker = format!(
        "versiondock-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    );
    git(
        vec![
            "stash".into(),
            "push".into(),
            "--message".into(),
            format!("VersionDock automatic stash before update ({marker})"),
        ],
        repo,
        token,
    )
    .await?;
    let after = pull_stash_head(repo, token).await;
    let Some(hash) = after.filter(|hash| Some(hash) != before.as_ref()) else {
        // A dirty submodule may not create a superproject stash. Leave it in
        // place and let Git decide whether the update is safe.
        return Ok(None);
    };
    Ok(Some(PullAutoStash {
        short_hash: hash.chars().take(12).collect(),
        hash,
    }))
}

async fn pull_auto_stash_ref(
    repo: &RepositoryMeta,
    hash: &str,
    token: &CancellationToken,
) -> Result<Option<String>, DesktopError> {
    let output = git(
        vec!["stash".into(), "list".into(), "--format=%H%x00%gd".into()],
        repo,
        token,
    )
    .await?
    .stdout_text();
    Ok(output.lines().find_map(|line| {
        let (candidate, reference) = line.split_once('\0')?;
        (candidate == hash).then(|| reference.to_string())
    }))
}

async fn restore_pull_auto_stash(
    repo: &RepositoryMeta,
    auto_stash: &PullAutoStash,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let reference = pull_auto_stash_ref(repo, &auto_stash.hash, token)
        .await?
        .ok_or_else(|| {
            DesktopError::new(
                "GIT_AUTO_STASH_MISSING",
                format!(
                    "VersionDock auto-stash {} could not be found. Check the Stash panel before making further changes.",
                    auto_stash.short_hash
                ),
                true,
            )
        })?;
    git(
        vec!["stash".into(), "pop".into(), "--index".into(), reference],
        repo,
        token,
    )
    .await?;
    Ok(())
}

fn git_has_conflict_error(error: &DesktopError) -> bool {
    let detail = format!(
        "{}\n{}",
        error.message,
        error.stderr.as_deref().unwrap_or_default()
    )
    .to_ascii_lowercase();
    detail.contains("conflict") || detail.contains("needs merge")
}

fn pull_auto_stash_error(
    code: &str,
    message: String,
    auto_stash: &PullAutoStash,
    cause: Option<DesktopError>,
) -> DesktopError {
    DesktopError {
        code: code.into(),
        message,
        command: cause.as_ref().and_then(|error| error.command.clone()),
        exit_code: cause.as_ref().and_then(|error| error.exit_code),
        stderr: cause.as_ref().and_then(|error| error.stderr.clone()),
        recoverable: true,
        operation: Some("pull".into()),
        workspace_id: None,
        repository_id: None,
        subject: Some(format!("stash:{}", auto_stash.hash)),
        hint: Some("Open Conflicts, resolve the working copy, and keep the retained stash until the restored changes are verified".into()),
    }
}

async fn status_fingerprint(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let raw = match repo.kind {
        VcsKind::Git => {
            git(
                vec!["status".into(), "--porcelain=v1".into(), "-z".into()],
                repo,
                token,
            )
            .await?
            .stdout
        }
        VcsKind::Svn => {
            svn(vec!["status".into(), "--xml".into()], repo, token)
                .await?
                .stdout
        }
    };
    Ok(hex::encode(Sha256::digest(raw)))
}

async fn current_revision(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    match repo.kind {
        VcsKind::Git => Ok(git(
            vec!["rev-parse".into(), "--verify".into(), "HEAD".into()],
            repo,
            token,
        )
        .await?
        .stdout_text()
        .trim()
        .into()),
        VcsKind::Svn => {
            let raw = svn(vec!["info".into(), "--xml".into()], repo, token)
                .await?
                .stdout_text();
            let document = roxmltree::Document::parse(&raw)
                .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
            document
                .descendants()
                .find(|node| node.has_tag_name("entry"))
                .and_then(|node| node.attribute("revision"))
                .map(String::from)
                .ok_or_else(|| {
                    DesktopError::new("SVN_REVISION_MISSING", "Unable to read SVN revision", true)
                })
        }
    }
}

async fn update_summary(
    repo: &RepositoryMeta,
    before: &str,
    after: &str,
    token: &CancellationToken,
) -> Result<UpdateSummary, DesktopError> {
    if before == after {
        return Ok(UpdateSummary {
            kind: UpdateKind::NoChanges,
            commit_count: 0,
            file_count: 0,
            contains_merge: false,
            detail: UpdateDetail {
                commits: Vec::new(),
                files: Vec::new(),
            },
        });
    }
    match repo.kind {
        VcsKind::Git => {
            validate_revision(before)?;
            validate_revision(after)?;
            let format = format!("%H{FIELD}%h{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%aI{FIELD}%cI{FIELD}%s{FIELD}%D{RECORD}");
            let range = format!("{before}..{after}");
            let (raw, stats, statuses) = tokio::try_join!(
                async {
                    Ok::<_, DesktopError>(
                        git(
                            vec![
                                "log".into(),
                                "--date-order".into(),
                                format!("--format={format}"),
                                range.clone(),
                            ],
                            repo,
                            token,
                        )
                        .await?
                        .stdout_text(),
                    )
                },
                async {
                    Ok::<_, DesktopError>(
                        git(
                            vec![
                                "diff".into(),
                                "--numstat".into(),
                                before.into(),
                                after.into(),
                                "--".into(),
                            ],
                            repo,
                            token,
                        )
                        .await?
                        .stdout_text(),
                    )
                },
                async {
                    Ok::<_, DesktopError>(
                        git(
                            vec![
                                "diff".into(),
                                "--name-status".into(),
                                before.into(),
                                after.into(),
                                "--".into(),
                            ],
                            repo,
                            token,
                        )
                        .await?
                        .stdout_text(),
                    )
                },
            )?;
            let commits = parse_git_log(&repo.id, &raw);
            let files = merge_git_files(&stats, &statuses);
            Ok(UpdateSummary {
                kind: UpdateKind::FastForward,
                commit_count: commits.len() as u32,
                file_count: files.len() as u32,
                contains_merge: commits.iter().any(|commit| commit.parents.len() > 1),
                detail: UpdateDetail { commits, files },
            })
        }
        VcsKind::Svn => {
            validate_svn_revision(before)?;
            validate_svn_revision(after)?;
            let start = before.parse::<u64>().unwrap_or(0).saturating_add(1);
            let raw = svn(
                vec![
                    "log".into(),
                    "--xml".into(),
                    "--verbose".into(),
                    "-r".into(),
                    format!("{after}:{start}"),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text();
            let document = roxmltree::Document::parse(&raw)
                .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
            let mut files = std::collections::BTreeMap::<String, CommitFile>::new();
            let mut commits = Vec::new();
            for entry in document
                .descendants()
                .filter(|node| node.has_tag_name("logentry"))
            {
                let revision = entry.attribute("revision").unwrap_or("");
                let text = |name| {
                    entry
                        .children()
                        .find(|child| child.has_tag_name(name))
                        .and_then(|child| child.text())
                        .unwrap_or("")
                };
                let message = text("msg");
                commits.push(CommitNode {
                    repo_id: repo.id.clone(),
                    hash: revision.into(),
                    short_hash: format!("r{revision}"),
                    parents: Vec::new(),
                    author: text("author").into(),
                    email: String::new(),
                    author_date: text("date").into(),
                    committer_date: text("date").into(),
                    message: message.lines().next().unwrap_or("").into(),
                    refs: Vec::new(),
                    incoming: false,
                    unpushed: false,
                });
                for path in entry.descendants().filter(|node| node.has_tag_name("path")) {
                    if let Some(value) = path.text() {
                        let value = value.trim_start_matches('/').to_string();
                        files.entry(value.clone()).or_insert(CommitFile {
                            path: value,
                            status: path.attribute("action").unwrap_or("M").into(),
                            added: None,
                            removed: None,
                        });
                    }
                }
            }
            let files = files.into_values().collect::<Vec<_>>();
            Ok(UpdateSummary {
                kind: UpdateKind::Updated,
                commit_count: commits.len() as u32,
                file_count: files.len() as u32,
                contains_merge: false,
                detail: UpdateDetail { commits, files },
            })
        }
    }
}

async fn git_push(
    repo: &RepositoryMeta,
    requested_remote: Option<String>,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    if let Some(remote) = requested_remote {
        validate_ref(&remote)?;
        return Ok(git(vec!["push".into(), remote], repo, token)
            .await?
            .stdout_text());
    }
    if git(
        vec![
            "rev-parse".into(),
            "--abbrev-ref".into(),
            "--symbolic-full-name".into(),
            "@{upstream}".into(),
        ],
        repo,
        token,
    )
    .await
    .is_ok()
    {
        return Ok(git(vec!["push".into()], repo, token).await?.stdout_text());
    }
    let branch = git(
        vec!["symbolic-ref".into(), "--short".into(), "HEAD".into()],
        repo,
        token,
    )
    .await?
    .stdout_text()
    .trim()
    .to_string();
    validate_ref(&branch)?;
    let remotes = git(vec!["remote".into()], repo, token)
        .await?
        .stdout_text()
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
        .collect::<Vec<_>>();
    let remote = if remotes.iter().any(|value| value == "origin") {
        "origin".to_string()
    } else if remotes.len() == 1 {
        remotes[0].clone()
    } else {
        return Err(DesktopError::new(
            "PUSH_REMOTE_REQUIRED",
            "The branch has no upstream and no unambiguous remote is available",
            true,
        ));
    };
    validate_ref(&remote)?;
    Ok(git(
        vec!["push".into(), "--set-upstream".into(), remote, branch],
        repo,
        token,
    )
    .await?
    .stdout_text())
}

pub async fn history(
    repo: &RepositoryMeta,
    skip: u32,
    limit: u32,
    query: HistoryQuery,
    token: &CancellationToken,
) -> Result<HistoryPage, DesktopError> {
    let limit = limit.clamp(1, 1_000);
    match repo.kind {
        VcsKind::Git => git_history(repo, skip, limit, query, token).await,
        VcsKind::Svn => svn_history(repo, skip, limit, query, token).await,
    }
}

pub async fn history_topology(
    repo: &RepositoryMeta,
    svn_limit: u32,
    revision: Option<String>,
    token: &CancellationToken,
) -> Result<Vec<GraphCommitNode>, DesktopError> {
    match repo.kind {
        VcsKind::Git => git_history_topology(repo, revision, token).await,
        VcsKind::Svn => svn_history_topology(repo, svn_limit.clamp(1, 5_000), token).await,
    }
}

pub async fn unpushed_commits(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<UnpushedCommit>, DesktopError> {
    ensure_git(repo)?;
    let has_upstream = git(
        vec![
            "rev-parse".into(),
            "--abbrev-ref".into(),
            "--symbolic-full-name".into(),
            "@{upstream}".into(),
        ],
        repo,
        token,
    )
    .await
    .is_ok();

    let mut range = if has_upstream {
        vec!["@{upstream}..HEAD".into()]
    } else {
        let remotes = git(vec!["remote".into()], repo, token).await?.stdout_text();
        if remotes.lines().any(|line| !line.trim().is_empty()) {
            vec!["HEAD".into(), "--not".into(), "--remotes".into()]
        } else {
            vec!["HEAD".into()]
        }
    };
    range.push("--max-count=100".into());
    range.push(format!(
        "--format={RECORD}%H{FIELD}%h{FIELD}%s{FIELD}%an{FIELD}%aI"
    ));
    range.push("--shortstat".into());
    let raw = git(
        std::iter::once("log".into()).chain(range).collect(),
        repo,
        token,
    )
    .await?
    .stdout_text();

    Ok(raw
        .split(RECORD)
        .filter_map(|record| {
            let mut lines = record.lines().filter(|line| !line.trim().is_empty());
            let fields = lines.next()?.split(FIELD).collect::<Vec<_>>();
            if fields.len() < 5 || fields[0].is_empty() {
                return None;
            }
            let stat = lines.find(|line| line.contains("changed"));
            let number_before = |needle: &str| -> u32 {
                stat.and_then(|line| {
                    line.split(',').find_map(|part| {
                        let trimmed = part.trim();
                        trimmed
                            .contains(needle)
                            .then(|| trimmed.split_whitespace().next()?.parse().ok())
                            .flatten()
                    })
                })
                .unwrap_or(0)
            };
            Some(UnpushedCommit {
                hash: fields[0].into(),
                short_hash: fields[1].into(),
                message: fields[2].into(),
                author: fields[3].into(),
                date: fields[4].into(),
                files_changed: number_before("file changed").max(number_before("files changed")),
                additions: number_before("insertion"),
                deletions: number_before("deletion"),
            })
        })
        .collect())
}

pub async fn unpushed_operation(
    repo: &RepositoryMeta,
    operation: UnpushedOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    match operation {
        UnpushedOperation::UndoHead => {
            git(
                vec!["reset".into(), "--soft".into(), "HEAD^".into()],
                repo,
                token,
            )
            .await?;
        }
        UnpushedOperation::EditMessage { hash, message } => {
            ensure_clean_worktree(repo, token).await?;
            validate_revision(&hash)?;
            let head = git(vec!["rev-parse".into(), "HEAD".into()], repo, token)
                .await?
                .stdout_text()
                .trim()
                .to_string();
            if head != hash {
                return Err(DesktopError::new(
                    "COMMIT_NOT_HEAD",
                    "Only the HEAD commit message can be edited safely",
                    false,
                ));
            }
            let message = validate_message(&message)?;
            cli::run(
                "git",
                &["commit".into(), "--amend".into(), "--file=-".into()],
                Path::new(&repo.root_path),
                Some(message.as_bytes()),
                cli::DEFAULT_TIMEOUT,
                token,
            )
            .await?;
        }
        UnpushedOperation::Revert { hashes } => {
            ensure_clean_worktree(repo, token).await?;
            validate_commit_hashes(&hashes)?;
            let mut args = vec!["revert".into(), "--no-edit".into()];
            args.extend(hashes);
            git(args, repo, token).await?;
        }
        UnpushedOperation::Drop { hashes } => {
            ensure_clean_worktree(repo, token).await?;
            let (oldest, newest) = validate_contiguous_commits(repo, &hashes, false, token).await?;
            git(
                vec![
                    "rebase".into(),
                    "--onto".into(),
                    format!("{oldest}^"),
                    newest,
                    "HEAD".into(),
                ],
                repo,
                token,
            )
            .await?;
        }
        UnpushedOperation::Squash { hashes, message } => {
            ensure_clean_worktree(repo, token).await?;
            let (oldest, newest) = validate_contiguous_commits(repo, &hashes, true, token).await?;
            let head = git(vec!["rev-parse".into(), "HEAD".into()], repo, token)
                .await?
                .stdout_text()
                .trim()
                .to_string();
            if newest != head {
                return Err(DesktopError::new(
                    "SQUASH_REQUIRES_HEAD",
                    "Squash selection must include HEAD",
                    false,
                ));
            }
            git(
                vec!["reset".into(), "--soft".into(), format!("{oldest}^")],
                repo,
                token,
            )
            .await?;
            let message = validate_message(&message)?;
            cli::run(
                "git",
                &["commit".into(), "--file=-".into()],
                Path::new(&repo.root_path),
                Some(message.as_bytes()),
                cli::DEFAULT_TIMEOUT,
                token,
            )
            .await?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum CommitPathDirection {
    Apply,
    Revert,
}

fn commit_path_status(value: &str) -> Result<char, DesktopError> {
    let status = value
        .trim()
        .chars()
        .next()
        .map(|value| value.to_ascii_uppercase())
        .ok_or_else(|| DesktopError::new("INVALID_FILE_STATUS", "File status is empty", false))?;
    if matches!(status, 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U') {
        Ok(status)
    } else {
        Err(DesktopError::new(
            "INVALID_FILE_STATUS",
            format!("Unsupported commit file status: {value}"),
            false,
        ))
    }
}

fn remove_commit_working_path(root: &Path, path: &str) -> Result<(), DesktopError> {
    if path.trim().is_empty() || path == "." {
        return Err(DesktopError::new(
            "INVALID_FILE_PATH",
            "Repository root cannot be used as a commit file path",
            false,
        ));
    }
    let target = safe_relative(root, path, false)?;
    let metadata = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(DesktopError::new(
                "COMMIT_PATH_OPERATION_FAILED",
                error.to_string(),
                true,
            ));
        }
    };
    let result = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(&target)
    } else if metadata.is_file() || metadata.file_type().is_symlink() {
        std::fs::remove_file(&target)
    } else {
        return Err(DesktopError::new(
            "UNSUPPORTED_FILE_TYPE",
            format!("Unsupported file type: {path}"),
            false,
        ));
    };
    result
        .map_err(|error| DesktopError::new("COMMIT_PATH_OPERATION_FAILED", error.to_string(), true))
}

struct VerifiedCommitPathEntry {
    revision: String,
    path: String,
    status: char,
    previous_path: Option<String>,
}

async fn verify_commit_path_entry(
    repo: &RepositoryMeta,
    entry: CommitPathOperationEntry,
    token: &CancellationToken,
) -> Result<VerifiedCommitPathEntry, DesktopError> {
    validate_revision(&entry.revision)?;
    if entry.path.trim().is_empty() || entry.path == "." {
        return Err(DesktopError::new(
            "INVALID_FILE_PATH",
            "Repository root cannot be used as a commit file path",
            false,
        ));
    }
    let root = Path::new(&repo.root_path);
    let path = relative_path(root, &entry.path, false)?;
    let expected_status = commit_path_status(&entry.status)?;
    let output = git(
        vec![
            "diff-tree".into(),
            "--no-commit-id".into(),
            "--name-status".into(),
            "--root".into(),
            "-r".into(),
            "-M".into(),
            "-C".into(),
            "-z".into(),
            entry.revision.clone(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let fields = output
        .split('\0')
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let mut index = 0;
    while index < fields.len() {
        let actual_status = commit_path_status(fields[index])?;
        if matches!(actual_status, 'R' | 'C') {
            if index + 2 >= fields.len() {
                break;
            }
            let previous_path = relative_path(root, fields[index + 1], false)?;
            let current_path = relative_path(root, fields[index + 2], false)?;
            if current_path == path && actual_status == expected_status {
                return Ok(VerifiedCommitPathEntry {
                    revision: entry.revision,
                    path,
                    status: actual_status,
                    previous_path: Some(previous_path),
                });
            }
            index += 3;
        } else {
            if index + 1 >= fields.len() {
                break;
            }
            let current_path = relative_path(root, fields[index + 1], false)?;
            if current_path == path && actual_status == expected_status {
                return Ok(VerifiedCommitPathEntry {
                    revision: entry.revision,
                    path,
                    status: actual_status,
                    previous_path: None,
                });
            }
            index += 2;
        }
    }
    Err(DesktopError::new(
        "INVALID_COMMIT_PATH_OPERATION",
        format!(
            "Path '{}' is not a '{}' change in revision {}",
            entry.path, entry.status, entry.revision
        ),
        false,
    ))
}

async fn operate_commit_paths(
    repo: &RepositoryMeta,
    entries: Vec<CommitPathOperationEntry>,
    direction: CommitPathDirection,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if entries.is_empty() {
        return Ok(());
    }
    let root = Path::new(&repo.root_path);
    let mut seen = HashSet::new();
    let mut verified = Vec::new();
    for entry in entries {
        let value = verify_commit_path_entry(repo, entry, token).await?;
        if seen.insert((value.revision.clone(), value.path.clone())) {
            verified.push(value);
        }
    }
    for entry in verified {
        let source = match direction {
            CommitPathDirection::Apply => entry.revision.clone(),
            CommitPathDirection::Revert => format!("{}^", entry.revision),
        };
        let (restore_path, remove_paths): (Option<String>, Vec<String>) = match direction {
            CommitPathDirection::Apply => match entry.status {
                'D' => (None, vec![entry.path]),
                'R' => (Some(entry.path), entry.previous_path.into_iter().collect()),
                _ => (Some(entry.path), Vec::new()),
            },
            CommitPathDirection::Revert => match entry.status {
                'A' | 'C' => (None, vec![entry.path]),
                'R' => (entry.previous_path, vec![entry.path]),
                _ => (Some(entry.path), Vec::new()),
            },
        };
        for path in remove_paths {
            remove_commit_working_path(root, &path)?;
        }
        if let Some(path) = restore_path {
            git(
                vec![
                    "restore".into(),
                    "--source".into(),
                    source,
                    "--".into(),
                    format!(":(literal){path}"),
                ],
                repo,
                token,
            )
            .await?;
        }
    }
    Ok(())
}

pub async fn history_operation(
    repo: &RepositoryMeta,
    operation: HistoryOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    match operation {
        HistoryOperation::SvnUpdateTo { revision } => {
            if repo.kind != VcsKind::Svn {
                return Err(DesktopError::new(
                    "UNSUPPORTED_OPERATION",
                    "SVN revision update requires an SVN working copy",
                    false,
                ));
            }
            validate_svn_revision(&revision)?;
            svn(
                vec!["update".into(), "--revision".into(), revision, ".".into()],
                repo,
                token,
            )
            .await?;
        }
        operation => {
            ensure_git(repo)?;
            match operation {
                HistoryOperation::Checkout { revision } => {
                    validate_revision(&revision)?;
                    ensure_clean_worktree(repo, token).await?;
                    git(
                        vec!["switch".into(), "--detach".into(), revision],
                        repo,
                        token,
                    )
                    .await?;
                }
                HistoryOperation::CherryPick { revision } => {
                    validate_revision(&revision)?;
                    ensure_clean_worktree(repo, token).await?;
                    git(vec!["cherry-pick".into(), revision], repo, token).await?;
                }
                HistoryOperation::Revert { revisions } => {
                    ensure_clean_worktree(repo, token).await?;
                    validate_commit_hashes(&revisions)?;
                    let mut args = vec!["revert".into(), "--no-edit".into()];
                    args.extend(revisions);
                    git(args, repo, token).await?;
                }
                HistoryOperation::Reset { revision, mode } => {
                    validate_revision(&revision)?;
                    if !matches!(mode.as_str(), "soft" | "mixed" | "hard") {
                        return Err(DesktopError::new(
                            "INVALID_RESET_MODE",
                            "Reset mode must be soft, mixed, or hard",
                            false,
                        ));
                    }
                    if mode != "hard" {
                        ensure_clean_worktree(repo, token).await?;
                    }
                    git(
                        vec!["reset".into(), format!("--{mode}"), revision],
                        repo,
                        token,
                    )
                    .await?;
                }
                HistoryOperation::CheckoutFile { revision, path } => {
                    validate_revision(&revision)?;
                    let safe = literal_path(Path::new(&repo.root_path), &path, true)?;
                    git(
                        vec![
                            "restore".into(),
                            "--source".into(),
                            revision,
                            "--".into(),
                            safe,
                        ],
                        repo,
                        token,
                    )
                    .await?;
                }
                HistoryOperation::RevertFile { revision, path } => {
                    validate_revision(&revision)?;
                    let safe = literal_path(Path::new(&repo.root_path), &path, true)?;
                    git(
                        vec![
                            "restore".into(),
                            "--source".into(),
                            format!("{revision}^"),
                            "--".into(),
                            safe,
                        ],
                        repo,
                        token,
                    )
                    .await?;
                }
                HistoryOperation::ApplyPaths { entries } => {
                    operate_commit_paths(repo, entries, CommitPathDirection::Apply, token).await?;
                }
                HistoryOperation::RevertPaths { entries } => {
                    operate_commit_paths(repo, entries, CommitPathDirection::Revert, token).await?;
                }
                HistoryOperation::SvnUpdateTo { .. } => unreachable!(),
            }
        }
    }
    Ok(())
}

pub async fn create_patch(
    repo: &RepositoryMeta,
    revisions: &[String],
    token: &CancellationToken,
) -> Result<PatchDocument, DesktopError> {
    if revisions.is_empty() {
        return Err(DesktopError::new(
            "EMPTY_COMMIT_SELECTION",
            "Select at least one revision",
            false,
        ));
    }
    let mut content = String::new();
    match repo.kind {
        VcsKind::Git => {
            validate_commit_hashes(revisions)?;
            for revision in revisions.iter().rev() {
                let output = git(
                    vec![
                        "show".into(),
                        "--format=email".into(),
                        "--binary".into(),
                        "--no-ext-diff".into(),
                        revision.clone(),
                    ],
                    repo,
                    token,
                )
                .await?;
                content.push_str(&output.stdout_text());
                if !content.ends_with('\n') {
                    content.push('\n');
                }
            }
        }
        VcsKind::Svn => {
            for revision in revisions.iter().rev() {
                validate_svn_revision(revision)?;
                content.push_str(
                    &svn(
                        vec!["diff".into(), "--git".into(), "-c".into(), revision.clone()],
                        repo,
                        token,
                    )
                    .await?
                    .stdout_text(),
                );
                if !content.ends_with('\n') {
                    content.push('\n');
                }
            }
        }
    }
    if content.len() > DIFF_MAX_BYTES * 2 {
        return Err(DesktopError::new(
            "PATCH_TOO_LARGE",
            "Patch is too large to export",
            true,
        ));
    }
    let suffix = if revisions.len() == 1 {
        revisions[0].chars().take(12).collect::<String>()
    } else {
        format!("{}-commits", revisions.len())
    };
    Ok(PatchDocument {
        file_name: format!("versiondock-{suffix}.patch"),
        content,
    })
}

async fn ensure_clean_worktree(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let status = git(vec!["status".into(), "--porcelain".into()], repo, token)
        .await?
        .stdout_text();
    if status.trim().is_empty() {
        Ok(())
    } else {
        Err(DesktopError::new(
            "WORKTREE_NOT_CLEAN",
            "Commit history can only be rewritten with a clean working tree",
            true,
        )
        .hint("Commit, stash, shelf, or discard current changes first"))
    }
}

fn validate_commit_hashes(hashes: &[String]) -> Result<(), DesktopError> {
    if hashes.is_empty() {
        return Err(DesktopError::new(
            "EMPTY_COMMIT_SELECTION",
            "Select at least one commit",
            false,
        ));
    }
    for hash in hashes {
        validate_revision(hash)?;
    }
    Ok(())
}

async fn validate_contiguous_commits(
    repo: &RepositoryMeta,
    hashes: &[String],
    require_multiple: bool,
    token: &CancellationToken,
) -> Result<(String, String), DesktopError> {
    validate_commit_hashes(hashes)?;
    if require_multiple && hashes.len() < 2 {
        return Err(DesktopError::new(
            "SQUASH_REQUIRES_MULTIPLE",
            "Select at least two commits to squash",
            false,
        ));
    }
    let selected = hashes.iter().cloned().collect::<HashSet<_>>();
    let log = git(
        vec!["rev-list".into(), "--topo-order".into(), "HEAD".into()],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let lines = log.lines().collect::<Vec<_>>();
    let positions = lines
        .iter()
        .enumerate()
        .filter(|(_, hash)| selected.contains(**hash))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if positions.len() != hashes.len() {
        return Err(DesktopError::new(
            "COMMIT_NOT_FOUND",
            "One or more selected commits are no longer available",
            true,
        ));
    }
    if positions.windows(2).any(|pair| pair[1] != pair[0] + 1) {
        return Err(DesktopError::new(
            "NON_CONTIGUOUS_COMMITS",
            "Selected commits must be contiguous",
            false,
        ));
    }
    Ok((
        lines[*positions.last().unwrap()].to_string(),
        lines[positions[0]].to_string(),
    ))
}

async fn git_history(
    repo: &RepositoryMeta,
    skip: u32,
    limit: u32,
    query: HistoryQuery,
    token: &CancellationToken,
) -> Result<HistoryPage, DesktopError> {
    if let Some(value) = query.revision.as_deref() {
        validate_revision_or_ref(value)?;
    }
    let format = format!(
        "%H{FIELD}%h{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%aI{FIELD}%cI{FIELD}%s{FIELD}%D{FIELD}%B{RECORD}"
    );
    let head_hash = git(
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "HEAD".into(),
        ],
        repo,
        token,
    )
    .await
    .map(|output| output.stdout_text().trim().to_string())
    .unwrap_or_default();
    let mut args = vec![
        "log".into(),
        "--date-order".into(),
        format!("--format={format}"),
        "--date=iso-strict".into(),
    ];
    if let Some(value) = query
        .author
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push(format!("--author={}", regex_literal(value)));
    }
    if let Some(value) = query
        .from_date
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_history_date(value)?;
        args.push(format!("--since={value}T00:00:00"));
    }
    if let Some(value) = query
        .to_date
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_history_date(value)?;
        args.push(format!("--until={value}T23:59:59"));
    }
    // Prioritize the checked-out history when tips share a timestamp, matching
    // JetBrains and the VersionDock plugin. Unborn repositories have no HEAD.
    if let Some(value) = query.revision.clone() {
        args.push(value);
    } else {
        if !head_hash.is_empty() {
            args.push("HEAD".into());
        }
        args.push("--exclude=refs/stash".into());
        args.push("--exclude=refs/versiondock/ai-composer/*".into());
        args.push("--all".into());
    }
    if let Some(path) = query
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let path = literal_path(Path::new(&repo.root_path), path, false)?;
        args.push("--follow".into());
        args.push("--".into());
        args.push(path);
    }
    let (raw, refs_by_hash) = tokio::try_join!(
        async { Ok::<_, DesktopError>(git(args, repo, token).await?.stdout_text()) },
        git_decorated_refs(repo, &head_hash, token),
    )?;
    let needle = query.text.unwrap_or_default().trim().to_lowercase();
    let mut commits = raw
        .split(RECORD)
        .filter_map(|record| {
            let fields = record.trim().split(FIELD).collect::<Vec<_>>();
            if fields.len() < 10 || fields[0].is_empty() {
                return None;
            }
            let searchable = format!(
                "{} {} {} {} {}",
                fields[0], fields[1], fields[3], fields[7], fields[9]
            )
            .to_lowercase();
            if !needle.is_empty() && !searchable.contains(&needle) {
                return None;
            }
            Some(CommitNode {
                repo_id: repo.id.clone(),
                hash: fields[0].into(),
                short_hash: fields[1].into(),
                parents: fields[2].split_whitespace().map(String::from).collect(),
                author: fields[3].into(),
                email: fields[4].into(),
                author_date: fields[5].into(),
                committer_date: fields[6].into(),
                message: fields[7].into(),
                refs: fields[8]
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(String::from)
                    .collect(),
                incoming: false,
                unpushed: false,
            })
        })
        .skip(skip as usize)
        .take(limit as usize + 1)
        .collect::<Vec<_>>();
    for commit in &mut commits {
        if let Some(refs) = refs_by_hash.get(&commit.hash) {
            commit.refs = refs.clone();
        }
    }
    let unpushed = git_revision_hashes(repo, vec!["@{upstream}..HEAD".into()], token).await;
    let incoming = git_revision_hashes(repo, vec!["HEAD..@{upstream}".into()], token).await;
    for commit in &mut commits {
        commit.unpushed = unpushed.contains(&commit.hash);
        commit.incoming = incoming.contains(&commit.hash);
    }
    let has_more = commits.len() > limit as usize;
    commits.truncate(limit as usize);
    Ok(HistoryPage { commits, has_more })
}

async fn git_history_topology(
    repo: &RepositoryMeta,
    revision: Option<String>,
    token: &CancellationToken,
) -> Result<Vec<GraphCommitNode>, DesktopError> {
    let format = format!("%H{FIELD}%P{FIELD}%cI{RECORD}");
    let head_hash = git(
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "HEAD".into(),
        ],
        repo,
        token,
    )
    .await
    .map(|output| output.stdout_text().trim().to_string())
    .unwrap_or_default();
    let mut args = vec![
        "log".into(),
        "--date-order".into(),
        format!("--format={format}"),
        "--date=iso-strict".into(),
    ];
    if let Some(revision) = revision {
        validate_revision_or_ref(&revision)?;
        args.push(revision);
    } else if !head_hash.is_empty() {
        args.push("HEAD".into());
    }
    if args.last().is_some_and(|value| value == "HEAD") || head_hash.is_empty() {
        args.push("--exclude=refs/stash".into());
        args.push("--exclude=refs/versiondock/ai-composer/*".into());
        args.push("--all".into());
    }
    let (raw, refs_by_hash) = tokio::try_join!(
        async { Ok::<_, DesktopError>(git(args, repo, token).await?.stdout_text()) },
        git_decorated_refs(repo, &head_hash, token),
    )?;
    Ok(raw
        .split(RECORD)
        .filter_map(|record| {
            let fields = record.trim().split(FIELD).collect::<Vec<_>>();
            if fields.len() < 3 || fields[0].is_empty() {
                return None;
            }
            Some(GraphCommitNode {
                repo_id: repo.id.clone(),
                hash: fields[0].into(),
                parents: fields[1].split_whitespace().map(String::from).collect(),
                committer_date: fields[2].into(),
                refs: refs_by_hash.get(fields[0]).cloned().unwrap_or_default(),
            })
        })
        .collect())
}

async fn git_decorated_refs(
    repo: &RepositoryMeta,
    head_hash: &str,
    token: &CancellationToken,
) -> Result<HashMap<String, Vec<String>>, DesktopError> {
    let format = format!("%(objectname){FIELD}%(*objectname){FIELD}%(refname){FIELD}%(HEAD)");
    let raw = git(
        vec![
            "for-each-ref".into(),
            format!("--format={format}"),
            "refs/heads/".into(),
            "refs/remotes/".into(),
            "refs/tags/".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let mut refs_by_hash: HashMap<String, Vec<String>> = HashMap::new();
    let mut attached_head = false;
    let mut add_ref = |hash: &str, reference: String| {
        if hash.is_empty() || reference.is_empty() {
            return;
        }
        let refs = refs_by_hash.entry(hash.to_string()).or_default();
        if !refs.contains(&reference) {
            refs.push(reference);
        }
    };
    for line in raw.lines() {
        let fields = line.split(FIELD).collect::<Vec<_>>();
        if fields.len() < 4 {
            continue;
        }
        let commit_hash = if fields[1].is_empty() {
            fields[0]
        } else {
            fields[1]
        };
        let reference = fields[2];
        add_ref(commit_hash, reference.to_string());
        if fields[3].trim() == "*" {
            attached_head = true;
            add_ref(commit_hash, format!("HEAD -> {reference}"));
        }
    }
    if !attached_head && !head_hash.is_empty() {
        add_ref(head_hash, "HEAD".into());
    }
    Ok(refs_by_hash)
}

fn parse_git_log(repo_id: &str, raw: &str) -> Vec<CommitNode> {
    raw.split(RECORD)
        .filter_map(|record| {
            let fields = record.trim().split(FIELD).collect::<Vec<_>>();
            if fields.len() < 9 || fields[0].is_empty() {
                return None;
            }
            Some(CommitNode {
                repo_id: repo_id.into(),
                hash: fields[0].into(),
                short_hash: fields[1].into(),
                parents: fields[2].split_whitespace().map(String::from).collect(),
                author: fields[3].into(),
                email: fields[4].into(),
                author_date: fields[5].into(),
                committer_date: fields[6].into(),
                message: fields[7].into(),
                refs: fields[8]
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(String::from)
                    .collect(),
                incoming: false,
                unpushed: false,
            })
        })
        .collect()
}

async fn git_revision_hashes(
    repo: &RepositoryMeta,
    revisions: Vec<String>,
    token: &CancellationToken,
) -> HashSet<String> {
    let mut args = vec!["rev-list".into(), "--max-count=500".into()];
    args.extend(revisions);
    git(args, repo, token)
        .await
        .map(|output| {
            output
                .stdout_text()
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

pub async fn branch_compare(
    repo: &RepositoryMeta,
    base: &str,
    target: &str,
    token: &CancellationToken,
) -> Result<BranchCompareResult, DesktopError> {
    ensure_git(repo)?;
    validate_revision_or_ref(base)?;
    validate_revision_or_ref(target)?;
    let format = format!(
        "%H{FIELD}%h{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%aI{FIELD}%cI{FIELD}%s{FIELD}%D{RECORD}"
    );
    let compare_log = |range: String| {
        git(
            vec![
                "log".into(),
                "--max-count=200".into(),
                format!("--format={format}"),
                "--date=iso-strict".into(),
                range,
            ],
            repo,
            token,
        )
    };
    let (base_output, target_output) = tokio::try_join!(
        compare_log(format!("{target}..{base}")),
        compare_log(format!("{base}..{target}"))
    )?;
    let range = format!("{base}..{target}");
    let stats = git(
        vec![
            "diff".into(),
            "--numstat".into(),
            range.clone(),
            "--".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let statuses = git(
        vec!["diff".into(), "--name-status".into(), range, "--".into()],
        repo,
        token,
    )
    .await?
    .stdout_text();
    Ok(BranchCompareResult {
        base: base.into(),
        target: target.into(),
        base_commits: parse_git_log(&repo.id, &base_output.stdout_text()),
        target_commits: parse_git_log(&repo.id, &target_output.stdout_text()),
        files: merge_git_files(&stats, &statuses),
    })
}

async fn svn_history(
    repo: &RepositoryMeta,
    skip: u32,
    limit: u32,
    query: HistoryQuery,
    token: &CancellationToken,
) -> Result<HistoryPage, DesktopError> {
    let backend_filter = query
        .text
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || query
            .author
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || query.from_date.is_some()
        || query.to_date.is_some();
    let requested = skip
        .saturating_add(limit)
        .saturating_add(1)
        .clamp(100, 5_000);
    if let Some(value) = query.from_date.as_deref().filter(|value| !value.is_empty()) {
        validate_history_date(value)?;
    }
    if let Some(value) = query.to_date.as_deref().filter(|value| !value.is_empty()) {
        validate_history_date(value)?;
    }
    let target = svn_history_target(repo, query.revision.as_deref(), query.path.as_deref())?;
    let mut args = vec!["log".into(), "--xml".into(), "-r".into(), "HEAD:0".into()];
    if !backend_filter {
        args.extend(["--limit".into(), requested.to_string()]);
    }
    if let Some(target) = target {
        args.extend(["--".into(), target]);
    }
    let raw = svn(args, repo, token).await?.stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let needle = query.text.unwrap_or_default().to_lowercase();
    let author_filter = query.author.unwrap_or_default().to_lowercase();
    let all = document
        .descendants()
        .filter(|node| node.has_tag_name("logentry"))
        .filter_map(|entry| {
            let revision = entry.attribute("revision")?;
            let text = |name: &str| {
                entry
                    .children()
                    .find(|node| node.has_tag_name(name))
                    .and_then(|node| node.text())
                    .unwrap_or("")
            };
            let full_message = text("msg");
            let message = full_message.lines().next().unwrap_or("").to_string();
            let author = text("author").to_string();
            let date = text("date");
            if !needle.is_empty()
                && !full_message.to_lowercase().contains(&needle)
                && !author.to_lowercase().contains(&needle)
                && !revision.to_lowercase().contains(&needle)
            {
                return None;
            }
            if !author_filter.is_empty() && !author.to_lowercase().contains(&author_filter) {
                return None;
            }
            let day = date.get(..10).unwrap_or(date);
            if query.from_date.as_deref().is_some_and(|from| day < from)
                || query.to_date.as_deref().is_some_and(|to| day > to)
            {
                return None;
            }
            Some(CommitNode {
                repo_id: repo.id.clone(),
                hash: revision.into(),
                short_hash: format!("r{revision}"),
                parents: vec![],
                author,
                email: String::new(),
                author_date: date.into(),
                committer_date: date.into(),
                message,
                refs: vec![],
                incoming: false,
                unpushed: false,
            })
        })
        .collect::<Vec<_>>();
    let mut commits = all.into_iter().skip(skip as usize).collect::<Vec<_>>();
    let has_more = commits.len() > limit as usize;
    commits.truncate(limit as usize);
    Ok(HistoryPage { commits, has_more })
}

fn validate_history_date(value: &str) -> Result<(), DesktopError> {
    let valid = value.len() == 10
        && value.as_bytes().iter().enumerate().all(|(index, byte)| {
            if matches!(index, 4 | 7) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    if valid {
        Ok(())
    } else {
        Err(DesktopError::new(
            "INVALID_HISTORY_DATE",
            "History dates must use YYYY-MM-DD",
            false,
        ))
    }
}

fn svn_history_target(
    repo: &RepositoryMeta,
    revision: Option<&str>,
    path: Option<&str>,
) -> Result<Option<String>, DesktopError> {
    let revision = revision
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "HEAD");
    let path = path.map(str::trim).filter(|value| !value.is_empty());
    if revision.is_none() && path.is_none() {
        return Ok(None);
    }
    let mut relative = String::new();
    if let Some(revision) = revision {
        if revision.bytes().all(|byte| byte.is_ascii_digit()) {
            return Ok(Some(format!("{}@{revision}", repo.root_path)));
        }
        safe_relative(Path::new("/"), revision, true)?;
        relative.push_str(revision.trim_matches('/'));
    }
    if let Some(path) = path {
        relative_path(Path::new(&repo.root_path), path, false)?;
        if !relative.is_empty() {
            relative.push('/');
        }
        relative.push_str(path.trim_matches('/'));
    }
    Ok(Some(if revision.is_some() {
        format!("^/{relative}@HEAD")
    } else {
        format!(
            "{}@HEAD",
            Path::new(&repo.root_path).join(relative).to_string_lossy()
        )
    }))
}

async fn svn_history_topology(
    repo: &RepositoryMeta,
    limit: u32,
    token: &CancellationToken,
) -> Result<Vec<GraphCommitNode>, DesktopError> {
    let raw = svn(
        vec![
            "log".into(),
            "--xml".into(),
            "-r".into(),
            "HEAD:0".into(),
            "--limit".into(),
            limit.to_string(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let entries = document
        .descendants()
        .filter(|node| node.has_tag_name("logentry"))
        .filter_map(|entry| {
            let revision = entry.attribute("revision")?;
            let date = entry
                .children()
                .find(|node| node.has_tag_name("date"))
                .and_then(|node| node.text())
                .unwrap_or("");
            Some((revision.to_string(), date.to_string()))
        })
        .collect::<Vec<_>>();
    Ok(entries
        .iter()
        .enumerate()
        .map(|(index, (revision, date))| GraphCommitNode {
            repo_id: repo.id.clone(),
            hash: revision.clone(),
            parents: Vec::new(),
            committer_date: date.clone(),
            refs: if index == 0 {
                vec!["HEAD".into()]
            } else {
                Vec::new()
            },
        })
        .collect())
}

pub async fn commit_detail(
    repo: &RepositoryMeta,
    revision: &str,
    token: &CancellationToken,
) -> Result<CommitDetail, DesktopError> {
    match repo.kind {
        VcsKind::Git => {
            validate_revision(revision)?;
            let format = format!("%H{FIELD}%h{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%aI{FIELD}%cI{FIELD}%s{FIELD}%D{RECORD}%B");
            let raw = git(
                vec![
                    "show".into(),
                    "--no-patch".into(),
                    format!("--format={format}"),
                    revision.into(),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text();
            let (header, full_message) = raw.split_once(RECORD).unwrap_or((&raw, ""));
            let commit = parse_git_log(&repo.id, &format!("{header}{RECORD}"))
                .into_iter()
                .next()
                .ok_or_else(|| {
                    DesktopError::new("COMMIT_PARSE_FAILED", "Unable to parse commit", true)
                })?;
            let is_merge = commit.parents.len() >= 2;
            let (files, merge_parent_changes) = if is_merge {
                let (combined_status, parent_changes) = tokio::try_join!(
                    async {
                        Ok::<String, DesktopError>(
                            git(
                                vec![
                                    "diff-tree".into(),
                                    "--no-commit-id".into(),
                                    "-r".into(),
                                    "--cc".into(),
                                    "-M".into(),
                                    "--name-status".into(),
                                    revision.into(),
                                ],
                                repo,
                                token,
                            )
                            .await?
                            .stdout_text(),
                        )
                    },
                    async { merge_parent_changes(repo, revision, &commit.parents, token).await },
                )?;
                (parse_combined_diff_files(&combined_status), parent_changes)
            } else {
                let stats_args = if let Some(parent) = commit.parents.first() {
                    vec![
                        "diff".into(),
                        "--numstat".into(),
                        parent.clone(),
                        revision.into(),
                    ]
                } else {
                    vec![
                        "show".into(),
                        "--numstat".into(),
                        "--format=".into(),
                        revision.into(),
                    ]
                };
                let status_args = if let Some(parent) = commit.parents.first() {
                    vec![
                        "diff".into(),
                        "--name-status".into(),
                        parent.clone(),
                        revision.into(),
                    ]
                } else {
                    vec![
                        "show".into(),
                        "--name-status".into(),
                        "--format=".into(),
                        revision.into(),
                    ]
                };
                let (stats, statuses) = tokio::try_join!(
                    async {
                        Ok::<_, DesktopError>(git(stats_args, repo, token).await?.stdout_text())
                    },
                    async {
                        Ok::<_, DesktopError>(git(status_args, repo, token).await?.stdout_text())
                    },
                )?;
                (merge_git_files(&stats, &statuses), Vec::new())
            };
            let branches = containing_branches(repo, &commit.hash, token).await?;
            Ok(CommitDetail {
                commit,
                full_message: full_message.trim().into(),
                files,
                branches,
                merge_parent_changes,
            })
        }
        VcsKind::Svn => {
            validate_svn_revision(revision)?;
            let raw = svn(
                vec![
                    "log".into(),
                    "--xml".into(),
                    "--verbose".into(),
                    "-r".into(),
                    revision.into(),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text();
            let document = roxmltree::Document::parse(&raw)
                .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
            let entry = document
                .descendants()
                .find(|node| node.has_tag_name("logentry"));
            let text = |name: &str| {
                entry
                    .and_then(|node| node.children().find(|child| child.has_tag_name(name)))
                    .and_then(|node| node.text())
                    .unwrap_or("")
                    .to_string()
            };
            let full_message = entry
                .and_then(|node| node.children().find(|child| child.has_tag_name("msg")))
                .and_then(|node| node.text())
                .unwrap_or("")
                .to_string();
            let message = full_message.lines().next().unwrap_or("").to_string();
            let author = text("author");
            let date = text("date");
            let commit = CommitNode {
                repo_id: repo.id.clone(),
                hash: revision.into(),
                short_hash: format!("r{revision}"),
                parents: vec![],
                author,
                email: String::new(),
                author_date: date.clone(),
                committer_date: date,
                message: if message.is_empty() {
                    format!("SVN revision {revision}")
                } else {
                    message
                },
                refs: vec![],
                incoming: false,
                unpushed: false,
            };
            let files = document
                .descendants()
                .filter(|node| node.has_tag_name("path"))
                .filter_map(|node| {
                    Some(CommitFile {
                        path: node.text()?.trim_start_matches('/').into(),
                        status: node.attribute("action").unwrap_or("M").into(),
                        added: None,
                        removed: None,
                    })
                })
                .collect();
            Ok(CommitDetail {
                commit,
                full_message,
                files,
                branches: CommitBranches::default(),
                merge_parent_changes: Vec::new(),
            })
        }
    }
}

fn normalize_combined_diff_status(code: &str) -> String {
    let normalized = code.trim_end_matches(|c: char| c.is_ascii_digit());
    if normalized.len() <= 1 {
        return if normalized.is_empty() {
            "M".into()
        } else {
            normalized.into()
        };
    }
    if normalized.contains('R') {
        return "R".into();
    }
    if normalized.contains('C') {
        return "C".into();
    }
    if normalized.contains('D') {
        return "D".into();
    }
    if normalized.contains('A') {
        return "A".into();
    }
    "M".into()
}

fn parse_combined_diff_files(statuses: &str) -> Vec<CommitFile> {
    statuses
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\t').filter(|s| !s.is_empty()).collect();
            if fields.len() < 2 {
                return None;
            }
            let raw_status = fields[0];
            let path = fields[fields.len() - 1];
            Some(CommitFile {
                path: path.into(),
                status: normalize_combined_diff_status(raw_status),
                added: None,
                removed: None,
            })
        })
        .collect()
}

pub async fn merge_parent_changes(
    repo: &RepositoryMeta,
    revision: &str,
    parents: &[String],
    token: &CancellationToken,
) -> Result<Vec<MergeParentChange>, DesktopError> {
    if !matches!(repo.kind, VcsKind::Git) || parents.len() < 2 {
        return Ok(Vec::new());
    }
    validate_revision(revision)?;
    for parent in parents {
        validate_revision(parent)?;
    }

    let mut changes = Vec::new();
    for (index, parent) in parents.iter().enumerate() {
        let (metadata, changed_paths) = tokio::try_join!(
            async {
                Ok::<String, DesktopError>(
                    git(
                        vec![
                            "show".into(),
                            "-s".into(),
                            "--format=%h%x00%an%x00%aI%x00%s".into(),
                            parent.clone(),
                        ],
                        repo,
                        token,
                    )
                    .await?
                    .stdout_text(),
                )
            },
            async {
                Ok::<String, DesktopError>(
                    git(
                        vec![
                            "diff".into(),
                            "--name-only".into(),
                            "-M".into(),
                            parent.clone(),
                            revision.into(),
                        ],
                        repo,
                        token,
                    )
                    .await?
                    .stdout_text(),
                )
            }
        )?;

        let meta_parts: Vec<&str> = metadata.trim_end().split('\0').collect();
        let short_hash = meta_parts
            .first()
            .copied()
            .filter(|s| !s.is_empty())
            .unwrap_or(&parent[..7.min(parent.len())])
            .to_string();
        let author_name = meta_parts.get(1).copied().unwrap_or("").to_string();
        let author_date = meta_parts.get(2).copied().unwrap_or("").to_string();
        let message = meta_parts
            .get(3..)
            .map(|p| p.join("\0"))
            .unwrap_or_default();
        let file_count = changed_paths
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count() as u32;

        if file_count > 0 {
            changes.push(MergeParentChange {
                hash: parent.clone(),
                short_hash,
                message,
                author_name,
                author_date,
                parent_index: index as u32,
                file_count,
            });
        }
    }
    Ok(changes)
}

pub async fn merge_parent_files(
    repo: &RepositoryMeta,
    revision: &str,
    parent_hash: &str,
    token: &CancellationToken,
) -> Result<Vec<CommitFile>, DesktopError> {
    if !matches!(repo.kind, VcsKind::Git) {
        return Ok(Vec::new());
    }
    validate_revision(revision)?;
    validate_revision(parent_hash)?;

    let stats_args = vec![
        "diff".into(),
        "--numstat".into(),
        parent_hash.into(),
        revision.into(),
    ];
    let status_args = vec![
        "diff".into(),
        "--name-status".into(),
        parent_hash.into(),
        revision.into(),
    ];
    let (stats, statuses) = tokio::try_join!(
        async { Ok::<_, DesktopError>(git(stats_args, repo, token).await?.stdout_text()) },
        async { Ok::<_, DesktopError>(git(status_args, repo, token).await?.stdout_text()) },
    )?;
    Ok(merge_git_files(&stats, &statuses))
}

pub async fn merge_commits(
    repo: &RepositoryMeta,
    revision: &str,
    parents: &[String],
    token: &CancellationToken,
) -> Result<Vec<MergeCommitSummary>, DesktopError> {
    if !matches!(repo.kind, VcsKind::Git) || parents.len() < 2 {
        return Ok(Vec::new());
    }
    validate_revision(revision)?;
    for parent in parents {
        validate_revision(parent)?;
    }

    let mut result = Vec::new();
    for (index, parent) in parents.iter().enumerate().skip(1) {
        let raw = git(
            vec![
                "log".into(),
                format!("{}..{}", parents[0], parent),
                format!("--format=%H{FIELD}%h{FIELD}%an{FIELD}%aI{FIELD}%s"),
            ],
            repo,
            token,
        )
        .await?
        .stdout_text();
        for line in raw.lines().filter(|line| !line.trim().is_empty()) {
            let fields = line.split(FIELD).collect::<Vec<_>>();
            if fields.len() < 5 {
                continue;
            }
            result.push(MergeCommitSummary {
                hash: fields[0].into(),
                short_hash: fields[1].into(),
                message: fields[4].into(),
                author: fields[2].into(),
                author_date: fields[3].into(),
                parent_index: index as u32,
            });
        }
    }
    Ok(result)
}

async fn containing_branches(
    repo: &RepositoryMeta,
    revision: &str,
    token: &CancellationToken,
) -> Result<CommitBranches, DesktopError> {
    if !matches!(repo.kind, VcsKind::Git) {
        return Ok(CommitBranches::default());
    }
    let local = git(
        vec![
            "branch".into(),
            "--contains".into(),
            revision.into(),
            "--format=%(refname:short)".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let remote = git(
        vec![
            "for-each-ref".into(),
            "--contains".into(),
            revision.into(),
            "--format=%(refname:short)".into(),
            "refs/remotes".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let tags = git(
        vec![
            "tag".into(),
            "--contains".into(),
            revision.into(),
            "--format=%(refname:short)".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();

    Ok(CommitBranches {
        local: lines(&local),
        remote: lines(&remote),
        tags: lines(&tags),
    })
}

fn lines(value: &str) -> Vec<String> {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect()
}

fn merge_git_files(stats: &str, statuses: &str) -> Vec<CommitFile> {
    let mut numbers = std::collections::HashMap::new();
    for line in stats.lines() {
        let fields = line.splitn(3, '\t').collect::<Vec<_>>();
        if fields.len() == 3 {
            numbers.insert(fields[2], (fields[0].parse().ok(), fields[1].parse().ok()));
        }
    }
    statuses
        .lines()
        .filter_map(|line| {
            let (status, path) = line.split_once('\t')?;
            let (added, removed) = numbers.get(path).cloned().unwrap_or((None, None));
            Some(CommitFile {
                path: path.into(),
                status: status.into(),
                added,
                removed,
            })
        })
        .collect()
}

pub async fn branches(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<BranchInfo>, DesktopError> {
    if repo.kind == VcsKind::Svn {
        return svn_branches(repo, token).await;
    }
    let format = format!(
        "%(refname:short){FIELD}%(refname){FIELD}%(HEAD){FIELD}%(upstream:short){FIELD}%(upstream:track){RECORD}"
    );
    let raw = git(
        vec![
            "for-each-ref".into(),
            format!("--format={format}"),
            "refs/heads".into(),
            "refs/remotes".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let remote_names = git(vec!["remote".into()], repo, token)
        .await
        .map(|value| {
            let mut names = value
                .stdout_text()
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
                .collect::<Vec<_>>();
            names.sort_by_key(|name| std::cmp::Reverse(name.len()));
            names
        })
        .unwrap_or_default();
    Ok(raw
        .split(RECORD)
        .filter_map(|record| {
            let fields = record.trim().split(FIELD).collect::<Vec<_>>();
            if fields.len() < 5 || fields[0].is_empty() || fields[0].ends_with("/HEAD") {
                return None;
            }
            Some(BranchInfo {
                name: fields[0].into(),
                current: fields[2] == "*",
                remote: fields[1].starts_with("refs/remotes/"),
                remote_name: remote_name_for_ref(fields[1], &remote_names),
                upstream: (!fields[3].is_empty()).then(|| fields[3].into()),
                ahead: parse_counter(fields[4], "ahead "),
                behind: parse_counter(fields[4], "behind "),
                detached_tag: None,
                detached_hash: None,
            })
        })
        .collect())
}

fn remote_name_for_ref(ref_name: &str, remote_names: &[String]) -> Option<String> {
    let value = ref_name.strip_prefix("refs/remotes/")?;
    remote_names
        .iter()
        .find(|remote| value == remote.as_str() || value.starts_with(&format!("{remote}/")))
        .cloned()
        .or_else(|| value.split('/').next().map(str::to_string))
}

async fn svn_branches(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<BranchInfo>, DesktopError> {
    let relative_url = svn_relative_url(repo, token).await?;
    let (current_name, detached_tag) = svn_display_ref(&relative_url);
    let behind = svn_incoming_revisions(repo, token).await;
    let mut branches = vec![BranchInfo {
        name: current_name.clone(),
        current: true,
        remote: false,
        remote_name: None,
        upstream: None,
        ahead: 0,
        behind,
        detached_tag,
        detached_hash: None,
    }];

    let add = |name: String, branches: &mut Vec<BranchInfo>| {
        if branches
            .iter()
            .any(|branch| !branch.remote && branch.name == name)
        {
            return;
        }
        branches.push(BranchInfo {
            current: name == current_name,
            name,
            remote: false,
            remote_name: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            detached_tag: None,
            detached_hash: None,
        });
    };

    if svn(
        vec!["ls".into(), "--xml".into(), "^/trunk".into()],
        repo,
        token,
    )
    .await
    .is_ok()
    {
        add("trunk".into(), &mut branches);
    }
    let raw = svn(
        vec!["ls".into(), "--xml".into(), "^/branches".into()],
        repo,
        token,
    )
    .await
    .map(|value| value.stdout_text())
    .unwrap_or_default();
    for (name, _, _) in parse_svn_list_entries(&raw)? {
        add(name, &mut branches);
    }
    Ok(branches)
}

pub async fn branch_operation(
    repo: &RepositoryMeta,
    operation: BranchOperation,
    token: &CancellationToken,
) -> Result<BranchOperationResult, DesktopError> {
    if repo.kind == VcsKind::Svn {
        let is_merge = matches!(&operation, BranchOperation::Merge { .. });
        if is_merge {
            prepare_svn_merge(repo, token).await?;
        }
        let args = match operation {
            BranchOperation::Checkout { name } => {
                vec![
                    "switch".into(),
                    svn_branch_target(repo, &name, token).await?,
                ]
            }
            BranchOperation::Merge { name } => {
                vec!["merge".into(), svn_branch_target(repo, &name, token).await?]
            }
            BranchOperation::Delete { name, .. } => {
                let target = svn_repository_target(&name)?;
                vec![
                    "delete".into(),
                    target.clone(),
                    "--message".into(),
                    format!("Delete {target} from VersionDock"),
                ]
            }
            BranchOperation::Create { name, from } => {
                let destination = svn_repository_target(&format!("branches/{name}"))?;
                let relative = svn_relative_url(repo, token).await?;
                let source = if relative.is_empty() {
                    "^/".into()
                } else {
                    format!("^/{relative}")
                };
                let mut args = vec![
                    "copy".into(),
                    source,
                    destination,
                    "--message".into(),
                    format!("Create branch {name} from VersionDock"),
                ];
                if let Some(revision) = from {
                    let revision = revision.trim_start_matches('r').to_string();
                    validate_svn_revision(&revision)?;
                    args.extend(["--revision".into(), revision]);
                }
                args
            }
            BranchOperation::Rename { .. } | BranchOperation::Rebase { .. } => {
                return Err(DesktopError::new(
                    "SVN_BRANCH_OPERATION_UNSUPPORTED",
                    "This branch operation is not available for SVN",
                    true,
                ));
            }
        };
        let result = svn(args, repo, token).await;
        if is_merge {
            record_svn_merge(repo, token).await;
        }
        result?;
        return Ok(BranchOperationResult {
            completed: true,
            conflicted: false,
        });
    }
    ensure_git(repo)?;
    let is_merge = matches!(operation, BranchOperation::Merge { .. });
    let args = match operation {
        BranchOperation::Create { name, from } => {
            validate_ref(&name)?;
            let mut args = vec!["switch".into(), "-c".into(), name];
            if let Some(value) = from {
                validate_ref(&value)?;
                args.push(value);
            }
            args
        }
        BranchOperation::Checkout { name } => {
            validate_ref(&name)?;
            let remote_ref = git(
                vec![
                    "show-ref".into(),
                    "--verify".into(),
                    format!("refs/remotes/{name}"),
                ],
                repo,
                token,
            )
            .await
            .is_ok();
            if remote_ref {
                vec!["switch".into(), "--track".into(), name]
            } else {
                vec!["switch".into(), name]
            }
        }
        BranchOperation::Merge { name } => {
            validate_revision_or_ref(&name)?;
            vec!["merge".into(), name]
        }
        BranchOperation::Rebase { name } => {
            validate_revision_or_ref(&name)?;
            vec!["rebase".into(), name]
        }
        BranchOperation::Rename { old_name, new_name } => {
            validate_ref(&old_name)?;
            validate_ref(&new_name)?;
            vec!["branch".into(), "-m".into(), old_name, new_name]
        }
        BranchOperation::Delete { name, force } => {
            validate_ref(&name)?;
            vec![
                "branch".into(),
                if force { "-D".into() } else { "-d".into() },
                name,
            ]
        }
    };
    match git(args, repo, token).await {
        Ok(_) => Ok(BranchOperationResult {
            completed: true,
            conflicted: false,
        }),
        Err(_) if is_merge && git_has_conflicts(repo, token).await => Ok(BranchOperationResult {
            completed: false,
            conflicted: true,
        }),
        Err(error) => Err(error),
    }
}

async fn git_has_conflicts(repo: &RepositoryMeta, token: &CancellationToken) -> bool {
    git(
        vec![
            "diff".into(),
            "--name-only".into(),
            "--diff-filter=U".into(),
        ],
        repo,
        token,
    )
    .await
    .is_ok_and(|output| !output.stdout_text().trim().is_empty())
}

async fn stash_head(repo: &RepositoryMeta, token: &CancellationToken) -> Option<String> {
    git(
        vec!["rev-parse".into(), "--verify".into(), "refs/stash".into()],
        repo,
        token,
    )
    .await
    .ok()
    .map(|output| output.stdout_text().trim().to_string())
    .filter(|value| !value.is_empty())
}

async fn create_recovery_stash(
    repo: &RepositoryMeta,
    message: String,
    token: &CancellationToken,
) -> Result<Option<String>, DesktopError> {
    let before = stash_head(repo, token).await;
    git(
        vec![
            "stash".into(),
            "push".into(),
            "--include-untracked".into(),
            "--message".into(),
            message,
        ],
        repo,
        token,
    )
    .await?;
    let after = stash_head(repo, token).await;
    Ok((after != before).then(|| "stash@{0}".into()))
}

fn recovery_error(
    target: &str,
    stash_reference: Option<String>,
    changes_restored: bool,
    error: DesktopError,
    hint: impl Into<String>,
) -> BranchRecoveryResult {
    BranchRecoveryResult {
        status: BranchRecoveryStatus::PartialFailure,
        target: target.into(),
        stash_reference,
        changes_restored,
        error: Some(error),
        recovery_hint: Some(hint.into()),
    }
}

pub async fn branch_recovery(
    repo: &RepositoryMeta,
    operation: BranchRecoveryOperation,
    token: &CancellationToken,
) -> Result<BranchRecoveryResult, DesktopError> {
    ensure_git(repo)?;
    let target = match &operation {
        BranchRecoveryOperation::StashAndCheckout { target }
        | BranchRecoveryOperation::CarryChanges { target }
        | BranchRecoveryOperation::ForceCheckout { target }
        | BranchRecoveryOperation::StashAndMerge { target } => target.clone(),
    };
    validate_revision_or_ref(&target)?;
    if matches!(operation, BranchRecoveryOperation::ForceCheckout { .. }) {
        git(
            vec!["checkout".into(), "-f".into(), target.clone()],
            repo,
            token,
        )
        .await?;
        return Ok(BranchRecoveryResult {
            status: BranchRecoveryStatus::Completed,
            target,
            stash_reference: None,
            changes_restored: false,
            error: None,
            recovery_hint: None,
        });
    }

    let original_branch = git(vec!["branch".into(), "--show-current".into()], repo, token)
        .await?
        .stdout_text()
        .trim()
        .to_string();
    let is_merge = matches!(operation, BranchRecoveryOperation::StashAndMerge { .. });
    let carry = matches!(operation, BranchRecoveryOperation::CarryChanges { .. });
    let label = if is_merge { "merge" } else { "checkout" };
    let stash_reference = create_recovery_stash(
        repo,
        format!("VersionDock WIP before {label} of {target}"),
        token,
    )
    .await?;
    let command = if is_merge {
        vec!["merge".into(), target.clone()]
    } else {
        vec!["switch".into(), target.clone()]
    };
    if let Err(error) = git(command, repo, token).await {
        if is_merge && git_has_conflicts(repo, token).await {
            return Ok(BranchRecoveryResult {
                status: BranchRecoveryStatus::Conflicted,
                target,
                stash_reference,
                changes_restored: false,
                error: None,
                recovery_hint: Some(
                    "Resolve the merge conflicts; the recovery stash was retained".into(),
                ),
            });
        }
        if let Some(reference) = stash_reference.clone() {
            let restore = git(
                vec![
                    "stash".into(),
                    "apply".into(),
                    "--index".into(),
                    reference.clone(),
                ],
                repo,
                token,
            )
            .await;
            if restore.is_ok() {
                let _ = git(vec!["stash".into(), "drop".into(), reference], repo, token).await;
                return Ok(recovery_error(
                    &target,
                    None,
                    true,
                    error,
                    "The operation failed and the original changes were restored",
                ));
            }
            return Ok(recovery_error(
                &target,
                Some(reference),
                false,
                error,
                "The operation and automatic restore failed; recover the retained stash manually",
            ));
        }
        return Err(error);
    }

    if carry {
        if let Some(reference) = stash_reference.clone() {
            if let Err(error) = git(
                vec![
                    "stash".into(),
                    "apply".into(),
                    "--index".into(),
                    reference.clone(),
                ],
                repo,
                token,
            )
            .await
            {
                return Ok(recovery_error(
                    &target,
                    Some(reference),
                    false,
                    error,
                    "The target branch is checked out; resolve the apply conflict or recover the retained stash manually",
                ));
            }
            git(vec!["stash".into(), "drop".into(), reference], repo, token).await?;
        }
    }

    Ok(BranchRecoveryResult {
        status: BranchRecoveryStatus::Completed,
        target,
        stash_reference: if carry { None } else { stash_reference },
        changes_restored: carry,
        error: None,
        recovery_hint: (!original_branch.is_empty() && is_merge)
            .then(|| format!("Merge started from {original_branch}")),
    })
}

fn svn_repository_target(value: &str) -> Result<String, DesktopError> {
    let relative = value.trim().trim_start_matches("^/").trim_matches('/');
    if relative.is_empty()
        || relative.starts_with('-')
        || relative.contains('\0')
        || relative.contains('\\')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(DesktopError::new(
            "INVALID_SVN_REPOSITORY_PATH",
            "Invalid SVN repository-relative path",
            false,
        ));
    }
    let normalized = if relative == "trunk"
        || relative.starts_with("trunk/")
        || relative.starts_with("branches/")
        || relative.starts_with("tags/")
    {
        relative.to_string()
    } else {
        format!("branches/{relative}")
    };
    Ok(format!("^/{normalized}"))
}

async fn svn_branch_target(
    repo: &RepositoryMeta,
    value: &str,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    if value == "HEAD" || value == "SVN" {
        let relative = svn_relative_url(repo, token).await?;
        return Ok(if relative.is_empty() {
            "^/".into()
        } else {
            format!("^/{relative}")
        });
    }
    svn_repository_target(value)
}

async fn svn_working_changes(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<PendingSvnMerge, DesktopError> {
    let raw = svn(vec!["status".into(), "--xml".into()], repo, token)
        .await?
        .stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let mut pending = PendingSvnMerge::default();
    for entry in document
        .descendants()
        .filter(|node| node.has_tag_name("entry"))
    {
        let Some(path) = entry.attribute("path") else {
            continue;
        };
        let item = entry
            .children()
            .find(|node| node.has_tag_name("wc-status"))
            .and_then(|node| node.attribute("item"))
            .unwrap_or("normal");
        if item == "normal" || item == "external" || item == "ignored" {
            continue;
        }
        let path = path.replace('\\', "/");
        pending.paths.push(path.clone());
        if item == "added" {
            pending.added_paths.push(path);
        }
    }
    pending.paths.sort();
    pending.paths.dedup();
    pending
        .added_paths
        .sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
    pending.added_paths.dedup();
    Ok(pending)
}

async fn prepare_svn_merge(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if svn_working_changes(repo, token).await?.paths.is_empty() {
        Ok(())
    } else {
        Err(DesktopError::new(
            "SVN_WORKING_COPY_NOT_CLEAN",
            "SVN merge requires a clean working copy so it can be aborted without losing local changes",
            true,
        ))
    }
}

async fn record_svn_merge(repo: &RepositoryMeta, token: &CancellationToken) {
    let pending = svn_working_changes(repo, token).await.unwrap_or_default();
    if let Ok(mut merges) = svn_merges().lock() {
        if pending.paths.is_empty() {
            merges.remove(&repo.id);
        } else {
            merges.insert(repo.id.clone(), pending);
        }
    }
}

async fn refresh_svn_merge(repo: &RepositoryMeta, token: &CancellationToken) {
    let Some(mut pending) = svn_merges()
        .lock()
        .ok()
        .and_then(|merges| merges.get(&repo.id).cloned())
    else {
        return;
    };
    let current = svn_working_changes(repo, token).await.unwrap_or_default();
    let current_paths = current.paths.into_iter().collect::<HashSet<_>>();
    pending.paths.retain(|path| current_paths.contains(path));
    pending
        .added_paths
        .retain(|path| current_paths.contains(path));
    if let Ok(mut merges) = svn_merges().lock() {
        if pending.paths.is_empty() {
            merges.remove(&repo.id);
        } else {
            merges.insert(repo.id.clone(), pending);
        }
    }
}

pub async fn svn_merge_active(repo: &RepositoryMeta, token: &CancellationToken) -> bool {
    if repo.kind != VcsKind::Svn {
        return false;
    }
    let Some(pending) = svn_merges()
        .lock()
        .ok()
        .and_then(|merges| merges.get(&repo.id).cloned())
    else {
        return false;
    };
    let current = svn_working_changes(repo, token).await.unwrap_or_default();
    let current_paths = current.paths.into_iter().collect::<HashSet<_>>();
    let still_active = pending
        .paths
        .iter()
        .any(|path| current_paths.contains(path));
    if !still_active {
        if let Ok(mut merges) = svn_merges().lock() {
            merges.remove(&repo.id);
        }
    }
    still_active
}

pub async fn tags(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<TagInfo>, DesktopError> {
    if repo.kind == VcsKind::Svn {
        let raw = svn(
            vec!["ls".into(), "--xml".into(), "^/tags".into()],
            repo,
            token,
        )
        .await
        .map(|value| value.stdout_text())
        .unwrap_or_default();
        return Ok(parse_svn_list_entries(&raw)?
            .into_iter()
            .map(|(name, revision, date)| TagInfo {
                hash: revision
                    .map(|value| format!("r{value}"))
                    .unwrap_or_else(|| name.clone()),
                name,
                date,
            })
            .collect());
    }
    let format =
        format!("%(refname:short){FIELD}%(objectname){FIELD}%(creatordate:iso-strict){RECORD}");
    let raw = git(
        vec![
            "for-each-ref".into(),
            format!("--format={format}"),
            "refs/tags".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    Ok(raw
        .split(RECORD)
        .filter_map(|record| {
            let values = record.trim().split(FIELD).collect::<Vec<_>>();
            (values.len() >= 3 && !values[0].is_empty()).then(|| TagInfo {
                name: values[0].into(),
                hash: values[1].into(),
                date: values[2].into(),
            })
        })
        .collect())
}

async fn svn_relative_url(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let value = svn(
        vec!["info".into(), "--show-item".into(), "relative-url".into()],
        repo,
        token,
    )
    .await?
    .stdout_text()
    .trim()
    .trim_start_matches("^/")
    .trim_matches('/')
    .to_string();
    Ok(value)
}

fn svn_display_ref(relative_url: &str) -> (String, Option<String>) {
    let relative_url = relative_url.trim_start_matches("^/").trim_matches('/');
    if relative_url.is_empty() {
        return ("SVN".into(), None);
    }
    if relative_url == "trunk" || relative_url.starts_with("trunk/") {
        return ("trunk".into(), None);
    }
    if let Some(name) = relative_url.strip_prefix("branches/") {
        return (name.split('/').next().unwrap_or(name).into(), None);
    }
    if let Some(name) = relative_url.strip_prefix("tags/") {
        let name = name.split('/').next().unwrap_or(name);
        return (format!("tags/{name}"), Some(name.into()));
    }
    (
        relative_url.rsplit('/').next().unwrap_or("SVN").into(),
        None,
    )
}

fn parse_svn_list_entries(
    raw: &str,
) -> Result<Vec<(String, Option<String>, String)>, DesktopError> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let document = roxmltree::Document::parse(raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    Ok(document
        .descendants()
        .filter(|node| node.has_tag_name("entry"))
        .filter_map(|entry| {
            let name = entry
                .children()
                .find(|node| node.has_tag_name("name"))
                .and_then(|node| node.text())?
                .trim_end_matches('/')
                .to_string();
            if name.is_empty() {
                return None;
            }
            let commit = entry.children().find(|node| node.has_tag_name("commit"));
            let revision = commit
                .and_then(|node| node.attribute("revision"))
                .map(str::to_string);
            let date = commit
                .and_then(|node| node.children().find(|child| child.has_tag_name("date")))
                .and_then(|node| node.text())
                .unwrap_or_default()
                .to_string();
            Some((name, revision, date))
        })
        .collect())
}

async fn svn_incoming_revisions(repo: &RepositoryMeta, token: &CancellationToken) -> u32 {
    let revision = svn(
        vec!["info".into(), "--show-item".into(), "revision".into()],
        repo,
        token,
    )
    .await
    .ok()
    .and_then(|value| value.stdout_text().trim().parse::<u64>().ok());
    let Some(revision) = revision else { return 0 };
    let Some(start) = revision.checked_add(1) else {
        return 0;
    };
    let raw = svn(
        vec![
            "log".into(),
            "--xml".into(),
            "-r".into(),
            format!("{start}:HEAD"),
        ],
        repo,
        token,
    )
    .await
    .map(|value| value.stdout_text())
    .unwrap_or_default();
    roxmltree::Document::parse(&raw)
        .ok()
        .map(|document| {
            document
                .descendants()
                .filter(|node| node.has_tag_name("logentry"))
                .count()
                .min(u32::MAX as usize) as u32
        })
        .unwrap_or(0)
}

pub async fn tag_operation(
    repo: &RepositoryMeta,
    operation: TagOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if repo.kind == VcsKind::Svn {
        let is_merge = matches!(&operation, TagOperation::Merge { .. });
        if is_merge {
            prepare_svn_merge(repo, token).await?;
        }
        let args = match operation {
            TagOperation::Checkout { name } => {
                vec![
                    "switch".into(),
                    svn_repository_target(&format!("tags/{name}"))?,
                ]
            }
            TagOperation::Merge { name } => {
                vec![
                    "merge".into(),
                    svn_repository_target(&format!("tags/{name}"))?,
                ]
            }
            TagOperation::Delete { name } => {
                let target = svn_repository_target(&format!("tags/{name}"))?;
                vec![
                    "delete".into(),
                    target.clone(),
                    "--message".into(),
                    format!("Delete {target} from VersionDock"),
                ]
            }
            TagOperation::Create { name, revision } => {
                let destination = svn_repository_target(&format!("tags/{name}"))?;
                let relative = svn_relative_url(repo, token).await?;
                let source = if relative.is_empty() {
                    "^/".into()
                } else {
                    format!("^/{relative}")
                };
                let mut args = vec![
                    "copy".into(),
                    source,
                    destination,
                    "--message".into(),
                    format!("Create tag {name} from VersionDock"),
                ];
                if let Some(revision) = revision {
                    let revision = revision.trim_start_matches('r').to_string();
                    validate_svn_revision(&revision)?;
                    args.extend(["--revision".into(), revision]);
                }
                args
            }
            TagOperation::Push { .. } => {
                return Err(DesktopError::new(
                    "SVN_TAG_OPERATION_UNSUPPORTED",
                    "This tag operation is not available for SVN",
                    true,
                ));
            }
        };
        let result = svn(args, repo, token).await;
        if is_merge {
            record_svn_merge(repo, token).await;
        }
        result?;
        return Ok(());
    }
    ensure_git(repo)?;
    let args = match operation {
        TagOperation::Create { name, revision } => {
            validate_ref(&name)?;
            let mut args = vec!["tag".into(), name];
            if let Some(value) = revision {
                validate_revision_or_ref(&value)?;
                args.push(value);
            }
            args
        }
        TagOperation::Delete { name } => {
            validate_ref(&name)?;
            vec!["tag".into(), "-d".into(), name]
        }
        TagOperation::Checkout { name } => {
            validate_ref(&name)?;
            vec![
                "switch".into(),
                "--detach".into(),
                format!("refs/tags/{name}"),
            ]
        }
        TagOperation::Merge { name } => {
            validate_ref(&name)?;
            vec!["merge".into(), format!("refs/tags/{name}")]
        }
        TagOperation::Push { name, remote } => {
            validate_ref(&name)?;
            validate_ref(&remote)?;
            vec!["push".into(), remote, format!("refs/tags/{name}")]
        }
    };
    git(args, repo, token).await?;
    Ok(())
}

fn parse_name_status_z(raw: &str) -> Vec<ShelfFileEntry> {
    let mut files = Vec::new();
    let parts: Vec<&str> = raw.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let status_code = parts[i].trim();
        if status_code.is_empty() {
            i += 1;
            continue;
        }
        if status_code.starts_with('R') || status_code.starts_with('C') {
            if i + 2 < parts.len() {
                let new_path = parts[i + 2];
                if !new_path.is_empty() {
                    files.push(ShelfFileEntry {
                        path: new_path.to_string(),
                        status: "renamed".to_string(),
                    });
                }
                i += 3;
                continue;
            }
        } else if i + 1 < parts.len() {
            let path = parts[i + 1];
            if !path.is_empty() {
                let status = match status_code {
                    "M" => "modified",
                    "A" => "added",
                    "D" => "deleted",
                    "U" => "conflicted",
                    _ => "modified",
                };
                files.push(ShelfFileEntry {
                    path: path.to_string(),
                    status: status.to_string(),
                });
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    files
}

pub async fn stashes(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<StashEntry>, DesktopError> {
    ensure_git(repo)?;
    let format = format!("%gd{FIELD}%H{FIELD}%s{FIELD}%B{FIELD}%cI{RECORD}");
    let raw = git(
        vec!["stash".into(), "list".into(), format!("--format={format}")],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let mut entries = Vec::new();
    for record in raw.split(RECORD) {
        let fields = record.trim().split(FIELD).collect::<Vec<_>>();
        if fields.len() < 5 || !valid_stash_ref(fields[0]) {
            continue;
        }
        let reference = fields[0].trim().to_string();
        let hash = fields[1].trim().to_string();
        let subject = fields[2].trim();
        let raw_body = fields[3].trim();
        let date = fields[4].trim().to_string();

        let (branch, message, full_message) =
            if let Some(stripped) = subject.strip_prefix("WIP on ") {
                let (b, m) = stripped
                    .split_once(": ")
                    .map(|(b, m)| (b.to_string(), m.to_string()))
                    .unwrap_or_else(|| (String::new(), stripped.to_string()));
                let prefix = format!("WIP on {b}: ");
                let full = raw_body
                    .strip_prefix(&prefix)
                    .unwrap_or(raw_body)
                    .trim()
                    .to_string();
                let full_msg = if full.is_empty() { m.clone() } else { full };
                (b, m, full_msg)
            } else if let Some(stripped) = subject.strip_prefix("On ") {
                let (b, m) = stripped
                    .split_once(": ")
                    .map(|(b, m)| (b.to_string(), m.to_string()))
                    .unwrap_or_else(|| (String::new(), stripped.to_string()));
                let prefix = format!("On {b}: ");
                let full = raw_body
                    .strip_prefix(&prefix)
                    .unwrap_or(raw_body)
                    .trim()
                    .to_string();
                let full_msg = if full.is_empty() { m.clone() } else { full };
                (b, m, full_msg)
            } else {
                (
                    String::new(),
                    subject.to_string(),
                    if raw_body.is_empty() {
                        subject.to_string()
                    } else {
                        raw_body.to_string()
                    },
                )
            };

        let mut files = Vec::new();
        if let Ok(show_out) = git(
            vec![
                "stash".into(),
                "show".into(),
                "--name-status".into(),
                "-z".into(),
                reference.clone(),
            ],
            repo,
            token,
        )
        .await
        {
            files = parse_name_status_z(&show_out.stdout_text());
        }

        if let Ok(untracked_out) = git(
            vec![
                "ls-tree".into(),
                "-r".into(),
                "--name-only".into(),
                "-z".into(),
                format!("{reference}^3"),
            ],
            repo,
            token,
        )
        .await
        {
            let tracked_set: std::collections::HashSet<String> =
                files.iter().map(|f| f.path.clone()).collect();
            for path in untracked_out.stdout_text().split('\0') {
                let path = path.trim();
                if !path.is_empty() && !tracked_set.contains(path) {
                    files.push(ShelfFileEntry {
                        path: path.to_string(),
                        status: "untracked".to_string(),
                    });
                }
            }
        }

        entries.push(StashEntry {
            reference,
            hash,
            branch,
            message,
            full_message,
            date,
            files,
        });
    }
    Ok(entries)
}

pub async fn stash_file_diff(
    repo: &RepositoryMeta,
    reference: &str,
    path: &str,
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    ensure_git(repo)?;
    validate_stash_ref(reference)?;
    let safe = relative_path(Path::new(&repo.root_path), path, false)?;
    let pathspec = format!(":(literal){safe}");
    let mut output = git(
        vec![
            "diff".into(),
            "-U999999".into(),
            "--no-ext-diff".into(),
            "--no-color".into(),
            "--binary".into(),
            format!("{reference}^1"),
            reference.into(),
            "--".into(),
            pathspec.clone(),
        ],
        repo,
        token,
    )
    .await?;
    if output.stdout.is_empty()
        && git(
            vec![
                "cat-file".into(),
                "-e".into(),
                format!("{reference}^3:{safe}"),
            ],
            repo,
            token,
        )
        .await
        .is_ok()
    {
        output = git(
            vec![
                "diff".into(),
                "-U999999".into(),
                "--no-ext-diff".into(),
                "--no-color".into(),
                "--binary".into(),
                "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into(),
                format!("{reference}^3"),
                "--".into(),
                pathspec,
            ],
            repo,
            token,
        )
        .await?;
    }
    make_diff(path, output.stdout)
}

pub async fn stash_operation(
    repo: &RepositoryMeta,
    operation: StashOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    match operation {
        StashOperation::Create {
            message,
            paths,
            include_untracked,
        } => {
            let message = validate_message(&message)?;
            let root = Path::new(&repo.root_path);
            let mut args = vec![
                "stash".into(),
                "push".into(),
                "--message".into(),
                message.into(),
            ];
            if include_untracked {
                args.push("--include-untracked".into());
            }
            if !paths.is_empty() {
                args.push("--".into());
                args.extend(
                    paths
                        .iter()
                        .map(|path| literal_path(root, path, true))
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            git(args, repo, token).await?;
        }
        StashOperation::Apply { reference } => {
            validate_stash_ref(&reference)?;
            git(vec!["stash".into(), "apply".into(), reference], repo, token).await?;
        }
        StashOperation::Pop { reference } => {
            validate_stash_ref(&reference)?;
            git(vec!["stash".into(), "pop".into(), reference], repo, token).await?;
        }
        StashOperation::Drop { reference } => {
            validate_stash_ref(&reference)?;
            git(vec!["stash".into(), "drop".into(), reference], repo, token).await?;
        }
    }
    Ok(())
}

fn valid_stash_ref(value: &str) -> bool {
    let Some(index) = value
        .strip_prefix("stash@{")
        .and_then(|value| value.strip_suffix('}'))
    else {
        return false;
    };
    !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
}

fn validate_stash_ref(value: &str) -> Result<(), DesktopError> {
    if valid_stash_ref(value) {
        Ok(())
    } else {
        Err(DesktopError::new(
            "INVALID_STASH_REF",
            "Invalid stash reference",
            false,
        ))
    }
}

pub async fn worktrees(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<WorktreeEntry>, DesktopError> {
    ensure_git(repo)?;
    let raw = git(
        vec![
            "worktree".into(),
            "list".into(),
            "--porcelain".into(),
            "-z".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let main = std::fs::canonicalize(&repo.root_path)
        .unwrap_or_else(|_| Path::new(&repo.root_path).to_path_buf());
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for field in raw.split('\0').filter(|value| !value.is_empty()) {
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            let canonical =
                std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf());
            current = Some(WorktreeEntry {
                path: path.into(),
                head: String::new(),
                branch: String::new(),
                bare: false,
                detached: false,
                locked: false,
                lock_reason: None,
                prunable: false,
                main: canonical == main,
            });
        } else if let Some(entry) = current.as_mut() {
            if let Some(head) = field.strip_prefix("HEAD ") {
                entry.head = head.into();
            } else if let Some(branch) = field.strip_prefix("branch refs/heads/") {
                entry.branch = branch.into();
            } else if field == "bare" {
                entry.bare = true;
            } else if field == "detached" {
                entry.detached = true;
            } else if let Some(reason) = field.strip_prefix("locked") {
                entry.locked = true;
                entry.lock_reason = reason
                    .trim()
                    .is_empty()
                    .then_some(String::new())
                    .or_else(|| Some(reason.trim().into()));
            } else if field.starts_with("prunable") {
                entry.prunable = true;
            }
        }
    }
    if let Some(entry) = current {
        entries.push(entry);
    }
    Ok(entries)
}

pub async fn subtrees(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<SubtreeEntry>, DesktopError> {
    ensure_git(repo)?;
    let raw = git(
        vec![
            "config".into(),
            "--local".into(),
            "--null".into(),
            "--list".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let mut records = HashMap::<String, SubtreeConfigRecord>::new();
    for item in raw.split('\0').filter(|item| !item.is_empty()) {
        let Some((key, value)) = item.split_once('\n') else {
            continue;
        };
        let Some((id, field)) = parse_subtree_config_key(key) else {
            continue;
        };
        let record = records.entry(id.into()).or_default();
        match field {
            "version" => record.version = Some(value.into()),
            "prefix" => record.prefix = Some(value.into()),
            "remote" => record.remote = Some(value.into()),
            "branch" => record.branch = Some(value.into()),
            "squash" => record.squash = Some(value.into()),
            "state" => record.state = Some(value.into()),
            _ => unreachable!("subtree config keys are allowlisted"),
        }
    }

    let mut entries = records
        .into_iter()
        .filter_map(|(id, record)| subtree_entry_from_config(id, record).ok())
        .collect::<Vec<_>>();

    let existing_prefixes = entries
        .iter()
        .map(|e| e.prefix.clone())
        .collect::<HashSet<_>>();

    if let Ok(imported) = import_vscode_subtrees_if_needed(repo, &existing_prefixes, token).await {
        entries.extend(imported);
    }

    entries.sort_by(|left, right| {
        left.prefix
            .cmp(&right.prefix)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(entries)
}

pub async fn submodules(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<SubmoduleEntry>, DesktopError> {
    ensure_git(repo)?;
    let modules_file = Path::new(&repo.root_path).join(".gitmodules");
    if !modules_file.is_file() {
        return Ok(Vec::new());
    }
    let raw = git(
        vec![
            "config".into(),
            "--file".into(),
            ".gitmodules".into(),
            "--null".into(),
            "--get-regexp".into(),
            r"^submodule\..*\.".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    #[derive(Default)]
    struct Record {
        path: Option<String>,
        url: Option<String>,
        branch: Option<String>,
    }
    let mut records = HashMap::<String, Record>::new();
    for item in raw.split('\0').filter(|item| !item.is_empty()) {
        let Some((key, value)) = item.split_once('\n') else {
            continue;
        };
        let Some(rest) = key.strip_prefix("submodule.") else {
            continue;
        };
        let Some((name, field)) = rest.rsplit_once('.') else {
            continue;
        };
        let record = records.entry(name.into()).or_default();
        match field {
            "path" => record.path = Some(value.into()),
            "url" => record.url = Some(value.into()),
            "branch" => record.branch = Some(value.into()),
            _ => {}
        }
    }
    let mut entries = Vec::new();
    for record in records.into_values() {
        let (Some(path), Some(url)) = (record.path, record.url) else {
            continue;
        };
        let path = relative_path(Path::new(&repo.root_path), &path, false)?;
        let status = git(
            vec![
                "submodule".into(),
                "status".into(),
                "--".into(),
                path.clone(),
            ],
            repo,
            token,
        )
        .await?
        .stdout_text();
        let marker = status.chars().next().unwrap_or('-');
        let revision = status
            .get(1..)
            .and_then(|value| value.split_whitespace().next())
            .filter(|value| value.len() >= 7)
            .map(str::to_string);
        entries.push(SubmoduleEntry {
            initialized: marker != '-',
            dirty: matches!(marker, '+' | 'U'),
            path,
            url: redact_url(&url),
            revision,
            branch: record.branch,
        });
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

pub async fn submodule_operation(
    repo: &RepositoryMeta,
    operation: SubmoduleOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    let (path, mut args, network) = match operation {
        SubmoduleOperation::Init { path, recursive } => {
            let mut args = vec!["submodule".into(), "update".into(), "--init".into()];
            if recursive {
                args.push("--recursive".into());
            }
            (path, args, true)
        }
        SubmoduleOperation::Update {
            path,
            init,
            recursive,
            remote,
        } => {
            let mut args = vec!["submodule".into(), "update".into()];
            if init {
                args.push("--init".into());
            }
            if recursive {
                args.push("--recursive".into());
            }
            if remote {
                args.push("--remote".into());
            }
            (path, args, true)
        }
        SubmoduleOperation::Deinit { path, force } => {
            let mut args = vec!["submodule".into(), "deinit".into()];
            if force {
                args.push("--force".into());
            }
            (path, args, false)
        }
        SubmoduleOperation::Sync { path, recursive } => {
            let mut args = vec!["submodule".into(), "sync".into()];
            if recursive {
                args.push("--recursive".into());
            }
            (path, args, false)
        }
    };
    let entry = submodules(repo, token)
        .await?
        .into_iter()
        .find(|entry| entry.path == path)
        .ok_or_else(|| {
            DesktopError::new(
                "SUBMODULE_NOT_FOUND",
                "The path is not declared in .gitmodules",
                true,
            )
        })?;
    args.extend(["--".into(), entry.path]);
    if network {
        args.splice(0..0, ["-c".into(), "protocol.file.allow=always".into()]);
        git_network(args, repo, token).await?;
    } else {
        git(args, repo, token).await?;
    }
    Ok(())
}

pub async fn subtree_operation(
    repo: &RepositoryMeta,
    operation: SubtreeOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    match operation {
        SubtreeOperation::Add {
            prefix,
            remote,
            branch,
            squash,
        } => {
            ensure_clean_worktree(repo, token).await?;
            validate_subtree_prefix(repo, &prefix)?;
            validate_subtree_remote(repo, &remote, token).await?;
            validate_ref(&branch)?;
            let existing = subtrees(repo, token).await?;
            if existing.iter().any(|entry| entry.prefix == prefix) {
                return Err(DesktopError::new(
                    "SUBTREE_PREFIX_EXISTS",
                    "A subtree is already registered for this prefix",
                    true,
                ));
            }
            let id = subtree_id(&prefix);
            if existing.iter().any(|entry| entry.id == id) {
                return Err(DesktopError::new(
                    "SUBTREE_ID_COLLISION",
                    "Subtree registration ID collision",
                    false,
                ));
            }
            let entry = SubtreeEntry {
                id,
                prefix,
                remote,
                branch,
                squash,
                state: SubtreeState::Pending,
            };
            persist_subtree(repo, &entry, token).await?;
            let mut args = vec![
                "subtree".into(),
                "add".into(),
                "--prefix".into(),
                entry.prefix.clone(),
            ];
            if entry.squash {
                args.push("--squash".into());
            }
            args.extend([entry.remote.clone(), entry.branch.clone()]);
            if let Err(error) = git_network(args, repo, token).await {
                remove_subtree_config(repo, &entry.id, token).await;
                return Err(error);
            }
            activate_subtree(repo, &entry.id, token).await.map_err(|_| {
                DesktopError::new(
                    "SUBTREE_REGISTRATION_PENDING",
                    "Subtree was added, but its registration is pending recovery",
                    true,
                )
            })
        }
        SubtreeOperation::Pull { subtree_id } => {
            ensure_clean_worktree(repo, token).await?;
            let entry = registered_subtree(repo, &subtree_id, token).await?;
            ensure_active_subtree(repo, &entry, token).await?;
            let mut args = vec![
                "subtree".into(),
                "pull".into(),
                "--prefix".into(),
                entry.prefix,
            ];
            if entry.squash {
                args.push("--squash".into());
            }
            args.extend([entry.remote, entry.branch]);
            git_network(args, repo, token).await.map(|_| ())
        }
        SubtreeOperation::Push { subtree_id } => {
            let entry = registered_subtree(repo, &subtree_id, token).await?;
            ensure_active_subtree(repo, &entry, token).await?;
            git_network(
                vec![
                    "subtree".into(),
                    "push".into(),
                    "--prefix".into(),
                    entry.prefix,
                    entry.remote,
                    entry.branch,
                ],
                repo,
                token,
            )
            .await
            .map(|_| ())
        }
        SubtreeOperation::Register {
            prefix,
            remote,
            branch,
            squash,
        } => {
            validate_subtree_prefix(repo, &prefix)?;
            validate_subtree_remote(repo, &remote, token).await?;
            validate_ref(&branch)?;
            let absolute = Path::new(&repo.root_path).join(&prefix);
            if !absolute.is_dir() {
                return Err(DesktopError::new(
                    "SUBTREE_PREFIX_NOT_FOUND",
                    "The subtree prefix must be an existing directory",
                    true,
                ));
            }
            let existing = subtrees(repo, token).await?;
            if existing.iter().any(|entry| entry.prefix == prefix) {
                return Err(DesktopError::new(
                    "SUBTREE_PREFIX_EXISTS",
                    "A subtree is already registered for this prefix",
                    true,
                ));
            }
            persist_subtree(
                repo,
                &SubtreeEntry {
                    id: subtree_id(&prefix),
                    prefix,
                    remote,
                    branch,
                    squash,
                    state: SubtreeState::Active,
                },
                token,
            )
            .await
        }
        SubtreeOperation::Edit {
            subtree_id: registration_id,
            prefix,
            remote,
            branch,
            squash,
        } => {
            let previous = registered_subtree(repo, &registration_id, token).await?;
            validate_subtree_prefix(repo, &prefix)?;
            validate_subtree_remote(repo, &remote, token).await?;
            validate_ref(&branch)?;
            let absolute = Path::new(&repo.root_path).join(&prefix);
            if !absolute.is_dir() {
                return Err(DesktopError::new(
                    "SUBTREE_PREFIX_NOT_FOUND",
                    "The subtree prefix must be an existing directory",
                    true,
                ));
            }
            let replacement = SubtreeEntry {
                id: subtree_id(&prefix),
                prefix,
                remote,
                branch,
                squash,
                state: SubtreeState::Active,
            };
            let existing = subtrees(repo, token).await?;
            if existing
                .iter()
                .any(|entry| entry.id != previous.id && entry.prefix == replacement.prefix)
            {
                return Err(DesktopError::new(
                    "SUBTREE_PREFIX_EXISTS",
                    "A subtree is already registered for this prefix",
                    true,
                ));
            }
            persist_subtree(repo, &replacement, token).await?;
            if replacement.id != previous.id {
                if let Err(error) = remove_subtree_config_strict(repo, &previous.id, token).await {
                    remove_subtree_config(repo, &replacement.id, token).await;
                    persist_subtree(repo, &previous, token).await.ok();
                    return Err(error);
                }
            }
            Ok(())
        }
        SubtreeOperation::DeleteRegistry { subtree_id } => {
            let entry = registered_subtree(repo, &subtree_id, token).await?;
            remove_subtree_config_strict(repo, &entry.id, token).await?;
            Ok(())
        }
        SubtreeOperation::RemoveFiles { subtree_id } => {
            ensure_clean_worktree(repo, token).await?;
            let entry = registered_subtree(repo, &subtree_id, token).await?;
            validate_subtree_prefix(repo, &entry.prefix)?;
            git(
                vec!["rm".into(), "-r".into(), "--".into(), entry.prefix],
                repo,
                token,
            )
            .await
            .map(|_| ())
        }
        SubtreeOperation::Split { subtree_id, branch } => {
            let entry = registered_subtree(repo, &subtree_id, token).await?;
            ensure_active_subtree(repo, &entry, token).await?;
            let mut args = vec![
                "subtree".into(),
                "split".into(),
                "--prefix".into(),
                entry.prefix,
            ];
            if let Some(branch) = branch.filter(|value| !value.trim().is_empty()) {
                validate_ref(&branch)?;
                args.extend(["--branch".into(), branch]);
            }
            git(args, repo, token).await.map(|_| ())
        }
        SubtreeOperation::Merge {
            subtree_id,
            revision,
            squash,
            message,
        } => {
            ensure_clean_worktree(repo, token).await?;
            let entry = registered_subtree(repo, &subtree_id, token).await?;
            ensure_active_subtree(repo, &entry, token).await?;
            validate_revision_or_ref(&revision)?;
            let mut args = vec![
                "subtree".into(),
                "merge".into(),
                "--prefix".into(),
                entry.prefix,
            ];
            if squash {
                args.push("--squash".into());
            }
            if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
                args.extend(["--message".into(), validate_message(&message)?.into()]);
            }
            args.push(revision);
            git(args, repo, token).await.map(|_| ())
        }
    }
}

#[derive(Default)]
struct SubtreeConfigRecord {
    version: Option<String>,
    prefix: Option<String>,
    remote: Option<String>,
    branch: Option<String>,
    squash: Option<String>,
    state: Option<String>,
}

fn parse_subtree_config_key(key: &str) -> Option<(&str, &str)> {
    let suffix = key.strip_prefix(SUBTREE_CONFIG_PREFIX)?;
    let (id, field) = suffix.split_once('.')?;
    if id.len() != 32
        || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !matches!(
            field,
            "version" | "prefix" | "remote" | "branch" | "squash" | "state"
        )
        || field.contains('.')
    {
        return None;
    }
    Some((id, field))
}

fn subtree_entry_from_config(
    id: String,
    record: SubtreeConfigRecord,
) -> Result<SubtreeEntry, DesktopError> {
    if record.version.as_deref() != Some("1") {
        return Err(invalid_subtree_registry(&id));
    }
    let prefix = record.prefix.ok_or_else(|| invalid_subtree_registry(&id))?;
    let remote = record.remote.ok_or_else(|| invalid_subtree_registry(&id))?;
    let branch = record.branch.ok_or_else(|| invalid_subtree_registry(&id))?;
    let squash = match record.squash.as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => return Err(invalid_subtree_registry(&id)),
    };
    let state = match record.state.as_deref() {
        Some("active") => SubtreeState::Active,
        Some("pending") => SubtreeState::Pending,
        _ => return Err(invalid_subtree_registry(&id)),
    };
    if !is_safe_subtree_relative_path(&prefix)
        || validate_subtree_remote_str(&remote).is_err()
        || validate_ref(&branch).is_err()
        || subtree_id(&prefix) != id
    {
        return Err(invalid_subtree_registry(&id));
    }
    Ok(SubtreeEntry {
        id,
        prefix,
        remote,
        branch,
        squash,
        state,
    })
}

async fn registered_subtree(
    repo: &RepositoryMeta,
    subtree_id: &str,
    token: &CancellationToken,
) -> Result<SubtreeEntry, DesktopError> {
    validate_subtree_id(subtree_id)?;
    subtrees(repo, token)
        .await?
        .into_iter()
        .find(|entry| entry.id == subtree_id)
        .ok_or_else(|| {
            DesktopError::new(
                "SUBTREE_NOT_FOUND",
                "Subtree registration was not found",
                true,
            )
        })
}

async fn persist_subtree(
    repo: &RepositoryMeta,
    entry: &SubtreeEntry,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let state_str = match entry.state {
        SubtreeState::Active => "active",
        SubtreeState::Pending => "pending",
    };
    for (field, value) in [
        ("version", "1"),
        ("prefix", entry.prefix.as_str()),
        ("remote", entry.remote.as_str()),
        ("branch", entry.branch.as_str()),
        ("squash", if entry.squash { "true" } else { "false" }),
        ("state", state_str),
    ] {
        if let Err(error) = git(
            vec![
                "config".into(),
                "--local".into(),
                subtree_config_key(&entry.id, field),
                value.into(),
            ],
            repo,
            token,
        )
        .await
        {
            remove_subtree_config(repo, &entry.id, token).await;
            return Err(error);
        }
    }
    Ok(())
}

async fn activate_subtree(
    repo: &RepositoryMeta,
    id: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    git(
        vec![
            "config".into(),
            "--local".into(),
            subtree_config_key(id, "state"),
            "active".into(),
        ],
        repo,
        token,
    )
    .await?;
    Ok(())
}

async fn remove_subtree_config_strict(
    repo: &RepositoryMeta,
    id: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    git(
        vec![
            "config".into(),
            "--local".into(),
            "--remove-section".into(),
            subtree_config_section(id),
        ],
        repo,
        token,
    )
    .await
    .map(|_| ())
}

async fn remove_subtree_config(repo: &RepositoryMeta, id: &str, token: &CancellationToken) {
    let _ = git(
        vec![
            "config".into(),
            "--local".into(),
            "--remove-section".into(),
            subtree_config_section(id),
        ],
        repo,
        token,
    )
    .await;
}

fn subtree_config_section(id: &str) -> String {
    format!("{}.{}", SUBTREE_CONFIG_PREFIX.trim_end_matches('.'), id)
}

fn subtree_config_key(id: &str, field: &str) -> String {
    format!("{SUBTREE_CONFIG_PREFIX}{id}.{field}")
}

fn subtree_id(prefix: &str) -> String {
    hex::encode(Sha256::digest(prefix.as_bytes()))[..32].into()
}

fn validate_subtree_id(value: &str) -> Result<(), DesktopError> {
    if value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(DesktopError::new(
            "INVALID_SUBTREE_ID",
            "Invalid subtree registration ID",
            false,
        ))
    }
}

fn validate_subtree_prefix(repo: &RepositoryMeta, value: &str) -> Result<(), DesktopError> {
    if !is_safe_subtree_relative_path(value) {
        return Err(DesktopError::new(
            "INVALID_SUBTREE_PREFIX",
            "Subtree prefix must be a safe repository-relative path",
            false,
        ));
    }
    safe_relative(Path::new(&repo.root_path), value, true).map_err(|_| {
        DesktopError::new(
            "INVALID_SUBTREE_PREFIX",
            "Subtree prefix must not traverse a symbolic link",
            false,
        )
    })?;
    Ok(())
}

fn validate_subtree_remote_str(value: &str) -> Result<(), DesktopError> {
    if value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("ssh://")
        || value.starts_with("git://")
        || value.starts_with("file://")
        || value.contains('@')
    {
        if value.is_empty()
            || value.len() > 1024
            || value.contains('\0')
            || value.contains(['\r', '\n'])
            || value.starts_with('-')
        {
            return Err(DesktopError::new(
                "INVALID_SUBTREE_REMOTE",
                "Subtree remote URL is invalid",
                false,
            ));
        }
        return Ok(());
    }
    validate_ref(value).map_err(|_| {
        DesktopError::new(
            "INVALID_SUBTREE_REMOTE",
            "Subtree remote must be an existing Git remote name or valid repository URL",
            false,
        )
    })
}

async fn validate_subtree_remote(
    repo: &RepositoryMeta,
    value: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    validate_subtree_remote_str(value)?;
    if value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("ssh://")
        || value.starts_with("git://")
        || value.starts_with("file://")
        || value.contains('@')
    {
        return Ok(());
    }
    git(
        vec!["remote".into(), "get-url".into(), value.into()],
        repo,
        token,
    )
    .await
    .map(|_| ())
    .map_err(|_| {
        DesktopError::new(
            "SUBTREE_REMOTE_NOT_FOUND",
            "Subtree remote is not configured for this repository",
            true,
        )
    })
}

fn vscode_workspace_storage_dirs() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        let home_path = PathBuf::from(home);
        candidates.push(home_path.join("Library/Application Support/Code/User/workspaceStorage"));
        candidates.push(home_path.join("Library/Application Support/Cursor/User/workspaceStorage"));
        candidates.push(home_path.join("Library/Application Support/Trae/User/workspaceStorage"));
        candidates.push(
            home_path.join("Library/Application Support/Code - Insiders/User/workspaceStorage"),
        );
        candidates
            .push(home_path.join("Library/Application Support/VSCodium/User/workspaceStorage"));
        candidates.push(home_path.join(".config/Code/User/workspaceStorage"));
        candidates.push(home_path.join(".config/Cursor/User/workspaceStorage"));
        candidates.push(home_path.join(".config/Trae/User/workspaceStorage"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata_path = PathBuf::from(appdata);
        candidates.push(appdata_path.join("Code/User/workspaceStorage"));
        candidates.push(appdata_path.join("Cursor/User/workspaceStorage"));
        candidates.push(appdata_path.join("Trae/User/workspaceStorage"));
    }
    candidates.push(PathBuf::from(
        "/Volumes/WorkSSD/VSCode/Code/User/workspaceStorage",
    ));
    candidates.retain(|dir| dir.is_dir());
    candidates
}

async fn extract_vscode_subtree_json(db_path: &Path) -> Vec<serde_json::Value> {
    let mut results = Vec::new();
    let output = tokio::process::Command::new("sqlite3")
        .arg(db_path)
        .arg("SELECT value FROM ItemTable WHERE key IN ('chenqinru.versiondock', 'versiondock.subtrees', 'RioNoir.gitcharm', 'gitcharm.subtrees');")
        .output()
        .await;
    if let Ok(out) = output {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if let Some(arr) = parsed
                        .get("versiondock.subtrees")
                        .or_else(|| parsed.get("gitcharm.subtrees"))
                        .and_then(|v| v.as_array())
                    {
                        results.extend(arr.clone());
                    } else if let Some(arr) = parsed.as_array() {
                        results.extend(arr.clone());
                    }
                }
            }
        }
    }
    if results.is_empty() {
        if let Ok(bytes) = std::fs::read(db_path) {
            let haystack = String::from_utf8_lossy(&bytes);
            for key_pattern in ["\"versiondock.subtrees\":[", "\"gitcharm.subtrees\":["] {
                if let Some(idx) = haystack.find(key_pattern) {
                    let slice = &haystack[idx + key_pattern.len() - 1..];
                    if let Some(end_idx) = slice.find(']') {
                        let json_str = &slice[..=end_idx];
                        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(json_str) {
                            results.extend(arr);
                        }
                    }
                }
            }
        }
    }
    results
}

async fn import_vscode_subtrees_if_needed(
    repo: &RepositoryMeta,
    existing_prefixes: &HashSet<String>,
    token: &CancellationToken,
) -> Result<Vec<SubtreeEntry>, DesktopError> {
    let mut imported = Vec::new();
    let dirs = vscode_workspace_storage_dirs();
    for base_dir in dirs {
        let Ok(read_dir) = std::fs::read_dir(&base_dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let db_path = entry.path().join("state.vscdb");
            if !db_path.is_file() {
                continue;
            }
            let values = extract_vscode_subtree_json(&db_path).await;
            for val in values {
                let Some(repo_id) = val.get("repoId").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(prefix) = val.get("prefix").and_then(|v| v.as_str()) else {
                    continue;
                };
                if existing_prefixes.contains(prefix) {
                    continue;
                }
                let Some(repository) = val.get("repository").and_then(|v| v.as_str()) else {
                    continue;
                };
                let branch = val.get("ref").and_then(|v| v.as_str()).unwrap_or("main");
                let squash = val
                    .get("defaultSquash")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let clean_repo_id = repo_id
                    .split("::")
                    .next()
                    .unwrap_or("")
                    .trim_end_matches('/');
                let clean_root_path = repo.root_path.trim_end_matches('/');
                let repo_name = Path::new(clean_root_path).file_name();
                let entry_repo_name = Path::new(clean_repo_id).file_name();

                let repo_match = clean_repo_id == clean_root_path
                    || clean_repo_id.contains(clean_root_path)
                    || clean_root_path.contains(clean_repo_id)
                    || (repo_name.is_some() && repo_name == entry_repo_name);

                if repo_match
                    && is_safe_subtree_relative_path(prefix)
                    && std::path::Path::new(&repo.root_path).join(prefix).exists()
                {
                    let id = subtree_id(prefix);
                    let subtree_entry = SubtreeEntry {
                        id,
                        prefix: prefix.to_string(),
                        remote: repository.to_string(),
                        branch: branch.to_string(),
                        squash,
                        state: SubtreeState::Active,
                    };
                    if !imported
                        .iter()
                        .any(|existing: &SubtreeEntry| existing.prefix == subtree_entry.prefix)
                    {
                        let _ = persist_subtree(repo, &subtree_entry, token).await;
                        imported.push(subtree_entry);
                    }
                }
            }
        }
    }

    Ok(imported)
}

async fn ensure_active_subtree(
    repo: &RepositoryMeta,
    entry: &SubtreeEntry,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if entry.state != SubtreeState::Active {
        return Err(DesktopError::new(
            "SUBTREE_REGISTRATION_PENDING",
            "Subtree registration is pending recovery; unregister it before retrying",
            true,
        ));
    }
    validate_subtree_prefix(repo, &entry.prefix)?;
    validate_subtree_remote(repo, &entry.remote, token).await
}

fn is_safe_subtree_relative_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 4 * 1024
        || value.contains(['\0', '\r', '\n'])
        || Path::new(value).is_absolute()
    {
        return false;
    }
    let mut has_normal_component = false;
    for component in Path::new(value).components() {
        match component {
            std::path::Component::Normal(_) => has_normal_component = true,
            _ => return false,
        }
    }
    has_normal_component
}

fn invalid_subtree_registry(id: &str) -> DesktopError {
    DesktopError::new(
        "INVALID_SUBTREE_REGISTRY",
        format!("Invalid subtree registry entry: {id}"),
        false,
    )
}

pub async fn remotes(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<RemoteInfo>, DesktopError> {
    ensure_git(repo)?;
    let names = git(vec!["remote".into()], repo, token).await?.stdout_text();
    let mut result = Vec::new();
    for name in names.lines().map(str::trim).filter(|name| !name.is_empty()) {
        validate_ref(name)?;
        let fetch_url = git(
            vec!["remote".into(), "get-url".into(), name.into()],
            repo,
            token,
        )
        .await?
        .stdout_text();
        let push_url = git(
            vec![
                "remote".into(),
                "get-url".into(),
                "--push".into(),
                name.into(),
            ],
            repo,
            token,
        )
        .await?
        .stdout_text();
        result.push(RemoteInfo {
            name: name.into(),
            fetch_url: redact_url(fetch_url.trim()),
            push_url: redact_url(push_url.trim()),
        });
    }
    Ok(result)
}

pub async fn remote_operation(
    repo: &RepositoryMeta,
    operation: RemoteOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    let (args, network) = match operation {
        RemoteOperation::Add { name, url } => {
            validate_ref(&name)?;
            validate_remote_url(&url)?;
            (vec!["remote".into(), "add".into(), name, url], false)
        }
        RemoteOperation::Rename { old_name, new_name } => {
            validate_ref(&old_name)?;
            validate_ref(&new_name)?;
            (
                vec!["remote".into(), "rename".into(), old_name, new_name],
                false,
            )
        }
        RemoteOperation::SetUrl { name, url, push } => {
            validate_ref(&name)?;
            validate_remote_url(&url)?;
            let mut args = vec!["remote".into(), "set-url".into()];
            if push {
                args.push("--push".into());
            }
            args.extend([name, url]);
            (args, false)
        }
        RemoteOperation::Remove { name } => {
            validate_ref(&name)?;
            (vec!["remote".into(), "remove".into(), name], false)
        }
        RemoteOperation::Prune { name } => {
            validate_ref(&name)?;
            (vec!["remote".into(), "prune".into(), name], true)
        }
    };
    if network {
        let mut safe = vec!["-c".into(), "core.quotepath=false".into()];
        safe.extend(args);
        cli::run(
            "git",
            &safe,
            Path::new(&repo.root_path),
            None,
            cli::NETWORK_TIMEOUT,
            token,
        )
        .await?;
    } else {
        git(args, repo, token).await?;
    }
    Ok(())
}

pub async fn svn_operation(
    repo: &RepositoryMeta,
    operation: SvnOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if repo.kind != VcsKind::Svn {
        return Err(DesktopError::new(
            "UNSUPPORTED_OPERATION",
            "This operation requires an SVN working copy",
            false,
        ));
    }
    let root = Path::new(&repo.root_path);
    let args = match operation {
        SvnOperation::Cleanup {
            break_locks,
            remove_unversioned,
            remove_ignored,
            include_externals,
        } => {
            let mut args = vec!["cleanup".into()];
            if break_locks {
                args.push("--break-locks".into());
            }
            if remove_unversioned {
                args.push("--remove-unversioned".into());
            }
            if remove_ignored {
                args.push("--remove-ignored".into());
            }
            if include_externals {
                args.push("--include-externals".into());
            }
            args.push(".".into());
            args
        }
        SvnOperation::ResolveWorking { paths } => {
            if paths.is_empty() {
                return Err(DesktopError::new(
                    "EMPTY_PATH_SELECTION",
                    "Select at least one conflict to resolve",
                    false,
                ));
            }
            let mut args = vec![
                "resolve".into(),
                "--accept".into(),
                "working".into(),
                "--".into(),
            ];
            args.extend(
                paths
                    .iter()
                    .map(|path| relative_path(root, path, true))
                    .collect::<Result<Vec<_>, _>>()?,
            );
            args
        }
        SvnOperation::Lock {
            paths,
            message,
            force,
        } => {
            if paths.is_empty() {
                return Err(DesktopError::new(
                    "EMPTY_PATH_SELECTION",
                    "Select at least one path to lock",
                    false,
                ));
            }
            let mut args = vec!["lock".into()];
            if force {
                args.push("--force".into());
            }
            if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
                args.extend(["--message".into(), validate_message(&message)?.into()]);
            }
            args.push("--".into());
            args.extend(
                paths
                    .iter()
                    .map(|path| relative_path(root, path, true))
                    .collect::<Result<Vec<_>, _>>()?,
            );
            args
        }
        SvnOperation::Unlock { paths, force } => {
            if paths.is_empty() {
                return Err(DesktopError::new(
                    "EMPTY_PATH_SELECTION",
                    "Select at least one path to unlock",
                    false,
                ));
            }
            let mut args = vec!["unlock".into()];
            if force {
                args.push("--force".into());
            }
            args.push("--".into());
            args.extend(
                paths
                    .iter()
                    .map(|path| relative_path(root, path, true))
                    .collect::<Result<Vec<_>, _>>()?,
            );
            args
        }
        SvnOperation::Relocate { from_url, to_url } => {
            validate_svn_url(&from_url)?;
            validate_svn_url(&to_url)?;
            vec!["relocate".into(), from_url, to_url, ".".into()]
        }
        SvnOperation::Switch {
            url,
            revision,
            ignore_ancestry,
        } => {
            validate_svn_url(&url)?;
            let mut args = vec!["switch".into()];
            if let Some(revision) = revision.filter(|value| !value.trim().is_empty()) {
                validate_svn_revision(&revision)?;
                args.extend(["--revision".into(), revision]);
            }
            if ignore_ancestry {
                args.push("--ignore-ancestry".into());
            }
            args.extend([url, ".".into()]);
            args
        }
        SvnOperation::Copy {
            source_url,
            destination_url,
            revision,
            message,
        } => {
            validate_svn_url(&source_url)?;
            validate_svn_url(&destination_url)?;
            let message = validate_message(&message)?;
            let mut args = vec!["copy".into()];
            if let Some(revision) = revision.filter(|value| !value.trim().is_empty()) {
                validate_svn_revision(&revision)?;
                args.extend(["--revision".into(), revision]);
            }
            args.extend([
                source_url,
                destination_url,
                "--message".into(),
                message.into(),
            ]);
            args
        }
    };
    svn(args, repo, token).await.map(|_| ())
}

pub async fn worktree_operation(
    config_dir: &Path,
    repo: &RepositoryMeta,
    operation: WorktreeOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    match operation {
        WorktreeOperation::Create { branch, new_branch } => {
            validate_ref(&branch)?;
            let encoded = hex::encode(Sha256::digest(branch.as_bytes()));
            let target = config_dir
                .join("worktrees")
                .join(&repo.id)
                .join(&encoded[..16]);
            if target.exists() {
                return Err(DesktopError::new(
                    "WORKTREE_EXISTS",
                    "Managed worktree already exists",
                    true,
                ));
            }
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|error| {
                    DesktopError::new("WORKTREE_STORAGE_FAILED", error.to_string(), true)
                })?;
            }
            let mut args = vec!["worktree".into(), "add".into()];
            if new_branch {
                args.extend(["-b".into(), branch.clone()]);
            }
            args.push(target.to_string_lossy().into_owned());
            if !new_branch {
                args.push(branch);
            }
            git(args, repo, token).await?;
        }
        WorktreeOperation::Remove { path, force } => {
            let entry = managed_worktree(config_dir, repo, &path, token).await?;
            if entry.main {
                return Err(DesktopError::new(
                    "WORKTREE_MAIN",
                    "The main worktree cannot be removed",
                    false,
                ));
            }
            let mut args = vec!["worktree".into(), "remove".into()];
            if force {
                args.push("--force".into());
            }
            args.push(entry.path);
            git(args, repo, token).await?;
        }
        WorktreeOperation::Lock { path } => {
            let entry = managed_worktree(config_dir, repo, &path, token).await?;
            git(
                vec!["worktree".into(), "lock".into(), entry.path],
                repo,
                token,
            )
            .await?;
        }
        WorktreeOperation::Unlock { path } => {
            let entry = managed_worktree(config_dir, repo, &path, token).await?;
            git(
                vec!["worktree".into(), "unlock".into(), entry.path],
                repo,
                token,
            )
            .await?;
        }
        WorktreeOperation::Prune => {
            git(vec!["worktree".into(), "prune".into()], repo, token).await?;
        }
    }
    Ok(())
}

async fn managed_worktree(
    config_dir: &Path,
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Result<WorktreeEntry, DesktopError> {
    if path.contains('\0') || !Path::new(path).is_absolute() {
        return Err(DesktopError::new(
            "INVALID_WORKTREE_PATH",
            "Invalid worktree path",
            false,
        ));
    }
    let managed_root = config_dir.join("worktrees").join(&repo.id);
    let candidate = std::fs::canonicalize(path).map_err(|_| {
        DesktopError::new(
            "WORKTREE_NOT_FOUND",
            "Worktree path is no longer available",
            true,
        )
    })?;
    let boundary = std::fs::canonicalize(&managed_root).unwrap_or(managed_root);
    if !candidate.starts_with(&boundary) {
        return Err(DesktopError::new(
            "WORKTREE_OUTSIDE_MANAGED_ROOT",
            "Only VersionDock-managed worktrees can be changed",
            false,
        ));
    }
    worktrees(repo, token)
        .await?
        .into_iter()
        .find(|entry| entry.path == path)
        .ok_or_else(|| DesktopError::new("WORKTREE_NOT_FOUND", "Worktree not found", true))
}

pub async fn managed_worktree_path(
    _config_dir: &Path,
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Result<PathBuf, DesktopError> {
    if path.contains('\0') || !Path::new(path).is_absolute() {
        return Err(DesktopError::new(
            "INVALID_WORKTREE_PATH",
            "Invalid worktree path",
            false,
        ));
    }
    let entry = worktrees(repo, token)
        .await?
        .into_iter()
        .find(|entry| entry.path == path)
        .ok_or_else(|| DesktopError::new("WORKTREE_NOT_FOUND", "Worktree not found", true))?;
    std::fs::canonicalize(entry.path).map_err(|_| {
        DesktopError::new(
            "WORKTREE_NOT_FOUND",
            "Worktree path is no longer available",
            true,
        )
    })
}

async fn worktree_git(
    path: &Path,
    args: Vec<String>,
    token: &CancellationToken,
) -> Result<cli::CommandOutput, DesktopError> {
    let mut safe = vec!["-c".into(), "core.quotepath=false".into()];
    safe.extend(args);
    cli::run("git", &safe, path, None, cli::DEFAULT_TIMEOUT, token).await
}

pub async fn worktree_diff(
    config_dir: &Path,
    repo: &RepositoryMeta,
    path: &str,
    base_ref: &str,
    token: &CancellationToken,
) -> Result<WorktreeDiffResult, DesktopError> {
    validate_revision_or_ref(base_ref)?;
    let worktree = managed_worktree_path(config_dir, repo, path, token).await?;
    let stats = worktree_git(
        &worktree,
        vec![
            "diff".into(),
            "--numstat".into(),
            base_ref.into(),
            "--".into(),
        ],
        token,
    )
    .await?
    .stdout_text();
    let statuses = worktree_git(
        &worktree,
        vec![
            "diff".into(),
            "--name-status".into(),
            "-M".into(),
            base_ref.into(),
            "--".into(),
        ],
        token,
    )
    .await?
    .stdout_text();
    let current_ref = worktree_git(
        &worktree,
        vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
        token,
    )
    .await?
    .stdout_text()
    .trim()
    .to_string();
    let mut files = merge_git_files(&stats, &statuses);
    let untracked = worktree_git(
        &worktree,
        vec![
            "ls-files".into(),
            "--others".into(),
            "--exclude-standard".into(),
            "-z".into(),
        ],
        token,
    )
    .await?
    .stdout_text();
    for path in untracked.split('\0').filter(|path| !path.is_empty()) {
        if files.iter().any(|file| file.path == path) {
            continue;
        }
        let added = std::fs::read_to_string(worktree.join(path))
            .ok()
            .map(|content| content.lines().count().min(u32::MAX as usize) as u32);
        files.push(CommitFile {
            path: path.into(),
            status: "A".into(),
            added,
            removed: Some(0),
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(WorktreeDiffResult {
        path: path.into(),
        base_ref: base_ref.into(),
        current_ref,
        files,
    })
}

pub async fn worktree_file_diff(
    config_dir: &Path,
    repo: &RepositoryMeta,
    path: &str,
    base_ref: &str,
    relative_path_value: &str,
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    validate_revision_or_ref(base_ref)?;
    let worktree = managed_worktree_path(config_dir, repo, path, token).await?;
    let relative = relative_path(&worktree, relative_path_value, false)?;
    let status = worktree_git(
        &worktree,
        vec![
            "status".into(),
            "--porcelain=v1".into(),
            "--".into(),
            format!(":(literal){relative}"),
        ],
        token,
    )
    .await?
    .stdout_text();
    if status.lines().any(|line| line.starts_with("??")) {
        return untracked_diff(&worktree, relative_path_value, &relative);
    }
    let output = worktree_git(
        &worktree,
        vec![
            "diff".into(),
            "-U999999".into(),
            "--no-ext-diff".into(),
            "--no-color".into(),
            "--binary".into(),
            base_ref.into(),
            "--".into(),
            format!(":(literal){relative}"),
        ],
        token,
    )
    .await?;
    make_diff(relative_path_value, output.stdout)
}

pub async fn branch_working_diff(
    repo: &RepositoryMeta,
    base_ref: &str,
    token: &CancellationToken,
) -> Result<WorktreeDiffResult, DesktopError> {
    ensure_git(repo)?;
    validate_revision_or_ref(base_ref)?;
    let stats = git(
        vec![
            "diff".into(),
            "--numstat".into(),
            base_ref.into(),
            "--".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let statuses = git(
        vec![
            "diff".into(),
            "--name-status".into(),
            "-M".into(),
            base_ref.into(),
            "--".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let current_ref = git(
        vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
        repo,
        token,
    )
    .await?
    .stdout_text()
    .trim()
    .to_string();
    let mut files = merge_git_files(&stats, &statuses);
    let untracked = git(
        vec![
            "ls-files".into(),
            "--others".into(),
            "--exclude-standard".into(),
            "-z".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let root = Path::new(&repo.root_path);
    for path in untracked.split('\0').filter(|path| !path.is_empty()) {
        if files.iter().any(|file| file.path == path) {
            continue;
        }
        let added = std::fs::read_to_string(root.join(path))
            .ok()
            .map(|content| content.lines().count().min(u32::MAX as usize) as u32);
        files.push(CommitFile {
            path: path.into(),
            status: "A".into(),
            added,
            removed: Some(0),
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(WorktreeDiffResult {
        path: repo.root_path.clone(),
        base_ref: base_ref.into(),
        current_ref,
        files,
    })
}

pub async fn branch_working_file_diff(
    repo: &RepositoryMeta,
    base_ref: &str,
    relative_path_value: &str,
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    ensure_git(repo)?;
    validate_revision_or_ref(base_ref)?;
    let root = Path::new(&repo.root_path);
    let relative = relative_path(root, relative_path_value, false)?;
    let status = git(
        vec![
            "status".into(),
            "--porcelain=v1".into(),
            "--".into(),
            format!(":(literal){relative}"),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    if status.lines().any(|line| line.starts_with("??")) {
        return untracked_diff(root, relative_path_value, &relative);
    }
    let output = git(
        vec![
            "diff".into(),
            "-U999999".into(),
            "--no-ext-diff".into(),
            "--no-color".into(),
            "--binary".into(),
            base_ref.into(),
            "--".into(),
            format!(":(literal){relative}"),
        ],
        repo,
        token,
    )
    .await?;
    make_diff(relative_path_value, output.stdout)
}

pub async fn conflict_versions(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Result<MergeVersions, DesktopError> {
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, false)?;
    let working_path = root.join(&safe);
    if working_path.is_dir() {
        return Err(DesktopError::new(
            "DIRECTORY_CONFLICT_NOT_EDITABLE",
            "Directory conflicts cannot be edited as text. Choose a conflict side or resolve the directory manually.",
            true,
        ));
    }
    let working_bytes = match tokio::fs::read(&working_path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            return Err(DesktopError::new(
                "FILE_READ_FAILED",
                error.to_string(),
                true,
            ))
        }
    };
    let binary = bytes_are_binary(&working_bytes);
    let working = String::from_utf8_lossy(&working_bytes).into_owned();
    let (base, ours, theirs) = match repo.kind {
        VcsKind::Git => {
            let base = git(vec!["show".into(), format!(":1:{safe}")], repo, token)
                .await
                .map(|output| output.stdout_text())
                .unwrap_or_default();
            let ours = git(vec!["show".into(), format!(":2:{safe}")], repo, token)
                .await
                .map(|output| output.stdout_text())
                .unwrap_or_default();
            let theirs = git(vec!["show".into(), format!(":3:{safe}")], repo, token)
                .await
                .map(|output| output.stdout_text())
                .unwrap_or_default();
            (base, ours, theirs)
        }
        VcsKind::Svn => svn_conflict_artifacts(root, &safe),
    };
    let mut conflicts = parse_conflict_blocks(&working);
    let mut marker_content = working.clone();
    if !binary && conflicts.is_empty() {
        marker_content = synthetic_conflict_content(&base, &ours, &theirs);
        conflicts = parse_conflict_blocks(&marker_content);
    }
    let ours_label = conflicts
        .first()
        .map(|block| block.ours_label.clone())
        .unwrap_or_else(|| "OURS".into());
    let theirs_label = conflicts
        .first()
        .map(|block| block.theirs_label.clone())
        .unwrap_or_else(|| "THEIRS".into());
    Ok(MergeVersions {
        path: safe.clone(),
        base,
        ours,
        theirs,
        working: working.clone(),
        marker_content,
        conflicts,
        ours_label,
        theirs_label,
        language: language_for(&safe),
        fingerprint: fingerprint(working.as_bytes()),
        binary,
    })
}

fn parse_conflict_blocks(content: &str) -> Vec<ConflictBlock> {
    enum MarkerState {
        Normal,
        Ours,
        Base,
        Theirs,
    }
    let mut state = MarkerState::Normal;
    let mut result = Vec::new();
    let mut current: Option<ConflictBlock> = None;
    for (line_index, line) in content.split('\n').enumerate() {
        match state {
            MarkerState::Normal => {
                if let Some(label) = line.strip_prefix("<<<<<<< ") {
                    current = Some(ConflictBlock {
                        index: result.len() as u32,
                        ours_label: label.to_string(),
                        theirs_label: String::new(),
                        ours_lines: Vec::new(),
                        base_lines: Vec::new(),
                        theirs_lines: Vec::new(),
                        start_line: line_index as u32,
                        end_line: line_index as u32,
                    });
                    state = MarkerState::Ours;
                }
            }
            MarkerState::Ours => {
                if line.starts_with("||||||| ") {
                    state = MarkerState::Base;
                } else if line == "=======" {
                    state = MarkerState::Theirs;
                } else if let Some(block) = current.as_mut() {
                    block.ours_lines.push(line.to_string());
                }
            }
            MarkerState::Base => {
                if line == "=======" {
                    state = MarkerState::Theirs;
                } else if let Some(block) = current.as_mut() {
                    block.base_lines.push(line.to_string());
                }
            }
            MarkerState::Theirs => {
                if let Some(label) = line.strip_prefix(">>>>>>> ") {
                    if let Some(mut block) = current.take() {
                        block.theirs_label = label.to_string();
                        block.end_line = line_index as u32;
                        result.push(block);
                    }
                    state = MarkerState::Normal;
                } else if let Some(block) = current.as_mut() {
                    block.theirs_lines.push(line.to_string());
                }
            }
        }
    }
    result
}

fn synthetic_conflict_content(base: &str, ours: &str, theirs: &str) -> String {
    let mut lines = vec!["<<<<<<< OURS".to_string()];
    if !ours.is_empty() {
        lines.extend(ours.split('\n').map(str::to_string));
    }
    if !base.is_empty() {
        lines.push("||||||| BASE".into());
        lines.extend(base.split('\n').map(str::to_string));
    }
    lines.push("=======".into());
    if !theirs.is_empty() {
        lines.extend(theirs.split('\n').map(str::to_string));
    }
    lines.push(">>>>>>> THEIRS".into());
    lines.join("\n")
}

async fn complete_git_merge_if_resolved(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<bool, DesktopError> {
    if repo.kind != VcsKind::Git || git_operation_name(Path::new(&repo.root_path)) != Some("merge")
    {
        return Ok(false);
    }
    let unresolved = git(
        vec![
            "diff".into(),
            "--name-only".into(),
            "--diff-filter=U".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    if !unresolved.trim().is_empty() {
        return Ok(false);
    }
    git(vec!["commit".into(), "--no-edit".into()], repo, token)
        .await
        .map_err(|error| {
            DesktopError::new(
                "MERGE_AUTO_COMMIT_FAILED",
                "All conflicts were resolved, but the merge commit could not be created",
                true,
            )
            .hint(error.message)
        })?;
    Ok(true)
}

pub async fn conflict_save(
    repo: &RepositoryMeta,
    path: &str,
    content: &str,
    expected: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if content.lines().any(|line| {
        line.starts_with("<<<<<<< ") || line == "=======" || line.starts_with(">>>>>>> ")
    }) {
        return Err(DesktopError::new(
            "UNRESOLVED_MARKERS",
            "Conflict markers remain in the result",
            true,
        ));
    }
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, true)?;
    let target = root.join(&safe);
    if target.is_dir() {
        return Err(DesktopError::new(
            "DIRECTORY_CONFLICT_NOT_EDITABLE",
            "Directory conflicts cannot be saved as text.",
            true,
        ));
    }
    let current = match tokio::fs::read(&target).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            return Err(DesktopError::new(
                "FILE_READ_FAILED",
                error.to_string(),
                true,
            ))
        }
    };
    if fingerprint(&current) != expected {
        return Err(DesktopError::new(
            "CONFLICT_STALE",
            "The file changed after it was loaded",
            true,
        ));
    }
    let temporary = target.with_extension(format!("versiondock-{}", std::process::id()));
    tokio::fs::write(&temporary, content)
        .await
        .map_err(|error| DesktopError::new("FILE_WRITE_FAILED", error.to_string(), true))?;
    tokio::fs::rename(&temporary, &target)
        .await
        .map_err(|error| DesktopError::new("FILE_WRITE_FAILED", error.to_string(), true))?;
    match repo.kind {
        VcsKind::Git => {
            stage(repo, &[safe], token).await?;
            complete_git_merge_if_resolved(repo, token).await?;
        }
        VcsKind::Svn => {
            svn(
                vec![
                    "resolve".into(),
                    "--accept".into(),
                    "working".into(),
                    "--".into(),
                    safe,
                ],
                repo,
                token,
            )
            .await?;
        }
    }
    Ok(())
}

pub async fn conflict_accept(
    repo: &RepositoryMeta,
    path: &str,
    choice: ConflictChoice,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, true)?;
    match repo.kind {
        VcsKind::Git => {
            match choice {
                ConflictChoice::Mine => {
                    git(
                        vec![
                            "checkout".into(),
                            "--ours".into(),
                            "--".into(),
                            safe.clone(),
                        ],
                        repo,
                        token,
                    )
                    .await?;
                }
                ConflictChoice::Theirs => {
                    git(
                        vec![
                            "checkout".into(),
                            "--theirs".into(),
                            "--".into(),
                            safe.clone(),
                        ],
                        repo,
                        token,
                    )
                    .await?;
                }
                ConflictChoice::Working => {}
            }
            stage(repo, &[safe], token).await?;
            complete_git_merge_if_resolved(repo, token).await?;
        }
        VcsKind::Svn => {
            let accept = match choice {
                ConflictChoice::Mine => "mine-full",
                ConflictChoice::Theirs => "theirs-full",
                ConflictChoice::Working => "working",
            };
            svn(
                vec![
                    "resolve".into(),
                    "--accept".into(),
                    accept.into(),
                    "--".into(),
                    safe,
                ],
                repo,
                token,
            )
            .await?;
        }
    }
    Ok(())
}

fn svn_conflict_artifacts(root: &Path, path: &str) -> (String, String, String) {
    let target = root.join(path);
    let parent = target.parent().unwrap_or(root);
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let mut mine = String::new();
    let mut left = String::new();
    let mut right = String::new();
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let value = std::fs::read_to_string(entry.path()).unwrap_or_default();
            if file_name == format!("{name}.mine") {
                mine = value;
            } else if file_name.starts_with(&format!("{name}.merge-left.r"))
                || (file_name.starts_with(&format!("{name}.r")) && left.is_empty())
            {
                left = value;
            } else if file_name.starts_with(&format!("{name}.merge-right.r"))
                || file_name.starts_with(&format!("{name}.r"))
            {
                right = value;
            }
        }
    }
    (left, mine, right)
}

fn fingerprint(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn ensure_git(repo: &RepositoryMeta) -> Result<(), DesktopError> {
    if repo.kind == VcsKind::Git {
        Ok(())
    } else {
        Err(DesktopError::new(
            "UNSUPPORTED_OPERATION",
            "Operation requires a Git repository",
            false,
        ))
    }
}

fn validate_message(value: &str) -> Result<&str, DesktopError> {
    let value = value.trim();
    if value.is_empty() {
        Err(DesktopError::new(
            "EMPTY_COMMIT_MESSAGE",
            "Commit message is required",
            true,
        ))
    } else if value.len() > 1_000_000 {
        Err(DesktopError::new(
            "COMMIT_MESSAGE_TOO_LARGE",
            "Commit message is too large",
            true,
        ))
    } else {
        Ok(value)
    }
}

fn validate_ref(value: &str) -> Result<(), DesktopError> {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('-')
        || value.contains('\0')
        || value.contains(['\r', '\n'])
        || value.contains("..")
        || value.contains("@{")
    {
        Err(DesktopError::new(
            "INVALID_REF",
            format!("Invalid Git ref: {value}"),
            false,
        ))
    } else {
        Ok(())
    }
}

fn validate_revision(value: &str) -> Result<(), DesktopError> {
    if (7..=64).contains(&value.len())
        && value.chars().all(|character| character.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err(DesktopError::new(
            "INVALID_REVISION",
            "Invalid Git revision",
            false,
        ))
    }
}

fn validate_revision_or_ref(value: &str) -> Result<(), DesktopError> {
    validate_revision(value).or_else(|_| validate_ref(value))
}

fn validate_remote_url(value: &str) -> Result<(), DesktopError> {
    if value.is_empty()
        || value.len() > 16 * 1024
        || value.starts_with('-')
        || value.contains('\0')
        || value.contains(['\r', '\n'])
    {
        Err(DesktopError::new(
            "INVALID_REMOTE_URL",
            "Invalid remote URL",
            false,
        ))
    } else {
        Ok(())
    }
}

fn validate_svn_url(value: &str) -> Result<(), DesktopError> {
    validate_remote_url(value)?;
    if value == "^"
        || value.starts_with("^/")
        || value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("svn://")
        || value.starts_with("svn+ssh://")
        || value.starts_with("file://")
    {
        Ok(())
    } else {
        Err(DesktopError::new(
            "INVALID_SVN_URL",
            "SVN URL must be repository-relative or use a supported URL scheme",
            false,
        ))
    }
}

fn redact_url(value: &str) -> String {
    let Some(scheme) = value.find("://") else {
        return value.to_string();
    };
    let authority_start = scheme + 3;
    let authority_end = value[authority_start..]
        .find(['/', '?', '#'])
        .map(|index| authority_start + index)
        .unwrap_or(value.len());
    let authority = &value[authority_start..authority_end];
    let Some(userinfo_end) = authority.rfind('@') else {
        return value.to_string();
    };
    format!(
        "{}<redacted>@{}{}",
        &value[..authority_start],
        &authority[userinfo_end + 1..],
        &value[authority_end..]
    )
}

fn validate_svn_revision(value: &str) -> Result<(), DesktopError> {
    if !value.is_empty() && value.chars().all(|character| character.is_ascii_digit()) {
        Ok(())
    } else {
        Err(DesktopError::new(
            "INVALID_REVISION",
            "Invalid SVN revision",
            false,
        ))
    }
}

fn parse_counter(value: &str, marker: &str) -> u32 {
    value
        .find(marker)
        .and_then(|index| {
            value[index + marker.len()..]
                .split(|character: char| !character.is_ascii_digit())
                .next()
        })
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

pub(crate) fn language_for(path: &str) -> String {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "rs" => "rust",
        "ts" => "typescript",
        "tsx" => "tsx",
        "js" => "javascript",
        "jsx" => "jsx",
        "vue" => "vue",
        "svelte" => "svelte",
        "astro" => "astro",
        "py" => "python",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "json" => "json",
        "jsonc" => "jsonc",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "sass" => "sass",
        "less" => "less",
        "md" => "markdown",
        "mdx" => "mdx",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "shell",
        _ => "text",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_option_like_refs_and_revisions() {
        assert!(validate_ref("--upload-pack=evil").is_err());
        assert!(validate_ref("feature/good").is_ok());
        assert!(validate_revision("abcdef1234567").is_ok());
        assert!(validate_revision("HEAD").is_err());
    }

    #[test]
    fn large_diff_is_not_returned() {
        let result = make_diff("large.txt", vec![b'a'; DIFF_MAX_BYTES + 1]).unwrap();
        assert!(result.truncated);
        assert!(result.content.is_empty());
    }

    #[test]
    fn maps_embedded_and_extension_specific_languages_for_diff_highlighting() {
        assert_eq!(language_for("src/views/detail.vue"), "vue");
        assert_eq!(language_for("src/App.tsx"), "tsx");
        assert_eq!(language_for("styles/theme.scss"), "scss");
        assert_eq!(language_for("config/settings.jsonc"), "jsonc");
    }

    #[test]
    fn detects_binary_magic_without_relying_on_nul_bytes() {
        assert!(bytes_are_binary(b"\x89PNG\r\n\x1a\nnot-yet-compressed"));
        assert!(bytes_are_binary(b"%PDF-1.7\n1 0 obj"));
        assert!(!bytes_are_binary("中文文本\nsecond line".as_bytes()));
    }

    #[test]
    fn parses_two_way_and_diff3_conflict_blocks() {
        let content = "before\n<<<<<<< HEAD\nours one\n||||||| base\nbase one\n=======\ntheirs one\n>>>>>>> feature\nmiddle\n<<<<<<< HEAD\nours two\n=======\ntheirs two\n>>>>>>> feature\nafter";
        let values = parse_conflict_blocks(content);
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].base_lines, ["base one"]);
        assert_eq!(values[0].start_line, 1);
        assert_eq!(values[0].end_line, 7);
        assert!(values[1].base_lines.is_empty());
        assert_eq!(values[1].ours_lines, ["ours two"]);
        assert_eq!(values[1].theirs_lines, ["theirs two"]);
    }

    #[test]
    fn synthesizes_marker_content_for_add_delete_conflicts() {
        let value = synthetic_conflict_content("base", "", "incoming");
        let conflicts = parse_conflict_blocks(&value);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].ours_lines.is_empty());
        assert_eq!(conflicts[0].base_lines, ["base"]);
        assert_eq!(conflicts[0].theirs_lines, ["incoming"]);
    }

    #[tokio::test]
    async fn loads_missing_svn_conflict_files_from_virtual_artifacts() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("missing.txt.mine"), "local\n").unwrap();
        std::fs::write(root.path().join("missing.txt.merge-left.r1"), "base\n").unwrap();
        std::fs::write(root.path().join("missing.txt.merge-right.r2"), "incoming\n").unwrap();
        let repository = RepositoryMeta {
            id: "svn".into(),
            name: "svn".into(),
            root_path: root.path().to_string_lossy().into_owned(),
            color: "#4ec9b0".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let versions = conflict_versions(&repository, "missing.txt", &CancellationToken::new())
            .await
            .unwrap();
        assert!(versions.working.is_empty());
        assert_eq!(versions.base, "base\n");
        assert_eq!(versions.ours, "local\n");
        assert_eq!(versions.theirs, "incoming\n");
        assert_eq!(versions.conflicts.len(), 1);
    }

    #[tokio::test]
    async fn rejects_directory_conflicts_as_text_documents() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("conflicted-directory")).unwrap();
        let repository = RepositoryMeta {
            id: "svn".into(),
            name: "svn".into(),
            root_path: root.path().to_string_lossy().into_owned(),
            color: "#4ec9b0".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let error = conflict_versions(
            &repository,
            "conflicted-directory",
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "DIRECTORY_CONFLICT_NOT_EDITABLE");
    }

    #[test]
    fn file_history_tracks_the_historical_path_across_copy_and_rename_records() {
        let output = format!(
            "{RECORD}new{FIELD}parent{FIELD}Ada{FIELD}2026-01-02{FIELD}copy file\nC007\tsrc/old.rs\tsrc/new.rs\n{RECORD}old{FIELD}root{FIELD}Ada{FIELD}2026-01-01{FIELD}edit source\nM\tsrc/old.rs\n"
        );
        let entries = parse_git_file_history(&output, "src/new.rs");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "src/new.rs");
        assert_eq!(entries[0].previous_path.as_deref(), Some("src/old.rs"));
        assert_eq!(entries[1].path, "src/old.rs");
        assert_eq!(entries[1].previous_path, None);
    }

    #[test]
    fn file_history_cursor_round_trips_its_repository_path_and_revision_context() {
        let cursor = FileHistoryCursor {
            repo_id: "git-repo".into(),
            path: "src/中文 file.rs".into(),
            vcs: VcsKind::Git,
            offset: 100,
            anchor_revision: "abcdef1234567890".into(),
            peg_revision: None,
        };
        let encoded = encode_file_history_cursor(&cursor).unwrap();
        let decoded = decode_file_history_cursor(&encoded).unwrap();
        assert_eq!(decoded.repo_id, cursor.repo_id);
        assert_eq!(decoded.path, cursor.path);
        assert_eq!(decoded.offset, 100);
        assert_eq!(decoded.anchor_revision, cursor.anchor_revision);
        assert!(decode_file_history_cursor("100").is_err());
    }

    #[test]
    fn keeps_remote_names_with_slashes_intact() {
        let remotes = vec!["company/remote".into(), "origin".into()];
        assert_eq!(
            remote_name_for_ref("refs/remotes/company/remote/feature/ui", &remotes),
            Some("company/remote".into())
        );
        assert_eq!(
            remote_name_for_ref("refs/remotes/origin/main", &remotes),
            Some("origin".into())
        );
    }

    #[test]
    fn parses_svn_branch_and_tag_listing_entries() {
        let xml = r#"<lists><list><entry kind="dir"><name>release/</name><commit revision="42"><date>2026-08-13T08:00:00.000000Z</date></commit></entry><entry kind="dir"><name>v1.0.0/</name><commit revision="43"><date>2026-08-14T08:00:00.000000Z</date></commit></entry></list></lists>"#;
        let entries = parse_svn_list_entries(xml).unwrap();
        assert_eq!(entries[0].0, "release");
        assert_eq!(entries[0].1.as_deref(), Some("42"));
        assert_eq!(
            svn_display_ref("^/branches/release/src"),
            ("release".into(), None)
        );
        assert_eq!(
            svn_display_ref("^/tags/v1.0.0"),
            ("tags/v1.0.0".into(), Some("v1.0.0".into()))
        );
    }
}
