use std::{collections::BTreeMap, path::Path};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    cli,
    models::{
        DesktopError, EffectiveGitIdentity, GitIdentitySource, GitIdentityState, GitProfile,
        GitProfileOperation, RepositoryMeta,
    },
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileFile {
    #[serde(default)]
    profiles: Vec<GitProfile>,
    #[serde(default)]
    selected_by_workspace: BTreeMap<String, String>,
    #[serde(default)]
    selected_by_repository: BTreeMap<String, String>,
}

pub async fn state(
    config_dir: &Path,
    workspace_id: &str,
    repo: Option<&RepositoryMeta>,
    token: &CancellationToken,
) -> Result<GitIdentityState, DesktopError> {
    let file = load(config_dir);
    let selected_profile_id = file
        .selected_by_workspace
        .get(workspace_id)
        .or_else(|| repo.and_then(|repo| file.selected_by_repository.get(&repo.id)))
        .filter(|id| !id.is_empty())
        .cloned();
    let local = if let Some(repo) = repo {
        read_identity(Path::new(&repo.root_path), true, token).await?
    } else {
        None
    };
    let global = read_identity(
        repo.map(|repo| Path::new(&repo.root_path))
            .unwrap_or_else(|| Path::new(".")),
        false,
        token,
    )
    .await?;
    let effective = selected_profile_id
        .as_ref()
        .and_then(|id| match id.as_str() {
            "__local__" => local.clone(),
            "__global__" => global.clone(),
            _ => file
                .profiles
                .iter()
                .find(|profile| &profile.id == id)
                .map(|profile| EffectiveGitIdentity {
                    user_name: profile.user_name.clone(),
                    email: profile.email.clone(),
                    source: GitIdentitySource::Custom,
                    profile_id: Some(profile.id.clone()),
                    valid: valid_identity(&profile.user_name, &profile.email),
                }),
        })
        .or_else(|| local.clone())
        .or_else(|| global.clone())
        .unwrap_or_else(missing_identity);
    Ok(GitIdentityState {
        profiles: file.profiles,
        selected_profile_id,
        local,
        global,
        effective,
    })
}

pub async fn operate(
    config_dir: &Path,
    workspace_id: &str,
    repo: Option<&RepositoryMeta>,
    operation: GitProfileOperation,
    token: &CancellationToken,
) -> Result<GitIdentityState, DesktopError> {
    // Profiles share one file across repositories and workspaces.
    static WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = WRITE_LOCK.lock().await;
    let mut file = load(config_dir);
    match operation {
        GitProfileOperation::Save { mut profile } => {
            profile.id = profile.id.trim().to_string();
            profile.label = profile.label.trim().to_string();
            profile.user_name = profile.user_name.trim().to_string();
            profile.email = profile.email.trim().to_string();
            if profile.id.is_empty()
                || profile.label.is_empty()
                || matches!(profile.id.as_str(), "__local__" | "__global__")
                || matches!(profile.label.to_lowercase().as_str(), "local" | "global")
                || profile.email.is_empty()
                || has_control(&profile.label)
                || has_control(&profile.user_name)
                || has_control(&profile.email)
            {
                return Err(DesktopError::new(
                    "INVALID_GIT_PROFILE",
                    "Profile label, user.name and user.email must be valid",
                    true,
                ));
            }
            if let Some(current) = file.profiles.iter_mut().find(|item| item.id == profile.id) {
                *current = profile;
            } else {
                file.profiles.push(profile);
            }
        }
        GitProfileOperation::Delete { profile_id } => {
            if matches!(profile_id.as_str(), "__local__" | "__global__") {
                return Err(DesktopError::new(
                    "INVALID_GIT_PROFILE",
                    "Built-in profiles cannot be deleted",
                    false,
                ));
            }
            for selected in file.selected_by_workspace.values_mut() {
                if *selected == profile_id {
                    selected.clear();
                }
            }
            file.profiles.retain(|profile| profile.id != profile_id);
            file.selected_by_repository
                .retain(|_, selected| selected != &profile_id);
        }
        GitProfileOperation::Select { profile_id } => {
            if let Some(id) = profile_id {
                if !matches!(id.as_str(), "__local__" | "__global__")
                    && !file.profiles.iter().any(|profile| profile.id == id)
                {
                    return Err(DesktopError::new(
                        "GIT_PROFILE_NOT_FOUND",
                        "The selected Git identity profile no longer exists",
                        true,
                    ));
                }
                file.selected_by_workspace
                    .insert(workspace_id.to_string(), id);
            } else {
                file.selected_by_workspace
                    .insert(workspace_id.to_string(), String::new());
            }
        }
    }
    save(config_dir, &file)?;
    state(config_dir, workspace_id, repo, token).await
}

fn load(config_dir: &Path) -> ProfileFile {
    std::fs::read(config_dir.join("git-profiles.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(config_dir: &Path, value: &ProfileFile) -> Result<(), DesktopError> {
    std::fs::create_dir_all(config_dir)
        .map_err(|error| DesktopError::new("PROFILE_IO_FAILED", error.to_string(), true))?;
    let target = config_dir.join("git-profiles.json");
    let temporary = config_dir.join("git-profiles.json.tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| DesktopError::new("PROFILE_SERIALIZE_FAILED", error.to_string(), true))?;
    std::fs::write(&temporary, bytes)
        .map_err(|error| DesktopError::new("PROFILE_IO_FAILED", error.to_string(), true))?;
    std::fs::rename(temporary, target)
        .map_err(|error| DesktopError::new("PROFILE_IO_FAILED", error.to_string(), true))
}

async fn read_identity(
    root: &Path,
    local: bool,
    token: &CancellationToken,
) -> Result<Option<EffectiveGitIdentity>, DesktopError> {
    #[cfg(test)]
    if !local {
        return Ok(None);
    }
    let scope = if local { "--local" } else { "--global" };
    let name = cli::run(
        "git",
        &[
            "config".into(),
            scope.into(),
            "--get".into(),
            "user.name".into(),
        ],
        root,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
    .map(|output| output.stdout_text().trim().to_string())
    .unwrap_or_default();
    let email = cli::run(
        "git",
        &[
            "config".into(),
            scope.into(),
            "--get".into(),
            "user.email".into(),
        ],
        root,
        None,
        cli::DEFAULT_TIMEOUT,
        token,
    )
    .await
    .map(|output| output.stdout_text().trim().to_string())
    .unwrap_or_default();
    if name.is_empty() && email.is_empty() {
        return Ok(None);
    }
    Ok(Some(EffectiveGitIdentity {
        valid: valid_identity(&name, &email),
        user_name: name,
        email,
        source: if local {
            GitIdentitySource::Local
        } else {
            GitIdentitySource::Global
        },
        profile_id: None,
    }))
}

fn valid_identity(name: &str, email: &str) -> bool {
    !name.trim().is_empty() && email.contains('@') && !has_control(name) && !has_control(email)
}

fn has_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn missing_identity() -> EffectiveGitIdentity {
    EffectiveGitIdentity {
        user_name: String::new(),
        email: String::new(),
        source: GitIdentitySource::Missing,
        profile_id: None,
        valid: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{GitProfileOperation, VcsKind};
    use std::process::Command;
    use tempfile::tempdir;

    fn run(args: &[&str], cwd: &Path) {
        assert!(Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap()
            .success());
    }

    #[tokio::test]
    async fn resolves_local_and_selected_custom_identity_without_writing_git_config() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repo_dir = tempdir().unwrap();
        let config_dir = tempdir().unwrap();
        run(&["init", "-b", "main"], repo_dir.path());
        run(&["config", "user.name", "Local User"], repo_dir.path());
        run(
            &["config", "user.email", "local@example.test"],
            repo_dir.path(),
        );
        let repo = RepositoryMeta {
            id: "repo-id".into(),
            name: "repo".into(),
            root_path: repo_dir.path().to_string_lossy().into_owned(),
            color: "#4ec9b0".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let token = CancellationToken::new();
        let initial = state(config_dir.path(), "workspace", Some(&repo), &token)
            .await
            .unwrap();
        assert_eq!(initial.effective.user_name, "Local User");
        let profile = GitProfile {
            id: "custom".into(),
            label: "Release".into(),
            user_name: "Release Bot".into(),
            email: "release@example.test".into(),
        };
        operate(
            config_dir.path(),
            "workspace",
            Some(&repo),
            GitProfileOperation::Save { profile },
            &token,
        )
        .await
        .unwrap();
        let selected = operate(
            config_dir.path(),
            "workspace",
            Some(&repo),
            GitProfileOperation::Select {
                profile_id: Some("custom".into()),
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(selected.effective.user_name, "Release Bot");
        let local_name = Command::new("git")
            .args(["config", "--local", "user.name"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&local_name.stdout).trim(),
            "Local User"
        );
    }
    #[tokio::test]
    async fn workspace_selection_applies_to_multiple_repositories_and_real_commits() {
        let repo_dir = tempdir().unwrap();
        let config = tempdir().unwrap();
        run(&["init", "-b", "main"], repo_dir.path());
        run(&["config", "user.name", "Local Dev"], repo_dir.path());
        run(
            &["config", "user.email", "local@example.test"],
            repo_dir.path(),
        );
        let repo = RepositoryMeta {
            id: "alpha".into(),
            name: "alpha".into(),
            root_path: repo_dir.path().to_string_lossy().into_owned(),
            color: "#888".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        let beta = RepositoryMeta {
            id: "beta".into(),
            ..repo.clone()
        };
        let token = CancellationToken::new();
        operate(
            config.path(),
            "ws",
            Some(&repo),
            GitProfileOperation::Save {
                profile: GitProfile {
                    id: "work".into(),
                    label: "Work".into(),
                    user_name: "Work Dev".into(),
                    email: "work@example.test".into(),
                },
            },
            &token,
        )
        .await
        .unwrap();
        operate(
            config.path(),
            "ws",
            Some(&repo),
            GitProfileOperation::Select {
                profile_id: Some("work".into()),
            },
            &token,
        )
        .await
        .unwrap();
        let selected = state(config.path(), "ws", Some(&beta), &token)
            .await
            .unwrap();
        assert_eq!(selected.effective.user_name, "Work Dev");
        assert_eq!(
            state(config.path(), "other", Some(&beta), &token)
                .await
                .unwrap()
                .effective
                .user_name,
            "Local Dev"
        );
        std::fs::write(repo_dir.path().join("tracked.txt"), "test\n").unwrap();
        crate::vcs::commit_with_identity(
            &beta,
            "Identity QA",
            false,
            &["tracked.txt".into()],
            Some(&selected.effective),
            false,
            false,
            &token,
        )
        .await
        .unwrap();
        let output = Command::new("git")
            .args(["log", "-1", "--format=%an <%ae>|%cn <%ce>"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "Work Dev <work@example.test>|Work Dev <work@example.test>"
        );
        let local = operate(
            config.path(),
            "ws",
            Some(&repo),
            GitProfileOperation::Select {
                profile_id: Some("__local__".into()),
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(local.selected_profile_id.as_deref(), Some("__local__"));
        assert_eq!(
            state(config.path(), "ws", Some(&beta), &token)
                .await
                .unwrap()
                .effective
                .user_name,
            "Local Dev"
        );
        let global = operate(
            config.path(),
            "ws",
            Some(&repo),
            GitProfileOperation::Select {
                profile_id: Some("__global__".into()),
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(global.selected_profile_id.as_deref(), Some("__global__"));
        operate(
            config.path(),
            "ws",
            Some(&repo),
            GitProfileOperation::Select {
                profile_id: Some("work".into()),
            },
            &token,
        )
        .await
        .unwrap();
        let deleted = operate(
            config.path(),
            "ws",
            Some(&repo),
            GitProfileOperation::Delete {
                profile_id: "work".into(),
            },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(deleted.selected_profile_id, None);
        assert_eq!(deleted.effective.user_name, "Local Dev");
        let name = Command::new("git")
            .args(["config", "--local", "user.name"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&name.stdout).trim(), "Local Dev");
    }

    #[tokio::test]
    async fn legacy_selection_and_concurrent_profile_writes_are_preserved() {
        let config = tempdir().unwrap();
        let token = CancellationToken::new();
        let profile = GitProfile {
            id: "legacy".into(),
            label: "Legacy".into(),
            user_name: "Legacy User".into(),
            email: "legacy@example.test".into(),
        };
        let repo = RepositoryMeta {
            id: "old".into(),
            name: "old".into(),
            root_path: config.path().to_string_lossy().into_owned(),
            color: "#888".into(),
            kind: VcsKind::Git,
            parent_repo_id: None,
            depth: 0,
            is_submodule: false,
            is_worktree: false,
        };
        save(
            config.path(),
            &ProfileFile {
                profiles: vec![profile.clone()],
                selected_by_repository: BTreeMap::from([("old".into(), "legacy".into())]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            state(config.path(), "ws", Some(&repo), &token)
                .await
                .unwrap()
                .effective
                .user_name,
            "Legacy User"
        );
        let cleared = operate(
            config.path(),
            "ws",
            Some(&repo),
            GitProfileOperation::Select { profile_id: None },
            &token,
        )
        .await
        .unwrap();
        assert_eq!(cleared.selected_profile_id, None);
        let a = GitProfile {
            id: "a".into(),
            label: "A".into(),
            ..profile.clone()
        };
        let b = GitProfile {
            id: "b".into(),
            label: "B".into(),
            ..profile.clone()
        };
        let (a, b) = tokio::join!(
            operate(
                config.path(),
                "ws",
                None,
                GitProfileOperation::Save { profile: a },
                &token
            ),
            operate(
                config.path(),
                "other",
                None,
                GitProfileOperation::Save { profile: b },
                &token
            )
        );
        a.unwrap();
        b.unwrap();
        assert_eq!(
            state(config.path(), "ws", None, &token)
                .await
                .unwrap()
                .profiles
                .len(),
            3
        );
        assert!(operate(
            config.path(),
            "ws",
            None,
            GitProfileOperation::Save {
                profile: GitProfile {
                    label: "Global".into(),
                    ..profile
                }
            },
            &token
        )
        .await
        .is_err());
        assert!(operate(
            config.path(),
            "ws",
            None,
            GitProfileOperation::Delete {
                profile_id: "__local__".into()
            },
            &token
        )
        .await
        .is_err());
    }
}
