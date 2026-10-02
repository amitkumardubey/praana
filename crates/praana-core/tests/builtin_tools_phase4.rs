//! P4A history built-in tools. Expected red until `tools/builtin/history.rs` exists.

use std::fs;
use std::path::PathBuf;

use praana_core::config::types::{CircuitConfig, RiskConfig, ToolsConfig};
use praana_core::history::db::HistoryDatabase;
use praana_core::history::event_log::{
    write_new_session_meta, EMPTY_PROJECT_CONTEXT_SOURCE_SHA256,
};
use praana_core::protocol::id::*;
use praana_core::protocol::tool_result::ToolResultStatus;
use praana_core::tools::builtin::history::{
    phase4_history_tools, register_phase4_history, ReadSessionSourceInput, ReadSessionSourceOutput,
    RetrieveArtifactOutput, SearchSessionLogInput, SearchSessionLogOutput,
};
use praana_core::tools::{
    BatchOrigin, ProviderToolCall, ToolBatchRequest, ToolCallOrigin, ToolCapabilities,
    ToolErrorCode, ToolName, ToolRuntime,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const SESSION_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

fn ulid(suffix: &str) -> String {
    let mut id = String::from("01ARZ3NDEKTSV4RRFFQ69G5F");
    id.push_str(suffix);
    assert_eq!(id.len(), 26, "{id}");
    id
}

fn session_id() -> SessionId {
    SessionId::from_str_canonical(SESSION_ID).unwrap()
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("schemas/tools/v1")
}

fn tools_config() -> ToolsConfig {
    ToolsConfig {
        allowed_paths: Vec::new(),
        default_timeout_ms: 60_000,
        max_parallel_calls: 4,
        max_spawned_processes: 4,
        shell_enabled: false,
        shell_max_timeout_ms: 600_000,
        shell_timeout_ms: 30_000,
    }
}

#[test]
fn history_tool_descriptors_match_catalog() {
    let tools = phase4_history_tools().unwrap();
    let by_name: std::collections::BTreeMap<_, _> = tools
        .iter()
        .map(|tool| (tool.descriptor().name.as_str(), tool.descriptor()))
        .collect();
    assert_eq!(by_name.len(), 3);

    let search = by_name.get("search_session_log").unwrap();
    assert_eq!(search.order, 100);
    assert!(search.strict);
    assert_eq!(
        search.description,
        "Search accepted session history, audit events, artifacts, summaries, or StateGraph evidence with exact or FTS ranking."
    );
    assert!(search.capabilities.is_empty());

    let retrieve = by_name.get("retrieve_artifact").unwrap();
    assert_eq!(retrieve.order, 110);
    assert!(retrieve.strict);
    assert_eq!(
        retrieve.description,
        "Read a bounded immutable artifact by ID using one byte, line, grep, or JSON-pointer selection."
    );
    assert!(retrieve
        .capabilities
        .contains(ToolCapabilities::ARTIFACT_READ));

    let source = by_name.get("read_session_source").unwrap();
    assert_eq!(source.order, 120);
    assert!(source.strict);
    assert_eq!(
        source.description,
        "Read a bounded byte window of one event-sourced session search result by its result_id."
    );
    assert!(source.capabilities.is_empty());
}

#[test]
fn history_schema_snapshots_match() {
    let tools = phase4_history_tools().unwrap();
    let registry = register_phase4_history().unwrap();
    let descriptors = registry.catalog().descriptors();
    let history_descriptors: Vec<_> = descriptors
        .iter()
        .filter(|d| {
            d.name.as_str() == "search_session_log"
                || d.name.as_str() == "retrieve_artifact"
                || d.name.as_str() == "read_session_source"
        })
        .collect();
    assert_eq!(history_descriptors.len(), 3);

    let manifest: Value =
        serde_json::from_str(&fs::read_to_string(fixture_dir().join("manifest.json")).unwrap())
            .unwrap();
    let manifest_tools = manifest["tools"].as_array().unwrap();
    for descriptor in &history_descriptors {
        let input_name = format!(
            "{}-{}-input.json",
            descriptor.order,
            descriptor.name.as_str()
        );
        let output_name = format!(
            "{}-{}-output.json",
            descriptor.order,
            descriptor.name.as_str()
        );
        let input_snapshot = fs::read_to_string(fixture_dir().join(&input_name)).unwrap();
        let output_snapshot = fs::read_to_string(fixture_dir().join(&output_name)).unwrap();
        assert_eq!(
            input_snapshot,
            serde_json::to_string_pretty(&descriptor.input_schema).unwrap() + "\n"
        );
        assert_eq!(
            output_snapshot,
            serde_json::to_string_pretty(&descriptor.output_schema).unwrap() + "\n"
        );
        let row = manifest_tools
            .iter()
            .find(|row| row["name"] == descriptor.name.as_str())
            .unwrap();
        assert_eq!(row["order"], descriptor.order);
        assert_eq!(
            row["description_sha256"],
            Sha256Digest::digest_bytes(descriptor.description.as_bytes()).as_str()
        );
        assert_eq!(row["strict"], true);
        let _ = tools;
    }
}

#[tokio::test]
async fn search_session_log_tool_executes() {
    let dir = tempfile::tempdir().unwrap();
    let session = dir.path().join("session");
    fs::create_dir_all(&session).unwrap();
    write_new_session_meta(
        &session,
        &session_id(),
        &Sha256Digest::from_hex_str(EMPTY_PROJECT_CONTEXT_SOURCE_SHA256).unwrap(),
    )
    .unwrap();
    // A real session always owns its database; the read-only history tools
    // never create one.
    drop(HistoryDatabase::open(&session.join("history.db")).unwrap());

    let registry = register_phase4_history().unwrap();
    let rt = ToolRuntime::new(
        registry,
        tools_config(),
        RiskConfig { allow: Vec::new() },
        CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
    );
    rt.set_workspace(dir.path().to_path_buf());
    rt.set_session(session.clone(), session_id());

    let request = ToolBatchRequest {
        batch_id: ToolBatchId::from_str_canonical(&ulid("B1")).unwrap(),
        session_id: session_id(),
        turn_id: TurnId::from_str_canonical(&ulid("T1")).unwrap(),
        attempt_id: AttemptId::from_str_canonical(&ulid("AT")).unwrap(),
        calls: vec![ProviderToolCall {
            tool_call_id: ToolCallId::from_str_canonical("call_001").unwrap(),
            tool_name: ToolName::new("search_session_log").unwrap(),
            arguments: json!({"query": "hello"}),
            provider_ordinal: 0,
        }],
        origin: ToolCallOrigin::Model,
    };
    let results = rt
        .execute_batch(request, BatchOrigin::Model, CancellationToken::new())
        .await
        .expect("batch")
        .results;
    assert_eq!(results.len(), 1);
    let finished = &results[0];
    assert_eq!(finished.status, ToolResultStatus::Error);
    // The session has no projected history yet, so the storage layer reports
    // the missing `history_derived` checkpoint; catalog §6.4 maps it to
    // ToolInternal with the Appendix A.4 canonical code in details.
    let error = finished.dto.error.as_ref().expect("history tool error");
    assert_eq!(error.code, ToolErrorCode::ToolInternal);
    assert!(!error.retryable);
    let details = error.details.as_ref().expect("catalog 6.4 details");
    assert_eq!(
        details.get("history_code").and_then(Value::as_str),
        Some("HISTORY_EVENT_INTEGRITY")
    );
    assert_eq!(
        details.get("canonical_code").and_then(Value::as_str),
        Some("E_SESSION_INTEGRITY_FAILED")
    );
}

#[test]
fn history_tool_dto_defaults_and_shapes() {
    let input: SearchSessionLogInput = serde_json::from_value(json!({"query": "hello"})).unwrap();
    assert_eq!(input.limit, 20);
    assert!(input.mode.is_none());
    assert!(!input.case_sensitive);
    assert!(input.cursor.is_none());
    assert!(input.state_ids.is_empty());
    assert!(!input.include_prior_epochs);

    let source: ReadSessionSourceInput =
        serde_json::from_value(json!({"result_id": ulid("E1")})).unwrap();
    assert_eq!(source.byte_offset, 0);

    let page: SearchSessionLogOutput = serde_json::from_value(json!({
        "page": {"projection_through_sequence": 0, "results": [], "next_cursor": null}
    }))
    .unwrap();
    assert!(page.page.results.is_empty());

    let artifact: RetrieveArtifactOutput = serde_json::from_value(json!({
        "artifact": {
            "artifact_id": ulid("A1"),
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "selector": "default",
            "content": {"encoding": "utf8", "data": "x"},
            "returned_bytes": 1,
            "complete": true,
            "selected_line_start": null,
            "selected_line_end": null,
            "total_lines": null,
            "matches": [],
            "continuation": null
        }
    }))
    .unwrap();
    assert!(artifact.artifact.complete);

    let source_out: ReadSessionSourceOutput = serde_json::from_value(json!({
        "source": {
            "result_id": ulid("E2"),
            "source_kind": "event",
            "source_field": "arguments",
            "event_id": null,
            "event_sequence": null,
            "turn_id": null,
            "content_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "text": "x",
            "byte_offset": 0,
            "returned_bytes": 1,
            "total_bytes": 1,
            "start_line": 1,
            "end_line": 1,
            "total_lines": 1,
            "complete": true,
            "continuation": null
        }
    }))
    .unwrap();
    assert_eq!(source_out.source.total_lines, 1);
}

#[test]
fn history_error_mapping_details_and_class() {
    use praana_core::tools::error::map_history_error;

    let mapped = map_history_error("HISTORY_SEARCH_QUERY");
    assert_eq!(mapped.canonical_code, "E_HISTORY_QUERY_INVALID");
    assert_eq!(
        mapped.status,
        praana_core::protocol::tool_result::ToolResultStatus::Error
    );

    let mapped = map_history_error("HISTORY_SEARCH_CURSOR_STALE");
    assert_eq!(mapped.canonical_code, "E_HISTORY_CURSOR_STALE");
    assert!(mapped.retryable);

    let mapped = map_history_error("HISTORY_CANCELLED");
    assert_eq!(mapped.canonical_code, "E_HISTORY_CANCELLED");

    let mapped = map_history_error("HISTORY_SQLITE_BUSY");
    assert_eq!(mapped.canonical_code, "E_HISTORY_BUSY");

    let mapped = map_history_error("HISTORY_ARTIFACT_NOT_FOUND");
    assert_eq!(mapped.canonical_code, "E_ARTIFACT_NOT_FOUND");
}

const STATE_TOOLS: &[(&str, u16, &str, bool)] = &[
    (
        "create_task",
        200,
        "Create a current-session task with status todo in the active StateGraph tier.",
        true,
    ),
    (
        "complete_task",
        210,
        "Mark one current-session task done and move it to the soft StateGraph tier.",
        true,
    ),
    (
        "retract_task",
        220,
        "Retract any current-session StateGraph object by ID with a reason; it remains searchable.",
        true,
    ),
    (
        "add_constraint",
        230,
        "Record a current-session constraint in the active StateGraph tier; strength defaults to hard.",
        true,
    ),
    (
        "decide",
        240,
        "Record a current-session decision with its rationale, optionally superseding an active decision.",
        true,
    ),
    (
        "add_note",
        250,
        "Record a semantic current-session note or finding, with optional lowercase tags.",
        true,
    ),
    (
        "soft_unload",
        260,
        "Move one StateGraph object to the soft tier; it stays listed and can be hydrated.",
        true,
    ),
    (
        "hard_unload",
        270,
        "Archive one StateGraph object to the hard tier; its content then requires hydrate.",
        true,
    ),
    (
        "hydrate",
        280,
        "Move one StateGraph object to the active tier and return its complete content.",
        true,
    ),
    (
        "list_state",
        290,
        "List current-session StateGraph objects with bounded summaries, filtered by kind, tier, and status.",
        false,
    ),
    (
        "focus_task",
        300,
        "Make one current StateGraph object the single focus, activating it if needed, and return its content.",
        true,
    ),
];

#[test]
fn state_tool_descriptors_match_catalog_and_schemas() {
    use praana_core::hooks::plan;
    use praana_core::tools::builtin::state::phase4_state_tools;
    use praana_core::tools::error::map_state_error;
    use praana_core::tools::intent::{ToolIdempotency, ToolInspectContext, ToolMutation};
    use praana_core::tools::ToolCapabilities;

    let tools = phase4_state_tools().unwrap();
    assert_eq!(tools.len(), STATE_TOOLS.len());
    let context = ToolInspectContext {
        cwd: PathBuf::from("/workspace/praana"),
        plan_mode: true,
    };
    for ((name, order, description, write), tool) in STATE_TOOLS.iter().zip(tools.iter()) {
        let descriptor = tool.descriptor();
        assert_eq!(descriptor.name.as_str(), *name);
        assert_eq!(descriptor.order, *order);
        assert!(descriptor.strict);
        assert_eq!(descriptor.description, *description);
        if *write {
            assert!(descriptor
                .capabilities
                .contains(ToolCapabilities::STATE_WRITE));
        } else {
            assert!(descriptor
                .capabilities
                .contains(ToolCapabilities::STATE_READ));
        }
        let prepared = tool
            .parse_and_inspect(
                &if *name == "list_state" {
                    json!({})
                } else if *name == "create_task" {
                    json!({"title": "t"})
                } else if *name == "add_note" {
                    json!({"text": "n"})
                } else if *name == "add_constraint" {
                    json!({"text": "c"})
                } else if *name == "decide" {
                    json!({"summary": "s", "rationale": "r"})
                } else if *name == "retract_task" {
                    json!({"id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "reason": "why"})
                } else {
                    json!({"id": "01ARZ3NDEKTSV4RRFFQ69G5FAV"})
                },
                &context,
            )
            .unwrap();
        assert_eq!(prepared.intent.timeout_ms, 30_000);
        assert!(prepared.intent.path_accesses.is_empty());
        assert!(prepared.intent.command.is_none());
        plan::check(true, &prepared.intent).unwrap();
        if *write {
            assert_eq!(prepared.intent.mutation, ToolMutation::SessionState);
            assert_eq!(prepared.intent.idempotency, ToolIdempotency::NonIdempotent);
        } else {
            assert_eq!(prepared.intent.mutation, ToolMutation::ReadOnly);
            assert_eq!(prepared.intent.idempotency, ToolIdempotency::ReadOnly);
        }
        let root = fixture_dir();
        let input: Value = serde_json::from_str(
            &fs::read_to_string(root.join(format!("{order}-{name}-input.json"))).unwrap(),
        )
        .unwrap();
        let output: Value = serde_json::from_str(
            &fs::read_to_string(root.join(format!("{order}-{name}-output.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(descriptor.input_schema, input, "{name} input snapshot");
        assert_eq!(descriptor.output_schema, output, "{name} output snapshot");
        for key in [
            "title",
            "text",
            "reason",
            "summary",
            "description",
            "rationale",
            "tags",
        ] {
            let Some(prop) = descriptor.input_schema["properties"].get(key) else {
                continue;
            };
            assert!(prop.get("maxLength").is_none(), "{name}.{key}");
            assert!(prop.get("minLength").is_none(), "{name}.{key}");
            assert!(prop.get("pattern").is_none(), "{name}.{key}");
        }
        assert_required_in_properties(&descriptor.input_schema, name);
        assert_required_in_properties(&descriptor.output_schema, name);
    }
    let root = fixture_dir();
    for entry in fs::read_dir(&root).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let file_name = path.file_name().unwrap().to_string_lossy();
        if file_name == "manifest.json" {
            continue;
        }
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_required_in_properties(&value, &file_name);
    }
    let list = tools
        .iter()
        .find(|tool| tool.descriptor().name.as_str() == "list_state")
        .unwrap()
        .descriptor();
    let limit = &list.input_schema["properties"]["limit"];
    assert_eq!(limit["type"], json!("integer"));
    assert_eq!(limit["default"], json!(50));
    assert!(limit.get("minimum").is_none());
    assert!(limit.get("maximum").is_none());
    let note = tools
        .iter()
        .find(|tool| tool.descriptor().name.as_str() == "add_note")
        .unwrap()
        .descriptor();
    assert!(note.input_schema["properties"]["tags"]
        .get("pattern")
        .is_none());
    assert!(note.input_schema["properties"]["tags"]["items"]
        .get("maxLength")
        .is_none());

    let persistence = map_state_error("STATE_PERSISTENCE");
    assert!(!persistence.retryable);
    assert_eq!(persistence.canonical_code, "TOOL_INTERNAL");
    let conflict = map_state_error("STATE_REVISION_CONFLICT");
    assert!(conflict.retryable);
    assert_eq!(conflict.canonical_code, "TOOL_VALIDATION_FAILED");
    let missing = map_state_error("STATE_NOT_FOUND");
    assert!(!missing.retryable);
    assert_eq!(missing.canonical_code, "TOOL_VALIDATION_FAILED");
}

fn assert_required_in_properties(node: &Value, path: &str) {
    let Some(object) = node.as_object() else {
        return;
    };
    if let Some(required) = object.get("required").and_then(Value::as_array) {
        let properties = object.get("properties").and_then(Value::as_object);
        for name in required {
            let name = name.as_str().expect("required entry");
            assert!(
                properties.is_some_and(|properties| properties.contains_key(name)),
                "{path} required `{name}` is missing from properties"
            );
        }
    }
    for (key, child) in object {
        if matches!(key.as_str(), "oneOf" | "anyOf" | "allOf" | "prefixItems") {
            if let Some(items) = child.as_array() {
                for item in items {
                    assert_required_in_properties(item, path);
                }
            }
        } else if child.is_object() {
            assert_required_in_properties(child, path);
        }
    }
}
