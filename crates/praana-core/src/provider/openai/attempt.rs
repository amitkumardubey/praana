//! Attempt-controller ordering around admission, credentials, and durable events.
//! The wire adapter does not append events; these functions are the controller.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};

use crate::credentials::{resolve_credential, CredentialStoreError, CredentialStoreV1};
use crate::history::event_log::EventLogStore;
use crate::protocol::compaction::{
    EvidenceRefV1, HandoffReason, HistoricalHandoffContentV1, HistoricalHandoffV1,
    HistoricalStatementV1, StatementConfidence,
};
use crate::protocol::events::{
    AssistantAttemptFailed, AssistantStepPurpose, CanonicalEvent, ContinuationDisposition,
    EventEnvelope, ModelChangeReason, ModelChanged, PartialAssistantOutput, ProviderAttemptPurpose,
};
use crate::protocol::hashes::calculate_request_hash;
use crate::protocol::id::{AttemptId, EventId, HandoffId, Sha256Digest, TurnId};
use crate::protocol::messages::ToolCall;
use crate::protocol::models::{ModelSelection, ProviderUsage};
use crate::provider::profile::{profile_hash, ModelCapabilityProfile};
use crate::token::TokenEstimatorV1;
use crate::token::GENERIC_ESTIMATOR_ID;

use super::{AdmissionRequest, OpenAiAdapterEvent, ProviderError, ProviderErrorCode};

pub enum PreRequestDecision {
    Allow,
    Deny {
        code: ProviderErrorCode,
        message: &'static str,
    },
    Rebuild,
}

/// At most two rebuilds. The next rebuild is `request_admission_loop`.
pub fn run_pre_request(
    mut hook: impl FnMut(u32) -> PreRequestDecision,
) -> Result<u32, ProviderError> {
    let mut rebuilds = 0u32;
    loop {
        match hook(rebuilds) {
            PreRequestDecision::Allow => return Ok(rebuilds),
            PreRequestDecision::Deny { code, message } => {
                return Err(ProviderError::new(
                    code,
                    "openai",
                    "openai-chat-v1",
                    message,
                ));
            }
            PreRequestDecision::Rebuild => {
                rebuilds += 1;
                if rebuilds > 2 {
                    return Err(ProviderError::new(
                        ProviderErrorCode::RequestAdmissionLoop,
                        "openai",
                        "openai-chat-v1",
                        "admission rebuild limit",
                    ));
                }
            }
        }
    }
}

pub fn resolve_provider_credential(
    store: &CredentialStoreV1,
    provider: &str,
    explicit: Option<&str>,
    env_vars: &BTreeMap<String, String>,
) -> Result<String, ProviderError> {
    match resolve_credential(store, provider, explicit, env_vars) {
        Ok(resolved) => Ok(resolved.value.to_owned()),
        Err(CredentialStoreError::CredentialMissing) => Err(ProviderError::new(
            ProviderErrorCode::AuthMissing,
            provider,
            "openai-chat-v1",
            "credential missing",
        )),
        Err(_) => Err(ProviderError::new(
            ProviderErrorCode::AuthMissing,
            provider,
            "openai-chat-v1",
            "credential unavailable",
        )),
    }
}

/// Reuse a prior estimate only when both the wire-request hash and the capability-profile hash match.
pub fn admission_for_retry<'a>(
    prior_request_hash: &Sha256Digest,
    prior_profile_hash: &Sha256Digest,
    prior_attempt: AttemptId,
    request: &mut AdmissionRequest<'a>,
) -> Result<(), ProviderError> {
    let request_hash = calculate_request_hash(request.request_body).map_err(|_| {
        ProviderError::new(
            ProviderErrorCode::RequestSerializeFailed,
            "openai",
            "openai-chat-v1",
            "request hash failed",
        )
    })?;
    let profile_digest = profile_digest(request.profile)?;
    request.estimate_reused_from =
        if &request_hash == prior_request_hash && &profile_digest == prior_profile_hash {
            Some(prior_attempt)
        } else {
            None
        };
    Ok(())
}

pub fn profile_digest(
    profile: Option<&ModelCapabilityProfile>,
) -> Result<Sha256Digest, ProviderError> {
    match profile {
        Some(profile) => profile_hash(profile).map_err(|_| {
            ProviderError::new(
                ProviderErrorCode::RequestSerializeFailed,
                "openai",
                "openai-chat-v1",
                "profile hash failed",
            )
        }),
        None => Ok(Sha256Digest::digest_bytes(b"unknown-window")),
    }
}

pub fn crosses_emission(event: &OpenAiAdapterEvent) -> bool {
    match event {
        OpenAiAdapterEvent::TextDelta { delta, .. } => !delta.is_empty(),
        OpenAiAdapterEvent::ReasoningDelta { delta, .. } => !delta.is_empty(),
        OpenAiAdapterEvent::ToolCallStarted { .. }
        | OpenAiAdapterEvent::ToolCallArgumentsDelta { .. } => true,
        _ => false,
    }
}

/// Completion wins only when the terminal event was parsed before cancellation was observed.
/// A tool batch invalidates the previous admission. The next send needs a new decision.
#[derive(Clone, Debug, Default)]
pub struct AttemptGate {
    admitted_request_hash: Option<Sha256Digest>,
}

impl AttemptGate {
    pub fn note_admission(&mut self, request_hash: Sha256Digest) {
        self.admitted_request_hash = Some(request_hash);
    }

    pub fn note_tool_batch(&mut self) {
        self.admitted_request_hash = None;
    }

    pub fn allow_send(&self, request_hash: &Sha256Digest) -> Result<(), ProviderError> {
        if self.admitted_request_hash.as_ref() == Some(request_hash) {
            Ok(())
        } else {
            Err(ProviderError::new(
                ProviderErrorCode::RequestAdmissionDenied,
                "openai",
                "openai-chat-v1",
                "admission required after tool batch",
            ))
        }
    }
}

pub fn terminal_wins(terminal_parsed_before_cancel: bool) -> Result<(), ProviderError> {
    if terminal_parsed_before_cancel {
        Ok(())
    } else {
        Err(ProviderError::new(
            ProviderErrorCode::Aborted,
            "openai",
            "openai-chat-v1",
            "aborted",
        ))
    }
}

#[allow(clippy::too_many_arguments)]
pub fn fail_open_attempt(
    store: &mut EventLogStore,
    event_id: EventId,
    turn_id: TurnId,
    attempt_id: AttemptId,
    purpose: AssistantStepPurpose,
    error: &ProviderError,
    partial_calls: &[ToolCall],
    emitted: bool,
    timestamp_ms: i64,
) -> Result<(), ProviderError> {
    let protocol = error.to_protocol_error().ok_or_else(|| {
        ProviderError::new(
            ProviderErrorCode::CanonicalRequestInvalid,
            &error.provider,
            &error.protocol,
            "failure has no canonical mapping",
        )
    })?;
    let blocks = if emitted {
        partial_calls
            .iter()
            .map(|call| {
                crate::protocol::events::PartialAssistantBlock::ToolCallFragment(
                    crate::protocol::events::PartialToolCall {
                        call_id: Some(call.call_id.clone()),
                        name: Some(call.name.clone()),
                        raw_arguments: call.raw_arguments.clone(),
                    },
                )
            })
            .collect()
    } else {
        Vec::new()
    };
    let envelope = EventEnvelope {
        schema_version: 2,
        event_id,
        session_id: *store.session_id(),
        sequence: store.current_sequence().saturating_add(1),
        timestamp_ms,
        turn_id: Some(turn_id),
        attempt_id: Some(attempt_id),
        event: CanonicalEvent::AssistantAttemptFailed(AssistantAttemptFailed {
            purpose: ProviderAttemptPurpose::AssistantStep(purpose),
            error: protocol,
            partial_output: PartialAssistantOutput {
                blocks,
                provider_response_id: None,
            },
            observable_delta_emitted: emitted,
            provider_may_have_completed: false,
            usage: ProviderUsage::default(),
        }),
    };
    store.append_event(&envelope).map_err(|_| {
        ProviderError::new(
            ProviderErrorCode::PersistenceFailed,
            &error.provider,
            &error.protocol,
            "attempt failure was not durable",
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub fn switch_model(
    store: &mut EventLogStore,
    event_id: EventId,
    handoff_id: HandoffId,
    from: &ModelSelection,
    to: &ModelSelection,
    toolset_hash: Sha256Digest,
    dropped_continuation: bool,
    timestamp_ms: i64,
) -> Result<HistoricalHandoffV1, ProviderError> {
    let label = format!(
        "Switched from {} {} to {} {}.",
        from.provider, from.model, to.provider, to.model
    );
    let rendered = label.as_bytes();
    let framing = crate::token::FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "adapter-estimate:generic:default:v1".into(),
        fixed_tokens: 0,
        per_item_tokens: 0,
        item_count: 0,
        additional_tokens: 0,
    };
    let estimated = crate::token::GenericTokenEstimatorV1
        .estimate(
            crate::token::TokenEstimationContext::ProviderRequestComponent {
                component: crate::token::RequestComponentKind::Handoff,
            },
            rendered,
            &framing,
        )
        .map_err(|_| {
            ProviderError::new(
                ProviderErrorCode::AdmissionArithmeticOverflow,
                &to.provider,
                &to.protocol,
                "handoff estimate failed",
            )
        })?;
    let handoff = HistoricalHandoffV1 {
        handoff_schema_version: 1,
        handoff_id,
        reason: HandoffReason::ModelSwitch,
        label: label.clone(),
        epoch: 0,
        lineage_through_epoch: 0,
        source_start_sequence: 1,
        source_end_sequence: store.current_sequence().max(1),
        based_on_previous_handoff: None,
        content: HistoricalHandoffContentV1 {
            current_goals: vec![HistoricalStatementV1 {
                text: label,
                confidence: StatementConfidence::Direct,
                evidence: EvidenceRefV1::default(),
                uncertainty: None,
            }],
            ..HistoricalHandoffContentV1::default()
        },
        artifact_ids: Vec::new(),
        state_ids: Vec::new(),
        estimated_tokens: estimated.total_tokens,
        estimator_id: GENERIC_ESTIMATOR_ID.to_owned(),
        rendered_input_sha256: estimated.input_sha256,
    };
    if serde_json::to_string(&handoff)
        .unwrap_or_default()
        .contains("opaque-ciphertext")
    {
        return Err(ProviderError::new(
            ProviderErrorCode::CanonicalRequestInvalid,
            &to.provider,
            &to.protocol,
            "handoff must not carry encrypted reasoning",
        ));
    }
    let envelope = EventEnvelope {
        schema_version: 2,
        event_id,
        session_id: *store.session_id(),
        sequence: store.current_sequence().saturating_add(1),
        timestamp_ms,
        turn_id: None,
        attempt_id: None,
        event: CanonicalEvent::ModelChanged(ModelChanged {
            from: from.clone(),
            to: to.clone(),
            reason: ModelChangeReason::UserSelection,
            continuation_disposition: if dropped_continuation {
                ContinuationDisposition::DroppedIncompatible
            } else {
                ContinuationDisposition::None
            },
            handoff: handoff.clone(),
            toolset_hash,
        }),
    };
    store.append_event(&envelope).map_err(|_| {
        ProviderError::new(
            ProviderErrorCode::PersistenceFailed,
            &to.provider,
            &to.protocol,
            "model change was not durable",
        )
    })?;
    Ok(handoff)
}

/// Drops the TCP connection when the consumer is dropped.
pub struct CancellableSocket {
    stream: TcpStream,
}

impl CancellableSocket {
    pub fn connect(authority: &str) -> Result<Self, ProviderError> {
        let stream = TcpStream::connect(authority).map_err(|_| {
            ProviderError::new(
                ProviderErrorCode::TransportError,
                "openai",
                "openai-chat-v1",
                "connect failed",
            )
        })?;
        Ok(Self { stream })
    }

    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, ProviderError> {
        self.stream.read(buf).map_err(|_| {
            ProviderError::new(
                ProviderErrorCode::TransportError,
                "openai",
                "openai-chat-v1",
                "read failed",
            )
        })
    }
}

impl Drop for CancellableSocket {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

impl Write for CancellableSocket {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.stream.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}
