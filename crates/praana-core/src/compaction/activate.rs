//! Epoch activation against a configured compactor (Compaction spec §11–§12).
//!
//! The durable event is authoritative. The sequence is: snapshot and select
//! under the session writer, build and admit the exact request, append the
//! compaction attempt start, resolve the credential, send, then re-validate
//! the candidate and the frozen source before appending `HistoryCompacted`.
//! Any failure appends `AssistantAttemptFailed` and leaves the projection
//! unchanged. A candidate that fails validation may get one repair, which is a
//! fresh durable attempt with `retry_of` (§8.4).
//!
//! The SQLite summary rows of §12 step 13 are P5-4. Live pressure wiring is
//! P5-6; here activation is called explicitly.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use futures::StreamExt;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::canonical_json::to_canonical_json_bytes;
use crate::clock::Clock;
use crate::compaction::control::{
    compactor_config_id, prompt_version, render_compaction_control_v1, CompactionControlV1,
    CompactionSourceMessageV1, CompactionSourceTurnV1, CompactionStateInputV1,
    CompactorConfigIdentity, COMPACTION_REQUEST_SCHEMA_VERSION, COMPACTOR_SYSTEM_POLICY,
};
use crate::compaction::render::check_rendered_handoff_tokens;
use crate::compaction::schema::{
    candidate_hash, candidate_json_schema, candidate_schema_sha256, parse_candidate,
    CandidateIssue, CandidateIssueCode, CompactionCandidateV1, CANDIDATE_OUTPUT_SCHEMA_ID,
};
use crate::compaction::selection::{select_turns, ProjectedTurn, Selection};
use crate::compaction::validate::{validate_candidate, ReferenceUniverse};
use crate::compaction::CompactionError;
use crate::config::EffectiveConfigV1;
use crate::credentials::store::{credentials_path, load_store, CredentialStoreV1};
use crate::history::event_log::EventLogStore;
use crate::history::recovery::{build_interrupted_turn_capsule_from_replay, ATTEMPT_LOST_CODE};
use crate::history::replay::{accepted_messages, EventReplayer, TurnTerminal};
use crate::id::{IdGenerator, MonotonicUlidGenerator};
use crate::protocol::compaction::{
    CompactorStrategy, HandoffReason, HistoricalHandoffV1, HistoryCompactedV1, SourceRangeV1,
    SummarySegmentV1,
};
use crate::protocol::constants::{COMPACTION_POLICY_VERSION, EVENT_SCHEMA_VERSION};
use crate::protocol::errors::{ErrorClass, ProtocolError};
use crate::protocol::events::{
    AssistantAttemptFailed, AssistantAttemptStarted, AttemptSuperseded, CanonicalEvent,
    CompactionPurpose, EventEnvelope, InterruptedTurnCapsuleV1, PartialAssistantOutput,
    ProviderAttemptPurpose, SupersessionReason,
};
use crate::protocol::hashes::{calculate_prefix_hash, calculate_sha256, calculate_source_hash};
use crate::protocol::id::{
    ArtifactId, AttemptId, CompactionId, EventId, HandoffId, MessageId, SessionId, Sha256Digest,
    StateId, SummarySegmentId, TurnId,
};
use crate::protocol::json::serialize_canonical;
use crate::protocol::messages::ConversationMessage;
use crate::protocol::models::{ModelSelection, ProviderUsage, ReasoningEffort};
use crate::provider::openai::{
    accounted_component_bytes, admit, build_headers, classify_http, format_chat_body,
    format_responses_body, http_error, parse_chat_stream, parse_responses_stream,
    resolve_provider_credential, AdmissionDecision, AdmissionEstimate, AdmissionRequest,
    ChatFormatInput, ChatProfileKind, OpenAiAdapterEvent, ProviderError, ProviderErrorCode,
    ResponsesFormatInput, ToolChoiceV1,
};
use crate::provider::profile::{ModelCapabilityProfile, ReasoningContextCapability};
use crate::provider::registry::ProviderProtocol;
use crate::provider::{catalog_cache_path, endpoint_fingerprint};
use crate::token::{
    FramingProfileV1, GenericTokenEstimatorV1, TokenEstimateV1, TokenEstimationContext,
    TokenEstimatorV1, TOKEN_ESTIMATOR_SCHEMA_VERSION,
};
use crate::tools::ToolCatalog;

/// `HistoricalHandoffV1.label` for every reason (§8.3).
pub const HANDOFF_LABEL: &str = "NON-AUTHORITATIVE HISTORICAL EVIDENCE";

// ---------------------------------------------------------------------------
// Errors and outcomes
// ---------------------------------------------------------------------------

/// A compaction that stopped before or outside a durable attempt. Nothing in
/// the projection changed.
#[derive(Debug)]
pub enum CompactionRunError {
    /// Selection found nothing to retire, or a turn lacked token mass.
    Selection(CompactionError),
    /// The configured pair is empty, untrusted, or lacks strict schema support.
    Unavailable(String),
    /// A compaction-purpose attempt is already open.
    InFlight,
    /// The compactor request did not pass admission against its own model.
    Admission(String),
    /// The request could not be built before any durable start.
    Request(String),
    /// History could not be read, or an event could not become durable.
    History(String),
}

impl CompactionRunError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Selection(error) => error.code(),
            Self::Unavailable(_) | Self::InFlight => "COMPACTION_UNAVAILABLE",
            Self::Admission(_) => "ADMISSION_ACTIVE_CONTEXT_TOO_LARGE",
            Self::Request(_) => "COMPACTION_PROVIDER",
            Self::History(_) => "COMPACTION_PERSISTENCE",
        }
    }
}

impl std::fmt::Display for CompactionRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Selection(error) => write!(f, "{error}"),
            Self::InFlight => write!(f, "{}: a compaction is in flight", self.code()),
            Self::Unavailable(m) | Self::Admission(m) | Self::Request(m) | Self::History(m) => {
                write!(f, "{}: {m}", self.code())
            }
        }
    }
}

impl std::error::Error for CompactionRunError {}

impl From<CompactionError> for CompactionRunError {
    fn from(error: CompactionError) -> Self {
        Self::Selection(error)
    }
}

fn history_error(error: impl std::fmt::Display) -> CompactionRunError {
    CompactionRunError::History(error.to_string())
}

/// The durable result of one compaction operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompactionOutcome {
    Activated {
        compaction_id: CompactionId,
        epoch: u32,
        attempt_id: AttemptId,
        event_id: EventId,
        retired_turn_ids: Vec<TurnId>,
        /// Failure to update the derived History projection after activation.
        /// The durable `HistoryCompacted` event remains authoritative.
        derived_projection_error: Option<ProtocolError>,
    },
    Failed {
        compaction_id: CompactionId,
        attempt_id: AttemptId,
        error: ProtocolError,
    },
}

// ---------------------------------------------------------------------------
// Configured compactor
// ---------------------------------------------------------------------------

/// A resolved `history.compactor_provider` / `history.compactor_model` pair
/// (§7.3). It carries no credential; that is resolved after the durable start.
#[derive(Clone, Debug)]
pub struct ConfiguredCompactor {
    pub provider: String,
    pub protocol: ProviderProtocol,
    pub model: String,
    pub base_url: String,
    pub extra_headers: BTreeMap<String, String>,
    pub max_output_tokens: u64,
    pub timeout_ms: u64,
    pub profile: ModelCapabilityProfile,
    pub framing: FramingProfileV1,
    pub selection: ModelSelection,
    pub config_id: String,
    pub home: PathBuf,
    /// One client for the first attempt and its repair, so the connection and
    /// TLS session can be reused.
    pub client: reqwest::Client,
    /// Credential environment. `None` reads the process environment at send
    /// time; tests pin it so an ambient key cannot change the outcome.
    pub env: Option<BTreeMap<String, String>>,
}

impl ConfiguredCompactor {
    /// Resolves the configured pair. The protocol follows the initial provider
    /// rule (`openai` uses Responses, `openrouter` uses Chat). The model needs
    /// a trusted catalog/profile window and strict JSON schema support; there
    /// is no unsafe compactor window override.
    pub fn resolve(
        config: &EffectiveConfigV1,
        home: &Path,
        now_ms: i64,
    ) -> Result<Self, CompactionRunError> {
        let history = &config.history;
        let provider = crate::config::raw::ascii_edge_trim(&history.compactor_provider).to_owned();
        let model = crate::config::raw::ascii_edge_trim(&history.compactor_model).to_owned();
        if provider.is_empty() || model.is_empty() {
            return Err(CompactionRunError::Unavailable(
                "the compactor pair is empty and inert".into(),
            ));
        }
        let (protocol, base_url, extra_headers) = match provider.as_str() {
            "openai" => (
                ProviderProtocol::Responses,
                config.providers.openai.base_url.clone(),
                config.providers.openai.extra_headers.clone(),
            ),
            "openrouter" => (
                ProviderProtocol::Chat,
                config.providers.openrouter.base_url.clone(),
                config.providers.openrouter.extra_headers.clone(),
            ),
            other => {
                return Err(CompactionRunError::Unavailable(format!(
                    "unsupported compactor provider {other:?}"
                )))
            }
        };
        let cache = crate::turn::provider::read_catalog_cache(&catalog_cache_path(home));
        let profile = crate::provider::catalog::resolve_profile_with_catalog(
            &provider,
            &protocol,
            &model,
            &base_url,
            now_ms,
            cache.as_ref(),
            None,
            Some(history.compactor_max_output_tokens),
        )
        .map_err(|error| {
            CompactionRunError::Unavailable(format!(
                "compactor model has no trusted window: {error}"
            ))
        })?;
        if profile.min_output_tokens > profile.max_output_tokens {
            return Err(CompactionRunError::Unavailable(
                "compactor profile output range is empty".into(),
            ));
        }
        if !profile.strict_json_schema {
            return Err(CompactionRunError::Unavailable(
                "compactor model does not support strict JSON schema output".into(),
            ));
        }
        let fingerprint = endpoint_fingerprint(&base_url).map_err(|error| {
            CompactionRunError::Unavailable(format!("compactor endpoint is invalid: {error}"))
        })?;
        let config_id = compactor_config_id(&CompactorConfigIdentity {
            provider: &provider,
            protocol: protocol.config_name(),
            model: &model,
            base_url_fingerprint: &fingerprint,
            max_output_tokens: history.compactor_max_output_tokens,
            timeout_ms: history.compactor_timeout_ms,
        });
        let selection = ModelSelection {
            provider: provider.clone(),
            protocol: protocol.config_name().to_owned(),
            model: model.clone(),
            model_revision: profile.model_revision.clone(),
            model_family: protocol.config_name().to_owned(),
            endpoint_fingerprint: fingerprint,
            reasoning_effort: ReasoningEffort::Off,
        };
        Ok(Self {
            framing: crate::turn::framing_for(&provider, protocol.config_name(), &model),
            provider,
            protocol,
            model,
            base_url,
            extra_headers,
            max_output_tokens: history.compactor_max_output_tokens,
            timeout_ms: history.compactor_timeout_ms,
            profile,
            selection,
            config_id,
            home: home.to_path_buf(),
            client: reqwest::Client::new(),
            env: None,
        })
    }

    pub fn strategy(&self) -> CompactorStrategy {
        CompactorStrategy::Configured {
            provider: self.provider.clone(),
            model: self.model.clone(),
            config_id: self.config_id.clone(),
        }
    }

    fn is_responses(&self) -> bool {
        matches!(self.protocol, ProviderProtocol::Responses)
    }

    /// `Rout` for the compactor request: the configured output limit clamped
    /// to the profile range, exactly as admission clamps it (§4.1).
    fn resolved_output_tokens(&self) -> u64 {
        self.max_output_tokens.clamp(
            self.profile.min_output_tokens,
            self.profile.max_output_tokens,
        )
    }
}

// ---------------------------------------------------------------------------
// Projected turns (decided 2026-10-12: built on demand from replay)
// ---------------------------------------------------------------------------

/// One retained outer turn with the inputs the compactor needs. Nothing here
/// is persisted.
#[derive(Clone, Debug)]
pub struct TurnMass {
    pub turn: ProjectedTurn,
    pub estimate: TokenEstimateV1,
    pub messages: Vec<ConversationMessage>,
    /// The same messages, each with the canonical event that accepted it, so
    /// the compactor can cite source events (Compaction §7.4).
    pub source_messages: Vec<CompactionSourceMessageV1>,
    pub capsule: Option<InterruptedTurnCapsuleV1>,
}

/// The accepting event of every message in one turn: `user_message_accepted`
/// for the user message, `assistant_step_accepted` for each step, and
/// `tool_execution_finished` for each result.
fn message_events(
    turn: &crate::history::replay::TurnReplay,
    user_events: &HashMap<TurnId, EventId>,
) -> HashMap<MessageId, EventId> {
    let mut map = HashMap::new();
    if let Some(event_id) = user_events.get(&turn.id) {
        map.insert(turn.user.message_id, *event_id);
    }
    for step in turn.steps.values() {
        map.insert(step.message.message_id, step.accept_event_id);
    }
    for batch in turn.batches.values() {
        for execution in batch.executions.values() {
            if let (Some(result), Some(finish)) = (&execution.result, execution.finish_event_id) {
                map.insert(result.message_id, finish);
            }
        }
    }
    map
}

fn message_id(message: &ConversationMessage) -> MessageId {
    match message {
        ConversationMessage::User(user) => user.message_id,
        ConversationMessage::Assistant(assistant) => assistant.message_id,
        ConversationMessage::ToolResult(result) => result.message_id,
    }
}

/// Builds `ProjectedTurn` for every turn of the current reset epoch. Token
/// mass is the target estimator's count of each turn's accepted messages
/// (§6). A turn is closed exactly when it committed or has a valid
/// interrupted capsule (§5.1).
pub fn projected_turns(
    events: &[EventEnvelope],
    raw_lines: &[String],
    replay: &EventReplayer,
    framing: &FramingProfileV1,
) -> Result<Vec<TurnMass>, CompactionRunError> {
    let mut closure = HashMap::new();
    let mut user_events = HashMap::new();
    for event in after_last_reset(events) {
        match &event.event {
            CanonicalEvent::TurnCommitted(_) | CanonicalEvent::TurnInterrupted(_) => {
                if let Some(turn) = event.turn_id {
                    closure.insert(turn, event);
                }
            }
            CanonicalEvent::UserMessageAccepted(_) => {
                if let Some(turn) = event.turn_id {
                    user_events.insert(turn, event.event_id);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    for turn in replay.turns.values() {
        // Replay drops prior-reset turns and already tracks retired ids.
        if replay.compacted_turn_ids.contains(&turn.id) {
            continue;
        }
        let messages = accepted_messages(turn, false, None, None).map_err(history_error)?;
        let accepting = message_events(turn, &user_events);
        let source_messages = messages
            .iter()
            .map(|message| {
                let id = message_id(message);
                accepting
                    .get(&id)
                    .map(|event_id| CompactionSourceMessageV1 {
                        event_id: *event_id,
                        message: message.clone(),
                    })
                    .ok_or_else(|| {
                        CompactionRunError::History(format!("message {id} has no accepting event"))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let (closed, capsule) = match &turn.terminal {
            Some(TurnTerminal::Committed(_)) => (true, None),
            Some(TurnTerminal::Interrupted(_, _)) => match closure.get(&turn.id).and_then(|event| {
                let TurnTerminal::Interrupted(_, event_id) = turn.terminal.as_ref()? else {
                    return None;
                };
                if event.event_id != *event_id
                    || !matches!(event.event, CanonicalEvent::TurnInterrupted(_))
                {
                    return None;
                }
                build_interrupted_turn_capsule_from_replay(turn, event.sequence, raw_lines).ok()
            }) {
                Some(capsule) => (true, Some(capsule)),
                None => (false, None),
            },
            None => (false, None),
        };
        let bytes = to_canonical_json_bytes(&messages).map_err(history_error)?;
        let estimate = GenericTokenEstimatorV1
            .estimate(
                TokenEstimationContext::CompactionSourceTurn { turn_id: turn.id },
                &bytes,
                framing,
            )
            .map_err(history_error)?;
        out.push(TurnMass {
            turn: ProjectedTurn {
                turn_id: turn.id,
                start_sequence: turn.start_sequence,
                closure_sequence: closure.get(&turn.id).map_or(0, |event| event.sequence),
                reset_epoch: replay.reset_epoch,
                retired_by_epoch: None,
                compaction_closed: closed,
                protocol_complete: closed,
                accepted_message_tokens: estimate.total_tokens,
            },
            estimate,
            messages,
            source_messages,
            capsule,
        });
    }
    Ok(out)
}

fn after_last_reset(events: &[EventEnvelope]) -> &[EventEnvelope] {
    let start = events
        .iter()
        .rposition(|event| matches!(event.event, CanonicalEvent::ResetBoundary(_)))
        .map_or(0, |index| index + 1);
    &events[start..]
}

/// The `has_unconsidered_eligible_turn` input to `should_launch` (§4.2),
/// derived from replay. After a genuine compaction failure, only a turn that
/// closed after that attempt started is new. A lost attempt did not judge the
/// source, so it does not back off. After a successful epoch the projection
/// changed, so every remaining eligible turn counts.
pub fn has_unconsidered_eligible_turn(
    events: &[EventEnvelope],
    turns: &[ProjectedTurn],
    active_turn: Option<TurnId>,
    reset_epoch: u32,
) -> bool {
    let Ok(eligible) = select_turns(turns, active_turn, reset_epoch, 1_000_000) else {
        return false;
    };
    let epoch_events = after_last_reset(events);
    let last = epoch_events.iter().rev().find(|event| match &event.event {
        CanonicalEvent::HistoryCompacted(_) => true,
        CanonicalEvent::AssistantAttemptFailed(failed) => {
            matches!(failed.purpose, ProviderAttemptPurpose::Compaction(_))
        }
        _ => false,
    });
    let Some(last) = last else { return true };
    if matches!(last.event, CanonicalEvent::HistoryCompacted(_)) {
        return true;
    }
    if matches!(&last.event, CanonicalEvent::AssistantAttemptFailed(failed)
        if failed.error.code == ATTEMPT_LOST_CODE)
    {
        return true;
    }
    let Some(started_at) = epoch_events.iter().find_map(|event| match &event.event {
        CanonicalEvent::AssistantAttemptStarted(_) if event.attempt_id == last.attempt_id => {
            Some(event.sequence)
        }
        _ => None,
    }) else {
        return true;
    };
    turns
        .iter()
        .filter(|turn| eligible.turn_ids.contains(&turn.turn_id))
        .any(|turn| turn.closure_sequence > started_at)
}

/// True when a proactive compaction could be launched now: no compaction
/// attempt is open and at least one eligible turn was not considered by the
/// most recent attempt at this projection (§4.2). Costs one whole-log
/// projection, so callers gate it on the fill trigger first.
pub fn proactive_candidate(
    log: &EventLogStore,
    framing: &FramingProfileV1,
) -> Result<bool, CompactionRunError> {
    let replay = log.replayer();
    if open_compaction_attempt(replay) {
        return Ok(false);
    }
    let events = log.events_slice();
    let turns = projected_turns(events, log.raw_lines(), replay, framing)?;
    let projected: Vec<ProjectedTurn> = turns.iter().map(|turn| turn.turn.clone()).collect();
    Ok(has_unconsidered_eligible_turn(
        events,
        &projected,
        replay.active_turn_id(),
        replay.reset_epoch,
    ))
}

fn open_compaction_attempt(replay: &EventReplayer) -> bool {
    replay.attempts.values().any(|attempt| {
        attempt.status == crate::history::replay::AttemptStatus::Open
            && matches!(attempt.purpose, ProviderAttemptPurpose::Compaction(_))
    })
}

// ---------------------------------------------------------------------------
// Snapshot (§12 steps 1-2)
// ---------------------------------------------------------------------------

/// Everything frozen under the session writer before the compactor runs.
#[derive(Clone, Debug)]
pub struct CompactionSnapshot {
    pub projection_sequence: u64,
    pub reset_epoch: u32,
    pub epoch: u32,
    pub previous_handoff: Option<HistoricalHandoffV1>,
    pub previous_handoff_hash: Option<Sha256Digest>,
    pub selection: Selection,
    pub source_hash: Sha256Digest,
    pub event_prefix_hash_before: Sha256Digest,
    /// Hash of the complete log prefix frozen for source rechecks.
    pub snapshot_event_prefix_hash: [u8; 32],
    /// Replay baseline advanced in place over appended events during recheck.
    pub replay_state: EventReplayer,
    pub turn_estimates: Vec<TokenEstimateV1>,
    pub source_turns: Vec<CompactionSourceTurnV1>,
    pub current_state: CompactionStateInputV1,
    pub universe: ReferenceUniverse,
}

impl CompactionSnapshot {
    /// Smallest renderable control for the creation-time admission probe.
    pub fn minimal_for_admission_probe() -> Result<Self, crate::config::ConfigError> {
        Ok(Self {
            projection_sequence: 0,
            reset_epoch: 0,
            epoch: 1,
            previous_handoff: None,
            previous_handoff_hash: None,
            selection: Selection {
                turn_ids: Vec::new(),
                source_start_sequence: 1,
                source_end_sequence: 1,
                eligible_mass: 0,
                target_mass: 0,
                selected_mass: 0,
            },
            source_hash: Sha256Digest::digest_bytes(b""),
            event_prefix_hash_before: Sha256Digest::digest_bytes(b""),
            snapshot_event_prefix_hash: [0u8; 32],
            replay_state: EventReplayer::default(),
            turn_estimates: Vec::new(),
            // Zero source turns cannot render (§7.4); use one empty synthetic turn.
            source_turns: vec![CompactionSourceTurnV1 {
                turn_id: TurnId::from_str_canonical("01J8Z3NDEK0000000000000001").map_err(
                    |error| {
                        crate::config::ConfigError::InvalidValue(format!(
                            "synthetic turn id: {error}"
                        ))
                    },
                )?,
                start_sequence: 1,
                end_sequence: 1,
                interrupted: None,
                messages: Vec::new(),
                artifact_previews: Vec::new(),
            }],
            current_state: CompactionStateInputV1 {
                graph_sequence: 0,
                rendered_input_sha256: Sha256Digest::digest_bytes(b""),
                rendered_active_state: String::new(),
            },
            universe: ReferenceUniverse {
                source_event_ids: BTreeSet::new(),
                source_artifact_ids: BTreeSet::new(),
                source_state_ids: BTreeSet::new(),
                prior_segment_ids: BTreeSet::new(),
                lineage_event_ids: BTreeSet::new(),
                session_artifact_ids: BTreeSet::new(),
                current_state_ids: BTreeSet::new(),
            },
        })
    }
}

fn digest_of<T: serde::Serialize>(value: &T) -> Result<Sha256Digest, CompactionRunError> {
    Ok(calculate_sha256(
        &serialize_canonical(value).map_err(history_error)?,
    ))
}

/// Collects every string under an object key named `key`, recursively.
fn collect_ids(value: &Value, key: &str, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (name, child) in map {
                if name == key {
                    match child {
                        Value::String(id) => {
                            out.insert(id.clone());
                        }
                        Value::Array(items) => {
                            for item in items {
                                if let Value::String(id) = item {
                                    out.insert(id.clone());
                                }
                            }
                        }
                        _ => collect_ids(child, key, out),
                    }
                } else {
                    collect_ids(child, key, out);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_ids(item, key, out);
            }
        }
        _ => {}
    }
}

fn parsed_ids<T: std::str::FromStr + Ord>(raw: BTreeSet<String>) -> BTreeSet<T> {
    raw.into_iter().filter_map(|id| id.parse().ok()).collect()
}

fn artifact_ids_in<T: serde::Serialize>(value: &T) -> BTreeSet<ArtifactId> {
    let mut raw = BTreeSet::new();
    if let Ok(value) = serde_json::to_value(value) {
        collect_ids(&value, "artifact_id", &mut raw);
    }
    parsed_ids(raw)
}

fn state_ids_of(graph: &crate::protocol::state_graph::StateGraphV1) -> BTreeSet<StateId> {
    graph.objects.iter().map(|object| object.state_id).collect()
}

/// Snapshots the session, selects the oldest eligible prefix, and freezes the
/// source hash and reference universe (§9.1, §9.2).
pub fn snapshot(
    log: &EventLogStore,
    config: &EffectiveConfigV1,
    framing: &FramingProfileV1,
) -> Result<CompactionSnapshot, CompactionRunError> {
    let events = log.events_slice();
    let raw_lines = log.raw_lines();
    let snapshot_event_prefix_hash = log.current_prefix_hash();
    // One clone for the entire operation. Repair transfers ownership and
    // recheck advances this baseline only over the newly appended tail.
    let replay = log.replayer().clone();
    if open_compaction_attempt(&replay) {
        return Err(CompactionRunError::InFlight);
    }
    let turns = projected_turns(events, raw_lines, &replay, framing)?;
    let projected: Vec<ProjectedTurn> = turns.iter().map(|turn| turn.turn.clone()).collect();
    let fraction_ppm = crate::compaction::admission::ratio_to_ppm(
        config.history.compact_mass_fraction,
    )
    .map_err(|_| CompactionRunError::Request("compact_mass_fraction is out of range".into()))?;
    let selection = select_turns(
        &projected,
        replay.active_turn_id(),
        replay.reset_epoch,
        u32::try_from(fraction_ppm).unwrap_or(u32::MAX),
    )?;
    let start = selection.source_start_sequence;
    let end = selection.source_end_sequence;
    if start == 0 || end as usize > raw_lines.len() || start > end {
        return Err(CompactionRunError::History(
            "selected range is outside the log".into(),
        ));
    }
    let source_hash = calculate_source_hash(&raw_lines[start as usize - 1..end as usize]);
    let prefix = *log
        .prefix_hashes()
        .get(start as usize - 1)
        .ok_or_else(|| history_error("source prefix is outside the log"))?;

    let selected: Vec<&TurnMass> = selection
        .turn_ids
        .iter()
        .filter_map(|id| turns.iter().find(|turn| turn.turn.turn_id == *id))
        .collect();
    let source_turns: Vec<CompactionSourceTurnV1> = selected
        .iter()
        .map(|turn| CompactionSourceTurnV1 {
            turn_id: turn.turn.turn_id,
            start_sequence: turn.turn.start_sequence,
            end_sequence: turn.turn.closure_sequence,
            interrupted: turn.capsule.clone(),
            messages: turn.source_messages.clone(),
            // Artifact results already carry their preview and reference
            // inside `messages`. Full preview metadata from the artifact
            // store arrives with P5-4 retrieval.
            artifact_previews: Vec::new(),
        })
        .collect();

    // §9.2 reference universe, frozen with the snapshot.
    let source_events: Vec<&EventEnvelope> = events
        .iter()
        .filter(|event| event.sequence >= start && event.sequence <= end)
        .collect();
    // Only the selected source end needs a historical graph. Fold state
    // consequences once instead of cloning the graph at every turn closure.
    let mut state_at_end = crate::protocol::state_graph::StateGraphV1 {
        schema_version: 1,
        ..Default::default()
    };
    for event in &events[..end as usize] {
        crate::state::project_logged_event(&mut state_at_end, event)
            .map_err(|error| history_error(error.state_code))?;
    }
    let epoch_events = after_last_reset(events);
    let mut prior_segment_ids = BTreeSet::new();
    let mut lineage_ranges = Vec::new();
    for event in epoch_events {
        if let CanonicalEvent::HistoryCompacted(compacted) = &event.event {
            prior_segment_ids.insert(compacted.segment.segment_id);
            lineage_ranges.push((
                compacted.source_start_sequence,
                compacted.source_end_sequence,
            ));
        }
    }
    let universe = ReferenceUniverse {
        source_event_ids: source_events.iter().map(|event| event.event_id).collect(),
        source_artifact_ids: artifact_ids_in(&source_events),
        source_state_ids: state_ids_of(&state_at_end),
        prior_segment_ids,
        lineage_event_ids: events
            .iter()
            .filter(|event| {
                lineage_ranges
                    .iter()
                    .any(|(lo, hi)| event.sequence >= *lo && event.sequence <= *hi)
            })
            .map(|event| event.event_id)
            .collect(),
        session_artifact_ids: artifact_ids_in(&events),
        current_state_ids: state_ids_of(&replay.state),
    };

    let rendered_active_state = crate::state::render_state_tail(&replay.state);
    let current_state = CompactionStateInputV1 {
        graph_sequence: replay.state.applied_through_sequence,
        rendered_input_sha256: Sha256Digest::digest_bytes(rendered_active_state.as_bytes()),
        rendered_active_state,
    };
    let previous_handoff_hash = replay.active_handoff.as_ref().map(digest_of).transpose()?;
    Ok(CompactionSnapshot {
        projection_sequence: replay.current_sequence(),
        reset_epoch: replay.reset_epoch,
        epoch: replay.compaction_epoch + 1,
        previous_handoff: replay.active_handoff.clone(),
        previous_handoff_hash,
        turn_estimates: selected.iter().map(|turn| turn.estimate.clone()).collect(),
        selection,
        source_hash,
        event_prefix_hash_before: Sha256Digest::from_bytes(prefix),
        snapshot_event_prefix_hash,
        replay_state: replay,
        source_turns,
        current_state,
        universe,
    })
}

/// §12 step 8: the reset epoch, compaction lineage, previous handoff, selected
/// turn statuses, and source bytes are unchanged. Later events are allowed.
pub fn recheck_source(
    snapshot: &CompactionSnapshot,
    events: &[EventEnvelope],
    raw_lines: &[String],
) -> Result<(), String> {
    let current_prefix_hash =
        crate::history::checkpoint::prefix_hash_at(raw_lines, raw_lines.len() as u64)
            .ok_or("current prefix is outside the log")?;
    recheck_source_with_prefix(
        &mut snapshot.clone(),
        events,
        raw_lines,
        current_prefix_hash,
    )
}

fn recheck_source_with_prefix(
    snapshot: &mut CompactionSnapshot,
    events: &[EventEnvelope],
    raw_lines: &[String],
    current_prefix_hash: [u8; 32],
) -> Result<(), String> {
    let snapshot_sequence = snapshot.projection_sequence as usize;
    if events.len() < snapshot_sequence || raw_lines.len() < snapshot_sequence {
        return Err("event log prefix is shorter than the snapshot".into());
    }
    let mut prefix = snapshot.snapshot_event_prefix_hash;
    for (index, line) in raw_lines.iter().enumerate().skip(snapshot_sequence) {
        prefix = calculate_prefix_hash(&prefix, index as u64 + 1, line.as_bytes());
    }
    if prefix != current_prefix_hash {
        return Err("event log prefix changed".into());
    }

    let replay = &mut snapshot.replay_state;
    let replay_sequence = replay.current_sequence() as usize;
    for (index, event) in events.iter().enumerate().skip(replay_sequence) {
        replay
            .process_event_in_place(event, Some(index + 1), Some(raw_lines))
            .map_err(|error| error.to_string())?;
    }
    if replay.reset_epoch != snapshot.reset_epoch {
        return Err("reset epoch changed".into());
    }
    if replay.compaction_epoch + 1 != snapshot.epoch {
        return Err("compaction epoch changed".into());
    }
    let handoff_hash = replay
        .active_handoff
        .as_ref()
        .map(digest_of)
        .transpose()
        .map_err(|e| e.to_string())?;
    if handoff_hash != snapshot.previous_handoff_hash {
        return Err("previous handoff changed".into());
    }
    for turn_id in &snapshot.selection.turn_ids {
        if replay.compacted_turn_ids.contains(turn_id) {
            return Err(format!("turn {turn_id} was already retired"));
        }
        let closed = replay
            .turn_index(*turn_id)
            .and_then(|index| replay.turns.get(&index))
            .is_some_and(|turn| turn.terminal.is_some());
        if !closed {
            return Err(format!("turn {turn_id} is no longer closed"));
        }
    }
    let start = snapshot.selection.source_start_sequence as usize;
    let end = snapshot.selection.source_end_sequence as usize;
    if start == 0 || end > raw_lines.len() {
        return Err("source range is outside the log".into());
    }
    if calculate_source_hash(&raw_lines[start - 1..end]) != snapshot.source_hash {
        return Err("source bytes changed".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Request (§7.3-§7.4, OpenAI §8.5)
// ---------------------------------------------------------------------------

/// The admitted compactor request, bound to its estimate by request hash.
#[derive(Clone, Debug)]
pub struct PlannedRequest {
    pub control: CompactionControlV1,
    pub body: Value,
    pub estimate: AdmissionEstimate,
}

pub fn build_control(snapshot: &CompactionSnapshot) -> CompactionControlV1 {
    CompactionControlV1 {
        request_schema_version: COMPACTION_REQUEST_SCHEMA_VERSION,
        previous_handoff: snapshot.previous_handoff.clone(),
        source_turns: snapshot.source_turns.clone(),
        current_state: snapshot.current_state.clone(),
        output_schema_id: CANDIDATE_OUTPUT_SCHEMA_ID.to_owned(),
        output_schema_sha256: candidate_schema_sha256(),
    }
}

/// A repair request carries only the validation issues and the candidate hash
/// (§8.4), never the rejected candidate text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepairNote {
    pub candidate_hash: Option<Sha256Digest>,
    pub issues: Vec<CandidateIssue>,
}

fn repair_text(note: &RepairNote) -> Result<String, CompactionRunError> {
    let issues: Vec<Value> = note
        .issues
        .iter()
        .map(|issue| {
            serde_json::json!({
                "code": issue.code.code(),
                "path": issue.path,
                "message": issue.message,
            })
        })
        .collect();
    let payload = serde_json::json!({
        "candidate_sha256": note.candidate_hash.as_ref().map(|digest| digest.as_str()),
        "issues": issues,
    });
    let bytes = to_canonical_json_bytes(&payload)
        .map_err(|e| CompactionRunError::Request(e.to_string()))?;
    let json = String::from_utf8(bytes).map_err(|e| CompactionRunError::Request(e.to_string()))?;
    Ok(format!(
        "[PRAANA:COMPACTION_REPAIR]\n{json}\n[/PRAANA:COMPACTION_REPAIR]\n"
    ))
}

/// Formats the standalone compactor request: the §7.4 system policy in the
/// protocol's instruction field, one ephemeral user control message, no tools,
/// and the strict candidate schema. A repair appends one more ephemeral user
/// message with the issues. The body is admitted against the compactor model.
pub fn plan_request(
    snapshot: &CompactionSnapshot,
    compactor: &ConfiguredCompactor,
    config: &EffectiveConfigV1,
    repair: Option<&RepairNote>,
) -> Result<PlannedRequest, CompactionRunError> {
    let control = build_control(snapshot);
    let control_text = render_compaction_control_v1(&control)
        .map_err(|error| CompactionRunError::Request(error.to_string()))?;
    let tools = ToolCatalog::try_from_descriptors(Vec::new())
        .map_err(|error| CompactionRunError::Request(error.to_string()))?;
    let resolved = compactor.resolved_output_tokens();
    let mut body = if compactor.is_responses() {
        format_responses_body(&ResponsesFormatInput {
            model: &compactor.model,
            instructions: COMPACTOR_SYSTEM_POLICY,
            messages: &[],
            tools: &tools,
            tool_choice: ToolChoiceV1::Auto,
            parallel_tools: false,
            resolved_max_output_tokens: resolved,
            temperature_milli: None,
            temperature_with_reasoning: false,
            reasoning: ReasoningEffort::Off,
            reasoning_context: ReasoningContextCapability::Unsupported,
            image_input_supported: false,
            continuation: None,
            target: &compactor.selection,
            internal_compaction_control: Some(&control_text),
            compaction_schema: Some(candidate_json_schema()),
            replay_policy: "active",
        })
    } else {
        format_chat_body(&ChatFormatInput {
            profile: if compactor.provider == "openrouter" {
                ChatProfileKind::OpenRouter
            } else {
                ChatProfileKind::OpenAi
            },
            model: &compactor.model,
            instructions: COMPACTOR_SYSTEM_POLICY,
            messages: &[],
            tools: &tools,
            tool_choice: ToolChoiceV1::Auto,
            parallel_tools: false,
            resolved_max_output_tokens: resolved,
            temperature_milli: None,
            temperature_with_reasoning: false,
            reasoning: ReasoningEffort::Off,
            image_input_supported: false,
            internal_compaction_control: Some(&control_text),
            compaction_schema: Some(candidate_json_schema()),
        })
    }
    .map_err(|error| CompactionRunError::Request(error.safe_message.clone()))?;
    if let Some(note) = repair {
        let text = repair_text(note)?;
        let (key, item) = if compactor.is_responses() {
            (
                "input",
                serde_json::json!({
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                }),
            )
        } else {
            (
                "messages",
                serde_json::json!({"role": "user", "content": text}),
            )
        };
        body.get_mut(key)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| CompactionRunError::Request("request body has no message list".into()))?
            .push(item);
    }
    let component_bytes =
        accounted_component_bytes(&body).map_err(|e| CompactionRunError::Request(e.to_owned()))?;
    let decision = admit(&AdmissionRequest {
        profile: Some(&compactor.profile),
        configured_context_window: 0,
        unsafe_increase: false,
        requested_max_output: compactor.max_output_tokens,
        configured_min_output: 0,
        reasoning_reserve_tokens: 0,
        safety_margin_min_tokens: config.history.safety_margin_min_tokens,
        safety_margin_ratio: config.history.safety_margin_ratio,
        calibration_margin: 0,
        component_bytes,
        framing: compactor.framing.clone(),
        image_count: 0,
        request_body: &body,
        estimate_reused_from: None,
        state_tail: "",
        state_tail_offset: None,
        handoff: "",
        handoff_offset: None,
    })
    .map_err(|error| CompactionRunError::Admission(error.safe_message.clone()))?;
    match decision {
        AdmissionDecision::Admit(estimate) if estimate.output_reserve_tokens == resolved => {
            Ok(PlannedRequest {
                control,
                body,
                estimate,
            })
        }
        AdmissionDecision::Admit(_) => Err(CompactionRunError::Admission(
            "admitted output reserve differs from the formatted request".into(),
        )),
        AdmissionDecision::ReduceOutput { .. } | AdmissionDecision::Reject { .. } => Err(
            CompactionRunError::Admission("the compactor request exceeds its model window".into()),
        ),
    }
}

// ---------------------------------------------------------------------------
// Transport (§12 step 5)
// ---------------------------------------------------------------------------

/// Raw candidate text and reported usage from one compactor send.
#[derive(Clone, Debug)]
pub struct GeneratedCandidate {
    pub text: String,
    pub usage: ProviderUsage,
}

fn compaction_error(code: &str, class: ErrorClass, message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: code.to_owned(),
        class,
        message: message.into(),
        retryable: false,
        http_status: None,
        retry_after_ms: None,
    }
}

fn provider_error(
    compactor: &ConfiguredCompactor,
    code: ProviderErrorCode,
    message: impl Into<String>,
) -> ProviderError {
    ProviderError::new(
        code,
        &compactor.provider,
        compactor.protocol.config_name(),
        message,
    )
}

/// Sends the exact admitted bytes with timeout and cancellation. The session
/// controller owns this send; `dispatch_after_admission` is not used.
pub async fn generate(
    compactor: &ConfiguredCompactor,
    request: &PlannedRequest,
    token: &str,
    cancel: &CancellationToken,
) -> Result<GeneratedCandidate, ProtocolError> {
    let deadline = std::time::Duration::from_millis(compactor.timeout_ms);
    let send = send_once(compactor, request, token, cancel);
    match tokio::time::timeout(deadline, send).await {
        Err(_) => Err(compaction_error(
            "E_COMPACTION_TIMEOUT",
            ErrorClass::Timeout,
            "The compactor exceeded its deadline.",
        )),
        Ok(Err(SendFailure::Cancelled)) => Err(compaction_error(
            "E_COMPACTION_CANCELLED",
            ErrorClass::Cancelled,
            "The compaction was cancelled before activation.",
        )),
        Ok(Err(SendFailure::Provider(error))) => Err(crate::turn::provider_protocol_error(&error)),
        Ok(Ok(candidate)) => Ok(candidate),
    }
}

enum SendFailure {
    Cancelled,
    Provider(ProviderError),
}

async fn send_once(
    compactor: &ConfiguredCompactor,
    request: &PlannedRequest,
    token: &str,
    cancel: &CancellationToken,
) -> Result<GeneratedCandidate, SendFailure> {
    let provider =
        |code, message: String| SendFailure::Provider(provider_error(compactor, code, message));
    let headers = build_headers(
        &compactor.provider,
        env!("CARGO_PKG_VERSION"),
        &compactor.extra_headers,
        Some(token),
    )
    .map_err(SendFailure::Provider)?;
    let mut header_map = reqwest::header::HeaderMap::new();
    for (name, value) in &headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            provider(
                ProviderErrorCode::HeaderInvalid,
                "header name is invalid".into(),
            )
        })?;
        let value = reqwest::header::HeaderValue::from_bytes(value.as_bytes()).map_err(|_| {
            provider(
                ProviderErrorCode::HeaderInvalid,
                "header value is invalid".into(),
            )
        })?;
        header_map.append(name, value);
    }
    // The uploaded bytes are the canonical bytes the request hash covers.
    let body = crate::protocol::json::serialize_canonical_string(&request.body)
        .map_err(|error| provider(ProviderErrorCode::RequestSerializeFailed, error.to_string()))?;
    if crate::protocol::hashes::calculate_request_hash(&request.body)
        .ok()
        .as_ref()
        != Some(&request.estimate.request_hash)
    {
        return Err(provider(
            ProviderErrorCode::RequestAdmissionDenied,
            "request bytes differ from the admitted request".into(),
        ));
    }
    let path = if compactor.is_responses() {
        "responses"
    } else {
        "chat/completions"
    };
    let url = format!("{}/{path}", compactor.base_url.trim_end_matches('/'));
    let send = compactor
        .client
        .post(url)
        .headers(header_map)
        .body(body)
        .send();
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(SendFailure::Cancelled),
        result = send => result.map_err(|error| provider(ProviderErrorCode::TransportError, format!("transport: {error}")))?,
    };
    let status = response.status().as_u16();
    let response_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_ascii_lowercase(),
                value.to_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Err(SendFailure::Cancelled),
            next = stream.next() => next,
        };
        match next {
            None => break,
            Some(Err(error)) => {
                return Err(provider(
                    ProviderErrorCode::TransportError,
                    format!("stream: {error}"),
                ))
            }
            Some(Ok(chunk)) => bytes.extend_from_slice(&chunk),
        }
    }
    if !(200..300).contains(&status) {
        // The body is classified and dropped: it may echo the request.
        let code = classify_http(status, &bytes);
        let mut error = http_error(code, status, &response_headers, &[]);
        error.safe_message = format!("provider responded with HTTP {status}");
        return Err(SendFailure::Provider(error));
    }
    let (events, usage) = if compactor.is_responses() {
        let outcome =
            parse_responses_stream(&bytes, &compactor.selection).map_err(SendFailure::Provider)?;
        (outcome.events, outcome.usage.usage)
    } else {
        let outcome = parse_chat_stream(&bytes).map_err(SendFailure::Provider)?;
        (outcome.events, outcome.usage.usage)
    };
    let mut text = String::new();
    for event in events {
        if let OpenAiAdapterEvent::TextDelta { delta, refusal, .. } = event {
            if refusal {
                return Err(provider(
                    ProviderErrorCode::ProviderContentFilter,
                    "the compactor refused".into(),
                ));
            }
            text.push_str(&delta);
        }
    }
    Ok(GeneratedCandidate { text, usage })
}

// ---------------------------------------------------------------------------
// Finalization (§12 steps 7-9)
// ---------------------------------------------------------------------------

fn sorted_ids<T: Ord + Clone>(ids: BTreeSet<T>) -> Vec<T> {
    ids.into_iter().collect()
}

fn content_ids<T: serde::Serialize>(content: &T) -> (Vec<ArtifactId>, Vec<StateId>) {
    let Ok(value) = serde_json::to_value(content) else {
        return (Vec::new(), Vec::new());
    };
    let mut artifacts = BTreeSet::new();
    let mut states = BTreeSet::new();
    collect_ids(&value, "artifact_ids", &mut artifacts);
    collect_ids(&value, "state_ids", &mut states);
    (
        sorted_ids(parsed_ids(artifacts)),
        sorted_ids(parsed_ids(states)),
    )
}

/// Host-owned identity of one finalization: allocated IDs and the attempt it
/// completes.
pub struct FinalizeIds {
    pub compaction_id: CompactionId,
    pub segment_id: SummarySegmentId,
    pub handoff_id: HandoffId,
    pub attempt_started_event_id: EventId,
}

/// Attaches every host-owned field to a validated candidate, renders and
/// bounds the segment and handoff, and computes the final hashes (§9.2, §11).
pub fn finalize(
    snapshot: &CompactionSnapshot,
    candidate: &CompactionCandidateV1,
    compactor: &ConfiguredCompactor,
    config: &EffectiveConfigV1,
    ids: FinalizeIds,
) -> Result<HistoryCompactedV1, Vec<CandidateIssue>> {
    let issue = |path: &str, message: String| {
        vec![CandidateIssue::new(
            CandidateIssueCode::Schema,
            path,
            message,
        )]
    };
    let estimator = GenericTokenEstimatorV1;
    let framing = &compactor.framing;
    let source_input_sha256 =
        digest_of(&snapshot.turn_estimates).map_err(|e| issue("source", e.to_string()))?;
    let source_tokens = snapshot
        .turn_estimates
        .iter()
        .try_fold(0_u64, |sum, estimate| {
            sum.checked_add(estimate.total_tokens)
        })
        .ok_or_else(|| issue("source", "source token sum overflowed".into()))?;
    let estimator_id = snapshot
        .turn_estimates
        .first()
        .map(|estimate| estimate.estimator_id.clone())
        .unwrap_or_default();

    let (segment_artifacts, segment_states) = content_ids(&candidate.segment);
    let segment = SummarySegmentV1 {
        summary_segment_schema_version: 1,
        segment_id: ids.segment_id,
        epoch: snapshot.epoch,
        source: SourceRangeV1 {
            reset_epoch: snapshot.reset_epoch,
            start_sequence: snapshot.selection.source_start_sequence,
            end_sequence: snapshot.selection.source_end_sequence,
            turn_ids: snapshot.selection.turn_ids.clone(),
            event_prefix_hash_before: snapshot.event_prefix_hash_before.clone(),
            source_hash: snapshot.source_hash.clone(),
            source_tokens,
            source_estimator_id: estimator_id.clone(),
            source_input_sha256,
        },
        content: candidate.segment.clone(),
        artifact_ids: segment_artifacts.clone(),
        state_ids: segment_states.clone(),
    };
    let segment_bytes =
        to_canonical_json_bytes(&segment).map_err(|e| issue("segment", e.to_string()))?;
    let segment_estimate = estimator
        .estimate(
            TokenEstimationContext::CompactionSegment,
            &segment_bytes,
            framing,
        )
        .map_err(|e| issue("segment", e.to_string()))?;
    if segment_estimate.total_tokens > config.history.summary_segment_max_tokens {
        return Err(issue(
            "segment",
            format!(
                "segment is {} tokens, over the {} token bound",
                segment_estimate.total_tokens, config.history.summary_segment_max_tokens
            ),
        ));
    }

    let (handoff_artifacts, handoff_states) = content_ids(&candidate.handoff);
    let source_start_sequence = snapshot
        .previous_handoff
        .as_ref()
        .map_or(snapshot.selection.source_start_sequence, |previous| {
            previous.source_start_sequence
        });
    let mut handoff = HistoricalHandoffV1 {
        handoff_schema_version: 1,
        handoff_id: ids.handoff_id,
        reason: HandoffReason::Compaction,
        label: HANDOFF_LABEL.to_owned(),
        epoch: snapshot.epoch,
        lineage_through_epoch: snapshot.epoch,
        source_start_sequence,
        source_end_sequence: snapshot.selection.source_end_sequence,
        based_on_previous_handoff: snapshot.previous_handoff.as_ref().map(|h| h.handoff_id),
        content: candidate.handoff.clone(),
        artifact_ids: handoff_artifacts.clone(),
        state_ids: handoff_states.clone(),
        estimated_tokens: 0,
        estimator_id: String::new(),
        rendered_input_sha256: Sha256Digest::from_bytes([0; 32]),
    };
    // The estimate describes the rendering whose own estimate fields are still
    // zero: those fields cannot describe a rendering that contains them. The
    // final rendering is then bounded as-is below.
    let pre = check_rendered_handoff_tokens(&handoff, &estimator, framing, u64::MAX)
        .map_err(|e| vec![e])?;
    handoff.estimated_tokens = pre.estimate.total_tokens;
    handoff.estimator_id = pre.estimate.estimator_id.clone();
    handoff.rendered_input_sha256 = pre.estimate.input_sha256.clone();
    let rendered = check_rendered_handoff_tokens(
        &handoff,
        &estimator,
        framing,
        config.history.handoff_max_tokens,
    )
    .map_err(|e| vec![e])?;

    let output_estimates = [segment_estimate.clone(), rendered.estimate.clone()];
    let output_input_sha256 =
        digest_of(&output_estimates).map_err(|e| issue("output", e.to_string()))?;
    let output_tokens = segment_estimate
        .total_tokens
        .checked_add(rendered.estimate.total_tokens)
        .ok_or_else(|| issue("output", "output token sum overflowed".into()))?;
    let segment_hash = digest_of(&segment).map_err(|e| issue("segment", e.to_string()))?;
    let handoff_hash = digest_of(&handoff).map_err(|e| issue("handoff", e.to_string()))?;
    let candidate_digest = candidate_hash(candidate).map_err(|e| vec![e])?;

    let artifact_ids = sorted_ids(
        segment_artifacts
            .into_iter()
            .chain(handoff_artifacts)
            .collect(),
    );
    let state_ids = sorted_ids(segment_states.into_iter().chain(handoff_states).collect());
    Ok(HistoryCompactedV1 {
        compaction_schema_version: 1,
        compaction_id: ids.compaction_id,
        policy_version: COMPACTION_POLICY_VERSION.to_owned(),
        epoch: snapshot.epoch,
        reset_epoch: snapshot.reset_epoch,
        source_start_sequence: snapshot.selection.source_start_sequence,
        source_end_sequence: snapshot.selection.source_end_sequence,
        source_hash: snapshot.source_hash.clone(),
        source_turn_ids: snapshot.selection.turn_ids.clone(),
        eligible_source_tokens: snapshot.selection.eligible_mass,
        target_source_tokens: snapshot.selection.target_mass,
        retired_source_tokens: snapshot.selection.selected_mass,
        segment,
        segment_hash,
        handoff,
        handoff_hash,
        candidate_hash: candidate_digest,
        output_tokens,
        strategy: compactor.strategy(),
        provider: compactor.provider.clone(),
        protocol: compactor.protocol.config_name().to_owned(),
        model: compactor.model.clone(),
        model_revision: compactor.profile.model_revision.clone(),
        prompt_version: prompt_version(),
        token_estimator_schema_version: TOKEN_ESTIMATOR_SCHEMA_VERSION,
        estimator_id,
        output_input_sha256,
        artifact_ids,
        state_ids,
        attempt_started_event_id: ids.attempt_started_event_id,
    })
}

// ---------------------------------------------------------------------------
// Durable run (§12)
// ---------------------------------------------------------------------------

/// The session writer's view: the log plus deterministic id/time sources.
pub struct ActivationContext<'a> {
    pub log: &'a mut EventLogStore,
    pub ids: &'a MonotonicUlidGenerator,
    pub clock: &'a dyn Clock,
    pub session_id: SessionId,
    pub config: &'a EffectiveConfigV1,
    /// Target request framing for turn token mass (§6).
    pub framing: &'a FramingProfileV1,
}

impl ActivationContext<'_> {
    fn fresh<T: crate::id::ProtocolUlidId>(&self) -> Result<T, CompactionRunError> {
        self.ids.next_id().map_err(history_error)
    }

    fn append(
        &mut self,
        attempt_id: Option<AttemptId>,
        event: CanonicalEvent,
    ) -> Result<EventId, CompactionRunError> {
        let event_id: EventId = self.fresh()?;
        let envelope = EventEnvelope {
            schema_version: EVENT_SCHEMA_VERSION,
            event_id,
            session_id: self.session_id,
            sequence: self.log.current_sequence() + 1,
            timestamp_ms: self.clock.now_ms(),
            turn_id: None,
            attempt_id,
            event,
        };
        self.log.append_event(&envelope).map_err(history_error)?;
        Ok(event_id)
    }
}

/// One durable compaction attempt that has started and is waiting on the
/// compactor.
pub struct StartedAttempt {
    pub snapshot: CompactionSnapshot,
    pub request: PlannedRequest,
    pub purpose: CompactionPurpose,
    pub attempt_id: AttemptId,
    pub attempt_number: u32,
    pub started_event_id: EventId,
    pub retry_of: Option<AttemptId>,
    token: String,
}

impl std::fmt::Debug for StartedAttempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartedAttempt")
            .field("attempt_id", &self.attempt_id)
            .field("attempt_number", &self.attempt_number)
            .finish_non_exhaustive()
    }
}

/// Result of [`begin`].
#[derive(Debug)]
pub enum Begun {
    Started(Box<StartedAttempt>),
    /// The durable start succeeded but the credential was missing; the attempt
    /// is already failed and nothing was sent.
    Failed(CompactionOutcome),
}

/// A repair continues an existing operation: same purpose, next attempt.
pub struct RepairOf {
    pub previous: Box<StartedAttempt>,
    pub note: RepairNote,
}

/// §12 steps 1-4: snapshot, select, build and admit the request, append the
/// attempt start, then resolve the credential.
pub fn begin(
    ctx: &mut ActivationContext<'_>,
    compactor: &ConfiguredCompactor,
    repair: Option<RepairOf>,
) -> Result<Begun, CompactionRunError> {
    let (snapshot, purpose, attempt_number, retry_of, repair_note) = match repair {
        None => {
            let snapshot = snapshot(ctx.log, ctx.config, ctx.framing)?;
            let purpose = CompactionPurpose {
                compaction_id: ctx.fresh()?,
                epoch: snapshot.epoch,
            };
            (snapshot, purpose, 1, None, None)
        }
        Some(repair) => (
            repair.previous.snapshot,
            repair.previous.purpose,
            repair.previous.attempt_number + 1,
            Some(repair.previous.attempt_id),
            Some(repair.note),
        ),
    };
    let request = plan_request(&snapshot, compactor, ctx.config, repair_note.as_ref())?;
    let attempt_id: AttemptId = ctx.fresh()?;
    let started_event_id = ctx.append(
        Some(attempt_id),
        CanonicalEvent::AssistantAttemptStarted(AssistantAttemptStarted {
            purpose: ProviderAttemptPurpose::Compaction(purpose.clone()),
            attempt_number,
            model: compactor.selection.clone(),
            request_hash: request.estimate.request_hash.clone(),
            admission: request.estimate.snapshot.clone(),
            retry_of,
            emergency_context_retry: false,
            recovery_notices: Vec::new(),
        }),
    )?;
    #[cfg(feature = "failpoints")]
    crate::crash_point::hit("compaction.after_attempt_started");

    // §12 step 4: the credential is resolved only after the durable start.
    let store = load_store(&credentials_path(&compactor.home))
        .unwrap_or_else(|_| CredentialStoreV1::empty());
    let env = compactor.env.clone().unwrap_or_else(|| {
        std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect()
    });
    match resolve_provider_credential(&store, &compactor.provider, None, &env) {
        Ok(token) => Ok(Begun::Started(Box::new(StartedAttempt {
            snapshot,
            request,
            purpose,
            attempt_id,
            attempt_number,
            started_event_id,
            retry_of,
            token,
        }))),
        Err(_) => {
            let error = compaction_error(
                "E_PROVIDER_AUTH",
                ErrorClass::Authentication,
                "The compactor credential is missing.",
            );
            fail_attempt(
                ctx,
                &purpose,
                attempt_id,
                error.clone(),
                false,
                ProviderUsage::default(),
            )?;
            Ok(Begun::Failed(CompactionOutcome::Failed {
                compaction_id: purpose.compaction_id,
                attempt_id,
                error,
            }))
        }
    }
}

fn fail_attempt(
    ctx: &mut ActivationContext<'_>,
    purpose: &CompactionPurpose,
    attempt_id: AttemptId,
    error: ProtocolError,
    sent: bool,
    usage: ProviderUsage,
) -> Result<(), CompactionRunError> {
    ctx.append(
        Some(attempt_id),
        CanonicalEvent::AssistantAttemptFailed(AssistantAttemptFailed {
            purpose: ProviderAttemptPurpose::Compaction(purpose.clone()),
            error,
            partial_output: PartialAssistantOutput {
                blocks: Vec::new(),
                provider_response_id: None,
            },
            observable_delta_emitted: false,
            provider_may_have_completed: sent,
            usage,
        }),
    )?;
    Ok(())
}

/// Result of [`finish`].
#[derive(Debug)]
pub enum Finished {
    Done(CompactionOutcome),
    /// The candidate failed validation; the attempt is failed and one repair
    /// may follow under the attempt budget.
    Invalid {
        outcome: CompactionOutcome,
        note: RepairNote,
    },
}

fn candidate_invalid(issues: &[CandidateIssue]) -> ProtocolError {
    let mut summary: Vec<String> = issues
        .iter()
        .take(8)
        .map(|issue| format!("{} at {}", issue.code.code(), issue.path))
        .collect();
    if issues.len() > 8 {
        summary.push(format!("and {} more", issues.len() - 8));
    }
    let mut message = format!(
        "The compaction candidate is invalid: {}.",
        summary.join("; ")
    );
    let mut end = message.len().min(512);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message.truncate(end);
    compaction_error(
        "E_COMPACTION_CANDIDATE_INVALID",
        ErrorClass::InvalidProviderOutput,
        message,
    )
}

/// §12 steps 6-12: validate the candidate, recheck the frozen source, attach
/// host fields, append `HistoryCompacted`, and supersede a failed predecessor.
pub fn finish(
    ctx: &mut ActivationContext<'_>,
    compactor: &ConfiguredCompactor,
    started: &mut StartedAttempt,
    generated: Result<GeneratedCandidate, ProtocolError>,
) -> Result<Finished, CompactionRunError> {
    let failed = |ctx: &mut ActivationContext<'_>,
                  error: ProtocolError,
                  usage: ProviderUsage|
     -> Result<CompactionOutcome, CompactionRunError> {
        fail_attempt(
            ctx,
            &started.purpose,
            started.attempt_id,
            error.clone(),
            true,
            usage,
        )?;
        Ok(CompactionOutcome::Failed {
            compaction_id: started.purpose.compaction_id,
            attempt_id: started.attempt_id,
            error,
        })
    };
    let generated = match generated {
        Ok(generated) => generated,
        Err(error) => {
            return Ok(Finished::Done(failed(
                ctx,
                error,
                ProviderUsage::default(),
            )?))
        }
    };

    let usage = generated.usage.clone();
    let mut candidate_digest = None;
    let validated = parse_candidate(generated.text.as_bytes())
        .map_err(|issue| vec![issue])
        .and_then(|candidate| {
            candidate_digest = candidate_hash(&candidate).ok();
            validate_candidate(&candidate, &started.snapshot.universe).map(|()| candidate)
        });
    let candidate = match validated {
        Ok(candidate) => candidate,
        Err(issues) => {
            let outcome = failed(ctx, candidate_invalid(&issues), usage.clone())?;
            return Ok(Finished::Invalid {
                outcome,
                note: RepairNote {
                    candidate_hash: candidate_digest,
                    issues,
                },
            });
        }
    };

    if let Err(reason) = recheck_source_with_prefix(
        &mut started.snapshot,
        ctx.log.events_slice(),
        ctx.log.raw_lines(),
        ctx.log.current_prefix_hash(),
    ) {
        let error = compaction_error(
            "E_COMPACTION_SOURCE_HASH_MISMATCH",
            ErrorClass::Conflict,
            format!("The frozen compaction source changed: {reason}."),
        );
        return Ok(Finished::Done(failed(ctx, error, usage.clone())?));
    }

    let ids = FinalizeIds {
        compaction_id: started.purpose.compaction_id,
        segment_id: ctx.fresh()?,
        handoff_id: ctx.fresh()?,
        attempt_started_event_id: started.started_event_id,
    };
    let compacted = match finalize(&started.snapshot, &candidate, compactor, ctx.config, ids) {
        Ok(compacted) => compacted,
        Err(issues) => {
            let outcome = failed(ctx, candidate_invalid(&issues), usage.clone())?;
            return Ok(Finished::Invalid {
                outcome,
                note: RepairNote {
                    candidate_hash: candidate_digest,
                    issues,
                },
            });
        }
    };
    let retired_turn_ids = compacted.source_turn_ids.clone();
    let epoch = compacted.epoch;
    let event_id = ctx.append(
        Some(started.attempt_id),
        CanonicalEvent::HistoryCompacted(compacted),
    )?;
    #[cfg(feature = "failpoints")]
    crate::crash_point::hit("compaction.after_history_compacted_fsync");
    if let Some(old) = started.retry_of {
        let supersession = ctx.append(
            None,
            CanonicalEvent::AttemptSuperseded(AttemptSuperseded {
                purpose: ProviderAttemptPurpose::Compaction(started.purpose.clone()),
                superseded_attempt_id: old,
                replacement_attempt_id: started.attempt_id,
                replacement_accept_event_id: event_id,
                reason: SupersessionReason::Retry,
            }),
        );
        if supersession.is_err() {
            // Activation is already durable. Stop further writes (including
            // validation failures) and let recovery repair supersession;
            // the caller must still project the durable activation below.
            ctx.log.mark_read_only();
        }
    }
    #[cfg(feature = "failpoints")]
    crate::crash_point::hit("compaction.before_projection_publish");
    Ok(Finished::Done(CompactionOutcome::Activated {
        compaction_id: started.purpose.compaction_id,
        epoch,
        attempt_id: started.attempt_id,
        event_id,
        retired_turn_ids,
        derived_projection_error: None,
    }))
}

/// Runs one compaction operation end to end with at most one schema repair.
/// The repair needs a free `turn.max_attempts` slot for this compaction
/// purpose; otherwise the first failure stands.
pub async fn run(
    ctx: &mut ActivationContext<'_>,
    compactor: &ConfiguredCompactor,
    cancel: &CancellationToken,
) -> Result<CompactionOutcome, CompactionRunError> {
    let mut started = match begin(ctx, compactor, None)? {
        Begun::Started(started) => started,
        Begun::Failed(outcome) => return Ok(outcome),
    };
    let generated = generate(compactor, &started.request, &started.token, cancel).await;
    let (outcome, note) = match finish(ctx, compactor, &mut started, generated)? {
        Finished::Done(outcome) => return Ok(outcome),
        Finished::Invalid { outcome, note } => (outcome, note),
    };
    if started.attempt_number >= ctx.config.turn.max_attempts || cancel.is_cancelled() {
        return Ok(outcome);
    }
    let mut repaired = match begin(
        ctx,
        compactor,
        Some(RepairOf {
            previous: started,
            note,
        }),
    )? {
        Begun::Started(repaired) => repaired,
        Begun::Failed(outcome) => return Ok(outcome),
    };
    let generated = generate(compactor, &repaired.request, &repaired.token, cancel).await;
    Ok(match finish(ctx, compactor, &mut repaired, generated)? {
        Finished::Done(outcome) | Finished::Invalid { outcome, .. } => outcome,
    })
}
