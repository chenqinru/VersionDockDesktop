use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use chrono::Utc;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cli,
    models::{
        DesktopError, DesktopSettings, FileChange, RepositoryCapabilities, RepositoryMeta,
        RepositoryStatus, ToolAvailability, VcsKind, WorkspaceDescriptor, WorkspaceSnapshot,
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
    let metas = scan(&workspace, settings)?;
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let mut tasks = tokio::task::JoinSet::new();
    for (index, meta) in metas.into_iter().enumerate() {
        let semaphore = semaphore.clone();
        let token = token.clone();
        let tools = tools.clone();
        tasks.spawn(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .map_err(|_| DesktopError::new("APP_CLOSING", "Application is closing", true))?;
            let tool_available = match meta.kind {
                VcsKind::Git => tools.git,
                VcsKind::Svn => tools.svn,
            };
            let status = match meta.kind {
                VcsKind::Git if tools.git => git_status(meta, &token).await,
                VcsKind::Svn if tools.svn => svn_status(meta, &token).await,
                _ => Ok(empty_status(meta, tool_available)),
            }?;
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
    let repositories = indexed.into_iter().map(|(_, status)| status).collect();
    Ok(WorkspaceSnapshot {
        workspace,
        repositories,
        generation,
        tools,
    })
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
                .max_by_key(|(candidate, _, _)| candidate.components().count());
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
                && parent.is_some_and(|(parent_path, _, _)| {
                    let relative = path
                        .strip_prefix(parent_path)
                        .ok()
                        .map(|value| value.to_string_lossy().replace('\\', "/"));
                    git_file.exists()
                        || relative.is_some_and(|value| {
                            declared_submodule_paths(parent_path).contains(&value)
                        })
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

fn walk(
    root: &Path,
    current: &Path,
    depth: usize,
    max_depth: usize,
    ignored_folders: &[String],
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
            || ignored_folders
                .iter()
                .any(|ignored| ignored == &name || relative.as_ref() == Some(ignored))
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

pub fn repository(
    workspace: &WorkspaceDescriptor,
    repo_id_value: &str,
) -> Result<RepositoryMeta, DesktopError> {
    scan(workspace, &DesktopSettings::default())?
        .into_iter()
        .find(|meta| meta.id == repo_id_value)
        .ok_or_else(|| {
            DesktopError::new(
                "REPOSITORY_NOT_FOUND",
                "Repository is no longer part of the workspace",
                true,
            )
        })
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
        &["status".into(), "--xml".into(), "--no-ignore".into()],
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
            path: path.replace('\\', "/"),
            status: item.into(),
            staged: false,
            unstaged: true,
            conflicted,
            conflict_type,
            submodule: false,
        });
    }
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
    Ok(RepositoryStatus {
        meta,
        branch: info,
        revision,
        ahead: 0,
        behind: 0,
        files,
        conflicts,
        operation: None,
        capabilities: repository_capabilities(VcsKind::Svn, true),
        tool_available: true,
    })
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
        assert!(repos.iter().any(|repo| repo.name == "deep"));
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
    fn parses_ahead_and_behind() {
        assert_eq!(
            parse_git_header("## main...origin/main [ahead 2, behind 3]"),
            ("main".into(), 2, 3)
        );
    }
}
