use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

use crate::{
    engines::{
        codex::{CodexEngine, CodexForkedThread, CodexReviewStarted},
    },
    models::{
        CodexAppDto, CodexSkillDto, EngineCapabilitiesDto, EngineHealthDto, EngineInfoDto,
        EngineModelAvailabilityNuxDto, EngineModelDto, EngineModelUpgradeInfoDto,
        ReasoningEffortOptionDto, ThreadDto,
    },
};

pub mod codex;
pub mod codex_event_mapper;
pub mod codex_protocol;
pub mod codex_transport;
pub mod events;

pub use codex::CodexRuntimeEvent;
pub use events::*;

#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRequestRoute {
    pub server_method: String,
    pub raw_request_id: Value,
}

#[derive(Debug, Clone)]
pub enum ThreadScope {
    Repo {
        repo_path: String,
    },
    Workspace {
        root_path: String,
        writable_roots: Vec<String>,
    },
}

#[derive(Debug, Clone)]
pub struct SandboxPolicy {
    pub writable_roots: Vec<String>,
    pub allow_network: bool,
    pub approval_policy: Option<Value>,
    pub permission_profile: Option<Value>,
    pub approvals_reviewer: Option<String>,
    pub reasoning_effort: Option<String>,
    pub sandbox_mode: Option<String>,
    pub service_tier: Option<String>,
    pub personality: Option<String>,
    pub output_schema: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    pub is_default: bool,
    pub upgrade: Option<String>,
    pub availability_nux: Option<ModelAvailabilityNux>,
    pub upgrade_info: Option<ModelUpgradeInfo>,
    pub input_modalities: Vec<String>,
    pub attachment_modalities: Vec<String>,
    pub limits: Option<ModelLimits>,
    pub supports_personality: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<ReasoningEffortOption>,
}

#[derive(Debug, Clone, Default)]
pub struct ModelLimits {
    pub context_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ReasoningEffortOption {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct ModelAvailabilityNux {
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ModelUpgradeInfo {
    pub model: String,
    pub upgrade_copy: Option<String>,
    pub model_link: Option<String>,
    pub migration_markdown: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct EngineCapabilities {
    pub permission_modes: &'static [&'static str],
    pub sandbox_modes: &'static [&'static str],
    pub approval_decisions: &'static [&'static str],
}

const CODEX_CAPABILITIES: EngineCapabilities = EngineCapabilities {
    permission_modes: &["untrusted", "on-failure", "on-request", "never"],
    sandbox_modes: &["read-only", "workspace-write", "danger-full-access"],
    approval_decisions: &["accept", "decline", "cancel", "accept_for_session"],
};

pub fn capabilities_for_engine(engine_id: &str) -> EngineCapabilities {
    match engine_id {
        "codex" => CODEX_CAPABILITIES,
        _ => EngineCapabilities {
            permission_modes: &[],
            sandbox_modes: &[],
            approval_decisions: &[],
        },
    }
}

pub fn engine_supports_sandbox_mode(engine_id: &str, sandbox_mode: &str) -> bool {
    capabilities_for_engine(engine_id)
        .sandbox_modes
        .contains(&sandbox_mode)
}

pub fn validate_engine_sandbox_mode(
    engine_id: &str,
    sandbox_mode: Option<&str>,
) -> Result<(), String> {
    let Some(sandbox_mode) = sandbox_mode else {
        return Ok(());
    };

    if engine_supports_sandbox_mode(engine_id, sandbox_mode) {
        return Ok(());
    }

    let supported = capabilities_for_engine(engine_id).sandbox_modes.join(", ");
    Err(format!(
        "engine sandbox mode `{sandbox_mode}` is not supported. expected one of: {supported}"
    ))
}

pub fn normalize_approval_response_for_engine(
    engine_id: &str,
    response: Value,
) -> Result<Value, String> {
    if engine_id != "codex" {
        return Err(format!("unsupported engine_id {engine_id}"));
    }
    Ok(response)
}

pub fn approval_response_route_for_engine(
    engine_id: &str,
    details: &Value,
) -> Option<ApprovalRequestRoute> {
    match engine_id {
        "codex" => codex_event_mapper::extract_persisted_approval_route(details),
        _ => None,
    }
}

fn map_engine_capabilities(capabilities: EngineCapabilities) -> EngineCapabilitiesDto {
    EngineCapabilitiesDto {
        permission_modes: capabilities
            .permission_modes
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        sandbox_modes: capabilities
            .sandbox_modes
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        approval_decisions: capabilities
            .approval_decisions
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
    }
}

#[derive(Debug, Clone)]
pub struct EngineThread {
    pub engine_thread_id: String,
}

#[derive(Debug, Clone)]
pub struct ThreadSyncSnapshot {
    pub title: Option<String>,
    pub preview: Option<String>,
    pub raw_status: Option<String>,
    pub active_flags: Vec<String>,
    pub imported_messages: Vec<ImportedThreadMessage>,
}

#[derive(Debug, Clone)]
pub struct ImportedThreadMessage {
    pub role: String,
    pub content: Option<String>,
    pub blocks: Value,
    pub status: String,
    pub native_turn_id: Option<String>,
    pub turn_engine_id: Option<String>,
    pub turn_model_id: Option<String>,
    pub turn_reasoning_effort: Option<String>,
    pub token_input: u64,
    pub token_output: u64,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageLimitsReadDiagnostics {
    pub thread_read_attempted: bool,
    pub thread_read_succeeded: bool,
    pub latest_turn_read_attempted: bool,
    pub latest_turn_read_succeeded: bool,
    pub latest_turn_source: Option<String>,
    pub latest_turn_id: Option<String>,
    pub latest_turn_had_token_usage: bool,
    pub account_read_attempted: bool,
    pub account_read_succeeded: bool,
    pub thread_read_error: Option<String>,
    pub latest_turn_read_error: Option<String>,
    pub account_read_error: Option<String>,
    pub fatal_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageLimitsReadResult {
    pub usage: Option<UsageLimitsSnapshot>,
    pub diagnostics: UsageLimitsReadDiagnostics,
}

#[derive(Debug, Clone)]
pub struct CodexRemoteThreadSummary {
    pub engine_thread_id: String,
    pub title: Option<String>,
    pub preview: String,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub model_provider: String,
    pub source_kind: String,
    pub status_type: String,
    pub active_flags: Vec<String>,
    pub archived: bool,
}

#[derive(Debug, Clone)]
pub struct TurnAttachment {
    pub file_name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TurnInput {
    pub message: String,
    pub attachments: Vec<TurnAttachment>,
    pub plan_mode: bool,
    pub input_items: Vec<TurnInputItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TurnInputItem {
    Text { text: String },
    Skill { name: String, path: String },
    Mention { name: String, path: String },
}

#[async_trait]
pub trait Engine: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn models(&self) -> Vec<ModelInfo>;

    async fn is_available(&self) -> bool;

    async fn start_thread(
        &self,
        scope: ThreadScope,
        resume_engine_thread_id: Option<&str>,
        model: &str,
        sandbox: SandboxPolicy,
    ) -> Result<EngineThread, anyhow::Error>;

    async fn send_message(
        &self,
        engine_thread_id: &str,
        input: TurnInput,
        event_tx: mpsc::Sender<EngineEvent>,
        cancellation: CancellationToken,
    ) -> Result<(), anyhow::Error>;

    async fn steer_message(
        &self,
        engine_thread_id: &str,
        input: TurnInput,
    ) -> Result<(), anyhow::Error>;

    async fn respond_to_approval(
        &self,
        approval_id: &str,
        response: serde_json::Value,
        route: Option<ApprovalRequestRoute>,
    ) -> Result<(), anyhow::Error>;

    async fn interrupt(&self, engine_thread_id: &str) -> Result<(), anyhow::Error>;

    async fn archive_thread(&self, engine_thread_id: &str) -> Result<(), anyhow::Error>;

    async fn unarchive_thread(&self, engine_thread_id: &str) -> Result<(), anyhow::Error>;
}

pub struct EngineManager {
    codex: Arc<CodexEngine>,
}

impl EngineManager {
    pub fn new() -> Self {
        Self {
            codex: Arc::new(CodexEngine::default()),
        }
    }

    pub async fn list_engines(&self) -> anyhow::Result<Vec<EngineInfoDto>> {
        let codex_models = match timeout(Duration::from_secs(4), self.codex.list_models_runtime())
            .await
        {
            Ok(models) => models,
            Err(_) => {
                log::warn!(
                        "timed out loading codex runtime models; falling back to cached or static model catalog"
                    );
                self.codex.runtime_model_fallback().await
            }
        };
        Ok(vec![EngineInfoDto {
                id: self.codex.id().to_string(),
                name: self.codex.name().to_string(),
                models: codex_models.into_iter().map(map_model_info).collect(),
                capabilities: map_engine_capabilities(capabilities_for_engine(self.codex.id())),
            }])
    }

    pub async fn health(&self, engine_id: &str) -> anyhow::Result<EngineHealthDto> {
        match engine_id {
            "codex" => {
                let report = self.codex.health_report().await;
                Ok(EngineHealthDto {
                    id: "codex".to_string(),
                    available: report.available,
                    version: report.version,
                    details: report.details,
                    warnings: report.warnings,
                    checks: report.checks,
                    fixes: report.fixes,
                    protocol_diagnostics: report.protocol_diagnostics,
                })
            }
            _ => anyhow::bail!("unknown engine: {engine_id}"),
        }
    }

    pub async fn prewarm(&self, engine_id: &str) -> anyhow::Result<()> {
        match engine_id {
            "codex" => self.codex.prewarm().await,
            _ => anyhow::bail!("unknown engine: {engine_id}"),
        }
    }

    pub async fn list_codex_skills(&self, cwd: &str) -> anyhow::Result<Vec<CodexSkillDto>> {
        self.codex.list_skills(cwd).await
    }

    pub async fn list_codex_apps(&self) -> anyhow::Result<Vec<CodexAppDto>> {
        self.codex.list_apps().await
    }

    pub async fn read_thread_usage_limits(
        &self,
        thread: &ThreadDto,
    ) -> anyhow::Result<UsageLimitsReadResult> {
        match thread.engine_id.as_str() {
            "codex" => {
                self.codex
                    .read_usage_limits_snapshot(thread.engine_thread_id.as_deref())
                    .await
            }
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        }
    }

    pub async fn fork_codex_thread(
        &self,
        engine_thread_id: &str,
        cwd: &str,
        model: &str,
        last_turn_id: Option<&str>,
        sandbox: SandboxPolicy,
    ) -> anyhow::Result<CodexForkedThread> {
        self.codex
            .fork_thread(engine_thread_id, cwd, model, last_turn_id, sandbox)
            .await
    }

    pub async fn resolve_codex_fork_turn_id(
        &self,
        engine_thread_id: &str,
        turns_after: u32,
    ) -> anyhow::Result<String> {
        self.codex
            .resolve_fork_turn_id(engine_thread_id, turns_after)
            .await
    }

    pub async fn rollback_codex_thread(
        &self,
        engine_thread_id: &str,
        num_turns: u32,
    ) -> anyhow::Result<ThreadSyncSnapshot> {
        self.codex
            .rollback_thread(engine_thread_id, num_turns)
            .await
    }

    pub async fn compact_codex_thread(&self, engine_thread_id: &str) -> anyhow::Result<()> {
        self.codex.compact_thread(engine_thread_id).await
    }

    pub async fn list_codex_remote_threads(
        &self,
        search_term: Option<&str>,
        archived: Option<bool>,
    ) -> anyhow::Result<Vec<CodexRemoteThreadSummary>> {
        self.codex.list_threads(search_term, archived).await
    }

    pub async fn read_codex_remote_thread(
        &self,
        engine_thread_id: &str,
    ) -> anyhow::Result<CodexRemoteThreadSummary> {
        self.codex.read_remote_thread(engine_thread_id).await
    }

    pub async fn unarchive_codex_remote_thread(
        &self,
        engine_thread_id: &str,
    ) -> anyhow::Result<()> {
        self.codex.unarchive_remote_thread(engine_thread_id).await
    }

    pub async fn start_codex_review(
        &self,
        source_engine_thread_id: &str,
        target: Value,
        delivery: Option<&str>,
        event_tx: mpsc::Sender<EngineEvent>,
        cancellation: CancellationToken,
        started_tx: oneshot::Sender<CodexReviewStarted>,
    ) -> anyhow::Result<()> {
        self.codex
            .start_review(
                source_engine_thread_id,
                target,
                delivery,
                event_tx,
                cancellation,
                started_tx,
            )
            .await
    }

    pub async fn ensure_engine_thread(
        &self,
        thread: &ThreadDto,
        model_id: Option<&str>,
        scope: ThreadScope,
        sandbox: SandboxPolicy,
    ) -> anyhow::Result<String> {
        let resume_id = thread.engine_thread_id.as_deref();
        let effective_model_id = model_id.unwrap_or(thread.model_id.as_str());

        let result = match thread.engine_id.as_str() {
            "codex" => self
                .codex
                .start_thread(scope, resume_id, effective_model_id, sandbox)
                .await
                .context("failed to start codex thread")?,
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        };

        Ok(result.engine_thread_id)
    }

    pub async fn send_message(
        &self,
        thread: &ThreadDto,
        engine_thread_id: &str,
        input: TurnInput,
        event_tx: mpsc::Sender<EngineEvent>,
        cancellation: CancellationToken,
    ) -> anyhow::Result<()> {
        match thread.engine_id.as_str() {
            "codex" => self
                .codex
                .send_message(engine_thread_id, input, event_tx, cancellation)
                .await
                .context("codex send_message failed"),
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        }
    }

    pub async fn steer_message(
        &self,
        thread: &ThreadDto,
        engine_thread_id: &str,
        input: TurnInput,
    ) -> anyhow::Result<()> {
        match thread.engine_id.as_str() {
            "codex" => self
                .codex
                .steer_message(engine_thread_id, input)
                .await
                .context("codex steer_message failed"),
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        }
    }

    pub async fn respond_to_approval(
        &self,
        thread: &ThreadDto,
        approval_id: &str,
        response: serde_json::Value,
        route: Option<ApprovalRequestRoute>,
    ) -> anyhow::Result<()> {
        match thread.engine_id.as_str() {
            "codex" => {
                self.codex
                    .respond_to_approval(approval_id, response, route)
                    .await
            }
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        }
    }

    pub async fn interrupt(&self, thread: &ThreadDto) -> anyhow::Result<()> {
        let engine_thread_id = thread.engine_thread_id.as_deref().unwrap_or("default");
        match thread.engine_id.as_str() {
            "codex" => self.codex.interrupt(engine_thread_id).await,
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        }
    }

    pub async fn archive_thread(&self, thread: &ThreadDto) -> anyhow::Result<()> {
        let Some(engine_thread_id) = thread.engine_thread_id.as_deref() else {
            return Ok(());
        };

        match thread.engine_id.as_str() {
            "codex" => self.codex.archive_thread(engine_thread_id).await,
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        }
    }

    pub async fn unarchive_thread(&self, thread: &ThreadDto) -> anyhow::Result<()> {
        let Some(engine_thread_id) = thread.engine_thread_id.as_deref() else {
            return Ok(());
        };

        match thread.engine_id.as_str() {
            "codex" => self.codex.unarchive_thread(engine_thread_id).await,
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        }
    }

    pub async fn codex_uses_external_sandbox(&self) -> bool {
        self.codex.uses_external_sandbox().await
    }

    pub async fn read_thread_preview(
        &self,
        thread: &ThreadDto,
        engine_thread_id: &str,
    ) -> Option<String> {
        match thread.engine_id.as_str() {
            "codex" => self.codex.read_thread_preview(engine_thread_id).await,
            _ => None,
        }
    }

    pub async fn set_thread_name(
        &self,
        thread: &ThreadDto,
        engine_thread_id: &str,
        name: &str,
    ) -> anyhow::Result<()> {
        match thread.engine_id.as_str() {
            "codex" => self.codex.set_thread_name(engine_thread_id, name).await,
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        }
    }

    pub fn subscribe_codex_runtime_events(&self) -> broadcast::Receiver<CodexRuntimeEvent> {
        self.codex.subscribe_runtime_events()
    }

    pub async fn read_thread_sync_snapshot(
        &self,
        thread: &ThreadDto,
    ) -> anyhow::Result<Option<ThreadSyncSnapshot>> {
        let Some(engine_thread_id) = thread.engine_thread_id.as_deref() else {
            return Ok(None);
        };

        match thread.engine_id.as_str() {
            "codex" => self
                .codex
                .read_thread_sync_snapshot(engine_thread_id)
                .await
                .map(Some),
            _ => anyhow::bail!("unsupported engine_id {}", thread.engine_id),
        }
    }
}

fn map_model_info(model: ModelInfo) -> EngineModelDto {
    EngineModelDto {
        id: model.id,
        display_name: model.display_name,
        description: model.description,
        hidden: model.hidden,
        is_default: model.is_default,
        upgrade: model.upgrade,
        availability_nux: model
            .availability_nux
            .map(|value| EngineModelAvailabilityNuxDto {
                message: value.message,
            }),
        upgrade_info: model.upgrade_info.map(|value| EngineModelUpgradeInfoDto {
            model: value.model,
            upgrade_copy: value.upgrade_copy,
            model_link: value.model_link,
            migration_markdown: value.migration_markdown,
        }),
        input_modalities: model.input_modalities,
        attachment_modalities: model.attachment_modalities,
        limits: model
            .limits
            .map(|limits| crate::models::EngineModelLimitsDto {
                context_tokens: limits.context_tokens,
                input_tokens: limits.input_tokens,
                output_tokens: limits.output_tokens,
            }),
        supports_personality: model.supports_personality,
        default_reasoning_effort: model.default_reasoning_effort,
        supported_reasoning_efforts: model
            .supported_reasoning_efforts
            .into_iter()
            .map(|option| ReasoningEffortOptionDto {
                reasoning_effort: option.reasoning_effort,
                description: option.description,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_capabilities_expose_supported_contract() {
        let capabilities = capabilities_for_engine("codex");
        assert!(capabilities.sandbox_modes.contains(&"workspace-write"));
        assert!(capabilities.approval_decisions.contains(&"accept"));
    }

    #[test]
    fn approval_response_route_for_codex_requires_hidden_transport_fields() {
        assert_eq!(
            approval_response_route_for_engine(
                "codex",
                &json!({
                    "_serverMethod": "item/fileChange/requestApproval"
                })
            ),
            None
        );
    }
}
