//! P6-1 memory plugin contract tests (Memory spec §2, §6–§9.1, §15.2).
//!
//! Contract-only slice: DTO encoding, JSON Schema snapshots, golden fixtures,
//! strict decoding, bounds validation, and trait shape. No plugin behavior.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use praana_core::canonical_json::to_canonical_json_bytes;
use praana_core::memory::*;
use praana_core::protocol::id::{Sha256Digest, ToolCallId};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const MEMORY_FIXTURES_DIR: &str = "tests/fixtures/memory/v1";
const MEMORY_SCHEMAS_DIR: &str = "schemas/memory/v1";

fn schema_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(MEMORY_SCHEMAS_DIR)
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(MEMORY_FIXTURES_DIR)
}

fn write_when_requested(path: &Path, bytes: &[u8]) {
    if std::env::var_os("PRAANA_WRITE_MEMORY_FIXTURES").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
}

// ================================================================ §7.8 enum table

#[derive(Debug)]
struct EnumRow {
    name: &'static str,
    variants: &'static [&'static str],
}

const ENUM_TABLE: &[EnumRow] = &[
    EnumRow { name: "MemoryDigestFormat", variants: &["markdown", "plain_text"] },
    EnumRow { name: "MemoryNoticeSeverity", variants: &["info", "warning"] },
    EnumRow { name: "RecallScope", variants: &["auto", "project", "global"] },
    EnumRow { name: "RecallMode", variants: &["standard", "causal_chain"] },
    EnumRow { name: "MemoryKind", variants: &["fact", "preference", "decision", "pattern", "mistake", "constraint"] },
    EnumRow { name: "MemoryScope", variants: &["project", "global"] },
    EnumRow { name: "MemoryScopeRequest", variants: &["auto", "project", "global"] },
    EnumRow { name: "MemoryCertainty", variants: &["high", "medium", "low"] },
    EnumRow { name: "MemoryWriteSource", variants: &["explicit_tool", "session_extraction", "consolidation"] },
    EnumRow { name: "RememberDisposition", variants: &["created", "reinforced", "replaced"] },
    EnumRow { name: "MemoryOutcomeSignal", variants: &["success", "failure", "interrupted", "unknown"] },
    EnumRow { name: "MemorySessionEndReason", variants: &["clean", "aborted", "error", "replaced_by_new_session"] },
    EnumRow { name: "MemoryPluginErrorCode", variants: &["invalid_options", "unsupported", "not_found", "invalid_input", "storage_busy", "storage_corrupt", "host_unavailable", "completion_failed", "cancelled", "timed_out", "internal"] },
    EnumRow { name: "MemoryHostErrorCode", variants: &["invalid_request", "unavailable", "completion_failed", "cancelled", "timed_out", "internal"] },
    EnumRow { name: "MemoryHostIdKind", variants: &["memory_entry", "plugin_operation"] },
    EnumRow { name: "MemoryPluginLogLevel", variants: &["debug", "info", "warn", "error"] },
    EnumRow { name: "MemoryCompletionPurpose", variants: &["extract_learnings", "detect_contradiction", "consolidate"] },
    EnumRow { name: "StateObjectKindDto", variants: &["task", "decision", "constraint", "note", "error"] },
    EnumRow { name: "StateTierDto", variants: &["active", "soft", "hard"] },
];

/// The §7.8 table is encoded here as data, so a missing or extra string
/// changes this data and fails the tests that consume it.
#[test]
fn section_7_8_enum_table_is_encoded_as_data() {
    assert_eq!(ENUM_TABLE.len(), 19);
    let all: Vec<&str> = ENUM_TABLE.iter().flat_map(|r| r.variants.iter().copied()).collect();
    assert!(all.contains(&"markdown"));
    assert!(all.contains(&"replaced_by_new_session"));
    assert!(all.contains(&"host_unavailable"));
    assert!(all.contains(&"plugin_operation"));
    assert!(all.contains(&"detect_contradiction"));
    assert!(all.contains(&"hard"));
}

// ================================================================ fixture values

mod fixtures {
    use super::*;

    pub const SESSION: &str = "01HNDKSZACCM9JD7GD6ZSAEKF4";
    pub const EVENT: &str = "01HNDKSZMVT8ZH52SF6C65RZYG";
    pub const TURN: &str = "01HNDKSZH5JMRNV7E9Z0C1HT0H";
    pub const ARTIFACT: &str = "01HNDKSZ1W6VV83STEYQME4QCM";
    pub const STATE: &str = "01HNDKSZ17DC6PY0V7B8B018TT";
    pub const ENTRY: &str = "01HNDKSZ28HM8HEE7QV4YSR5S4";

    pub fn plugin_manifest() -> Value {
        json!({
            "id": "builtin:sqlite",
            "display_name": "Builtin SQLite",
            "plugin_version": "0.1.0",
            "api_version": 1,
            "dto_schema_version": 1
        })
    }

    pub fn capabilities() -> Value {
        json!({
            "recall": true,
            "remember": true,
            "retract": true,
            "pin": true,
            "feedback": true,
            "startup_digest": true,
            "session_end_learning": true,
            "consolidation": true,
            "semantic_recall": false
        })
    }

    pub fn host_capabilities() -> Value {
        json!({"llm_completion": true, "completion_json_schema": true})
    }

    pub fn builtin_open_options() -> Value {
        json!({
            "db_path": "/home/user/.praana/memory.db",
            "extraction": true,
            "digest_max_tokens": 1600,
            "recall_limit": 10,
            "llm_contradictions": false
        })
    }

    pub fn open_request() -> Value {
        json!({
            "api_version": 1,
            "dto_schema_version": 1,
            "plugin_id": "builtin:sqlite",
            "options": {"type": "builtin_sqlite", "data": builtin_open_options()},
            "runtime": runtime_info()
        })
    }

    pub fn open_options() -> Value {
        json!({"type": "builtin_sqlite", "data": builtin_open_options()})
    }

    pub fn runtime_info() -> Value {
        json!({
            "praana_version": "0.1.0",
            "implementation": "rust",
            "os": "linux",
            "arch": "x86_64"
        })
    }

    pub fn session_context() -> Value {
        json!({
            "session_id": SESSION,
            "invocation_id": "op_01HNDKSZ28HM8HEE7QV4YSR5S4",
            "started_at_ms": 1735689600000i64,
            "agent_scope": "agent:praana",
            "user_scope": "user:ef0123456789abcdef0123456789abcdef",
            "project_scope": null,
            "project_label": "praana-p6-1",
            "cwd_label": "praana-p6-1"
        })
    }

    pub fn session_context_no_project() -> Value {
        let mut v = session_context();
        let map = v.as_object_mut().unwrap();
        map.insert("project_scope".into(), Value::Null);
        map.insert("project_label".into(), Value::Null);
        v
    }

    pub fn session_start() -> Value {
        json!({
            "session": session_context(),
            "state_graph": state_graph_snapshot()
        })
    }

    pub fn digest_markdown() -> Value {
        json!({
            "format": "markdown",
            "content": "## Constraints\n- Ship contract first\n",
            "entry_ids": [ENTRY],
            "estimated_tokens": 87,
            "token_estimator_schema_version": 1,
            "estimator_id": "generic",
            "input_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
    }

    pub fn digest_plain_text() -> Value {
        json!({
            "format": "plain_text",
            "content": "Constraints: Ship contract first.",
            "entry_ids": [ENTRY],
            "estimated_tokens": 21,
            "token_estimator_schema_version": 1,
            "estimator_id": "generic",
            "input_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        })
    }

    pub fn bootstrap() -> Value {
        json!({
            "invocation_ordinal": 1,
            "digest": digest_markdown(),
            "notices": [{
                "code": "memory.mode_degraded",
                "message": "CausalChain is treated as Standard in v1",
                "severity": "warning"
            }]
        })
    }

    pub fn bootstrap_no_digest() -> Value {
        json!({"invocation_ordinal": 2, "digest": null, "notices": []})
    }

    pub fn notice() -> Value {
        json!({
            "code": "memory.extraction_stale",
            "message": "Sequence 40 is stale",
            "severity": "info"
        })
    }

    pub fn recall_query() -> Value {
        json!({
            "query": "deployment deadline",
            "limit": 10,
            "kinds": ["fact", "decision", "constraint"],
            "scope": "auto",
            "mode": "standard"
        })
    }

    pub fn recall_query_scope_project() -> Value {
        let mut v = recall_query();
        v["scope"] = json!("project");
        v
    }

    pub fn recall_query_scope_global_mode_causal_chain() -> Value {
        let mut v = recall_query();
        v["scope"] = json!("global");
        v["mode"] = json!("causal_chain");
        v
    }

    pub fn recalled_memory() -> Value {
        json!({
            "id": ENTRY,
            "kind": "pattern",
            "content": "Deploys happen on Fridays",
            "scope": "project",
            "validity": 0.8125,
            "usefulness": 0.6875,
            "match_score": 0.9375,
            "rank_score": 0.875,
            "pinned": false,
            "evidence": [{
                "source_session_id": SESSION,
                "source_event_start": EVENT,
                "source_event_end": null
            }]
        })
    }

    pub fn recall_result() -> Value {
        json!({
            "entries": [recalled_memory()],
            "notice": null
        })
    }

    pub fn memory_evidence_ref() -> Value {
        json!({
            "source_session_id": SESSION,
            "source_event_start": null,
            "source_event_end": EVENT
        })
    }

    pub fn remember_tool_input() -> Value {
        json!({
            "content": "User prefers short releases",
            "kind": "preference",
            "certainty": "medium",
            "scope": "auto",
            "pinned": false
        })
    }

    pub fn remember_tool_input_scope_project() -> Value {
        let mut v = remember_tool_input();
        v["scope"] = json!("project");
        v
    }

    pub fn remember_tool_input_scope_global() -> Value {
        let mut v = remember_tool_input();
        v["scope"] = json!("global");
        v
    }

    pub fn remember_input() -> Value {
        json!({
            "content": "Pinning is a user preference",
            "kind": "mistake",
            "certainty": "high",
            "scope": "global",
            "pinned": true,
            "source": "explicit_tool",
            "evidence": []
        })
    }

    pub fn remember_input_certainty_low_source_session_extraction() -> Value {
        let mut v = remember_input();
        v["certainty"] = json!("low");
        v["source"] = json!("session_extraction");
        v["scope"] = json!("project");
        v
    }

    pub fn remember_input_source_consolidation() -> Value {
        let mut v = remember_input();
        v["source"] = json!("consolidation");
        v["scope"] = json!("project");
        v
    }

    pub fn remember_result() -> Value {
        json!({"id": ENTRY, "disposition": "created"})
    }

    pub fn remember_result_disposition_reinforced() -> Value {
        json!({"id": ENTRY, "disposition": "reinforced"})
    }

    pub fn remember_result_disposition_replaced() -> Value {
        json!({"id": ENTRY, "disposition": "replaced"})
    }

    pub fn retract_memory_input() -> Value {
        json!({"id": ENTRY, "reason": "Superseded by a newer insight"})
    }

    pub fn retract_memory_input_no_reason() -> Value {
        json!({"id": ENTRY, "reason": null})
    }

    pub fn retract_memory_result() -> Value {
        json!({"id": ENTRY, "retracted": true})
    }

    pub fn pin_memory_input() -> Value {
        json!({"id": ENTRY, "pinned": false})
    }

    pub fn pin_memory_result() -> Value {
        json!({"id": ENTRY, "pinned": false})
    }

    pub fn memory_feedback() -> Value {
        json!({
            "turn_id": TURN,
            "recalled_ids": [ENTRY],
            "used_ids": [ENTRY],
            "outcome": "success"
        })
    }

    pub fn memory_feedback_outcome(outcome: &str) -> Value {
        json!({
            "turn_id": TURN,
            "recalled_ids": [ENTRY],
            "used_ids": [],
            "outcome": outcome
        })
    }

    pub fn memory_feedback_result() -> Value {
        json!({"accepted_ids": [ENTRY]})
    }

    pub fn session_end() -> Value {
        json!({
            "session_id": SESSION,
            "through_sequence": 97,
            "ended_at_ms": 1735689660000i64,
            "reason": "clean",
            "outcome": "success",
            "transcript": [
                {
                    "sequence": 90,
                    "event_id": EVENT,
                    "turn_id": null,
                    "kind": {"type": "user_text", "data": {"text": "hello"}},
                    "timestamp_ms": 1735689640000i64
                },
                {
                    "sequence": 91,
                    "event_id": EVENT,
                    "turn_id": TURN,
                    "kind": {"type": "assistant_text", "data": {"text": "hi"}},
                    "timestamp_ms": 1735689641000i64
                },
                {
                    "sequence": 92,
                    "event_id": EVENT,
                    "turn_id": TURN,
                    "kind": {"type": "assistant_reasoning_summary", "data": {"text": "brief reasoning"}},
                    "timestamp_ms": 1735689642000i64
                },
                {
                    "sequence": 93,
                    "event_id": EVENT,
                    "turn_id": TURN,
                    "kind": {"type": "tool_observation", "data": {
                        "tool_call_id": "toolcall_01",
                        "tool_name": "read_file",
                        "display_label": "summary.md",
                        "redacted_preview": "# Summary\n",
                        "artifact": {"artifact_id": ARTIFACT, "content_type": "text/markdown", "redacted": true},
                        "is_error": false
                    }},
                    "timestamp_ms": 1735689643000i64
                },
                {
                    "sequence": 94,
                    "event_id": EVENT,
                    "turn_id": TURN,
                    "kind": {"type": "historical_handoff", "data": {"text": "previous context"}},
                    "timestamp_ms": 1735689644000i64
                }
            ],
            "final_state_graph": {
                "at_event_sequence": 97,
                "objects": [{
                    "id": STATE,
                    "kind": "decision",
                    "tier": "soft",
                    "status": null,
                    "title": "Decision",
                    "text": "Ship contract first",
                    "rationale": "Phase 6 order",
                    "retracted": false,
                    "updated_at_ms": 1735689650000i64
                }],
                "focused_id": STATE
            },
            "artifact_summaries": [redacted_artifact_summary()]
        })
    }

    pub fn session_end_reason(reason: &str) -> Value {
        json!({
            "session_id": SESSION,
            "through_sequence": 0,
            "ended_at_ms": 1735689660000i64,
            "reason": reason,
            "outcome": "unknown",
            "transcript": [],
            "final_state_graph": {
                "at_event_sequence": 0,
                "objects": [],
                "focused_id": null
            },
            "artifact_summaries": []
        })
    }

    pub fn session_end_result() -> Value {
        json!({
            "learnings_created": 2,
            "memories_reinforced": 1,
            "memories_retracted": 0,
            "memories_consolidated": 1,
            "notices": []
        })
    }

    pub fn stats() -> Value {
        json!({
            "plugin_id": "builtin:sqlite",
            "plugin_version": "0.1.0",
            "entries_active": 120,
            "entries_retracted": 4,
            "entries_pinned": 3,
            "entries_project": 75,
            "entries_global": 45,
            "storage_bytes": 1048576,
            "last_maintenance_at_ms": null
        })
    }

    pub fn stats_no_storage() -> Value {
        let mut v = stats();
        v["storage_bytes"] = Value::Null;
        v
    }

    pub fn plugin_error(code: &str) -> Value {
        json!({"code": code, "message": "Database is busy", "retryable": true})
    }

    pub fn host_error(code: &str) -> Value {
        json!({"code": code, "message": "Provider transport unavailable", "retryable": true})
    }

    pub fn log_record(level: &str) -> Value {
        json!({
            "level": level,
            "message": "recall completed",
            "fields": {"entry_id": ENTRY, "ok": true}
        })
    }

    pub fn completion_request(purpose: &str) -> Value {
        json!({
            "purpose": purpose,
            "prompt_version": "memory-extraction-v1:abcdef",
            "system": "You extract durable memory.",
            "prompt": "Extract learnings from the transcript.",
            "max_output_tokens": 512,
            "temperature_milli": 100,
            "response_schema": null,
            "timeout_ms": 15000
        })
    }

    pub fn completion_response() -> Value {
        json!({
            "text": "[]",
            "model_label": "gpt-5.6-mini",
            "input_tokens": null,
            "output_tokens": null
        })
    }

    pub fn visible_transcript_item() -> Value {
        json!({
            "sequence": 5,
            "event_id": EVENT,
            "turn_id": TURN,
            "kind": {"type": "tool_observation", "data": {
                "tool_call_id": "toolcall_02",
                "tool_name": "write_file",
                "display_label": "note.md",
                "redacted_preview": "",
                "artifact": null,
                "is_error": true
            }},
            "timestamp_ms": 1735689600000i64
        })
    }

    pub fn visible_transcript_kind() -> Value {
        json!({"type": "assistant_text", "data": {"text": "Hello"}})
    }

    pub fn memory_artifact_ref() -> Value {
        json!({"artifact_id": ARTIFACT, "content_type": "application/pdf", "redacted": false})
    }

    pub fn state_graph_snapshot() -> Value {
        json!({
            "at_event_sequence": 42,
            "objects": [state_object()],
            "focused_id": STATE
        })
    }

    pub fn state_object() -> Value {
        json!({
            "id": STATE,
            "kind": "note",
            "tier": "active",
            "status": null,
            "title": null,
            "text": "Keep notes short",
            "rationale": null,
            "retracted": true,
            "updated_at_ms": 1735689600000i64
        })
    }

    pub fn state_object_kind(kind: &str) -> Value {
        let mut v = state_object();
        v["kind"] = json!(kind);
        v
    }

    pub fn redacted_artifact_summary() -> Value {
        json!({
            "artifact_id": ARTIFACT,
            "producing_event_id": EVENT,
            "tool_name": "read_file",
            "display_label": "summary.md",
            "content_type": "text/markdown",
            "redacted_summary": "Logged deployment timestamps",
            "access_count": 7
        })
    }
}

// ================================================================ schema matching

fn schema_type_ok(value: &Value, ty: &str) -> bool {
    match ty {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => value.is_number(),
        _ => true,
    }
}

fn schema_matches(value: &Value, schema: &Value) -> bool {
    if let Some(Value::String(constant)) = schema.get("const") {
        return value == constant;
    }
    if let Some(types) = schema.get("type") {
        let types: Vec<&str> = match types {
            Value::String(t) => vec![t.as_str()],
            Value::Array(ts) => ts.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !types.is_empty() && !types.iter().any(|t| schema_type_ok(value, t)) {
            return false;
        }
    }
    if let Some(Value::Array(members)) = schema.get("enum") {
        if !members.contains(value) {
            return false;
        }
    }
    if let Some(Value::Array(branches)) = schema.get("oneOf") {
        return branches.iter().filter(|b| schema_matches(value, b)).count() == 1;
    }
    if let Some(Value::Array(branches)) = schema.get("anyOf") {
        return branches.iter().any(|b| schema_matches(value, b));
    }
    match value {
        Value::Object(map) => {
            if let Some(Value::Object(props)) = schema.get("properties") {
                for (key, child) in map {
                    match props.get(key) {
                        Some(child_schema) => {
                            if !schema_matches(child, child_schema) {
                                return false;
                            }
                        }
                        None if schema.get("additionalProperties") == Some(&Value::Bool(false)) => {
                            return false;
                        }
                        None => {}
                    }
                }
            }
            if let Some(Value::Array(required)) = schema.get("required") {
                for key in required.iter().filter_map(Value::as_str) {
                    if !map.contains_key(key) {
                        return false;
                    }
                }
            }
            true
        }
        Value::Array(items) => {
            if let Some(item_schema) = schema.get("items") {
                items.iter().all(|it| schema_matches(it, item_schema))
            } else {
                true
            }
        }
        _ => true,
    }
}

#[track_caller]
fn assert_matches_schema(value: &Value, schema: &Value) {
    assert!(
        schema_matches(value, schema),
        "value does not match its JSON schema: {value}"
    );
}

// ================================================================ fixtures and schemas

fn check_fixture<T: DeserializeOwned + JsonSchema + serde::Serialize>(file: &str, value: Value) {
    let canonical = to_canonical_json_bytes(&value).expect("fixture value canonicalizes");
    let path = fixture_dir().join(file);
    write_when_requested(&path, &canonical);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("missing golden fixture {file}: {e}"));
    assert_eq!(canonical, bytes, "{file}: file is not the RFC 8785 form of the value");
    let decoded: T = decode_dto(&bytes).unwrap_or_else(|e| panic!("{file} fails strict decode: {e}"));
    assert_eq!(
        to_canonical_json_bytes(&decoded).unwrap(),
        bytes,
        "{file}: decoded value does not round-trip byte-exact"
    );
    assert_matches_schema(&value, &dto_schema_value::<T>());
}

#[test]
fn golden_fixtures_round_trip_byte_exact_and_match_their_schemas() {
    let cases: Vec<(&str, fn(Value))> = vec![
        ("memory_plugin_manifest.json", |v| check_fixture::<MemoryPluginManifest>("memory_plugin_manifest.json", v)),
        ("memory_capabilities.json", |v| check_fixture::<MemoryCapabilities>("memory_capabilities.json", v)),
        ("memory_host_capabilities.json", |v| check_fixture::<MemoryHostCapabilities>("memory_host_capabilities.json", v)),
        ("memory_open_request.json", |v| check_fixture::<MemoryOpenRequest>("memory_open_request.json", v)),
        ("memory_open_options.json", |v| check_fixture::<MemoryOpenOptions>("memory_open_options.json", v)),
        ("builtin_sqlite_open_options.json", |v| check_fixture::<BuiltinSqliteOpenOptions>("builtin_sqlite_open_options.json", v)),
        ("memory_runtime_info.json", |v| check_fixture::<MemoryRuntimeInfo>("memory_runtime_info.json", v)),
        ("memory_session_start.json", |v| check_fixture::<MemorySessionStart>("memory_session_start.json", v)),
        ("memory_session_context.json", |v| check_fixture::<MemorySessionContext>("memory_session_context.json", v)),
        ("memory_session_context_no_project.json", |v| check_fixture::<MemorySessionContext>("memory_session_context_no_project.json", v)),
        ("memory_bootstrap.json", |v| check_fixture::<MemoryBootstrap>("memory_bootstrap.json", v)),
        ("memory_bootstrap_no_digest.json", |v| check_fixture::<MemoryBootstrap>("memory_bootstrap_no_digest.json", v)),
        ("memory_digest.json", |v| check_fixture::<MemoryDigest>("memory_digest.json", v)),
        ("memory_notice.json", |v| check_fixture::<MemoryNotice>("memory_notice.json", v)),
        ("recall_query.json", |v| check_fixture::<RecallQuery>("recall_query.json", v)),
        ("recall_query_scope_project.json", |v| check_fixture::<RecallQuery>("recall_query_scope_project.json", v)),
        ("recall_query_scope_global_mode_causal_chain.json", |v| check_fixture::<RecallQuery>("recall_query_scope_global_mode_causal_chain.json", v)),
        ("recall_result.json", |v| check_fixture::<RecallResult>("recall_result.json", v)),
        ("recalled_memory.json", |v| check_fixture::<RecalledMemory>("recalled_memory.json", v)),
        ("memory_evidence_ref.json", |v| check_fixture::<MemoryEvidenceRef>("memory_evidence_ref.json", v)),
        ("remember_tool_input.json", |v| check_fixture::<RememberToolInput>("remember_tool_input.json", v)),
        ("remember_tool_input_scope_project.json", |v| check_fixture::<RememberToolInput>("remember_tool_input_scope_project.json", v)),
        ("remember_tool_input_scope_global.json", |v| check_fixture::<RememberToolInput>("remember_tool_input_scope_global.json", v)),
        ("remember_input.json", |v| check_fixture::<RememberInput>("remember_input.json", v)),
        ("remember_input_certainty_low_source_session_extraction.json", |v| check_fixture::<RememberInput>("remember_input_certainty_low_source_session_extraction.json", v)),
        ("remember_input_source_consolidation.json", |v| check_fixture::<RememberInput>("remember_input_source_consolidation.json", v)),
        ("remember_result.json", |v| check_fixture::<RememberResult>("remember_result.json", v)),
        ("remember_result_disposition_reinforced.json", |v| check_fixture::<RememberResult>("remember_result_disposition_reinforced.json", v)),
        ("remember_result_disposition_replaced.json", |v| check_fixture::<RememberResult>("remember_result_disposition_replaced.json", v)),
        ("retract_memory_input.json", |v| check_fixture::<RetractMemoryInput>("retract_memory_input.json", v)),
        ("retract_memory_input_no_reason.json", |v| check_fixture::<RetractMemoryInput>("retract_memory_input_no_reason.json", v)),
        ("retract_memory_result.json", |v| check_fixture::<RetractMemoryResult>("retract_memory_result.json", v)),
        ("pin_memory_input.json", |v| check_fixture::<PinMemoryInput>("pin_memory_input.json", v)),
        ("pin_memory_result.json", |v| check_fixture::<PinMemoryResult>("pin_memory_result.json", v)),
        ("memory_feedback.json", |v| check_fixture::<MemoryFeedback>("memory_feedback.json", v)),
        ("memory_feedback_outcome_failure.json", |v| check_fixture::<MemoryFeedback>("memory_feedback_outcome_failure.json", v)),
        ("memory_feedback_outcome_interrupted.json", |v| check_fixture::<MemoryFeedback>("memory_feedback_outcome_interrupted.json", v)),
        ("memory_feedback_outcome_unknown.json", |v| check_fixture::<MemoryFeedback>("memory_feedback_outcome_unknown.json", v)),
        ("memory_feedback_result.json", |v| check_fixture::<MemoryFeedbackResult>("memory_feedback_result.json", v)),
        ("memory_session_end.json", |v| check_fixture::<MemorySessionEnd>("memory_session_end.json", v)),
        ("memory_session_end_reason_aborted.json", |v| check_fixture::<MemorySessionEnd>("memory_session_end_reason_aborted.json", v)),
        ("memory_session_end_reason_error.json", |v| check_fixture::<MemorySessionEnd>("memory_session_end_reason_error.json", v)),
        ("memory_session_end_reason_replaced_by_new_session.json", |v| check_fixture::<MemorySessionEnd>("memory_session_end_reason_replaced_by_new_session.json", v)),
        ("memory_session_end_result.json", |v| check_fixture::<MemorySessionEndResult>("memory_session_end_result.json", v)),
        ("memory_stats.json", |v| check_fixture::<MemoryStats>("memory_stats.json", v)),
        ("memory_stats_no_storage.json", |v| check_fixture::<MemoryStats>("memory_stats_no_storage.json", v)),
        ("memory_plugin_error.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error.json", v)),
        ("memory_plugin_error_code_invalid_options.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_invalid_options.json", v)),
        ("memory_plugin_error_code_unsupported.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_unsupported.json", v)),
        ("memory_plugin_error_code_not_found.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_not_found.json", v)),
        ("memory_plugin_error_code_invalid_input.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_invalid_input.json", v)),
        ("memory_plugin_error_code_storage_corrupt.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_storage_corrupt.json", v)),
        ("memory_plugin_error_code_host_unavailable.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_host_unavailable.json", v)),
        ("memory_plugin_error_code_completion_failed.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_completion_failed.json", v)),
        ("memory_plugin_error_code_cancelled.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_cancelled.json", v)),
        ("memory_plugin_error_code_timed_out.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_timed_out.json", v)),
        ("memory_plugin_error_code_internal.json", |v| check_fixture::<MemoryPluginError>("memory_plugin_error_code_internal.json", v)),
        ("memory_host_error.json", |v| check_fixture::<MemoryHostError>("memory_host_error.json", v)),
        ("memory_host_error_code_invalid_request.json", |v| check_fixture::<MemoryHostError>("memory_host_error_code_invalid_request.json", v)),
        ("memory_host_error_code_completion_failed.json", |v| check_fixture::<MemoryHostError>("memory_host_error_code_completion_failed.json", v)),
        ("memory_host_error_code_cancelled.json", |v| check_fixture::<MemoryHostError>("memory_host_error_code_cancelled.json", v)),
        ("memory_host_error_code_timed_out.json", |v| check_fixture::<MemoryHostError>("memory_host_error_code_timed_out.json", v)),
        ("memory_host_error_code_internal.json", |v| check_fixture::<MemoryHostError>("memory_host_error_code_internal.json", v)),
        ("memory_plugin_log_record.json", |v| check_fixture::<MemoryPluginLogRecord>("memory_plugin_log_record.json", v)),
        ("memory_plugin_log_record_level_debug.json", |v| check_fixture::<MemoryPluginLogRecord>("memory_plugin_log_record_level_debug.json", v)),
        ("memory_plugin_log_record_level_warn.json", |v| check_fixture::<MemoryPluginLogRecord>("memory_plugin_log_record_level_warn.json", v)),
        ("memory_plugin_log_record_level_error.json", |v| check_fixture::<MemoryPluginLogRecord>("memory_plugin_log_record_level_error.json", v)),
        ("memory_completion_request.json", |v| check_fixture::<MemoryCompletionRequest>("memory_completion_request.json", v)),
        ("memory_completion_request_purpose_detect_contradiction.json", |v| check_fixture::<MemoryCompletionRequest>("memory_completion_request_purpose_detect_contradiction.json", v)),
        ("memory_completion_request_purpose_consolidate.json", |v| check_fixture::<MemoryCompletionRequest>("memory_completion_request_purpose_consolidate.json", v)),
        ("memory_completion_response.json", |v| check_fixture::<MemoryCompletionResponse>("memory_completion_response.json", v)),
        ("visible_transcript_item.json", |v| check_fixture::<VisibleTranscriptItem>("visible_transcript_item.json", v)),
        ("visible_transcript_kind.json", |v| check_fixture::<VisibleTranscriptKind>("visible_transcript_kind.json", v)),
        ("memory_artifact_ref.json", |v| check_fixture::<MemoryArtifactRef>("memory_artifact_ref.json", v)),
        ("state_graph_snapshot_dto.json", |v| check_fixture::<StateGraphSnapshotDto>("state_graph_snapshot_dto.json", v)),
        ("state_object_dto.json", |v| check_fixture::<StateObjectDto>("state_object_dto.json", v)),
        ("state_object_dto_kind_task.json", |v| check_fixture::<StateObjectDto>("state_object_dto_kind_task.json", v)),
        ("state_object_dto_kind_constraint.json", |v| check_fixture::<StateObjectDto>("state_object_dto_kind_constraint.json", v)),
        ("redacted_artifact_summary_dto.json", |v| check_fixture::<RedactedArtifactSummaryDto>("redacted_artifact_summary_dto.json", v)),
    ];
    let call = |file: &str, value: Value| {
        let f = cases
            .iter()
            .find(|(name, _)| *name == file)
            .unwrap_or_else(|| panic!("no case for {file}"))
            .1;
        f(value);
    };
    use fixtures::*;
    call("memory_plugin_manifest.json", plugin_manifest());
    call("memory_capabilities.json", capabilities());
    call("memory_host_capabilities.json", host_capabilities());
    call("memory_open_request.json", open_request());
    call("memory_open_options.json", open_options());
    call("builtin_sqlite_open_options.json", builtin_open_options());
    call("memory_runtime_info.json", runtime_info());
    call("memory_session_start.json", session_start());
    call("memory_session_context.json", session_context());
    call("memory_session_context_no_project.json", session_context_no_project());
    call("memory_bootstrap.json", bootstrap());
    call("memory_bootstrap_no_digest.json", bootstrap_no_digest());
    call("memory_digest.json", digest_plain_text());
    call("memory_notice.json", notice());
    call("recall_query.json", recall_query());
    call("recall_query_scope_project.json", recall_query_scope_project());
    call("recall_query_scope_global_mode_causal_chain.json", recall_query_scope_global_mode_causal_chain());
    call("recall_result.json", recall_result());
    call("recalled_memory.json", recalled_memory());
    call("memory_evidence_ref.json", memory_evidence_ref());
    call("remember_tool_input.json", remember_tool_input());
    call("remember_tool_input_scope_project.json", remember_tool_input_scope_project());
    call("remember_tool_input_scope_global.json", remember_tool_input_scope_global());
    call("remember_input.json", remember_input());
    call("remember_input_certainty_low_source_session_extraction.json", remember_input_certainty_low_source_session_extraction());
    call("remember_input_source_consolidation.json", remember_input_source_consolidation());
    call("remember_result.json", remember_result());
    call("remember_result_disposition_reinforced.json", remember_result_disposition_reinforced());
    call("remember_result_disposition_replaced.json", remember_result_disposition_replaced());
    call("retract_memory_input.json", retract_memory_input());
    call("retract_memory_input_no_reason.json", retract_memory_input_no_reason());
    call("retract_memory_result.json", retract_memory_result());
    call("pin_memory_input.json", pin_memory_input());
    call("pin_memory_result.json", pin_memory_result());
    call("memory_feedback.json", memory_feedback());
    call("memory_feedback_outcome_failure.json", memory_feedback_outcome("failure"));
    call("memory_feedback_outcome_interrupted.json", memory_feedback_outcome("interrupted"));
    call("memory_feedback_outcome_unknown.json", memory_feedback_outcome("unknown"));
    call("memory_feedback_result.json", memory_feedback_result());
    call("memory_session_end.json", session_end());
    call("memory_session_end_reason_aborted.json", session_end_reason("aborted"));
    call("memory_session_end_reason_error.json", session_end_reason("error"));
    call("memory_session_end_reason_replaced_by_new_session.json", session_end_reason("replaced_by_new_session"));
    call("memory_session_end_result.json", session_end_result());
    call("memory_stats.json", stats());
    call("memory_stats_no_storage.json", stats_no_storage());
    call("memory_plugin_error.json", plugin_error("storage_busy"));
    for code in ["invalid_options", "unsupported", "not_found", "invalid_input", "storage_corrupt", "host_unavailable", "completion_failed", "cancelled", "timed_out", "internal"] {
        call(&format!("memory_plugin_error_code_{code}.json"), plugin_error(code));
    }
    call("memory_host_error.json", host_error("unavailable"));
    for code in ["invalid_request", "completion_failed", "cancelled", "timed_out", "internal"] {
        call(&format!("memory_host_error_code_{code}.json"), host_error(code));
    }
    call("memory_plugin_log_record.json", log_record("info"));
    call("memory_plugin_log_record_level_debug.json", log_record("debug"));
    call("memory_plugin_log_record_level_warn.json", log_record("warn"));
    call("memory_plugin_log_record_level_error.json", log_record("error"));
    call("memory_completion_request.json", completion_request("extract_learnings"));
    call("memory_completion_request_purpose_detect_contradiction.json", completion_request("detect_contradiction"));
    call("memory_completion_request_purpose_consolidate.json", completion_request("consolidate"));
    call("memory_completion_response.json", completion_response());
    call("visible_transcript_item.json", visible_transcript_item());
    call("visible_transcript_kind.json", visible_transcript_kind());
    call("memory_artifact_ref.json", memory_artifact_ref());
    call("state_graph_snapshot_dto.json", state_graph_snapshot());
    call("state_object_dto.json", state_object());
    call("state_object_dto_kind_task.json", state_object_kind("task"));
    call("state_object_dto_kind_constraint.json", state_object_kind("constraint"));
    call("redacted_artifact_summary_dto.json", redacted_artifact_summary());
}

fn walk_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| walk_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| walk_strings(v, out)),
        _ => {}
    }
}

#[test]
fn fixtures_cover_every_section_7_8_enum_string() {
    let mut collected: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(fixture_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        walk_strings(&value, &mut collected);
    }
    for row in ENUM_TABLE {
        // `MemoryHostIdKind` appears only in the `MemoryPluginHost::new_id`
        // trait signature (§8.1); no DTO serializes it, so fixture coverage
        // is impossible and its exact strings are pinned by the enum tests.
        if row.name == "MemoryHostIdKind" {
            continue;
        }
        for variant in row.variants {
            assert!(
                collected.iter().any(|s| s == variant),
                "{} string `{variant}` is not covered by any golden fixture",
                row.name
            );
        }
    }
}

#[test]
fn fixtures_cover_required_null_option_fields() {
    // Each Option field serializes as null in at least one fixture.
    let reads = |file: &str| std::fs::read_to_string(fixture_dir().join(file)).unwrap();
    for (file, field) in [
        ("memory_session_context.json", "\"project_scope\":null"),
        ("memory_session_context_no_project.json", "\"project_label\":null"),
        ("memory_bootstrap_no_digest.json", "\"digest\":null"),
        ("recall_result.json", "\"notice\":null"),
        ("memory_evidence_ref.json", "\"source_event_start\":null"),
        ("recalled_memory.json", "\"source_event_end\":null"),
        ("retract_memory_input_no_reason.json", "\"reason\":null"),
        ("memory_session_end.json", "\"turn_id\":null"),
        ("visible_transcript_item.json", "\"artifact\":null"),
        ("memory_session_start.json", "\"focused_id\":null"),
        ("state_object_dto.json", "\"status\":null"),
        ("state_object_dto.json", "\"title\":null"),
        ("state_object_dto.json", "\"rationale\":null"),
        ("memory_stats_no_storage.json", "\"storage_bytes\":null"),
        ("memory_stats.json", "\"last_maintenance_at_ms\":null"),
        ("memory_completion_request.json", "\"response_schema\":null"),
        ("memory_completion_response.json", "\"input_tokens\":null"),
        ("memory_completion_response.json", "\"output_tokens\":null"),
    ] {
        assert!(reads(file).contains(field), "{file} must contain {field}");
    }
}

// ================================================================ schema snapshots

fn check_schema_file<T: JsonSchema>(file: &str) {
    let generated = dto_schema_bytes::<T>();
    let path = schema_dir().join(file);
    write_when_requested(&path, &generated);
    let checked_in = std::fs::read(&path).unwrap_or_else(|e| panic!("missing checked-in schema {file}: {e}"));
    assert_eq!(
        generated,
        checked_in,
        "{file}: generated schema differs from the checked-in snapshot (regenerate with PRAANA_WRITE_MEMORY_FIXTURES=1)"
    );
}

#[test]
fn every_checked_in_schema_equals_the_generated_bytes() {
    check_schema_file::<MemoryPluginManifest>("memory_plugin_manifest.schema.json");
    check_schema_file::<MemoryCapabilities>("memory_capabilities.schema.json");
    check_schema_file::<MemoryHostCapabilities>("memory_host_capabilities.schema.json");
    check_schema_file::<MemoryOpenRequest>("memory_open_request.schema.json");
    check_schema_file::<MemoryOpenOptions>("memory_open_options.schema.json");
    check_schema_file::<BuiltinSqliteOpenOptions>("builtin_sqlite_open_options.schema.json");
    check_schema_file::<MemoryRuntimeInfo>("memory_runtime_info.schema.json");
    check_schema_file::<MemorySessionStart>("memory_session_start.schema.json");
    check_schema_file::<MemorySessionContext>("memory_session_context.schema.json");
    check_schema_file::<MemoryBootstrap>("memory_bootstrap.schema.json");
    check_schema_file::<MemoryDigest>("memory_digest.schema.json");
    check_schema_file::<MemoryNotice>("memory_notice.schema.json");
    check_schema_file::<RecallQuery>("recall_query.schema.json");
    check_schema_file::<RecallResult>("recall_result.schema.json");
    check_schema_file::<RecalledMemory>("recalled_memory.schema.json");
    check_schema_file::<MemoryEvidenceRef>("memory_evidence_ref.schema.json");
    check_schema_file::<RememberToolInput>("remember_tool_input.schema.json");
    check_schema_file::<RememberInput>("remember_input.schema.json");
    check_schema_file::<RememberResult>("remember_result.schema.json");
    check_schema_file::<RetractMemoryInput>("retract_memory_input.schema.json");
    check_schema_file::<RetractMemoryResult>("retract_memory_result.schema.json");
    check_schema_file::<PinMemoryInput>("pin_memory_input.schema.json");
    check_schema_file::<PinMemoryResult>("pin_memory_result.schema.json");
    check_schema_file::<MemoryFeedback>("memory_feedback.schema.json");
    check_schema_file::<MemoryFeedbackResult>("memory_feedback_result.schema.json");
    check_schema_file::<MemorySessionEnd>("memory_session_end.schema.json");
    check_schema_file::<MemorySessionEndResult>("memory_session_end_result.schema.json");
    check_schema_file::<MemoryStats>("memory_stats.schema.json");
    check_schema_file::<MemoryPluginError>("memory_plugin_error.schema.json");
    check_schema_file::<MemoryHostError>("memory_host_error.schema.json");
    check_schema_file::<MemoryPluginLogRecord>("memory_plugin_log_record.schema.json");
    check_schema_file::<MemoryCompletionRequest>("memory_completion_request.schema.json");
    check_schema_file::<MemoryCompletionResponse>("memory_completion_response.schema.json");
    check_schema_file::<VisibleTranscriptItem>("visible_transcript_item.schema.json");
    check_schema_file::<VisibleTranscriptKind>("visible_transcript_kind.schema.json");
    check_schema_file::<MemoryArtifactRef>("memory_artifact_ref.schema.json");
    check_schema_file::<StateGraphSnapshotDto>("state_graph_snapshot_dto.schema.json");
    check_schema_file::<StateObjectDto>("state_object_dto.schema.json");
    check_schema_file::<RedactedArtifactSummaryDto>("redacted_artifact_summary_dto.schema.json");
}

#[test]
fn every_schema_file_is_rfc_8785_canonical_without_trailing_lf() {
    for entry in std::fs::read_dir(schema_dir()).unwrap() {
        let path = entry.unwrap().path();
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.ends_with(b"\n"), "{}: trailing LF", path.display());
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(bytes, to_canonical_json_bytes(&value).unwrap(), "{}: not canonical", path.display());
    }
}

#[test]
fn every_object_schema_is_strict_all_properties_required() {
    let all_schemas: Vec<Value> = std::fs::read_dir(schema_dir())
        .unwrap()
        .map(|e| {
            let value: Value =
                serde_json::from_slice(&std::fs::read(e.unwrap().path()).unwrap()).unwrap();
            value
        })
        .collect();
    assert!(all_schemas.len() >= 39, "expected every public DTO schema");
    for schema in &all_schemas {
        walk(&schema, &mut |node| {
            if let Value::Object(map) = node {
                if map.get("type") == Some(&json!("object")) && map.contains_key("properties") {
                    assert_eq!(
                        map.get("additionalProperties"),
                        Some(&json!(false)),
                        "object schema must deny unknown fields"
                    );
                    let required = map.get("required").and_then(Value::as_array);
                    let required = required.expect("object schema has required");
                    let props = map.get("properties").and_then(Value::as_object).unwrap();
                    for key in props.keys() {
                        assert!(
                            required.contains(&json!(key)),
                            "property {key} is missing from required"
                        );
                    }
                }
            }
        });
    }
}

fn walk(value: &Value, visit: &mut impl FnMut(&Value)) {
    visit(value);
    match value {
        Value::Array(items) => items.iter().for_each(|v| walk(v, visit)),
        Value::Object(map) => map.values().for_each(|v| walk(v, visit)),
        _ => {}
    }
}

// ================================================================ unit enums

#[test]
fn unit_enums_serialize_to_exact_section_7_8_strings() {
    assert_eq!(serde_json::to_string(&MemoryDigestFormat::Markdown).unwrap(), "\"markdown\"");
    assert_eq!(serde_json::to_string(&MemoryDigestFormat::PlainText).unwrap(), "\"plain_text\"");
    assert_eq!(serde_json::to_string(&MemoryNoticeSeverity::Info).unwrap(), "\"info\"");
    assert_eq!(serde_json::to_string(&MemoryNoticeSeverity::Warning).unwrap(), "\"warning\"");
    assert_eq!(serde_json::to_string(&RecallScope::Auto).unwrap(), "\"auto\"");
    assert_eq!(serde_json::to_string(&RecallScope::Project).unwrap(), "\"project\"");
    assert_eq!(serde_json::to_string(&RecallScope::Global).unwrap(), "\"global\"");
    assert_eq!(serde_json::to_string(&RecallMode::Standard).unwrap(), "\"standard\"");
    assert_eq!(serde_json::to_string(&RecallMode::CausalChain).unwrap(), "\"causal_chain\"");
    assert_eq!(serde_json::to_string(&MemoryKind::Fact).unwrap(), "\"fact\"");
    assert_eq!(serde_json::to_string(&MemoryKind::Preference).unwrap(), "\"preference\"");
    assert_eq!(serde_json::to_string(&MemoryKind::Decision).unwrap(), "\"decision\"");
    assert_eq!(serde_json::to_string(&MemoryKind::Pattern).unwrap(), "\"pattern\"");
    assert_eq!(serde_json::to_string(&MemoryKind::Mistake).unwrap(), "\"mistake\"");
    assert_eq!(serde_json::to_string(&MemoryKind::Constraint).unwrap(), "\"constraint\"");
    assert_eq!(serde_json::to_string(&MemoryScope::Project).unwrap(), "\"project\"");
    assert_eq!(serde_json::to_string(&MemoryScope::Global).unwrap(), "\"global\"");
    assert_eq!(serde_json::to_string(&MemoryScopeRequest::Auto).unwrap(), "\"auto\"");
    assert_eq!(serde_json::to_string(&MemoryScopeRequest::Project).unwrap(), "\"project\"");
    assert_eq!(serde_json::to_string(&MemoryScopeRequest::Global).unwrap(), "\"global\"");
    assert_eq!(serde_json::to_string(&MemoryCertainty::High).unwrap(), "\"high\"");
    assert_eq!(serde_json::to_string(&MemoryCertainty::Medium).unwrap(), "\"medium\"");
    assert_eq!(serde_json::to_string(&MemoryCertainty::Low).unwrap(), "\"low\"");
    assert_eq!(serde_json::to_string(&MemoryWriteSource::ExplicitTool).unwrap(), "\"explicit_tool\"");
    assert_eq!(serde_json::to_string(&MemoryWriteSource::SessionExtraction).unwrap(), "\"session_extraction\"");
    assert_eq!(serde_json::to_string(&MemoryWriteSource::Consolidation).unwrap(), "\"consolidation\"");
    assert_eq!(serde_json::to_string(&RememberDisposition::Created).unwrap(), "\"created\"");
    assert_eq!(serde_json::to_string(&RememberDisposition::Reinforced).unwrap(), "\"reinforced\"");
    assert_eq!(serde_json::to_string(&RememberDisposition::Replaced).unwrap(), "\"replaced\"");
    assert_eq!(serde_json::to_string(&MemoryOutcomeSignal::Success).unwrap(), "\"success\"");
    assert_eq!(serde_json::to_string(&MemoryOutcomeSignal::Failure).unwrap(), "\"failure\"");
    assert_eq!(serde_json::to_string(&MemoryOutcomeSignal::Interrupted).unwrap(), "\"interrupted\"");
    assert_eq!(serde_json::to_string(&MemoryOutcomeSignal::Unknown).unwrap(), "\"unknown\"");
    assert_eq!(serde_json::to_string(&MemorySessionEndReason::Clean).unwrap(), "\"clean\"");
    assert_eq!(serde_json::to_string(&MemorySessionEndReason::Aborted).unwrap(), "\"aborted\"");
    assert_eq!(serde_json::to_string(&MemorySessionEndReason::Error).unwrap(), "\"error\"");
    assert_eq!(serde_json::to_string(&MemorySessionEndReason::ReplacedByNewSession).unwrap(), "\"replaced_by_new_session\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::InvalidOptions).unwrap(), "\"invalid_options\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::Unsupported).unwrap(), "\"unsupported\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::NotFound).unwrap(), "\"not_found\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::InvalidInput).unwrap(), "\"invalid_input\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::StorageBusy).unwrap(), "\"storage_busy\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::StorageCorrupt).unwrap(), "\"storage_corrupt\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::HostUnavailable).unwrap(), "\"host_unavailable\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::CompletionFailed).unwrap(), "\"completion_failed\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::Cancelled).unwrap(), "\"cancelled\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::TimedOut).unwrap(), "\"timed_out\"");
    assert_eq!(serde_json::to_string(&MemoryPluginErrorCode::Internal).unwrap(), "\"internal\"");
    assert_eq!(serde_json::to_string(&MemoryHostErrorCode::InvalidRequest).unwrap(), "\"invalid_request\"");
    assert_eq!(serde_json::to_string(&MemoryHostErrorCode::Unavailable).unwrap(), "\"unavailable\"");
    assert_eq!(serde_json::to_string(&MemoryHostErrorCode::CompletionFailed).unwrap(), "\"completion_failed\"");
    assert_eq!(serde_json::to_string(&MemoryHostErrorCode::Cancelled).unwrap(), "\"cancelled\"");
    assert_eq!(serde_json::to_string(&MemoryHostErrorCode::TimedOut).unwrap(), "\"timed_out\"");
    assert_eq!(serde_json::to_string(&MemoryHostErrorCode::Internal).unwrap(), "\"internal\"");
    assert_eq!(serde_json::to_string(&MemoryHostIdKind::MemoryEntry).unwrap(), "\"memory_entry\"");
    assert_eq!(serde_json::to_string(&MemoryHostIdKind::PluginOperation).unwrap(), "\"plugin_operation\"");
    assert_eq!(serde_json::to_string(&MemoryPluginLogLevel::Debug).unwrap(), "\"debug\"");
    assert_eq!(serde_json::to_string(&MemoryPluginLogLevel::Info).unwrap(), "\"info\"");
    assert_eq!(serde_json::to_string(&MemoryPluginLogLevel::Warn).unwrap(), "\"warn\"");
    assert_eq!(serde_json::to_string(&MemoryPluginLogLevel::Error).unwrap(), "\"error\"");
    assert_eq!(serde_json::to_string(&MemoryCompletionPurpose::ExtractLearnings).unwrap(), "\"extract_learnings\"");
    assert_eq!(serde_json::to_string(&MemoryCompletionPurpose::DetectContradiction).unwrap(), "\"detect_contradiction\"");
    assert_eq!(serde_json::to_string(&MemoryCompletionPurpose::Consolidate).unwrap(), "\"consolidate\"");
    assert_eq!(serde_json::to_string(&StateObjectKindDto::Task).unwrap(), "\"task\"");
    assert_eq!(serde_json::to_string(&StateObjectKindDto::Decision).unwrap(), "\"decision\"");
    assert_eq!(serde_json::to_string(&StateObjectKindDto::Constraint).unwrap(), "\"constraint\"");
    assert_eq!(serde_json::to_string(&StateObjectKindDto::Note).unwrap(), "\"note\"");
    assert_eq!(serde_json::to_string(&StateObjectKindDto::Error).unwrap(), "\"error\"");
    assert_eq!(serde_json::to_string(&StateTierDto::Active).unwrap(), "\"active\"");
    assert_eq!(serde_json::to_string(&StateTierDto::Soft).unwrap(), "\"soft\"");
    assert_eq!(serde_json::to_string(&StateTierDto::Hard).unwrap(), "\"hard\"");
}

#[test]
fn unit_enums_reject_every_non_table_string() {
    for raw in ["mark_down", "MARKDOWN", "md", "", "markdown\n"] {
        assert!(serde_json::from_str::<MemoryDigestFormat>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["INFO", "i", "", "warn"] {
        assert!(serde_json::from_str::<MemoryNoticeSeverity>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["AUTO", "Auto", "automatic", "", "global_"] {
        assert!(serde_json::from_str::<RecallScope>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["STANDARD", "causal-chain", "causal", "", "standard_"] {
        assert!(serde_json::from_str::<RecallMode>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["Fact", "facts", "constraint ", "", "type"] {
        assert!(serde_json::from_str::<MemoryKind>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["PROJECT", "auto", "", "global_"] {
        assert!(serde_json::from_str::<MemoryScope>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["Auto", "PROJECT", "automatic", "", "g"] {
        assert!(serde_json::from_str::<MemoryScopeRequest>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["High", "MEDIUM", "h", "", "low " ] {
        assert!(serde_json::from_str::<MemoryCertainty>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["explicit tool", "EXPLICIT_TOOL", "tool", "", "session"] {
        assert!(serde_json::from_str::<MemoryWriteSource>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["CREATED", "created_", "create", "", "reinforce"] {
        assert!(serde_json::from_str::<RememberDisposition>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["Success", "SUCCESS", "ok", "", "failed"] {
        assert!(serde_json::from_str::<MemoryOutcomeSignal>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["Clean", "CLEAN", "close", "", "abort"] {
        assert!(serde_json::from_str::<MemorySessionEndReason>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["invalid options", "INVALID_OPTIONS", "invalid", "", "busy"] {
        assert!(serde_json::from_str::<MemoryPluginErrorCode>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["invalid request", "INVALID_REQUEST", "invalid", "", "unavailable_"] {
        assert!(serde_json::from_str::<MemoryHostErrorCode>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["memory entry", "MEMORY_ENTRY", "entry", "", "operation"] {
        assert!(serde_json::from_str::<MemoryHostIdKind>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["Debug", "DEBUG", "verbose", "", "err"] {
        assert!(serde_json::from_str::<MemoryPluginLogLevel>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["extract learnings", "EXTRACT_LEARNINGS", "extract", "", "consolidate_"] {
        assert!(serde_json::from_str::<MemoryCompletionPurpose>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["Task", "TASK", "todo", "", "decision_"] {
        assert!(serde_json::from_str::<StateObjectKindDto>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
    for raw in ["Active", "ACTIVE", "on", "", "soft_"] {
        assert!(serde_json::from_str::<StateTierDto>(&format!("\"{raw}\"")).is_err(), "{raw}");
    }
}

// ================================================================ payload enums

#[test]
fn payload_enums_serialize_to_exact_type_data_adjacent_objects() {
    let opts = MemoryOpenOptions::BuiltinSqlite(BuiltinSqliteOpenOptions {
        db_path: "/home/user/.praana/memory.db".into(),
        extraction: true,
        digest_max_tokens: 1600,
        recall_limit: 10,
        llm_contradictions: false,
    });
    assert_eq!(
        serde_json::to_value(&opts).unwrap(),
        json!({"type": "builtin_sqlite", "data": {
            "db_path": "/home/user/.praana/memory.db",
            "extraction": true,
            "digest_max_tokens": 1600,
            "recall_limit": 10,
            "llm_contradictions": false
        }})
    );
    let kind = VisibleTranscriptKind::ToolObservation {
        tool_call_id: ToolCallId::from_str_canonical("toolcall_01").unwrap(),
        tool_name: "read_file".into(),
        display_label: "summary.md".into(),
        redacted_preview: "# Summary".into(),
        artifact: None,
        is_error: false,
    };
    assert_eq!(
        serde_json::to_value(&kind).unwrap(),
        json!({"type": "tool_observation", "data": {
            "tool_call_id": "toolcall_01",
            "tool_name": "read_file",
            "display_label": "summary.md",
            "redacted_preview": "# Summary",
            "artifact": null,
            "is_error": false
        }})
    );
    assert_eq!(
        serde_json::to_value(&VisibleTranscriptKind::UserText { text: "hi".into() }).unwrap(),
        json!({"type": "user_text", "data": {"text": "hi"}})
    );
}

#[test]
fn payload_enums_reject_every_non_adjacent_tag_shape() {
    let bad = [
        r#"{"kind":"builtin_sqlite","value":{}}"#,
        r#"{"BuiltinSqlite":{}}"#,
        r#"{"type":"builtin_sqlite"}"#,
        r#"{"type":"builtin_sqlite","data":{},"extra":1}"#,
        r#"{"type":"something_else","data":{}}"#,
        r#"{"type":"builtin_sqlite","data":{},"data":{}}"#,
        r#"builtin_sqlite"#,
        r#"["builtin_sqlite",{}]"#,
        r#"{}"#,
        r#"null"#,
    ];
    for raw in bad {
        assert!(
            serde_json::from_str::<MemoryOpenOptions>(raw).is_err(),
            "OpenOptions accepted {raw}"
        );
    }
    let bad_kind = [
        r#"{"kind":"user_text","value":{"text":"hi"}}"#,
        r#"{"UserText":{"text":"hi"}}"#,
        r#"{"type":"user_text"}"#,
        r#"{"type":"user_text","data":{"text":"hi"},"extra":1}"#,
        r#"{"type":"user_text","data":{"text":"hi"},"data":{"text":"hi"}}"#,
        r#"{"type":"nonsense","data":{"text":"hi"}}"#,
        r#"{"type":"user_text","data":{"wrong":"hi"}}"#,
        r#"{"type":"tool_observation","data":{"tool_call_id":"tc","tool_name":"x","display_label":"y","redacted_preview":"z","artifact":null,"is_error":false,"extra":1}}"#,
        r#"{"type":"assistant_text","data":{}}"#,
    ];
    for raw in bad_kind {
        assert!(
            serde_json::from_str::<VisibleTranscriptKind>(raw).is_err(),
            "VisibleTranscriptKind accepted {raw}"
        );
    }
}

// ================================================================ strict decoder

fn open_request_json() -> String {
    r#"{"api_version":1,"dto_schema_version":1,"plugin_id":"builtin:sqlite","options":{"type":"builtin_sqlite","data":{"db_path":"/home/user/.praana/memory.db","extraction":true,"digest_max_tokens":1600,"recall_limit":10,"llm_contradictions":false}},"runtime":{"praana_version":"0.1.0","implementation":"rust","os":"linux","arch":"x86_64"}}"#.to_owned()
}

fn assert_decode_err<T: DeserializeOwned + JsonSchema>(raw: &str) {
    match decode_dto::<T>(raw.as_bytes()) {
        Ok(_) => panic!("decoder must reject: {raw}"),
        Err(e) => println!("REJECTED ({:?}): {}", e.kind, e.message),
    }
}

#[test]
fn decoder_rejects_duplicate_object_keys() {
    let dup = open_request_json().replacen(r#""api_version":1"#, r#""api_version":1,"api_version":1"#, 1);
    let err = decode_dto::<MemoryOpenRequest>(dup.as_bytes()).unwrap_err();
    assert_eq!(err.kind, MemoryDecodeErrorKind::DuplicateKey);
    let dup_nested = open_request_json().replacen(r#""os":"linux""#, r#""os":"linux","os":"linux""#, 1);
    assert!(decode_dto::<MemoryOpenRequest>(dup_nested.as_bytes()).is_err());
}

#[test]
fn decoder_rejects_unknown_fields() {
    let raw = open_request_json().replacen(r#""runtime":"#, r#""extra":1,"runtime":"#, 1);
    assert_decode_err::<MemoryOpenRequest>(&raw);
}

#[test]
fn decoder_rejects_unknown_payload_tags() {
    let raw = r#"{"type":"mystery","data":{}}"#;
    assert_decode_err::<MemoryOpenOptions>(raw);
    let raw = r#"{"type":"tool_observation","data":{"tool_call_id":"tc","tool_name":"x","display_label":"y","redacted_preview":"z","artifact":null,"is_error":false,"extra":1}}"#;
    assert_decode_err::<VisibleTranscriptKind>(raw);
}

#[test]
fn decoder_rejects_missing_properties() {
    let mut value = fixtures::open_request();
    value.as_object_mut().unwrap().remove("runtime");
    let raw = serde_json::to_string(&value).unwrap();
    assert_decode_err::<MemoryOpenRequest>(&raw);
    // Missing Option keys are also rejected (they are required on input).
    let mut value = fixtures::session_context();
    value.as_object_mut().unwrap().remove("project_label");
    let raw = serde_json::to_string(&value).unwrap();
    assert_decode_err::<MemorySessionContext>(&raw);
}

#[test]
fn decoder_rejects_null_for_non_option_fields() {
    let raw = open_request_json().replacen(r#""plugin_id":"builtin:sqlite""#, r#""plugin_id":null"#, 1);
    assert_decode_err::<MemoryOpenRequest>(&raw);
}

#[test]
fn decoder_rejects_nul_in_strings() {
    let raw = open_request_json().replacen(r#""plugin_id":"builtin:sqlite""#, r#""plugin_id":"bad\u0000id""#, 1);
    let err = decode_dto::<MemoryOpenRequest>(raw.as_bytes()).unwrap_err();
    assert_eq!(err.kind, MemoryDecodeErrorKind::NulString);
    let raw = open_request_json().replacen(
        r#""plugin_id":"builtin:sqlite""#,
        &format!(r#""plugin_id":"bad{}id""#, "\0"),
        1,
    );
    assert!(decode_dto::<MemoryOpenRequest>(raw.as_bytes()).is_err());
}

#[test]
fn decoder_rejects_nan_and_infinity() {
    let raw = open_request_json().replacen(r#""api_version":1"#, r#""api_version":1e999"#, 1);
    assert_decode_err::<MemoryOpenRequest>(&raw);
    let raw = r#"{"id":"01HNDKSZ28HM8HEE7QV4YSR5S4","kind":"fact","content":"x","scope":"project","validity":1e400,"usefulness":0.5,"match_score":0.5,"rank_score":0.5,"pinned":false,"evidence":[]}"#;
    assert_decode_err::<RecalledMemory>(raw);
    let raw = r#"{"id":"01HNDKSZ28HM8HEE7QV4YSR5S4","kind":"fact","content":"x","scope":"project","validity":0.5,"usefulness":0.5,"match_score":0.5,"rank_score":0.5,"pinned":false,"evidence":[]}"#;
    decode_dto::<RecalledMemory>(raw.as_bytes()).unwrap();
}

#[test]
fn decoder_never_panics_on_malformed_input() {
    let raws: Vec<&[u8]> = vec![b"", b"{", b"}", b"[]", b"\xff\xfe", b"not json", b"{\"a\":}", b"tru"];
    for raw in raws {
        let result = std::panic::catch_unwind(|| {
            decode_dto::<MemoryOpenRequest>(raw).map(|_| ())
        });
        assert!(result.is_ok(), "decoder panicked on {:?}", String::from_utf8_lossy(raw));
        if let Ok(Err(_)) = result {
            // expected
        }
    }
}

// ================================================================ validation bounds

fn at_len(n: usize) -> String {
    "a".repeat(n)
}

#[test]
fn manifest_bounds_hold_at_limit_and_fail_one_over() {
    let valid = || MemoryPluginManifest {
        id: "builtin:sqlite".into(),
        display_name: "Builtin SQLite".into(),
        plugin_version: "0.1.0".into(),
        api_version: MEMORY_API_VERSION,
        dto_schema_version: 1,
    };
    valid().validate().unwrap();
    assert!(valid().validate().is_ok());
    let mut m = valid();
    m.api_version = 2;
    assert!(m.validate().is_err());
    let mut m = valid();
    m.dto_schema_version = 2;
    assert!(m.validate().is_err());
    let mut m = valid();
    m.id = "builtin:sqlite".repeat(6); // 90 chars > 64
    assert!(m.validate().is_err());
    let mut m = valid();
    m.id = "a".repeat(64);
    assert!(m.validate().is_ok());
    let mut m = valid();
    m.id = "a".repeat(65);
    assert!(m.validate().is_err());
    let mut m = valid();
    m.id = "BadId".to_owned();
    assert!(m.validate().is_err());
    let mut m = valid();
    m.id = ":starts-with-colon".to_owned();
    assert!(m.validate().is_err());
    let mut m = valid();
    m.id = "1digit".to_owned();
    assert!(m.validate().is_ok());
    let mut m = valid();
    m.id = "has_underscore.dash:colon".to_owned();
    assert!(m.validate().is_ok());
    let mut m = valid();
    m.id = "has space".to_owned();
    assert!(m.validate().is_err());
}

#[test]
fn api_and_dto_schema_version_helpers_are_exact() {
    assert!(api_version_matches(MEMORY_API_VERSION));
    assert!(!api_version_matches(0));
    assert!(!api_version_matches(2));
    assert!(dto_schema_version_matches(1));
    assert!(!dto_schema_version_matches(0));
    assert!(!dto_schema_version_matches(2));
}

#[test]
fn session_context_bounds_hold_at_limit_and_fail_one_over() {
    let valid = || MemorySessionContext {
        session_id: fixtures::SESSION.parse().unwrap(),
        invocation_id: at_len(128),
        started_at_ms: 0,
        agent_scope: "agent:praana".into(),
        user_scope: "user:x".into(),
        project_scope: None,
        project_label: None,
        cwd_label: "€".repeat(128),
    };
    valid().validate().unwrap();
    let mut c = valid();
    c.invocation_id = at_len(129);
    assert!(c.validate().is_err());
    let mut c = valid();
    c.invocation_id = String::new();
    assert!(c.validate().is_err());
    let mut c = valid();
    c.cwd_label = "€".repeat(129);
    assert!(c.validate().is_err());
    let mut c = valid();
    c.cwd_label = "a".repeat(128);
    assert!(c.validate().is_ok());
}

#[test]
fn digest_content_bound_holds_at_limit_and_fails_one_over() {
    let valid = || MemoryDigest {
        format: MemoryDigestFormat::Markdown,
        content: at_len(65536),
        entry_ids: vec![fixtures::ENTRY.to_owned()],
        estimated_tokens: 100,
        token_estimator_schema_version: 1,
        estimator_id: "generic".into(),
        input_sha256: Sha256Digest::from_hex_str(&"a".repeat(64)).unwrap(),
    };
    valid().validate().unwrap();
    let mut d = valid();
    d.content = at_len(65537);
    assert!(d.validate().is_err());
}

#[test]
fn recall_query_bounds_hold_at_limit_and_fail_one_over() {
    let valid = || RecallQuery {
        query: at_len(2000),
        limit: 50,
        kinds: vec![MemoryKind::Fact, MemoryKind::Preference, MemoryKind::Decision, MemoryKind::Pattern, MemoryKind::Mistake, MemoryKind::Constraint],
        scope: RecallScope::Auto,
        mode: RecallMode::Standard,
    };
    valid().validate().unwrap();
    let mut q = valid();
    q.query = String::new();
    assert!(q.validate().is_err());
    let mut q = valid();
    q.query = at_len(2001);
    assert!(q.validate().is_err());
    let mut q = valid();
    q.limit = 0;
    assert!(q.validate().is_err());
    let mut q = valid();
    q.limit = 51;
    assert!(q.validate().is_err());
    let mut q = valid();
    q.kinds = vec![MemoryKind::Fact; 6];
    assert!(q.validate().is_ok(), "duplicate kinds are allowed; only the unique set is bounded");
    // Only six kinds exist, so more than six unique kinds is unrepresentable;
    // duplicates do not count toward the unique set.
    let mut q = valid();
    q.kinds = vec![MemoryKind::Fact, MemoryKind::Preference, MemoryKind::Decision, MemoryKind::Pattern, MemoryKind::Mistake, MemoryKind::Constraint, MemoryKind::Fact];
    assert!(q.validate().is_ok(), "six unique kinds is the max");
}

#[test]
fn recalled_memory_scores_must_be_in_0_1() {
    let valid = || RecalledMemory {
        id: fixtures::ENTRY.to_owned(),
        kind: MemoryKind::Fact,
        content: "x".into(),
        scope: MemoryScope::Project,
        validity: 1.0,
        usefulness: 1.0,
        match_score: 1.0,
        rank_score: 1.0,
        pinned: false,
        evidence: vec![],
    };
    valid().validate().unwrap();
    let mut r = valid();
    r.validity = 1.0001;
    assert!(r.validate().is_err());
    let mut r = valid();
    r.usefulness = -0.01;
    assert!(r.validate().is_err());
    let mut r = valid();
    r.match_score = 1.0001;
    assert!(r.validate().is_err());
    let mut r = valid();
    r.rank_score = -0.0001;
    assert!(r.validate().is_err());
}

#[test]
fn remember_content_bounds_hold_at_limit_and_fail_one_over() {
    let valid = || RememberInput {
        content: at_len(2000),
        kind: MemoryKind::Fact,
        certainty: MemoryCertainty::Medium,
        scope: MemoryScope::Global,
        pinned: false,
        source: MemoryWriteSource::ExplicitTool,
        evidence: vec![],
    };
    valid().validate().unwrap();
    let mut r = valid();
    r.content = String::new();
    assert!(r.validate().is_err());
    let mut r = valid();
    r.content = at_len(2001);
    assert!(r.validate().is_err());
    let valid_tool = || RememberToolInput {
        content: at_len(2000),
        kind: MemoryKind::Fact,
        certainty: MemoryCertainty::Medium,
        scope: MemoryScopeRequest::Auto,
        pinned: false,
    };
    valid_tool().validate().unwrap();
    let mut t = valid_tool();
    t.content = at_len(2001);
    assert!(t.validate().is_err());
}

#[test]
fn feedback_used_ids_must_be_a_subset_of_recalled_ids() {
    let valid = || MemoryFeedback {
        turn_id: fixtures::TURN.parse().unwrap(),
        recalled_ids: vec![fixtures::ENTRY.to_owned(), "01HNDKSZ28HM8HEE7QV4YSR5S4".into()],
        used_ids: vec![fixtures::ENTRY.to_owned()],
        outcome: MemoryOutcomeSignal::Success,
    };
    valid().validate().unwrap();
    let mut f = valid();
    f.used_ids = vec!["01HNDKSZ28HM8HEE7QV4YSR5S5".into()];
    assert!(f.validate().is_err());
}

#[test]
fn session_end_sequence_and_summary_count_bounds_hold_at_limit_and_fail_one_over() {
    let valid = || MemorySessionEnd {
        session_id: fixtures::SESSION.parse().unwrap(),
        through_sequence: 97,
        ended_at_ms: 0,
        reason: MemorySessionEndReason::Clean,
        outcome: MemoryOutcomeSignal::Success,
        transcript: vec![VisibleTranscriptItem {
            sequence: 97,
            event_id: fixtures::EVENT.parse().unwrap(),
            turn_id: None,
            kind: VisibleTranscriptKind::UserText { text: "hi".into() },
            timestamp_ms: 0,
        }],
        final_state_graph: StateGraphSnapshotDto {
            at_event_sequence: 97,
            objects: vec![],
            focused_id: None,
        },
        artifact_summaries: (0..100).map(|i| RedactedArtifactSummaryDto {
            artifact_id: fixtures::ARTIFACT.parse().unwrap(),
            producing_event_id: fixtures::EVENT.parse().unwrap(),
            tool_name: "read_file".into(),
            display_label: "f".into(),
            content_type: "text/plain".into(),
            redacted_summary: "s".into(),
            access_count: i,
        }).collect(),
    };
    valid().validate().unwrap();
    let mut e = valid();
    e.transcript[0].sequence = 98;
    assert!(e.validate().is_err());
    let mut e = valid();
    e.final_state_graph.at_event_sequence = 98;
    assert!(e.validate().is_err());
    let mut e = valid();
    e.artifact_summaries.push(e.artifact_summaries[0].clone());
    assert!(e.validate().is_err());
}

#[test]
fn error_message_caps_hold_at_limit_and_fail_one_over() {
    let valid = || MemoryPluginError {
        code: MemoryPluginErrorCode::Internal,
        message: at_len(1000),
        retryable: false,
    };
    valid().validate().unwrap();
    let mut e = valid();
    e.message = at_len(1001);
    assert!(e.validate().is_err());
    let valid_host = || MemoryHostError {
        code: MemoryHostErrorCode::Internal,
        message: at_len(1000),
        retryable: false,
    };
    valid_host().validate().unwrap();
    let mut e = valid_host();
    e.message = at_len(1001);
    assert!(e.validate().is_err());
}

#[test]
fn log_record_bounds_hold_at_limit_and_fail_one_over() {
    let valid = || MemoryPluginLogRecord {
        level: MemoryPluginLogLevel::Info,
        message: at_len(4096),
        fields: BTreeMap::from([("ok".to_owned(), json!(true))]),
    };
    valid().validate().unwrap();
    let mut r = valid();
    r.message = at_len(4097);
    assert!(r.validate().is_err());
    for bad in ["token_count", "Secret", "authorization_header", "cookie", "password", "credential"] {
        let mut r = valid();
        r.fields = BTreeMap::from([(bad.to_owned(), json!(1))]);
        assert!(r.validate().is_err(), "{bad}");
    }
    for ok in ["ok", "backend", "result", "entry_id", "user"] {
        let mut r = valid();
        r.fields = BTreeMap::from([(ok.to_owned(), json!(1))]);
        assert!(r.validate().is_ok(), "{ok}");
    }
}

#[test]
fn completion_request_bounds_hold_at_limit_and_fail_one_over() {
    let valid = || MemoryCompletionRequest {
        purpose: MemoryCompletionPurpose::ExtractLearnings,
        prompt_version: "v1".into(),
        system: at_len(262144 - 100),
        prompt: at_len(100),
        max_output_tokens: 4096,
        temperature_milli: 1000,
        response_schema: None,
        timeout_ms: 30000,
    };
    valid().validate().unwrap();
    let mut r = valid();
    r.system = at_len(262144 - 99);
    assert!(r.validate().is_err());
    let mut r = valid();
    r.max_output_tokens = 0;
    assert!(r.validate().is_err());
    let mut r = valid();
    r.max_output_tokens = 4097;
    assert!(r.validate().is_err());
    let mut r = valid();
    r.temperature_milli = 1001;
    assert!(r.validate().is_err());
    let mut r = valid();
    r.timeout_ms = 0;
    assert!(r.validate().is_err());
    let mut r = valid();
    r.timeout_ms = 30001;
    assert!(r.validate().is_err());
    let mut r = valid();
    r.response_schema = Some(json!("not-an-object"));
    assert!(r.validate().is_err());
    let mut r = valid();
    r.response_schema = Some(json!({"$ref": "http://example.com/schema.json"}));
    assert!(r.validate().is_err());
    let mut r = valid();
    r.response_schema = Some(json!({"$ref": "#/$defs/x"}));
    assert!(r.validate().is_ok());
    // Object root with 16 nested arrays: the deepest value sits at depth 17 -> rejected.
    let mut r = valid();
    let deep = serde_json::from_str::<Value>(&format!(r#"{{"a":{}0{}}}"#, "[".repeat(16), "]".repeat(16))).unwrap();
    r.response_schema = Some(deep);
    assert!(r.validate().is_err());
    // 15 nested arrays: deepest value at depth 16 -> accepted.
    let mut r = valid();
    let deep = serde_json::from_str::<Value>(&format!(r#"{{"a":{}0{}}}"#, "[".repeat(15), "]".repeat(15))).unwrap();
    r.response_schema = Some(deep);
    assert!(r.validate().is_ok());
    // Exact 65536 canonical bytes accepted; one byte over rejected.
    let mut r = valid();
    r.response_schema = Some(json!({"s": at_len(65528)}));
    assert!(r.validate().is_ok());
    let mut r = valid();
    r.response_schema = Some(json!({"s": at_len(65529)}));
    assert!(r.validate().is_err());
}

#[test]
fn completion_response_bounds_hold_at_limit_and_fail_one_over() {
    let valid = || MemoryCompletionResponse {
        text: at_len(65536),
        model_label: at_len(256),
        input_tokens: None,
        output_tokens: None,
    };
    valid().validate().unwrap();
    let mut r = valid();
    r.text = at_len(65537);
    assert!(r.validate().is_err());
    let mut r = valid();
    r.model_label = at_len(257);
    assert!(r.validate().is_err());
}

#[test]
fn state_dto_size_bounds_hold_at_limit_and_fail_one_over() {
    // Per-object 4 KiB and snapshot 256 KiB canonical caps.
    let base_object = || StateObjectDto {
        id: fixtures::STATE.parse().unwrap(),
        kind: StateObjectKindDto::Task,
        tier: StateTierDto::Active,
        status: None,
        title: None,
        text: String::new(),
        rationale: None,
        retracted: false,
        updated_at_ms: 0,
    };
    let base_len = to_canonical_json_bytes(&base_object()).unwrap().len();
    let text_for_exact = |cap: usize| at_len(cap - base_len);
    let obj = StateObjectDto { text: text_for_exact(4096), ..base_object() };
    assert_eq!(to_canonical_json_bytes(&obj).unwrap().len(), 4096);
    obj.validate().unwrap();
    let over = StateObjectDto { text: text_for_exact(4096) + "a", ..base_object() };
    assert!(over.validate().is_err());

    let snapshot_base = || StateGraphSnapshotDto {
        at_event_sequence: 0,
        objects: vec![obj.clone()],
        focused_id: None,
    };
    let base_len = to_canonical_json_bytes(&snapshot_base()).unwrap().len();
    let pad = at_len(262144 - base_len);
    let mut snap = snapshot_base();
    snap.objects[0].text.push_str(&pad);
    assert_eq!(to_canonical_json_bytes(&snap).unwrap().len(), 262144);
    snap.validate().unwrap();
    let mut over = snap.clone();
    over.objects[0].text.push('a');
    assert!(over.validate().is_err());
}

#[test]
fn artifact_summary_size_bound_holds_at_limit_and_fails_one_over() {
    let base = || RedactedArtifactSummaryDto {
        artifact_id: fixtures::ARTIFACT.parse().unwrap(),
        producing_event_id: fixtures::EVENT.parse().unwrap(),
        tool_name: "read_file".into(),
        display_label: "f".into(),
        content_type: "text/plain".into(),
        redacted_summary: String::new(),
        access_count: 0,
    };
    let base_len = to_canonical_json_bytes(&base()).unwrap().len();
    let s = RedactedArtifactSummaryDto { redacted_summary: at_len(2048 - base_len), ..base() };
    assert_eq!(to_canonical_json_bytes(&s).unwrap().len(), 2048);
    s.validate().unwrap();
    let over = RedactedArtifactSummaryDto { redacted_summary: at_len(2048 - base_len + 1), ..base() };
    assert!(over.validate().is_err());
}

// ================================================================ trait shape

struct StubPlugin;

#[async_trait]
impl MemoryPlugin for StubPlugin {
    fn manifest(&self) -> MemoryPluginManifest {
        MemoryPluginManifest {
            id: "stub".into(),
            display_name: "Stub".into(),
            plugin_version: "0.0.0".into(),
            api_version: MEMORY_API_VERSION,
            dto_schema_version: 1,
        }
    }

    async fn open(
        &self,
        _request: MemoryOpenRequest,
        _host: Arc<dyn MemoryPluginHost>,
        _cancel: CancellationToken,
    ) -> Result<Box<dyn MemorySession>, MemoryPluginError> {
        Ok(Box::new(StubSession))
    }
}

struct StubSession;

#[async_trait]
impl MemorySession for StubSession {
    fn capabilities(&self) -> MemoryCapabilities {
        MemoryCapabilities {
            recall: true,
            remember: false,
            retract: false,
            pin: false,
            feedback: false,
            startup_digest: false,
            session_end_learning: false,
            consolidation: false,
            semantic_recall: false,
        }
    }

    async fn start(
        &mut self,
        _input: MemorySessionStart,
        _cancel: CancellationToken,
    ) -> Result<MemoryBootstrap, MemoryPluginError> {
        Ok(MemoryBootstrap {
            invocation_ordinal: 1,
            digest: None,
            notices: vec![],
        })
    }

    async fn recall(
        &mut self,
        _input: RecallQuery,
        _cancel: CancellationToken,
    ) -> Result<RecallResult, MemoryPluginError> {
        Ok(RecallResult { entries: vec![], notice: None })
    }

    async fn remember(
        &mut self,
        _input: RememberInput,
        _cancel: CancellationToken,
    ) -> Result<RememberResult, MemoryPluginError> {
        Ok(RememberResult { id: "x".into(), disposition: RememberDisposition::Created })
    }

    async fn retract(
        &mut self,
        _input: RetractMemoryInput,
        _cancel: CancellationToken,
    ) -> Result<RetractMemoryResult, MemoryPluginError> {
        Ok(RetractMemoryResult { id: "x".into(), retracted: false })
    }

    async fn pin(
        &mut self,
        _input: PinMemoryInput,
        _cancel: CancellationToken,
    ) -> Result<PinMemoryResult, MemoryPluginError> {
        Ok(PinMemoryResult { id: "x".into(), pinned: false })
    }

    async fn feedback(
        &mut self,
        _input: MemoryFeedback,
        _cancel: CancellationToken,
    ) -> Result<MemoryFeedbackResult, MemoryPluginError> {
        Ok(MemoryFeedbackResult { accepted_ids: vec![] })
    }

    async fn end(
        &mut self,
        _input: MemorySessionEnd,
        _cancel: CancellationToken,
    ) -> Result<MemorySessionEndResult, MemoryPluginError> {
        Ok(MemorySessionEndResult {
            learnings_created: 0,
            memories_reinforced: 0,
            memories_retracted: 0,
            memories_consolidated: 0,
            notices: vec![],
        })
    }

    async fn stats(
        &self,
        _cancel: CancellationToken,
    ) -> Result<MemoryStats, MemoryPluginError> {
        Ok(MemoryStats {
            plugin_id: "stub".into(),
            plugin_version: "0.0.0".into(),
            entries_active: 0,
            entries_retracted: 0,
            entries_pinned: 0,
            entries_project: 0,
            entries_global: 0,
            storage_bytes: None,
            last_maintenance_at_ms: None,
        })
    }

    async fn close(
        self: Box<Self>,
        _cancel: CancellationToken,
    ) -> Result<(), MemoryPluginError> {
        Ok(())
    }
}

struct StubHost;

#[async_trait]
impl MemoryPluginHost for StubHost {
    fn capabilities(&self) -> MemoryHostCapabilities {
        MemoryHostCapabilities { llm_completion: true, completion_json_schema: true }
    }

    fn now_ms(&self) -> i64 {
        0
    }

    fn new_id(&self, kind: MemoryHostIdKind) -> String {
        match kind {
            MemoryHostIdKind::MemoryEntry => "memory_entry_1".into(),
            MemoryHostIdKind::PluginOperation => "plugin_operation_1".into(),
        }
    }

    fn log(&self, record: MemoryPluginLogRecord) {
        assert_eq!(record.level, MemoryPluginLogLevel::Debug);
    }

    async fn complete(
        &self,
        _request: MemoryCompletionRequest,
        _cancel: CancellationToken,
    ) -> Result<MemoryCompletionResponse, MemoryHostError> {
        Ok(MemoryCompletionResponse {
            text: "[]".into(),
            model_label: "stub".into(),
            input_tokens: Some(1),
            output_tokens: Some(1),
        })
    }
}

#[tokio::test]
async fn traits_are_object_safe_and_close_works_through_the_trait_object() {
    let plugin = StubPlugin;
    let host: Arc<dyn MemoryPluginHost> = Arc::new(StubHost);
    assert_eq!(plugin.manifest().api_version, MEMORY_API_VERSION);

    let request = MemoryOpenRequest {
        api_version: MEMORY_API_VERSION,
        dto_schema_version: 1,
        plugin_id: "stub".into(),
        options: MemoryOpenOptions::BuiltinSqlite(BuiltinSqliteOpenOptions {
            db_path: "/tmp/stub.db".into(),
            extraction: true,
            digest_max_tokens: 1000,
            recall_limit: 5,
            llm_contradictions: false,
        }),
        runtime: MemoryRuntimeInfo {
            praana_version: "0.1.0".into(),
            implementation: "rust".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
        },
    };

    let mut session: Box<dyn MemorySession> = plugin
        .open(request, host.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert!(session.capabilities().recall);
    let start = MemorySessionStart {
        session: MemorySessionContext {
            session_id: fixtures::SESSION.parse().unwrap(),
            invocation_id: "op_1".into(),
            started_at_ms: 0,
            agent_scope: "agent:praana".into(),
            user_scope: "user:x".into(),
            project_scope: None,
            project_label: None,
            cwd_label: "dir".into(),
        },
        state_graph: StateGraphSnapshotDto {
            at_event_sequence: 0,
            objects: vec![],
            focused_id: None,
        },
    };
    let boot = session.start(start, CancellationToken::new()).await.unwrap();
    assert_eq!(boot.invocation_ordinal, 1);
    let stats = session.stats(CancellationToken::new()).await.unwrap();
    assert_eq!(stats.plugin_id, "stub");
    host.log(MemoryPluginLogRecord {
        level: MemoryPluginLogLevel::Debug,
        message: "log".into(),
        fields: BTreeMap::new(),
    });
    let complete = host
        .complete(
            MemoryCompletionRequest {
                purpose: MemoryCompletionPurpose::ExtractLearnings,
                prompt_version: "v1".into(),
                system: String::new(),
                prompt: "prompt".into(),
                max_output_tokens: 10,
                temperature_milli: 0,
                response_schema: None,
                timeout_ms: 1000,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(complete.text, "[]");
    assert_eq!(host.new_id(MemoryHostIdKind::MemoryEntry), "memory_entry_1");
    session.close(CancellationToken::new()).await.unwrap();
}


