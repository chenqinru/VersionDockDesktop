use super::{
    models::{AiPrompt, AiTask},
    transport::error,
};
use crate::models::DesktopError;
use std::path::{Path, PathBuf};
pub fn builtin(task: AiTask, chinese: bool) -> &'static str {
    match (task, chinese) {
        (AiTask::CommitMessage, true) => include_str!("prompts/commit-message.zh.md"),
        (AiTask::CommitMessage, false) => include_str!("prompts/commit-message.en.md"),
        (AiTask::CommitExplanation, true) => include_str!("prompts/commit-explanation.zh.md"),
        (AiTask::CommitExplanation, false) => include_str!("prompts/commit-explanation.en.md"),
        (AiTask::CodeReview, true) => include_str!("prompts/code-review.zh.md"),
        (AiTask::CodeReview, false) => include_str!("prompts/code-review.en.md"),
        (AiTask::CommitComposer, true) => include_str!("prompts/commit-composer.zh.md"),
        (AiTask::CommitComposer, false) => include_str!("prompts/commit-composer.en.md"),
        (AiTask::MergeConflict, true) => include_str!("prompts/merge-conflict.zh.md"),
        (AiTask::MergeConflict, false) => include_str!("prompts/merge-conflict.en.md"),
    }
}
fn filename(task: AiTask) -> String {
    format!("ai-{}.prompt.md", task.name())
}
fn global_path(config: &Path, task: AiTask) -> PathBuf {
    config
        .join("ai-prompts")
        .join(if task == AiTask::CommitMessage {
            "prompt.md".into()
        } else {
            filename(task)
        })
}
fn workspace_path(root: &Path, task: AiTask) -> Result<PathBuf, DesktopError> {
    crate::state::safe_relative(root, &format!(".vscode/{}", filename(task)), true)
}
fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .filter(|s| !s.trim().is_empty())
}
pub fn resolve(config: &Path, root: Option<&Path>, task: AiTask, chinese: bool) -> AiPrompt {
    if let Some(path) = root.and_then(|p| workspace_path(p, task).ok()) {
        if let Some(text) = read(&path) {
            return AiPrompt {
                text,
                source: "workspace".into(),
                path: Some(path.to_string_lossy().into_owned()),
            };
        }
    }
    let path = global_path(config, task);
    if let Some(text) = read(&path) {
        return AiPrompt {
            text,
            source: "global".into(),
            path: Some(path.to_string_lossy().into_owned()),
        };
    }
    AiPrompt {
        text: builtin(task, chinese).into(),
        source: "builtin".into(),
        path: None,
    }
}
pub fn edit(
    config: &Path,
    root: Option<&Path>,
    task: AiTask,
    chinese: bool,
    scope: &str,
    action: &str,
    text: Option<String>,
) -> Result<AiPrompt, DesktopError> {
    if action == "resolve" {
        return Ok(resolve(config, root, task, chinese));
    }
    let path = match scope {
        "workspace" => workspace_path(
            root.ok_or_else(|| {
                error(
                    "AI_PROMPT_WORKSPACE_REQUIRED",
                    "Select a single workspace for this prompt",
                )
            })?,
            task,
        )?,
        "global" => global_path(config, task),
        _ => return Err(error("AI_PROMPT_SCOPE_INVALID", "Unknown prompt scope")),
    };
    match action {
        "read" => Ok(AiPrompt {
            text: read(&path).unwrap_or_else(|| builtin(task, chinese).into()),
            source: scope.into(),
            path: Some(path.to_string_lossy().into_owned()),
        }),
        "save" => {
            let text = text.unwrap_or_default();
            if text.trim().is_empty() || text.len() > 256 * 1024 {
                return Err(error(
                    "AI_PROMPT_INVALID",
                    "Prompt must be non-empty and smaller than 256 KiB",
                ));
            }
            std::fs::create_dir_all(path.parent().unwrap())
                .map_err(|e| error("AI_PROMPT_IO_FAILED", e.to_string()))?;
            std::fs::write(&path, &text)
                .map_err(|e| error("AI_PROMPT_IO_FAILED", e.to_string()))?;
            Ok(AiPrompt {
                text,
                source: scope.into(),
                path: Some(path.to_string_lossy().into_owned()),
            })
        }
        "reset" => {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(error("AI_PROMPT_IO_FAILED", e.to_string())),
            };
            edit(config, root, task, chinese, scope, "read", None)
        }
        _ => Err(error("AI_PROMPT_ACTION_INVALID", "Unknown prompt action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_global_builtin_priority_and_scoped_reset() {
        let config = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let task = AiTask::CodeReview;
        assert_eq!(
            resolve(config.path(), Some(workspace.path()), task, true).source,
            "builtin"
        );
        edit(
            config.path(),
            Some(workspace.path()),
            task,
            true,
            "global",
            "save",
            Some("global prompt".into()),
        )
        .unwrap();
        assert_eq!(
            resolve(config.path(), Some(workspace.path()), task, true).text,
            "global prompt"
        );
        edit(
            config.path(),
            Some(workspace.path()),
            task,
            true,
            "workspace",
            "save",
            Some("workspace prompt".into()),
        )
        .unwrap();
        assert_eq!(
            resolve(config.path(), Some(workspace.path()), task, true).text,
            "workspace prompt"
        );
        let reset = edit(
            config.path(),
            Some(workspace.path()),
            task,
            true,
            "global",
            "reset",
            None,
        )
        .unwrap();
        assert_eq!(reset.source, "global");
        assert!(reset.text.contains("AI"));
        assert_eq!(
            resolve(config.path(), Some(workspace.path()), task, true).source,
            "workspace"
        );
        edit(
            config.path(),
            Some(workspace.path()),
            task,
            true,
            "workspace",
            "reset",
            None,
        )
        .unwrap();
        assert_eq!(
            resolve(config.path(), Some(workspace.path()), task, true).source,
            "builtin"
        );
    }
}
