use std::{
    collections::HashMap, ffi::OsString, path::Path, process::Stdio, sync::Arc, time::Duration,
};

use anyhow::Context;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot, Mutex},
};

use crate::{process_utils, runtime_env};

use super::codex_protocol::{
    notification_payload, parse_incoming, raw_value_to_value, request_payload,
    response_error_payload, response_success_payload, IncomingMessage, RpcResponse,
};
use super::trim_action_output_delta_content;

const TURN_EVENT_QUEUE_CAPACITY: usize = 1024;
const RUNTIME_EVENT_QUEUE_CAPACITY: usize = 512;
const BEST_EFFORT_QUEUE_RESERVE: usize = 64;
const TRANSPORT_ERROR_LINE_MAX_CHARS: usize = 16 * 1024;
const TRANSPORT_ERROR_LINE_TRUNCATED_PREFIX: &str = "... [protocol line truncated; showing tail]\n";

pub struct CodexTransport {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>>,
    incoming_router: Arc<CodexIncomingRouter>,
    next_request_id: std::sync::atomic::AtomicU64,
}

#[derive(Clone)]
struct CodexEventScope {
    inner: Arc<Mutex<CodexEventScopeState>>,
}

#[derive(Debug, Clone)]
struct CodexEventScopeState {
    thread_id: String,
    turn_id: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexMessageRoutingInfo {
    kind: &'static str,
    method: Option<String>,
    signature: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    params_keys: Option<Vec<String>>,
    content_chars: Option<usize>,
    is_plan_event: bool,
    is_transport_control: bool,
}

pub struct CodexIncomingSubscription {
    receiver: mpsc::Receiver<IncomingMessage>,
    scope: CodexEventScope,
}

#[derive(Default)]
struct CodexIncomingRouter {
    state: Mutex<CodexIncomingRouterState>,
}

#[derive(Default)]
struct CodexIncomingRouterState {
    turn_subscribers: Vec<CodexTurnSubscriber>,
    runtime_subscribers: Vec<mpsc::Sender<IncomingMessage>>,
}

#[derive(Clone)]
struct CodexTurnSubscriber {
    scope: CodexEventScope,
    sender: mpsc::Sender<IncomingMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CodexScopeMatch {
    Matched,
    ThreadMismatch { expected: String, found: String },
    TurnMismatch { expected: String, found: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexDeliveryClass {
    Lossless,
    BestEffort,
}

impl Drop for CodexTransport {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

impl CodexTransport {
    pub async fn spawn(codex_executable: &str) -> anyhow::Result<Self> {
        let mut command = Command::new(codex_executable);
        process_utils::configure_tokio_command(&mut command);
        runtime_env::apply_missing_login_shell_env(&mut command).await;
        if let Some(augmented_path) = codex_augmented_path(codex_executable) {
            command.env("PATH", augmented_path);
        }

        let mut child = command
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| {
                format!("failed to spawn `codex app-server` using `{codex_executable}`")
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("codex app-server stdin not available"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("codex app-server stdout not available"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("codex app-server stderr not available"))?;

        let incoming_router = Arc::new(CodexIncomingRouter::default());
        let pending = Arc::new(Mutex::new(
            HashMap::<String, oneshot::Sender<RpcResponse>>::new(),
        ));

        {
            let pending = pending.clone();
            let incoming_router = incoming_router.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();

                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => match parse_incoming(&line) {
                            Ok(IncomingMessage::Response(response)) => {
                                let sender = pending.lock().await.remove(&response.id);
                                if let Some(sender) = sender {
                                    let _ = sender.send(response);
                                }
                            }
                            Ok(other) => {
                                incoming_router
                                    .dispatch(trim_buffered_incoming_message(other))
                                    .await;
                            }
                            Err(error) => {
                                log::warn!("codex stdout parse error: {error}");
                                incoming_router
                                    .dispatch(IncomingMessage::Notification {
                                        method: "transport/parse_error".to_string(),
                                        params: transport_parse_error_payload(
                                            &error.to_string(),
                                            &line,
                                        ),
                                    })
                                    .await;
                            }
                        },
                        Ok(None) => {
                            incoming_router
                                .dispatch(IncomingMessage::Notification {
                                    method: "transport/eof".to_string(),
                                    params: serde_json::value::RawValue::from_string(
                                        "{}".to_string(),
                                    )
                                    .expect("\"{}\" is valid json"),
                                })
                                .await;
                            break;
                        }
                        Err(error) => {
                            log::warn!("codex stdout read error: {error}");
                            incoming_router
                                .dispatch(IncomingMessage::Notification {
                                    method: "transport/read_error".to_string(),
                                    params: serde_json::value::to_raw_value(&serde_json::json!({
                                      "error": error.to_string(),
                                    }))
                                    .expect("internal error payload is valid json"),
                                })
                                .await;
                            break;
                        }
                    }
                }
            });
        }

        {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if !line.trim().is_empty() {
                                log::debug!("codex stderr: {line}");
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            log::debug!("codex stderr read error: {error}");
                            break;
                        }
                    }
                }
            });
        }

        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            incoming_router,
            next_request_id: std::sync::atomic::AtomicU64::new(1),
        })
    }

    pub async fn subscribe_thread(&self, thread_id: &str) -> CodexIncomingSubscription {
        self.incoming_router.subscribe_thread(thread_id).await
    }

    pub async fn subscribe_runtime(&self) -> mpsc::Receiver<IncomingMessage> {
        self.incoming_router.subscribe_runtime().await
    }

    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> anyhow::Result<serde_json::Value> {
        self.ensure_alive().await?;

        let id = self
            .next_request_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .to_string();

        let payload = request_payload(&id, method, params);
        let (sender, receiver) = oneshot::channel::<RpcResponse>();
        self.pending.lock().await.insert(id.clone(), sender);

        if let Err(error) = self.write_payload(&payload).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        let response = match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                anyhow::bail!("codex response channel closed for method `{method}`")
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                anyhow::bail!("codex request timeout for method `{method}`")
            }
        };

        if let Some(error) = response.error {
            anyhow::bail!("{}", error);
        }

        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }

    pub async fn notify(&self, method: &str, params: serde_json::Value) -> anyhow::Result<()> {
        self.ensure_alive().await?;
        self.write_payload(&notification_payload(method, params))
            .await
    }

    pub async fn respond_success(
        &self,
        request_id: &serde_json::Value,
        result: serde_json::Value,
    ) -> anyhow::Result<()> {
        self.ensure_alive().await?;
        self.write_payload(&response_success_payload(request_id, result))
            .await
    }

    pub async fn respond_error(
        &self,
        request_id: &serde_json::Value,
        code: i64,
        message: &str,
        data: Option<serde_json::Value>,
    ) -> anyhow::Result<()> {
        self.ensure_alive().await?;
        self.write_payload(&response_error_payload(request_id, code, message, data))
            .await
    }

    pub async fn is_alive(&self) -> bool {
        self.ensure_alive().await.is_ok()
    }

    pub async fn shutdown(&self) -> anyhow::Result<()> {
        let mut child = self.child.lock().await;
        if child.try_wait()?.is_none() {
            child.kill().await.ok();
            child.wait().await.ok();
        }
        Ok(())
    }

    async fn write_payload(&self, payload: &serde_json::Value) -> anyhow::Result<()> {
        let serialized = serde_json::to_vec(payload)?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&serialized)
            .await
            .context("failed writing payload to codex stdin")?;
        stdin
            .write_all(b"\n")
            .await
            .context("failed writing line terminator to codex stdin")?;
        stdin.flush().await.context("failed flushing codex stdin")?;
        Ok(())
    }

    async fn ensure_alive(&self) -> anyhow::Result<()> {
        let mut child = self.child.lock().await;
        if let Some(status) = child
            .try_wait()
            .context("failed to query codex process status")?
        {
            anyhow::bail!("codex app-server exited with status {status}");
        }
        Ok(())
    }
}

impl CodexIncomingSubscription {
    pub async fn recv(&mut self) -> Option<IncomingMessage> {
        self.receiver.recv().await
    }

    #[cfg(test)]
    fn try_recv(&mut self) -> Option<IncomingMessage> {
        self.receiver.try_recv().ok()
    }

    pub async fn set_thread_id(&self, thread_id: &str) {
        self.scope.set_thread_id(thread_id).await;
    }

    pub async fn set_turn_id(&self, turn_id: Option<String>) {
        self.scope.set_turn_id(turn_id).await;
    }
}

impl CodexEventScope {
    fn new(thread_id: &str) -> Self {
        Self {
            inner: Arc::new(Mutex::new(CodexEventScopeState {
                thread_id: thread_id.to_string(),
                turn_id: None,
            })),
        }
    }

    async fn set_thread_id(&self, thread_id: &str) {
        let mut state = self.inner.lock().await;
        state.thread_id = thread_id.to_string();
        state.turn_id = None;
    }

    async fn set_turn_id(&self, turn_id: Option<String>) {
        self.inner.lock().await.turn_id = turn_id;
    }

    async fn matches_info(&self, info: &CodexMessageRoutingInfo) -> CodexScopeMatch {
        if info.is_transport_control {
            return CodexScopeMatch::Matched;
        }

        let state = self.inner.lock().await.clone();

        if let Some(thread_id) = info.thread_id.as_deref() {
            if thread_id != state.thread_id {
                return CodexScopeMatch::ThreadMismatch {
                    expected: state.thread_id,
                    found: thread_id.to_string(),
                };
            }
        }

        if let Some(turn_id) = info.turn_id.as_deref() {
            if let Some(expected_turn_id) = state.turn_id.as_deref() {
                if turn_id != expected_turn_id {
                    return CodexScopeMatch::TurnMismatch {
                        expected: expected_turn_id.to_string(),
                        found: turn_id.to_string(),
                    };
                }
            }
        }

        CodexScopeMatch::Matched
    }
}

impl CodexIncomingRouter {
    async fn subscribe_thread(&self, thread_id: &str) -> CodexIncomingSubscription {
        let (sender, receiver) = mpsc::channel(TURN_EVENT_QUEUE_CAPACITY);
        let scope = CodexEventScope::new(thread_id);
        let subscriber = CodexTurnSubscriber {
            scope: scope.clone(),
            sender,
        };
        self.state.lock().await.turn_subscribers.push(subscriber);

        CodexIncomingSubscription { receiver, scope }
    }

    async fn subscribe_runtime(&self) -> mpsc::Receiver<IncomingMessage> {
        let (sender, receiver) = mpsc::channel(RUNTIME_EVENT_QUEUE_CAPACITY);
        self.state.lock().await.runtime_subscribers.push(sender);
        receiver
    }

    async fn dispatch(&self, message: IncomingMessage) {
        let delivery_class = delivery_class_for_message(&message);
        let routing_info = routing_info_for_message(&message);
        let (turn_subscribers, runtime_subscribers) = {
            let mut state = self.state.lock().await;
            state
                .turn_subscribers
                .retain(|subscriber| !subscriber.sender.is_closed());
            state
                .runtime_subscribers
                .retain(|subscriber| !subscriber.is_closed());
            (
                state.turn_subscribers.clone(),
                state.runtime_subscribers.clone(),
            )
        };

        let turn_subscriber_count = turn_subscribers.len();
        let runtime_subscriber_count = runtime_subscribers.len();
        let mut delivered_turn_subscribers = 0usize;
        let mut skipped_scope_reasons = Vec::new();

        for subscriber in turn_subscribers {
            match subscriber.scope.matches_info(&routing_info).await {
                CodexScopeMatch::Matched => {
                    if deliver_message(
                        &subscriber.sender,
                        message.clone(),
                        delivery_class,
                        "turn",
                        &routing_info,
                    )
                    .await
                    {
                        delivered_turn_subscribers += 1;
                    }
                }
                CodexScopeMatch::ThreadMismatch { expected, found } => {
                    let reason = format!("thread_mismatch(expected={expected}, found={found})");
                    skipped_scope_reasons.push(reason);
                }
                CodexScopeMatch::TurnMismatch { expected, found } => {
                    let reason = format!("turn_mismatch(expected={expected}, found={found})");
                    skipped_scope_reasons.push(reason);
                }
            }
        }

        if routing_info.should_log_successful_plan_routing() {
            let message = format!(
                "codex plan event routing: {}; delivery_class={delivery_class:?}; turn_subscribers={turn_subscriber_count}; delivered_turn_subscribers={delivered_turn_subscribers}; runtime_subscribers={runtime_subscriber_count}; skipped_scope_reasons={:?}",
                routing_info.log_summary(),
                skipped_scope_reasons
            );
            log::info!("{message}");
            record_codex_event_routing_log(&message);
        } else if turn_subscriber_count > 0
            && delivered_turn_subscribers == 0
            && !skipped_scope_reasons.is_empty()
        {
            let message = format!(
                "codex event was not delivered to any matching turn subscriber: {}; delivery_class={delivery_class:?}; turn_subscribers={turn_subscriber_count}; runtime_subscribers={runtime_subscriber_count}; skipped_scope_reasons={:?}",
                routing_info.log_summary(),
                skipped_scope_reasons
            );
            log::debug!("{message}");
            record_codex_event_routing_log(&message);
        }

        for sender in runtime_subscribers {
            let _ = deliver_message(
                &sender,
                message.clone(),
                CodexDeliveryClass::BestEffort,
                "runtime",
                &routing_info,
            )
            .await;
        }
    }
}

impl CodexMessageRoutingInfo {
    fn log_summary(&self) -> String {
        format!(
            "kind={}; method={}; signature={}; thread_id={}; turn_id={}; params_keys={:?}; content_chars={}; plan_event={}",
            self.kind,
            self.method.as_deref().unwrap_or("<none>"),
            self.signature.as_deref().unwrap_or("<none>"),
            self.thread_id.as_deref().unwrap_or("<missing>"),
            self.turn_id.as_deref().unwrap_or("<missing>"),
            self.params_keys,
            self.content_chars
                .map(|value| value.to_string())
                .unwrap_or_else(|| "<unknown>".to_string()),
            self.is_plan_event
        )
    }

    fn should_log_successful_plan_routing(&self) -> bool {
        self.signature.as_deref() == Some("turnplanupdated")
    }
}

fn record_codex_event_routing_log(message: &str) {
    crate::diagnostic_logs::append_codex_event_routing_log(message);
}

async fn deliver_message(
    sender: &mpsc::Sender<IncomingMessage>,
    message: IncomingMessage,
    delivery_class: CodexDeliveryClass,
    subscriber_kind: &str,
    routing_info: &CodexMessageRoutingInfo,
) -> bool {
    match delivery_class {
        CodexDeliveryClass::Lossless => {
            if sender.send(message).await.is_err() {
                let message = format!(
                    "codex {subscriber_kind} event receiver closed during delivery; dropped event: {}",
                    routing_info.log_summary()
                );
                log::warn!("{message}");
                record_codex_event_routing_log(&message);
                return false;
            }
            true
        }
        CodexDeliveryClass::BestEffort => {
            if sender.capacity() <= BEST_EFFORT_QUEUE_RESERVE {
                let message = format!(
                    "codex {subscriber_kind} event receiver full; dropping best-effort event: {}",
                    routing_info.log_summary()
                );
                log::warn!("{message}");
                record_codex_event_routing_log(&message);
                return false;
            }

            match sender.try_send(message) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    let message = format!(
                        "codex {subscriber_kind} event receiver closed during best-effort delivery; dropped event: {}",
                        routing_info.log_summary()
                    );
                    log::warn!("{message}");
                    record_codex_event_routing_log(&message);
                    false
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    let message = format!(
                        "codex {subscriber_kind} event receiver full; dropping best-effort event: {}",
                        routing_info.log_summary()
                    );
                    log::warn!("{message}");
                    record_codex_event_routing_log(&message);
                    false
                }
            }
        }
    }
}

fn routing_info_for_message(message: &IncomingMessage) -> CodexMessageRoutingInfo {
    let (kind, method) = match message {
        IncomingMessage::Notification { method, .. } => ("notification", Some(method.clone())),
        IncomingMessage::Request { method, .. } => ("request", Some(method.clone())),
        IncomingMessage::Response(_) => ("response", None),
    };
    let signature = method.as_deref().map(method_signature);
    let is_plan_event = signature.as_deref().is_some_and(is_plan_event_signature);
    let is_transport_control = signature
        .as_deref()
        .is_some_and(is_transport_control_signature);
    let params = message_params(message);
    let thread_id = params.as_ref().and_then(extract_thread_id_from_value);
    let turn_id = params.as_ref().and_then(extract_turn_id_from_value);
    let params_keys = params.as_ref().and_then(object_keys);
    let content_chars = params.as_ref().and_then(plan_event_content_chars);

    CodexMessageRoutingInfo {
        kind,
        method,
        signature,
        thread_id,
        turn_id,
        params_keys,
        content_chars,
        is_plan_event,
        is_transport_control,
    }
}

fn object_keys(value: &serde_json::Value) -> Option<Vec<String>> {
    let mut keys = value
        .as_object()?
        .keys()
        .map(|key| key.to_string())
        .collect::<Vec<_>>();
    keys.sort();
    Some(keys)
}

fn plan_event_content_chars(value: &serde_json::Value) -> Option<usize> {
    let mut total = 0usize;
    let mut found = false;

    for key in ["delta", "text", "content", "explanation"] {
        if let Some(content) = value.get(key).and_then(serde_json::Value::as_str) {
            total = total.saturating_add(content.chars().count());
            found = true;
        }
    }

    if let Some(plan) = value.get("plan").and_then(serde_json::Value::as_array) {
        found = true;
        for entry in plan {
            for key in ["step", "title", "description"] {
                if let Some(content) = entry.get(key).and_then(serde_json::Value::as_str) {
                    total = total.saturating_add(content.chars().count());
                }
            }
        }
    }

    found.then_some(total)
}

fn trim_buffered_incoming_message(message: IncomingMessage) -> IncomingMessage {
    match message {
        IncomingMessage::Notification { method, params } => IncomingMessage::Notification {
            params: trim_large_output_params(&method, params),
            method,
        },
        IncomingMessage::Request {
            id,
            raw_id,
            method,
            params,
        } => IncomingMessage::Request {
            id,
            raw_id,
            params: trim_large_output_params(&method, params),
            method,
        },
        IncomingMessage::Response(response) => IncomingMessage::Response(response),
    }
}

fn transport_parse_error_payload(error: &str, line: &str) -> Box<serde_json::value::RawValue> {
    serde_json::value::to_raw_value(&serde_json::json!({
        "error": error,
        "line": trim_transport_error_line(line),
    }))
    .expect("internal error payload is valid json")
}

fn trim_transport_error_line(line: &str) -> String {
    if line.chars().count() <= TRANSPORT_ERROR_LINE_MAX_CHARS {
        return line.to_string();
    }

    let tail_chars = TRANSPORT_ERROR_LINE_MAX_CHARS
        .saturating_sub(TRANSPORT_ERROR_LINE_TRUNCATED_PREFIX.len())
        .max(1);
    let mut tail = line.chars().rev().take(tail_chars).collect::<Vec<_>>();
    tail.reverse();

    format!(
        "{}{}",
        TRANSPORT_ERROR_LINE_TRUNCATED_PREFIX,
        tail.into_iter().collect::<String>()
    )
}

fn trim_large_output_params(
    method: &str,
    params: Box<serde_json::value::RawValue>,
) -> Box<serde_json::value::RawValue> {
    if !is_large_output_event(method) {
        return params;
    }

    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(params.get()) else {
        return params;
    };

    if method_signature(method).contains("terminalinteraction") {
        trim_string_field(&mut value, "stdin");
    } else {
        for key in ["delta", "output", "text", "content"] {
            trim_string_field(&mut value, key);
        }
    }

    serde_json::value::to_raw_value(&value).unwrap_or(params)
}

fn trim_string_field(value: &mut serde_json::Value, key: &str) {
    let Some(field) = value.get_mut(key) else {
        return;
    };
    let Some(content) = field.as_str() else {
        return;
    };

    *field = serde_json::Value::String(trim_action_output_delta_content(content));
}

fn is_large_output_event(method: &str) -> bool {
    matches!(
        method_signature(method).as_str(),
        "itemcommandexecutionoutputdelta"
            | "itemfilechangeoutputdelta"
            | "itemcommandexecutionterminalinteraction"
            | "terminalinteraction"
    )
}

fn delivery_class_for_message(message: &IncomingMessage) -> CodexDeliveryClass {
    match message {
        IncomingMessage::Request { .. } => CodexDeliveryClass::Lossless,
        IncomingMessage::Response(_) => CodexDeliveryClass::Lossless,
        IncomingMessage::Notification { method, .. } => {
            let signature = method_signature(method);
            if matches!(
                signature.as_str(),
                "transporteof"
                    | "transportreaderror"
                    | "transportparseerror"
                    | "turnstarted"
                    | "turncompleted"
                    | "turnplanupdated"
                    | "itemcompleted"
                    | "itemagentmessagedelta"
                    | "itemplandelta"
                    | "itemreasoningsummarytextdelta"
                    | "itemreasoningtextdelta"
                    | "threadrealtimetranscriptdelta"
                    | "threadrealtimetranscriptdone"
            ) {
                CodexDeliveryClass::Lossless
            } else {
                CodexDeliveryClass::BestEffort
            }
        }
    }
}

fn is_transport_control_signature(signature: &str) -> bool {
    matches!(
        signature,
        "transporteof" | "transportreaderror" | "transportparseerror"
    )
}

fn is_plan_event_signature(signature: &str) -> bool {
    matches!(signature, "turnplanupdated" | "itemplandelta")
}

fn message_params(message: &IncomingMessage) -> Option<serde_json::Value> {
    match message {
        IncomingMessage::Notification { params, .. } | IncomingMessage::Request { params, .. } => {
            Some(raw_value_to_value(params))
        }
        IncomingMessage::Response(_) => None,
    }
}

fn extract_thread_id_from_value(value: &serde_json::Value) -> Option<String> {
    let candidates = [
        "threadId",
        "thread_id",
        "engineThreadId",
        "engine_thread_id",
        "conversationId",
        "conversation_id",
        "sessionId",
        "session_id",
    ];

    if let Some(found) = extract_any_string(value, &candidates) {
        return Some(found);
    }

    for key in [
        "thread", "turn", "session", "context", "meta", "metadata", "item",
    ] {
        if let Some(nested) = value.get(key) {
            if let Some(found) = extract_any_string(nested, &candidates) {
                return Some(found);
            }
        }
    }

    None
}

fn extract_turn_id_from_value(value: &serde_json::Value) -> Option<String> {
    let candidates = ["turnId", "turn_id"];

    if let Some(found) = extract_any_string(value, &candidates) {
        return Some(found);
    }

    for key in ["turn", "item", "session", "context", "meta", "metadata"] {
        if let Some(nested) = value.get(key) {
            if let Some(found) = extract_any_string(nested, &candidates) {
                return Some(found);
            }
        }
    }

    None
}

fn extract_any_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(found) = value.get(*key).and_then(serde_json::Value::as_str) {
            return Some(found.to_string());
        }
    }

    None
}

fn method_signature(method: &str) -> String {
    method
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn codex_augmented_path(executable: &str) -> Option<OsString> {
    runtime_env::augmented_path_with_prepend([Path::new(executable).parent()?.to_path_buf()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn event_queue_capacities_bound_idle_retention() {
        assert!(
            TURN_EVENT_QUEUE_CAPACITY <= 1024,
            "Codex turn event queues are live buffers; raising this can retain large protocol payloads"
        );
        assert!(
            RUNTIME_EVENT_QUEUE_CAPACITY <= 512,
            "Codex runtime event queues should stay best-effort and bounded"
        );
        assert!(
            BEST_EFFORT_QUEUE_RESERVE < TURN_EVENT_QUEUE_CAPACITY,
            "best-effort reserve must leave room for lossless turn events"
        );
    }

    #[test]
    fn transport_parse_error_payload_trims_large_protocol_lines() {
        let line = "x".repeat(TRANSPORT_ERROR_LINE_MAX_CHARS + 2048);

        let payload = transport_parse_error_payload("bad json", &line);
        let parsed: Value = serde_json::from_str(payload.get()).expect("valid json payload");
        let trimmed_line = parsed
            .get("line")
            .and_then(Value::as_str)
            .expect("line should be present");

        assert!(trimmed_line.starts_with(TRANSPORT_ERROR_LINE_TRUNCATED_PREFIX));
        assert!(trimmed_line.chars().count() <= TRANSPORT_ERROR_LINE_MAX_CHARS);
        assert!(trimmed_line.ends_with(&"x".repeat(64)));
        assert_eq!(
            parsed.get("error").and_then(Value::as_str),
            Some("bad json")
        );
    }

    #[tokio::test]
    async fn router_sends_thread_events_only_to_matching_subscribers() {
        let router = CodexIncomingRouter::default();
        let mut thread_a = router.subscribe_thread("thread-a").await;
        let mut thread_b = router.subscribe_thread("thread-b").await;

        router
            .dispatch(IncomingMessage::Notification {
                method: "item/agent_message/delta".to_string(),
                params: serde_json::value::to_raw_value(&json!({
                    "threadId": "thread-a",
                    "turnId": "turn-a",
                    "delta": "hello",
                }))
                .expect("valid params"),
            })
            .await;

        assert!(thread_a.recv().await.is_some());
        assert!(thread_b.try_recv().is_none());
    }

    #[tokio::test]
    async fn router_filters_by_turn_after_scope_is_bound() {
        let router = CodexIncomingRouter::default();
        let mut subscription = router.subscribe_thread("thread-a").await;
        subscription.set_turn_id(Some("turn-a".to_string())).await;

        router
            .dispatch(IncomingMessage::Notification {
                method: "item/agent_message/delta".to_string(),
                params: serde_json::value::to_raw_value(&json!({
                    "threadId": "thread-a",
                    "turnId": "turn-b",
                    "delta": "wrong",
                }))
                .expect("valid params"),
            })
            .await;

        assert!(subscription.try_recv().is_none());

        router
            .dispatch(IncomingMessage::Notification {
                method: "turn/completed".to_string(),
                params: serde_json::value::to_raw_value(&json!({
                    "threadId": "thread-a",
                    "turnId": "turn-a",
                    "status": "completed",
                }))
                .expect("valid params"),
            })
            .await;

        assert!(subscription.recv().await.is_some());
    }

    #[tokio::test]
    async fn router_keeps_lossless_turn_completed_when_best_effort_queue_is_full() {
        let router = CodexIncomingRouter::default();
        let mut subscription = router.subscribe_thread("thread-a").await;

        for index in 0..(TURN_EVENT_QUEUE_CAPACITY + 16) {
            router
                .dispatch(IncomingMessage::Notification {
                    method: "item/command_execution/output_delta".to_string(),
                    params: serde_json::value::to_raw_value(&json!({
                        "threadId": "thread-a",
                        "turnId": "turn-a",
                        "delta": format!("line-{index}"),
                    }))
                    .expect("valid params"),
                })
                .await;
        }

        router
            .dispatch(IncomingMessage::Notification {
                method: "turn/completed".to_string(),
                params: serde_json::value::to_raw_value(&json!({
                    "threadId": "thread-a",
                    "turnId": "turn-a",
                    "status": "completed",
                }))
                .expect("valid params"),
            })
            .await;

        let mut saw_completed = false;
        for _ in 0..TURN_EVENT_QUEUE_CAPACITY {
            let message = tokio::time::timeout(Duration::from_secs(1), subscription.recv())
                .await
                .expect("router should deliver queued messages")
                .expect("subscription should stay open");
            if let IncomingMessage::Notification { method, .. } = message {
                if method == "turn/completed" {
                    saw_completed = true;
                    break;
                }
            }
        }

        assert!(saw_completed);
    }

    #[tokio::test]
    async fn router_keeps_lossless_turn_plan_updated_when_best_effort_queue_is_full() {
        let router = CodexIncomingRouter::default();
        let mut subscription = router.subscribe_thread("thread-a").await;

        for index in 0..(TURN_EVENT_QUEUE_CAPACITY + 16) {
            router
                .dispatch(IncomingMessage::Notification {
                    method: "item/command_execution/output_delta".to_string(),
                    params: serde_json::value::to_raw_value(&json!({
                        "threadId": "thread-a",
                        "turnId": "turn-a",
                        "delta": format!("line-{index}"),
                    }))
                    .expect("valid params"),
                })
                .await;
        }

        router
            .dispatch(IncomingMessage::Notification {
                method: "turn/plan/updated".to_string(),
                params: serde_json::value::to_raw_value(&json!({
                    "threadId": "thread-a",
                    "turnId": "turn-a",
                    "plan": [
                        { "step": "Verify event routing", "status": "in_progress" },
                        { "step": "Implement the plan", "status": "pending" }
                    ],
                }))
                .expect("valid params"),
            })
            .await;

        let mut saw_plan_update = false;
        for _ in 0..TURN_EVENT_QUEUE_CAPACITY {
            let message = tokio::time::timeout(Duration::from_secs(1), subscription.recv())
                .await
                .expect("router should deliver queued messages")
                .expect("subscription should stay open");
            if let IncomingMessage::Notification { method, .. } = message {
                if method == "turn/plan/updated" {
                    saw_plan_update = true;
                    break;
                }
            }
        }

        assert!(saw_plan_update);
    }
}
