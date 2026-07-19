use serde_json::Value;

pub const REMOTE_TURN_ACTIVE_KEY: &str = "codexRemoteTurnActive";
pub const REMOTE_TURN_ACTIVE_SYNC_REASON: &str = "remote_active_turn";
pub const LEGACY_REMOTE_TURN_ACTIVE_SYNC_REASON: &str = "remote thread has an active turn";

pub fn has_confirmed_remote_turn(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(Value::as_object)
        .and_then(|object| object.get(REMOTE_TURN_ACTIVE_KEY))
        .and_then(Value::as_bool)
        == Some(true)
}

pub fn set_confirmed_remote_turn(metadata: &mut Value, active: bool) {
    if !metadata.is_object() {
        *metadata = serde_json::json!({});
    }

    if let Some(object) = metadata.as_object_mut() {
        object.insert(REMOTE_TURN_ACTIVE_KEY.to_string(), Value::Bool(active));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmed_remote_turn_requires_typed_boolean_metadata() {
        assert!(has_confirmed_remote_turn(Some(&serde_json::json!({
            "codexRemoteTurnActive": true,
        }))));
        assert!(!has_confirmed_remote_turn(Some(&serde_json::json!({
            "codexRemoteTurnActive": "true",
            "codexSyncReason": LEGACY_REMOTE_TURN_ACTIVE_SYNC_REASON,
        }))));
        assert!(!has_confirmed_remote_turn(Some(&serde_json::json!({
            "codexSyncReason": LEGACY_REMOTE_TURN_ACTIVE_SYNC_REASON,
        }))));
    }

    #[test]
    fn setting_remote_turn_state_normalizes_non_object_metadata() {
        let mut metadata = serde_json::json!("invalid");
        set_confirmed_remote_turn(&mut metadata, false);
        assert_eq!(
            metadata.get(REMOTE_TURN_ACTIVE_KEY),
            Some(&serde_json::json!(false))
        );
    }
}
