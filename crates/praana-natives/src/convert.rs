//! Conversions between N-API DTOs and core DTOs plus success/error envelope
//! construction. Nothing else lives here.

use praana_native_core::{NativeErrorCode, NativeResult};

use crate::types::{
    EmbedResult, FindFilesMatch, FindFilesOpts, FindFilesResult, GrepMatch, GrepOpts, GrepResult,
    ImportHit, ListImportsResult, ListSymbolsResult, ParseDiagnostic, ParseFileResult,
    ProjectHitsResult, ProjectQueryOpts, SymbolHit,
};

fn code_str(code: &NativeErrorCode) -> &'static str {
    code.as_str()
}

// ── Parse ────────────────────────────────────────────────────

fn parse_diagnostic(value: praana_native_core::ParseDiagnostic) -> ParseDiagnostic {
    ParseDiagnostic {
        message: value.message,
        start_line: value.start_line,
        start_col: value.start_col,
        end_line: value.end_line,
        end_col: value.end_col,
    }
}

pub fn parse_file_result(
    result: NativeResult<praana_native_core::ParseFileOutput>,
) -> ParseFileResult {
    match result {
        Ok(out) => ParseFileResult {
            ok: true,
            error: None,
            code: None,
            language: out.language,
            diagnostics: out.diagnostics.into_iter().map(parse_diagnostic).collect(),
        },
        Err(e) => ParseFileResult::err(code_str(&e.code), e.message),
    }
}

// ── Symbols / imports ────────────────────────────────────────

fn symbol_hit(value: praana_native_core::SymbolHit) -> SymbolHit {
    SymbolHit {
        path: value.path.to_string_lossy().into_owned(),
        name: value.name,
        kind: value.kind,
        exported: value.exported,
        start_line: value.start_line,
        start_col: value.start_col,
        end_line: value.end_line,
        end_col: value.end_col,
    }
}

fn import_hit(value: praana_native_core::ImportHit) -> ImportHit {
    ImportHit {
        path: value.path.to_string_lossy().into_owned(),
        source: value.source,
        names: value.names,
        start_line: value.start_line,
        start_col: value.start_col,
        end_line: value.end_line,
        end_col: value.end_col,
    }
}

pub fn list_symbols_result(
    result: NativeResult<praana_native_core::ListSymbolsOutput>,
) -> ListSymbolsResult {
    match result {
        Ok(out) => ListSymbolsResult {
            ok: true,
            error: None,
            code: None,
            language: out.language,
            symbols: out.symbols.into_iter().map(symbol_hit).collect(),
        },
        Err(e) => ListSymbolsResult::err(code_str(&e.code), e.message),
    }
}

pub fn list_imports_result(
    result: NativeResult<praana_native_core::ListImportsOutput>,
) -> ListImportsResult {
    match result {
        Ok(out) => ListImportsResult {
            ok: true,
            error: None,
            code: None,
            language: out.language,
            imports: out.imports.into_iter().map(import_hit).collect(),
        },
        Err(e) => ListImportsResult::err(code_str(&e.code), e.message),
    }
}

// ── Project queries ──────────────────────────────────────────

pub fn project_options_from_napi(
    opts: Option<ProjectQueryOpts>,
) -> praana_native_core::ProjectQueryOptions {
    match opts {
        None => praana_native_core::ProjectQueryOptions::default(),
        Some(o) => praana_native_core::ProjectQueryOptions {
            language: o.language,
            max_files: o.max_files,
            max_hits: o.max_hits,
        },
    }
}

pub fn project_hits_result(
    result: NativeResult<praana_native_core::ProjectHitsOutput>,
) -> ProjectHitsResult {
    match result {
        Ok(out) => ProjectHitsResult {
            ok: true,
            error: None,
            code: None,
            hits: out.hits.into_iter().map(symbol_hit).collect(),
            truncated: out.truncated,
            files_scanned: out.files_scanned,
        },
        Err(e) => ProjectHitsResult::err(code_str(&e.code), e.message),
    }
}

// ── Search ───────────────────────────────────────────────────

pub fn grep_options_from_napi(opts: GrepOpts) -> praana_native_core::GrepOptions {
    praana_native_core::GrepOptions {
        pattern: opts.pattern,
        path: std::path::PathBuf::from(opts.path),
        globs: opts.globs,
        glob_exclude: opts.glob_exclude,
        case_insensitive: opts.case_insensitive,
        context: opts.context,
        max_results: opts.max_results,
        max_file_size: opts.max_file_size,
        time_budget_ms: opts.time_budget_ms,
    }
}

pub fn grep_result(result: NativeResult<praana_native_core::GrepOutput>) -> GrepResult {
    match result {
        Ok(out) => GrepResult {
            ok: true,
            error: None,
            code: None,
            matches: out
                .matches
                .into_iter()
                .map(|m| GrepMatch {
                    path: m.path.to_string_lossy().into_owned(),
                    relative_path: m.relative_path,
                    line: m.line,
                    column: m.column,
                    text: m.text,
                    context_before: m.context_before,
                    context_after: m.context_after,
                })
                .collect(),
            truncated: out.truncated,
            files_searched: out.files_searched,
            regex_fallback: out.regex_fallback,
        },
        Err(e) => GrepResult::err(code_str(&e.code), e.message),
    }
}

pub fn find_files_options_from_napi(opts: FindFilesOpts) -> praana_native_core::FindFilesOptions {
    praana_native_core::FindFilesOptions {
        pattern: opts.pattern,
        path: std::path::PathBuf::from(opts.path),
        mode: opts.mode,
        max_results: opts.max_results,
    }
}

pub fn find_files_result(
    result: NativeResult<praana_native_core::FindFilesOutput>,
) -> FindFilesResult {
    match result {
        Ok(out) => FindFilesResult {
            ok: true,
            error: None,
            code: None,
            matches: out
                .matches
                .into_iter()
                .map(|m| FindFilesMatch {
                    path: m.path.to_string_lossy().into_owned(),
                    relative_path: m.relative_path,
                    name: m.name,
                    size: m.size as f64,
                    modified: m.modified,
                })
                .collect(),
            truncated: out.truncated,
            total_matched: out.total_matched,
        },
        Err(e) => FindFilesResult::err(code_str(&e.code), e.message),
    }
}

// ── Embeddings ───────────────────────────────────────────────

pub fn embed_result(result: NativeResult<praana_native_core::EmbedOutput>) -> EmbedResult {
    match result {
        Ok(out) => EmbedResult {
            ok: true,
            error: None,
            code: None,
            dim: out.dim,
            embedding: out.embedding.into_iter().map(|v| v as f64).collect(),
        },
        Err(e) => EmbedResult::err(code_str(&e.code), e.message),
    }
}
