//! Protocol schema constants and bounds.

pub const EVENT_SCHEMA_VERSION: u32 = 2;
pub const PROJECTION_VERSION: &str = "rust-v2-projection-1";
pub const COMPACTION_POLICY_VERSION: &str = "rust-v2-compaction-1";
pub const ARTIFACT_POLICY_VERSION: &str = "rust-v2-artifact-1";
pub const TOKEN_ESTIMATOR_SCHEMA_VERSION: u32 = 1;
pub const UNICODE_UTILITY_VERSION: &str = "praana-unicode-15.1-v1";
pub const SYSTEM_CONTEXT_SCHEMA_VERSION: u32 = 1;
pub const PROVIDER_REGISTRY_SCHEMA_VERSION: u32 = 1;
pub const BUILTIN_TOOL_CATALOG_SCHEMA_VERSION: u32 = 1;
pub const REDACTION_VERSION: &str = "praana-redaction-v1";
pub const UI_CONTRACT_SCHEMA_VERSION: u32 = 1;

pub const MAX_EVENT_LINE_BYTES: usize = 16_777_216; // 16 MiB
pub const MAX_JSON_STRING_BYTES: usize = 16_777_216;
pub const MAX_JSON_DEPTH: usize = 64;
pub const MAX_JSON_INTEGER: u64 = 9_007_199_254_740_991; // 2^53 - 1
pub const MIN_JSON_TIMESTAMP_MS: i64 = -9_007_199_254_740_991;
pub const MAX_JSON_TIMESTAMP_MS: i64 = 9_007_199_254_740_991;
pub const MAX_ID_BYTES: usize = 256;
pub const MAX_MODEL_LABEL_BYTES: usize = 256;
pub const TOOL_RESULT_MEDIA_TYPE: &str = "application/vnd.praana.tool-result+json;version=1";
