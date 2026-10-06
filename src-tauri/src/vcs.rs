use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
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
        HistoryQuery, IgnoreRules, IncomingCommit, LineRange, MergeCommitSummary,
        MergeParentChange, MergeVersions, PatchDocument, RecentCommitMessage, RemoteInfo,
        RemoteOperation, RepositoryMeta, RepositoryUpdateResult, RestoreConflictFailure,
        RestoreConflictsResult, RevisionChanges, ShelfFileEntry, StashEntry, StashOperation,
        SubmoduleConflictStages, SubmoduleEntry, SubmoduleOperation, SubmoduleSyncStatus,
        SubtreeEntry, SubtreeOperation, SubtreePushStatus, SubtreeState, SvnOperation, SyncAction,
        SyncResult, TagInfo, TagOperation, UnpushedCommit, UnpushedOperation, UpdateDetail,
        UpdateKind, UpdateSummary, VcsKind, WorktreeDiffResult, WorktreeEntry, WorktreeOperation,
    },
    state::safe_relative,
};

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';
const META_END: char = '\u{1d}';
const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DIFF_MAX_BYTES: usize = 5 * 1024 * 1024;
const DIFF_MAX_LINES: usize = 50_000;
const SUBTREE_CONFIG_PREFIX: &str = "versiondock.subtree.";

#[derive(Debug, Clone, Default)]
struct PendingSvnMerge {
    paths: Vec<String>,
    added_paths: Vec<String>,
}

#[derive(Debug)]
struct SvnProbeState {
    task_id: u64,
    active_revision: u64,
    pending: Option<(RepositoryMeta, u64)>,
    token: CancellationToken,
}

static SVN_MERGES: OnceLock<Mutex<HashMap<String, PendingSvnMerge>>> = OnceLock::new();
static SUBTREE_SPLIT_CACHE: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
static SUBTREE_STATUS_CACHE: OnceLock<Mutex<HashMap<String, (Instant, SubtreePushStatus)>>> =
    OnceLock::new();
type SvnBranchCacheEntry = (Instant, bool, Vec<String>);
type SvnTagCacheEntry = (Instant, Vec<TagInfo>);
type SvnIncomingCacheEntry = (Instant, u64, u32);
static SVN_BRANCH_CACHE: OnceLock<Mutex<HashMap<String, SvnBranchCacheEntry>>> = OnceLock::new();
static SVN_TAG_CACHE: OnceLock<Mutex<HashMap<String, SvnTagCacheEntry>>> = OnceLock::new();
struct SvnRefQueries {
    valid: AtomicBool,
    branches: tokio::sync::Mutex<()>,
    tags: tokio::sync::Mutex<()>,
}
static SVN_REF_QUERIES: OnceLock<Mutex<HashMap<String, Arc<SvnRefQueries>>>> = OnceLock::new();
fn svn_ref_queries(repo_id: &str) -> Arc<SvnRefQueries> {
    SVN_REF_QUERIES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(repo_id.into())
        .or_insert_with(|| {
            Arc::new(SvnRefQueries {
                valid: AtomicBool::new(true),
                branches: tokio::sync::Mutex::new(()),
                tags: tokio::sync::Mutex::new(()),
            })
        })
        .clone()
}
static SVN_INCOMING_CACHE: OnceLock<Mutex<HashMap<String, SvnIncomingCacheEntry>>> =
    OnceLock::new();
static SVN_INCOMING_GENERATION: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static SVN_INCOMING_PROBING: OnceLock<Mutex<HashMap<String, SvnProbeState>>> = OnceLock::new();
static SVN_PROBE_TASK_SEQ: AtomicU64 = AtomicU64::new(1);
static STASH_FILES_CACHE: OnceLock<Mutex<HashMap<String, Vec<ShelfFileEntry>>>> = OnceLock::new();

fn svn_merges() -> &'static Mutex<HashMap<String, PendingSvnMerge>> {
    SVN_MERGES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn subtree_split_cache() -> &'static Mutex<HashMap<String, (String, String)>> {
    SUBTREE_SPLIT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn subtree_status_cache() -> &'static Mutex<HashMap<String, (Instant, SubtreePushStatus)>> {
    SUBTREE_STATUS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn invalidate_subtree_status_cache(repo_id: &str) {
    if let Ok(mut cache) = subtree_status_cache().lock() {
        let prefix = format!("{repo_id}\0");
        cache.retain(|key, _| !key.starts_with(&prefix));
    }
}

pub fn invalidate_svn_ref_caches(repo_id: &str) {
    if let Ok(mut queries) = SVN_REF_QUERIES.get_or_init(Default::default).lock() {
        if let Some(previous) = queries.remove(repo_id) {
            previous.valid.store(false, Ordering::SeqCst);
        }
    }
    if let Ok(mut cache) = SVN_BRANCH_CACHE.get_or_init(Default::default).lock() {
        if let Some(entry) = cache.get_mut(repo_id) {
            entry.0 = Instant::now();
        }
    }
    if let Ok(mut cache) = SVN_TAG_CACHE.get_or_init(Default::default).lock() {
        if let Some(entry) = cache.get_mut(repo_id) {
            entry.0 = Instant::now();
        }
    }
    if let Ok(mut cache) = SVN_INCOMING_CACHE.get_or_init(Default::default).lock() {
        cache.remove(repo_id);
        if let Ok(mut gens) = SVN_INCOMING_GENERATION.get_or_init(Default::default).lock() {
            let entry = gens.entry(repo_id.to_string()).or_insert(0);
            *entry = entry.wrapping_add(1);
        }
    } else if let Ok(mut gens) = SVN_INCOMING_GENERATION.get_or_init(Default::default).lock() {
        let entry = gens.entry(repo_id.to_string()).or_insert(0);
        *entry = entry.wrapping_add(1);
    }
    if let Ok(mut probing) = SVN_INCOMING_PROBING.get_or_init(Default::default).lock() {
        if let Some(state) = probing.remove(repo_id) {
            state.token.cancel();
        }
    }
    #[cfg(test)]
    if let Ok(mut map) = SVN_WC_REVISION_MOCK.get_or_init(Default::default).lock() {
        map.remove(repo_id);
    }
    #[cfg(test)]
    if let Ok(mut map) = SVN_INCOMING_MOCK_HANDLERS
        .get_or_init(Default::default)
        .lock()
    {
        map.remove(repo_id);
    }
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

// Ref metadata reports an empty upstream without failing for local-only,
// detached or unborn branches. Do not use rev-parse @{upstream} as a probe.
async fn git_upstream(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Option<String>, DesktopError> {
    git_upstream_at(repo, None, token).await
}

async fn git_upstream_at(
    repo: &RepositoryMeta,
    path: Option<&str>,
    token: &CancellationToken,
) -> Result<Option<String>, DesktopError> {
    let mut args = Vec::new();
    if let Some(path) = path {
        args.extend(["-C".into(), path.into()]);
    }
    args.extend([
        "for-each-ref".into(),
        "--format=%(HEAD)%00%(upstream)".into(),
        "refs/heads/".into(),
    ]);
    let output = git(args, repo, token).await?.stdout_text();
    let upstream = output
        .lines()
        .filter_map(|line| line.split_once('\0'))
        .find(|(head, _)| head.trim() == "*")
        .map(|(_, upstream)| upstream.trim().to_string())
        .filter(|upstream| !upstream.is_empty());
    let Some(upstream) = upstream else {
        return Ok(None);
    };
    // A configured tracking ref can have disappeared after fetch/prune. Like
    // the plugin's @{u} probe, treat it as absent, without logging a false error.
    let mut args = Vec::new();
    if let Some(path) = path {
        args.extend(["-C".into(), path.into()]);
    }
    args.extend([
        "for-each-ref".into(),
        "--format=%(refname)".into(),
        upstream.clone(),
    ]);
    let refs = git(args, repo, token).await?.stdout_text();
    Ok(refs
        .lines()
        .any(|name| name == upstream)
        .then_some(upstream))
}

async fn git_unpushed_count_at(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Result<u32, DesktopError> {
    let run = |args: Vec<String>| {
        let mut command = vec!["-C".into(), path.into()];
        command.extend(args);
        git(command, repo, token)
    };
    if let Some(upstream) = git_upstream_at(repo, Some(path), token).await? {
        if let Ok(output) = run(vec![
            "rev-list".into(),
            "--count".into(),
            format!("{upstream}..HEAD"),
        ])
        .await
        {
            return Ok(output.stdout_text().trim().parse().unwrap_or(0));
        }
    }
    // Detached HEAD and local branches without tracking still have unpublished
    // commits. Match GitService.countUnpushedCommits' remote-reachability fallback.
    let remotes = run(vec!["remote".into()]).await?.stdout_text();
    let mut args = vec!["rev-list".into(), "HEAD".into(), "--count".into()];
    if remotes.trim().is_empty() {
        args.push("--max-count=100".into());
    } else {
        args.extend(["--not".into(), "--remotes".into()]);
    }
    let output = run(args).await?;
    Ok(output.stdout_text().trim().parse().unwrap_or(0))
}

async fn git_network_quick(
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
        Duration::from_secs(8),
        token,
    )
    .await
}

async fn svn(
    args: Vec<String>,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<cli::CommandOutput, DesktopError> {
    svn_with_timeout(args, repo, token, cli::DEFAULT_TIMEOUT).await
}

async fn svn_with_timeout(
    args: Vec<String>,
    repo: &RepositoryMeta,
    token: &CancellationToken,
    timeout: Duration,
) -> Result<cli::CommandOutput, DesktopError> {
    svn_with_timeout_mode(args, repo, token, timeout, cli::SvnCommandMode::Standard).await
}

async fn svn_optional_directory(
    directory: &str,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Option<cli::CommandOutput>, DesktopError> {
    match svn_with_timeout_mode(
        vec!["ls".into(), "--xml".into(), directory.into()],
        repo,
        token,
        Duration::from_secs(8),
        cli::SvnCommandMode::OptionalDirectory,
    )
    .await
    {
        Ok(output) => Ok(Some(output)),
        Err(error) if error.code == "SVN_OPTIONAL_PATH_MISSING" => Ok(None),
        Err(error) => Err(error),
    }
}

async fn svn_with_timeout_mode(
    args: Vec<String>,
    repo: &RepositoryMeta,
    token: &CancellationToken,
    timeout: Duration,
    mode: cli::SvnCommandMode,
) -> Result<cli::CommandOutput, DesktopError> {
    let auth = crate::svn_account::cached_auth(repo);
    let first = svn_once(&args, repo, auth.as_ref(), timeout, token, mode).await;
    match first {
        Err(error) if error.code == "SVN_AUTH_FAILED" => {
            let Some(credentials) =
                crate::svn_account::authentication_retry(repo, auth, &error, token).await?
            else {
                return Err(error);
            };
            let retried = svn_once(&args, repo, Some(&credentials), timeout, token, mode).await;
            if retried
                .as_ref()
                .err()
                .is_some_and(|error| error.code == "SVN_AUTH_FAILED")
            {
                crate::svn_account::remember_auth_failure(repo);
            }
            retried
        }
        result => result,
    }
}

async fn svn_once(
    args: &[String],
    repo: &RepositoryMeta,
    auth: Option<&(String, String)>,
    timeout: Duration,
    token: &CancellationToken,
    mode: cli::SvnCommandMode,
) -> Result<cli::CommandOutput, DesktopError> {
    let mut safe = vec!["--non-interactive".into()];
    if let Some((username, _)) = auth {
        safe.extend([
            "--username".into(),
            username.clone(),
            "--password-from-stdin".into(),
            "--no-auth-cache".into(),
        ]);
    }
    safe.extend_from_slice(args);
    // EOF terminates SVN's stdin password without adding a platform-specific EOL.
    let input = auth.map(|(_, password)| password.as_bytes());
    cli::run_svn(
        &safe,
        Path::new(&repo.root_path),
        input,
        timeout,
        token,
        mode,
    )
    .await
}

fn literal_path(root: &Path, value: &str, include_leaf: bool) -> Result<String, DesktopError> {
    safe_relative(root, value, include_leaf)?;
    Ok(format!(":(literal){value}"))
}

fn relative_path(root: &Path, value: &str, include_leaf: bool) -> Result<String, DesktopError> {
    safe_relative(root, value, include_leaf)?;
    Ok(if cfg!(windows) {
        value.replace('\\', "/")
    } else {
        value.to_string()
    })
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

fn validate_checkout_target_name(target_name: &str) -> Result<(), DesktopError> {
    let windows_stem = target_name
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    let windows_reserved = matches!(windows_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (windows_stem.len() == 4
            && matches!(&windows_stem[..3], "COM" | "LPT")
            && matches!(windows_stem.as_bytes()[3], b'1'..=b'9'));
    if target_name.is_empty()
        || target_name.trim() != target_name
        || target_name.contains('\0')
        || target_name.chars().any(char::is_control)
        || target_name.chars().any(|character| {
            matches!(
                character,
                '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\'
            )
        })
        || option_like(target_name)
        || Path::new(target_name).components().count() != 1
        || matches!(target_name, "." | "..")
        || target_name.ends_with('.')
        || target_name.ends_with(' ')
        || windows_reserved
    {
        return Err(DesktopError::new(
            "INVALID_TARGET_NAME",
            "Invalid checkout target name",
            false,
        ));
    }
    Ok(())
}

fn meaningful_directory_entries(
    path: &Path,
    staging_name: Option<&str>,
) -> Result<Vec<String>, DesktopError> {
    let mut entries = Vec::new();
    for entry in path.read_dir().map_err(|error| {
        DesktopError::new("CHECKOUT_TARGET_UNAVAILABLE", error.to_string(), true)
    })? {
        let entry = entry.map_err(|error| {
            DesktopError::new("CHECKOUT_TARGET_UNAVAILABLE", error.to_string(), true)
        })?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), ".DS_Store" | "Thumbs.db") || staging_name == Some(name.as_str())
        {
            continue;
        }
        entries.push(name);
    }
    Ok(entries)
}

fn staging_directory(parent: &Path, target: &Path, target_name: &str, existed: bool) -> PathBuf {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    if existed {
        target.join(format!(".vd-staging-{suffix}"))
    } else {
        parent.join(format!(".{target_name}.vd-staging-{suffix}"))
    }
}

fn cleanup_checkout_staging(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn finalize_checkout(
    target: &Path,
    staging: &Path,
    target_existed: bool,
) -> Result<(), DesktopError> {
    if !target_existed {
        if target.exists() {
            return Err(DesktopError::new(
                "CHECKOUT_TARGET_CREATED_DURING_OPERATION",
                format!(
                    "The target was created during the operation; checkout files remain at {}",
                    staging.display()
                ),
                true,
            ));
        }
        std::fs::rename(staging, target).map_err(|error| {
            DesktopError::new("CHECKOUT_FINALIZE_FAILED", error.to_string(), true)
        })?;
        return Ok(());
    }

    let staging_name = staging.file_name().and_then(|value| value.to_str());
    if !meaningful_directory_entries(target, staging_name)?.is_empty() {
        return Err(DesktopError::new(
            "CHECKOUT_TARGET_CHANGED_DURING_OPERATION",
            format!(
                "The target is no longer empty; checkout files remain at {}",
                staging.display()
            ),
            true,
        ));
    }
    for system_file in [".DS_Store", "Thumbs.db"] {
        let path = target.join(system_file);
        if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
    }
    let mut moved = Vec::new();
    for entry in staging
        .read_dir()
        .map_err(|error| DesktopError::new("CHECKOUT_FINALIZE_FAILED", error.to_string(), true))?
    {
        let entry = entry.map_err(|error| {
            DesktopError::new("CHECKOUT_FINALIZE_FAILED", error.to_string(), true)
        })?;
        let name = entry.file_name();
        if let Err(error) = std::fs::rename(entry.path(), target.join(&name)) {
            for moved_name in moved.iter().rev() {
                let _ = std::fs::rename(target.join(moved_name), staging.join(moved_name));
            }
            return Err(DesktopError::new(
                "CHECKOUT_FINALIZE_FAILED",
                format!("{error}; staging files remain at {}", staging.display()),
                true,
            ));
        }
        moved.push(name);
    }
    std::fs::remove_dir(staging)
        .map_err(|error| DesktopError::new("CHECKOUT_FINALIZE_FAILED", error.to_string(), true))
}

pub async fn clone_repository(
    url: &str,
    parent: &Path,
    target_name: &str,
    credentials: Option<&(String, String)>,
    recurse_submodules: bool,
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
    let supported = url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("git://")
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
    validate_checkout_target_name(target_name)?;
    let target = safe_relative(parent, target_name, true)?;
    if target.exists()
        && (!target.is_dir() || !meaningful_directory_entries(&target, None)?.is_empty())
    {
        return Err(DesktopError::new(
            "CLONE_TARGET_NOT_EMPTY",
            "Clone target already exists and is not empty",
            true,
        ));
    }
    let existed = target.exists();
    let staging = staging_directory(parent, &target, target_name, existed);
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
    let mut clone_args = vec!["-c".into(), "core.quotepath=false".into(), "clone".into()];
    if recurse_submodules {
        clone_args.push("--recurse-submodules".into());
    }
    clone_args.extend([
        "--".into(),
        url.into(),
        staging.to_string_lossy().into_owned(),
    ]);
    let result = cli::run_with_env(
        "git",
        &clone_args,
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
        cleanup_checkout_staging(&staging);
        return Err(error);
    }
    finalize_checkout(&target, &staging, existed)?;
    std::fs::canonicalize(&target)
        .map_err(|error| DesktopError::new("CLONE_TARGET_UNAVAILABLE", error.to_string(), true))
}

pub async fn checkout_svn_repository(
    url: &str,
    parent: &Path,
    target_name: &str,
    credentials: Option<&(String, String)>,
    token: &CancellationToken,
) -> Result<PathBuf, DesktopError> {
    let url = url.trim();
    let supported = ["http://", "https://", "svn://", "svn+ssh://", "file://"]
        .iter()
        .any(|scheme| url.to_ascii_lowercase().starts_with(scheme));
    if url.is_empty() || url.contains('\0') || option_like(url) || !supported {
        return Err(DesktopError::new(
            "INVALID_SVN_CHECKOUT_URL",
            "SVN checkout URL must use HTTP, HTTPS, SVN, SVN+SSH, or file://",
            false,
        ));
    }
    validate_checkout_target_name(target_name)?;
    if credentials.is_some_and(|(username, _)| username.trim().is_empty()) {
        return Err(DesktopError::new(
            "INVALID_SVN_USERNAME",
            "SVN username is invalid",
            false,
        ));
    }
    let target = safe_relative(parent, target_name, true)?;
    if target.exists()
        && (!target.is_dir() || !meaningful_directory_entries(&target, None)?.is_empty())
    {
        return Err(DesktopError::new(
            "SVN_CHECKOUT_TARGET_NOT_EMPTY",
            "SVN checkout target already exists and is not empty",
            true,
        ));
    }
    let existed = target.exists();
    let staging = staging_directory(parent, &target, target_name, existed);
    std::fs::create_dir_all(&staging)
        .map_err(|error| DesktopError::new("CHECKOUT_STAGING_FAILED", error.to_string(), true))?;

    let password_stdin_supported = if credentials.is_some() {
        cli::run(
            "svn",
            &["--version".into(), "--quiet".into()],
            &staging,
            None,
            Duration::from_secs(15),
            token,
        )
        .await
        .ok()
        .map(|output| output.stdout_text())
        .and_then(|version| {
            let mut parts = version
                .trim()
                .split('.')
                .filter_map(|part| part.parse::<u32>().ok());
            Some((parts.next()?, parts.next()?))
        })
        .is_some_and(|(major, minor)| major > 1 || (major == 1 && minor >= 10))
    } else {
        false
    };
    if credentials.is_some() && !password_stdin_supported {
        cleanup_checkout_staging(&staging);
        return Err(DesktopError::new(
            "SVN_PASSWORD_STDIN_UNAVAILABLE",
            "This SVN client cannot receive passwords through stdin",
            false,
        )
        .hint("Use the system SVN credential cache or upgrade SVN to 1.10 or later"));
    }
    let mut args = vec!["checkout".into(), "--force".into(), url.into(), ".".into()];
    let stdin = if let Some((username, password)) = credentials {
        args.extend(["--username".into(), username.trim().into()]);
        args.push("--password-from-stdin".into());
        args.extend([
            "--config-option".into(),
            "servers:global:store-passwords=yes".into(),
            "--config-option".into(),
            "servers:global:store-auth-creds=yes".into(),
        ]);
        Some(password.as_bytes())
    } else {
        None
    };
    args.push("--non-interactive".into());
    if let Err(error) = cli::run("svn", &args, &staging, stdin, cli::NETWORK_TIMEOUT, token).await {
        cleanup_checkout_staging(&staging);
        return Err(error);
    }
    finalize_checkout(&target, &staging, existed)?;
    std::fs::canonicalize(&target).map_err(|error| {
        DesktopError::new("SVN_CHECKOUT_TARGET_UNAVAILABLE", error.to_string(), true)
    })
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
            let primary = svn_with_timeout(
                vec![
                    "log".into(),
                    "--xml".into(),
                    "-r".into(),
                    "HEAD:1".into(),
                    "--limit".into(),
                    "100".into(),
                ],
                repo,
                token,
                Duration::from_secs(10),
            )
            .await;
            let raw = match primary {
                Ok(output) if !output.stdout_text().trim().is_empty() => output.stdout_text(),
                _ => svn_with_timeout(
                    vec!["log".into(), "--xml".into(), "--limit".into(), "100".into()],
                    repo,
                    token,
                    Duration::from_secs(10),
                )
                .await?
                .stdout_text(),
            };
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
    Ok(recent_commit_messages(repo, token)
        .await?
        .into_iter()
        .next()
        .map(|item| item.message))
}

async fn resolve_git_candidate_paths(
    repo: &RepositoryMeta,
    base: &str,
    target: &str,
    safe_path: &str,
    token: &CancellationToken,
) -> Vec<String> {
    if let Ok(name_status) = git(
        vec![
            "diff".into(),
            "--name-status".into(),
            "-z".into(),
            "-M".into(),
            base.into(),
        ]
        .into_iter()
        .chain(match target {
            "INDEX" => vec!["--cached".into()],
            "WORKTREE" | "WORKING" => vec![],
            _ => vec![target.into()],
        })
        .chain(["--".into()])
        .collect(),
        repo,
        token,
    )
    .await
    {
        let fields = name_status.stdout_text();
        let parts = fields.split('\0').collect::<Vec<_>>();
        let mut index = 0;
        while index < parts.len() {
            let code = parts[index];
            index += 1;
            if code.is_empty() {
                continue;
            }
            if code.starts_with('R') || code.starts_with('C') {
                let old_path = parts.get(index).copied().unwrap_or_default();
                index += 1;
                let new_path = parts.get(index).copied().unwrap_or_default();
                index += 1;
                if new_path == safe_path || old_path == safe_path {
                    let mut candidates = Vec::new();
                    if !old_path.is_empty() {
                        candidates.push(old_path.to_string());
                    }
                    if !new_path.is_empty() && new_path != old_path {
                        candidates.push(new_path.to_string());
                    }
                    return candidates;
                }
                continue;
            }
            let path = parts.get(index).copied().unwrap_or_default();
            index += 1;
            if path == safe_path {
                return vec![safe_path.to_string()];
            }
        }
    }
    vec![safe_path.to_string()]
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
    let target_revision = to_revision.clone().or(revision.clone());
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
                let candidates = resolve_git_candidate_paths(repo, &from, &to, &safe, token).await;
                let mut args = vec![
                    "diff".into(),
                    "-M".into(),
                    "-U999999".into(),
                    "--no-ext-diff".into(),
                    "--no-color".into(),
                    "--binary".into(),
                    from,
                    to,
                    "--".into(),
                ];
                for candidate in candidates {
                    args.push(format!(":(literal){candidate}"));
                }
                git(args, repo, token).await?
            } else if let Some(ref value) = revision {
                validate_revision(value)?;
                let parent = git(
                    vec![
                        "rev-list".into(),
                        "--parents".into(),
                        "-n".into(),
                        "1".into(),
                        value.clone(),
                    ],
                    repo,
                    token,
                )
                .await
                .ok()
                .and_then(|out| {
                    let text = out.stdout_text();
                    let parts = text.split_whitespace().collect::<Vec<_>>();
                    if parts.len() >= 2 {
                        Some(parts[1].to_string())
                    } else {
                        None
                    }
                });

                if let Some(parent_hash) = parent {
                    let candidates =
                        resolve_git_candidate_paths(repo, &parent_hash, value, &safe, token).await;
                    let mut args = vec![
                        "diff".into(),
                        "-M".into(),
                        "-U999999".into(),
                        "--no-ext-diff".into(),
                        "--no-color".into(),
                        "--binary".into(),
                        parent_hash,
                        value.clone(),
                        "--".into(),
                    ];
                    for candidate in candidates {
                        args.push(format!(":(literal){candidate}"));
                    }
                    git(args, repo, token).await?
                } else {
                    git(
                        vec![
                            "show".into(),
                            "-U999999".into(),
                            "--format=".into(),
                            "--no-ext-diff".into(),
                            "--no-color".into(),
                            "--binary".into(),
                            value.clone(),
                            "--".into(),
                            format!(":(literal){safe}"),
                        ],
                        repo,
                        token,
                    )
                    .await?
                }
            } else {
                let candidates = resolve_git_candidate_paths(
                    repo,
                    "HEAD",
                    if staged { "INDEX" } else { "WORKTREE" },
                    &safe,
                    token,
                )
                .await;
                let mut args = vec![
                    "diff".into(),
                    "-M".into(),
                    "-U999999".into(),
                    "--no-ext-diff".into(),
                    "--no-color".into(),
                    "--binary".into(),
                ];
                if staged {
                    args.push("--cached".into());
                }
                args.push("--".into());
                for candidate in candidates {
                    args.push(format!(":(literal){candidate}"));
                }
                git(args, repo, token).await?
            }
        }
        VcsKind::Svn => {
            let mut args = vec![
                "diff".into(),
                "--internal-diff".into(),
                "-x".into(),
                "-U999999".into(),
            ];
            if from_revision.is_some() || to_revision.is_some() {
                let from = from_revision.as_deref().ok_or_else(|| {
                    DesktopError::new(
                        "INVALID_REVISION_RANGE",
                        "Both range revisions are required",
                        false,
                    )
                })?;
                let to = to_revision.as_deref().ok_or_else(|| {
                    DesktopError::new(
                        "INVALID_REVISION_RANGE",
                        "Both range revisions are required",
                        false,
                    )
                })?;
                validate_svn_revision(from)?;
                validate_svn_revision(to)?;
                args.extend(["-r".into(), format!("{from}:{to}")]);
            } else if let Some(ref value) = revision {
                validate_svn_revision(value)?;
                args.extend(["-c".into(), value.clone()]);
            }
            let historical_path = if to_revision.is_some() || revision.is_some() {
                svn_repository_path(repo, &safe, token).await?
            } else {
                safe.clone()
            };
            let target = to_revision
                .as_deref()
                .or(revision.as_deref())
                .map(|value| format!("{historical_path}@{value}"))
                .unwrap_or_else(|| safe.clone());
            args.extend(["--".into(), target]);
            let mut output = svn(args.clone(), repo, token).await;
            if output.is_err() {
                let base = from_revision.clone().or_else(|| {
                    revision
                        .as_deref()
                        .and_then(|value| value.parse::<u64>().ok())
                        .and_then(|value| value.checked_sub(1))
                        .map(|value| value.to_string())
                });
                if let Some(base) = base {
                    // A deleted path cannot be pegged to its deletion revision.
                    args.pop();
                    args.push(format!("{historical_path}@{base}"));
                    output = svn(args, repo, token).await;
                }
            }
            match output {
                Ok(out) => out,
                Err(err) => {
                    if let Some(rev) = revision.as_deref() {
                        if let Ok(info) = svn_working_copy_info(repo, token).await {
                            if !info.url.is_empty() {
                                let target_url =
                                    format!("{}/{}@HEAD", info.url.trim_end_matches('/'), safe);
                                if let Ok(fallback_out) = svn(
                                    vec![
                                        "diff".into(),
                                        "--internal-diff".into(),
                                        "-x".into(),
                                        "-U999999".into(),
                                        "-c".into(),
                                        rev.into(),
                                        target_url,
                                    ],
                                    repo,
                                    token,
                                )
                                .await
                                {
                                    return make_diff(path, fallback_out.stdout);
                                }
                            }
                        }
                    }
                    return Err(err);
                }
            }
        }
    };
    let mut document = make_diff(path, output.stdout)?;
    if !document.binary && document.line_count == 0 {
        let bytes = match repo.kind {
            VcsKind::Git if staged || target_revision.is_some() => {
                let spec = target_revision
                    .as_ref()
                    .map(|revision| format!("{revision}:{safe}"))
                    .unwrap_or_else(|| format!(":{safe}"));
                git(vec!["show".into(), spec], repo, token)
                    .await
                    .ok()
                    .map(|out| out.stdout)
            }
            VcsKind::Svn if target_revision.is_some() => {
                let revision = target_revision.as_deref().unwrap_or_default();
                let target = svn_repository_path(repo, &safe, token).await?;
                svn(
                    vec![
                        "cat".into(),
                        "-r".into(),
                        revision.into(),
                        "--".into(),
                        format!("{target}@{revision}"),
                    ],
                    repo,
                    token,
                )
                .await
                .ok()
                .map(|out| out.stdout)
            }
            _ => std::fs::read(root.join(&safe)).ok(),
        };
        if let Some(bytes) = bytes {
            if !bytes_are_binary(&bytes) {
                document.line_count = String::from_utf8_lossy(&bytes)
                    .lines()
                    .count()
                    .min(u32::MAX as usize) as u32;
            }
        }
    }
    Ok(document)
}

fn map_diff_lines_to_base(patch: &str, selected: LineRange) -> Option<LineRange> {
    let hunks: Vec<(u32, u32, u32, u32)> = patch
        .lines()
        .filter(|line| line.starts_with("@@ "))
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            fields.next();
            let parse = |text: &str| -> Option<(u32, u32)> {
                let mut parts = text.get(1..)?.split(',');
                Some((
                    parts.next()?.parse().ok()?,
                    parts.next().map(str::parse).transpose().ok()?.unwrap_or(1),
                ))
            };
            let (old_start, old_count) = parse(fields.next()?)?;
            let (new_start, new_count) = parse(fields.next()?)?;
            Some((old_start, old_count, new_start, new_count))
        })
        .collect();
    let map = |line: u32| -> Option<u32> {
        let mut delta = 0_i64;
        for &(old_start, old_count, new_start, new_count) in &hunks {
            if new_count == 0 {
                if line <= new_start {
                    break;
                }
            } else {
                if line < new_start {
                    break;
                }
                if line < new_start.saturating_add(new_count) {
                    let offset = line - new_start;
                    return (offset < old_count)
                        .then(|| old_start + offset)
                        .filter(|number| *number > 0);
                }
            }
            delta += i64::from(old_count) - i64::from(new_count);
        }
        u32::try_from(i64::from(line) + delta)
            .ok()
            .filter(|number| *number > 0)
    };
    let mut numbers = (selected.start..=selected.end).filter_map(map);
    let first = numbers.next()?;
    let (start, end) = numbers.fold((first, first), |(start, end), number| {
        (start.min(number), end.max(number))
    });
    Some(LineRange { start, end })
}

/// Convert mutable index/working-copy coordinates into a committed history target.
/// New-only lines have no history. This never changes the index or working copy.
pub async fn diff_line_history_target(
    repo: &RepositoryMeta,
    path: &str,
    source_revision: &str,
    line_range: LineRange,
    token: &CancellationToken,
) -> Result<Option<crate::models::DiffLineHistoryTarget>, DesktopError> {
    if line_range.start == 0
        || line_range.end < line_range.start
        || line_range.end - line_range.start > 50_000
    {
        return Err(DesktopError::new(
            "INVALID_LINE_RANGE",
            "Invalid diff selection line range",
            false,
        ));
    }
    let safe = relative_path(Path::new(&repo.root_path), path, false)?;
    let (revision, history_path, patch) = match repo.kind {
        VcsKind::Git => {
            if !matches!(source_revision, "INDEX" | "WORKTREE" | "WORKING") {
                return Err(DesktopError::new(
                    "INVALID_REVISION",
                    "Expected an index or working-tree source",
                    false,
                ));
            }
            let head = git(
                vec!["rev-parse".into(), "--verify".into(), "HEAD".into()],
                repo,
                token,
            )
            .await;
            let Ok(head) = head else {
                return Ok(None);
            };
            let revision = head.stdout_text().trim().to_string();
            let candidates =
                resolve_git_candidate_paths(repo, &revision, source_revision, &safe, token).await;
            let history_path = candidates.first().cloned().unwrap_or_else(|| safe.clone());
            if git(
                vec![
                    "cat-file".into(),
                    "-e".into(),
                    format!("{revision}:{history_path}"),
                ],
                repo,
                token,
            )
            .await
            .is_err()
            {
                return Ok(None);
            }
            let mut args = vec![
                "diff".into(),
                "-M".into(),
                "-U0".into(),
                "--no-ext-diff".into(),
                "--no-color".into(),
                revision.clone(),
            ];
            if source_revision == "INDEX" {
                args.push("--cached".into());
            }
            args.push("--".into());
            args.extend(candidates.iter().map(|path| format!(":(literal){path}")));
            let patch = git(args, repo, token).await?.stdout_text();
            (revision, history_path, patch)
        }
        VcsKind::Svn => {
            if !matches!(source_revision, "BASE" | "WORKTREE" | "WORKING") {
                return Err(DesktopError::new(
                    "INVALID_REVISION",
                    "Expected a base or working-copy source",
                    false,
                ));
            }
            let revision = svn(
                vec![
                    "info".into(),
                    "--show-item".into(),
                    "revision".into(),
                    "--".into(),
                    safe.clone(),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text()
            .trim()
            .to_string();
            validate_svn_revision(&revision)?;
            let patch = if source_revision == "BASE" {
                String::new()
            } else {
                svn(
                    vec![
                        "diff".into(),
                        "--internal-diff".into(),
                        "-x".into(),
                        "-U0".into(),
                        "--".into(),
                        safe.clone(),
                    ],
                    repo,
                    token,
                )
                .await?
                .stdout_text()
            };
            (revision, safe, patch)
        }
    };
    Ok(
        map_diff_lines_to_base(&patch, line_range).map(|line_range| {
            crate::models::DiffLineHistoryTarget {
                path: history_path,
                revision,
                line_range,
            }
        }),
    )
}

fn diff_file_line_count(content: &str) -> usize {
    let mut old = 0;
    let mut new = 0;
    for line in content.lines().filter(|line| line.starts_with("@@ ")) {
        let mut fields = line.split_whitespace();
        fields.next();
        let extent = |value: Option<&str>| {
            value
                .and_then(|value| value.get(1..))
                .map(|value| {
                    let mut parts = value.split(',');
                    let start = parts
                        .next()
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(0);
                    let count = parts
                        .next()
                        .map(|v| v.parse::<usize>().unwrap_or(0))
                        .unwrap_or(1);
                    if count == 0 {
                        0
                    } else {
                        start.saturating_add(count - 1)
                    }
                })
                .unwrap_or(0)
        };
        old = old.max(extent(fields.next()));
        new = new.max(extent(fields.next()));
    }
    if new > 0 {
        new
    } else {
        old
    }
}

pub(crate) fn make_diff(path: &str, bytes: Vec<u8>) -> Result<DiffDocument, DesktopError> {
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let binary = bytes_are_binary(&bytes)
        // 补丁正文行带有空格、+ 或 - 前缀；源码里的标记文字不是 VCS 元数据。
        || content.lines().any(|line| {
            line == "GIT binary patch"
                || (line.starts_with("Binary files ") && line.ends_with(" differ"))
                || line == "Cannot display: file marked as a binary type."
        });
    let patch_line_count = content.lines().count();
    let line_count = diff_file_line_count(&content);
    let truncated = bytes.len() > DIFF_MAX_BYTES || patch_line_count > DIFF_MAX_LINES;
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
    allow_truncated: bool,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if paths.is_empty() {
        return Ok(());
    }
    let root = Path::new(&repo.root_path);
    match repo.kind {
        VcsKind::Git => {
            for path in paths {
                let safe = relative_path(root, path, false)?;
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
                    .map(|path| literal_path(root, path, false))
                    .collect::<Result<Vec<_>, _>>()?,
            );
            git(args, repo, token).await?;
        }
        VcsKind::Svn => {
            let _ = allow_truncated;
            let safe_paths = paths
                .iter()
                .map(|path| relative_path(root, path, false))
                .collect::<Result<Vec<_>, _>>()?;
            let ignores = crate::workspace::svn_ignore_rules(root, token).await;
            let scan_root = root.to_path_buf();
            let scan_paths = safe_paths.clone();
            let scan_token = token.clone();
            tokio::task::spawn_blocking(move || {
                for path in &scan_paths {
                    if scan_token.is_cancelled() {
                        return Err(DesktopError::new(
                            "REQUEST_CANCELLED",
                            "Operation cancelled",
                            true,
                        ));
                    }
                    if path.split('/').any(|part| {
                        matches!(part.to_ascii_lowercase().as_str(), ".git" | ".hg" | ".svn")
                    }) {
                        return Err(DesktopError::new(
                            "SVN_NESTED_VCS_METADATA",
                            format!("Cannot add nested repository metadata at {path}"),
                            false,
                        ));
                    }
                    ensure_no_nested_vcs_metadata(
                        &scan_root,
                        &scan_root.join(path),
                        &ignores,
                        &scan_token,
                    )?;
                }
                Ok::<(), DesktopError>(())
            })
            .await
            .map_err(|error| DesktopError::new("SVN_ADD_SCAN_FAILED", error.to_string(), true))??;
            let mut args = vec!["add".into(), "--parents".into(), "--".into()];
            args.extend(safe_paths);
            svn(args, repo, token).await?;
        }
    }
    Ok(())
}

fn ensure_no_nested_vcs_metadata(
    root: &Path,
    target: &Path,
    ignores: &crate::workspace::SvnIgnoreRules,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let mut pending = vec![target.to_path_buf()];
    while let Some(path) = pending.pop() {
        if token.is_cancelled() {
            return Err(DesktopError::new(
                "REQUEST_CANCELLED",
                "Operation cancelled",
                true,
            ));
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if matches!(name.to_ascii_lowercase().as_str(), ".git" | ".hg" | ".svn") {
            return Err(DesktopError::new(
                "SVN_NESTED_VCS_METADATA",
                format!(
                    "Cannot add nested repository metadata at {}",
                    path.display()
                ),
                false,
            ));
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| DesktopError::new("SVN_ADD_SCAN_FAILED", error.to_string(), true))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let entries = std::fs::read_dir(&path)
            .map_err(|error| DesktopError::new("SVN_ADD_SCAN_FAILED", error.to_string(), true))?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                DesktopError::new("SVN_ADD_SCAN_FAILED", error.to_string(), true)
            })?;
            let child = entry.path();
            let lower_name = entry.file_name().to_string_lossy().to_lowercase();
            if !ignores.matches(&child, root, &lower_name) {
                pending.push(child);
            }
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
                patterns: content
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_string)
                    .collect(),
            })
        }
    }
}

pub async fn svn_ignore_entries(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<IgnoreRules>, DesktopError> {
    if repo.kind != VcsKind::Svn {
        return Err(DesktopError::new(
            "UNSUPPORTED_OPERATION",
            "This operation requires an SVN working copy",
            false,
        ));
    }
    let raw = svn(
        vec![
            "propget".into(),
            "svn:ignore".into(),
            "--xml".into(),
            "-R".into(),
            "--".into(),
            ".".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let root = Path::new(&repo.root_path);
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut entries = Vec::new();
    for target in document
        .descendants()
        .filter(|node| node.has_tag_name("target"))
    {
        let path = Path::new(target.attribute("path").unwrap_or("."));
        let path = if path.is_absolute() {
            let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            canonical_path
                .strip_prefix(&canonical_root)
                .map_err(|error| DesktopError::new("INVALID_PATH", error.to_string(), false))?
                .to_path_buf()
        } else {
            path.to_path_buf()
        };
        let directory = relative_path(root, &path.to_string_lossy(), false)?;
        let patterns = target
            .children()
            .find(|node| {
                node.has_tag_name("property") && node.attribute("name") == Some("svn:ignore")
            })
            .and_then(|node| node.text())
            .unwrap_or("")
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        if !patterns.is_empty() {
            entries.push(IgnoreRules {
                directory,
                source: "svn:ignore".into(),
                patterns,
            });
        }
    }
    entries.sort_by(|a, b| a.directory.cmp(&b.directory));
    Ok(entries)
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

pub async fn unstage_unexpected_cached(
    repo: &RepositoryMeta,
    expected_paths: &[String],
    additional_unstage: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if repo.kind != VcsKind::Git {
        if !additional_unstage.is_empty() {
            unstage(repo, additional_unstage, token).await?;
        }
        return Ok(());
    }
    let target_paths_set: std::collections::HashSet<&str> =
        expected_paths.iter().map(|s| s.as_str()).collect();
    let raw_cached = git(
        vec![
            "diff".into(),
            "--name-status".into(),
            "--cached".into(),
            "-z".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout;
    let mut all_unstage = additional_unstage.to_vec();
    let parts: Vec<&[u8]> = raw_cached.split(|b| *b == 0).collect();
    let mut i = 0;
    while i < parts.len() {
        if parts[i].is_empty() {
            break;
        }
        let status = match std::str::from_utf8(parts[i]) {
            Ok(s) => s,
            Err(_) => {
                i += 1;
                continue;
            }
        };
        i += 1;
        if status.starts_with('R') || status.starts_with('C') {
            if i + 1 >= parts.len() {
                break;
            }
            let old_path = match std::str::from_utf8(parts[i]) {
                Ok(s) => s,
                Err(_) => {
                    i += 2;
                    continue;
                }
            };
            let new_path = match std::str::from_utf8(parts[i + 1]) {
                Ok(s) => s,
                Err(_) => {
                    i += 2;
                    continue;
                }
            };
            i += 2;
            if !target_paths_set.contains(new_path) {
                if !all_unstage.iter().any(|p| p == old_path) {
                    all_unstage.push(old_path.to_string());
                }
                if !all_unstage.iter().any(|p| p == new_path) {
                    all_unstage.push(new_path.to_string());
                }
            }
        } else {
            if i >= parts.len() {
                break;
            }
            let path = match std::str::from_utf8(parts[i]) {
                Ok(s) => s,
                Err(_) => {
                    i += 1;
                    continue;
                }
            };
            i += 1;
            if !target_paths_set.contains(path) && !all_unstage.iter().any(|p| p == path) {
                all_unstage.push(path.to_string());
            }
        }
    }
    if !all_unstage.is_empty() {
        unstage(repo, &all_unstage, token).await?;
    }
    Ok(())
}

pub async fn inspect_staged_file_for_safety(
    repo: &RepositoryMeta,
    rel_path: &str,
    check_crlf: bool,
    token: &CancellationToken,
) -> Result<Option<(u64, bool)>, DesktopError> {
    if repo.kind != VcsKind::Git {
        return Ok(None);
    }
    let path = match relative_path(Path::new(&repo.root_path), rel_path, true) {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    let spec = format!(":{path}");
    let size_output = match git(
        vec!["cat-file".into(), "-s".into(), spec.clone()],
        repo,
        token,
    )
    .await
    {
        Ok(out) => out,
        Err(_) => return Ok(None),
    };
    let size_str = String::from_utf8_lossy(&size_output.stdout)
        .trim()
        .to_string();
    let size = match size_str.parse::<u64>() {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };

    let mut has_crlf = false;
    if check_crlf && size > 0 && size < 5 * 1024 * 1024 {
        if let Ok(content_output) =
            git(vec!["cat-file".into(), "-p".into(), spec], repo, token).await
        {
            let limit = content_output.stdout.len().min(64 * 1024);
            if content_output.stdout[..limit]
                .windows(2)
                .any(|w| w == b"\r\n")
            {
                has_crlf = true;
            }
        }
    }

    Ok(Some((size, has_crlf)))
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
                    if let Ok(metadata) = std::fs::symlink_metadata(&target) {
                        if metadata.is_dir() {
                            let _ = std::fs::remove_dir_all(&target);
                        } else {
                            let _ = std::fs::remove_file(&target);
                        }
                    }
                } else {
                    let res = git(
                        vec![
                            "restore".into(),
                            "--worktree".into(),
                            "--".into(),
                            pathspec.clone(),
                        ],
                        repo,
                        token,
                    )
                    .await;
                    if res.is_err() {
                        let _ =
                            git(vec!["checkout".into(), "--".into(), pathspec], repo, token).await;
                    }
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
                                let _ = std::fs::remove_dir(&target);
                            } else {
                                std::fs::remove_file(&target).map_err(|error| {
                                    DesktopError::new("DISCARD_FAILED", error.to_string(), true)
                                })?;
                            }
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
    commit_with_identity(repo, message, amend, paths, None, false, false, token).await
}

pub async fn commit_with_identity(
    repo: &RepositoryMeta,
    message: &str,
    amend: bool,
    paths: &[String],
    identity: Option<&EffectiveGitIdentity>,
    no_verify: bool,
    staged_only: bool,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let message = validate_message(message)?;
    match repo.kind {
        VcsKind::Git => {
            if !staged_only && !paths.is_empty() {
                stage(repo, paths, false, token).await?;
            }
            let mut args = vec!["commit".into(), "--file=-".into()];
            if amend {
                args.push("--amend".into());
            }
            if no_verify {
                args.push("--no-verify".into());
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
            let commit_targets = prepare_svn_commit(repo, paths, token).await?;
            // Password and commit message must not compete for stdin.
            let mut message_file = tempfile::NamedTempFile::new()
                .map_err(|e| DesktopError::new("COMMIT_MESSAGE_FAILED", e.to_string(), true))?;
            std::io::Write::write_all(&mut message_file, message.as_bytes())
                .map_err(|e| DesktopError::new("COMMIT_MESSAGE_FAILED", e.to_string(), true))?;
            let mut args = vec![
                "commit".into(),
                "--file".into(),
                message_file.path().to_string_lossy().into_owned(),
                "--depth".into(),
                "empty".into(),
            ];
            args.extend(commit_targets);
            let output = svn_with_timeout(args, repo, token, cli::NETWORK_TIMEOUT).await?;
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
                    "-z".into(),
                    format!("--format={format}"),
                    format!("--max-count={}", skip + limit + 1),
                    cursor.anchor_revision.clone(),
                    "--".into(),
                    format!(":(literal){path}"),
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
            // Log paths are repository-relative, including after a file or
            // containing directory was copied/renamed. Resolve them against
            // the checkout prefix instead of assigning today's filename.
            let prefix = svn_checkout_prefix(repo, token).await?;
            let mut entries = parse_svn_file_history(&output, &path, &prefix)?;
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
    let mut records = output.split('\0').peekable();
    while let Some(record) = records.next() {
        let Some(header) = record.trim_start_matches(['\n', '\r']).strip_prefix(RECORD) else {
            continue;
        };
        let fields = header.splitn(5, FIELD).collect::<Vec<_>>();
        if fields.len() < 5 {
            continue;
        }
        let has_change = records.peek().is_some_and(|value| {
            !value.trim_start_matches(['\n', '\r']).starts_with(RECORD) && !value.is_empty()
        });
        let status = if has_change {
            records
                .next()
                .unwrap_or("M")
                .trim_start_matches(['\n', '\r'])
                .to_string()
        } else {
            "M".to_string()
        };
        let first_path = if has_change {
            records.next().filter(|path| !path.is_empty())
        } else {
            None
        };
        let moved_or_copied = status.starts_with('R') || status.starts_with('C');
        let previous_path = if moved_or_copied {
            first_path.map(str::to_string)
        } else {
            None
        };
        let path_at_revision = if moved_or_copied {
            records.next().filter(|path| !path.is_empty())
        } else {
            first_path
        }
        .map(str::to_string)
        .unwrap_or_else(|| current_path.clone());
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

async fn svn_checkout_prefix(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let output = svn(
        vec!["info".into(), "--xml".into(), "--".into(), ".".into()],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let info = roxmltree::Document::parse(&output)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    Ok(info
        .descendants()
        .find(|node| node.has_tag_name("relative-url"))
        .and_then(|node| node.text())
        .map(|value| decode_svn_path(value.trim_start_matches('^').trim_matches('/')))
        .unwrap_or_default())
}

async fn svn_repository_path(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let repository_path = if let Some(path) = path.strip_prefix("^/") {
        format!("/{path}")
    } else {
        format!("/{}/{}", svn_checkout_prefix(repo, token).await?, path).replace("//", "/")
    };
    let mut url = url::Url::parse("https://svn.invalid/").expect("valid constant URL");
    {
        let mut segments = url
            .path_segments_mut()
            .expect("constant URL supports paths");
        segments.clear();
        for segment in repository_path.trim_start_matches('/').split('/') {
            segments.push(segment);
        }
    }
    Ok(format!("^{}", url.path()))
}

fn parse_svn_file_history(
    output: &str,
    initial_path: &str,
    checkout_prefix: &str,
) -> Result<Vec<FileHistoryEntry>, DesktopError> {
    let document = roxmltree::Document::parse(output)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let mut current_path = if let Some(path) = initial_path.strip_prefix("^/") {
        format!("/{path}")
    } else {
        format!("/{}/{}", checkout_prefix.trim_matches('/'), initial_path).replace("//", "/")
    };
    let local_path = |value: &str| -> String {
        let prefix = if checkout_prefix.is_empty() {
            "/".to_string()
        } else {
            format!("/{}/", checkout_prefix.trim_matches('/'))
        };
        value
            .strip_prefix(&prefix)
            .map(str::to_string)
            .unwrap_or_else(|| format!("^{value}"))
    };
    let mut entries = Vec::new();
    for node in document
        .descendants()
        .filter(|node| node.has_tag_name("logentry"))
    {
        let revision = node.attribute("revision").unwrap_or_default();
        if revision.is_empty() {
            continue;
        }
        let changed = node
            .descendants()
            .filter(|item| item.has_tag_name("path"))
            .filter(|item| {
                item.text().is_some_and(|value| {
                    value == current_path
                        || item.attribute("kind") == Some("dir")
                            && current_path.starts_with(&format!("{value}/"))
                })
            })
            .max_by_key(|item| item.text().unwrap_or_default().len());
        let action = changed
            .and_then(|item| item.attribute("action"))
            .unwrap_or("M");
        let copy_from = changed.and_then(|item| item.attribute("copyfrom-path"));
        let previous_path = copy_from.map(|source| {
            let changed_path = changed.and_then(|item| item.text()).unwrap_or_default();
            format!(
                "{source}{}",
                current_path.strip_prefix(changed_path).unwrap_or_default()
            )
        });
        let previous_revision = if action == "A" && copy_from.is_none() {
            None
        } else {
            changed
                .and_then(|item| item.attribute("copyfrom-rev"))
                .map(str::to_string)
                .or_else(|| {
                    revision
                        .parse::<u64>()
                        .ok()
                        .and_then(|value| value.checked_sub(1))
                        .map(|value| value.to_string())
                })
        };
        let status = if let Some(source) = copy_from {
            if node.descendants().any(|item| {
                item.has_tag_name("path")
                    && item.attribute("action") == Some("D")
                    && item.text() == Some(source)
            }) {
                "R"
            } else {
                "C"
            }
        } else {
            action
        };
        let text = |tag: &str| {
            node.children()
                .find(|item| item.has_tag_name(tag))
                .and_then(|item| item.text())
                .unwrap_or_default()
                .to_string()
        };
        entries.push(FileHistoryEntry {
            revision: revision.to_string(),
            previous_revision,
            path: local_path(&current_path),
            previous_path: previous_path.as_deref().map(local_path),
            author: text("author"),
            date: text("date"),
            message: text("msg"),
            status: status.to_string(),
        });
        if let Some(previous) = previous_path {
            current_path = previous;
        }
    }
    Ok(entries)
}

pub async fn file_revision_content(
    repo: &RepositoryMeta,
    relative_path_value: &str,
    revision: &str,
    cat_file_filter_mode: crate::models::CatFileFilterMode,
    token: &CancellationToken,
) -> Result<FileRevisionDocument, DesktopError> {
    let path = relative_path(Path::new(&repo.root_path), relative_path_value, true)?;
    match repo.kind {
        VcsKind::Git => validate_revision(revision)?,
        VcsKind::Svn => validate_svn_revision(revision)?,
    }
    let bytes = match repo.kind {
        VcsKind::Git => {
            let spec = format!("{revision}:{path}");
            let cat_flag = match cat_file_filter_mode {
                crate::models::CatFileFilterMode::Filters => "--filters",
                crate::models::CatFileFilterMode::Textconv => "--textconv",
                crate::models::CatFileFilterMode::None => "-p",
            };
            if cat_flag == "-p" {
                git(vec!["cat-file".into(), "-p".into(), spec], repo, token)
                    .await?
                    .stdout
            } else {
                match git(
                    vec!["cat-file".into(), cat_flag.into(), spec.clone()],
                    repo,
                    token,
                )
                .await
                {
                    Ok(output) => output.stdout,
                    Err(error) if error.code == "REQUEST_CANCELLED" => return Err(error),
                    Err(_) => {
                        git(vec!["cat-file".into(), "-p".into(), spec], repo, token)
                            .await?
                            .stdout
                    }
                }
            }
        }
        VcsKind::Svn => {
            let target = svn_repository_path(repo, &path, token).await?;
            svn(
                vec![
                    "cat".into(),
                    "-r".into(),
                    revision.into(),
                    "--".into(),
                    format!("{target}@{revision}"),
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
        "revert" => vec!["revert".into(), "--abort".into()],
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

pub async fn skip_operation(
    repo: &RepositoryMeta,
    operation: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if repo.kind != VcsKind::Git || operation != "cherry-pick" {
        return Err(DesktopError::new(
            "OPERATION_NOT_SUPPORTED",
            "Only cherry-pick steps can be skipped",
            false,
        ));
    }
    if git_operation_name(Path::new(&repo.root_path)) != Some(operation) {
        return Err(DesktopError::new(
            "OPERATION_NOT_ACTIVE",
            "No matching cherry-pick operation is active",
            true,
        ));
    }
    git(vec!["cherry-pick".into(), "--skip".into()], repo, token).await?;
    Ok(())
}

pub async fn continue_operation(
    repo: &RepositoryMeta,
    operation: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if repo.kind != VcsKind::Git {
        return Err(DesktopError::new(
            "OPERATION_NOT_SUPPORTED",
            "Continuing repository operations is only supported for Git repositories",
            true,
        ));
    }
    let active_op = git_operation_name(Path::new(&repo.root_path)).ok_or_else(|| {
        DesktopError::new(
            "OPERATION_NOT_ACTIVE",
            "No Git operation is currently in progress",
            true,
        )
    })?;
    if active_op != operation {
        return Err(DesktopError::new(
            "OPERATION_MISMATCH",
            format!("Expected active operation '{active_op}', got '{operation}'"),
            true,
        ));
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
        return Err(DesktopError::new(
            "CONFLICTS_UNRESOLVED",
            "Cannot continue: there are still unresolved conflicts",
            true,
        ));
    }
    let args = match operation {
        "rebase" => vec![
            "-c".into(),
            "core.editor=true".into(),
            "rebase".into(),
            "--continue".into(),
        ],
        "cherry-pick" => vec![
            "cherry-pick".into(),
            "--continue".into(),
            "--no-edit".into(),
        ],
        "revert" => vec!["revert".into(), "--continue".into(), "--no-edit".into()],
        "merge" => vec!["commit".into(), "--no-edit".into()],
        _ => {
            return Err(DesktopError::new(
                "OPERATION_NOT_SUPPORTED",
                format!("Cannot continue operation '{operation}'"),
                true,
            ));
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
    } else if git_dir.join("REVERT_HEAD").exists() {
        Some("revert")
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
) -> Result<Vec<String>, DesktopError> {
    if paths.is_empty() {
        return Err(DesktopError::new(
            "SVN_COMMIT_NO_PATHS",
            "No SVN files selected to commit",
            false,
        ));
    }
    let root = Path::new(&repo.root_path);
    let visible = crate::workspace::svn_status(repo.clone(), token).await?;
    let status = svn(vec!["status".into(), "--xml".into()], repo, token)
        .await?
        .stdout_text();
    let document = roxmltree::Document::parse(&status)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let selected = paths
        .iter()
        .map(|path| relative_path(root, path, true))
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    if let Some(path) = visible
        .files
        .iter()
        .find(|file| file.is_truncated && selected.contains(&file.path))
    {
        return Err(DesktopError::new(
            "SVN_TRUNCATED_DIRECTORY_COMMIT_FORBIDDEN",
            format!(
                "Add the entire truncated directory {} before committing it",
                path.path
            ),
            false,
        ));
    }
    let mut unversioned_roots = Vec::new();
    let mut missing = Vec::new();
    for entry in document
        .descendants()
        .filter(|node| node.has_tag_name("entry"))
    {
        let Some(path) = entry.attribute("path") else {
            continue;
        };
        let Some(normalized) = svn_status_relative_path(root, path) else {
            continue;
        };
        let item = entry
            .children()
            .find(|node| node.has_tag_name("wc-status"))
            .and_then(|node| node.attribute("item"))
            .unwrap_or("normal");
        if item == "unversioned" {
            unversioned_roots.push(normalized);
        } else if item == "missing" && selected.contains(&normalized) {
            missing.push(normalized);
        }
    }
    let to_add =
        selected
            .iter()
            .filter(|path| {
                unversioned_roots
                    .iter()
                    .any(|root| *path == root || path.starts_with(&format!("{root}/")))
            })
            .map(|path| {
                if visible.files.iter().any(|file| {
                    file.path == *path && file.status == "untracked" && !file.is_truncated
                }) {
                    Ok(path.clone())
                } else {
                    Err(DesktopError::new(
                        "SVN_UNTRACKED_PATH_NOT_VISIBLE",
                        format!("Untracked path {path} is not in the current SVN status"),
                        false,
                    ))
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
    if !to_add.is_empty() {
        stage(repo, &to_add, false, token).await?;
    }
    if !missing.is_empty() {
        let mut args = vec!["delete".into(), "--force".into(), "--".into()];
        args.extend(missing);
        svn(args, repo, token).await?;
    }
    let newly_added_directories = to_add
        .iter()
        .filter(|path| root.join(path).is_dir())
        .collect::<Vec<_>>();
    let mut targets = selected;
    if !to_add.is_empty() {
        let after_add = svn(vec!["status".into(), "--xml".into()], repo, token)
            .await?
            .stdout_text();
        let document = roxmltree::Document::parse(&after_add)
            .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
        let added = document
            .descendants()
            .filter(|node| node.has_tag_name("entry"))
            .filter(|node| {
                node.children().any(|child| {
                    child.has_tag_name("wc-status") && child.attribute("item") == Some("added")
                })
            })
            .filter_map(|node| node.attribute("path"))
            .filter_map(|path| svn_status_relative_path(root, path))
            .collect::<std::collections::HashSet<_>>();
        for directory in newly_added_directories {
            let prefix = format!("{directory}/");
            targets.extend(
                added
                    .iter()
                    .filter(|path| path.starts_with(&prefix))
                    .cloned(),
            );
        }
        let selected_targets = targets.iter().cloned().collect::<Vec<_>>();
        for target in selected_targets {
            let parts = target.split('/').collect::<Vec<_>>();
            for count in 1..parts.len() {
                let ancestor = parts[..count].join("/");
                if added.contains(&ancestor) {
                    targets.insert(ancestor);
                }
            }
        }
    }
    let mut targets = targets.into_iter().collect::<Vec<_>>();
    targets.sort();
    Ok(targets)
}

fn svn_status_relative_path(root: &Path, value: &str) -> Option<String> {
    let path = Path::new(value);
    let relative = if path.is_absolute() {
        path.strip_prefix(root).ok()?.to_path_buf()
    } else {
        path.to_path_buf()
    };
    Some(relative.to_string_lossy().replace('\\', "/"))
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
            restore_warning: None,
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
        restore_warning: None,
        output: format!("pulled {branch}"),
        update: None,
    })
}

#[cfg(test)]
mod update_restore_tests {
    #[test]
    fn restoration_warning_preserves_the_update_outcome() {
        use super::finish_update_with_restore_warning;
        use crate::models::{DesktopError, SyncResult, UpdateRestoreWarning};
        let warning = |conflicted| {
            Some(UpdateRestoreWarning {
                shelf: true,
                backup_name: "backup".into(),
                backup_id: "id".into(),
                conflicted,
                details: "restore failed".into(),
            })
        };
        let success = || {
            Ok(SyncResult {
                output: "updated".into(),
                update: None,
                restore_warning: None,
            })
        };
        assert!(
            finish_update_with_restore_warning(success(), warning(false))
                .unwrap()
                .restore_warning
                .is_some()
        );
        let conflict = finish_update_with_restore_warning(success(), warning(true)).unwrap_err();
        assert_eq!(conflict.code, "GIT_UPDATE_CONFLICT");
        let failure = finish_update_with_restore_warning(
            Err(DesktopError::new("GIT_PULL_FAILED", "network failed", true)),
            warning(false),
        )
        .unwrap_err();
        assert_eq!(failure.code, "GIT_PULL_FAILED");
        assert!(failure.restore_warning.is_some());
    }
}

fn finish_update_with_restore_warning(
    result: Result<SyncResult, DesktopError>,
    warning: Option<crate::models::UpdateRestoreWarning>,
) -> Result<SyncResult, DesktopError> {
    let Some(warning) = warning else {
        return result;
    };
    match result {
        Ok(mut value) if !warning.conflicted => {
            // The plugin reports a restoration warning separately from a
            // successful pull. Do not convert this case into Update failed.
            value.restore_warning = Some(warning);
            Ok(value)
        }
        Ok(_) => {
            let mut error = DesktopError::new(
                "GIT_UPDATE_CONFLICT",
                "Update stopped with conflicts or an unfinished version-control operation.",
                true,
            );
            error.restore_warning = Some(warning);
            Err(error)
        }
        Err(mut error) => {
            error.restore_warning = Some(warning);
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn sync_with_worktree_backup(
    config_dir: &Path,
    repo: &RepositoryMeta,
    action: SyncAction,
    remote: Option<String>,
    branch: Option<String>,
    force: bool,
    settings: &crate::models::DesktopSettings,
    token: &CancellationToken,
) -> Result<SyncResult, DesktopError> {
    let captures_worktree = repo.kind == VcsKind::Git
        && matches!(
            action,
            SyncAction::Pull | SyncAction::PullRebase | SyncAction::PullFfOnly
        )
        && !git_has_conflicts(repo, token).await
        && git_operation_name(Path::new(&repo.root_path)).is_none();
    if !captures_worktree {
        return sync(repo, action, remote, branch, force, settings, token).await;
    }
    if git(
        vec!["status".into(), "--porcelain=v1".into(), "-z".into()],
        repo,
        token,
    )
    .await?
    .stdout
    .is_empty()
    {
        return sync(repo, action, remote, branch, force, settings, token).await;
    }
    if settings.update_project_clean_working_tree == crate::models::CleanWorkingTreeMethod::Stash {
        let backup = create_auto_stash(repo, true, token).await?;
        let result = sync(repo, action, remote, branch, force, settings, token).await;
        let Some(backup) = backup else {
            return result;
        };
        let recovery_token = CancellationToken::new();
        let restore = restore_auto_stash(
            repo,
            &backup,
            result
                .as_ref()
                .err()
                .is_some_and(|error| error.code == "REQUEST_CANCELLED"),
            &recovery_token,
        )
        .await;
        let warning = if let Err(error) = restore {
            Some(crate::models::UpdateRestoreWarning {
                shelf: false,
                backup_name: String::new(),
                backup_id: backup.hash,
                conflicted: git_has_conflicts(repo, &recovery_token).await
                    || git_operation_name(Path::new(&repo.root_path)).is_some(),
                details: error.message,
            })
        } else {
            None
        };
        return finish_update_with_restore_warning(result, warning);
    }
    let before_status = status_fingerprint(repo, token).await?;
    let name = format!(
        "Auto-shelved before update ({})",
        chrono::Local::now().format("%H:%M:%S")
    );
    let capture_token = CancellationToken::new();
    let shelf_id = match crate::shelf::create(config_dir, repo, &name, &[], &capture_token).await {
        Ok(id) => id,
        Err(error) => {
            // Fall back to the existing stash path only if capture restored the
            // original working tree. Never continue after a partial capture.
            if status_fingerprint(repo, token).await? != before_status {
                return Err(error);
            }
            let mut fallback_settings = settings.clone();
            fallback_settings.update_project_clean_working_tree =
                crate::models::CleanWorkingTreeMethod::Stash;
            return Box::pin(sync_with_worktree_backup(
                config_dir,
                repo,
                action,
                remote,
                branch,
                force,
                &fallback_settings,
                token,
            ))
            .await;
        }
    };
    let result = sync(repo, action, remote, branch, force, settings, token).await;
    // Cancellation stops the update, but recovery must still run to restore
    // local changes or leave an identifiable shelf for manual recovery.
    let recovery_token = CancellationToken::new();
    let restore =
        crate::shelf::restore_after_update(config_dir, repo, &shelf_id, &recovery_token).await;
    let conflicted = git_has_conflicts(repo, &recovery_token).await
        || git_operation_name(Path::new(&repo.root_path)).is_some();
    if restore.is_err() || conflicted {
        let details = restore
            .err()
            .map(|error| error.message)
            .unwrap_or_else(|| "Conflicts detected while restoring local changes".into());
        return finish_update_with_restore_warning(
            result,
            Some(crate::models::UpdateRestoreWarning {
                shelf: true,
                backup_name: name,
                backup_id: shelf_id,
                conflicted,
                details,
            }),
        );
    }
    crate::shelf::operate(
        config_dir,
        repo,
        crate::models::ShelfOperation::Drop { shelf_id },
        &recovery_token,
    )
    .await?;
    let mut result = result?;
    if let Some(update) = result.update.as_mut() {
        update.before_status = before_status;
        update.after_status = status_fingerprint(repo, &recovery_token).await?;
    }
    Ok(result)
}

pub async fn sync(
    repo: &RepositoryMeta,
    action: SyncAction,
    remote: Option<String>,
    branch: Option<String>,
    force: bool,
    settings: &crate::models::DesktopSettings,
    token: &CancellationToken,
) -> Result<SyncResult, DesktopError> {
    if repo.kind == VcsKind::Git && matches!(action, SyncAction::PushTags) {
        return Ok(SyncResult {
            restore_warning: None,
            output: git_push_tags(repo, remote, token).await?,
            update: None,
        });
    }
    if repo.kind == VcsKind::Git && matches!(action, SyncAction::Push) {
        return Ok(SyncResult {
            restore_warning: None,
            output: git_push(
                repo,
                remote,
                branch,
                force,
                settings.use_safe_force_push,
                token,
            )
            .await?,
            update: None,
        });
    }
    if repo.kind == VcsKind::Git
        && matches!(
            action,
            SyncAction::Pull | SyncAction::PullRebase | SyncAction::PullFfOnly
        )
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
        SyncAction::Pull | SyncAction::PullRebase | SyncAction::PullFfOnly | SyncAction::Update
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
        && matches!(
            action,
            SyncAction::Pull | SyncAction::PullRebase | SyncAction::PullFfOnly
        )
        && explicit_remote_branch.is_none()
    {
        let has_upstream = git_upstream(repo, token).await?.is_some();
        if !has_upstream {
            return Ok(SyncResult {
                restore_warning: None,
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
        (VcsKind::Git, SyncAction::Fetch) => {
            let mut args = vec!["fetch".into(), "--all".into(), "--prune".into()];
            match settings.fetch_tags {
                crate::models::FetchTagsMode::All => args.push("--tags".into()),
                crate::models::FetchTagsMode::None => args.push("--no-tags".into()),
                crate::models::FetchTagsMode::Auto => {}
            }
            ("git", args)
        }
        (VcsKind::Git, SyncAction::Pull | SyncAction::PullRebase | SyncAction::PullFfOnly) => {
            let mut args = vec!["pull".into()];
            if matches!(action, SyncAction::PullRebase) {
                args.push("--rebase".into());
            } else if matches!(action, SyncAction::PullFfOnly) {
                args.push("--ff-only".into());
            } else {
                args.extend(["--no-rebase".into(), "--ff".into()]);
            }
            if let Some((remote_name, remote_branch)) = explicit_remote_branch {
                args.extend([remote_name, remote_branch]);
            }
            ("git", args)
        }
        (VcsKind::Git, SyncAction::Push | SyncAction::PushTags) => unreachable!(),
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
    let operation = if program == "svn" {
        svn_with_timeout(safe[1..].to_vec(), repo, token, cli::NETWORK_TIMEOUT).await
    } else {
        cli::run(
            program,
            &safe,
            Path::new(&repo.root_path),
            None,
            cli::NETWORK_TIMEOUT,
            token,
        )
        .await
    };
    // Updating may be cancelled, but captured local changes must finish recovery.
    let recovery_token = CancellationToken::new();
    let output = match operation {
        Ok(output) => output.stdout_text(),
        Err(error) => {
            if let Some(auto_stash) = auto_stash.as_ref() {
                if git_has_conflicts(repo, &recovery_token).await
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
                restore_pull_auto_stash(repo, auto_stash, &recovery_token)
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
        if let Err(error) = restore_pull_auto_stash(repo, auto_stash, &recovery_token).await {
            let code = if git_has_conflicts(repo, &recovery_token).await
                || git_has_conflict_error(&error)
            {
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
            restore_warning: None,
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
        restore_warning: None,
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
    create_auto_stash(repo, false, token).await
}

async fn create_auto_stash(
    repo: &RepositoryMeta,
    include_untracked: bool,
    token: &CancellationToken,
) -> Result<Option<PullAutoStash>, DesktopError> {
    let mut status_args = vec!["status".into(), "--porcelain=v1".into()];
    if !include_untracked {
        status_args.push("--untracked-files=no".into());
    }
    let tracked_status = git(status_args, repo, token).await?.stdout_text();
    if tracked_status.trim().is_empty() {
        return Ok(None);
    }
    // Once Git starts capturing changes, finish identifying the recovery object
    // even if the operation is cancelled in the meantime.
    let capture_token = CancellationToken::new();
    let token = &capture_token;
    let before = pull_stash_head(repo, token).await;
    let marker = format!(
        "versiondock-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    );
    let name = if include_untracked {
        format!(
            "Auto-stashed before update ({})",
            chrono::Local::now().format("%H:%M:%S")
        )
    } else {
        format!("VersionDock automatic stash before update ({marker})")
    };
    let mut args = vec!["stash".into(), "push".into(), "--message".into(), name];
    if include_untracked {
        args.push("--include-untracked".into());
    }
    git(args, repo, token).await?;
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
    restore_auto_stash(repo, auto_stash, true, token).await
}

async fn restore_auto_stash(
    repo: &RepositoryMeta,
    auto_stash: &PullAutoStash,
    restore_index: bool,
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
    let mut args = vec!["stash".into(), "pop".into()];
    if restore_index {
        args.push("--index".into());
    }
    args.push(reference);
    git(args, repo, token).await?;
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
        restore_warning: None,
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

fn decode_svn_path(input: &str) -> String {
    let mut bytes = Vec::new();
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            if let (Some(h1), Some(h2)) = (chars.next(), chars.next()) {
                if let Ok(hex_byte) =
                    u8::from_str_radix(&format!("{}{}", h1 as char, h2 as char), 16)
                {
                    bytes.push(hex_byte);
                    continue;
                }
                bytes.push(b);
                bytes.push(h1);
                bytes.push(h2);
            } else {
                bytes.push(b);
            }
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

pub struct SvnWorkingCopyInfo {
    pub revision: String,
    pub relative_path: String,
    pub url: String,
}

pub async fn svn_working_copy_info(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<SvnWorkingCopyInfo, DesktopError> {
    let raw = svn(vec!["info".into(), "--xml".into()], repo, token)
        .await?
        .stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let entry = document
        .descendants()
        .find(|node| node.has_tag_name("entry"));
    let revision = entry
        .and_then(|node| node.attribute("revision"))
        .ok_or_else(|| {
            DesktopError::new("SVN_REVISION_MISSING", "Unable to read SVN revision", true)
        })?
        .to_string();
    let revision = svn_effective_revision(repo, &revision, token).await;
    let wc_url = document
        .descendants()
        .find(|n| n.has_tag_name("url"))
        .and_then(|n| n.text())
        .unwrap_or("")
        .to_string();
    let mut relative_path = document
        .descendants()
        .find(|n| n.has_tag_name("relative-url"))
        .and_then(|n| n.text())
        .map(|s| decode_svn_path(s.trim().trim_start_matches('^').trim_matches('/')))
        .unwrap_or_default();
    if relative_path.is_empty() {
        let root_url = document
            .descendants()
            .find(|n| n.has_tag_name("root"))
            .and_then(|n| n.text())
            .unwrap_or("");
        if !wc_url.is_empty() && !root_url.is_empty() && wc_url.starts_with(root_url) {
            relative_path = decode_svn_path(wc_url[root_url.len()..].trim_matches('/'));
        }
    }
    Ok(SvnWorkingCopyInfo {
        revision,
        relative_path,
        url: wc_url,
    })
}

fn map_svn_path_to_working_copy(
    raw_path: &str,
    wc_relative_path: &str,
    wc_url: &str,
) -> Option<String> {
    let decoded = decode_svn_path(raw_path.trim());

    if !wc_url.is_empty() {
        if let Some(suffix) = decoded
            .strip_prefix(wc_url)
            .or_else(|| raw_path.strip_prefix(wc_url))
        {
            let rel = suffix.trim_start_matches('/');
            if rel.is_empty() {
                return None;
            }
            return Some(rel.to_string());
        }
    }

    let repo_rel = decoded.trim_start_matches('/');
    if wc_relative_path.is_empty() {
        if repo_rel.is_empty() {
            None
        } else {
            Some(repo_rel.to_string())
        }
    } else {
        let prefix = format!("{wc_relative_path}/");
        if repo_rel.starts_with(&prefix) {
            let rel = &repo_rel[prefix.len()..];
            if rel.is_empty() {
                None
            } else {
                Some(rel.to_string())
            }
        } else {
            None
        }
    }
}

pub(crate) async fn svn_effective_revision(
    repo: &RepositoryMeta,
    revision: &str,
    token: &CancellationToken,
) -> String {
    let Ok(root_revision) = revision.parse::<u64>() else {
        return revision.to_string();
    };
    // A partial commit can leave the working-copy root at an older revision.
    // Match the extension's BASE marker using the upper svnversion revision.
    let output = cli::run(
        "svnversion",
        &[".".into()],
        Path::new(&repo.root_path),
        None,
        Duration::from_secs(5),
        token,
    )
    .await;
    let working_revision = output.ok().and_then(|output| {
        let text = output.stdout_text();
        let range = text
            .trim()
            .split(|character: char| !character.is_ascii_digit() && character != ':')
            .next()?;
        range
            .split(':')
            .filter_map(|value| value.parse::<u64>().ok())
            .max()
    });
    root_revision
        .max(working_revision.unwrap_or(root_revision))
        .to_string()
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
        VcsKind::Svn => svn_working_copy_info(repo, token)
            .await
            .map(|info| info.revision),
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
                                "-z".into(),
                                "-M".into(),
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
                                "-z".into(),
                                "-M".into(),
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
    requested_branch: Option<String>,
    force: bool,
    use_safe_force_push: bool,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let mut extra_args: Vec<String> = Vec::new();
    if force {
        if use_safe_force_push {
            extra_args.push("--force-with-lease".into());
        } else {
            extra_args.push("--force".into());
        }
    }
    let explicit_branch = requested_branch
        .as_ref()
        .is_some_and(|value| !value.is_empty());
    let target_branch = if let Some(branch_name) = requested_branch {
        let clean = branch_name.trim_start_matches("refs/heads/").to_string();
        if !clean.is_empty() {
            validate_ref(&clean)?;
            Some(clean)
        } else {
            None
        }
    } else {
        None
    };

    let branch = if let Some(b) = target_branch {
        b
    } else {
        let head_branch = git(
            vec!["symbolic-ref".into(), "--short".into(), "HEAD".into()],
            repo,
            token,
        )
        .await?
        .stdout_text()
        .trim()
        .to_string();
        validate_ref(&head_branch)?;
        head_branch
    };

    let has_upstream = git(
        vec![
            "rev-parse".into(),
            "--abbrev-ref".into(),
            "--symbolic-full-name".into(),
            format!("{branch}@{{upstream}}"),
        ],
        repo,
        token,
    )
    .await
    .is_ok();

    if let Some(remote) = requested_remote {
        validate_ref(&remote)?;
        let mut args = vec!["push".into()];
        args.extend(extra_args);
        if !has_upstream {
            args.extend(["--set-upstream".into(), remote, branch]);
        } else {
            args.push(remote);
            args.push(branch);
        }
        return Ok(git(args, repo, token).await?.stdout_text());
    }

    if has_upstream && explicit_branch {
        let remote = git(
            vec![
                "config".into(),
                "--get".into(),
                format!("branch.{branch}.remote"),
            ],
            repo,
            token,
        )
        .await?
        .stdout_text()
        .trim()
        .to_string();
        validate_ref(&remote)?;
        let mut args = vec!["push".into()];
        args.extend(extra_args);
        args.extend([remote, branch]);
        return Ok(git(args, repo, token).await?.stdout_text());
    }
    if has_upstream {
        let mut args = vec!["push".into()];
        args.extend(extra_args);
        return Ok(git(args, repo, token).await?.stdout_text());
    }

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
    let mut args = vec!["push".into()];
    args.extend(extra_args);
    args.extend(["--set-upstream".into(), remote, branch]);
    Ok(git(args, repo, token).await?.stdout_text())
}

async fn git_push_tags(
    repo: &RepositoryMeta,
    requested_remote: Option<String>,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let remote = if let Some(remote) = requested_remote {
        validate_ref(&remote)?;
        remote
    } else {
        let remotes = git(vec!["remote".into()], repo, token)
            .await?
            .stdout_text()
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(String::from)
            .collect::<Vec<_>>();
        if remotes.iter().any(|value| value == "origin") {
            "origin".into()
        } else if remotes.len() == 1 {
            remotes[0].clone()
        } else {
            return Err(DesktopError::new(
                "PUSH_REMOTE_REQUIRED",
                "No unambiguous remote is available for pushing tags",
                true,
            ));
        }
    };
    Ok(
        git_network(vec!["push".into(), remote, "--tags".into()], repo, token)
            .await?
            .stdout_text(),
    )
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
    limit: Option<u32>,
    svn_limit: u32,
    revision: Option<String>,
    token: &CancellationToken,
) -> Result<Vec<GraphCommitNode>, DesktopError> {
    match repo.kind {
        VcsKind::Git => git_history_topology(repo, limit, revision, token).await,
        VcsKind::Svn => svn_history_topology(repo, svn_limit.clamp(1, 100), token).await,
    }
}

pub async fn unpushed_commits(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<UnpushedCommit>, DesktopError> {
    ensure_git(repo)?;
    let upstream = git_upstream(repo, token).await?;
    let mut range = if let Some(upstream) = upstream {
        vec![format!("{upstream}..HEAD")]
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
        "--format={RECORD}%H{FIELD}%h{FIELD}%s{FIELD}%B{FIELD}%an{FIELD}%aI{FIELD}%P{FIELD}%ae{META_END}"
    ));
    range.push("--numstat".into());
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
            let (metadata, stats) = record.split_once(META_END)?;
            let fields = metadata.split(FIELD).collect::<Vec<_>>();
            if fields.len() < 8 || fields[0].is_empty() {
                return None;
            }
            let (files_changed, additions, deletions, _) = parse_numstat(stats);
            Some(UnpushedCommit {
                hash: fields[0].into(),
                short_hash: fields[1].into(),
                message: fields[2].into(),
                body: commit_message_body(fields[3], fields[2]),
                full_message: Some(fields[3].trim().to_string()),
                author: fields[4].into(),
                author_email: Some(fields[7].into()).filter(|value: &String| !value.is_empty()),
                date: fields[5].into(),
                files_changed,
                additions,
                deletions,
                parents: fields[6].split_whitespace().map(str::to_string).collect(),
            })
        })
        .collect())
}

fn parse_numstat(raw: &str) -> (u32, u32, u32, Vec<String>) {
    let mut files = 0;
    let mut additions = 0;
    let mut deletions = 0;
    let mut paths = Vec::new();
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let fields = line.splitn(3, '\t').collect::<Vec<_>>();
        if fields.len() != 3 {
            continue;
        }
        files += 1;
        additions += fields[0].parse::<u32>().unwrap_or(0);
        deletions += fields[1].parse::<u32>().unwrap_or(0);
        paths.push(fields[2].to_string());
    }
    (files, additions, deletions, paths)
}

fn parse_git_name_status_z(raw: &str) -> Vec<(String, String)> {
    let fields = raw.split('\0').collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let code = fields[index];
        index += 1;
        if code.is_empty() {
            continue;
        }
        let rename_or_copy = code.starts_with('R') || code.starts_with('C');
        if rename_or_copy {
            index += 1;
        }
        let Some(path) = fields.get(index).filter(|path| !path.is_empty()) else {
            break;
        };
        index += 1;
        files.push((
            code.trim_end_matches(|character: char| character.is_ascii_digit())
                .to_string(),
            (*path).to_string(),
        ));
    }
    files
}

fn parse_numstat_z(raw: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let fields = raw.split('\0').collect::<Vec<_>>();
    let mut stats = HashMap::new();
    let mut index = 0;
    while index < fields.len() {
        let record = fields[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let parts = record.splitn(3, '\t').collect::<Vec<_>>();
        if parts.len() != 3 {
            continue;
        }
        let path = if parts[2].is_empty() {
            // Renames and copies include both paths; name-status uses the destination.
            let destination = fields.get(index + 1).copied().unwrap_or_default();
            index += 2;
            destination
        } else {
            parts[2]
        };
        if path.is_empty() {
            continue;
        }
        stats.insert(
            path.to_string(),
            (parts[0].parse().ok(), parts[1].parse().ok()),
        );
    }
    stats
}

async fn git_revision_changes(
    repo: &RepositoryMeta,
    from_revision: String,
    to_revision: String,
    token: &CancellationToken,
) -> Result<RevisionChanges, DesktopError> {
    let (statuses, stats) = tokio::try_join!(
        git(
            vec![
                "diff".into(),
                "--name-status".into(),
                "-z".into(),
                "-M".into(),
                from_revision.clone(),
                to_revision.clone(),
                "--".into(),
            ],
            repo,
            token,
        ),
        git(
            vec![
                "diff".into(),
                "--numstat".into(),
                "-z".into(),
                "-M".into(),
                from_revision.clone(),
                to_revision.clone(),
                "--".into(),
            ],
            repo,
            token,
        ),
    )?;
    let stats = parse_numstat_z(&stats.stdout_text());
    let files = parse_git_name_status_z(&statuses.stdout_text())
        .into_iter()
        .map(|(status, path)| {
            let (added, removed) = stats.get(&path).copied().unwrap_or((None, None));
            CommitFile {
                path,
                status,
                added,
                removed,
            }
        })
        .collect();
    Ok(RevisionChanges {
        from_revision,
        to_revision,
        files,
    })
}

fn commit_message_body(full_message: &str, subject: &str) -> Option<String> {
    let full_message = full_message.trim();
    let body = full_message
        .strip_prefix(subject)
        .unwrap_or(full_message)
        .trim();
    (!body.is_empty()).then(|| body.to_string())
}

pub async fn incoming_commits(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<IncomingCommit>, DesktopError> {
    ensure_git(repo)?;
    let Some(upstream) = git_upstream(repo, token).await? else {
        return Ok(Vec::new());
    };

    let raw = git(
        vec![
            "log".into(),
            format!("HEAD..{upstream}"),
            "--max-count=100".into(),
            format!("--format={RECORD}%H{FIELD}%h{FIELD}%s{FIELD}%B{FIELD}%an{FIELD}%aI{FIELD}%P{FIELD}%ae{META_END}"),
            "--numstat".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();

    let potential_conflict_paths = incoming_conflict_paths(repo, &upstream, token)
        .await
        .into_iter()
        .collect::<HashSet<_>>();
    Ok(raw
        .split(RECORD)
        .filter_map(|record| {
            let (metadata, stats) = record.split_once(META_END)?;
            let fields = metadata.split(FIELD).collect::<Vec<_>>();
            if fields.len() < 8 || fields[0].is_empty() {
                return None;
            }
            let (files_changed, additions, deletions, changed_paths) = parse_numstat(stats);
            Some(IncomingCommit {
                hash: fields[0].into(),
                short_hash: fields[1].into(),
                message: fields[2].into(),
                body: commit_message_body(fields[3], fields[2]),
                full_message: Some(fields[3].trim().to_string()),
                author: fields[4].into(),
                author_email: Some(fields[7].into()).filter(|value: &String| !value.is_empty()),
                date: fields[5].into(),
                files_changed,
                additions,
                deletions,
                parents: fields[6].split_whitespace().map(str::to_string).collect(),
                potential_conflict_paths: changed_paths
                    .into_iter()
                    .filter(|path| potential_conflict_paths.contains(path))
                    .collect(),
            })
        })
        .collect())
}

async fn empty_git_changes(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<RevisionChanges, DesktopError> {
    let revision = current_revision(repo, token).await?;
    Ok(RevisionChanges {
        from_revision: revision.clone(),
        to_revision: revision,
        files: Vec::new(),
    })
}

pub async fn unpushed_changes(
    repo: &RepositoryMeta,
    oldest_revision: Option<String>,
    token: &CancellationToken,
) -> Result<RevisionChanges, DesktopError> {
    ensure_git(repo)?;
    let from_revision = if let Some(oldest) = oldest_revision {
        validate_revision(&oldest)?;
        git(
            vec!["rev-parse".into(), "--verify".into(), format!("{oldest}^")],
            repo,
            token,
        )
        .await
        .ok()
        .map(|output| output.stdout_text().trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| EMPTY_TREE_HASH.into())
    } else {
        let Some(upstream) = git_upstream(repo, token).await? else {
            return empty_git_changes(repo, token).await;
        };
        git(
            vec!["merge-base".into(), "HEAD".into(), upstream],
            repo,
            token,
        )
        .await?
        .stdout_text()
        .trim()
        .to_string()
    };
    let to_revision = git(vec!["rev-parse".into(), "HEAD".into()], repo, token)
        .await?
        .stdout_text()
        .trim()
        .to_string();
    git_revision_changes(repo, from_revision, to_revision, token).await
}

pub async fn incoming_changes(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<RevisionChanges, DesktopError> {
    ensure_git(repo)?;
    let Some(upstream) = git_upstream(repo, token).await? else {
        return empty_git_changes(repo, token).await;
    };
    let to_revision = git(
        vec!["rev-parse".into(), "--verify".into(), upstream],
        repo,
        token,
    )
    .await?
    .stdout_text()
    .trim()
    .to_string();
    let from_revision = git(
        vec!["merge-base".into(), "HEAD".into(), to_revision.clone()],
        repo,
        token,
    )
    .await
    .ok()
    .map(|output| output.stdout_text().trim().to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "HEAD".into());
    git_revision_changes(repo, from_revision, to_revision, token).await
}

async fn incoming_conflict_paths(
    repo: &RepositoryMeta,
    upstream: &str,
    token: &CancellationToken,
) -> Vec<String> {
    let Some(base) = git(
        vec!["merge-base".into(), "HEAD".into(), upstream.into()],
        repo,
        token,
    )
    .await
    .ok()
    .map(|output| output.stdout_text().trim().to_string())
    .filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let collect = |raw: String| {
        raw.lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<HashSet<_>>()
    };
    let mut local = git(
        vec!["diff".into(), "--name-only".into(), format!("{base}..HEAD")],
        repo,
        token,
    )
    .await
    .ok()
    .map(|output| collect(output.stdout_text()))
    .unwrap_or_default();
    for args in [
        vec!["diff".into(), "--name-only".into()],
        vec!["diff".into(), "--cached".into(), "--name-only".into()],
        vec![
            "ls-files".into(),
            "--others".into(),
            "--exclude-standard".into(),
        ],
    ] {
        if let Ok(output) = git(args, repo, token).await {
            local.extend(collect(output.stdout_text()));
        }
    }
    let remote = git(
        vec![
            "diff".into(),
            "--name-only".into(),
            format!("{base}..{upstream}"),
        ],
        repo,
        token,
    )
    .await
    .ok()
    .map(|output| collect(output.stdout_text()))
    .unwrap_or_default();
    let mut paths = local.intersection(&remote).cloned().collect::<Vec<_>>();
    paths.sort();
    paths
}

async fn ensure_unpushed_commits(
    repo: &RepositoryMeta,
    hashes: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if hashes.is_empty() {
        return Ok(());
    }
    for hash in hashes {
        validate_revision(hash)?;
    }

    let remotes_output = git(vec!["remote".into()], repo, token).await?.stdout_text();
    let remote_names: Vec<String> = remotes_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect();

    if !remote_names.is_empty() {
        for remote_name in &remote_names {
            validate_ref(remote_name)?;
            git_network_quick(
                vec![
                    "fetch".into(),
                    "--prune".into(),
                    "--no-tags".into(),
                    remote_name.clone(),
                ],
                repo,
                token,
            )
            .await
            .map_err(|err| {
                DesktopError::new(
                    "CANNOT_VERIFY_REMOTE_STATE",
                    format!(
                        "Cannot verify remote tracking state for '{remote_name}' before rewriting history. Operation aborted to protect published commits: {}",
                        err.message
                    ),
                    false,
                )
            })?;
        }
    }

    if let Some(upstream) = git_upstream(repo, token).await? {
        for hash in hashes {
            let is_ancestor = git(
                vec![
                    "merge-base".into(),
                    "--is-ancestor".into(),
                    hash.clone(),
                    upstream.clone(),
                ],
                repo,
                token,
            )
            .await
            .is_ok();

            if is_ancestor {
                let short = if hash.len() > 7 { &hash[..7] } else { hash };
                return Err(DesktopError::new(
                    "COMMIT_ALREADY_PUSHED",
                    format!("Commit {short} has already been pushed to the remote tracking branch"),
                    false,
                ));
            }
        }
    }

    if !remote_names.is_empty() {
        for hash in hashes {
            let containing_remotes = git(
                vec![
                    "branch".into(),
                    "-r".into(),
                    "--contains".into(),
                    hash.clone(),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text();

            if containing_remotes.lines().any(|l| !l.trim().is_empty()) {
                let short = if hash.len() > 7 { &hash[..7] } else { hash };
                return Err(DesktopError::new(
                    "COMMIT_ALREADY_PUSHED",
                    format!("Commit {short} has already been pushed to a remote branch"),
                    false,
                ));
            }
        }
    }

    Ok(())
}

pub async fn unpushed_operation(
    repo: &RepositoryMeta,
    operation: UnpushedOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    match operation {
        UnpushedOperation::UndoHead { expected_hash } => {
            let head = git(vec!["rev-parse".into(), "HEAD".into()], repo, token)
                .await?
                .stdout_text()
                .trim()
                .to_string();
            if let Some(expected) = expected_hash
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                validate_revision(expected)?;
                let matches =
                    head == expected || head.starts_with(expected) || expected.starts_with(&head);
                if !matches {
                    return Err(DesktopError::new(
                        "COMMIT_NOT_HEAD",
                        "The current HEAD has changed and no longer matches the expected commit",
                        false,
                    ));
                }
            }
            ensure_unpushed_commits(repo, &[head], token).await?;
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
            let matches = head == hash || head.starts_with(&hash) || hash.starts_with(&head);
            if !matches {
                return Err(DesktopError::new(
                    "COMMIT_NOT_HEAD",
                    "Only the HEAD commit message can be edited safely",
                    false,
                ));
            }
            ensure_unpushed_commits(repo, &[head], token).await?;
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
            ensure_unpushed_commits(repo, &hashes, token).await?;
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
            let matches = newest == head || newest.starts_with(&head) || head.starts_with(&newest);
            if !matches {
                return Err(DesktopError::new(
                    "SQUASH_REQUIRES_HEAD",
                    "Squash selection must include HEAD",
                    false,
                ));
            }
            ensure_unpushed_commits(repo, &hashes, token).await?;
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
    cherry_pick_add_suffix: bool,
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
                    let mut args = vec!["cherry-pick".into()];
                    if cherry_pick_add_suffix {
                        args.push("-x".into());
                    }
                    args.push(revision);
                    git(args, repo, token).await?;
                }
                HistoryOperation::Revert { revisions } => {
                    ensure_clean_worktree(repo, token).await?;
                    validate_commit_hashes(&revisions)?;
                    let mut args = vec!["revert".into(), "--no-edit".into()];
                    args.extend(revisions);
                    git(args, repo, token).await?;
                }
                HistoryOperation::Reset {
                    revision,
                    mode,
                    expected_branch,
                    expected_head,
                } => {
                    validate_revision(&revision)?;
                    if !matches!(mode.as_str(), "soft" | "mixed" | "hard") {
                        return Err(DesktopError::new(
                            "INVALID_RESET_MODE",
                            "Reset mode must be soft, mixed, or hard",
                            false,
                        ));
                    }
                    if let Some(expected) = expected_branch
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        let current_branch = git(
                            vec![
                                "symbolic-ref".into(),
                                "--short".into(),
                                "-q".into(),
                                "HEAD".into(),
                            ],
                            repo,
                            token,
                        )
                        .await
                        .map(|output| output.stdout_text().trim().to_string())
                        .ok();

                        let branch_matches = match current_branch.as_deref() {
                            Some(current) => current == expected,
                            None => expected == "HEAD" || expected == "(detached)",
                        };

                        if !branch_matches {
                            return Err(DesktopError::new(
                                "BRANCH_CHANGED",
                                format!(
                                    "The current branch has changed (expected '{expected}'). Reset aborted.",
                                ),
                                false,
                            ));
                        }
                    }
                    if let Some(expected) = expected_head
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        validate_revision(expected)?;
                        let head = git(vec!["rev-parse".into(), "HEAD".into()], repo, token)
                            .await?
                            .stdout_text()
                            .trim()
                            .to_string();
                        let matches = head == expected
                            || head.starts_with(expected)
                            || expected.starts_with(&head);
                        if !matches {
                            return Err(DesktopError::new(
                                "HEAD_CHANGED",
                                "The current HEAD commit has changed since confirmation. Reset aborted.",
                                false,
                            ));
                        }
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
                    let parent_ref = format!("{revision}^");
                    let exists_in_parent = git(
                        vec![
                            "cat-file".into(),
                            "-e".into(),
                            format!("{parent_ref}:{safe}"),
                        ],
                        repo,
                        token,
                    )
                    .await
                    .is_ok();
                    if exists_in_parent {
                        git(
                            vec![
                                "restore".into(),
                                "--source".into(),
                                parent_ref,
                                "--".into(),
                                safe,
                            ],
                            repo,
                            token,
                        )
                        .await?;
                    } else {
                        let abs_path = Path::new(&repo.root_path).join(&safe);
                        if abs_path.exists() {
                            if abs_path.is_dir() {
                                let _ = std::fs::remove_dir_all(&abs_path);
                            } else {
                                let _ = std::fs::remove_file(&abs_path);
                            }
                        }
                    }
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
                        "format-patch".into(),
                        "-1".into(),
                        "--stdout".into(),
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

pub async fn save_patches(
    repo: &RepositoryMeta,
    revisions: &[String],
    directory: &str,
    token: &CancellationToken,
) -> Result<Vec<String>, DesktopError> {
    if revisions.is_empty() {
        return Err(DesktopError::new(
            "EMPTY_COMMIT_SELECTION",
            "Select at least one revision",
            false,
        ));
    }
    let folder = crate::state::canonical_directory(directory)?;
    let mut files = Vec::new();
    for revision in revisions {
        let patch = create_patch(repo, std::slice::from_ref(revision), token).await?;
        let name = format!("{}.patch", revision.chars().take(7).collect::<String>());
        let target = safe_relative(&folder, &name, true)?;
        tokio::fs::write(&target, patch.content.as_bytes())
            .await
            .map_err(|e| DesktopError::new("SAVE_PATCH_FAILED", e.to_string(), true))?;
        files.push(target.to_string_lossy().into_owned());
    }
    Ok(files)
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

    let query_text = query.text.as_deref().map(str::trim).unwrap_or("");
    let is_hash_like =
        (7..=64).contains(&query_text.len()) && query_text.chars().all(|c| c.is_ascii_hexdigit());
    let mut resolved_revision: Option<String> = None;
    if is_hash_like {
        let rev_parse_res = git(
            vec![
                "rev-parse".into(),
                "--verify".into(),
                "--quiet".into(),
                format!("{}^{{commit}}", query_text.to_ascii_lowercase()),
            ],
            repo,
            token,
        )
        .await;
        match rev_parse_res {
            Ok(output) => {
                let resolved = output.stdout_text().trim().to_string();
                if resolved.is_empty() {
                    return Ok(HistoryPage {
                        commits: Vec::new(),
                        has_more: false,
                    });
                }
                resolved_revision = Some(resolved);
            }
            Err(_) => {
                return Ok(HistoryPage {
                    commits: Vec::new(),
                    has_more: false,
                });
            }
        }
    }
    if resolved_revision.is_some() && skip > 0 {
        return Ok(HistoryPage {
            commits: Vec::new(),
            has_more: false,
        });
    }

    let query_revision = query
        .revision
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "WORKTREE" && *v != "WORKING" && *v != "INDEX");

    if let (Some(rev), Some(branch)) = (&resolved_revision, query_revision) {
        let is_ancestor = git(
            vec![
                "merge-base".into(),
                "--is-ancestor".into(),
                rev.clone(),
                branch.to_string(),
            ],
            repo,
            token,
        )
        .await
        .is_ok();
        if !is_ancestor {
            return Ok(HistoryPage {
                commits: Vec::new(),
                has_more: false,
            });
        }
    }

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
        args.push("--regexp-ignore-case".into());
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
    if resolved_revision.is_none() && !query_text.is_empty() {
        args.push(format!("--grep={query_text}"));
        args.push("--regexp-ignore-case".into());
    }
    let trimmed_path = query
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let line_range_filter = if trimmed_path.is_some() {
        query.line_range
    } else {
        None
    };

    if line_range_filter.is_some() {
        args.push("--no-patch".into());
    }

    if let Some(rev) = &resolved_revision {
        args.push("-1".into());
        args.push(rev.clone());
    } else if let Some(value) = query_revision {
        args.push(value.to_string());
    } else if line_range_filter.is_some() {
        if !head_hash.is_empty() {
            args.push("HEAD".into());
        }
    } else {
        if !head_hash.is_empty() {
            args.push("HEAD".into());
        }
        args.push("--exclude=refs/stash".into());
        args.push("--exclude=refs/versiondock/ai-composer/*".into());
        args.push("--all".into());
    }
    if resolved_revision.is_none() {
        if let Some(path) = trimmed_path {
            if let Some(line_range) = line_range_filter {
                let path = relative_path(Path::new(&repo.root_path), path, false)?;
                args.push("-L".into());
                args.push(format!("{},{}:{}", line_range.start, line_range.end, path));
            } else {
                let path = literal_path(Path::new(&repo.root_path), path, false)?;
                args.push("--follow".into());
                args.push("--".into());
                args.push(path);
            }
        }
    }
    let (raw, refs_by_hash) = tokio::try_join!(
        async {
            match git(args, repo, token).await {
                Ok(output) => Ok(output.stdout_text()),
                Err(err) if line_range_filter.is_some() => {
                    let message = err.message.to_lowercase();
                    if message.contains("has only") {
                        Ok(String::new())
                    } else {
                        Err(err)
                    }
                }
                Err(err) => Err(err),
            }
        },
        git_decorated_refs(repo, &head_hash, token),
    )?;
    let needle = query_text.to_lowercase();
    let mut commits = raw
        .split(RECORD)
        .filter_map(|record| {
            let fields = record.trim().split(FIELD).collect::<Vec<_>>();
            if fields.len() < 10 || fields[0].is_empty() {
                return None;
            }
            if let Some(ref rev) = resolved_revision {
                if !fields[0].eq_ignore_ascii_case(rev)
                    && !fields[1].to_lowercase().starts_with(&needle)
                {
                    return None;
                }
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
    let upstream = git_upstream(repo, token).await?;
    let unpushed = git_unpushed_history_hashes(repo, upstream.as_deref(), token).await;
    let incoming = if let Some(upstream) = upstream {
        git_revision_hashes(repo, vec![format!("HEAD..{upstream}")], token).await
    } else {
        HashSet::new()
    };
    for commit in &mut commits {
        commit.unpushed = unpushed
            .as_ref()
            .is_none_or(|hashes| hashes.contains(&commit.hash));
        commit.incoming = incoming.contains(&commit.hash);
    }
    let has_more = commits.len() > limit as usize;
    commits.truncate(limit as usize);
    Ok(HistoryPage { commits, has_more })
}

async fn git_history_topology(
    repo: &RepositoryMeta,
    limit: Option<u32>,
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
    let cap = limit.unwrap_or(2000).max(2000);
    let mut args = vec![
        "log".into(),
        format!("-n{cap}"),
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

// None means there are no remote references: all visible commits are local.
async fn git_unpushed_history_hashes(
    repo: &RepositoryMeta,
    upstream: Option<&str>,
    token: &CancellationToken,
) -> Option<HashSet<String>> {
    if let Some(upstream) = upstream {
        return Some(git_revision_hashes(repo, vec![format!("{upstream}..HEAD")], token).await);
    }
    match git(
        vec![
            "for-each-ref".into(),
            "--format=%(refname)".into(),
            "refs/remotes/".into(),
        ],
        repo,
        token,
    )
    .await
    {
        Ok(output) if output.stdout_text().trim().is_empty() => None,
        Ok(_) => Some(
            git_revision_hashes(
                repo,
                vec!["HEAD".into(), "--not".into(), "--remotes".into()],
                token,
            )
            .await,
        ),
        Err(_) => Some(HashSet::new()),
    }
}

async fn git_revision_hashes(
    repo: &RepositoryMeta,
    revisions: Vec<String>,
    token: &CancellationToken,
) -> HashSet<String> {
    let mut args = vec!["rev-list".into()];
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

pub async fn branch_compare_commits(
    repo: &RepositoryMeta,
    base: &str,
    target: &str,
    side: &str,
    skip: u32,
    limit: u32,
    query: &HistoryQuery,
    token: &CancellationToken,
) -> Result<Vec<CommitNode>, DesktopError> {
    ensure_git(repo)?;
    validate_revision_or_ref(base)?;
    validate_revision_or_ref(target)?;

    let is_base_only = side == "baseOnly" || side == "base";
    let is_target_only = side == "targetOnly" || side == "target";
    if !is_base_only && !is_target_only {
        return Err(DesktopError::new(
            "VALIDATION_FAILED",
            "side must be either 'baseOnly' or 'targetOnly'",
            false,
        ));
    }

    let trimmed_text = query.text.as_deref().map(str::trim).unwrap_or("");
    let is_hash_like = (7..=64).contains(&trimmed_text.len())
        && trimmed_text.bytes().all(|b| b.is_ascii_hexdigit());

    let mut resolved_revision: Option<String> = None;
    if is_hash_like {
        let rev_parse_res = git(
            vec![
                "rev-parse".into(),
                "--verify".into(),
                "--quiet".into(),
                format!("{}^{{commit}}", trimmed_text.to_ascii_lowercase()),
            ],
            repo,
            token,
        )
        .await;
        if let Ok(output) = rev_parse_res {
            let resolved = output.stdout_text().trim().to_string();
            if !resolved.is_empty() {
                resolved_revision = Some(resolved);
            }
        }
        if resolved_revision.is_none() {
            return Ok(Vec::new());
        }
    }

    if let Some(ref rev) = resolved_revision {
        if skip > 0 {
            return Ok(Vec::new());
        }
        let (in_base, in_target) = tokio::join!(
            git(
                vec![
                    "merge-base".into(),
                    "--is-ancestor".into(),
                    rev.clone(),
                    base.to_string(),
                ],
                repo,
                token,
            ),
            git(
                vec![
                    "merge-base".into(),
                    "--is-ancestor".into(),
                    rev.clone(),
                    target.to_string(),
                ],
                repo,
                token,
            )
        );

        let matches_side = if is_base_only {
            in_base.is_ok() && in_target.is_err()
        } else {
            in_target.is_ok() && in_base.is_err()
        };

        if !matches_side {
            return Ok(Vec::new());
        }
    }

    let range = if is_base_only {
        format!("{target}..{base}")
    } else {
        format!("{base}..{target}")
    };

    let format = format!(
        "%H{FIELD}%h{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%aI{FIELD}%cI{FIELD}%s{FIELD}%D{RECORD}"
    );

    let max_count = if resolved_revision.is_some() {
        1
    } else if limit == 0 {
        200
    } else {
        limit
    };

    let skip_count = if resolved_revision.is_some() { 0 } else { skip };

    let mut args = vec![
        "log".into(),
        format!("--max-count={max_count}"),
        format!("--skip={skip_count}"),
        format!("--format={format}"),
        "--date=iso-strict".into(),
    ];

    if let Some(ref rev) = resolved_revision {
        args.push(rev.clone());
    } else if !trimmed_text.is_empty() {
        args.push(format!("--grep={trimmed_text}"));
        args.push("--regexp-ignore-case".into());
    }

    if let Some(value) = query
        .author
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push(format!("--author={}", regex_literal(value)));
        args.push("--regexp-ignore-case".into());
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

    if resolved_revision.is_none() {
        args.push(range);
    }

    if let Some(path) = query
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--".into());
        args.push(path.into());
    }

    let output = git(args, repo, token).await?;
    let commits = parse_git_log(&repo.id, &output.stdout_text());
    Ok(commits)
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
    let default_query = HistoryQuery::default();
    let (base_commits, target_commits) = tokio::try_join!(
        branch_compare_commits(
            repo,
            base,
            target,
            "baseOnly",
            0,
            500,
            &default_query,
            token
        ),
        branch_compare_commits(
            repo,
            base,
            target,
            "targetOnly",
            0,
            500,
            &default_query,
            token
        )
    )?;
    let range = format!("{base}..{target}");
    let stats = git(
        vec![
            "diff".into(),
            "--numstat".into(),
            "-z".into(),
            "-M".into(),
            range.clone(),
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
            "-z".into(),
            "-M".into(),
            range,
            "--".into(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    Ok(BranchCompareResult {
        base: base.into(),
        target: target.into(),
        base_commits,
        target_commits,
        files: merge_git_files(&stats, &statuses),
    })
}

async fn svn_selection_revisions(
    repo: &RepositoryMeta,
    path: &str,
    line_range: LineRange,
    revision: Option<&str>,
    token: &CancellationToken,
) -> Result<HashSet<String>, DesktopError> {
    let rel = relative_path(Path::new(&repo.root_path), path, false)?;
    let mut args = vec!["blame".into(), "--xml".into()];
    let clean_rev = revision
        .map(str::trim)
        .filter(|r| !r.is_empty() && *r != "HEAD")
        .and_then(|r| {
            let clean = r.trim_start_matches('r');
            if clean.bytes().all(|b| b.is_ascii_digit()) && !clean.is_empty() {
                Some(clean)
            } else {
                None
            }
        });
    if let Some(rev) = clean_rev {
        args.extend(["-r".into(), rev.to_string()]);
        args.extend(["--".into(), format!("{rel}@{rev}")]);
    } else {
        args.extend(["--".into(), format!("{rel}@")]);
    }
    let output = svn_with_timeout(args, repo, token, Duration::from_secs(15)).await?;
    let raw = output.stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let mut revisions = HashSet::new();
    for entry in document.descendants().filter(|n| n.has_tag_name("entry")) {
        let line_num: u32 = match entry.attribute("line-number").and_then(|v| v.parse().ok()) {
            Some(n) => n,
            None => continue,
        };
        if line_num < line_range.start || line_num > line_range.end {
            continue;
        }
        if let Some(commit_node) = entry.children().find(|c| c.has_tag_name("commit")) {
            if let Some(rev) = commit_node
                .attribute("revision")
                .map(str::trim)
                .filter(|r| !r.is_empty())
            {
                revisions.insert(rev.to_string());
            }
        }
    }
    Ok(revisions)
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

    let trimmed_path = query
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let query_revision = query.revision.as_deref().map(str::trim).filter(|v| {
        !v.is_empty() && *v != "HEAD" && *v != "WORKTREE" && *v != "WORKING" && *v != "INDEX"
    });

    let selection_revisions = match (trimmed_path, query.line_range) {
        (Some(path), Some(line_range)) => {
            let revisions =
                svn_selection_revisions(repo, path, line_range, query_revision, token).await?;
            if revisions.is_empty() {
                return Ok(HistoryPage {
                    commits: vec![],
                    has_more: false,
                });
            }
            Some(revisions)
        }
        _ => None,
    };

    let target = svn_history_target(repo, query_revision, query.path.as_deref())?;
    let mut args = vec!["log".into(), "--xml".into()];

    if let Some(ref sel) = selection_revisions {
        let mut numeric: Vec<u64> = sel.iter().filter_map(|r| r.parse::<u64>().ok()).collect();
        numeric.sort_unstable();
        if let (Some(&min_rev), Some(&max_rev)) = (numeric.first(), numeric.last()) {
            args.extend(["-r".into(), format!("{max_rev}:{min_rev}")]);
        } else {
            args.extend(["-r".into(), "HEAD:0".into()]);
        }
    } else if let Some(clean_rev) = query_revision.and_then(|r| {
        let clean = r.trim_start_matches('r');
        if clean.bytes().all(|b| b.is_ascii_digit()) && !clean.is_empty() {
            Some(clean)
        } else {
            None
        }
    }) {
        args.extend(["-r".into(), format!("{clean_rev}:0")]);
    } else {
        args.extend(["-r".into(), "HEAD:0".into()]);
    }

    let scan_limit = if backend_filter || selection_revisions.is_some() {
        requested.max(1_000)
    } else {
        requested
    };
    args.extend(["--limit".into(), scan_limit.to_string()]);
    if let Some(target) = target {
        args.extend(["--".into(), target]);
    }
    let raw = svn_with_timeout(args, repo, token, Duration::from_secs(15))
        .await?
        .stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let needle = query.text.unwrap_or_default().to_lowercase();
    let author_filter = query.author.unwrap_or_default().to_lowercase();
    let mut all = document
        .descendants()
        .filter(|node| node.has_tag_name("logentry"))
        .filter_map(|entry| {
            let revision = entry.attribute("revision")?;
            if let Some(ref sel) = selection_revisions {
                if !sel.contains(revision) {
                    return None;
                }
            }
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
    let true_head_rev = if query_revision.is_none() && query.path.is_none() {
        document
            .descendants()
            .find(|node| node.has_tag_name("logentry"))
            .and_then(|node| node.attribute("revision"))
            .map(|r| r.trim_start_matches('r').to_string())
    } else {
        None
    };
    let base_rev = current_revision(repo, token).await.ok();
    let clean_base = base_rev.as_deref().map(|r| r.trim_start_matches('r'));
    for commit in &mut all {
        let clean_c = commit.hash.trim_start_matches('r');
        let mut refs = Vec::new();
        if let Some(ref head) = true_head_rev {
            if clean_c == head {
                refs.push("HEAD".to_string());
            }
        }
        if let Some(base) = clean_base {
            if clean_c == base {
                refs.push("BASE".to_string());
            }
        }
        commit.refs = refs;
        commit.incoming = clean_base
            .and_then(|base| base.parse::<u64>().ok())
            .zip(clean_c.parse::<u64>().ok())
            .is_some_and(|(base, revision)| revision > base);
    }
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
    let numeric_rev = revision.and_then(|r| {
        let clean = r.trim_start_matches('r');
        if !clean.is_empty() && clean.bytes().all(|byte| byte.is_ascii_digit()) {
            Some(clean)
        } else {
            None
        }
    });
    let mut relative = String::new();
    if let Some(revision) = revision {
        if numeric_rev.is_none() {
            let target = svn_repository_target(revision)?;
            relative.push_str(target.trim_start_matches("^/"));
        }
    }
    if let Some(path) = path {
        let rel = relative_path(Path::new(&repo.root_path), path, false)?;
        if !relative.is_empty() {
            relative.push('/');
        }
        relative.push_str(rel.trim_matches('/'));
    }
    if relative.is_empty() {
        if let Some(clean) = numeric_rev {
            return Ok(Some(format!("{}@{clean}", repo.root_path)));
        }
        return Ok(None);
    }
    Ok(Some(if revision.is_some() && numeric_rev.is_none() {
        format!("^/{relative}@HEAD")
    } else if let Some(clean) = numeric_rev {
        format!(
            "{}@{clean}",
            Path::new(&repo.root_path).join(relative).to_string_lossy()
        )
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
                let (combined_status, combined_stats) = tokio::try_join!(
                    async {
                        Ok::<String, DesktopError>(
                            git(
                                vec![
                                    "diff-tree".into(),
                                    "--no-commit-id".into(),
                                    "-r".into(),
                                    "--cc".into(),
                                    "-z".into(),
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
                    async {
                        Ok::<String, DesktopError>(
                            git(
                                vec![
                                    "diff-tree".into(),
                                    "--no-commit-id".into(),
                                    "-r".into(),
                                    "--cc".into(),
                                    "-z".into(),
                                    "-M".into(),
                                    "--numstat".into(),
                                    revision.into(),
                                ],
                                repo,
                                token,
                            )
                            .await?
                            .stdout_text(),
                        )
                    },
                )?;
                let parent_changes =
                    Box::pin(merge_parent_changes(repo, revision, &commit.parents, token)).await?;
                (
                    parse_combined_diff_files(&combined_status, &parse_numstat_z(&combined_stats)),
                    parent_changes,
                )
            } else {
                let stats_args = if let Some(parent) = commit.parents.first() {
                    vec![
                        "diff".into(),
                        "--numstat".into(),
                        "-z".into(),
                        "-M".into(),
                        parent.clone(),
                        revision.into(),
                        "--".into(),
                    ]
                } else {
                    vec![
                        "show".into(),
                        "--numstat".into(),
                        "-z".into(),
                        "-M".into(),
                        "--format=".into(),
                        revision.into(),
                        "--".into(),
                    ]
                };
                let status_args = if let Some(parent) = commit.parents.first() {
                    vec![
                        "diff".into(),
                        "--name-status".into(),
                        "-z".into(),
                        "-M".into(),
                        parent.clone(),
                        revision.into(),
                        "--".into(),
                    ]
                } else {
                    vec![
                        "show".into(),
                        "--name-status".into(),
                        "-z".into(),
                        "-M".into(),
                        "--format=".into(),
                        revision.into(),
                        "--".into(),
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
            Ok(CommitDetail {
                commit,
                full_message: full_message.trim().into(),
                files,
                branches: CommitBranches::default(),
                branches_pending: Some(true),
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
            let clean_rev = revision.trim_start_matches('r');
            let mut refs = Vec::new();

            let wc_info = svn_working_copy_info(repo, token).await.ok();
            if let Some(ref info) = wc_info {
                if clean_rev == info.revision.trim_start_matches('r') {
                    refs.push("BASE".to_string());
                }
            }

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
                refs: refs.clone(),
                incoming: false,
                unpushed: false,
            };

            let wc_rel_path = wc_info
                .as_ref()
                .map(|i| i.relative_path.as_str())
                .unwrap_or("");
            let wc_url = wc_info.as_ref().map(|i| i.url.as_str()).unwrap_or("");

            let mut files: Vec<CommitFile> = document
                .descendants()
                .filter(|node| node.has_tag_name("path"))
                .filter(|node| node.attribute("kind") != Some("dir"))
                .filter_map(|node| {
                    let raw_path = node.text()?.trim();
                    let mapped = map_svn_path_to_working_copy(raw_path, wc_rel_path, wc_url)?;
                    Some(CommitFile {
                        path: mapped,
                        status: node.attribute("action").unwrap_or("M").into(),
                        added: None,
                        removed: None,
                    })
                })
                .collect();

            if files.is_empty() && !wc_url.is_empty() {
                if let Ok(summary_out) = svn(
                    vec![
                        "diff".into(),
                        "--summarize".into(),
                        "--xml".into(),
                        "-c".into(),
                        clean_rev.into(),
                        format!("{wc_url}@HEAD"),
                    ],
                    repo,
                    token,
                )
                .await
                {
                    if let Ok(summary_doc) = roxmltree::Document::parse(&summary_out.stdout_text())
                    {
                        files = summary_doc
                            .descendants()
                            .filter(|node| node.has_tag_name("path"))
                            .filter(|node| node.attribute("kind") != Some("dir"))
                            .filter_map(|node| {
                                let raw_path = node.text()?.trim();
                                let mapped =
                                    map_svn_path_to_working_copy(raw_path, wc_rel_path, wc_url)?;
                                let item = node.attribute("item").unwrap_or("modified");
                                let status = match item {
                                    "added" => "A",
                                    "deleted" => "D",
                                    _ => "M",
                                };
                                Some(CommitFile {
                                    path: mapped,
                                    status: status.into(),
                                    added: None,
                                    removed: None,
                                })
                            })
                            .collect();
                    }
                }
            }

            Ok(CommitDetail {
                commit,
                full_message,
                files,
                branches: CommitBranches {
                    local: refs.clone(),
                    remote: Vec::new(),
                    tags: Vec::new(),
                    is_head: None,
                },
                branches_pending: None,
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

fn parse_combined_diff_files(
    statuses: &str,
    stats: &HashMap<String, (Option<u32>, Option<u32>)>,
) -> Vec<CommitFile> {
    parse_git_name_status_z(statuses)
        .into_iter()
        .map(|(raw_status, path)| {
            let (added, removed) = stats.get(&path).copied().unwrap_or((None, None));
            CommitFile {
                path,
                status: normalize_combined_diff_status(&raw_status),
                added,
                removed,
            }
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
        let metadata = git(
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
        .stdout_text();

        let changed_paths = git(
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
        .stdout_text();

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
        "-z".into(),
        "-M".into(),
        parent_hash.into(),
        revision.into(),
        "--".into(),
    ];
    let status_args = vec![
        "diff".into(),
        "--name-status".into(),
        "-z".into(),
        "-M".into(),
        parent_hash.into(),
        revision.into(),
        "--".into(),
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

pub async fn commit_branches(
    repo: &RepositoryMeta,
    revision: &str,
    token: &CancellationToken,
) -> Result<CommitBranches, DesktopError> {
    if !matches!(repo.kind, VcsKind::Git) {
        return Ok(CommitBranches::default());
    }
    validate_revision(revision)?;
    let (local, remote, tags, head) = tokio::try_join!(
        git(
            vec![
                "branch".into(),
                "--contains".into(),
                revision.into(),
                "--format=%(refname)".into(),
            ],
            repo,
            token,
        ),
        git(
            vec![
                "for-each-ref".into(),
                "--contains".into(),
                revision.into(),
                "--format=%(refname)".into(),
                "refs/remotes".into(),
            ],
            repo,
            token,
        ),
        git(
            vec![
                "tag".into(),
                "--points-at".into(),
                revision.into(),
                "--format=%(refname)".into(),
            ],
            repo,
            token,
        ),
        git(vec!["rev-parse".into(), "HEAD".into()], repo, token),
    )?;
    let local = local.stdout_text();
    let remote = remote.stdout_text();
    let tags = tags.stdout_text();
    let head = head.stdout_text();

    Ok(CommitBranches {
        local: lines(&local)
            .into_iter()
            .filter_map(|value| value.strip_prefix("refs/heads/").map(str::to_string))
            .collect(),
        remote: lines(&remote)
            .into_iter()
            .filter_map(|value| value.strip_prefix("refs/remotes/").map(str::to_string))
            .filter(|value| !value.ends_with("/HEAD"))
            .collect(),
        tags: lines(&tags)
            .into_iter()
            .filter_map(|value| value.strip_prefix("refs/tags/").map(str::to_string))
            .collect(),
        is_head: Some(
            !head.trim().is_empty()
                && (head.trim() == revision
                    || head.trim().starts_with(revision)
                    || revision.starts_with(head.trim())),
        ),
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
    let numbers = parse_numstat_z(stats);
    parse_git_name_status_z(statuses)
        .into_iter()
        .map(|(status, path)| {
            let (added, removed) = numbers.get(&path).copied().unwrap_or((None, None));
            CommitFile {
                path,
                status,
                added,
                removed,
            }
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
        "%(refname:short){FIELD}%(refname){FIELD}%(HEAD){FIELD}%(upstream:short){FIELD}%(upstream:track){FIELD}%(contents:subject){FIELD}%(committerdate:iso-strict){RECORD}"
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
    let mut items: Vec<BranchInfo> = raw
        .split(RECORD)
        .filter_map(|record| {
            let fields = record.trim().split(FIELD).collect::<Vec<_>>();
            if fields.len() < 5 || fields[0].is_empty() || fields[1].ends_with("/HEAD") {
                return None;
            }
            let last_commit_message = fields.get(5).and_then(|s| {
                let trimmed = s.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            });
            let last_commit_date = fields.get(6).and_then(|s| {
                let trimmed = s.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            });
            Some(BranchInfo {
                // Short refs become `heads/name` or `remotes/origin/name` when
                // another namespace contains the same name. The full ref owns
                // branch identity regardless of tag/local/remote collisions.
                name: fields[1]
                    .strip_prefix("refs/heads/")
                    .or_else(|| fields[1].strip_prefix("refs/remotes/"))
                    .unwrap_or(fields[0])
                    .into(),
                current: fields[2] == "*",
                remote: fields[1].starts_with("refs/remotes/"),
                remote_name: remote_name_for_ref(fields[1], &remote_names),
                upstream: (!fields[3].is_empty()).then(|| fields[3].into()),
                ahead: parse_counter(fields[4], "ahead "),
                behind: parse_counter(fields[4], "behind "),
                detached_tag: None,
                detached_hash: None,
                last_commit_message,
                last_commit_date,
            })
        })
        .collect();

    let has_current = items.iter().any(|b| b.current);
    if !has_current {
        let detached_tag = if let Ok(tag_out) = git(
            vec![
                "describe".into(),
                "--tags".into(),
                "--exact-match".into(),
                "HEAD".into(),
            ],
            repo,
            token,
        )
        .await
        {
            let tag = tag_out.stdout_text().trim().to_string();
            if !tag.is_empty() {
                Some(tag)
            } else {
                None
            }
        } else if let Ok(tag_out) = git(
            vec![
                "tag".into(),
                "--points-at".into(),
                "HEAD".into(),
                "--sort=-creatordate".into(),
            ],
            repo,
            token,
        )
        .await
        {
            let tag = tag_out
                .stdout_text()
                .lines()
                .next()
                .map(|line| line.trim().to_string())
                .unwrap_or_default();
            if !tag.is_empty() {
                Some(tag)
            } else {
                None
            }
        } else {
            None
        };

        let detached_hash = if detached_tag.is_none() {
            if let Ok(hash_out) = git(vec!["rev-parse".into(), "HEAD".into()], repo, token).await {
                let full = hash_out.stdout_text().trim().to_string();
                if full.len() >= 8 {
                    Some(full[..8].to_string())
                } else if !full.is_empty() {
                    Some(full)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        items.push(BranchInfo {
            name: "HEAD".into(),
            current: true,
            remote: false,
            remote_name: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            detached_tag,
            detached_hash,
            last_commit_message: None,
            last_commit_date: None,
        });
    }

    Ok(items)
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
    let revision = current_revision(repo, token).await.unwrap_or_default();
    let behind = svn_incoming_revisions_cached(repo, &revision);
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
        last_commit_message: None,
        last_commit_date: None,
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
            last_commit_message: None,
            last_commit_date: None,
        });
    };

    let queries = svn_ref_queries(&repo.id);
    let _query = tokio::select! {
        _ = token.cancelled() => return Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)),
        guard = queries.branches.lock() => guard,
    };
    let cached = SVN_BRANCH_CACHE
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|cache| cache.get(&repo.id).cloned());
    let (has_trunk, branch_names) = if let Some((_, has_trunk, branch_names)) = cached
        .as_ref()
        .filter(|(until, _, _)| *until > Instant::now())
    {
        (*has_trunk, branch_names.clone())
    } else {
        let result: Result<(bool, Vec<String>), DesktopError> = async {
            let (trunk, listed) = tokio::join!(
                svn_optional_directory("^/trunk", repo, token),
                svn_optional_directory("^/branches", repo, token),
            );
            let trunk = trunk?;
            let names = listed?
                .map(|output| parse_svn_list_entries(&output.stdout_text()))
                .transpose()?
                .unwrap_or_default()
                .into_iter()
                .map(|(name, _, _)| name)
                .collect::<Vec<_>>();
            Ok((trunk.is_some(), names))
        }
        .await;
        let (value, lifetime) = match result {
            Ok(value) => (value, Duration::from_secs(300)),
            Err(error) => {
                if token.is_cancelled() || error.code == "REQUEST_CANCELLED" {
                    return Err(error);
                }
                crate::logger::log_entry(
                    crate::logger::LogLevel::Error,
                    crate::logger::LogChannel::Svn,
                    "Failed to query remote branches",
                    Some(format!("{}: {}", error.code, error.message)),
                    None,
                    None,
                );
                (
                    cached
                        .map(|(_, trunk, names)| (trunk, names))
                        .unwrap_or_default(),
                    Duration::from_secs(3),
                )
            }
        };
        if let Ok(mut cache) = SVN_BRANCH_CACHE.get_or_init(Default::default).lock() {
            if queries.valid.load(Ordering::SeqCst) {
                cache.insert(
                    repo.id.clone(),
                    (Instant::now() + lifetime, value.0, value.1.clone()),
                );
            }
        }
        value
    };
    if has_trunk {
        add("trunk".into(), &mut branches);
    }
    for name in branch_names {
        add(name, &mut branches);
    }
    Ok(branches)
}

#[cfg(test)]
pub async fn branch_operation(
    repo: &RepositoryMeta,
    operation: crate::models::BranchOperation,
    token: &CancellationToken,
) -> Result<crate::models::BranchOperationResult, DesktopError> {
    branch_operation_with_protection(
        repo,
        operation,
        &crate::models::DesktopSettings::default().protected_branches,
        token,
    )
    .await
}

pub async fn branch_operation_with_protection(
    repo: &RepositoryMeta,
    operation: BranchOperation,
    patterns: &[String],
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
            BranchOperation::Create { name, from, .. } => {
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
        BranchOperation::Create {
            name,
            from,
            checkout,
        } => {
            validate_ref(&name)?;
            let should_checkout = checkout.unwrap_or(true);
            let mut args = if should_checkout {
                vec!["switch".into(), "-c".into(), name]
            } else {
                vec!["branch".into(), name]
            };
            if let Some(value) = from {
                validate_ref(&value)?;
                args.push(value);
            }
            args
        }
        BranchOperation::Checkout { name } => {
            validate_ref(&name)?;
            let is_local_ref = git(
                vec![
                    "show-ref".into(),
                    "--verify".into(),
                    format!("refs/heads/{name}"),
                ],
                repo,
                token,
            )
            .await
            .is_ok();
            if is_local_ref {
                vec!["switch".into(), name]
            } else {
                let is_remote_ref = git(
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
                if is_remote_ref {
                    let remotes = git(vec!["remote".into()], repo, token)
                        .await
                        .map(|out| {
                            let mut list = out
                                .stdout_text()
                                .lines()
                                .map(str::trim)
                                .filter(|l| !l.is_empty())
                                .map(String::from)
                                .collect::<Vec<_>>();
                            list.sort_by_key(|r| std::cmp::Reverse(r.len()));
                            list
                        })
                        .unwrap_or_default();
                    let local_name = remotes
                        .iter()
                        .find_map(|r| name.strip_prefix(&format!("{r}/")))
                        .or_else(|| name.split_once('/').map(|(_, rest)| rest))
                        .unwrap_or(&name);
                    let local_exists = git(
                        vec![
                            "show-ref".into(),
                            "--verify".into(),
                            format!("refs/heads/{local_name}"),
                        ],
                        repo,
                        token,
                    )
                    .await
                    .is_ok();
                    if local_exists {
                        vec!["switch".into(), local_name.to_string()]
                    } else {
                        vec![
                            "switch".into(),
                            "--track".into(),
                            format!("refs/remotes/{name}"),
                        ]
                    }
                } else {
                    vec!["switch".into(), name]
                }
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
            if crate::protection::matches_branch(&name, patterns) {
                return Err(DesktopError::new(
                    "PROTECTED_BRANCH_DELETE",
                    format!("Cannot delete protected branch '{name}'"),
                    true,
                ));
            }
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
        let queries = svn_ref_queries(&repo.id);
        let _query = tokio::select! {
            _ = token.cancelled() => return Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)),
            guard = queries.tags.lock() => guard,
        };
        let cached = SVN_TAG_CACHE
            .get_or_init(Default::default)
            .lock()
            .ok()
            .and_then(|cache| cache.get(&repo.id).cloned());
        if let Some((_, tags)) = cached.as_ref().filter(|(until, _)| *until > Instant::now()) {
            return Ok(tags.clone());
        }
        let result: Result<Vec<TagInfo>, DesktopError> = async {
            let raw = svn_optional_directory("^/tags", repo, token)
                .await?
                .map(|value| value.stdout_text())
                .unwrap_or_default();
            Ok(parse_svn_list_entries(&raw)?
                .into_iter()
                .map(|(name, revision, date)| TagInfo {
                    hash: revision
                        .map(|value| format!("r{value}"))
                        .unwrap_or_else(|| name.clone()),
                    name,
                    date,
                })
                .collect::<Vec<_>>())
        }
        .await;
        let (tags, lifetime) = match result {
            Ok(tags) => (tags, Duration::from_secs(300)),
            Err(error) => {
                if token.is_cancelled() || error.code == "REQUEST_CANCELLED" {
                    return Err(error);
                }
                crate::logger::log_entry(
                    crate::logger::LogLevel::Error,
                    crate::logger::LogChannel::Svn,
                    "Failed to query remote tags",
                    Some(format!("{}: {}", error.code, error.message)),
                    None,
                    None,
                );
                (
                    cached.map(|(_, tags)| tags).unwrap_or_default(),
                    Duration::from_secs(3),
                )
            }
        };
        if let Ok(mut cache) = SVN_TAG_CACHE.get_or_init(Default::default).lock() {
            if queries.valid.load(Ordering::SeqCst) {
                cache.insert(repo.id.clone(), (Instant::now() + lifetime, tags.clone()));
            }
        }
        return Ok(tags);
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
        .filter(|node| node.has_tag_name("entry") && node.attribute("kind") == Some("dir"))
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

async fn fetch_svn_incoming_revisions(
    repo: &RepositoryMeta,
    revision: u64,
    token: &CancellationToken,
) -> Result<u32, DesktopError> {
    #[cfg(test)]
    let mock_result = if let Ok(lock) = SVN_INCOMING_MOCK_HANDLERS
        .get_or_init(Default::default)
        .lock()
    {
        lock.get(&repo.id).and_then(|handler| handler(revision))
    } else {
        None
    };
    #[cfg(test)]
    if let Some((delay, res)) = mock_result {
        if delay > Duration::ZERO {
            tokio::select! {
                _ = tokio::time::sleep(delay) => {},
                _ = token.cancelled() => {
                    return Err(DesktopError::new("PROBE_CANCELLED", "Probe cancelled", false));
                }
            }
        }
        if token.is_cancelled() {
            return Err(DesktopError::new(
                "PROBE_CANCELLED",
                "Probe cancelled",
                false,
            ));
        }
        return res;
    }

    // A mixed-revision working copy cannot be compared to its highest revision:
    // some files may still need updates. Start with the actual outdated paths.
    let output = svn_with_timeout(
        vec!["status".into(), "-u".into(), "--xml".into()],
        repo,
        token,
        Duration::from_secs(20),
    )
    .await?;
    let raw = output.stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let outdated = document
        .descendants()
        .filter(|node| node.has_tag_name("entry"))
        .filter_map(|entry| {
            let remote = entry
                .children()
                .find(|node| node.has_tag_name("repos-status"))?;
            let unchanged = |attribute| {
                matches!(
                    remote.attribute(attribute).unwrap_or("none"),
                    "none" | "normal"
                )
            };
            if unchanged("item") && unchanged("props") {
                return None;
            }
            let path =
                svn_status_relative_path(Path::new(&repo.root_path), entry.attribute("path")?)?;
            if path.is_empty()
                || Path::new(&path)
                    .components()
                    .any(|component| component == std::path::Component::ParentDir)
            {
                return None;
            }
            let base = entry
                .children()
                .find(|node| node.has_tag_name("wc-status"))
                .and_then(|node| node.attribute("revision"))
                .and_then(|value| value.parse::<u64>().ok());
            Some((path.trim_start_matches("./").to_string(), base))
        })
        .collect::<Vec<_>>();
    if outdated.is_empty() {
        return Ok(0);
    }
    let count = async {
        let info = svn(vec!["info".into(), "--xml".into()], repo, token)
            .await?
            .stdout_text();
        let info = roxmltree::Document::parse(&info)
            .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
        let root_revision = info
            .descendants()
            .find(|node| node.has_tag_name("entry"))
            .and_then(|node| node.attribute("revision"))
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(revision);
        let prefix = info
            .descendants()
            .find(|node| node.has_tag_name("relative-url"))
            .and_then(|node| node.text())
            .unwrap_or("^/");
        let prefix = decode_svn_path(prefix.trim_start_matches('^').trim_matches('/'));
        let base = outdated
            .iter()
            .map(|(_, base)| base.unwrap_or(root_revision))
            .min()
            .unwrap_or(root_revision);
        let Some(start) = base.checked_add(1) else {
            return Ok::<u32, DesktopError>(1);
        };
        let log = svn_with_timeout(
            vec![
                "log".into(),
                "--xml".into(),
                "-v".into(),
                "-r".into(),
                format!("{start}:HEAD"),
            ],
            repo,
            token,
            Duration::from_secs(20),
        )
        .await?
        .stdout_text();
        let log = roxmltree::Document::parse(&log)
            .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
        let mut revisions = HashSet::new();
        for entry in log
            .descendants()
            .filter(|node| node.has_tag_name("logentry"))
        {
            let Some(revision) = entry
                .attribute("revision")
                .and_then(|value| value.parse::<u64>().ok())
            else {
                continue;
            };
            let changed = entry
                .descendants()
                .filter(|node| node.has_tag_name("path"))
                .filter_map(|node| {
                    let path = node.text()?.trim_start_matches('/');
                    if prefix.is_empty() {
                        Some(path)
                    } else if path == prefix {
                        Some(".")
                    } else {
                        path.strip_prefix(&prefix)
                            .and_then(|suffix| suffix.strip_prefix('/'))
                    }
                })
                .collect::<Vec<_>>();
            if outdated.iter().any(|(path, path_base)| {
                revision > path_base.unwrap_or(base)
                    && changed.iter().any(|changed| {
                        *changed == "."
                            || path == "."
                            || path == changed
                            || path.starts_with(&format!("{changed}/"))
                            || changed.starts_with(&format!("{path}/"))
                    })
            }) {
                revisions.insert(revision);
            }
        }
        Ok(revisions.len().max(1).min(u32::MAX as usize) as u32)
    }
    .await;
    // The plugin still reports an update when status proves files are outdated,
    // even if verbose history is unavailable. Cancellation must remain cancellable.
    match count {
        Err(error) if token.is_cancelled() || error.code == "REQUEST_CANCELLED" => Err(error),
        Err(_) => Ok(1),
        result => result,
    }
}

pub fn svn_incoming_cached_behind(repo_id: &str, revision_str: &str) -> Option<u32> {
    let Ok(revision) = revision_str.trim().parse::<u64>() else {
        return None;
    };
    let cached = SVN_INCOMING_CACHE
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|cache| cache.get(repo_id).cloned());
    match cached {
        Some((_, cached_revision, cached_behind)) if cached_revision == revision => {
            Some(cached_behind)
        }
        _ => None,
    }
}

#[cfg(test)]
pub fn set_svn_incoming_cached_for_test(repo_id: &str, revision: u64, behind: u32) {
    if let Ok(mut cache) = SVN_INCOMING_CACHE.get_or_init(Default::default).lock() {
        cache.insert(repo_id.to_string(), (Instant::now(), revision, behind));
    }
}

#[cfg(test)]
type SvnIncomingMockHandler =
    Box<dyn Fn(u64) -> Option<(Duration, Result<u32, DesktopError>)> + Send + Sync>;
#[cfg(test)]
static SVN_INCOMING_MOCK_HANDLERS: OnceLock<Mutex<HashMap<String, SvnIncomingMockHandler>>> =
    OnceLock::new();

#[cfg(test)]
pub fn set_svn_incoming_mock_handler_for_test(
    repo_id: &str,
    handler: Option<SvnIncomingMockHandler>,
) {
    if let Ok(mut lock) = SVN_INCOMING_MOCK_HANDLERS
        .get_or_init(Default::default)
        .lock()
    {
        if let Some(h) = handler {
            lock.insert(repo_id.to_string(), h);
        } else {
            lock.remove(repo_id);
        }
    }
}

#[cfg(test)]
pub fn get_svn_incoming_probing_state_for_test(repo_id: &str) -> Option<(u64, Option<u64>)> {
    SVN_INCOMING_PROBING
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|map| {
            map.get(repo_id)
                .map(|s| (s.active_revision, s.pending.as_ref().map(|(_, rev)| *rev)))
        })
}

async fn notify_repo_status_changed(repo_id: &str) {
    if let Some(app) = crate::logger::global_app_handle() {
        use tauri::{Emitter, Manager};
        let state = app.state::<crate::state::AppState>();
        let workspace_ids = state.workspaces_for_repository(repo_id).await;
        if workspace_ids.is_empty() {
            state.record_pending_repo_status_changed(repo_id);
            return;
        }
        let generation = state.next_generation();
        for workspace_id in workspace_ids {
            let _ = app.emit(
                "versiondock://event",
                crate::models::RepositoryEvent {
                    workspace_id,
                    repo_id: Some(repo_id.to_string()),
                    generation,
                    source: crate::models::RepositoryEventSource::Watcher,
                    scopes: vec![crate::models::RefreshScope::Status],
                },
            );
        }
    }
}

#[cfg(test)]
static SVN_WC_REVISION_MOCK: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

#[cfg(test)]
pub fn set_svn_wc_revision_for_test(repo_id: &str, revision: Option<u64>) {
    if let Ok(mut map) = SVN_WC_REVISION_MOCK.get_or_init(Default::default).lock() {
        if let Some(rev) = revision {
            map.insert(repo_id.to_string(), rev);
        } else {
            map.remove(repo_id);
        }
    }
}

async fn svn_wc_revision(repo: &RepositoryMeta, token: &CancellationToken) -> Option<u64> {
    #[cfg(test)]
    if let Ok(map) = SVN_WC_REVISION_MOCK.get_or_init(Default::default).lock() {
        if let Some(&rev) = map.get(&repo.id) {
            return Some(rev);
        }
    }

    let output = svn_with_timeout(
        vec!["info".into(), "--show-item".into(), "revision".into()],
        repo,
        token,
        Duration::from_secs(5),
    )
    .await
    .ok()?;
    svn_effective_revision(repo, output.stdout_text().trim(), token)
        .await
        .parse::<u64>()
        .ok()
}

fn spawn_svn_incoming_probe(repo: RepositoryMeta, revision: u64, previous_behind: Option<u32>) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let repo_id = repo.id.clone();
    let probing = SVN_INCOMING_PROBING.get_or_init(Default::default);
    let cancel_token = CancellationToken::new();
    let (task_id, task_generation) = {
        let Ok(mut map) = probing.lock() else { return };
        if let Some(state) = map.get_mut(&repo_id) {
            if state.active_revision != revision {
                state.pending = Some((repo, revision));
            }
            return;
        }
        let task_id = SVN_PROBE_TASK_SEQ.fetch_add(1, Ordering::Relaxed);
        let task_generation = {
            let Ok(mut gens) = SVN_INCOMING_GENERATION.get_or_init(Default::default).lock() else {
                return;
            };
            *gens.entry(repo_id.clone()).or_insert(0)
        };
        map.insert(
            repo_id.clone(),
            SvnProbeState {
                task_id,
                active_revision: revision,
                pending: None,
                token: cancel_token.clone(),
            },
        );
        (task_id, task_generation)
    };

    let task_token = cancel_token.clone();
    tokio::spawn(async move {
        struct ProbeGuard {
            repo_id: String,
            task_id: u64,
        }
        impl Drop for ProbeGuard {
            fn drop(&mut self) {
                if let Ok(mut map) = SVN_INCOMING_PROBING.get_or_init(Default::default).lock() {
                    if let Some(state) = map.get(&self.repo_id) {
                        if state.task_id == self.task_id {
                            map.remove(&self.repo_id);
                        }
                    }
                }
            }
        }
        let _guard = ProbeGuard {
            repo_id: repo_id.clone(),
            task_id,
        };

        let mut current_repo = repo;
        let mut current_revision = revision;
        let mut current_prev_behind = previous_behind;

        loop {
            if task_token.is_cancelled() {
                break;
            }
            let is_gen_valid = {
                if let Ok(gens) = SVN_INCOMING_GENERATION.get_or_init(Default::default).lock() {
                    gens.get(&current_repo.id).copied().unwrap_or(0) == task_generation
                } else {
                    false
                }
            };
            if !is_gen_valid {
                break;
            }

            let result =
                fetch_svn_incoming_revisions(&current_repo, current_revision, &task_token).await;

            if task_token.is_cancelled() {
                break;
            }

            let probing = SVN_INCOMING_PROBING.get_or_init(Default::default);
            let pending_opt = {
                let Ok(mut map) = probing.lock() else { break };
                if let Some(state) = map.get_mut(&current_repo.id) {
                    if state.task_id == task_id {
                        state.pending.take()
                    } else {
                        None
                    }
                } else {
                    None
                }
            };

            let is_still_active = {
                let Ok(map) = probing.lock() else { break };
                map.get(&current_repo.id)
                    .map(|s| s.task_id == task_id)
                    .unwrap_or(false)
            };
            if !is_still_active {
                break;
            }

            if let Some((pending_repo, pending_rev)) = pending_opt {
                // 探测运行期间检测到曾有异版本请求到达！
                let real_rev = svn_wc_revision(&current_repo, &task_token)
                    .await
                    .unwrap_or(pending_rev);

                if real_rev != current_revision {
                    {
                        if let Ok(mut map) = probing.lock() {
                            if let Some(state) = map.get_mut(&current_repo.id) {
                                if state.task_id == task_id {
                                    state.active_revision = real_rev;
                                }
                            }
                        }
                    }
                    current_repo = pending_repo;
                    current_revision = real_rev;
                    current_prev_behind = None;
                    continue;
                }
            }

            // 没有后续新任务（或确认当前版本为真实最终状态），从 map 中移除活跃标记
            {
                if let Ok(mut map) = probing.lock() {
                    if let Some(state) = map.get(&current_repo.id) {
                        if state.task_id == task_id {
                            map.remove(&current_repo.id);
                        }
                    }
                }
            }

            // 原子核对代次与有效性，并写回缓存
            let mut should_notify = false;
            {
                let Ok(mut cache) = SVN_INCOMING_CACHE.get_or_init(Default::default).lock() else {
                    break;
                };
                let current_gen = if let Ok(gens) =
                    SVN_INCOMING_GENERATION.get_or_init(Default::default).lock()
                {
                    gens.get(&current_repo.id).copied().unwrap_or(0)
                } else {
                    break;
                };
                if current_gen != task_generation || task_token.is_cancelled() {
                    // 关键保护：代次不匹配或任务已取消，说明在写回前发生过缓存失效（如分支切换），绝对禁止写回！
                    break;
                }

                match result {
                    Ok(fresh_behind) => {
                        cache.insert(
                            current_repo.id.clone(),
                            (Instant::now(), current_revision, fresh_behind),
                        );
                        let changed = match current_prev_behind {
                            Some(prev) => prev != fresh_behind,
                            None => fresh_behind > 0,
                        };
                        if changed {
                            should_notify = true;
                        }
                    }
                    Err(_) => {
                        if let Some(prev) = current_prev_behind {
                            cache.insert(
                                current_repo.id.clone(),
                                (Instant::now(), current_revision, prev),
                            );
                        } else if let Some((_, cached_rev, _)) = cache.get(&current_repo.id) {
                            if *cached_rev != current_revision {
                                cache.remove(&current_repo.id);
                            }
                        }
                    }
                }
            }

            if should_notify {
                notify_repo_status_changed(&current_repo.id).await;
            }

            break;
        }
    });
}

pub(crate) fn svn_incoming_revisions_cached(repo: &RepositoryMeta, revision_str: &str) -> u32 {
    let Ok(revision) = revision_str.trim().parse::<u64>() else {
        return 0;
    };
    let cached = SVN_INCOMING_CACHE
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|cache| cache.get(&repo.id).cloned());

    match cached {
        Some((checked_at, cached_revision, cached_behind)) => {
            if cached_revision == revision && checked_at.elapsed() < Duration::from_secs(60) {
                cached_behind
            } else {
                let previous_behind = if cached_revision == revision {
                    Some(cached_behind)
                } else {
                    None
                };
                spawn_svn_incoming_probe(repo.clone(), revision, previous_behind);
                if cached_revision == revision {
                    cached_behind
                } else {
                    0
                }
            }
        }
        None => {
            spawn_svn_incoming_probe(repo.clone(), revision, None);
            0
        }
    }
}

#[allow(dead_code)]
pub(crate) async fn svn_incoming_revisions(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> u32 {
    let revision = svn(
        vec!["info".into(), "--show-item".into(), "revision".into()],
        repo,
        token,
    )
    .await
    .ok()
    .and_then(|value| value.stdout_text().trim().parse::<u64>().ok());
    let Some(revision) = revision else { return 0 };
    let cached = SVN_INCOMING_CACHE
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|cache| cache.get(&repo.id).cloned())
        .filter(|(_, cached_revision, _)| *cached_revision == revision);
    if let Some((checked_at, _, behind)) = cached {
        if checked_at.elapsed() < Duration::from_secs(60) {
            return behind;
        }
    }
    let behind = match fetch_svn_incoming_revisions(repo, revision, token).await {
        Ok(count) => count,
        Err(_) => cached.map(|(_, _, behind)| behind).unwrap_or(0),
    };
    if let Ok(mut cache) = SVN_INCOMING_CACHE.get_or_init(Default::default).lock() {
        cache.insert(repo.id.clone(), (Instant::now(), revision, behind));
    }
    behind
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
            TagOperation::Delete { name, .. } => {
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
        TagOperation::Delete { name, remote } => {
            validate_ref(&name)?;
            if let Some(remote_name) = remote {
                validate_ref(&remote_name)?;
                vec![
                    "push".into(),
                    remote_name,
                    "--delete".into(),
                    format!("refs/tags/{name}"),
                ]
            } else {
                vec!["tag".into(), "-d".into(), name]
            }
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

        let cached_files = STASH_FILES_CACHE
            .get_or_init(Default::default)
            .lock()
            .ok()
            .and_then(|cache| cache.get(&hash).cloned());
        if let Some(files) = cached_files {
            entries.push(StashEntry {
                reference,
                hash,
                branch,
                message,
                full_message,
                date,
                files,
            });
            continue;
        }
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

        if let Ok(mut cache) = STASH_FILES_CACHE.get_or_init(Default::default).lock() {
            cache.insert(hash.clone(), files.clone());
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
        StashOperation::Apply {
            reference,
            expected_hash,
        } => {
            validate_stash_ref(&reference)?;
            if let Some(expected) = expected_hash {
                verify_stash_hash(repo, &reference, &expected, token).await?;
            }
            git(vec!["stash".into(), "apply".into(), reference], repo, token).await?;
        }
        StashOperation::Pop {
            reference,
            expected_hash,
        } => {
            validate_stash_ref(&reference)?;
            if let Some(expected) = expected_hash {
                verify_stash_hash(repo, &reference, &expected, token).await?;
            }
            git(vec!["stash".into(), "pop".into(), reference], repo, token).await?;
        }
        StashOperation::Drop {
            reference,
            expected_hash,
        } => {
            validate_stash_ref(&reference)?;
            if let Some(expected) = expected_hash {
                verify_stash_hash(repo, &reference, &expected, token).await?;
            }
            git(vec!["stash".into(), "drop".into(), reference], repo, token).await?;
        }
    }
    Ok(())
}

async fn verify_stash_hash(
    repo: &RepositoryMeta,
    reference: &str,
    expected_hash: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let output = match git(vec!["rev-parse".into(), reference.to_string()], repo, token).await {
        Ok(out) => out,
        Err(_) => {
            return Err(DesktopError::new(
                "STASH_REFERENCE_MOVED",
                "Stash entry not found or reference has moved",
                false,
            ));
        }
    };
    let actual_hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let expected = expected_hash.trim();
    if !actual_hash.eq_ignore_ascii_case(expected) && !actual_hash.starts_with(expected) {
        return Err(DesktopError::new(
            "STASH_REFERENCE_MOVED",
            format!(
                "Stash entry reference '{reference}' has moved concurrently (expected {expected}, found {actual_hash})"
            ),
            false,
        ));
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

pub async fn subtree_statuses(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<SubtreePushStatus>, DesktopError> {
    ensure_git(repo)?;
    let entries = subtrees(repo, token).await?;
    let mut statuses = Vec::with_capacity(entries.len());
    for entry in entries {
        let cache_key = format!(
            "{}\0{}\0{}\0{}\0{}\0{:?}",
            repo.id, entry.id, entry.prefix, entry.remote, entry.branch, entry.state
        );
        let cached = subtree_status_cache()
            .lock()
            .ok()
            .and_then(|cache| cache.get(&cache_key).cloned())
            .filter(|(checked_at, _)| checked_at.elapsed() < Duration::from_secs(60))
            .map(|(_, status)| status);
        if let Some(status) = cached {
            statuses.push(status);
            continue;
        }
        let status = subtree_status(repo, &entry, token).await;
        if let Ok(mut cache) = subtree_status_cache().lock() {
            cache.insert(cache_key, (Instant::now(), status.clone()));
        }
        statuses.push(status);
    }
    Ok(statuses)
}

async fn subtree_split_hash(
    repo: &RepositoryMeta,
    prefix: &str,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let last_commit = git(
        vec![
            "log".into(),
            "-1".into(),
            "--format=%H".into(),
            "HEAD".into(),
            "--".into(),
            format!(":(literal){prefix}"),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text()
    .trim()
    .to_string();
    let cache_key = format!("{}\0{prefix}", repo.id);
    if !last_commit.is_empty() {
        if let Some((_, split_hash)) = subtree_split_cache()
            .lock()
            .ok()
            .and_then(|cache| cache.get(&cache_key).cloned())
            .filter(|(cached_commit, _)| cached_commit == &last_commit)
        {
            return Ok(split_hash);
        }
    }
    let split_hash = git(
        vec![
            "subtree".into(),
            "split".into(),
            format!("--prefix={prefix}"),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text()
    .lines()
    .rev()
    .map(str::trim)
    .find(|line| line.len() >= 40 && line.chars().all(|character| character.is_ascii_hexdigit()))
    .map(str::to_string)
    .ok_or_else(|| {
        DesktopError::new(
            "SUBTREE_SPLIT_HASH_MISSING",
            "Cannot determine subtree split commit",
            true,
        )
    })?;
    if !last_commit.is_empty() {
        if let Ok(mut cache) = subtree_split_cache().lock() {
            cache.insert(cache_key, (last_commit, split_hash.clone()));
        }
    }
    Ok(split_hash)
}

async fn subtree_status(
    repo: &RepositoryMeta,
    entry: &SubtreeEntry,
    token: &CancellationToken,
) -> SubtreePushStatus {
    if entry.state != SubtreeState::Active {
        return SubtreePushStatus {
            subtree_id: entry.id.clone(),
            ahead_count: None,
            has_updates: false,
            remote_ref: None,
            split_hash: None,
            remote_hash: None,
            error: Some("Subtree registration is pending recovery".into()),
        };
    }
    let split_hash = match subtree_split_hash(repo, &entry.prefix, token).await {
        Ok(value) => Some(value),
        Err(error) => {
            return SubtreePushStatus {
                subtree_id: entry.id.clone(),
                ahead_count: None,
                has_updates: false,
                remote_ref: None,
                split_hash: None,
                remote_hash: None,
                error: Some(error.message),
            };
        }
    };
    let remote_ref = if entry.branch.starts_with("refs/") {
        entry.branch.clone()
    } else {
        format!("refs/heads/{}", entry.branch)
    };
    let remote = git_network_quick(
        vec!["ls-remote".into(), entry.remote.clone(), remote_ref.clone()],
        repo,
        token,
    )
    .await;
    let (remote_hash, remote_error) = match remote {
        Ok(output) => (
            output
                .stdout_text()
                .split_whitespace()
                .next()
                .map(str::to_string),
            None,
        ),
        Err(error) => (None, Some(error.message)),
    };
    let ahead_count = match (&remote_hash, &split_hash) {
        (Some(remote_hash), Some(split_hash)) => git(
            vec![
                "rev-list".into(),
                "--count".into(),
                format!("{remote_hash}..{split_hash}"),
            ],
            repo,
            token,
        )
        .await
        .ok()
        .and_then(|output| output.stdout_text().trim().parse().ok()),
        _ => None,
    };
    SubtreePushStatus {
        subtree_id: entry.id.clone(),
        ahead_count,
        has_updates: match (&remote_hash, &split_hash) {
            (Some(remote_hash), Some(split_hash)) => remote_hash != split_hash,
            (None, Some(_)) if remote_error.is_none() => true,
            _ => false,
        },
        remote_ref: Some(remote_ref),
        split_hash,
        remote_hash,
        error: remote_error,
    }
}

pub async fn submodules(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<SubmoduleEntry>, DesktopError> {
    ensure_git(repo)?;
    let modules_file = Path::new(&repo.root_path).join(".gitmodules");
    let raw = if modules_file.is_file() {
        git(
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
        .stdout_text()
    } else {
        String::new()
    };
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
    let unmerged = git(
        vec!["ls-files".into(), "-u".into(), "-z".into()],
        repo,
        token,
    )
    .await
    .map(|output| output.stdout_text())
    .unwrap_or_default();
    for entry in unmerged.split('\0').filter(|entry| !entry.is_empty()) {
        let Some((metadata, path)) = entry.split_once('\t') else {
            continue;
        };
        if !metadata.starts_with("160000 ") || path.is_empty() {
            continue;
        }
        records.entry(path.to_string()).or_insert_with(|| Record {
            path: Some(path.to_string()),
            url: Some(String::new()),
            branch: None,
        });
    }
    let mut entries = Vec::new();
    for (name, record) in records {
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
        .await
        .map(|output| output.stdout_text())
        .unwrap_or_default();
        let marker = status.chars().next().unwrap_or('-');
        let revision = status
            .get(1..)
            .and_then(|value| value.split_whitespace().next())
            .filter(|value| value.len() >= 7)
            .map(str::to_string);
        let initialized = marker != '-';
        let current_branch = if initialized {
            git(
                vec![
                    "-C".into(),
                    path.clone(),
                    "symbolic-ref".into(),
                    "--quiet".into(),
                    "--short".into(),
                    "HEAD".into(),
                ],
                repo,
                token,
            )
            .await
            .ok()
            .map(|output| output.stdout_text().trim().to_string())
            .filter(|value| !value.is_empty())
        } else {
            None
        };
        let recorded_commit = git(
            vec!["rev-parse".into(), format!("HEAD:{path}")],
            repo,
            token,
        )
        .await
        .ok()
        .map(|output| output.stdout_text().trim().to_string())
        .filter(|value| !value.is_empty());
        let (index_commit, conflict_stages, type_change, companion_path) =
            submodule_index_state(repo, &path, token).await;
        let unpushed_count = if initialized {
            match git_unpushed_count_at(repo, &path, token).await {
                Err(error) if token.is_cancelled() || error.code == "REQUEST_CANCELLED" => {
                    return Err(error)
                }
                result => result.unwrap_or(0),
            }
        } else {
            0
        };
        let working_dirty = initialized
            && git(
                vec![
                    "-C".into(),
                    path.clone(),
                    "status".into(),
                    "--porcelain".into(),
                ],
                repo,
                token,
            )
            .await
            .ok()
            .is_some_and(|output| !output.stdout_text().trim().is_empty());
        let sync_status = if marker == 'U' || conflict_stages.is_some() || type_change {
            SubmoduleSyncStatus::Conflict
        } else if !initialized {
            SubmoduleSyncStatus::Uninitialized
        } else if marker == '+'
            || matches!((&recorded_commit, &revision), (Some(recorded), Some(head)) if recorded != head)
        {
            SubmoduleSyncStatus::OutOfSync
        } else {
            SubmoduleSyncStatus::Synced
        };
        let diff_summary = submodule_diff_summary(repo, &path, token).await;
        entries.push(SubmoduleEntry {
            name,
            initialized: marker != '-',
            dirty: matches!(marker, '+' | 'U') || working_dirty,
            path,
            url: redact_url(&url),
            revision,
            branch: record.branch,
            sync_status,
            recorded_commit,
            index_commit,
            conflict_stages,
            detached: current_branch.is_none(),
            current_branch,
            unpushed_count,
            type_change,
            companion_path,
            diff_summary,
        });
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

async fn submodule_index_state(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> (
    Option<String>,
    Option<SubmoduleConflictStages>,
    bool,
    Option<String>,
) {
    let pathspec = format!(":(literal){path}");
    let raw = git(
        vec![
            "ls-files".into(),
            "--stage".into(),
            "-z".into(),
            "--".into(),
            pathspec,
        ],
        repo,
        token,
    )
    .await
    .map(|output| output.stdout_text())
    .unwrap_or_default();
    let mut index_commit = None;
    let mut stages = SubmoduleConflictStages::default();
    let mut has_conflict = false;
    let mut type_change = false;
    for entry in raw.split('\0').filter(|entry| !entry.is_empty()) {
        let Some((metadata, entry_path)) = entry.split_once('\t') else {
            continue;
        };
        let fields = metadata.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 3 || entry_path != path {
            continue;
        }
        let mode = fields[0];
        let hash = fields[1].to_string();
        match fields[2] {
            "0" if mode == "160000" => index_commit = Some(hash),
            "1" => {
                has_conflict = true;
                type_change |= mode != "160000";
                stages.base = Some(hash);
            }
            "2" => {
                has_conflict = true;
                type_change |= mode != "160000";
                stages.ours = Some(hash);
            }
            "3" => {
                has_conflict = true;
                type_change |= mode != "160000";
                stages.theirs = Some(hash);
            }
            _ => {}
        }
    }
    let unmerged = git(
        vec!["ls-files".into(), "-u".into(), "-z".into()],
        repo,
        token,
    )
    .await
    .map(|output| output.stdout_text())
    .unwrap_or_default();
    let companion_path = unmerged.split('\0').find_map(|entry| {
        let (_, entry_path) = entry.split_once('\t')?;
        entry_path
            .starts_with(&format!("{path}~"))
            .then(|| entry_path.to_string())
    });
    if companion_path.is_some() {
        type_change = true;
        has_conflict = true;
    }
    (
        index_commit,
        has_conflict.then_some(stages),
        type_change,
        companion_path,
    )
}

async fn submodule_diff_summary(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Option<String> {
    git(
        vec![
            "diff".into(),
            "--submodule=log".into(),
            "HEAD".into(),
            "--".into(),
            format!(":(literal){path}"),
        ],
        repo,
        token,
    )
    .await
    .ok()
    .map(|output| output.stdout_text().trim().to_string())
    .filter(|value| !value.is_empty())
}

pub(crate) async fn resolve_submodule_conflict_gitlink(
    repo: &RepositoryMeta,
    path: &str,
    choice: ConflictChoice,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if !matches!(choice, ConflictChoice::Working) {
        let (_, stages, _, _) = submodule_index_state(repo, path, token).await;
        let selected = stages.and_then(|stages| match choice {
            ConflictChoice::Mine => stages.ours,
            ConflictChoice::Theirs => stages.theirs,
            ConflictChoice::Working => None,
        });
        if let Some(hash) = selected {
            git(
                vec![
                    "update-index".into(),
                    "--add".into(),
                    "--cacheinfo".into(),
                    format!("160000,{hash},{path}"),
                ],
                repo,
                token,
            )
            .await?;
        } else {
            git(
                vec![
                    "rm".into(),
                    "--cached".into(),
                    "--ignore-unmatch".into(),
                    "--".into(),
                    path.to_string(),
                ],
                repo,
                token,
            )
            .await?;
        }
        return Ok(());
    }
    stage(repo, &[path.to_string()], false, token).await
}

pub(crate) async fn check_submodule_type_change_conflict(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Result<Option<String>, DesktopError> {
    let base_path = path.split_once('~').map(|(p, _)| p).unwrap_or(path);
    let companion_prefix = format!("{base_path}~");

    let raw = git(
        vec!["ls-files".into(), "-u".into(), "-z".into()],
        repo,
        token,
    )
    .await?
    .stdout_text();

    let mut has_submodule_stage = false;
    let mut has_non_submodule_stage = false;
    let mut detected_companion = None;

    for entry in raw.split('\0').filter(|e| !e.is_empty()) {
        let Some((meta, entry_path)) = entry.split_once('\t') else {
            continue;
        };
        let mode = meta.split_whitespace().next().unwrap_or("");
        if entry_path == base_path {
            if mode == "160000" {
                has_submodule_stage = true;
            } else {
                has_non_submodule_stage = true;
            }
        } else if entry_path.starts_with(&companion_prefix) {
            detected_companion = Some(entry_path.to_string());
        }
    }

    if (path.contains('~') || detected_companion.is_some() || has_non_submodule_stage)
        && has_submodule_stage
    {
        return Ok(detected_companion.or_else(|| Some(path.to_string())));
    }

    Ok(None)
}

pub async fn submodule_operation(
    repo: &RepositoryMeta,
    operation: SubmoduleOperation,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    let align_path = match &operation {
        SubmoduleOperation::Update {
            path,
            remote: false,
            ..
        } => Some(Some(relative_path(
            Path::new(&repo.root_path),
            path,
            false,
        )?)),
        SubmoduleOperation::UpdateAll { remote: false, .. } => Some(None),
        _ => None,
    };
    if let Some(target_path) = align_path {
        let entries = submodules(repo, token).await?;
        for entry in entries
            .iter()
            .filter(|entry| target_path.as_ref().is_none_or(|path| path == &entry.path))
        {
            // Update aligns to the pointer committed in the parent, even when a
            // different gitlink has already been staged. Leave conflicts intact.
            if entry.sync_status != SubmoduleSyncStatus::Conflict
                && matches!((&entry.index_commit, &entry.recorded_commit), (Some(index), Some(recorded)) if index != recorded)
            {
                git(
                    vec![
                        "checkout".into(),
                        "HEAD".into(),
                        "--".into(),
                        literal_path(Path::new(&repo.root_path), &entry.path, false)?,
                    ],
                    repo,
                    token,
                )
                .await?;
            }
        }
    }
    let mut permit_file_protocol = true;
    let (path, mut args, network, requires_existing) = match operation {
        SubmoduleOperation::Add {
            url,
            path,
            branch,
            allow_file_protocol,
        } => {
            validate_remote_url(&url)?;
            if !allow_file_protocol
                && (url.starts_with("file://")
                    || url.starts_with('/')
                    || url.starts_with("./")
                    || url.starts_with("../"))
            {
                return Err(DesktopError::new(
                    "SUBMODULE_FILE_PROTOCOL_BLOCKED",
                    "Local-path submodules require an explicit file-protocol confirmation",
                    true,
                ));
            }
            let path = relative_path(Path::new(&repo.root_path), &path, false)?;
            permit_file_protocol = allow_file_protocol;
            let mut args = Vec::new();
            if allow_file_protocol {
                args.extend(["-c".into(), "protocol.file.allow=always".into()]);
            }
            args.extend(["submodule".into(), "add".into()]);
            if let Some(branch) = branch.filter(|value| !value.trim().is_empty()) {
                validate_ref(&branch)?;
                args.extend(["--branch".into(), branch]);
            }
            args.extend(["--".into(), url, path.clone()]);
            (path, args, true, false)
        }
        SubmoduleOperation::Init { path, recursive } => {
            let mut args = vec!["submodule".into(), "update".into(), "--init".into()];
            if recursive {
                args.push("--recursive".into());
            }
            (path, args, true, true)
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
            (path, args, true, true)
        }
        SubmoduleOperation::Deinit { path, force } => {
            let mut args = vec!["submodule".into(), "deinit".into()];
            if force {
                args.push("--force".into());
            }
            (path, args, false, true)
        }
        SubmoduleOperation::Sync { path, recursive } => {
            let mut args = vec!["submodule".into(), "sync".into()];
            if recursive {
                args.push("--recursive".into());
            }
            (path, args, false, true)
        }
        SubmoduleOperation::UpdateAll {
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
            (String::new(), args, true, false)
        }
        SubmoduleOperation::Remove { path, force } => {
            let path = relative_path(Path::new(&repo.root_path), &path, false)?;
            if !force {
                let dirty_worktree = git(
                    vec![
                        "-C".into(),
                        path.clone(),
                        "status".into(),
                        "--porcelain".into(),
                    ],
                    repo,
                    token,
                )
                .await
                .ok()
                .is_some_and(|output| !output.stdout_text().trim().is_empty());
                let local_only_commits = git(
                    vec![
                        "-C".into(),
                        path.clone(),
                        "rev-list".into(),
                        "--all".into(),
                        "--not".into(),
                        "--remotes".into(),
                        "--max-count=1".into(),
                    ],
                    repo,
                    token,
                )
                .await
                .ok()
                .is_some_and(|output| !output.stdout_text().trim().is_empty());
                if dirty_worktree || local_only_commits {
                    return Err(DesktopError::new(
                        "SUBMODULE_DIRTY",
                        "The submodule has local changes or commits not reachable from a remote; confirm force removal before continuing",
                        true,
                    ));
                }
            }
            let mut args = vec!["rm".into()];
            if force {
                args.push("--force".into());
            }
            args.extend(["--".into(), path.clone()]);
            (path, args, false, true)
        }
        SubmoduleOperation::ResolveConflict { path, choice } => {
            let path = relative_path(Path::new(&repo.root_path), &path, false)?;
            resolve_submodule_conflict_gitlink(repo, &path, choice, token).await?;
            return Ok(());
        }
        SubmoduleOperation::Push { path } => {
            let path = relative_path(Path::new(&repo.root_path), &path, false)?;
            if git(
                vec![
                    "-C".into(),
                    path.clone(),
                    "symbolic-ref".into(),
                    "--quiet".into(),
                    "HEAD".into(),
                ],
                repo,
                token,
            )
            .await
            .is_err()
            {
                return Err(DesktopError::new(
                    "SUBMODULE_DETACHED_HEAD",
                    "Checkout a branch in the submodule before pushing",
                    true,
                ));
            }
            (
                path.clone(),
                vec!["-C".into(), path, "push".into()],
                true,
                true,
            )
        }
        SubmoduleOperation::Pull { path, rebase } => {
            let path = relative_path(Path::new(&repo.root_path), &path, false)?;
            let attached = git(
                vec![
                    "-C".into(),
                    path.clone(),
                    "symbolic-ref".into(),
                    "--quiet".into(),
                    "HEAD".into(),
                ],
                repo,
                token,
            )
            .await
            .is_ok();
            let mut args = vec![
                "-C".into(),
                path.clone(),
                if attached {
                    "pull".into()
                } else {
                    "fetch".into()
                },
            ];
            if attached && rebase {
                args.push("--rebase".into());
            }
            (path, args, true, true)
        }
    };
    if requires_existing {
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
        if !matches!(
            args.first().map(String::as_str),
            Some("rm" | "add" | "checkout" | "-C")
        ) {
            args.extend(["--".into(), entry.path]);
        }
    }
    if network {
        if permit_file_protocol && args.first().is_some_and(|value| value == "submodule") {
            args.splice(0..0, ["-c".into(), "protocol.file.allow=always".into()]);
        }
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
        SvnOperation::RemoveIgnoreEntries { entries } => {
            // Called under the repository write lock. Re-read properties so
            // deleting chosen entries preserves any unrelated ignore patterns.
            for entry in &entries {
                relative_path(root, &entry.directory, false)?;
            }
            for entry in entries {
                let Some(current) = svn_ignore_entries(repo, token)
                    .await?
                    .into_iter()
                    .find(|group| group.directory == entry.directory)
                else {
                    continue;
                };
                let remaining = current
                    .patterns
                    .into_iter()
                    .filter(|pattern| !entry.patterns.contains(pattern))
                    .collect::<Vec<_>>();
                update_ignore_rules(repo, &entry.directory, &remaining, token).await?;
            }
            return Ok(());
        }
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
        WorktreeOperation::Create {
            path,
            branch,
            new_branch,
            commitish,
            no_track,
        } => {
            validate_ref(&branch)?;
            if let Some(revision) = &commitish {
                validate_revision_or_ref(revision)?;
            }
            let target = PathBuf::from(&path);
            if !target.is_absolute() || path.contains('\0') {
                return Err(DesktopError::new(
                    "INVALID_WORKTREE_PATH",
                    "Choose an absolute worktree directory",
                    false,
                ));
            }
            if target.exists()
                && (!target.is_dir()
                    || std::fs::read_dir(&target)
                        .map_err(|e| {
                            DesktopError::new("WORKTREE_STORAGE_FAILED", e.to_string(), true)
                        })?
                        .next()
                        .is_some())
            {
                return Err(DesktopError::new(
                    "WORKTREE_EXISTS",
                    "Worktree directory is not empty",
                    true,
                ));
            }
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    DesktopError::new("WORKTREE_STORAGE_FAILED", e.to_string(), true)
                })?;
            }
            let mut args = vec!["worktree".into(), "add".into()];
            if new_branch {
                args.extend(["-b".into(), branch.clone()]);
            }
            if no_track {
                args.push("--no-track".into());
            }
            args.push(target.to_string_lossy().into_owned());
            if !new_branch {
                args.push(branch);
            } else if let Some(revision) = commitish {
                args.push(revision);
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
        WorktreeOperation::Lock { path, reason } => {
            let entry = managed_worktree(config_dir, repo, &path, token).await?;
            let mut args = vec!["worktree".into(), "lock".into()];
            if let Some(reason) = reason {
                args.extend(["--reason".into(), reason]);
            }
            args.push(entry.path);
            git(args, repo, token).await?;
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
    _config_dir: &Path,
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
    let candidate = std::fs::canonicalize(path).ok();
    worktrees(repo, token)
        .await?
        .into_iter()
        .find(|entry| {
            entry.path == path
                || candidate.as_ref().is_some_and(|candidate| {
                    std::fs::canonicalize(&entry.path).ok().as_ref() == Some(candidate)
                })
        })
        .ok_or_else(|| {
            DesktopError::new(
                "WORKTREE_NOT_FOUND",
                "Path is not a registered worktree of this repository",
                true,
            )
        })
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
            "-z".into(),
            "-M".into(),
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
            "-z".into(),
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

#[cfg(test)]
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
            "-z".into(),
            "-M".into(),
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
            "-z".into(),
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

pub fn map_git_conflict_side_statuses(code: &str) -> (Option<&'static str>, Option<&'static str>) {
    match code {
        "DD" => (Some("deleted"), Some("deleted")),
        "AU" => (Some("added"), Some("deleted")),
        "UD" => (Some("modified"), Some("deleted")),
        "UA" => (Some("deleted"), Some("added")),
        "DU" => (Some("deleted"), Some("modified")),
        "AA" => (Some("added"), Some("added")),
        "UU" => (Some("modified"), Some("modified")),
        _ => (Some("modified"), Some("modified")),
    }
}

pub async fn is_git_conflict_binary(
    repo: &RepositoryMeta,
    safe_path: &str,
    token: &CancellationToken,
) -> bool {
    let working_path = Path::new(&repo.root_path).join(safe_path);
    if let Ok(meta) = std::fs::symlink_metadata(&working_path) {
        if meta.file_type().is_symlink() {
            return true;
        }
    }
    if let Ok(output) = git(
        vec![
            "ls-files".into(),
            "-u".into(),
            "-z".into(),
            "--".into(),
            format!(":(literal){safe_path}"),
        ],
        repo,
        token,
    )
    .await
    {
        let text = output.stdout_text();
        for entry in text.split('\0').filter(|e| !e.is_empty()) {
            if let Some(mode) = entry.split_whitespace().next() {
                if mode == "120000" || mode == "160000" {
                    return true;
                }
            }
        }
    }
    if let Ok(bytes) = std::fs::read(&working_path) {
        if bytes_are_binary(&bytes) || std::str::from_utf8(&bytes).is_err() {
            return true;
        }
    }
    for stage in ["1", "2", "3"] {
        if let Ok(output) = git(
            vec!["show".into(), format!(":{stage}:{safe_path}")],
            repo,
            token,
        )
        .await
        {
            if bytes_are_binary(&output.stdout) || std::str::from_utf8(&output.stdout).is_err() {
                return true;
            }
        }
    }
    false
}

async fn svn_file_kind_properties(
    repo: &RepositoryMeta,
    safe_path: &str,
    token: &CancellationToken,
) -> Result<(String, String), DesktopError> {
    let literal_target = format!("{safe_path}@");
    let info = svn(
        vec![
            "info".into(),
            "--xml".into(),
            "--".into(),
            literal_target.clone(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let document = roxmltree::Document::parse(&info)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let entry = document
        .descendants()
        .find(|node| node.has_tag_name("entry"))
        .ok_or_else(|| DesktopError::new("SVN_XML_INVALID", "SVN info has no entry", true))?;
    let schedule = entry
        .descendants()
        .find(|node| node.has_tag_name("schedule"))
        .and_then(|node| node.text());
    let mut args = vec!["proplist".into(), "--xml".into(), "--verbose".into()];
    let target = if entry.attribute("kind") == Some("none") {
        // A moved/deleted victim may retain a tree-conflict record without a
        // working-copy node. Read the exact recorded revision, never HEAD.
        let source = ["source-left", "source-right"]
            .into_iter()
            .find_map(|side| {
                entry
                    .descendants()
                    .filter(|node| node.has_tag_name("tree-conflict"))
                    .flat_map(|node| node.children())
                    .find(|node| {
                        node.has_tag_name("version")
                            && node.attribute("side") == Some(side)
                            && matches!(node.attribute("kind"), Some("file" | "dir"))
                    })
            });
        let Some(source) = source else {
            return Ok((String::new(), String::new()));
        };
        let (Some(root_url), Some(path), Some(revision)) = (
            source.attribute("repos-url"),
            source.attribute("path-in-repos"),
            source
                .attribute("revision")
                .and_then(|value| value.parse::<u64>().ok()),
        ) else {
            return Err(DesktopError::new(
                "SVN_XML_INVALID",
                "Incomplete SVN conflict source",
                true,
            ));
        };
        let mut url = url::Url::parse(root_url)
            .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
        {
            let mut segments = url.path_segments_mut().map_err(|_| {
                DesktopError::new("SVN_XML_INVALID", "Invalid SVN repository URL", true)
            })?;
            segments.pop_if_empty();
            for segment in path.trim_start_matches('/').split('/') {
                segments.push(segment);
            }
        }
        args.extend(["-r".into(), revision.to_string()]);
        format!("{url}@{revision}")
    } else {
        // SVN refuses WORKING properties for scheduled deletions, including
        // delete/edit conflicts and deletions that kept their local file.
        if schedule == Some("delete") {
            args.extend(["-r".into(), "BASE".into()]);
        }
        literal_target
    };
    args.extend(["--".into(), target]);
    // proplist succeeds with an empty property list. Two propget calls would
    // both fail for ordinary files that have neither optional property.
    let raw = svn(args, repo, token).await?.stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let property = |name: &str| {
        document
            .descendants()
            .find(|node| node.has_tag_name("property") && node.attribute("name") == Some(name))
            .and_then(|node| node.text())
            .unwrap_or_default()
            .to_string()
    };
    Ok((property("svn:mime-type"), property("svn:special")))
}

pub async fn is_svn_conflict_binary(
    repo: &RepositoryMeta,
    safe_path: &str,
    token: &CancellationToken,
) -> bool {
    let working_path = Path::new(&repo.root_path).join(safe_path);
    if let Ok(meta) = std::fs::symlink_metadata(&working_path) {
        if meta.file_type().is_symlink() {
            return true;
        }
    }
    if let Ok(bytes) = std::fs::read(&working_path) {
        if bytes_are_binary(&bytes) || std::str::from_utf8(&bytes).is_err() {
            return true;
        }
    }
    let (mime_out, special_out) = svn_file_kind_properties(repo, safe_path, token)
        .await
        .unwrap_or_default();
    let mime = mime_out.trim().to_lowercase();
    let is_binary_mime = !mime.is_empty()
        && !mime.starts_with("text/")
        && mime != "image/x-xbitmap"
        && mime != "image/x-xpixmap";
    if is_binary_mime || !special_out.trim().is_empty() {
        return true;
    }
    let parent = working_path
        .parent()
        .unwrap_or_else(|| Path::new(&repo.root_path));
    let name = working_path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("");
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().into_owned();
            if fname.starts_with(&format!("{name}."))
                && (fname.ends_with(".mine") || fname.contains(".r"))
            {
                if let Ok(bytes) = std::fs::read(entry.path()) {
                    if bytes_are_binary(&bytes) || std::str::from_utf8(&bytes).is_err() {
                        return true;
                    }
                }
            }
        }
    }
    false
}

pub async fn svn_incoming_status(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> String {
    if let Ok(info_out) = svn(
        vec!["info".into(), "--xml".into(), "--".into(), path.to_string()],
        repo,
        token,
    )
    .await
    {
        let text = info_out.stdout_text();
        if let Ok(doc) = roxmltree::Document::parse(&text) {
            let mut left_kind: Option<&str> = None;
            let mut right_kind: Option<&str> = None;
            for node in doc.descendants().filter(|n| n.has_tag_name("version")) {
                let side = node.attribute("side");
                let kind = node.attribute("kind");
                if side == Some("source-left") {
                    left_kind = kind;
                } else if side == Some("source-right") {
                    right_kind = kind;
                }
            }
            if right_kind == Some("none") {
                return "deleted".to_string();
            }
            if left_kind == Some("none") && right_kind.is_some() {
                return "added".to_string();
            }
        }
    }
    "modified".to_string()
}

/// Apply the display policy without changing raw fingerprints or conflict write/accept logic.
pub async fn conflict_versions_with_mode(
    repo: &RepositoryMeta,
    path: &str,
    mode: &crate::models::CatFileFilterMode,
    token: &CancellationToken,
) -> Result<MergeVersions, DesktopError> {
    let mut versions = conflict_versions(repo, path, token).await?;
    if repo.kind != VcsKind::Git
        || versions.binary
        || *mode == crate::models::CatFileFilterMode::None
    {
        return Ok(versions);
    }
    let synthetic = versions.marker_content != versions.working;
    let base =
        crate::diff_content::blob(repo, &format!(":1:{}", versions.path), mode, token).await?;
    let ours =
        crate::diff_content::blob(repo, &format!(":2:{}", versions.path), mode, token).await?;
    let theirs =
        crate::diff_content::blob(repo, &format!(":3:{}", versions.path), mode, token).await?;
    if [&base, &ours, &theirs]
        .iter()
        .any(|bytes| bytes.len() > DIFF_MAX_BYTES || bytes_are_binary(bytes))
    {
        versions.binary = true;
        return Ok(versions);
    }
    versions.base = String::from_utf8_lossy(&base).into_owned();
    versions.ours = String::from_utf8_lossy(&ours).into_owned();
    versions.theirs = String::from_utf8_lossy(&theirs).into_owned();
    if synthetic {
        versions.marker_content =
            synthetic_conflict_content(&versions.base, &versions.ours, &versions.theirs);
        versions.conflicts = parse_conflict_blocks(&versions.marker_content);
    }
    Ok(versions)
}

pub async fn conflict_versions(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Result<MergeVersions, DesktopError> {
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, false)?;
    let working_path = root.join(&safe);
    if let Ok(meta) = tokio::fs::symlink_metadata(&working_path).await {
        if meta.file_type().is_symlink() {
            return Err(DesktopError::new(
                "SYMLINK_CONFLICT_NOT_EDITABLE",
                "Symbolic link conflicts cannot be edited as text. Choose a conflict side or resolve the link manually.",
                true,
            ));
        }
    }
    if relative_path(root, path, true).is_err() {
        return Err(DesktopError::new(
            "SYMLINK_CONFLICT_NOT_EDITABLE",
            "Symbolic link conflicts cannot be edited as text. Choose a conflict side or resolve the link manually.",
            true,
        ));
    }
    if repo.kind == VcsKind::Git {
        if let Ok(output) = git(
            vec![
                "ls-files".into(),
                "-u".into(),
                "-z".into(),
                "--".into(),
                format!(":(literal){safe}"),
            ],
            repo,
            token,
        )
        .await
        {
            let text = output.stdout_text();
            for entry in text.split('\0').filter(|e| !e.is_empty()) {
                if let Some(mode) = entry.split_whitespace().next() {
                    if mode == "120000" {
                        return Err(DesktopError::new(
                            "SYMLINK_CONFLICT_NOT_EDITABLE",
                            "Symbolic link conflicts cannot be edited as text. Choose a conflict side or resolve the link manually.",
                            true,
                        ));
                    }
                    if mode == "160000" {
                        return Err(DesktopError::new(
                            "SUBMODULE_CONFLICT_NOT_EDITABLE",
                            "Submodule conflicts cannot be edited as text. Choose a conflict side or resolve the submodule manually.",
                            true,
                        ));
                    }
                }
            }
        }
    }
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
    let mut binary =
        bytes_are_binary(&working_bytes) || std::str::from_utf8(&working_bytes).is_err();
    let working = String::from_utf8_lossy(&working_bytes).into_owned();
    let (base, ours, theirs, ours_status, theirs_status) = match repo.kind {
        VcsKind::Git => {
            let base_bytes = git(vec!["show".into(), format!(":1:{safe}")], repo, token)
                .await
                .map(|output| output.stdout)
                .unwrap_or_default();
            let ours_bytes = git(vec!["show".into(), format!(":2:{safe}")], repo, token)
                .await
                .map(|output| output.stdout)
                .unwrap_or_default();
            let theirs_bytes = git(vec!["show".into(), format!(":3:{safe}")], repo, token)
                .await
                .map(|output| output.stdout)
                .unwrap_or_default();

            if bytes_are_binary(&base_bytes)
                || std::str::from_utf8(&base_bytes).is_err()
                || bytes_are_binary(&ours_bytes)
                || std::str::from_utf8(&ours_bytes).is_err()
                || bytes_are_binary(&theirs_bytes)
                || std::str::from_utf8(&theirs_bytes).is_err()
            {
                binary = true;
            }

            let base = String::from_utf8_lossy(&base_bytes).into_owned();
            let ours = String::from_utf8_lossy(&ours_bytes).into_owned();
            let theirs = String::from_utf8_lossy(&theirs_bytes).into_owned();
            let status_output = git(
                vec![
                    "status".into(),
                    "--porcelain".into(),
                    "-z".into(),
                    "--".into(),
                    format!(":(literal){safe}"),
                ],
                repo,
                token,
            )
            .await
            .map(|output| output.stdout_text())
            .unwrap_or_default();
            let xy = status_output.split('\0').next().and_then(|rec| {
                if rec.len() >= 2 {
                    Some(&rec[..2])
                } else {
                    None
                }
            });
            let (ours_s, theirs_s) = xy
                .map(map_git_conflict_side_statuses)
                .unwrap_or((Some("modified"), Some("modified")));
            (
                base,
                ours,
                theirs,
                ours_s.map(String::from),
                theirs_s.map(String::from),
            )
        }
        VcsKind::Svn => {
            let (base, ours, theirs) = svn_conflict_artifacts(repo, root, &safe, token).await;
            let is_symlink = tokio::fs::symlink_metadata(&working_path)
                .await
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            let (mime_out, special_out) = svn_file_kind_properties(repo, &safe, token)
                .await
                .unwrap_or_default();
            let mime = mime_out.trim().to_lowercase();
            let is_binary_mime = !mime.is_empty()
                && !mime.starts_with("text/")
                && mime != "image/x-xbitmap"
                && mime != "image/x-xpixmap";
            if is_symlink
                || is_binary_mime
                || !special_out.trim().is_empty()
                || bytes_are_binary(base.as_bytes())
                || bytes_are_binary(ours.as_bytes())
                || bytes_are_binary(theirs.as_bytes())
            {
                binary = true;
            }
            let incoming = svn_incoming_status(repo, &safe, token).await;
            (base, ours, theirs, Some("modified".into()), Some(incoming))
        }
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
        ours_status,
        theirs_status,
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
    for (line_index, raw_line) in content.split('\n').enumerate() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        match state {
            MarkerState::Normal => {
                if line.starts_with("<<<<<<<") {
                    let label = line
                        .strip_prefix("<<<<<<< ")
                        .unwrap_or_else(|| line.strip_prefix("<<<<<<<").unwrap_or(""))
                        .trim();
                    let ours_label = if label.is_empty() { "OURS" } else { label };
                    current = Some(ConflictBlock {
                        index: result.len() as u32,
                        ours_label: ours_label.to_string(),
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
                if line.starts_with("|||||||") {
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
                if line.starts_with(">>>>>>>") {
                    let label = line
                        .strip_prefix(">>>>>>> ")
                        .unwrap_or_else(|| line.strip_prefix(">>>>>>>").unwrap_or(""))
                        .trim();
                    let theirs_label = if label.is_empty() { "THEIRS" } else { label };
                    if let Some(mut block) = current.take() {
                        block.theirs_label = theirs_label.to_string();
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

#[derive(Debug, Clone, Default)]
pub struct ConflictResolutionOutput {
    pub auto_commit_error: Option<String>,
    pub auto_committed: bool,
}

pub async fn conflict_save(
    repo: &RepositoryMeta,
    path: &str,
    content: &str,
    expected: &str,
    delete_file: bool,
    auto_commit_resolved_merge: bool,
    token: &CancellationToken,
) -> Result<ConflictResolutionOutput, DesktopError> {
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
    let current_fingerprint = fingerprint(&current);
    if current_fingerprint != expected && current != content.as_bytes() {
        return Err(DesktopError::new(
            "CONFLICT_STALE",
            "The file changed after it was loaded",
            true,
        ));
    }
    if !delete_file {
        if bytes_are_binary(&current) || std::str::from_utf8(&current).is_err() {
            return Err(DesktopError::new(
                "BINARY_FILE_NOT_EDITABLE",
                "Binary file — no diff available",
                true,
            ));
        }
        if repo.kind == VcsKind::Git {
            if is_git_conflict_binary(repo, &safe, token).await {
                return Err(DesktopError::new(
                    "BINARY_FILE_NOT_EDITABLE",
                    "Binary file — no diff available",
                    true,
                ));
            }
        } else if repo.kind == VcsKind::Svn && is_svn_conflict_binary(repo, &safe, token).await {
            return Err(DesktopError::new(
                "BINARY_FILE_NOT_EDITABLE",
                "Binary file — no diff available",
                true,
            ));
        }
    }
    if delete_file {
        if target.exists() {
            if target.is_dir() {
                tokio::fs::remove_dir_all(&target).await.map_err(|error| {
                    DesktopError::new("FILE_DELETE_FAILED", error.to_string(), true)
                })?;
            } else {
                tokio::fs::remove_file(&target).await.map_err(|error| {
                    DesktopError::new("FILE_DELETE_FAILED", error.to_string(), true)
                })?;
            }
        }
        match repo.kind {
            VcsKind::Git => {
                let rm_res = git(
                    vec![
                        "rm".into(),
                        "-f".into(),
                        "--".into(),
                        format!(":(literal){safe}"),
                    ],
                    repo,
                    token,
                )
                .await;
                if rm_res.is_err() {
                    git(
                        vec![
                            "add".into(),
                            "-u".into(),
                            "--".into(),
                            format!(":(literal){safe}"),
                        ],
                        repo,
                        token,
                    )
                    .await?;
                }
                let mut auto_commit_error = None;
                let mut auto_committed = false;
                if auto_commit_resolved_merge {
                    match complete_git_merge_if_resolved(repo, token).await {
                        Ok(committed) => {
                            auto_committed = committed;
                        }
                        Err(error) => {
                            crate::logger::log_entry(
                                crate::logger::LogLevel::Warn,
                                crate::logger::LogChannel::Git,
                                format!(
                                    "Conflict file deletion resolved and staged, but auto commit failed: {}",
                                    error.message
                                ),
                                None,
                                None,
                                None,
                            );
                            auto_commit_error = Some(error.message);
                        }
                    }
                }
                return Ok(ConflictResolutionOutput {
                    auto_commit_error,
                    auto_committed,
                });
            }
            VcsKind::Svn => {
                let is_versioned = svn(
                    vec!["info".into(), "--xml".into(), "--".into(), safe.clone()],
                    repo,
                    token,
                )
                .await
                .is_ok();
                if is_versioned {
                    svn(
                        vec!["delete".into(), "--force".into(), "--".into(), safe.clone()],
                        repo,
                        token,
                    )
                    .await?;
                }
                svn(
                    vec![
                        "resolve".into(),
                        "--accept".into(),
                        "working".into(),
                        "--".into(),
                        safe.clone(),
                    ],
                    repo,
                    token,
                )
                .await?;
            }
        }
        return Ok(ConflictResolutionOutput::default());
    }
    if content.lines().any(|raw_line| {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        line.starts_with("<<<<<<<") || line == "=======" || line.starts_with(">>>>>>>")
    }) {
        return Err(DesktopError::new(
            "UNRESOLVED_MARKERS",
            "Conflict markers remain in the result",
            true,
        ));
    }
    let parent = target.parent().unwrap_or(root);
    let mut temp = tempfile::Builder::new()
        .prefix(".versiondock-tmp-")
        .tempfile_in(parent)
        .map_err(|error| DesktopError::new("FILE_WRITE_FAILED", error.to_string(), true))?;
    use std::io::Write;
    temp.write_all(content.as_bytes())
        .map_err(|error| DesktopError::new("FILE_WRITE_FAILED", error.to_string(), true))?;
    temp.flush()
        .map_err(|error| DesktopError::new("FILE_WRITE_FAILED", error.to_string(), true))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let original_mode = if let Ok(meta) = std::fs::metadata(&target) {
            Some(meta.permissions().mode())
        } else if repo.kind == VcsKind::Git {
            let output = git(
                vec![
                    "ls-files".into(),
                    "-u".into(),
                    "-z".into(),
                    "--".into(),
                    format!(":(literal){safe}"),
                ],
                repo,
                token,
            )
            .await
            .ok()
            .map(|o| o.stdout_text())
            .unwrap_or_default();
            output
                .split('\0')
                .filter_map(|entry| entry.split_whitespace().next())
                .find(|mode| *mode == "100755")
                .map(|_| 0o755)
        } else {
            None
        };
        if let Some(mode) = original_mode {
            let _ = std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(mode));
        } else {
            let _ = std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o644));
        }
    }
    temp.persist(&target)
        .map_err(|error| DesktopError::new("FILE_WRITE_FAILED", error.error.to_string(), true))?;
    let mut auto_commit_error = None;
    let mut auto_committed = false;
    match repo.kind {
        VcsKind::Git => {
            stage(repo, &[safe], false, token).await?;
            if auto_commit_resolved_merge {
                match complete_git_merge_if_resolved(repo, token).await {
                    Ok(committed) => {
                        auto_committed = committed;
                    }
                    Err(error) => {
                        crate::logger::log_entry(
                            crate::logger::LogLevel::Warn,
                            crate::logger::LogChannel::Git,
                            format!(
                                "Conflict file resolved and staged, but auto commit failed: {}",
                                error.message
                            ),
                            None,
                            None,
                            None,
                        );
                        auto_commit_error = Some(error.message);
                    }
                }
            }
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
    Ok(ConflictResolutionOutput {
        auto_commit_error,
        auto_committed,
    })
}

pub async fn conflict_accept(
    repo: &RepositoryMeta,
    path: &str,
    choice: ConflictChoice,
    auto_commit_resolved_merge: bool,
    token: &CancellationToken,
) -> Result<ConflictResolutionOutput, DesktopError> {
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, false)?;
    match repo.kind {
        VcsKind::Git => {
            if let Some(companion) =
                check_submodule_type_change_conflict(repo, &safe, token).await?
            {
                return Err(DesktopError::new(
                    "SUBMODULE_TYPE_CHANGE_MANUAL",
                    format!(
                        "This is a directory-file or type-change conflict involving a submodule with companion path '{companion}'. Please resolve it manually to protect local changes."
                    ),
                    true,
                ));
            }

            let (_, stages, type_change, _) = submodule_index_state(repo, &safe, token).await;
            if stages.is_some() && !type_change {
                resolve_submodule_conflict_gitlink(repo, &safe, choice, token).await?;
                let mut auto_commit_error = None;
                let mut auto_committed = false;
                if auto_commit_resolved_merge {
                    match complete_git_merge_if_resolved(repo, token).await {
                        Ok(committed) => {
                            auto_committed = committed;
                        }
                        Err(error) => {
                            crate::logger::log_entry(
                                crate::logger::LogLevel::Warn,
                                crate::logger::LogChannel::Git,
                                format!(
                                    "Conflict side accepted and staged, but auto commit failed: {}",
                                    error.message
                                ),
                                None,
                                None,
                                None,
                            );
                            auto_commit_error = Some(error.message);
                        }
                    }
                }
                return Ok(ConflictResolutionOutput {
                    auto_commit_error,
                    auto_committed,
                });
            }

            let side_status = match choice {
                ConflictChoice::Mine | ConflictChoice::Theirs => {
                    let output = git(
                        vec![
                            "status".into(),
                            "--porcelain".into(),
                            "-z".into(),
                            "--".into(),
                            format!(":(literal){safe}"),
                        ],
                        repo,
                        token,
                    )
                    .await
                    .map(|out| out.stdout_text())
                    .unwrap_or_default();
                    let xy = output.split('\0').next().and_then(|rec| {
                        if rec.len() >= 2 {
                            Some(&rec[..2])
                        } else {
                            None
                        }
                    });
                    let (ours_s, theirs_s) = xy
                        .map(map_git_conflict_side_statuses)
                        .unwrap_or((Some("modified"), Some("modified")));
                    if choice == ConflictChoice::Mine {
                        ours_s
                    } else {
                        theirs_s
                    }
                }
                ConflictChoice::Working => None,
            };

            if side_status == Some("deleted") {
                let target = root.join(&safe);
                let is_submodule_dir = target.is_dir() && target.join(".git").exists();
                if is_submodule_dir {
                    let dirty = git(
                        vec![
                            "-C".into(),
                            safe.clone(),
                            "status".into(),
                            "--porcelain".into(),
                        ],
                        repo,
                        token,
                    )
                    .await
                    .map(|out| !out.stdout_text().trim().is_empty())
                    .unwrap_or(false);
                    if dirty {
                        return Err(DesktopError::new(
                            "SUBMODULE_DIRTY",
                            "The submodule has uncommitted local changes or commits; resolve it manually to avoid data loss.",
                            true,
                        ));
                    }
                    git(
                        vec![
                            "rm".into(),
                            "--cached".into(),
                            "--ignore-unmatch".into(),
                            "--".into(),
                            safe.clone(),
                        ],
                        repo,
                        token,
                    )
                    .await?;
                } else {
                    let literal_arg = format!(":(literal){safe}");
                    let rm_res = git(
                        vec!["rm".into(), "-f".into(), "--".into(), literal_arg.clone()],
                        repo,
                        token,
                    )
                    .await;
                    if rm_res.is_err() {
                        if tokio::fs::symlink_metadata(&target).await.is_ok() {
                            let is_dir = target.is_dir()
                                && !tokio::fs::symlink_metadata(&target)
                                    .await
                                    .map(|m| m.file_type().is_symlink())
                                    .unwrap_or(false);
                            if is_dir {
                                tokio::fs::remove_dir_all(&target).await.map_err(|error| {
                                    DesktopError::new("FILE_DELETE_FAILED", error.to_string(), true)
                                })?;
                            } else {
                                tokio::fs::remove_file(&target).await.map_err(|error| {
                                    DesktopError::new("FILE_DELETE_FAILED", error.to_string(), true)
                                })?;
                            }
                        }
                        git(
                            vec!["add".into(), "-u".into(), "--".into(), literal_arg],
                            repo,
                            token,
                        )
                        .await?;
                    }
                }
            } else {
                match choice {
                    ConflictChoice::Mine => {
                        git(
                            vec![
                                "checkout".into(),
                                "--ours".into(),
                                "--".into(),
                                format!(":(literal){safe}"),
                            ],
                            repo,
                            token,
                        )
                        .await?;
                        stage(repo, std::slice::from_ref(&safe), false, token).await?;
                    }
                    ConflictChoice::Theirs => {
                        git(
                            vec![
                                "checkout".into(),
                                "--theirs".into(),
                                "--".into(),
                                format!(":(literal){safe}"),
                            ],
                            repo,
                            token,
                        )
                        .await?;
                        stage(repo, std::slice::from_ref(&safe), false, token).await?;
                    }
                    ConflictChoice::Working => {
                        stage(repo, std::slice::from_ref(&safe), false, token).await?;
                    }
                }
            }
            let mut auto_commit_error = None;
            let mut auto_committed = false;
            if auto_commit_resolved_merge {
                match complete_git_merge_if_resolved(repo, token).await {
                    Ok(committed) => {
                        auto_committed = committed;
                    }
                    Err(error) => {
                        crate::logger::log_entry(
                            crate::logger::LogLevel::Warn,
                            crate::logger::LogChannel::Git,
                            format!(
                                "Conflict side accepted and staged, but auto commit failed: {}",
                                error.message
                            ),
                            None,
                            None,
                            None,
                        );
                        auto_commit_error = Some(error.message);
                    }
                }
            }
            return Ok(ConflictResolutionOutput {
                auto_commit_error,
                auto_committed,
            });
        }
        VcsKind::Svn => {
            let accept = match choice {
                ConflictChoice::Mine => "mine-full",
                ConflictChoice::Theirs => "theirs-full",
                ConflictChoice::Working => "working",
            };
            let res = svn(
                vec![
                    "resolve".into(),
                    "--accept".into(),
                    accept.into(),
                    "--".into(),
                    safe.clone(),
                ],
                repo,
                token,
            )
            .await;

            if let Err(error) = res {
                let error_lower = error.message.to_lowercase();
                if error_lower.contains("w195024") {
                    accept_svn_tree_conflict(repo, &safe, choice, token).await?;
                } else {
                    return Err(error);
                }
            }
        }
    }
    Ok(ConflictResolutionOutput::default())
}

async fn accept_svn_tree_conflict(
    repo: &RepositoryMeta,
    safe_path: &str,
    choice: ConflictChoice,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let root = Path::new(&repo.root_path);
    let target = root.join(safe_path);

    if choice == ConflictChoice::Mine || choice == ConflictChoice::Working {
        svn(
            vec![
                "resolve".into(),
                "--accept".into(),
                "working".into(),
                "--".into(),
                safe_path.to_string(),
            ],
            repo,
            token,
        )
        .await?;
        return Ok(());
    }

    let raw_info = svn(
        vec![
            "info".into(),
            "--xml".into(),
            "--".into(),
            safe_path.to_string(),
        ],
        repo,
        token,
    )
    .await
    .map(|out| out.stdout_text())
    .unwrap_or_default();

    let is_update_or_switch =
        raw_info.contains("operation=\"update\"") || raw_info.contains("operation=\"switch\"");
    let is_dir = raw_info.contains("kind=\"dir\"");

    if is_update_or_switch {
        if target.exists() {
            if target.is_dir() {
                let _ = tokio::fs::remove_dir_all(&target).await;
            } else {
                let _ = tokio::fs::remove_file(&target).await;
            }
        }
        svn(
            vec![
                "revert".into(),
                "--depth".into(),
                "infinity".into(),
                "--".into(),
                safe_path.to_string(),
            ],
            repo,
            token,
        )
        .await?;
        return Ok(());
    }

    if !is_dir {
        let is_symlink = tokio::fs::symlink_metadata(&target)
            .await
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if is_symlink {
            return Err(DesktopError::new(
                "UNSUPPORTED_FILE_TYPE",
                "Binary file — no diff available",
                true,
            ));
        }

        let (mime_out, special_out) = svn_file_kind_properties(repo, safe_path, token)
            .await
            .unwrap_or_default();
        let mime = mime_out.trim().to_lowercase();
        let is_binary_mime = !mime.is_empty()
            && !mime.starts_with("text/")
            && mime != "image/x-xbitmap"
            && mime != "image/x-xpixmap";
        if is_binary_mime || !special_out.trim().is_empty() {
            return Err(DesktopError::new(
                "BINARY_CONFLICT",
                "Binary file — no diff available",
                true,
            ));
        }

        let versions = conflict_versions(repo, safe_path, token).await?;
        if versions.binary {
            return Err(DesktopError::new(
                "BINARY_CONFLICT",
                "Binary file — no diff available",
                true,
            ));
        }
        if let Some(parent) = target.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        tokio::fs::write(&target, &versions.theirs)
            .await
            .map_err(|error| DesktopError::new("FILE_WRITE_FAILED", error.to_string(), true))?;
        svn(
            vec![
                "resolve".into(),
                "--accept".into(),
                "working".into(),
                "--".into(),
                safe_path.to_string(),
            ],
            repo,
            token,
        )
        .await?;
        return Ok(());
    }

    Err(DesktopError::new(
        "SVN_TREE_CONFLICT_MANUAL",
        "SVN directory merge conflicts must be resolved manually to preserve the complete tree and properties.",
        true,
    ))
}

async fn svn_conflict_artifacts(
    repo: &RepositoryMeta,
    root: &Path,
    path: &str,
    token: &CancellationToken,
) -> (String, String, String) {
    let target = root.join(path);
    let parent = target.parent().unwrap_or(root);
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    let mut base = String::new();
    let mut ours = String::new();
    let mut theirs = String::new();

    if let Ok(info_out) = svn(
        vec!["info".into(), "--xml".into(), "--".into(), path.to_string()],
        repo,
        token,
    )
    .await
    {
        let text = info_out.stdout_text();
        if let Ok(doc) = roxmltree::Document::parse(&text) {
            for node in doc.descendants() {
                let tag_name = node.tag_name().name();
                if let Some(file_str) = node.text() {
                    let file_str = file_str.trim();
                    if !file_str.is_empty() {
                        let file_path = if Path::new(file_str).is_absolute() {
                            PathBuf::from(file_str)
                        } else {
                            let p1 = parent.join(file_str);
                            if p1.exists() {
                                p1
                            } else {
                                root.join(file_str)
                            }
                        };
                        match tag_name {
                            "prev-base-file" => {
                                if let Ok(bytes) = tokio::fs::read(&file_path).await {
                                    base = String::from_utf8_lossy(&bytes).into_owned();
                                }
                            }
                            "prev-wc-file" => {
                                if let Ok(bytes) = tokio::fs::read(&file_path).await {
                                    ours = String::from_utf8_lossy(&bytes).into_owned();
                                }
                            }
                            "cur-base-file" => {
                                if let Ok(bytes) = tokio::fs::read(&file_path).await {
                                    theirs = String::from_utf8_lossy(&bytes).into_owned();
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    if base.is_empty() || theirs.is_empty() || ours.is_empty() {
        let mut r_files: Vec<(u64, PathBuf)> = Vec::new();
        let mut merge_left: Option<PathBuf> = None;
        let mut merge_right: Option<PathBuf> = None;
        let mut mine_file: Option<PathBuf> = None;

        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().into_owned();
                if file_name == format!("{name}.mine") {
                    mine_file = Some(entry.path());
                } else if file_name.starts_with(&format!("{name}.merge-left.r")) {
                    merge_left = Some(entry.path());
                } else if file_name.starts_with(&format!("{name}.merge-right.r")) {
                    merge_right = Some(entry.path());
                } else if let Some(rev_str) = file_name.strip_prefix(&format!("{name}.r")) {
                    if let Ok(rev) = rev_str.parse::<u64>() {
                        r_files.push((rev, entry.path()));
                    }
                }
            }
        }

        r_files.sort_by_key(|(rev, _)| *rev);

        if ours.is_empty() {
            if let Some(mine_path) = mine_file {
                if let Ok(bytes) = std::fs::read(mine_path) {
                    ours = String::from_utf8_lossy(&bytes).into_owned();
                }
            }
        }
        if base.is_empty() {
            if let Some(left_path) = merge_left {
                if let Ok(bytes) = std::fs::read(left_path) {
                    base = String::from_utf8_lossy(&bytes).into_owned();
                }
            } else if let Some((_, first_path)) = r_files.first() {
                if let Ok(bytes) = std::fs::read(first_path) {
                    base = String::from_utf8_lossy(&bytes).into_owned();
                }
            }
        }
        if theirs.is_empty() {
            if let Some(right_path) = merge_right {
                if let Ok(bytes) = std::fs::read(right_path) {
                    theirs = String::from_utf8_lossy(&bytes).into_owned();
                }
            } else if let Some((_, last_path)) = r_files.last() {
                if let Ok(bytes) = std::fs::read(last_path) {
                    theirs = String::from_utf8_lossy(&bytes).into_owned();
                }
            }
        }
    }

    (base, ours, theirs)
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
    use tempfile::tempdir;

    #[tokio::test]
    async fn svn_incoming_revisions_cached_does_not_block_on_uncached_or_expired_state() {
        let repo = RepositoryMeta {
            id: "svn-perf-repo".into(),
            name: "SvnPerfRepo".into(),
            root_path: "/nonexistent/svn/repo".into(),
            color: "#000".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };

        // 1. 无缓存时：耗时必须远小于远端超时 20 秒（< 50ms），且非阻塞返回 0
        invalidate_svn_ref_caches(&repo.id);
        let start = Instant::now();
        let behind = svn_incoming_revisions_cached(&repo, "100");
        let elapsed = start.elapsed();
        assert_eq!(behind, 0);
        assert!(elapsed < Duration::from_millis(50));

        // 2. 预置缓存后：立即返回缓存中的 behind
        if let Ok(mut cache) = SVN_INCOMING_CACHE.get_or_init(Default::default).lock() {
            cache.insert(repo.id.clone(), (Instant::now(), 100, 5));
        }
        let start = Instant::now();
        let behind = svn_incoming_revisions_cached(&repo, "100");
        let elapsed = start.elapsed();
        assert_eq!(behind, 5);
        assert!(elapsed < Duration::from_millis(10));

        // 3. 缓存过期时：仍然立即返回已知的 behind（5），耗时远小于 20 秒（< 50ms），后台非阻塞刷新
        if let Ok(mut cache) = SVN_INCOMING_CACHE.get_or_init(Default::default).lock() {
            let expired_instant = Instant::now() - Duration::from_secs(120);
            cache.insert(repo.id.clone(), (expired_instant, 100, 5));
        }
        let start = Instant::now();
        let behind = svn_incoming_revisions_cached(&repo, "100");
        let elapsed = start.elapsed();
        assert_eq!(behind, 5);
        assert!(elapsed < Duration::from_millis(50));

        // 清理缓存
        invalidate_svn_ref_caches(&repo.id);
    }

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
    fn binary_marker_text_inside_diff_hunks_is_not_binary() {
        for prefix in [' ', '+', '-'] {
            let patch = format!(
                "diff --git a/vcs.rs b/vcs.rs\n--- a/vcs.rs\n+++ b/vcs.rs\n@@ -1,3 +1,3 @@\n{prefix}GIT binary patch\n{prefix}Binary files a/image.png and b/image.png differ\n{prefix}Cannot display: file marked as a binary type.\n"
            );
            let diff = make_diff("vcs.rs", patch.clone().into_bytes()).unwrap();
            assert!(!diff.binary, "text hunk with prefix {prefix:?}");
            assert_eq!(diff.content, patch);
        }
        let diff = make_diff(
            "Binary files.rs",
            b"diff --git a/Binary files.rs b/Binary files.rs\n--- a/Binary files.rs\n+++ b/Binary files.rs\n@@ -1 +1 @@\n-old\n+new\n".to_vec(),
        ).unwrap();
        assert!(!diff.binary);
    }

    #[test]
    fn standalone_vcs_binary_markers_remain_binary() {
        for marker in [
            "GIT binary patch\nliteral 3\nabc",
            "Binary files a/image.png and b/image.png differ",
            "Cannot display: file marked as a binary type.\nsvn:mime-type = application/octet-stream",
        ] {
            let patch = format!("diff --git a/file b/file\n{marker}\n");
            assert!(make_diff("file", patch.into_bytes()).unwrap().binary);
        }
        assert!(make_diff("file", b"raw\0binary".to_vec()).unwrap().binary);
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
            "{RECORD}new{FIELD}parent{FIELD}Ada{FIELD}2026-01-02{FIELD}copy file\0\nC007\0src/old.rs\0src/new.rs\0{RECORD}old{FIELD}root{FIELD}Ada{FIELD}2026-01-01{FIELD}edit source\0\nM\0src/old.rs\0"
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
        assert_eq!(
            svn_repository_target("release").unwrap(),
            "^/branches/release"
        );
        assert_eq!(
            svn_repository_target("branches/release").unwrap(),
            "^/branches/release"
        );
        assert_eq!(
            svn_repository_target("tags/v1.0.0").unwrap(),
            "^/tags/v1.0.0"
        );
    }

    #[test]
    #[cfg(unix)]
    fn git_symlink_conflict_is_rejected_and_never_reads_external_file() {
        let repo_dir = tempdir().unwrap();
        let external_dir = tempdir().unwrap();
        let external_secret = external_dir.path().join("secret.txt");
        std::fs::write(&external_secret, "SUPER_SECRET_TOKEN").unwrap();

        let link_path = repo_dir.path().join("link_to_secret.txt");
        std::os::unix::fs::symlink(&external_secret, &link_path).unwrap();

        let repo = RepositoryMeta {
            id: "repo".into(),
            name: "Repo".into(),
            root_path: repo_dir.path().to_string_lossy().into(),
            color: "#fff".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let token = CancellationToken::new();
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let is_binary = is_git_conflict_binary(&repo, "link_to_secret.txt", &token).await;
            assert!(is_binary);

            let res = conflict_versions(&repo, "link_to_secret.txt", &token).await;
            assert!(res.is_err());
            let err = res.err().unwrap();
            assert_eq!(err.code, "SYMLINK_CONFLICT_NOT_EDITABLE");
        });
    }

    #[test]
    fn conflict_save_uses_atomic_tempfile_and_allows_idempotent_retry() {
        let repo_dir = tempdir().unwrap();
        let target_file = repo_dir.path().join("file.txt");
        std::fs::write(&target_file, "initial content").unwrap();
        let expected_fp = fingerprint("initial content".as_bytes());

        let existing_dummy = repo_dir
            .path()
            .join(format!("file.versiondock-{}", std::process::id()));
        std::fs::write(&existing_dummy, "DO_NOT_OVERWRITE").unwrap();

        let new_content = "resolved content";
        let parent = target_file.parent().unwrap();
        let mut temp = tempfile::Builder::new()
            .prefix(".versiondock-tmp-")
            .tempfile_in(parent)
            .unwrap();
        use std::io::Write;
        temp.write_all(new_content.as_bytes()).unwrap();
        temp.flush().unwrap();
        temp.persist(&target_file).unwrap();

        assert_eq!(
            std::fs::read_to_string(&existing_dummy).unwrap(),
            "DO_NOT_OVERWRITE"
        );

        let current = std::fs::read(&target_file).unwrap();
        let current_fp = fingerprint(&current);
        assert_ne!(current_fp, expected_fp);
        assert_eq!(current, new_content.as_bytes());
    }

    #[test]
    #[cfg(unix)]
    fn conflict_save_preserves_executable_permission_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let repo_dir = tempdir().unwrap();
        let target_file = repo_dir.path().join("script.sh");
        std::fs::write(&target_file, "#!/bin/sh\necho hello\n").unwrap();
        std::fs::set_permissions(&target_file, std::fs::Permissions::from_mode(0o755)).unwrap();

        let initial_mode = std::fs::metadata(&target_file)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(initial_mode & 0o111, 0o111);

        let parent = target_file.parent().unwrap();
        let mut temp = tempfile::Builder::new()
            .prefix(".versiondock-tmp-")
            .tempfile_in(parent)
            .unwrap();
        use std::io::Write;
        temp.write_all(b"#!/bin/sh\necho resolved\n").unwrap();
        temp.flush().unwrap();

        let original_mode = std::fs::metadata(&target_file)
            .ok()
            .map(|m| m.permissions().mode());
        if let Some(mode) = original_mode {
            let _ = std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(mode));
        }
        temp.persist(&target_file).unwrap();

        let final_mode = std::fs::metadata(&target_file)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(final_mode & 0o777, 0o755);
    }

    #[test]
    #[cfg(unix)]
    fn conflict_accept_path_check_allows_symlink_leaf() {
        let repo_dir = tempdir().unwrap();
        let external_dir = tempdir().unwrap();
        let target = external_dir.path().join("external_file.txt");
        std::fs::write(&target, "content").unwrap();

        let link_path = repo_dir.path().join("link_file.txt");
        std::os::unix::fs::symlink(&target, &link_path).unwrap();

        assert!(relative_path(repo_dir.path(), "link_file.txt", false).is_ok());
        assert!(relative_path(repo_dir.path(), "link_file.txt", true).is_err());
    }

    #[test]
    fn svn_conflict_artifacts_sorts_revision_numbers_correctly() {
        let repo_dir = tempdir().unwrap();
        let target_file = repo_dir.path().join("conflict.txt");
        std::fs::write(&target_file, "working copy text").unwrap();

        let r1_file = repo_dir.path().join("conflict.txt.r1");
        let r2_file = repo_dir.path().join("conflict.txt.r2");
        let mine_file = repo_dir.path().join("conflict.txt.mine");

        std::fs::write(&r1_file, "base content from r1").unwrap();
        std::fs::write(&r2_file, "incoming content from r2").unwrap();
        std::fs::write(&mine_file, "my content from mine").unwrap();

        let repo = RepositoryMeta {
            id: "repo".into(),
            name: "Repo".into(),
            root_path: repo_dir.path().to_string_lossy().into(),
            color: "#fff".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let token = CancellationToken::new();

        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (base, ours, theirs) =
                svn_conflict_artifacts(&repo, repo_dir.path(), "conflict.txt", &token).await;
            assert_eq!(base, "base content from r1");
            assert_eq!(ours, "my content from mine");
            assert_eq!(theirs, "incoming content from r2");
        });
    }

    #[test]
    fn is_svn_conflict_binary_detects_binary_in_side_files() {
        let repo_dir = tempdir().unwrap();
        let target_file = repo_dir.path().join("image.png");
        std::fs::write(&target_file, "text dummy").unwrap();

        let r2_file = repo_dir.path().join("image.png.r2");
        let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
        std::fs::write(&r2_file, png_bytes).unwrap();

        let repo = RepositoryMeta {
            id: "repo".into(),
            name: "Repo".into(),
            root_path: repo_dir.path().to_string_lossy().into(),
            color: "#fff".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let token = CancellationToken::new();

        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let is_binary = is_svn_conflict_binary(&repo, "image.png", &token).await;
            assert!(is_binary);
        });
    }

    #[test]
    fn submodule_conflict_accept_theirs_stages_theirs_pointer() {
        let temp = tempdir().unwrap();
        let sub_dir = temp.path().join("sub_origin");
        std::fs::create_dir_all(&sub_dir).unwrap();
        let run_cmd = |args: &[&str], cwd: &Path| {
            let res = std::process::Command::new(args[0])
                .args(&args[1..])
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(
                res.status.success(),
                "Command failed: {:?}, stderr: {}",
                args,
                String::from_utf8_lossy(&res.stderr)
            );
            String::from_utf8_lossy(&res.stdout).trim().to_string()
        };

        run_cmd(&["git", "init"], &sub_dir);
        run_cmd(&["git", "config", "user.email", "test@test.com"], &sub_dir);
        run_cmd(&["git", "config", "user.name", "Test"], &sub_dir);
        run_cmd(
            &["git", "commit", "--allow-empty", "-m", "sub c0"],
            &sub_dir,
        );
        let sub_main_branch = run_cmd(&["git", "branch", "--show-current"], &sub_dir);
        let c0 = run_cmd(&["git", "rev-parse", "HEAD"], &sub_dir);

        run_cmd(&["git", "checkout", "-b", "sub_b1"], &sub_dir);
        run_cmd(
            &["git", "commit", "--allow-empty", "-m", "sub c1"],
            &sub_dir,
        );
        let c1 = run_cmd(&["git", "rev-parse", "HEAD"], &sub_dir);

        run_cmd(&["git", "checkout", &sub_main_branch], &sub_dir);
        run_cmd(&["git", "checkout", "-b", "sub_b2"], &sub_dir);
        run_cmd(
            &["git", "commit", "--allow-empty", "-m", "sub c2"],
            &sub_dir,
        );
        let c2 = run_cmd(&["git", "rev-parse", "HEAD"], &sub_dir);

        let main_dir = temp.path().join("main");
        std::fs::create_dir_all(&main_dir).unwrap();
        run_cmd(&["git", "init"], &main_dir);
        run_cmd(&["git", "config", "user.email", "test@test.com"], &main_dir);
        run_cmd(&["git", "config", "user.name", "Test"], &main_dir);
        run_cmd(
            &[
                "git",
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                sub_dir.to_str().unwrap(),
                "mysub",
            ],
            &main_dir,
        );
        run_cmd(&["git", "checkout", &c0], &main_dir.join("mysub"));
        run_cmd(&["git", "add", "mysub"], &main_dir);
        run_cmd(&["git", "commit", "-m", "add submodule c0"], &main_dir);
        let main_default_branch = run_cmd(&["git", "branch", "--show-current"], &main_dir);

        run_cmd(&["git", "checkout", "-b", "b1"], &main_dir);
        run_cmd(&["git", "checkout", &c1], &main_dir.join("mysub"));
        run_cmd(&["git", "add", "mysub"], &main_dir);
        run_cmd(&["git", "commit", "-m", "b1 uses c1"], &main_dir);

        run_cmd(&["git", "checkout", &main_default_branch], &main_dir);
        run_cmd(&["git", "checkout", "-b", "b2"], &main_dir);
        run_cmd(&["git", "checkout", &c2], &main_dir.join("mysub"));
        run_cmd(&["git", "add", "mysub"], &main_dir);
        run_cmd(&["git", "commit", "-m", "b2 uses c2"], &main_dir);

        let _ = std::process::Command::new("git")
            .args(["merge", "b1"])
            .current_dir(&main_dir)
            .output();

        let repo = RepositoryMeta {
            id: "repo".into(),
            name: "Repo".into(),
            root_path: main_dir.to_string_lossy().into(),
            color: "#fff".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let token = CancellationToken::new();

        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let ver_res = conflict_versions(&repo, "mysub", &token).await;
            assert!(ver_res.is_err());
            let err_code = ver_res.err().unwrap().code;
            assert!(
                err_code == "SUBMODULE_CONFLICT_NOT_EDITABLE"
                    || err_code == "DIRECTORY_CONFLICT_NOT_EDITABLE"
            );

            let accept_res =
                conflict_accept(&repo, "mysub", ConflictChoice::Theirs, false, &token).await;
            assert!(accept_res.is_ok());

            let staged_ls = run_cmd(&["git", "ls-files", "--stage", "--", "mysub"], &main_dir);
            assert!(
                staged_ls.contains(&c1),
                "Index should contain theirs SHA {c1}, but was: {staged_ls}"
            );
            assert!(
                !staged_ls.contains(&c2),
                "Index should not contain ours SHA {c2}"
            );
        });
    }

    #[test]
    fn submodule_type_change_conflict_is_rejected_and_preserves_uncommitted_files() {
        let temp = tempdir().unwrap();
        let sub_dir = temp.path().join("sub_origin");
        std::fs::create_dir_all(&sub_dir).unwrap();
        let run_cmd = |args: &[&str], cwd: &Path| {
            let res = std::process::Command::new(args[0])
                .args(&args[1..])
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(
                res.status.success(),
                "Command failed: {:?}, stderr: {}",
                args,
                String::from_utf8_lossy(&res.stderr)
            );
            String::from_utf8_lossy(&res.stdout).trim().to_string()
        };

        run_cmd(&["git", "init"], &sub_dir);
        run_cmd(&["git", "config", "user.email", "test@test.com"], &sub_dir);
        run_cmd(&["git", "config", "user.name", "Test"], &sub_dir);
        run_cmd(
            &["git", "commit", "--allow-empty", "-m", "sub init"],
            &sub_dir,
        );

        let main_dir = temp.path().join("main");
        std::fs::create_dir_all(&main_dir).unwrap();
        run_cmd(&["git", "init"], &main_dir);
        run_cmd(&["git", "config", "user.email", "test@test.com"], &main_dir);
        run_cmd(&["git", "config", "user.name", "Test"], &main_dir);
        run_cmd(&["git", "commit", "--allow-empty", "-m", "init"], &main_dir);
        let main_default_branch = run_cmd(&["git", "branch", "--show-current"], &main_dir);

        run_cmd(&["git", "checkout", "-b", "sub_branch"], &main_dir);
        run_cmd(
            &[
                "git",
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                sub_dir.to_str().unwrap(),
                "component",
            ],
            &main_dir,
        );
        run_cmd(
            &["git", "commit", "-m", "add submodule component"],
            &main_dir,
        );

        run_cmd(&["git", "checkout", &main_default_branch], &main_dir);
        if main_dir.join("component").exists() {
            let _ = std::fs::remove_dir_all(main_dir.join("component"));
        }
        run_cmd(&["git", "checkout", "-b", "file_branch"], &main_dir);
        std::fs::write(main_dir.join("component"), "regular file content\n").unwrap();
        run_cmd(&["git", "add", "component"], &main_dir);
        run_cmd(
            &["git", "commit", "-m", "add regular file component"],
            &main_dir,
        );

        let _ = std::process::Command::new("git")
            .args(["merge", "sub_branch"])
            .current_dir(&main_dir)
            .output();

        if main_dir.join("component").is_dir() {
            std::fs::write(
                main_dir.join("component").join("precious_uncommitted.txt"),
                "UNCOMMITTED WORK",
            )
            .unwrap();
        }

        let repo = RepositoryMeta {
            id: "repo".into(),
            name: "Repo".into(),
            root_path: main_dir.to_string_lossy().into(),
            color: "#fff".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let token = CancellationToken::new();

        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let res =
                conflict_accept(&repo, "component", ConflictChoice::Mine, false, &token).await;
            assert!(
                res.is_err(),
                "Accepting submodule type-change conflict should be rejected"
            );
            let err = res.err().unwrap();
            assert!(
                err.code == "SUBMODULE_TYPE_CHANGE_MANUAL" || err.code == "SUBMODULE_DIRTY",
                "Expected type change error, got: {}",
                err.code
            );

            if main_dir.join("component").is_dir() {
                assert!(
                    main_dir
                        .join("component")
                        .join("precious_uncommitted.txt")
                        .exists(),
                    "Uncommitted file inside submodule must be preserved!"
                );
            }
        });
    }

    #[tokio::test]
    async fn svn_incoming_probe_failure_does_not_pollute_new_revision_with_old_count() {
        let repo = RepositoryMeta {
            id: "svn-pollute-test-repo".into(),
            name: "SvnPolluteTest".into(),
            root_path: "/nonexistent/test/svn/path".into(),
            color: "#000".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };

        // 1. 旧修订号 100 曾缓存了 behind = 5
        set_svn_incoming_cached_for_test(&repo.id, 100, 5);

        // 2. 工作副本变迁到新修订号 105，触发读取（此路径由于路径不存在，probe 必定失败）
        let initial_behind = svn_incoming_revisions_cached(&repo, "105");
        assert_eq!(initial_behind, 0);

        // 等待后台 probe 异步执行完成
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        // 3. 核心断言：失败后绝不能将旧修订号 100 的 5 写入新修订号 105 之下！
        let fresh_behind_from_cache = svn_incoming_cached_behind(&repo.id, "105");
        assert_eq!(fresh_behind_from_cache, None);

        // 再次读取也不会读出失效的旧计数 5
        let recheck_behind = svn_incoming_revisions_cached(&repo, "105");
        assert_eq!(recheck_behind, 0);

        invalidate_svn_ref_caches(&repo.id);
    }

    #[tokio::test(start_paused = true)]
    async fn svn_incoming_probe_chains_pending_new_revision_and_prevents_stale_overwrite() {
        let repo = RepositoryMeta {
            id: "svn-chain-test-repo".into(),
            name: "SvnChainTest".into(),
            root_path: "/test/svn/chain/path".into(),
            color: "#000".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };

        invalidate_svn_ref_caches(&repo.id);

        // Keep the probe-chain test independent of real SVN startup and I/O.
        set_svn_wc_revision_for_test(&repo.id, Some(105));

        // 安装 mock 处理函数：
        // 探测 r100 耗时 80ms，返回 Ok(0)（计数无变化）
        // 探测 r105 耗时 10ms，返回 Ok(4)（新修订号有 4 个待更新提交）
        set_svn_incoming_mock_handler_for_test(
            &repo.id,
            Some(Box::new(|rev| {
                if rev == 100 {
                    Some((Duration::from_millis(80), Ok(0)))
                } else if rev == 105 {
                    Some((Duration::from_millis(10), Ok(4)))
                } else {
                    None
                }
            })),
        );

        // 1. 发起 r100 的探测（此时进入后台运行 80ms）
        let initial_behind = svn_incoming_revisions_cached(&repo, "100");
        assert_eq!(initial_behind, 0);

        // 确认当前探测处于活跃状态，active_revision 为 100
        let state1 = get_svn_incoming_probing_state_for_test(&repo.id);
        assert_eq!(state1, Some((100, None)));

        // 2. 在 r100 探测尚未结束时（经过 15ms），工作副本更新到 r105，触发状态读取
        tokio::time::sleep(Duration::from_millis(15)).await;
        let behind_105_early = svn_incoming_revisions_cached(&repo, "105");
        assert_eq!(behind_105_early, 0);

        // 核心断言 1：新修订号 r105 绝没有被丢弃，而是被准确挂接在 pending 队列中！
        let state2 = get_svn_incoming_probing_state_for_test(&repo.id);
        assert_eq!(state2, Some((100, Some(105))));

        // 3. 等待足够时间，让 r100 完成（80ms）、自动串联启动 r105 并完成（10ms）
        tokio::time::sleep(Duration::from_millis(120)).await;

        // 核心断言 2：探测链条已全部完成并退出活跃状态
        let state3 = get_svn_incoming_probing_state_for_test(&repo.id);
        assert_eq!(state3, None);

        // 核心断言 3：r105 的真实探测结果 4 已被准确写入缓存，没有被旧 r100 的 0 覆盖，也不会发生通知漏报！
        let cached_105 = svn_incoming_cached_behind(&repo.id, "105");
        assert_eq!(cached_105, Some(4));

        let recheck_behind = svn_incoming_revisions_cached(&repo, "105");
        assert_eq!(recheck_behind, 4);

        // 清理 mock 与缓存
        set_svn_incoming_mock_handler_for_test(&repo.id, None);
        set_svn_wc_revision_for_test(&repo.id, None);
        invalidate_svn_ref_caches(&repo.id);
    }

    #[tokio::test(start_paused = true)]
    async fn svn_incoming_probe_delayed_stale_request_does_not_clear_pending_new_revision() {
        let repo = RepositoryMeta {
            id: "svn-delayed-stale-repo".into(),
            name: "SvnDelayedStale".into(),
            root_path: "/test/svn/delayed/path".into(),
            color: "#000".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };

        invalidate_svn_ref_caches(&repo.id);

        // 安装 mock：
        // r100 探测耗时 80ms，返回 Ok(0)（计数无变化）
        // r105 探测耗时 10ms，返回 Ok(3)（新修订号有 3 个待更新提交）
        set_svn_incoming_mock_handler_for_test(
            &repo.id,
            Some(Box::new(|rev| {
                if rev == 100 {
                    Some((Duration::from_millis(80), Ok(0)))
                } else if rev == 105 {
                    Some((Duration::from_millis(10), Ok(3)))
                } else {
                    None
                }
            })),
        );

        // 模拟真实工作副本此时已经变迁到 r105
        set_svn_wc_revision_for_test(&repo.id, Some(105));

        // 1. 发起 r100 探测（旧状态读取）
        let _ = svn_incoming_revisions_cached(&repo, "100");
        assert_eq!(
            get_svn_incoming_probing_state_for_test(&repo.id),
            Some((100, None))
        );

        // 2. 15ms 后，工作副本更新到 r105，触发状态读取，挂接 pending = 105
        tokio::time::sleep(Duration::from_millis(15)).await;
        let _ = svn_incoming_revisions_cached(&repo, "105");
        assert_eq!(
            get_svn_incoming_probing_state_for_test(&repo.id),
            Some((100, Some(105)))
        );

        // 3. 30ms 后，一个较早发起的旧状态请求（如早前发起的并发扫描）延迟到达，再次传入 r100
        tokio::time::sleep(Duration::from_millis(15)).await;
        let _ = svn_incoming_revisions_cached(&repo, "100");

        // 核心断言 1：迟到的旧请求绝不会把 r105 的待探测任务清除！pending 依然牢固保持为 Some(105)
        assert_eq!(
            get_svn_incoming_probing_state_for_test(&repo.id),
            Some((100, Some(105)))
        );

        // 4. 等待足够时间，让 r100 结束（80ms）并自动重查工作副本（确认当前真实为 105），串联执行 r105 探测（10ms）
        tokio::time::sleep(Duration::from_millis(120)).await;

        // 核心断言 2：r105 探测成功完成并写入缓存，通知得以正常发布，未发生任何漏报！
        assert_eq!(svn_incoming_cached_behind(&repo.id, "105"), Some(3));
        assert_eq!(svn_incoming_revisions_cached(&repo, "105"), 3);

        set_svn_incoming_mock_handler_for_test(&repo.id, None);
        set_svn_wc_revision_for_test(&repo.id, None);
        invalidate_svn_ref_caches(&repo.id);
    }

    #[tokio::test(start_paused = true)]
    async fn svn_incoming_probe_real_rollback_recheck_adopts_active_result() {
        let repo = RepositoryMeta {
            id: "svn-rollback-recheck-repo".into(),
            name: "SvnRollbackRecheck".into(),
            root_path: "/test/svn/rollback/path".into(),
            color: "#000".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };

        invalidate_svn_ref_caches(&repo.id);

        // 安装 mock：
        // r200 探测耗时 80ms，返回 Ok(2)
        set_svn_incoming_mock_handler_for_test(
            &repo.id,
            Some(Box::new(|rev| {
                if rev == 200 {
                    Some((Duration::from_millis(80), Ok(2)))
                } else {
                    None
                }
            })),
        );

        // 1. 发起 r200 探测
        let _ = svn_incoming_revisions_cached(&repo, "200");
        assert_eq!(
            get_svn_incoming_probing_state_for_test(&repo.id),
            Some((200, None))
        );

        // 2. 状态曾短暂更新到 205，排队 pending
        tokio::time::sleep(Duration::from_millis(15)).await;
        let _ = svn_incoming_revisions_cached(&repo, "205");
        assert_eq!(
            get_svn_incoming_probing_state_for_test(&repo.id),
            Some((200, Some(205)))
        );

        // 3. 模拟用户真实执行了 svn update -r 200 回滚操作，工作副本真实变回 200
        set_svn_wc_revision_for_test(&repo.id, Some(200));

        // 4. 等待 r200 探测完成（80ms）
        tokio::time::sleep(Duration::from_millis(100)).await;

        // 核心断言：旧任务结束后重查真实工作副本为 200，精确判定为真实回滚，直接采纳已完成的 200 结果（2），且未发起多余探测！
        assert_eq!(svn_incoming_cached_behind(&repo.id, "200"), Some(2));
        assert_eq!(svn_incoming_revisions_cached(&repo, "200"), 2);
        assert_eq!(get_svn_incoming_probing_state_for_test(&repo.id), None);

        set_svn_incoming_mock_handler_for_test(&repo.id, None);
        set_svn_wc_revision_for_test(&repo.id, None);
        invalidate_svn_ref_caches(&repo.id);
    }

    #[tokio::test(start_paused = true)]
    async fn svn_incoming_probe_branch_switch_invalidation_prevents_stale_writeback() {
        let repo = RepositoryMeta {
            id: "svn-branch-switch-repo".into(),
            name: "SvnBranchSwitch".into(),
            root_path: "/test/svn/branch/switch/path".into(),
            color: "#000".into(),
            kind: VcsKind::Svn,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };

        invalidate_svn_ref_caches(&repo.id);

        // 安装 mock 处理函数：
        // 旧分支探测 r100 耗时 80ms，返回 Ok(7)（代表旧分支有 7 个待更新修订）
        set_svn_incoming_mock_handler_for_test(
            &repo.id,
            Some(Box::new(|rev| {
                if rev == 100 {
                    Some((Duration::from_millis(80), Ok(7)))
                } else {
                    None
                }
            })),
        );

        // 1. 发起原分支的 r100 探测（进入后台运行 80ms）
        let initial_behind = svn_incoming_revisions_cached(&repo, "100");
        assert_eq!(initial_behind, 0);

        // 确认原分支探测当前处于活跃状态，active_revision 为 100
        let state1 = get_svn_incoming_probing_state_for_test(&repo.id);
        assert_eq!(state1, Some((100, None)));

        // 2. 在探测运行中（15ms 后），用户执行切换分支操作！
        // 切换分支触发 invalidate_svn_ref_caches，代次递增，任务被标记取消并从 probing 移除
        tokio::time::sleep(Duration::from_millis(15)).await;
        invalidate_svn_ref_caches(&repo.id);

        // 确认此时 probing 已被清除，缓存也为空
        assert_eq!(get_svn_incoming_probing_state_for_test(&repo.id), None);
        assert_eq!(svn_incoming_cached_behind(&repo.id, "100"), None);

        // 3. 等待足够时间（100ms），让原分支的旧探测异步任务完成
        tokio::time::sleep(Duration::from_millis(100)).await;

        // 核心断言 1：旧任务结束时由于代次不匹配/已取消，绝对禁止把旧分支的 7 写回缓存！
        assert_eq!(
            svn_incoming_cached_behind(&repo.id, "100"),
            None,
            "旧分支的待更新数绝不能写回到缓存中！"
        );

        // 核心断言 2：新分支的本地修订号碰巧也是 100 时，状态读取绝不会读到旧分支的错误计数 7！
        let fresh_behind_on_new_branch = svn_incoming_cached_behind(&repo.id, "100");
        assert_eq!(fresh_behind_on_new_branch, None);

        set_svn_incoming_mock_handler_for_test(&repo.id, None);
        set_svn_wc_revision_for_test(&repo.id, None);
        invalidate_svn_ref_caches(&repo.id);
    }
}

pub async fn current_branch_for_protection(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    if repo.kind != VcsKind::Git {
        return Ok(String::new());
    }
    Ok(
        git(vec!["branch".into(), "--show-current".into()], repo, token)
            .await?
            .stdout_text()
            .trim()
            .to_string(),
    )
}
