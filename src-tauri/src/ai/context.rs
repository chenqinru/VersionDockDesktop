use super::{models::*, transport::error};
use crate::{
    models::{DesktopError, RepositoryMeta, VcsKind},
    state::AppState,
    vcs,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
use tokio_util::sync::CancellationToken;
type DiffEvidence = (RepositoryMeta, String, bool, String);
type ContextBlock = (String, Option<DiffEvidence>);
pub struct Context {
    pub text: String,
    pub roots: Vec<String>,
    pub anchors: HashMap<String, AiAnchor>,
    pub truncated: bool,
    pub file_count: u32,
    pub merge_fingerprint: Option<String>,
}
pub fn fingerprint(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}
pub async fn repository(
    state: &AppState,
    workspace_id: &str,
    repo_id: &str,
) -> Result<RepositoryMeta, DesktopError> {
    crate::commands::resolve_repo(state, workspace_id, repo_id).await
}
pub async fn prompt_root(state: &AppState, request: &AiRequest) -> Option<std::path::PathBuf> {
    let workspace = state.workspace(&request.workspace_id).await.ok()?;
    if workspace.paths.len() == 1 {
        return Some(workspace.paths[0].clone().into());
    }
    let mut roots = HashSet::new();
    for id in request
        .candidates
        .iter()
        .map(|c| c.repo_id.as_str())
        .chain(request.commits.iter().map(|c| c.repo_id.as_str()))
        .chain(request.repo_id.as_deref())
    {
        let repo = repository(state, &request.workspace_id, id).await.ok()?;
        if let Some(root) = workspace
            .paths
            .iter()
            .filter(|root| Path::new(&repo.root_path).starts_with(root))
            .max_by_key(|root| root.len())
        {
            roots.insert(root.clone());
        }
    }
    if roots.len() == 1 {
        roots.into_iter().next().map(Into::into)
    } else {
        None
    }
}
pub fn tokens(text: &str) -> usize {
    let ascii = text.bytes().filter(u8::is_ascii).count();
    ascii.div_ceil(4) + text.chars().filter(|c| !c.is_ascii()).count() * 2
}
fn prefix_chars(text: &str, budget: usize) -> (&str, bool) {
    let end = text
        .char_indices()
        .nth(budget)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    (&text[..end], end < text.len())
}
pub async fn build(
    state: &AppState,
    request: &AiRequest,
    max_tokens: u32,
    token: &CancellationToken,
) -> Result<Context, DesktopError> {
    let mut roots = HashSet::new();
    let mut blocks: Vec<ContextBlock> = Vec::new();
    let mut files = 0u32;
    let mut related = HashMap::new();
    let mut merge_fingerprint = None;
    let mut upstream_truncated = false;
    if request.task == AiTask::MergeConflict {
        let repo = repository(
            state,
            &request.workspace_id,
            request
                .repo_id
                .as_deref()
                .ok_or_else(|| error("AI_CONTEXT_EMPTY", "Select a conflict file"))?,
        )
        .await?;
        let path = request
            .path
            .as_deref()
            .ok_or_else(|| error("AI_CONTEXT_EMPTY", "Select a conflict file"))?;
        let versions = vcs::conflict_versions(&repo, path, token).await?;
        if versions.binary {
            return Err(error(
                "AI_BINARY_UNSUPPORTED",
                "AI cannot resolve a binary conflict",
            ));
        }
        let indexes: HashSet<_> = request.conflict_indexes.iter().copied().collect();
        let conflicts: Vec<_> = versions
            .conflicts
            .iter()
            .filter(|c| indexes.contains(&c.index))
            .collect();
        if conflicts.len() != indexes.len() || conflicts.is_empty() {
            return Err(error(
                "AI_CONFLICT_STALE",
                "Requested conflicts are no longer available",
            ));
        }
        merge_fingerprint = Some(versions.fingerprint.clone());
        roots.insert(repo.root_path.clone());
        files = 1;
        let data = conflict_evidence(&versions.marker_content, &versions.conflicts, &indexes);
        blocks.push((format!("File: {path}\nConflict evidence: {}\nReturn JSON only: {{\"resolutions\":[{{\"index\":0,\"content\":\"replacement text\"}}]}}",serde_json::to_string(&data).unwrap_or_default()),None));
    } else if !request.commits.is_empty() {
        for commit in &request.commits {
            let repo = repository(state, &request.workspace_id, &commit.repo_id).await?;
            roots.insert(repo.root_path.clone());
            let detail = vcs::commit_detail(&repo, &commit.hash, token).await?;
            let parent = if repo.kind == VcsKind::Git {
                detail
                    .commit
                    .parents
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into())
            } else {
                commit
                    .hash
                    .trim_start_matches('r')
                    .parse::<u64>()
                    .ok()
                    .map(|n| n.saturating_sub(1).to_string())
                    .unwrap_or_else(|| "0".into())
            };
            let allowed = request
                .candidates
                .iter()
                .find(|c| c.repo_id == repo.id)
                .map(|c| c.paths.as_slice());
            if detail.files.is_empty() {
                blocks.push((
                    format!(
                        "Repository: {}\nCommit: {}\nAuthor: {}\nMessage:\n{}\nNo file changes.",
                        repo.name, commit.hash, detail.commit.author, detail.full_message
                    ),
                    None,
                ));
            }
            for file in detail.files {
                if allowed.is_some_and(|paths| !paths.is_empty() && !paths.contains(&file.path)) {
                    continue;
                }
                let diff = vcs::diff(
                    &repo,
                    &file.path,
                    false,
                    None,
                    Some(parent.clone()),
                    Some(commit.hash.clone()),
                    token,
                )
                .await?;
                upstream_truncated |= diff.truncated;
                files += 1;
                blocks.push((format!("Repository: {}\nCommit: {}\nAuthor: {}\nDate: {}\nMessage:\n{}\nFile: {}\n{}",repo.name,commit.hash,detail.commit.author,detail.commit.author_date,detail.full_message,file.path,super::diff_context::compact(&diff.content)),None));
            }
        }
    } else {
        for candidate in &request.candidates {
            let repo = repository(state, &request.workspace_id, &candidate.repo_id).await?;
            roots.insert(repo.root_path.clone());
            for path in &candidate.paths {
                if request.task == AiTask::CodeReview && sensitive_path(path) {
                    continue;
                }
                let diff =
                    candidate_diff(&repo, path, candidate.staged_only, request.task, token).await?;
                if request.task == AiTask::CodeReview
                    && (diff.content.contains("diff --cc ")
                        || diff.content.contains("diff --combined "))
                {
                    return Err(error(
                        "AI_CONTEXT_CONFLICT",
                        "Resolve existing conflicts before requesting an AI review",
                    ));
                }
                upstream_truncated |= diff.truncated;
                if request.task == AiTask::CodeReview && !diff.binary && !diff.truncated {
                    let snapshot = review_snapshot(&repo, path, candidate.staged_only, token).await;
                    related.insert(
                        format!("{}:{path}:{}", repo.id, candidate.staged_only),
                        related_lines(&diff.content, &snapshot),
                    );
                }
                files += 1;
                if diff.binary {
                    blocks.push((
                        format!(
                            "Repository: {}\nFile: {path}\nBinary change; content omitted.",
                            repo.name
                        ),
                        None,
                    ));
                    continue;
                }
                blocks.push((
                    format!(
                        "Repository: {}\nFile: {path}\nSource: {}\n",
                        repo.name,
                        if candidate.staged_only {
                            "staged"
                        } else {
                            "working"
                        }
                    ),
                    Some((
                        repo.clone(),
                        path.clone(),
                        candidate.staged_only,
                        diff.content,
                    )),
                ));
            }
        }
    }
    if files == 0 && request.commits.is_empty() {
        return Err(error(
            "AI_CONTEXT_EMPTY",
            "Select changes or commits before using AI",
        ));
    }
    let budget = (max_tokens as usize).saturating_sub(4096).max(1024);
    let per_file = (budget / blocks.len().max(1)).max(64);
    let mut text = String::new();
    let mut anchors = HashMap::new();
    let mut truncated = upstream_truncated;
    let mut ordinal = 0usize;
    for (header, details) in blocks {
        let mut section = header;
        let mut section_tokens = tokens(&section);
        if let Some((repo, path, staged, diff)) = details {
            let references = related
                .remove(&format!("{}:{path}:{staged}", repo.id))
                .unwrap_or_default();
            let reserve = if references.is_empty() {
                0
            } else {
                (per_file / 4).min(tokens(&references) + 32)
            };
            let mut old = 0u32;
            let mut in_hunk = false;
            let mut new = 0u32;
            let hash = fingerprint(&diff);
            let focused_diff = super::diff_context::compact(&diff);
            for line in focused_diff.lines() {
                if line.starts_with("@@ ") {
                    in_hunk = true;
                    let ranges: Vec<_> = line.split_whitespace().collect();
                    old = ranges
                        .get(1)
                        .and_then(|s| s.trim_start_matches('-').split(',').next())
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    new = ranges
                        .get(2)
                        .and_then(|s| s.trim_start_matches('+').split(',').next())
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                }
                let changed = in_hunk && (line.starts_with('+') || line.starts_with('-'));
                let row_tokens = tokens(line) + if changed { 16 } else { 1 };
                if section_tokens + row_tokens > per_file.saturating_sub(reserve) {
                    truncated = true;
                    break;
                }
                section_tokens += row_tokens;
                if changed {
                    ordinal += 1;
                    let id = format!("A{ordinal}");
                    let anchor = AiAnchor {
                        id: id.clone(),
                        repo_id: repo.id.clone(),
                        repo_name: repo.name.clone(),
                        file_path: path.clone(),
                        staged,
                        old_line: line.starts_with('-').then_some(old),
                        new_line: line.starts_with('+').then_some(new),
                        fingerprint: hash.clone(),
                    };
                    section.push_str(&format!("[{id}] "));
                    anchors.insert(id, anchor);
                }
                section.push_str(line);
                section.push('\n');
                if line.starts_with(' ') {
                    old += 1;
                    new += 1;
                } else if in_hunk && line.starts_with('+') {
                    new += 1;
                } else if in_hunk && line.starts_with('-') {
                    old += 1;
                }
            }
            if !references.is_empty() {
                section.push_str(
                    "\nRelated unchanged lines (same-file context only, not finding anchors):\n",
                );
                for line in references.lines() {
                    let count = tokens(line) + 1;
                    if section_tokens + count > per_file {
                        break;
                    }
                    section_tokens += count;
                    section.push_str(line);
                    section.push('\n');
                }
            }
        } else if tokens(&section) > per_file {
            let (prefix, cropped) = prefix_chars(&section, per_file / 2);
            truncated |= cropped;
            section = prefix.into();
        }
        text.push_str(&section);
        text.push_str("\n\n");
    }
    if truncated && request.task == AiTask::MergeConflict {
        return Err(error("AI_CONTEXT_TOO_LARGE","Complete conflict context exceeds the input budget. Increase the budget or select fewer conflicts."));
    }
    if upstream_truncated && request.task == AiTask::CodeReview {
        return Err(error(
            "AI_CONTEXT_TOO_LARGE",
            "Selected Diff exceeds the application preview limit. Select smaller changes.",
        ));
    }
    text.push_str(&format!(
        "User draft / request (supporting context only):\n{}\nContext truncated: {}\n",
        request.user_prompt, truncated
    ));
    Ok(Context {
        text,
        roots: {
            let mut values: Vec<_> = roots.into_iter().collect();
            values.sort();
            values
        },
        anchors,
        truncated,
        file_count: files,
        merge_fingerprint,
    })
}

fn sensitive_path(path: &str) -> bool {
    let name = Path::new(path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || [".pem", ".key", ".pfx", ".p12", ".pkcs12", ".kdbx"]
            .iter()
            .any(|ext| name.ends_with(ext))
        || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
            .iter()
            .any(|key| name == *key || name == format!("{key}.pub"))
}
async fn review_snapshot(
    repo: &RepositoryMeta,
    path: &str,
    staged: bool,
    token: &CancellationToken,
) -> String {
    if staged && repo.kind == VcsKind::Git {
        return crate::cli::run(
            "git",
            &["show".into(), format!(":{path}")],
            Path::new(&repo.root_path),
            None,
            std::time::Duration::from_secs(30),
            token,
        )
        .await
        .ok()
        .map(|r| r.stdout_text())
        .unwrap_or_default();
    }
    if let Ok(target) = crate::state::safe_relative(Path::new(&repo.root_path), path, false) {
        if let Ok(metadata) = std::fs::metadata(&target) {
            if metadata.len() <= 2 * 1024 * 1024 {
                return tokio::fs::read_to_string(target).await.unwrap_or_default();
            }
        }
    }
    vcs::file_revision_content(
        repo,
        path,
        if repo.kind == VcsKind::Git {
            "HEAD"
        } else {
            "BASE"
        },
        crate::models::CatFileFilterMode::None,
        token,
    )
    .await
    .ok()
    .map(|v| v.content)
    .unwrap_or_default()
}
fn identifiers(line: &str) -> HashSet<String> {
    const STOP: &[&str] = &[
        "async",
        "await",
        "boolean",
        "break",
        "case",
        "catch",
        "class",
        "const",
        "continue",
        "default",
        "else",
        "export",
        "extends",
        "false",
        "final",
        "finally",
        "for",
        "from",
        "function",
        "if",
        "implements",
        "import",
        "interface",
        "let",
        "new",
        "null",
        "number",
        "object",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "static",
        "string",
        "super",
        "switch",
        "this",
        "throw",
        "throws",
        "true",
        "try",
        "undefined",
        "var",
        "void",
        "while",
    ];
    line.split(|c: char| !c.is_ascii_alphanumeric() && !"_$.:/-".contains(c))
        .map(|s| s.trim_end_matches(['.', ':', '/', '-']).to_lowercase())
        .filter(|s| {
            s.len() >= 3
                && s.len() <= 96
                && !STOP.contains(&s.as_str())
                && s.chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        })
        .collect()
}
fn related_lines(diff: &str, snapshot: &str) -> String {
    let mut added = HashSet::new();
    let mut removed = HashSet::new();
    let mut covered = HashSet::new();
    let mut line_number = 0usize;
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("@@ ") {
            in_hunk = true;
            line_number = line
                .split_whitespace()
                .nth(2)
                .and_then(|s| s.trim_start_matches('+').split(',').next())
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            continue;
        }
        if !in_hunk {
            continue;
        }
        if let Some(text) = line.strip_prefix('+') {
            added.extend(identifiers(text));
        } else if let Some(text) = line.strip_prefix('-') {
            removed.extend(identifiers(text));
        }
        if line.starts_with('+') {
            covered.insert(line_number);
        }
        if line.starts_with(' ') || line.starts_with('+') {
            line_number += 1;
        }
    }
    let mut keywords: Vec<_> = added.union(&removed).cloned().collect();
    keywords.sort_by_key(|s| {
        (
            added.contains(s) == removed.contains(s),
            std::cmp::Reverse(s.len()),
            s.clone(),
        )
    });
    keywords.truncate(32);
    let lines: Vec<_> = snapshot.lines().collect();
    let mut matches = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if covered.contains(&(index + 1)) {
            continue;
        }
        let values = identifiers(line);
        if let Some(rank) = keywords.iter().position(|k| values.contains(k)) {
            matches.push((rank, index));
        }
    }
    matches.sort();
    matches.truncate(24);
    let mut selected = std::collections::BTreeSet::new();
    for (_, index) in matches {
        for n in index.saturating_sub(1)..=(index + 1).min(lines.len().saturating_sub(1)) {
            if !covered.contains(&(n + 1)) {
                selected.insert(n);
            }
        }
    }
    selected
        .into_iter()
        .map(|i| format!("line:{} | {}\n", i + 1, lines[i]))
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conflict_context_excludes_markers_and_adjacent_blocks() {
        let conflicts = vec![
            crate::models::ConflictBlock {
                index: 0,
                ours_label: "ours".into(),
                theirs_label: "theirs".into(),
                ours_lines: vec!["a".into()],
                theirs_lines: vec!["b".into()],
                base_lines: vec![],
                start_line: 1,
                end_line: 5,
            },
            crate::models::ConflictBlock {
                index: 1,
                ours_label: "ours".into(),
                theirs_label: "theirs".into(),
                ours_lines: vec!["c".into()],
                theirs_lines: vec!["d".into()],
                base_lines: vec![],
                start_line: 7,
                end_line: 11,
            },
        ];
        let data = conflict_evidence("before\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\nbetween\n<<<<<<< ours\nc\n=======\nd\n>>>>>>> theirs\nafter", &conflicts, &HashSet::from([0,1]));
        assert_eq!(data[0]["before"], serde_json::json!(["before"]));
        assert_eq!(data[0]["after"], serde_json::json!(["between"]));
        assert_eq!(data[1]["before"], serde_json::json!(["between"]));
        assert_eq!(data[1]["after"], serde_json::json!(["after"]));
    }
    #[test]
    fn includes_unchanged_references_without_making_them_anchors() {
        let diff = "@@ -1 +1 @@\n-const oldName = 1;\n+const newName = 1;\n";
        let snapshot = "const newName = 1;\n\nfunction unrelated() {}\nconst usage = oldName;\n";
        let context = related_lines(diff, snapshot);
        assert!(context.contains("line:4 | const usage = oldName;"));
        assert!(!context.contains("line:1 |"));
        assert!(sensitive_path("config/.env.production"));
        assert!(!sensitive_path("env.ts"));
    }
}

async fn candidate_diff(
    repo: &RepositoryMeta,
    path: &str,
    staged: bool,
    task: AiTask,
    token: &CancellationToken,
) -> Result<crate::models::DiffDocument, DesktopError> {
    if task != AiTask::CommitMessage || staged || repo.kind != VcsKind::Git {
        return vcs::diff(repo, path, staged, None, None, None, token).await;
    }
    let head = crate::cli::run(
        "git",
        &["rev-parse".into(), "--verify".into(), "HEAD".into()],
        Path::new(&repo.root_path),
        None,
        std::time::Duration::from_secs(30),
        token,
    )
    .await;
    if head.is_ok() {
        return vcs::branch_working_file_diff(repo, "HEAD", path, token).await;
    }
    let mut index = vcs::diff(repo, path, true, None, None, None, token).await?;
    let working = vcs::diff(repo, path, false, None, None, None, token).await?;
    index
        .content
        .push_str("\nWorking changes after the staged snapshot:\n");
    index.content.push_str(&working.content);
    index.binary |= working.binary;
    index.truncated |= working.truncated;
    Ok(index)
}

#[cfg(test)]
mod combined_diff_tests {
    use super::*;
    #[tokio::test]
    async fn commit_messages_include_staged_and_unstaged_parts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(out.status.success());
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.name", "AI QA"]);
        git(&["config", "user.email", "aiqa@example.invalid"]);
        let path = root.join("selected.ts");
        std::fs::write(&path, "const original = 1;\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "initial"]);
        std::fs::write(&path, "const staged = 2;\n").unwrap();
        git(&["add", "."]);
        std::fs::write(&path, "const staged = 2;\nconst working = 3;\n").unwrap();
        let repo = RepositoryMeta {
            id: "r".into(),
            name: "r".into(),
            root_path: root.to_string_lossy().into(),
            kind: VcsKind::Git,
            color: "#000".into(),
            parent_repo_id: None,
            depth: 0,
            is_worktree: false,
            is_submodule: false,
        };
        let token = CancellationToken::new();
        let diff = candidate_diff(&repo, "selected.ts", false, AiTask::CommitMessage, &token)
            .await
            .unwrap();
        assert!(diff.content.contains("+const staged = 2;"));
        assert!(diff.content.contains("+const working = 3;"));
        assert!(diff.content.contains("-const original = 1;"));
        let diff = candidate_diff(&repo, "selected.ts", false, AiTask::CodeReview, &token)
            .await
            .unwrap();
        assert!(!diff.content.contains("+const staged = 2;"));
        assert!(diff.content.contains("+const working = 3;"));
    }
}

fn conflict_evidence(
    content: &str,
    conflicts: &[crate::models::ConflictBlock],
    indexes: &HashSet<u32>,
) -> Vec<serde_json::Value> {
    let lines: Vec<_> = content.split('\n').collect();
    let mut ordered: Vec<_> = conflicts.iter().collect();
    ordered.sort_by_key(|conflict| conflict.start_line);
    ordered.iter().enumerate().filter(|(_, conflict)| indexes.contains(&conflict.index)).map(|(position, conflict)| {
        let start = (conflict.start_line as usize).min(lines.len());
        let end = (conflict.end_line as usize + 1).min(lines.len());
        let before = start.saturating_sub(30).max(position.checked_sub(1).map_or(0, |index| ordered[index].end_line as usize + 1)).min(start);
        let after = (end + 30).min(lines.len()).min(ordered.get(position + 1).map_or(lines.len(), |next| next.start_line as usize)).max(end);
        serde_json::json!({"index":conflict.index,"current":conflict.ours_lines,"base":conflict.base_lines,"incoming":conflict.theirs_lines,"before":lines[before..start],"after":lines[end..after]})
    }).collect()
}
