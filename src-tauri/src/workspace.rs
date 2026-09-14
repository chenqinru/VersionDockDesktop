use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cli,
    models::{
        CapabilityStatus, DesktopError, DesktopSettings, FileChange, RepositoryCapabilities,
        RepositoryMeta, RepositoryStatus, SecureCredentialCapability, ToolAvailability, VcsKind,
        WorkspaceDescriptor, WorkspaceSnapshot,
    },
    state::{canonical_directory, workspace_id},
};

const COLORS: [&str; 8] = [
    "#4EC9B0", "#569CD6", "#C586C0", "#DCDCAA", "#CE9178", "#9CDCFE", "#B5CEA8", "#D7BA7D",
];
const SKIP: [&str; 11] = [
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
];

pub async fn tool_availability(token: &CancellationToken) -> ToolAvailability {
    let git = cli::run(
        "git",
        &["--version".into()],
        Path::new("."),
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await;
    let svn = cli::run(
        "svn",
        &["--version".into(), "--quiet".into()],
        Path::new("."),
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await;
    ToolAvailability {
        git: git.is_ok(),
        svn: svn.is_ok(),
        svnadmin: cli::run(
            "svnadmin",
            &["--version".into(), "--quiet".into()],
            Path::new("."),
            None,
            cli::DEFAULT_TIMEOUT,
            token,
        )
        .await
        .is_ok(),
        git_version: git.ok().map(|value| {
            value
                .stdout_text()
                .trim()
                .trim_start_matches("git version ")
                .to_string()
        }),
        svn_version: svn.ok().map(|value| value.stdout_text().trim().to_string()),
    }
}

pub fn descriptor(paths: Vec<String>) -> Result<WorkspaceDescriptor, DesktopError> {
    let canonical = paths
        .iter()
        .map(|path| canonical_directory(path))
        .collect::<Result<Vec<_>, _>>()?;
    let path_strings = canonical
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let name = if canonical.len() == 1 {
        canonical[0]
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Workspace")
            .to_string()
    } else {
        format!("{} roots", canonical.len())
    };
    Ok(WorkspaceDescriptor {
        id: workspace_id(&path_strings),
        name,
        paths: path_strings,
        last_opened_at: Utc::now().to_rfc3339(),
        available: true,
    })
}

pub async fn snapshot(
    workspace: WorkspaceDescriptor,
    generation: u32,
    settings: &DesktopSettings,
    token: &CancellationToken,
) -> Result<WorkspaceSnapshot, DesktopError> {
    let tools = tool_availability(token).await;
    let secure_credentials = crate::svn_account::secure_store_capability().await;
    let metas = scan(&workspace, settings)?;
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let mut tasks = tokio::task::JoinSet::new();
    for (index, meta) in metas.into_iter().enumerate() {
        let semaphore = semaphore.clone();
        let token = token.clone();
        let tools = tools.clone();
        let secure_credentials = secure_credentials.clone();
        tasks.spawn(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .map_err(|_| DesktopError::new("APP_CLOSING", "Application is closing", true))?;
            let tool_available = match meta.kind {
                VcsKind::Git => tools.git,
                VcsKind::Svn => tools.svn,
            };
            let mut status = match meta.kind {
                VcsKind::Git if tools.git => git_status(meta, &token).await,
                VcsKind::Svn if tools.svn => svn_status(meta, &token).await,
                _ => Ok(empty_status(meta, tool_available)),
            }?;
            apply_runtime_capabilities(&mut status, &tools, &secure_credentials);
            Ok::<_, DesktopError>((index, status))
        });
    }
    let mut indexed = Vec::new();
    while let Some(result) = tasks.join_next().await {
        indexed.push(
            result.map_err(|error| {
                DesktopError::new("STATUS_TASK_FAILED", error.to_string(), true)
            })??,
        );
    }
    indexed.sort_by_key(|(index, _)| *index);
    let mut repositories = indexed
        .into_iter()
        .map(|(_, status)| status)
        .collect::<Vec<_>>();
    apply_nested_git_ownership(&mut repositories);
    Ok(WorkspaceSnapshot {
        workspace,
        repositories,
        generation,
        tools,
    })
}

pub fn apply_nested_git_ownership(repositories: &mut [RepositoryStatus]) {
    let metas = repositories
        .iter()
        .map(|repository| repository.meta.clone())
        .collect::<Vec<_>>();
    apply_nested_git_ownership_with_metas(repositories, &metas);
}

pub fn apply_nested_git_ownership_with_metas(
    repositories: &mut [RepositoryStatus],
    metas: &[RepositoryMeta],
) {
    let nested = metas
        .iter()
        .filter(|repository| repository.kind == VcsKind::Git && !repository.is_submodule)
        .cloned()
        .collect::<Vec<_>>();
    for parent in repositories
        .iter_mut()
        .filter(|repository| repository.meta.kind == VcsKind::Git)
    {
        let parent_root = Path::new(&parent.meta.root_path);
        let child_paths = nested
            .iter()
            .filter_map(|child| {
                let child_root = Path::new(&child.root_path);
                (child.id != parent.meta.id && child_root.starts_with(parent_root))
                    .then(|| child_root.strip_prefix(parent_root).ok())
                    .flatten()
                    .map(|path| path.to_string_lossy().replace('\\', "/"))
                    .filter(|path| !path.is_empty())
            })
            .collect::<Vec<_>>();
        if child_paths.is_empty() {
            continue;
        }
        parent.files.retain(|file| {
            !child_paths
                .iter()
                .any(|child| file.path == *child || file.path.starts_with(&format!("{child}/")))
        });
        parent.conflicts = parent.files.iter().filter(|file| file.conflicted).count() as u32;
    }
}

pub fn scan(
    workspace: &WorkspaceDescriptor,
    settings: &DesktopSettings,
) -> Result<Vec<RepositoryMeta>, DesktopError> {
    let mut discovered = Vec::<(PathBuf, VcsKind)>::new();
    let mut seen = HashSet::new();
    for root in &workspace.paths {
        let root = canonical_directory(root)?;
        walk(
            &root,
            &root,
            0,
            settings.repository_scan_depth as usize,
            &settings.ignored_folders,
            settings.exclude_ignored_directories,
            &mut discovered,
            &mut seen,
        )?;
    }
    discovered.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| kind_rank(left.1).cmp(&kind_rank(right.1)))
    });
    let paths = discovered
        .iter()
        .map(|(path, kind)| (path.clone(), *kind, repo_id(path, *kind)))
        .collect::<Vec<_>>();
    Ok(paths
        .iter()
        .enumerate()
        .map(|(index, (path, kind, id))| {
            let parent = paths
                .iter()
                .filter(|(candidate, _, candidate_id)| {
                    candidate_id != id && path.starts_with(candidate) && path != candidate
                })
                .max_by_key(|(candidate, candidate_kind, _)| {
                    (
                        candidate.components().count(),
                        u8::from(*kind == VcsKind::Git && *candidate_kind == VcsKind::Git),
                    )
                });
            let depth = parent
                .map(|_| {
                    paths
                        .iter()
                        .filter(|(candidate, _, _)| {
                            path.starts_with(candidate) && path != candidate
                        })
                        .count() as u32
                })
                .unwrap_or(0);
            let git_file = path.join(".git");
            let is_worktree = *kind == VcsKind::Git && git_file.is_file();
            let is_submodule = *kind == VcsKind::Git
                && paths.iter().any(|(parent_path, parent_kind, parent_id)| {
                    if *parent_kind != VcsKind::Git
                        || parent_id == id
                        || !path.starts_with(parent_path)
                        || path == parent_path
                    {
                        return false;
                    }
                    let relative = path
                        .strip_prefix(parent_path)
                        .ok()
                        .map(|value| value.to_string_lossy().replace('\\', "/"));
                    relative
                        .is_some_and(|value| declared_submodule_paths(parent_path).contains(&value))
                });
            RepositoryMeta {
                id: id.clone(),
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("repository")
                    .to_string(),
                root_path: path.to_string_lossy().into_owned(),
                color: settings
                    .project_colors
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| COLORS[index % COLORS.len()].into()),
                kind: *kind,
                parent_repo_id: parent.map(|(_, _, candidate_id)| candidate_id.clone()),
                depth,
                is_submodule,
                is_worktree,
            }
        })
        .collect())
}

fn parse_gitignore_ignored_dirs(dir: &Path) -> Vec<String> {
    let gitignore = dir.join(".gitignore");
    let Ok(content) = std::fs::read_to_string(gitignore) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
                return None;
            }
            let pattern = trimmed.trim_start_matches('/').trim_end_matches('/');
            if pattern.is_empty() || pattern.contains('*') || pattern.contains('/') {
                return None;
            }
            Some(pattern.to_string())
        })
        .collect()
}

fn walk(
    root: &Path,
    current: &Path,
    depth: usize,
    max_depth: usize,
    ignored_folders: &[String],
    exclude_ignored_directories: bool,
    result: &mut Vec<(PathBuf, VcsKind)>,
    seen: &mut HashSet<String>,
) -> Result<(), DesktopError> {
    if depth <= max_depth && current.join(".git").exists() {
        let key = format!("{}::git", current.display());
        if seen.insert(key) {
            result.push((current.to_path_buf(), VcsKind::Git));
            discover_submodules(current, 1, result, seen);
        }
    }
    if current.join(".svn").is_dir() {
        let key = format!("{}::svn", current.display());
        if seen.insert(key) {
            result.push((current.to_path_buf(), VcsKind::Svn));
        }
        return Ok(());
    }
    if depth >= max_depth {
        return Ok(());
    }
    let local_ignored = if exclude_ignored_directories {
        parse_gitignore_ignored_dirs(current)
    } else {
        Vec::new()
    };
    for entry in std::fs::read_dir(current)
        .map_err(|error| DesktopError::new("WORKSPACE_SCAN_FAILED", error.to_string(), true))?
    {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = entry
            .path()
            .strip_prefix(root)
            .ok()
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        if SKIP.contains(&name.as_str())
            || name.contains(".vd-staging-")
            || ignored_folders
                .iter()
                .any(|ignored| ignored == &name || relative.as_ref() == Some(ignored))
            || local_ignored.iter().any(|ignored| ignored == &name)
        {
            continue;
        }
        let child = entry.path();
        let next_depth = child
            .strip_prefix(root)
            .map(|suffix| suffix.components().count())
            .unwrap_or(depth + 1);
        let has_git = child.join(".git").exists();
        if next_depth <= max_depth || !has_git {
            walk(
                root,
                &child,
                next_depth,
                max_depth,
                ignored_folders,
                exclude_ignored_directories,
                result,
                seen,
            )?;
        }
    }
    Ok(())
}

fn discover_submodules(
    parent: &Path,
    depth: usize,
    result: &mut Vec<(PathBuf, VcsKind)>,
    seen: &mut HashSet<String>,
) {
    if depth > 5 {
        return;
    }
    let Ok(contents) = std::fs::read_to_string(parent.join(".gitmodules")) else {
        return;
    };
    for line in contents.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "path" {
            continue;
        }
        let path = value.trim();
        if path.is_empty()
            || Path::new(path).is_absolute()
            || path.split('/').any(|part| part == "..")
        {
            continue;
        }
        let child = parent.join(path);
        if !child.starts_with(parent) || !child.exists() {
            continue;
        }
        let key = format!("{}::git", child.display());
        if seen.insert(key) {
            result.push((child.clone(), VcsKind::Git));
        }
        discover_submodules(&child, depth + 1, result, seen);
    }
}

pub async fn git_status(
    meta: RepositoryMeta,
    token: &CancellationToken,
) -> Result<RepositoryStatus, DesktopError> {
    let root_path = meta.root_path.clone();
    let root = Path::new(&root_path);
    let output = cli::run(
        "git",
        &[
            "-c".into(),
            "core.quotepath=false".into(),
            "status".into(),
            "--porcelain=v1".into(),
            "-z".into(),
            "--branch".into(),
            "--untracked-files=all".into(),
        ],
        root,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await?;
    let raw = output.stdout_text();
    let mut fields = raw.split('\0').filter(|value| !value.is_empty());
    let header = fields.next().unwrap_or("## HEAD");
    let (branch, ahead, behind) = parse_git_header(header);
    let submodule_paths = declared_submodule_paths(root);
    let mut files = Vec::new();
    while let Some(record) = fields.next() {
        if record.len() < 3 {
            continue;
        }
        let xy = &record.as_bytes()[..2];
        let path = record[3..].to_string();
        if xy[0] == b'R' || xy[0] == b'C' {
            // Porcelain v1 -z emits destination first, then the original path.
            let _original_path = fields.next();
        }
        let conflicted = matches!(xy, b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU");
        let submodule = submodule_paths.contains(&path);
        files.push(FileChange {
            path,
            status: if submodule {
                "submodule".into()
            } else {
                status_label(xy).into()
            },
            staged: xy[0] != b' ' && xy[0] != b'?' && !conflicted,
            unstaged: xy[1] != b' ' && !conflicted || xy == b"??",
            conflicted,
            conflict_type: conflicted.then(|| "text".into()),
            submodule,
            is_truncated: false,
            truncation_reason: None,
        });
    }
    let revision = cli::run(
        "git",
        &["rev-parse".into(), "--short".into(), "HEAD".into()],
        root,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
    .map(|value| value.stdout_text().trim().to_string())
    .unwrap_or_default();
    let conflicts = files.iter().filter(|file| file.conflicted).count() as u32;
    Ok(RepositoryStatus {
        meta,
        branch,
        revision,
        ahead,
        behind,
        files,
        conflicts,
        operation: git_operation(root),
        capabilities: repository_capabilities(VcsKind::Git, true),
        tool_available: true,
    })
}

pub async fn svn_status(
    meta: RepositoryMeta,
    token: &CancellationToken,
) -> Result<RepositoryStatus, DesktopError> {
    let root = Path::new(&meta.root_path);
    let output = cli::run(
        "svn",
        &["status".into(), "--xml".into()],
        root,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await?;
    let xml = output.stdout_text();
    let document = roxmltree::Document::parse(&xml)
        .map_err(|error| DesktopError::new("SVN_XML_INVALID", error.to_string(), true))?;
    let mut files = Vec::new();
    for entry in document
        .descendants()
        .filter(|node| node.has_tag_name("entry"))
    {
        let Some(path) = entry.attribute("path") else {
            continue;
        };
        let relative_path = if Path::new(path).is_absolute() {
            match Path::new(path).strip_prefix(root) {
                Ok(value) => value.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            }
        } else {
            path.replace('\\', "/")
        };
        let Some(status) = entry.children().find(|node| node.has_tag_name("wc-status")) else {
            continue;
        };
        let item = status.attribute("item").unwrap_or("modified");
        let conflict_type = if status.attribute("tree-conflicted") == Some("true") {
            Some("tree".to_string())
        } else if item == "obstructed" {
            Some("obstruction".to_string())
        } else if status.attribute("props") == Some("conflicted") {
            Some("property".to_string())
        } else if item == "conflicted" {
            Some("text".to_string())
        } else {
            None
        };
        let conflicted = conflict_type.is_some();
        if item == "normal" && !conflicted {
            continue;
        }
        files.push(FileChange {
            path: relative_path,
            status: svn_status_label(item).into(),
            staged: false,
            unstaged: true,
            conflicted,
            conflict_type,
            submodule: false,
            is_truncated: false,
            truncation_reason: None,
        });
    }
    let has_unversioned_directory = files.iter().any(|file| {
        file.status == "untracked"
            && std::fs::symlink_metadata(root.join(&file.path))
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    });
    let ignores = if has_unversioned_directory {
        svn_ignore_rules(root, token).await
    } else {
        SvnIgnoreRules {
            client: Vec::new(),
            inherited: Vec::new(),
        }
    };
    let mut expanded = Vec::with_capacity(files.len());
    for file in files {
        let candidate = root.join(&file.path);
        let real_directory = std::fs::symlink_metadata(&candidate)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink());
        if file.status == "untracked" && real_directory {
            let (children, truncated, reason) =
                collect_svn_untracked(&candidate, root, &ignores, 500, 8);
            let has_children = !children.is_empty();
            if truncated {
                expanded.push(FileChange {
                    is_truncated: true,
                    truncation_reason: reason,
                    ..file.clone()
                });
            }
            expanded.extend(children);
            if !truncated && !has_children {
                expanded.push(file);
            }
        } else {
            expanded.push(file);
        }
    }
    let files = expanded;
    let info = cli::run(
        "svn",
        &["info".into(), "--show-item".into(), "relative-url".into()],
        root,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
    .map(|value| {
        value
            .stdout_text()
            .trim()
            .trim_start_matches("^/")
            .to_string()
    })
    .unwrap_or_else(|_| "SVN".into());
    let revision = cli::run(
        "svn",
        &["info".into(), "--show-item".into(), "revision".into()],
        root,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
    .map(|value| value.stdout_text().trim().to_string())
    .unwrap_or_default();
    let conflicts = files.iter().filter(|file| file.conflicted).count() as u32;
    let operation = crate::vcs::svn_merge_active(&meta, token)
        .await
        .then(|| "merge".into());
    Ok(RepositoryStatus {
        meta,
        branch: info,
        revision,
        ahead: 0,
        behind: 0,
        files,
        conflicts,
        operation,
        capabilities: repository_capabilities(VcsKind::Svn, true),
        tool_available: true,
    })
}

fn svn_status_label(item: &str) -> &'static str {
    match item {
        "unversioned" => "untracked",
        "added" => "added",
        "deleted" | "missing" => "deleted",
        "conflicted" | "obstructed" => "conflicted",
        _ => "modified",
    }
}

fn collect_svn_untracked(
    directory: &Path,
    root: &Path,
    ignores: &SvnIgnoreRules,
    max_entries: usize,
    max_depth: usize,
) -> (Vec<FileChange>, bool, Option<String>) {
    let mut files = Vec::new();
    let mut visited = 0;
    let mut truncated = false;
    let mut reason = None;
    fn walk(
        directory: &Path,
        root: &Path,
        ignores: &SvnIgnoreRules,
        depth: usize,
        max_depth: usize,
        max_entries: usize,
        visited: &mut usize,
        files: &mut Vec<FileChange>,
        reason: &mut Option<String>,
    ) {
        if depth > max_depth {
            *reason = Some("depth-limit".into());
            return;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            if files.len() >= max_entries || *visited >= max_entries {
                *reason = Some("entry-limit".into());
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if matches!(name.as_str(), ".git" | ".hg") || ignores.matches(&path, root, &name) {
                continue;
            }
            *visited += 1;
            let Ok(kind) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if kind.is_dir() && !kind.file_type().is_symlink() {
                walk(
                    &path,
                    root,
                    ignores,
                    depth + 1,
                    max_depth,
                    max_entries,
                    visited,
                    files,
                    reason,
                );
            } else if let Ok(relative) = path.strip_prefix(root) {
                files.push(FileChange {
                    path: relative.to_string_lossy().replace('\\', "/"),
                    status: "untracked".into(),
                    staged: false,
                    unstaged: true,
                    conflicted: false,
                    conflict_type: None,
                    submodule: false,
                    is_truncated: false,
                    truncation_reason: None,
                });
            }
        }
    }
    walk(
        directory,
        root,
        ignores,
        1,
        max_depth,
        max_entries,
        &mut visited,
        &mut files,
        &mut reason,
    );
    truncated |= reason.is_some();
    (files, truncated, reason)
}

pub(crate) struct SvnIgnoreRules {
    client: Vec<glob::Pattern>,
    inherited: Vec<(PathBuf, Vec<glob::Pattern>)>,
}

impl SvnIgnoreRules {
    pub(crate) fn matches(&self, path: &Path, root: &Path, lower_name: &str) -> bool {
        if lower_name == ".svn" {
            return true;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if self.client.iter().any(|pattern| pattern.matches(name)) {
            return true;
        }
        let relative = path.strip_prefix(root).unwrap_or(path);
        self.inherited.iter().any(|(scope, patterns)| {
            relative.starts_with(scope) && patterns.iter().any(|pattern| pattern.matches(name))
        })
    }
}

fn svn_client_ignore_patterns() -> Vec<glob::Pattern> {
    let mut config_paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        config_paths.push(PathBuf::from(home).join(".subversion/config"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        config_paths.push(PathBuf::from(appdata).join("Subversion/config"));
    }
    for path in config_paths {
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        let mut values = Vec::new();
        let mut found = false;
        let mut continuation = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty()
                || trimmed.starts_with('#')
                || trimmed.starts_with(';')
                || trimmed.starts_with('[')
            {
                continuation = false;
                continue;
            }
            if continuation && line.starts_with([' ', '\t']) {
                values.extend(trimmed.split_whitespace().map(str::to_string));
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                if key.trim().eq_ignore_ascii_case("global-ignores") {
                    found = true;
                    continuation = true;
                    values.extend(value.split_whitespace().map(str::to_string));
                    continue;
                }
            }
            continuation = false;
        }
        if found {
            return compile_svn_patterns(values);
        }
    }
    compile_svn_patterns([
        "*.o",
        "*.lo",
        "*.la",
        "*.al",
        ".libs",
        "*.so",
        "*.so.[0-9]*",
        "*.a",
        "*.pyc",
        "*.pyo",
        "__pycache__",
        "*.rej",
        "*~",
        "#*#",
        ".#*",
        ".*.swp",
        ".DS_Store",
        "[Tt]humbs.db",
    ])
}

fn compile_svn_patterns<I, S>(values: I) -> Vec<glob::Pattern>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    values
        .into_iter()
        .filter_map(|value| glob::Pattern::new(value.as_ref()).ok())
        .collect()
}

pub(crate) async fn svn_ignore_rules(root: &Path, token: &CancellationToken) -> SvnIgnoreRules {
    let client = svn_client_ignore_patterns();
    let output = cli::run(
        "svn",
        &[
            "propget".into(),
            "svn:global-ignores".into(),
            "--show-inherited-props".into(),
            "--xml".into(),
            "-R".into(),
            "--".into(),
            ".".into(),
        ],
        root,
        None,
        Duration::from_secs(5),
        token,
    )
    .await;
    let inherited = output
        .ok()
        .and_then(|value| {
            let xml = value.stdout_text();
            let document = roxmltree::Document::parse(&xml).ok()?;
            let mut rules = Vec::new();
            for target in document
                .descendants()
                .filter(|node| node.has_tag_name("target"))
            {
                let raw_scope = target.attribute("path").unwrap_or("");
                let scope = if raw_scope.contains("://") {
                    PathBuf::new()
                } else if Path::new(raw_scope).is_absolute() {
                    Path::new(raw_scope)
                        .strip_prefix(root)
                        .unwrap_or(Path::new(""))
                        .to_path_buf()
                } else {
                    PathBuf::from(raw_scope)
                };
                for property in target.descendants().filter(|node| {
                    (node.has_tag_name("property") || node.has_tag_name("inherited_property"))
                        && node.attribute("name") == Some("svn:global-ignores")
                }) {
                    let property_scope = if property.has_tag_name("inherited_property") {
                        PathBuf::new()
                    } else {
                        scope.clone()
                    };
                    let patterns =
                        compile_svn_patterns(property.text().unwrap_or("").split_whitespace());
                    if !patterns.is_empty() {
                        rules.push((property_scope, patterns));
                    }
                }
            }
            Some(rules)
        })
        .unwrap_or_default();
    SvnIgnoreRules { client, inherited }
}

fn empty_status(meta: RepositoryMeta, tool_available: bool) -> RepositoryStatus {
    let kind = meta.kind;
    RepositoryStatus {
        meta,
        branch: String::new(),
        revision: String::new(),
        ahead: 0,
        behind: 0,
        files: vec![],
        conflicts: 0,
        operation: None,
        capabilities: repository_capabilities(kind, tool_available),
        tool_available,
    }
}

fn repository_capabilities(kind: VcsKind, tool_available: bool) -> RepositoryCapabilities {
    if !tool_available {
        let mut unavailable = RepositoryCapabilities::default();
        for key in [
            "status",
            "diff",
            "commit",
            "sync",
            "history",
            "conflict",
            "stash",
            "shelf",
            "changelist",
            "worktree",
            "subtree",
            "submodule",
            "compare",
            "remoteManagement",
            "identity",
            "svnAccount",
            "fileHistory",
        ] {
            unavailable.availability.insert(
                key.into(),
                crate::models::CapabilityStatus::unavailable(
                    "VCS_TOOL_UNAVAILABLE",
                    match kind {
                        VcsKind::Git => "Git is not installed",
                        VcsKind::Svn => "SVN is not installed",
                    },
                ),
            );
        }
        return unavailable;
    }
    let mut capabilities = match kind {
        VcsKind::Git => RepositoryCapabilities {
            status: true,
            diff: true,
            commit: true,
            sync: true,
            history: true,
            conflict: true,
            stash: true,
            shelf: true,
            changelist: true,
            worktree: true,
            subtree: true,
            submodule: true,
            compare: true,
            remote_management: true,
            identity: true,
            svn_account: false,
            file_history: true,
            ..RepositoryCapabilities::default()
        },
        VcsKind::Svn => RepositoryCapabilities {
            status: true,
            diff: true,
            commit: true,
            sync: true,
            history: true,
            conflict: true,
            changelist: true,
            svn_account: true,
            file_history: true,
            ..RepositoryCapabilities::default()
        },
    };
    for (key, available) in [
        ("status", capabilities.status),
        ("diff", capabilities.diff),
        ("commit", capabilities.commit),
        ("sync", capabilities.sync),
        ("history", capabilities.history),
        ("conflict", capabilities.conflict),
        ("stash", capabilities.stash),
        ("shelf", capabilities.shelf),
        ("changelist", capabilities.changelist),
        ("worktree", capabilities.worktree),
        ("subtree", capabilities.subtree),
        ("submodule", capabilities.submodule),
        ("compare", capabilities.compare),
        ("remoteManagement", capabilities.remote_management),
        ("identity", capabilities.identity),
        ("svnAccount", capabilities.svn_account),
        ("fileHistory", capabilities.file_history),
    ] {
        capabilities.availability.insert(
            key.into(),
            if available {
                crate::models::CapabilityStatus::available()
            } else {
                crate::models::CapabilityStatus::unavailable(
                    "VCS_CAPABILITY_NOT_APPLICABLE",
                    "This capability is not available for the repository type",
                )
            },
        );
    }
    capabilities
}

fn parsed_version(value: &str) -> Option<(u32, u32, u32)> {
    let values = value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .take(3)
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    Some((
        *values.first()?,
        *values.get(1).unwrap_or(&0),
        *values.get(2).unwrap_or(&0),
    ))
}

fn unavailable(code: &str, detail: impl Into<String>) -> CapabilityStatus {
    CapabilityStatus::unavailable(code, detail)
}

fn contextual_capability(available: bool, code: &str, detail: &str) -> CapabilityStatus {
    if available {
        CapabilityStatus::available()
    } else {
        unavailable(code, detail)
    }
}

pub fn apply_runtime_capabilities(
    status: &mut RepositoryStatus,
    tools: &ToolAvailability,
    secure_credentials: &SecureCredentialCapability,
) {
    let (tool_name, version, minimum) = match status.meta.kind {
        VcsKind::Git => ("Git", tools.git_version.as_deref(), (2, 23, 0)),
        VcsKind::Svn => ("SVN", tools.svn_version.as_deref(), (1, 9, 0)),
    };
    if !status.tool_available {
        for key in [
            "syncFetch",
            "syncPull",
            "syncPush",
            "historyRewrite",
            "worktreeWrite",
            "subtreeWrite",
            "submoduleWrite",
            "svnPasswordStorage",
        ] {
            status.capabilities.availability.insert(
                key.into(),
                unavailable(
                    "VCS_TOOL_UNAVAILABLE",
                    format!("{tool_name} is not installed or cannot be executed"),
                ),
            );
        }
        return;
    }
    let parsed_tool_version = version.and_then(parsed_version);
    let version_supported = match parsed_tool_version {
        Some(current) => current >= minimum,
        None => true,
    };
    if !version_supported {
        let detail = format!(
            "{tool_name} {} is older than the supported minimum {}.{}",
            version.unwrap_or("unknown"),
            minimum.0,
            minimum.1,
        );
        for capability in status.capabilities.availability.values_mut() {
            if capability.available {
                *capability = unavailable("VCS_VERSION_UNSUPPORTED", detail.clone());
            }
        }
        for key in [
            "syncFetch",
            "syncPull",
            "syncPush",
            "historyRewrite",
            "worktreeWrite",
            "subtreeWrite",
            "submoduleWrite",
            "svnPasswordStorage",
        ] {
            status.capabilities.availability.insert(
                key.into(),
                unavailable("VCS_VERSION_UNSUPPORTED", detail.clone()),
            );
        }
        return;
    }

    let git = status.meta.kind == VcsKind::Git && status.tool_available && version_supported;
    let svn = status.meta.kind == VcsKind::Svn && status.tool_available && version_supported;
    let detached = git
        && (status.branch == "HEAD"
            || status.branch.starts_with("HEAD (")
            || status.branch.contains("detached"));
    let conflicted = status.conflicts > 0;
    let operation_active = status.operation.is_some();
    let dirty = status
        .files
        .iter()
        .any(|file| file.staged || file.unstaged || file.conflicted);
    let has_head = !status.revision.trim().is_empty();
    let safe_sync = !detached && !conflicted && !operation_active;
    let safe_extension_write = !conflicted && !operation_active;

    status.capabilities.availability.insert(
        "commit".into(),
        contextual_capability(
            (git || svn) && !conflicted,
            "REPOSITORY_CONFLICTED",
            "Resolve repository conflicts before committing",
        ),
    );
    status.capabilities.availability.insert(
        "syncFetch".into(),
        contextual_capability(git, "VCS_CAPABILITY_NOT_APPLICABLE", "Fetch requires Git"),
    );
    for key in ["syncPull", "syncPush"] {
        let (code, detail) = if !git {
            ("VCS_CAPABILITY_NOT_APPLICABLE", "Pull and push require Git")
        } else if detached {
            (
                "DETACHED_HEAD",
                "Check out a branch before pulling or pushing",
            )
        } else if conflicted {
            (
                "REPOSITORY_CONFLICTED",
                "Resolve conflicts before synchronizing",
            )
        } else {
            (
                "REPOSITORY_OPERATION_IN_PROGRESS",
                "Finish or abort the current repository operation",
            )
        };
        status.capabilities.availability.insert(
            key.into(),
            contextual_capability(git && safe_sync, code, detail),
        );
    }
    status.capabilities.availability.insert(
        "historyRewrite".into(),
        contextual_capability(
            git && has_head && !detached && !conflicted && !dirty && !operation_active,
            if !git {
                "VCS_CAPABILITY_NOT_APPLICABLE"
            } else if detached {
                "DETACHED_HEAD"
            } else if !has_head {
                "HEAD_UNAVAILABLE"
            } else if conflicted {
                "REPOSITORY_CONFLICTED"
            } else if operation_active {
                "REPOSITORY_OPERATION_IN_PROGRESS"
            } else if dirty {
                "WORKTREE_DIRTY"
            } else {
                "CAPABILITY_UNAVAILABLE"
            },
            if !git {
                "History rewriting requires Git"
            } else if detached {
                "Check out a branch before rewriting history"
            } else if !has_head {
                "Create the initial commit first"
            } else if conflicted {
                "Resolve conflicts before rewriting history"
            } else if operation_active {
                "Finish or abort the current repository operation"
            } else if dirty {
                "Commit, stash, or discard working tree changes first"
            } else {
                "History rewriting is unavailable"
            },
        ),
    );
    for (key, supported) in [
        ("worktreeWrite", status.capabilities.worktree),
        ("subtreeWrite", status.capabilities.subtree),
        ("submoduleWrite", status.capabilities.submodule),
    ] {
        status.capabilities.availability.insert(
            key.into(),
            contextual_capability(
                git && supported && safe_extension_write,
                if !git || !supported {
                    "VCS_CAPABILITY_NOT_APPLICABLE"
                } else if conflicted {
                    "REPOSITORY_CONFLICTED"
                } else {
                    "REPOSITORY_OPERATION_IN_PROGRESS"
                },
                if !git || !supported {
                    "This repository does not support this Git extension operation"
                } else if conflicted {
                    "Resolve conflicts before modifying repository structure"
                } else {
                    "Finish or abort the current repository operation"
                },
            ),
        );
    }
    status.capabilities.availability.insert(
        "svnPasswordStorage".into(),
        contextual_capability(
            svn && secure_credentials.status.available
                && secure_credentials.password_stdin_supported,
            if !svn {
                "VCS_CAPABILITY_NOT_APPLICABLE"
            } else if !secure_credentials.status.available {
                "SECURE_STORAGE_UNAVAILABLE"
            } else {
                "SVN_PASSWORD_STDIN_UNAVAILABLE"
            },
            if !svn {
                "Password storage is only available for SVN repositories"
            } else if !secure_credentials.status.available {
                "System secure storage is unavailable"
            } else {
                "SVN 1.10 or newer is required to pass passwords through stdin"
            },
        ),
    );

    if parsed_tool_version.is_none() {
        let detail = format!(
            "Could not parse the reported {tool_name} version{}; baseline capabilities remain enabled",
            version.map_or(String::new(), |value| format!(": {value}")),
        );
        for capability in status.capabilities.availability.values_mut() {
            if capability.available {
                capability.reason_code = Some("VCS_VERSION_UNPARSED".into());
                capability.detail = Some(detail.clone());
            }
        }
    }
}

fn repo_id(path: &Path, kind: VcsKind) -> String {
    let hash = Sha256::digest(format!("{}::{kind:?}", path.display()).as_bytes());
    format!(
        "{}-{}",
        if kind == VcsKind::Git { "git" } else { "svn" },
        hex::encode(&hash[..8])
    )
}

fn kind_rank(kind: VcsKind) -> u8 {
    if kind == VcsKind::Git {
        0
    } else {
        1
    }
}

fn parse_git_header(value: &str) -> (String, u32, u32) {
    let value = value.trim_start_matches("## ");
    let branch = value
        .split("...")
        .next()
        .unwrap_or(value)
        .split(" [")
        .next()
        .unwrap_or(value)
        .to_string();
    let ahead = parse_counter(value, "ahead ");
    let behind = parse_counter(value, "behind ");
    (branch, ahead, behind)
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

fn status_label(xy: &[u8]) -> &'static str {
    if matches!(xy, b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU") {
        "conflicted"
    } else if xy.contains(&b'?') {
        "untracked"
    } else if xy.contains(&b'A') {
        "added"
    } else if xy.contains(&b'D') {
        "deleted"
    } else if xy.contains(&b'R') {
        "renamed"
    } else {
        "modified"
    }
}

fn declared_submodule_paths(root: &Path) -> HashSet<String> {
    let Ok(contents) = std::fs::read_to_string(root.join(".gitmodules")) else {
        return HashSet::new();
    };
    contents
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| key.trim() == "path")
        .map(|(_, value)| value.trim().replace('\\', "/"))
        .filter(|value| {
            !value.is_empty()
                && !Path::new(value).is_absolute()
                && !value.split('/').any(|part| part == "..")
        })
        .collect()
}

fn git_operation(root: &Path) -> Option<String> {
    let git = root.join(".git");
    let git_dir = if git.is_dir() {
        git
    } else {
        let value = std::fs::read_to_string(git).ok()?;
        let target = value.trim().strip_prefix("gitdir: ")?;
        root.join(target)
    };
    if git_dir.join("MERGE_HEAD").exists() {
        Some("merge".into())
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("rebase".into())
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick".into())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn scan_uses_configured_depth_for_git_and_svn() {
        let root = tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a/.git")).unwrap();
        std::fs::create_dir_all(root.path().join("a/deep/.git")).unwrap();
        std::fs::create_dir_all(root.path().join("one/two/three/.svn")).unwrap();
        let path = root.path().to_string_lossy().into_owned();
        let ws = descriptor(vec![path]).unwrap();
        let repos = scan(&ws, &DesktopSettings::default()).unwrap();
        assert!(repos
            .iter()
            .any(|repo| repo.name == "a" && repo.kind == VcsKind::Git));
        assert!(repos
            .iter()
            .any(|repo| repo.name == "three" && repo.kind == VcsKind::Svn));
        assert!(repos
            .iter()
            .any(|repo| repo.name == "deep" && !repo.is_submodule));
        let settings = DesktopSettings {
            repository_scan_depth: 1,
            ..DesktopSettings::default()
        };
        let shallow = scan(&ws, &settings).unwrap();
        assert!(!shallow.iter().any(|repo| repo.name == "deep"));
        assert!(!shallow.iter().any(|repo| repo.name == "three"));
    }

    #[test]
    fn scan_discovers_declared_submodules_beyond_normal_depth() {
        let root = tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("parent/.git")).unwrap();
        std::fs::create_dir_all(root.path().join("parent/vendor/deep/.git")).unwrap();
        std::fs::write(
            root.path().join("parent/.gitmodules"),
            "[submodule \"deep\"]\n  path = vendor/deep\n",
        )
        .unwrap();
        let ws = descriptor(vec![root.path().to_string_lossy().into_owned()]).unwrap();
        let repos = scan(&ws, &DesktopSettings::default()).unwrap();
        assert!(repos
            .iter()
            .any(|repo| repo.name == "deep" && repo.is_submodule));
    }

    #[test]
    fn nested_git_files_are_owned_only_by_the_nested_repository() {
        let root = tempdir().unwrap();
        let parent_root = root.path().join("parent");
        let child_root = parent_root.join("nested");
        std::fs::create_dir_all(&child_root).unwrap();
        let status = |id: &str, root_path: &Path, files: Vec<FileChange>| RepositoryStatus {
            meta: RepositoryMeta {
                id: id.into(),
                name: id.into(),
                root_path: root_path.to_string_lossy().into_owned(),
                color: "#000".into(),
                kind: VcsKind::Git,
                parent_repo_id: None,
                depth: 0,
                is_submodule: false,
                is_worktree: false,
            },
            branch: "main".into(),
            revision: "abcdef0".into(),
            ahead: 0,
            behind: 0,
            files,
            conflicts: 0,
            operation: None,
            capabilities: repository_capabilities(VcsKind::Git, true),
            tool_available: true,
        };
        let file = |path: &str| FileChange {
            path: path.into(),
            status: "untracked".into(),
            staged: false,
            unstaged: true,
            conflicted: false,
            conflict_type: None,
            submodule: false,
            is_truncated: false,
            truncation_reason: None,
        };
        let mut repositories = vec![
            status(
                "parent",
                &parent_root,
                vec![file("nested"), file("owned.txt")],
            ),
            status("child", &child_root, vec![file("child.txt")]),
        ];
        apply_nested_git_ownership(&mut repositories);
        assert_eq!(repositories[0].files.len(), 1);
        assert_eq!(repositories[0].files[0].path, "owned.txt");
        assert_eq!(repositories[1].files[0].path, "child.txt");
    }

    #[test]
    fn parses_ahead_and_behind() {
        assert_eq!(
            parse_git_header("## main...origin/main [ahead 2, behind 3]"),
            ("main".into(), 2, 3)
        );
    }

    fn capability_status(kind: VcsKind, branch: &str) -> RepositoryStatus {
        RepositoryStatus {
            meta: RepositoryMeta {
                id: "repo".into(),
                name: "repo".into(),
                root_path: "/repo".into(),
                color: "#000".into(),
                kind,
                parent_repo_id: None,
                depth: 0,
                is_submodule: false,
                is_worktree: false,
            },
            branch: branch.into(),
            revision: "abcdef0".into(),
            ahead: 0,
            behind: 0,
            files: vec![],
            conflicts: 0,
            operation: None,
            capabilities: repository_capabilities(kind, true),
            tool_available: true,
        }
    }

    #[test]
    fn capabilities_reject_detached_push_and_require_secure_svn_password_storage() {
        let tools = ToolAvailability {
            git: true,
            svn: true,
            svnadmin: true,
            git_version: Some("2.53.0".into()),
            svn_version: Some("1.14.5".into()),
        };
        let unavailable_store = SecureCredentialCapability {
            status: CapabilityStatus::unavailable("NO_STORE", "No secure store"),
            backend: None,
            password_stdin_supported: true,
        };
        let mut git = capability_status(VcsKind::Git, "HEAD (detached at abcdef0)");
        apply_runtime_capabilities(&mut git, &tools, &unavailable_store);
        assert!(!git.capabilities.availability["syncPush"].available);
        assert_eq!(
            git.capabilities.availability["syncPush"]
                .reason_code
                .as_deref(),
            Some("DETACHED_HEAD")
        );
        assert!(git.capabilities.availability["syncFetch"].available);

        let mut svn = capability_status(VcsKind::Svn, "trunk");
        apply_runtime_capabilities(&mut svn, &tools, &unavailable_store);
        assert!(!svn.capabilities.availability["svnPasswordStorage"].available);
        assert_eq!(parsed_version("svn, version 1.14.5"), Some((1, 14, 5)));
    }

    #[test]
    fn capabilities_report_precise_unavailable_reasons_and_unparsed_versions() {
        let secure_store = SecureCredentialCapability {
            status: CapabilityStatus::available(),
            backend: Some("memory".into()),
            password_stdin_supported: true,
        };
        let mut svn = capability_status(VcsKind::Svn, "trunk");
        let mut tools = ToolAvailability {
            git: true,
            svn: true,
            svnadmin: true,
            git_version: Some("vendor build".into()),
            svn_version: Some("1.14.5".into()),
        };
        apply_runtime_capabilities(&mut svn, &tools, &secure_store);
        assert_eq!(
            svn.capabilities.availability["worktreeWrite"]
                .reason_code
                .as_deref(),
            Some("VCS_CAPABILITY_NOT_APPLICABLE")
        );

        let mut git = capability_status(VcsKind::Git, "main");
        apply_runtime_capabilities(&mut git, &tools, &secure_store);
        assert_eq!(
            git.capabilities.availability["svnPasswordStorage"]
                .reason_code
                .as_deref(),
            Some("VCS_CAPABILITY_NOT_APPLICABLE")
        );
        assert_eq!(
            git.capabilities.availability["syncFetch"]
                .reason_code
                .as_deref(),
            Some("VCS_VERSION_UNPARSED")
        );

        tools.git_version = Some("2.53.0".into());
        git.conflicts = 1;
        git.files.push(FileChange {
            path: "conflicted.txt".into(),
            status: "conflicted".into(),
            staged: false,
            unstaged: false,
            conflicted: true,
            conflict_type: Some("bothModified".into()),
            submodule: false,
            is_truncated: false,
            truncation_reason: None,
        });
        apply_runtime_capabilities(&mut git, &tools, &secure_store);
        assert_eq!(
            git.capabilities.availability["historyRewrite"]
                .reason_code
                .as_deref(),
            Some("REPOSITORY_CONFLICTED")
        );
    }
}
