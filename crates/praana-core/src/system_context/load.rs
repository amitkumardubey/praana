//! Project-context discovery, normalization, bounds, and provenance hashing
//! (System Context sections 3, 7.1, 8).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    SystemContextError, MAX_COMBINED_CONTEXT_BYTES, MAX_SOURCE_FILE_BYTES,
    PROJECT_CONTEXT_SOURCE_DOMAIN,
};
use crate::protocol::hashes::calculate_sha256;
use crate::protocol::id::Sha256Digest;

/// User-visible resume warning emitted when the current project context
/// differs from creation-time provenance (System Context section 7.1). The
/// orchestration layer owns emission; P1D owns detection and the constant.
pub const PROJECT_CONTEXT_CHANGED_SINCE_CREATE: &str = "PROJECT_CONTEXT_CHANGED_SINCE_CREATE";

/// Scope of a discovered project-context source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceScope {
    User,
    Project,
}

impl SourceScope {
    pub(crate) fn render(&self) -> &'static str {
        match self {
            SourceScope::User => "user",
            SourceScope::Project => "project",
        }
    }
}

/// One successfully read discovery candidate in discovery order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectContextSource {
    pub scope: SourceScope,
    pub relative_label: String,
    pub normalized: String,
}

/// Discovery outcome. `all_sources` is the provenance list (pre-bound);
/// `included` is the rendering list (post-bound); `omitted_count` counts
/// whole files omitted after the combined bound was reached.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadedProjectContext {
    pub included: Vec<ProjectContextSource>,
    pub omitted_count: u32,
    pub all_sources: Vec<ProjectContextSource>,
}

impl LoadedProjectContext {
    pub fn empty() -> Self {
        Self {
            included: Vec::new(),
            omitted_count: 0,
            all_sources: Vec::new(),
        }
    }
}

/// Normalize instruction bytes exactly per System Context section 3: one UTF-8
/// input, no NUL, at most 65,536 bytes, one BOM removed, CRLF/CR to LF. No
/// trimming, interpolation, Markdown parsing, or include expansion.
pub fn normalize_instruction_bytes(raw: &[u8]) -> Result<String, SystemContextError> {
    if raw.len() > MAX_SOURCE_FILE_BYTES {
        return Err(SystemContextError::new(
            "PROJECT_CONTEXT_READ_FAILED",
            None,
            "file_over_bound",
        ));
    }
    let text = std::str::from_utf8(raw).map_err(|_| {
        SystemContextError::new("PROJECT_CONTEXT_READ_FAILED", None, "invalid_utf8")
    })?;
    if text.contains('\0') {
        return Err(SystemContextError::new(
            "PROJECT_CONTEXT_READ_FAILED",
            None,
            "contains_nul",
        ));
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}

/// The base and home directories Config uses to resolve session paths
/// (System Context §3). `base_dir` anchors a relative cwd/git-root input and
/// `home_dir` anchors a `~/` prefix, matching `normalize_config_path` exactly.
#[derive(Clone, Debug)]
pub struct ContextPathResolution {
    pub base_dir: PathBuf,
    pub home_dir: PathBuf,
}

impl ContextPathResolution {
    pub fn new(base_dir: impl Into<PathBuf>, home_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
            home_dir: home_dir.into(),
        }
    }
}

/// Discover project-context sources (System Context section 3). Missing
/// candidates are normal; an existing unreadable/non-regular/symlink candidate
/// fails visibly and blocks. Secret detection is report-only: any
/// high-confidence match fails with `PROJECT_CONTEXT_SECRET_FOUND`.
///
/// `cwd` and `git_root` are normalized through the exact Config path algorithm
/// using `resolution`'s base and home directories, so tilde and relative
/// discovery roots resolve to the same files Config would read.
pub fn discover_project_context(
    praana_home: &Path,
    cwd: &Path,
    git_root: Option<&Path>,
    resolution: &ContextPathResolution,
) -> Result<LoadedProjectContext, SystemContextError> {
    let cwd = normalize_input_path(cwd, &resolution.base_dir, &resolution.home_dir)?;
    let git_root = match git_root {
        None => None,
        Some(root) => Some(normalize_input_path(
            root,
            &resolution.base_dir,
            &resolution.home_dir,
        )?),
    };

    let candidates: Vec<(SourceScope, String, PathBuf)> = {
        let mut out = Vec::new();
        out.push((
            SourceScope::User,
            "AGENTS.md".to_owned(),
            praana_home.join("AGENTS.md"),
        ));
        match &git_root {
            Some(root) => {
                let root_label = cwd_relative_label(&cwd, &root.join("AGENTS.md"));
                out.push((SourceScope::Project, root_label, root.join("AGENTS.md")));
                let cwd_agents = cwd.join("AGENTS.md");
                if !same_path(&cwd_agents, &root.join("AGENTS.md")) {
                    out.push((
                        SourceScope::Project,
                        cwd_relative_label(&cwd, &cwd_agents),
                        cwd_agents,
                    ));
                }
                if !candidate_exists(&root.join("AGENTS.md")) {
                    out.push((
                        SourceScope::Project,
                        cwd_relative_label(&cwd, &root.join("CLAUDE.md")),
                        root.join("CLAUDE.md"),
                    ));
                }
            }
            None => {
                let cwd_agents = cwd.join("AGENTS.md");
                out.push((
                    SourceScope::Project,
                    cwd_relative_label(&cwd, &cwd_agents),
                    cwd_agents,
                ));
            }
        }
        out
    };

    let mut all_sources: Vec<ProjectContextSource> = Vec::new();
    for (scope, relative_label, path) in candidates {
        match read_instruction_file(&relative_label, &path)? {
            None => continue, // missing candidates are normal
            Some(normalized) => {
                let matches = crate::redaction::detect_secret_matches_v1(&normalized);
                if !matches.is_empty() {
                    let mut kinds: Vec<&str> = matches.iter().map(|m| m.kind.name()).collect();
                    kinds.sort_unstable();
                    kinds.dedup();
                    return Err(SystemContextError::new(
                        "PROJECT_CONTEXT_SECRET_FOUND",
                        Some(&relative_label),
                        kinds.join(","),
                    ));
                }
                all_sources.push(ProjectContextSource {
                    scope,
                    relative_label,
                    normalized,
                });
            }
        }
    }

    // Combined bound: stop at the first file that does not fit; all later
    // files are omitted whole and a single fixed omission record is rendered.
    let mut included = Vec::new();
    let mut total = 0usize;
    let mut omitted_count = 0u32;
    for source in &all_sources {
        let len = source.normalized.len();
        if total + len <= MAX_COMBINED_CONTEXT_BYTES {
            included.push(source.clone());
            total += len;
        } else {
            omitted_count = (all_sources.len() - included.len()) as u32;
            break;
        }
    }
    if omitted_count == 0 && included.len() < all_sources.len() {
        omitted_count = (all_sources.len() - included.len()) as u32;
    }
    Ok(LoadedProjectContext {
        included,
        omitted_count,
        all_sources,
    })
}

/// Compute `project_context_source_sha256` (System Context section 7.1):
/// domain, NUL, then per successfully read candidate in discovery order:
/// scope, NUL, relative label, NUL, normalized bytes, NUL.
pub fn project_context_source_sha256(sources: &[ProjectContextSource]) -> Sha256Digest {
    let mut buffer = Vec::new();
    buffer.extend_from_slice(PROJECT_CONTEXT_SOURCE_DOMAIN.as_bytes());
    buffer.push(b'\0');
    for source in sources {
        buffer.extend_from_slice(source.scope.render().as_bytes());
        buffer.push(b'\0');
        buffer.extend_from_slice(source.relative_label.as_bytes());
        buffer.push(b'\0');
        buffer.extend_from_slice(source.normalized.as_bytes());
        buffer.push(b'\0');
    }
    calculate_sha256(&buffer)
}

/// Resume comparison (System Context section 7.1): equal digests emit no
/// warning; a difference means exactly one
/// `PROJECT_CONTEXT_CHANGED_SINCE_CREATE` warning and the current instructions
/// are used for subsequent requests. Creation metadata is never rewritten.
pub fn project_context_changed_since_create(
    creation: &Sha256Digest,
    current: &LoadedProjectContext,
) -> bool {
    project_context_source_sha256(&current.all_sources).as_str() != creation.as_str()
}

/// Resume warning codes for the current project context (System Context
/// section 7.1). Returns exactly one `PROJECT_CONTEXT_CHANGED_SINCE_CREATE`
/// when the recomputed digest differs from the immutable creation digest, and
/// an empty vector when they match. The orchestration layer pushes these codes
/// into session warnings verbatim; the warning never carries source bytes or
/// absolute paths, and creation metadata is never rewritten here.
pub fn resume_context_warnings(
    creation: &Sha256Digest,
    current: &LoadedProjectContext,
) -> Vec<&'static str> {
    if project_context_changed_since_create(creation, current) {
        vec![PROJECT_CONTEXT_CHANGED_SINCE_CREATE]
    } else {
        Vec::new()
    }
}

/// Resolve a cwd/git-root input through the exact Config path algorithm
/// (System Context §3). `~/` expands against the user home Config uses and a
/// relative input resolves against the base directory Config uses; using the
/// input's own parent for either would read the wrong `AGENTS.md`. An absolute
/// input is normalized lexically without expansion.
pub(crate) fn normalize_input_path(
    path: &Path,
    base_dir: &Path,
    home_dir: &Path,
) -> Result<PathBuf, SystemContextError> {
    let raw = path.to_str().ok_or_else(|| {
        SystemContextError::new("PROJECT_CONTEXT_READ_FAILED", None, "path_not_utf8")
    })?;
    let canonical =
        crate::config::path::normalize_config_path(raw, base_dir, home_dir, "project_context_path")
            .map_err(|_| {
                SystemContextError::new("PROJECT_CONTEXT_READ_FAILED", None, "path_normalization")
            })?;
    Ok(PathBuf::from(canonical))
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b
}

fn candidate_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Read one candidate: regular files only, never symlinks. Missing files are
/// normal; every other read/validation failure is a visible
/// `PROJECT_CONTEXT_READ_FAILED`.
fn read_instruction_file(label: &str, path: &Path) -> Result<Option<String>, SystemContextError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(SystemContextError::new(
                "PROJECT_CONTEXT_READ_FAILED",
                Some(label),
                "unreadable",
            ))
        }
    };
    if meta.file_type().is_symlink() {
        return Err(SystemContextError::new(
            "PROJECT_CONTEXT_READ_FAILED",
            Some(label),
            "symlink",
        ));
    }
    if !meta.is_file() {
        return Err(SystemContextError::new(
            "PROJECT_CONTEXT_READ_FAILED",
            Some(label),
            "not_regular_file",
        ));
    }
    let bytes = fs::read(path).map_err(|_| {
        SystemContextError::new("PROJECT_CONTEXT_READ_FAILED", Some(label), "unreadable")
    })?;
    normalize_instruction_bytes(&bytes)
        .map(Some)
        .map_err(|error| SystemContextError::new(&error.code, Some(label), error.detail))
}

/// cwd-relative label using `/` separators; never absolute.
fn cwd_relative_label(cwd: &Path, path: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(cwd) {
        if !rel.as_os_str().is_empty() {
            let label = rel.to_string_lossy().replace('\\', "/");
            if !label.is_empty() {
                return label;
            }
        }
    }
    // Not beneath cwd: walk to the common ancestor and use `..` components;
    // the label stays relative and never absolute.
    let mut up = 0usize;
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut base = cwd.to_path_buf();
    let mut cursor = path.to_path_buf();
    loop {
        if base == cursor || path.starts_with(&base) {
            break;
        }
        if let Some(parent) = base.parent() {
            base = parent.to_path_buf();
            up += 1;
        } else {
            break;
        }
    }
    loop {
        if cursor == base || cursor.as_os_str().is_empty() {
            break;
        }
        if let Some(name) = cursor.file_name() {
            suffix.push(name.to_os_string());
        }
        cursor = cursor.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    }
    let mut label = String::new();
    for _ in 0..up {
        label.push_str("../");
    }
    for part in suffix.iter().rev() {
        label.push_str(&part.to_string_lossy().replace('\\', "/"));
        label.push('/');
    }
    if label.ends_with('/') {
        label.pop();
    }
    if label.is_empty() {
        label.push_str("../");
    }
    label
}
