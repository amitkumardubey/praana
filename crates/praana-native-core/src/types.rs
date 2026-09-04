//! N-API-free payload DTOs shared by the pure core and the N-API wrapper.

use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseDiagnostic {
    pub message: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolHit {
    pub path: PathBuf,
    pub name: String,
    pub kind: String,
    pub exported: bool,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportHit {
    pub path: PathBuf,
    pub source: String,
    pub names: Vec<String>,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ProjectQueryOptions {
    pub language: Option<String>,
    pub max_files: Option<u32>,
    pub max_hits: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseFileOutput {
    pub language: Option<String>,
    pub diagnostics: Vec<ParseDiagnostic>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListSymbolsOutput {
    pub language: Option<String>,
    pub symbols: Vec<SymbolHit>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListImportsOutput {
    pub language: Option<String>,
    pub imports: Vec<ImportHit>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectHitsOutput {
    pub hits: Vec<SymbolHit>,
    pub truncated: bool,
    pub files_scanned: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrepOptions {
    pub pattern: String,
    pub path: PathBuf,
    pub globs: Option<Vec<String>>,
    pub glob_exclude: Option<Vec<String>>,
    pub case_insensitive: Option<bool>,
    pub context: Option<u32>,
    pub max_results: Option<u32>,
    pub max_file_size: Option<u32>,
    pub time_budget_ms: Option<u32>,
}

impl Default for GrepOptions {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            path: PathBuf::new(),
            globs: None,
            glob_exclude: None,
            case_insensitive: None,
            context: None,
            max_results: None,
            max_file_size: None,
            time_budget_ms: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrepMatch {
    pub path: PathBuf,
    pub relative_path: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrepOutput {
    pub matches: Vec<GrepMatch>,
    pub truncated: bool,
    pub files_searched: u32,
    pub regex_fallback: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindFilesOptions {
    pub pattern: String,
    pub path: PathBuf,
    pub mode: Option<String>,
    pub max_results: Option<u32>,
}

impl Default for FindFilesOptions {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            path: PathBuf::new(),
            mode: None,
            max_results: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FindFilesMatch {
    pub path: PathBuf,
    pub relative_path: String,
    pub name: String,
    pub size: u64,
    pub modified: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FindFilesOutput {
    pub matches: Vec<FindFilesMatch>,
    pub truncated: bool,
    pub total_matched: u32,
}

#[cfg(feature = "embeddings")]
#[derive(Clone, Debug, PartialEq)]
pub struct EmbedOutput {
    pub dim: u32,
    pub embedding: Vec<f32>,
}
