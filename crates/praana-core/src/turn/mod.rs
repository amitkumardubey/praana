//! Provider-independent headless turn loop.
//!
//! Admission goes through the existing provider admit function. Tool execution
//! goes through the P3A runtime and P3B artifact publisher. This module does
//! not speak a provider wire protocol.

use std::collections::BTreeSet;
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
use crate::protocol::state_graph::StateChangeReason;
use crate::provider::openai::{admit, AdmissionDecision, AdmissionRequest};
use crate::redaction::redact_json_v1;
use crate::token::calibration::{CalibrationBucketKey, TokenCalibrationSampleV1};
use crate::token::calibration_store::{cached_calibration_margin, note_appended_sample};
use crate::token::profile::TokenProfileStoreV1;
use crate::token::FramingProfileV1;
use crate::token::GENERIC_ESTIMATOR_ID;

mod telemetry;
use crate::tools::builtin::production_tools;
use crate::tools::{
    BatchOrigin, DurableBatchOutcome, DurableSession, ErasedTool, ProviderToolCall,
    ToolBatchRequest, ToolCallOrigin, ToolName, ToolRegistry, ToolRuntime,
};

pub mod provider;

/// OpenAI §18.3: no further attempt is scheduled once the accumulated retry
/// wall time for one step reaches this cap, including under cancellation.
const RETRY_WALL_CAP_MS: u64 = 60_000;

/// History built-ins that read the derived database run the live projection
/// before the tools read. Names come from the tool `NAME` consts so this list
/// cannot drift from the tool catalog. `retrieve_artifact` is deliberately
/// absent: it reads publish-written artifact tables, so it cannot observe the
/// derived catch-up, and running the projection for it would only add a
/// failure surface without any read benefit.
const HISTORY_TOOL_BATCHES_PROJECT: [&str; 2] = [
    <crate::tools::builtin::history::SearchSessionLogTool as crate::tools::TypedTool>::NAME,
    <crate::tools::builtin::history::ReadSessionSourceTool as crate::tools::TypedTool>::NAME,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopFault {
    None,
    AfterToolBodyBeforeFinish,
}

#[derive(Clone)]
pub struct LoopConfig {
    /// Per-user PRAANA home. The calibration store is `<home>/calibration.db`.
    /// Explicit: admission does not derive this from `session_dir`.
    pub home: PathBuf,
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
    /// A History fsync/append failure. Surfaces as exit 1 with no resume ID.
    Durability(String),
    /// Typed provider/protocol failure carrying the canonical diagnostic and
    /// the emission state needed for retry policy and durable attempt failure.
    Provider(Box<ProviderFailure>),
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
            Self::Durability(message) => write!(f, "{message}"),
            Self::Provider(failure) => write!(f, "{}", failure.error),
        }
    }
}

impl std::error::Error for TurnError {}

/// Provider-side failure detail routed from `StepProvider` into the P3C loop.
#[derive(Clone, Debug)]
pub struct ProviderFailure {
    /// Canonical protocol error (E_* code + class). Message must be redacted
    /// and free of raw provider bodies before it reaches events or stderr.
    pub error: ProtocolError,
    /// First nonempty semantic delta was observed: retry is forbidden.
    pub emission_crossed: bool,
    /// A user-visible text or reasoning-summary delta reached the sink layer.
    pub observable_delta: bool,
    /// Ordered partial blocks for the durable attempt-failure payload.
    pub partial_blocks: Vec<AssistantBlock>,
    pub provider_response_id: Option<String>,
    pub usage: ProviderUsage,
    pub may_have_completed: bool,
    pub cancelled: bool,
    /// Provider-hinted retry delay (`retry-after` / `retry-after-ms`).
    pub retry_after_ms: Option<u64>,
}

/// Canonical code of a provider context-length response (Protocol §10).
const CONTEXT_LENGTH_CODE: &str = "E_PROVIDER_CONTEXT_LENGTH";

/// The §14.3 step 5 final diagnostic: the one emergency context retry was
/// unavailable (cap exhausted) or failed with context length again. The
/// internal domain code `ADMISSION_PROVIDER_CONTEXT_REJECTED` maps to the
/// canonical `E_PROVIDER_CONTEXT_LENGTH` / `context_length` at the report
/// boundary (Protocol Appendix A.5), so `TurnReport.diagnostic` carries the
/// canonical code like every other surfaced diagnostic.
fn provider_context_rejected() -> ProtocolError {
    ProtocolError {
        code: "E_PROVIDER_CONTEXT_LENGTH".to_owned(),
        class: ErrorClass::ContextLength,
        message: "the provider rejected the request for context length after the one emergency \
                  retry was unavailable or failed"
            .to_owned(),
        retryable: false,
        http_status: None,
        retry_after_ms: None,
    }
}

/// Domain `COMPACTION_UNAVAILABLE` (Compaction §14.4) at the report boundary:
/// canonical `E_COMPACTION_UNAVAILABLE` / `unavailable` (Protocol Appendix
/// A.5). Not retryable until the compactor capability or config changes.
/// Fixed generic message shared by every non-activation live compaction
/// diagnostic (Compaction §14.1): never quotes provider or compactor text.
const LIVE_COMPACTION_NOT_ACTIVATED_MESSAGE: &str =
    "live compaction did not activate; every turn retained";

/// Fixed message for the degraded-resume derived-rebuild failure. The code,
/// class, and retryability come from `projection_error`; the raw error text
/// and paths never reach events or reports. The derived `history.db` stays
/// behind while canonical history remains authoritative.
const RESUME_PROJECTION_DIAGNOSTIC_MESSAGE: &str =
    "derived history rebuild failed at resume; canonical history is authoritative";

fn compaction_unavailable(cause_code: &str) -> ProtocolError {
    ProtocolError {
        code: "E_COMPACTION_UNAVAILABLE".to_owned(),
        class: ErrorClass::Unavailable,
        message: format!(
            "the configured compactor became unavailable after session start ({}); new turn \
             admission is stopped",
            cause_code
        ),
        retryable: false,
        http_status: None,
        retry_after_ms: None,
    }
}

/// Result of one live compaction epoch (see `HeadlessLoop::live_compaction_epoch`).
#[derive(Debug)]
enum LiveEpoch {
    Activated,
    Retained,
    Unavailable(ProtocolError),
}

/// Live compaction launch decision (§4.2, §14.2). `admitted_fill_ppm` is
/// `None` when the request did not fit as-is (hard ceiling, `I > U`); that
/// path compacts whenever a source turn remains. An admitted request checks
/// the cheap fill trigger first: `candidate` projects and token-estimates the
/// whole retained log, so it runs only once proactive compaction could launch.
fn wants_live_compaction(
    admitted_fill_ppm: Option<u64>,
    compact_at: f64,
    compact_clear_at: f64,
    candidate: impl FnOnce() -> Result<bool, TurnError>,
) -> Result<bool, TurnError> {
    use crate::compaction::admission::{should_launch, PressureThresholds};
    let Some(fill_ppm) = admitted_fill_ppm else {
        return candidate();
    };
    let Ok(thresholds) = PressureThresholds::from_ratios(compact_at, compact_clear_at) else {
        return Ok(false);
    };
    if fill_ppm < thresholds.trigger_ppm {
        return Ok(false);
    }
    Ok(should_launch(fill_ppm, thresholds, false, candidate()?))
}

impl ProviderFailure {
    /// The one emergency context retry (Compaction §14.3). It is not a generic
    /// retry: `retry_allowed` still excludes `ContextLength`, so other error
    /// classes can neither reach nor reset this budget.
    fn emergency_context_retry_allowed(&self, already_spent: bool) -> bool {
        !already_spent
            && !self.cancelled
            && !self.emission_crossed
            && self.error.code == CONTEXT_LENGTH_CODE
    }

    fn retry_allowed(&self) -> bool {
        !self.emission_crossed
            && !self.cancelled
            && self.error.retryable
            && matches!(
                self.error.class,
                ErrorClass::Transport
                    | ErrorClass::Timeout
                    | ErrorClass::RateLimit
                    | ErrorClass::Unavailable
            )
    }
}

#[derive(Clone, Debug)]
pub struct TurnReport {
    pub interruption: Option<InterruptionReason>,
    pub admission_count: u32,
    /// Canonical `E_*` diagnostic for provider/protocol failures and admission
    /// errors surfaced before or during the turn. Printed on stderr by the CLI.
    pub diagnostic: Option<ProtocolError>,
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

    /// Value-level authorization for adapters that transmit a `serde_json`
    /// value (the scripted test providers).
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

    /// Byte-level authorization for the real transport: `sent` must be exactly
    /// the canonical (RFC 8785) serialization of the admitted body whose
    /// SHA-256 is the durable `request_hash`. Called before the network write so
    /// a mutated or differently serialized buffer never reaches the socket.
    pub fn authorize_bytes(&self, sent: &[u8]) -> Result<SendAuthorization, TurnError> {
        let expected = crate::protocol::json::serialize_canonical(&self.body)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        if sent != expected.as_slice() {
            return Err(TurnError::failed(
                "provider send was not the admitted request",
            ));
        }
        let sent_hash =
            Sha256Digest::from_bytes(<sha2::Sha256 as sha2::Digest>::digest(sent).into());
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

/// Per-prepare context handed to the provider by the session controller.
pub struct PrepareContext<'a> {
    /// Active turn's user input text (projection remains the provider's job).
    pub input: &'a str,
    /// Recovery notices durable for the upcoming attempt start.
    pub notices: Vec<RecoveryNotice>,
    pub state_tail: &'a str,
}

/// Everything the controller needs from `prepare`: the exact final body plus
/// the resolved capability profile used by admission.
pub struct PreparedStep {
    pub request: PreparedRequest,
    pub profile: Option<crate::provider::profile::ModelCapabilityProfile>,
    pub image_count: usize,
    pub resolved_max_output_tokens: Option<u64>,
    pub state_tail_offset: Option<usize>,
    /// Rendered handoff slot and its instruction-string offset when a handoff
    /// exists. `None` keeps an empty slot inside `system` (Compaction §4.1).
    pub handoff: Option<(usize, String)>,
}

/// Admission outcome for a fully prepared request.
#[allow(clippy::large_enum_variant)]
enum AdmissionOutcome {
    Admitted(Admitted),
    Reject,
    ReduceOutput(u64),
}

/// Protocol-owned result of one completed provider attempt. `blocks` carries
/// the ordered assistant blocks (including refusals) when the wire adapter
/// converted them; `None` falls back to the legacy draft conversion.
pub struct StepOutcome {
    pub draft: AssistantDraft,
    pub blocks: Option<Vec<AssistantBlock>>,
    pub continuation: Option<crate::protocol::continuation::ProviderContinuation>,
    pub phase: Option<crate::protocol::messages::AssistantPhase>,
    pub authorization: SendAuthorization,
}

/// Receives accepted assistant text blocks in order, only after
/// `assistant_step_accepted` is durable. Never sees provisional deltas.
pub trait AcceptedStepSink: Send {
    fn on_accepted_text(&mut self, text: &str);
}

pub(crate) struct NullSink;

impl AcceptedStepSink for NullSink {
    fn on_accepted_text(&mut self, _text: &str) {}
}

#[async_trait]
pub trait StepProvider: Send + Sync {
    fn prepare(&self, step_index: u32) -> Result<PreparedRequest, TurnError> {
        let _ = step_index;
        Err(TurnError::failed("prepare is not implemented"))
    }
    async fn complete(
        &self,
        step_index: u32,
        admitted: &AdmittedRequest,
        cancel: &CancellationToken,
    ) -> Result<ProviderOutput, TurnError> {
        let _ = (step_index, admitted, cancel);
        Err(TurnError::failed("complete is not implemented"))
    }

    /// Preferred seam: full projection/format/profile in one call. The default
    /// wraps the legacy `prepare` pair with no profile.
    fn prepare_admitted(
        &self,
        step_index: u32,
        _ctx: &PrepareContext<'_>,
    ) -> Result<PreparedStep, TurnError> {
        Ok(PreparedStep {
            request: self.prepare(step_index)?,
            profile: None,
            image_count: 0,
            resolved_max_output_tokens: None,
            state_tail_offset: None,
            handoff: None,
        })
    }

    /// Preferred completion seam returning ordered blocks/continuation. The
    /// default wraps the legacy `complete` pair.
    async fn complete_step(
        &self,
        step_index: u32,
        admitted: &AdmittedRequest,
        cancel: &CancellationToken,
    ) -> Result<StepOutcome, TurnError> {
        let output = self.complete(step_index, admitted, cancel).await?;
        Ok(StepOutcome {
            draft: output.draft,
            blocks: None,
            continuation: None,
            phase: None,
            authorization: output.authorization,
        })
    }

    /// Called before each drive with the live session directory so a real
    /// provider can project accepted conversation. Default: no session.
    fn bind_session(&self, _session_dir: &Path) {}

    /// Admission `ReduceOutput` reserve override for the next re-prepare.
    fn set_output_reserve(&self, _tokens: u64) {}

    /// Clears the reserve override after a successful admission so later
    /// steps format with the normal profile/config output window.
    fn clear_output_reserve(&self) {}
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

#[derive(Default)]
struct RecoveryBatch {
    id: Option<ToolBatchId>,
    cancelled_calls: BTreeSet<ToolCallId>,
}

pub struct HeadlessLoop {
    config: LoopConfig,
    log: EventLogStore,
    artifacts: ArtifactStore,
    history_db: crate::history::db::HistoryDatabase,
    runtime: ToolRuntime,
    session_id: SessionId,
    model: ModelSelection,
    toolset_hash: Sha256Digest,
    framing: FramingProfileV1,
    admissions: u32,
    cancel: CancellationToken,
    pending_notices: Vec<RecoveryNotice>,
    pending_diagnostic: Option<ProtocolError>,
    /// Turn-scoped live compaction failure (Compaction §14.1): failed/errored
    /// epochs set this. Reset at turn start. A committed turn's report prefers
    /// this over the projection diagnostic; interrupted reports carry only
    /// `pending_diagnostic`.
    compaction_diagnostic: Option<ProtocolError>,
    /// Turn-scoped live projection failure of the derived history database
    /// (`project_history_live`, post-activation projection). Independent of
    /// `compaction_diagnostic`: both can record within one turn, and the
    /// report prefers the compaction one (the lower-priority projection
    /// diagnostic is dropped from the report but stays recorded in its slot).
    projection_diagnostic: Option<ProtocolError>,
    /// Degraded-resume derived-projection failure: non-durable and resume-scoped.
    /// Set when `resume_with_project_context` degrades instead of aborting.
    /// A committed report checks it after the turn's own diagnostics
    /// (`pending_diagnostic`, then compaction, then projection). An interrupted
    /// report checks it after `pending_diagnostic` only. It is taken when it
    /// is the diagnostic actually reported, and cleared when a later live
    /// projection succeeds. It is never persisted as a recovery notice, so two
    /// resumes failing with the same code can never collide during replay.
    resume_projection_diagnostic: Option<ProtocolError>,
    /// The recomputed project context differs from the immutable creation
    /// digest; surfaced as a warning code before the next provider request.
    project_context_changed: bool,
    /// A context-length failure is awaiting its one emergency recovery cycle
    /// (Compaction §14.3): the next admission runs a compaction epoch and the
    /// resend is marked `emergency_context_retry`. Not an admission input — the
    /// epoch makes room, not a margin. `false` otherwise.
    emergency_recovery_pending: bool,
    /// Resolved configured compactor (Compaction §7.3). `None` keeps live
    /// compaction inert; the P5-7 creation gate is what installs one.
    compactor: Option<crate::compaction::activate::ConfiguredCompactor>,
    /// Set when the installed compactor lost its credential after start
    /// (Compaction §14.4). While set, new turn admission is refused.
    compaction_unavailable: Option<ProtocolError>,
    /// Best-effort, process-local notice; no profile content or secret is retained.
    compactor_profile_unresolved: Option<&'static str>,
    /// Observable hysteresis signal (Compaction §4.2); never a lockout.
    pressure: crate::compaction::admission::PressureState,
}

impl HeadlessLoop {
    pub fn create(config: LoopConfig) -> Result<Self, TurnError> {
        Self::create_with_project_context(config, None)
    }

    /// Session creation with a discovered project context: `meta.json` then
    /// records the `project_context_source_sha256` of the sources the provider
    /// request is actually compiled from (System Context §7.1).
    pub fn create_with_project_context(
        config: LoopConfig,
        project_context: Option<crate::system_context::load::LoadedProjectContext>,
    ) -> Result<Self, TurnError> {
        std::fs::create_dir_all(&config.session_dir)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        std::fs::create_dir_all(&config.workspace)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        write_config_snapshot_durable(&config.session_dir, &config.config)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        // The session directory is named after its session id when it is
        // canonical (`<session.root>/<SessionId>/`); otherwise a fresh id is
        // generated so tests and legacy layouts keep working.
        let session_id: SessionId = match std::path::Path::new(&config.session_dir)
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| SessionId::from_str_canonical(name).ok())
        {
            Some(id) => id,
            None => config
                .ids
                .next_id()
                .map_err(|err| TurnError::failed(err.to_string()))?,
        };
        let log = Self::open_log(&config.session_dir, &session_id, project_context.as_ref())
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let mut loop_ = Self::assemble(config, log, session_id, Vec::new())?;
        if loop_.log.current_sequence() == 0 {
            loop_.append_session_started()?;
        }
        Ok(loop_)
    }

    pub fn resume(config: LoopConfig) -> Result<Self, TurnError> {
        Self::resume_with_project_context(config, None)
    }

    /// Resume with a recomputed project context. The immutable creation digest
    /// in `meta.json` is never rewritten; a difference emits exactly one
    /// `PROJECT_CONTEXT_CHANGED_SINCE_CREATE` warning carrying only the code
    /// (System Context §7.1), and the current context is what the next
    /// provider request is compiled from.
    pub fn resume_with_project_context(
        config: LoopConfig,
        project_context: Option<crate::system_context::load::LoadedProjectContext>,
    ) -> Result<Self, TurnError> {
        let session_id = read_session_id(&config.session_dir)?;
        let (notices, resume_projection_diagnostic) = {
            let mut engine = SessionRecoveryEngine::new(&config.session_dir, &session_id)
                .map_err(|err| TurnError::failed(err.to_string()))?;
            engine
                .run_recovery()
                .map_err(|err| TurnError::failed(err.to_string()))?;
            let db =
                crate::history::db::HistoryDatabase::open(&config.session_dir.join("history.db"))
                    .map_err(|err| TurnError::failed(err.to_string()))?;
            // `history.db` is derived and non-authoritative. A derived-projection
            // failure after a successful `run_recovery` degrades; a
            // canonical-integrity failure stays fatal, as does `run_recovery`
            // itself. The derived failure is a NON-durable, resume-scoped
            // diagnostic on the first turn report after resume — never a
            // recovery notice — so identical failures across resumes cannot
            // collide when the session replays (a recovery notice id is
            // derived from the code alone, and replay rejects a repeated id
            // whose content differs).
            let notices = engine.take_pending_notices();
            // Never rebuild here. `project()` replaces `history.db` on an
            // invalid checkpoint and drops canonical `operation_records`
            // (History §2.1, §9.4). Catch-up of an absent or stale checkpoint
            // still happens in place. An invalid checkpoint degrades.
            // Canonical-integrity errors stay fatal: the blanket catch must
            // not resume on a corrupt event prefix or artifact table.
            let resume_projection_diagnostic =
                match crate::history::checkpoint::HistoryProjector::new(&db)
                    .project_without_rebuild(engine.store())
                {
                    Ok(()) => None,
                    Err(error) if resume_projection_is_canonical_integrity(error.code()) => {
                        return Err(TurnError::failed(format!(
                            "{}: canonical history failed integrity checks at resume",
                            error.code()
                        )));
                    }
                    Err(error) => {
                        let mut diagnostic = projection_error(&error, &config.session_dir);
                        diagnostic.message = RESUME_PROJECTION_DIAGNOSTIC_MESSAGE.to_owned();
                        // A resume failure cannot be retried inside the turn.
                        // `projection_error` marks `HISTORY_IO` retryable.
                        diagnostic.retryable = false;
                        Some(diagnostic)
                    }
                };
            (notices, resume_projection_diagnostic)
        };
        let parsed = SessionId::from_str_canonical(&session_id)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        // A recomputed context that differs from the immutable creation digest
        // is reported as exactly one code, never as source text or a path.
        let context_changed = match project_context.as_ref() {
            Some(current) => {
                let creation = crate::history::event_log::read_project_context_source_sha256(
                    &config.session_dir,
                )
                .map_err(|err| TurnError::failed(err.to_string()))?;
                !crate::system_context::load::resume_context_warnings(&creation, current).is_empty()
            }
            None => false,
        };
        let log = EventLogStore::create_or_open(&config.session_dir, &session_id)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        let mut loop_ = Self::assemble(config, log, parsed, notices)?;
        loop_.resume_projection_diagnostic = resume_projection_diagnostic;
        loop_.project_context_changed = context_changed;
        Ok(loop_)
    }

    /// Session creation records the provenance digest of the project context
    /// the provider request is actually compiled from (System Context §7.1).
    fn open_log(
        session_dir: &Path,
        session_id: &SessionId,
        project_context: Option<&crate::system_context::load::LoadedProjectContext>,
    ) -> Result<EventLogStore, crate::protocol::errors::HistoryError> {
        match project_context {
            Some(context) => {
                let digest = crate::system_context::load::project_context_source_sha256(
                    &context.all_sources,
                );
                EventLogStore::create_or_open_with_project_context(
                    session_dir,
                    &session_id.to_string(),
                    &digest,
                )
            }
            None => EventLogStore::create_or_open(session_dir, &session_id.to_string()),
        }
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
        let mut sink = NullSink;
        self.run_turn_with_sink(text, provider, &mut sink).await
    }

    pub async fn run_turn_with_sink(
        &mut self,
        text: &str,
        provider: &dyn StepProvider,
        sink: &mut dyn AcceptedStepSink,
    ) -> Result<TurnReport, TurnError> {
        self.ensure_live()?;
        self.ensure_compaction_available()?;
        provider.bind_session(self.log.session_dir());
        self.begin_turn(text)?;
        self.drive(provider, sink).await
    }

    pub async fn continue_turn(
        &mut self,
        provider: &dyn StepProvider,
    ) -> Result<TurnReport, TurnError> {
        let mut sink = NullSink;
        self.continue_turn_with_sink(provider, &mut sink).await
    }

    pub async fn continue_turn_with_sink(
        &mut self,
        provider: &dyn StepProvider,
        sink: &mut dyn AcceptedStepSink,
    ) -> Result<TurnReport, TurnError> {
        self.ensure_live()?;
        self.ensure_compaction_available()?;
        provider.bind_session(self.log.session_dir());
        if self.replay()?.active_turn_id().is_none() {
            return Err(TurnError::failed("no active turn to continue"));
        }
        self.drive(provider, sink).await
    }

    /// Installs the resolved configured compactor that live pressure and
    /// hard-ceiling recovery use. `None` makes both inert. Installing (or
    /// clearing) the compactor is the capability change that lifts a §14.4
    /// `COMPACTION_UNAVAILABLE` admission stop.
    pub fn set_compactor(
        &mut self,
        compactor: Option<crate::compaction::activate::ConfiguredCompactor>,
    ) {
        self.compactor = compactor;
        self.compaction_unavailable = None;
        self.compactor_profile_unresolved = None;
    }

    /// Reinstalls the frozen pair without a creation gate. Credential failures
    /// stop admission (§14.4); unresolved profiles leave compaction inert for
    /// this process and ordinary turn admission unchanged. Runtime secrets are
    /// still resolved only after the durable compaction attempt start.
    pub fn install_compactor_on_resume(
        &mut self,
        home: &Path,
        now_ms: i64,
        env_vars: &std::collections::BTreeMap<String, String>,
    ) {
        use crate::compaction::activate::{CompactionRunError, ConfiguredCompactor};
        use crate::compaction::creation::{
            credential_presence_cause_code, validate_compactor_credential_presence,
        };
        use crate::config::{raw::ascii_edge_trim, CompactorPair};
        let history = &self.config.config.history;
        let provider = match history.compactor_pair() {
            CompactorPair::Empty => {
                self.set_compactor(None);
                return;
            }
            CompactorPair::Complete { provider, .. } => provider,
            // Frozen invalid pairs still use the existing credential failure path.
            CompactorPair::OneSided => ascii_edge_trim(&history.compactor_provider),
        };
        // Presence is independent of catalog freshness. A lost credential must
        // still stop admission even when the profile also cannot be resolved.
        if let Err(error) = validate_compactor_credential_presence(provider, home, env_vars) {
            self.compactor = None;
            self.compactor_profile_unresolved = None;
            self.compaction_unavailable = Some(compaction_unavailable(
                credential_presence_cause_code(&error),
            ));
            return;
        }
        match ConfiguredCompactor::resolve(&self.config.config, home, now_ms) {
            Ok(compactor) => self.set_compactor(Some(compactor)),
            Err(CompactionRunError::Unavailable { reason, .. }) => {
                let cause_code = reason.token();
                self.set_compactor(None);
                self.compactor_profile_unresolved = Some(cause_code);
                let dimensions = format!("{{\"error_code\":\"{cause_code}\"}}");
                // Best-effort derived telemetry must not prevent session resume.
                let _ = self.artifacts.record_telemetry_sample(
                    "compactor_profile_unresolved",
                    None,
                    0,
                    &dimensions,
                    now_ms,
                );
            }
            Err(error) => {
                // resolve only performs profile resolution; every failure is Unavailable.
                unreachable!("ConfiguredCompactor::resolve returned a non-profile error: {error}")
            }
        }
    }

    /// Notice for a caller to present; library code never prints to stderr.
    pub fn compactor_profile_unresolved_cause(&self) -> Option<&'static str> {
        self.compactor_profile_unresolved
    }

    /// Current pressure hysteresis signal (Compaction §4.2).
    pub fn pressure_state(&self) -> crate::compaction::admission::PressureState {
        self.pressure
    }

    /// Runs one compaction operation against a configured compactor
    /// (Compaction §12) on demand. The projection the next provider request
    /// sees is rebuilt from the durable log, so a `HistoryCompacted` that
    /// reached fsync is the activation.
    pub async fn compact_now(
        &mut self,
        compactor: &crate::compaction::activate::ConfiguredCompactor,
    ) -> Result<crate::compaction::activate::CompactionOutcome, TurnError> {
        self.ensure_live()?;
        self.compact_once(compactor)
            .await
            .map_err(|error| match error {
                crate::compaction::activate::CompactionRunError::History(message) => {
                    TurnError::Durability(message)
                }
                other => TurnError::failed(other.to_string()),
            })
    }

    async fn compact_once(
        &mut self,
        compactor: &crate::compaction::activate::ConfiguredCompactor,
    ) -> Result<
        crate::compaction::activate::CompactionOutcome,
        crate::compaction::activate::CompactionRunError,
    > {
        let config = self.config.config.clone();
        let mut outcome = {
            let mut ctx = crate::compaction::activate::ActivationContext {
                log: &mut self.log,
                ids: &self.config.ids,
                clock: self.config.clock.as_ref(),
                session_id: self.session_id,
                config: &config,
                framing: &self.framing,
            };
            crate::compaction::activate::run(&mut ctx, compactor, &self.cancel).await?
        };
        if let crate::compaction::activate::CompactionOutcome::Activated {
            derived_projection_error,
            ..
        } = &mut outcome
        {
            // Any activation, including `compact_now`, clears a failed epoch
            // from earlier in the turn. The report must not keep that failure
            // once an epoch has since activated (Compaction §14.1).
            self.compaction_diagnostic = None;
            // This persistent writer handle never rebuilds or replaces files.
            // Projection is one checkpoint-tail transaction with the database's
            // existing 5 s busy timeout; no full replay runs on this live path.
            match crate::history::checkpoint::HistoryProjector::new(&self.history_db)
                .project_without_rebuild(&self.log)
            {
                Err(error) => {
                    // A post-activation derived-projection failure is not a
                    // compaction failure: it gets its own slot, so a successful
                    // activation is never reported as compaction failing and a
                    // compaction failure in the same turn still wins the report.
                    let diagnostic = projection_error(&error, &self.config.session_dir);
                    *derived_projection_error = Some(diagnostic.clone());
                    self.projection_diagnostic = Some(diagnostic);
                }
                Ok(()) => {
                    self.projection_diagnostic = None;
                    self.resume_projection_diagnostic = None;
                }
            }
        }
        Ok(outcome)
    }

    /// One live compaction epoch (Compaction §14.1, §14.2). `Activated` means a
    /// `HistoryCompacted` is durable and the request must be rebuilt.
    /// `Retained` keeps every source turn and lets the caller continue with
    /// the request it already admitted or reject it. `Unavailable` is the
    /// §14.4 post-start credential loss: the caller must not send.
    async fn live_compaction_epoch(&mut self) -> Result<LiveEpoch, TurnError> {
        use crate::compaction::activate::{CompactionOutcome, CompactionRunError};
        let Some(compactor) = self.compactor.clone() else {
            return Ok(LiveEpoch::Retained);
        };
        match self.compact_once(&compactor).await {
            Ok(CompactionOutcome::Activated { .. }) => Ok(LiveEpoch::Activated),
            Ok(CompactionOutcome::Failed { error, .. })
                if error.class == ErrorClass::Authentication =>
            {
                // §14.4: a revoked or missing compactor credential on an
                // eligible session is `COMPACTION_UNAVAILABLE`, not a
                // recoverable §14.1 failure. Compaction stays unavailable and
                // new turn admission stops until a compactor is reinstalled.
                let unavailable = compaction_unavailable(&error.code);
                self.compaction_unavailable = Some(unavailable.clone());
                Ok(LiveEpoch::Unavailable(unavailable))
            }
            Ok(CompactionOutcome::Failed { error, .. }) => {
                // §14.1: a failed compaction retains every turn and the request
                // still goes out. Report the safe code, class, retry fields,
                // and a fixed generic message that never quotes provider text.
                self.compaction_diagnostic = Some(safe_compaction_diagnostic(&error));
                Ok(LiveEpoch::Retained)
            }
            Err(CompactionRunError::History(message)) => Err(TurnError::Durability(message)),
            Err(other) => {
                // Retained: the request is still sent. The diagnostic is a
                // canonical E_* code (Protocol Appendix A.5), never the §14.4
                // stop `E_COMPACTION_UNAVAILABLE`.
                self.compaction_diagnostic = Some(retained_epoch_diagnostic(&other));
                Ok(LiveEpoch::Retained)
            }
        }
    }

    /// §14.4: once the installed compactor became unavailable after start, no
    /// new provider request is admitted until a compactor is reinstalled.
    fn ensure_compaction_available(&self) -> Result<(), TurnError> {
        match &self.compaction_unavailable {
            Some(error) => Err(TurnError::failed(format!(
                "{}: {}",
                error.code, error.message
            ))),
            None => Ok(()),
        }
    }

    fn live_compaction_candidate(&self) -> Result<bool, TurnError> {
        crate::compaction::activate::proactive_candidate(&self.log, &self.framing)
            .map_err(|error| TurnError::failed(error.to_string()))
    }

    /// Whether this admission should run a compaction epoch before sending.
    /// Both the hard-ceiling path (non-`Admitted`, §14.2) and the proactive
    /// pressure path (§4.2) require an unconsidered eligible turn: without one
    /// there is nothing left to compact, so re-running would only burn a
    /// durable attempt and a compactor call against the same source.
    ///
    /// `proactive_candidate` projects and token-estimates the whole retained
    /// log, so an admitted request checks the cheap fill trigger first and
    /// only pays for the projection once proactive compaction could launch.
    fn live_compaction_wanted(&mut self, admission: &AdmissionOutcome) -> Result<bool, TurnError> {
        let admitted_fill_ppm = match admission {
            AdmissionOutcome::Admitted(admitted) => {
                Some(u64::from(admitted.snapshot.projected_fill_millionths))
            }
            _ => None,
        };
        let history = &self.config.config.history;
        let (log, framing) = (&self.log, &self.framing);
        wants_live_compaction(
            admitted_fill_ppm,
            history.compact_at,
            history.compact_clear_at,
            || {
                crate::compaction::activate::proactive_candidate(log, framing)
                    .map_err(|error| TurnError::failed(error.to_string()))
            },
        )
    }

    /// Updates the observable pressure hysteresis signal (§4.2) from the
    /// admitted fill. Runs on every admission regardless of whether a compactor
    /// is installed, so `pressure_state()` reflects reality even when live
    /// compaction is inert.
    fn update_pressure(&mut self, admission: &AdmissionOutcome) {
        use crate::compaction::admission::{next_pressure_state, PressureThresholds};
        let AdmissionOutcome::Admitted(admitted) = admission else {
            return;
        };
        let history = &self.config.config.history;
        let Ok(thresholds) =
            PressureThresholds::from_ratios(history.compact_at, history.compact_clear_at)
        else {
            return;
        };
        let fill_ppm = u64::from(admitted.snapshot.projected_fill_millionths);
        self.pressure = next_pressure_state(self.pressure, fill_ppm, thresholds);
    }

    /// True when replay reports an unfinished turn that
    /// [`HeadlessLoop::continue_turn_with_sink`] would drive to completion.
    pub fn has_active_turn(&self) -> Result<bool, TurnError> {
        Ok(self.replay()?.active_turn_id().is_some())
    }

    /// `PROJECT_CONTEXT_CHANGED_SINCE_CREATE` when the recomputed project
    /// context differs from the digest recorded at session creation. The code
    /// is the whole payload: no source bytes and no host-absolute paths.
    pub fn project_context_changed_since_create(&self) -> bool {
        self.project_context_changed
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
        let mut tools = production_tools(&config.config.tools)
            .map_err(|err| TurnError::failed(err.to_string()))?;
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
        runtime.set_state_active_max_tokens(config.config.state.active_max_tokens);
        let history_path = config.session_dir.join("history.db");
        let artifacts = ArtifactStore::open(
            &history_path,
            policy_from_session(&config.session_dir),
            Arc::clone(&config.clock),
        )
        .map_err(|err| TurnError::failed(err.to_string()))?;
        let history_db = crate::history::db::HistoryDatabase::open(&history_path)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        runtime
            .open_state(&log)
            .map_err(|err| TurnError::failed(err.to_string()))?;
        Ok(Self {
            model: model_selection(&config.config),
            config,
            log,
            artifacts,
            history_db,
            runtime,
            session_id,
            toolset_hash,
            framing,
            admissions: 0,
            cancel: CancellationToken::new(),
            pending_notices,
            pending_diagnostic: None,
            compaction_diagnostic: None,
            projection_diagnostic: None,
            resume_projection_diagnostic: None,
            project_context_changed: false,
            emergency_recovery_pending: false,
            compactor: None,
            compactor_profile_unresolved: None,
            compaction_unavailable: None,
            pressure: crate::compaction::admission::PressureState::Normal,
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
        self.pending_diagnostic = None;
        // Diagnostics are turn-scoped: a fresh turn clears every slot so
        // nothing from an earlier committed turn leaks into a later report.
        self.compaction_diagnostic = None;
        self.projection_diagnostic = None;
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

    async fn drive(
        &mut self,
        provider: &dyn StepProvider,
        sink: &mut dyn AcceptedStepSink,
    ) -> Result<TurnReport, TurnError> {
        loop {
            if self.cancel.is_cancelled() {
                return self.interrupt(InterruptionReason::UserAbort, None);
            }
            let open = self.open_turn()?;

            if self.config.config.state.auto_hydrate
                && self.config.config.state.auto_hydrate_max > 0
            {
                let (has_attempt_started, trigger_uma, already_hydrated) = {
                    let events = self.log.events_slice();
                    let mut trigger_uma = None;
                    let mut has_attempt_started = false;

                    for event in events {
                        if let CanonicalEvent::UserMessageAccepted(uma) = &event.event {
                            if uma.message.turn_id == open.id {
                                trigger_uma = Some(event.clone());
                            }
                        }
                        if let CanonicalEvent::AssistantAttemptStarted(aas) = &event.event {
                            if event.turn_id == Some(open.id)
                                && matches!(aas.purpose, ProviderAttemptPurpose::AssistantStep(_))
                            {
                                has_attempt_started = true;
                            }
                        }
                    }

                    let already_hydrated = if let Some(trigger) = &trigger_uma {
                        events.iter().any(|event| {
                            if let CanonicalEvent::StateChanged(sc) = &event.event {
                                sc.reason == StateChangeReason::AutoHydrate
                                    && sc.automation.as_ref().map(|a| a.trigger_event_id)
                                        == Some(trigger.event_id)
                            } else {
                                false
                            }
                        })
                    } else {
                        false
                    };

                    (has_attempt_started, trigger_uma, already_hydrated)
                };

                if !has_attempt_started {
                    let Some(trigger) = trigger_uma else {
                        return Err(TurnError::failed("STATE_PROJECTION_INTEGRITY"));
                    };
                    if !already_hydrated {
                        let result = self.runtime.auto_hydrate(
                            &mut self.log,
                            &self.config.ids,
                            &*self.config.clock,
                            &|| self.cancel.is_cancelled(),
                            &trigger,
                            &self.config.config.state,
                        );
                        match result {
                            Ok(_) => {
                                if self.log.is_unhealthy() {
                                    return Err(TurnError::Durability(
                                        "log unhealthy after auto-hydrate".to_string(),
                                    ));
                                }
                            }
                            Err(err) => {
                                if self.log.is_unhealthy() {
                                    return Err(TurnError::Durability(
                                        "log unhealthy after auto-hydrate".to_string(),
                                    ));
                                }
                                match err.state_code.as_str() {
                                    "STATE_CANCELLED" => {
                                        // skip auto-hydration with no log; normal cancellation handling applies
                                    }
                                    "STATE_PERSISTENCE" => {
                                        return Err(TurnError::Durability(err.message));
                                    }
                                    "STATE_PROJECTION_INTEGRITY" => {
                                        return Err(TurnError::failed(
                                            "STATE_PROJECTION_INTEGRITY",
                                        ));
                                    }
                                    code => {
                                        eprintln!("state auto-hydrate skipped: {code}");
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if open.tool_batch_open {
                // Recovery has classified all started calls. Finish only the
                // unstarted safe peers in the original batch, then publish a
                // completion referencing every durable result in call order.
                match self.resume_incomplete_tool_batch(&open).await? {
                    Control::Continue => continue,
                    Control::Done(report) => return Ok(report),
                }
            }
            if let Some(control) = self.resume_unstarted_tool_step(&open).await? {
                match control {
                    Control::Continue => continue,
                    Control::Done(report) => return Ok(report),
                }
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
            match self.run_step(provider, &open, sink).await? {
                Control::Continue => {}
                Control::Done(report) => return Ok(report),
            }
        }
    }

    async fn resume_incomplete_tool_batch(
        &mut self,
        open: &OpenTurn,
    ) -> Result<Control, TurnError> {
        let replay = self.replay()?;
        let index = replay
            .turn_index(open.id)
            .ok_or_else(|| TurnError::failed("turn index missing"))?;
        let turn = replay
            .turns
            .get(&index)
            .ok_or_else(|| TurnError::failed("turn missing"))?;
        let batch = turn
            .batches
            .values()
            .find(|batch| batch.completed.is_none())
            .ok_or_else(|| TurnError::failed("incomplete batch missing"))?;
        if batch
            .executions
            .values()
            .any(|execution| execution.result.is_none())
        {
            return Err(TurnError::failed(
                "started call was not classified by recovery",
            ));
        }
        let calls: Vec<_> = batch
            .calls
            .iter()
            .map(|call| DraftCall {
                call_id: call.call_id.to_string(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            })
            .collect();
        let recovery_cancelled_calls = batch
            .calls
            .iter()
            .filter(|call| {
                !batch.executions.contains_key(&call.call_id)
                    && has_durable_argument_marker(&call.raw_arguments, &call.arguments)
            })
            .map(|call| call.call_id.clone())
            .collect();
        self.run_tool_batch_with_cancel_in(
            open.id,
            batch.attempt_id,
            batch.step_id,
            &calls,
            self.cancel.clone(),
            RecoveryBatch {
                id: Some(batch.id),
                cancelled_calls: recovery_cancelled_calls,
            },
        )
        .await
    }

    async fn resume_unstarted_tool_step(
        &mut self,
        open: &OpenTurn,
    ) -> Result<Option<Control>, TurnError> {
        let replay = self.replay()?;
        let index = replay
            .turn_index(open.id)
            .ok_or_else(|| TurnError::failed("turn index missing"))?;
        let turn = replay
            .turns
            .get(&index)
            .ok_or_else(|| TurnError::failed("turn missing"))?;
        let Some(step) = turn.steps.values().next_back() else {
            return Ok(None);
        };
        if step.message.finish_reason != FinishReason::ToolUse
            || turn.batches.contains_key(&step.purpose.step_id)
        {
            return Ok(None);
        }
        let mut calls = Vec::new();
        let mut recovery_cancelled_calls = BTreeSet::new();
        for block in &step.message.blocks {
            let AssistantBlock::ToolCall(call) = block else {
                continue;
            };
            if has_durable_argument_marker(&call.raw_arguments, &call.arguments) {
                recovery_cancelled_calls.insert(call.call_id.clone());
            }
            calls.push(DraftCall {
                call_id: call.call_id.to_string(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            });
        }
        if calls.is_empty() {
            return Ok(None);
        }
        Ok(Some(
            self.run_tool_batch_with_cancel_in(
                open.id,
                step.attempt_id,
                step.purpose.step_id,
                &calls,
                self.cancel.clone(),
                RecoveryBatch {
                    id: None,
                    cancelled_calls: recovery_cancelled_calls,
                },
            )
            .await?,
        ))
    }

    async fn run_step(
        &mut self,
        provider: &dyn StepProvider,
        open: &OpenTurn,
        sink: &mut dyn AcceptedStepSink,
    ) -> Result<Control, TurnError> {
        let replay = self.replay()?;
        let index = replay
            .turn_index(open.id)
            .ok_or_else(|| TurnError::failed("turn index missing"))?;
        let input_text: String = replay
            .turns
            .get(&index)
            .map(|turn| {
                turn.user
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        UserBlock::Text(text) => Some(text.text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        drop(replay);
        // Accumulated retry wall time for this step: no further attempt is
        // scheduled once it reaches the OpenAI §18.3 60s cap.
        let mut retry_spent_ms: u64 = 0;
        self.emergency_recovery_pending = false;
        // The §14.3 recovery cycle runs its emergency epoch at most once.
        let mut emergency_epoch_run = false;
        loop {
            if self.cancel.is_cancelled() {
                return Ok(Control::Done(
                    self.interrupt(InterruptionReason::UserAbort, None)?,
                ));
            }
            let replay = self.replay()?;
            #[derive(Clone)]
            struct PriorAttempt {
                id: AttemptId,
                attempt_number: u32,
                status: crate::history::replay::AttemptStatus,
                step_id: StepId,
                emergency: bool,
                emitted: bool,
                failure_code: Option<String>,
            }
            let prior_attempts: Vec<PriorAttempt> = replay
                .attempts
                .values()
                .filter_map(|attempt| {
                    let ProviderAttemptPurpose::AssistantStep(purpose) = &attempt.purpose else {
                        return None;
                    };
                    if attempt.turn_id != Some(open.id) || purpose.step_index != open.step_index {
                        return None;
                    }
                    Some(PriorAttempt {
                        id: attempt.id,
                        attempt_number: attempt.attempt_number,
                        status: attempt.status.clone(),
                        step_id: purpose.step_id,
                        emergency: attempt.emergency_context_retry,
                        emitted: attempt.observable_delta_emitted,
                        failure_code: attempt.failure_code.clone(),
                    })
                })
                .collect();
            let max_prior = prior_attempts
                .iter()
                .max_by_key(|attempt| attempt.attempt_number)
                .cloned();
            // Compaction §14.3 / D2: the first context-length failure of a step
            // earns exactly one emergency resend. It is derived from the
            // durable log so a resumed turn neither repeats nor loses it.
            let emergency_spent = prior_attempts.iter().any(|attempt| attempt.emergency);
            let last_was_context_length = max_prior.as_ref().is_some_and(|attempt| {
                attempt.status == crate::history::replay::AttemptStatus::Failed
                    && !attempt.emitted
                    && attempt.failure_code.as_deref() == Some(CONTEXT_LENGTH_CODE)
            });
            if prior_attempts.len() >= self.config.config.turn.max_attempts as usize {
                let last_id = max_prior.as_ref().map(|attempt| attempt.id);
                // §14.3 step 5: a context-length failure whose emergency resend
                // the cap blocked rejects with ADMISSION_PROVIDER_CONTEXT_REJECTED;
                // any other exhausted retry keeps the attempt's own diagnostic.
                if last_was_context_length {
                    self.pending_diagnostic = Some(provider_context_rejected());
                }
                return Ok(Control::Done(
                    self.interrupt(InterruptionReason::ProviderFailure, last_id)?,
                ));
            }
            let attempt_number = prior_attempts
                .iter()
                .map(|attempt| attempt.attempt_number)
                .max()
                .unwrap_or(0)
                .saturating_add(1);
            let retry_of = max_prior.as_ref().map(|attempt| attempt.id);
            if last_was_context_length && emergency_spent {
                // §14.3 step 5: the emergency resend (or an earlier one) failed
                // with context length again. Reject with the final code rather
                // than the raw provider context-length diagnostic.
                self.pending_diagnostic = Some(provider_context_rejected());
                return Ok(Control::Done(
                    self.interrupt(InterruptionReason::ProviderFailure, retry_of)?,
                ));
            }
            let is_emergency = last_was_context_length;
            // §14.3 step 3: an emergency resend runs one compaction recovery
            // epoch before it is sent. Derived from the durable log (not an
            // in-memory value a resume would lose) so a live resend and a
            // resumed resend take the same recovery path.
            if is_emergency {
                self.emergency_recovery_pending = true;
            }
            let step_id: StepId = match &max_prior {
                Some(attempt) => attempt.step_id,
                None => self.fresh()?,
            };
            let state_tail = crate::state::render_state_tail(self.log.state_graph());
            let tail_estimate = crate::state::estimate_tail(&state_tail)
                .map_err(|e| TurnError::failed(e.to_string()))?;
            let limit = self.config.config.state.active_max_tokens;
            if tail_estimate.total_tokens > limit {
                let largest_desc = crate::state::largest_object_line(self.log.state_graph())
                    .map(|(sid, count)| format!("; largest object {sid} {count} tokens"))
                    .unwrap_or_default();
                let message = format!(
                    "state tail {} tokens exceeds limit {limit}{largest_desc}",
                    tail_estimate.total_tokens
                );
                self.pending_diagnostic = Some(ProtocolError {
                    code: "E_ACTIVE_TURN_TOO_LARGE".to_owned(),
                    class: ErrorClass::ContextLength,
                    message,
                    retryable: false,
                    http_status: None,
                    retry_after_ms: None,
                });
                return Ok(Control::Done(
                    self.interrupt(InterruptionReason::ActiveTurnTooLarge, None)?,
                ));
            }
            let prepare_ctx = PrepareContext {
                input: &input_text,
                notices: self.pending_notices.clone(),
                state_tail: &state_tail,
            };
            let prepared = match provider.prepare_admitted(open.step_index, &prepare_ctx) {
                Ok(prepared) => prepared,
                Err(TurnError::InjectedCrash) => return Err(TurnError::InjectedCrash),
                Err(TurnError::Durability(message)) => return Err(TurnError::Durability(message)),
                Err(error) => {
                    let failure = prepare_failure(error);
                    return self.failure_interrupt(
                        failure,
                        InterruptionReason::ProviderFailure,
                        None,
                    );
                }
            };
            let mut admission = match self.admit_prepared(&prepared, &state_tail) {
                Ok(admission) => admission,
                Err(TurnError::InjectedCrash) => return Err(TurnError::InjectedCrash),
                Err(TurnError::Durability(message)) => return Err(TurnError::Durability(message)),
                Err(error) => {
                    let failure = prepare_failure(error);
                    return self.failure_interrupt(
                        failure,
                        InterruptionReason::ProviderFailure,
                        None,
                    );
                }
            };
            // Compaction §4.2: the pressure hysteresis signal tracks every
            // admission, whether or not a compactor is installed.
            self.update_pressure(&admission);
            // Compaction §14.2 order: a compaction epoch comes before any
            // output-reserve reduction, and an epoch always rebuilds the
            // request. §14.2 step 2 repeats successful epochs while the request
            // is still over `U` and eligible turns remain; `live_compaction_wanted`
            // gates on `proactive_candidate`, which goes false once every
            // eligible turn is considered, so the loop is bounded by progress
            // rather than by the assistant `turn.max_attempts` budget.
            //
            // The §14.3 emergency recovery cycle runs its epoch once per step
            // (`emergency_epoch_run`). It is distinct from the hard-ceiling /
            // proactive repeat and spends the compaction purpose budget.
            //
            // P5-6a retires closed turns only, at top-level turn admission. No
            // in-turn tool-cycle compaction (handoff; §5.3; #634), so a step
            // after a tool call (`step_index > 0`) never compacts.
            let emergency_cycle = self.emergency_recovery_pending && !emergency_epoch_run;
            let compaction_wanted = if open.step_index == 0 && self.compactor.is_some() {
                if emergency_cycle {
                    self.live_compaction_candidate()?
                } else {
                    self.live_compaction_wanted(&admission)?
                }
            } else {
                false
            };
            if compaction_wanted {
                emergency_epoch_run |= emergency_cycle;
                match self.live_compaction_epoch().await? {
                    LiveEpoch::Activated => continue,
                    LiveEpoch::Retained => {}
                    LiveEpoch::Unavailable(error) => {
                        // §14.4: stop without calling the provider; the
                        // projection is unchanged.
                        self.pending_diagnostic = Some(error);
                        return Ok(Control::Done(
                            self.interrupt(InterruptionReason::ProviderFailure, None)?,
                        ));
                    }
                }
            }
            if let AdmissionOutcome::ReduceOutput(new_max_output_tokens) = admission {
                provider.set_output_reserve(new_max_output_tokens);
                let reprepared = match provider.prepare_admitted(open.step_index, &prepare_ctx) {
                    Ok(prepared) => prepared,
                    Err(TurnError::InjectedCrash) => return Err(TurnError::InjectedCrash),
                    Err(TurnError::Durability(message)) => {
                        return Err(TurnError::Durability(message))
                    }
                    Err(error) => {
                        let failure = prepare_failure(error);
                        return self.failure_interrupt(
                            failure,
                            InterruptionReason::ProviderFailure,
                            None,
                        );
                    }
                };
                admission = match self.admit_prepared(&reprepared, &state_tail) {
                    Ok(admission) => admission,
                    Err(TurnError::InjectedCrash) => return Err(TurnError::InjectedCrash),
                    Err(TurnError::Durability(message)) => {
                        return Err(TurnError::Durability(message))
                    }
                    Err(error) => {
                        let failure = prepare_failure(error);
                        return self.failure_interrupt(
                            failure,
                            InterruptionReason::ProviderFailure,
                            None,
                        );
                    }
                };
                // §4.2: the reduced-reserve re-admission can change projected
                // fill, so refresh the hysteresis signal from the final value.
                self.update_pressure(&admission);
            }
            let admitted = match admission {
                AdmissionOutcome::Admitted(admitted) => admitted,
                AdmissionOutcome::Reject => {
                    self.pending_diagnostic = Some(ProtocolError {
                        code: "E_ACTIVE_TURN_TOO_LARGE".to_owned(),
                        class: ErrorClass::ContextLength,
                        message: "the active turn cannot fit the provider context window"
                            .to_owned(),
                        retryable: false,
                        http_status: None,
                        retry_after_ms: None,
                    });
                    return Ok(Control::Done(
                        self.interrupt(InterruptionReason::ActiveTurnTooLarge, None)?,
                    ));
                }
                AdmissionOutcome::ReduceOutput(_) => {
                    self.pending_diagnostic = Some(ProtocolError {
                        code: "E_ADMISSION_ACCOUNTING".to_owned(),
                        class: ErrorClass::Internal,
                        message: "output reserve still exceeds admission budget after re-prepare"
                            .to_owned(),
                        retryable: false,
                        http_status: None,
                        retry_after_ms: None,
                    });
                    return Ok(Control::Done(
                        self.interrupt(InterruptionReason::ProviderFailure, None)?,
                    ));
                }
            };
            if self.cancel.is_cancelled() {
                return Ok(Control::Done(
                    self.interrupt(InterruptionReason::UserAbort, None)?,
                ));
            }
            // The admitted body carries the final reserve; drop the override.
            provider.clear_output_reserve();
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
            // Kept across the provider call so an accepted comparable step
            // can record the hash and estimate of this attempt.
            let calibration_request_hash = admitted.request_hash.clone();
            let calibration_estimated = admitted.snapshot.estimated_input_tokens;
            let calibration_window = admitted.snapshot.context_window_tokens;
            let calibration_components = admitted.component_tokens;
            let calibration_estimator_id = admitted.snapshot.estimator_id.clone();
            self.append(
                Some(open.id),
                Some(attempt_id),
                CanonicalEvent::AssistantAttemptStarted(AssistantAttemptStarted {
                    purpose: ProviderAttemptPurpose::AssistantStep(purpose.clone()),
                    attempt_number,
                    model: self.model.clone(),
                    request_hash: admitted.request_hash,
                    admission: admitted.snapshot,
                    retry_of,
                    emergency_context_retry: is_emergency,
                    recovery_notices: notices,
                }),
            )?;
            // The attempt started; clear the pending-recovery flag so this
            // attempt's own context-length failure (handled below) is what
            // re-arms it, not a stale flag from the admission that preceded it.
            self.emergency_recovery_pending = false;
            #[cfg(feature = "failpoints")]
            crate::crash_point::hit(format!(
                "turn.after_assistant_attempt_started:step{}:attempt{}",
                open.step_index, attempt_number
            ));
            let outcome = match provider
                .complete_step(open.step_index, &admitted_request, &self.cancel)
                .await
            {
                Ok(outcome) => outcome,
                Err(TurnError::InjectedCrash) => return Err(TurnError::InjectedCrash),
                Err(TurnError::Durability(message)) => return Err(TurnError::Durability(message)),
                Err(TurnError::Provider(failure)) => {
                    let cancelled = failure.cancelled;
                    if failure.error.code == CONTEXT_LENGTH_CODE {
                        telemetry::record_context_underestimation(
                            &self.artifacts,
                            &telemetry::ContextUnderestimation {
                                model: &self.model,
                                estimator_id: &calibration_estimator_id,
                                request_hash: calibration_request_hash.as_str(),
                                error_code: &failure.error.code,
                                context_window_tokens: calibration_window,
                                estimated_input_tokens: calibration_estimated,
                                component_tokens: &calibration_components,
                            },
                            self.config.clock.now_ms(),
                        );
                    }
                    self.fail_attempt(open.id, attempt_id, purpose.clone(), &failure)?;
                    if failure.emergency_context_retry_allowed(emergency_spent || is_emergency) {
                        // §14.3 steps 3-4: arm the one emergency recovery cycle
                        // (a compaction epoch runs before the resend) and loop.
                        // The top-of-loop `max_attempts` check gates the resend,
                        // so an exhausted cap ends the step without another
                        // send. The resume path re-arms this from the log.
                        self.emergency_recovery_pending = true;
                        #[cfg(feature = "failpoints")]
                        crate::crash_point::hit("turn.before_emergency_resend");
                        continue;
                    }
                    // `attempt_number` is 1-based, so it is also the 1-based
                    // number of the retry about to be scheduled.
                    let delay = self.retry_backoff_delay_ms(attempt_number, &failure);
                    if failure.retry_allowed() && Self::retry_budget_allows(retry_spent_ms, delay) {
                        tokio::select! {
                            _ = self.cancel.cancelled() => {}
                            _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {}
                        }
                        retry_spent_ms = retry_spent_ms.saturating_add(delay);
                        continue;
                    }
                    let reason = if cancelled {
                        InterruptionReason::UserAbort
                    } else {
                        InterruptionReason::ProviderFailure
                    };
                    // §14.3 step 5: an emergency resend that fails with context
                    // length again rejects with ADMISSION_PROVIDER_CONTEXT_REJECTED,
                    // not the raw provider diagnostic that `fail_attempt` left.
                    if !cancelled
                        && (is_emergency || emergency_spent)
                        && failure.error.code == CONTEXT_LENGTH_CODE
                    {
                        self.pending_diagnostic = Some(provider_context_rejected());
                    }
                    return Ok(Control::Done(self.interrupt(reason, Some(attempt_id))?));
                }
                Err(TurnError::Failed(message)) => {
                    let failure = output_failure(&message);
                    self.fail_attempt(open.id, attempt_id, purpose.clone(), &failure)?;
                    return Ok(Control::Done(self.interrupt(
                        InterruptionReason::ProviderFailure,
                        Some(attempt_id),
                    )?));
                }
            };
            // OpenAI §19: `complete_step` returns `Ok` only once a terminal
            // event was fully parsed, so a cancellation observed after that
            // parse does not discard the completed step — completion wins. A
            // cancel seen before the terminal event arrives as the cancelled
            // provider failure above and is handled there.
            let draft = outcome.draft;
            let message = match assistant_message_with(
                &draft,
                outcome.blocks,
                outcome.phase,
                outcome.continuation,
                self.config.ids.as_ref(),
                open.id,
                step_id,
                &self.model,
            ) {
                Ok(message) => message,
                Err(error) => {
                    let failure = output_failure(&error.to_string());
                    self.fail_attempt(open.id, attempt_id, purpose.clone(), &failure)?;
                    return Ok(Control::Done(self.interrupt(
                        InterruptionReason::ProviderFailure,
                        Some(attempt_id),
                    )?));
                }
            };
            let accept_event_id = self.append(
                Some(open.id),
                Some(attempt_id),
                CanonicalEvent::AssistantStepAccepted(AssistantStepAccepted {
                    purpose: purpose.clone(),
                    message: message.clone(),
                }),
            )?;
            // The step is durable: drop any diagnostic from a retried attempt
            // so a later success never reports a stale failure line.
            self.pending_diagnostic = None;
            // Accepted text reaches the sink only after the barrier above.
            for block in &message.blocks {
                if let AssistantBlock::Text(text) = block {
                    sink.on_accepted_text(&text.text);
                }
            }
            self.record_calibration_sample(
                is_emergency,
                &message.usage,
                &calibration_request_hash,
                calibration_estimated,
                &calibration_estimator_id,
            );
            #[cfg(feature = "failpoints")]
            crate::crash_point::hit(format!(
                "turn.after_assistant_step_accepted:step{}",
                open.step_index
            ));
            if let Some(old_id) = max_prior
                .filter(|attempt| attempt.status == crate::history::replay::AttemptStatus::Failed)
                .map(|attempt| attempt.id)
            {
                // Match the crash-recovery repair path (history/recovery.rs): an
                // emergency context retry supersedes with EmergencyContextRetry,
                // so live execution and resume agree on the reason.
                let reason = if is_emergency {
                    SupersessionReason::EmergencyContextRetry
                } else {
                    SupersessionReason::Retry
                };
                self.append(
                    Some(open.id),
                    None,
                    CanonicalEvent::AttemptSuperseded(AttemptSuperseded {
                        purpose: ProviderAttemptPurpose::AssistantStep(purpose),
                        superseded_attempt_id: old_id,
                        replacement_attempt_id: attempt_id,
                        replacement_accept_event_id: accept_event_id,
                        reason,
                    }),
                )?;
            }
            if message.finish_reason != FinishReason::ToolUse {
                return Ok(Control::Continue);
            }
            return self
                .run_tool_batch(open.id, attempt_id, step_id, &draft.calls)
                .await;
        }
    }

    /// Retry delay for the `retry_number`-th retry of this step (1-based, so
    /// the first retry uses the 500ms cap and the second the 1000ms cap), from
    /// the provider `retry-after` hint or bounded jitter. Pure: the caller
    /// applies the wall cap and the sleep.
    fn retry_backoff_delay_ms(&self, retry_number: u32, failure: &ProviderFailure) -> u64 {
        retry_backoff_delay_ms_for(Arc::clone(&self.config.clock), retry_number, failure)
    }

    /// OpenAI §18.3 wall cap: another attempt is scheduled only while the
    /// accumulated retry time plus the next delay stays inside the budget, so
    /// no send happens once 60 seconds of retrying have been spent.
    fn retry_budget_allows(spent_ms: u64, delay_ms: u64) -> bool {
        spent_ms.saturating_add(delay_ms) < RETRY_WALL_CAP_MS
    }

    fn failure_interrupt(
        &mut self,
        failure: ProviderFailure,
        reason: InterruptionReason,
        attempt: Option<AttemptId>,
    ) -> Result<Control, TurnError> {
        self.pending_diagnostic = Some(failure.error);
        Ok(Control::Done(self.interrupt(reason, attempt)?))
    }

    /// Token Accounting §9 margin for this request's bucket.
    ///
    /// Admission estimates with the generic estimator, so the key uses
    /// `GENERIC_ESTIMATOR_ID`. A recorded sample uses the admitted snapshot's
    /// estimator id, which is that same id today; a different id is a
    /// different bucket. The first use of a key in this process loads the
    /// store. Another process's later writes are visible to the next process.
    fn calibration_margin_for_admission(&mut self) -> u64 {
        let key = CalibrationBucketKey::from_parts(
            self.model.provider.clone(),
            self.model.protocol.clone(),
            self.model.model.clone(),
            self.model.model_revision.clone(),
            GENERIC_ESTIMATOR_ID,
        );
        let cached = cached_calibration_margin(&self.config.home, &key);
        if let Some(code) = cached.error_code {
            self.note_calibration_store_error(code);
        }
        cached.margin
    }

    /// Comparable accepted assistant step. Placeholder zero usage and an
    /// emergency context retry are not samples. Compaction-purpose requests
    /// are not assistant steps, so they are not sampled here.
    ///
    /// The failpoint sits after the sample exists and before the store write.
    /// A crash there drops at most this one non-canonical sample.
    fn record_calibration_sample(
        &mut self,
        is_emergency: bool,
        usage: &ProviderUsage,
        request_hash: &Sha256Digest,
        estimated_input_tokens: u64,
        estimator_id: &str,
    ) {
        if is_emergency || usage.input_tokens == 0 {
            return;
        }
        let Ok(sample) = TokenCalibrationSampleV1::new(
            self.model.provider.clone(),
            self.model.protocol.clone(),
            self.model.model.clone(),
            self.model.model_revision.clone(),
            estimator_id.to_owned(),
            request_hash.clone(),
            estimated_input_tokens,
            usage.input_tokens,
            Some(usage.cache_read_tokens),
            self.log.replayer().compaction_epoch,
            self.config.clock.now_ms(),
        ) else {
            return;
        };
        #[cfg(feature = "failpoints")]
        crate::crash_point::hit("compaction.after_calibration_sample");
        match crate::token::append_sample(&self.config.home, &sample) {
            Ok(()) => note_appended_sample(&self.config.home, &sample),
            Err(error) => self.note_calibration_store_error(error.code),
        }
    }

    fn note_calibration_store_error(&mut self, code: &'static str) {
        // The code is telemetry only. `C` stays 0 and the sample is dropped.
        telemetry::record_calibration_store_error(
            &self.artifacts,
            code,
            self.config.clock.now_ms(),
        );
    }

    fn admit_prepared(
        &mut self,
        prepared: &PreparedStep,
        state_tail: &str,
    ) -> Result<AdmissionOutcome, TurnError> {
        self.admissions = self.admissions.saturating_add(1);
        let llm = &self.config.config.llm;
        let history = &self.config.config.history;
        let component_bytes =
            crate::provider::openai::accounted_component_bytes(&prepared.request.request_body)
                .map_err(TurnError::failed)?;
        let requested_max_output = prepared
            .resolved_max_output_tokens
            .unwrap_or(llm.max_output_tokens);
        let decision = admit(&AdmissionRequest {
            profile: prepared.profile.as_ref(),
            configured_context_window: llm.context_window,
            unsafe_increase: llm.unsafe_allow_context_window_increase,
            requested_max_output,
            configured_min_output: llm.min_output_tokens,
            reasoning_reserve_tokens: llm.reasoning_reserve_tokens,
            safety_margin_min_tokens: history.safety_margin_min_tokens,
            safety_margin_ratio: history.safety_margin_ratio,
            // §14.3 step 2-3: the `max(1, W - I + 1)` underestimation figure is
            // telemetry, not `C`. Emergency recovery makes room via a
            // compaction epoch, not by inflating this margin. `admit` still
            // caps `M` at `floor(0.10 * W)`.
            calibration_margin: self.calibration_margin_for_admission(),
            component_bytes,
            framing: self.framing.clone(),
            image_count: prepared.image_count as u64,
            request_body: &prepared.request.request_body,
            estimate_reused_from: None,
            state_tail,
            state_tail_offset: prepared.state_tail_offset,
            handoff: prepared
                .handoff
                .as_ref()
                .map_or("", |(_, text)| text.as_str()),
            handoff_offset: prepared.handoff.as_ref().map(|(offset, _)| *offset),
        })
        .map_err(|err| TurnError::Provider(Box::new(provider_failure_from_provider_error(&err))))?;
        Ok(match decision {
            AdmissionDecision::Admit(estimate) => AdmissionOutcome::Admitted(Admitted {
                request_hash: estimate.request_hash,
                snapshot: estimate.snapshot,
                request_body: prepared.request.request_body.clone(),
                component_tokens: [
                    estimate.system_tokens,
                    estimate.tool_schema_tokens,
                    estimate.memory_bootstrap_tokens,
                    estimate.handoff_tokens,
                    estimate.retained_message_tokens,
                    estimate.state_graph_tokens,
                    estimate.active_tool_cycle_tokens,
                    estimate.continuation_tokens,
                    estimate.provider_framing_tokens,
                ],
            }),
            AdmissionDecision::ReduceOutput {
                new_max_output_tokens,
                ..
            } => AdmissionOutcome::ReduceOutput(new_max_output_tokens),
            AdmissionDecision::Reject { .. } => AdmissionOutcome::Reject,
        })
    }

    async fn run_tool_batch(
        &mut self,
        turn_id: TurnId,
        attempt_id: AttemptId,
        step_id: StepId,
        draft_calls: &[DraftCall],
    ) -> Result<Control, TurnError> {
        self.run_tool_batch_with_cancel(
            turn_id,
            attempt_id,
            step_id,
            draft_calls,
            self.cancel.clone(),
        )
        .await
    }

    async fn run_tool_batch_with_cancel(
        &mut self,
        turn_id: TurnId,
        attempt_id: AttemptId,
        step_id: StepId,
        draft_calls: &[DraftCall],
        cancel: CancellationToken,
    ) -> Result<Control, TurnError> {
        self.run_tool_batch_with_cancel_in(
            turn_id,
            attempt_id,
            step_id,
            draft_calls,
            cancel,
            RecoveryBatch::default(),
        )
        .await
    }

    async fn run_tool_batch_with_cancel_in(
        &mut self,
        turn_id: TurnId,
        attempt_id: AttemptId,
        step_id: StepId,
        draft_calls: &[DraftCall],
        cancel: CancellationToken,
        recovery: RecoveryBatch,
    ) -> Result<Control, TurnError> {
        if draft_calls
            .iter()
            .any(|call| HISTORY_TOOL_BATCHES_PROJECT.contains(&call.name.as_str()))
        {
            self.project_history_live();
        }
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
        let batch_id: ToolBatchId = match recovery.id {
            Some(id) => id,
            None => self.fresh()?,
        };
        let request = ToolBatchRequest {
            batch_id,
            session_id: self.session_id,
            turn_id,
            attempt_id,
            calls,
            origin: ToolCallOrigin::Model,
        };
        let fault_after_body = self.config.fault == LoopFault::AfterToolBodyBeforeFinish;
        let outcome = {
            let mut durable = DurableSession {
                log: &mut self.log,
                artifacts: &self.artifacts,
                ids: self.config.ids.as_ref(),
                clock: self.config.clock.as_ref(),
                session_id: self.session_id,
                step_id,
                fault_after_body,
                recovery_cancelled_calls: recovery.cancelled_calls,
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
        failure: &ProviderFailure,
    ) -> Result<(), TurnError> {
        self.append(
            Some(turn_id),
            Some(attempt_id),
            CanonicalEvent::AssistantAttemptFailed(AssistantAttemptFailed {
                purpose: ProviderAttemptPurpose::AssistantStep(purpose),
                error: failure.error.clone(),
                partial_output: PartialAssistantOutput {
                    blocks: failure
                        .partial_blocks
                        .iter()
                        .filter_map(partial_block_from_block)
                        .collect(),
                    provider_response_id: failure.provider_response_id.as_deref().and_then(|id| {
                        crate::protocol::id::ProviderResponseId::from_str_canonical(id).ok()
                    }),
                },
                observable_delta_emitted: failure.observable_delta,
                provider_may_have_completed: failure.may_have_completed,
                usage: failure.usage.clone(),
            }),
        )?;
        // The canonical diagnostic is durable with the attempt; surface it on
        // the eventual report (and clear it again if a retry succeeds).
        self.pending_diagnostic = Some(failure.error.clone());
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
        crate::crash_point::hit("turn.after_turn_committed");
        self.project_history_live();
        self.pending_diagnostic = None;
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
        self.project_history_live();
        Ok(self.report(Some(reason)))
    }

    fn report(&mut self, interruption: Option<InterruptionReason>) -> TurnReport {
        // The turn's own cause (`pending_diagnostic`) always wins. A committed
        // turn then prefers compaction, then projection, then the resume
        // diagnostic, so a stale resume failure cannot hide this turn's own
        // failure. An interrupted report carries `pending_diagnostic` and then
        // the resume diagnostic (session state, not a turn cause). Compaction
        // and projection stay out of interrupted reports. The resume
        // diagnostic is taken only when it is the one actually reported.
        let mut diagnostic = self.pending_diagnostic.clone();
        if interruption.is_none() {
            if diagnostic.is_none() {
                diagnostic = self.compaction_diagnostic.clone();
            }
            if diagnostic.is_none() {
                diagnostic = self.projection_diagnostic.clone();
            }
        }
        if diagnostic.is_none() {
            diagnostic = self.resume_projection_diagnostic.clone();
            if diagnostic.is_some() {
                self.resume_projection_diagnostic = None;
            }
        }
        TurnReport {
            interruption,
            admission_count: self.admissions,
            diagnostic,
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
                .process_event_in_place(event, Some(index + 1), Some(raw))
                .map_err(|err| TurnError::failed(format!("replay: {err}")))?;
        }
        Ok(replay)
    }

    /// Projects the persistent derived handle without a rebuild. An Invalid
    /// checkpoint cannot heal on this path or at resume (rebuild is a separate
    /// recovery operation), so this diagnostic repeats every turn. A success
    /// clears the turn-scoped slot, so a transient failure earlier in the turn
    /// is not reported once the projection has recovered.
    fn project_history_live(&mut self) {
        match crate::history::checkpoint::HistoryProjector::new(&self.history_db)
            .project_without_rebuild(&self.log)
        {
            Err(error) => {
                let diagnostic = projection_error(&error, &self.config.session_dir);
                self.projection_diagnostic = Some(diagnostic);
            }
            Ok(()) => {
                self.projection_diagnostic = None;
                // A healed derived database must not keep reporting the
                // resume failure.
                self.resume_projection_diagnostic = None;
            }
        }
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
            .map_err(|err| TurnError::Durability(format!("append: {err}")))?;
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
    /// Admitted component counts for §14.3 telemetry. Not an admission input.
    component_tokens: [u64; 9],
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

/// A failed/errored compaction keeps the original code, class, retryability,
/// HTTP status, and retry-after hint (none carry provider text or host paths)
/// but replaces the message with a fixed generic string, so no provider or
/// transport body ever reaches events or stderr.
/// Canonical diagnostic for a retained live epoch that stopped before a
/// durable attempt (`CompactionRunError`). Appendix A.5 supplies the code and
/// class where a row names one. `E_COMPACTION_UNAVAILABLE` is reserved for the
/// §14.4 stop, so a retained `COMPACTION_UNAVAILABLE` (`InFlight`,
/// `Unavailable`) does not use it. `Request` has no concrete provider error to
/// map, and `History` is not reported here. Those use `E_COMPACTION_EPOCH_FAILED`.
fn retained_epoch_diagnostic(
    error: &crate::compaction::activate::CompactionRunError,
) -> ProtocolError {
    use crate::compaction::activate::CompactionRunError;
    use crate::compaction::CompactionError;
    let (code, class) = match error {
        CompactionRunError::Selection(
            CompactionError::NoEligibleTurns | CompactionError::MissingTokenMass(_),
        ) => ("E_COMPACTION_RANGE_INVALID", ErrorClass::Validation),
        CompactionRunError::Selection(CompactionError::ArithmeticOverflow) => {
            ("E_ADMISSION_ACCOUNTING", ErrorClass::Internal)
        }
        CompactionRunError::Admission(_) => ("E_ACTIVE_TURN_TOO_LARGE", ErrorClass::ContextLength),
        CompactionRunError::Unavailable { .. }
        | CompactionRunError::InFlight
        | CompactionRunError::Request(_)
        | CompactionRunError::History(_) => ("E_COMPACTION_EPOCH_FAILED", ErrorClass::Internal),
    };
    ProtocolError {
        code: code.to_owned(),
        class,
        message: LIVE_COMPACTION_NOT_ACTIVATED_MESSAGE.to_owned(),
        retryable: false,
        http_status: None,
        retry_after_ms: None,
    }
}

fn safe_compaction_diagnostic(error: &ProtocolError) -> ProtocolError {
    ProtocolError {
        code: error.code.clone(),
        class: error.class.clone(),
        message: "live compaction did not activate; every turn retained".to_owned(),
        retryable: error.retryable,
        http_status: error.http_status,
        retry_after_ms: error.retry_after_ms,
    }
}

/// Resume projection failures are either a derived-cache problem or a
/// canonical-integrity problem.
///
/// Derived-projection (degrade, leave `history.db` in place): the codes
/// `checkpoint.rs` / `error.rs` use when the derived write or the stored
/// checkpoint cannot be applied, without claiming the event prefix or the
/// artifact tables are corrupt.
/// - `HISTORY_CHECKPOINT_INVALID` — `project_without_rebuild` refuses to rebuild
/// - `HISTORY_IO` — `io_err` / non-busy `map_sqlite` during the derived write
/// - `HISTORY_SQLITE_BUSY` — busy timeout on the derived database
/// - `HISTORY_SQLITE_PRAGMA_FAILED` — required SQLite behavior unavailable
/// - `HISTORY_INSECURE_PERMISSIONS` — private-file mode could not be set
///
/// Canonical-integrity (fatal): the codes those files use when the canonical
/// prefix or artifact bytes cannot be trusted, plus anything else (capsule
/// builders pass `err.code()` through, including `E_EVENT_SCHEMA_INVALID`).
/// - `HISTORY_CANONICAL_DB_CORRUPT` — `rebuild.rs` blob hash / reference checks
/// - `HISTORY_DANGLING_ARTIFACT` — finish event names a missing artifact row
/// - `HISTORY_EVENT_INTEGRITY` — replay does not match the derived rows, or
///   the checkpoint prefix hash does not parse
/// - `HISTORY_SCHEMA_UNSUPPORTED` — canonical redaction version cannot be applied
///
/// Unknown codes fail closed.
fn resume_projection_is_canonical_integrity(code: &str) -> bool {
    !matches!(
        code,
        "HISTORY_CHECKPOINT_INVALID"
            | "HISTORY_IO"
            | "HISTORY_SQLITE_BUSY"
            | "HISTORY_SQLITE_PRAGMA_FAILED"
            | "HISTORY_INSECURE_PERMISSIONS"
    )
}

/// Classification of a post-activation derived-projection failure.
fn projection_error(
    error: &crate::history::error::ArtifactError,
    session_dir: &Path,
) -> ProtocolError {
    let code = error.code();
    let class = match code {
        "HISTORY_SQLITE_BUSY" | "HISTORY_IO" | "HISTORY_SQLITE_PRAGMA_FAILED" => {
            ErrorClass::Persistence
        }
        "HISTORY_INSECURE_PERMISSIONS" => ErrorClass::Policy,
        "HISTORY_SCHEMA_UNSUPPORTED" => ErrorClass::Validation,
        // Invalid checkpoints require recovery, not a repeat of the live
        // projection. Unknown/replay integrity failures also fail closed.
        _ => ErrorClass::Integrity,
    };
    ProtocolError {
        code: code.to_owned(),
        class,
        message: error
            .message()
            .replace(session_dir.to_string_lossy().as_ref(), "<session>"),
        retryable: matches!(code, "HISTORY_SQLITE_BUSY" | "HISTORY_IO"),
        http_status: None,
        retry_after_ms: None,
    }
}

/// Canonical protocol error for a `ProviderError` raised during preparation
/// or admission (before any durable attempt exists).
pub fn provider_protocol_error(error: &crate::provider::openai::ProviderError) -> ProtocolError {
    use crate::provider::openai::ProviderErrorCode;
    let (code, class) = match error.code {
        ProviderErrorCode::AdmissionContextWindowUnknown => {
            ("E_ADMISSION_CONTEXT_WINDOW_UNKNOWN", ErrorClass::Validation)
        }
        ProviderErrorCode::AdmissionArithmeticOverflow
        | ProviderErrorCode::CompactionProfileInvalid
        | ProviderErrorCode::AdmissionStateTailMismatch
        | ProviderErrorCode::PersistenceFailed => ("E_ADMISSION_ACCOUNTING", ErrorClass::Internal),
        _ => {
            let mut mapped = error.to_protocol_error().unwrap_or_else(|| {
                ProtocolError::provider(
                    "E_PROVIDER_REQUEST_INVALID",
                    ErrorClass::InvalidRequest,
                    error.safe_message.clone(),
                    false,
                )
            });
            // `to_protocol_error` copies `safe_message` verbatim, so the
            // report-only detector has to run on this arm too: transport and
            // stream messages are the ones that can quote a URL or a peer
            // fragment, and nothing may reach events or stderr unredacted.
            mapped.message = redact_provider_message(&mapped.message);
            return mapped;
        }
    };
    ProtocolError {
        code: code.to_owned(),
        class,
        // Belt and braces: the P3D adapter already stores fixed safe messages,
        // but every provider message passes the report-only secret detector
        // before it can reach events or stderr.
        message: redact_provider_message(&error.safe_message),
        retryable: error.retryable,
        http_status: error.http_status,
        retry_after_ms: error.retry_after_ms,
    }
}

fn provider_failure_from_provider_error(
    error: &crate::provider::openai::ProviderError,
) -> ProviderFailure {
    ProviderFailure {
        error: provider_protocol_error(error),
        emission_crossed: false,
        observable_delta: false,
        partial_blocks: Vec::new(),
        provider_response_id: None,
        usage: ProviderUsage::default(),
        may_have_completed: false,
        cancelled: false,
        retry_after_ms: error.retry_after_ms,
    }
}

/// Prep/prepare-side failure from the legacy `StepProvider::prepare` seam or
/// a non-provider error. No emission is possible before the attempt starts.
fn prepare_failure(error: TurnError) -> ProviderFailure {
    match error {
        TurnError::Provider(failure) => *failure,
        TurnError::Failed(message) => ProviderFailure {
            error: ProtocolError::provider(
                "E_PROVIDER_REQUEST_INVALID",
                ErrorClass::InvalidRequest,
                redact_provider_message(&message),
                false,
            ),
            emission_crossed: false,
            observable_delta: false,
            partial_blocks: Vec::new(),
            provider_response_id: None,
            usage: ProviderUsage::default(),
            may_have_completed: false,
            cancelled: false,
            retry_after_ms: None,
        },
        other => ProviderFailure {
            error: ProtocolError::provider(
                "E_PROVIDER_REQUEST_INVALID",
                ErrorClass::InvalidRequest,
                redact_provider_message(&other.to_string()),
                false,
            ),
            emission_crossed: false,
            observable_delta: false,
            partial_blocks: Vec::new(),
            provider_response_id: None,
            usage: ProviderUsage::default(),
            may_have_completed: false,
            cancelled: false,
            retry_after_ms: None,
        },
    }
}

/// Post-attempt failure with no typed detail (draft conversion errors, legacy
/// `StepProvider::complete` errors). Never retryable.
fn output_failure(message: &str) -> ProviderFailure {
    ProviderFailure {
        error: ProtocolError::provider(
            "E_PROVIDER_OUTPUT_INVALID",
            ErrorClass::InvalidProviderOutput,
            redact_provider_message(message),
            false,
        ),
        emission_crossed: false,
        observable_delta: false,
        partial_blocks: Vec::new(),
        provider_response_id: None,
        usage: ProviderUsage::default(),
        may_have_completed: true,
        cancelled: false,
        retry_after_ms: None,
    }
}

/// Lossy projection for the durable partial-output record: a refusal has no
/// partial form and is represented by the accepted path instead.
fn partial_block_from_block(
    block: &AssistantBlock,
) -> Option<crate::protocol::events::PartialAssistantBlock> {
    use crate::protocol::events::PartialAssistantBlock;
    match block {
        AssistantBlock::Text(text) => Some(PartialAssistantBlock::Text(text.clone())),
        AssistantBlock::ReasoningSummary(summary) => {
            Some(PartialAssistantBlock::ReasoningSummary(summary.clone()))
        }
        AssistantBlock::ToolCall(call) => Some(PartialAssistantBlock::ToolCallFragment(
            crate::protocol::events::PartialToolCall {
                call_id: Some(call.call_id.clone()),
                name: Some(call.name.clone()),
                raw_arguments: call.raw_arguments.clone(),
            },
        )),
        AssistantBlock::Refusal(_) | AssistantBlock::Image(_) => None,
    }
}

fn has_durable_argument_marker(
    raw_arguments: &str,
    arguments: &serde_json::Map<String, Value>,
) -> bool {
    raw_arguments.contains("[REDACTED:")
        || serde_json::to_string(arguments)
            .map(|value| value.contains("[REDACTED:"))
            .unwrap_or(true)
}

// Proof is per changed leaf, not per call: one marked secret must not mask an
// unrelated unmarked rewrite elsewhere in the same argument object.
fn every_argument_change_is_marked(original: &Value, redacted: &Value) -> bool {
    match (original, redacted) {
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .get(key)
                        .is_some_and(|other| every_argument_change_is_marked(value, other))
                })
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(value, other)| every_argument_change_is_marked(value, other))
        }
        (Value::String(left), Value::String(right)) => {
            left == right
                || right.matches("[REDACTED:").count() > left.matches("[REDACTED:").count()
        }
        _ => original == redacted,
    }
}

#[cfg(test)]
mod argument_proof_tests {
    use super::every_argument_change_is_marked;
    use serde_json::json;

    #[test]
    fn proof_is_per_leaf_and_rejects_structural_or_unmarked_mutations() {
        let before = json!({"nested": ["plain", "secret"], "count": 1});
        assert!(every_argument_change_is_marked(&before, &before));
        assert!(every_argument_change_is_marked(
            &before,
            &json!({"nested": ["plain", "[REDACTED:aws-access-key]"], "count": 1})
        ));
        assert!(!every_argument_change_is_marked(
            &before,
            &json!({"nested": ["rewritten", "[REDACTED:aws-access-key]"], "count": 1})
        ));
        assert!(!every_argument_change_is_marked(
            &before,
            &json!({"nested": ["plain", "[REDACTED:aws-access-key]"]})
        ));
        assert!(!every_argument_change_is_marked(
            &json!("literal [REDACTED:note]"),
            &json!("rewritten [REDACTED:note]")
        ));
    }
}

/// Retry delay for the `retry_number`-th retry (1-based): the provider
/// `retry-after` hint when present, otherwise bounded jitter with a
/// 500 * 2^(n-1) cap, clamped to the 60s wall cap.
fn retry_backoff_delay_ms_for(
    clock: Arc<dyn Clock>,
    retry_number: u32,
    failure: &ProviderFailure,
) -> u64 {
    let headers: Vec<(String, String)> = failure
        .retry_after_ms
        .map(|ms| ("retry-after-ms".to_owned(), ms.to_string()))
        .into_iter()
        .collect();
    let now_ms = clock.now_ms();
    let seed = now_ms as u64 ^ ((retry_number as u64) << 32);
    let mut rng = |cap: u64| {
        if cap == 0 {
            0
        } else {
            seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) % cap
        }
    };
    crate::provider::openai::retry_delay_ms(retry_number, &headers, now_ms, &mut rng)
        .min(RETRY_WALL_CAP_MS)
}

/// Both arms of `provider_protocol_error` must run the report-only detector:
/// `ProviderError::to_protocol_error` copies `safe_message` verbatim, so the
/// common transport/stream arm would otherwise persist an unredacted message.
#[cfg(test)]
mod provider_error_redaction_tests {
    use super::provider_protocol_error;
    use crate::provider::openai::{ProviderError, ProviderErrorCode};

    const CANARY: &str = "sk-p3d-secret-key-value-should-not-survive";

    #[test]
    fn common_arm_redacts_a_message_that_quotes_a_credential() {
        let error = ProviderError::new(
            ProviderErrorCode::TransportError,
            "openai",
            "openai-chat-v1",
            format!("transport: connect failed with {CANARY}"),
        );
        let protocol = provider_protocol_error(&error);
        assert_eq!(protocol.code, "E_PROVIDER_STREAM");
        assert!(
            !protocol.message.contains(CANARY),
            "the common arm must redact before the message becomes durable: {}",
            protocol.message
        );
        assert!(
            protocol.message.contains("[REDACTED:"),
            "expected a redaction marker: {}",
            protocol.message
        );
    }

    #[test]
    fn overflow_arm_still_maps_to_admission_accounting() {
        let error = ProviderError::new(
            ProviderErrorCode::AdmissionArithmeticOverflow,
            "openai",
            "openai-chat-v1",
            "usable input underflow",
        );
        let protocol = provider_protocol_error(&error);
        assert_eq!(protocol.code, "E_ADMISSION_ACCOUNTING");
        assert_eq!(
            protocol.class,
            crate::protocol::errors::ErrorClass::Internal
        );
        assert_eq!(protocol.message, "usable input underflow");
    }
}

/// P3D send authorization: the uploaded buffer must be byte-for-byte the
/// canonical serialization the durable `request_hash` was computed over.
#[cfg(test)]
mod admitted_bytes_tests {
    use super::AdmittedRequest;
    use crate::protocol::hashes::calculate_request_hash;
    use crate::protocol::json::serialize_canonical;
    use serde_json::json;

    fn admitted(body: serde_json::Value) -> AdmittedRequest {
        let request_hash = calculate_request_hash(&body).expect("request hash");
        AdmittedRequest { body, request_hash }
    }

    #[test]
    fn canonical_bytes_authorize_and_mutations_never_do() {
        // A body where RFC 8785 and `serde_json::to_string` differ, so the
        // byte check is not trivially satisfied by either encoder: RFC 8785
        // writes the ECMAScript number form (`1`), `serde_json` writes `1.0`.
        let body = json!({
            "zeta": 1,
            "alpha": {"nested": [3, 2, 1], "flag": true},
            "temperature": 1.0,
            "gpt-5.6-sol": "model",
            "tools": [{"name": "shell", "parameters": {"type": "object"}}],
        });
        let canonical = serialize_canonical(&body).expect("canonical");
        let compact = serde_json::to_string(&body).expect("compact");
        assert!(
            compact.contains("1.0") && !String::from_utf8_lossy(&canonical).contains("1.0"),
            "the fixture distinguishes the two encoders: canonical={} compact={compact}",
            String::from_utf8_lossy(&canonical)
        );

        let admitted = admitted(body);
        admitted
            .authorize_bytes(&canonical)
            .expect("the canonical admitted bytes authorize");

        // The differently serialized value is not the admitted request.
        assert!(
            admitted.authorize_bytes(compact.as_bytes()).is_err(),
            "a value-level serialization is not the admitted bytes"
        );

        // A single flipped bit never reaches the socket.
        let mutated: Vec<u8> = canonical.iter().map(|byte| byte ^ 0x01).collect();
        let error = admitted
            .authorize_bytes(&mutated)
            .err()
            .expect("a mutated buffer is not the admitted request");
        assert!(
            error.to_string().contains("not the admitted request"),
            "unexpected error: {error}"
        );

        // Truncation and extension are refused too.
        assert!(admitted
            .authorize_bytes(&canonical[..canonical.len() - 1])
            .is_err());
        let mut extended = canonical.clone();
        extended.push(b' ');
        assert!(admitted.authorize_bytes(&extended).is_err());
    }

    #[test]
    fn a_different_value_never_authorizes() {
        let admitted = admitted(json!({"model": "gpt-5.6-sol"}));
        let other = serialize_canonical(&json!({"model": "gpt-5.6-sol-x"})).expect("canonical");
        assert!(
            admitted.authorize_bytes(&other).is_err(),
            "a different value is never the admitted request"
        );
    }
}

/// P3D retry policy (OpenAI §18.3): the delay for retry `n` uses the
/// 500 * 2^(n-1) cap, and no further attempt is scheduled once the accumulated
/// retry time plus the next delay reaches the 60s wall cap.
#[cfg(test)]
mod retry_policy_tests {
    use super::{retry_backoff_delay_ms_for, HeadlessLoop, RETRY_WALL_CAP_MS};
    use crate::clock::Clock;
    use crate::protocol::models::ProviderUsage;
    use crate::turn::ProviderFailure;
    use std::sync::Arc;

    struct FixedClock(i64);
    impl Clock for FixedClock {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    fn retryable_failure(retry_after_ms: Option<u64>) -> ProviderFailure {
        ProviderFailure {
            error: crate::protocol::errors::ProtocolError::provider(
                "E_PROVIDER_STREAM",
                crate::protocol::errors::ErrorClass::Transport,
                "server error",
                true,
            ),
            emission_crossed: false,
            observable_delta: false,
            partial_blocks: Vec::new(),
            provider_response_id: None,
            usage: ProviderUsage::default(),
            may_have_completed: false,
            cancelled: false,
            retry_after_ms,
        }
    }

    /// The loop reads its delay through this seam so the caps are assertable
    /// without a network round trip.
    fn delay(retry_number: u32, failure: &ProviderFailure) -> u64 {
        retry_backoff_delay_ms_for(
            Arc::new(FixedClock(1_700_000_000_000)),
            retry_number,
            failure,
        )
    }

    #[test]
    fn jitter_cap_doubles_per_retry() {
        // A fixed clock makes the seeded jitter deterministic; assert the caps
        // through the maximum each attempt may take.
        for (retry_number, cap) in [(1u32, 500u64), (2, 1_000), (3, 2_000)] {
            let mut observed = 0;
            for tick in 0..64u64 {
                let mut rng = |bound: u64| tick.wrapping_mul(2_654_435_761) % bound.max(1);
                let candidate = crate::provider::openai::retry_delay_ms(
                    retry_number,
                    &[],
                    1_700_000_000_000,
                    &mut rng,
                );
                observed = observed.max(candidate);
            }
            assert!(observed <= cap, "retry {retry_number} exceeded cap {cap}");
        }
        // The deterministic seeded path stays inside the same caps.
        let failure = retryable_failure(None);
        assert!(delay(1, &failure) <= 500);
        assert!(delay(2, &failure) <= 1_000);
        assert!(delay(3, &failure) <= 2_000);
    }

    #[test]
    fn sixty_seconds_of_retry_time_schedules_no_further_send() {
        // Two 30s retry-after hints fill the budget; the third send is refused.
        assert!(HeadlessLoop::retry_budget_allows(0, 30_000));
        assert!(!HeadlessLoop::retry_budget_allows(30_000, 30_000));
        assert!(!HeadlessLoop::retry_budget_allows(59_999, 1_000));
        assert!(HeadlessLoop::retry_budget_allows(59_999, 0));
        assert_eq!(RETRY_WALL_CAP_MS, 60_000);

        // A 30s hint is honored verbatim as the per-delay schedule.
        let hint = retryable_failure(Some(30_000));
        assert_eq!(delay(1, &hint), 30_000);
        assert!(!HeadlessLoop::retry_budget_allows(30_000, 30_000));
    }
}

#[allow(clippy::too_many_arguments)]
fn assistant_message_with(
    draft: &AssistantDraft,
    blocks_override: Option<Vec<AssistantBlock>>,
    phase: Option<crate::protocol::messages::AssistantPhase>,
    continuation: Option<crate::protocol::continuation::ProviderContinuation>,
    ids: &MonotonicUlidGenerator,
    turn_id: TurnId,
    step_id: StepId,
    model: &ModelSelection,
) -> Result<AssistantMessage, TurnError> {
    let blocks = match blocks_override {
        Some(blocks) => blocks
            .into_iter()
            .map(|block| match block {
                AssistantBlock::ToolCall(call) => {
                    sanitize_tool_call(call.call_id.as_str(), &call.name, call.arguments.clone())
                }
                other => Ok(other),
            })
            .collect::<Result<Vec<_>, TurnError>>()?,
        None => draft_to_blocks(draft)?,
    };
    if blocks.is_empty() {
        return Err(TurnError::failed("assistant step has no blocks"));
    }
    let has_tool_calls = blocks
        .iter()
        .any(|block| matches!(block, AssistantBlock::ToolCall(_)));
    match draft.finish_reason {
        FinishReason::ToolUse if !has_tool_calls => {
            return Err(TurnError::failed("tool use step has no calls"));
        }
        FinishReason::Stop | FinishReason::Length if has_tool_calls => {
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
        phase,
        blocks,
        finish_reason: draft.finish_reason.clone(),
        continuation,
        usage: draft.usage.clone(),
    })
}

fn draft_to_blocks(draft: &AssistantDraft) -> Result<Vec<AssistantBlock>, TurnError> {
    let mut blocks = Vec::new();
    if let Some(text) = &draft.text {
        if text.is_empty() {
            return Err(TurnError::failed("assistant text is empty"));
        }
        blocks.push(AssistantBlock::Text(TextBlock { text: text.clone() }));
    }
    for call in &draft.calls {
        blocks.push(sanitize_tool_call(
            &call.call_id,
            &call.name,
            call.arguments.clone(),
        )?);
    }
    Ok(blocks)
}

/// Validate, redact, and canonicalize one tool call at acceptance time. The
/// redaction proof is independent of the call's origin (draft or wire
/// adapter): an unmarked accepted call is safe to reconstruct only because
/// acceptance verified byte-equivalence.
fn sanitize_tool_call(
    call_id: &str,
    name: &str,
    arguments: serde_json::Map<String, Value>,
) -> Result<AssistantBlock, TurnError> {
    validate_tool_name(name).map_err(|err| TurnError::failed(err.to_string()))?;
    let original = Value::Object(arguments);
    let redacted =
        redact_json_v1(&original).map_err(|_| TurnError::failed("tool call redaction failed"))?;
    if !every_argument_change_is_marked(&original, &redacted.value) {
        return Err(TurnError::failed("tool call redaction proof missing"));
    }
    let Value::Object(arguments) = redacted.value else {
        return Err(TurnError::failed("tool call redaction failed"));
    };
    let raw_arguments = serialize_canonical_string(&Value::Object(arguments.clone()))
        .map_err(|err| TurnError::failed(err.to_string()))?;
    Ok(AssistantBlock::ToolCall(ToolCall {
        call_id: ToolCallId::from_str_canonical(call_id)
            .map_err(|err| TurnError::failed(err.to_string()))?,
        name: name.to_owned(),
        arguments,
        raw_arguments,
    }))
}

fn resolved_framing(config: &EffectiveConfigV1) -> FramingProfileV1 {
    framing_for(
        config.llm.provider.as_str(),
        config.llm.protocol.as_str(),
        config.llm.model.as_str(),
    )
}

/// Bundled framing profile for one provider/protocol/model, falling back to
/// the conservative generic profile. The compactor uses its own model's row.
pub(crate) fn framing_for(provider: &str, protocol: &str, model: &str) -> FramingProfileV1 {
    if let Ok(store) = TokenProfileStoreV1::load_bundled() {
        if let Ok(entry) = store.resolve(provider, protocol, model, None) {
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
    // The endpoint fingerprint identifies the provider endpoint, not the
    // model. Fall back to a digest of the raw base URL if normalization
    // rejects it (admission still fails later with a typed error).
    let endpoint = if config.llm.provider == "openrouter" {
        &config.providers.openrouter.base_url
    } else {
        &config.providers.openai.base_url
    };
    let fingerprint = crate::provider::endpoint_fingerprint(endpoint)
        .unwrap_or_else(|_| Sha256Digest::digest_bytes(endpoint.as_bytes()));
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

    #[test]
    fn projection_error_policy_distinguishes_transient_and_permanent_failures() {
        use crate::history::error::ArtifactError;
        use crate::protocol::errors::ErrorClass;
        for code in ["HISTORY_IO", "HISTORY_SQLITE_BUSY"] {
            let error = super::projection_error(
                &ArtifactError::new(code, "retry later"),
                std::path::Path::new("/session"),
            );
            assert!(error.retryable, "{code}");
            assert_eq!(error.class, ErrorClass::Persistence);
        }
        for (code, class) in [
            ("HISTORY_EVENT_INTEGRITY", ErrorClass::Integrity),
            ("HISTORY_CANONICAL_DB_CORRUPT", ErrorClass::Integrity),
            ("HISTORY_CHECKPOINT_INVALID", ErrorClass::Integrity),
            ("HISTORY_SCHEMA_UNSUPPORTED", ErrorClass::Validation),
            ("HISTORY_INSECURE_PERMISSIONS", ErrorClass::Policy),
            ("HISTORY_SQLITE_PRAGMA_FAILED", ErrorClass::Persistence),
            ("E_COMPACTION_RANGE_INVALID", ErrorClass::Integrity),
        ] {
            let error = super::projection_error(
                &ArtifactError::new(code, "bad data in /session/history.db"),
                std::path::Path::new("/session"),
            );
            assert!(!error.retryable, "{code}");
            assert_eq!(error.class, class, "{code}");
            assert!(!error.message.contains("/session"));
        }
    }

    #[test]
    fn resume_projection_failure_classifies_every_history_code() {
        // Every code `history/error.rs`, `checkpoint.rs`, and `rebuild.rs` can
        // surface from a projection, plus the History §13 table and the
        // projection-id passthrough. Derived codes degrade; the rest are fatal.
        let derived = [
            "HISTORY_CHECKPOINT_INVALID",
            "HISTORY_IO",
            "HISTORY_SQLITE_BUSY",
            "HISTORY_SQLITE_PRAGMA_FAILED",
            "HISTORY_INSECURE_PERMISSIONS",
        ];
        let canonical = [
            "HISTORY_CANONICAL_DB_CORRUPT",
            "HISTORY_DANGLING_ARTIFACT",
            "HISTORY_EVENT_INTEGRITY",
            "HISTORY_SCHEMA_UNSUPPORTED",
            "HISTORY_CANCELLED",
            "HISTORY_SESSION_LOCKED",
            "HISTORY_META_MISMATCH",
            "HISTORY_ARTIFACT_NOT_FOUND",
            "HISTORY_SOURCE_NOT_FOUND",
            "HISTORY_ARTIFACT_RANGE",
            "HISTORY_SELECTOR_UNSUPPORTED",
            "HISTORY_ARTIFACT_TOO_LARGE",
            "HISTORY_PREVIEW_BOUND",
            "HISTORY_JSON_POINTER",
            "HISTORY_REGEX_INVALID",
            "HISTORY_REGEX_UNSUPPORTED",
            "HISTORY_SEARCH_QUERY",
            "HISTORY_SEARCH_CURSOR_STALE",
            "HISTORY_ROLLBACK_CONFLICT",
            "HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN",
            "E_EVENT_SCHEMA_INVALID",
            "HISTORY_NOT_A_REAL_CODE",
        ];
        for code in derived {
            assert!(
                !super::resume_projection_is_canonical_integrity(code),
                "{code} is a derived-projection failure"
            );
        }
        for code in canonical {
            assert!(
                super::resume_projection_is_canonical_integrity(code),
                "{code} is a canonical-integrity failure"
            );
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
            home: dir.path().join("home"),
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

#[cfg(test)]
mod live_compaction_decision_tests {
    use super::{wants_live_compaction, TurnError};
    use std::cell::Cell;

    const COMPACT_AT: f64 = 0.8;
    const CLEAR_AT: f64 = 0.6;

    /// Runs the decision and reports whether the whole-log candidate
    /// projection was evaluated.
    fn decide(fill_ppm: Option<u64>, candidate: bool) -> (bool, bool) {
        let called = Cell::new(false);
        let wanted = wants_live_compaction(fill_ppm, COMPACT_AT, CLEAR_AT, || {
            called.set(true);
            Ok(candidate)
        })
        .unwrap();
        (wanted, called.get())
    }

    #[test]
    fn below_the_fill_trigger_skips_the_candidate_projection() {
        for fill in [0, 1, 600_000, 799_999] {
            assert_eq!(decide(Some(fill), true), (false, false), "fill {fill}");
        }
    }

    #[test]
    fn at_or_above_the_trigger_launches_only_with_a_candidate() {
        for fill in [800_000, 950_000, 1_200_000] {
            assert_eq!(decide(Some(fill), true), (true, true), "fill {fill}");
            assert_eq!(decide(Some(fill), false), (false, true), "fill {fill}");
        }
    }

    #[test]
    fn hard_ceiling_always_checks_the_candidate() {
        assert_eq!(decide(None, true), (true, true));
        assert_eq!(decide(None, false), (false, true));
    }

    #[test]
    fn invalid_thresholds_never_project() {
        let called = Cell::new(false);
        let wanted = wants_live_compaction(Some(900_000), 0.5, 0.9, || {
            called.set(true);
            Ok(true)
        })
        .unwrap();
        assert!(!wanted);
        assert!(!called.get());
    }

    #[test]
    fn candidate_errors_propagate_once_evaluated() {
        let error = wants_live_compaction(Some(900_000), COMPACT_AT, CLEAR_AT, || {
            Err(TurnError::failed("projection failed"))
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "projection failed");
    }
}

#[cfg(test)]
mod live_projection_regression_tests {
    use super::*;
    use crate::config::build_defaults;
    use crate::credentials::store::{
        credentials_path, save_store, upsert_credential, CredentialStoreV1,
    };
    use crate::id::{IdGenerationError, RandomSource};
    use crate::tools::{
        ToolAdapter, ToolCapabilities, ToolError, ToolExecutionContext, ToolIdempotency,
        ToolInspectContext, ToolIntent, ToolMutation, TypedTool,
    };
    use rusqlite::OptionalExtension;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::Mutex;

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

    fn test_config(dir: &std::path::Path) -> LoopConfig {
        std::fs::create_dir_all(dir.join("home")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.join("home"), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let mut store = CredentialStoreV1::empty();
        upsert_credential(&mut store, "openai", "p5-secret".into(), 1_700_000_000_000).unwrap();
        save_store(&credentials_path(&dir.join("home")), &store).unwrap();
        let mut effective = build_defaults(PathBuf::from("/praana-home").as_path());
        effective.turn.max_steps = 4;
        effective.turn.max_attempts = 3;
        effective.llm.context_window = 128_000;
        effective.llm.provider = "scripted".into();
        effective.llm.protocol = "scripted-v1".into();
        effective.llm.model = "fake".into();
        effective.llm.min_output_tokens = 16;
        effective.llm.max_output_tokens = 256;
        effective.history.safety_margin_min_tokens = 0;
        effective.history.safety_margin_ratio = 0.0;
        effective.tools.max_parallel_calls = 2;
        LoopConfig {
            home: dir.join("home"),
            session_dir: dir.join("session"),
            workspace: dir.join("work"),
            config: effective,
            clock: Arc::new(FixedClock(1_700_000_000_000)),
            ids: Arc::new(MonotonicUlidGenerator::new(
                Arc::new(FixedClock(1_700_000_000_000)),
                Arc::new(crate::clock::ThreadSleeper),
                Box::new(SeqRandom(1)),
            )),
            fault: LoopFault::None,
            extra_tools: vec![ToolAdapter::arc(DerivedDbProbe).unwrap()],
        }
    }

    struct Scripted {
        steps: Mutex<VecDeque<ScriptedStep>>,
    }

    impl Scripted {
        fn new(steps: Vec<ScriptedStep>) -> Self {
            Self {
                steps: Mutex::new(steps.into()),
            }
        }
    }

    fn usage(n: u64) -> ProviderUsage {
        ProviderUsage {
            input_tokens: n,
            output_tokens: 1,
            reasoning_tokens: 0,
            total_tokens: n + 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
        }
    }

    fn text_step(text: &str) -> ScriptedStep {
        ScriptedStep {
            text: Some(text.to_owned()),
            calls: Vec::new(),
            finish: FinishReason::Stop,
            usage: usage(1),
        }
    }

    fn tool_step(id: &str, name: &str, args: Value) -> ScriptedStep {
        let mut arguments = serde_json::Map::new();
        if let Value::Object(map) = args {
            arguments = map;
        }
        ScriptedStep {
            text: None,
            calls: vec![DraftCall {
                call_id: id.into(),
                name: name.into(),
                arguments,
            }],
            finish: FinishReason::ToolUse,
            usage: usage(3),
        }
    }

    #[async_trait]
    impl StepProvider for Scripted {
        fn prepare(&self, _step_index: u32) -> Result<PreparedRequest, TurnError> {
            Ok(PreparedRequest {
                request_body: json!({"scripted": true}),
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
            let step = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted step");
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

    fn read_events(session_dir: &Path) -> Vec<Value> {
        std::fs::read_to_string(session_dir.join("events.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn events_of_kind(session_dir: &Path, kind: &str) -> Vec<Value> {
        read_events(session_dir)
            .into_iter()
            .filter(|event| event["event"]["kind"] == kind)
            .collect()
    }

    fn find_value<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
        match value {
            Value::Object(map) => {
                if let Some(found) = map.get(key) {
                    return Some(found);
                }
                map.values().find_map(|child| find_value(child, key))
            }
            Value::Array(items) => items.iter().find_map(|item| find_value(item, key)),
            _ => None,
        }
    }

    fn last_tool_result_dto(session_dir: &Path, tool: &str) -> Value {
        let event = events_of_kind(session_dir, "tool_execution_finished")
            .into_iter()
            .rev()
            .find(|event| event["event"]["data"]["result"]["tool_name"] == tool)
            .expect("durable tool result");
        let text = event["event"]["data"]["result"]["body"]["content"]["data"]["text"]
            .as_str()
            .expect("inline tool result");
        serde_json::from_str(text).expect("tool result DTO JSON")
    }

    fn inject_projection_trigger(session_dir: &Path, message: &str) {
        let conn = rusqlite::Connection::open(session_dir.join("history.db")).unwrap();
        conn.execute_batch(&format!(
            "CREATE TRIGGER IF NOT EXISTS fail_history_projection BEFORE INSERT ON projection_checkpoints \
             WHEN NEW.projection_name = 'history_derived' \
             BEGIN SELECT RAISE(ABORT, '{message}'); END;"
        ))
        .unwrap();
    }

    fn drop_projection_trigger(session_dir: &Path) {
        let conn = rusqlite::Connection::open(session_dir.join("history.db")).unwrap();
        conn.execute_batch("DROP TRIGGER IF EXISTS fail_history_projection")
            .unwrap();
    }

    fn checkpoint_applied_through(session_dir: &Path) -> Option<i64> {
        let conn = rusqlite::Connection::open(session_dir.join("history.db")).unwrap();
        conn.query_row(
            "SELECT applied_through_sequence FROM projection_checkpoints \
             WHERE projection_name = 'history_derived'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    fn event_line_count(session_dir: &Path) -> u64 {
        std::fs::read_to_string(session_dir.join("events.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count() as u64
    }

    /// Test-only derived-db probe: reads the checkpoint cursor or drops the
    /// injected projection-failure trigger, so a test can observe whether a
    /// batch ran the live projection before its tools executed.
    struct DerivedDbProbe;

    #[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct DerivedDbProbeInput {
        op: String,
    }

    #[derive(Debug, serde::Serialize, schemars::JsonSchema)]
    struct DerivedDbProbeOutput {
        applied_through_sequence: Option<u64>,
        current_sequence: Option<u64>,
        projection_name: String,
    }

    #[async_trait]
    impl TypedTool for DerivedDbProbe {
        type Input = DerivedDbProbeInput;
        type Output = DerivedDbProbeOutput;
        const NAME: &'static str = "derived_db_probe";
        const ORDER: u16 = 150;
        const DESCRIPTION: &'static str = "test-only derived history db probe";

        fn static_capabilities(&self) -> ToolCapabilities {
            ToolCapabilities::empty()
        }

        fn inspect(
            &self,
            input: &DerivedDbProbeInput,
            _: &ToolInspectContext,
        ) -> Result<ToolIntent, ToolError> {
            Ok(ToolIntent {
                mutation: match input.op.as_str() {
                    "read_checkpoint_cursor" => ToolMutation::PureCompute,
                    _ => ToolMutation::SessionState,
                },
                path_accesses: Vec::new(),
                command: None,
                risk_facts: Vec::new(),
                timeout_ms: 5_000,
                idempotency: ToolIdempotency::NonIdempotent,
                planned: Vec::new(),
            })
        }

        async fn execute(
            &self,
            context: ToolExecutionContext,
            input: DerivedDbProbeInput,
            _: CancellationToken,
        ) -> Result<DerivedDbProbeOutput, ToolError> {
            let conn = rusqlite::Connection::open(context.session_dir.join("history.db")).map_err(
                |error| {
                    ToolError::new(crate::tools::ToolErrorCode::ToolInternal, error.to_string())
                },
            )?;
            match input.op.as_str() {
                "read_checkpoint_cursor" => {
                    let applied_through_sequence = conn
                        .query_row(
                            "SELECT applied_through_sequence FROM projection_checkpoints \
                             WHERE projection_name = ?1",
                            ["history_derived"],
                            |row| row.get::<_, i64>(0),
                        )
                        .optional()
                        .map_err(|error| {
                            ToolError::new(
                                crate::tools::ToolErrorCode::ToolInternal,
                                error.to_string(),
                            )
                        })?
                        .map(|sequence| sequence as u64);
                    Ok(DerivedDbProbeOutput {
                        applied_through_sequence,
                        current_sequence: Some(event_line_count(&context.session_dir)),
                        projection_name: "history_derived".to_owned(),
                    })
                }
                "drop_projection_trigger" => {
                    conn.execute_batch("DROP TRIGGER IF EXISTS fail_history_projection")
                        .map_err(|error| {
                            ToolError::new(
                                crate::tools::ToolErrorCode::ToolInternal,
                                error.to_string(),
                            )
                        })?;
                    Ok(DerivedDbProbeOutput {
                        applied_through_sequence: None,
                        current_sequence: None,
                        projection_name: "history_derived".to_owned(),
                    })
                }
                other => Err(ToolError::new(
                    crate::tools::ToolErrorCode::ToolValidationFailed,
                    format!("unknown probe op: {other}"),
                )),
            }
        }
    }

    #[tokio::test]
    async fn retrieve_only_batch_does_not_run_the_pre_batch_projection() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let cfg = test_config(dir.path());
        let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();

        let seed = Scripted::new(vec![text_step("seed marker")]);
        assert!(loop_
            .run_turn("seed turn", &seed)
            .await
            .unwrap()
            .interruption
            .is_none());

        // Create an artifact in a turn whose commit projection succeeds.
        let artifact_turn = Scripted::new(vec![
            tool_step(
                "call-sh",
                "shell",
                json!({"command": "yes a | head -c 5000", "timeout_ms": 5000}),
            ),
            text_step("artifact made"),
        ]);
        assert!(loop_
            .run_turn("artifact turn", &artifact_turn)
            .await
            .unwrap()
            .interruption
            .is_none());
        let artifact_id = find_value(
            &events_of_kind(&cfg.session_dir, "tool_execution_finished")
                .into_iter()
                .rev()
                .find(|event| event["event"]["data"]["result"]["tool_name"] == "shell")
                .expect("shell finish event"),
            "artifact_id",
        )
        .expect("artifact id")
        .as_str()
        .unwrap()
        .to_owned();

        // A stale turn whose commit projection fails leaves the derived db
        // lagging behind the log.
        inject_projection_trigger(&cfg.session_dir, "injected projection failure");
        let stale = Scripted::new(vec![text_step("stale marker")]);
        let stale_report = loop_.run_turn("stale turn", &stale).await.unwrap();
        assert_eq!(
            stale_report.diagnostic.as_ref().map(|d| d.code.as_str()),
            Some("HISTORY_IO"),
            "{stale_report:?}"
        );
        drop_projection_trigger(&cfg.session_dir);

        let lagging_cursor = checkpoint_applied_through(&cfg.session_dir)
            .expect("checkpoint row from the earlier projections");
        let log_tail = event_line_count(&cfg.session_dir);
        assert!(
            lagging_cursor < log_tail as i64,
            "precondition: stale turn left the checkpoint lagging ({lagging_cursor} < {log_tail})"
        );

        // A retrieve-only batch must NOT run the pre-batch projection: the
        // probe tool in the same batch still sees the lagging checkpoint,
        // while the artifact stays retrievable from publish-written tables.
        let probe = Scripted::new(vec![
            tool_step(
                "call-retrieve",
                "retrieve_artifact",
                json!({"artifact_id": artifact_id}),
            ),
            tool_step(
                "call-probe",
                "derived_db_probe",
                json!({"op": "read_checkpoint_cursor"}),
            ),
            text_step("artifact probed"),
        ]);
        let probe_report = loop_.run_turn("probe artifact", &probe).await.unwrap();
        assert!(probe_report.interruption.is_none(), "{probe_report:?}");
        let artifact = last_tool_result_dto(&cfg.session_dir, "retrieve_artifact");
        let text = artifact["data"]["artifact"]["content"]["data"]
            .as_str()
            .unwrap();
        assert!(
            text.contains('a'),
            "artifact text is retrievable: {artifact}"
        );
        let probed = last_tool_result_dto(&cfg.session_dir, "derived_db_probe");
        assert_eq!(
            probed["data"]["applied_through_sequence"].as_u64(),
            Some(lagging_cursor as u64),
            "a retrieve-only batch must not run the pre-batch projection: {probed}"
        );
        assert!(
            probed["data"]["applied_through_sequence"].as_u64().unwrap() < log_tail,
            "checkpoint stays lagging through a retrieve-only batch: {probed}"
        );
    }

    // -----------------------------------------------------------------------
    // Minimal local fake compactor: answers the one durable request with a
    // schema-valid candidate citing the first source-turn message, so a real
    // `ConfiguredCompactor` can activate without any external network.
    // -----------------------------------------------------------------------

    const CONTROL_OPEN: &str = "[PRAANA:INTERNAL_COMPACTION_CONTROL]\n";
    const CONTROL_CLOSE: &str = "\n[/PRAANA:INTERNAL_COMPACTION_CONTROL]\n";
    const FAKE_MODEL: &str = "gpt-5.6-sol";

    fn read_request(stream: &mut TcpStream) -> (String, String) {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 8192];
        let split = loop {
            let n = stream.read(&mut tmp).unwrap_or(0);
            if n == 0 {
                return (String::new(), String::new());
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(split) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break split;
            }
        };
        let headers = String::from_utf8_lossy(&buf[..split]).to_string();
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while buf.len() < split + 4 + length {
            let n = stream.read(&mut tmp).unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        (
            headers,
            String::from_utf8_lossy(&buf[split + 4..]).to_string(),
        )
    }

    fn http_ok_sse(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 X\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn responses_sse(text: &str) -> String {
        let delta = serde_json::to_string(text).unwrap();
        format!(
            "event: response.created\ndata: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_c\",\"model\":\"{FAKE_MODEL}\"}}}}\n\n\
event: response.output_item.added\ndata: {{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{{\"type\":\"message\",\"id\":\"msg_c\",\"phase\":\"final_answer\"}}}}\n\n\
event: response.output_text.delta\ndata: {{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":{delta}}}\n\n\
event: response.output_text.done\ndata: {{\"type\":\"response.output_text.done\",\"output_index\":0,\"text\":{delta}}}\n\n\
event: response.output_item.done\ndata: {{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{{\"type\":\"message\",\"id\":\"msg_c\"}}}}\n\n\
event: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_c\",\"status\":\"completed\",\"output\":[{{\"type\":\"message\",\"id\":\"msg_c\"}}],\"usage\":{{\"input_tokens\":2,\"output_tokens\":1,\"total_tokens\":3}}}}}}\n\n"
        )
    }

    fn control_of(body: &Value) -> Option<Value> {
        let items = body.get("input")?.as_array()?;
        items.iter().find_map(|item| {
            let text = item.pointer("/content/0/text")?.as_str()?;
            let inner = text
                .strip_prefix(CONTROL_OPEN)?
                .strip_suffix(CONTROL_CLOSE)?;
            serde_json::from_str(inner).ok()
        })
    }

    /// A candidate whose only cited evidence is the first source-turn message.
    fn valid_candidate(control: &Value) -> String {
        let cited: Vec<String> = control["source_turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|turn| turn["messages"][0]["event_id"].as_str().unwrap().to_owned())
            .collect();
        let evidence = json!({"event_ids": cited, "artifact_ids": [], "state_ids": [], "summary_segment_ids": []});
        let mut candidate: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/compaction_v1/candidate_empty.json"
        ))
        .unwrap();
        let statement = json!({
            "text": "epoch one unique archived detail",
            "confidence": "direct",
            "evidence": evidence,
            "uncertainty": null
        });
        candidate["segment"]["user_goals"] = json!([statement.clone()]);
        candidate["handoff"]["current_goals"] = json!([json!({
            "text": "epoch one handoff context",
            "confidence": "direct",
            "evidence": evidence,
            "uncertainty": null
        })]);
        serde_json::to_string(&candidate).unwrap()
    }

    struct MiniFake {
        addr: std::net::SocketAddr,
        _thread: std::thread::JoinHandle<()>,
    }

    impl MiniFake {
        fn spawn(session_dir: &Path) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let session_dir = session_dir.to_path_buf();
            let _thread = std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { break };
                    let (_headers, body) = read_request(&mut stream);
                    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    let response = match control_of(&parsed) {
                        Some(control) => http_ok_sse(&responses_sse(&valid_candidate(&control))),
                        None => http_ok_sse("not a compactor request"),
                    };
                    let _ = stream.write_all(&response);
                    let _ = stream.flush();
                }
            });
            let _ = session_dir;
            Self { addr, _thread }
        }
    }

    #[tokio::test]
    async fn compaction_diagnostic_is_cleared_when_an_epoch_activates() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let cfg = test_config(dir.path());
        let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
        let seed = Scripted::new(vec![text_step("seed marker")]);
        assert!(loop_
            .run_turn("seed turn", &seed)
            .await
            .unwrap()
            .interruption
            .is_none());

        let fake = MiniFake::spawn(&cfg.session_dir);
        let compactor = crate::compaction::activate::ConfiguredCompactor {
            provider: "openai".into(),
            protocol: crate::provider::registry::ProviderProtocol::Responses,
            model: FAKE_MODEL.into(),
            base_url: format!("http://{}/v1", fake.addr),
            extra_headers: BTreeMap::new(),
            max_output_tokens: 4096,
            timeout_ms: 5_000,
            profile: crate::provider::profile::ModelCapabilityProfile {
                profile_version: "test-v1".into(),
                profile_source_sha256: Sha256Digest::digest_bytes(b"test-profile"),
                catalog_cache_sha256: None,
                provider: "openai".into(),
                protocol: "openai-responses-v1".into(),
                model_pattern: FAKE_MODEL.into(),
                model_revision: None,
                context_window_tokens: 128_000,
                max_output_tokens: 4096,
                min_output_tokens: 16,
                reasoning_accounting:
                    crate::provider::profile::ReasoningAccounting::IncludedInOutputLimit,
                reasoning_context:
                    crate::provider::profile::ReasoningContextCapability::Unsupported,
                tokenizer: crate::provider::profile::TokenizerCapability::ConservativeGeneric {
                    estimator_id: "praana-generic-unicode-15.1-v1".into(),
                },
                framing_profile_id: "adapter-estimate:generic:default:v1".into(),
                reasoning_efforts: vec![],
                parallel_tools: true,
                strict_json_schema: true,
                temperature_with_reasoning: false,
                image_input: crate::provider::profile::ImageInputCapability::Unsupported,
                endpoint_fingerprint: Sha256Digest::digest_bytes(b"test"),
                self_compaction: crate::provider::profile::SelfCompactionCapability::Unvalidated,
                continuation_after_internal_request: false,
            },
            framing: crate::token::FramingProfileV1 {
                framing_profile_schema_version: 1,
                framing_profile_id: "compaction-test".to_owned(),
                fixed_tokens: 0,
                per_item_tokens: 0,
                item_count: 0,
                additional_tokens: 0,
            },
            selection: ModelSelection {
                provider: "openai".into(),
                protocol: "openai-responses-v1".into(),
                model: FAKE_MODEL.into(),
                model_revision: None,
                model_family: FAKE_MODEL.into(),
                endpoint_fingerprint: Sha256Digest::digest_bytes(b"test"),
                reasoning_effort: ReasoningEffort::Medium,
            },
            config_id: "unit-test".into(),
            home: cfg.home.clone(),
            client: reqwest::Client::new(),
            env: Some(BTreeMap::new()),
        };

        // A failed epoch earlier in the turn left the slot populated; an epoch
        // that then activates must clear it so the committed report does not
        // read the recovered turn as failed.
        loop_.compaction_diagnostic = Some(ProtocolError {
            code: "E_PROVIDER_STREAM".to_owned(),
            class: ErrorClass::Transport,
            message: LIVE_COMPACTION_NOT_ACTIVATED_MESSAGE.to_owned(),
            retryable: true,
            http_status: Some(500),
            retry_after_ms: None,
        });
        loop_.set_compactor(Some(compactor));
        let epoch = loop_.live_compaction_epoch().await.unwrap();
        assert!(matches!(epoch, LiveEpoch::Activated), "{epoch:?}");
        assert!(
            loop_.compaction_diagnostic.is_none(),
            "an activated epoch clears the turn-scoped compaction failure"
        );
    }

    fn unit_compactor(
        cfg: &LoopConfig,
        window: u64,
    ) -> crate::compaction::activate::ConfiguredCompactor {
        crate::compaction::activate::ConfiguredCompactor {
            provider: "openai".into(),
            protocol: crate::provider::registry::ProviderProtocol::Responses,
            model: FAKE_MODEL.into(),
            base_url: "http://127.0.0.1:9/v1".into(),
            extra_headers: BTreeMap::new(),
            max_output_tokens: 4096,
            timeout_ms: 5_000,
            profile: crate::provider::profile::ModelCapabilityProfile {
                profile_version: "test-v1".into(),
                profile_source_sha256: Sha256Digest::digest_bytes(b"test-profile"),
                catalog_cache_sha256: None,
                provider: "openai".into(),
                protocol: "openai-responses-v1".into(),
                model_pattern: FAKE_MODEL.into(),
                model_revision: None,
                context_window_tokens: window,
                max_output_tokens: 4096,
                min_output_tokens: 16,
                reasoning_accounting:
                    crate::provider::profile::ReasoningAccounting::IncludedInOutputLimit,
                reasoning_context:
                    crate::provider::profile::ReasoningContextCapability::Unsupported,
                tokenizer: crate::provider::profile::TokenizerCapability::ConservativeGeneric {
                    estimator_id: "praana-generic-unicode-15.1-v1".into(),
                },
                framing_profile_id: "adapter-estimate:generic:default:v1".into(),
                reasoning_efforts: vec![],
                parallel_tools: true,
                strict_json_schema: true,
                temperature_with_reasoning: false,
                image_input: crate::provider::profile::ImageInputCapability::Unsupported,
                endpoint_fingerprint: Sha256Digest::digest_bytes(b"test"),
                self_compaction: crate::provider::profile::SelfCompactionCapability::Unvalidated,
                continuation_after_internal_request: false,
            },
            framing: crate::token::FramingProfileV1 {
                framing_profile_schema_version: 1,
                framing_profile_id: "compaction-test".to_owned(),
                fixed_tokens: 0,
                per_item_tokens: 0,
                item_count: 0,
                additional_tokens: 0,
            },
            selection: ModelSelection {
                provider: "openai".into(),
                protocol: "openai-responses-v1".into(),
                model: FAKE_MODEL.into(),
                model_revision: None,
                model_family: FAKE_MODEL.into(),
                endpoint_fingerprint: Sha256Digest::digest_bytes(b"test"),
                reasoning_effort: ReasoningEffort::Medium,
            },
            config_id: "unit-test".into(),
            home: cfg.home.clone(),
            client: reqwest::Client::new(),
            env: Some(BTreeMap::new()),
        }
    }

    #[tokio::test]
    async fn compact_now_activation_clears_the_compaction_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let cfg = test_config(dir.path());
        let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
        let seed = Scripted::new(vec![text_step("seed marker")]);
        assert!(loop_
            .run_turn("seed turn", &seed)
            .await
            .unwrap()
            .interruption
            .is_none());

        let fake = MiniFake::spawn(&cfg.session_dir);
        let mut compactor = unit_compactor(&cfg, 128_000);
        compactor.base_url = format!("http://{}/v1", fake.addr);
        loop_.compaction_diagnostic = Some(ProtocolError {
            code: "E_PROVIDER_STREAM".to_owned(),
            class: ErrorClass::Transport,
            message: LIVE_COMPACTION_NOT_ACTIVATED_MESSAGE.to_owned(),
            retryable: true,
            http_status: Some(500),
            retry_after_ms: None,
        });
        let outcome = loop_.compact_now(&compactor).await.unwrap();
        assert!(
            matches!(
                outcome,
                crate::compaction::activate::CompactionOutcome::Activated { .. }
            ),
            "compact_now activated: {outcome:?}"
        );
        // begin_turn would clear the slot anyway. Observe the report first.
        let report = loop_.report(None);
        assert!(
            report.diagnostic.is_none(),
            "compact_now activation clears the compaction failure: {report:?}"
        );
    }

    #[tokio::test]
    async fn retained_inflight_epoch_is_not_the_unavailable_stop() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let cfg = test_config(dir.path());
        let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
        let seed = Scripted::new(vec![text_step("seed marker")]);
        assert!(loop_
            .run_turn("seed turn", &seed)
            .await
            .unwrap()
            .interruption
            .is_none());

        let compactor = unit_compactor(&cfg, 128_000);
        {
            let session_id = loop_.session_id;
            let mut ctx = crate::compaction::activate::ActivationContext {
                log: &mut loop_.log,
                ids: loop_.config.ids.as_ref(),
                clock: loop_.config.clock.as_ref(),
                session_id,
                config: &loop_.config.config,
                framing: &loop_.framing,
            };
            let started = crate::compaction::activate::begin(&mut ctx, &compactor, None)
                .expect("an open compaction attempt is durable");
            drop(started);
        }
        loop_.set_compactor(Some(compactor));
        let epoch = loop_.live_compaction_epoch().await.unwrap();
        assert!(
            matches!(epoch, LiveEpoch::Retained),
            "an in-flight epoch retains the turn: {epoch:?}"
        );
        let diagnostic = loop_
            .compaction_diagnostic
            .clone()
            .expect("the retained epoch records a diagnostic");
        assert_ne!(
            diagnostic.code, "E_COMPACTION_UNAVAILABLE",
            "{diagnostic:?}"
        );
        assert_eq!(
            diagnostic.code, "E_COMPACTION_EPOCH_FAILED",
            "{diagnostic:?}"
        );
        assert_eq!(diagnostic.class, ErrorClass::Internal);
        assert_eq!(diagnostic.message, LIVE_COMPACTION_NOT_ACTIVATED_MESSAGE);
        assert!(
            loop_.compaction_unavailable.is_none(),
            "a retained epoch must not stop admission"
        );

        let current = Scripted::new(vec![text_step("request still sent")]);
        let report = loop_
            .run_turn("request still sent", &current)
            .await
            .unwrap();
        assert!(
            report.interruption.is_none(),
            "the assistant request is still sent: {report:?}"
        );
    }

    #[tokio::test]
    async fn retained_admission_failure_is_not_the_unavailable_stop() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let cfg = test_config(dir.path());
        let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
        let seed = Scripted::new(vec![text_step(&"seed ".repeat(400))]);
        assert!(loop_
            .run_turn("seed turn", &seed)
            .await
            .unwrap()
            .interruption
            .is_none());

        // The scripted request body is tiny. A small session window makes its
        // fill cross the proactive trigger while the request itself still fits,
        // so the epoch runs and the assistant request is still sent.
        loop_.config.config.llm.context_window = 2_000;
        loop_.config.config.history.compact_at = 0.0002;
        loop_.config.config.history.compact_clear_at = 0.0001;
        let mut compactor = unit_compactor(&cfg, 32);
        compactor.max_output_tokens = 4_096;
        loop_.set_compactor(Some(compactor));

        let current = Scripted::new(vec![text_step("request still sent")]);
        let report = loop_.run_turn("current turn", &current).await.unwrap();
        assert!(
            report.interruption.is_none(),
            "the assistant request is still sent: {report:?}"
        );
        let diagnostic = report
            .diagnostic
            .expect("the retained admission failure is reported");
        assert_ne!(
            diagnostic.code, "E_COMPACTION_UNAVAILABLE",
            "{diagnostic:?}"
        );
        assert_eq!(diagnostic.code, "E_ACTIVE_TURN_TOO_LARGE", "{diagnostic:?}");
        assert_eq!(diagnostic.class, ErrorClass::ContextLength);
        assert_eq!(diagnostic.message, LIVE_COMPACTION_NOT_ACTIVATED_MESSAGE);
        assert!(loop_.compaction_unavailable.is_none());
    }

    fn parked_resume_diagnostic(code: &str) -> ProtocolError {
        ProtocolError {
            code: code.to_owned(),
            class: ErrorClass::Persistence,
            message: RESUME_PROJECTION_DIAGNOSTIC_MESSAGE.to_owned(),
            retryable: true,
            http_status: None,
            retry_after_ms: None,
        }
    }

    #[tokio::test]
    async fn degraded_resume_diagnostic_is_not_retryable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let cfg = test_config(dir.path());
        let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
        let seed = Scripted::new(vec![text_step("seed marker")]);
        assert!(loop_
            .run_turn("seed turn", &seed)
            .await
            .unwrap()
            .interruption
            .is_none());
        drop(loop_);

        {
            let conn = rusqlite::Connection::open(cfg.session_dir.join("history.db")).unwrap();
            conn.execute_batch(
                "DELETE FROM projection_checkpoints WHERE projection_name = 'history_derived'",
            )
            .unwrap();
            conn.execute_batch(
                "CREATE TRIGGER fail_resume_projection BEFORE INSERT ON projection_checkpoints \
                 WHEN NEW.projection_name = 'history_derived' \
                 BEGIN SELECT RAISE(ABORT, 'injected resume projection failure'); END;",
            )
            .unwrap();
        }

        let mut resumed = HeadlessLoop::resume(cfg).expect("resume degrades");
        // No turn has run, so nothing outranks the resume diagnostic.
        let report = resumed.report(None);
        let diagnostic = report
            .diagnostic
            .expect("the resume diagnostic is reported before any turn");
        assert_eq!(diagnostic.code, "HISTORY_IO", "{diagnostic:?}");
        assert!(
            !diagnostic.retryable,
            "a resume projection failure cannot be retried in-turn: {diagnostic:?}"
        );
        assert_eq!(diagnostic.message, RESUME_PROJECTION_DIAGNOSTIC_MESSAGE);
        assert!(resumed.resume_projection_diagnostic.is_none());
    }

    #[test]
    fn committed_report_prefers_compaction_and_keeps_the_resume_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let mut loop_ = HeadlessLoop::create(test_config(dir.path())).unwrap();
        loop_.compaction_diagnostic = Some(ProtocolError {
            code: "E_PROVIDER_STREAM".to_owned(),
            class: ErrorClass::Transport,
            message: LIVE_COMPACTION_NOT_ACTIVATED_MESSAGE.to_owned(),
            retryable: false,
            http_status: Some(500),
            retry_after_ms: None,
        });
        loop_.resume_projection_diagnostic = Some(parked_resume_diagnostic("HISTORY_IO"));
        let first = loop_.report(None);
        assert_eq!(
            first.diagnostic.as_ref().map(|d| d.code.as_str()),
            Some("E_PROVIDER_STREAM"),
            "compaction outranks the resume diagnostic: {first:?}"
        );
        assert!(
            loop_.resume_projection_diagnostic.is_some(),
            "the resume diagnostic is taken only when it is reported"
        );
        loop_.compaction_diagnostic = None;
        loop_.projection_diagnostic = None;
        loop_.pending_diagnostic = None;
        let second = loop_.report(None);
        assert_eq!(
            second.diagnostic.as_ref().map(|d| d.code.as_str()),
            Some("HISTORY_IO"),
            "the resume diagnostic is still reported once nothing else is pending: {second:?}"
        );
        assert!(loop_.resume_projection_diagnostic.is_none());
    }

    #[test]
    fn interrupted_report_carries_the_resume_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let mut loop_ = HeadlessLoop::create(test_config(dir.path())).unwrap();
        loop_.compaction_diagnostic = Some(ProtocolError {
            code: "E_PROVIDER_STREAM".to_owned(),
            class: ErrorClass::Transport,
            message: LIVE_COMPACTION_NOT_ACTIVATED_MESSAGE.to_owned(),
            retryable: false,
            http_status: None,
            retry_after_ms: None,
        });
        loop_.projection_diagnostic = Some(parked_resume_diagnostic("HISTORY_IO"));
        loop_.resume_projection_diagnostic =
            Some(parked_resume_diagnostic("HISTORY_CHECKPOINT_INVALID"));
        let report = loop_.report(Some(InterruptionReason::UserAbort));
        assert_eq!(report.interruption, Some(InterruptionReason::UserAbort));
        assert_eq!(
            report.diagnostic.as_ref().map(|d| d.code.as_str()),
            Some("HISTORY_CHECKPOINT_INVALID"),
            "an interrupted report carries the resume diagnostic, not compaction: {report:?}"
        );
        assert!(loop_.resume_projection_diagnostic.is_none());
        assert!(loop_.compaction_diagnostic.is_some());
    }

    #[tokio::test]
    async fn successful_live_projection_clears_the_resume_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let cfg = test_config(dir.path());
        let mut loop_ = HeadlessLoop::create(cfg).unwrap();
        let seed = Scripted::new(vec![text_step("seed marker")]);
        assert!(loop_
            .run_turn("seed turn", &seed)
            .await
            .unwrap()
            .interruption
            .is_none());
        loop_.resume_projection_diagnostic = Some(parked_resume_diagnostic("HISTORY_IO"));
        loop_.project_history_live();
        assert!(
            loop_.projection_diagnostic.is_none(),
            "the live projection itself succeeded"
        );
        assert!(
            loop_.resume_projection_diagnostic.is_none(),
            "a healed derived database is not reported as failed"
        );
    }

    #[test]
    fn retained_epoch_diagnostic_maps_every_run_error() {
        use crate::compaction::activate::{CompactionRunError, UnavailableReason};
        use crate::compaction::CompactionError;
        use crate::protocol::id::TurnId;
        let turn = TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        let cases: Vec<(CompactionRunError, &str, ErrorClass)> = vec![
            (
                CompactionRunError::Selection(CompactionError::NoEligibleTurns),
                "E_COMPACTION_RANGE_INVALID",
                ErrorClass::Validation,
            ),
            (
                CompactionRunError::Selection(CompactionError::MissingTokenMass(turn)),
                "E_COMPACTION_RANGE_INVALID",
                ErrorClass::Validation,
            ),
            (
                CompactionRunError::Selection(CompactionError::ArithmeticOverflow),
                "E_ADMISSION_ACCOUNTING",
                ErrorClass::Internal,
            ),
            (
                CompactionRunError::Unavailable {
                    reason: UnavailableReason::Empty,
                    message: "empty".into(),
                },
                "E_COMPACTION_EPOCH_FAILED",
                ErrorClass::Internal,
            ),
            (
                CompactionRunError::InFlight,
                "E_COMPACTION_EPOCH_FAILED",
                ErrorClass::Internal,
            ),
            (
                CompactionRunError::Admission("too large".into()),
                "E_ACTIVE_TURN_TOO_LARGE",
                ErrorClass::ContextLength,
            ),
            (
                CompactionRunError::Request("could not build".into()),
                "E_COMPACTION_EPOCH_FAILED",
                ErrorClass::Internal,
            ),
            (
                CompactionRunError::History("fsync failed".into()),
                "E_COMPACTION_EPOCH_FAILED",
                ErrorClass::Internal,
            ),
        ];
        for (error, code, class) in cases {
            let diagnostic = super::retained_epoch_diagnostic(&error);
            assert_eq!(diagnostic.code, code, "{error}");
            assert_eq!(diagnostic.class, class, "{error}");
            assert_ne!(diagnostic.code, "E_COMPACTION_UNAVAILABLE");
            assert_eq!(diagnostic.message, LIVE_COMPACTION_NOT_ACTIVATED_MESSAGE);
            assert!(!diagnostic.retryable);
        }
    }

    #[tokio::test]
    async fn projection_diagnostic_is_cleared_by_a_later_success_in_the_same_turn() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("work")).unwrap();
        let cfg = test_config(dir.path());
        let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();

        let seed = Scripted::new(vec![text_step("seed marker")]);
        assert!(loop_
            .run_turn("seed turn", &seed)
            .await
            .unwrap()
            .interruption
            .is_none());

        // Make the derived db lagging and keep the trigger active so the probe
        // turn's first pre-batch projection fails too.
        inject_projection_trigger(&cfg.session_dir, "injected projection failure");
        let stale = Scripted::new(vec![text_step("stale marker")]);
        let stale_report = loop_.run_turn("stale turn", &stale).await.unwrap();
        assert_eq!(
            stale_report.diagnostic.as_ref().map(|d| d.code.as_str()),
            Some("HISTORY_IO"),
            "{stale_report:?}"
        );

        // Same turn: the first batch's pre-batch projection fails while the
        // trigger is active; the second batch drops the trigger, so this
        // turn's commit projection succeeds. A stale projection diagnostic
        // must not survive the success.
        let probe = Scripted::new(vec![
            tool_step(
                "call-search",
                "search_session_log",
                json!({"query": "unused", "mode": "exact"}),
            ),
            tool_step(
                "call-drop",
                "derived_db_probe",
                json!({"op": "drop_projection_trigger"}),
            ),
            text_step("recovered"),
        ]);
        let report = loop_
            .run_turn("transient projection failure", &probe)
            .await
            .unwrap();
        assert!(report.interruption.is_none(), "{report:?}");
        assert!(
            report.diagnostic.is_none(),
            "a recovered projection must not be reported as failed: {report:?}"
        );
        let cursor =
            checkpoint_applied_through(&cfg.session_dir).expect("checkpoint row after recovery");
        assert_eq!(
            cursor as u64,
            event_line_count(&cfg.session_dir),
            "the commit projection caught up after the trigger was dropped"
        );
    }
}
