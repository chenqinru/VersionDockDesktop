use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub execution_mode: String,
    pub provider: String,
    pub api_protocol: String,
    pub api_url: String,
    pub model: String,
    pub max_input_tokens: u32,
    pub max_output_tokens: u32,
    pub cli_provider: String,
    pub cli_model: String,
    pub cli_timeout_seconds: u32,
    pub cli_executable_paths: BTreeMap<String, String>,
}
impl Default for AiConfig {
    fn default() -> Self {
        Self {
            execution_mode: "provider".into(),
            provider: "openai".into(),
            api_protocol: "chat-completions".into(),
            api_url: String::new(),
            model: String::new(),
            max_input_tokens: 128_000,
            max_output_tokens: 128_000,
            cli_provider: "claude".into(),
            cli_model: String::new(),
            cli_timeout_seconds: 300,
            cli_executable_paths: [
                ("claude", "claude"),
                ("codex", "codex"),
                ("antigravity", "agy"),
                ("opencode", "opencode"),
            ]
            .into_iter()
            .map(|(a, b)| (a.into(), b.into()))
            .collect(),
        }
    }
}
impl AiConfig {
    pub fn normalize(mut self) -> Self {
        if !["openai", "claude", "gemini", "custom"].contains(&self.provider.as_str()) {
            self.provider = "openai".into();
        }
        if self.execution_mode != "agent-cli" {
            self.execution_mode = "provider".into();
        }
        if self.api_protocol != "responses" {
            self.api_protocol = "chat-completions".into();
        }
        if !["claude", "codex", "antigravity", "opencode"].contains(&self.cli_provider.as_str()) {
            self.cli_provider = "claude".into();
        }
        self.max_input_tokens = self.max_input_tokens.clamp(4_096, 1_000_000);
        self.max_output_tokens = self.max_output_tokens.clamp(1_024, 128_000);
        self.cli_timeout_seconds = self.cli_timeout_seconds.clamp(30, 1_800);
        self.model = self.model.trim().into();
        self.api_url = self.api_url.trim().into();
        self.cli_model = self.cli_model.trim().into();
        self
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum AiTask {
    CommitMessage,
    CommitExplanation,
    CodeReview,
    CommitComposer,
    MergeConflict,
}
impl AiTask {
    pub fn name(self) -> &'static str {
        match self {
            Self::CommitMessage => "commit-message",
            Self::CommitExplanation => "commit-explanation",
            Self::CodeReview => "code-review",
            Self::CommitComposer => "commit-composer",
            Self::MergeConflict => "merge-conflict",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiCandidate {
    pub repo_id: String,
    pub paths: Vec<String>,
    pub staged_only: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiCommit {
    pub repo_id: String,
    pub hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub request_id: String,
    pub task: AiTask,
    pub workspace_id: String,
    #[serde(default)]
    pub candidates: Vec<AiCandidate>,
    #[serde(default)]
    pub commits: Vec<AiCommit>,
    #[serde(default)]
    pub user_prompt: String,
    pub repo_id: Option<String>,
    pub path: Option<String>,
    #[serde(default)]
    pub conflict_indexes: Vec<u32>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub unit_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiAnchor {
    pub id: String,
    pub repo_id: String,
    pub repo_name: String,
    pub file_path: String,
    pub staged: bool,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiFinding {
    pub id: String,
    pub severity: String,
    pub title: String,
    pub anchor_id: String,
    pub evidence: String,
    pub impact: String,
    pub suggestion: String,
    pub anchor: AiAnchor,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiReview {
    pub verdict: String,
    pub summary: String,
    pub findings: Vec<AiFinding>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiResolution {
    pub index: u32,
    pub lines: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiGroup {
    pub id: String,
    pub message: String,
    #[serde(default)]
    pub rationale: String,
    pub unit_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiUnit {
    pub id: String,
    pub file_path: String,
    pub old_path: Option<String>,
    pub kind: String,
    pub status: String,
    pub title: String,
    pub diff: String,
    pub language: String,
    pub added: u32,
    pub removed: u32,
    pub atomic: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiComposerSource {
    pub session_id: String,
    pub mode: String,
    pub repo_id: String,
    pub repo_name: String,
    pub vcs_kind: String,
    pub branch: String,
    pub source_label: String,
    pub units: Vec<AiUnit>,
    pub original_commit_count: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiApplyResult {
    pub commit_count: u32,
    pub commit_hashes: Vec<String>,
    pub backup_ref: Option<String>,
    pub recovery_command: Option<String>,
    pub completed_groups: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiResult {
    pub text: String,
    pub provider: String,
    pub model: String,
    pub prompt_source: String,
    pub input_truncated: bool,
    pub duration_ms: u32,
    pub review: Option<AiReview>,
    pub resolutions: Vec<AiResolution>,
    pub groups: Vec<AiGroup>,
    pub file_count: u32,
    pub repository_count: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiEvent {
    pub r#type: String,
    pub request_id: String,
    pub phase: String,
    pub delta: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiRuntime {
    pub configured: bool,
    pub key_saved: bool,
    pub provider: String,
    pub available: bool,
    pub message: String,
    pub version: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiPrompt {
    pub text: String,
    pub source: String,
    pub path: Option<String>,
}
