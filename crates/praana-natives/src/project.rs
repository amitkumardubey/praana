use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

use crate::lang::LangId;
use crate::parse::read_and_parse;
use crate::symbols::{definitions_named, extract_references};
use crate::types::{ProjectHitsResult, ProjectQueryOpts, SymbolHit};

const DEFAULT_MAX_FILES: u32 = 2000;
const DEFAULT_MAX_HITS: u32 = 100;

fn supported_extension(path: &Path) -> bool {
  LangId::from_path(path).is_some()
}

fn matches_language_filter(path: &Path, filter: Option<&LangId>) -> bool {
  match filter {
    None => true,
    Some(want) => LangId::from_path(path) == Some(*want),
  }
}

pub fn walk_source_files(
  root: &Path,
  language_filter: Option<LangId>,
  max_files: u32,
) -> Result<(Vec<PathBuf>, bool), String> {
  if !root.is_dir() {
    return Err(format!("invalid_argument: root is not a directory: {}", root.display()));
  }

  let mut builder = WalkBuilder::new(root);
  builder
    .hidden(false)
    .git_ignore(true)
    .git_global(true)
    .git_exclude(true)
    .require_git(false);
  // Always skip heavy / irrelevant dirs even if not gitignored.
  builder.filter_entry(|entry| {
    let name = entry.file_name().to_string_lossy();
    !matches!(
      name.as_ref(),
      ".git"
        | "node_modules"
        | "target"
        | "dist"
        | "build"
        | ".praana"
        | ".next"
        | "coverage"
        | "__pycache__"
        | "vendor"
    )
  });

  let mut files = Vec::new();
  let mut truncated = false;
  for result in builder.build() {
    let entry = result.map_err(|e| format!("io_error: walk failed: {e}"))?;
    if !entry
      .file_type()
      .map(|t| t.is_file())
      .unwrap_or(false)
    {
      continue;
    }
    let path = entry.path();
    if !supported_extension(path) {
      continue;
    }
    if !matches_language_filter(path, language_filter.as_ref()) {
      continue;
    }
    if files.len() as u32 >= max_files {
      truncated = true;
      break;
    }
    files.push(path.to_path_buf());
  }
  Ok((files, truncated))
}

pub fn find_definition(
  root: &Path,
  symbol: &str,
  opts: Option<ProjectQueryOpts>,
) -> ProjectHitsResult {
  if symbol.trim().is_empty() {
    return ProjectHitsResult::err("invalid_argument", "symbol must be non-empty");
  }
  let max_files = opts
    .as_ref()
    .and_then(|o| o.max_files)
    .unwrap_or(DEFAULT_MAX_FILES);
  let max_hits = opts
    .as_ref()
    .and_then(|o| o.max_hits)
    .unwrap_or(DEFAULT_MAX_HITS);
  let lang_filter = opts
    .as_ref()
    .and_then(|o| o.language.as_deref())
    .map(|s| {
      LangId::parse(s).ok_or_else(|| {
        ProjectHitsResult::err(
          "unsupported_language",
          format!("unknown language filter '{s}'"),
        )
      })
    });

  let language_filter = match lang_filter {
    Some(Ok(l)) => Some(l),
    Some(Err(e)) => return e,
    None => None,
  };

  let (files, walk_truncated) = match walk_source_files(root, language_filter, max_files) {
    Ok(v) => v,
    Err(e) => {
      let code = if e.starts_with("invalid_argument") {
        "invalid_argument"
      } else {
        "io_error"
      };
      return ProjectHitsResult::err(code, e);
    }
  };

  let mut hits: Vec<SymbolHit> = Vec::new();
  let mut hits_truncated = false;
  for path in &files {
    let parsed = match read_and_parse(path, None) {
      Ok(p) => p,
      Err(_) => continue,
    };
    match definitions_named(&parsed, path, symbol) {
      Ok(mut defs) => {
        for d in defs.drain(..) {
          if hits.len() as u32 >= max_hits {
            hits_truncated = true;
            break;
          }
          hits.push(d);
        }
      }
      Err(_) => continue,
    }
    if hits_truncated {
      break;
    }
  }

  ProjectHitsResult {
    ok: true,
    error: None,
    code: None,
    hits,
    truncated: walk_truncated || hits_truncated,
    files_scanned: files.len() as u32,
  }
}

pub fn find_references(
  root: &Path,
  symbol: &str,
  opts: Option<ProjectQueryOpts>,
) -> ProjectHitsResult {
  if symbol.trim().is_empty() {
    return ProjectHitsResult::err("invalid_argument", "symbol must be non-empty");
  }
  let max_files = opts
    .as_ref()
    .and_then(|o| o.max_files)
    .unwrap_or(DEFAULT_MAX_FILES);
  let max_hits = opts
    .as_ref()
    .and_then(|o| o.max_hits)
    .unwrap_or(DEFAULT_MAX_HITS);
  let lang_filter = opts
    .as_ref()
    .and_then(|o| o.language.as_deref())
    .map(|s| {
      LangId::parse(s).ok_or_else(|| {
        ProjectHitsResult::err(
          "unsupported_language",
          format!("unknown language filter '{s}'"),
        )
      })
    });

  let language_filter = match lang_filter {
    Some(Ok(l)) => Some(l),
    Some(Err(e)) => return e,
    None => None,
  };

  let (files, walk_truncated) = match walk_source_files(root, language_filter, max_files) {
    Ok(v) => v,
    Err(e) => {
      let code = if e.starts_with("invalid_argument") {
        "invalid_argument"
      } else {
        "io_error"
      };
      return ProjectHitsResult::err(code, e);
    }
  };

  let mut hits: Vec<SymbolHit> = Vec::new();
  let mut hits_truncated = false;
  for path in &files {
    let parsed = match read_and_parse(path, None) {
      Ok(p) => p,
      Err(_) => continue,
    };
    match extract_references(&parsed, path, symbol) {
      Ok(mut refs) => {
        for r in refs.drain(..) {
          if hits.len() as u32 >= max_hits {
            hits_truncated = true;
            break;
          }
          hits.push(r);
        }
      }
      Err(_) => continue,
    }
    if hits_truncated {
      break;
    }
  }

  ProjectHitsResult {
    ok: true,
    error: None,
    code: None,
    hits,
    truncated: walk_truncated || hits_truncated,
    files_scanned: files.len() as u32,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use tempfile::tempdir;

  #[test]
  fn finds_definition_across_files() {
    let dir = tempdir().unwrap();
    fs::write(
      dir.path().join("a.ts"),
      "export function target() { return 1; }\n",
    )
    .unwrap();
    fs::write(dir.path().join("b.ts"), "import { target } from \"./a\";\n")
      .unwrap();
    let result = find_definition(dir.path(), "target", None);
    assert!(result.ok, "{result:?}");
    assert!(
      result.hits.iter().any(|h| h.name == "target" && h.path.ends_with("a.ts")),
      "{:?}",
      result.hits
    );
  }

  #[test]
  fn finds_references() {
    let dir = tempdir().unwrap();
    fs::write(
      dir.path().join("a.ts"),
      "export function target() { return target; }\n",
    )
    .unwrap();
    let result = find_references(dir.path(), "target", None);
    assert!(result.ok);
    assert!(result.hits.len() >= 2, "{:?}", result.hits);
  }
}
