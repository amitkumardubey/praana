use std::path::Path;

use crate::config::types::ToolsConfig;
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{canonical_lock_key, PathAccessMode, ToolIntent};

pub fn check(intent: &mut ToolIntent, cwd: &Path, tools: &ToolsConfig) -> Result<(), ToolError> {
    for access in &mut intent.path_accesses {
        let path = canonical_lock_key(cwd, &access.requested)?;
        access.normalized_absolute = path.clone();
        if !within_roots(&path, cwd, &tools.allowed_paths) {
            return Err(ToolError::new(
                ToolErrorCode::ToolPathOutsideWorkspace,
                "path is outside the workspace",
            ));
        }
        match access.mode {
            PathAccessMode::Read if !path.exists() => {
                return Err(ToolError::new(
                    ToolErrorCode::ToolPathNotFound,
                    "path was not found",
                ));
            }
            PathAccessMode::Write => {
                if let Some(parent) = path.parent() {
                    if parent.exists() && !parent.is_dir() {
                        return Err(ToolError::new(
                            ToolErrorCode::ToolValidationFailed,
                            "write parent is not a directory",
                        ));
                    }
                }
            }
            PathAccessMode::Read => {}
        }
    }
    Ok(())
}

fn within_roots(path: &Path, cwd: &Path, allowed: &[String]) -> bool {
    if path.starts_with(cwd) {
        return true;
    }
    allowed.iter().any(|root| path.starts_with(root))
}
