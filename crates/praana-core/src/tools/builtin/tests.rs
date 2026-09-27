//! Project test adapter. Commands are argument arrays, never a shell string.

use std::path::Path;
use std::time::Instant;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::dto::*;
use super::files::validation;
use crate::process::{supervise, SuperviseRequest};
use crate::tools::contract::TypedTool;
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{
    CommandIntent, ToolExecutionContext, ToolIdempotency, ToolInspectContext, ToolIntent,
    ToolMutation,
};
use crate::tools::ToolCapabilities;

pub struct RunTestsTool;

struct Adapter {
    name: &'static str,
    command: Vec<String>,
}

fn detect(root: &Path, targets: &[String], pattern: Option<&str>) -> Result<Adapter, ToolError> {
    let mut candidates = Vec::new();
    let has = |name: &str| root.join(name).exists();
    if has("bun.lock") || has("bun.lockb") {
        candidates.push("bun");
    }
    if has("package-lock.json") {
        candidates.push("npm");
    }
    if has("pnpm-lock.yaml") {
        candidates.push("pnpm");
    }
    if has("yarn.lock") {
        candidates.push("yarn");
    }
    if candidates.len() > 1 {
        return Err(validation(&format!(
            "ambiguous test adapters: {}",
            candidates.join(", ")
        )));
    }
    if let Some(name) = candidates.pop() {
        let mut command = vec![name.to_owned(), "test".to_owned()];
        if let Some(pattern) = pattern {
            match name {
                "bun" => command.extend(["--test-name-pattern".into(), pattern.to_owned()]),
                "npm" | "pnpm" | "yarn" => command.push(format!("--testNamePattern={pattern}")),
                _ => {}
            }
        }
        command.extend(targets.iter().cloned());
        return Ok(Adapter { name, command });
    }
    if has("Cargo.toml") {
        let mut command = vec!["cargo".into(), "test".into()];
        command.extend(targets.iter().cloned());
        if let Some(pattern) = pattern {
            command.push(pattern.to_owned());
        }
        return Ok(Adapter {
            name: "cargo",
            command,
        });
    }
    if has("go.mod") {
        let mut command = vec!["go".into(), "test".into()];
        if targets.is_empty() {
            command.push("./...".into());
        } else {
            command.extend(targets.iter().cloned());
        }
        if let Some(pattern) = pattern {
            command.extend(["-run".into(), pattern.to_owned()]);
        }
        return Ok(Adapter {
            name: "go",
            command,
        });
    }
    if has("pytest.ini") || has("conftest.py") || has("pyproject.toml") || has("setup.py") {
        let mut command = vec!["python".into(), "-m".into(), "pytest".into()];
        if let Some(pattern) = pattern {
            command.extend(["-k".into(), pattern.to_owned()]);
        }
        command.extend(targets.iter().cloned());
        return Ok(Adapter {
            name: "pytest",
            command,
        });
    }
    Err(validation("no test adapter detected"))
}

#[async_trait]
impl TypedTool for RunTestsTool {
    type Input = RunTestsInput;
    type Output = RunTestsOutput;
    const NAME: &'static str = "run_tests";
    const ORDER: u16 = 600;
    const DESCRIPTION: &'static str =
        "Run the detected project test adapter under supervised process limits and return a structured summary.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::SPAWN_PROCESS
    }

    fn inspect(
        &self,
        input: &RunTestsInput,
        context: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        if input.targets.len() > 100 {
            return Err(validation("too many test targets"));
        }
        for target in &input.targets {
            if target.is_empty() || target.len() > 4096 || target.contains('\0') {
                return Err(validation(
                    "test target is empty, too long, or contains NUL",
                ));
            }
        }
        if input
            .name_pattern
            .as_ref()
            .is_some_and(|pattern| pattern.len() > 1024 || pattern.contains('\0'))
        {
            return Err(validation("name pattern is too long or contains NUL"));
        }
        Ok(ToolIntent {
            mutation: ToolMutation::External,
            path_accesses: vec![super::files::access(
                ".",
                crate::tools::intent::PathAccessMode::Read,
            )],
            command: Some(CommandIntent {
                command: "test".into(),
                cwd: context.cwd.clone(),
                read_equivalent: false,
                test_command: true,
            }),
            risk_facts: Vec::new(),
            timeout_ms: input.timeout_ms.unwrap_or(0),
            idempotency: ToolIdempotency::NonIdempotent,
            planned: Vec::new(),
        })
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: RunTestsInput,
        cancel: CancellationToken,
    ) -> Result<RunTestsOutput, ToolError> {
        let adapter = detect(&context.cwd, &input.targets, input.name_pattern.as_deref())?;
        let started = Instant::now();
        let output = supervise(SuperviseRequest {
            command: String::new(),
            argv: Some(adapter.command.clone()),
            cwd: context.cwd.clone(),
            env: std::env::vars().collect(),
            timeout: context.timeout,
            cancel,
            session_id: context.session_id.to_string(),
            stdout_limit: 8 * 1024 * 1024,
            stderr_limit: 8 * 1024 * 1024,
            process_slots: context.process_slots.clone(),
        })
        .await?;
        let stdout = std::str::from_utf8(&output.stdout)
            .map_err(|_| {
                ToolError::new(
                    ToolErrorCode::ToolUnsupported,
                    "binary output is not inlined",
                )
            })?
            .to_owned();
        let stderr = std::str::from_utf8(&output.stderr)
            .map_err(|_| {
                ToolError::new(
                    ToolErrorCode::ToolUnsupported,
                    "binary output is not inlined",
                )
            })?
            .to_owned();
        let counts = parse_counts(adapter.name, &stdout, &stderr);
        if output.truncated {
            return Err(ToolError::new(
                ToolErrorCode::ToolProcessOutputLimit,
                "process output limit",
            )
            .with_details(serde_json::json!({
                "adapter": adapter.name,
                "command": adapter.command,
                "counts": counts,
                "stdout": stdout,
                "stderr": stderr,
                "truncated": true,
            })));
        }
        Ok(RunTestsOutput {
            adapter: adapter.name.to_owned(),
            command: adapter.command,
            exit_code: output.exit_code,
            counts,
            duration_ms: started.elapsed().as_millis() as u64,
            stdout,
            stderr,
        })
    }
}

pub(crate) fn parse_counts(adapter: &str, stdout: &str, stderr: &str) -> Option<TestCountsDto> {
    let text = format!("{stdout}\n{stderr}");
    match adapter {
        "cargo" => cargo_counts(&text),
        "bun" | "npm" | "pnpm" | "yarn" => js_counts(&text),
        "go" => go_counts(&text),
        "pytest" => pytest_counts(&text),
        _ => None,
    }
}

fn capture_number(text: &str, label: &str) -> Option<u64> {
    let pattern = format!(r"(\d+)\s+{label}");
    let regex = regex::Regex::new(&pattern).ok()?;
    regex
        .captures_iter(text)
        .last()
        .and_then(|caps| caps.get(1))
        .and_then(|value| value.as_str().parse().ok())
}

fn cargo_counts(text: &str) -> Option<TestCountsDto> {
    if !text.contains("test result:") {
        return None;
    }
    Some(TestCountsDto {
        passed: capture_number(text, "passed")?,
        failed: capture_number(text, "failed").unwrap_or(0),
        skipped: capture_number(text, "ignored").unwrap_or(0),
    })
}

fn js_counts(text: &str) -> Option<TestCountsDto> {
    let passed = capture_number(text, "pass");
    let failed = capture_number(text, "fail");
    if passed.is_none() && failed.is_none() {
        return None;
    }
    Some(TestCountsDto {
        passed: passed.unwrap_or(0),
        failed: failed.unwrap_or(0),
        skipped: capture_number(text, "skip").unwrap_or(0),
    })
}

fn go_counts(text: &str) -> Option<TestCountsDto> {
    let passed = text
        .lines()
        .filter(|line| line.starts_with("--- PASS:"))
        .count();
    let failed = text
        .lines()
        .filter(|line| line.starts_with("--- FAIL:"))
        .count();
    let skipped = text
        .lines()
        .filter(|line| line.starts_with("--- SKIP:"))
        .count();
    if passed + failed + skipped == 0 {
        return None;
    }
    Some(TestCountsDto {
        passed: passed as u64,
        failed: failed as u64,
        skipped: skipped as u64,
    })
}

fn pytest_counts(text: &str) -> Option<TestCountsDto> {
    if !text.contains(" passed") && !text.contains(" failed") && !text.contains(" skipped") {
        return None;
    }
    if capture_number(text, "passed").is_none()
        && capture_number(text, "failed").is_none()
        && capture_number(text, "skipped").is_none()
    {
        return None;
    }
    Some(TestCountsDto {
        passed: capture_number(text, "passed").unwrap_or(0),
        failed: capture_number(text, "failed").unwrap_or(0),
        skipped: capture_number(text, "skipped").unwrap_or(0),
    })
}

#[cfg(test)]
mod count_tests {
    use super::parse_counts;

    #[test]
    fn parses_supported_summaries_and_leaves_noise_empty() {
        let cargo = parse_counts(
            "cargo",
            "test result: ok. 3 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out",
            "",
        )
        .unwrap();
        assert_eq!((cargo.passed, cargo.failed, cargo.skipped), (3, 1, 2));
        let bun = parse_counts("bun", " 4 pass\n 1 fail\n 2 skip\n", "").unwrap();
        assert_eq!((bun.passed, bun.failed, bun.skipped), (4, 1, 2));
        let go = parse_counts(
            "go",
            "--- PASS: TestA\n--- FAIL: TestB\n--- SKIP: TestC\n",
            "",
        )
        .unwrap();
        assert_eq!((go.passed, go.failed, go.skipped), (1, 1, 1));
        let pytest = parse_counts("pytest", "2 passed, 1 skipped", "").unwrap();
        assert_eq!((pytest.passed, pytest.failed, pytest.skipped), (2, 0, 1));
        assert!(parse_counts("cargo", "running tests", "").is_none());
        assert!(parse_counts("unknown", "3 passed", "").is_none());
    }
}
