use super::error::ConfigError;
use super::raw::ascii_edge_trim;
use std::path::{Component, Path, PathBuf};

pub fn normalize_config_path(
    raw_path: &str,
    base_dir: &Path,
    home_dir: &Path,
    field_name: &str,
) -> Result<String, ConfigError> {
    if raw_path.is_empty() {
        return Err(ConfigError::PathInvalid(format!(
            "{field_name}: path cannot be empty"
        )));
    }
    if raw_path.contains('\0') {
        return Err(ConfigError::PathInvalid(format!(
            "{field_name}: path contains NUL byte"
        )));
    }
    if raw_path.len() > 4096 {
        return Err(ConfigError::PathInvalid(format!(
            "{field_name}: path exceeds 4096 bytes"
        )));
    }

    // Config §7.1: Expand only an initial exact ~/ against user's home. Bare ~, ~\..., ~user are NOT expanded.
    let expanded = if let Some(stripped) = raw_path.strip_prefix("~/") {
        home_dir.join(stripped)
    } else {
        let p = Path::new(raw_path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            base_dir.join(p)
        }
    };

    // Lexically normalize: eliminate '.' and '..'
    let mut normalized_components = Vec::new();
    for comp in expanded.components() {
        match comp {
            Component::Prefix(prefix) => {
                normalized_components.push(Component::Prefix(prefix));
            }
            Component::RootDir => {
                normalized_components.push(Component::RootDir);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if let Some(last) = normalized_components.last() {
                    match last {
                        Component::Normal(_) => {
                            normalized_components.pop();
                        }
                        Component::RootDir => {
                            return Err(ConfigError::PathInvalid(format!(
                                "{field_name}: path traverses above filesystem root"
                            )));
                        }
                        _ => {
                            normalized_components.push(Component::ParentDir);
                        }
                    }
                } else {
                    return Err(ConfigError::PathInvalid(format!(
                        "{field_name}: path traverses above filesystem root"
                    )));
                }
            }
            Component::Normal(c) => {
                normalized_components.push(Component::Normal(c));
            }
        }
    }

    let mut result = PathBuf::new();
    for comp in normalized_components {
        result.push(comp.as_os_str());
    }

    let result_str = result.to_str().ok_or_else(|| {
        ConfigError::PathInvalid(format!("{field_name}: path is not valid UTF-8"))
    })?;

    // Convert to canonical JSON form: forward slashes, uppercase Windows drive letter
    let canonical = to_canonical_json_path(result_str);
    Ok(canonical)
}

/// Normalize PRAANA_HOME per Config §3.1 and §7.1.
///
/// §3.1/§7.1 gap fill:
/// 1. Absent -> ~/.praana, then normalized.
/// 2. Empty or whitespace-only -> CONFIG_PATH_INVALID.
/// 3. Reject NUL and >4096 UTF-8 bytes -> CONFIG_PATH_INVALID.
/// 4. Expand only exact ~/ against the injected user home.
/// 5. If still relative -> resolve against process cwd (not user home, not session cwd).
/// 6. Lexical . / ..; reject traversal above the filesystem root.
pub fn normalize_praana_home(
    raw_home: Option<&str>,
    home_dir: &Path,
    process_cwd: &Path,
) -> Result<PathBuf, ConfigError> {
    let raw = match raw_home {
        None => "~/.praana",
        Some(s) => {
            let trimmed = ascii_edge_trim(s);
            if trimmed.is_empty() {
                return Err(ConfigError::PathInvalid(
                    "PRAANA_HOME is empty or whitespace-only".into(),
                ));
            }
            s
        }
    };

    if raw.contains('\0') {
        return Err(ConfigError::PathInvalid(
            "PRAANA_HOME contains NUL byte".into(),
        ));
    }
    if raw.len() > 4096 {
        return Err(ConfigError::PathInvalid(
            "PRAANA_HOME exceeds 4096 bytes".into(),
        ));
    }

    let expanded = if let Some(stripped) = raw.strip_prefix("~/") {
        home_dir.join(stripped)
    } else {
        let p = Path::new(raw);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            // §3.1/§7.1 gap fill: resolve relative PRAANA_HOME against process cwd
            process_cwd.join(p)
        }
    };

    // Lexically normalize . and ..
    let mut normalized_components = Vec::new();
    for comp in expanded.components() {
        match comp {
            Component::Prefix(prefix) => normalized_components.push(Component::Prefix(prefix)),
            Component::RootDir => normalized_components.push(Component::RootDir),
            Component::CurDir => {}
            Component::ParentDir => {
                if let Some(last) = normalized_components.last() {
                    match last {
                        Component::Normal(_) => {
                            normalized_components.pop();
                        }
                        Component::RootDir => {
                            return Err(ConfigError::PathInvalid(
                                "PRAANA_HOME traverses above filesystem root".into(),
                            ));
                        }
                        _ => {
                            normalized_components.push(Component::ParentDir);
                        }
                    }
                } else {
                    return Err(ConfigError::PathInvalid(
                        "PRAANA_HOME traverses above filesystem root".into(),
                    ));
                }
            }
            Component::Normal(c) => normalized_components.push(Component::Normal(c)),
        }
    }

    let mut result = PathBuf::new();
    for comp in normalized_components {
        result.push(comp.as_os_str());
    }

    Ok(result)
}

/// De-duplicate tools.allowed_paths after platform path comparison, keeping first-seen order.
pub fn deduplicate_allowed_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(paths.len());
    for p in paths {
        #[cfg(windows)]
        let key = p.to_ascii_lowercase();
        #[cfg(not(windows))]
        let key = p.clone();

        if seen.insert(key) {
            deduped.push(p);
        }
    }
    deduped
}

pub fn to_canonical_json_path(path_str: &str) -> String {
    let mut s = path_str.replace('\\', "/");
    // If windows drive letter e.g. "c:/..." -> "C:/..."
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let first = (s.as_bytes()[0] as char).to_ascii_uppercase();
        s.replace_range(0..1, &first.to_string());
    }
    s
}

pub fn validate_memory_db_path(
    db_path_canonical: &str,
    praana_home: &Path,
) -> Result<(), ConfigError> {
    let plugin_root = praana_home.join("plugins/builtin-sqlite");
    let plugin_root_canonical = to_canonical_json_path(plugin_root.to_str().unwrap());

    // Path must be strictly beneath plugin_root (not equal to it and not outside it)
    if db_path_canonical == plugin_root_canonical {
        return Err(ConfigError::PathOutsidePluginRoot(format!(
            "built-in memory DB path '{db_path_canonical}' equals plugin root '{plugin_root_canonical}'"
        )));
    }

    let prefix = format!("{plugin_root_canonical}/");
    if !db_path_canonical.starts_with(&prefix) {
        return Err(ConfigError::PathOutsidePluginRoot(format!(
            "built-in memory DB path '{db_path_canonical}' escapes plugin root '{plugin_root_canonical}'"
        )));
    }

    Ok(())
}
