use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub request_id: String,
    pub command: BridgeCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub request_id: String,
    #[specta(type = specta_typescript::Unknown)]
    pub result: Option<serde_json::Value>,
    pub error: Option<DesktopError>,
}

impl ResponseEnvelope {
    pub fn success<T: Serialize>(request_id: String, value: T) -> Self {
        Self {
            request_id,
            result: serde_json::to_value(value).ok(),
            error: None,
        }
    }

    pub fn failure(request_id: String, error: DesktopError) -> Self {
        Self {
            request_id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum BridgeCommand {
    Bootstrap,
    SaveAppState {
        state: AppStateSnapshot,
    },
    WorkspaceOpen {
        paths: Vec<String>,
    },
    WorkspaceRemoveRecent {
        workspace_id: String,
    },
    WorkspaceRefresh {
        workspace_id: String,
    },
    RepositoryStatus {
        workspace_id: String,
        repo_id: String,
    },
    FileDiff {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
        staged: bool,
        revision: Option<String>,
    },
    Stage {
        workspace_id: String,
        repo_id: String,
        paths: Vec<String>,
    },
    Unstage {
        workspace_id: String,
        repo_id: String,
        paths: Vec<String>,
    },
    Commit {
        workspace_id: String,
        repo_id: String,
        message: String,
        amend: bool,
        paths: Vec<String>,
    },
    Sync {
        workspace_id: String,
        repo_id: String,
        action: SyncAction,
        remote: Option<String>,
    },
    History {
        workspace_id: String,
        repo_id: String,
        skip: u32,
        limit: u32,
        filter: Option<String>,
    },
    CommitDetail {
        workspace_id: String,
        repo_id: String,
        revision: String,
    },
    Branches {
        workspace_id: String,
        repo_id: String,
    },
    BranchOperation {
        workspace_id: String,
        repo_id: String,
        operation: BranchOperation,
    },
    Tags {
        workspace_id: String,
        repo_id: String,
    },
    TagOperation {
        workspace_id: String,
        repo_id: String,
        operation: TagOperation,
    },
    Stashes {
        workspace_id: String,
        repo_id: String,
    },
    StashOperation {
        workspace_id: String,
        repo_id: String,
        operation: StashOperation,
    },
    SystemOpen {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
        reveal: bool,
        external: bool,
    },
    Shelves {
        workspace_id: String,
        repo_id: String,
    },
    ShelfOperation {
        workspace_id: String,
        repo_id: String,
        operation: ShelfOperation,
    },
    Changelists {
        workspace_id: String,
        repo_id: String,
    },
    ChangelistOperation {
        workspace_id: String,
        repo_id: String,
        operation: ChangelistOperation,
    },
    Worktrees {
        workspace_id: String,
        repo_id: String,
    },
    WorktreeOperation {
        workspace_id: String,
        repo_id: String,
        operation: WorktreeOperation,
    },
    BranchCompare {
        workspace_id: String,
        repo_id: String,
        base: String,
        target: String,
    },
    Remotes {
        workspace_id: String,
        repo_id: String,
    },
    RemoteOperation {
        workspace_id: String,
        repo_id: String,
        operation: RemoteOperation,
    },
    Conflicts {
        workspace_id: String,
    },
    ConflictVersions {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
    },
    ConflictSave {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
        content: String,
        expected_fingerprint: String,
    },
    ConflictAccept {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
        choice: ConflictChoice,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncAction {
    Fetch,
    Pull,
    Push,
    Update,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BranchOperation {
    Create { name: String, from: Option<String> },
    Checkout { name: String },
    Rename { old_name: String, new_name: String },
    Delete { name: String, force: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TagOperation {
    Create {
        name: String,
        revision: Option<String>,
    },
    Delete {
        name: String,
    },
    Checkout {
        name: String,
    },
    Push {
        name: String,
        remote: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StashOperation {
    Create {
        message: String,
        paths: Vec<String>,
        include_untracked: bool,
    },
    Apply {
        reference: String,
    },
    Pop {
        reference: String,
    },
    Drop {
        reference: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShelfOperation {
    Create { name: String, paths: Vec<String> },
    Apply { shelf_id: String },
    Drop { shelf_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChangelistOperation {
    Create {
        name: String,
    },
    Rename {
        changelist_id: String,
        name: String,
    },
    Delete {
        changelist_id: String,
    },
    Assign {
        changelist_id: Option<String>,
        paths: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorktreeOperation {
    Create { branch: String, new_branch: bool },
    Remove { path: String, force: bool },
    Lock { path: String },
    Unlock { path: String },
    Prune,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    Mine,
    Theirs,
    Working,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RemoteOperation {
    Add {
        name: String,
        url: String,
    },
    Rename {
        old_name: String,
        new_name: String,
    },
    SetUrl {
        name: String,
        url: String,
        push: bool,
    },
    Remove {
        name: String,
    },
    Prune {
        name: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopError {
    pub code: String,
    pub message: String,
    pub command: Option<String>,
    pub exit_code: Option<i32>,
    pub stderr: Option<String>,
    pub recoverable: bool,
}

impl DesktopError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            command: None,
            exit_code: None,
            stderr: None,
            recoverable,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub request_id: String,
    pub phase: String,
    pub message: String,
    pub completed: Option<u32>,
    pub total: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEvent {
    pub workspace_id: String,
    pub generation: u32,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryEvent {
    pub workspace_id: String,
    pub repo_id: String,
    pub generation: u32,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppStateSnapshot {
    pub theme: ThemePreference,
    pub language: LanguagePreference,
    pub last_workspace_id: Option<String>,
    pub recent_workspaces: Vec<WorkspaceDescriptor>,
    pub panel_sizes: PanelSizes,
    pub active_tab: String,
    pub file_view_mode: String,
    pub external_editor: Option<ExternalEditor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum LanguagePreference {
    #[default]
    System,
    ZhCn,
    En,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditor {
    pub executable: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PanelSizes {
    pub commit: u32,
    pub branches: u32,
    pub detail: u32,
}

impl Default for PanelSizes {
    fn default() -> Self {
        Self {
            commit: 360,
            branches: 220,
            detail: 360,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapData {
    pub state: AppStateSnapshot,
    pub tools: ToolAvailability,
    pub capabilities: DesktopCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCapabilities {
    pub ai: bool,
    pub stash: bool,
    pub shelf: bool,
    pub changelist: bool,
    pub worktree: bool,
    pub subtree: bool,
    pub compare: bool,
    pub remote_management: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolAvailability {
    pub git: bool,
    pub svn: bool,
    pub svnadmin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDescriptor {
    pub id: String,
    pub name: String,
    pub paths: Vec<String>,
    pub last_opened_at: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub workspace: WorkspaceDescriptor,
    pub repositories: Vec<RepositoryStatus>,
    pub generation: u32,
    pub tools: ToolAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryMeta {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub color: String,
    pub kind: VcsKind,
    pub parent_repo_id: Option<String>,
    pub depth: u32,
    pub is_submodule: bool,
    pub is_worktree: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VcsKind {
    Git,
    Svn,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    pub meta: RepositoryMeta,
    pub branch: String,
    pub revision: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileChange>,
    pub conflicts: u32,
    pub operation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffDocument {
    pub path: String,
    pub content: String,
    pub language: String,
    pub binary: bool,
    pub truncated: bool,
    pub line_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitNode {
    pub repo_id: String,
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub author_date: String,
    pub committer_date: String,
    pub message: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub status: String,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub commit: CommitNode,
    pub full_message: String,
    pub files: Vec<CommitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub commits: Vec<CommitNode>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchCompareResult {
    pub base: String,
    pub target: String,
    pub base_commits: Vec<CommitNode>,
    pub target_commits: Vec<CommitNode>,
    pub files: Vec<CommitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub hash: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub reference: String,
    pub hash: String,
    pub branch: String,
    pub message: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShelfEntry {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelistEntry {
    pub id: String,
    pub name: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub head: String,
    pub branch: String,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub repo_id: String,
    pub repo_name: String,
    pub repo_color: String,
    pub path: String,
    pub kind: VcsKind,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeVersions {
    pub path: String,
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub working: String,
    pub language: String,
    pub fingerprint: String,
    pub binary: bool,
}
