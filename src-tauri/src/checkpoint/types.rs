use serde::{Deserialize, Serialize};
#[cfg(test)]
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCatalog {
    pub projects: Vec<crate::models::WorkspaceDescriptor>,
    pub tasks: Vec<TaskWorkspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointProject {
    pub workspace: crate::models::WorkspaceDescriptor,
    pub repositories: Vec<crate::models::RepositoryMeta>,
    pub tasks: Vec<TaskWorkspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CheckpointAction {
    Repositories,
    Activity,
    Overview,
    History {
        task_id: String,
        query: String,
        repository: Option<String>,
        only_changes: bool,
        offset: u32,
        revision: Option<String>,
    },
    StorageUsage {
        task_id: Option<String>,
    },
    ProjectStorageUsage,
    PreviewProjectCleanup {
        keep_recent: u32,
    },
    ProjectCleanup {
        keep_recent: u32,
        fingerprint: String,
    },
    PreviewRedo {
        task_id: String,
    },
    OpenInCodex {
        task_id: String,
    },
    Create {
        name: String,
        repo_ids: Vec<String>,
        mode: RecordingMode,
        isolation: TaskIsolation,
        include_ignored: Vec<String>,
    },
    SetMode {
        task_id: String,
        mode: RecordingMode,
    },
    Begin {
        task_id: String,
        name: String,
    },
    Finish {
        task_id: String,
    },
    Abandon {
        task_id: String,
    },
    Preview {
        task_id: String,
        checkpoint_id: Option<String>,
        bring_back: bool,
    },
    Execute {
        preview_id: String,
    },
    Recover {
        transaction_id: String,
    },
    Detail {
        task_id: String,
        checkpoint_id: String,
    },
    Messages {
        task_id: String,
        checkpoint_id: String,
    },
    RenameTask {
        task_id: String,
        name: String,
    },
    Rename {
        task_id: String,
        checkpoint_id: String,
        name: String,
    },
    Diff {
        source: CheckpointDiffSource,
        repository: String,
        path: String,
        layer: String,
    },
    Remove {
        task_id: String,
    },
    PreviewCleanup {
        task_id: String,
        keep_recent: u32,
    },
    Cleanup {
        task_id: String,
        keep_recent: u32,
        fingerprint: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CheckpointDiffSource {
    Checkpoint {
        task_id: String,
        checkpoint_id: String,
    },
    Preview {
        preview_id: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub enum RecordingMode {
    Manual,
    Automatic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub enum TaskIsolation {
    Original,
    Worktree,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct TaskRepository {
    pub source_id: String,
    pub source_path: String,
    pub task_path: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub status: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub before: String,
    pub after: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, specta(optional))]
    pub summary: Option<CheckpointSummary>,
    #[serde(default)]
    #[cfg_attr(test, specta(optional))]
    pub prompt_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointMessage {
    pub body: String,
    pub annotations: Vec<CheckpointAnnotation>,
    pub attachments: Vec<CheckpointAttachment>,
    pub selections: Vec<String>,
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
pub struct CheckpointAnnotation {
    #[serde(rename = "text")]
    pub quote: String,
    #[serde(rename = "annotation")]
    #[serde(default)]
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointAttachment {
    pub name: String,
    pub path: String,
    pub image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSummary {
    pub files: u32,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspace {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub path: String,
    pub roots: Vec<String>,
    pub repositories: Vec<TaskRepository>,
    pub mode: RecordingMode,
    pub isolation: TaskIsolation,
    pub created_at: String,
    pub seed: String,
    pub source_seed: String,
    pub last_applied: Option<String>,
    pub checkpoints: Vec<Checkpoint>,
    pub hook_events: Vec<String>,
    pub last_hook_at: Option<String>,
    pub hook_error: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct RestoreFile {
    pub repository: String,
    pub path: String,
    pub layer: String,
    pub status: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub id: String,
    pub task_id: String,
    pub bring_back: bool,
    pub files: Vec<RestoreFile>,
    pub conflicts: Vec<String>,
    pub fingerprint: String,
    #[serde(default)]
    #[cfg_attr(test, specta(optional))]
    pub checkpoint_count: u32,
    #[serde(default)]
    #[cfg_attr(test, specta(optional))]
    pub redo_of: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub completed: u32,
    pub total: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointListing {
    pub tasks: Vec<TaskWorkspace>,
    pub recovery: Vec<RestoreReport>,
    #[serde(default)]
    #[cfg_attr(test, specta(optional))]
    pub connections: Option<std::collections::BTreeMap<String, HookConnection>>,
    #[serde(default)]
    #[cfg_attr(test, specta(optional))]
    pub history_counts: Option<std::collections::BTreeMap<String, u32>>,
    #[serde(default)]
    #[cfg_attr(test, specta(optional))]
    pub history_revisions: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    #[cfg_attr(test, specta(optional))]
    pub redo_checkpoints: Option<std::collections::BTreeMap<String, Vec<String>>>,
}

/// Status-bar metadata only: unfinished checkpoints and the latest checkpoint per task.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointActivity {
    pub tasks: Vec<TaskWorkspace>,
    pub recovery: Vec<RestoreReport>,
    #[serde(default)]
    #[cfg_attr(test, specta(optional))]
    pub connections: Option<std::collections::BTreeMap<String, HookConnection>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct HookConnection {
    pub status: String,
    pub verified_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPage {
    pub task_id: String,
    pub points: Vec<Checkpoint>,
    pub total: u32,
    pub matching: u32,
    pub offset: u32,
    pub revision: String,
    pub following_turns: std::collections::BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStorageUsage {
    pub path: String,
    pub total_bytes: f64,
    pub task_bytes: f64,
    pub reclaimable_bytes: Option<f64>,
    pub warning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CheckpointSettingsAction {
    Status,
    InstallHooks,
    OpenStorage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSettings {
    pub hooks_installed: bool,
    pub storage: CheckpointStorageUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct ProjectTaskStorage {
    pub task_id: String,
    pub name: String,
    pub checkpoints: u32,
    pub referenced_bytes: f64,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct ProjectStorageUsage {
    pub project_id: String,
    pub total_bytes: f64,
    pub referenced_bytes: f64,
    pub reclaimable_bytes: Option<f64>,
    pub tasks: Vec<ProjectTaskStorage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct ProjectCleanupPreview {
    pub project_id: String,
    pub keep_recent: u32,
    pub remove_count: u32,
    pub protected_count: u32,
    pub reclaimable_bytes: f64,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCleanupPreview {
    pub task_id: String,
    pub keep_recent: u32,
    pub remove_count: u32,
    pub protected_count: u32,
    pub reclaimable_bytes: f64,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Type))]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCleanupReport {
    pub status: String,
    pub removed_count: u32,
    pub freed_bytes: f64,
    pub error: Option<String>,
}
