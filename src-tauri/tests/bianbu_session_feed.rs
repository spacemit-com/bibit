use app_lib::runtime::bianbu_http::feed::validate_sequence;
use app_lib::runtime::{RuntimeCapabilities, SessionSubmitRequest, SessionSubmitResult};
use serde_json::json;
#[test]
fn session_contract_accepts_staged_without_run_and_preserves_zero() {
    let result: SessionSubmitResult = serde_json::from_value(
        json!({"accepted":true,"message_id":"stable","status":"staged","run_id":null}),
    )
    .unwrap();
    assert!(result.accepted);
    assert!(result.run_id.is_none());
    let request: SessionSubmitRequest = serde_json::from_value(
        json!({"targetId":"target","sessionId":"s","messageId":"stable","content":"中文","skillIds":["skill"]}),
    )
    .unwrap();
    request.validate().unwrap();
    assert!(validate_sequence(&[json!({"seq":0}), json!({"seq":1})]).is_ok());
    let defaults = RuntimeCapabilities::default();
    assert!(!defaults.session_events && !defaults.session_inbox);
}
