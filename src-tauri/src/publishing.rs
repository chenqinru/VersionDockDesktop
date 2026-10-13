use std::future::Future;

use tokio_util::sync::CancellationToken;

use crate::{
    commands::with_write,
    models::{
        DesktopError, OperationStatus, PublishRepositoryResult, RemoteOperation, RemoteRepository,
        RepositoryMeta,
    },
    state::{self, AppState},
    vcs,
};

// Serialize the remote creation as well as local writes, across windows and
// workspace aliases. The Git write lock is held only for local operations.
pub(crate) async fn publish_repository<Create, Created, Push, Pushed>(
    state: &AppState,
    repo: &RepositoryMeta,
    push: bool,
    token: &CancellationToken,
    create: Create,
    push_branch: Push,
) -> Result<PublishRepositoryResult, DesktopError>
where
    Create: FnOnce() -> Created,
    Created: Future<Output = Result<RemoteRepository, DesktopError>>,
    Push: FnOnce(String, String, RemoteRepository) -> Pushed,
    Pushed: Future<Output = Result<(), DesktopError>>,
{
    let path = state::canonical_directory(&repo.root_path)?;
    let lock = state
        .write_lock(&format!("publish:{}", path.to_string_lossy()))
        .await;
    state::emit_current_operation(
        OperationStatus::Queued,
        "waitingForRepository",
        "Waiting for the repository write lock",
    );
    if token.is_cancelled() {
        return Err(DesktopError::new(
            "REQUEST_CANCELLED",
            "Operation cancelled",
            true,
        ));
    }
    // Do not queue a second creation behind a partial first publication: the
    // first may have created a remote without configuring origin locally.
    let _guard = lock.try_lock_owned().map_err(|_| {
        DesktopError::new(
            "PUBLISH_IN_PROGRESS",
            "This repository is already being published. Wait for the current operation to finish.",
            true,
        )
    })?;
    let expected = with_write(state, &repo.id, token, vcs::publish_preflight(repo, token)).await?;
    state::emit_current_operation(
        OperationStatus::Running,
        "createRemote",
        "Publishing repository",
    );
    let created = create().await?;
    let mut result = PublishRepositoryResult {
        repository: created.clone(),
        remote_created: true,
        remote_configured: false,
        push_attempted: false,
        pushed: false,
        failed_stage: None,
        recovery_hint: None,
        error: None,
    };
    let local = with_write(state, &repo.id, token, async {
        let current = vcs::publish_preflight(repo, token).await?;
        if current != expected {
            return Err(DesktopError::new(
                "PUBLISH_STATE_CHANGED",
                "The current branch changed while publishing",
                true,
            ));
        }
        state::emit_current_operation(
            OperationStatus::Running,
            "configureRemote",
            "Publishing repository",
        );
        vcs::remote_operation(
            repo,
            RemoteOperation::Add {
                name: "origin".into(),
                url: created.clone_url.clone(),
            },
            token,
        )
        .await?;
        result.remote_configured = true;
        if push {
            // External Git processes do not take our lock. Verify origin and
            // branch again immediately before handing off to the push command.
            let remotes = vcs::remotes(repo, token).await?;
            if !remotes.iter().any(|remote| {
                remote.name == "origin"
                    && remote.fetch_url == created.clone_url
                    && remote.push_url == created.clone_url
            }) {
                return Err(DesktopError::new(
                    "REMOTE_APPEARED",
                    "A remote appeared while publishing",
                    true,
                ));
            }
            if vcs::publish_head(repo, token).await? != expected {
                return Err(DesktopError::new(
                    "PUBLISH_STATE_CHANGED",
                    "The current branch changed while publishing",
                    true,
                ));
            }
            result.push_attempted = true;
            state::emit_current_operation(
                OperationStatus::Running,
                "push",
                "Publishing repository",
            );
            push_branch(expected.0, expected.1, created.clone()).await?;
            result.pushed = true;
        }
        Ok::<(), DesktopError>(())
    })
    .await;
    if let Err(error) = local {
        result.failed_stage = Some(
            if result.remote_configured {
                "push"
            } else {
                "localRemote"
            }
            .into(),
        );
        result.recovery_hint = Some(created.web_url.clone().unwrap_or(created.clone_url.clone()));
        result.error = Some(error);
    }
    Ok(result)
}
