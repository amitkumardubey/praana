//! Phase 3 built-in input and success DTOs.
//!
//! Field names and defaults are the built-in catalog. `Sha256Digest` is the
//! protocol digest newtype; these structs do not introduce a second hash type.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::protocol::id::Sha256Digest;

pub fn one() -> u64 {
    1
}
pub fn dot() -> String {
    ".".to_owned()
}
pub fn default_context_lines() -> u8 {
    2
}
pub fn default_search_results() -> u32 {
    100
}
pub fn default_find_results() -> u32 {
    100
}
pub fn default_diff_context() -> u16 {
    3
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LineRangeRequest {
    #[serde(default = "one")]
    pub start_line: u64,
    #[serde(default)]
    pub max_lines: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FileIdentityDto {
    pub path: String,
    pub sha256: Sha256Digest,
    pub byte_count: u64,
    pub modified_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextEncodingDto {
    Utf8,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChangedFileDto {
    pub path: String,
    pub before_sha256: Option<Sha256Digest>,
    pub after_sha256: Sha256Digest,
    pub bytes_written: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReadFileInput {
    pub path: String,
    #[serde(flatten)]
    pub range: LineRangeRequest,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReadFileOutput {
    pub file: FileIdentityDto,
    pub encoding: TextEncodingDto,
    pub start_line: u64,
    pub end_line: u64,
    pub total_lines: u64,
    pub content: String,
    pub eof: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WriteFileInput {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub create_parents: bool,
    #[serde(default)]
    pub expected_sha256: Option<Sha256Digest>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WriteFileOutput {
    pub changed: bool,
    pub file: ChangedFileDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EditFileInput {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    #[serde(default)]
    pub expected_sha256: Option<Sha256Digest>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EditFileOutput {
    pub changed: bool,
    pub replacements: u32,
    pub file: ChangedFileDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BatchWriteInput {
    pub writes: Vec<WriteFileInput>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BatchEditInput {
    pub edits: Vec<EditFileInput>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BatchMutationOutput {
    pub changed: Vec<ChangedFileDto>,
    pub unchanged_paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchCodeInput {
    pub pattern: String,
    #[serde(default = "dot")]
    pub path: String,
    #[serde(default)]
    pub include_globs: Vec<String>,
    #[serde(default)]
    pub exclude_globs: Vec<String>,
    #[serde(default)]
    pub case_insensitive: bool,
    #[serde(default = "default_context_lines")]
    pub context_lines: u8,
    #[serde(default = "default_search_results")]
    pub max_results: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchMatchDto {
    pub path: String,
    pub line: u64,
    pub column: u64,
    pub text: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchCodeOutput {
    pub matches: Vec<SearchMatchDto>,
    pub truncated: bool,
    pub scanned_files: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindMode {
    Fuzzy,
    Glob,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FoundPathKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FindFilesInput {
    pub query: String,
    #[serde(default = "dot")]
    pub path: String,
    #[serde(default)]
    pub mode: Option<FindMode>,
    #[serde(default = "default_find_results")]
    pub max_results: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FoundPathDto {
    pub path: String,
    pub kind: FoundPathKind,
    pub score_milli: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FindFilesOutput {
    pub paths: Vec<FoundPathDto>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RunTestsInput {
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub name_pattern: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TestCountsDto {
    pub passed: u64,
    pub failed: u64,
    pub skipped: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RunTestsOutput {
    pub adapter: String,
    pub command: Vec<String>,
    pub exit_code: Option<i32>,
    pub counts: Option<TestCountsDto>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GitStatusInput {
    #[serde(default)]
    pub include_untracked: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GitStatusEntryDto {
    pub path: String,
    pub original_path: Option<String>,
    pub index: String,
    pub worktree: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GitStatusOutput {
    pub branch: Option<String>,
    pub entries: Vec<GitStatusEntryDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GitDiffInput {
    #[serde(default)]
    pub staged: bool,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default = "default_diff_context")]
    pub context_lines: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GitDiffOutput {
    pub command: Vec<String>,
    pub exit_code: i32,
    pub diff: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShellInput {
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShellOutput {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub cancelled: bool,
}
