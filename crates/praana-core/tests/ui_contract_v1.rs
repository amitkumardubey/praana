//! P1C focused test: permanent UI contract v1 fixture inventory and round-trips.
//!
//! Expected red reason before implementation: unresolved
//! `praana_core::ui_contract` imports.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use praana_core::ui_contract::setup::SensitiveStringDto;
use praana_core::ui_contract::transcript::{TranscriptEntryDto, TranscriptRoleDto};
use praana_core::ui_contract::{
    check_cursor_session_binding, command_wire_name, event_wire_name, expected_success_variant,
    memory_entry_allowed, validate_ui_event, CoreCommand, CoreCommandResult, UiEventRecord,
    ALL_COMMAND_KINDS, ALL_EVENT_KINDS, TRANSCRIPT_PROJECTION_SCHEMA_VERSION,
    UI_CONTRACT_SCHEMA_VERSION,
};
use sha2::{Digest, Sha256};

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ui_contract_v1")
}

fn read_json(path: &Path) -> serde_json::Value {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(hex_char(b >> 4));
        out.push(hex_char(b & 0x0F));
    }
    out
}

fn hex_char(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'a' + nibble - 10) as char,
    }
}

fn is_crockford_ulid(s: &str) -> bool {
    if s.len() != 26 {
        return false;
    }
    s.bytes().all(|b| {
        matches!(
            b,
            b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'T' | b'V'..=b'Z'
        )
    })
}

fn is_crockford_selector(s: &str) -> bool {
    if s.len() != 12 {
        return false;
    }
    s.bytes().all(|b| {
        matches!(
            b,
            b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'T' | b'V'..=b'Z'
        )
    })
}

fn is_lower_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(serde::Deserialize)]
struct UiFixtureManifest {
    ui_contract_schema_version: u32,
    command_files: Vec<String>,
    result_files: Vec<String>,
    event_files: Vec<String>,
    rejection_files: Vec<String>,
    mapping_file: String,
    sha256_by_file: BTreeMap<String, String>,
}

#[derive(serde::Deserialize)]
struct UiMappingFile {
    ui_contract_schema_version: u32,
    rows: Vec<UiMappingRow>,
}

#[derive(serde::Deserialize)]
struct UiMappingRow {
    direction: String,
    semantic_variant: String,
    ipc_dotted_name: String,
    ratatui_mapping: String,
}

#[derive(serde::Deserialize)]
struct UiRejectionFixture {
    target: String,
    input_json: String,
    expected_code: String,
}

fn load_manifest() -> (PathBuf, UiFixtureManifest) {
    let root = fixture_root();
    let bytes = fs::read(root.join("manifest.json")).expect("read manifest.json");
    let manifest: UiFixtureManifest = serde_json::from_slice(&bytes).expect("parse manifest.json");
    (root, manifest)
}

fn disk_files(root: &Path, dir: &str, ext: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for entry in fs::read_dir(root.join(dir)).expect("read fixture dir") {
        let entry = entry.expect("dir entry");
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(ext) {
            out.insert(format!("{dir}/{name}"));
        }
    }
    out
}

#[test]
fn schema_versions_are_one() {
    assert_eq!(UI_CONTRACT_SCHEMA_VERSION, 1);
    assert_eq!(TRANSCRIPT_PROJECTION_SCHEMA_VERSION, 1);
    let (_root, manifest) = load_manifest();
    assert_eq!(manifest.ui_contract_schema_version, 1);
}

#[test]
fn manifest_inventory_matches_disk() {
    let (root, manifest) = load_manifest();
    let disk_commands = disk_files(&root, "commands", ".json");
    let disk_results = disk_files(&root, "results", ".json");
    let mut disk_events = disk_files(&root, "events", ".json");
    for entry in fs::read_dir(root.join("events")).expect("read events dir") {
        let entry = entry.expect("dir entry");
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".jsonl") {
            disk_events.insert(format!("events/{name}"));
        }
    }
    let disk_rejections = disk_files(&root, "rejections", ".json");

    let listed_commands: BTreeSet<String> = manifest.command_files.into_iter().collect();
    let listed_results: BTreeSet<String> = manifest.result_files.into_iter().collect();
    let listed_events: BTreeSet<String> = manifest.event_files.into_iter().collect();
    let listed_rejections: BTreeSet<String> = manifest.rejection_files.into_iter().collect();

    assert_eq!(listed_commands, disk_commands, "command inventory mismatch");
    assert_eq!(listed_results, disk_results, "result inventory mismatch");
    assert_eq!(listed_events, disk_events, "event inventory mismatch");
    assert_eq!(
        listed_rejections, disk_rejections,
        "rejection inventory mismatch"
    );
    assert_eq!(manifest.mapping_file, "mapping.json");
}

#[test]
fn manifest_digests_match_disk_bytes() {
    let (root, manifest) = load_manifest();
    let mut checked = 0u32;
    for (file, expected) in &manifest.sha256_by_file {
        let bytes = fs::read(root.join(file)).unwrap_or_else(|e| panic!("read {file}: {e}"));
        assert_eq!(sha256_hex(&bytes), *expected, "digest mismatch for {file}");
        assert!(
            expected.len() == 64
                && expected
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
                        || matches!(b, b'0'..=b'9' | b'a'..=b'f')),
            "digest for {file} must be 64 lowercase hex"
        );
        checked += 1;
    }
    let total = manifest.command_files.len()
        + manifest.result_files.len()
        + manifest.event_files.len()
        + manifest.rejection_files.len()
        + 1;
    assert_eq!(
        checked as usize, total,
        "every listed file must be hash-checked"
    );
    // Manifest itself plus mapping.json are covered via sha entries for mapping;
    // manifest.json is the root of trust and is enumerated explicitly.
    assert!(
        manifest.sha256_by_file.contains_key("mapping.json"),
        "mapping.json must be hash-checked"
    );
}

#[test]
fn mapping_covers_every_command_and_event_kind() {
    let root = fixture_root();
    let bytes = fs::read(root.join("mapping.json")).expect("read mapping.json");
    let mapping: UiMappingFile = serde_json::from_slice(&bytes).expect("parse mapping.json");
    assert_eq!(mapping.ui_contract_schema_version, 1);

    let command_rows: Vec<&UiMappingRow> = mapping
        .rows
        .iter()
        .filter(|r| r.direction == "ui_to_core")
        .collect();
    let event_rows: Vec<&UiMappingRow> = mapping
        .rows
        .iter()
        .filter(|r| r.direction == "core_to_ui")
        .collect();
    assert_eq!(command_rows.len(), ALL_COMMAND_KINDS.len());
    assert_eq!(event_rows.len(), ALL_EVENT_KINDS.len());

    let mapped_commands: BTreeSet<&str> = command_rows
        .iter()
        .map(|r| r.semantic_variant.as_str())
        .collect();
    let expected_commands: BTreeSet<&str> = ALL_COMMAND_KINDS.iter().copied().collect();
    assert_eq!(mapped_commands, expected_commands);

    let mapped_events: BTreeSet<&str> = event_rows
        .iter()
        .map(|r| r.semantic_variant.as_str())
        .collect();
    let expected_events: BTreeSet<&str> = ALL_EVENT_KINDS.iter().copied().collect();
    assert_eq!(mapped_events, expected_events);

    for row in &mapping.rows {
        // Dotted names are lowercase ASCII with dots; multiword segments use
        // underscores (e.g. tool.batch_started). What section 11 forbids is
        // a second underscore *alias* per variant, which the one-row-per-kind
        // coverage above already excludes.
        assert!(
            row.ipc_dotted_name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_'),
            "wire name must be lowercase dotted ASCII: {}",
            row.ipc_dotted_name
        );
        assert!(
            !row.ipc_dotted_name.contains("..")
                && !row.ipc_dotted_name.starts_with('.')
                && !row.ipc_dotted_name.ends_with('.'),
            "malformed wire name: {}",
            row.ipc_dotted_name
        );
        if row.direction == "ui_to_core" {
            assert!(
                row.ratatui_mapping
                    .starts_with("Effect::Invoke(CoreCommand::")
                    && row.ratatui_mapping.ends_with(')'),
                "bad ratatui mapping: {}",
                row.ratatui_mapping
            );
        } else {
            assert!(
                row.ratatui_mapping
                    .starts_with("Action::CoreEvent(UiEvent::")
                    && row.ratatui_mapping.ends_with(')'),
                "bad ratatui mapping: {}",
                row.ratatui_mapping
            );
        }
    }

    // Implementation wire-name functions agree with the mapping table.
    let by_variant: BTreeMap<&str, &UiMappingRow> = mapping
        .rows
        .iter()
        .map(|r| (r.semantic_variant.as_str(), r))
        .collect();
    for kind in ALL_COMMAND_KINDS {
        let command = sample_command_for_kind(kind);
        let wire = command_wire_name(&command);
        assert_eq!(
            by_variant[kind].ipc_dotted_name, wire,
            "wire mismatch for {kind}"
        );
    }
    for kind in ALL_EVENT_KINDS {
        let event = sample_event_for_kind(kind);
        let wire = event_wire_name(&event);
        assert_eq!(
            by_variant[kind].ipc_dotted_name, wire,
            "wire mismatch for {kind}"
        );
    }
}

fn read_event_records(path: &Path) -> Vec<UiEventRecord> {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
        let text = String::from_utf8(bytes).expect("utf8 event fixture");
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line)
                    .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
            })
            .collect()
    } else {
        vec![serde_json::from_slice(&bytes)
            .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))]
    }
}

fn sample_command_for_kind(kind: &str) -> CoreCommand {
    let (root, manifest) = load_manifest();
    for file in &manifest.command_files {
        let value = read_json(&root.join(file));
        let command: CoreCommand =
            serde_json::from_value(value).unwrap_or_else(|e| panic!("parse {file}: {e}"));
        if command_kind_tag(&command) == kind {
            return command;
        }
    }
    panic!("no fixture command for kind {kind}");
}

fn sample_event_for_kind(kind: &str) -> praana_core::ui_contract::UiEvent {
    let (root, manifest) = load_manifest();
    for file in &manifest.event_files {
        for record in read_event_records(&root.join(file)) {
            if record.event.kind_name() == kind {
                return record.event;
            }
        }
    }
    panic!("no fixture event for kind {kind}");
}

#[test]
fn every_command_fixture_round_trips() {
    let (root, manifest) = load_manifest();
    // Several commands have multiple fixtures (resume by id/selector, page
    // tail/before, content selections, redacted auth variants).
    assert!(manifest.command_files.len() >= ALL_COMMAND_KINDS.len());
    let mut kinds_seen = std::collections::BTreeSet::new();
    for file in &manifest.command_files {
        let value = read_json(&root.join(file));
        let command: CoreCommand =
            serde_json::from_value(value).unwrap_or_else(|e| panic!("parse {file}: {e}"));
        // Re-serialize through the typed DTO (never Value) and parse again.
        let bytes = serde_json::to_vec(&command).expect("serialize command");
        let raw: serde_json::Value = serde_json::from_slice(&bytes).expect("raw command json");
        // CoreCommand carries input-only secrets, so equality is checked on
        // canonical bytes rather than derived PartialEq.
        let canonical = praana_core::canonical_json::to_canonical_json_bytes(&command)
            .expect("canonical command");
        let value: serde_json::Value = serde_json::from_slice(&canonical).expect("canonical json");
        let command_again: CoreCommand =
            serde_json::from_value(value).unwrap_or_else(|e| panic!("reparse {file}: {e}"));
        let canonical_again = praana_core::canonical_json::to_canonical_json_bytes(&command_again)
            .expect("canonical command");
        assert_eq!(canonical, canonical_again, "round-trip mismatch for {file}");
        // Every command JSON envelope uses snake_case type tags.
        assert!(raw.get("type").is_some(), "missing type tag in {file}");
        assert!(raw.get("data").is_some(), "missing data in {file}");
        kinds_seen.insert(command_kind_tag(&command));
    }
    let expected: std::collections::BTreeSet<&str> = ALL_COMMAND_KINDS.iter().copied().collect();
    assert_eq!(kinds_seen, expected, "command kind coverage mismatch");
}

fn command_kind_tag(command: &CoreCommand) -> &'static str {
    match command {
        CoreCommand::SessionCreate(_) => "CoreCommand::SessionCreate",
        CoreCommand::SessionResume(_) => "CoreCommand::SessionResume",
        CoreCommand::SessionEnd(_) => "CoreCommand::SessionEnd",
        CoreCommand::SessionSnapshot(_) => "CoreCommand::SessionSnapshot",
        CoreCommand::SessionClear(_) => "CoreCommand::SessionClear",
        CoreCommand::SessionNew(_) => "CoreCommand::SessionNew",
        CoreCommand::TurnSubmit(_) => "CoreCommand::TurnSubmit",
        CoreCommand::TurnCancel(_) => "CoreCommand::TurnCancel",
        CoreCommand::RiskResolve(_) => "CoreCommand::RiskResolve",
        CoreCommand::SlashCatalog(_) => "CoreCommand::SlashCatalog",
        CoreCommand::SlashExecute(_) => "CoreCommand::SlashExecute",
        CoreCommand::PathComplete(_) => "CoreCommand::PathComplete",
        CoreCommand::ModelCatalog(_) => "CoreCommand::ModelCatalog",
        CoreCommand::ModelSelect(_) => "CoreCommand::ModelSelect",
        CoreCommand::ReasoningSet(_) => "CoreCommand::ReasoningSet",
        CoreCommand::SettingsPatch(_) => "CoreCommand::SettingsPatch",
        CoreCommand::TranscriptPage(_) => "CoreCommand::TranscriptPage",
        CoreCommand::ContentRead(_) => "CoreCommand::ContentRead",
        CoreCommand::SetupStatus(_) => "CoreCommand::SetupStatus",
        CoreCommand::SetupApply(_) => "CoreCommand::SetupApply",
        CoreCommand::AuthLogin(_) => "CoreCommand::AuthLogin",
        CoreCommand::AuthLogout(_) => "CoreCommand::AuthLogout",
        CoreCommand::ConsentResolve(_) => "CoreCommand::ConsentResolve",
        CoreCommand::RuntimePing(_) => "CoreCommand::RuntimePing",
        CoreCommand::Shutdown(_) => "CoreCommand::Shutdown",
    }
}

#[test]
fn every_result_fixture_round_trips_with_pairing() {
    let (root, manifest) = load_manifest();
    assert!(manifest.result_files.len() >= ALL_COMMAND_KINDS.len());
    let expected: BTreeMap<&str, &str> = [
        ("session_create.json", "session_opened"),
        ("session_resume_by_id.json", "session_opened"),
        ("session_resume_by_selector.json", "session_opened"),
        ("session_end.json", "session_ended"),
        ("session_snapshot.json", "session_snapshot"),
        ("session_clear.json", "session_cleared"),
        ("session_new.json", "session_opened"),
        ("turn_submit.json", "turn_submitted"),
        ("turn_cancel.json", "turn_cancellation"),
        ("risk_resolve.json", "risk_resolved"),
        ("slash_catalog.json", "slash_catalog"),
        ("slash_execute.json", "slash_executed"),
        ("path_complete.json", "path_completion"),
        ("model_catalog.json", "model_catalog"),
        ("model_select.json", "model_selected"),
        ("reasoning_set.json", "reasoning_set"),
        ("settings_patch.json", "settings_patched"),
        ("transcript_page_tail.json", "transcript_page"),
        ("transcript_page_before.json", "transcript_page"),
        ("content_read_bytes.json", "content_read"),
        ("content_read_lines.json", "content_read"),
        ("content_read_grep.json", "content_read"),
        ("setup_status.json", "setup_status"),
        ("setup_apply_redacted.json", "setup_applied"),
        ("auth_login_api_key_redacted.json", "auth_login"),
        ("auth_login_device.json", "auth_login"),
        ("auth_logout.json", "auth_logout"),
        ("consent_resolve.json", "consent_resolved"),
        ("runtime_ping.json", "runtime_pong"),
        ("shutdown.json", "shutdown_admitted"),
    ]
    .into_iter()
    .collect();
    for file in &manifest.result_files {
        let value = read_json(&root.join(file));
        let result: CoreCommandResult =
            serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("parse {file}: {e}"));
        let bytes = serde_json::to_vec(&result).expect("serialize result");
        let again: CoreCommandResult =
            serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("reparse {file}: {e}"));
        assert_eq!(result, again, "round-trip mismatch for {file}");
        let short = file.rsplit('/').next().unwrap();
        let want = expected
            .get(short)
            .unwrap_or_else(|| panic!("no pairing for {file}"));
        let got = result.success_type();
        assert_eq!(got, *want, "pairing mismatch for {file}");
        assert_eq!(value.get("status").and_then(|s| s.as_str()), Some("ok"));
    }
}

#[test]
fn command_result_pairing_matches_section_12() {
    // Every mutating/read-only command maps to exactly one success variant.
    let pairs: &[(&str, &str)] = &[
        ("CoreCommand::SessionCreate", "session_opened"),
        ("CoreCommand::SessionResume", "session_opened"),
        ("CoreCommand::SessionNew", "session_opened"),
        ("CoreCommand::SessionEnd", "session_ended"),
        ("CoreCommand::SessionSnapshot", "session_snapshot"),
        ("CoreCommand::SessionClear", "session_cleared"),
        ("CoreCommand::TurnSubmit", "turn_submitted"),
        ("CoreCommand::TurnCancel", "turn_cancellation"),
        ("CoreCommand::RiskResolve", "risk_resolved"),
        ("CoreCommand::SlashCatalog", "slash_catalog"),
        ("CoreCommand::SlashExecute", "slash_executed"),
        ("CoreCommand::PathComplete", "path_completion"),
        ("CoreCommand::ModelCatalog", "model_catalog"),
        ("CoreCommand::ModelSelect", "model_selected"),
        ("CoreCommand::ReasoningSet", "reasoning_set"),
        ("CoreCommand::SettingsPatch", "settings_patched"),
        ("CoreCommand::TranscriptPage", "transcript_page"),
        ("CoreCommand::ContentRead", "content_read"),
        ("CoreCommand::SetupStatus", "setup_status"),
        ("CoreCommand::SetupApply", "setup_applied"),
        ("CoreCommand::AuthLogin", "auth_login"),
        ("CoreCommand::AuthLogout", "auth_logout"),
        ("CoreCommand::ConsentResolve", "consent_resolved"),
        ("CoreCommand::RuntimePing", "runtime_pong"),
        ("CoreCommand::Shutdown", "shutdown_admitted"),
    ];
    assert_eq!(pairs.len(), ALL_COMMAND_KINDS.len());
    for (kind, success) in pairs {
        let command = sample_command_for_kind(kind);
        assert_eq!(expected_success_variant(&command), *success);
    }
}

#[test]
fn every_event_fixture_round_trips() {
    let (root, manifest) = load_manifest();
    let mut single = 0u32;
    let mut lines_total = 0u32;
    for file in &manifest.event_files {
        let records = read_event_records(&root.join(file));
        assert!(!records.is_empty(), "empty event fixture {file}");
        if file.ends_with(".json") {
            assert_eq!(
                records.len(),
                1,
                "single event fixture holds one record: {file}"
            );
            single += 1;
        }
        for record in &records {
            assert_eq!(record.ui_contract_schema_version, 1, "{file}");
            let bytes = serde_json::to_vec(&record).expect("serialize event");
            let again: UiEventRecord =
                serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("reparse {file}: {e}"));
            assert_eq!(*record, again, "round-trip mismatch for {file}");
            lines_total += 1;
        }
    }
    assert_eq!(single as usize, ALL_EVENT_KINDS.len());
    assert!(lines_total > single, "jsonl fixtures must add coverage");
}

#[test]
fn retry_and_reconciliation_sequences_hold() {
    let root = fixture_root();
    let read_records = |name: &str| -> Vec<UiEventRecord> {
        let text = fs::read_to_string(root.join(name)).expect("read jsonl");
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("parse jsonl line"))
            .collect()
    };
    // Pre-visible retry: start, failed rewind with replacement, replacement
    // start retrying the old attempt, acceptance, supersession.
    let retry = read_records("events/previsible_retry.jsonl");
    assert_eq!(retry.len(), 5);
    assert_eq!(retry[0].event.kind_name(), "UiEvent::AttemptStarted");
    assert_eq!(retry[1].event.kind_name(), "UiEvent::AttemptRewind");
    assert_eq!(retry[2].event.kind_name(), "UiEvent::AttemptStarted");
    assert_eq!(retry[3].event.kind_name(), "UiEvent::AssistantAccepted");
    assert_eq!(retry[4].event.kind_name(), "UiEvent::AttemptSuperseded");
    // Post-visible interruption: attempt start, one text delta, the durable
    // provider failure, rewind without replacement, and terminal turn
    // interruption. No replacement attempt follows the visible failure.
    let interruption = read_records("events/postvisible_interruption.jsonl");
    assert_eq!(interruption.len(), 5);
    assert_eq!(interruption[0].event.kind_name(), "UiEvent::AttemptStarted");
    assert_eq!(interruption[1].event.kind_name(), "UiEvent::AssistantDelta");
    assert_eq!(interruption[2].event.kind_name(), "UiEvent::SystemError");
    assert_eq!(interruption[3].event.kind_name(), "UiEvent::AttemptRewind");
    assert_eq!(
        interruption[4].event.kind_name(),
        "UiEvent::TurnInterrupted"
    );
    // The failure between the visible delta and the rewind is durable.
    assert!(matches!(
        interruption[2].durability,
        praana_core::ui_contract::event::UiDurabilityRef::CanonicalEvent { .. }
    ));
    for record in &interruption[1..] {
        assert_ne!(record.event.kind_name(), "UiEvent::AttemptStarted");
    }
    // Provider-failure interruption is a TurnSubmit descendant: no operation ID.
    assert!(interruption[4].operation_id.is_none());
    // Cancel rewind proves rewind without retry. user_abort is the TurnCancel
    // command result, so the envelope carries that operation ID.
    let cancel = read_records("events/cancel_rewind.jsonl");
    assert_eq!(cancel.len(), 3);
    assert_eq!(cancel[1].event.kind_name(), "UiEvent::AttemptRewind");
    assert_eq!(cancel[2].event.kind_name(), "UiEvent::TurnInterrupted");
    assert!(cancel[2].operation_id.is_some());
    // Accepted reconciliation carries attempt start, acceptance, rewind.
    let reconciliation = read_records("events/accepted_reconciliation.jsonl");
    assert_eq!(reconciliation.len(), 3);
    assert_eq!(
        reconciliation[1].event.kind_name(),
        "UiEvent::AssistantAccepted"
    );
}

#[test]
fn rejection_fixtures_fail_with_expected_code() {
    let (root, manifest) = load_manifest();
    assert_eq!(manifest.rejection_files.len(), 6);
    for file in &manifest.rejection_files {
        let value = read_json(&root.join(file));
        let fixture: UiRejectionFixture =
            serde_json::from_value(value).unwrap_or_else(|e| panic!("parse {file}: {e}"));
        match (fixture.target.as_str(), fixture.expected_code.as_str()) {
            ("command", "invalid_ulid") => {
                let err = serde_json::from_str::<CoreCommand>(&fixture.input_json)
                    .expect_err("lowercase/prefixed ULID must be rejected");
                let msg = err.to_string();
                assert!(
                    msg.contains("ULID") || msg.contains("ulid") || msg.contains("invalid"),
                    "unexpected error for {file}: {msg}"
                );
            }
            ("command", "unknown_field") => {
                let err = serde_json::from_str::<CoreCommand>(&fixture.input_json)
                    .expect_err("unknown field must be rejected");
                assert!(
                    err.to_string().contains("unknown field"),
                    "unexpected error for {file}: {err}"
                );
            }
            ("transcript", "unknown_variant") => {
                let err = serde_json::from_str::<TranscriptEntryDto>(&fixture.input_json)
                    .expect_err("recall role must be rejected");
                let msg = err.to_string();
                assert!(
                    msg.contains("unknown variant") || msg.contains("recall"),
                    "unexpected error for {file}: {msg}"
                );
                // The role alone is also rejected: no Recall variant exists.
                let role_err = serde_json::from_str::<TranscriptRoleDto>("\"recall\"")
                    .expect_err("recall role must not exist");
                assert!(role_err.to_string().contains("unknown variant"));
            }
            ("operation_replay", "operation_conflict") => {
                let raw: serde_json::Value =
                    serde_json::from_str(&fixture.input_json).expect("valid json");
                assert!(raw.get("operation_id").is_some());
                assert!(raw.get("request_sha256").is_some());
                // The stored hash must be well-formed; the conflict itself is
                // exercised against the ledger in operation_idempotency tests.
                let hash = raw.get("request_sha256").and_then(|v| v.as_str()).unwrap();
                assert_eq!(hash.len(), 64);
            }
            ("result", "cursor_invalid") => {
                // The fixture is a partial transcript page carrying a cursor
                // issued under another session; echoing it cross-session is
                // CursorInvalid. The JSON is intentionally partial (it is the
                // cursor carrier, not a complete page).
                let raw: serde_json::Value =
                    serde_json::from_str(&fixture.input_json).expect("valid json");
                let cursor_str = raw
                    .pointer("/data/data/before_cursor")
                    .and_then(|v| v.as_str())
                    .expect("fixture carries before_cursor");
                let cursor: praana_core::ui_contract::TranscriptCursor =
                    cursor_str.parse().expect("valid cursor shape");
                // A cursor issued under one session is invalid in another.
                let a = "01J8Z3NDEK0000000000000001".parse().unwrap();
                let b = "01J8Z3NDEK0000000000000002".parse().unwrap();
                assert!(check_cursor_session_binding(&a, &a, &cursor).is_ok());
                let err = check_cursor_session_binding(&a, &b, &cursor).expect_err("cross-session");
                assert_eq!(err.code_name(), "cursor_invalid");
            }
            other => panic!("unexpected rejection fixture {file}: {other:?}"),
        }
    }
}

#[test]
fn ulids_selectors_and_cursors_follow_id_rules() {
    let (root, manifest) = load_manifest();
    let mut ulids = 0u32;
    let mut shas = 0u32;
    for file in manifest
        .command_files
        .iter()
        .chain(manifest.result_files.iter())
        .chain(manifest.event_files.iter())
    {
        let path = root.join(file);
        let values: Vec<serde_json::Value> =
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                let text = fs::read_to_string(&path).expect("read fixture");
                text.lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(|line| serde_json::from_str(line).expect("json fixture"))
                    .collect()
            } else {
                vec![read_json(&path)]
            };
        for raw in &values {
            collect_id_like(raw, &mut ulids, &mut shas, file);
        }
    }
    assert!(ulids > 100, "fixtures must carry complete ULIDs");
    assert!(shas > 20, "fixtures must carry full SHA-256 values");

    // Resume selector is the first 12 characters of the canonical session ID.
    let session_id = "01J8Z3NDEK0000000000000001";
    let selector = &session_id[..12];
    assert_eq!(selector, "01J8Z3NDEK00");
    assert_eq!(selector.len(), 12);
    assert_ne!(session_id.len(), selector.len());

    // Cursors are opaque ASCII 1..=512 bytes.
    let cursor: praana_core::ui_contract::TranscriptCursor =
        "Y3Vyc29yLXRyYW5zY3JpcHQtMDE".parse().expect("valid cursor");
    assert!(cursor.as_str().len() <= 512);
    assert!(cursor
        .as_str()
        .bytes()
        .all(|b| b.is_ascii() && !b.is_ascii_control()));
}

fn collect_id_like(value: &serde_json::Value, ulids: &mut u32, shas: &mut u32, file: &str) {
    match value {
        serde_json::Value::String(s) => {
            if is_crockford_ulid(s) {
                *ulids += 1;
            } else if is_lower_hex64(s) {
                *shas += 1;
            } else if is_crockford_selector(s) {
                // Resume selector: 12-char prefix of a session ID.
            } else if s.len() == 64 {
                panic!("malformed sha-like string {s:?} in {file}");
            } else if s.len() == 26
                && s.bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                panic!("malformed ULID-like string {s:?} in {file}");
            } else if s.len() == 12
                && s.bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                panic!("malformed selector-like string {s:?} in {file}");
            }
            // Other strings (cursors, labels, messages) are opaque.
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_id_like(item, ulids, shas, file);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_id_like(item, ulids, shas, file);
            }
        }
        _ => {}
    }
}

#[test]
fn memory_is_plugin_gated_without_recall() {
    // No Recall variant anywhere in the contract.
    for kind in ALL_EVENT_KINDS {
        assert!(!kind.to_lowercase().contains("recall"), "{kind}");
    }
    for kind in ALL_COMMAND_KINDS {
        assert!(!kind.to_lowercase().contains("recall"), "{kind}");
    }
    // Memory entries require an enabled plugin, non-incognito session, and
    // explicit ambient content from the plugin.
    assert!(memory_entry_allowed(true, false, true));
    assert!(!memory_entry_allowed(false, false, true));
    assert!(!memory_entry_allowed(true, true, true));
    assert!(!memory_entry_allowed(true, false, false));
}

#[test]
fn secrets_never_appear_as_plaintext_in_fixtures_or_debug() {
    let (root, manifest) = load_manifest();
    for file in manifest
        .command_files
        .iter()
        .chain(manifest.result_files.iter())
        .chain(manifest.event_files.iter())
    {
        let bytes = fs::read(root.join(file)).expect("read fixture");
        let text = String::from_utf8(bytes).expect("utf8");
        assert!(
            !text.contains("sk-") && !text.contains("secret-value"),
            "secret plaintext in {file}"
        );
    }
    let secret = SensitiveStringDto::from("sk-test-plaintext".to_string());
    assert_eq!(format!("{secret:?}"), "[REDACTED]");
    assert!(!format!("{secret:?}").contains("sk-test-plaintext"));
}

#[test]
fn envelope_validation_accepts_fixture_records() {
    let (root, manifest) = load_manifest();
    for file in &manifest.event_files {
        for record in read_event_records(&root.join(file)) {
            validate_ui_event(&record).unwrap_or_else(|e| panic!("validate {}: {e:?}", file));
        }
    }
}

#[test]
fn durability_wire_form_is_tagged_with_data() {
    use praana_core::ui_contract::UiDurabilityRef;
    // CanonicalEvent carries its payload under "data", not flattened.
    let canonical: UiDurabilityRef = serde_json::from_str(
        r#"{"type":"canonical_event","data":{"event_id":"01J8Z3NDEK000000000000001N","canonical_sequence":54}}"#,
    )
    .expect("tagged canonical_event");
    match canonical {
        UiDurabilityRef::CanonicalEvent {
            canonical_sequence, ..
        } => assert_eq!(canonical_sequence, 54),
        _ => panic!("wrong variant"),
    }
    let host: UiDurabilityRef = serde_json::from_str(
        r#"{"type":"host_revision","data":{"kind":"consent","revision":1,"sha256":"2117f99c33b13f233b3de1407b7cf551443797f7831f9f6536583851efe89cd8"}}"#,
    )
    .expect("tagged host_revision");
    assert!(matches!(
        host,
        UiDurabilityRef::HostRevision {
            kind: praana_core::ui_contract::event::HostRevisionKind::Consent,
            ..
        }
    ));
    let settings: UiDurabilityRef = serde_json::from_str(
        r#"{"type":"settings_revision","data":{"revision":4,"sha256":"ddeb29c1fb98b3cc8df9c648bf3188822a23152e09c52c8e7ca2770eb43bc9ee"}}"#,
    )
    .expect("tagged settings_revision");
    assert!(matches!(settings, UiDurabilityRef::SettingsRevision { .. }));
    // The flattened pre-P1C-fix form is rejected.
    assert!(serde_json::from_str::<UiDurabilityRef>(
        r#"{"type":"canonical_event","event_id":"01J8Z3NDEK000000000000001N","canonical_sequence":54}"#,
    )
    .is_err());
}

#[test]
fn spec_forbidden_values_are_rejected() {
    // history_mode "full" is not the protocol append-only mode.
    assert!(
        serde_json::from_str::<praana_core::protocol::models::HistoryMode>(r#""full""#).is_err()
    );
    assert!(
        serde_json::from_str::<praana_core::protocol::models::HistoryMode>(r#""append""#).is_ok()
    );
    // Projection IDs must be the canonical projection string.
    assert!(
        serde_json::from_str::<praana_core::protocol::id::ProjectionId>(
            r#""01J8Z3NDEK0000000000000014""#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<praana_core::protocol::id::ProjectionId>(
            r#""rust-v2-projection-1""#
        )
        .is_ok()
    );
    // ComponentState has exactly five variants; "normal" is rejected.
    assert!(
        serde_json::from_str::<praana_core::ui_contract::result::ComponentState>(r#""normal""#)
            .is_err()
    );
    // No "accepted" decision summary; protocol DecisionStatus applies.
    assert!(
        serde_json::from_str::<praana_core::ui_contract::result::StateStatusSummaryDto>(
            r#"{"type":"decision","data":"accepted"}"#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<praana_core::ui_contract::result::StateStatusSummaryDto>(
            r#"{"type":"decision","data":{"status":"active"}}"#
        )
        .is_ok()
    );
    // Untagged JsonData objects are rejected.
    assert!(serde_json::from_str::<praana_core::ui_contract::JsonData>(
        r#"{"command":"bun test"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<praana_core::ui_contract::JsonData>(
        r#"{"type":"object","data":{"command":{"type":"string","data":"bun test"}}}"#
    )
    .is_ok());
}

#[test]
fn every_event_kind_enforces_its_durability() {
    use praana_core::ui_contract::event::UiDurabilityRef;
    let (root, manifest) = load_manifest();
    let mut seen = std::collections::BTreeSet::new();
    for file in &manifest.event_files {
        if !file.ends_with(".json") {
            continue;
        }
        for record in read_event_records(&root.join(file)) {
            seen.insert(record.event.kind_name());
            // The corrected fixture durability validates.
            validate_ui_event(&record).unwrap_or_else(|e| panic!("validate {}: {e:?}", file));
            // A swapped durability variant is rejected.
            let mut wrong = record.clone();
            wrong.durability = match &record.durability {
                UiDurabilityRef::Ephemeral => UiDurabilityRef::CanonicalEvent {
                    event_id: "01J8Z3NDEK000000000000001N".parse().unwrap(),
                    canonical_sequence: 1,
                },
                _ => UiDurabilityRef::Ephemeral,
            };
            // Every corrected single-event fixture sits on its exact mapping
            // side (conditional rows included: stopped without a session,
            // sourceless notices, failed rewinds, and persisted consent all
            // have exactly one legal variant here), so the swap is rejected.
            assert!(
                validate_ui_event(&wrong).is_err(),
                "wrong durability accepted for {}",
                record.event.kind_name()
            );
        }
    }
    let expected: std::collections::BTreeSet<&str> = ALL_EVENT_KINDS.iter().copied().collect();
    assert_eq!(seen, expected);
}

#[test]
fn priority_coalescing_sensitivity_cover_every_event_kind() {
    use praana_core::ui_contract::event::{
        coalesce_key, durability_requirement, priority, sensitivity, UiDurabilityRequirement,
        UiEventPriority, UiSensitivity,
    };
    // Expected (priority, has_coalescing_key, sensitivity, durability).
    let table: &[(
        &str,
        UiEventPriority,
        bool,
        UiSensitivity,
        UiDurabilityRequirement,
    )] = &[
        (
            "UiEvent::RuntimeReady",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::RuntimeStopping",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::RuntimeStopped",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::SnapshotOrEphemeral,
        ),
        (
            "UiEvent::RuntimeBackpressure",
            UiEventPriority::LatestOnly,
            true,
            UiSensitivity::Public,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::SystemNotice",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Redacted,
            UiDurabilityRequirement::SourceOrEphemeral,
        ),
        (
            "UiEvent::SystemError",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Redacted,
            UiDurabilityRequirement::SourceOrEphemeral,
        ),
        (
            "UiEvent::SessionOpened",
            UiEventPriority::Critical,
            false,
            UiSensitivity::LocalMetadata,
            UiDurabilityRequirement::CanonicalSnapshot,
        ),
        (
            "UiEvent::SessionStatus",
            UiEventPriority::LatestOnly,
            true,
            UiSensitivity::LocalMetadata,
            UiDurabilityRequirement::CanonicalSnapshot,
        ),
        (
            "UiEvent::SessionCleared",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::SessionEnded",
            UiEventPriority::Critical,
            false,
            UiSensitivity::LocalMetadata,
            UiDurabilityRequirement::CanonicalSnapshot,
        ),
        (
            "UiEvent::ModelChanged",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::ReasoningChanged",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::SettingsChanged",
            UiEventPriority::LatestOnly,
            true,
            UiSensitivity::Public,
            UiDurabilityRequirement::SettingsRevision,
        ),
        (
            "UiEvent::ContextUpdated",
            UiEventPriority::LatestOnly,
            true,
            UiSensitivity::Public,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::TurnStarted",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Redacted,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::AttemptStarted",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::AssistantDelta",
            UiEventPriority::Appendable,
            true,
            UiSensitivity::Redacted,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::AttemptRewind",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalOrEphemeral,
        ),
        (
            "UiEvent::AssistantAccepted",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Redacted,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::AttemptSuperseded",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::UsageUpdated",
            UiEventPriority::LatestOnly,
            true,
            UiSensitivity::Public,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::TurnCompleted",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::TurnInterrupted",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Redacted,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::ToolBatchStarted",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalSnapshot,
        ),
        (
            "UiEvent::ToolCallPending",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Redacted,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::RiskConfirmationRequested",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Redacted,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::RiskConfirmationResolved",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::ToolCallStarted",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::ToolCallProgress",
            UiEventPriority::LatestOnly,
            true,
            UiSensitivity::Public,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::ToolCallFinished",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Redacted,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::ToolBatchFinished",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::CanonicalEvent,
        ),
        (
            "UiEvent::SetupChanged",
            UiEventPriority::Critical,
            false,
            UiSensitivity::LocalMetadata,
            UiDurabilityRequirement::HostSetupConfig,
        ),
        (
            "UiEvent::AuthFlowUpdated",
            UiEventPriority::LatestOnly,
            true,
            UiSensitivity::LocalMetadata,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::AuthChanged",
            UiEventPriority::Critical,
            false,
            UiSensitivity::LocalMetadata,
            UiDurabilityRequirement::CredentialRevision,
        ),
        (
            "UiEvent::ConsentRequested",
            UiEventPriority::Critical,
            false,
            UiSensitivity::LocalMetadata,
            UiDurabilityRequirement::Ephemeral,
        ),
        (
            "UiEvent::ConsentResolved",
            UiEventPriority::Critical,
            false,
            UiSensitivity::Public,
            UiDurabilityRequirement::HostConsentOrEphemeral,
        ),
    ];
    assert_eq!(table.len(), ALL_EVENT_KINDS.len());
    let (root, manifest) = load_manifest();
    let mut records = std::collections::BTreeMap::new();
    for file in &manifest.event_files {
        if !file.ends_with(".json") {
            continue;
        }
        for record in read_event_records(&root.join(file)) {
            records.insert(record.event.kind_name(), record);
        }
    }
    for (kind, want_priority, want_key, want_sensitivity, want_durability) in table {
        let record = records
            .get(kind)
            .unwrap_or_else(|| panic!("no fixture for {kind}"));
        assert_eq!(priority(&record.event), *want_priority, "{kind}");
        assert_eq!(coalesce_key(record).is_some(), *want_key, "{kind}");
        assert_eq!(sensitivity(&record.event), *want_sensitivity, "{kind}");
        assert_eq!(
            durability_requirement(&record.event),
            *want_durability,
            "{kind}"
        );
    }
}

#[test]
fn operation_scope_rejects_both_directions() {
    let (root, _) = load_manifest();
    // A direct command result without its operation ID is rejected.
    let mut started = read_event_records(&root.join("events/turn_started.json"))
        .pop()
        .expect("turn_started fixture");
    assert!(started.operation_id.is_some());
    started.operation_id = None;
    assert!(validate_ui_event(&started).is_err());
    // A later TurnSubmit descendant carrying an operation ID is rejected.
    let mut attempt = read_event_records(&root.join("events/attempt_started.json"))
        .pop()
        .expect("attempt_started fixture");
    assert!(attempt.operation_id.is_none());
    attempt.operation_id = Some("01J8Z3NDEK0000000000000030".parse().unwrap());
    assert!(validate_ui_event(&attempt).is_err());
    // Direct results across the session/model/settings/host surface require it.
    for name in [
        "events/session_opened.json",
        "events/session_cleared.json",
        "events/session_ended.json",
        "events/model_changed.json",
        "events/reasoning_changed.json",
        "events/settings_changed.json",
        "events/setup_changed.json",
        "events/auth_changed.json",
        "events/consent_resolved.json",
        "events/risk_confirmation_resolved.json",
        "events/runtime_stopping.json",
        "events/runtime_stopped.json",
        "events/turn_interrupted.json",
    ] {
        let record = read_event_records(&root.join(name)).pop().expect("fixture");
        assert!(
            record.operation_id.is_some(),
            "{name} must carry its operation ID"
        );
    }
    // Later TurnSubmit descendants, including turn completion and
    // provider-failure interruption, must leave operation_id null.
    for name in [
        "events/attempt_started.json",
        "events/turn_completed.json",
        "events/assistant_delta.json",
        "events/attempt_rewind.json",
        "events/assistant_accepted.json",
        "events/attempt_superseded.json",
        "events/usage_updated.json",
        "events/tool_batch_started.json",
        "events/tool_call_pending.json",
        "events/risk_confirmation_requested.json",
        "events/tool_call_started.json",
        "events/tool_call_progress.json",
        "events/tool_call_finished.json",
        "events/tool_batch_finished.json",
        "events/auth_flow_updated.json",
        "events/consent_requested.json",
        "events/session_status.json",
        "events/context_updated.json",
    ] {
        let record = read_event_records(&root.join(name)).pop().expect("fixture");
        assert!(
            record.operation_id.is_none(),
            "{name} must not carry an operation ID"
        );
    }
}

#[test]
fn turn_interrupted_operation_id_follows_command_vs_turn_machine() {
    use praana_core::ui_contract::event::TurnInterruptionReasonDto;
    let (root, _) = load_manifest();
    let mut interrupted = read_event_records(&root.join("events/turn_interrupted.json"))
        .pop()
        .expect("turn_interrupted fixture");
    // user_abort is a TurnCancel result: the fixture ID is required.
    assert!(interrupted.operation_id.is_some());
    assert!(validate_ui_event(&interrupted).is_ok());
    let kept_id = interrupted.operation_id;
    interrupted.operation_id = None;
    assert!(validate_ui_event(&interrupted).is_err());
    interrupted.operation_id = kept_id;
    // Provider-failure interruption is a TurnSubmit descendant: ID must be null.
    if let praana_core::ui_contract::UiEvent::TurnInterrupted(payload) = &mut interrupted.event {
        payload.reason = TurnInterruptionReasonDto::ProviderFailure;
        payload.message = "Provider stream failed.".to_string();
    } else {
        panic!("expected turn_interrupted");
    }
    assert!(validate_ui_event(&interrupted).is_err());
    interrupted.operation_id = None;
    assert!(validate_ui_event(&interrupted).is_ok());
}

#[test]
fn turn_interrupted_uncertain_executions_require_attempt() {
    use praana_core::ui_contract::event::TurnInterruptedDto;
    let (root, _) = load_manifest();
    let mut interrupted = read_event_records(&root.join("events/turn_interrupted.json"))
        .pop()
        .expect("turn_interrupted fixture");
    // Empty uncertain list with no attempt is valid.
    assert!(validate_ui_event(&interrupted).is_ok());
    // A non-empty uncertain list without an envelope attempt is rejected.
    if let praana_core::ui_contract::UiEvent::TurnInterrupted(payload) = &mut interrupted.event {
        *payload = TurnInterruptedDto {
            uncertain_execution_ids: vec!["01J8Z3NDEK0000000000000006".parse().unwrap()],
            ..payload.clone()
        };
    } else {
        panic!("expected turn_interrupted");
    }
    assert!(validate_ui_event(&interrupted).is_err());
    // Naming the failed attempt in the envelope accepts it.
    interrupted.attempt_id = Some("01J8Z3NDEK0000000000000003".parse().unwrap());
    assert!(validate_ui_event(&interrupted).is_ok());
}

#[test]
fn state_snapshot_ordering_is_focused_then_tier_then_id() {
    use praana_core::protocol::state_graph::{StateKind, StateTier};
    use praana_core::ui_contract::result::{
        StateCountsDto, StateObjectSummaryDto, StateSnapshotDto, StateStatusSummaryDto,
    };
    let (root, _) = load_manifest();
    // Checked-in snapshots validate through the snapshot/epilogue entry points.
    let snapshot: praana_core::ui_contract::CoreCommandResult =
        serde_json::from_value(read_json(&root.join("results/session_snapshot.json")))
            .expect("parse snapshot");
    match snapshot {
        praana_core::ui_contract::CoreCommandResult::Ok(
            praana_core::ui_contract::CoreCommandSuccess::SessionSnapshot(page),
        ) => page.validate().expect("fixture snapshot validates"),
        _ => panic!("expected session_snapshot"),
    }
    let counts = StateCountsDto {
        total: 2,
        tasks: 1,
        decisions: 0,
        constraints: 1,
        notes: 0,
        errors: 0,
        active: 1,
        soft: 1,
        hard: 0,
    };
    let object = |id: &str, tier: StateTier, focused: bool| StateObjectSummaryDto {
        state_id: id.parse().unwrap(),
        kind: StateKind::Task,
        tier,
        status: StateStatusSummaryDto::Note,
        label: "x".to_string(),
        focused,
    };
    let valid = StateSnapshotDto {
        graph_sequence: 1,
        counts: counts.clone(),
        objects: vec![
            object("01J8Z3NDEK0000000000000011", StateTier::Soft, true),
            object("01J8Z3NDEK0000000000000012", StateTier::Active, false),
            object("01J8Z3NDEK0000000000000013", StateTier::Soft, false),
        ],
        truncated: false,
    };
    valid.validate_ordering().expect("focused-then-tier order");
    // Unfocused object before the focused one is rejected.
    let mut bad = valid.clone();
    bad.objects.swap(0, 1);
    assert!(bad.validate_ordering().is_err());
    // Soft before active is rejected.
    let bad = StateSnapshotDto {
        objects: vec![
            object("01J8Z3NDEK0000000000000011", StateTier::Soft, false),
            object("01J8Z3NDEK0000000000000012", StateTier::Active, false),
        ],
        ..valid.clone()
    };
    assert!(bad.validate_ordering().is_err());
    // Unsorted StateIds within a tier are rejected.
    let bad = StateSnapshotDto {
        objects: vec![
            object("01J8Z3NDEK0000000000000013", StateTier::Active, false),
            object("01J8Z3NDEK0000000000000012", StateTier::Active, false),
        ],
        ..valid.clone()
    };
    assert!(bad.validate_ordering().is_err());
}

#[test]
fn envelope_validation_rejects_bad_context() {
    use praana_core::ui_contract::event::RuntimeReadyDto;
    use praana_core::ui_contract::{UiDurabilityRef, UiEvent};

    let ready = UiEventRecord {
        ui_contract_schema_version: 1,
        session_id: None,
        turn_id: None,
        attempt_id: None,
        operation_id: None,
        durability: UiDurabilityRef::Ephemeral,
        event: UiEvent::RuntimeReady(RuntimeReadyDto {
            core_version: "0.16.0".to_string(),
            ui_contract_schema_version: 1,
            event_schema_version: 1,
            history_schema_version: 1,
            config_schema_version: 1,
            system_context_schema_version: 1,
            provider_registry_schema_version: 1,
            builtin_tool_catalog_schema_version: 1,
            redaction_version: "1".to_string(),
            features: vec!["settings_patch".to_string()],
        }),
    };
    assert!(validate_ui_event(&ready).is_ok());
    // RuntimeReady must not carry a session.
    let mut bad = ready.clone();
    bad.session_id = Some("01J8Z3NDEK0000000000000001".parse().unwrap());
    assert!(validate_ui_event(&bad).is_err());
    // Schema version must be 1.
    let mut bad_version = ready.clone();
    bad_version.ui_contract_schema_version = 2;
    assert!(validate_ui_event(&bad_version).is_err());
}
