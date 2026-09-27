use std::path::{Path, PathBuf};

use crate::config::types::ToolsConfig;
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{canonical_lock_key, PathAccessMode, RiskFact, ToolIntent};

pub fn check(intent: &mut ToolIntent, cwd: &Path, tools: &ToolsConfig) -> Result<(), ToolError> {
    let roots = workspace_roots(cwd, &tools.allowed_paths);
    let cwd = normalized_root(cwd);
    let mut writes_outside_cwd = false;
    for access in &mut intent.path_accesses {
        let path = canonical_lock_key(&cwd, &access.requested)?;
        access.normalized_absolute = path.clone();
        if !within_roots(&path, &roots) {
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
                writes_outside_cwd |= !path.starts_with(&cwd);
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
    if writes_outside_cwd && !intent.risk_facts.contains(&RiskFact::WriteOutsideCwd) {
        intent.risk_facts.push(RiskFact::WriteOutsideCwd);
    }
    Ok(())
}

pub fn workspace_roots(cwd: &Path, allowed: &[String]) -> Vec<PathBuf> {
    let mut roots = vec![normalized_root(cwd)];
    for root in allowed {
        let root = normalized_root(Path::new(root));
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

fn normalized_root(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn within_roots(path: &Path, roots: &[PathBuf]) -> bool {
    let path = if path.exists() {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    } else {
        path.to_path_buf()
    };
    roots.iter().any(|root| path.starts_with(root))
}
