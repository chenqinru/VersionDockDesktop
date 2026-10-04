use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub request_id: String,
    pub context: RequestContext,
    pub command: BridgeCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    pub generation: u32,
    pub domain: OperationDomain,
    #[serde(default)]
    pub visibility: OperationVisibility,
    pub workspace_id: Option<String>,
    pub repository_id: Option<String>,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationVisibility {
    #[default]
    Foreground,
    Background,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum OperationDomain {
    Application,
    Workspace,
    Status,
    Diff,
    History,
    Branch,
    Tag,
    Commit,
    Sync,
    Conflict,
    Stash,
    Shelf,
    Changelist,
    Worktree,
    Subtree,
    Submodule,
    Remote,
    Identity,
    SvnAccount,
    FileHistory,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationStatus {
    Queued,
    Running,
    Succeeded,
    Partial,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub request_id: String,
    #[specta(type = specta_typescript::Unknown)]
    pub result: Option<serde_json::Value>,
    pub error: Option<DesktopError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowTabTransfer {
    pub transfer_id: String,
    pub source_window_label: String,
    pub tab_id: String,
    pub tab_name: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowTabImport {
    pub transfer: WindowTabTransfer,
    pub screen_x: f64,
    pub screen_y: f64,
    pub target_client_x: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowTabTransferCompleted {
    pub transfer_id: String,
    pub source_window_label: String,
    pub tab_id: String,
    pub target_window_label: String,
    pub accepted: bool,
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
    RuntimeCapabilities,
    SaveAppState {
        state: AppStateSnapshot,
    },
    SaveCommitSelections {
        workspace_id: String,
        selections: Vec<RepositoryCommitSelection>,
    },
    UpdateSettings {
        settings: DesktopSettings,
        #[serde(default)]
        changed_fields: Option<Vec<String>>,
    },
    AiRuntime,
    AiSaveKey {
        provider: String,
        api_url: String,
        key: Option<String>,
    },
    AiPrompt {
        task: crate::ai::models::AiTask,
        workspace_id: Option<String>,
        repo_id: Option<String>,
        scope: String,
        action: String,
        text: Option<String>,
    },
    AiGenerate {
        request: crate::ai::models::AiRequest,
    },
    AiComposerPrepare {
        workspace_id: String,
        repo_id: String,
        paths: Vec<String>,
        staged_only: bool,
        hashes: Vec<String>,
    },
    AiComposerApply {
        workspace_id: String,
        repo_id: String,
        session_id: String,
        groups: Vec<crate::ai::models::AiGroup>,
        no_verify: bool,
    },
    AiReviewLocate {
        workspace_id: String,
        anchor: crate::ai::models::AiAnchor,
    },
    AiResetCliSession,
    UpdateLayout {
        layout: LayoutState,
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
    InitializeRepository {
        workspace_id: String,
        target_path: String,
    },
    CloneRepository {
        url: String,
        parent_path: String,
        target_name: String,
        provider_account_id: Option<String>,
    },
    CheckoutSvnRepository {
        url: String,
        parent_path: String,
        target_name: String,
        username: Option<String>,
        password: Option<String>,
    },
    ProviderAccounts,
    ProviderGithubBegin {
        account_id: Option<String>,
    },
    ProviderGithubComplete {
        flow_id: String,
    },
    ProviderGithubSave {
        account_id: Option<String>,
        token: String,
    },
    ProviderGitlabSave {
        account_id: Option<String>,
        host: String,
        token: String,
    },
    ProviderGiteeSave {
        account_id: Option<String>,
        token: String,
    },
    ProviderRemove {
        account_id: String,
    },
    ProviderRepositories {
        account_id: String,
        query: Option<String>,
        page: u32,
        per_page: u32,
    },
    ProviderNamespaces {
        account_id: String,
    },
    ResolveAuthorAvatar {
        workspace_id: String,
        repo_id: String,
        email: String,
        author_name: String,
    },
    PublishRepository {
        workspace_id: String,
        repo_id: String,
        account_id: String,
        namespace_id: Option<String>,
        name: String,
        description: String,
        visibility: RemoteVisibility,
        push: bool,
    },
    WindowOpenNew {
        paths: Option<Vec<String>>,
        x: Option<f64>,
        y: Option<f64>,
        width: Option<f64>,
        height: Option<f64>,
        transfer: Option<WindowTabTransfer>,
    },
    WindowStoreTabSession {
        transfer: WindowTabTransfer,
        #[specta(type = specta_typescript::Unknown)]
        session: serde_json::Value,
    },
    WindowReadTabSession {
        transfer_id: String,
    },
    WindowDiscardTabSession {
        transfer_id: String,
    },
    WindowSyncTabs {
        workspace_paths: Vec<Vec<String>>,
        active_workspace_id: Option<String>,
    },
    WindowFocusWorkspace {
        paths: Vec<String>,
    },
    WindowTabDrop {
        transfer: WindowTabTransfer,
        screen_x: f64,
        screen_y: f64,
    },
    WindowCompleteTabTransfer {
        transfer_id: String,
        source_window_label: String,
        tab_id: String,
        target_window_label: String,
        accepted: bool,
    },
    WindowSyncBounds {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    WindowSetSize {
        width: f64,
        height: f64,
        center: bool,
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
        from_revision: Option<String>,
        to_revision: Option<String>,
    },
    StashFileDiff {
        workspace_id: String,
        repo_id: String,
        reference: String,
        relative_path: String,
    },
    ShelfFileDiff {
        workspace_id: String,
        repo_id: String,
        shelf_id: String,
        relative_path: String,
    },
    Stage {
        workspace_id: String,
        repo_id: String,
        paths: Vec<String>,
        #[serde(default)]
        #[specta(optional)]
        allow_truncated: bool,
    },
    Unstage {
        workspace_id: String,
        repo_id: String,
        paths: Vec<String>,
    },
    Discard {
        workspace_id: String,
        repo_id: String,
        paths: Vec<String>,
    },
    DeletePaths {
        workspace_id: String,
        repo_id: String,
        paths: Vec<String>,
    },
    AddIgnore {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
    },
    IgnoreRules {
        workspace_id: String,
        repo_id: String,
        directory: String,
    },
    SvnIgnoreEntries {
        workspace_id: String,
        repo_id: String,
    },
    UpdateIgnoreRules {
        workspace_id: String,
        repo_id: String,
        directory: String,
        patterns: Vec<String>,
    },
    Commit {
        workspace_id: String,
        repo_id: String,
        message: String,
        amend: bool,
        paths: Vec<String>,
        #[serde(default)]
        no_verify: bool,
        #[serde(default)]
        staged_only: bool,
    },
    CommitSafetyCheck {
        workspace_id: String,
        repo_id: String,
        paths: Vec<String>,
        #[serde(default)]
        staged_only: bool,
    },
    BatchCommit {
        workspace_id: String,
        targets: Vec<BatchCommitTarget>,
        push: bool,
    },
    RecentCommitMessages {
        workspace_id: String,
        repo_ids: Vec<String>,
        limit: u32,
    },
    LastCommitMessage {
        workspace_id: String,
        repo_id: String,
    },
    Sync {
        workspace_id: String,
        repo_id: String,
        action: SyncAction,
        remote: Option<String>,
        branch: Option<String>,
        #[serde(default)]
        force: Option<bool>,
    },
    History {
        workspace_id: String,
        repo_id: String,
        skip: u32,
        limit: u32,
        query: HistoryQuery,
    },
    HistoryTopology {
        workspace_id: String,
        repo_id: String,
        svn_limit: u32,
        #[serde(default)]
        limit: Option<u32>,
        revision: Option<String>,
    },
    CommitDetail {
        workspace_id: String,
        repo_id: String,
        revision: String,
    },
    CommitMergeCommits {
        workspace_id: String,
        repo_id: String,
        revision: String,
        parents: Vec<String>,
    },
    CommitMergeParentFiles {
        workspace_id: String,
        repo_id: String,
        revision: String,
        parent_hash: String,
    },
    UnpushedCommits {
        workspace_id: String,
        repo_id: String,
    },
    UnpushedChanges {
        workspace_id: String,
        repo_id: String,
        oldest_revision: Option<String>,
    },
    IncomingCommits {
        workspace_id: String,
        repo_id: String,
    },
    IncomingChanges {
        workspace_id: String,
        repo_id: String,
    },
    UnpushedOperation {
        workspace_id: String,
        repo_id: String,
        operation: UnpushedOperation,
    },
    HistoryOperation {
        workspace_id: String,
        repo_id: String,
        operation: HistoryOperation,
    },
    CreatePatch {
        workspace_id: String,
        repo_id: String,
        revisions: Vec<String>,
    },
    SavePatch {
        workspace_id: String,
        repo_id: String,
        revisions: Vec<String>,
        path: String,
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
    BranchRecovery {
        workspace_id: String,
        repo_id: String,
        operation: BranchRecoveryOperation,
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
    OpenWorktree {
        workspace_id: String,
        repo_id: String,
        path: String,
        reveal: bool,
    },
    WorktreeDiff {
        workspace_id: String,
        repo_id: String,
        path: String,
        base_ref: String,
    },
    WorktreeFileDiff {
        workspace_id: String,
        repo_id: String,
        path: String,
        base_ref: String,
        relative_path: String,
    },
    BranchWorkingDiff {
        workspace_id: String,
        repo_id: String,
        base_ref: String,
    },
    BranchWorkingFileDiff {
        workspace_id: String,
        repo_id: String,
        base_ref: String,
        relative_path: String,
    },
    Subtrees {
        workspace_id: String,
        repo_id: String,
    },
    SubtreeStatuses {
        workspace_id: String,
        repo_id: String,
    },
    SubtreeOperation {
        workspace_id: String,
        repo_id: String,
        operation: SubtreeOperation,
    },
    Submodules {
        workspace_id: String,
        repo_id: String,
    },
    SubmoduleOperation {
        workspace_id: String,
        repo_id: String,
        operation: SubmoduleOperation,
    },
    BranchCompare {
        workspace_id: String,
        repo_id: String,
        base: String,
        target: String,
    },
    BranchCompareCommits {
        workspace_id: String,
        repo_id: String,
        base: String,
        target: String,
        side: String,
        skip: u32,
        limit: u32,
        query: HistoryQuery,
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
        repo_id: Option<String>,
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
        #[serde(default)]
        #[specta(optional)]
        delete_file: Option<bool>,
    },
    ConflictAccept {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
        choice: ConflictChoice,
    },
    AbortRepositoryOperation {
        workspace_id: String,
        repo_id: String,
        operation: String,
    },
    ContinueRepositoryOperation {
        workspace_id: String,
        repo_id: String,
        operation: String,
        #[serde(default)]
        #[specta(optional)]
        skip: Option<bool>,
    },
    GitUnlockIndex {
        workspace_id: String,
        repo_id: String,
    },
    RestoreConflicts {
        workspace_id: String,
        repo_id: String,
    },
    GitIdentity {
        workspace_id: String,
        repo_id: String,
    },
    GitProfileOperation {
        workspace_id: String,
        repo_id: String,
        operation: GitProfileOperation,
    },
    SvnAccount {
        workspace_id: String,
        repo_id: String,
    },
    SvnAccountOperation {
        workspace_id: String,
        repo_id: String,
        operation: SvnAccountOperation,
    },
    SvnOperation {
        workspace_id: String,
        repo_id: String,
        operation: SvnOperation,
    },
    DiffLineHistoryTarget {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
        source_revision: String,
        line_range: LineRange,
    },
    FileHistory {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
        cursor: Option<String>,
        limit: u32,
    },
    FileRevisionContent {
        workspace_id: String,
        repo_id: String,
        relative_path: String,
        revision: String,
    },
    LogGet {
        channel: Option<crate::logger::LogChannel>,
        level: Option<crate::logger::LogLevel>,
        limit: Option<u32>,
    },
    LogClear,
    LogFormat {
        entries: Vec<crate::logger::LogEntry>,
    },
    LogStorageStatus,
    LogOpenFolder,
    LogExport {
        target_path: String,
        #[serde(default)]
        #[specta(optional)]
        entries: Option<Vec<crate::logger::LogEntry>>,
    },
    LogClientPush {
        level: crate::logger::LogLevel,
        channel: crate::logger::LogChannel,
        message: String,
        details: Option<String>,
    },
}

#[allow(unused_imports)]
pub use crate::logger::{LogChannel, LogEntry, LogLevel};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BatchCommitTarget {
    pub repo_id: String,
    pub message: String,
    pub amend: bool,
    pub paths: Vec<String>,
    #[serde(default)]
    #[specta(optional)]
    pub unstage_paths: Vec<String>,
    #[serde(default)]
    #[specta(optional)]
    pub no_verify: bool,
    #[serde(default)]
    #[specta(optional)]
    pub staged_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOperationResult {
    pub repo_id: String,
    pub commit_attempted: bool,
    pub committed: bool,
    pub revision: Option<String>,
    pub push_attempted: bool,
    pub pushed: bool,
    pub failed_stage: Option<String>,
    pub recovery_hint: Option<String>,
    pub error: Option<DesktopError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InitializeRepositoryResult {
    pub snapshot: WorkspaceSnapshot,
    pub repository_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloneRepositoryResult {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRepositoryResult {
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteProviderKind {
    Github,
    Gitlab,
    Gitee,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProviderAccount {
    pub id: String,
    pub provider: RemoteProviderKind,
    pub host: String,
    pub login: String,
    pub display_name: Option<String>,
    pub secure_storage_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceFlow {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at: String,
    pub interval: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNamespace {
    pub id: String,
    pub name: String,
    pub full_path: String,
    pub kind: String,
    pub host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepository {
    pub id: String,
    pub provider: RemoteProviderKind,
    pub host: String,
    pub name: String,
    pub full_name: String,
    pub clone_url: String,
    pub web_url: Option<String>,
    pub default_branch: Option<String>,
    pub namespace: Option<RemoteNamespace>,
    pub private: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepositoryPage {
    pub items: Vec<RemoteRepository>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteVisibility {
    Private,
    Internal,
    Public,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PublishRepositoryResult {
    pub repository: RemoteRepository,
    pub remote_created: bool,
    pub remote_configured: bool,
    pub push_attempted: bool,
    pub pushed: bool,
    pub failed_stage: Option<String>,
    pub recovery_hint: Option<String>,
    pub error: Option<DesktopError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentCommitMessage {
    pub repo_id: String,
    pub revision: String,
    pub committed_at: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub text: Option<String>,
    pub author: Option<String>,
    pub from_date: Option<String>,
    pub to_date: Option<String>,
    pub path: Option<String>,
    pub revision: Option<String>,
    #[serde(default)]
    pub line_range: Option<LineRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub output: String,
    pub update: Option<RepositoryUpdateResult>,
    #[serde(default)]
    #[specta(optional)]
    pub restore_warning: Option<UpdateRestoreWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRestoreWarning {
    pub shelf: bool,
    pub backup_name: String,
    pub backup_id: String,
    pub conflicted: bool,
    pub details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryUpdateResult {
    pub repo_id: String,
    pub before_revision: String,
    pub after_revision: String,
    pub summary: Option<UpdateSummary>,
    pub summary_error: Option<DesktopError>,
    pub before_status: String,
    pub after_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSummary {
    pub kind: UpdateKind,
    pub commit_count: u32,
    pub file_count: u32,
    pub contains_merge: bool,
    pub detail: UpdateDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdateKind {
    NoChanges,
    FastForward,
    Updated,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDetail {
    pub commits: Vec<CommitNode>,
    pub files: Vec<CommitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreRules {
    pub directory: String,
    pub source: String,
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncAction {
    Fetch,
    Pull,
    PullRebase,
    PullFfOnly,
    Push,
    PushTags,
    Update,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BranchOperation {
    Create {
        name: String,
        from: Option<String>,
        #[serde(default)]
        checkout: Option<bool>,
    },
    Checkout {
        name: String,
    },
    Merge {
        name: String,
    },
    Rebase {
        name: String,
    },
    Rename {
        old_name: String,
        new_name: String,
    },
    Delete {
        name: String,
        force: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchOperationResult {
    pub completed: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BranchRecoveryOperation {
    StashAndCheckout { target: String },
    CarryChanges { target: String },
    ForceCheckout { target: String },
    StashAndMerge { target: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BranchRecoveryStatus {
    Completed,
    Conflicted,
    PartialFailure,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchRecoveryResult {
    pub status: BranchRecoveryStatus,
    pub target: String,
    pub stash_reference: Option<String>,
    pub changes_restored: bool,
    pub error: Option<DesktopError>,
    pub recovery_hint: Option<String>,
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
        remote: Option<String>,
    },
    Checkout {
        name: String,
    },
    Merge {
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
        #[serde(default)]
        expected_hash: Option<String>,
    },
    Pop {
        reference: String,
        #[serde(default)]
        expected_hash: Option<String>,
    },
    Drop {
        reference: String,
        #[serde(default)]
        expected_hash: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShelfOperation {
    Create {
        name: String,
        paths: Vec<String>,
    },
    Apply {
        shelf_id: String,
        #[serde(default)]
        paths: Option<Vec<String>>,
    },
    Drop {
        shelf_id: String,
    },
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
    SetActive {
        changelist_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SubtreeOperation {
    Add {
        prefix: String,
        remote: String,
        branch: String,
        squash: bool,
    },
    Pull {
        subtree_id: String,
    },
    Push {
        subtree_id: String,
    },
    Register {
        prefix: String,
        remote: String,
        branch: String,
        squash: bool,
    },
    Edit {
        subtree_id: String,
        prefix: String,
        remote: String,
        branch: String,
        squash: bool,
    },
    DeleteRegistry {
        subtree_id: String,
    },
    RemoveFiles {
        subtree_id: String,
    },
    Split {
        subtree_id: String,
        branch: Option<String>,
    },
    Merge {
        subtree_id: String,
        revision: String,
        squash: bool,
        message: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleEntry {
    pub name: String,
    pub path: String,
    pub url: String,
    pub initialized: bool,
    pub revision: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    pub sync_status: SubmoduleSyncStatus,
    pub recorded_commit: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub index_commit: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub conflict_stages: Option<SubmoduleConflictStages>,
    pub current_branch: Option<String>,
    pub detached: bool,
    pub unpushed_count: u32,
    #[serde(default)]
    pub type_change: bool,
    #[serde(default)]
    #[specta(optional)]
    pub companion_path: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub diff_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleConflictStages {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleSyncStatus {
    Synced,
    OutOfSync,
    Uninitialized,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SubmoduleOperation {
    Add {
        url: String,
        path: String,
        branch: Option<String>,
        allow_file_protocol: bool,
    },
    Init {
        path: String,
        recursive: bool,
    },
    Update {
        path: String,
        init: bool,
        recursive: bool,
        remote: bool,
    },
    Deinit {
        path: String,
        force: bool,
    },
    Sync {
        path: String,
        recursive: bool,
    },
    UpdateAll {
        init: bool,
        recursive: bool,
        remote: bool,
    },
    Remove {
        path: String,
        force: bool,
    },
    ResolveConflict {
        path: String,
        choice: ConflictChoice,
    },
    Push {
        path: String,
    },
    Pull {
        path: String,
        rebase: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubtreeState {
    Active,
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    Mine,
    Theirs,
    Working,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GitProfileOperation {
    Save { profile: GitProfile },
    Delete { profile_id: String },
    Select { profile_id: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitProfile {
    pub id: String,
    pub label: String,
    pub user_name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GitIdentitySource {
    Custom,
    Local,
    Global,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveGitIdentity {
    pub user_name: String,
    pub email: String,
    pub source: GitIdentitySource,
    pub profile_id: Option<String>,
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentityState {
    pub profiles: Vec<GitProfile>,
    pub selected_profile_id: Option<String>,
    pub local: Option<EffectiveGitIdentity>,
    pub global: Option<EffectiveGitIdentity>,
    pub effective: EffectiveGitIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SvnAccountOperation {
    Switch {
        username: String,
        password: String,
        remember: bool,
    },
    Save {
        username: String,
        password: Option<String>,
    },
    Delete,
    Test,
    ClearNative {
        credential_id: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SvnCredentialSource {
    VersionDockSecureStore,
    NativeCache,
    Session,
    #[default]
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SvnNativeCredential {
    pub id: String,
    pub realm: String,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SvnOperation {
    RemoveIgnoreEntries {
        entries: Vec<IgnoreRules>,
    },
    Cleanup {
        break_locks: bool,
        remove_unversioned: bool,
        remove_ignored: bool,
        include_externals: bool,
    },
    ResolveWorking {
        paths: Vec<String>,
    },
    Lock {
        paths: Vec<String>,
        message: Option<String>,
        force: bool,
    },
    Unlock {
        paths: Vec<String>,
        force: bool,
    },
    Relocate {
        from_url: String,
        to_url: String,
    },
    Switch {
        url: String,
        revision: Option<String>,
        ignore_ancestry: bool,
    },
    Copy {
        source_url: String,
        destination_url: String,
        revision: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SvnAccountState {
    pub repository_url: String,
    pub repository_root: String,
    pub username: Option<String>,
    pub password_stored: bool,
    pub secure_storage_available: bool,
    pub password_stdin_supported: bool,
    pub connection_ok: Option<bool>,
    #[serde(default)]
    pub source: SvnCredentialSource,
    #[serde(default)]
    pub native_credentials: Vec<SvnNativeCredential>,
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
    #[specta(optional)]
    pub operation: Option<String>,
    #[specta(optional)]
    pub workspace_id: Option<String>,
    #[specta(optional)]
    pub repository_id: Option<String>,
    #[specta(optional)]
    pub subject: Option<String>,
    #[specta(optional)]
    pub hint: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub restore_warning: Option<UpdateRestoreWarning>,
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
            operation: None,
            workspace_id: None,
            repository_id: None,
            subject: None,
            hint: None,
            restore_warning: None,
        }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OperationEvent {
    pub operation_id: String,
    pub context: RequestContext,
    pub status: OperationStatus,
    pub phase: String,
    pub message: String,
    pub started_at: String,
    pub cancellable: bool,
    pub completed: Option<u32>,
    pub total: Option<u32>,
    #[serde(default)]
    #[specta(optional)]
    pub result: Option<OperationResultSummary>,
    pub error: Option<DesktopError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OperationResultSummary {
    pub summary: String,
    pub succeeded: u32,
    pub failed: u32,
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
    pub repo_id: Option<String>,
    pub generation: u32,
    pub source: RepositoryEventSource,
    pub scopes: Vec<RefreshScope>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryEventSource {
    Watcher,
    Operation,
    Scheduler,
    OtherWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum RefreshScope {
    WorkspaceSnapshot,
    Status,
    Diff,
    Index,
    Refs,
    History,
    Operation,
    Conflicts,
    SvnRevision,
    Unpushed,
    Worktrees,
    Subtrees,
    Submodules,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppStateSnapshot {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    #[specta(optional)]
    pub settings: DesktopSettings,
    #[serde(default)]
    #[specta(optional)]
    pub layout: LayoutState,
    pub last_workspace_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub open_workspace_ids: Vec<String>,
    #[serde(default)]
    #[specta(optional)]
    pub active_workspace_id: Option<String>,
    pub recent_workspaces: Vec<WorkspaceDescriptor>,
    #[serde(default)]
    #[specta(optional)]
    pub commit_selections: BTreeMap<String, Vec<RepositoryCommitSelection>>,
    #[serde(default)]
    #[specta(optional)]
    pub theme: Option<ThemePreference>,
    #[serde(default)]
    #[specta(optional)]
    pub language: Option<LanguagePreference>,
    #[serde(default)]
    #[specta(optional)]
    pub ui_font_size: Option<UiFontSizePreference>,
    #[serde(default)]
    #[specta(optional)]
    pub panel_sizes: Option<PanelSizes>,
    #[serde(default)]
    #[specta(optional)]
    pub active_tab: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub file_view_mode: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub stash_view_mode: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub external_editor: Option<ExternalEditor>,
    #[serde(default)]
    #[specta(optional)]
    pub branch_sidebar_collapsed: Option<bool>,
    #[serde(default)]
    #[specta(optional)]
    pub branch_sidebar_collapsed_sections: Option<Vec<String>>,
}

fn default_schema_version() -> u32 {
    7
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default)]
    #[specta(optional)]
    pub ai_config: crate::ai::models::AiConfig,

    pub theme: ThemePreference,
    pub language: LanguagePreference,
    pub ui_font_size: UiFontSizePreference,
    #[serde(default)]
    #[specta(optional)]
    pub layout_density: LayoutDensity,
    pub changes_display_mode: ChangesDisplayMode,
    pub default_commit_action: DefaultCommitAction,
    pub default_save_action: DefaultSaveAction,
    pub prompt_before_adding_untracked: bool,
    pub suppress_diverged_warning: bool,
    pub auto_refresh_interval: u32,
    pub fetch_on_startup: bool,
    #[serde(default = "default_true")]
    #[specta(optional)]
    pub auto_fetch_on_focus: bool,
    pub reset_view_locations_on_startup: bool,
    pub notify_incoming_commits: bool,
    pub notify_unpushed_commits: bool,
    pub repository_scan_depth: u32,
    pub ignored_folders: Vec<String>,
    pub maximum_graph_commits: u32,
    pub project_colors: BTreeMap<String, String>,
    #[serde(default)]
    #[specta(optional)]
    pub hidden_repository_ids: Vec<String>,
    pub external_editor: Option<ExternalEditor>,
    #[serde(default = "default_auto_check_updates")]
    pub auto_check_updates: bool,
    #[serde(default)]
    #[specta(optional)]
    pub skipped_update_version: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub online_avatars_enabled: bool,
    #[serde(default)]
    #[specta(optional)]
    pub gravatar_enabled: bool,
    #[serde(default)]
    #[specta(optional)]
    pub avatar_cross_platform_fallback: bool,
    #[serde(default)]
    pub file_icon_theme: FileIconThemePreference,

    // ── Commit & Safety Guard ──────────────────────────────────────────────
    #[serde(default)]
    pub no_verify: bool,
    #[serde(default = "default_true")]
    pub auto_commit_resolved_merge: bool,
    #[serde(default = "default_true")]
    pub warn_on_large_files: bool,
    #[serde(default = "default_large_file_size_limit_mb")]
    pub large_file_size_limit_mb: u32,
    #[serde(default = "default_true")]
    pub warn_on_detached_head: bool,
    #[serde(default = "default_true")]
    pub warn_on_crlf: bool,
    #[serde(default = "default_true")]
    pub warn_on_invalid_file_names: bool,

    // ── Branch & Push Protection ───────────────────────────────────────────
    #[serde(default = "default_protected_branches")]
    pub protected_branches: Vec<String>,
    #[serde(default = "default_true")]
    pub sync_protected_branches_from_github: bool,
    #[serde(default = "default_true")]
    pub show_push_dialog_for_protected_branches: bool,
    #[serde(default)]
    pub on_push_rejected: OnPushRejectedAction,
    #[serde(default = "default_branch_clean_character")]
    pub branch_clean_character: String,
    #[serde(default = "default_true")]
    pub cherry_pick_add_suffix: bool,
    #[serde(default = "default_true")]
    pub use_safe_force_push: bool,

    // ── Update Project & Submodules ────────────────────────────────────────
    #[serde(default)]
    pub update_project_method: UpdateProjectMethod,
    #[serde(default)]
    pub update_project_clean_working_tree: CleanWorkingTreeMethod,
    #[serde(default = "default_true")]
    pub update_project_show_notification: bool,
    #[serde(default = "default_true")]
    pub clone_recursive_submodules: bool,

    // ── Diff & Shelve ──────────────────────────────────────────────────────
    #[serde(default)]
    pub shelve_comparison_base: ShelveComparisonBase,

    // ── Git Advanced ───────────────────────────────────────────────────────
    #[serde(default)]
    pub cat_file_filter_mode: CatFileFilterMode,
    #[serde(default)]
    pub fetch_tags: FetchTagsMode,
    #[serde(default = "default_true")]
    pub exclude_ignored_directories: bool,
}

fn default_auto_check_updates() -> bool {
    true
}

fn default_true() -> bool {
    true
}

fn default_large_file_size_limit_mb() -> u32 {
    50
}

fn default_protected_branches() -> Vec<String> {
    vec!["master".into(), "main".into()]
}

fn default_branch_clean_character() -> String {
    "-".into()
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            ai_config: crate::ai::models::AiConfig::default(),
            theme: ThemePreference::System,
            language: LanguagePreference::System,
            ui_font_size: UiFontSizePreference::Standard,
            layout_density: LayoutDensity::Comfortable,
            file_icon_theme: FileIconThemePreference::Material,
            changes_display_mode: ChangesDisplayMode::Simplified,
            default_commit_action: DefaultCommitAction::Commit,
            default_save_action: DefaultSaveAction::Stash,
            prompt_before_adding_untracked: true,
            suppress_diverged_warning: false,
            auto_refresh_interval: 0,
            fetch_on_startup: false,
            auto_fetch_on_focus: true,
            reset_view_locations_on_startup: false,
            notify_incoming_commits: true,
            notify_unpushed_commits: true,
            auto_check_updates: true,
            skipped_update_version: None,
            online_avatars_enabled: false,
            gravatar_enabled: false,
            avatar_cross_platform_fallback: false,
            repository_scan_depth: 4,
            ignored_folders: vec![
                ".git".into(),
                ".svn".into(),
                ".hg".into(),
                "node_modules".into(),
                "vendor".into(),
                "dist".into(),
                "build".into(),
                "out".into(),
                ".next".into(),
                ".nuxt".into(),
                ".turbo".into(),
                "target".into(),
            ],
            maximum_graph_commits: 1_000,
            project_colors: BTreeMap::new(),
            hidden_repository_ids: Vec::new(),
            external_editor: None,

            no_verify: false,
            auto_commit_resolved_merge: true,
            warn_on_large_files: true,
            large_file_size_limit_mb: 50,
            warn_on_detached_head: true,
            warn_on_crlf: true,
            warn_on_invalid_file_names: true,

            protected_branches: vec!["master".into(), "main".into()],
            sync_protected_branches_from_github: true,
            show_push_dialog_for_protected_branches: true,
            on_push_rejected: OnPushRejectedAction::Prompt,
            branch_clean_character: "-".into(),
            cherry_pick_add_suffix: true,
            use_safe_force_push: true,

            update_project_method: UpdateProjectMethod::Rebase,
            update_project_clean_working_tree: CleanWorkingTreeMethod::Shelve,
            update_project_show_notification: true,
            clone_recursive_submodules: true,

            shelve_comparison_base: ShelveComparisonBase::Local,

            cat_file_filter_mode: CatFileFilterMode::Filters,
            fetch_tags: FetchTagsMode::Auto,
            exclude_ignored_directories: true,
        }
    }
}

impl DesktopSettings {
    pub fn normalize(mut self) -> Self {
        self.ai_config = self.ai_config.normalize();
        self.repository_scan_depth = self.repository_scan_depth.min(10);
        self.maximum_graph_commits = self.maximum_graph_commits.clamp(100, 10_000);
        self.auto_refresh_interval = self.auto_refresh_interval.min(86_400);
        self.large_file_size_limit_mb = self.large_file_size_limit_mb.clamp(1, 1000);
        if self.branch_clean_character.len() > 1 {
            self.branch_clean_character = self
                .branch_clean_character
                .chars()
                .next()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "-".into());
        }
        if self.branch_clean_character.is_empty() {
            self.branch_clean_character = "-".into();
        }
        let mut seen_branches = std::collections::HashSet::new();
        self.protected_branches = self
            .protected_branches
            .into_iter()
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty() && seen_branches.insert(b.clone()))
            .collect();
        let mut seen = std::collections::HashSet::new();
        self.ignored_folders = self
            .ignored_folders
            .into_iter()
            .map(|value| value.trim().replace('\\', "/"))
            .filter(|value| {
                !value.is_empty()
                    && !value.contains('\0')
                    && !value.split('/').any(|part| part == "..")
                    && seen.insert(value.clone())
            })
            .collect();
        self.project_colors = self
            .project_colors
            .into_iter()
            .filter_map(|(key, value)| normalize_color(&value).map(|color| (key, color)))
            .collect();
        self.hidden_repository_ids = self
            .hidden_repository_ids
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
            .collect();
        self.hidden_repository_ids.sort();
        self.hidden_repository_ids.dedup();
        if let Some(editor) = &mut self.external_editor {
            editor.executable = editor.executable.trim().to_string();
            if editor.executable.is_empty() {
                self.external_editor = None;
            }
        }
        self
    }
}

fn is_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn normalize_color(value: &str) -> Option<String> {
    let value = value.trim();
    is_color(value).then(|| value.to_ascii_lowercase())
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum ChangesDisplayMode {
    #[default]
    Simplified,
    Changelists,
    Vscode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum DefaultCommitAction {
    #[default]
    Commit,
    CommitAndPush,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DefaultSaveAction {
    #[default]
    Stash,
    Shelf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OnPushRejectedAction {
    #[default]
    Prompt,
    RebaseAndRetry,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateProjectMethod {
    #[default]
    Rebase,
    Merge,
    Prompt,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CleanWorkingTreeMethod {
    #[default]
    Shelve,
    Stash,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShelveComparisonBase {
    #[default]
    Local,
    Parent,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CatFileFilterMode {
    #[default]
    Filters,
    Textconv,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FetchTagsMode {
    #[default]
    Auto,
    All,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LayoutState {
    pub panel_sizes: PanelSizes,
    pub active_tab: String,
    pub file_view_mode: String,
    pub stash_view_mode: String,
    pub branch_sidebar_collapsed: bool,
    pub branch_sidebar_collapsed_sections: Vec<String>,
}

impl Default for LayoutState {
    fn default() -> Self {
        Self {
            panel_sizes: PanelSizes::default(),
            active_tab: "changes".into(),
            file_view_mode: "tree".into(),
            stash_view_mode: "tree".into(),
            branch_sidebar_collapsed: false,
            branch_sidebar_collapsed_sections: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsEffects {
    pub rescan_workspace: bool,
    pub reload_history: bool,
    pub restart_auto_refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdateResult {
    pub settings: DesktopSettings,
    pub effects: SettingsEffects,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    #[default]
    System,
    Dark2026,
    Light2026,
    GithubDarkDimmed,
    OneDarkPro,
    Dracula,
    Nord,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LayoutDensity {
    #[default]
    Comfortable,
    Compact,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum UiFontSizePreference {
    Minimum,
    Small,
    #[default]
    Standard,
    Large,
    Maximum,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileIconThemePreference {
    #[default]
    Material,
    Catppuccin,
    Seti,
    Codicon,
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
            detail: 380,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapData {
    pub state: AppStateSnapshot,
    pub tools: ToolAvailability,
    pub capabilities: DesktopCapabilities,
    pub application_session_id: String,
    #[serde(default)]
    #[specta(optional)]
    pub launch_workspace_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub runtime: RuntimeCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityStatus {
    pub available: bool,
    pub reason_code: Option<String>,
    pub detail: Option<String>,
}

impl CapabilityStatus {
    pub fn available() -> Self {
        Self {
            available: true,
            reason_code: None,
            detail: None,
        }
    }

    pub fn unavailable(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            available: false,
            reason_code: Some(code.into()),
            detail: Some(detail.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum NotificationPermissionState {
    #[default]
    NotRequested,
    Allowed,
    Denied,
    Restricted,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecureCredentialCapability {
    pub status: CapabilityStatus,
    pub backend: Option<String>,
    pub password_stdin_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub system_notifications: CapabilityStatus,
    pub notification_permission: NotificationPermissionState,
    pub secure_credentials: SecureCredentialCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCapabilities {
    pub ai: bool,
    #[specta(optional)]
    pub initialize_repository: bool,
    #[specta(optional)]
    pub clone_repository: bool,
    pub stash: bool,
    pub shelf: bool,
    pub changelist: bool,
    pub worktree: bool,
    pub subtree: bool,
    #[specta(optional)]
    pub submodule: bool,
    pub compare: bool,
    pub remote_management: bool,
    #[specta(optional)]
    pub identity: bool,
    #[specta(optional)]
    pub svn_account: bool,
    #[specta(optional)]
    pub file_history: bool,
    #[specta(optional)]
    pub secure_credentials: bool,
    #[specta(optional)]
    pub system_notifications: bool,
    #[serde(default)]
    #[specta(optional)]
    pub availability: BTreeMap<String, CapabilityStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCapabilities {
    pub status: bool,
    pub diff: bool,
    pub commit: bool,
    pub sync: bool,
    pub history: bool,
    pub conflict: bool,
    pub stash: bool,
    pub shelf: bool,
    pub changelist: bool,
    pub worktree: bool,
    pub subtree: bool,
    pub submodule: bool,
    pub compare: bool,
    pub remote_management: bool,
    pub identity: bool,
    pub svn_account: bool,
    pub file_history: bool,
    #[serde(default)]
    #[specta(optional)]
    pub availability: BTreeMap<String, CapabilityStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolAvailability {
    pub git: bool,
    pub svn: bool,
    pub svnadmin: bool,
    #[serde(default)]
    #[specta(optional)]
    pub git_version: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub svn_version: Option<String>,
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
    #[serde(default)]
    #[specta(optional)]
    pub capabilities: RepositoryCapabilities,
    #[serde(default)]
    #[specta(optional)]
    pub tool_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflicted: bool,
    #[serde(default)]
    #[specta(optional)]
    pub conflict_type: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub conflict_types: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub conflict_status: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub submodule: bool,
    #[serde(default)]
    #[specta(optional)]
    pub is_truncated: bool,
    #[serde(default)]
    #[specta(optional)]
    pub truncation_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLineHistoryTarget {
    pub path: String,
    pub revision: String,
    pub line_range: LineRange,
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
    #[serde(default)]
    pub incoming: bool,
    #[serde(default)]
    pub unpushed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommitNode {
    pub repo_id: String,
    pub hash: String,
    pub parents: Vec<String>,
    pub committer_date: String,
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
pub struct RevisionChanges {
    pub from_revision: String,
    pub to_revision: String,
    pub files: Vec<CommitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeParentChange {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author_name: String,
    pub author_date: String,
    pub parent_index: u32,
    pub file_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub commit: CommitNode,
    pub full_message: String,
    pub files: Vec<CommitFile>,
    pub branches: CommitBranches,
    #[serde(default)]
    pub merge_parent_changes: Vec<MergeParentChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitBranches {
    pub local: Vec<String>,
    pub remote: Vec<String>,
    pub tags: Vec<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_head: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeCommitSummary {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub author_date: String,
    pub parent_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub commits: Vec<CommitNode>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub revision: String,
    pub previous_revision: Option<String>,
    pub path: String,
    pub previous_path: Option<String>,
    pub author: String,
    pub date: String,
    pub message: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryPage {
    pub entries: Vec<FileHistoryEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileRevisionDocument {
    pub revision: String,
    pub path: String,
    pub content: String,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnpushedCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    #[serde(default)]
    #[specta(optional)]
    pub body: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub full_message: Option<String>,
    pub author: String,
    #[serde(default)]
    #[specta(optional)]
    pub author_email: Option<String>,
    pub date: String,
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
    #[serde(default)]
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IncomingCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    #[serde(default)]
    #[specta(optional)]
    pub body: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub full_message: Option<String>,
    pub author: String,
    #[serde(default)]
    #[specta(optional)]
    pub author_email: Option<String>,
    pub date: String,
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
    pub parents: Vec<String>,
    pub potential_conflict_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UnpushedOperation {
    Revert {
        hashes: Vec<String>,
    },
    UndoHead {
        #[serde(default, rename = "expectedHash")]
        expected_hash: Option<String>,
    },
    Drop {
        hashes: Vec<String>,
    },
    Squash {
        hashes: Vec<String>,
        message: String,
    },
    EditMessage {
        hash: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HistoryOperation {
    Checkout {
        revision: String,
    },
    CherryPick {
        revision: String,
    },
    Revert {
        revisions: Vec<String>,
    },
    Reset {
        revision: String,
        mode: String,
        #[serde(default, rename = "expectedBranch")]
        expected_branch: Option<String>,
        #[serde(default, rename = "expectedHead")]
        expected_head: Option<String>,
    },
    CheckoutFile {
        revision: String,
        path: String,
    },
    RevertFile {
        revision: String,
        path: String,
    },
    ApplyPaths {
        entries: Vec<CommitPathOperationEntry>,
    },
    RevertPaths {
        entries: Vec<CommitPathOperationEntry>,
    },
    SvnUpdateTo {
        revision: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitPathOperationEntry {
    pub revision: String,
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchDocument {
    pub file_name: String,
    pub content: String,
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
    #[serde(default)]
    pub remote_name: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    #[serde(default)]
    pub detached_tag: Option<String>,
    #[serde(default)]
    pub detached_hash: Option<String>,
    #[serde(default)]
    pub last_commit_message: Option<String>,
    #[serde(default)]
    pub last_commit_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub hash: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub reference: String,
    pub hash: String,
    pub branch: String,
    pub message: String,
    pub full_message: String,
    pub date: String,
    pub files: Vec<ShelfFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfFileEntry {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShelfEntry {
    pub id: String,
    pub name: String,
    pub created_at: String,
    #[serde(default)]
    pub branch: Option<String>,
    pub files: Vec<ShelfFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelistEntry {
    pub id: String,
    pub name: String,
    pub files: Vec<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub is_active: bool,
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
pub struct WorktreeDiffResult {
    pub path: String,
    pub base_ref: String,
    pub current_ref: String,
    pub files: Vec<CommitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubtreeEntry {
    pub id: String,
    pub prefix: String,
    pub remote: String,
    pub branch: String,
    pub squash: bool,
    pub state: SubtreeState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubtreePushStatus {
    pub subtree_id: String,
    pub ahead_count: Option<u32>,
    pub has_updates: bool,
    pub remote_ref: Option<String>,
    pub split_hash: Option<String>,
    pub remote_hash: Option<String>,
    pub error: Option<String>,
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
    #[serde(default)]
    #[specta(optional)]
    pub conflict_type: String,
    #[serde(default)]
    #[specta(optional)]
    pub conflict_types: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub actions: Vec<String>,
    #[serde(default)]
    #[specta(optional)]
    pub current_status: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub incoming_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlock {
    pub index: u32,
    pub ours_label: String,
    pub theirs_label: String,
    pub ours_lines: Vec<String>,
    pub base_lines: Vec<String>,
    pub theirs_lines: Vec<String>,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeVersions {
    pub path: String,
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub working: String,
    pub marker_content: String,
    pub conflicts: Vec<ConflictBlock>,
    pub ours_label: String,
    pub theirs_label: String,
    pub language: String,
    pub fingerprint: String,
    pub binary: bool,
    #[serde(default)]
    #[specta(optional)]
    pub ours_status: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub theirs_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCommitSelection {
    pub repo_id: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreConflictFailure {
    pub path: String,
    pub error: DesktopError,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreConflictsResult {
    pub restored_paths: Vec<String>,
    pub failures: Vec<RestoreConflictFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolutionResult {
    pub resolved: bool,
    pub auto_commit_error: Option<String>,
    #[serde(default)]
    pub auto_committed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileInfo {
    pub path: String,
    pub size_bytes: f64,
    pub size_formatted: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InvalidFileNameInfo {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitSafetyCheckResult {
    pub has_issues: bool,
    pub sensitive_files: Vec<String>,
    pub large_files: Vec<LargeFileInfo>,
    pub invalid_file_names: Vec<InvalidFileNameInfo>,
    pub crlf_files: Vec<String>,
}
