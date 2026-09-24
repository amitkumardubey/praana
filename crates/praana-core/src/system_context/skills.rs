//! Skill catalog validation, ordering, and line rendering
//! (System Context section 5). Skill bodies are never loaded or rendered.

use serde::{Deserialize, Serialize};

/// A discovered skill catalog entry (System Context section 2).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SkillCatalogEntryV1 {
    pub name: String,
    pub description: String,
    pub scope: SkillScopeV1,
}

/// Skill visibility scope (System Context section 2).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillScopeV1 {
    Project,
    User,
}

use super::SystemContextError;

/// Rendered as `- <name> [<scope>]: <description>` (System Context section 5).
pub fn render_skill_lines(skills: &[SkillCatalogEntryV1]) -> Vec<String> {
    skills
        .iter()
        .map(|skill| {
            let scope = match &skill.scope {
                SkillScopeV1::Project => "project",
                SkillScopeV1::User => "user",
            };
            format!("- {} [{}]: {}", skill.name, scope, skill.description)
        })
        .collect()
}

/// Validate and sort skills (System Context section 5). Names match
/// `^[a-z0-9][a-z0-9_-]{0,63}$`; descriptions are sanitized to one
/// line and at most 300 UTF-8 bytes. Sorted by scope (project before user)
/// then name ASCII.
pub fn validate_skills(
    skills: &[SkillCatalogEntryV1],
) -> Result<Vec<SkillCatalogEntryV1>, SystemContextError> {
    let mut validated = Vec::with_capacity(skills.len());
    for skill in skills {
        let name = &skill.name;
        if name.is_empty() || name.len() > 64 {
            return Err(SystemContextError::new(
                "PROJECT_CONTEXT_SKILL_INVALID",
                Some(name),
                "invalid_name",
            ));
        }
        // System Context §5: `^[a-z0-9][a-z0-9_-]{0,63}$`. Every byte is
        // lowercase ASCII, a digit, `_`, or `-`; the first byte excludes `_`
        // and `-`. Uppercase and `.` are rejected.
        let is_body_byte =
            |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-');
        let first_ok = name
            .bytes()
            .next()
            .map(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            .unwrap_or(false);
        if !name.bytes().all(is_body_byte) || !first_ok {
            return Err(SystemContextError::new(
                "PROJECT_CONTEXT_SKILL_INVALID",
                Some(name),
                "invalid_name",
            ));
        }
        let description = sanitize_skill_description(&skill.description);
        validated.push(SkillCatalogEntryV1 {
            name: skill.name.clone(),
            description,
            scope: skill.scope.clone(),
        });
    }
    validated.sort_by(|a, b| {
        let scope_order = |scope: &SkillScopeV1| match scope {
            SkillScopeV1::Project => 0u8,
            SkillScopeV1::User => 1u8,
        };
        scope_order(&a.scope)
            .cmp(&scope_order(&b.scope))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(validated)
}

/// Collapse to one line and cap at 300 UTF-8 bytes on a character boundary.
///
/// System Context §5 requires "one sanitized line". Each line break — `\n`,
/// `\r\n`, or a lone `\r` — collapses to exactly one space; a `\r\n` pair does
/// not produce two spaces.
fn sanitize_skill_description(description: &str) -> String {
    let one_line = {
        let mut out = String::with_capacity(description.len());
        let mut prev_was_cr = false;
        for ch in description.chars() {
            match ch {
                '\r' => {
                    out.push(' ');
                    prev_was_cr = true;
                }
                '\n' => {
                    // A `\n` immediately after a `\r` completes one CRLF break
                    // that already emitted its single space.
                    if !prev_was_cr {
                        out.push(' ');
                    }
                    prev_was_cr = false;
                }
                other => {
                    out.push(other);
                    prev_was_cr = false;
                }
            }
        }
        out
    };
    if one_line.len() <= 300 {
        return one_line;
    }
    let mut truncation = 300usize;
    while !one_line.is_char_boundary(truncation) && truncation > 0 {
        truncation -= 1;
    }
    one_line[..truncation].to_owned()
}
