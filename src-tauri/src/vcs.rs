use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cli,
    models::{
        BranchCompareResult, BranchInfo, BranchOperation, CommitBranches, CommitDetail, CommitFile,
        CommitNode, ConflictChoice, DesktopError, DiffDocument, HistoryPage, MergeCommitSummary,
        MergeVersions, RemoteInfo, RemoteOperation, RepositoryMeta, StashEntry, StashOperation,
        SubtreeEntry, SubtreeOperation, SubtreeState, SyncAction, TagInfo, TagOperation,
        UnpushedCommit, VcsKind, WorktreeEntry, WorktreeOperation,
    },
    state::safe_relative,
};

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';
const DIFF_MAX_BYTES: usize = 5 * 1024 * 1024;
const DIFF_MAX_LINES: usize = 50_000;
const SUBTREE_CONFIG_PREFIX: &str = "versiondock.subtree.";

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
    let mut safe = vec!["--non-interactive".into()];
    safe.extend(args);
    execute("svn", safe, repo, token).await
}

fn literal_path(root: &Path, value: &str, include_leaf: bool) -> Result<String, DesktopError> {
    safe_relative(root, value, include_leaf)?;
    Ok(format!(":(literal){value}"))
}

fn relative_path(root: &Path, value: &str, include_leaf: bool) -> Result<String, DesktopError> {
    safe_relative(root, value, include_leaf)?;
    Ok(value.replace('\\', "/"))
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
                validate_revision(&from)?;
                validate_revision(&to)?;
                git(
                    vec![
                        "diff".into(),
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
    let binary = bytes.contains(&0) || String::from_utf8_lossy(&bytes).contains("Binary files");
    let content = String::from_utf8_lossy(&bytes).into_owned();
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

pub async fn stage(
    repo: &RepositoryMeta,
    paths: &[String],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
    if paths.is_empty() {
        return Ok(());
    }
    let root = Path::new(&repo.root_path);
    let mut args = vec!["add".into(), "--".into()];
    args.extend(
        paths
            .iter()
            .map(|path| literal_path(root, path, true))
            .collect::<Result<Vec<_>, _>>()?,
    );
    git(args, repo, token).await?;
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

pub async fn commit(
    repo: &RepositoryMeta,
    message: &str,
    amend: bool,
    paths: &[String],
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
            Ok(output.stdout_text())
        }
    }
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

pub async fn sync(
    repo: &RepositoryMeta,
    action: SyncAction,
    remote: Option<String>,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    if repo.kind == VcsKind::Git && matches!(action, SyncAction::Push) {
        return git_push(repo, remote, token).await;
    }
    let (program, args) = match (repo.kind, action) {
        (VcsKind::Git, SyncAction::Fetch) => (
            "git",
            vec!["fetch".into(), "--all".into(), "--prune".into()],
        ),
        (VcsKind::Git, SyncAction::Pull) => ("git", vec!["pull".into(), "--ff-only".into()]),
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
    Ok(cli::run(
        program,
        &safe,
        Path::new(&repo.root_path),
        None,
        cli::NETWORK_TIMEOUT,
        token,
    )
    .await?
    .stdout_text())
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
    filter: Option<String>,
    token: &CancellationToken,
) -> Result<HistoryPage, DesktopError> {
    let limit = limit.clamp(1, 500);
    match repo.kind {
        VcsKind::Git => git_history(repo, skip, limit, filter, token).await,
        VcsKind::Svn => svn_history(repo, skip, limit, filter, token).await,
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

async fn git_history(
    repo: &RepositoryMeta,
    skip: u32,
    limit: u32,
    filter: Option<String>,
    token: &CancellationToken,
) -> Result<HistoryPage, DesktopError> {
    let format = format!(
        "%H{FIELD}%h{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%aI{FIELD}%cI{FIELD}%s{FIELD}%D{RECORD}"
    );
    let mut args = vec![
        "log".into(),
        "--all".into(),
        format!("--skip={skip}"),
        format!("--max-count={}", limit + 1),
        format!("--format={format}"),
        "--date=iso-strict".into(),
    ];
    if let Some(value) = filter.filter(|value| !value.trim().is_empty()) {
        args.push("--regexp-ignore-case".to_string());
        args.push(format!("--grep={}", value.trim()));
    }
    let raw = git(args, repo, token).await?.stdout_text();
    let mut commits = parse_git_log(&repo.id, &raw);
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
    filter: Option<String>,
    token: &CancellationToken,
) -> Result<HistoryPage, DesktopError> {
    let requested = skip.saturating_add(limit).saturating_add(1).min(5_000);
    let raw = svn(
        vec![
            "log".into(),
            "--xml".into(),
            "-r".into(),
            "HEAD:0".into(),
            "--limit".into(),
            requested.to_string(),
        ],
        repo,
        token,
    )
    .await?
    .stdout_text();
    let document = roxmltree::Document::parse(&raw)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let needle = filter.unwrap_or_default().to_lowercase();
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
            let message = text("msg").lines().next().unwrap_or("").to_string();
            let author = text("author").to_string();
            if !needle.is_empty()
                && !message.to_lowercase().contains(&needle)
                && !author.to_lowercase().contains(&needle)
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
                author_date: text("date").into(),
                committer_date: text("date").into(),
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
                async { Ok::<_, DesktopError>(git(stats_args, repo, token).await?.stdout_text()) },
                async { Ok::<_, DesktopError>(git(status_args, repo, token).await?.stdout_text()) },
            )?;
            let branches = containing_branches(repo, &commit.hash, token).await?;
            Ok(CommitDetail {
                commit,
                full_message: full_message.trim().into(),
                files: merge_git_files(&stats, &statuses),
                branches,
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
            })
        }
    }
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
) -> Result<(), DesktopError> {
    ensure_git(repo)?;
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
    git(args, repo, token).await?;
    Ok(())
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
    if value.is_empty() {
        return Err(DesktopError::new(
            "SVN_BRANCH_UNAVAILABLE",
            "SVN working copy has no relative repository URL",
            true,
        ));
    }
    Ok(value)
}

fn svn_display_ref(relative_url: &str) -> (String, Option<String>) {
    let relative_url = relative_url.trim_start_matches("^/").trim_matches('/');
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
        TagOperation::Push { name, remote } => {
            validate_ref(&name)?;
            validate_ref(&remote)?;
            vec!["push".into(), remote, format!("refs/tags/{name}")]
        }
    };
    git(args, repo, token).await?;
    Ok(())
}

pub async fn stashes(
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<Vec<StashEntry>, DesktopError> {
    ensure_git(repo)?;
    let format = format!("%gd{FIELD}%H{FIELD}%gs{FIELD}%cI{RECORD}");
    let raw = git(
        vec!["stash".into(), "list".into(), format!("--format={format}")],
        repo,
        token,
    )
    .await?
    .stdout_text();
    Ok(raw
        .split(RECORD)
        .filter_map(|record| {
            let fields = record.trim().split(FIELD).collect::<Vec<_>>();
            if fields.len() < 4 || !valid_stash_ref(fields[0]) {
                return None;
            }
            let subject = fields[2].trim();
            let (branch, message) = subject
                .strip_prefix("On ")
                .and_then(|value| value.split_once(": "))
                .map(|(branch, message)| (branch.to_string(), message.to_string()))
                .unwrap_or_else(|| (String::new(), subject.to_string()));
            Some(StashEntry {
                reference: fields[0].into(),
                hash: fields[1].into(),
                branch,
                message,
                date: fields[3].into(),
            })
        })
        .collect())
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
    entries.sort_by(|left, right| {
        left.prefix
            .cmp(&right.prefix)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(entries)
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
        SubtreeOperation::Remove { subtree_id } => {
            let entry = registered_subtree(repo, &subtree_id, token).await?;
            remove_subtree_config_strict(repo, &entry.id, token).await?;
            Ok(())
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
        || validate_ref(&remote).is_err()
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
    for (field, value) in [
        ("version", "1"),
        ("prefix", entry.prefix.as_str()),
        ("remote", entry.remote.as_str()),
        ("branch", entry.branch.as_str()),
        ("squash", if entry.squash { "true" } else { "false" }),
        ("state", "pending"),
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

async fn validate_subtree_remote(
    repo: &RepositoryMeta,
    value: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    validate_ref(value).map_err(|_| {
        DesktopError::new(
            "INVALID_SUBTREE_REMOTE",
            "Subtree remote must be an existing Git remote name",
            false,
        )
    })?;
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
            let entry = managed_worktree(repo, &path, token).await?;
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
            let entry = managed_worktree(repo, &path, token).await?;
            git(
                vec!["worktree".into(), "lock".into(), entry.path],
                repo,
                token,
            )
            .await?;
        }
        WorktreeOperation::Unlock { path } => {
            let entry = managed_worktree(repo, &path, token).await?;
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
    worktrees(repo, token)
        .await?
        .into_iter()
        .find(|entry| entry.path == path)
        .ok_or_else(|| DesktopError::new("WORKTREE_NOT_FOUND", "Worktree not found", true))
}

pub async fn conflict_versions(
    repo: &RepositoryMeta,
    path: &str,
    token: &CancellationToken,
) -> Result<MergeVersions, DesktopError> {
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, false)?;
    let working_bytes = tokio::fs::read(root.join(&safe))
        .await
        .map_err(|error| DesktopError::new("FILE_READ_FAILED", error.to_string(), true))?;
    let binary = working_bytes.contains(&0);
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
    Ok(MergeVersions {
        path: safe.clone(),
        base,
        ours,
        theirs,
        working: working.clone(),
        language: language_for(&safe),
        fingerprint: fingerprint(working.as_bytes()),
        binary,
    })
}

pub async fn conflict_save(
    repo: &RepositoryMeta,
    path: &str,
    content: &str,
    expected: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    if content.contains("<<<<<<<") || content.contains("=======") || content.contains(">>>>>>>") {
        return Err(DesktopError::new(
            "UNRESOLVED_MARKERS",
            "Conflict markers remain in the result",
            true,
        ));
    }
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, true)?;
    let target = root.join(&safe);
    let current = tokio::fs::read(&target)
        .await
        .map_err(|error| DesktopError::new("FILE_READ_FAILED", error.to_string(), true))?;
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

fn language_for(path: &str) -> String {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "py" => "python",
        "java" => "java",
        "kt" => "kotlin",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "html" => "html",
        "css" | "scss" => "css",
        "md" => "markdown",
        "sql" => "sql",
        "sh" | "zsh" => "shell",
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
