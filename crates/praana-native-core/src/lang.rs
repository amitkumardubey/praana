//! Language detection and grammar lookup (moved from the N-API wrapper).

use std::path::Path;
use tree_sitter::Language;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LangId {
    TypeScript,
    Tsx,
    JavaScript,
    Jsx,
    Python,
    Go,
    Rust,
}

impl LangId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::JavaScript => "javascript",
            Self::Jsx => "jsx",
            Self::Python => "python",
            Self::Go => "go",
            Self::Rust => "rust",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "typescript" | "ts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "javascript" | "js" | "mjs" | "cjs" => Some(Self::JavaScript),
            "jsx" => Some(Self::Jsx),
            "python" | "py" => Some(Self::Python),
            "go" | "golang" => Some(Self::Go),
            "rust" | "rs" => Some(Self::Rust),
            _ => None,
        }
    }

    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "ts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "js" | "mjs" | "cjs" => Some(Self::JavaScript),
            "jsx" => Some(Self::Jsx),
            "py" => Some(Self::Python),
            "go" => Some(Self::Go),
            "rs" => Some(Self::Rust),
            _ => None,
        }
    }

    pub fn language(self) -> Language {
        match self {
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript | Self::Jsx => tree_sitter_javascript::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
        }
    }
}

/// Resolve language from optional override or path extension.
pub fn resolve_language(path: &Path, language_override: Option<&str>) -> Result<LangId, String> {
    if let Some(raw) = language_override {
        return LangId::parse(raw)
            .ok_or_else(|| format!("unsupported_language: unknown language override '{raw}'"));
    }
    LangId::from_path(path).ok_or_else(|| {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("(none)");
        format!("unsupported_language: no grammar for extension '.{ext}'")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn detects_extensions() {
        assert_eq!(
            LangId::from_path(Path::new("a.ts")),
            Some(LangId::TypeScript)
        );
        assert_eq!(LangId::from_path(Path::new("a.tsx")), Some(LangId::Tsx));
        assert_eq!(
            LangId::from_path(Path::new("a.js")),
            Some(LangId::JavaScript)
        );
        assert_eq!(LangId::from_path(Path::new("a.py")), Some(LangId::Python));
        assert_eq!(LangId::from_path(Path::new("a.go")), Some(LangId::Go));
        assert_eq!(LangId::from_path(Path::new("a.rs")), Some(LangId::Rust));
    }

    #[test]
    fn parse_aliases() {
        assert_eq!(LangId::parse("TS"), Some(LangId::TypeScript));
        assert_eq!(LangId::parse("golang"), Some(LangId::Go));
        assert_eq!(LangId::parse("rs"), Some(LangId::Rust));
    }

    #[test]
    fn resolve_override_wins() {
        let p = PathBuf::from("weird.dat");
        assert_eq!(
            resolve_language(&p, Some("python")).unwrap(),
            LangId::Python
        );
    }
}
