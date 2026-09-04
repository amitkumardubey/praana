//! Contract lock for the N-API wrapper exports, written against the current
//! implementation before wrapper delegation (Phase 0 Step 7).
//!
//! Uses the committed fixture files under
//! `crates/praana-native-core/tests/fixtures/` by repository-relative paths.

use std::path::{Path, PathBuf};

use praana_natives::{
    embed_text, find_definition, find_files, find_references, grep, list_imports, list_symbols,
    native_version, parse_file, ping, NATIVE_API_VERSION,
};
use praana_natives::{FindFilesOpts, GrepOpts};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repository root")
}

fn fixture(rel: &str) -> PathBuf {
    repo_root()
        .join("crates/praana-native-core/tests/fixtures")
        .join(rel)
}

#[test]
fn version_is_exact_and_ping_pongs() {
    assert_eq!(native_version(), "0.3.0");
    assert_eq!(NATIVE_API_VERSION, "0.3.0");
    assert_eq!(ping(), "pong");
}

#[test]
fn clean_parse_has_no_diagnostics() {
    let result = parse_file(
        fixture("code-intel/clean.ts")
            .to_string_lossy()
            .into_owned(),
        None,
    );
    assert!(result.ok, "{:?}", result.error);
    assert_eq!(result.language.as_deref(), Some("typescript"));
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

#[test]
fn syntax_error_parse_reports_diagnostics() {
    let result = parse_file(
        fixture("code-intel/syntax-error.ts")
            .to_string_lossy()
            .into_owned(),
        None,
    );
    assert!(result.ok, "parse itself must succeed: {:?}", result.error);
    assert!(!result.diagnostics.is_empty());
}

#[test]
fn unsupported_language_reports_code() {
    let result = parse_file(
        fixture("search/src/probe.txt")
            .to_string_lossy()
            .into_owned(),
        None,
    );
    assert!(!result.ok);
    assert_eq!(result.code.as_deref(), Some("unsupported_language"));
}

#[test]
fn symbols_cover_languages_and_exports() {
    let symbols = list_symbols(
        fixture("code-intel/symbols.rs")
            .to_string_lossy()
            .into_owned(),
        None,
    );
    assert!(symbols.ok, "{:?}", symbols.error);
    assert!(symbols
        .symbols
        .iter()
        .any(|s| s.name == "fixture_function" && s.exported));
    assert!(symbols
        .symbols
        .iter()
        .any(|s| s.name == "FIXTURE_CONST" && s.exported));
    assert!(symbols.symbols.iter().all(|s| s.start_line >= 1));

    let python = list_symbols(
        fixture("code-intel/symbols.py")
            .to_string_lossy()
            .into_owned(),
        None,
    );
    assert!(python.ok);
    assert!(python.symbols.iter().any(|s| s.name == "fixture_function"));

    let go = list_symbols(
        fixture("code-intel/symbols.go")
            .to_string_lossy()
            .into_owned(),
        None,
    );
    assert!(go.ok);
    assert!(go.symbols.iter().any(|s| s.name == "FixtureFunction"));
}

#[test]
fn imports_are_listed_with_positions() {
    let imports = list_imports(
        fixture("code-intel/clean.ts")
            .to_string_lossy()
            .into_owned(),
        None,
    );
    assert!(imports.ok, "{:?}", imports.error);
    assert!(
        imports
            .imports
            .iter()
            .any(|i| i.source.contains("helper") && i.start_line == 2),
        "{:?}",
        imports.imports
    );

    let python = list_imports(
        fixture("code-intel/symbols.py")
            .to_string_lossy()
            .into_owned(),
        None,
    );
    assert!(python.ok);
    assert!(python.imports.iter().any(|i| i.source.contains("os")));
    assert!(python.imports.iter().any(|i| i.source.contains("pathlib")));
}

#[test]
fn definition_and_reference_search_work_over_a_root() {
    let root = fixture("code-intel");
    let definition = find_definition(
        root.to_string_lossy().into_owned(),
        "fixture_function".into(),
        None,
    );
    assert!(definition.ok, "{:?}", definition.error);
    assert!(
        definition
            .hits
            .iter()
            .any(|h| h.name == "fixture_function" && h.path.ends_with("symbols.rs")),
        "{:?}",
        definition.hits
    );

    let references = find_references(
        root.to_string_lossy().into_owned(),
        "FIXTURE_CONST".into(),
        None,
    );
    assert!(references.ok, "{:?}", references.error);
    assert!(references.hits.iter().any(|h| h.name == "FIXTURE_CONST"));
}

#[test]
fn grep_returns_context_one_based_lines_and_skips_node_modules() {
    let root = fixture("search");
    let result = grep(GrepOpts {
        pattern: "fixture-probe".into(),
        path: root.to_string_lossy().into_owned(),
        context: Some(1),
        ..Default::default()
    });
    assert!(result.ok, "{:?}", result.error);
    assert!(
        result
            .matches
            .iter()
            .any(|m| m.text.contains("fixture-probe-alpha")),
        "{:?}",
        result.matches
    );
    assert!(
        result
            .matches
            .iter()
            .any(|m| m.text.contains("fixture-probe-text")),
        "{:?}",
        result.matches
    );
    assert!(
        result
            .matches
            .iter()
            .all(|m| !m.path.contains("node_modules")),
        "node_modules must be skipped"
    );
    let m = result
        .matches
        .iter()
        .find(|m| m.text.contains("fixture-probe-text"))
        .unwrap();
    assert_eq!(m.line, 1);
    assert_eq!(m.column, 39);
    assert!(m.context_before.is_empty());
    assert!(m.context_after.iter().any(|l| l.contains("second line")));
}

#[test]
fn grep_invalid_regex_falls_back_to_literal() {
    let root = fixture("search");
    let result = grep(GrepOpts {
        pattern: "fixture-probe-(".into(),
        path: root.to_string_lossy().into_owned(),
        ..Default::default()
    });
    assert!(result.ok, "{:?}", result.error);
    assert!(result.regex_fallback.is_some());
}

#[test]
fn fuzzy_and_glob_file_search() {
    let root = fixture("search");
    let fuzzy = find_files(FindFilesOpts {
        pattern: "alpha".into(),
        path: root.to_string_lossy().into_owned(),
        mode: Some("fuzzy".into()),
        max_results: Some(10),
    });
    assert!(fuzzy.ok, "{:?}", fuzzy.error);
    assert!(fuzzy.matches.iter().any(|m| m.name == "alpha.ts"));

    let glob = find_files(FindFilesOpts {
        pattern: "*.txt".into(),
        path: root.to_string_lossy().into_owned(),
        mode: Some("glob".into()),
        max_results: Some(10),
    });
    assert!(glob.ok, "{:?}", glob.error);
    assert!(glob.matches.iter().any(|m| m.name == "probe.txt"));
    assert!(glob
        .matches
        .iter()
        .all(|m| !m.relative_path.contains("node_modules")));
    let probe = glob.matches.iter().find(|m| m.name == "probe.txt").unwrap();
    assert!(probe.size > 0.0);
    assert!(probe.modified > 0.0);
}

#[test]
fn missing_embedding_model_is_unavailable() {
    let result = embed_text(
        "fixture".into(),
        fixture("code-intel").to_string_lossy().into_owned(),
    );
    assert!(!result.ok);
    assert_eq!(result.code.as_deref(), Some("unavailable"));
}
