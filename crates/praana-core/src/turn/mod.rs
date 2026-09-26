//! Provider-independent headless turn loop.
//!
//! Admission goes through the existing provider admit function. Tool execution
//! goes through the P3A runtime and P3B artifact publisher. This module does
//! not speak a provider wire protocol.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::clock::Clock;
use crate::config::EffectiveConfigV1;
use crate::history::artifact::{policy_from_session, ArtifactStore};
use crate::history::event_log::{write_config_snapshot_durable, EventLogStore};
use crate::history::recovery::SessionRecoveryEngine;
use crate::history::replay::{accepted_messages, EventReplayer};
use crate::id::{IdGenerator, MonotonicUlidGenerator};
use crate::protocol::constants::*;
use crate::protocol::errors::{ErrorClass, ProtocolError};
use crate::protocol::events::*;
use crate::protocol::hashes::calculate_accepted_messages_hash;
use crate::protocol::id::*;
use crate::protocol::json::serialize_canonical_string;
use crate::protocol::messages::{
    validate_tool_name, AssistantBlock, AssistantMessage, FinishReason, TextBlock, ToolCall,
    UserBlock, UserMessage,
};
use crate::protocol::models::{
    AdmissionSnapshot, HistoryMode, ModelSelection, ProviderUsage, ReasoningEffort,
};
use crate::protocol::recovery::RecoveryNotice;
use crate::provider::openai::{admit, AdmissionDecision, AdmissionRequest};
use crate::redaction::redact_json_v1;
use crate::token::profile::TokenProfileStoreV1;
use crate::token::FramingProfileV1;
use crate::tools::builtin::phase3_tools;
use crate::tools::{
    BatchOrigin, DurableBatchOutcome, DurableSession, ErasedTool, ProviderToolCall,
    ToolBatchRequest, ToolCallOrigin, ToolName, ToolRegistry, ToolRuntime,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopFault {
    None,
    AfterToolBodyBeforeFinish,
}

#[derive(Clone)]
pub struct LoopConfig {
    pub session_dir: PathBuf,
    pub workspace: PathBuf,
    pub config: EffectiveConfigV1,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<MonotonicUlidGenerator>,
    pub fault: LoopFault,
    #[cfg(test)]
    pub extra_tools: Vec<Arc<dyn ErasedTool>>,
}

#[derive(Debug)]
pub enum TurnError {
    InjectedCrash,
    Failed(String),
}

impl TurnError {
    fn failed(message: impl Into<String>) -> Self {
        Self::Failed(message.into())
    }
}

impl std::fmt::Display for TurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InjectedCrash => write!(f, "injected crash"),
            Self::Failed(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for TurnError {}

#[derive(Clone, Debug)]
pub struct TurnReport {
    pub interruption: Option<InterruptionReason>,
    pub admission_count: u32,
}

#[derive(Clone, Debug)]
pub struct PreparedRequest {
    pub request_body: Value,
    /// Ignored by admission. Component bytes are derived from `request_body`.
    pub component_bytes: [Vec<u8>; 9],
}

/// The only wire body an adapter may transmit for this attempt.
pub struct AdmittedRequest {
    body: Value,
    request_hash: Sha256Digest,
}

impl AdmittedRequest {
    pub fn body(&self) -> &Value {
        &self.body
    }

    pub fn authorize_send(&self, sent: &Value) -> Result<SendAuthorization, TurnError> {
        if sent != &self.body {
            return Err(TurnError::failed(
                "provider send was not the admitted request",
            ));
        }
        let sent_hash = crate::protocol::hashes::calculate_request_hash(sent)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        if sent_hash != self.request_hash {
            return Err(TurnError::failed(
                "provider send was not the admitted request",
            ));
        }
        Ok(SendAuthorization { _private: () })
    }
}

/// Proof that the adapter transmitted `AdmittedRequest::body`.
pub struct SendAuthorization {
    _private: (),
}

pub struct ProviderOutput {
    pub draft: AssistantDraft,
    pub authorization: SendAuthorization,
}

#[derive(Clone, Debug)]
pub struct DraftCall {
    pub call_id: String,
    pub name: String,
    pub arguments: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug)]
pub struct AssistantDraft {
    pub text: Option<String>,
    pub calls: Vec<DraftCall>,
    pub finish_reason: FinishReason,
    pub usage: ProviderUsage,
}

#[derive(Clone, Debug)]
pub struct ScriptedStep {
    pub text: Option<String>,
    pub calls: Vec<DraftCall>,
    pub finish: FinishReason,
    pub usage: ProviderUsage,
}

#[async_trait]
pub trait StepProvider: Send + Sync {
    fn prepare(&self, step_index: u32) -> Result<PreparedRequest, TurnError>;
    async fn complete(
        &self,
        step_index: u32,
        admitted: &AdmittedRequest,
        cancel: &CancellationToken,
    ) -> Result<ProviderOutput, TurnError>;
}

struct OpenTurn {
    id: TurnId,
    step_index: u32,
    max_steps: u32,
    last_finish: Option<FinishReason>,
    tool_batch_open: bool,
}

enum Control {
    Continue,
    Done(TurnReport),
}

pub struct HeadlessLoop {
    config: LoopConfig,
    log: EventLogStore,
    artifacts: ArtifactStore,
    runtime: ToolRuntime,
    session_id: SessionId,
    model: ModelSelection,
    toolset_hash: Sha256Digest,
    framing: FramingProfileV1,
    admissions: u32,
    cancel: CancellationToken,
    pending_notices: Vec<RecoveryNotice>,
}

impl HeadlessLoop {
    pub fn create(config: LoopConfig) -> Result<Self, TurnError> {
        std::fs::create_dir_all(&config.session_dir)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        std::fs::create_dir_all(&config.workspace)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        write_config_snapshot_durable(&config.session_dir, &config.config)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let session_id: SessionId = config
            .ids
            .next_id()
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let log = EventLogStore::create_or_open(&config.session_dir, &session_id.to_string())
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let mut loop_ = Self::assemble(config, log, session_id, Vec::new())?;
        if loop_.log.current_sequence() == 0 {
            loop_.append_session_started()?;
        }
        Ok(loop_)
    }

    pub fn resume(config: LoopConfig) -> Result<Self, TurnError> {
        let session_id = read_session_id(&config.session_dir)?;
        let notices = {
            let mut engine = SessionRecoveryEngine::new(&config.session_dir, &session_id)
                .map_err(|err| TurnError::failed(err.to_string()))?;
            engine
                .run_recovery()
                .map_err(|err| TurnError::failed(err.to_string()))?;
            engine.take_pending_notices()
        };
        let parsed = SessionId::from_str_canonical(&session_id)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let log = EventLogStore::create_or_open(&config.session_dir, &session_id)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        Self::assemble(config, log, parsed, notices)
    }

    pub fn session_dir(&self) -> &Path {
        self.log.session_dir()
    }

    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub fn held_locks(&self) -> usize {
        self.runtime.locks().held_count()
    }

    pub fn event_kinds(&self) -> Result<Vec<String>, TurnError> {
        let events = self
            .log
            .events()
            .map_err(|err| TurnError::failed(err.to_string()))?;
        Ok(events
            .iter()
            .map(|event| event_kind(&event.event).to_owned())
            .collect())
    }

    pub async fn run_turn(
        &mut self,
        text: &str,
        provider: &dyn StepProvider,
    ) -> Result<TurnReport, TurnError> {
        self.ensure_live()?;
        self.begin_turn(text)?;
        self.drive(provider).await
    }

    pub async fn continue_turn(
        &mut self,
        provider: &dyn StepProvider,
    ) -> Result<TurnReport, TurnError> {
        self.ensure_live()?;
        if self.replay()?.active_turn_id().is_none() {
            return Err(TurnError::failed("no active turn to continue"));
        }
        self.drive(provider).await
    }

    fn install_test_tools(tools: &mut Vec<std::sync::Arc<dyn ErasedTool>>, config: &LoopConfig) {
        #[cfg(test)]
        tools.extend(config.extra_tools.iter().cloned());
        #[cfg(not(test))]
        let _ = (tools, config);
    }

    fn ensure_live(&self) -> Result<(), TurnError> {
        if self.runtime.is_poisoned() {
            return Err(TurnError::failed("session is poisoned"));
        }
        Ok(())
    }

    fn assemble(
        config: LoopConfig,
        log: EventLogStore,
        session_id: SessionId,
        pending_notices: Vec<RecoveryNotice>,
    ) -> Result<Self, TurnError> {
        let mut tools =
            phase3_tools(&config.config.tools).map_err(|err| TurnError::failed(err.to_string()))?;
        Self::install_test_tools(&mut tools, &config);
        let registry = ToolRegistry::try_from_erased(tools)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let framing = resolved_framing(&config.config);
        let toolset_hash = registry.catalog_hash().clone();
        let runtime = ToolRuntime::new(
            registry,
            config.config.tools.clone(),
            config.config.risk.clone(),
            config.config.circuit.clone(),
        );
        runtime.set_workspace(config.workspace.clone());
        runtime.set_session(config.session_dir.clone(), session_id);
        runtime.set_headless(true);
        let artifacts = ArtifactStore::open(
            &config.session_dir.join("history.db"),
            policy_from_session(&config.session_dir),
            Arc::clone(&config.clock),
        )
        .map_err(|err| TurnError::failed(err.to_string()))?;
        Ok(Self {
            model: model_selection(&config.config),
            config,
            log,
            artifacts,
            runtime,
            session_id,
            toolset_hash,
            framing,
            admissions: 0,
            cancel: CancellationToken::new(),
            pending_notices,
        })
    }

    fn append_session_started(&mut self) -> Result<(), TurnError> {
        let cwd = std::fs::canonicalize(&self.config.workspace)
            .unwrap_or_else(|_| self.config.workspace.clone());
        self.append(
            None,
            None,
            CanonicalEvent::SessionStarted(SessionStarted {
                cwd: cwd.to_string_lossy().into_owned(),
                agent: "praana".to_owned(),
                config_schema_version: self.config.config.config_schema_version,
                config_digest_sha256: self.config.config.config_digest_sha256(),
                history_mode: HistoryMode::Append,
                projection_version: ProjectionId::from_str_canonical(PROJECTION_VERSION)
                    .map_err(|err| TurnError::failed(err.to_string()))?,
                compaction_policy_version: COMPACTION_POLICY_VERSION.to_owned(),
                artifact_policy_version: ARTIFACT_POLICY_VERSION.to_owned(),
                token_estimator_schema_version: TOKEN_ESTIMATOR_SCHEMA_VERSION,
                unicode_utility_version: UNICODE_UTILITY_VERSION.to_owned(),
                system_context_schema_version: SYSTEM_CONTEXT_SCHEMA_VERSION,
                provider_registry_schema_version: PROVIDER_REGISTRY_SCHEMA_VERSION,
                builtin_tool_catalog_schema_version: BUILTIN_TOOL_CATALOG_SCHEMA_VERSION,
                redaction_version: REDACTION_VERSION.to_owned(),
                ui_contract_schema_version: UI_CONTRACT_SCHEMA_VERSION,
                initial_model: self.model.clone(),
                initial_toolset_hash: self.toolset_hash.clone(),
            }),
        )?;
        Ok(())
    }

    fn begin_turn(&mut self, text: &str) -> Result<(), TurnError> {
        if text.is_empty() {
            return Err(TurnError::failed("user message is empty"));
        }
        if self.replay()?.active_turn_id().is_some() {
            return Err(TurnError::failed("a turn is already active"));
        }
        let turn_id: TurnId = self.fresh()?;
        let message_id: MessageId = self.fresh()?;
        self.append(
            Some(turn_id),
            None,
            CanonicalEvent::UserMessageAccepted(UserMessageAccepted {
                message: UserMessage {
                    message_id,
                    turn_id,
                    blocks: vec![UserBlock::Text(TextBlock {
                        text: text.to_owned(),
                    })],
                },
            }),
        )?;
        let index = self
            .replay()?
            .turn_index(turn_id)
            .ok_or_else(|| TurnError::failed("user message did not open a turn"))?;
        self.append(
            Some(turn_id),
            None,
            CanonicalEvent::TurnStarted(TurnStarted {
                turn_index: index,
                user_message_id: message_id,
                model: self.model.clone(),
                toolset_hash: self.toolset_hash.clone(),
                max_steps: self.config.config.turn.max_steps,
            }),
        )?;
        Ok(())
    }

    async fn drive(&mut self, provider: &dyn StepProvider) -> Result<TurnReport, TurnError> {
        loop {
            if self.cancel.is_cancelled() {
                return self.interrupt(InterruptionReason::UserAbort, None);
            }
            let open = self.open_turn()?;
            if open.tool_batch_open {
                return Err(TurnError::failed("tool batch is incomplete"));
            }
            if matches!(
                open.last_finish,
                Some(FinishReason::Stop | FinishReason::Length)
            ) {
                return self.commit();
            }
            if open.step_index >= open.max_steps {
                return self.interrupt(InterruptionReason::StepLimit, None);
            }
            match self.run_step(provider, &open).await? {
                Control::Continue => {}
                Control::Done(report) => return Ok(report),
            }
        }
    }

    async fn run_step(
        &mut self,
        provider: &dyn StepProvider,
        open: &OpenTurn,
    ) -> Result<Control, TurnError> {
        let prepared = provider.prepare(open.step_index)?;
        if self.cancel.is_cancelled() {
            return Ok(Control::Done(
                self.interrupt(InterruptionReason::UserAbort, None)?,
            ));
        }
        let admitted = self.admit_request(&prepared)?;
        let Some(admitted) = admitted else {
            return Ok(Control::Done(
                self.interrupt(InterruptionReason::ActiveTurnTooLarge, None)?,
            ));
        };
        if self.cancel.is_cancelled() {
            return Ok(Control::Done(
                self.interrupt(InterruptionReason::UserAbort, None)?,
            ));
        }
        let step_id: StepId = self.fresh()?;
        let attempt_id: AttemptId = self.fresh()?;
        let purpose = AssistantStepPurpose {
            step_id,
            step_index: open.step_index,
        };
        let notices = std::mem::take(&mut self.pending_notices);
        let admitted_request = AdmittedRequest {
            body: admitted.request_body.clone(),
            request_hash: admitted.request_hash.clone(),
        };
        self.append(
            Some(open.id),
            Some(attempt_id),
            CanonicalEvent::AssistantAttemptStarted(AssistantAttemptStarted {
                purpose: ProviderAttemptPurpose::AssistantStep(purpose.clone()),
                attempt_number: 1,
                model: self.model.clone(),
                request_hash: admitted.request_hash,
                admission: admitted.snapshot,
                retry_of: None,
                emergency_context_retry: false,
                recovery_notices: notices,
            }),
        )?;
        #[cfg(feature = "failpoints")]
        crate::crash_point::hit(format!(
            "turn.after_assistant_attempt_started:{}",
            attempt_id
        ));
        let draft = match provider
            .complete(open.step_index, &admitted_request, &self.cancel)
            .await
        {
            Ok(output) => output.draft,
            Err(TurnError::InjectedCrash) => return Err(TurnError::InjectedCrash),
            Err(error) => {
                self.fail_attempt(open.id, attempt_id, purpose, &error.to_string(), false)?;
                return Ok(Control::Done(self.interrupt(
                    InterruptionReason::ProviderFailure,
                    Some(attempt_id),
                )?));
            }
        };
        if self.cancel.is_cancelled() {
            self.fail_attempt(open.id, attempt_id, purpose, "cancelled", true)?;
            return Ok(Control::Done(
                self.interrupt(InterruptionReason::UserAbort, Some(attempt_id))?,
            ));
        }
        let message = match assistant_message(
            &draft,
            self.config.ids.as_ref(),
            open.id,
            step_id,
            &self.model,
        ) {
            Ok(message) => message,
            Err(error) => {
                self.fail_attempt(open.id, attempt_id, purpose, &error.to_string(), false)?;
                return Ok(Control::Done(self.interrupt(
                    InterruptionReason::ProviderFailure,
                    Some(attempt_id),
                )?));
            }
        };
        self.append(
            Some(open.id),
            Some(attempt_id),
            CanonicalEvent::AssistantStepAccepted(AssistantStepAccepted {
                purpose,
                message: message.clone(),
            }),
        )?;
        #[cfg(feature = "failpoints")]
        crate::crash_point::hit(format!("turn.after_assistant_step_accepted:{}", step_id));
        if message.finish_reason != FinishReason::ToolUse {
            return Ok(Control::Continue);
        }
        self.run_tool_batch(open.id, attempt_id, step_id, &draft.calls)
            .await
    }

    fn admit_request(&mut self, prepared: &PreparedRequest) -> Result<Option<Admitted>, TurnError> {
        self.admissions = self.admissions.saturating_add(1);
        let llm = &self.config.config.llm;
        let history = &self.config.config.history;
        let decision = admit(&AdmissionRequest {
            profile: None,
            configured_context_window: llm.context_window,
            unsafe_increase: llm.unsafe_allow_context_window_increase,
            requested_max_output: llm.max_output_tokens,
            configured_min_output: llm.min_output_tokens,
            reasoning_reserve_tokens: llm.reasoning_reserve_tokens,
            safety_margin_min_tokens: history.safety_margin_min_tokens,
            safety_margin_ratio: history.safety_margin_ratio,
            calibration_margin: 0,
            component_bytes: crate::provider::openai::accounted_component_bytes(
                &prepared.request_body,
            )
            .map_err(TurnError::failed)?,
            framing: self.framing.clone(),
            image_count: 0,
            request_body: &prepared.request_body,
            estimate_reused_from: None,
        })
        .map_err(|err| TurnError::failed(err.to_string()))?;
        Ok(match decision {
            AdmissionDecision::Admit(estimate)
            | AdmissionDecision::ReduceOutput { estimate, .. } => Some(Admitted {
                request_hash: estimate.request_hash,
                snapshot: estimate.snapshot,
                request_body: prepared.request_body.clone(),
            }),
            AdmissionDecision::Reject { .. } => None,
        })
    }

    async fn run_tool_batch(
        &mut self,
        turn_id: TurnId,
        attempt_id: AttemptId,
        step_id: StepId,
        draft_calls: &[DraftCall],
    ) -> Result<Control, TurnError> {
        let mut calls = Vec::new();
        for call in draft_calls {
            let provider_ordinal = calls.len() as u32;
            calls.push(ProviderToolCall {
                tool_call_id: ToolCallId::from_str_canonical(&call.call_id)
                    .map_err(|err| TurnError::failed(err.to_string()))?,
                tool_name: ToolName::new(&call.name)
                    .map_err(|err| TurnError::failed(err.to_string()))?,
                arguments: Value::Object(call.arguments.clone()),
                provider_ordinal,
            });
        }
        let batch_id: ToolBatchId = self.fresh()?;
        let request = ToolBatchRequest {
            batch_id,
            session_id: self.session_id,
            turn_id,
            attempt_id,
            calls,
            origin: ToolCallOrigin::Model,
        };
        let fault_after_body = self.config.fault == LoopFault::AfterToolBodyBeforeFinish;
        let cancel = self.cancel.clone();
        let outcome = {
            let mut durable = DurableSession {
                log: &mut self.log,
                artifacts: &self.artifacts,
                ids: self.config.ids.as_ref(),
                clock: self.config.clock.as_ref(),
                session_id: self.session_id,
                step_id,
                fault_after_body,
            };
            self.runtime
                .execute_durable_batch(request, BatchOrigin::Model, cancel, &mut durable)
                .await
                .map_err(|err| TurnError::failed(err.to_string()))?
        };
        match outcome {
            DurableBatchOutcome::CrashedAfterBody => Err(TurnError::InjectedCrash),
            DurableBatchOutcome::Finished(finished) if finished.poisoned => {
                Ok(Control::Done(self.interrupt_with(
                    InterruptionReason::ToolRuntimePoisoned,
                    None,
                    &finished.uncertain_execution_ids,
                )?))
            }
            DurableBatchOutcome::Finished(_) => Ok(Control::Continue),
        }
    }

    fn fail_attempt(
        &mut self,
        turn_id: TurnId,
        attempt_id: AttemptId,
        purpose: AssistantStepPurpose,
        message: &str,
        cancelled: bool,
    ) -> Result<(), TurnError> {
        let message = redact_provider_message(message);
        self.append(
            Some(turn_id),
            Some(attempt_id),
            CanonicalEvent::AssistantAttemptFailed(AssistantAttemptFailed {
                purpose: ProviderAttemptPurpose::AssistantStep(purpose),
                error: ProtocolError::provider(
                    if cancelled {
                        "E_CANCELLED"
                    } else {
                        "E_PROVIDER_OUTPUT_INVALID"
                    },
                    if cancelled {
                        ErrorClass::Cancelled
                    } else {
                        ErrorClass::InvalidProviderOutput
                    },
                    message,
                    false,
                ),
                partial_output: PartialAssistantOutput {
                    blocks: Vec::new(),
                    provider_response_id: None,
                },
                observable_delta_emitted: false,
                provider_may_have_completed: !cancelled,
                usage: ProviderUsage::default(),
            }),
        )?;
        Ok(())
    }

    fn commit(&mut self) -> Result<TurnReport, TurnError> {
        let replay = self.replay()?;
        let turn_id = replay
            .active_turn_id()
            .ok_or_else(|| TurnError::failed("no active turn"))?;
        let index = replay
            .turn_index(turn_id)
            .ok_or_else(|| TurnError::failed("turn index missing"))?;
        let turn = replay
            .turns
            .get(&index)
            .ok_or_else(|| TurnError::failed("turn missing"))?;
        let messages = accepted_messages(turn, true, None, None)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let accepted_messages_hash = calculate_accepted_messages_hash(&messages)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let terminal = turn
            .steps
            .values()
            .next_back()
            .ok_or_else(|| TurnError::failed("turn has no accepted step"))?;
        let outcome = match terminal.message.finish_reason {
            FinishReason::Length => TurnOutcome::Length,
            _ => TurnOutcome::Stop,
        };
        let usage = sum_usage(&replay, turn_id);
        let notices = presented_notices(
            self.log
                .events()
                .map_err(|err| TurnError::failed(err.to_string()))?
                .as_slice(),
            turn_id,
        );
        self.append(
            Some(turn_id),
            None,
            CanonicalEvent::TurnCommitted(TurnCommitted {
                turn_index: turn
                    .started
                    .as_ref()
                    .map(|started| started.turn_index)
                    .unwrap_or(index),
                user_message_id: turn.user.message_id,
                terminal_step_id: terminal.purpose.step_id,
                accepted_step_ids: turn
                    .steps
                    .values()
                    .map(|step| step.purpose.step_id)
                    .collect(),
                completed_batch_ids: turn
                    .steps
                    .values()
                    .filter_map(|step| {
                        turn.batches
                            .get(&step.purpose.step_id)
                            .and_then(|batch| batch.completed.as_ref())
                            .map(|batch| batch.batch_id)
                    })
                    .collect(),
                outcome,
                accepted_messages_hash,
                usage,
                recovery_notice_ids_presented: notices,
            }),
        )?;
        #[cfg(feature = "failpoints")]
        crate::crash_point::hit(format!("turn.after_turn_committed:{}", turn_id));
        Ok(self.report(None))
    }

    fn interrupt(
        &mut self,
        reason: InterruptionReason,
        failed_attempt_id: Option<AttemptId>,
    ) -> Result<TurnReport, TurnError> {
        self.interrupt_with(reason, failed_attempt_id, &[])
    }

    fn interrupt_with(
        &mut self,
        reason: InterruptionReason,
        failed_attempt_id: Option<AttemptId>,
        uncertain: &[ToolExecutionId],
    ) -> Result<TurnReport, TurnError> {
        let replay = self.replay()?;
        let turn_id = replay
            .active_turn_id()
            .ok_or_else(|| TurnError::failed("no active turn"))?;
        let index = replay
            .turn_index(turn_id)
            .ok_or_else(|| TurnError::failed("turn index missing"))?;
        let turn = replay
            .turns
            .get(&index)
            .ok_or_else(|| TurnError::failed("turn missing"))?;
        let last_accepted_step_id = turn
            .steps
            .values()
            .next_back()
            .map(|step| step.purpose.step_id);
        self.append(
            Some(turn_id),
            None,
            CanonicalEvent::TurnInterrupted(TurnInterrupted {
                turn_index: turn
                    .started
                    .as_ref()
                    .map(|started| started.turn_index)
                    .unwrap_or(index),
                user_message_id: turn.user.message_id,
                reason: reason.clone(),
                last_accepted_step_id,
                failed_attempt_id,
                uncertain_execution_ids: uncertain.to_vec(),
                message: interruption_message(&reason).to_owned(),
            }),
        )?;
        Ok(self.report(Some(reason)))
    }

    fn report(&self, interruption: Option<InterruptionReason>) -> TurnReport {
        TurnReport {
            interruption,
            admission_count: self.admissions,
        }
    }

    fn open_turn(&self) -> Result<OpenTurn, TurnError> {
        let replay = self.replay()?;
        let id = replay
            .active_turn_id()
            .ok_or_else(|| TurnError::failed("no active turn"))?;
        let index = replay
            .turn_index(id)
            .ok_or_else(|| TurnError::failed("turn index missing"))?;
        let turn = replay
            .turns
            .get(&index)
            .ok_or_else(|| TurnError::failed("turn missing"))?;
        let started = turn
            .started
            .as_ref()
            .ok_or_else(|| TurnError::failed("turn has not started"))?;
        let last = turn.steps.values().next_back();
        Ok(OpenTurn {
            id,
            step_index: turn.steps.len() as u32,
            max_steps: started.max_steps,
            last_finish: last.map(|step| step.message.finish_reason.clone()),
            tool_batch_open: turn.batches.values().any(|batch| batch.completed.is_none()),
        })
    }

    fn replay(&self) -> Result<EventReplayer, TurnError> {
        let events = self
            .log
            .events()
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let raw = self.log.raw_lines();
        let mut replay = EventReplayer::new();
        for (index, event) in events.iter().enumerate() {
            replay
                .process_event(event, Some(index + 1), Some(raw))
                .map_err(|err| TurnError::failed(format!("replay: {err}")))?;
        }
        Ok(replay)
    }

    fn append(
        &mut self,
        turn_id: Option<TurnId>,
        attempt_id: Option<AttemptId>,
        event: CanonicalEvent,
    ) -> Result<EventId, TurnError> {
        let event_id = self.fresh()?;
        let envelope = EventEnvelope {
            schema_version: EVENT_SCHEMA_VERSION,
            event_id,
            session_id: self.session_id,
            sequence: self.log.current_sequence() + 1,
            timestamp_ms: self.config.clock.now_ms(),
            turn_id,
            attempt_id,
            event,
        };
        self.log
            .append_event(&envelope)
            .map_err(|err| TurnError::failed(format!("append: {err}")))?;
        Ok(event_id)
    }

    fn fresh<T: crate::id::ProtocolUlidId>(&self) -> Result<T, TurnError> {
        self.config
            .ids
            .next_id()
            .map_err(|err| TurnError::failed(err.to_string()))
    }
}

struct Admitted {
    request_hash: Sha256Digest,
    snapshot: AdmissionSnapshot,
    request_body: Value,
}

fn redact_provider_message(message: &str) -> String {
    let redacted = crate::redaction::redact_text_v1(message)
        .map(|out| out.text)
        .unwrap_or_else(|_| "redaction failed".to_owned());
    let mut out = String::new();
    for ch in redacted.chars() {
        if out.len() + ch.len_utf8() > 512 {
            break;
        }
        if ch == '\0' {
            continue;
        }
        out.push(ch);
    }
    out
}

fn assistant_message(
    draft: &AssistantDraft,
    ids: &MonotonicUlidGenerator,
    turn_id: TurnId,
    step_id: StepId,
    model: &ModelSelection,
) -> Result<AssistantMessage, TurnError> {
    let mut blocks = Vec::new();
    if let Some(text) = &draft.text {
        if text.is_empty() {
            return Err(TurnError::failed("assistant text is empty"));
        }
        blocks.push(AssistantBlock::Text(TextBlock { text: text.clone() }));
    }
    for call in &draft.calls {
        validate_tool_name(&call.name).map_err(|err| TurnError::failed(err.to_string()))?;
        let redacted = redact_json_v1(&Value::Object(call.arguments.clone()))
            .map_err(|_| TurnError::failed("tool call redaction failed"))?;
        let Value::Object(arguments) = redacted.value else {
            return Err(TurnError::failed("tool call redaction failed"));
        };
        let raw_arguments = serialize_canonical_string(&Value::Object(arguments.clone()))
            .map_err(|err| TurnError::failed(err.to_string()))?;
        blocks.push(AssistantBlock::ToolCall(ToolCall {
            call_id: ToolCallId::from_str_canonical(&call.call_id)
                .map_err(|err| TurnError::failed(err.to_string()))?,
            name: call.name.clone(),
            arguments,
            raw_arguments,
        }));
    }
    if blocks.is_empty() {
        return Err(TurnError::failed("assistant step has no blocks"));
    }
    match draft.finish_reason {
        FinishReason::ToolUse if draft.calls.is_empty() => {
            return Err(TurnError::failed("tool use step has no calls"));
        }
        FinishReason::Stop | FinishReason::Length if !draft.calls.is_empty() => {
            return Err(TurnError::failed("terminal step still requests tools"));
        }
        _ => {}
    }
    Ok(AssistantMessage {
        message_id: ids
            .next_id()
            .map_err(|err| TurnError::failed(err.to_string()))?,
        turn_id,
        step_id,
        provider: model.provider.clone(),
        model: model.model.clone(),
        phase: None,
        blocks,
        finish_reason: draft.finish_reason.clone(),
        continuation: None,
        usage: draft.usage.clone(),
    })
}

fn resolved_framing(config: &EffectiveConfigV1) -> FramingProfileV1 {
    if let Ok(store) = TokenProfileStoreV1::load_bundled() {
        if let Ok(entry) = store.resolve(
            config.llm.provider.as_str(),
            config.llm.protocol.as_str(),
            config.llm.model.as_str(),
            None,
        ) {
            return entry.framing_profile.clone();
        }
        if let Ok(entry) = store.resolve_conservative_generic() {
            return entry.framing_profile.clone();
        }
    }
    FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "adapter-estimate:generic:default:v1".to_owned(),
        fixed_tokens: 4,
        per_item_tokens: 3,
        item_count: 0,
        additional_tokens: 0,
    }
}

fn model_selection(config: &EffectiveConfigV1) -> ModelSelection {
    let fingerprint = Sha256Digest::digest_bytes(
        format!("{}|{}", config.llm.protocol, config.llm.model).as_bytes(),
    );
    ModelSelection {
        provider: config.llm.provider.clone(),
        protocol: config.llm.protocol.clone(),
        model: config.llm.model.clone(),
        model_revision: None,
        model_family: config.llm.protocol.clone(),
        endpoint_fingerprint: fingerprint,
        reasoning_effort: match config.llm.reasoning_effort.as_str() {
            "off" => ReasoningEffort::Off,
            "minimal" => ReasoningEffort::Minimal,
            "low" => ReasoningEffort::Low,
            "high" => ReasoningEffort::High,
            "xhigh" => ReasoningEffort::Xhigh,
            _ => ReasoningEffort::Medium,
        },
    }
}

fn sum_usage(replay: &EventReplayer, turn_id: TurnId) -> ProviderUsage {
    let mut total = ProviderUsage::default();
    for attempt in replay.attempts.values() {
        if attempt.turn_id != Some(turn_id) {
            continue;
        }
        total.input_tokens = total
            .input_tokens
            .saturating_add(attempt.usage.input_tokens);
        total.output_tokens = total
            .output_tokens
            .saturating_add(attempt.usage.output_tokens);
        total.reasoning_tokens = total
            .reasoning_tokens
            .saturating_add(attempt.usage.reasoning_tokens);
        total.total_tokens = total
            .total_tokens
            .saturating_add(attempt.usage.total_tokens);
        total.cache_read_tokens = total
            .cache_read_tokens
            .saturating_add(attempt.usage.cache_read_tokens);
        total.cache_write_tokens = total
            .cache_write_tokens
            .saturating_add(attempt.usage.cache_write_tokens);
    }
    total
}

fn presented_notices(events: &[EventEnvelope], turn_id: TurnId) -> Vec<RecoveryNoticeId> {
    let mut ids = Vec::new();
    for event in events {
        if event.turn_id != Some(turn_id) {
            continue;
        }
        let CanonicalEvent::AssistantAttemptStarted(started) = &event.event else {
            continue;
        };
        for notice in &started.recovery_notices {
            if !ids.contains(&notice.notice_id) {
                ids.push(notice.notice_id);
            }
        }
    }
    ids
}

fn interruption_message(reason: &InterruptionReason) -> &'static str {
    match reason {
        InterruptionReason::UserAbort => "Turn aborted by user before commit.",
        InterruptionReason::ProviderFailure => {
            "Turn stopped because no further provider attempt could produce accepted output."
        }
        InterruptionReason::StepLimit => {
            "Turn stopped after reaching the configured assistant step limit."
        }
        InterruptionReason::ActiveTurnTooLarge => {
            "Turn stopped because the active turn could not fit the provider context window."
        }
        InterruptionReason::IncompatibleContinuation => {
            "Turn stopped because provider-native continuation was incompatible with the available model."
        }
        InterruptionReason::ToolRuntimePoisoned => {
            "Turn stopped because an uncooperative tool left execution outcome uncertain and the runtime was poisoned."
        }
        InterruptionReason::SessionShutdown => {
            "Turn stopped because the session was shut down before commit."
        }
    }
}

fn event_kind(event: &CanonicalEvent) -> &'static str {
    match event {
        CanonicalEvent::SessionStarted(_) => "session_started",
        CanonicalEvent::UserMessageAccepted(_) => "user_message_accepted",
        CanonicalEvent::TurnStarted(_) => "turn_started",
        CanonicalEvent::AssistantAttemptStarted(_) => "assistant_attempt_started",
        CanonicalEvent::AssistantAttemptFailed(_) => "assistant_attempt_failed",
        CanonicalEvent::AssistantStepAccepted(_) => "assistant_step_accepted",
        CanonicalEvent::AttemptSuperseded(_) => "attempt_superseded",
        CanonicalEvent::ToolExecutionStarted(_) => "tool_execution_started",
        CanonicalEvent::ToolExecutionFinished(_) => "tool_execution_finished",
        CanonicalEvent::ToolBatchCompleted(_) => "tool_batch_completed",
        CanonicalEvent::TurnCommitted(_) => "turn_committed",
        CanonicalEvent::TurnInterrupted(_) => "turn_interrupted",
        CanonicalEvent::StateChanged(_) => "state_changed",
        CanonicalEvent::HistoryCompacted(_) => "history_compacted",
        CanonicalEvent::ModelChanged(_) => "model_changed",
        CanonicalEvent::ResetBoundary(_) => "reset_boundary",
        CanonicalEvent::SystemNote(_) => "system_note",
    }
}

fn read_session_id(dir: &Path) -> Result<String, TurnError> {
    let text = std::fs::read_to_string(dir.join("meta.json"))
        .map_err(|err| TurnError::failed(err.to_string()))?;
    let value: Value = serde_json::from_str(text.trim_end_matches('\n'))
        .map_err(|err| TurnError::failed(err.to_string()))?;
    value
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| TurnError::failed("session id missing"))
}

impl From<crate::tools::ToolError> for TurnError {
    fn from(error: crate::tools::ToolError) -> Self {
        Self::failed(error.to_string())
    }
}

#[cfg(test)]
mod poison_tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use serde_json::{json, Value};
    use tokio_util::sync::CancellationToken;

    use super::{
        AdmittedRequest, AssistantDraft, DraftCall, HeadlessLoop, LoopConfig, LoopFault,
        PreparedRequest, ProviderOutput, ScriptedStep, StepProvider, TurnError,
    };
    use crate::clock::Clock;
    use crate::config::build_defaults;
    use crate::id::{IdGenerationError, MonotonicUlidGenerator, RandomSource};
    use crate::protocol::events::InterruptionReason;
    use crate::protocol::messages::FinishReason;
    use crate::protocol::models::ProviderUsage;
    use crate::tools::{
        PathAccessMode, ToolAdapter, ToolCapabilities, ToolError, ToolExecutionContext,
        ToolIdempotency, ToolInspectContext, ToolIntent, ToolMutation, TypedTool,
    };

    struct FixedClock(i64);
    impl Clock for FixedClock {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }
    struct SeqRandom(u128);
    impl RandomSource for SeqRandom {
        fn next_random_80(&mut self) -> Result<u128, IdGenerationError> {
            self.0 += 1;
            Ok(self.0)
        }
    }

    struct CountingProvider {
        prepares: AtomicUsize,
        steps: Mutex<std::collections::VecDeque<ScriptedStep>>,
    }

    #[async_trait]
    impl StepProvider for CountingProvider {
        fn prepare(&self, step_index: u32) -> Result<PreparedRequest, TurnError> {
            self.prepares.fetch_add(1, Ordering::SeqCst);
            Ok(PreparedRequest {
                request_body: json!({"scripted": true, "step": step_index}),
                component_bytes: std::array::from_fn(|_| Vec::new()),
            })
        }

        async fn complete(
            &self,
            _step_index: u32,
            admitted: &AdmittedRequest,
            _cancel: &CancellationToken,
        ) -> Result<ProviderOutput, TurnError> {
            let authorization = admitted.authorize_send(admitted.body())?;
            let step = self.steps.lock().unwrap().pop_front().expect("step");
            Ok(ProviderOutput {
                draft: AssistantDraft {
                    text: step.text,
                    calls: step.calls,
                    finish_reason: step.finish,
                    usage: step.usage,
                },
                authorization,
            })
        }
    }

    struct StuckWriter;
    #[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct StuckInput {
        value: String,
    }
    #[derive(Debug, serde::Serialize, schemars::JsonSchema)]
    struct StuckOutput {
        value: String,
    }

    #[async_trait]
    impl TypedTool for StuckWriter {
        type Input = StuckInput;
        type Output = StuckOutput;
        const NAME: &'static str = "stuck_writer";
        const ORDER: u16 = 50;
        const DESCRIPTION: &'static str = "Writes until the runtime stops it";
        fn static_capabilities(&self) -> ToolCapabilities {
            ToolCapabilities::WRITE_FILES
        }
        fn inspect(&self, _: &StuckInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
            Ok(ToolIntent {
                mutation: ToolMutation::Workspace,
                path_accesses: vec![crate::tools::PathAccessIntent {
                    requested: "note.txt".into(),
                    normalized_absolute: PathBuf::new(),
                    mode: PathAccessMode::Write,
                }],
                command: None,
                risk_facts: Vec::new(),
                timeout_ms: 80,
                idempotency: ToolIdempotency::NonIdempotent,
                planned: Vec::new(),
            })
        }
        async fn execute(
            &self,
            context: ToolExecutionContext,
            _input: StuckInput,
            _: CancellationToken,
        ) -> Result<StuckOutput, ToolError> {
            let path = context.cwd.join("note.txt");
            loop {
                let _ = std::fs::write(&path, b"still-writing");
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }
    }

    #[tokio::test]
    async fn poisoned_session_rejects_another_turn_before_admission() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let mut effective = build_defaults(PathBuf::from("/praana-home").as_path());
        effective.turn.max_steps = 3;
        effective.llm.context_window = 128_000;
        effective.llm.provider = "scripted".into();
        effective.llm.protocol = "scripted-v1".into();
        effective.llm.model = "fake".into();
        effective.llm.min_output_tokens = 16;
        effective.llm.max_output_tokens = 256;
        effective.history.safety_margin_min_tokens = 0;
        effective.history.safety_margin_ratio = 0.0;
        let mut arguments = serde_json::Map::new();
        arguments.insert("value".into(), json!("go"));
        let provider = CountingProvider {
            prepares: AtomicUsize::new(0),
            steps: Mutex::new(
                vec![ScriptedStep {
                    text: None,
                    calls: vec![DraftCall {
                        call_id: "call-stuck".into(),
                        name: "stuck_writer".into(),
                        arguments,
                    }],
                    finish: FinishReason::ToolUse,
                    usage: ProviderUsage::default(),
                }]
                .into(),
            ),
        };
        let cfg = LoopConfig {
            session_dir: dir.path().join("session"),
            workspace: dir.path().join("work"),
            config: effective,
            clock: Arc::new(FixedClock(1_700_000_000_000)),
            ids: Arc::new(MonotonicUlidGenerator::new(
                Arc::new(FixedClock(1_700_000_000_000)),
                Arc::new(crate::clock::ThreadSleeper),
                Box::new(SeqRandom(1)),
            )),
            fault: LoopFault::None,
            extra_tools: vec![ToolAdapter::arc(StuckWriter).unwrap()],
        };
        let mut loop_ = HeadlessLoop::create(cfg).unwrap();
        let report = loop_.run_turn("stuck", &provider).await.unwrap();
        assert_eq!(
            report.interruption,
            Some(InterruptionReason::ToolRuntimePoisoned)
        );
        assert_eq!(loop_.held_locks(), 1);
        let text = std::fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
        let interrupted: Value = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .find(|event: &Value| event["event"]["kind"] == "turn_interrupted")
            .unwrap();
        assert!(!interrupted["event"]["data"]["uncertain_execution_ids"]
            .as_array()
            .unwrap()
            .is_empty());
        let prepares = provider.prepares.load(Ordering::SeqCst);
        let error = loop_.run_turn("again", &provider).await.unwrap_err();
        assert!(error.to_string().contains("poisoned"), "{error}");
        assert_eq!(provider.prepares.load(Ordering::SeqCst), prepares);
        let again = std::fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
        assert_eq!(
            again.matches("\"user_message_accepted\"").count(),
            text.matches("\"user_message_accepted\"").count()
        );
    }
}
