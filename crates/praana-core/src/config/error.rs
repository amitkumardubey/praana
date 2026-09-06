use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("CONFIG_SOURCE_INVALID: {0}")]
    SourceInvalid(String),

    #[error("CONFIG_PARSE: {0}")]
    Parse(String),

    #[error("CONFIG_VERSION_UNSUPPORTED: config_schema_version must be 1, got {0}")]
    VersionUnsupported(u32),

    #[error("CONFIG_UNKNOWN_KEY: {0}")]
    UnknownKey(String),

    #[error("CONFIG_INVALID_TYPE: {0}")]
    InvalidType(String),

    #[error("CONFIG_INVALID_VALUE: {0}")]
    InvalidValue(String),

    #[error("CONFIG_VALUE_NOT_IMPLEMENTED: {0}")]
    ValueNotImplemented(String),

    #[error("CONFIG_FEATURE_NOT_IMPLEMENTED: {0}")]
    FeatureNotImplemented(String),

    #[error("CONFIG_PATH_INVALID: {0}")]
    PathInvalid(String),

    #[error("CONFIG_PATH_OUTSIDE_PLUGIN_ROOT: {0}")]
    PathOutsidePluginRoot(String),

    #[error("CONFIG_SECRET_FORBIDDEN: {0}")]
    SecretForbidden(String),

    #[error("CONFIG_SETUP_REQUIRED: provider and model are required to start a session")]
    SetupRequired,

    #[error("CONFIG_COMPACTOR_REQUIRED: {0}")]
    CompactorRequired(String),

    #[error("CONFIG_SNAPSHOT_MISMATCH: {0}")]
    SnapshotMismatch(String),

    #[error("CONFIG_RELOAD_UNSUPPORTED: live configuration reload is not supported in schema v1")]
    ReloadUnsupported,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigWarning {
    UnsafeContextWindow,
    ChangedSinceCreate { changed_keys: Vec<String> },
    PermissionsBroad(String),
}
