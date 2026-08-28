use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};

use crate::types::{
  FindFilesMatch, FindFilesOpts, FindFilesResult, GrepMatch, GrepOpts, GrepResult,
};

const DEFAULT_MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: u32 = 200;
const DEFAULT_FIND_MAX: u32 = 50;
const SKIP_DIR_NAMES: &[&str] = &[
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".praana",
  ".next",
  "coverage",
  "__pycache__",
  "vendor",
];

fn skip_dir(name: &str) -> bool {
  SKIP_DIR_NAMES.contains(&name)
}

fn walk_files(root: &Path) -> Result<Vec<PathBuf>, String> {
  if !root.exists() {
    return Err(format!("path does not exist: {}", root.display()));
  }
  if root.is_file() {
    return Ok(vec![root.to_path_buf()]);
  }
  if !root.is_dir() {
    return Err(format!("not a directory or file: {}", root.display()));
  }

  let mut builder = WalkBuilder::new(root);
  builder
    .hidden(false)
    .git_ignore(true)
    .git_global(true)
    .git_exclude(true)
    .require_git(false);
  builder.filter_entry(|entry| {
    let name = entry.file_name().to_string_lossy();
    !skip_dir(name.as_ref())
  });

  let mut files = Vec::new();
  for result in builder.build() {
    let entry = result.map_err(|e| format!("walk failed: {e}"))?;
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
      continue;
    }
    files.push(entry.path().to_path_buf());
  }
  Ok(files)
}

fn compile_globset(patterns: &[String], label: &str) -> Result<Option<GlobSet>, String> {
  if patterns.is_empty() {
    return Ok(None);
  }
  let mut builder = GlobSetBuilder::new();
  for raw in patterns {
    let pat = raw.trim();
    if pat.is_empty() {
      continue;
    }
    let glob = Glob::new(pat).or_else(|_| Glob::new(&format!("**/{pat}"))).map_err(|e| {
      format!("invalid {label} glob '{pat}': {e}")
    })?;
    builder.add(glob);
  }
  builder
    .build()
    .map(Some)
    .map_err(|e| format!("invalid {label} glob set: {e}"))
}

fn relative_slash(root: &Path, path: &Path) -> String {
  path
    .strip_prefix(root)
    .unwrap_or(path)
    .to_string_lossy()
    .replace('\\', "/")
}

fn matches_globs(
  rel: &str,
  include: Option<&GlobSet>,
  exclude: Option<&GlobSet>,
) -> bool {
  if let Some(ex) = exclude {
    if ex.is_match(rel) || ex.is_match(Path::new(rel).file_name().unwrap_or_default()) {
      return false;
    }
    // also match path segments (e.g. glob_exclude "node_modules")
    if rel.split('/').any(|seg| ex.is_match(seg)) {
      return false;
    }
  }
  match include {
    None => true,
    Some(inc) => inc.is_match(rel) || inc.is_match(Path::new(rel).file_name().unwrap_or_default()),
  }
}

fn looks_binary(bytes: &[u8]) -> bool {
  bytes.iter().take(8192).any(|b| *b == 0)
}

fn compile_pattern(pattern: &str, case_insensitive: bool) -> Result<(Regex, Option<String>), String> {
  match RegexBuilder::new(pattern)
    .case_insensitive(case_insensitive)
    .build()
  {
    Ok(re) => Ok((re, None)),
    Err(e) => {
      let literal = regex::escape(pattern);
      let re = RegexBuilder::new(&literal)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e2| format!("invalid regex: {e2}"))?;
      Ok((re, Some(format!("invalid regex ({e}); searched as literal"))))
    }
  }
}

pub fn grep(opts: GrepOpts) -> GrepResult {
  let root = PathBuf::from(&opts.path);
  let files = match walk_files(&root) {
    Ok(f) => f,
    Err(e) => return GrepResult::err("io_error", e),
  };

  let include = match compile_globset(opts.globs.as_deref().unwrap_or(&[]), "include") {
    Ok(g) => g,
    Err(e) => return GrepResult::err("invalid_argument", e),
  };
  let exclude = match compile_globset(opts.glob_exclude.as_deref().unwrap_or(&[]), "exclude") {
    Ok(g) => g,
    Err(e) => return GrepResult::err("invalid_argument", e),
  };

  let case_insensitive = opts.case_insensitive.unwrap_or(false);
  let (re, regex_fallback) = match compile_pattern(&opts.pattern, case_insensitive) {
    Ok(v) => v,
    Err(e) => return GrepResult::err("invalid_argument", e),
  };

  let ctx = opts.context.unwrap_or(0) as usize;
  let max_results = opts.max_results.unwrap_or(DEFAULT_MAX_RESULTS) as usize;
  let max_file_size = opts.max_file_size.map(|n| n as u64).unwrap_or(DEFAULT_MAX_FILE_SIZE);
  let deadline = opts
    .time_budget_ms
    .map(|ms| Instant::now() + Duration::from_millis(ms as u64));

  let walk_root = if root.is_file() {
    root.parent().unwrap_or(&root).to_path_buf()
  } else {
    root.clone()
  };

  let mut matches = Vec::new();
  let mut files_searched = 0u32;
  let mut truncated = false;

  for path in files {
    if let Some(d) = deadline {
      if Instant::now() >= d {
        truncated = true;
        break;
      }
    }
    let rel = relative_slash(&walk_root, &path);
    if !matches_globs(&rel, include.as_ref(), exclude.as_ref()) {
      continue;
    }
    let meta = match fs::metadata(&path) {
      Ok(m) => m,
      Err(_) => continue,
    };
    if meta.len() > max_file_size {
      continue;
    }
    let bytes = match fs::read(&path) {
      Ok(b) => b,
      Err(_) => continue,
    };
    if looks_binary(&bytes) {
      continue;
    }
    files_searched += 1;
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.split('\n').collect();
    for (idx, line) in lines.iter().enumerate() {
      let Some(m) = re.find(line) else { continue };
      let start = idx.saturating_sub(ctx);
      let end = (idx + 1 + ctx).min(lines.len());
      matches.push(GrepMatch {
        path: path.to_string_lossy().into_owned(),
        relative_path: rel.clone(),
        line: (idx + 1) as u32,
        column: (m.start() + 1) as u32,
        text: (*line).to_string(),
        context_before: lines[start..idx].iter().map(|s| (*s).to_string()).collect(),
        context_after: lines[idx + 1..end].iter().map(|s| (*s).to_string()).collect(),
      });
      if matches.len() >= max_results {
        truncated = true;
        break;
      }
    }
    if truncated {
      break;
    }
  }

  GrepResult {
    ok: true,
    error: None,
    code: None,
    matches,
    truncated,
    files_searched,
    regex_fallback,
  }
}

fn fuzzy_score(query: &str, candidate: &str) -> i32 {
  let q = query.to_lowercase();
  let c = candidate.to_lowercase();
  if q.is_empty() {
    return 0;
  }
  if c == q {
    return 10_000;
  }
  if Path::new(candidate)
    .file_name()
    .map(|n| n.to_string_lossy().eq_ignore_ascii_case(&q))
    .unwrap_or(false)
  {
    return 9_000;
  }
  if c.contains(&q) {
    return 5_000 - c.len() as i32;
  }
  let tokens: Vec<&str> = q.split_whitespace().filter(|t| !t.is_empty()).collect();
  if !tokens.is_empty() && tokens.iter().all(|t| c.contains(t)) {
    return 3_000 - c.len() as i32;
  }
  // subsequence (typo-resistant-ish)
  let mut qi = q.chars().peekable();
  for ch in c.chars() {
    if qi.peek() == Some(&ch) {
      qi.next();
    }
  }
  if qi.peek().is_none() {
    return 1_000 - c.len() as i32;
  }
  0
}

fn glob_match_path(pattern: &str, rel: &str) -> bool {
  let candidates = if pattern.starts_with("**/") || pattern.starts_with('/') {
    vec![pattern.to_string()]
  } else {
    vec![pattern.to_string(), format!("**/{pattern}")]
  };
  for pat in candidates {
    match Glob::new(&pat).and_then(|g| {
      let mut b = GlobSetBuilder::new();
      b.add(g);
      b.build()
    }) {
      Ok(set) => {
        if set.is_match(rel) || set.is_match(Path::new(rel).file_name().unwrap_or_default()) {
          return true;
        }
      }
      Err(_) => {
        if rel.contains(pattern) {
          return true;
        }
      }
    }
  }
  false
}

pub fn find_files(opts: FindFilesOpts) -> FindFilesResult {
  let root = PathBuf::from(&opts.path);
  let files = match walk_files(&root) {
    Ok(f) => f,
    Err(e) => return FindFilesResult::err("io_error", e),
  };
  let walk_root = if root.is_file() {
    root.parent().unwrap_or(&root).to_path_buf()
  } else {
    root.clone()
  };
  let max = opts.max_results.unwrap_or(DEFAULT_FIND_MAX) as usize;
  let mode = opts.mode.as_deref().unwrap_or("fuzzy");
  let pattern = opts.pattern.trim();

  let mut scored: Vec<(i32, FindFilesMatch)> = Vec::new();
  for path in files {
    let rel = relative_slash(&walk_root, &path);
    let name = path
      .file_name()
      .map(|n| n.to_string_lossy().into_owned())
      .unwrap_or_default();
    let keep = if mode == "glob" {
      glob_match_path(pattern, &rel)
    } else {
      fuzzy_score(pattern, &rel) > 0 || fuzzy_score(pattern, &name) > 0
    };
    if !keep {
      continue;
    }
    let score = if mode == "glob" {
      1
    } else {
      fuzzy_score(pattern, &name).max(fuzzy_score(pattern, &rel))
    };
    let meta = fs::metadata(&path).ok();
    let modified = meta
      .as_ref()
      .and_then(|m| m.modified().ok())
      .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
      .map(|d| d.as_secs_f64() * 1000.0)
      .unwrap_or(0.0);
    scored.push((
      score,
      FindFilesMatch {
        path: path.to_string_lossy().into_owned(),
        relative_path: rel,
        name,
        size: meta.map(|m| m.len() as f64).unwrap_or(0.0),
        modified,
      },
    ));
  }

  scored.sort_by(|a, b| b.0.cmp(&a.0));
  let total_matched = scored.len() as u32;
  let truncated = scored.len() > max;
  scored.truncate(max);

  FindFilesResult {
    ok: true,
    error: None,
    code: None,
    matches: scored.into_iter().map(|(_, m)| m).collect(),
    truncated,
    total_matched,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::create_dir_all(dir.path().join("node_modules")).unwrap();
    fs::write(dir.path().join("src/a.ts"), "export function alpha() {\n  return \"alpha\";\n}\n").unwrap();
    fs::write(dir.path().join("src/hello.txt"), "before-line\nTARGET line\nafter-line\n").unwrap();
    fs::write(dir.path().join("node_modules/lib.ts"), "export const hello = 1;\n").unwrap();
    dir
  }

  #[test]
  fn grep_finds_match_and_skips_node_modules() {
    let dir = fixture();
    let result = grep(GrepOpts {
      pattern: "alpha".into(),
      path: dir.path().to_string_lossy().into_owned(),
      ..GrepOpts::default()
    });
    assert!(result.ok, "{:?}", result.error);
    assert!(result.matches.iter().any(|m| m.text.contains("alpha")));
    assert!(result.matches.iter().all(|m| !m.path.contains("node_modules")));
  }

  #[test]
  fn grep_context_and_column() {
    let dir = fixture();
    let result = grep(GrepOpts {
      pattern: "TARGET".into(),
      path: dir.path().to_string_lossy().into_owned(),
      context: Some(1),
      ..GrepOpts::default()
    });
    let m = result.matches.iter().find(|m| m.text.contains("TARGET")).unwrap();
    assert_eq!(m.column, 1);
    assert!(m.context_before.iter().any(|l| l.contains("before-line")));
    assert!(m.context_after.iter().any(|l| l.contains("after-line")));
  }

  #[test]
  fn grep_invalid_regex_falls_back_to_literal() {
    let dir = fixture();
    let result = grep(GrepOpts {
      pattern: "foo(".into(),
      path: dir.path().to_string_lossy().into_owned(),
      ..GrepOpts::default()
    });
    assert!(result.ok);
    assert!(result.regex_fallback.is_some());
  }

  #[test]
  fn find_files_fuzzy_button() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src/components")).unwrap();
    fs::write(dir.path().join("src/components/button.tsx"), "x").unwrap();
    fs::write(dir.path().join("README.md"), "x").unwrap();
    let result = find_files(FindFilesOpts {
      pattern: "button".into(),
      path: dir.path().to_string_lossy().into_owned(),
      mode: Some("fuzzy".into()),
      max_results: Some(10),
    });
    assert!(result.ok);
    assert!(result.matches.iter().any(|m| m.name == "button.tsx"));
  }

  #[test]
  fn find_files_glob_mode() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/a.ts"), "x").unwrap();
    fs::write(dir.path().join("src/b.md"), "x").unwrap();
    let result = find_files(FindFilesOpts {
      pattern: "*.ts".into(),
      path: dir.path().to_string_lossy().into_owned(),
      mode: Some("glob".into()),
      max_results: Some(10),
    });
    assert!(result.ok);
    assert!(result.matches.iter().all(|m| m.name.ends_with(".ts")));
    assert!(!result.matches.is_empty());
  }

}
