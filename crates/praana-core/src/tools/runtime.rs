//! Batch execution. Hook order is fixed in this function.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::types::{CircuitConfig, RiskConfig, ToolsConfig};
use crate::hooks::risk::RiskDecider;
use crate::protocol::id::{AttemptId, SessionId, Sha256Digest, ToolBatchId, TurnId};

use super::contract::{ErasedTool, PreparedToolCall};
use super::error::{map_side_effect_uncertain, map_tool_error, ToolError, ToolErrorCode};
use super::intent::{side_effect_capable, ToolExecutionContext, ToolInspectContext, ToolIntent};
use super::locks::{PathLease, PathLockTable};
use super::result::{canonical_tool_result_bytes, ToolResultDto};
use super::{ToolCapabilities, ToolName, ToolRegistry};
use crate::hooks::{self, HookTrace};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderToolCall {
    pub tool_call_id: crate::protocol::id::ToolCallId,
    pub tool_name: ToolName,
    pub arguments: serde_json::Value,
    pub provider_ordinal: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolBatchRequest {
    pub batch_id: ToolBatchId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub attempt_id: AttemptId,
    pub calls: Vec<ProviderToolCall>,
    pub origin: ToolCallOrigin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCallOrigin {
    Model,
    SlashCommand,
    HeadlessCommand,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchOrigin {
    Model,
    SlashCommand,
    HeadlessCommand,
}

#[derive(Clone, Debug)]
pub struct FinishedCall {
    pub dto: ToolResultDto,
    pub canonical_bytes: Vec<u8>,
    pub execution_started: bool,
    pub status: crate::protocol::tool_result::ToolResultStatus,
}

#[derive(Clone, Debug)]
pub struct BatchFinished {
    pub results: Vec<FinishedCall>,
    pub poisoned: bool,
}

pub trait ResultCommit: Send + Sync {
    fn commit(&self, finished: &FinishedCall);
}

struct Admitted {
    call: ProviderToolCall,
    tool: Arc<dyn ErasedTool>,
    prepared: PreparedToolCall,
    capabilities: ToolCapabilities,
    lease: PathLease,
}

pub struct ToolRuntime {
    registry: ToolRegistry,
    tools: ToolsConfig,
    risk: RiskConfig,
    circuit: CircuitConfig,
    plan_mode: AtomicBool,
    headless: AtomicBool,
    poisoned: AtomicBool,
    trace: HookTrace,
    locks: Arc<PathLockTable>,
    parallel: Arc<Semaphore>,
    spawn: Arc<Semaphore>,
    circuit_counts: Mutex<std::collections::BTreeMap<String, u32>>,
    risk_decider: Mutex<Option<Arc<dyn RiskDecider>>>,
    risk_gate: tokio::sync::Mutex<()>,
    commit: Mutex<Option<Arc<dyn ResultCommit>>>,
    retained: Mutex<Vec<JoinHandle<()>>>,
}

impl ToolRuntime {
    pub fn new(
        registry: ToolRegistry,
        tools: ToolsConfig,
        risk: RiskConfig,
        circuit: CircuitConfig,
    ) -> Self {
        let parallel = Arc::new(Semaphore::new(tools.max_parallel_calls.max(1) as usize));
        let spawn = Arc::new(Semaphore::new(tools.max_spawned_processes.max(1) as usize));
        Self {
            registry,
            tools,
            risk,
            circuit,
            plan_mode: AtomicBool::new(false),
            headless: AtomicBool::new(true),
            poisoned: AtomicBool::new(false),
            trace: HookTrace::new(),
            locks: PathLockTable::new(),
            parallel,
            spawn,
            circuit_counts: Mutex::new(std::collections::BTreeMap::new()),
            risk_decider: Mutex::new(None),
            risk_gate: tokio::sync::Mutex::new(()),
            commit: Mutex::new(None),
            retained: Mutex::new(Vec::new()),
        }
    }

    pub fn set_risk_decider(&self, decider: Arc<dyn RiskDecider>) {
        *self
            .risk_decider
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(decider);
    }

    pub fn set_result_commit(&self, commit: Arc<dyn ResultCommit>) {
        *self.commit.lock().unwrap_or_else(|err| err.into_inner()) = Some(commit);
    }

    pub fn set_plan_mode(&self, enabled: bool) {
        self.plan_mode.store(enabled, Ordering::SeqCst);
    }

    pub fn set_headless(&self, headless: bool) {
        self.headless.store(headless, Ordering::SeqCst);
    }

    pub fn set_trace(&self, trace: HookTrace) {
        self.trace.replace_from(&trace);
    }

    pub fn trace(&self) -> HookTrace {
        self.trace.clone()
    }

    pub fn locks(&self) -> Arc<PathLockTable> {
        Arc::clone(&self.locks)
    }

    pub async fn execute_batch(
        &self,
        mut request: ToolBatchRequest,
        origin: BatchOrigin,
        cancel: CancellationToken,
    ) -> Result<BatchFinished, ToolError> {
        if self.poisoned.load(Ordering::SeqCst) {
            return Err(ToolError::new(
                ToolErrorCode::ToolInternal,
                "tool runtime is poisoned",
            ));
        }
        let headless = self.headless.load(Ordering::SeqCst)
            || matches!(request.origin, ToolCallOrigin::HeadlessCommand)
            || matches!(origin, BatchOrigin::HeadlessCommand);
        let mut calls = std::mem::take(&mut request.calls);
        calls.sort_by_key(|call| call.provider_ordinal);
        if duplicate_identity(&calls) {
            return Err(ToolError::new(
                ToolErrorCode::ToolInternal,
                "duplicate provider ordinal or call id",
            ));
        }
        let mut admitted = Vec::new();
        let mut blocked = Vec::new();
        for call in calls {
            if cancel.is_cancelled() {
                blocked.push((
                    call.provider_ordinal,
                    self.finish_error(
                        &call,
                        ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"),
                        false,
                    )?,
                ));
                continue;
            }
            match self.preflight(call, headless).await? {
                Preflight::Ready(item) => admitted.push(item),
                Preflight::Blocked(ordinal, finished) => blocked.push((ordinal, finished)),
            }
        }
        let ran = futures::future::join_all(admitted.into_iter().map(|item| {
            let cancel = cancel.clone();
            async move {
                let ordinal = item.call.provider_ordinal;
                let finished = self.run_admitted(item, &cancel).await?;
                Ok::<_, ToolError>((ordinal, finished))
            }
        }))
        .await;
        let mut results = blocked;
        for item in ran {
            results.push(item?);
        }
        results.sort_by_key(|(ordinal, _)| *ordinal);
        let poisoned = self.poisoned.load(Ordering::SeqCst);
        Ok(BatchFinished {
            results: results.into_iter().map(|(_, finished)| finished).collect(),
            poisoned,
        })
    }

    async fn preflight(
        &self,
        call: ProviderToolCall,
        headless: bool,
    ) -> Result<Preflight, ToolError> {
        let Some(tool) = self.registry.get(&call.tool_name) else {
            return Ok(Preflight::Blocked(
                call.provider_ordinal,
                self.finish_error(
                    &call,
                    ToolError::new(ToolErrorCode::ToolUnknown, "unknown tool"),
                    false,
                )?,
            ));
        };
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let inspect_ctx = ToolInspectContext {
            cwd: cwd.clone(),
            plan_mode: self.plan_mode.load(Ordering::SeqCst),
        };
        let mut prepared = match tool.parse_and_inspect(&call.arguments, &inspect_ctx) {
            Ok(prepared) => prepared,
            Err(error) => {
                return Ok(Preflight::Blocked(
                    call.provider_ordinal,
                    self.finish_error(&call, error, false)?,
                ));
            }
        };
        let capabilities = tool.descriptor().capabilities;
        self.trace.push("plan");
        if let Err(error) =
            hooks::plan::check(self.plan_mode.load(Ordering::SeqCst), &prepared.intent)
        {
            return Ok(Preflight::Blocked(
                call.provider_ordinal,
                self.finish_error(&call, error, false)?,
            ));
        }
        self.trace.push("validate");
        if let Err(error) = hooks::validate::check(&mut prepared.intent, &cwd, &self.tools) {
            hooks::circuit::record_error(
                call.tool_name.as_str(),
                &prepared.intent,
                capabilities,
                error.code(),
                &self.circuit_counts,
            );
            return Ok(Preflight::Blocked(
                call.provider_ordinal,
                self.finish_error(&call, error, false)?,
            ));
        }
        self.trace.push("risk");
        let argument_hash = Sha256Digest::digest_bytes(
            crate::canonical_json::to_canonical_json_bytes(&call.arguments)
                .unwrap_or_else(|_| Vec::new())
                .as_slice(),
        )
        .as_str()
        .to_owned();
        let decider = self
            .risk_decider
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone();
        if let Err(error) = hooks::risk::check(
            &prepared.intent,
            headless,
            &self.risk,
            call.tool_call_id.as_str(),
            &argument_hash,
            decider.as_deref(),
            &self.risk_gate,
        )
        .await
        {
            return Ok(Preflight::Blocked(
                call.provider_ordinal,
                self.finish_error(&call, error, false)?,
            ));
        }
        self.trace.push("circuit");
        if let Err(error) = hooks::circuit::check(
            call.tool_name.as_str(),
            &call.arguments,
            &prepared.intent,
            capabilities,
            self.circuit.loop_threshold,
            &self.circuit_counts,
        ) {
            return Ok(Preflight::Blocked(
                call.provider_ordinal,
                self.finish_error(&call, error, false)?,
            ));
        }
        self.trace.push("write_lock");
        let lease = match self.acquire(&prepared.intent) {
            Ok(lease) => lease,
            Err(error) => {
                return Ok(Preflight::Blocked(
                    call.provider_ordinal,
                    self.finish_error(&call, error, false)?,
                ));
            }
        };
        hooks::circuit::record_attempt(
            call.tool_name.as_str(),
            &call.arguments,
            &prepared.intent,
            capabilities,
            &self.circuit_counts,
        );
        Ok(Preflight::Ready(Admitted {
            call,
            tool,
            prepared,
            capabilities,
            lease,
        }))
    }

    async fn run_admitted(
        &self,
        admitted: Admitted,
        cancel: &CancellationToken,
    ) -> Result<FinishedCall, ToolError> {
        let Admitted {
            call,
            tool,
            prepared,
            capabilities,
            lease,
        } = admitted;
        let started = std::time::Instant::now();
        self.trace.push("execute");
        let call_cancel = cancel.child_token();
        let timeout = resolved_timeout(&prepared.intent, capabilities, &self.tools);
        let exec_ctx = ToolExecutionContext {
            cwd: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
            workspace_roots: vec![
                std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
            ],
            process_slots: Some(Arc::clone(&self.spawn)),
        };
        let permit = tokio::select! {
            permit = self.parallel.acquire() => permit,
            _ = call_cancel.cancelled() => {
                drop(lease);
                self.trace.push("write_lock_release");
                return self.finish_error(&call, ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"), false);
            }
        };
        let permit = match permit {
            Ok(permit) => permit,
            Err(_) => {
                drop(lease);
                self.trace.push("write_lock_release");
                return self.finish_error(
                    &call,
                    ToolError::new(ToolErrorCode::ToolInternal, "semaphore closed"),
                    false,
                );
            }
        };
        let side_effect = side_effect_capable(&prepared.intent, capabilities);
        let intent = prepared.intent.clone();
        let tool = Arc::clone(&tool);
        let exec_cancel = call_cancel.clone();
        let execution = async move { tool.execute_erased(exec_ctx, prepared, exec_cancel).await };
        let mut handle = tokio::spawn(std::panic::AssertUnwindSafe(execution).catch_unwind());
        let polled = tokio::select! {
            biased;
            result = &mut handle => Poll::Done(map_join(result)),
            _ = call_cancel.cancelled() => Poll::Stop { cancelled: true },
            _ = tokio::time::sleep(timeout) => Poll::Stop { cancelled: false },
        };
        let output = match polled {
            Poll::Done(value) => value,
            Poll::Stop { cancelled } => {
                if !cancelled {
                    call_cancel.cancel();
                }
                self.reap(handle, side_effect, cancelled, cancel).await
            }
        };
        drop(permit);
        let duration_ms = started.elapsed().as_millis() as u64;
        if let Err(error) = &output {
            if error.code() == ToolErrorCode::ToolInternal
                && error.message() == "side effect uncertain"
            {
                drop(lease);
                self.trace.push("write_lock_release");
                return self.finish_uncertain(&call);
            }
            hooks::circuit::record_error(
                call.tool_name.as_str(),
                &intent,
                capabilities,
                error.code(),
                &self.circuit_counts,
            );
        }
        let finished = self.finish_output(&call, output, duration_ms, lease)?;
        Ok(finished)
    }

    async fn reap(
        &self,
        mut handle: JoinHandle<std::thread::Result<Result<serde_json::Value, ToolError>>>,
        side_effect: bool,
        cancelled: bool,
        batch: &CancellationToken,
    ) -> Result<serde_json::Value, ToolError> {
        match tokio::time::timeout(Duration::from_millis(1000), &mut handle).await {
            Ok(joined) => {
                let _ = map_join(joined);
                if cancelled {
                    Err(ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"))
                } else {
                    Err(ToolError::new(ToolErrorCode::ToolTimedOut, "timed out"))
                }
            }
            Err(_) if side_effect => {
                self.poisoned.store(true, Ordering::SeqCst);
                batch.cancel();
                self.retained
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .push(tokio::spawn(async move {
                        let _ = handle.await;
                    }));
                Err(ToolError::new(
                    ToolErrorCode::ToolInternal,
                    "side effect uncertain",
                ))
            }
            Err(_) => {
                handle.abort();
                Err(ToolError::new(ToolErrorCode::ToolTimedOut, "timed out"))
            }
        }
    }

    fn finish_output(
        &self,
        call: &ProviderToolCall,
        output: Result<serde_json::Value, ToolError>,
        duration_ms: u64,
        lease: PathLease,
    ) -> Result<FinishedCall, ToolError> {
        self.trace.push("lsp");
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(hooks::lsp::noop));
        self.trace.push("verify");
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(hooks::verify::noop));
        self.trace.push("enrich");
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(hooks::enrich::noop));
        self.trace.push("redact");
        let mut dto = match output {
            Ok(value) => success_dto(call, value, duration_ms),
            Err(error) => error_dto(call, &error, duration_ms),
        };
        let redacted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            hooks::redact::apply(&mut dto)
        }));
        let redact_error = match redacted {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some(ToolError::new(
                ToolErrorCode::ToolRedactionFailed,
                "redaction failed",
            )),
        };
        if let Some(error) = redact_error {
            drop(dto);
            drop(lease);
            self.trace.push("circuit_account");
            self.trace.push("write_lock_release");
            return self.finish_error(call, error, true);
        }
        self.trace.push("circuit_account");
        drop(lease);
        self.trace.push("write_lock_release");
        let status = dto
            .error
            .as_ref()
            .map(|error| map_tool_error(error.code).status)
            .unwrap_or(crate::protocol::tool_result::ToolResultStatus::Success);
        let canonical_bytes = canonical_tool_result_bytes(&dto)?;
        let finished = FinishedCall {
            dto,
            canonical_bytes,
            execution_started: true,
            status,
        };
        if let Some(commit) = self
            .commit
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
        {
            let _ =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| commit.commit(&finished)));
        }
        Ok(finished)
    }

    fn finish_uncertain(&self, call: &ProviderToolCall) -> Result<FinishedCall, ToolError> {
        let mapped = map_side_effect_uncertain();
        let mut dto = error_dto(
            call,
            &ToolError::new(ToolErrorCode::ToolInternal, "side effect uncertain"),
            0,
        );
        if let Some(error) = dto.error.as_mut() {
            error.retryable = mapped.retryable;
            error.details = Some(serde_json::Value::String(mapped.canonical_code.to_owned()));
        }
        let canonical_bytes = canonical_tool_result_bytes(&dto)?;
        Ok(FinishedCall {
            dto,
            canonical_bytes,
            execution_started: true,
            status: mapped.status,
        })
    }

    fn acquire(&self, intent: &ToolIntent) -> Result<PathLease, ToolError> {
        let keys = intent
            .path_accesses
            .iter()
            .map(|access| {
                let path = if access.normalized_absolute.as_os_str().is_empty() {
                    super::intent::canonical_lock_key(
                        &std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
                        &access.requested,
                    )?
                } else {
                    access.normalized_absolute.clone()
                };
                Ok((
                    path,
                    matches!(access.mode, super::intent::PathAccessMode::Write),
                ))
            })
            .collect::<Result<Vec<_>, ToolError>>()?;
        self.locks.try_acquire_keys(keys)
    }

    fn finish_error(
        &self,
        call: &ProviderToolCall,
        error: ToolError,
        execution_started: bool,
    ) -> Result<FinishedCall, ToolError> {
        let mapped = map_tool_error(error.code());
        let dto = error_dto(call, &error, 0);
        let canonical_bytes = canonical_tool_result_bytes(&dto)?;
        Ok(FinishedCall {
            dto,
            canonical_bytes,
            execution_started,
            status: mapped.status,
        })
    }
}

enum Poll {
    Done(Result<serde_json::Value, ToolError>),
    Stop { cancelled: bool },
}

enum Preflight {
    Ready(Admitted),
    Blocked(u32, FinishedCall),
}

fn duplicate_identity(calls: &[ProviderToolCall]) -> bool {
    let mut ordinals = std::collections::BTreeSet::new();
    let mut ids = std::collections::BTreeSet::new();
    for call in calls {
        if !ordinals.insert(call.provider_ordinal)
            || !ids.insert(call.tool_call_id.as_str().to_owned())
        {
            return true;
        }
    }
    false
}

fn resolved_timeout(
    intent: &ToolIntent,
    capabilities: ToolCapabilities,
    tools: &ToolsConfig,
) -> Duration {
    let shell = intent.command.is_some() || capabilities.contains(ToolCapabilities::SPAWN_PROCESS);
    let millis = if shell {
        let requested = if intent.timeout_ms == 0 {
            tools.shell_timeout_ms
        } else {
            intent.timeout_ms
        };
        requested.min(tools.shell_max_timeout_ms)
    } else {
        intent.timeout_ms.min(tools.default_timeout_ms)
    };
    Duration::from_millis(millis.max(1))
}

fn map_join(
    result: Result<
        std::thread::Result<Result<serde_json::Value, ToolError>>,
        tokio::task::JoinError,
    >,
) -> Result<serde_json::Value, ToolError> {
    match result {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err(ToolError::new(ToolErrorCode::ToolPanicked, "tool panicked")),
        Err(_) => Err(ToolError::new(ToolErrorCode::ToolCancelled, "cancelled")),
    }
}

fn success_dto(
    call: &ProviderToolCall,
    value: serde_json::Value,
    duration_ms: u64,
) -> ToolResultDto {
    ToolResultDto {
        ok: true,
        data: Some(value),
        error: None,
        warnings: Vec::new(),
        artifacts: Vec::new(),
        meta: super::result::ToolResultMeta {
            tool_call_id: call.tool_call_id.clone(),
            tool_name: call.tool_name.clone(),
            duration_ms,
            cancelled: false,
            timed_out: false,
            redacted: false,
            truncated: false,
        },
    }
}

fn error_dto(call: &ProviderToolCall, error: &ToolError, duration_ms: u64) -> ToolResultDto {
    let mapped = map_tool_error(error.code());
    ToolResultDto {
        ok: false,
        data: None,
        error: Some(super::result::ToolErrorDto {
            code: error.code(),
            message: error.message().to_owned(),
            retryable: mapped.retryable,
            details: None,
        }),
        warnings: Vec::new(),
        artifacts: Vec::new(),
        meta: super::result::ToolResultMeta {
            tool_call_id: call.tool_call_id.clone(),
            tool_name: call.tool_name.clone(),
            duration_ms,
            cancelled: error.code() == ToolErrorCode::ToolCancelled,
            timed_out: error.code() == ToolErrorCode::ToolTimedOut,
            redacted: false,
            truncated: false,
        },
    }
}
