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
    selected_by_repository: BTreeMap<String, String>,
}

pub async fn state(
    config_dir: &Path,
    repo: &RepositoryMeta,
    token: &CancellationToken,
) -> Result<GitIdentityState, DesktopError> {
    let file = load(config_dir);
    let selected_profile_id = file.selected_by_repository.get(&repo.id).cloned();
    let local = read_identity(repo, true, token).await?;
    let global = read_identity(repo, false, token).await?;
    let effective = selected_profile_id
        .as_ref()
        .and_then(|id| file.profiles.iter().find(|profile| &profile.id == id))
        .map(|profile| EffectiveGitIdentity {
            user_name: profile.user_name.clone(),
            email: profile.email.clone(),
            source: GitIdentitySource::Custom,
            profile_id: Some(profile.id.clone()),
            valid: valid_identity(&profile.user_name, &profile.email),
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
    repo: &RepositoryMeta,
    operation: GitProfileOperation,
    token: &CancellationToken,
) -> Result<GitIdentityState, DesktopError> {
    let mut file = load(config_dir);
    match operation {
        GitProfileOperation::Save { mut profile } => {
            profile.id = profile.id.trim().to_string();
            profile.label = profile.label.trim().to_string();
            profile.user_name = profile.user_name.trim().to_string();
            profile.email = profile.email.trim().to_string();
            if profile.id.is_empty()
                || profile.label.is_empty()
                || !valid_identity(&profile.user_name, &profile.email)
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
            file.profiles.retain(|profile| profile.id != profile_id);
            file.selected_by_repository
                .retain(|_, selected| selected != &profile_id);
        }
        GitProfileOperation::Select { profile_id } => {
            if let Some(id) = profile_id {
                if !file.profiles.iter().any(|profile| profile.id == id) {
                    return Err(DesktopError::new(
                        "GIT_PROFILE_NOT_FOUND",
                        "The selected Git identity profile no longer exists",
                        true,
                    ));
                }
                file.selected_by_repository.insert(repo.id.clone(), id);
            } else {
                file.selected_by_repository.remove(&repo.id);
            }
        }
    }
    save(config_dir, &file)?;
    state(config_dir, repo, token).await
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
    repo: &RepositoryMeta,
    local: bool,
    token: &CancellationToken,
) -> Result<Option<EffectiveGitIdentity>, DesktopError> {
    #[cfg(test)]
    if !local {
        return Ok(None);
    }
    let scope = if local { "--local" } else { "--global" };
    let root = Path::new(&repo.root_path);
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
        let initial = state(config_dir.path(), &repo, &token).await.unwrap();
        assert_eq!(initial.effective.user_name, "Local User");
        let profile = GitProfile {
            id: "custom".into(),
            label: "Release".into(),
            user_name: "Release Bot".into(),
            email: "release@example.test".into(),
        };
        operate(
            config_dir.path(),
            &repo,
            GitProfileOperation::Save { profile },
            &token,
        )
        .await
        .unwrap();
        let selected = operate(
            config_dir.path(),
            &repo,
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
}
