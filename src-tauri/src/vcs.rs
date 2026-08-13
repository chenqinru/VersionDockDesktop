use std::path::Path;

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cli,
    models::{
        BranchCompareResult, BranchInfo, BranchOperation, CommitDetail, CommitFile, CommitNode,
        ConflictChoice, DesktopError, DiffDocument, HistoryPage, MergeVersions, RemoteInfo,
        RemoteOperation, RepositoryMeta, StashEntry, StashOperation, SyncAction, TagInfo,
        TagOperation, VcsKind, WorktreeEntry, WorktreeOperation,
    },
    state::safe_relative,
};

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';
const DIFF_MAX_BYTES: usize = 5 * 1024 * 1024;
const DIFF_MAX_LINES: usize = 50_000;

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
    token: &CancellationToken,
) -> Result<DiffDocument, DesktopError> {
    let root = Path::new(&repo.root_path);
    let safe = relative_path(root, path, false)?;
    let output = match repo.kind {
        VcsKind::Git => {
            if let Some(value) = revision {
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
            if let Some(value) = revision {
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
            })
        })
        .collect()
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
            let stats = git(
                vec![
                    "show".into(),
                    "--numstat".into(),
                    "--format=".into(),
                    revision.into(),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text();
            let statuses = git(
                vec![
                    "show".into(),
                    "--name-status".into(),
                    "--format=".into(),
                    revision.into(),
                ],
                repo,
                token,
            )
            .await?
            .stdout_text();
            Ok(CommitDetail {
                commit,
                full_message: full_message.trim().into(),
                files: merge_git_files(&stats, &statuses),
            })
        }
        VcsKind::Svn => {
            validate_svn_revision(revision)?;
            let page = svn_history(repo, 0, 1, None, token).await?;
            let mut commit = page
                .commits
                .into_iter()
                .find(|item| item.hash == revision)
                .unwrap_or(CommitNode {
                    repo_id: repo.id.clone(),
                    hash: revision.into(),
                    short_hash: format!("r{revision}"),
                    parents: vec![],
                    author: String::new(),
                    email: String::new(),
                    author_date: String::new(),
                    committer_date: String::new(),
                    message: format!("SVN revision {revision}"),
                    refs: vec![],
                });
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
            let full_message = entry
                .and_then(|node| node.children().find(|child| child.has_tag_name("msg")))
                .and_then(|node| node.text())
                .unwrap_or("")
                .to_string();
            commit.message = full_message
                .lines()
                .next()
                .unwrap_or(&commit.message)
                .into();
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
            })
        }
    }
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
    ensure_git(repo)?;
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
                upstream: (!fields[3].is_empty()).then(|| fields[3].into()),
                ahead: parse_counter(fields[4], "ahead "),
                behind: parse_counter(fields[4], "behind "),
            })
        })
        .collect())
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
    ensure_git(repo)?;
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
}
