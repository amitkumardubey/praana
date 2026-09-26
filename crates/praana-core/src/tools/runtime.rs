//! Batch execution. Hook order is fixed in this function.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::stream::{FuturesUnordered, StreamExt};
use futures::FutureExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::clock::Clock;
use crate::config::types::{CircuitConfig, RiskConfig, ToolsConfig};
use crate::history::artifact::{ArtifactStore, PublishInput};
use crate::history::preview::ArtifactContentType;
use crate::hooks::risk::RiskDecider;
use crate::id::{IdGenerator, MonotonicUlidGenerator};
use crate::protocol::events::{
    CanonicalEvent, EventEnvelope, ToolBatchCompleted, ToolExecutionStarted, ToolMutability,
};
use crate::protocol::hashes::{calculate_result_messages_hash, calculate_tool_arguments_hash};
use crate::protocol::id::{
    AttemptId, EventId, SessionId, Sha256Digest, StepId, ToolBatchId, ToolExecutionId, TurnId,
};
use crate::protocol::tool_result::ToolResultStatus;

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
    pub execution_id: Option<ToolExecutionId>,
    pub force_binary: bool,
}

#[derive(Clone, Debug)]
pub struct BatchFinished {
    pub results: Vec<FinishedCall>,
    pub poisoned: bool,
    pub uncertain_execution_ids: Vec<ToolExecutionId>,
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
    execution_id: ToolExecutionId,
    batch_id: ToolBatchId,
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
    retained: Mutex<Vec<RetainedExecution>>,
    workspace: Mutex<PathBuf>,
    session_dir: Mutex<PathBuf>,
    session_id: Mutex<SessionId>,
    reads: Mutex<BTreeSet<PathBuf>>,
    ids: Mutex<MonotonicUlidGenerator>,
}

pub struct DurableSession<'a> {
    pub log: &'a mut crate::history::event_log::EventLogStore,
    pub artifacts: &'a ArtifactStore,
    pub ids: &'a MonotonicUlidGenerator,
    pub clock: &'a dyn Clock,
    pub session_id: SessionId,
    pub step_id: StepId,
    pub fault_after_body: bool,
}

pub enum DurableBatchOutcome {
    Finished(BatchFinished),
    CrashedAfterBody,
}

enum BatchSlot {
    Ready {
        call_index: u32,
        item: Admitted,
    },
    Blocked {
        call_index: u32,
        call: ProviderToolCall,
        finished: FinishedCall,
        execution_id: ToolExecutionId,
    },
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
            workspace: Mutex::new(
                std::env::current_dir()
                    .ok()
                    .and_then(|path| std::fs::canonicalize(&path).ok())
                    .unwrap_or_else(|| PathBuf::from(".")),
            ),
            session_dir: Mutex::new(std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
            session_id: Mutex::new(placeholder_session()),
            reads: Mutex::new(BTreeSet::new()),
            ids: Mutex::new(MonotonicUlidGenerator::system()),
        }
    }

    pub fn set_workspace(&self, workspace: PathBuf) {
        let canonical = std::fs::canonicalize(&workspace).unwrap_or(workspace);
        *self.workspace.lock().unwrap_or_else(|err| err.into_inner()) = canonical;
    }

    pub fn set_session(&self, session_dir: PathBuf, session_id: SessionId) {
        let _ = std::fs::create_dir_all(&session_dir);
        *self
            .session_dir
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = session_dir;
        *self
            .session_id
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = session_id;
    }

    pub fn workspace(&self) -> PathBuf {
        self.workspace
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub fn session_dir(&self) -> PathBuf {
        self.session_dir
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub fn session_id(&self) -> SessionId {
        *self
            .session_id
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }

    fn next_execution_id(&self) -> ToolExecutionId {
        self.ids
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .next_id()
            .expect("execution id")
    }

    fn note_read(&self, path: PathBuf) {
        self.reads
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(path);
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

    pub fn is_poisoned(&self) -> bool {
        self.poisoned.load(Ordering::SeqCst)
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
            match self.preflight(call, headless, request.batch_id).await? {
                Preflight::Ready(item) => admitted.push(item),
                Preflight::Blocked(ordinal, finished) => blocked.push((ordinal, finished)),
            }
        }
        let ran = futures::future::join_all(admitted.into_iter().map(|item| {
            let cancel = cancel.clone();
            async move {
                let ordinal = item.call.provider_ordinal;
                let finished = self.run_admitted(item, &cancel, None).await?;
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
        let results: Vec<FinishedCall> =
            results.into_iter().map(|(_, finished)| finished).collect();
        let uncertain_execution_ids = uncertain_ids(&results);
        Ok(BatchFinished {
            results,
            poisoned,
            uncertain_execution_ids,
        })
    }

    pub async fn execute_durable_batch(
        &self,
        request: ToolBatchRequest,
        origin: BatchOrigin,
        cancel: CancellationToken,
        durable: &mut DurableSession<'_>,
    ) -> Result<DurableBatchOutcome, ToolError> {
        if self.poisoned.load(Ordering::SeqCst) {
            return Err(ToolError::new(
                ToolErrorCode::ToolInternal,
                "tool runtime is poisoned",
            ));
        }
        let headless = self.headless.load(Ordering::SeqCst)
            || matches!(request.origin, ToolCallOrigin::HeadlessCommand)
            || matches!(origin, BatchOrigin::HeadlessCommand);
        let mut calls = request.calls.clone();
        calls.sort_by_key(|call| call.provider_ordinal);
        if duplicate_identity(&calls) {
            return Err(ToolError::new(
                ToolErrorCode::ToolInternal,
                "duplicate provider ordinal or call id",
            ));
        }
        let mut slots = Vec::new();
        for (call_index, call) in calls.into_iter().enumerate() {
            if cancel.is_cancelled() {
                slots.push(BatchSlot::Blocked {
                    call_index: call_index as u32,
                    call: call.clone(),
                    finished: self.finish_error(
                        &call,
                        ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"),
                        false,
                    )?,
                    execution_id: fresh_id(durable.ids)?,
                });
                continue;
            }
            match self
                .preflight(call.clone(), headless, request.batch_id)
                .await?
            {
                Preflight::Ready(item) => slots.push(BatchSlot::Ready {
                    call_index: call_index as u32,
                    item,
                }),
                Preflight::Blocked(_, finished) => {
                    slots.push(BatchSlot::Blocked {
                        call_index: call_index as u32,
                        call,
                        finished,
                        execution_id: fresh_id(durable.ids)?,
                    });
                }
            }
        }
        let mut ready = Vec::new();
        let mut blocked = Vec::new();
        for slot in slots {
            match slot {
                BatchSlot::Ready { call_index, item } => ready.push((call_index, item)),
                BatchSlot::Blocked {
                    call_index,
                    call,
                    finished,
                    execution_id,
                } => blocked.push((call_index, call, finished, execution_id)),
            }
        }
        let (started, finished_ready, not_started) =
            self.drive_ready(&request, durable, ready, &cancel).await?;
        blocked.extend(not_started);
        if durable.fault_after_body {
            return Ok(DurableBatchOutcome::CrashedAfterBody);
        }
        let mut inputs = Vec::new();
        for (call_index, finished) in &finished_ready {
            let start = started.iter().find(|(index, _, _)| index == call_index);
            inputs.push(self.publish_input(
                durable,
                &request,
                *call_index,
                finished,
                start.map(|(_, event_id, execution_id)| (*event_id, *execution_id)),
            )?);
        }
        for (call_index, call, finished, execution_id) in &blocked {
            let _ = call;
            inputs.push(
                self.publish_input(durable, &request, *call_index, finished, None)
                    .map(|mut input| {
                        input.execution_id = *execution_id;
                        input
                    })?,
            );
        }
        inputs.sort_by_key(|input| input.call_index);
        if !inputs.is_empty() {
            durable
                .artifacts
                .publish_batch(durable.log, &inputs, None)
                .map_err(|_| {
                    ToolError::new(ToolErrorCode::ToolArtifactFailed, "artifact publish failed")
                })?;
        }
        let events = durable
            .log
            .events()
            .map_err(|_| ToolError::new(ToolErrorCode::ToolInternal, "event read failed"))?;
        let mut messages = Vec::new();
        let mut finish_ids = Vec::new();
        let mut call_ids = Vec::new();
        for input in &inputs {
            let envelope = events
                .iter()
                .find(|event| event.event_id == input.finish_event_id)
                .ok_or_else(|| {
                    ToolError::new(ToolErrorCode::ToolInternal, "finish event missing")
                })?;
            let crate::protocol::events::CanonicalEvent::ToolExecutionFinished(finished) =
                &envelope.event
            else {
                return Err(ToolError::new(
                    ToolErrorCode::ToolInternal,
                    "finish event kind mismatch",
                ));
            };
            messages.push(finished.result.clone());
            finish_ids.push(envelope.event_id);
            call_ids.push(input.call_id.clone());
        }
        let result_messages_hash = calculate_result_messages_hash(&messages)
            .map_err(|_| ToolError::new(ToolErrorCode::ToolInternal, "result hash failed"))?;
        self.append_durable(
            durable,
            Some(request.turn_id),
            Some(request.attempt_id),
            CanonicalEvent::ToolBatchCompleted(ToolBatchCompleted {
                batch_id: request.batch_id,
                step_id: durable.step_id,
                call_ids,
                result_event_ids: finish_ids,
                result_messages_hash,
            }),
        )?;
        #[cfg(feature = "failpoints")]
        crate::crash_point::hit("runtime.after_tool_batch_completed");
        let mut results = finished_ready;
        results.extend(
            blocked
                .into_iter()
                .map(|(index, _, finished, _)| (index, finished)),
        );
        results.sort_by_key(|(index, _)| *index);
        let poisoned = self.poisoned.load(Ordering::SeqCst);
        let results: Vec<FinishedCall> =
            results.into_iter().map(|(_, finished)| finished).collect();
        let uncertain_execution_ids = uncertain_ids(&results);
        Ok(DurableBatchOutcome::Finished(BatchFinished {
            results,
            poisoned,
            uncertain_execution_ids,
        }))
    }

    fn publish_input(
        &self,
        durable: &mut DurableSession<'_>,
        request: &ToolBatchRequest,
        call_index: u32,
        finished: &FinishedCall,
        started: Option<(EventId, ToolExecutionId)>,
    ) -> Result<PublishInput, ToolError> {
        let (started_event_id, execution_id) = match started {
            Some((event_id, execution_id)) => (Some(event_id), execution_id),
            None => (None, fresh_id(durable.ids)?),
        };
        let content_type = if finished.force_binary {
            ArtifactContentType::Binary
        } else {
            match finished.dto.meta.tool_name.as_str() {
                "shell" => ArtifactContentType::Log,
                "git_diff" => ArtifactContentType::Diff,
                "run_tests" => ArtifactContentType::TestOutput,
                "search_code" | "find_files" => ArtifactContentType::SearchResults,
                _ => ArtifactContentType::Json,
            }
        };
        Ok(PublishInput {
            artifact_id: fresh_id(durable.ids)?,
            finish_event_id: fresh_id(durable.ids)?,
            result_message_id: fresh_id(durable.ids)?,
            canonical_bytes: finished.canonical_bytes.clone(),
            content_type,
            tool_name: finished.dto.meta.tool_name.as_str().to_owned(),
            call_id: finished.dto.meta.tool_call_id.clone(),
            call_index,
            execution_id,
            batch_id: request.batch_id,
            step_id: durable.step_id,
            turn_id: request.turn_id,
            attempt_id: request.attempt_id,
            execution_started: finished.execution_started,
            started_event_id,
            status: if finished.dto.ok {
                ToolResultStatus::Success
            } else {
                finished.status.clone()
            },
            label: Some(finished.dto.meta.tool_name.as_str().to_owned()),
            normalized_path: None,
            exit_code: None,
            redacted: finished.dto.meta.redacted,
            redaction_json: "{\"applied\":false,\"replacement_count\":0,\"kinds\":[]}".to_owned(),
            force_binary: finished.force_binary,
        })
    }

    fn append_durable(
        &self,
        durable: &mut DurableSession<'_>,
        turn_id: Option<TurnId>,
        attempt_id: Option<AttemptId>,
        event: CanonicalEvent,
    ) -> Result<EventId, ToolError> {
        let event_id = fresh_id(durable.ids)?;
        let envelope = EventEnvelope {
            schema_version: crate::protocol::constants::EVENT_SCHEMA_VERSION,
            event_id,
            session_id: durable.session_id,
            sequence: durable.log.current_sequence() + 1,
            timestamp_ms: durable.clock.now_ms(),
            turn_id,
            attempt_id,
            event,
        };
        durable
            .log
            .append_event(&envelope)
            .map_err(|_| ToolError::new(ToolErrorCode::ToolInternal, "event append failed"))?;
        Ok(event_id)
    }

    async fn preflight(
        &self,
        call: ProviderToolCall,
        headless: bool,
        batch_id: ToolBatchId,
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
        let cwd = self.workspace();
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
        if let Err(error) = hooks::validate::check(&mut prepared.intent, &cwd, &self.tools)
            .and_then(|_| self.check_planned(call.tool_name.as_str(), &prepared.intent))
        {
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
            execution_id: self.next_execution_id(),
            batch_id,
        }))
    }

    fn check_planned(&self, tool_name: &str, intent: &ToolIntent) -> Result<(), ToolError> {
        if tool_name == "shell" {
            if let Some(command) = &intent.command {
                crate::tools::shell_parse::ensure_executable(&command.command)?;
            }
            if let Some(access) = intent.path_accesses.first() {
                if !access.normalized_absolute.is_dir() {
                    return Err(ToolError::new(
                        ToolErrorCode::ToolValidationFailed,
                        "cwd is not a directory",
                    ));
                }
            }
        }
        let reads = self.reads.lock().unwrap_or_else(|err| err.into_inner());
        for change in &intent.planned {
            match change {
                super::intent::PlannedChange::Write {
                    requested_path,
                    expected_sha256,
                } => {
                    let path = intent
                        .path_accesses
                        .iter()
                        .find(|access| access.requested == *requested_path)
                        .map(|access| access.normalized_absolute.clone())
                        .ok_or_else(|| {
                            ToolError::new(ToolErrorCode::ToolInternal, "write path missing")
                        })?;
                    if !path.exists() && expected_sha256.is_some() {
                        return Err(ToolError::new(
                            ToolErrorCode::ToolValidationFailed,
                            "expected hash conflicts with a missing file",
                        ));
                    }
                    if let Some(expected) = expected_sha256 {
                        if path.is_file() {
                            let bytes = std::fs::read(&path).map_err(|_| {
                                ToolError::new(ToolErrorCode::ToolIoFailed, "read failed")
                            })?;
                            if Sha256Digest::digest_bytes(&bytes).as_str() != expected {
                                return Err(ToolError::new(
                                    ToolErrorCode::ToolValidationFailed,
                                    "file changed",
                                ));
                            }
                        }
                    }
                }
                super::intent::PlannedChange::Edit {
                    requested_path,
                    old_text,
                    new_text,
                    expected_sha256,
                } => {
                    let path = intent
                        .path_accesses
                        .iter()
                        .find(|access| access.requested == *requested_path)
                        .map(|access| access.normalized_absolute.clone())
                        .ok_or_else(|| {
                            ToolError::new(ToolErrorCode::ToolInternal, "edit path missing")
                        })?;
                    if !path.is_file() {
                        return Err(ToolError::new(
                            ToolErrorCode::ToolPathNotFound,
                            "path was not found",
                        ));
                    }
                    if !reads.contains(&path) {
                        return Err(ToolError::new(
                            ToolErrorCode::ToolPathUnread,
                            "read the file before editing it",
                        ));
                    }
                    let bytes = std::fs::read(&path)
                        .map_err(|_| ToolError::new(ToolErrorCode::ToolIoFailed, "read failed"))?;
                    if let Some(expected) = expected_sha256 {
                        if Sha256Digest::digest_bytes(&bytes).as_str() != expected {
                            return Err(ToolError::new(
                                ToolErrorCode::ToolValidationFailed,
                                "file changed",
                            ));
                        }
                    }
                    let text = std::str::from_utf8(&bytes).map_err(|_| {
                        ToolError::new(ToolErrorCode::ToolUnsupported, "unsupported encoding")
                    })?;
                    if tool_name != "batch_edit" {
                        let _ = super::builtin::apply_edit(text, old_text, new_text)?;
                    }
                }
            }
        }
        drop(reads);
        if tool_name == "batch_edit" {
            simulate_batch_edits(intent)?;
        }
        Ok(())
    }

    async fn drive_ready(
        &self,
        request: &ToolBatchRequest,
        durable: &mut DurableSession<'_>,
        ready: Vec<(u32, Admitted)>,
        cancel: &CancellationToken,
    ) -> Result<
        (
            Vec<(u32, EventId, ToolExecutionId)>,
            Vec<(u32, FinishedCall)>,
            Vec<(u32, ProviderToolCall, FinishedCall, ToolExecutionId)>,
        ),
        ToolError,
    > {
        let mut waiting = FuturesUnordered::new();
        for (call_index, item) in ready {
            let cancel = cancel.clone();
            let parallel = Arc::clone(&self.parallel);
            waiting.push(async move {
                let entered = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => None,
                    permit = parallel.acquire_owned() => permit.ok(),
                };
                (call_index, item, entered)
            });
        }
        let mut bodies: FuturesUnordered<ReadyBody<'_>> = FuturesUnordered::new();
        let mut started = Vec::new();
        let mut finished = Vec::new();
        let mut not_started = Vec::new();
        loop {
            let waiting_open = !waiting.is_empty();
            let bodies_open = !bodies.is_empty();
            if !waiting_open && !bodies_open {
                break;
            }
            tokio::select! {
                biased;
                next = waiting.next(), if waiting_open => {
                    let Some((call_index, item, entered)) = next else { break };
                    match entered {
                        Some(permit) => {
                            let event_id = self.record_start(durable, request, call_index, &item)?;
                            let execution_id = item.execution_id;
                            #[cfg(feature = "failpoints")]
                            crate::crash_point::hit(format!(
                                "runtime.after_tool_execution_started:{}",
                                call_index
                            ));
                            started.push((call_index, event_id, execution_id));
                            let cancel = cancel.clone();
                            bodies.push(Box::pin(async move {
                                let finished = self.run_admitted(item, &cancel, Some(permit)).await?;
                                Ok((call_index, finished))
                            }));
                        }
                        None => {
                            let call = item.call.clone();
                            let execution_id = item.execution_id;
                            drop(item);
                            self.trace.push("write_lock_release");
                            let finished = self.finish_error(
                                &call,
                                ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"),
                                false,
                            )?;
                            not_started.push((call_index, call, finished, execution_id));
                        }
                    }
                }
                next = bodies.next(), if bodies_open => {
                    let Some(body) = next else { break };
                    finished.push(body?);
                }
            }
        }
        Ok((started, finished, not_started))
    }

    fn record_start(
        &self,
        durable: &mut DurableSession<'_>,
        request: &ToolBatchRequest,
        call_index: u32,
        item: &Admitted,
    ) -> Result<EventId, ToolError> {
        let redacted_arguments = hooks::redact::redact_value(&item.call.arguments)
            .map_err(|_| ToolError::new(ToolErrorCode::ToolInternal, "arguments hash failed"))?;
        let arguments_hash = calculate_tool_arguments_hash(&redacted_arguments)
            .map_err(|_| ToolError::new(ToolErrorCode::ToolInternal, "arguments hash failed"))?;
        self.append_durable(
            durable,
            Some(request.turn_id),
            Some(request.attempt_id),
            CanonicalEvent::ToolExecutionStarted(ToolExecutionStarted {
                batch_id: request.batch_id,
                execution_id: item.execution_id,
                step_id: durable.step_id,
                call_id: item.call.tool_call_id.clone(),
                call_index,
                tool_name: item.call.tool_name.as_str().to_owned(),
                arguments_hash,
                mutability: mutability_of(&item.prepared.intent),
            }),
        )
    }

    async fn run_admitted(
        &self,
        admitted: Admitted,
        cancel: &CancellationToken,
        held: Option<OwnedSemaphorePermit>,
    ) -> Result<FinishedCall, ToolError> {
        let Admitted {
            call,
            tool,
            prepared,
            capabilities,
            lease,
            execution_id,
            batch_id,
        } = admitted;
        let started = std::time::Instant::now();
        self.trace.push("execute");
        let call_cancel = cancel.child_token();
        let timeout = resolved_timeout(&prepared.intent, capabilities, &self.tools);
        let deadline = if capabilities.contains(ToolCapabilities::SPAWN_PROCESS) {
            timeout.saturating_add(Duration::from_millis(1500))
        } else {
            timeout
        };
        let cwd = self.workspace();
        let workspace_roots = hooks::validate::workspace_roots(&cwd, &self.tools.allowed_paths);
        let exec_ctx = ToolExecutionContext {
            cwd: cwd.clone(),
            workspace_roots,
            process_slots: Some(Arc::clone(&self.spawn)),
            session_dir: self.session_dir(),
            session_id: self.session_id(),
            batch_id,
            call_id: call.tool_call_id.clone(),
            execution_id,
            timeout,
            normalized_paths: prepared
                .intent
                .path_accesses
                .iter()
                .map(|access| (access.requested.clone(), access.normalized_absolute.clone()))
                .collect(),
        };
        let permit = if let Some(permit) = held {
            permit
        } else {
            let permit = tokio::select! {
                permit = Arc::clone(&self.parallel).acquire_owned() => permit,
                _ = call_cancel.cancelled() => {
                    drop(lease);
                    self.trace.push("write_lock_release");
                    return self.finish_error(&call, ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"), false);
                }
            };
            match permit {
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
            _ = tokio::time::sleep(deadline) => Poll::Stop { cancelled: false },
        };
        let mut lease = Some(lease);
        let output = match polled {
            Poll::Done(value) => value,
            Poll::Stop { cancelled } => {
                if !cancelled {
                    call_cancel.cancel();
                }
                self.reap(
                    handle,
                    side_effect,
                    cancelled,
                    cancel,
                    lease.take().expect("path lease"),
                )
                .await
            }
        };
        #[cfg(feature = "failpoints")]
        crate::crash_point::hit(format!(
            "runtime.after_tool_body_before_redaction:{}",
            execution_id
        ));
        drop(permit);
        let duration_ms = started.elapsed().as_millis() as u64;
        if let Err(error) = &output {
            if error.code() == ToolErrorCode::ToolInternal
                && error.message() == "side effect uncertain"
            {
                return self.finish_uncertain(&call, execution_id);
            }
            hooks::circuit::record_error(
                call.tool_name.as_str(),
                &intent,
                capabilities,
                error.code(),
                &self.circuit_counts,
            );
        }
        if output.is_ok() && call.tool_name.as_str() == "read_file" {
            for access in &intent.path_accesses {
                self.note_read(access.normalized_absolute.clone());
            }
        }
        let finished = self.finish_output(&call, output, duration_ms, lease, execution_id)?;
        Ok(finished)
    }

    async fn reap(
        &self,
        mut handle: JoinHandle<std::thread::Result<Result<serde_json::Value, ToolError>>>,
        side_effect: bool,
        cancelled: bool,
        batch: &CancellationToken,
        lease: PathLease,
    ) -> Result<serde_json::Value, ToolError> {
        match tokio::time::timeout(Duration::from_millis(1000), &mut handle).await {
            Ok(joined) => {
                drop(lease);
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
                    .push(RetainedExecution {
                        task: handle,
                        lease,
                        runtime: tokio::runtime::Handle::current(),
                    });
                Err(ToolError::new(
                    ToolErrorCode::ToolInternal,
                    "side effect uncertain",
                ))
            }
            Err(_) => {
                handle.abort();
                drop(lease);
                Err(ToolError::new(ToolErrorCode::ToolTimedOut, "timed out"))
            }
        }
    }

    fn finish_output(
        &self,
        call: &ProviderToolCall,
        output: Result<serde_json::Value, ToolError>,
        duration_ms: u64,
        lease: Option<PathLease>,
        execution_id: ToolExecutionId,
    ) -> Result<FinishedCall, ToolError> {
        self.trace.push("lsp");
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(hooks::lsp::noop));
        self.trace.push("verify");
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(hooks::verify::noop));
        self.trace.push("enrich");
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(hooks::enrich::noop));
        self.trace.push("redact");
        let force_binary = matches!(&output, Err(error) if error.is_binary());
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
        #[cfg(feature = "failpoints")]
        crate::crash_point::hit(format!(
            "runtime.after_redaction_before_artifact:{}",
            execution_id
        ));
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
            execution_id: Some(execution_id),
            force_binary,
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

    fn finish_uncertain(
        &self,
        call: &ProviderToolCall,
        execution_id: ToolExecutionId,
    ) -> Result<FinishedCall, ToolError> {
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
            execution_id: Some(execution_id),
            force_binary: false,
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
            execution_id: None,
            force_binary: false,
        })
    }
}

impl Drop for ToolRuntime {
    fn drop(&mut self) {
        let retained =
            std::mem::take(&mut *self.retained.lock().unwrap_or_else(|err| err.into_inner()));
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            for item in retained {
                item.task.abort();
                runtime.spawn(async move {
                    let _lease = item.lease;
                    let _ = item.task.await;
                });
            }
        } else {
            for item in retained {
                item.task.abort();
                let runtime = item.runtime.clone();
                runtime.block_on(async move {
                    let _lease = item.lease;
                    let _ = item.task.await;
                });
            }
        }
    }
}

type ToolTask = JoinHandle<std::thread::Result<Result<serde_json::Value, ToolError>>>;
type ReadyBody<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<(u32, FinishedCall), ToolError>> + Send + 'a>,
>;

struct RetainedExecution {
    task: ToolTask,
    lease: PathLease,
    runtime: tokio::runtime::Handle,
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

fn fresh_id<T: crate::id::ProtocolUlidId>(ids: &MonotonicUlidGenerator) -> Result<T, ToolError> {
    ids.next_id()
        .map_err(|_| ToolError::new(ToolErrorCode::ToolInternal, "id generation failed"))
}

fn mutability_of(intent: &ToolIntent) -> ToolMutability {
    match intent.mutation {
        super::intent::ToolMutation::ReadOnly | super::intent::ToolMutation::PureCompute => {
            ToolMutability::ReadOnly
        }
        super::intent::ToolMutation::External => ToolMutability::Outward,
        _ => ToolMutability::Mutating,
    }
}

fn placeholder_session() -> SessionId {
    SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").expect("session id")
}

fn simulate_batch_edits(intent: &ToolIntent) -> Result<(), ToolError> {
    let mut images: Vec<(PathBuf, String)> = Vec::new();
    for change in &intent.planned {
        let super::intent::PlannedChange::Edit {
            requested_path,
            old_text,
            new_text,
            ..
        } = change
        else {
            continue;
        };
        let path = intent
            .path_accesses
            .iter()
            .find(|access| access.requested == *requested_path)
            .map(|access| access.normalized_absolute.clone())
            .ok_or_else(|| ToolError::new(ToolErrorCode::ToolInternal, "edit path missing"))?;
        if let Some(existing) = images.iter_mut().find(|item| item.0 == path) {
            existing.1 = super::builtin::apply_edit(&existing.1, old_text, new_text)?;
        } else {
            let bytes = std::fs::read(&path)
                .map_err(|_| ToolError::new(ToolErrorCode::ToolIoFailed, "read failed"))?;
            let text = std::str::from_utf8(&bytes).map_err(|_| {
                ToolError::new(ToolErrorCode::ToolUnsupported, "unsupported encoding")
            })?;
            let next = super::builtin::apply_edit(text, old_text, new_text)?;
            images.push((path, next));
        }
    }
    Ok(())
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
            details: error.details().cloned(),
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
            truncated: error.code() == ToolErrorCode::ToolProcessOutputLimit,
        },
    }
}

fn uncertain_ids(results: &[FinishedCall]) -> Vec<ToolExecutionId> {
    results
        .iter()
        .filter(|finished| finished.status == ToolResultStatus::Uncertain)
        .filter_map(|finished| finished.execution_id)
        .collect()
}
