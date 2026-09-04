//! File read, parse, and diagnostics (moved from the N-API wrapper).

use std::path::Path;

use tree_sitter::{Node, Parser, Tree};

use crate::error::{NativeError, NativeErrorCode, NativeResult};
use crate::lang::{resolve_language, LangId};
use crate::types::ParseDiagnostic;

pub struct ParsedFile {
    pub lang: LangId,
    pub source: String,
    pub tree: Tree,
}

pub fn read_and_parse(path: &Path, language_override: Option<&str>) -> NativeResult<ParsedFile> {
    let lang = resolve_language(path, language_override).map_err(|message| {
        let code = if message.starts_with("unsupported_language") {
            NativeErrorCode::UnsupportedLanguage
        } else {
            NativeErrorCode::InvalidArgument
        };
        NativeError::new(code, message)
    })?;

    let source = std::fs::read_to_string(path).map_err(|e| {
        NativeError::new(
            NativeErrorCode::IoError,
            format!("failed to read {}: {e}", path.display()),
        )
    })?;

    let mut parser = Parser::new();
    parser.set_language(&lang.language()).map_err(|e| {
        NativeError::new(
            NativeErrorCode::Internal,
            format!("failed to set language: {e}"),
        )
    })?;

    let tree = parser.parse(&source, None).ok_or_else(|| {
        NativeError::new(
            NativeErrorCode::ParseError,
            format!("parser returned no tree for {}", path.display()),
        )
    })?;

    Ok(ParsedFile { lang, source, tree })
}

pub fn collect_diagnostics(tree: &Tree, source: &str) -> Vec<ParseDiagnostic> {
    let mut out = Vec::new();
    let mut stack = vec![tree.root_node()];
    while let Some(node) = stack.pop() {
        if node.is_error() || node.is_missing() {
            out.push(node_to_diagnostic(&node, source));
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            stack.push(child);
        }
    }
    out
}

fn node_to_diagnostic(node: &Node, _source: &str) -> ParseDiagnostic {
    let start = node.start_position();
    let end = node.end_position();
    let kind = if node.is_missing() {
        "missing"
    } else {
        "error"
    };
    ParseDiagnostic {
        message: format!("syntax {kind}: {}", node.kind()),
        start_line: (start.row as u32) + 1,
        start_col: (start.column as u32) + 1,
        end_line: (end.row as u32) + 1,
        end_col: (end.column as u32) + 1,
    }
}

pub fn range_of(node: &Node) -> (u32, u32, u32, u32) {
    let start = node.start_position();
    let end = node.end_position();
    (
        (start.row as u32) + 1,
        (start.column as u32) + 1,
        (end.row as u32) + 1,
        (end.column as u32) + 1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn parses_typescript_and_finds_error() {
        let mut f = NamedTempFile::with_suffix(".ts").unwrap();
        writeln!(f, "function foo( {{").unwrap();
        let parsed = read_and_parse(f.path(), None).unwrap();
        assert_eq!(parsed.lang, LangId::TypeScript);
        let diags = collect_diagnostics(&parsed.tree, &parsed.source);
        assert!(!diags.is_empty());
    }

    #[test]
    fn parses_clean_python() {
        let mut f = NamedTempFile::with_suffix(".py").unwrap();
        writeln!(f, "def hello():\n    return 1").unwrap();
        let parsed = read_and_parse(f.path(), None).unwrap();
        assert_eq!(parsed.lang, LangId::Python);
        assert!(collect_diagnostics(&parsed.tree, &parsed.source).is_empty());
    }

    #[test]
    fn parses_clean_rust() {
        let mut f = NamedTempFile::with_suffix(".rs").unwrap();
        writeln!(f, "pub fn hello() -> i32 {{ 1 }}").unwrap();
        let parsed = read_and_parse(f.path(), None).unwrap();
        assert_eq!(parsed.lang, LangId::Rust);
        assert!(collect_diagnostics(&parsed.tree, &parsed.source).is_empty());
    }
}
