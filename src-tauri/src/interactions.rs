//! In-operation prompts: retry only the failed command, never an entire batch.
use crate::models::{DesktopError, PushProtectionTarget, RepositoryMeta, RequestContext};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use specta::Type;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub enum InteractionKind {
    SvnAuthentication,
    PushRecovery,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InteractionEvent {
    NativeInteractionRequest {
        id: String,
        operation_id: String,
        context: RequestContext,
        kind: InteractionKind,
        repo_id: String,
        repo_name: String,
        detail: String,
        remote: Option<String>,
        branch: Option<String>,
        prefer_merge: bool,
    },
    NativeInteractionClosed {
        id: String,
    },
}

#[derive(Debug, Default, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct InteractionResponse {
    pub choice: String,
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub push_approvals: Vec<PushProtectionTarget>,
}
struct Pending {
    window: String,
    sender: oneshot::Sender<InteractionResponse>,
}
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(Default::default)
}
struct PromptGuard {
    id: String,
    reporter: crate::state::OperationReporter,
}
impl Drop for PromptGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = pending().lock() {
            pending.remove(&self.id);
        }
        let _ = self.reporter.app.emit_to(
            &self.reporter.window_label,
            "versiondock://interaction",
            InteractionEvent::NativeInteractionClosed {
                id: self.id.clone(),
            },
        );
    }
}

#[cfg(test)]
tokio::task_local! { static TEST_RESPONDER: std::sync::Arc<dyn Fn(InteractionKind) -> InteractionResponse + Send + Sync>; }
#[cfg(test)]
pub(crate) async fn with_test_responder<F: std::future::Future>(
    responder: std::sync::Arc<dyn Fn(InteractionKind) -> InteractionResponse + Send + Sync>,
    future: F,
) -> F::Output {
    TEST_RESPONDER.scope(responder, future).await
}
pub(crate) fn available() -> bool {
    #[cfg(test)]
    if TEST_RESPONDER.try_with(|_| ()).is_ok() {
        return true;
    }
    crate::state::current_operation_reporter().is_some()
}

pub async fn ask(
    repo: &RepositoryMeta,
    kind: InteractionKind,
    detail: &str,
    remote: Option<&str>,
    branch: Option<&str>,
    prefer_merge: bool,
    token: &CancellationToken,
) -> Result<Option<InteractionResponse>, DesktopError> {
    #[cfg(test)]
    if let Ok(response) = TEST_RESPONDER.try_with(|responder| responder(kind.clone())) {
        return Ok(Some(response));
    }
    let Some(reporter) = crate::state::current_operation_reporter() else {
        return Ok(None);
    };
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    pending()
        .lock()
        .map_err(|_| DesktopError::new("PROMPT_FAILED", "Unable to start operation prompt", true))?
        .insert(
            id.clone(),
            Pending {
                window: reporter.window_label.clone(),
                sender,
            },
        );
    let _guard = PromptGuard {
        id: id.clone(),
        reporter: reporter.clone(),
    };
    reporter
        .app
        .emit_to(
            &reporter.window_label,
            "versiondock://interaction",
            InteractionEvent::NativeInteractionRequest {
                id,
                operation_id: reporter.operation_id.clone(),
                context: reporter.context.clone(),
                kind,
                repo_id: repo.id.clone(),
                repo_name: repo.name.clone(),
                detail: detail.into(),
                remote: remote.map(str::to_owned),
                branch: branch.map(str::to_owned),
                prefer_merge,
            },
        )
        .map_err(|e| DesktopError::new("PROMPT_FAILED", e.to_string(), true))?;
    let window_closed = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if reporter
                .app
                .get_webview_window(&reporter.window_label)
                .is_none()
            {
                break;
            }
        }
    };
    tokio::select! {
        _ = window_closed => Err(DesktopError::new("REQUEST_CANCELLED", "The requesting window was closed", true)),
        _ = token.cancelled() => Err(DesktopError::new("REQUEST_CANCELLED", "Operation cancelled", true)),
        result = receiver => Ok(result.ok()),
    }
}

#[tauri::command]
pub fn respond_native_interaction(
    id: String,
    response: InteractionResponse,
    window: WebviewWindow,
) -> bool {
    respond(&id, window.label(), response)
}
fn respond(id: &str, window: &str, response: InteractionResponse) -> bool {
    let Ok(mut values) = pending().lock() else {
        return false;
    };
    if !values.get(id).is_some_and(|value| value.window == window) {
        return false;
    }
    values
        .remove(id)
        .is_some_and(|value| value.sender.send(response).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn prompts_are_owned_by_the_requesting_window_and_only_answered_once() {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        pending().lock().unwrap().insert(
            id.clone(),
            Pending {
                window: "owner".into(),
                sender,
            },
        );
        assert!(!respond(&id, "other", InteractionResponse::default()));
        assert!(respond(
            &id,
            "owner",
            InteractionResponse {
                choice: "cancel".into(),
                ..Default::default()
            }
        ));
        assert_eq!(receiver.await.unwrap().choice, "cancel");
        assert!(!respond(&id, "owner", InteractionResponse::default()));
    }
}
