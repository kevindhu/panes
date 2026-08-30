use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub scan_depth: i64,
    pub created_at: String,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDto {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub path: String,
    pub default_branch: String,
    pub is_active: bool,
    pub trust_level: TrustLevelDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevelDto {
    Trusted,
    Standard,
    Restricted,
}

impl TrustLevelDto {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrustLevelDto::Trusted => "trusted",
            TrustLevelDto::Standard => "standard",
            TrustLevelDto::Restricted => "restricted",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "trusted" => Self::Trusted,
            "restricted" => Self::Restricted,
            _ => Self::Standard,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDto {
    pub id: String,
    pub workspace_id: String,
    pub repo_id: Option<String>,
    pub engine_id: String,
    pub model_id: String,
    pub engine_thread_id: Option<String>,
    pub engine_metadata: Option<Value>,
    pub title: String,
    pub status: ThreadStatusDto,
    pub message_count: i64,
    pub total_tokens: i64,
    pub created_at: String,
    pub last_activity_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRemoteThreadDto {
    pub engine_thread_id: String,
    pub title: Option<String>,
    pub preview: String,
    pub cwd: String,
    pub created_at: String,
    pub updated_at: String,
    pub model_provider: String,
    pub source_kind: String,
    pub status_type: String,
    #[serde(default)]
    pub active_flags: Vec<String>,
    pub archived: bool,
    pub local_thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRemoteThreadPageDto {
    pub threads: Vec<CodexRemoteThreadDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatusDto {
    Idle,
    Streaming,
    AwaitingApproval,
    Error,
    Completed,
}

impl ThreadStatusDto {
    pub fn as_str(&self) -> &'static str {
        match self {
            ThreadStatusDto::Idle => "idle",
            ThreadStatusDto::Streaming => "streaming",
            ThreadStatusDto::AwaitingApproval => "awaiting_approval",
            ThreadStatusDto::Error => "error",
            ThreadStatusDto::Completed => "completed",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "streaming" => Self::Streaming,
            "awaiting_approval" => Self::AwaitingApproval,
            "error" => Self::Error,
            "completed" => Self::Completed,
            _ => Self::Idle,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: Option<String>,
    pub blocks: Option<Value>,
    pub native_turn_id: Option<String>,
    pub turn_engine_id: Option<String>,
    pub turn_model_id: Option<String>,
    pub turn_reasoning_effort: Option<String>,
    pub schema_version: i64,
    pub status: MessageStatusDto,
    pub token_usage: Option<TokenUsageDto>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWindowCursorDto {
    pub created_at: String,
    pub id: String,
    pub row_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWindowDto {
    pub messages: Vec<MessageDto>,
    pub next_cursor: Option<MessageWindowCursorDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOutputChunkDto {
    pub stream: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOutputDto {
    pub found: bool,
    pub output_chunks: Vec<ActionOutputChunkDto>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatusDto {
    Completed,
    Streaming,
    Interrupted,
    Error,
}

impl MessageStatusDto {
    pub fn as_str(&self) -> &'static str {
        match self {
            MessageStatusDto::Completed => "completed",
            MessageStatusDto::Streaming => "streaming",
            MessageStatusDto::Interrupted => "interrupted",
            MessageStatusDto::Error => "error",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "streaming" => Self::Streaming,
            "interrupted" => Self::Interrupted,
            "error" => Self::Error,
            _ => Self::Completed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageDto {
    pub input: u64,
    pub output: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultDto {
    pub thread_id: String,
    pub thread_title: String,
    pub workspace_name: String,
    pub repo_id: Option<String>,
    pub message_id: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfoDto {
    pub id: String,
    pub name: String,
    pub models: Vec<EngineModelDto>,
    pub capabilities: EngineCapabilitiesDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilitiesDto {
    #[serde(default)]
    pub permission_modes: Vec<String>,
    #[serde(default)]
    pub sandbox_modes: Vec<String>,
    #[serde(default)]
    pub approval_decisions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModelDto {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    pub is_default: bool,
    pub upgrade: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability_nux: Option<EngineModelAvailabilityNuxDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgrade_info: Option<EngineModelUpgradeInfoDto>,
    #[serde(default)]
    pub input_modalities: Vec<String>,
    #[serde(default)]
    pub attachment_modalities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<EngineModelLimitsDto>,
    #[serde(default)]
    pub supports_personality: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<ReasoningEffortOptionDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModelLimitsDto {
    pub context_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModelAvailabilityNuxDto {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModelUpgradeInfoDto {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgrade_copy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_link: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortOptionDto {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineHealthDto {
    pub id: String,
    pub available: bool,
    pub version: Option<String>,
    pub details: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub checks: Vec<String>,
    #[serde(default)]
    pub fixes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_diagnostics: Option<CodexProtocolDiagnosticsDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexProtocolDiagnosticsDto {
    #[serde(default)]
    pub method_availability: Vec<CodexMethodAvailabilityDto>,
    #[serde(default)]
    pub experimental_features: Vec<CodexExperimentalFeatureDto>,
    #[serde(default)]
    pub collaboration_modes: Vec<String>,
    #[serde(default)]
    pub apps: Vec<CodexAppDto>,
    #[serde(default)]
    pub skills: Vec<CodexSkillDto>,
    #[serde(default)]
    pub plugin_marketplaces: Vec<CodexPluginMarketplaceDto>,
    #[serde(default)]
    pub mcp_servers: Vec<CodexMcpServerDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<CodexAccountStateDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<CodexConfigStateDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_config_warning: Option<CodexConfigWarningDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_account_login: Option<CodexAccountLoginCompletedDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_mcp_oauth: Option<CodexMcpOauthCompletedDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_thread_realtime: Option<CodexThreadRealtimeEventDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_windows_sandbox_setup: Option<CodexWindowsSandboxSetupDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_windows_world_writable_warning: Option<CodexWindowsWorldWritableWarningDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMethodAvailabilityDto {
    pub method: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexExperimentalFeatureDto {
    pub name: String,
    pub enabled: bool,
    pub default_enabled: bool,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppDto {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub is_enabled: bool,
    pub is_accessible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSkillDto {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub description: String,
    pub enabled: bool,
    #[serde(default)]
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginMarketplaceDto {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub plugins: Vec<CodexPluginDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginDto {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub installed: bool,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpServerDto {
    pub name: String,
    pub auth_status: String,
    pub tool_count: usize,
    pub resource_count: usize,
    pub resource_template_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountStateDto {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    pub requires_openai_auth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfigStateDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_profile: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default)]
    pub layers: Vec<CodexConfigLayerDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfigLayerDto {
    pub source: String,
    #[serde(default)]
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfigWarningDto {
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountLoginCompletedDto {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpOauthCompletedDto {
    pub name: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadRealtimeEventDto {
    pub kind: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_channels: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub samples_per_channel: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWindowsSandboxSetupDto {
    pub mode: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWindowsWorldWritableWarningDto {
    pub sample_paths: Vec<String>,
    pub extra_count: u64,
    pub failed_scan: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeToastDto {
    pub variant: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineRuntimeUpdatedDto {
    pub engine_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_diagnostics: Option<CodexProtocolDiagnosticsDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toast: Option<RuntimeToastDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCheckResultDto {
    pub command: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeEntryDto {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreePageDto {
    pub entries: Vec<FileTreeEntryDto>,
    pub offset: usize,
    pub limit: usize,
    pub total: usize,
    pub has_more: bool,
    pub scan_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResultDto {
    pub content: String,
    pub size_bytes: u64,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEditorFileReferenceDto {
    pub repo_path: String,
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}
