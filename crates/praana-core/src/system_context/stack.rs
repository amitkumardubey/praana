//! Project stack marker detection (System Context section 5). Reads only root
//! filenames; no dependency file content enters any slot.

use std::path::Path;

/// One detected stack marker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StackMarker {
    pub kind: &'static str,
    pub relative_path: String,
}

/// Root marker set with exact kinds (System Context section 5). Duplicate
/// kinds keep each marker.
fn marker_kind(name: &str) -> Option<&'static str> {
    match name {
        "package.json" => Some("javascript"),
        "bun.lock" | "bun.lockb" => Some("bun"),
        "Cargo.toml" => Some("rust"),
        "go.mod" => Some("go"),
        "pyproject.toml" | "requirements.txt" => Some("python"),
        "pom.xml" => Some("java"),
        "build.gradle" | "build.gradle.kts" => Some("java"),
        _ => None,
    }
}

/// Detect stack markers among regular root filenames of `root`.
pub fn detect_project_stack(root: &Path) -> Vec<StackMarker> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut markers = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(kind) = marker_kind(&name) else {
            continue;
        };
        // Regular files only; never follow or load content.
        let is_regular = std::fs::symlink_metadata(entry.path())
            .map(|meta| meta.is_file())
            .unwrap_or(false);
        if !is_regular {
            continue;
        }
        markers.push(StackMarker {
            kind,
            relative_path: name,
        });
    }
    markers
}

/// Render stack lines sorted ASCII by the rendered line
/// `- <kind>: <relative path>` (System Context section 5).
pub fn render_stack_lines(markers: &[StackMarker]) -> Vec<String> {
    let mut lines: Vec<String> = markers
        .iter()
        .map(|marker| format!("- {}: {}", marker.kind, marker.relative_path))
        .collect();
    lines.sort();
    lines
}
