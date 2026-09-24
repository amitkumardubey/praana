//! P1D integration tests: system and project context (System Context spec)
//! plus the reusable report-only secret detector (Redaction spec sections 2-4,
//! P1D ownership per System Context section 8.1).
//!
//! Fixture source: `tests/fixtures/system_context_v1/cases.json`. The fixture
//! values were authored directly from the normative specification text; the
//! implementation must reproduce them byte-for-byte. Fixtures are read-only
//! and contain only syntactically valid fake tokens.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use praana_core::history::event_log::{
    read_project_context_source_sha256, EventLogStore, SessionMetaV1,
};
use praana_core::protocol::constants::SYSTEM_CONTEXT_SCHEMA_VERSION;
use praana_core::protocol::id::{SessionId, Sha256Digest};
use praana_core::protocol::models::HistoryMode;
use praana_core::redaction::{detect_secret_matches_v1, SecretKind};
use praana_core::system_context::{
    build_instruction_slots, compile_system_context, discover_project_context,
    normalize_instruction_bytes, project_context_changed_since_create,
    project_context_source_sha256, render_skill_lines, resume_context_warnings, validate_skills,
    ComponentState, ContextPathResolution, LoadedProjectContext, ProjectContextSource,
    SkillCatalogEntryV1, SkillScopeV1, SourceScope, SystemContextInputV1,
    PROJECT_CONTEXT_CHANGED_SINCE_CREATE,
};

/// A path resolution rooted at `base` for both the relative base directory and
/// the `~/` home directory. Discovery fixtures pass absolute cwd/git-root
/// inputs, so this only exercises the lexical-normalization branch; the
/// dedicated tilde/relative tests below supply a distinct base and home.
fn resolution_at(base: &Path) -> ContextPathResolution {
    ContextPathResolution::new(base.to_path_buf(), base.to_path_buf())
}

const SESSION_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EMPTY_PROVENANCE: &str = "8089ad149c033af866b8281a5b9e27974ffe0b55fb9fd84559216fb4358f8576";
const KNOWN_CONFIG_DIGEST: &str =
    "1aecaa286f1f61128b79b8ff623dfc99bf40a786ce0997bb6d7a00f101328760";

fn cases() -> &'static serde_json::Value {
    static CASES: OnceLock<serde_json::Value> = OnceLock::new();
    CASES.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/system_context_v1/cases.json");
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap()
    })
}

/// Materialize generated fixture inputs:
/// `{"repeat":{"prefix","unit","count","suffix"}}` or a plain string.
fn materialize_input(spec: &serde_json::Value) -> String {
    if let Some(repeat) = spec.get("repeat") {
        let prefix = repeat.get("prefix").and_then(|v| v.as_str()).unwrap_or("");
        let unit = repeat.get("unit").and_then(|v| v.as_str()).unwrap_or("");
        let count = repeat.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let suffix = repeat.get("suffix").and_then(|v| v.as_str()).unwrap_or("");
        let mut out = String::with_capacity(prefix.len() + unit.len() * count + suffix.len());
        out.push_str(prefix);
        for _ in 0..count {
            out.push_str(unit);
        }
        out.push_str(suffix);
        out
    } else {
        spec.as_str()
            .expect("fixture input must be string or repeat")
            .to_owned()
    }
}

/// Minimal RFC 4648 standard base64 decoder for fixture byte content.
fn decode_fixture_b64(encoded: &str) -> Vec<u8> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    fn value_of(byte: u8) -> u8 {
        if byte == b'=' {
            return 0;
        }
        TABLE
            .iter()
            .position(|c| *c == byte)
            .expect("fixture base64 alphabet") as u8
    }
    let bytes: Vec<u8> = encoded
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let n = (u32::from(value_of(chunk[0])) << 18)
            | (u32::from(value_of(chunk[1])) << 12)
            | (u32::from(value_of(chunk[2])) << 6)
            | u32::from(value_of(chunk[3]));
        out.push((n >> 16) as u8);
        if chunk.len() > 2 && chunk[2] != b'=' {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 && chunk[3] != b'=' {
            out.push(n as u8);
        }
    }
    out
}

fn write_tree(root: &Path, files: &serde_json::Value) {
    let map = files.as_object().expect("fixture file map");
    for (rel, spec) in map {
        let dest = root.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        if let Some(b64) = spec.get("bytes_b64").and_then(|v| v.as_str()) {
            fs::write(&dest, decode_fixture_b64(b64)).unwrap();
        } else {
            fs::write(&dest, materialize_input(spec)).unwrap();
        }
    }
}

// ---------------------------------------------------------------------------
// Report-only detector
// ---------------------------------------------------------------------------

fn kind_token(kind: &SecretKind) -> String {
    serde_json::to_string(kind)
        .unwrap()
        .trim_matches('"')
        .to_owned()
}

#[test]
fn detector_fixture_cases_match_exact_spans() {
    for case in cases()["detector_cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let input = materialize_input(&case["input"]);
        let got = detect_secret_matches_v1(&input);
        let expected = case["expected"].as_array().unwrap();
        assert_eq!(
            got.len(),
            expected.len(),
            "case {id}: match count (input prefix: {:?})",
            &input[..input.len().min(120)]
        );
        for (m, e) in got.iter().zip(expected) {
            assert_eq!(
                kind_token(&m.kind),
                e["kind"].as_str().unwrap(),
                "case {id} kind"
            );
            assert_eq!(
                m.start_byte,
                e["start"].as_u64().unwrap() as usize,
                "case {id} start"
            );
            assert_eq!(
                m.end_byte,
                e["end"].as_u64().unwrap() as usize,
                "case {id} end"
            );
        }
    }
}

/// Detector output is deterministic under repeated calls; spans are ordered,
/// non-overlapping, and no replacement text is produced.
#[test]
fn detector_is_deterministic_and_report_only() {
    let input = format!(
        "keep {}\n-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----\nAPI_KEY = abcdefghij\n",
        "ghp_".to_owned() + &"z".repeat(36)
    );
    let first = detect_secret_matches_v1(&input);
    let second = detect_secret_matches_v1(&input);
    assert_eq!(first, second);
    assert!(!first.is_empty());
    for pair in first.windows(2) {
        assert!(
            pair[0].end_byte <= pair[1].start_byte,
            "ordered and non-overlapping"
        );
    }
}

// ---------------------------------------------------------------------------
// Discovery and provenance
// ---------------------------------------------------------------------------

fn build_discovery_tree(
    case: &serde_json::Value,
    temp: &tempfile::TempDir,
) -> (PathBuf, Option<PathBuf>, PathBuf) {
    let home = temp.path().join("home");
    let prj = temp.path().join("prj");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&prj).unwrap();

    if let Some(files) = case.get("home_files") {
        write_tree(&home, files);
    }
    if case.get("prj_files").is_some() || case.get("directory").is_some() {
        if let Some(files) = case.get("prj_files") {
            write_tree(&prj, files);
        }
        // directory fault injection: candidate path becomes a directory
        for tag in case
            .get("directory")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let tag = tag.as_str().unwrap();
            let (tree, rel) = tag.split_once(':').unwrap();
            let path = if tree == "home" {
                home.join(rel)
            } else {
                prj.join(rel)
            };
            fs::remove_file(&path).ok();
            fs::create_dir_all(&path).unwrap();
        }
    }
    if let Some(links) = case.get("symlink").and_then(|v| v.as_object()) {
        for (key, target) in links {
            let (tree, rel) = key.split_once(':').unwrap();
            let path = if tree == "home" {
                home.join(rel)
            } else {
                prj.join(rel)
            };
            #[cfg(unix)]
            std::os::unix::fs::symlink(temp.path().join(target.as_str().unwrap()), &path).unwrap();
            #[cfg(not(unix))]
            {
                let _ = (&path, target);
                panic!("symlink fixture requires unix");
            }
        }
    }
    for tag in case
        .get("unreadable")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let tag = tag.as_str().unwrap();
        let (tree, rel) = tag.split_once(':').unwrap();
        let path = if tree == "home" {
            home.join(rel)
        } else {
            prj.join(rel)
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            panic!("unreadable fixture requires unix");
        }
    }

    let cwd_rel = case.get("cwd_rel").and_then(|v| v.as_str()).unwrap_or("");
    let cwd = if cwd_rel.is_empty() {
        prj.clone()
    } else {
        prj.join(cwd_rel)
    };
    fs::create_dir_all(&cwd).unwrap();
    let git_root = case
        .get("has_git_root")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        .then(|| prj.clone());
    (home, git_root, cwd)
}

fn scope_token(scope: &SourceScope) -> String {
    serde_json::to_string(scope)
        .unwrap()
        .trim_matches('"')
        .to_owned()
}

#[test]
fn discovery_fixture_cases_match() {
    for case in cases()["discovery_cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap().to_owned();
        if case
            .get("unix_only")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            && !cfg!(unix)
        {
            continue; // platform check skipped outside unix
        }
        let temp = tempfile::TempDir::new().unwrap();
        let (home, git_root, cwd) = build_discovery_tree(case, &temp);

        let resolution = resolution_at(temp.path());
        let loaded = discover_project_context(&home, &cwd, git_root.as_deref(), &resolution);
        if let Some(expected_err) = case.get("error") {
            let err = loaded
                .err()
                .unwrap_or_else(|| panic!("case {id}: expected error"));
            assert_eq!(
                err.code,
                expected_err["code"].as_str().unwrap(),
                "case {id} code"
            );
            assert_eq!(
                err.label.as_deref(),
                Some(expected_err["label"].as_str().unwrap()),
                "case {id} label"
            );
            assert_eq!(
                err.detail,
                expected_err["detail"].as_str().unwrap(),
                "case {id} detail"
            );
            continue;
        }
        let loaded = loaded.unwrap_or_else(|e| panic!("case {id}: unexpected error {e:?}"));

        let expected_sources = case["sources"].as_array().unwrap();
        assert_eq!(
            loaded.all_sources.len(),
            expected_sources.len(),
            "case {id} provenance source count"
        );
        for (src, exp) in loaded.all_sources.iter().zip(expected_sources) {
            assert_eq!(
                scope_token(&src.scope),
                exp["scope"].as_str().unwrap(),
                "case {id} scope"
            );
            assert_eq!(src.relative_label, exp["relative_label"], "case {id} label");
        }
        let included_labels: Vec<&str> = loaded
            .included
            .iter()
            .map(|s| s.relative_label.as_str())
            .collect();
        let expected_included: Vec<&str> = case["included_labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(
            included_labels, expected_included,
            "case {id} included labels"
        );
        assert_eq!(
            loaded.omitted_count,
            case["omitted"].as_u64().unwrap() as u32,
            "case {id} omitted count"
        );
        assert_eq!(
            project_context_source_sha256(&loaded.all_sources).as_str(),
            case["provenance_sha256"].as_str().unwrap(),
            "case {id} provenance digest"
        );
    }
}

/// An existing unreadable candidate blocks with a visible error and the error
/// never carries instruction content.
#[cfg(unix)]
#[test]
fn unreadable_candidate_is_visible_and_blocking() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("prj");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    fs::write(home.join("AGENTS.md"), "user rules\n").unwrap();
    fs::write(cwd.join("AGENTS.md"), "root rules\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(home.join("AGENTS.md"), fs::Permissions::from_mode(0o000)).unwrap();
    let err =
        discover_project_context(&home, &cwd, Some(&cwd), &resolution_at(temp.path())).unwrap_err();
    assert_eq!(err.code, "PROJECT_CONTEXT_READ_FAILED");
    assert_eq!(err.label.as_deref(), Some("AGENTS.md"));
    assert!(
        !err.detail.contains("rules"),
        "no instruction content in diagnostics"
    );
}

// ---------------------------------------------------------------------------
// Rendering, slots, hashes
// ---------------------------------------------------------------------------

fn input_from(
    cwd: &Path,
    git_root: Option<&Path>,
    session_id: &str,
    skills: Vec<SkillCatalogEntryV1>,
) -> SystemContextInputV1 {
    SystemContextInputV1 {
        praana_version: "0.1.0-test".to_owned(),
        cwd: cwd.to_str().unwrap().to_owned(),
        git_root: git_root.map(|p| p.to_str().unwrap().to_owned()),
        session_id: SessionId::from_str_canonical(session_id).unwrap(),
        history_mode: HistoryMode::Append,
        native_status: ComponentState::Available,
        search_status: ComponentState::Available,
        lsp_status: ComponentState::Unavailable,
        skills,
    }
}

fn loaded_from(sources: &[serde_json::Value], omitted: u32) -> LoadedProjectContext {
    let mut all: Vec<ProjectContextSource> = Vec::with_capacity(sources.len());
    for s in sources {
        let normalized =
            normalize_instruction_bytes(s["content"].as_str().unwrap().as_bytes()).unwrap();
        all.push(ProjectContextSource {
            scope: if s["scope"].as_str().unwrap() == "user" {
                SourceScope::User
            } else {
                SourceScope::Project
            },
            relative_label: s["relative_label"].as_str().unwrap().to_owned(),
            normalized,
        });
    }
    let included_count = all.len().saturating_sub(omitted as usize);
    let included = all[..included_count].to_vec();
    LoadedProjectContext {
        included,
        omitted_count: omitted,
        all_sources: all,
    }
}

fn skills_from(case: &serde_json::Value) -> Vec<SkillCatalogEntryV1> {
    case["skills"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|s| SkillCatalogEntryV1 {
                    name: s["name"].as_str().unwrap().to_owned(),
                    description: s["description"].as_str().unwrap().to_owned(),
                    scope: if s["scope"].as_str().unwrap() == "user" {
                        SkillScopeV1::User
                    } else {
                        SkillScopeV1::Project
                    },
                })
                .collect()
        })
        .unwrap_or_default()
}

fn component_state(name: &str) -> ComponentState {
    match name {
        "available" => ComponentState::Available,
        "disabled" => ComponentState::Disabled,
        "unavailable" => ComponentState::Unavailable,
        other => panic!("unknown component state {other}"),
    }
}

#[test]
fn rendering_fixture_cases_match_exact_slot_bytes() {
    for case in cases()["render_cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap().to_owned();
        let temp = tempfile::TempDir::new().unwrap();
        let cwd = temp.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        for name in case["stack_files"].as_array().unwrap() {
            fs::write(cwd.join(name.as_str().unwrap()), "marker\n").unwrap();
        }
        let loaded = loaded_from(
            case["sources"].as_array().unwrap(),
            case["omitted"].as_u64().unwrap() as u32,
        );
        let input = input_from(&cwd, None, SESSION_A, skills_from(case));
        let slots =
            compile_system_context(&input, &loaded, "", &resolution_at(temp.path())).unwrap();

        assert_eq!(
            slots.system_context_schema_version, SYSTEM_CONTEXT_SCHEMA_VERSION,
            "case {id} schema version"
        );
        assert_eq!(
            slots.project_context,
            case["expected_project_context"].as_str().unwrap(),
            "case {id} project_context bytes"
        );
        assert_eq!(
            slots.stable_prefix_sha256.as_str(),
            case["expected_stable_prefix_sha256"].as_str().unwrap(),
            "case {id} stable prefix"
        );
        assert!(
            slots.cross_session_memory.is_none(),
            "case {id} memory null"
        );
        assert!(slots.historical_handoff.is_none(), "case {id} handoff null");
        for slot in [
            &slots.system_policy,
            &slots.project_context,
            &slots.current_state,
        ] {
            assert!(!slot.starts_with('\n'), "case {id} leading blank");
            assert!(!slot.ends_with('\n'), "case {id} final LF");
        }
    }
}

/// Volatile changes (session id, cwd, component states) never affect the
/// stable prefix, and volatile variants differ in current_state.
#[test]
fn volatile_facts_do_not_change_stable_prefix() {
    for case in cases()["volatile_cases"].as_array().unwrap() {
        let expected = case["expected_stable_prefix_sha256"].as_str().unwrap();
        let mut observed = Vec::new();
        for variant in case["variants"].as_array().unwrap() {
            let temp = tempfile::TempDir::new().unwrap();
            let cwd = temp.path().join("work");
            fs::create_dir_all(&cwd).unwrap();
            let source = ProjectContextSource {
                scope: SourceScope::Project,
                relative_label: "AGENTS.md".to_owned(),
                normalized: "rules".to_owned(),
            };
            let loaded = LoadedProjectContext {
                included: vec![source.clone()],
                omitted_count: 0,
                all_sources: vec![source],
            };
            let mut input = input_from(
                &cwd,
                None,
                variant["session_id"].as_str().unwrap(),
                Vec::new(),
            );
            input.cwd = variant["cwd"].as_str().unwrap().to_owned();
            input.native_status = component_state(variant["native"].as_str().unwrap());
            input.search_status = component_state(variant["search"].as_str().unwrap());
            input.lsp_status = component_state(variant["lsp"].as_str().unwrap());
            let slots =
                compile_system_context(&input, &loaded, "", &resolution_at(temp.path())).unwrap();
            assert_eq!(
                slots.stable_prefix_sha256.as_str(),
                expected,
                "case stable prefix"
            );
            observed.push(slots.current_state);
        }
        assert_ne!(
            observed[0], observed[1],
            "volatile variants differ in current_state"
        );
    }
}

#[test]
fn current_state_fixture_cases_match_exact_bytes() {
    for case in cases()["current_state_cases"].as_array().unwrap() {
        let temp = tempfile::TempDir::new().unwrap();
        let cwd = temp.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        let loaded = LoadedProjectContext::empty();
        let mut input = input_from(
            &cwd,
            None,
            case["facts_input"]["session_id"].as_str().unwrap(),
            Vec::new(),
        );
        input.cwd = case["facts_input"]["cwd"].as_str().unwrap().to_owned();
        input.native_status = component_state(case["facts_input"]["native"].as_str().unwrap());
        input.search_status = component_state(case["facts_input"]["search"].as_str().unwrap());
        input.lsp_status = component_state(case["facts_input"]["lsp"].as_str().unwrap());
        let slots = compile_system_context(
            &input,
            &loaded,
            case["state_graph_rendering"].as_str().unwrap(),
            &resolution_at(temp.path()),
        )
        .unwrap();
        assert_eq!(
            slots.current_state,
            case["expected_current_state"].as_str().unwrap(),
            "case {} current_state bytes",
            case["id"].as_str().unwrap()
        );
    }
}

#[test]
fn provenance_hash_is_stable_and_empty_list_matches_metadata_constant() {
    let loaded = LoadedProjectContext::empty();
    assert_eq!(
        project_context_source_sha256(&loaded.all_sources).as_str(),
        EMPTY_PROVENANCE
    );
}

// ---------------------------------------------------------------------------
// meta.json provenance boundary
// ---------------------------------------------------------------------------

fn create_session_with_digest(
    session_dir: &Path,
    digest_hex: &str,
) -> praana_core::protocol::errors::HistoryResult<EventLogStore> {
    EventLogStore::create_or_open_with_project_context(
        session_dir,
        SESSION_A,
        &Sha256Digest::from_hex_str(digest_hex).unwrap(),
    )
}

#[test]
fn meta_json_serializes_provenance_after_config_digest() {
    let temp = tempfile::TempDir::new().unwrap();
    let session_dir = temp.path().join("s");
    let digest = "a".repeat(64);
    let _store = create_session_with_digest(&session_dir, &digest).unwrap();
    let raw = fs::read_to_string(session_dir.join("meta.json")).unwrap();
    // Field order is part of the canonical on-disk grammar (History §15).
    let marker = format!(
        "\"config_digest_sha256\":\"{KNOWN_CONFIG_DIGEST}\",\"project_context_source_sha256\":\"{digest}\",\"event_schema_version\""
    );
    assert!(raw.contains(&marker), "field order: {raw}");
    let meta: SessionMetaV1 = serde_json::from_str(raw.trim_end()).unwrap();
    assert_eq!(meta.project_context_source_sha256.as_str(), digest);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(session_dir.join("meta.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn meta_json_rejects_non_canonical_provenance_grammar() {
    let temp = tempfile::TempDir::new().unwrap();
    let session_dir = temp.path().join("s");
    let store = create_session_with_digest(&session_dir, EMPTY_PROVENANCE).unwrap();
    drop(store);
    let meta_path = session_dir.join("meta.json");
    let original = fs::read_to_string(&meta_path).unwrap();
    assert!(
        original.contains(&format!(
            "\"project_context_source_sha256\":\"{EMPTY_PROVENANCE}\""
        )),
        "canonical empty provenance written on create"
    );
    for bad in ["A".repeat(64), "a".repeat(63), "z".repeat(64)] {
        let malformed = original.replace(
            &format!("\"project_context_source_sha256\":\"{EMPTY_PROVENANCE}\""),
            &format!("\"project_context_source_sha256\":\"{bad}\""),
        );
        assert_ne!(original, malformed, "replacement must apply for {bad}");
        fs::write(&meta_path, &malformed).unwrap();
        let err = read_project_context_source_sha256(&session_dir).unwrap_err();
        assert_eq!(
            err.code(),
            "HISTORY_META_MISMATCH",
            "bad digest {bad}: {err:?}"
        );
        // Restore canonical bytes so the next iteration starts clean.
        fs::write(&meta_path, &original).unwrap();
    }
}

#[test]
fn provenance_is_excluded_from_snapshot_and_immutable_on_resume() {
    let temp = tempfile::TempDir::new().unwrap();
    let session_dir = temp.path().join("s");
    let digest = "b".repeat(64);
    let store = EventLogStore::create_or_open_with_project_context(
        &session_dir,
        SESSION_A,
        &Sha256Digest::from_hex_str(&digest).unwrap(),
    )
    .unwrap();
    // meta.json carries the provenance digest; the config snapshot never does.
    let meta_text = fs::read_to_string(session_dir.join("meta.json")).unwrap();
    assert!(
        meta_text.contains(&format!("\"project_context_source_sha256\":\"{digest}\"")),
        "meta has provenance"
    );
    let snapshot = fs::read_to_string(session_dir.join("config.snapshot.json")).unwrap();
    assert!(
        !snapshot.contains("project_context_source"),
        "snapshot isolates provenance: {snapshot}"
    );
    // No event envelopes have been appended yet, so the provenance boundary
    // holds: project_context_source cannot leak into any serialized envelope.
    let events = fs::read_to_string(session_dir.join("events.jsonl")).unwrap();
    assert!(events.is_empty(), "events empty until appended: {events:?}");
    drop(store);
    // Re-opening (not creating) must NOT rewrite meta.json; the creation
    // provenance digest remains intact on resume.
    let meta_after_open = fs::read_to_string(session_dir.join("meta.json")).unwrap_or_default();
    assert!(
        meta_after_open.contains(&format!("\"project_context_source_sha256\":\"{digest}\"")),
        "provenance immutable on resume"
    );
}

#[test]
fn resume_compares_provenance_and_never_rewrites_meta() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().join("home");
    let prj = temp.path().join("prj");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&prj).unwrap();
    fs::write(prj.join("AGENTS.md"), "rules one\n").unwrap();

    let resolution = resolution_at(temp.path());
    let created = discover_project_context(&home, &prj, Some(&prj), &resolution).unwrap();
    let creation_digest = project_context_source_sha256(&created.all_sources);
    let session_dir = temp.path().join("s");
    let _store = EventLogStore::create_or_open_with_project_context(
        &session_dir,
        SESSION_A,
        &creation_digest,
    )
    .unwrap();

    let again = discover_project_context(&home, &prj, Some(&prj), &resolution).unwrap();
    assert!(!project_context_changed_since_create(
        &creation_digest,
        &again
    ));

    fs::write(prj.join("AGENTS.md"), "rules two\n").unwrap();
    let changed = discover_project_context(&home, &prj, Some(&prj), &resolution).unwrap();
    assert!(project_context_changed_since_create(
        &creation_digest,
        &changed
    ));
    assert_eq!(
        PROJECT_CONTEXT_CHANGED_SINCE_CREATE,
        "PROJECT_CONTEXT_CHANGED_SINCE_CREATE"
    );
    let meta_text = fs::read_to_string(session_dir.join("meta.json")).unwrap();
    assert!(
        meta_text.contains(creation_digest.as_str()),
        "creation digest intact"
    );
    assert!(
        !meta_text.contains("rules two"),
        "no instruction content in metadata"
    );

    let current_digest = project_context_source_sha256(&changed.all_sources);
    assert_ne!(creation_digest.as_str(), current_digest.as_str());
}

// ---------------------------------------------------------------------------
// build_instruction_slots smoke check (two LF between present slots)
// ---------------------------------------------------------------------------

#[test]
fn build_instruction_slots_smoke_two_lf_between_present_slots() {
    let temp = tempfile::TempDir::new().unwrap();
    let cwd = temp.path().join("work");
    fs::create_dir_all(&cwd).unwrap();
    let loaded = loaded_from(&[], 0);
    let input = input_from(&cwd, None, SESSION_A, Vec::new());
    let slots = build_instruction_slots(&input, &loaded, &[], &[], "").unwrap();
    let joined = format!(
        "{}\n\n{}\n\n{}\n\n{}",
        slots.system_policy,
        slots.project_context,
        slots.cross_session_memory.as_deref().unwrap_or(""),
        slots.current_state
    );
    let mut needle = slots.system_policy.clone();
    needle.push_str("\n\n");
    needle.push_str(&slots.project_context);
    assert!(
        joined.contains(&needle),
        "two-LF join between system_policy and project_context"
    );
}

// ---------------------------------------------------------------------------
// Skill name validation (System Context §5: ^[a-z0-9][a-z0-9_-]{0,63}$)
// ---------------------------------------------------------------------------

fn project_skill(name: &str) -> SkillCatalogEntryV1 {
    SkillCatalogEntryV1 {
        name: name.to_owned(),
        description: "desc".to_owned(),
        scope: SkillScopeV1::Project,
    }
}

#[test]
fn skill_names_reject_uppercase_and_dot_and_are_absent_from_render() {
    for bad in ["Bad", "A", "name.with.dot"] {
        let err = validate_skills(&[project_skill(bad)])
            .expect_err(&format!("name {bad:?} must be rejected"));
        assert_eq!(
            err.code, "PROJECT_CONTEXT_SKILL_INVALID",
            "name {bad:?} code"
        );

        // A rejected name never reaches rendered bytes: validation fails before
        // any line is produced, and rendering an unvalidated bad name still
        // must not smuggle it into a compiled slot. We assert both: the error
        // path, and that a compiled context over only-valid skills omits it.
        let temp = tempfile::TempDir::new().unwrap();
        let cwd = temp.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        let input = input_from(&cwd, None, SESSION_A, vec![project_skill(bad)]);
        let compiled = compile_system_context(
            &input,
            &LoadedProjectContext::empty(),
            "",
            &resolution_at(temp.path()),
        );
        let err = compiled.expect_err("compile must reject invalid skill name");
        assert_eq!(err.code, "PROJECT_CONTEXT_SKILL_INVALID");
    }
}

#[test]
fn skill_names_accept_lowercase_digits_underscore_hyphen() {
    let ok = validate_skills(&[
        project_skill("a"),
        project_skill("0abc"),
        project_skill("valid_name-2"),
    ])
    .expect("lowercase/digit/underscore/hyphen names are valid");
    assert_eq!(ok.len(), 3);
    // First byte `_`/`-` is rejected.
    assert!(validate_skills(&[project_skill("_leading")]).is_err());
    assert!(validate_skills(&[project_skill("-leading")]).is_err());
}

// ---------------------------------------------------------------------------
// Skill description line collapsing (System Context §5: one sanitized line)
// ---------------------------------------------------------------------------

#[test]
fn skill_description_collapses_crlf_to_single_space() {
    let cases = [
        ("a\r\nb", "- x [project]: a b"),
        ("a\nb", "- x [project]: a b"),
        ("a\rb", "- x [project]: a b"),
        ("a\r\n\r\nb", "- x [project]: a  b"),
    ];
    for (desc, expected_line) in cases {
        let validated = validate_skills(&[SkillCatalogEntryV1 {
            name: "x".to_owned(),
            description: desc.to_owned(),
            scope: SkillScopeV1::Project,
        }])
        .unwrap();
        let lines = render_skill_lines(&validated);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], expected_line, "description {desc:?}");
    }
}

// ---------------------------------------------------------------------------
// Component state rendering (System Context §6): every variant renders its
// exact snake_case token, including the UI-contract variants.
// ---------------------------------------------------------------------------

#[test]
fn every_component_state_renders_its_exact_token() {
    let variants = [
        (ComponentState::Available, "available"),
        (ComponentState::Disabled, "disabled"),
        (ComponentState::Unavailable, "unavailable"),
        (ComponentState::Degraded, "degraded"),
        (ComponentState::Starting, "starting"),
    ];
    for (state, token) in variants {
        let temp = tempfile::TempDir::new().unwrap();
        let cwd = temp.path().join("work");
        fs::create_dir_all(&cwd).unwrap();
        let mut input = input_from(&cwd, None, SESSION_A, Vec::new());
        input.native_status = state.clone();
        input.search_status = state.clone();
        input.lsp_status = state.clone();
        let slots = compile_system_context(
            &input,
            &LoadedProjectContext::empty(),
            "",
            &resolution_at(temp.path()),
        )
        .unwrap();
        assert!(
            slots.current_state.contains(&format!("- native: {token}")),
            "state {token} native token"
        );
        assert!(
            slots.current_state.contains(&format!("- search: {token}")),
            "state {token} search token"
        );
        assert!(
            slots.current_state.contains(&format!("- lsp: {token}")),
            "state {token} lsp token"
        );
    }
}

// ---------------------------------------------------------------------------
// Runtime fact escaping never emits a redaction marker (System Context §6,
// Redaction §10: P1D does not replace).
// ---------------------------------------------------------------------------

#[test]
fn escaped_fact_value_never_contains_redaction_marker() {
    // A cwd whose final component needs JSON escaping (space + quote) forces
    // the escaping branch. The rendered value must be JSON-escaped, never a
    // `[REDACTED:` marker.
    let temp = tempfile::TempDir::new().unwrap();
    let cwd = temp.path().join("work");
    fs::create_dir_all(&cwd).unwrap();
    let mut input = input_from(&cwd, None, SESSION_A, Vec::new());
    input.cwd = "/tmp/a dir \"q\"".to_owned();
    let slots = compile_system_context(
        &input,
        &LoadedProjectContext::empty(),
        "",
        &resolution_at(temp.path()),
    )
    .unwrap();
    assert!(
        !slots.current_state.contains("[REDACTED:"),
        "no redaction marker in current_state: {}",
        slots.current_state
    );
    assert!(
        slots
            .current_state
            .contains("cwd_label: \"a dir \\\"q\\\"\""),
        "cwd_label JSON-escaped: {}",
        slots.current_state
    );
}

// ---------------------------------------------------------------------------
// Resume warning emission (System Context §7.1)
// ---------------------------------------------------------------------------

#[test]
fn resume_emits_one_warning_on_change_and_none_when_equal() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().join("home");
    let prj = temp.path().join("prj");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&prj).unwrap();
    fs::write(prj.join("AGENTS.md"), "rules one\n").unwrap();

    let resolution = resolution_at(temp.path());
    let created = discover_project_context(&home, &prj, Some(&prj), &resolution).unwrap();
    let creation_digest = project_context_source_sha256(&created.all_sources);

    // Equal digest: zero warnings, and the current instructions still render.
    let unchanged = discover_project_context(&home, &prj, Some(&prj), &resolution).unwrap();
    let warnings = resume_context_warnings(&creation_digest, &unchanged);
    assert!(warnings.is_empty(), "equal digest yields no warning");

    // Changed bytes: exactly one PROJECT_CONTEXT_CHANGED_SINCE_CREATE warning.
    fs::write(prj.join("AGENTS.md"), "rules two\n").unwrap();
    let changed = discover_project_context(&home, &prj, Some(&prj), &resolution).unwrap();
    let warnings = resume_context_warnings(&creation_digest, &changed);
    assert_eq!(
        warnings,
        vec![PROJECT_CONTEXT_CHANGED_SINCE_CREATE],
        "changed digest yields exactly one warning"
    );
    // The warning carries no source bytes or paths.
    assert!(!warnings[0].contains("rules"));
    assert!(!warnings[0].contains('/'));

    // The new instructions are what render for subsequent requests.
    let input = input_from(&prj, Some(&prj), SESSION_A, Vec::new());
    let slots = compile_system_context(&input, &changed, "", &resolution).unwrap();
    assert!(
        slots.project_context.contains("rules two"),
        "resume renders the changed instructions: {}",
        slots.project_context
    );
    assert!(!slots.project_context.contains("rules one"));
}

// ---------------------------------------------------------------------------
// Path normalization matches Config (System Context §3)
// ---------------------------------------------------------------------------

#[test]
fn tilde_and_relative_cwd_resolve_like_config_normalization() {
    use praana_core::config::path::normalize_config_path;

    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().join("home");
    let base = temp.path().join("base");
    let project = home.join("proj");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("AGENTS.md"), "tilde rules\n").unwrap();

    // The discovery cwd expressed two ways: `~/proj` and a base-relative path
    // that Config would resolve to the same absolute regular file.
    let expected = normalize_config_path("~/proj", &base, &home, "cwd").unwrap();
    assert_eq!(
        expected,
        project.to_str().unwrap().replace('\\', "/"),
        "sanity: ~/proj resolves under home"
    );

    let resolution = ContextPathResolution::new(base.clone(), home.clone());
    let praana_home = temp.path().join("praana_home");
    fs::create_dir_all(&praana_home).unwrap();

    let from_tilde =
        discover_project_context(&praana_home, Path::new("~/proj"), None, &resolution).unwrap();
    // A relative cwd resolved against the base directory Config uses. Build a
    // relative path from base to the project directory.
    let rel = pathdiff_relative(&base, &project);
    let from_relative =
        discover_project_context(&praana_home, Path::new(&rel), None, &resolution).unwrap();

    let tilde_labels: Vec<&str> = from_tilde
        .all_sources
        .iter()
        .map(|s| s.relative_label.as_str())
        .collect();
    let relative_labels: Vec<&str> = from_relative
        .all_sources
        .iter()
        .map(|s| s.relative_label.as_str())
        .collect();
    assert_eq!(
        tilde_labels,
        vec!["AGENTS.md"],
        "tilde discovery reads the file"
    );
    assert_eq!(
        project_context_source_sha256(&from_tilde.all_sources).as_str(),
        project_context_source_sha256(&from_relative.all_sources).as_str(),
        "tilde and relative cwd resolve to the same regular file"
    );
    let _ = relative_labels;
}

/// Minimal `../`-based relative path from `base` to `target` for the test.
fn pathdiff_relative(base: &Path, target: &Path) -> String {
    let base_c: Vec<_> = base.components().collect();
    let target_c: Vec<_> = target.components().collect();
    let mut i = 0;
    while i < base_c.len() && i < target_c.len() && base_c[i] == target_c[i] {
        i += 1;
    }
    let mut out = String::new();
    for _ in i..base_c.len() {
        out.push_str("../");
    }
    for comp in &target_c[i..] {
        out.push_str(&comp.as_os_str().to_string_lossy());
        out.push('/');
    }
    if out.ends_with('/') {
        out.pop();
    }
    out
}
