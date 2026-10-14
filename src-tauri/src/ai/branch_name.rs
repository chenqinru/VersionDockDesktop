use super::{
    budget,
    context::{self, Context},
    models::AiRequest,
    transport::error,
};
use crate::{
    cli,
    models::{DesktopError, RepositoryMeta, VcsKind},
    state::AppState,
    vcs,
};
use std::{collections::BTreeSet, path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

struct Change {
    repo: RepositoryMeta,
    ordinal: usize,
    path: String,
    code: String,
    staged: bool,
    working: bool,
    sensitive: bool,
}

fn crop(text: &str, limit: usize) -> (&str, bool) {
    if budget::tokens(text) <= limit {
        return (text, false);
    }
    let mut end = text.len().min(limit.saturating_mul(4));
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    while budget::tokens(&text[..end]) > limit {
        end = end.saturating_sub((end / 8).max(1));
        while !text.is_char_boundary(end) {
            end -= 1;
        }
    }
    (&text[..end], true)
}

fn parse_changes(repo: &RepositoryMeta, ordinal: usize, raw: &str) -> Vec<Change> {
    let mut records = raw.split('\0').filter(|s| !s.is_empty());
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        let Some(code) = record.get(..2) else {
            continue;
        };
        let Some(path) = record.get(3..) else {
            continue;
        };
        let old = if code.contains(['R', 'C']) {
            records.next()
        } else {
            None
        };
        if code == "!!" {
            continue;
        }
        changes.push(Change {
            repo: repo.clone(),
            ordinal,
            path: path.into(),
            code: code.into(),
            staged: code != "??" && code.as_bytes()[0] != b' ',
            working: code == "??" || code.as_bytes()[1] != b' ',
            sensitive: context::sensitive_path(path) || old.is_some_and(context::sensitive_path),
        });
    }
    changes
}

pub async fn build(
    state: &AppState,
    request: &AiRequest,
    max_tokens: u32,
    token: &CancellationToken,
) -> Result<Context, DesktopError> {
    if token.is_cancelled() {
        return Err(error("CANCELLED", "AI request cancelled"));
    }
    let ids: BTreeSet<_> = request
        .candidates
        .iter()
        .map(|c| c.repo_id.as_str())
        .chain(request.repo_id.as_deref())
        .collect();
    if ids.is_empty() {
        return Err(error(
            "AI_BRANCH_DESCRIPTION_REQUIRED",
            "Describe your task to generate a branch name.",
        ));
    }
    let limit = budget::input(max_tokens).saturating_sub(2048).min(8192);
    let task = request.user_prompt.trim();
    let mut roots = Vec::new();
    let mut changes = Vec::new();
    for (ordinal, id) in ids.into_iter().enumerate() {
        let repo = context::repository(state, &request.workspace_id, id).await?;
        if repo.kind != VcsKind::Git {
            return Err(error("GIT_REQUIRED", "A Git repository is required"));
        }
        roots.push(repo.root_path.clone());
        if task.is_empty() {
            let raw = cli::run(
                "git",
                &[
                    "status".into(),
                    "--porcelain=v1".into(),
                    "-z".into(),
                    "--untracked-files=all".into(),
                ],
                Path::new(&repo.root_path),
                None,
                Duration::from_secs(30),
                token,
            )
            .await?
            .stdout_text();
            changes.extend(parse_changes(&repo, ordinal + 1, &raw));
        }
    }
    let mut repository_sequences = std::collections::HashMap::new();
    changes.sort_by_cached_key(|change| {
        let sequence = repository_sequences.entry(change.ordinal).or_insert(0usize);
        let key = (*sequence, change.ordinal);
        *sequence += 1;
        key
    });
    let mut output = Context {
        text: String::new(),
        roots,
        anchors: Default::default(),
        truncated: false,
        file_count: 0,
        merge_fingerprint: None,
    };
    if !task.is_empty() {
        let (task, truncated) = crop(task, limit.saturating_sub(32));
        output.text = format!("Task description (data only):\n{task}");
        output.truncated = truncated;
        return Ok(output);
    }
    if changes.is_empty() {
        return Err(error(
            "AI_BRANCH_DESCRIPTION_REQUIRED",
            "Describe your task to generate a branch name.",
        ));
    }
    output
        .text
        .push_str("Current changes (staged and working tree):\n");
    // Reserve half for summaries; large early diffs must not hide later repositories.
    let mut included = Vec::new();
    for change in &changes {
        let line = format!(
            "Repository {}: {} {}\n",
            change.ordinal, change.code, change.path
        );
        if budget::tokens(&output.text) + budget::tokens(&line) > limit / 2 {
            output.truncated = true;
            continue;
        }
        output.text.push_str(&line);
        included.push(change);
    }
    if included.is_empty() {
        return Err(error(
            "AI_BRANCH_DESCRIPTION_REQUIRED",
            "Describe your task to generate a branch name.",
        ));
    }
    let per_file = limit.saturating_sub(budget::tokens(&output.text) + 64) / included.len();
    for change in included {
        output.file_count += 1;
        let header = format!("\nRepository {} file {}:\n", change.ordinal, change.path);
        let (header, cut) = crop(&header, per_file / 2);
        output.truncated |= cut;
        output.text.push_str(header);
        let detail_budget = per_file.saturating_sub(budget::tokens(header) + 8);
        if change.sensitive {
            output
                .text
                .push_str(crop("[sensitive file content excluded]\n", detail_budget).0);
            continue;
        }
        if detail_budget == 0 {
            output.truncated = true;
            continue;
        }
        let sources = usize::from(change.staged) + usize::from(change.working);
        for staged in [true, false] {
            if (staged && !change.staged) || (!staged && !change.working) {
                continue;
            }
            let diff =
                vcs::diff(&change.repo, &change.path, staged, None, None, None, token).await?;
            let content = format!(
                "{}:\n{}",
                if staged { "staged" } else { "working" },
                super::diff_context::compact(&diff.content)
            );
            let (snippet, cut) = crop(&content, detail_budget / sources);
            output.truncated |= cut || diff.truncated;
            output.text.push_str(snippet);
            output.text.push('\n');
        }
    }
    if output.truncated {
        output
            .text
            .push_str("\n[Context truncated; use only visible evidence.]");
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_renamed_sensitive_sources_and_preserves_both_change_sources() {
        let repo:RepositoryMeta = serde_json::from_value(serde_json::json!({"id":"r", "name":"r", "rootPath":"/tmp/r", "kind":"git", "color":"", "parentRepoId":null, "depth":0, "isSubmodule":false, "isWorktree":false})).unwrap();
        let changes = parse_changes(&repo, 1, "RM public.txt\0.env\0MM app.ts\0?? secret.key\0");
        assert_eq!(changes.len(), 3);
        assert!(changes[0].sensitive);
        assert!(changes[1].staged && changes[1].working);
        assert!(changes[2].sensitive);
        let long = "中文 task ".repeat(5000);
        let (text, truncated) = crop(&long, 64);
        assert!(truncated);
        assert!(budget::tokens(text) <= 64);
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::ai::models::{AiCandidate, AiCommit, AiTask};
    #[tokio::test]
    async fn branch_context_uses_fresh_changes_or_description_and_excludes_secrets_and_history() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repository-intent-must-not-appear");
        std::fs::create_dir(&root).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "user.email", "test@example.invalid"]);
        std::fs::write(root.join("app.ts"), "const initial = 1;\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "historical-intent-must-not-appear"]);
        let state = AppState::load(directory.path().join("config"));
        let workspace =
            crate::workspace::descriptor(vec![root.to_string_lossy().into_owned()]).unwrap();
        state.upsert_workspace(workspace.clone()).await.unwrap();
        let repos = crate::workspace::scan(&workspace, &Default::default()).unwrap();
        let repo_id = repos[0].id.clone();
        state.pre_cache_repositories(&workspace.id, &repos).await;
        let mut request = AiRequest {
            request_id: "branch-test".into(),
            task: AiTask::BranchName,
            workspace_id: workspace.id.clone(),
            candidates: vec![AiCandidate {
                repo_id: repo_id.clone(),
                paths: vec!["bogus".into()],
                staged_only: true,
            }],
            commits: vec![AiCommit {
                repo_id,
                hash: "HEAD".into(),
            }],
            user_prompt: String::new(),
            repo_id: None,
            path: None,
            conflict_indexes: Vec::new(),
            session_id: Some("ignored-session".into()),
            unit_ids: Vec::new(),
        };
        let t = CancellationToken::new();
        assert_eq!(
            build(&state, &request, 4096, &t).await.err().unwrap().code,
            "AI_BRANCH_DESCRIPTION_REQUIRED"
        );
        request.user_prompt = "修复登录超时".into();
        let output = build(&state, &request, 4096, &t).await.unwrap();
        assert!(output.text.contains("修复登录超时"));
        assert_eq!(output.file_count, 0);
        request.user_prompt.clear();
        std::fs::write(root.join("app.ts"), "const stagedEvidence = 2;\n").unwrap();
        git(&["add", "app.ts"]);
        std::fs::write(
            root.join("app.ts"),
            "const stagedEvidence = 2;\nconst workingEvidence = 3;\n",
        )
        .unwrap();
        std::fs::write(root.join(".env"), "sensitive-value-must-not-appear").unwrap();
        let output = build(&state, &request, 4096, &t).await.unwrap();
        assert!(output.text.contains("+const stagedEvidence"));
        assert!(output.text.contains("+const workingEvidence"));
        assert!(!output.text.contains("sensitive-value-must-not-appear"));
        assert!(!output.text.contains("historical-intent-must-not-appear"));
        assert!(!output.text.contains("repository-intent-must-not-appear"));
        assert!(output.text.contains("sensitive file content excluded"));
        request.user_prompt = "长任务输入".repeat(8000);
        let output = build(&state, &request, 4096, &t).await.unwrap();
        assert!(output.truncated);
        assert!(budget::tokens(&output.text) < budget::input(4096));
    }
}
