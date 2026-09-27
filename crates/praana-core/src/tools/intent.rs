//! Call intent. Lock keys are canonical paths, with Windows case-folding.

use std::path::{Component, Path, PathBuf};

use super::error::{ToolError, ToolErrorCode};
use super::ToolCapabilities;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolIntent {
    pub mutation: ToolMutation,
    pub path_accesses: Vec<PathAccessIntent>,
    pub command: Option<CommandIntent>,
    pub risk_facts: Vec<RiskFact>,
    pub timeout_ms: u64,
    pub idempotency: ToolIdempotency,
    pub planned: Vec<PlannedChange>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlannedChange {
    Write {
        requested_path: String,
        expected_sha256: Option<String>,
    },
    Edit {
        requested_path: String,
        old_text: String,
        new_text: String,
        expected_sha256: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolMutation {
    PureCompute,
    ReadOnly,
    SessionState,
    Workspace,
    External,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolIdempotency {
    ReadOnly,
    IdempotentWrite,
    NonIdempotent,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathAccessIntent {
    pub requested: String,
    pub normalized_absolute: PathBuf,
    pub mode: PathAccessMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathAccessMode {
    Read,
    Write,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandIntent {
    pub command: String,
    pub cwd: PathBuf,
    pub read_equivalent: bool,
    pub test_command: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiskFact {
    Rm,
    GitReset,
    GitForcePush,
    GitClean,
    GhIssueClose,
    GhPrMerge,
    PackageInstall,
    WriteOutsideCwd,
}

impl RiskFact {
    pub fn config_name(self) -> &'static str {
        match self {
            Self::Rm => "rm",
            Self::GitReset => "git_reset",
            Self::GitForcePush => "git_force_push",
            Self::GitClean => "git_clean",
            Self::GhIssueClose => "gh_issue_close",
            Self::GhPrMerge => "gh_pr_merge",
            Self::PackageInstall => "package_install",
            Self::WriteOutsideCwd => "write_outside_cwd",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ToolInspectContext {
    pub cwd: PathBuf,
    pub plan_mode: bool,
}

#[derive(Clone, Debug)]
pub struct ToolExecutionContext {
    pub cwd: PathBuf,
    pub workspace_roots: Vec<PathBuf>,
    pub process_slots: Option<std::sync::Arc<tokio::sync::Semaphore>>,
    pub session_dir: PathBuf,
    pub session_id: crate::protocol::id::SessionId,
    pub batch_id: crate::protocol::id::ToolBatchId,
    pub call_id: crate::protocol::id::ToolCallId,
    pub execution_id: crate::protocol::id::ToolExecutionId,
    pub timeout: std::time::Duration,
    pub normalized_paths: Vec<(String, PathBuf)>,
}

impl ToolExecutionContext {
    pub fn path_for(&self, requested: &str) -> Option<&Path> {
        self.normalized_paths
            .iter()
            .find(|(name, _)| name == requested)
            .map(|(_, path)| path.as_path())
    }

    pub fn requested_for(&self, absolute: &Path) -> Option<String> {
        self.normalized_paths
            .iter()
            .find(|(_, path)| path == absolute)
            .map(|(name, _)| name.clone())
    }
}

pub fn normalize_lexical(cwd: &Path, requested: &str) -> Result<PathBuf, ToolError> {
    if requested.is_empty() || requested.contains('\0') || requested.len() > 4096 {
        return Err(ToolError::new(
            ToolErrorCode::ToolValidationFailed,
            "path is empty, too long, or contains NUL",
        ));
    }
    let raw = Path::new(requested);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(raw)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return Err(ToolError::new(
                        ToolErrorCode::ToolPathOutsideWorkspace,
                        "path traverses above the filesystem root",
                    ));
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

/// Symlink-resolved lock key. Missing suffix components stay lexical.
pub fn canonical_lock_key(cwd: &Path, requested: &str) -> Result<PathBuf, ToolError> {
    let lexical = normalize_lexical(cwd, requested)?;
    let mut cursor = lexical;
    let mut suffix = Vec::new();
    while !cursor.as_os_str().is_empty() && !cursor.exists() {
        let Some(name) = cursor.file_name().map(|name| name.to_os_string()) else {
            break;
        };
        let Some(parent) = cursor.parent() else {
            break;
        };
        if parent == cursor {
            break;
        }
        suffix.push(name);
        cursor = parent.to_path_buf();
    }
    let mut key = if cursor.exists() {
        std::fs::canonicalize(&cursor).unwrap_or(cursor)
    } else {
        cursor
    };
    for name in suffix.into_iter().rev() {
        key.push(name);
    }
    #[cfg(windows)]
    {
        key = fold_windows_key(key);
    }
    Ok(key)
}

#[cfg(windows)]
fn fold_windows_key(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().replace('/', "\\");
    let folded = if text.len() >= 2 && text.as_bytes()[1] == b':' {
        let drive = text.as_bytes()[0].to_ascii_uppercase() as char;
        format!("{drive}{}", text[1..].to_ascii_lowercase())
    } else {
        text.to_ascii_lowercase()
    };
    PathBuf::from(folded)
}

pub fn circuit_exempt(intent: &ToolIntent, capabilities: ToolCapabilities) -> bool {
    let _ = capabilities;
    match intent.mutation {
        ToolMutation::PureCompute | ToolMutation::ReadOnly => true,
        _ => intent
            .command
            .as_ref()
            .is_some_and(|command| command.read_equivalent || command.test_command),
    }
}

pub fn side_effect_capable(intent: &ToolIntent, capabilities: ToolCapabilities) -> bool {
    !matches!(intent.mutation, ToolMutation::PureCompute)
        || capabilities.intersects(
            ToolCapabilities::WRITE_FILES
                | ToolCapabilities::SPAWN_PROCESS
                | ToolCapabilities::NETWORK_POSSIBLE
                | ToolCapabilities::GIT_WRITE
                | ToolCapabilities::STATE_WRITE
                | ToolCapabilities::MEMORY_WRITE
                | ToolCapabilities::LSP_WRITE,
        )
}
