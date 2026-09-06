use serde::{Deserialize, Serialize};

pub fn is_blocking_approval(details: &serde_json::Value) -> bool {
    let method: String = details
        .get("_serverMethod")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    // Other approvals and older runtimes remain blocking.
    !(matches!(
        method.as_str(),
        "itemtoolrequestuserinput" | "toolrequestuserinput"
    ) && details
        .get("isBlocking")
        .and_then(serde_json::Value::as_bool)
        == Some(false))
}

pub const ACTION_OUTPUT_DELTA_MAX_CHARS: usize = 16 * 1024;
pub const STREAMED_DIFF_MAX_CHARS: usize = 128 * 1024;
const ACTION_OUTPUT_DELTA_TRUNCATED_PREFIX: &str = "... [output truncated; showing tail]\n";

pub fn trim_action_output_delta_content(content: &str) -> String {
    if content.chars().count() <= ACTION_OUTPUT_DELTA_MAX_CHARS {
        return content.to_string();
    }

    let tail_chars =
        ACTION_OUTPUT_DELTA_MAX_CHARS.saturating_sub(ACTION_OUTPUT_DELTA_TRUNCATED_PREFIX.len());
    let mut tail = content
        .chars()
        .rev()
        .take(tail_chars.max(1))
        .collect::<Vec<_>>();
    tail.reverse();

    format!(
        "{}{}",
        ACTION_OUTPUT_DELTA_TRUNCATED_PREFIX,
        tail.into_iter().collect::<String>()
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EngineEvent {
    CodexNativeEvent {
        event: CodexNativeEvent,
    },
    TurnStarted {
        client_turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        native_turn_id: Option<String>,
    },
    TurnCompleted {
        token_usage: Option<TokenUsage>,
        status: TurnCompletionStatus,
        diagnostics: Option<TurnCompletionDiagnostics>,
    },
    TurnSnapshotRecovered {
        blocks: Vec<serde_json::Value>,
    },
    TextDelta {
        content: String,
    },
    ThinkingDelta {
        content: String,
    },
    ActionStarted {
        action_id: String,
        engine_action_id: Option<String>,
        action_type: ActionType,
        summary: String,
        details: serde_json::Value,
    },
    ActionOutputDelta {
        action_id: String,
        stream: OutputStream,
        content: String,
    },
    ActionProgressUpdated {
        action_id: String,
        message: String,
    },
    ActionCompleted {
        action_id: String,
        result: ActionResult,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<serde_json::Value>,
    },
    DiffUpdated {
        diff: String,
        scope: DiffScope,
    },
    ApprovalRequested {
        approval_id: String,
        action_type: ActionType,
        summary: String,
        details: serde_json::Value,
    },
    UsageLimitsUpdated {
        usage: UsageLimitsSnapshot,
    },
    ModelRerouted {
        from_model: String,
        to_model: String,
        reason: String,
    },
    Notice {
        kind: String,
        level: String,
        title: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<Vec<String>>,
    },
    Error {
        message: String,
        recoverable: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnCompletionStatus {
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexNativeEvent {
    pub source_sequence: u64,
    pub observed_at_ms: i64,
    pub event_kind: CodexNativeEventKind,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub native_thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_turn_id: Option<String>,
    pub params_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexNativeEventKind {
    ClientRequest,
    ClientResponse,
    Request,
    Notification,
    Response,
}

impl CodexNativeEventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClientRequest => "client_request",
            Self::ClientResponse => "client_response",
            Self::Request => "request",
            Self::Notification => "notification",
            Self::Response => "response",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnCompletionSource {
    Engine,
    RecoveredSnapshot,
    ReconciledStreamLost,
    ReconciledTimeout,
    TimeoutFallback,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TurnCompletionDiagnostics {
    pub source: TurnCompletionSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionType {
    FileRead,
    FileWrite,
    FileEdit,
    FileDelete,
    Command,
    Git,
    Search,
    Other,
}

impl ActionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionType::FileRead => "file_read",
            ActionType::FileWrite => "file_write",
            ActionType::FileEdit => "file_edit",
            ActionType::FileDelete => "file_delete",
            ActionType::Command => "command",
            ActionType::Git => "git",
            ActionType::Search => "search",
            ActionType::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputStream {
    Stdout,
    Stderr,
    Stdin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffScope {
    Turn,
    File,
    Workspace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
    pub diff: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub reasoning: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageLimitsSnapshot {
    pub current_tokens: Option<u64>,
    pub max_context_tokens: Option<u64>,
    pub context_window_percent: Option<u8>,
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
    pub five_hour_percent: Option<u8>,
    pub weekly_percent: Option<u8>,
    pub five_hour_resets_at: Option<i64>,
    pub weekly_resets_at: Option<i64>,
}
