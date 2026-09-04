//! PRAANA native capability layer — thin N-API wrapper.
//!
//! Every export converts JavaScript inputs into core values, calls one
//! `praana_native_core` function, and converts the result or error into the
//! existing N-API result shape. No parsing, walking, regex, tokenization, or
//! ONNX logic lives here.

use std::path::Path;

use napi_derive::napi;

pub const NATIVE_API_VERSION: &str = "0.3.0";

mod convert;
mod types;

pub use types::*;

#[napi]
pub fn native_version() -> String {
    NATIVE_API_VERSION.to_string()
}

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}

#[napi]
pub fn parse_file(path: String, language: Option<String>) -> ParseFileResult {
    convert::parse_file_result(praana_native_core::parse_file(
        Path::new(&path),
        language.as_deref(),
    ))
}

#[napi]
pub fn list_symbols(path: String, language: Option<String>) -> ListSymbolsResult {
    convert::list_symbols_result(praana_native_core::list_symbols(
        Path::new(&path),
        language.as_deref(),
    ))
}

#[napi]
pub fn list_imports(path: String, language: Option<String>) -> ListImportsResult {
    convert::list_imports_result(praana_native_core::list_imports(
        Path::new(&path),
        language.as_deref(),
    ))
}

#[napi]
pub fn find_definition(
    root: String,
    symbol: String,
    opts: Option<ProjectQueryOpts>,
) -> ProjectHitsResult {
    convert::project_hits_result(praana_native_core::find_definition(
        Path::new(&root),
        &symbol,
        convert::project_options_from_napi(opts),
    ))
}

#[napi]
pub fn find_references(
    root: String,
    symbol: String,
    opts: Option<ProjectQueryOpts>,
) -> ProjectHitsResult {
    convert::project_hits_result(praana_native_core::find_references(
        Path::new(&root),
        &symbol,
        convert::project_options_from_napi(opts),
    ))
}

#[napi]
pub fn grep(opts: GrepOpts) -> GrepResult {
    convert::grep_result(praana_native_core::grep(convert::grep_options_from_napi(
        opts,
    )))
}

#[napi]
pub fn find_files(opts: FindFilesOpts) -> FindFilesResult {
    convert::find_files_result(praana_native_core::find_files(
        convert::find_files_options_from_napi(opts),
    ))
}

#[napi]
pub fn embed_text(text: String, model_dir: String) -> EmbedResult {
    convert::embed_result(praana_native_core::embed_text(&text, Path::new(&model_dir)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_semverish() {
        assert!(NATIVE_API_VERSION.contains('.'));
    }
}
