use super::{context::fingerprint, models::*, transport::error, validation::validate_groups};
use crate::{
    cli,
    models::{DesktopError, RepositoryMeta, VcsKind},
    vcs,
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub struct Session {
    pub source: AiComposerSource,
    pub workspace_id: String,
    pub repo: RepositoryMeta,
    pub base: String,
    pub head: String,
    pub branch: String,
    pub expected_tree: String,
    pub paths: Vec<String>,
    pub staged: bool,
    pub outside_patch: String,
    pub patches: HashMap<String, String>,
    pub fingerprint: String,
    pub created: Instant,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(Default::default)
}
pub fn session(id: &str, workspace: &str, repo: &str) -> Result<Session, DesktopError> {
    sessions()
        .lock()
        .ok()
        .and_then(|v| {
            v.get(id)
                .filter(|s| {
                    s.workspace_id == workspace
                        && s.repo.id == repo
                        && s.created.elapsed() < Duration::from_secs(3600)
                })
                .cloned()
        })
        .ok_or_else(|| {
            error(
                "AI_COMPOSER_SESSION_STALE",
                "Commit plan expired. Analyze changes again.",
            )
        })
}
async fn git(
    root: &Path,
    args: Vec<String>,
    stdin: Option<&str>,
    env: &[(String, String)],
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let isolated = env.iter().any(|(key, _)| key == "GIT_INDEX_FILE")
        || args.first().is_some_and(|command| {
            ["update-ref", "symbolic-ref", "ls-files", "worktree"].contains(&command.as_str())
        });
    let output = if isolated {
        cli::run_with_isolated_git_index(
            &args,
            root,
            stdin.map(str::as_bytes),
            Duration::from_secs(300),
            token,
            env,
        )
        .await?
    } else {
        cli::run_with_env(
            "git",
            &args,
            root,
            stdin.map(str::as_bytes),
            Duration::from_secs(300),
            token,
            env,
        )
        .await?
    };
    Ok(output.stdout_text())
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).into()).collect()
}
fn pathspecs(paths: &[String]) -> Vec<String> {
    paths.iter().map(|p| format!(":(literal){p}")).collect()
}
async fn checked(
    repo: &RepositoryMeta,
    paths: &[String],
    token: &CancellationToken,
) -> Result<(String, String), DesktopError> {
    let root = Path::new(&repo.root_path);
    for path in paths {
        crate::state::safe_relative(root, path, false)?;
    }
    let head = git(root, args(&["rev-parse", "HEAD"]), None, &[], token)
        .await?
        .trim()
        .to_owned();
    let branch = git(root, args(&["symbolic-ref", "HEAD"]), None, &[], token)
        .await
        .map_err(|_| {
            error(
                "AI_COMPOSER_DETACHED",
                "AI Commit Composer requires a checked-out branch",
            )
        })?
        .trim()
        .to_owned();
    for name in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ] {
        let path = git(
            root,
            args(&["rev-parse", "--git-path", name]),
            None,
            &[],
            token,
        )
        .await?;
        let path = Path::new(path.trim());
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        };
        if path.exists() {
            return Err(error(
                "AI_COMPOSER_BUSY",
                "Finish the current Git operation before composing commits",
            ));
        }
    }
    let conflicts = git(root, args(&["ls-files", "-u"]), None, &[], token).await?;
    if !conflicts.trim().is_empty() {
        return Err(error(
            "AI_COMPOSER_CONFLICTS",
            "Resolve conflicts before composing commits",
        ));
    }
    Ok((head, branch))
}
fn decode_patch_path(raw: &str) -> String {
    let Some(quoted) = raw
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    else {
        return raw.to_owned();
    };
    let bytes = quoted.as_bytes();
    let mut decoded = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        index += 1;
        if index == bytes.len() {
            return raw.to_owned();
        }
        if (b'0'..=b'7').contains(&bytes[index]) {
            let mut value = 0u16;
            let mut count = 0;
            while index < bytes.len() && count < 3 && (b'0'..=b'7').contains(&bytes[index]) {
                value = value * 8 + (bytes[index] - b'0') as u16;
                index += 1;
                count += 1;
            }
            let Ok(value) = u8::try_from(value) else {
                return raw.to_owned();
            };
            decoded.push(value);
        } else {
            decoded.push(match bytes[index] {
                b'n' => b'\n',
                b'r' => b'\r',
                b't' => b'\t',
                b'b' => 8,
                b'f' => 12,
                b'v' => 11,
                b'a' => 7,
                character => character,
            });
            index += 1;
        }
    }
    String::from_utf8(decoded).unwrap_or_else(|_| raw.to_owned())
}
fn split_patch(patch: &str, paths: &[String]) -> (Vec<AiUnit>, HashMap<String, String>) {
    let mut chunks: Vec<String> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            chunks.push(String::new());
        }
        if let Some(chunk) = chunks.last_mut() {
            chunk.push_str(line);
        }
    }
    let mut units = Vec::new();
    let mut patches = HashMap::new();
    for (index, chunk) in chunks.into_iter().enumerate() {
        let Some(path) = paths.get(index) else {
            continue;
        };
        let binary = chunk.contains("GIT binary patch") || chunk.contains("Binary files ");
        let added = chunk.contains("new file mode");
        let deleted = chunk.contains("deleted file mode");
        let atomic = binary
            || added
            || deleted
            || chunk.contains("rename from ")
            || chunk.contains("copy from ")
            || chunk.contains("old mode ")
            || chunk.contains("Subproject commit ")
            || !chunk.contains("\n@@ ");
        let old_path = chunk
            .lines()
            .find_map(|line| {
                line.strip_prefix("rename from ")
                    .or_else(|| line.strip_prefix("copy from "))
            })
            .map(decode_patch_path);
        let status = if added {
            "added"
        } else if deleted {
            "deleted"
        } else if chunk.contains("rename from ") {
            "renamed"
        } else if chunk.contains("copy from ") {
            "copied"
        } else if binary {
            "binary"
        } else {
            "modified"
        };
        let header_end = chunk.find("\n@@ ").map(|i| i + 1).unwrap_or(0);
        let header = chunk[..header_end]
            .lines()
            .filter(|line| !line.starts_with("index "))
            .map(|line| format!("{line}\n"))
            .collect::<String>();
        let hunks: Vec<String> = if atomic {
            vec![chunk.clone()]
        } else {
            chunk[header_end..]
                .split("\n@@ ")
                .enumerate()
                .map(|(i, h)| {
                    let mut h = if i == 0 {
                        h.to_owned()
                    } else {
                        format!("@@ {h}")
                    };
                    if !h.ends_with('\n') {
                        h.push('\n');
                    }
                    h
                })
                .collect()
        };
        for hunk in hunks {
            let raw = if atomic {
                hunk.clone()
            } else {
                format!("{header}{hunk}")
            };
            let id = format!("u{}", units.len() + 1);
            let mut in_hunk = false;
            let counts = hunk.lines().fold((0u32, 0u32), |(a, r), line| {
                if line.starts_with("@@ ") {
                    in_hunk = true;
                }
                (
                    a + u32::from(in_hunk && line.starts_with('+')),
                    r + u32::from(in_hunk && line.starts_with('-')),
                )
            });
            let title = if atomic {
                path.rsplit('/').next().unwrap_or(path).into()
            } else {
                hunk.lines().next().unwrap_or("Change").into()
            };
            units.push(AiUnit {
                id: id.clone(),
                file_path: path.clone(),
                old_path: old_path.clone(),
                kind: if atomic { "file" } else { "hunk" }.into(),
                status: status.into(),
                title,
                diff: if binary {
                    "Binary change (atomic)".into()
                } else {
                    hunk
                },
                language: crate::vcs::language_for(path),
                added: counts.0,
                removed: counts.1,
                atomic,
            });
            patches.insert(id, raw);
        }
    }
    (units, patches)
}
pub async fn prepare(
    workspace_id: &str,
    repo: &RepositoryMeta,
    paths: &[String],
    staged: bool,
    hashes: &[String],
    token: &CancellationToken,
) -> Result<AiComposerSource, DesktopError> {
    let mut selected: Vec<String> = paths
        .iter()
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    selected.sort();
    let root = Path::new(&repo.root_path);
    if repo.kind == VcsKind::Svn {
        if !hashes.is_empty() {
            return Err(error(
                "AI_COMPOSER_SVN_HISTORY",
                "SVN history cannot be reorganized",
            ));
        }
        if selected.is_empty() {
            return Err(error(
                "AI_CONTEXT_EMPTY",
                "Select changes before opening AI Commit Composer",
            ));
        }
        let mut units = Vec::new();
        let mut evidence = String::new();
        for path in &selected {
            let diff = vcs::diff(repo, path, false, None, None, None, token).await?;
            evidence.push_str(&format!("{path}\n{}", diff.content));
            units.push(AiUnit {
                id: format!("u{}", units.len() + 1),
                file_path: path.clone(),
                old_path: None,
                kind: "file".into(),
                status: "modified".into(),
                title: path.clone(),
                diff: diff.content,
                language: diff.language,
                added: 0,
                removed: 0,
                atomic: true,
            });
        }
        let source = AiComposerSource {
            session_id: uuid::Uuid::new_v4().to_string(),
            mode: "working".into(),
            repo_id: repo.id.clone(),
            repo_name: repo.name.clone(),
            vcs_kind: "svn".into(),
            branch: String::new(),
            source_label: "Selected working changes".into(),
            units,
            original_commit_count: None,
        };
        let session = Session {
            source: source.clone(),
            workspace_id: workspace_id.into(),
            repo: repo.clone(),
            base: String::new(),
            head: String::new(),
            branch: String::new(),
            expected_tree: String::new(),
            paths: selected,
            staged: false,
            outside_patch: String::new(),
            patches: HashMap::new(),
            fingerprint: fingerprint(&evidence),
            created: Instant::now(),
        };
        store(session);
        return Ok(source);
    }
    let (head, branch) = checked(repo, &selected, token).await?;
    let history = !hashes.is_empty();
    let mut base = head.clone();
    let original_count = if history {
        Some(hashes.len() as u32)
    } else {
        None
    };
    if history {
        let status = git(
            root,
            args(&["status", "--porcelain=v1", "--untracked-files=all"]),
            None,
            &[],
            token,
        )
        .await?;
        if !status.trim().is_empty() {
            return Err(error(
                "AI_COMPOSER_DIRTY",
                "Clean the working tree before reorganizing history",
            ));
        }
        let mut requested = HashSet::new();
        for hash in hashes {
            if hash.is_empty() || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(error("AI_REVISION_INVALID", "Invalid commit hash"));
            }
            let resolved = git(
                root,
                vec!["rev-parse".into(), format!("{hash}^{{commit}}")],
                None,
                &[],
                token,
            )
            .await?;
            requested.insert(resolved.trim().to_owned());
        }
        let range = git(
            root,
            vec![
                "rev-list".into(),
                "--first-parent".into(),
                format!("--max-count={}", hashes.len()),
                head.clone(),
            ],
            None,
            &[],
            token,
        )
        .await?;
        let actual: Vec<_> = range.lines().collect();
        if requested.len() != hashes.len()
            || actual.len() != hashes.len()
            || actual.iter().any(|h| !requested.contains(*h))
        {
            return Err(error(
                "AI_COMPOSER_RANGE",
                "Select consecutive unpushed commits ending at HEAD",
            ));
        }
        let oldest = actual.last().unwrap();
        let remote = git(
            root,
            vec![
                "for-each-ref".into(),
                format!("--contains={oldest}"),
                "--format=%(refname)".into(),
                "refs/remotes".into(),
            ],
            None,
            &[],
            token,
        )
        .await?;
        if !remote.trim().is_empty() {
            return Err(error(
                "AI_COMPOSER_PUSHED",
                "Selected history contains pushed commits",
            ));
        }
        for hash in &actual {
            let parents = git(
                root,
                vec![
                    "rev-list".into(),
                    "--parents".into(),
                    "-n".into(),
                    "1".into(),
                    (*hash).into(),
                ],
                None,
                &[],
                token,
            )
            .await?;
            if parents.split_whitespace().count() != 2 {
                return Err(error(
                    "AI_COMPOSER_RANGE",
                    "Initial and merge commits cannot be reorganized",
                ));
            }
        }
        base = git(
            root,
            vec!["rev-parse".into(), format!("{oldest}^1")],
            None,
            &[],
            token,
        )
        .await?
        .trim()
        .into();
    } else if selected.is_empty() {
        return Err(error(
            "AI_CONTEXT_EMPTY",
            "Select changes before opening AI Commit Composer",
        ));
    }
    let temporary =
        tempfile::tempdir().map_err(|e| error("AI_COMPOSER_TEMP_FAILED", e.to_string()))?;
    let index_path = temporary.path().join("index");
    let env = [(
        "GIT_INDEX_FILE".into(),
        index_path.to_string_lossy().into_owned(),
    )];
    git(
        root,
        vec!["read-tree".into(), base.clone()],
        None,
        &env,
        token,
    )
    .await?;
    let mut outside_patch = String::new();
    let patch;
    if history {
        patch = git(
            root,
            vec![
                "diff".into(),
                "--binary".into(),
                "--full-index".into(),
                "-M".into(),
                base.clone(),
                head.clone(),
            ],
            None,
            &[],
            token,
        )
        .await?;
        git(root, args(&["read-tree", "HEAD"]), None, &env, token).await?;
    } else {
        // Rename path closure uses -z name-status records, including both sides.
        let names = git(
            root,
            args(&["diff", "HEAD", "--name-status", "-z", "-M"]),
            None,
            &[],
            token,
        )
        .await?;
        let mut parts = names.split('\0').peekable();
        let mut closure = HashSet::new();
        while let Some(status) = parts.next() {
            if status.is_empty() {
                break;
            }
            let Some(a) = parts.next() else { break };
            if status.starts_with('R') || status.starts_with('C') {
                let Some(b) = parts.next() else { break };
                if selected.iter().any(|p| p == a || p == b) {
                    closure.insert(a.to_owned());
                    closure.insert(b.to_owned());
                }
            }
        }
        selected.extend(closure);
        selected.sort();
        selected.dedup();
        let all_index = git(
            root,
            args(&["diff", "--cached", "--name-only", "-z"]),
            None,
            &[],
            token,
        )
        .await?;
        let outside: Vec<String> = all_index
            .split('\0')
            .filter(|p| !p.is_empty() && !selected.iter().any(|s| s == p))
            .map(str::to_owned)
            .collect();
        if !outside.is_empty() {
            let mut a = args(&["diff", "--cached", "--binary", "--full-index", "HEAD", "--"]);
            a.extend(pathspecs(&outside));
            outside_patch = git(root, a, None, &[], token).await?;
        }
        if staged {
            let mut a = args(&[
                "diff",
                "--cached",
                "--binary",
                "--full-index",
                "-M",
                "HEAD",
                "--",
            ]);
            a.extend(pathspecs(&selected));
            let raw = git(root, a, None, &[], token).await?;
            git(
                root,
                args(&["apply", "--cached", "--binary", "--whitespace=nowarn", "-"]),
                Some(&raw),
                &env,
                token,
            )
            .await?;
        } else {
            let mut a = args(&["ls-files", "-z", "--cached", "--with-tree=HEAD", "--"]);
            a.extend(pathspecs(&selected));
            let tracked = git(root, a, None, &[], token).await?;
            let tracked: HashSet<_> = tracked.split('\0').collect();
            for force in [false, true] {
                let subset: Vec<String> = selected
                    .iter()
                    .filter(|p| tracked.contains(p.as_str()) == force)
                    .cloned()
                    .collect();
                if subset.is_empty() {
                    continue;
                }
                let mut a = args(&["add", "-A"]);
                if force {
                    a.push("-f".into());
                }
                a.push("--".into());
                a.extend(pathspecs(&subset));
                git(root, a, None, &env, token).await?;
            }
        }
        patch = git(
            root,
            vec![
                "diff".into(),
                "--cached".into(),
                "--binary".into(),
                "--full-index".into(),
                "-M".into(),
                base.clone(),
            ],
            None,
            &env,
            token,
        )
        .await?;
    }
    if patch.is_empty() {
        return Err(error(
            "AI_CONTEXT_EMPTY",
            "No selected changes are available for composition",
        ));
    }
    let expected_tree = git(root, args(&["write-tree"]), None, &env, token)
        .await?
        .trim()
        .into();
    let paths_raw = if history {
        git(
            root,
            vec![
                "diff".into(),
                "--name-only".into(),
                "-z".into(),
                "-M".into(),
                base.clone(),
                head.clone(),
            ],
            None,
            &[],
            token,
        )
        .await?
    } else {
        git(
            root,
            vec![
                "diff".into(),
                "--cached".into(),
                "--name-only".into(),
                "-z".into(),
                "-M".into(),
                base.clone(),
            ],
            None,
            &env,
            token,
        )
        .await?
    };
    let names: Vec<String> = paths_raw
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    let (units, patches) = split_patch(&patch, &names);
    if units.is_empty() {
        return Err(error("AI_COMPOSER_EMPTY", "No change units were found"));
    }
    let source = AiComposerSource {
        session_id: uuid::Uuid::new_v4().to_string(),
        mode: if history { "history" } else { "working" }.into(),
        repo_id: repo.id.clone(),
        repo_name: repo.name.clone(),
        vcs_kind: "git".into(),
        branch: branch.trim_start_matches("refs/heads/").into(),
        source_label: if history {
            "Selected unpushed commits"
        } else if staged {
            "Selected staged changes"
        } else {
            "Selected working changes"
        }
        .into(),
        units,
        original_commit_count: original_count,
    };
    let hash = fingerprint(&format!("{head}\n{patch}\n{outside_patch}"));
    store(Session {
        source: source.clone(),
        workspace_id: workspace_id.into(),
        repo: repo.clone(),
        base,
        head,
        branch,
        expected_tree,
        paths: selected,
        staged,
        outside_patch,
        patches,
        fingerprint: hash,
        created: Instant::now(),
    });
    Ok(source)
}
fn store(session: Session) {
    if let Ok(mut map) = sessions().lock() {
        map.retain(|_, s| s.created.elapsed() < Duration::from_secs(3600));
        if map.len() >= 32 {
            if let Some(key) = map
                .iter()
                .min_by_key(|(_, s)| s.created)
                .map(|(id, _)| id.clone())
            {
                map.remove(&key);
            }
        }
        map.insert(session.source.session_id.clone(), session);
    }
}
pub async fn apply(
    session: Session,
    groups: Vec<AiGroup>,
    no_verify: bool,
    identity: Option<&crate::models::EffectiveGitIdentity>,
    token: &CancellationToken,
) -> Result<AiApplyResult, DesktopError> {
    validate_groups(&groups, &session.source.units)?;
    if session.repo.kind == VcsKind::Svn {
        let refreshed = prepare(
            &session.workspace_id,
            &session.repo,
            &session.paths,
            false,
            &[],
            token,
        )
        .await?;
        let current = super::composer::session(
            &refreshed.session_id,
            &session.workspace_id,
            &session.repo.id,
        )?;
        if current.fingerprint != session.fingerprint {
            return Err(error(
                "AI_COMPOSER_STALE",
                "Selected changes changed after analysis",
            ));
        }
        let mut count = 0u32;
        let mut hashes = Vec::new();
        for (index, group) in groups.iter().enumerate() {
            crate::state::emit_current_operation_progress(
                crate::models::OperationStatus::Running,
                "applyingAiCommits",
                &group.message,
                Some(index as u32),
                Some(groups.len() as u32),
            );
            let paths: Vec<_> = session
                .source
                .units
                .iter()
                .filter(|u| group.unit_ids.contains(&u.id))
                .map(|u| u.file_path.clone())
                .collect();
            match vcs::commit(&session.repo, &group.message, false, &paths, token).await {
                Ok(hash) => {
                    count += 1;
                    hashes.push(hash);
                }
                Err(e) => {
                    return Err(error(
                        "AI_COMPOSER_PARTIAL_FAILURE",
                        format!(
                            "SVN committed {count} of {} groups before failing: {}",
                            groups.len(),
                            e.message
                        ),
                    ))
                }
            }
        }
        return Ok(AiApplyResult {
            commit_count: count,
            commit_hashes: hashes,
            backup_ref: None,
            recovery_command: None,
            completed_groups: Some(count),
        });
    }
    let root = Path::new(&session.repo.root_path);
    let (head, branch) = checked(&session.repo, &session.paths, token).await?;
    if head != session.head || branch != session.branch {
        return Err(error(
            "AI_COMPOSER_STALE",
            "Repository HEAD or branch changed after analysis",
        ));
    }
    if session.source.mode == "working" {
        let refreshed = prepare(
            &session.workspace_id,
            &session.repo,
            &session.paths,
            session.staged,
            &[],
            token,
        )
        .await?;
        let current = super::composer::session(
            &refreshed.session_id,
            &session.workspace_id,
            &session.repo.id,
        )?;
        if current.fingerprint != session.fingerprint {
            return Err(error(
                "AI_COMPOSER_STALE",
                "Selected or staged changes changed after analysis",
            ));
        }
    } else {
        let status = git(root, args(&["status", "--porcelain=v1"]), None, &[], token).await?;
        if !status.trim().is_empty() {
            return Err(error(
                "AI_COMPOSER_DIRTY",
                "Working tree changed after history analysis",
            ));
        }
    }
    if session.source.mode == "history" {
        ensure_unpushed(root, &session.base, &session.head, token).await?;
    }
    let publish_snapshot = repository_snapshot(root, token).await?;
    if identity.is_some_and(|i| !i.valid) {
        return Err(error(
            "GIT_IDENTITY_MISSING",
            "Configure a valid Git name and email before applying the plan",
        ));
    }
    let temporary =
        tempfile::tempdir().map_err(|e| error("AI_COMPOSER_TEMP_FAILED", e.to_string()))?;
    let worktree = temporary.path().join("worktree");
    let added = git(
        root,
        vec![
            "worktree".into(),
            "add".into(),
            "--detach".into(),
            worktree.to_string_lossy().into_owned(),
            session.base.clone(),
        ],
        None,
        &[],
        token,
    )
    .await;
    if let Err(e) = added {
        let cleanup = CancellationToken::new();
        let _ = git(
            root,
            vec![
                "worktree".into(),
                "remove".into(),
                "--force".into(),
                worktree.to_string_lossy().into_owned(),
            ],
            None,
            &[],
            &cleanup,
        )
        .await;
        let _ = git(root, args(&["worktree", "prune"]), None, &[], &cleanup).await;
        return Err(e);
    }
    let result = async {
        let mut hashes = Vec::new();
        for (index,group) in groups.iter().enumerate() {
            crate::state::emit_current_operation_progress(crate::models::OperationStatus::Running, "applyingAiCommits", &group.message, Some(index as u32), Some(groups.len() as u32));
            for id in &group.unit_ids {
                git(&worktree, args(&["apply", "--index", "--binary", "--whitespace=nowarn", "-"]), Some(&session.patches[id]), &[], token).await?;
            }
            let mut command = Vec::new();
            if let Some(identity) = identity {
                command.extend(["-c".into(), format!("user.name={}", identity.user_name), "-c".into(), format!("user.email={}", identity.email)]);
            }
            command.extend(args(&["commit", "--file=-"]));
            if no_verify { command.push("--no-verify".into()); }
            git(&worktree, command, Some(&group.message), &[], token).await?;
            hashes.push(git(&worktree, args(&["rev-parse", "HEAD"]), None, &[], token).await?.trim().to_owned());
        }
        let new_head = hashes.last().unwrap();
        let tree = git(&worktree, vec!["rev-parse".into(), format!("{new_head}^{{tree}}")], None, &[], token).await?;
        if tree.trim() != session.expected_tree {
            return Err(error("AI_COMPOSER_TREE_MISMATCH", "Composed commits do not reproduce the expected tree. No branch was changed."));
        }
        let final_index = temporary.path().join("publish-index");
        let env = [("GIT_INDEX_FILE".into(), final_index.to_string_lossy().into_owned())];
        git(root, vec!["read-tree".into(), new_head.clone()], None, &env, token).await?;
        if !session.outside_patch.is_empty() {
            git(root, args(&["apply", "--cached", "--binary", "--whitespace=nowarn", "-"]), Some(&session.outside_patch), &env, token).await?;
        }
        let index = git(root, args(&["rev-parse", "--git-path", "index"]), None, &[], token).await?;
        let index = Path::new(index.trim());
        let index = if index.is_absolute() { index.to_owned() } else { root.join(index) };
        // Only remove the lock created by this request; never remove another Git client's lock.
        let index_lock = OwnedIndexLock::prepare(index, &final_index)?;
        let (latest_head, latest_branch) = checked(&session.repo, &session.paths, token).await?;
        if latest_head != head || latest_branch != branch || repository_snapshot(root, token).await? != publish_snapshot {
            return Err(error("AI_COMPOSER_STALE", "Repository changed while constructing the commits. Analyze again."));
        }
        if session.source.mode == "history" { ensure_unpushed(root, &session.base, &session.head, token).await?; }
        let backup = format!("refs/versiondock/ai-composer/{}-{}", chrono::Utc::now().timestamp_millis(), &head[..8]);
        git(root, vec!["update-ref".into(), backup.clone(), head.clone()], None, &[], token).await?;
        if token.is_cancelled() { return Err(error("CANCELLED", "AI application cancelled")); }
        // Once publication starts, finish the index update even if the UI cancels the request.
        let restore = CancellationToken::new();
        git(root, vec!["update-ref".into(), session.branch.clone(), new_head.clone(), head.clone()], None, &[], &restore).await?;
        if let Err(error_detail) = index_lock.publish() {
            let rollback = git(root, vec!["update-ref".into(), session.branch.clone(), head.clone(), new_head.clone()], None, &[], &restore).await;
            return Err(error("AI_COMPOSER_RESTORE_FAILED", format!("Index publication failed: {error_detail}. Branch rollback: {}. Recovery reference: {backup}", if rollback.is_ok() { "completed" } else { "failed" })));
        }
        let _ = prune_backups(root, &restore).await;
        Ok(AiApplyResult {
            commit_count: hashes.len() as u32, commit_hashes: hashes,
            backup_ref: Some(backup.clone()), recovery_command: Some(format!("git reset --mixed {backup}")), completed_groups: None,
        })
    }.await;
    let _ = git(
        root,
        vec![
            "worktree".into(),
            "remove".into(),
            "--force".into(),
            worktree.to_string_lossy().into_owned(),
        ],
        None,
        &[],
        &CancellationToken::new(),
    )
    .await;
    if result.is_ok() {
        if let Ok(mut map) = sessions().lock() {
            map.remove(&session.source.session_id);
        }
    }
    result
}

async fn repository_snapshot(
    root: &Path,
    token: &CancellationToken,
) -> Result<String, DesktopError> {
    let status = git(
        root,
        args(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        None,
        &[],
        token,
    )
    .await?;
    let index = git(
        root,
        args(&["diff", "--cached", "--binary", "--full-index", "HEAD"]),
        None,
        &[],
        token,
    )
    .await?;
    let working = git(
        root,
        args(&["diff", "--binary", "--full-index"]),
        None,
        &[],
        token,
    )
    .await?;
    Ok(fingerprint(&format!("{status}\n{index}\n{working}")))
}
async fn ensure_unpushed(
    root: &Path,
    base: &str,
    head: &str,
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let commits = git(
        root,
        vec!["rev-list".into(), format!("{base}..{head}")],
        None,
        &[],
        token,
    )
    .await?;
    for commit in commits.lines() {
        let refs = git(
            root,
            vec![
                "for-each-ref".into(),
                format!("--contains={commit}"),
                "--format=%(refname)".into(),
                "refs/remotes".into(),
            ],
            None,
            &[],
            token,
        )
        .await?;
        if !refs.trim().is_empty() {
            return Err(error(
                "AI_COMPOSER_PUSHED",
                "Selected commits have been pushed since analysis",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "composer_tests.rs"]
mod tests;

struct OwnedIndexLock {
    index: std::path::PathBuf,
    lock: std::path::PathBuf,
    owned: bool,
}
impl OwnedIndexLock {
    fn prepare(index: std::path::PathBuf, prepared: &Path) -> Result<Self, DesktopError> {
        use std::io::Write;
        let lock = index.with_file_name("index.lock");
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&lock).map_err(|e| error("AI_COMPOSER_INDEX_LOCKED", format!("Unable to lock the repository index: {e}. Retry after the other Git operation finishes.")))?;
        let guard = Self {
            index,
            lock,
            owned: true,
        };
        let bytes = std::fs::read(prepared)
            .map_err(|e| error("AI_COMPOSER_INDEX_FAILED", e.to_string()))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| error("AI_COMPOSER_INDEX_FAILED", e.to_string()))?;
        Ok(guard)
    }
    fn publish(mut self) -> std::io::Result<()> {
        std::fs::rename(&self.lock, &self.index)?;
        self.owned = false;
        Ok(())
    }
}
impl Drop for OwnedIndexLock {
    fn drop(&mut self) {
        if self.owned {
            let _ = std::fs::remove_file(&self.lock);
        }
    }
}

async fn prune_backups(root: &Path, token: &CancellationToken) -> Result<(), DesktopError> {
    let refs = git(
        root,
        args(&[
            "for-each-ref",
            "--sort=-refname",
            "--format=%(refname) %(objectname)",
            "refs/versiondock/ai-composer/",
        ]),
        None,
        &[],
        token,
    )
    .await?;
    for row in refs.lines().skip(10) {
        if let Some((reference, expected)) = row.split_once(' ') {
            let _ = git(
                root,
                vec![
                    "update-ref".into(),
                    "-d".into(),
                    reference.into(),
                    expected.into(),
                ],
                None,
                &[],
                token,
            )
            .await;
        }
    }
    Ok(())
}
