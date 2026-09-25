//! Explicit tool environment. Credentials are removed before spawn.

use std::collections::HashMap;

const DENY_EXACT: &[&str] = &[
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "COHERE_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "BASH_ENV",
    "ENV",
    "PROMPT_COMMAND",
    "CDPATH",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SUDO_ASKPASS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
];

pub fn sanitize_env(parent: &HashMap<String, String>, session_id: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (name, value) in parent {
        if denied(name) {
            continue;
        }
        out.insert(name.clone(), value.clone());
    }
    out.insert("PRAANA_TOOL".to_owned(), "1".to_owned());
    out.insert("PRAANA_SESSION_ID".to_owned(), session_id.to_owned());
    out
}

/// Windows `CreateProcessW` environment block: `NAME=value\0` records, sorted
/// case-insensitively, terminated by an extra `\0`. A null pointer would make
/// the child inherit the parent environment.
pub fn unicode_environment_block(env: &HashMap<String, String>) -> Vec<u16> {
    let mut names: Vec<&String> = env.keys().collect();
    names.sort_by_key(|name| name.to_ascii_lowercase());
    let mut block = Vec::new();
    for name in names {
        if name.is_empty() || name.contains('=') || name.contains('\0') {
            continue;
        }
        let Some(value) = env.get(name) else {
            continue;
        };
        if value.contains('\0') {
            continue;
        }
        block.extend(format!("{name}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

fn denied(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if DENY_EXACT.iter().any(|item| *item == upper) {
        return true;
    }
    upper.starts_with("DYLD_")
}
