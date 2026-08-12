use napi_derive::napi;

/// Structured failure / success envelopes for code-intel exports.

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ParseDiagnostic {
  pub message: String,
  pub start_line: u32,
  pub start_col: u32,
  pub end_line: u32,
  pub end_col: u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SymbolHit {
  pub path: String,
  pub name: String,
  pub kind: String,
  pub exported: bool,
  pub start_line: u32,
  pub start_col: u32,
  pub end_line: u32,
  pub end_col: u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ImportHit {
  pub path: String,
  pub source: String,
  pub names: Vec<String>,
  pub start_line: u32,
  pub start_col: u32,
  pub end_line: u32,
  pub end_col: u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ProjectQueryOpts {
  pub language: Option<String>,
  pub max_files: Option<u32>,
  pub max_hits: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ParseFileResult {
  pub ok: bool,
  pub error: Option<String>,
  pub code: Option<String>,
  pub language: Option<String>,
  pub diagnostics: Vec<ParseDiagnostic>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ListSymbolsResult {
  pub ok: bool,
  pub error: Option<String>,
  pub code: Option<String>,
  pub language: Option<String>,
  pub symbols: Vec<SymbolHit>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ListImportsResult {
  pub ok: bool,
  pub error: Option<String>,
  pub code: Option<String>,
  pub language: Option<String>,
  pub imports: Vec<ImportHit>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ProjectHitsResult {
  pub ok: bool,
  pub error: Option<String>,
  pub code: Option<String>,
  pub hits: Vec<SymbolHit>,
  pub truncated: bool,
  pub files_scanned: u32,
}

impl ParseFileResult {
  pub fn err(code: &str, error: impl Into<String>) -> Self {
    Self {
      ok: false,
      error: Some(error.into()),
      code: Some(code.to_string()),
      language: None,
      diagnostics: vec![],
    }
  }
}

impl ListSymbolsResult {
  pub fn err(code: &str, error: impl Into<String>) -> Self {
    Self {
      ok: false,
      error: Some(error.into()),
      code: Some(code.to_string()),
      language: None,
      symbols: vec![],
    }
  }
}

impl ListImportsResult {
  pub fn err(code: &str, error: impl Into<String>) -> Self {
    Self {
      ok: false,
      error: Some(error.into()),
      code: Some(code.to_string()),
      language: None,
      imports: vec![],
    }
  }
}

impl ProjectHitsResult {
  pub fn err(code: &str, error: impl Into<String>) -> Self {
    Self {
      ok: false,
      error: Some(error.into()),
      code: Some(code.to_string()),
      hits: vec![],
      truncated: false,
      files_scanned: 0,
    }
  }
}
