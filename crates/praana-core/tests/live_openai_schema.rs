//! Opt-in check against the REAL OpenAI API (#645). Not run by CI.
//!
//! The compactor sends its candidate schema in strict structured-output mode.
//! OpenAI validates that schema before it generates a token, so a rejected
//! schema comes back as a 400 and the test fails. Run it once with your key:
//!
//! ```text
//! OPENAI_API_KEY=sk-... cargo test -p praana-core --test live_openai_schema \
//!     -- --ignored --nocapture
//! ```
//!
//! Optional: `PRAANA_LIVE_MODEL` (default `gpt-5.6-sol`) and `OPENAI_BASE_URL`
//! (default `https://api.openai.com/v1`). Each request asks for 16 output
//! tokens, so the cost is negligible. The key is read from the environment
//! only and is never printed.

use praana_core::compaction::schema::{candidate_json_schema, candidate_wire_schema};
use serde_json::{json, Value};

async fn post_schema(schema: &Value) -> (u16, Value) {
    let key = std::env::var("OPENAI_API_KEY").expect("set OPENAI_API_KEY to run this test");
    let base =
        std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into());
    let model = std::env::var("PRAANA_LIVE_MODEL").unwrap_or_else(|_| "gpt-5.6-sol".into());
    let body = json!({
        "model": model,
        "input": "Reply with the JSON object only.",
        "max_output_tokens": 16,
        "store": false,
        "text": {"format": {
            "type": "json_schema",
            "name": "praana_compaction_candidate_v1",
            "strict": true,
            "schema": schema,
        }},
    });
    let response = reqwest::Client::new()
        .post(format!("{}/responses", base.trim_end_matches('/')))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .expect("request reaches the API");
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (status, parsed)
}

fn schema_rejected(status: u16, body: &Value) -> bool {
    let error = &body["error"];
    status == 400
        && (error["code"] == "invalid_json_schema"
            || error["param"]
                .as_str()
                .is_some_and(|p| p.starts_with("text.format"))
            || error["message"]
                .as_str()
                .is_some_and(|m| m.to_ascii_lowercase().contains("schema")))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs OPENAI_API_KEY and network access"]
async fn openai_accepts_the_strict_compaction_schema() {
    // Diagnostic only: the full schema as checked in (carries `format: uint32`).
    let (full_status, full_body) = post_schema(candidate_json_schema()).await;
    println!(
        "FULL schema -> HTTP {full_status}, schema rejected: {}\n{full_body}",
        schema_rejected(full_status, &full_body)
    );

    // The assertion: the schema the compactor really sends.
    let (status, body) = post_schema(candidate_wire_schema()).await;
    println!(
        "WIRE schema -> HTTP {status}, schema rejected: {}\n{body}",
        schema_rejected(status, &body)
    );
    assert!(
        !schema_rejected(status, &body),
        "OpenAI rejected the strict compaction schema: HTTP {status}: {body}"
    );
    assert!(
        status == 200 || status == 400 || status == 429,
        "unexpected status {status}: {body}"
    );
}
