use crate::{
    models::{DesktopError, DesktopSettings, PushProtectionTarget, RepositoryMeta, VcsKind},
    state::AppState,
    vcs,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct RemoteRules {
    source: String,
    names: Vec<String>,
    checked_at: Option<Instant>,
}
#[derive(Default)]
pub struct ProtectionCache {
    entries: Mutex<HashMap<String, Arc<tokio::sync::Mutex<RemoteRules>>>>,
}

impl ProtectionCache {
    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }
}

pub fn matches_branch(name: &str, patterns: &[String]) -> bool {
    let name = name
        .trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(name.trim());
    if name.is_empty() || name == "HEAD" {
        return false;
    }
    let name = name.strip_prefix("remotes/").unwrap_or(name);
    let normalized = name
        .split_once('/')
        .map(|(_, suffix)| suffix)
        .unwrap_or(name);
    patterns.iter().any(|pattern| {
        let pattern = pattern.trim().to_lowercase();
        if pattern.is_empty() {
            return false;
        }
        if pattern.contains(['*', '?']) {
            [name, normalized]
                .iter()
                .any(|name| wildcard_match(&pattern, &name.to_lowercase()))
        } else {
            name.eq_ignore_ascii_case(&pattern)
                || normalized.eq_ignore_ascii_case(&pattern)
                || name.to_lowercase().ends_with(&format!("/{pattern}"))
        }
    })
}

// Same glob semantics as the plugin: * excludes '/', ** includes '/', ? is one character.
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let p: Vec<_> = pattern.chars().collect();
    let n: Vec<_> = name.chars().collect();
    let mut row = vec![false; n.len() + 1];
    row[0] = true;
    let mut i = 0;
    while i < p.len() {
        let mut next = vec![false; n.len() + 1];
        if p[i] == '*' {
            let deep = p.get(i + 1) == Some(&'*');
            if deep {
                i += 1;
            }
            next[0] = row[0];
            for j in 1..=n.len() {
                next[j] = row[j] || (next[j - 1] && (deep || n[j - 1] != '/'));
            }
        } else {
            for j in 1..=n.len() {
                next[j] = row[j - 1] && (p[i] == '?' || p[i] == n[j - 1]);
            }
        }
        row = next;
        i += 1;
    }
    row[n.len()]
}

pub async fn rules(
    state: &AppState,
    repo: &RepositoryMeta,
    settings: &DesktopSettings,
    refresh: bool,
    token: &CancellationToken,
) -> Result<Vec<String>, DesktopError> {
    let mut patterns = settings.protected_branches.clone();
    if !settings.sync_protected_branches_from_github || repo.kind != VcsKind::Git {
        return Ok(patterns);
    }
    let remotes = vcs::remotes(repo, token).await?;
    let source = remotes
        .iter()
        .find(|remote| remote.name == "origin")
        .or(remotes.first())
        .map(|remote| remote.fetch_url.clone())
        .unwrap_or_default();
    let entry = {
        let mut entries = state.protection.entries.lock().map_err(|_| {
            DesktopError::new(
                "PROTECTION_CACHE_FAILED",
                "Unable to load branch protection",
                true,
            )
        })?;
        entries.entry(repo.id.clone()).or_default().clone()
    };
    let mut cache = tokio::select! { _ = token.cancelled() => return Err(DesktopError::new("REQUEST_CANCELLED", "Request cancelled", true)), cache = entry.lock() => cache };
    if cache.source != source {
        *cache = RemoteRules {
            source: source.clone(),
            ..Default::default()
        };
    }
    if refresh
        && cache
            .checked_at
            .is_none_or(|last| last.elapsed() > Duration::from_secs(300))
    {
        match crate::provider::protected_branches(&state.config_dir, &source, token).await {
            Ok(names) => cache.names = names,
            Err(error) if error.code == "REQUEST_CANCELLED" => return Err(error),
            Err(error) => crate::logger::log_entry(
                crate::logger::LogLevel::Debug,
                crate::logger::LogChannel::Core,
                "Remote branch protection sync skipped",
                Some(error.message),
                None,
                None,
            ),
        }
        cache.checked_at = Some(Instant::now());
    }
    patterns.extend(cache.names.iter().cloned());
    patterns.sort();
    patterns.dedup();
    Ok(patterns)
}

pub async fn target(
    state: &AppState,
    repo: &RepositoryMeta,
    branch: Option<&str>,
    force: bool,
    refresh: bool,
    token: &CancellationToken,
) -> Result<PushProtectionTarget, DesktopError> {
    let settings = state.app.read().await.settings.clone();
    let branch = match branch {
        Some(branch) => branch.trim_start_matches("refs/heads/").to_string(),
        None => vcs::current_branch_for_protection(repo, token).await?,
    };
    let patterns = rules(state, repo, &settings, refresh, token).await?;
    let protected = repo.kind == VcsKind::Git && matches_branch(&branch, &patterns);
    use sha2::Digest;
    let proof = hex::encode(sha2::Sha256::digest(
        serde_json::to_vec(&(repo.id.clone(), branch.clone(), force, &patterns))
            .unwrap_or_default(),
    ));
    Ok(PushProtectionTarget {
        repo_id: repo.id.clone(),
        repo_name: repo.name.clone(),
        branch,
        force,
        requires_confirmation: protected
            && (force || settings.show_push_dialog_for_protected_branches),
        proof,
    })
}

pub async fn enforce_push(
    state: &AppState,
    repo: &RepositoryMeta,
    branch: Option<&str>,
    force: bool,
    approvals: &[PushProtectionTarget],
    token: &CancellationToken,
) -> Result<(), DesktopError> {
    let expected = target(state, repo, branch, force, false, token).await?;
    let approval = approvals
        .iter()
        .find(|approval| approval.repo_id == expected.repo_id);
    if approval.is_some_and(|approval| approval.proof != expected.proof)
        || (expected.requires_confirmation && approval.is_none())
    {
        return Err(DesktopError::new(
            "PROTECTED_PUSH_CONFIRMATION_REQUIRED",
            "The protected branch or protection rules changed. Confirm the push again.",
            true,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wildcard_patterns_match_plugin_semantics() {
        for (pattern, branch, expected) in [
            ("main", "origin/Main", true),
            ("main", "remotes/origin/main", true),
            ("release/*", "origin/release/one", true),
            ("release/*", "release/one/two", false),
            ("release/**", "release/one/two", true),
            ("ab**cd", "ab/ef/cd", true),
            ("release/?", "release/x", true),
            ("feature/[x]*", "feature/[x]one", true),
            ("feature/[x]*", "feature/xone", false),
            ("main", "HEAD", false),
            (" main ", "refs/heads/main", true),
        ] {
            assert_eq!(
                matches_branch(branch, &[pattern.into()]),
                expected,
                "{pattern} -> {branch}"
            );
        }
    }
}
