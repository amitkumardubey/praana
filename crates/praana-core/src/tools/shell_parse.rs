//! Shell tokenization, risk facts, and executable checks.
//!
//! `inspect` reports facts without touching the filesystem. Existence and PATH
//! checks stay in validation.

use std::path::Path;

use super::error::{ToolError, ToolErrorCode};
use super::intent::RiskFact;

const BUILTINS: &[&str] = &[
    ":",
    ".",
    "[",
    "alias",
    "bg",
    "bind",
    "break",
    "builtin",
    "caller",
    "cd",
    "command",
    "compgen",
    "complete",
    "continue",
    "declare",
    "dirs",
    "disown",
    "echo",
    "enable",
    "eval",
    "exec",
    "exit",
    "export",
    "false",
    "fc",
    "fg",
    "getopts",
    "hash",
    "help",
    "history",
    "jobs",
    "kill",
    "let",
    "local",
    "logout",
    "mapfile",
    "popd",
    "printf",
    "pushd",
    "pwd",
    "read",
    "readarray",
    "readonly",
    "return",
    "set",
    "shift",
    "shopt",
    "source",
    "suspend",
    "test",
    "times",
    "trap",
    "true",
    "type",
    "typeset",
    "ulimit",
    "umask",
    "unalias",
    "unset",
    "wait",
];

pub fn words(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escape = false;
    for ch in command.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escape = true;
            continue;
        }
        if let Some(mark) = quote {
            if ch == mark {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            ch if ch.is_whitespace() => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn skip_assignments(tokens: &[String]) -> &[String] {
    let mut index = 0;
    while index < tokens.len() && assignment(&tokens[index]) {
        index += 1;
    }
    &tokens[index..]
}

fn assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

pub struct ShellClass {
    pub facts: Vec<RiskFact>,
    pub read_equivalent: bool,
    pub test_command: bool,
}

pub fn classify(command: &str) -> Result<ShellClass, ToolError> {
    let segments = split_segments(command).map_err(|_| {
        ToolError::new(
            ToolErrorCode::ToolValidationFailed,
            "shell syntax cannot be classified",
        )
    })?;
    let mut facts = Vec::new();
    let mut read_equivalent = !segments.is_empty();
    let mut test_command = !segments.is_empty();
    for segment in &segments {
        let (read, test) = command_facts(segment, &mut facts, 0).map_err(|_| {
            ToolError::new(
                ToolErrorCode::ToolValidationFailed,
                "shell syntax cannot be classified",
            )
        })?;
        read_equivalent &= read;
        test_command &= test;
    }
    Ok(ShellClass {
        facts,
        read_equivalent,
        test_command,
    })
}

fn split_segments(command: &str) -> Result<Vec<String>, ()> {
    let chars: Vec<char> = command.chars().collect();
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut index = 0;
    let mut single = false;
    let mut double = false;
    while index < chars.len() {
        let ch = chars[index];
        if single {
            current.push(ch);
            if ch == '\'' {
                single = false;
            }
            index += 1;
            continue;
        }
        if ch == '\\' && !single {
            current.push(ch);
            if index + 1 < chars.len() {
                current.push(chars[index + 1]);
                index += 2;
            } else {
                return Err(());
            }
            continue;
        }
        if double {
            if ch == '"' {
                double = false;
                current.push(ch);
                index += 1;
                continue;
            }
            if ch == '$' && chars.get(index + 1) == Some(&'(') {
                let (inner, next) = matching_paren(&chars, index + 1)?;
                segments.extend(split_segments(&inner)?);
                current.push_str("$(");
                current.push_str(&inner);
                current.push(')');
                index = next;
                continue;
            }
            if ch == '`' {
                let end = chars[index + 1..]
                    .iter()
                    .position(|item| *item == '`')
                    .ok_or(())?;
                let inner: String = chars[index + 1..index + 1 + end].iter().collect();
                segments.extend(split_segments(&inner)?);
                current.push('`');
                current.push_str(&inner);
                current.push('`');
                index += end + 2;
                continue;
            }
            current.push(ch);
            index += 1;
            continue;
        }
        match ch {
            '\'' => {
                single = true;
                current.push(ch);
                index += 1;
            }
            '"' => {
                double = true;
                current.push(ch);
                index += 1;
            }
            '`' => {
                let end = chars[index + 1..]
                    .iter()
                    .position(|item| *item == '`')
                    .ok_or(())?;
                let inner: String = chars[index + 1..index + 1 + end].iter().collect();
                segments.extend(split_segments(&inner)?);
                current.push('`');
                current.push_str(&inner);
                current.push('`');
                index += end + 2;
            }
            '$' if chars.get(index + 1) == Some(&'(') => {
                let (inner, next) = matching_paren(&chars, index + 1)?;
                segments.extend(split_segments(&inner)?);
                current.push_str("$(");
                current.push_str(&inner);
                current.push(')');
                index = next;
            }
            '<' | '>' if chars.get(index + 1) == Some(&'(') => return Err(()),
            '\n' | ';' | '|' | '&' => {
                push_segment(&mut segments, &mut current);
                if chars.get(index + 1) == Some(&ch) && (ch == '|' || ch == '&') {
                    index += 2;
                } else {
                    index += 1;
                }
            }
            _ => {
                current.push(ch);
                index += 1;
            }
        }
    }
    if single || double {
        return Err(());
    }
    push_segment(&mut segments, &mut current);
    Ok(segments)
}

fn matching_paren(chars: &[char], open: usize) -> Result<(String, usize), ()> {
    let mut depth = 0usize;
    let mut single = false;
    let mut double = false;
    let mut index = open;
    while index < chars.len() {
        let ch = chars[index];
        if single {
            if ch == '\'' {
                single = false;
            }
            index += 1;
            continue;
        }
        if double {
            if ch == '"' {
                double = false;
            }
            index += 1;
            continue;
        }
        match ch {
            '\'' => single = true,
            '"' => double = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    let inner: String = chars[open + 1..index].iter().collect();
                    return Ok((inner, index + 1));
                }
            }
            _ => {}
        }
        index += 1;
    }
    Err(())
}

fn classify_script(
    script: &str,
    facts: &mut Vec<RiskFact>,
    depth: u32,
) -> Result<(bool, bool), ()> {
    let segments = split_segments(script)?;
    if segments.is_empty() {
        return Ok((false, false));
    }
    let mut read_equivalent = true;
    let mut test_command = true;
    for segment in &segments {
        let (read, test) = command_facts(segment, facts, depth)?;
        read_equivalent &= read;
        test_command &= test;
    }
    Ok((read_equivalent, test_command))
}

fn nested_shell_script(rest: &[String]) -> Result<&str, ()> {
    let mut index = 1;
    while index < rest.len() {
        let token = rest[index].as_str();
        if token == "--" {
            return Err(());
        }
        if is_command_flag(token) {
            let script = rest.get(index + 1).ok_or(())?;
            if script.starts_with('-') {
                return Err(());
            }
            return Ok(script.as_str());
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        return Err(());
    }
    Err(())
}

fn is_command_flag(token: &str) -> bool {
    token.starts_with('-')
        && !token.starts_with("--")
        && token.len() > 1
        && token.chars().skip(1).all(|ch| ch.is_ascii_alphanumeric())
        && token.contains('c')
}

fn static_literal(script: &str) -> bool {
    !script.chars().any(|ch| ch == '$' || ch == '`')
}

fn push_segment(segments: &mut Vec<String>, current: &mut String) {
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        segments.push(trimmed.to_owned());
    }
    current.clear();
}

fn command_facts(segment: &str, facts: &mut Vec<RiskFact>, depth: u32) -> Result<(bool, bool), ()> {
    if depth > 6 {
        return Err(());
    }
    let tokens = words(segment);
    let tokens = skip_assignments(&tokens);
    let mut index = 0;
    loop {
        match tokens.get(index).map(String::as_str) {
            Some("sudo" | "command" | "exec" | "nohup" | "nice" | "time") => index += 1,
            Some("env") => {
                index += 1;
                while tokens
                    .get(index)
                    .is_some_and(|token| assignment(token) || token.starts_with('-'))
                {
                    index += 1;
                }
            }
            _ => break,
        }
    }
    let rest = &tokens[index..];
    let first = rest.first().map(String::as_str).unwrap_or("");
    if first == "eval" {
        if rest.len() < 2 {
            return Err(());
        }
        let script = rest[1..].join(" ");
        if !static_literal(&script) {
            return Err(());
        }
        return classify_script(&script, facts, depth + 1);
    }
    if matches!(first, "bash" | "sh" | "dash" | "zsh") {
        let script = nested_shell_script(rest)?;
        if !static_literal(script) {
            return Err(());
        }
        return classify_script(script, facts, depth + 1);
    }
    if first == "find"
        && rest
            .iter()
            .any(|token| token == "-exec" || token == "-execdir")
    {
        let pos = rest
            .iter()
            .position(|token| token == "-exec" || token == "-execdir")
            .ok_or(())?;
        let cmd: Vec<String> = rest[pos + 1..]
            .iter()
            .take_while(|token| token.as_str() != ";" && token.as_str() != "+")
            .cloned()
            .collect();
        if cmd.is_empty() {
            return Err(());
        }
        return command_facts(&cmd.join(" "), facts, depth + 1);
    }
    if first == "xargs" {
        return Err(());
    }
    push_facts(rest, facts);
    Ok((is_read_equivalent(rest), is_test_command(rest)))
}

fn push_facts(tokens: &[String], facts: &mut Vec<RiskFact>) {
    if tokens.first().map(String::as_str) == Some("rm") {
        push_fact(facts, RiskFact::Rm);
    }
    if tokens.first().map(String::as_str) == Some("git") {
        match tokens.get(1).map(String::as_str) {
            Some("reset") => push_fact(facts, RiskFact::GitReset),
            Some("clean") => push_fact(facts, RiskFact::GitClean),
            Some("push")
                if tokens.iter().any(|token| {
                    token == "--force" || token == "-f" || token == "--force-with-lease"
                }) =>
            {
                push_fact(facts, RiskFact::GitForcePush);
            }
            _ => {}
        }
    }
    if tokens.first().map(String::as_str) == Some("gh") {
        match (
            tokens.get(1).map(String::as_str),
            tokens.get(2).map(String::as_str),
        ) {
            (Some("issue"), Some("close")) => push_fact(facts, RiskFact::GhIssueClose),
            (Some("pr"), Some("merge")) => push_fact(facts, RiskFact::GhPrMerge),
            _ => {}
        }
    }
    if matches!(
        tokens.first().map(String::as_str),
        Some("npm" | "pnpm" | "yarn" | "bun" | "cargo" | "pip" | "pip3")
    ) && matches!(
        tokens.get(1).map(String::as_str),
        Some("install" | "add" | "i")
    ) {
        push_fact(facts, RiskFact::PackageInstall);
    }
}

fn push_fact(facts: &mut Vec<RiskFact>, fact: RiskFact) {
    if !facts.contains(&fact) {
        facts.push(fact);
    }
}

fn is_read_equivalent(tokens: &[String]) -> bool {
    let Some(first) = tokens.first().map(String::as_str) else {
        return false;
    };
    if matches!(
        first,
        "cat"
            | "head"
            | "tail"
            | "less"
            | "more"
            | "bat"
            | "rg"
            | "grep"
            | "ls"
            | "pwd"
            | "wc"
            | "file"
            | "stat"
    ) {
        return true;
    }
    if first == "sed" && tokens.iter().any(|token| token == "-n") {
        return true;
    }
    first == "git"
        && matches!(
            tokens.get(1).map(String::as_str),
            Some("status" | "diff" | "log" | "show" | "rev-parse")
        )
}

fn is_test_command(tokens: &[String]) -> bool {
    matches!(
        (
            tokens.first().map(String::as_str),
            tokens.get(1).map(String::as_str),
        ),
        (Some("pytest" | "py.test"), _)
            | (
                Some("cargo" | "go" | "bun" | "npm" | "pnpm" | "yarn"),
                Some("test")
            )
    )
}

pub fn ensure_executable(command: &str) -> Result<(), ToolError> {
    let tokens = words(command);
    let tokens = skip_assignments(&tokens);
    let Some(program) = tokens.first() else {
        return Err(ToolError::new(
            ToolErrorCode::ToolValidationFailed,
            "shell command is empty",
        ));
    };
    if BUILTINS.contains(&program.as_str()) {
        return Ok(());
    }
    if program.contains('/') || program.contains('\\') {
        let path = Path::new(program);
        if path.is_file() {
            return Ok(());
        }
        return Err(ToolError::new(
            ToolErrorCode::ToolValidationFailed,
            "shell program was not found",
        ));
    }
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Ok(());
        }
    }
    Err(ToolError::new(
        ToolErrorCode::ToolValidationFailed,
        "shell program is not on PATH",
    ))
}

#[cfg(test)]
mod tests {
    use super::classify;
    use crate::tools::intent::RiskFact;

    #[test]
    fn nested_compound_script_carries_every_risk_fact() {
        let class = match classify("bash -c 'echo ok; rm -rf target'") {
            Ok(class) => class,
            Err(error) => panic!("{error}"),
        };
        assert!(class.facts.contains(&RiskFact::Rm));
        let login = match classify("sh -lc 'echo ok; rm -rf target'") {
            Ok(class) => class,
            Err(error) => panic!("{error}"),
        };
        assert!(login.facts.contains(&RiskFact::Rm));
    }

    #[test]
    fn dynamic_nested_script_fails_closed() {
        match classify("sh -c \"$script\"") {
            Err(error) => assert_eq!(
                error.code(),
                crate::tools::error::ToolErrorCode::ToolValidationFailed
            ),
            Ok(_) => panic!("dynamic script was classified"),
        }
        assert!(classify("bash ./deploy.sh").is_err());
    }
}
