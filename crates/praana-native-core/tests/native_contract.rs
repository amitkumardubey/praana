//! Contract test for the pure native core public API (Phase 0 Steps 8–12).
//!
//! Red step: these functions do not exist until the pure implementation is
//! moved out of the N-API wrapper.

use std::path::{Path, PathBuf};

use praana_native_core::{
    find_definition, find_files, find_references, grep, list_imports, list_symbols, parse_file,
    FindFilesOptions, GrepOptions, ProjectQueryOptions,
};

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
fn parse_file_clean_fixture_has_no_diagnostics() {
    let out = parse_file(&fixture("code-intel/clean.ts"), None).expect("parse ok");
    assert_eq!(out.language.as_deref(), Some("typescript"));
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
}

#[test]
fn parse_file_syntax_error_reports_diagnostics() {
    let out = parse_file(&fixture("code-intel/syntax-error.ts"), None).expect("parse ok");
    assert!(!out.diagnostics.is_empty());
}

#[test]
fn parse_file_unsupported_language_errors() {
    let err = parse_file(&fixture("search/src/probe.txt"), None).unwrap_err();
    assert_eq!(err.code.as_str(), "unsupported_language");
}

#[test]
fn symbols_and_imports_are_listed() {
    let symbols = list_symbols(&fixture("code-intel/symbols.rs"), None).expect("symbols");
    assert!(symbols
        .symbols
        .iter()
        .any(|s| s.name == "fixture_function" && s.exported));
    assert!(symbols.symbols.iter().all(|s| s.start_line >= 1));

    let imports = list_imports(&fixture("code-intel/clean.ts"), None).expect("imports");
    assert!(
        imports
            .imports
            .iter()
            .any(|i| i.source.contains("helper") && i.start_line == 2),
        "{:?}",
        imports.imports
    );
}

#[test]
fn definition_and_reference_search_work() {
    let root = fixture("code-intel");
    let definition = find_definition(&root, "fixture_function", ProjectQueryOptions::default())
        .expect("definition");
    assert!(
        definition
            .hits
            .iter()
            .any(|h| h.name == "fixture_function"
                && h.path.to_string_lossy().ends_with("symbols.rs")),
        "{:?}",
        definition.hits
    );

    let references = find_references(&root, "FIXTURE_CONST", ProjectQueryOptions::default())
        .expect("references");
    assert!(references.hits.iter().any(|h| h.name == "FIXTURE_CONST"));
}

#[test]
fn grep_returns_matches_context_and_ignores_node_modules() {
    let ignored = fixture("search/node_modules/ignored.ts");
    assert!(
        ignored.is_file(),
        "committed Phase 0 fixture must exist: {}",
        ignored.display()
    );
    let out = grep(GrepOptions {
        pattern: "fixture-probe".into(),
        path: fixture("search"),
        context: Some(1),
        ..GrepOptions::default()
    })
    .expect("grep");
    assert!(out
        .matches
        .iter()
        .any(|m| m.text.contains("fixture-probe-alpha")));
    assert!(out
        .matches
        .iter()
        .any(|m| m.text.contains("fixture-probe-text")));
    assert!(
        out.matches
            .iter()
            .all(|m| !m.path.to_string_lossy().contains("node_modules")),
        "node_modules must be skipped"
    );
    assert!(
        out.matches
            .iter()
            .all(|m| !m.text.contains("fixture-probe-ignored")),
        "ignored.ts under node_modules must not match"
    );
    let m = out
        .matches
        .iter()
        .find(|m| m.text.contains("fixture-probe-text"))
        .unwrap();
    assert_eq!(m.line, 1);
    assert_eq!(m.column, 39);
    assert!(m.context_after.iter().any(|l| l.contains("second line")));
}

#[test]
fn grep_invalid_regex_falls_back_to_literal() {
    let out = grep(GrepOptions {
        pattern: "fixture-probe-(".into(),
        path: fixture("search"),
        ..GrepOptions::default()
    })
    .expect("grep");
    assert!(out.regex_fallback.is_some());
}

#[test]
fn find_files_fuzzy_and_glob() {
    let root = fixture("search");
    let fuzzy = find_files(FindFilesOptions {
        pattern: "alpha".into(),
        path: root.clone(),
        mode: Some("fuzzy".into()),
        max_results: Some(10),
    })
    .expect("find_files");
    assert!(fuzzy.matches.iter().any(|m| m.name == "alpha.ts"));

    let glob = find_files(FindFilesOptions {
        pattern: "*.txt".into(),
        path: root,
        mode: Some("glob".into()),
        max_results: Some(10),
    })
    .expect("find_files");
    assert!(glob.matches.iter().any(|m| m.name == "probe.txt"));
    assert!(glob
        .matches
        .iter()
        .all(|m| !m.relative_path.contains("node_modules")));
    let probe = glob.matches.iter().find(|m| m.name == "probe.txt").unwrap();
    assert!(probe.size > 0);
    // Millisecond mtime is host filesystem metadata; assert only that it is a
    // finite non-negative value so the contract stays deterministic across hosts.
    assert!(probe.modified.is_finite());
    assert!(probe.modified >= 0.0);
}

#[cfg(feature = "embeddings")]
#[test]
fn embed_text_missing_model_is_unavailable() {
    let out = praana_native_core::embed_text("fixture", &fixture("code-intel"));
    let err = out.expect_err("missing model must be unavailable");
    assert_eq!(err.code.as_str(), "unavailable");
}
