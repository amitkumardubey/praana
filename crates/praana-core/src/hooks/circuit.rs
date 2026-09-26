use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{circuit_exempt, ToolIntent};
use crate::tools::ToolCapabilities;

pub fn check(
    tool_name: &str,
    arguments: &serde_json::Value,
    intent: &ToolIntent,
    capabilities: ToolCapabilities,
    threshold: u32,
    counts: &Mutex<BTreeMap<String, u32>>,
) -> Result<(), ToolError> {
    if circuit_exempt(intent, capabilities) {
        return Ok(());
    }
    let counts = counts.lock().unwrap_or_else(|err| err.into_inner());
    let seen = counts
        .get(&attempt_key(tool_name, arguments))
        .copied()
        .unwrap_or(0);
    if seen + 1 >= threshold {
        return Err(ToolError::new(
            ToolErrorCode::ToolCircuitOpen,
            "circuit open",
        ));
    }
    let errors = counts
        .get(&error_key(tool_name, intent))
        .copied()
        .unwrap_or(0);
    if errors + 1 >= threshold {
        return Err(ToolError::new(
            ToolErrorCode::ToolCircuitOpen,
            "circuit open",
        ));
    }
    Ok(())
}

pub fn record_attempt(
    tool_name: &str,
    arguments: &serde_json::Value,
    intent: &ToolIntent,
    capabilities: ToolCapabilities,
    counts: &Mutex<BTreeMap<String, u32>>,
) {
    if circuit_exempt(intent, capabilities) {
        return;
    }
    let mut counts = counts.lock().unwrap_or_else(|err| err.into_inner());
    let key = attempt_key(tool_name, arguments);
    let seen = counts.get(&key).copied().unwrap_or(0);
    counts.insert(key, seen.saturating_add(1));
}

pub fn record_error(
    tool_name: &str,
    intent: &ToolIntent,
    capabilities: ToolCapabilities,
    code: ToolErrorCode,
    counts: &Mutex<BTreeMap<String, u32>>,
) {
    if circuit_exempt(intent, capabilities) || !counts_as_error(code) {
        return;
    }
    let mut counts = counts.lock().unwrap_or_else(|err| err.into_inner());
    let key = error_key(tool_name, intent);
    let seen = counts.get(&key).copied().unwrap_or(0);
    counts.insert(key, seen.saturating_add(1));
}

fn counts_as_error(code: ToolErrorCode) -> bool {
    !matches!(
        code,
        ToolErrorCode::ToolPlanBlocked
            | ToolErrorCode::ToolRiskDeclined
            | ToolErrorCode::ToolRiskHeadlessDenied
            | ToolErrorCode::ToolCancelled
            | ToolErrorCode::ToolPathBusy
            | ToolErrorCode::ToolCircuitOpen
    )
}

fn attempt_key(tool_name: &str, arguments: &serde_json::Value) -> String {
    format!(
        "attempt:{tool_name}:{}",
        crate::canonical_json::to_canonical_json_string(arguments).unwrap_or_default()
    )
}

fn error_key(tool_name: &str, intent: &ToolIntent) -> String {
    if let Some(command) = &intent.command {
        return format!("err:{}", command.command);
    }
    if let Some(access) = intent.path_accesses.first() {
        return format!("err:{}", access.normalized_absolute.display());
    }
    format!("err:{tool_name}")
}
