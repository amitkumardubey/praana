//! PRAANA pure native capability layer (tree-sitter, search, embeddings).
//!
//! This crate owns the real implementations; the `praana-natives` N-API
//! wrapper delegates here. Ownership moves module by module during Phase 0.

pub mod error;
pub mod lang;
pub mod parse;
pub mod project;
pub mod search;
pub mod symbols;
pub mod types;

#[cfg(feature = "embeddings")]
pub mod embed;

use std::path::Path;

pub use error::{NativeError, NativeErrorCode, NativeResult};
pub use types::{
    FindFilesMatch, FindFilesOptions, FindFilesOutput, GrepMatch, GrepOptions, GrepOutput,
    ImportHit, ListImportsOutput, ListSymbolsOutput, ParseDiagnostic, ParseFileOutput,
    ProjectHitsOutput, ProjectQueryOptions, SymbolHit,
};

#[cfg(feature = "embeddings")]
pub use types::EmbedOutput;

/// Parse a source file and collect syntax diagnostics.
pub fn parse_file(path: &Path, language: Option<&str>) -> NativeResult<ParseFileOutput> {
    let parsed = parse::read_and_parse(path, language)?;
    let diagnostics = parse::collect_diagnostics(&parsed.tree, &parsed.source);
    Ok(ParseFileOutput {
        language: Some(parsed.lang.as_str().to_string()),
        diagnostics,
    })
}

/// List symbol definitions in one file.
pub fn list_symbols(path: &Path, language: Option<&str>) -> NativeResult<ListSymbolsOutput> {
    let parsed = parse::read_and_parse(path, language)?;
    let symbols = symbols::extract_symbols(&parsed, path)
        .map_err(|message| NativeError::new(NativeErrorCode::Internal, message))?;
    Ok(ListSymbolsOutput {
        language: Some(parsed.lang.as_str().to_string()),
        symbols,
    })
}

/// List imports in one file.
pub fn list_imports(path: &Path, language: Option<&str>) -> NativeResult<ListImportsOutput> {
    let parsed = parse::read_and_parse(path, language)?;
    let imports = symbols::extract_imports(&parsed, path)
        .map_err(|message| NativeError::new(NativeErrorCode::Internal, message))?;
    Ok(ListImportsOutput {
        language: Some(parsed.lang.as_str().to_string()),
        imports,
    })
}

/// Search definition sites of a symbol across a project root.
pub fn find_definition(
    root: &Path,
    symbol: &str,
    options: ProjectQueryOptions,
) -> NativeResult<ProjectHitsOutput> {
    project::find_definition(root, symbol, options)
}

/// Search reference sites of a symbol across a project root.
pub fn find_references(
    root: &Path,
    symbol: &str,
    options: ProjectQueryOptions,
) -> NativeResult<ProjectHitsOutput> {
    project::find_references(root, symbol, options)
}

/// Grep file contents under a root path.
pub fn grep(options: GrepOptions) -> NativeResult<GrepOutput> {
    search::grep(options)
}

/// Fuzzy / glob file search under a root path.
pub fn find_files(options: FindFilesOptions) -> NativeResult<FindFilesOutput> {
    search::find_files(options)
}

/// Embed text into a normalized vector using a local ONNX model directory.
#[cfg(feature = "embeddings")]
pub fn embed_text(text: &str, model_dir: &Path) -> NativeResult<EmbedOutput> {
    embed::embed_text(text, model_dir)
}
