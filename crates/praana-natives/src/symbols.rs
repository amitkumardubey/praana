use std::path::Path;

use tree_sitter::{Query, QueryCursor, StreamingIterator};

use crate::lang::LangId;
use crate::parse::{range_of, ParsedFile};
use crate::types::{ImportHit, SymbolHit};

fn symbols_query(lang: LangId) -> &'static str {
  match lang {
    LangId::TypeScript | LangId::Tsx => r#"
(function_declaration name: (identifier) @name) @def
(class_declaration name: (type_identifier) @name) @def
(interface_declaration name: (type_identifier) @name) @def
(type_alias_declaration name: (type_identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(lexical_declaration (variable_declarator name: (identifier) @name) @def)
(variable_declaration (variable_declarator name: (identifier) @name) @def)
(method_definition name: (property_identifier) @name) @def
(export_statement declaration: (function_declaration name: (identifier) @name) @def)
(export_statement declaration: (class_declaration name: (type_identifier) @name) @def)
(export_statement declaration: (interface_declaration name: (type_identifier) @name) @def)
(export_statement declaration: (type_alias_declaration name: (type_identifier) @name) @def)
(export_statement declaration: (enum_declaration name: (identifier) @name) @def)
(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @def))
(export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @def))
"#,
    LangId::JavaScript | LangId::Jsx => r#"
(function_declaration name: (identifier) @name) @def
(class_declaration name: (identifier) @name) @def
(lexical_declaration (variable_declarator name: (identifier) @name) @def)
(variable_declaration (variable_declarator name: (identifier) @name) @def)
(method_definition name: (property_identifier) @name) @def
(export_statement declaration: (function_declaration name: (identifier) @name) @def)
(export_statement declaration: (class_declaration name: (identifier) @name) @def)
(export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @def))
(export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @def))
"#,
    LangId::Python => r#"
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
(assignment left: (identifier) @name) @def
"#,
    LangId::Go => r#"
(function_declaration name: (identifier) @name) @def
(method_declaration name: (field_identifier) @name) @def
(type_declaration (type_spec name: (type_identifier) @name) @def)
(const_declaration (const_spec name: (identifier) @name) @def)
(var_declaration (var_spec name: (identifier) @name) @def)
"#,
  }
}

fn imports_query(lang: LangId) -> &'static str {
  match lang {
    LangId::TypeScript | LangId::Tsx | LangId::JavaScript | LangId::Jsx => r#"
(import_statement source: (string) @source) @import
(export_statement source: (string) @source) @import
(call_expression
  function: (identifier) @fn (#eq? @fn "require")
  arguments: (arguments (string) @source)) @import
"#,
    LangId::Python => r#"
(import_statement name: (dotted_name) @source) @import
(import_from_statement module_name: (dotted_name) @source) @import
(import_from_statement module_name: (relative_import) @source) @import
"#,
    LangId::Go => r#"
(import_declaration (import_spec path: (interpreted_string_literal) @source) @import)
(import_declaration (import_spec_list (import_spec path: (interpreted_string_literal) @source) @import))
"#,
  }
}

fn refs_query(lang: LangId) -> &'static str {
  match lang {
    LangId::TypeScript | LangId::Tsx => r#"
(identifier) @ref
(type_identifier) @ref
(property_identifier) @ref
"#,
    LangId::JavaScript | LangId::Jsx => r#"
(identifier) @ref
(property_identifier) @ref
"#,
    LangId::Python => r#"
(identifier) @ref
"#,
    LangId::Go => r#"
(identifier) @ref
(type_identifier) @ref
(field_identifier) @ref
"#,
  }
}

fn kind_for_def_node(node_kind: &str, lang: LangId) -> &'static str {
  match (lang, node_kind) {
    (_, "function_declaration" | "function_definition") => "function",
    (_, "method_definition" | "method_declaration") => "method",
    (_, "class_declaration" | "class_definition") => "class",
    (_, "interface_declaration") => "interface",
    (_, "type_alias_declaration" | "type_spec" | "type_declaration") => "type",
    (_, "enum_declaration") => "enum",
    (LangId::Go, "const_spec" | "const_declaration") => "constant",
    (LangId::Go, "var_spec" | "var_declaration") => "variable",
    (_, "lexical_declaration" | "variable_declaration" | "variable_declarator" | "assignment") => {
      "variable"
    }
    _ => "other",
  }
}

fn is_exported_ancestor(node: tree_sitter::Node, source: &str, lang: LangId) -> bool {
  match lang {
    LangId::Go => {
      // Exported if name starts with uppercase.
      true // refined per-name below
    }
    LangId::Python => {
      // Treat module-level as "exported" for agent usefulness.
      let mut n = Some(node);
      while let Some(cur) = n {
        if cur.kind() == "module" {
          return true;
        }
        if matches!(cur.kind(), "function_definition" | "class_definition")
          && cur.id() != node.id()
        {
          // Nested — still report but not exported.
          return false;
        }
        n = cur.parent();
      }
      false
    }
    LangId::TypeScript | LangId::Tsx | LangId::JavaScript | LangId::Jsx => {
      let mut n = Some(node);
      while let Some(cur) = n {
        if cur.kind() == "export_statement" {
          return true;
        }
        // export default / export { }
        if cur.kind() == "export_clause" {
          return true;
        }
        n = cur.parent();
      }
      // Heuristic: top-level module declarations without export are not exported.
      let _ = source;
      false
    }
  }
}

fn go_exported(name: &str) -> bool {
  name
    .chars()
    .next()
    .map(|c| c.is_uppercase())
    .unwrap_or(false)
}

pub fn extract_symbols(parsed: &ParsedFile, path: &Path) -> Result<Vec<SymbolHit>, String> {
  let query_src = symbols_query(parsed.lang);
  let language = parsed.lang.language();
  let query = Query::new(&language, query_src).map_err(|e| format!("query error: {e}"))?;
  let mut cursor = QueryCursor::new();
  let mut matches = cursor.matches(&query, parsed.tree.root_node(), parsed.source.as_bytes());

  let name_idx = query
    .capture_index_for_name("name")
    .ok_or_else(|| "query missing @name".to_string())?;
  let def_idx = query.capture_index_for_name("def");

  let path_str = path.to_string_lossy().to_string();
  let mut out = Vec::new();
  let mut seen = std::collections::HashSet::new();

  while let Some(m) = matches.next() {
    let mut name_node = None;
    let mut def_node = None;
    for cap in m.captures {
      if cap.index == name_idx {
        name_node = Some(cap.node);
      }
      if def_idx == Some(cap.index) {
        def_node = Some(cap.node);
      }
    }
    let Some(name_node) = name_node else { continue };
    let name = name_node
      .utf8_text(parsed.source.as_bytes())
      .unwrap_or("")
      .to_string();
    if name.is_empty() {
      continue;
    }
    let def = def_node.unwrap_or(name_node);
    let (sl, sc, el, ec) = range_of(&def);
    let key = (name.clone(), sl, sc);
    if !seen.insert(key) {
      continue;
    }
    let kind = kind_for_def_node(def.kind(), parsed.lang).to_string();
    let mut exported = is_exported_ancestor(def, &parsed.source, parsed.lang);
    if parsed.lang == LangId::Go {
      exported = go_exported(&name);
    }
    // Python top-level: treat as exported for agent usefulness
    if parsed.lang == LangId::Python {
      exported = def.parent().map(|p| p.kind() == "module").unwrap_or(false)
        || matches!(def.kind(), "function_definition" | "class_definition");
      // Prefer true for module-level function/class
      if matches!(def.kind(), "function_definition" | "class_definition") {
        let mut p = def.parent();
        exported = matches!(p.as_ref().map(|n| n.kind()), Some("module"));
        while let Some(node) = p {
          if node.kind() == "decorated_definition" {
            p = node.parent();
            continue;
          }
          exported = node.kind() == "module";
          break;
        }
      }
    }

    out.push(SymbolHit {
      path: path_str.clone(),
      name,
      kind,
      exported,
      start_line: sl,
      start_col: sc,
      end_line: el,
      end_col: ec,
    });
  }

  Ok(out)
}

pub fn extract_imports(parsed: &ParsedFile, path: &Path) -> Result<Vec<ImportHit>, String> {
  let query_src = imports_query(parsed.lang);
  let language = parsed.lang.language();
  let query = Query::new(&language, query_src).map_err(|e| format!("query error: {e}"))?;
  let mut cursor = QueryCursor::new();
  let mut matches = cursor.matches(&query, parsed.tree.root_node(), parsed.source.as_bytes());

  let source_idx = query
    .capture_index_for_name("source")
    .ok_or_else(|| "query missing @source".to_string())?;
  let import_idx = query.capture_index_for_name("import");

  let path_str = path.to_string_lossy().to_string();
  let mut out = Vec::new();

  while let Some(m) = matches.next() {
    let mut source_node = None;
    let mut import_node = None;
    for cap in m.captures {
      if cap.index == source_idx {
        source_node = Some(cap.node);
      }
      if import_idx == Some(cap.index) {
        import_node = Some(cap.node);
      }
    }
    let Some(source_node) = source_node else { continue };
    let mut source = source_node
      .utf8_text(parsed.source.as_bytes())
      .unwrap_or("")
      .to_string();
    // Strip quotes from string literals
    if (source.starts_with('"') && source.ends_with('"'))
      || (source.starts_with('\'') && source.ends_with('\''))
      || (source.starts_with('`') && source.ends_with('`'))
    {
      source = source[1..source.len() - 1].to_string();
    }
    let node = import_node.unwrap_or(source_node);
    let (sl, sc, el, ec) = range_of(&node);
    let names = extract_import_names(node, &parsed.source, parsed.lang);
    out.push(ImportHit {
      path: path_str.clone(),
      source,
      names,
      start_line: sl,
      start_col: sc,
      end_line: el,
      end_col: ec,
    });
  }

  Ok(out)
}

fn extract_import_names(node: tree_sitter::Node, source: &str, lang: LangId) -> Vec<String> {
  let mut names = Vec::new();
  match lang {
    LangId::TypeScript | LangId::Tsx | LangId::JavaScript | LangId::Jsx => {
      let mut cursor = node.walk();
      for child in node.children(&mut cursor) {
        if matches!(
          child.kind(),
          "import_clause" | "named_imports" | "namespace_import" | "identifier"
        ) {
          collect_identifiers(child, source, &mut names);
        }
      }
    }
    LangId::Python => {
      let mut cursor = node.walk();
      for child in node.children(&mut cursor) {
        if matches!(child.kind(), "dotted_as_names" | "dotted_as_name" | "aliased_import") {
          collect_identifiers(child, source, &mut names);
        }
      }
    }
    LangId::Go => {
      // import alias is optional identifier before path
      let mut cursor = node.walk();
      for child in node.children(&mut cursor) {
        if child.kind() == "package_identifier" || child.kind() == "dot" {
          if let Ok(t) = child.utf8_text(source.as_bytes()) {
            names.push(t.to_string());
          }
        }
      }
    }
  }
  names.sort();
  names.dedup();
  names
}

fn collect_identifiers(node: tree_sitter::Node, source: &str, out: &mut Vec<String>) {
  if matches!(
    node.kind(),
    "identifier" | "property_identifier" | "type_identifier"
  ) {
    if let Ok(t) = node.utf8_text(source.as_bytes()) {
      if t != "type" && t != "as" && t != "from" {
        out.push(t.to_string());
      }
    }
    return;
  }
  let mut cursor = node.walk();
  for child in node.children(&mut cursor) {
    collect_identifiers(child, source, out);
  }
}

pub fn extract_references(
  parsed: &ParsedFile,
  path: &Path,
  symbol: &str,
) -> Result<Vec<SymbolHit>, String> {
  let query_src = refs_query(parsed.lang);
  let language = parsed.lang.language();
  let query = Query::new(&language, query_src).map_err(|e| format!("query error: {e}"))?;
  let mut cursor = QueryCursor::new();
  let mut matches = cursor.matches(&query, parsed.tree.root_node(), parsed.source.as_bytes());
  let ref_idx = query
    .capture_index_for_name("ref")
    .ok_or_else(|| "query missing @ref".to_string())?;

  let path_str = path.to_string_lossy().to_string();
  let mut out = Vec::new();
  let mut seen = std::collections::HashSet::new();

  while let Some(m) = matches.next() {
    for cap in m.captures {
      if cap.index != ref_idx {
        continue;
      }
      let name = cap
        .node
        .utf8_text(parsed.source.as_bytes())
        .unwrap_or("");
      if name != symbol {
        continue;
      }
      let (sl, sc, el, ec) = range_of(&cap.node);
      if !seen.insert((sl, sc)) {
        continue;
      }
      out.push(SymbolHit {
        path: path_str.clone(),
        name: symbol.to_string(),
        kind: "reference".to_string(),
        exported: false,
        start_line: sl,
        start_col: sc,
        end_line: el,
        end_col: ec,
      });
    }
  }
  Ok(out)
}

pub fn definitions_named(
  parsed: &ParsedFile,
  path: &Path,
  symbol: &str,
) -> Result<Vec<SymbolHit>, String> {
  let all = extract_symbols(parsed, path)?;
  Ok(all.into_iter().filter(|s| s.name == symbol).collect())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::parse::read_and_parse;
  use std::io::Write;
  use tempfile::NamedTempFile;

  #[test]
  fn typescript_symbols_and_imports() {
    let mut f = NamedTempFile::with_suffix(".ts").unwrap();
    write!(
      f,
      r#"
import {{ foo }} from "./foo";
export function bar() {{ return 1; }}
export class Baz {{ method() {{}} }}
const local = 1;
"#
    )
    .unwrap();
    let parsed = read_and_parse(f.path(), None).unwrap();
    let symbols = extract_symbols(&parsed, f.path()).unwrap();
    let names: Vec<_> = symbols.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"bar"), "{names:?}");
    assert!(names.contains(&"Baz"), "{names:?}");
    let bar = symbols.iter().find(|s| s.name == "bar").unwrap();
    assert!(bar.exported);

    let imports = extract_imports(&parsed, f.path()).unwrap();
    assert!(
      imports.iter().any(|i| i.source.contains("foo")),
      "{imports:?}"
    );
  }

  #[test]
  fn python_symbols() {
    let mut f = NamedTempFile::with_suffix(".py").unwrap();
    write!(
      f,
      "from os import path\ndef hello():\n    pass\nclass World:\n    pass\n"
    )
    .unwrap();
    let parsed = read_and_parse(f.path(), None).unwrap();
    let symbols = extract_symbols(&parsed, f.path()).unwrap();
    let names: Vec<_> = symbols.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"hello"), "{names:?}");
    assert!(names.contains(&"World"), "{names:?}");
    let imports = extract_imports(&parsed, f.path()).unwrap();
    assert!(!imports.is_empty(), "{imports:?}");
  }

  #[test]
  fn go_symbols() {
    let mut f = NamedTempFile::with_suffix(".go").unwrap();
    write!(
      f,
      "package main\nimport \"fmt\"\nfunc Hello() {{}}\nfunc hidden() {{}}\n"
    )
    .unwrap();
    let parsed = read_and_parse(f.path(), None).unwrap();
    let symbols = extract_symbols(&parsed, f.path()).unwrap();
    let hello = symbols.iter().find(|s| s.name == "Hello").unwrap();
    assert!(hello.exported);
    let hidden = symbols.iter().find(|s| s.name == "hidden").unwrap();
    assert!(!hidden.exported);
    let imports = extract_imports(&parsed, f.path()).unwrap();
    assert!(imports.iter().any(|i| i.source == "fmt"), "{imports:?}");
  }
}
