#![deny(clippy::all)]

mod lang;
mod parse;
mod project;
mod symbols;
mod types;

use std::path::Path;

use napi_derive::napi;

pub use types::*;

/// Semver of the native *API surface* (independent of npm package version).
/// Bump major when removing/renaming exports or changing result shapes incompatibly.
pub const NATIVE_API_VERSION: &str = "0.2.0";

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
  let p = Path::new(&path);
  match parse::read_and_parse(p, language.as_deref()) {
    Ok(parsed) => {
      let diagnostics = parse::collect_diagnostics(&parsed.tree, &parsed.source);
      ParseFileResult {
        ok: true,
        error: None,
        code: None,
        language: Some(parsed.lang.as_str().to_string()),
        diagnostics,
      }
    }
    Err((code, error)) => ParseFileResult::err(&code, error),
  }
}

#[napi]
pub fn list_symbols(path: String, language: Option<String>) -> ListSymbolsResult {
  let p = Path::new(&path);
  match parse::read_and_parse(p, language.as_deref()) {
    Ok(parsed) => match symbols::extract_symbols(&parsed, p) {
      Ok(syms) => ListSymbolsResult {
        ok: true,
        error: None,
        code: None,
        language: Some(parsed.lang.as_str().to_string()),
        symbols: syms,
      },
      Err(e) => ListSymbolsResult::err("internal", e),
    },
    Err((code, error)) => ListSymbolsResult::err(&code, error),
  }
}

#[napi]
pub fn list_imports(path: String, language: Option<String>) -> ListImportsResult {
  let p = Path::new(&path);
  match parse::read_and_parse(p, language.as_deref()) {
    Ok(parsed) => match symbols::extract_imports(&parsed, p) {
      Ok(imports) => ListImportsResult {
        ok: true,
        error: None,
        code: None,
        language: Some(parsed.lang.as_str().to_string()),
        imports,
      },
      Err(e) => ListImportsResult::err("internal", e),
    },
    Err((code, error)) => ListImportsResult::err(&code, error),
  }
}

#[napi]
pub fn find_definition(
  root: String,
  symbol: String,
  opts: Option<ProjectQueryOpts>,
) -> ProjectHitsResult {
  project::find_definition(Path::new(&root), &symbol, opts)
}

#[napi]
pub fn find_references(
  root: String,
  symbol: String,
  opts: Option<ProjectQueryOpts>,
) -> ProjectHitsResult {
  project::find_references(Path::new(&root), &symbol, opts)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn version_is_semverish() {
    assert!(NATIVE_API_VERSION.contains('.'));
  }

  #[test]
  fn ping_returns_pong() {
    assert_eq!(ping(), "pong");
  }
}
