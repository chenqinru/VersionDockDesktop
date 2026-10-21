//! Connection status comes from a successful matching hook round, not event-name history.
use super::{
    belongs, has_hooks_for_config, hook_command, hooks_installed, io, storage::*, types::*,
};
use crate::models::WorkspaceDescriptor;
use std::{collections::BTreeMap, path::Path};

pub(super) fn all(
    db: &Database,
    workspace: &WorkspaceDescriptor,
    config: &Path,
) -> BTreeMap<String, HookConnection> {
    let installation = hooks_installed(config);
    let has_handler = super::codex_home().ok().is_some_and(|home| {
        has_hooks_for_config(&home.join("hooks.json"), config).unwrap_or(false)
    });
    let expected = std::env::current_exe()
        .map_err(io)
        .and_then(|exe| hook_command(config, &exe))
        .map(|cmd| digest(cmd.as_bytes()));
    db.tasks.iter().filter(|task| belongs(task, workspace)).map(|task| {
        let verification = db.verified_hooks.get(&task.id);
        let verified = verification.is_some_and(|v| expected.as_ref().is_ok_and(|expected| expected == &v.command_fingerprint));
        let (status, error) = if task.mode == RecordingMode::Manual { ("manual", None) }
        else if let Some(error) = &task.hook_error { ("error", Some(error.clone())) }
        else { match &installation {
            Err(error) => ("invalid", Some(error.message.clone())),
            Ok(false) if has_handler => ("invalid", Some("Install or update the Codex checkpoint hooks, then review and trust them in Codex.".into())),
            Ok(false) => ("notInstalled", Some("Install or update the Codex checkpoint hooks, then review and trust them in Codex.".into())),
            Ok(true) if verified => ("verified", None),
            Ok(true) => ("unverified", None),
        }};
        (task.id.clone(), HookConnection { status: status.into(), verified_at: verification.filter(|_| verified).map(|v| v.completed_at.clone()), error })
    }).collect()
}
