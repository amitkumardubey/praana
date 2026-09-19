//! Host settings DTOs and defaults.
//!
//! These settings are persisted by the Rust settings service. They are not
//! Config-v1 keys and never mutate the active session's config snapshot.
//! `incognito_default` affects only subsequently created sessions.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThemeId {
    Default,
    HighContrast,
    Mono,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolIconMode {
    Unicode,
    Ascii,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SettingsPatchDto {
    pub thinking_visible: Option<bool>,
    pub debug: Option<bool>,
    pub theme: Option<ThemeId>,
    pub tool_icons: Option<ToolIconMode>,
    pub mouse_enabled: Option<bool>,
    pub animation_enabled: Option<bool>,
    pub syntax_highlighting: Option<bool>,
    pub syntax_theme: Option<String>,
    pub incognito_default: Option<bool>,
}

impl SettingsPatchDto {
    /// A patch must set at least one field.
    pub fn validate(&self) -> Result<(), String> {
        if self.thinking_visible.is_none()
            && self.debug.is_none()
            && self.theme.is_none()
            && self.tool_icons.is_none()
            && self.mouse_enabled.is_none()
            && self.animation_enabled.is_none()
            && self.syntax_highlighting.is_none()
            && self.syntax_theme.is_none()
            && self.incognito_default.is_none()
        {
            return Err("settings patch must set at least one field".to_string());
        }
        if let Some(theme) = &self.syntax_theme {
            validate_syntax_theme(theme)?;
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.thinking_visible.is_none()
            && self.debug.is_none()
            && self.theme.is_none()
            && self.tool_icons.is_none()
            && self.mouse_enabled.is_none()
            && self.animation_enabled.is_none()
            && self.syntax_highlighting.is_none()
            && self.syntax_theme.is_none()
            && self.incognito_default.is_none()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EffectiveSettingsDto {
    pub revision: u64,
    pub thinking_visible: bool,
    pub debug: bool,
    pub theme: ThemeId,
    pub tool_icons: ToolIconMode,
    pub mouse_enabled: bool,
    pub animation_enabled: bool,
    pub syntax_highlighting: bool,
    pub syntax_theme: String,
    pub incognito_default: bool,
}

impl EffectiveSettingsDto {
    /// Revision 0 defaults when no persisted settings row exists.
    pub fn initial() -> Self {
        Self {
            revision: 0,
            thinking_visible: true,
            debug: false,
            theme: ThemeId::Default,
            tool_icons: ToolIconMode::Unicode,
            mouse_enabled: true,
            animation_enabled: true,
            syntax_highlighting: true,
            syntax_theme: "base16-ocean.dark".to_string(),
            incognito_default: false,
        }
    }

    /// Apply a validated patch, bumping the revision by exactly one.
    pub fn apply_patch(&self, patch: &SettingsPatchDto) -> Result<Self, String> {
        patch.validate()?;
        let mut next = self.clone();
        next.revision = self.revision + 1;
        if let Some(v) = patch.thinking_visible {
            next.thinking_visible = v;
        }
        if let Some(v) = patch.debug {
            next.debug = v;
        }
        if let Some(v) = &patch.theme {
            next.theme = v.clone();
        }
        if let Some(v) = &patch.tool_icons {
            next.tool_icons = v.clone();
        }
        if let Some(v) = patch.mouse_enabled {
            next.mouse_enabled = v;
        }
        if let Some(v) = patch.animation_enabled {
            next.animation_enabled = v;
        }
        if let Some(v) = patch.syntax_highlighting {
            next.syntax_highlighting = v;
        }
        if let Some(v) = &patch.syntax_theme {
            next.syntax_theme = v.clone();
        }
        if let Some(v) = patch.incognito_default {
            next.incognito_default = v;
        }
        Ok(next)
    }
}

/// Syntect 5.2 `ThemeSet::load_defaults` keys. P1C does not depend on the
/// Syntect crate; membership is this documented default-theme set.
const SYNTECT_DEFAULT_THEMES: &[&str] = &[
    "InspiredGitHub",
    "Solarized (dark)",
    "Solarized (light)",
    "base16-eighties.dark",
    "base16-mocha.dark",
    "base16-ocean.dark",
    "base16-ocean.light",
];

/// `syntax_theme` is 1 through 128 bytes and must name a built-in Syntect
/// default theme.
pub fn validate_syntax_theme(theme: &str) -> Result<(), String> {
    if theme.is_empty() || theme.len() > 128 {
        return Err("syntax_theme must be 1 through 128 bytes".to_string());
    }
    if !SYNTECT_DEFAULT_THEMES.contains(&theme) {
        return Err("syntax_theme must name a built-in Syntect default theme".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_defaults_match_spec() {
        let settings = EffectiveSettingsDto::initial();
        assert_eq!(settings.revision, 0);
        assert!(settings.thinking_visible);
        assert!(!settings.debug);
        assert_eq!(settings.theme, ThemeId::Default);
        assert_eq!(settings.tool_icons, ToolIconMode::Unicode);
        assert!(settings.mouse_enabled);
        assert!(settings.animation_enabled);
        assert!(settings.syntax_highlighting);
        assert_eq!(settings.syntax_theme, "base16-ocean.dark");
        assert!(!settings.incognito_default);
    }

    #[test]
    fn empty_patch_is_rejected() {
        let patch = SettingsPatchDto {
            thinking_visible: None,
            debug: None,
            theme: None,
            tool_icons: None,
            mouse_enabled: None,
            animation_enabled: None,
            syntax_highlighting: None,
            syntax_theme: None,
            incognito_default: None,
        };
        assert!(patch.validate().is_err());
        assert!(patch.is_empty());
    }

    #[test]
    fn invalid_syntax_theme_patch_is_not_empty() {
        let patch = SettingsPatchDto {
            thinking_visible: None,
            debug: None,
            theme: None,
            tool_icons: None,
            mouse_enabled: None,
            animation_enabled: None,
            syntax_highlighting: None,
            syntax_theme: Some("nord".to_string()),
            incognito_default: None,
        };
        assert!(!patch.is_empty());
        assert!(patch.validate().is_err());
    }

    #[test]
    fn syntax_theme_accepts_syntect_default_names() {
        assert!(validate_syntax_theme("base16-ocean.dark").is_ok());
        assert!(validate_syntax_theme("InspiredGitHub").is_ok());
        assert!(validate_syntax_theme("Solarized (dark)").is_ok());
        assert!(validate_syntax_theme("Solarized (light)").is_ok());
        assert!(validate_syntax_theme("base16-eighties.dark").is_ok());
        assert!(validate_syntax_theme("base16-mocha.dark").is_ok());
        assert!(validate_syntax_theme("base16-ocean.light").is_ok());
    }

    #[test]
    fn syntax_theme_rejects_unknown_and_empty_names() {
        assert!(validate_syntax_theme("nord").is_err());
        assert!(validate_syntax_theme("Monokai").is_err());
        assert!(validate_syntax_theme("").is_err());
        assert!(validate_syntax_theme(&"x".repeat(129)).is_err());
    }
}
