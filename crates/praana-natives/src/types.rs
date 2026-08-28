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

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct GrepOpts {
  pub pattern: String,
  pub path: String,
  pub globs: Option<Vec<String>>,
  pub glob_exclude: Option<Vec<String>>,
  pub case_insensitive: Option<bool>,
  pub context: Option<u32>,
  pub max_results: Option<u32>,
  pub max_file_size: Option<u32>,
  pub time_budget_ms: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GrepMatch {
  pub path: String,
  pub relative_path: String,
  pub line: u32,
  pub column: u32,
  pub text: String,
  pub context_before: Vec<String>,
  pub context_after: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GrepResult {
  pub ok: bool,
  pub error: Option<String>,
  pub code: Option<String>,
  pub matches: Vec<GrepMatch>,
  pub truncated: bool,
  pub files_searched: u32,
  pub regex_fallback: Option<String>,
}

impl GrepResult {
  pub fn err(code: &str, error: impl Into<String>) -> Self {
    Self {
      ok: false,
      error: Some(error.into()),
      code: Some(code.to_string()),
      matches: vec![],
      truncated: false,
      files_searched: 0,
      regex_fallback: None,
    }
  }
}

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct FindFilesOpts {
  pub pattern: String,
  pub path: String,
  pub mode: Option<String>,
  pub max_results: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct FindFilesMatch {
  pub path: String,
  pub relative_path: String,
  pub name: String,
  pub size: f64,
  pub modified: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct FindFilesResult {
  pub ok: bool,
  pub error: Option<String>,
  pub code: Option<String>,
  pub matches: Vec<FindFilesMatch>,
  pub truncated: bool,
  pub total_matched: u32,
}

impl FindFilesResult {
  pub fn err(code: &str, error: impl Into<String>) -> Self {
    Self {
      ok: false,
      error: Some(error.into()),
      code: Some(code.to_string()),
      matches: vec![],
      truncated: false,
      total_matched: 0,
    }
  }
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct EmbedResult {
  pub ok: bool,
  pub error: Option<String>,
  pub code: Option<String>,
  pub dim: u32,
  pub embedding: Vec<f64>,
}

impl EmbedResult {
  pub fn err(code: &str, error: impl Into<String>) -> Self {
    Self {
      ok: false,
      error: Some(error.into()),
      code: Some(code.to_string()),
      dim: 0,
      embedding: vec![],
    }
  }
}
