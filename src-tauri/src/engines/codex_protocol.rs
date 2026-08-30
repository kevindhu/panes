use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};

#[derive(Debug, Clone)]
pub enum IncomingMessage {
    Response(RpcResponse),
    Request {
        id: String,
        raw_id: Value,
        method: String,
        params: Box<RawValue>,
    },
    Notification {
        method: String,
        params: Box<RawValue>,
    },
}

fn own_raw_params(raw: Option<&RawValue>) -> anyhow::Result<Box<RawValue>> {
    RawValue::from_string(
        raw.map(|value| value.get().to_owned())
            .unwrap_or_else(|| "{}".to_owned()),
    )
    .map_err(Into::into)
}

pub fn raw_value_to_value(raw: &RawValue) -> Value {
    serde_json::from_str(raw.get()).unwrap_or(Value::Null)
}

#[derive(Debug, Clone)]
pub struct RpcResponse {
    pub id: String,
    pub result: Option<Value>,
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    #[serde(default)]
    pub code: Option<i64>,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.code {
            Some(code) => write!(f, "rpc error {code}: {}", self.message),
            None => write!(f, "rpc error: {}", self.message),
        }
    }
}

impl std::error::Error for RpcError {}

pub fn parse_incoming(line: &str) -> anyhow::Result<IncomingMessage> {
    let envelope: RawIncomingEnvelope<'_> = serde_json::from_str(line)
        .map_err(|error| anyhow::anyhow!("invalid JSON line: {error}; line={line}"))?;

    let method = envelope.method.and_then(value_into_string);

    if let Some(method) = method {
        let raw_id_value = envelope.id.map(parse_raw_value).transpose()?;
        let id = raw_id_value.as_ref().and_then(normalize_id);
        // Preserve the app-server payload exactly. Any presentation-specific truncation belongs
        // downstream of the durable transcript boundary, never in protocol ingestion.
        let params = own_raw_params(envelope.params)?;

        if let Some(id) = id {
            let raw_id = raw_id_value.unwrap_or_else(|| Value::String(id.clone()));
            return Ok(IncomingMessage::Request {
                id,
                raw_id,
                method,
                params,
            });
        }

        return Ok(IncomingMessage::Notification { method, params });
    }

    if let Some(raw_id) = envelope.id {
        let raw_id = parse_raw_value(raw_id)?;
        let Some(id) = normalize_id_owned(raw_id) else {
            return Err(anyhow::anyhow!(
                "incoming response id is not a supported scalar"
            ));
        };
        let result = envelope.result.map(parse_raw_value).transpose()?;
        let error = envelope
            .error
            .map(|raw| serde_json::from_str::<RpcError>(raw.get()))
            .transpose()?;

        return Ok(IncomingMessage::Response(RpcResponse { id, result, error }));
    }

    Err(anyhow::anyhow!(
        "incoming payload is neither request/notification nor response"
    ))
}

#[derive(Deserialize)]
struct RawIncomingEnvelope<'a> {
    #[serde(default, borrow)]
    id: Option<&'a RawValue>,
    #[serde(default)]
    method: Option<Value>,
    #[serde(default, borrow)]
    params: Option<&'a RawValue>,
    #[serde(default, borrow)]
    result: Option<&'a RawValue>,
    #[serde(default, borrow)]
    error: Option<&'a RawValue>,
}

fn parse_raw_value(raw: &RawValue) -> anyhow::Result<Value> {
    serde_json::from_str(raw.get()).map_err(Into::into)
}

pub fn request_payload(id: &str, method: &str, params: Value) -> Value {
    serde_json::json!({
      "id": id,
      "method": method,
      "params": params,
    })
}

pub fn notification_payload(method: &str, params: Value) -> Value {
    serde_json::json!({
      "method": method,
      "params": params,
    })
}

pub fn response_success_payload(id: &Value, result: Value) -> Value {
    serde_json::json!({
      "id": id,
      "result": result,
    })
}

pub fn response_error_payload(id: &Value, code: i64, message: &str, data: Option<Value>) -> Value {
    serde_json::json!({
      "id": id,
      "error": {
        "code": code,
        "message": message,
        "data": data,
      }
    })
}

fn normalize_id(raw: &Value) -> Option<String> {
    match raw {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn normalize_id_owned(raw: Value) -> Option<String> {
    match raw {
        Value::String(value) => Some(value),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_into_string(value: Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_notification_without_cloning_params() {
        let message = parse_incoming(
            r#"{"method":"thread/updated","params":{"threadId":"t1","payload":{"nested":true}}}"#,
        )
        .expect("notification should parse");

        match message {
            IncomingMessage::Notification { method, params } => {
                let params = raw_value_to_value(&params);
                assert_eq!(method, "thread/updated");
                assert_eq!(
                    params,
                    json!({
                        "threadId": "t1",
                        "payload": {
                            "nested": true,
                        },
                    })
                );
            }
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn parses_request_with_raw_numeric_id() {
        let message =
            parse_incoming(r#"{"id":42,"method":"serverRequest","params":{"kind":"approval"}}"#)
                .expect("request should parse");

        match message {
            IncomingMessage::Request {
                id,
                raw_id,
                method,
                params,
            } => {
                let params = raw_value_to_value(&params);
                assert_eq!(id, "42");
                assert_eq!(raw_id, json!(42));
                assert_eq!(method, "serverRequest");
                assert_eq!(params, json!({ "kind": "approval" }));
            }
            other => panic!("expected request, got {other:?}"),
        }
    }

    #[test]
    fn parses_response_with_result() {
        let message = parse_incoming(r#"{"id":"7","result":{"data":[{"id":"model-a"}]}}"#)
            .expect("response should parse");

        match message {
            IncomingMessage::Response(response) => {
                assert_eq!(response.id, "7");
                assert_eq!(
                    response.result,
                    Some(json!({ "data": [{ "id": "model-a" }] }))
                );
                assert!(response.error.is_none());
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn parses_response_with_error_without_result() {
        let message = parse_incoming(
            r#"{"id":"8","error":{"code":-32603,"message":"boom","data":{"retry":false}}}"#,
        )
        .expect("error response should parse");

        match message {
            IncomingMessage::Response(response) => {
                assert_eq!(response.id, "8");
                assert!(response.result.is_none());
                let error = response.error.expect("error should be present");
                assert_eq!(error.code, Some(-32603));
                assert_eq!(error.message, "boom");
                assert_eq!(error.data, Some(json!({ "retry": false })));
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn defaults_missing_params_to_empty_object() {
        let message =
            parse_incoming(r#"{"method":"runtime/ready"}"#).expect("notification should parse");

        match message {
            IncomingMessage::Notification { params, .. } => {
                let params = raw_value_to_value(&params);
                assert_eq!(params, json!({}));
            }
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn preserves_large_output_delta_while_parsing_params() {
        let output = format!("prefix:{}:tail", "x".repeat(2 * 1024 * 1024));
        let line = json!({
            "method": "item/command_execution/output_delta",
            "params": {
                "itemId": "cmd-1",
                "delta": output,
                "stream": "stdout",
                "metadata": { "preserved": true }
            }
        })
        .to_string();

        let message = parse_incoming(&line).expect("large output notification should parse");
        let IncomingMessage::Notification { params, .. } = message else {
            panic!("expected notification");
        };
        let params = raw_value_to_value(&params);

        let delta = params
            .get("delta")
            .and_then(Value::as_str)
            .expect("delta should be a string");
        assert_eq!(delta, output);
        assert_eq!(params["metadata"], json!({ "preserved": true }));
    }

    #[test]
    fn decodes_escaped_output_delta_while_parsing_params() {
        let message = parse_incoming(
            r#"{"method":"item/command_execution/output_delta","params":{"itemId":"cmd-1","delta":"line\u003a one\nline two","stream":"stderr"}}"#,
        )
        .expect("escaped output notification should parse");

        let IncomingMessage::Notification { params, .. } = message else {
            panic!("expected notification");
        };
        let params = raw_value_to_value(&params);

        assert_eq!(params["delta"], json!("line: one\nline two"));
    }

    #[test]
    fn preserves_completed_item_large_output_fields_while_parsing_params() {
        let expected_output = format!("head:{}:tail", "x".repeat(1024 * 1024));
        let expected_diff = format!("diff --git a/a b/a\n{}", "y".repeat(1024 * 1024));
        let expected_stderr = format!("err:{}", "z".repeat(1024 * 1024));
        let line = json!({
            "method": "item/completed",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "cmd-1",
                    "type": "commandExecution",
                    "status": "completed",
                    "aggregatedOutput": expected_output,
                    "changes": [{ "path": "src/main.rs", "diff": expected_diff }],
                    "error": { "stderr": expected_stderr }
                }
            }
        })
        .to_string();

        let message = parse_incoming(&line).expect("completed item notification should parse");
        let IncomingMessage::Notification { params, .. } = message else {
            panic!("expected notification");
        };
        let params = raw_value_to_value(&params);

        let item = params.get("item").expect("item should be present");
        let output = item
            .get("aggregatedOutput")
            .and_then(Value::as_str)
            .expect("output should be a string");
        let diff = item
            .get("changes")
            .and_then(Value::as_array)
            .and_then(|changes| changes.first())
            .and_then(|change| change.get("diff"))
            .and_then(Value::as_str)
            .expect("diff should be a string");
        let stderr = item
            .get("error")
            .and_then(|error| error.get("stderr"))
            .and_then(Value::as_str)
            .expect("stderr should be a string");

        assert_eq!(output, expected_output);
        assert_eq!(diff, expected_diff);
        assert_eq!(stderr, expected_stderr);
        assert_eq!(params["threadId"], json!("thread-1"));
        assert_eq!(item["id"], json!("cmd-1"));
    }

    #[test]
    fn preserves_turn_diff_while_parsing_params() {
        let expected_diff = format!("diff --git a/a b/a\n{}", "x".repeat(1024 * 1024));
        let line = json!({
            "method": "turn/diff/updated",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "diff": expected_diff
            }
        })
        .to_string();

        let message = parse_incoming(&line).expect("turn diff notification should parse");
        let IncomingMessage::Notification { params, .. } = message else {
            panic!("expected notification");
        };
        let params = raw_value_to_value(&params);
        let diff = params
            .get("diff")
            .and_then(Value::as_str)
            .expect("diff should be a string");

        assert_eq!(diff, expected_diff);
        assert_eq!(params["threadId"], json!("thread-1"));
    }

    #[test]
    fn preserves_raw_params_bytes_including_escapes_and_spacing() {
        let line = r#"{"method":"item/agentMessage/delta","params": { "threadId" : "t1", "delta":"line\u003a one\nline two" }}"#;
        let message = parse_incoming(line).expect("notification should parse");
        let IncomingMessage::Notification { params, .. } = message else {
            panic!("expected notification");
        };

        assert_eq!(
            params.get(),
            r#"{ "threadId" : "t1", "delta":"line\u003a one\nline two" }"#
        );
    }
}
