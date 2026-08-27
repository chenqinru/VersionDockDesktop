use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

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
    UpdateSettings {
        settings: DesktopSettings,
    },
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
    },
    BatchCommit {
        workspace_id: String,
        targets: Vec<BatchCommitTarget>,
        push: bool,
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
        revision: Option<String>,
    },
    HistoryTopology {
        workspace_id: String,
        repo_id: String,
        svn_limit: u32,
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
    AbortRepositoryOperation {
        workspace_id: String,
        repo_id: String,
        operation: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BatchCommitTarget {
    pub repo_id: String,
    pub message: String,
    pub amend: bool,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOperationResult {
    pub repo_id: String,
    pub committed: bool,
    pub revision: Option<String>,
    pub pushed: bool,
    pub error: Option<DesktopError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreRules {
    pub directory: String,
    pub source: String,
    pub patterns: Vec<String>,
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
    Merge { name: String },
    Rebase { name: String },
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
    pub path: String,
    pub url: String,
    pub initialized: bool,
    pub revision: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SubmoduleOperation {
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubtreeState {
    Active,
    Pending,
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
    Save {
        username: String,
        password: Option<String>,
    },
    Delete,
    Test,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SvnOperation {
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
    pub repository_root: String,
    pub username: Option<String>,
    pub password_stored: bool,
    pub secure_storage_available: bool,
    pub password_stdin_supported: bool,
    pub connection_ok: Option<bool>,
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
        }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
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
    3
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub theme: ThemePreference,
    pub language: LanguagePreference,
    pub ui_font_size: UiFontSizePreference,
    pub changes_display_mode: ChangesDisplayMode,
    pub default_commit_action: DefaultCommitAction,
    pub default_save_action: DefaultSaveAction,
    pub prompt_before_adding_untracked: bool,
    pub suppress_diverged_warning: bool,
    pub auto_refresh_interval: u32,
    pub fetch_on_startup: bool,
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
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            language: LanguagePreference::System,
            ui_font_size: UiFontSizePreference::Standard,
            changes_display_mode: ChangesDisplayMode::Simplified,
            default_commit_action: DefaultCommitAction::Commit,
            default_save_action: DefaultSaveAction::Stash,
            prompt_before_adding_untracked: true,
            suppress_diverged_warning: false,
            auto_refresh_interval: 0,
            fetch_on_startup: false,
            reset_view_locations_on_startup: false,
            notify_incoming_commits: false,
            notify_unpushed_commits: false,
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
        }
    }
}

impl DesktopSettings {
    pub fn normalize(mut self) -> Self {
        self.repository_scan_depth = self.repository_scan_depth.min(10);
        self.maximum_graph_commits = self.maximum_graph_commits.clamp(100, 10_000);
        self.auto_refresh_interval = self.auto_refresh_interval.min(86_400);
        self.ignored_folders = self
            .ignored_folders
            .into_iter()
            .map(|value| value.trim().replace('\\', "/"))
            .filter(|value| {
                !value.is_empty()
                    && !value.contains('\0')
                    && !value.split('/').any(|part| part == "..")
            })
            .collect();
        self.ignored_folders.sort();
        self.ignored_folders.dedup();
        self.project_colors.retain(|_, value| is_color(value));
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

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum ChangesDisplayMode {
    #[default]
    Simplified,
    Changelists,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum DefaultCommitAction {
    #[default]
    Commit,
    CommitAndPush,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum DefaultSaveAction {
    #[default]
    Stash,
    Shelf,
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
    pub submodule: bool,
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
    pub author: String,
    pub date: String,
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UnpushedOperation {
    Revert {
        hashes: Vec<String>,
    },
    UndoHead,
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
    pub actions: Vec<String>,
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
