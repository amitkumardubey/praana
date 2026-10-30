//! P4A history retrieval and search. Expected red until
//! `history::{retrieve,search,cursor,checkpoint}` and the history built-ins exist.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
#[cfg(feature = "failpoints")]
use std::time::{Duration, Instant};

use praana_core::canonical_json::to_canonical_json_bytes;
use praana_core::config::types::{CircuitConfig, RiskConfig, ToolsConfig};
use praana_core::history::artifact::{ArtifactPolicy, ArtifactStore, PublishInput};
use praana_core::history::checkpoint::HistoryDerivedCheckpointV1;
use praana_core::history::checkpoint::HistoryProjector;
use praana_core::history::db::HistoryDatabase;
use praana_core::history::event_log::EventLogStore;
use praana_core::history::preview::ArtifactContentType;
use praana_core::history::retrieve::{
    read_session_source, retrieve_artifact, ArtifactRetrievedContent, ArtifactSelector,
    InclusiveLineRange, ReadSessionSourceRequest, RegexFilter, RetrieveArtifactRequest,
    HISTORY_TOOL_RESULT_MAX_BYTES,
};
use praana_core::history::search::{
    search_session, SearchSourceKind, SessionSearchFilters, SessionSearchMode, SessionSearchRequest,
};
use praana_core::history::ArtifactError;
use praana_core::id::MonotonicUlidGenerator;
use praana_core::protocol::compaction::{
    CompactorStrategy, EvidenceRefV1, HandoffReason, HistoricalHandoffContentV1,
    HistoricalHandoffV1, HistoricalStatementV1, HistoryCompactedV1, SourceRangeV1,
    StatementConfidence, SummarySegmentContentV1, SummarySegmentV1,
};
use praana_core::protocol::constants::TOOL_RESULT_MEDIA_TYPE;
use praana_core::protocol::events::{
    AssistantAttemptStarted, AssistantStepAccepted, AssistantStepPurpose, CanonicalEvent,
    CompactionPurpose, EventEnvelope, ProviderAttemptPurpose, ResetBoundary, SessionStarted,
    ToolBatchCompleted, ToolExecutionFinished, ToolExecutionStarted, TurnCommitted, TurnStarted,
    UserMessageAccepted,
};
use praana_core::protocol::hashes::{
    calculate_accepted_messages_hash, calculate_result_messages_hash, calculate_source_hash,
    calculate_tool_arguments_hash,
};
use praana_core::protocol::id::*;
use praana_core::protocol::json::serialize_canonical_string;
use praana_core::protocol::messages::{
    AssistantBlock, AssistantMessage, AssistantPhase, ConversationMessage, FinishReason,
    ReasoningSummaryBlock, RefusalBlock, TextBlock, ToolCall, UserBlock, UserMessage,
};
use praana_core::protocol::models::{
    AdmissionSnapshot, HistoryMode, ModelSelection, ProviderUsage, ReasoningEffort,
};
use praana_core::protocol::tool_result::{
    InlineToolResult, ToolResultBody, ToolResultContent, ToolResultMessage, ToolResultStatus,
};
use praana_core::tools::builtin::history::register_phase4_history;
use praana_core::tools::{
    BatchOrigin, DurableBatchOutcome, DurableSession, ProviderToolCall, ToolBatchRequest,
    ToolCallOrigin, ToolName, ToolRuntime,
};
use praana_core::ui_contract::CoreCommand;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

const SESSION_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

fn ulid(suffix: &str) -> String {
    let mut id = String::from("01ARZ3NDEKTSV4RRFFQ69G5F");
    id.push_str(suffix);
    assert_eq!(id.len(), 26, "{id}");
    id
}

fn session_id() -> SessionId {
    SessionId::from_str_canonical(SESSION_ID).unwrap()
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/history_search")
}

struct TestSession {
    dir: PathBuf,
    log: EventLogStore,
    db: HistoryDatabase,
    clock: Arc<dyn praana_core::clock::Clock>,
    attempt_ordinal: u32,
    turn_ordinal: u32,
    user_message_ordinal: u32,
    assistant_message_ordinal: u32,
    execution_ordinal: u32,
    call_ordinal: u32,
    used_attempt_ids: HashSet<String>,
    used_turn_ids: HashSet<String>,
    step_attempt: HashMap<String, String>,
    step_index: u32,
    open_turn_index: u64,
    turn_step_ids: Vec<String>,
    turn_batch_ids: Vec<String>,
    conversation: Vec<ConversationMessage>,
    step_call_args: Vec<Value>,
    result_messages: Vec<ToolResultMessage>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolBody {
    Inline(&'static str),
    Artifact(&'static str),
}

impl TestSession {
    fn new(dir: &Path) -> Self {
        fs::create_dir_all(dir).unwrap();
        let log = EventLogStore::create_or_open(dir, SESSION_ID).unwrap();
        let db = HistoryDatabase::open(&dir.join("history.db")).unwrap();
        let clock: Arc<dyn praana_core::clock::Clock> = Arc::new(praana_core::clock::SystemClock);
        let mut session = Self {
            dir: dir.to_path_buf(),
            log,
            db,
            clock,
            attempt_ordinal: 0,
            turn_ordinal: 0,
            user_message_ordinal: 0,
            assistant_message_ordinal: 0,
            execution_ordinal: 0,
            call_ordinal: 0,
            used_attempt_ids: HashSet::new(),
            used_turn_ids: HashSet::new(),
            step_attempt: HashMap::new(),
            step_index: 0,
            open_turn_index: 0,
            turn_step_ids: Vec::new(),
            turn_batch_ids: Vec::new(),
            conversation: Vec::new(),
            step_call_args: Vec::new(),
            result_messages: Vec::new(),
        };
        session.append(
            CanonicalEvent::SessionStarted(session_started()),
            None,
            None,
        );
        session
    }

    fn append(
        &mut self,
        event: CanonicalEvent,
        turn_id: Option<TurnId>,
        attempt_id: Option<AttemptId>,
    ) -> EventId {
        let sequence = self.log.current_sequence() + 1;
        let event_id = EventId::from_str_canonical(&ulid(&format!("{:02X}", sequence))).unwrap();
        let envelope = EventEnvelope {
            schema_version: 2,
            event_id,
            session_id: session_id(),
            sequence,
            timestamp_ms: 1_700_000_000_000 + sequence as i64,
            turn_id,
            attempt_id,
            event,
        };
        self.log.append_event(&envelope).unwrap();
        event_id
    }

    fn user_message(&mut self, turn_id: &str, texts: &[&str]) -> String {
        let turn_str = if self.used_turn_ids.contains(turn_id) {
            let generated = ulid(&format!("G{:X}", self.turn_ordinal));
            self.turn_ordinal += 1;
            generated
        } else {
            turn_id.to_owned()
        };
        self.used_turn_ids.insert(turn_str.clone());
        let turn_id = TurnId::from_str_canonical(&turn_str).unwrap();
        let message_str = if self.user_message_ordinal == 0 {
            "01ARZ3NDEKTSV4RRFFQ69G5FAZ".to_owned()
        } else {
            let generated = ulid(&format!("F{:X}", self.user_message_ordinal));
            generated
        };
        self.user_message_ordinal += 1;
        let blocks = texts
            .iter()
            .map(|text| {
                UserBlock::Text(TextBlock {
                    text: (*text).to_owned(),
                })
            })
            .collect();
        let message = UserMessage {
            message_id: MessageId::from_str_canonical(&message_str).unwrap(),
            turn_id,
            blocks,
        };
        self.conversation.clear();
        self.conversation
            .push(ConversationMessage::User(message.clone()));
        self.append(
            CanonicalEvent::UserMessageAccepted(UserMessageAccepted { message }),
            Some(turn_id),
            None,
        );
        message_str
    }

    fn turn_started(&mut self, turn_id: &str, user_message_id: &str) {
        let turn_id = TurnId::from_str_canonical(turn_id).unwrap();
        self.step_index = 0;
        self.open_turn_index += 1;
        self.turn_step_ids.clear();
        self.turn_batch_ids.clear();
        self.append(
            CanonicalEvent::TurnStarted(TurnStarted {
                turn_index: self.open_turn_index,
                user_message_id: MessageId::from_str_canonical(user_message_id).unwrap(),
                model: model_selection(),
                toolset_hash: Sha256Digest::from_hex_str(
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                )
                .unwrap(),
                max_steps: 10,
            }),
            Some(turn_id),
            None,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn assistant_step(
        &mut self,
        turn_id: &str,
        attempt_id: &str,
        step_id: &str,
        text: Option<&str>,
        reasoning: Option<&str>,
        refusal: Option<&str>,
        tool_calls: &[(&str, Value)],
    ) {
        let turn_id = TurnId::from_str_canonical(turn_id).unwrap();
        let step_id = StepId::from_str_canonical(step_id).unwrap();
        let attempt_str = if self.used_attempt_ids.contains(attempt_id) {
            let generated = ulid(&format!("Y{:X}", self.attempt_ordinal));
            self.attempt_ordinal += 1;
            generated
        } else {
            attempt_id.to_owned()
        };
        self.used_attempt_ids.insert(attempt_str.clone());
        self.step_attempt
            .insert(step_id.to_string(), attempt_str.clone());
        let attempt_id = AttemptId::from_str_canonical(&attempt_str).unwrap();
        let step_index = self.step_index;
        self.append(
            CanonicalEvent::AssistantAttemptStarted(
                praana_core::protocol::events::AssistantAttemptStarted {
                    purpose: praana_core::protocol::events::ProviderAttemptPurpose::AssistantStep(
                        AssistantStepPurpose {
                            step_id,
                            step_index,
                        },
                    ),
                    attempt_number: 1,
                    model: model_selection(),
                    request_hash: Sha256Digest::from_hex_str(
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    )
                    .unwrap(),
                    admission: praana_core::protocol::models::AdmissionSnapshot {
                        token_estimator_schema_version: 1,
                        estimator_id: "generic".to_owned(),
                        estimated_input_sha256: Sha256Digest::from_hex_str(
                            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                        )
                        .unwrap(),
                        context_window_tokens: 128_000,
                        estimated_input_tokens: 0,
                        resolved_output_tokens: 0,
                        requested_reasoning_tokens: 0,
                        safety_margin_tokens: 0,
                        projected_fill_millionths: 0,
                        capability_profile_hash: Sha256Digest::from_hex_str(
                            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                        )
                        .unwrap(),
                        estimate_reused_from_attempt_id: None,
                    },
                    retry_of: None,
                    emergency_context_retry: false,
                    recovery_notices: vec![],
                },
            ),
            Some(turn_id),
            Some(attempt_id),
        );
        let mut blocks = Vec::new();
        if let Some(text) = text {
            blocks.push(AssistantBlock::Text(TextBlock {
                text: text.to_owned(),
            }));
        }
        if let Some(reasoning) = reasoning {
            blocks.push(AssistantBlock::ReasoningSummary(ReasoningSummaryBlock {
                text: reasoning.to_owned(),
                provider_item_id: None,
            }));
        }
        if let Some(refusal) = refusal {
            blocks.push(AssistantBlock::Refusal(RefusalBlock {
                text: refusal.to_owned(),
                provider_item_id: None,
            }));
        }
        self.step_call_args.clear();
        self.result_messages.clear();
        for (name, arguments) in tool_calls {
            self.step_call_args.push(arguments.clone());
            let call_str = format!("call_{:03}", self.call_ordinal + 1);
            self.call_ordinal += 1;
            blocks.push(AssistantBlock::ToolCall(ToolCall {
                call_id: ToolCallId::from_str_canonical(&call_str).unwrap(),
                name: (*name).to_owned(),
                arguments: arguments.as_object().unwrap().clone(),
                raw_arguments: arguments.to_string(),
            }));
        }
        let message = AssistantMessage {
            message_id: MessageId::from_str_canonical(&ulid(&format!(
                "M{:X}",
                self.assistant_message_ordinal
            )))
            .unwrap(),
            turn_id,
            step_id,
            provider: "openai".to_owned(),
            model: "gpt-5".to_owned(),
            phase: Some(AssistantPhase::FinalAnswer),
            blocks,
            finish_reason: if tool_calls.is_empty() {
                FinishReason::Stop
            } else {
                FinishReason::ToolUse
            },
            continuation: None,
            usage: ProviderUsage {
                input_tokens: 0,
                output_tokens: 0,
                reasoning_tokens: 0,
                total_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            },
        };
        self.append(
            CanonicalEvent::AssistantStepAccepted(AssistantStepAccepted {
                purpose: AssistantStepPurpose {
                    step_id,
                    step_index,
                },
                message: message.clone(),
            }),
            Some(turn_id),
            Some(attempt_id),
        );
        self.assistant_message_ordinal += 1;
        self.step_index += 1;
        self.turn_step_ids.push(step_id.to_string());
        self.conversation
            .push(ConversationMessage::Assistant(message));
    }

    #[allow(clippy::too_many_arguments)]
    fn tool_execution(
        &mut self,
        turn_id: &str,
        attempt_id: &str,
        step_id: &str,
        batch_id: &str,
        call_id: &str,
        call_index: u32,
        tool_name: &str,
        body: ToolBody,
    ) -> (EventId, Option<ArtifactId>) {
        let ord = self.execution_ordinal;
        self.execution_ordinal += 1;
        let turn_id = TurnId::from_str_canonical(turn_id).unwrap();
        let attempt_str = self
            .step_attempt
            .get(step_id)
            .cloned()
            .unwrap_or_else(|| attempt_id.to_owned());
        let attempt_id = AttemptId::from_str_canonical(&attempt_str).unwrap();
        let step_id = StepId::from_str_canonical(step_id).unwrap();
        let batch_id = ToolBatchId::from_str_canonical(batch_id).unwrap();
        let call_id = ToolCallId::from_str_canonical(call_id).unwrap();
        let execution_id =
            ToolExecutionId::from_str_canonical(&ulid(&format!("X{:X}", ord))).unwrap();
        let started_event_id = self.append(
            CanonicalEvent::ToolExecutionStarted(ToolExecutionStarted {
                batch_id,
                execution_id,
                step_id,
                call_id: call_id.clone(),
                call_index,
                tool_name: tool_name.to_owned(),
                arguments_hash: calculate_tool_arguments_hash(
                    &self.step_call_args[call_index as usize],
                )
                .unwrap(),
                mutability: praana_core::protocol::events::ToolMutability::ReadOnly,
            }),
            Some(turn_id),
            Some(attempt_id),
        );
        let text = match body {
            ToolBody::Inline(text) => text,
            ToolBody::Artifact(text) => text,
        };
        match body {
            ToolBody::Inline(_) => {
                let sha = Sha256Digest::digest_bytes(text.as_bytes());
                let result = ToolResultMessage {
                    message_id: MessageId::from_str_canonical(&ulid(&format!("R{:X}", ord)))
                        .unwrap(),
                    turn_id,
                    step_id,
                    batch_id,
                    execution_id,
                    call_id: call_id.clone(),
                    tool_name: tool_name.to_owned(),
                    status: ToolResultStatus::Success,
                    body: ToolResultBody {
                        media_type: TOOL_RESULT_MEDIA_TYPE.to_owned(),
                        content: ToolResultContent::Inline(InlineToolResult {
                            text: text.to_owned(),
                        }),
                        sha256: sha.clone(),
                        byte_count: text.len() as u64,
                        line_count: None,
                        estimated_tokens: 0,
                        token_estimator_schema_version: 1,
                        estimator_id: "generic".to_owned(),
                        token_input_sha256: sha,
                        redacted: false,
                    },
                    recovered: false,
                };
                self.result_messages.push(result.clone());
                self.conversation
                    .push(ConversationMessage::ToolResult(result.clone()));
                let finish_event_id = self.append(
                    CanonicalEvent::ToolExecutionFinished(ToolExecutionFinished {
                        batch_id,
                        execution_id,
                        step_id,
                        call_id: call_id.clone(),
                        call_index,
                        started_event_id: Some(started_event_id),
                        result,
                    }),
                    Some(turn_id),
                    Some(attempt_id),
                );
                (finish_event_id, None)
            }
            ToolBody::Artifact(_) => {
                let binary = text.contains('\u{0}');
                let data = match serde_json::from_str::<Value>(text) {
                    Ok(value @ (Value::Object(_) | Value::Array(_))) => value,
                    _ => json!({ "content": text }),
                };
                let dto = json!({
                    "artifacts": [],
                    "data": data,
                    "error": null,
                    "meta": {
                        "cancelled": false,
                        "duration_ms": 0,
                        "redacted": false,
                        "timed_out": false,
                        "tool_call_id": call_id.to_string(),
                        "tool_name": tool_name,
                        "truncated": false
                    },
                    "ok": true,
                    "warnings": []
                });
                let canonical_bytes = to_canonical_json_bytes(&dto).unwrap();
                let store = ArtifactStore::open(
                    &self.dir.join("history.db"),
                    ArtifactPolicy {
                        inline_tokens: 0,
                        batch_inline_tokens: 0,
                        preview_tokens: 160,
                        orphan_retention_days: 7,
                    },
                    self.clock.clone(),
                )
                .unwrap();
                let finish_event_id =
                    EventId::from_str_canonical(&ulid(&format!("E{:X}", ord))).unwrap();
                let result_message_id =
                    MessageId::from_str_canonical(&ulid(&format!("R{:X}", ord))).unwrap();
                let artifact_id =
                    ArtifactId::from_str_canonical(&ulid(&format!("D{:X}", ord))).unwrap();
                let input = PublishInput {
                    artifact_id,
                    finish_event_id,
                    result_message_id,
                    canonical_bytes,
                    content_type: if binary {
                        ArtifactContentType::Binary
                    } else {
                        ArtifactContentType::Json
                    },
                    tool_name: tool_name.to_owned(),
                    call_id: call_id.clone(),
                    call_index,
                    execution_id,
                    batch_id,
                    step_id,
                    turn_id,
                    attempt_id,
                    execution_started: true,
                    started_event_id: Some(started_event_id),
                    status: ToolResultStatus::Success,
                    label: Some(tool_name.to_owned()),
                    normalized_path: None,
                    exit_code: None,
                    redacted: false,
                    redaction_json: "{\"applied\":false,\"replacement_count\":0,\"kinds\":[]}"
                        .to_owned(),
                    force_binary: binary,
                };
                let outcomes = store
                    .publish_batch(&mut self.log, std::slice::from_ref(&input), None)
                    .unwrap();
                let events = self.log.events().unwrap();
                let finish = events
                    .iter()
                    .find(|envelope| envelope.event_id == finish_event_id)
                    .and_then(|envelope| match &envelope.event {
                        CanonicalEvent::ToolExecutionFinished(finished) => Some(finished),
                        _ => None,
                    })
                    .expect("published finish event exists");
                self.result_messages.push(finish.result.clone());
                self.conversation
                    .push(ConversationMessage::ToolResult(finish.result.clone()));
                let stored = outcomes
                    .into_iter()
                    .next()
                    .and_then(|outcome| outcome.artifact_id);
                (finish_event_id, stored)
            }
        }
    }

    fn batch_completed(
        &mut self,
        turn_id: &str,
        attempt_id: &str,
        step_id: &str,
        batch_id: &str,
        call_ids: &[&str],
        result_event_ids: &[EventId],
    ) {
        let turn_id = TurnId::from_str_canonical(turn_id).unwrap();
        let attempt_str = self
            .step_attempt
            .get(step_id)
            .cloned()
            .unwrap_or_else(|| attempt_id.to_owned());
        let attempt_id = AttemptId::from_str_canonical(&attempt_str).unwrap();
        let step_id = StepId::from_str_canonical(step_id).unwrap();
        let batch_id = ToolBatchId::from_str_canonical(batch_id).unwrap();
        self.turn_batch_ids.push(batch_id.to_string());
        self.append(
            CanonicalEvent::ToolBatchCompleted(ToolBatchCompleted {
                batch_id,
                step_id,
                call_ids: call_ids
                    .iter()
                    .map(|id| ToolCallId::from_str_canonical(id).unwrap())
                    .collect(),
                result_event_ids: result_event_ids.to_vec(),
                result_messages_hash: calculate_result_messages_hash(&self.result_messages)
                    .unwrap(),
            }),
            Some(turn_id),
            Some(attempt_id),
        );
    }

    fn turn_committed(&mut self, turn_id: &str, user_message_id: &str, step_id: &str) {
        let turn_id = TurnId::from_str_canonical(turn_id).unwrap();
        let terminal = self
            .turn_step_ids
            .last()
            .expect("committed turn needs an accepted step")
            .clone();
        debug_assert_eq!(
            terminal, step_id,
            "terminal step passed to turn_committed must be the last accepted step"
        );
        let accepted_step_ids: Vec<StepId> = self
            .turn_step_ids
            .iter()
            .map(|id| StepId::from_str_canonical(id).unwrap())
            .collect();
        let completed_batch_ids: Vec<ToolBatchId> = self
            .turn_batch_ids
            .iter()
            .map(|id| ToolBatchId::from_str_canonical(id).unwrap())
            .collect();
        let accepted_messages_hash = calculate_accepted_messages_hash(&self.conversation).unwrap();
        self.append(
            CanonicalEvent::TurnCommitted(TurnCommitted {
                turn_index: self.open_turn_index,
                user_message_id: MessageId::from_str_canonical(user_message_id).unwrap(),
                terminal_step_id: StepId::from_str_canonical(&terminal).unwrap(),
                accepted_step_ids,
                completed_batch_ids,
                outcome: praana_core::protocol::events::TurnOutcome::Stop,
                accepted_messages_hash,
                usage: ProviderUsage {
                    input_tokens: 0,
                    output_tokens: 0,
                    reasoning_tokens: 0,
                    total_tokens: 0,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                },
                recovery_notice_ids_presented: vec![],
            }),
            Some(turn_id),
            None,
        );
    }

    fn reset(&mut self) {
        self.append(
            CanonicalEvent::ResetBoundary(ResetBoundary {
                reset_epoch: 1,
                command: "clear".to_owned(),
                reason: None,
                clears_state: true,
                previous_turn_id: None,
            }),
            None,
            None,
        );
    }

    fn project(&self) {
        let projector = HistoryProjector::new(&self.db);
        projector.project(&self.log).unwrap();
    }

    fn try_project(&self) -> Result<(), ArtifactError> {
        let projector = HistoryProjector::new(&self.db);
        projector.project(&self.log)
    }

    fn search_conn(&self) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(self.dir.join("history.db")).unwrap();
        conn.pragma_update(None, "query_only", true).unwrap();
        conn
    }

    fn hmac_key(&self) -> [u8; 32] {
        let text = fs::read_to_string(self.dir.join("meta.json")).unwrap();
        let meta: Value = serde_json::from_str(text.trim_end_matches('\n')).unwrap();
        let key_b64 = meta["cursor_hmac_key_base64"].as_str().unwrap();
        decode_base64(key_b64).try_into().unwrap()
    }
}

fn session_started() -> SessionStarted {
    SessionStarted {
        cwd: "/workspace/praana".into(),
        agent: "praana".into(),
        config_schema_version: 1,
        config_digest_sha256: Sha256Digest::from_hex_str(
            "1aecaa286f1f61128b79b8ff623dfc99bf40a786ce0997bb6d7a00f101328760",
        )
        .unwrap(),
        history_mode: HistoryMode::Append,
        projection_version: ProjectionId::from_str_canonical(
            praana_core::protocol::constants::PROJECTION_VERSION,
        )
        .unwrap(),
        compaction_policy_version: "rust-v2-compaction-1".into(),
        artifact_policy_version: "rust-v2-artifact-1".into(),
        token_estimator_schema_version: 1,
        unicode_utility_version: "praana-unicode-15.1-v1".into(),
        system_context_schema_version: 1,
        provider_registry_schema_version: 1,
        builtin_tool_catalog_schema_version: 1,
        redaction_version: "praana-redaction-v1".into(),
        ui_contract_schema_version: 1,
        initial_model: model_selection(),
        initial_toolset_hash: Sha256Digest::from_hex_str(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap(),
    }
}

fn model_selection() -> ModelSelection {
    ModelSelection {
        provider: "openai".into(),
        protocol: "openai-responses-v1".into(),
        model: "gpt-5".into(),
        model_revision: None,
        model_family: "gpt-5".into(),
        endpoint_fingerprint: Sha256Digest::from_hex_str(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap(),
        reasoning_effort: ReasoningEffort::Medium,
    }
}

fn decode_base64(text: &str) -> Vec<u8> {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut map = [255u8; 256];
    for (i, &c) in TABLE.iter().enumerate() {
        map[c as usize] = i as u8;
    }
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;
    for &c in text.as_bytes() {
        if c == b'=' {
            break;
        }
        let v = map[c as usize];
        if v == 255 {
            continue;
        }
        buffer = (buffer << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

fn retrieve_request(artifact_id: &str) -> RetrieveArtifactRequest {
    RetrieveArtifactRequest {
        artifact_id: ArtifactId::from_str_canonical(artifact_id).unwrap(),
        selector: None,
        line_range: None,
        head_lines: None,
        tail_lines: None,
        regex: None,
        json_pointer: None,
        byte_offset: None,
        max_bytes: None,
    }
}

fn derived_checkpoint(session: &TestSession) -> HistoryDerivedCheckpointV1 {
    HistoryProjector::new(&session.db)
        .checkpoint()
        .unwrap()
        .expect("history_derived checkpoint")
}

fn history_tool_runtime(session_dir: &Path) -> ToolRuntime {
    let runtime = ToolRuntime::new(
        register_phase4_history().unwrap(),
        ToolsConfig {
            allowed_paths: Vec::new(),
            default_timeout_ms: 60_000,
            max_parallel_calls: 4,
            max_spawned_processes: 4,
            shell_enabled: false,
            shell_max_timeout_ms: 600_000,
            shell_timeout_ms: 30_000,
        },
        RiskConfig { allow: Vec::new() },
        CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
    );
    runtime.set_workspace(session_dir.to_path_buf());
    runtime.set_session(session_dir.to_path_buf(), session_id());
    runtime
}

#[allow(clippy::too_many_arguments)]
async fn execute_search(
    runtime: &ToolRuntime,
    session: &mut TestSession,
    artifacts: &ArtifactStore,
    ids: &MonotonicUlidGenerator,
    clock: &dyn praana_core::clock::Clock,
    turn_id: &str,
    attempt_id: &str,
    step_id: &str,
    batch_id: &str,
    call_id: &str,
    arguments: Value,
) -> praana_core::tools::FinishedCall {
    let request = ToolBatchRequest {
        batch_id: ToolBatchId::from_str_canonical(batch_id).unwrap(),
        session_id: session_id(),
        turn_id: TurnId::from_str_canonical(turn_id).unwrap(),
        attempt_id: AttemptId::from_str_canonical(attempt_id).unwrap(),
        calls: vec![ProviderToolCall {
            tool_call_id: ToolCallId::from_str_canonical(call_id).unwrap(),
            tool_name: ToolName::new("search_session_log").unwrap(),
            arguments,
            provider_ordinal: 0,
        }],
        origin: ToolCallOrigin::Model,
    };
    let mut durable = DurableSession {
        log: &mut session.log,
        artifacts,
        ids,
        clock,
        session_id: session_id(),
        step_id: StepId::from_str_canonical(step_id).unwrap(),
        fault_after_body: false,
        recovery_cancelled_calls: Default::default(),
    };
    let outcome = runtime
        .execute_durable_batch(
            request,
            BatchOrigin::Model,
            CancellationToken::new(),
            &mut durable,
        )
        .await
        .expect("search batch");
    let DurableBatchOutcome::Finished(batch) = outcome else {
        panic!("search batch did not finish");
    };
    batch.results.into_iter().next().expect("one search call")
}

fn tool_page(finished: &praana_core::tools::FinishedCall) -> Value {
    if !finished.dto.ok {
        let history = finished
            .dto
            .error
            .as_ref()
            .and_then(|error| error.details.as_ref())
            .and_then(|details| details.get("history_code"))
            .and_then(|code| code.as_str())
            .unwrap_or("unknown");
        panic!("search_session_log failed: {history}");
    }
    finished
        .dto
        .data
        .as_ref()
        .and_then(|data| data.get("page"))
        .cloned()
        .expect("search page")
}

fn log_has_finish(session: &TestSession, call_id: &str) -> bool {
    session.log.events().unwrap().iter().any(|event| {
        matches!(
            &event.event,
            CanonicalEvent::ToolExecutionFinished(finish) if finish.call_id.as_str() == call_id
        )
    })
}

/// 32-byte HMAC tag plus 256 zero bytes. A length mix folded through `as u8`
/// treats a difference of 256 as equal.
fn extend_tag(cursor: &str) -> String {
    let (body, tag) = cursor.split_once('.').expect("cursor separator");
    let mut raw = base64url_decode(tag).expect("cursor tag");
    assert_eq!(raw.len(), 32);
    raw.extend(std::iter::repeat_n(0u8, 256));
    format!("{body}.{}", base64url_no_pad(&raw))
}

/// Sets the unused low bits of the tag's final base64url character. The
/// decoded 32 bytes stay the same, so a decoder that ignores trailing bits
/// still accepts the original HMAC.
fn flip_tag_trailing_bits(cursor: &str) -> String {
    let (body, tag) = cursor.split_once('.').expect("cursor separator");
    let last = tag.as_bytes().last().copied().expect("tag char");
    let value = match last {
        b'A'..=b'Z' => last - b'A',
        b'a'..=b'z' => last - b'a' + 26,
        b'0'..=b'9' => last - b'0' + 52,
        b'-' => 62,
        b'_' => 63,
        _ => panic!("tag alphabet"),
    };
    assert_eq!(value & 0b11, 0);
    let flipped = TEST_B64URL[(value | 0b01) as usize] as char;
    let mut tag = tag.to_owned();
    tag.pop();
    tag.push(flipped);
    format!("{body}.{tag}")
}

fn assert_stale(session: &TestSession, key: &[u8; 32], cursor: &str) {
    let cancel = CancellationToken::new();
    let mut request = search_request("marker", SessionSearchMode::Exact);
    request.limit = 1;
    request.cursor = Some(cursor.to_owned());
    match search_session(&session.search_conn(), &request, key, &cancel) {
        Err(err) => assert_eq!(err.code(), "HISTORY_SEARCH_CURSOR_STALE"),
        Ok(_) => panic!("expected stale cursor"),
    }
}

fn cursor_json(cursor: &str) -> Value {
    let (body, _) = cursor.split_once('.').expect("cursor separator");
    let bytes = base64url_decode(body).expect("cursor body");
    serde_json::from_slice(&bytes).expect("cursor json")
}

fn cursor_u64(cursor: &str, field: &str) -> Option<u64> {
    cursor_json(cursor).get(field).and_then(Value::as_u64)
}

fn resign(payload: &Value, key: &[u8; 32]) -> String {
    let bytes = to_canonical_json_bytes(payload).unwrap();
    let tag = test_hmac_sha256(key, &bytes);
    format!("{}.{}", base64url_no_pad(&bytes), base64url_no_pad(&tag))
}

fn tamper(cursor: &str, tag_section: bool) -> String {
    let (body, tag) = cursor.split_once('.').expect("cursor separator");
    let (target, keep) = if tag_section {
        (tag, body)
    } else {
        (body, tag)
    };
    let mut chars: Vec<char> = target.chars().collect();
    chars[0] = if chars[0] == 'A' { 'B' } else { 'A' };
    let changed: String = chars.into_iter().collect();
    if tag_section {
        format!("{keep}.{changed}")
    } else {
        format!("{changed}.{keep}")
    }
}

fn test_hmac_sha256(key: &[u8; 32], message: &[u8]) -> [u8; 32] {
    let mut pad = [0u8; 64];
    pad[..key.len()].copy_from_slice(key);
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for index in 0..64 {
        ipad[index] ^= pad[index];
        opad[index] ^= pad[index];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    outer.finalize().into()
}

const TEST_B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn base64url_no_pad(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TEST_B64URL[(triple >> 18) as usize & 0x3f] as char);
        out.push(TEST_B64URL[(triple >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(TEST_B64URL[(triple >> 6) as usize & 0x3f] as char);
        }
        if chunk.len() > 2 {
            out.push(TEST_B64URL[triple as usize & 0x3f] as char);
        }
    }
    out
}

fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4 + 2);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for &byte in bytes {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        } as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn search_request(query: &str, mode: SessionSearchMode) -> SessionSearchRequest {
    SessionSearchRequest {
        query: query.to_owned(),
        mode,
        case_sensitive: false,
        filters: SessionSearchFilters::default(),
        limit: 20,
        cursor: None,
    }
}

fn build_session_with_texts(
    dir: &Path,
    user_texts: &[&str],
    assistant_texts: &[&str],
) -> TestSession {
    let mut session = TestSession::new(dir);
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    session.user_message(turn_id, user_texts);
    session.turn_started(turn_id, user_message_id);
    let mut terminal = step_id.to_owned();
    for (i, text) in assistant_texts.iter().enumerate() {
        let step = format!("01ARZ3NDEKTSV4RRFFQ69G5FB{}", 3 + i);
        session.assistant_step(turn_id, attempt_id, &step, Some(text), None, None, &[]);
        terminal = step;
    }
    if assistant_texts.is_empty() {
        session.assistant_step(turn_id, attempt_id, step_id, Some("done"), None, None, &[]);
    }
    session.turn_committed(turn_id, user_message_id, &terminal);
    session.project();
    session
}

// §10.1/§10.2 retrieval

#[test]
fn retrieval_line_range_and_head_tail_normalization() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    let call_id = "call_001";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[("read_file", json!({"path": "a.txt"}))],
    );
    let (finish_id, artifact_id) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        call_id,
        0,
        "read_file",
        ToolBody::Artifact("line one\nline two\nline three\n"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &[call_id],
        &[finish_id],
    );
    session.assistant_step(
        turn_id,
        attempt_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        Some("done"),
        None,
        None,
        &[],
    );
    session.turn_committed(turn_id, user_message_id, "01ARZ3NDEKTSV4RRFFQ69G5FB4");
    session.project();

    let artifact_id = artifact_id.unwrap();
    let conn = session.search_conn();
    let cancel = CancellationToken::new();

    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.line_range = Some(InclusiveLineRange { start: 2, end: 3 });
    let response = retrieve_artifact(&conn, &request, &cancel).unwrap();
    assert!(response.complete);
    assert_eq!(response.returned_bytes, 20);
    assert_eq!(
        response.content,
        ArtifactRetrievedContent::Utf8("line two\nline three\n".to_owned())
    );
    assert_eq!(response.selected_line_start, Some(2));
    assert_eq!(response.selected_line_end, Some(3));
    // History §6.2: a non-empty view is 1 + the number of LF bytes, so three
    // LF-terminated lines are four lines; the last one is empty.
    assert_eq!(response.total_lines, Some(4));
    assert!(response.continuation.is_none());

    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.head_lines = Some(1);
    let response = retrieve_artifact(&conn, &request, &cancel).unwrap();
    assert!(response.complete);
    assert_eq!(
        response.content,
        ArtifactRetrievedContent::Utf8("line one\n".to_owned())
    );
    assert!(response.continuation.is_none());

    // An oversized head selection pages with line_range + byte_offset, never head_lines.
    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.head_lines = Some(1);
    request.max_bytes = Some(5);
    let response = retrieve_artifact(&conn, &request, &cancel).unwrap();
    assert!(!response.complete);
    assert_eq!(
        response.content,
        ArtifactRetrievedContent::Utf8("line ".to_owned())
    );
    let continuation = response.continuation.unwrap();
    assert_eq!(
        continuation.line_range,
        Some(InclusiveLineRange { start: 1, end: 1 })
    );
    assert_eq!(continuation.byte_offset, Some(5));
    assert!(continuation.head_lines.is_none());
    assert!(continuation.tail_lines.is_none());
    assert_eq!(continuation.max_bytes, Some(5));

    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.tail_lines = Some(1);
    let response = retrieve_artifact(&conn, &request, &cancel).unwrap();
    // tail_lines normalizes to line_range {4, 4} under the §6.2 count, and the
    // line after the final LF is empty.
    assert_eq!(
        response.content,
        ArtifactRetrievedContent::Utf8(String::new())
    );
    assert_eq!(response.total_lines, Some(4));
    // An empty window returns no bytes, so §10.2 leaves both line fields null.
    assert_eq!(response.selected_line_start, None);
    assert_eq!(response.selected_line_end, None);
}

#[test]
fn retrieval_byte_offset_and_continuation() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    let call_id = "call_001";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[("read_file", json!({"path": "a.txt"}))],
    );
    let (finish_id, artifact_id) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        call_id,
        0,
        "read_file",
        ToolBody::Artifact("abcdefghij\nklmnopqrst\n"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &[call_id],
        &[finish_id],
    );
    session.assistant_step(
        turn_id,
        attempt_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        Some("done"),
        None,
        None,
        &[],
    );
    session.turn_committed(turn_id, user_message_id, "01ARZ3NDEKTSV4RRFFQ69G5FB4");
    session.project();

    let artifact_id = artifact_id.unwrap();
    let conn = session.search_conn();
    let cancel = CancellationToken::new();

    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.byte_offset = Some(5);
    request.max_bytes = Some(10);
    let response = retrieve_artifact(&conn, &request, &cancel).unwrap();
    assert!(!response.complete);
    assert_eq!(response.returned_bytes, 10);
    assert_eq!(
        response.content,
        ArtifactRetrievedContent::Utf8("fghij\nklmn".to_owned())
    );
    assert_eq!(response.selected_line_start, Some(1));
    assert_eq!(response.selected_line_end, Some(2));
    // History §6.2: two LF bytes make three lines.
    assert_eq!(response.total_lines, Some(3));
    let continuation = response.continuation.unwrap();
    assert_eq!(continuation.byte_offset, Some(15));
    // The continuation resumes at the next unreturned line and keeps the
    // original end, which is the §6.2 line count.
    assert_eq!(
        continuation.line_range,
        Some(InclusiveLineRange { start: 2, end: 3 })
    );
    assert_eq!(continuation.max_bytes, Some(10));
}

#[test]
fn retrieval_regex_with_context_merging() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    let call_id = "call_001";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[("read_file", json!({"path": "a.txt"}))],
    );
    let (finish_id, artifact_id) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        call_id,
        0,
        "read_file",
        ToolBody::Artifact("aaa\nmatch one\nbbb\nmatch two\nccc\n"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &[call_id],
        &[finish_id],
    );
    session.assistant_step(
        turn_id,
        attempt_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        Some("done"),
        None,
        None,
        &[],
    );
    session.turn_committed(turn_id, user_message_id, "01ARZ3NDEKTSV4RRFFQ69G5FB4");
    session.project();

    let artifact_id = artifact_id.unwrap();
    let conn = session.search_conn();
    let cancel = CancellationToken::new();

    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.regex = Some(RegexFilter {
        pattern: "match".to_owned(),
        case_sensitive: true,
        context_before: 1,
        context_after: 1,
        max_matches: 100,
    });
    let response = retrieve_artifact(&conn, &request, &cancel).unwrap();
    assert_eq!(response.matches.len(), 2);
    assert_eq!(response.matches[0].line, 2);
    assert_eq!(response.matches[1].line, 4);
    let text = match &response.content {
        ArtifactRetrievedContent::Utf8(text) => text.clone(),
        _ => panic!("expected utf8"),
    };
    assert!(text.contains("match one"));
    assert!(text.contains("match two"));
}

#[test]
fn retrieval_binary_as_base64() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    let call_id = "call_001";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[("read_file", json!({"path": "a.bin"}))],
    );
    let (finish_id, artifact_id) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        call_id,
        0,
        "read_file",
        ToolBody::Artifact("binary\u{0}data\u{ff}"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &[call_id],
        &[finish_id],
    );
    session.assistant_step(
        turn_id,
        attempt_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        Some("done"),
        None,
        None,
        &[],
    );
    session.turn_committed(turn_id, user_message_id, "01ARZ3NDEKTSV4RRFFQ69G5FB4");
    session.project();

    let artifact_id = artifact_id.unwrap();
    let conn = session.search_conn();
    let cancel = CancellationToken::new();

    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    let response = retrieve_artifact(&conn, &request, &cancel).unwrap();
    assert!(matches!(
        response.content,
        ArtifactRetrievedContent::Base64(_)
    ));
    assert_eq!(response.selected_line_start, None);
    assert_eq!(response.selected_line_end, None);
    assert_eq!(response.total_lines, None);

    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.line_range = Some(InclusiveLineRange { start: 1, end: 1 });
    let err = retrieve_artifact(&conn, &request, &cancel).unwrap_err();
    assert_eq!(err.code(), "HISTORY_SELECTOR_UNSUPPORTED");
}

#[test]
fn retrieval_json_pointer_before_rendering() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    let call_id = "call_001";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[("read_file", json!({"path": "a.txt"}))],
    );
    let (finish_id, artifact_id) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        call_id,
        0,
        "read_file",
        ToolBody::Artifact("{\"text\":\"pointer target\"}"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &[call_id],
        &[finish_id],
    );
    session.assistant_step(
        turn_id,
        attempt_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        Some("done"),
        None,
        None,
        &[],
    );
    session.turn_committed(turn_id, user_message_id, "01ARZ3NDEKTSV4RRFFQ69G5FB4");
    session.project();

    let artifact_id = artifact_id.unwrap();
    let conn = session.search_conn();
    let cancel = CancellationToken::new();

    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.json_pointer = Some("/data/text".to_owned());
    let response = retrieve_artifact(&conn, &request, &cancel).unwrap();
    assert_eq!(
        response.content,
        ArtifactRetrievedContent::Utf8("pointer target".to_owned())
    );
}

// §10.3 session source

#[test]
fn session_source_byte_offset_paging() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["hello world"], &["the answer"]);
    let conn = session.search_conn();
    let cancel = CancellationToken::new();

    let rows: Vec<(String, String, String)> = conn
        .prepare("SELECT document_id, source_field, text FROM search_documents WHERE source_field = 'user.blocks[0].text'")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows.len(), 1);
    let (document_id, _, text) = &rows[0];
    assert_eq!(text, "hello world");

    let request = praana_core::history::retrieve::ReadSessionSourceRequest {
        result_id: SearchResultId::from_str_canonical(document_id).unwrap(),
        byte_offset: 6,
    };
    let response = read_session_source(&conn, &request, &cancel).unwrap();
    assert_eq!(response.text, "world");
    assert_eq!(response.byte_offset, 6);
    assert_eq!(response.returned_bytes, 5);
    assert_eq!(response.total_bytes, 11);
    assert_eq!(response.start_line, 1);
    assert_eq!(response.end_line, 1);
    // §10.3: complete is true only when byte_offset = 0 and the whole text is
    // returned; this window starts at byte 6, so it is not "the complete
    // document" even though the window itself reaches the end (hence the null
    // continuation).
    assert!(!response.complete);
    assert!(response.continuation.is_none());
}

#[test]
fn session_source_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["hello"], &[]);
    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let request = praana_core::history::retrieve::ReadSessionSourceRequest {
        result_id: SearchResultId::from_str_canonical(&ulid("ZZ")).unwrap(),
        byte_offset: 0,
    };
    let err = read_session_source(&conn, &request, &cancel).unwrap_err();
    assert_eq!(err.code(), "HISTORY_SOURCE_NOT_FOUND");
}

// §11 search

#[test]
fn search_exact_case_sensitive_and_insensitive() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["Hello World"], &["the Answer"]);
    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let mut request = search_request("Hello", SessionSearchMode::Exact);
    request.case_sensitive = true;
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 1);
    assert_eq!(page.results[0].source_field, "user.blocks[0].text");

    let mut request = search_request("hello", SessionSearchMode::Exact);
    request.case_sensitive = true;
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 0);

    let mut request = search_request("hello", SessionSearchMode::Exact);
    request.case_sensitive = false;
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 1);
}

#[test]
fn search_regex_mode() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["abc123def"], &[]);
    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let request = search_request(r"\d+", SessionSearchMode::Regex);
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 1);
    assert_eq!(page.results[0].occurrences.len(), 1);
    assert_eq!(page.results[0].occurrences[0].line, 1);
    assert_eq!(page.results[0].occurrences[0].start_column, 4);
    assert_eq!(page.results[0].occurrences[0].end_column, 7);
}

#[test]
fn search_fts_mode() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["the quick brown fox"], &[]);
    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let request = search_request("quick", SessionSearchMode::Fts);
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 1);
    assert!(page.results[0].score.primary_micros < 1_000_000);
}

#[test]
fn search_filters_and_empty_query_id_lookup() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha beta"], &["gamma delta"]);
    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let mut request = search_request("alpha", SessionSearchMode::Exact);
    request.filters.event_kinds = vec!["user_message_accepted".to_owned()];
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 1);

    let mut request = search_request("alpha", SessionSearchMode::Exact);
    request.filters.event_kinds = vec!["assistant_step_accepted".to_owned()];
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 0);

    let mut request = search_request("gamma", SessionSearchMode::Exact);
    request.filters.source_kinds = vec![SearchSourceKind::Event];
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 1);

    let rows: Vec<String> = conn
        .prepare("SELECT document_id FROM search_documents WHERE source_field = 'assistant.blocks[0].text'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!rows.is_empty());
    // §11.2: an empty query is only valid in Exact mode with an id filter.
    let empty_no_ids = SessionSearchRequest {
        query: String::new(),
        mode: SessionSearchMode::Exact,
        case_sensitive: false,
        filters: SessionSearchFilters::default(),
        limit: 100,
        cursor: None,
    };
    let err = search_session(&conn, &empty_no_ids, &key, &cancel).unwrap_err();
    assert_eq!(err.code(), "HISTORY_SEARCH_QUERY");

    let cited_events: Vec<EventId> = conn
        .prepare("SELECT DISTINCT event_id FROM search_documents WHERE event_id IS NOT NULL")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<String>, _>>()
        .unwrap()
        .iter()
        .map(|id| EventId::from_str_canonical(id).unwrap())
        .collect();
    assert!(cited_events.len() >= 2);
    let empty_lookup = SessionSearchRequest {
        query: String::new(),
        mode: SessionSearchMode::Exact,
        case_sensitive: false,
        filters: SessionSearchFilters {
            event_ids: cited_events,
            ..SessionSearchFilters::default()
        },
        limit: 100,
        cursor: None,
    };
    let page = search_session(&conn, &empty_lookup, &key, &cancel).unwrap();
    assert!(page.results.len() >= 2);
    for result in &page.results {
        assert!(result.occurrences.is_empty());
    }
}

#[test]
fn search_cursor_pagination_and_tamper() {
    let dir = tempfile::tempdir().unwrap();
    let mut texts: Vec<String> = Vec::new();
    for i in 0..25 {
        texts.push(format!("unique marker number {i}"));
    }
    let texts_ref: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
    let session = build_session_with_texts(dir.path(), &texts_ref, &[]);
    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let mut request = search_request("marker", SessionSearchMode::Exact);
    request.limit = 10;
    let page1 = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page1.results.len(), 10);
    let cursor = page1.next_cursor.clone().unwrap();

    let mut request2 = search_request("marker", SessionSearchMode::Exact);
    request2.limit = 10;
    request2.cursor = Some(cursor);
    let page2 = search_session(&conn, &request2, &key, &cancel).unwrap();
    assert_eq!(page2.results.len(), 10);
    assert!(page2.next_cursor.is_some());

    let mut request3 = search_request("marker", SessionSearchMode::Exact);
    request3.limit = 10;
    request3.cursor = page2.next_cursor;
    let page3 = search_session(&conn, &request3, &key, &cancel).unwrap();
    assert_eq!(page3.results.len(), 5);
    assert!(page3.next_cursor.is_none());

    let all_ids: Vec<_> = page1
        .results
        .iter()
        .chain(&page2.results)
        .chain(&page3.results)
        .map(|r| r.result_id.to_string())
        .collect();
    let unique_ids: std::collections::BTreeSet<_> = all_ids.iter().collect();
    assert_eq!(unique_ids.len(), 25);

    let mut request4 = search_request("marker", SessionSearchMode::Exact);
    request4.limit = 10;
    request4.cursor = Some(page1.next_cursor.unwrap().replace('A', "B"));
    let err = search_session(&conn, &request4, &key, &cancel).unwrap_err();
    assert_eq!(err.code(), "HISTORY_SEARCH_CURSOR_STALE");
}

/// History §11.2 snapshot pages. Page 1 freezes `P`. Later indexable events
/// advance `history_derived` but must not stale the cursor or enter the page.
#[test]
fn continuation_pages_stay_on_the_captured_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut texts: Vec<String> = Vec::new();
    for i in 0..25 {
        texts.push(format!("unique marker number {i}"));
    }
    let texts_ref: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
    let mut session = build_session_with_texts(dir.path(), &texts_ref, &[]);
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let mut full = search_request("marker", SessionSearchMode::Exact);
    full.limit = 100;
    let snapshot =
        search_session(&session.search_conn(), &full, &key, &cancel).expect("snapshot page");
    assert!(snapshot.next_cursor.is_none());
    let p = snapshot.projection_through_sequence;

    let mut request = search_request("marker", SessionSearchMode::Exact);
    request.limit = 10;
    let page1 =
        search_session(&session.search_conn(), &request, &key, &cancel).expect("first page");
    assert_eq!(page1.results.len(), 10);
    assert_eq!(page1.projection_through_sequence, p);
    assert_eq!(page1.results, snapshot.results[..10]);
    let cursor1 = page1.next_cursor.clone().expect("page 1 continues");
    assert_eq!(cursor_u64(&cursor1, "projection_through_sequence"), Some(p));

    let turn2 = ulid("T2");
    let user2 = session.user_message(&turn2, &["extra marker hit"]);
    session.turn_started(&turn2, &user2);
    let step2 = ulid("S2");
    session.assistant_step(
        &turn2,
        &ulid("A2"),
        &step2,
        Some("assistant marker line"),
        None,
        None,
        &[],
    );
    session.turn_committed(&turn2, &user2, &step2);
    let turn3 = ulid("T3");
    let user3 = session.user_message(&turn3, &["plankton forecast"]);
    session.turn_started(&turn3, &user3);
    let step3 = ulid("S3");
    session.assistant_step(
        &turn3,
        &ulid("A3"),
        &step3,
        Some("no hit here"),
        None,
        None,
        &[],
    );
    session.turn_committed(&turn3, &user3, &step3);
    session.project();

    let checkpoint = derived_checkpoint(&session);
    assert!(checkpoint.applied_through_sequence > p);
    let conn = session.search_conn();
    let later: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_documents WHERE text = 'extra marker hit' AND event_sequence > ?1",
            [p as i64],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(later, 1);

    let mut request2 = search_request("marker", SessionSearchMode::Exact);
    request2.limit = 10;
    request2.cursor = Some(cursor1);
    let page2 = search_session(&conn, &request2, &key, &cancel).expect("page 2 is not stale");
    assert_eq!(page2.results.len(), 10);
    assert_eq!(page2.projection_through_sequence, p);
    let cursor2 = page2.next_cursor.clone().expect("page 2 continues");
    assert_eq!(cursor_u64(&cursor2, "projection_through_sequence"), Some(p));
    assert_eq!(
        cursor_u64(&cursor2, "reset_epoch"),
        cursor_u64(page1.next_cursor.as_deref().unwrap(), "reset_epoch")
    );

    let mut request3 = search_request("marker", SessionSearchMode::Exact);
    request3.limit = 10;
    request3.cursor = Some(cursor2);
    let page3 = search_session(&conn, &request3, &key, &cancel).expect("page 3 is not stale");
    assert_eq!(page3.results.len(), 5);
    assert!(page3.next_cursor.is_none());
    assert_eq!(page3.projection_through_sequence, p);

    let mut combined = page1.results.clone();
    combined.extend(page2.results);
    combined.extend(page3.results);
    assert_eq!(combined, snapshot.results);
    let ids: Vec<_> = combined
        .iter()
        .map(|result| result.result_id.to_string())
        .collect();
    let unique: std::collections::BTreeSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len());

    let mut fresh_request = search_request("marker", SessionSearchMode::Exact);
    fresh_request.limit = 100;
    let fresh = search_session(&conn, &fresh_request, &key, &cancel).expect("fresh first page");
    assert!(fresh.projection_through_sequence > p);
    assert!(fresh.results.len() > snapshot.results.len());
    assert!(fresh
        .results
        .iter()
        .any(|result| result.excerpt.contains("extra marker hit")));
    assert!(fresh
        .results
        .iter()
        .any(|result| result.excerpt.contains("assistant marker line")));
    assert!(fresh
        .results
        .iter()
        .all(|result| !result.excerpt.contains("plankton forecast")));
    assert!(fresh
        .results
        .iter()
        .all(|result| !result.excerpt.contains("no hit here")));
}

/// FTS `bm25()` statistics must be the rows at or below P. An appended hit
/// changes whole-index idf and average length, so a continuation that still
/// calls `bm25(search_fts)` repeats or skips snapshot rows.
#[test]
fn fts_continuation_pages_match_the_projection_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut texts = Vec::new();
    for i in 0..12 {
        texts.push(format!("xylophonequartz {}", "aa ".repeat(i + 1)));
    }
    for i in 0..40 {
        texts.push(format!("unrelated filler {}", "bb ".repeat((i % 5) + 1)));
    }
    let texts_ref: Vec<&str> = texts.iter().map(String::as_str).collect();
    let mut session = build_session_with_texts(dir.path(), &texts_ref, &[]);
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let mut full = search_request("xylophonequartz", SessionSearchMode::Fts);
    full.limit = 100;
    let snapshot =
        search_session(&session.search_conn(), &full, &key, &cancel).expect("snapshot page");
    assert_eq!(snapshot.results.len(), 12);
    assert!(snapshot.next_cursor.is_none());
    let p = snapshot.projection_through_sequence;

    let conn = session.search_conn();
    let mut sql_scores = std::collections::HashMap::new();
    let mut statement = conn
        .prepare(
            "SELECT d.document_id, bm25(search_fts, 1.0) \
             FROM search_fts JOIN search_documents d ON d.rowid = search_fts.rowid \
             WHERE search_fts MATCH ?1",
        )
        .unwrap();
    let mut rows = statement.query(["xylophonequartz"]).unwrap();
    while let Some(row) = rows.next().unwrap() {
        let document_id: String = row.get(0).unwrap();
        let raw: f64 = row.get(1).unwrap();
        let raw_micros = (raw * 1_000_000.0).round() as i64;
        sql_scores.insert(document_id, -raw_micros);
    }
    drop(rows);
    for result in &snapshot.results {
        assert_eq!(
            sql_scores.get(&result.result_id.to_string()).copied(),
            Some(result.score.primary_micros)
        );
    }

    let mut request = search_request("xylophonequartz", SessionSearchMode::Fts);
    request.limit = 4;
    let page1 =
        search_session(&session.search_conn(), &request, &key, &cancel).expect("first page");
    assert_eq!(page1.results, snapshot.results[..4]);
    let mut cursor = page1.next_cursor.clone().expect("page 1 continues");

    let turn = ulid("T2");
    let user = session.user_message(&turn, &["xylophonequartz after the snapshot"]);
    session.turn_started(&turn, &user);
    let step = ulid("S2");
    session.assistant_step(
        &turn,
        &ulid("A2"),
        &step,
        Some("no shared token here"),
        None,
        None,
        &[],
    );
    session.turn_committed(&turn, &user, &step);
    session.project();
    let checkpoint = derived_checkpoint(&session);
    assert!(checkpoint.applied_through_sequence > p);

    let mut combined = page1.results;
    let mut guard = 0;
    loop {
        let mut page_request = search_request("xylophonequartz", SessionSearchMode::Fts);
        page_request.limit = 4;
        page_request.cursor = Some(cursor);
        let page = search_session(&session.search_conn(), &page_request, &key, &cancel)
            .expect("continuation is not stale");
        assert_eq!(page.projection_through_sequence, p);
        combined.extend(page.results);
        match page.next_cursor {
            Some(next) => cursor = next,
            None => break,
        }
        guard += 1;
        assert!(guard < 8, "fts cursor did not finish");
    }
    assert_eq!(combined, snapshot.results);

    let mut fresh_request = search_request("xylophonequartz", SessionSearchMode::Fts);
    fresh_request.limit = 100;
    let fresh =
        search_session(&session.search_conn(), &fresh_request, &key, &cancel).expect("fresh page");
    assert!(fresh.projection_through_sequence > p);
    assert!(fresh.results.len() > snapshot.results.len());
    assert!(fresh.results.iter().any(|result| result
        .excerpt
        .contains("xylophonequartz after the snapshot")));
}

/// A reset must not change FTS ranking. Statistics stay those of
/// `bm25(search_fts, 1.0)` over every row at or below P, including prior epochs.
#[test]
fn fts_first_page_after_reset_matches_whole_index_bm25() {
    let dir = tempfile::tempdir().unwrap();
    let mut prior = Vec::new();
    for i in 0..26 {
        prior.push(format!(
            "prior filler row {i} {}",
            "zz ".repeat((i % 3) + 1)
        ));
    }
    let prior_ref: Vec<&str> = prior.iter().map(String::as_str).collect();
    let mut session = build_session_with_texts(dir.path(), &prior_ref, &[]);
    session.reset();
    session.user_message(
        "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        &[
            "xylophonequartz",
            &format!("xylophonequartz {}", "aa ".repeat(40)),
            "current epoch without the term",
        ],
    );
    session.project();

    let cancel = CancellationToken::new();
    let key = session.hmac_key();
    let mut request = search_request("xylophonequartz", SessionSearchMode::Fts);
    request.limit = 100;
    let page = search_session(&session.search_conn(), &request, &key, &cancel).expect("first page");
    assert_eq!(page.results.len(), 2);
    let p = page.projection_through_sequence;

    let conn = session.search_conn();
    let mut sql_scores = std::collections::HashMap::new();
    let mut statement = conn
        .prepare(
            "SELECT d.document_id, bm25(search_fts, 1.0) \
             FROM search_fts JOIN search_documents d ON d.rowid = search_fts.rowid \
             WHERE search_fts MATCH ?1 AND d.event_sequence <= ?2",
        )
        .unwrap();
    let mut rows = statement
        .query(rusqlite::params!["xylophonequartz", p as i64])
        .unwrap();
    while let Some(row) = rows.next().unwrap() {
        let document_id: String = row.get(0).unwrap();
        let raw: f64 = row.get(1).unwrap();
        sql_scores.insert(document_id, (raw * 1_000_000.0).round() as i64);
    }
    drop(rows);
    let mut raw_micros = Vec::new();
    for result in &page.results {
        let expected = sql_scores
            .get(&result.result_id.to_string())
            .copied()
            .expect("direct bm25 row");
        assert_eq!(result.score.raw_bm25_micros, Some(expected));
        raw_micros.push(expected);
    }
    assert_ne!(raw_micros[0], raw_micros[1]);
}

/// Continuation after a reset must keep the first page's scores. The private
/// copy includes prior-epoch rows at or below P; limiting it to the current
/// epoch changes idf and average length.
#[test]
fn fts_continuation_after_reset_keeps_prior_epoch_statistics() {
    let dir = tempfile::tempdir().unwrap();
    let mut prior = Vec::new();
    for i in 0..26 {
        prior.push(format!(
            "prior filler row {i} {}",
            "zz ".repeat((i % 3) + 1)
        ));
    }
    let prior_ref: Vec<&str> = prior.iter().map(String::as_str).collect();
    let mut session = build_session_with_texts(dir.path(), &prior_ref, &[]);
    session.reset();
    // Replay clears turn ordinals on reset. The harness counter does not.
    session.open_turn_index = 0;
    let mut current = Vec::new();
    for i in 0..4 {
        current.push(format!("xylophonequartz {}", "aa ".repeat(i + 1)));
    }
    let current_ref: Vec<&str> = current.iter().map(String::as_str).collect();
    let turn = ulid("T1");
    let user = session.user_message(&turn, &current_ref);
    session.turn_started(&turn, &user);
    let step = ulid("S1");
    session.assistant_step(&turn, &ulid("A1"), &step, Some("noted"), None, None, &[]);
    session.turn_committed(&turn, &user, &step);
    session.project();

    let cancel = CancellationToken::new();
    let key = session.hmac_key();
    let conn = session.search_conn();
    let prior_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_documents WHERE reset_epoch = 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(prior_rows >= 26);

    let mut full = search_request("xylophonequartz", SessionSearchMode::Fts);
    full.limit = 100;
    let snapshot = search_session(&conn, &full, &key, &cancel).expect("snapshot page");
    assert_eq!(snapshot.results.len(), 4);
    let p = snapshot.projection_through_sequence;

    let mut request = search_request("xylophonequartz", SessionSearchMode::Fts);
    request.limit = 2;
    let page1 = search_session(&conn, &request, &key, &cancel).expect("first page");
    assert_eq!(page1.results, snapshot.results[..2]);
    let mut cursor = page1.next_cursor.clone().expect("page 1 continues");
    drop(conn);

    let turn = ulid("T2");
    let user = session.user_message(&turn, &["xylophonequartz after the snapshot"]);
    session.turn_started(&turn, &user);
    let step = ulid("S2");
    session.assistant_step(
        &turn,
        &ulid("A2"),
        &step,
        Some("no shared token here"),
        None,
        None,
        &[],
    );
    session.turn_committed(&turn, &user, &step);
    session.project();
    assert!(derived_checkpoint(&session).applied_through_sequence > p);
    let later: i64 = session
        .search_conn()
        .query_row(
            "SELECT COUNT(*) FROM search_documents \
             WHERE text = 'xylophonequartz after the snapshot' AND event_sequence > ?1",
            [p as i64],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(later, 1);

    let mut combined = page1.results;
    let mut guard = 0;
    loop {
        let mut page_request = search_request("xylophonequartz", SessionSearchMode::Fts);
        page_request.limit = 2;
        page_request.cursor = Some(cursor);
        let page = search_session(&session.search_conn(), &page_request, &key, &cancel)
            .expect("continuation is not stale");
        assert_eq!(page.projection_through_sequence, p);
        combined.extend(page.results);
        match page.next_cursor {
            Some(next) => cursor = next,
            None => break,
        }
        guard += 1;
        assert!(guard < 8, "fts cursor did not finish");
    }
    assert_eq!(combined, snapshot.results);
}

#[tokio::test]
async fn search_session_log_next_page_survives_its_own_finish_event() {
    let dir = tempfile::tempdir().unwrap();
    let mut texts: Vec<String> = Vec::new();
    for i in 0..3 {
        texts.push(format!("unique marker number {i}"));
    }
    let texts_ref: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
    let mut session = build_session_with_texts(dir.path(), &texts_ref, &[]);
    let turn = ulid("TT");
    let user = session.user_message(&turn, &["please search"]);
    session.turn_started(&turn, &user);
    let step1 = ulid("S4");
    let first_args = json!({"query": "marker", "mode": "exact", "limit": 1});
    session.assistant_step(
        &turn,
        &ulid("A4"),
        &step1,
        None,
        None,
        None,
        &[("search_session_log", first_args.clone())],
    );
    let attempt1 = session.step_attempt.get(&step1).unwrap().clone();
    session.project();

    let clock = std::sync::Arc::clone(&session.clock);
    let artifacts = ArtifactStore::open(
        &session.dir.join("history.db"),
        ArtifactPolicy::defaults(),
        std::sync::Arc::clone(&clock),
    )
    .unwrap();
    let ids = MonotonicUlidGenerator::system();
    let rt = history_tool_runtime(&session.dir);
    let first = execute_search(
        &rt,
        &mut session,
        &artifacts,
        &ids,
        clock.as_ref(),
        &turn,
        &attempt1,
        &step1,
        &ulid("B4"),
        "call_001",
        first_args,
    )
    .await;
    let page1 = tool_page(&first);
    let p = page1["projection_through_sequence"].as_u64().unwrap();
    let cursor = page1["next_cursor"]
        .as_str()
        .expect("first tool page continues")
        .to_owned();
    assert!(!cursor.is_empty());
    session.project();
    let advanced = derived_checkpoint(&session);
    assert!(advanced.applied_through_sequence > p);
    assert!(log_has_finish(&session, "call_001"));

    let step2 = ulid("S5");
    let second_args = json!({
        "query": "marker",
        "mode": "exact",
        "limit": 1,
        "cursor": cursor,
    });
    session.assistant_step(
        &turn,
        &ulid("A5"),
        &step2,
        None,
        None,
        None,
        &[("search_session_log", second_args.clone())],
    );
    let attempt2 = session.step_attempt.get(&step2).unwrap().clone();
    session.project();
    let second = execute_search(
        &rt,
        &mut session,
        &artifacts,
        &ids,
        clock.as_ref(),
        &turn,
        &attempt2,
        &step2,
        &ulid("B5"),
        "call_002",
        second_args,
    )
    .await;
    let page2 = tool_page(&second);
    assert_eq!(page2["projection_through_sequence"].as_u64(), Some(p));
    let sequences: Vec<u64> = page2["results"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|result| result["event_sequence"].as_u64())
        .collect();
    assert!(!sequences.is_empty());
    assert!(sequences.iter().all(|sequence| *sequence <= p));
}

/// Default `search_session_log` mode is FTS. The next page runs after this
/// call's finish event and the following step's arguments row, both past P.
#[tokio::test]
async fn search_session_log_fts_next_page_matches_the_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut texts: Vec<String> = Vec::new();
    for i in 0..4 {
        texts.push(format!("xylophonequartz {}", "pad ".repeat(i + 1)));
    }
    for i in 0..20 {
        texts.push(format!("unrelated filler {}", "word ".repeat((i % 4) + 1)));
    }
    let texts_ref: Vec<&str> = texts.iter().map(|text| text.as_str()).collect();
    let mut session = build_session_with_texts(dir.path(), &texts_ref, &[]);
    let turn = ulid("TT");
    let user = session.user_message(&turn, &["please search"]);
    session.turn_started(&turn, &user);
    let step1 = ulid("S4");
    let first_args = json!({"query": "xylophonequartz", "limit": 1});
    session.assistant_step(
        &turn,
        &ulid("A4"),
        &step1,
        None,
        None,
        None,
        &[("search_session_log", first_args.clone())],
    );
    let attempt1 = session.step_attempt.get(&step1).unwrap().clone();
    session.project();

    let cancel = CancellationToken::new();
    let key = session.hmac_key();
    let mut full = search_request("xylophonequartz", SessionSearchMode::Fts);
    full.limit = 100;
    let snapshot =
        search_session(&session.search_conn(), &full, &key, &cancel).expect("fts snapshot");
    assert!(snapshot.results.len() >= 2);
    let expected_second = snapshot.results[1].clone();

    let clock = std::sync::Arc::clone(&session.clock);
    let artifacts = ArtifactStore::open(
        &session.dir.join("history.db"),
        ArtifactPolicy::defaults(),
        std::sync::Arc::clone(&clock),
    )
    .unwrap();
    let ids = MonotonicUlidGenerator::system();
    let rt = history_tool_runtime(&session.dir);
    let first = execute_search(
        &rt,
        &mut session,
        &artifacts,
        &ids,
        clock.as_ref(),
        &turn,
        &attempt1,
        &step1,
        &ulid("B4"),
        "call_001",
        first_args,
    )
    .await;
    let page1 = tool_page(&first);
    let p = page1["projection_through_sequence"].as_u64().unwrap();
    assert_eq!(p, snapshot.projection_through_sequence);
    let cursor = page1["next_cursor"]
        .as_str()
        .expect("first tool page continues")
        .to_owned();
    let first_id = snapshot.results[0].result_id.to_string();
    assert_eq!(
        page1["results"][0]["result_id"].as_str(),
        Some(first_id.as_str())
    );
    session.project();
    assert!(derived_checkpoint(&session).applied_through_sequence > p);
    assert!(log_has_finish(&session, "call_001"));

    let step2 = ulid("S5");
    let second_args = json!({
        "query": "xylophonequartz",
        "limit": 1,
        "cursor": cursor,
    });
    session.assistant_step(
        &turn,
        &ulid("A5"),
        &step2,
        None,
        None,
        None,
        &[("search_session_log", second_args.clone())],
    );
    let attempt2 = session.step_attempt.get(&step2).unwrap().clone();
    session.project();
    let second = execute_search(
        &rt,
        &mut session,
        &artifacts,
        &ids,
        clock.as_ref(),
        &turn,
        &attempt2,
        &step2,
        &ulid("B5"),
        "call_002",
        second_args,
    )
    .await;
    let page2 = tool_page(&second);
    assert_eq!(page2["projection_through_sequence"].as_u64(), Some(p));
    let second_id = expected_second.result_id.to_string();
    assert_eq!(
        page2["results"][0]["result_id"].as_str(),
        Some(second_id.as_str())
    );
    assert_eq!(
        page2["results"][0]["score"]["primary_micros"].as_i64(),
        Some(expected_second.score.primary_micros)
    );
}

#[test]
fn reset_after_cursor_issue_is_stale() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = build_session_with_texts(
        dir.path(),
        &["unique marker number 0", "unique marker number 1"],
        &[],
    );
    let cancel = CancellationToken::new();
    let key = session.hmac_key();
    let mut request = search_request("marker", SessionSearchMode::Exact);
    request.limit = 1;
    let page = search_session(&session.search_conn(), &request, &key, &cancel).unwrap();
    let cursor = page.next_cursor.expect("page continues");
    let before = derived_checkpoint(&session);
    session.reset();
    session.project();
    let after = derived_checkpoint(&session);
    assert_eq!(after.reset_epoch, before.reset_epoch + 1);
    assert!(after.applied_through_sequence > before.applied_through_sequence);
    request.cursor = Some(cursor);
    let err = search_session(&session.search_conn(), &request, &key, &cancel).unwrap_err();
    assert_eq!(err.code(), "HISTORY_SEARCH_CURSOR_STALE");
}

#[test]
fn rejected_cursors_are_undifferentiated_stale() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(
        dir.path(),
        &["unique marker number 0", "unique marker number 1"],
        &[],
    );
    let cancel = CancellationToken::new();
    let key = session.hmac_key();
    let mut request = search_request("marker", SessionSearchMode::Exact);
    request.limit = 1;
    let page = search_session(&session.search_conn(), &request, &key, &cancel).unwrap();
    let cursor = page.next_cursor.expect("page continues");
    let current = page.projection_through_sequence;

    assert_stale(&session, &key, &tamper(&cursor, false));
    assert_stale(&session, &key, &tamper(&cursor, true));

    let mut ahead = cursor_json(&cursor);
    ahead["projection_through_sequence"] = json!(current + 1);
    assert_stale(&session, &key, &resign(&ahead, &key));

    let mut other = cursor_json(&cursor);
    other["session_id"] = json!("01ARZ3NDEKTSV4RRFFQ69G5FAW");
    assert_stale(&session, &key, &resign(&other, &key));

    let mut schema1 = cursor_json(&cursor);
    schema1["cursor_schema_version"] = json!(1);
    schema1.as_object_mut().unwrap().remove("reset_epoch");
    assert_stale(&session, &key, &resign(&schema1, &key));
    assert_stale(&session, &key, &extend_tag(&cursor));
    assert_stale(&session, &key, &flip_tag_trailing_bits(&cursor));
}

#[test]
fn derived_rebuild_between_pages_keeps_the_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = build_session_with_texts(
        dir.path(),
        &[
            "unique marker number 0",
            "unique marker number 1",
            "unique marker number 2",
        ],
        &[],
    );
    let cancel = CancellationToken::new();
    let key = session.hmac_key();
    let mut request = search_request("marker", SessionSearchMode::Exact);
    request.limit = 1;
    let page1 = search_session(&session.search_conn(), &request, &key, &cancel).unwrap();
    let cursor = page1.next_cursor.clone().expect("page continues");
    request.cursor = Some(cursor.clone());
    let expected = search_session(&session.search_conn(), &request, &key, &cancel).unwrap();
    drop(request);

    let turn = ulid("T2");
    let user = session.user_message(&turn, &["unique marker number 9"]);
    session.turn_started(&turn, &user);
    let step = ulid("S9");
    session.assistant_step(
        &turn,
        &ulid("A9"),
        &step,
        Some("later marker"),
        None,
        None,
        &[],
    );
    session.turn_committed(&turn, &user, &step);
    session.project();
    let advanced = derived_checkpoint(&session);
    assert!(advanced.applied_through_sequence > page1.projection_through_sequence);

    HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap();
    let mut again = search_request("marker", SessionSearchMode::Exact);
    again.limit = 1;
    again.cursor = Some(cursor);
    let page2 = search_session(&session.search_conn(), &again, &key, &cancel)
        .expect("page 2 after rebuild");
    assert_eq!(page2.results, expected.results);
    assert_eq!(
        page2.projection_through_sequence,
        page1.projection_through_sequence
    );
    assert_eq!(
        cursor_u64(
            page2.next_cursor.as_deref().unwrap(),
            "projection_through_sequence"
        ),
        Some(page1.projection_through_sequence)
    );
}

#[test]
fn search_excerpt_worked_example() {
    let dir = tempfile::tempdir().unwrap();
    let mut long_text = String::new();
    for i in 0..200 {
        long_text.push_str(&format!("line {i} padding padding padding\n"));
    }
    let session = build_session_with_texts(dir.path(), &[&long_text], &[]);
    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let request = search_request("line 100", SessionSearchMode::Exact);
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 1);
    let result = &page.results[0];
    assert!(result.excerpt.len() <= 800);
    assert!(!result.excerpt_complete);
}

// §5.2/§8/§11.1.1 projection

#[test]
fn projection_indexes_tool_call_arguments_redacted() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[(
            "read_file",
            json!({"path": "a.txt", "auth_token": "secret-value-123"}),
        )],
    );
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    let (finish_id, _) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        "call_001",
        0,
        "read_file",
        ToolBody::Inline("ok"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &["call_001"],
        &[finish_id],
    );
    session.assistant_step(
        turn_id,
        attempt_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        Some("done"),
        None,
        None,
        &[],
    );
    session.turn_committed(turn_id, user_message_id, "01ARZ3NDEKTSV4RRFFQ69G5FB4");
    session.project();

    let conn = session.search_conn();
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT source_field, text FROM search_documents WHERE source_field LIKE 'assistant.blocks[%tool_call.arguments'")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows.len(), 1);
    let (_, text) = &rows[0];
    assert!(!text.contains("secret-value-123"));
    assert!(text.contains("[REDACTED"));
}

#[test]
fn projection_excludes_history_tool_results() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    let call_id = "call_001";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[("search_session_log", json!({"query": "hello"}))],
    );
    let (finish_id, _) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        call_id,
        0,
        "search_session_log",
        ToolBody::Inline("search output text"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &[call_id],
        &[finish_id],
    );
    let step_id_2 = "01ARZ3NDEKTSV4RRFFQ69G5FB8";
    let batch_id_2 = "01ARZ3NDEKTSV4RRFFQ69G5FB9";
    let call_id_2 = "call_002";
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id_2,
        None,
        None,
        None,
        &[("read_file", json!({"path": "b.txt"}))],
    );
    let (finish_id_2, _) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id_2,
        batch_id_2,
        call_id_2,
        0,
        "read_file",
        ToolBody::Inline("file output text"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id_2,
        batch_id_2,
        &[call_id_2],
        &[finish_id_2],
    );
    session.assistant_step(
        turn_id,
        attempt_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        Some("done"),
        None,
        None,
        &[],
    );
    session.turn_committed(turn_id, user_message_id, "01ARZ3NDEKTSV4RRFFQ69G5FB4");
    session.project();

    let conn = session.search_conn();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_documents WHERE source_field = 'tool_result.inline.text' AND text LIKE '%search output text%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_documents WHERE source_field = 'tool_result.inline.text' AND text LIKE '%file output text%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_documents WHERE source_field = 'tool_result.inline.text'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn projection_replay_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["hello world"], &["the answer"]);
    let conn = session.search_conn();
    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM search_documents", [], |row| {
            row.get(0)
        })
        .unwrap();
    let fts_before: i64 = conn
        .query_row("SELECT COUNT(*) FROM search_fts", [], |row| row.get(0))
        .unwrap();

    let projector = HistoryProjector::new(&session.db);
    projector.project(&session.log).unwrap();

    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM search_documents", [], |row| {
            row.get(0)
        })
        .unwrap();
    let fts_after: i64 = conn
        .query_row("SELECT COUNT(*) FROM search_fts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(fts_before, fts_after);
}

#[test]
fn projection_reset_hides_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = build_session_with_texts(dir.path(), &["hello world"], &[]);
    session.reset();
    session.user_message("01ARZ3NDEKTSV4RRFFQ69G5FAY", &["new epoch text"]);
    session.project();

    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let request = search_request("hello", SessionSearchMode::Exact);
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 0);

    let mut request = search_request("hello", SessionSearchMode::Exact);
    request.filters.include_prior_epochs = true;
    let page = search_session(&conn, &request, &key, &cancel).unwrap();
    assert_eq!(page.results.len(), 1);
}

// §9.4 rebuild

#[test]
fn rebuild_corrupt_fts_to_byte_equivalent_results() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["hello world"], &["the answer"]);
    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let key = session.hmac_key();

    let before = search_session(
        &conn,
        &search_request("hello", SessionSearchMode::Exact),
        &key,
        &cancel,
    )
    .unwrap();
    let before_fts = search_session(
        &conn,
        &search_request("hello", SessionSearchMode::Fts),
        &key,
        &cancel,
    )
    .unwrap();

    // `conn` is query-only; corrupt the FTS index through a writable handle.
    let writer = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
    writer.execute("DELETE FROM search_fts", []).unwrap();
    drop(writer);

    let projector = HistoryProjector::new(&session.db);
    projector.rebuild(&session.log).unwrap();

    // History §9.4 step 6 renames the old database to `history.db.bad-<ms>`;
    // a connection opened before the swap still reads that file.
    let aside = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .find(|name| name.starts_with("history.db.bad-"))
        .expect("the old database is renamed aside");
    assert!(!dir.path().join("history.db.rebuild").exists(), "{aside}");
    let conn = session.search_conn();

    let after = search_session(
        &conn,
        &search_request("hello", SessionSearchMode::Exact),
        &key,
        &cancel,
    )
    .unwrap();
    let after_fts = search_session(
        &conn,
        &search_request("hello", SessionSearchMode::Fts),
        &key,
        &cancel,
    )
    .unwrap();
    assert_eq!(before.results.len(), after.results.len());
    assert_eq!(before_fts.results.len(), after_fts.results.len());
}

fn dump_operation_records(db_path: &Path) -> Vec<(String, Vec<Option<String>>)> {
    let conn = rusqlite::Connection::open(db_path).unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT operation_id, ui_contract_schema_version, operation_kind,\n                    request_sha256, status, session_id, planned_effects_json,\n                    result_json, result_sha256, first_canonical_sequence,\n                    terminal_canonical_sequence, created_at_ms, finished_at_ms\n             FROM operation_records ORDER BY operation_id",
        )
        .unwrap();
    let rows = stmt
        .query_map([], |row| {
            let operation_id: String = row.get(0)?;
            let mut columns = Vec::new();
            for index in 1..13 {
                match row.get::<_, rusqlite::types::Value>(index)? {
                    rusqlite::types::Value::Null => columns.push(None),
                    rusqlite::types::Value::Integer(value) => columns.push(Some(value.to_string())),
                    rusqlite::types::Value::Real(value) => columns.push(Some(value.to_string())),
                    rusqlite::types::Value::Text(value) => columns.push(Some(value)),
                    rusqlite::types::Value::Blob(value) => {
                        columns.push(Some(String::from_utf8_lossy(&value).into_owned()))
                    }
                }
            }
            Ok((operation_id, columns))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows
}

fn turn_submit_command(operation_id: praana_core::ui_contract::ids::OperationId) -> CoreCommand {
    let raw = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/ui_contract_v1/commands/turn_submit.json"),
    )
    .unwrap();
    let mut value: Value = serde_json::from_str(&raw).unwrap();
    value["data"]["operation_id"] = json!(operation_id.to_string());
    serde_json::from_value(value).unwrap()
}

#[test]
fn rebuild_preserves_operation_records_with_idempotent_replay() {
    use praana_core::history::operation_ledger::{
        open_session_ledger, reserve_operation_sync, HistoryService, NullRecoveryProbe,
    };
    use praana_core::ui_contract::operation::{
        OperationReservation, OperationStatus, StoredTerminalResult,
    };
    use praana_core::ui_contract::result::CoreCommandSuccess;
    use praana_core::ui_contract::TurnSubmittedDto;

    const FIXED_NOW_MS: i64 = 1_700_000_000_000;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["hello world"], &["the answer"]);
    let session_id = session_id();
    let history = HistoryService {
        session_ledger: None,
        host_ledger: None,
        session_id: Some(session_id),
        probe: Arc::new(NullRecoveryProbe),
        now_ms: Arc::new(|| FIXED_NOW_MS),
    };
    let turn_id = TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAY").unwrap();
    let event_id = EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB2").unwrap();
    let success = CoreCommandSuccess::TurnSubmitted(TurnSubmittedDto {
        session_id,
        turn_id,
        user_message_event_id: event_id,
        canonical_sequence: 43,
    });

    // Two operation rows through the real ledger API on the same history.db:
    // one succeeded terminal row, one still-reserved row.
    let succeeded_id = praana_core::ui_contract::ids::OperationId(ulid::Ulid::generate());
    let reserved_id = praana_core::ui_contract::ids::OperationId(ulid::Ulid::generate());
    let succeeded_command = turn_submit_command(succeeded_id);
    let reserved_command = turn_submit_command(reserved_id);

    let ledger = open_session_ledger(&dir.path().join("history.db"), session_id).unwrap();
    match reserve_operation_sync(&ledger, &succeeded_command, &history).unwrap() {
        OperationReservation::Reserved(_) => {}
        other => panic!("expected fresh reservation, got {other:?}"),
    }
    ledger
        .complete_terminal(
            &succeeded_id,
            &StoredTerminalResult::Success(success.clone()),
            Some(43),
            Some(44),
            FIXED_NOW_MS,
        )
        .unwrap();
    assert!(matches!(
        ledger.lookup(&succeeded_id).unwrap().unwrap().dto.status,
        OperationStatus::Succeeded
    ));
    match reserve_operation_sync(&ledger, &reserved_command, &history).unwrap() {
        OperationReservation::Reserved(_) => {}
        other => panic!("expected reserved reservation, got {other:?}"),
    }
    assert!(matches!(
        ledger.lookup(&reserved_id).unwrap().unwrap().dto.status,
        OperationStatus::Reserved
    ));
    drop(ledger);

    let before = dump_operation_records(&dir.path().join("history.db"));

    // Force an Invalid derived checkpoint so the rebuild runs.
    {
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        let payload: String = conn
            .query_row(
                "SELECT payload_json FROM projection_checkpoints WHERE projection_name = 'history_derived'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut value: Value = serde_json::from_str(&payload).unwrap();
        value["search_schema_version"] = json!(99);
        conn.execute(
            "UPDATE projection_checkpoints SET payload_json = ?1 WHERE projection_name = 'history_derived'",
            [serde_json::to_string(&value).unwrap()],
        )
        .unwrap();
    }

    HistoryProjector::new(&session.db)
        .project(&session.log)
        .unwrap();
    let aside = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .find(|name| name.starts_with("history.db.bad-"))
        .expect("the old database is renamed aside");
    assert!(!dir.path().join("history.db.rebuild").exists(), "{aside}");

    // Every operation row survived the rebuild byte-identical.
    let after = dump_operation_records(&dir.path().join("history.db"));
    assert_eq!(before, after);

    // A retried id for the succeeded operation returns the stored result
    // through the ledger API, never reserving or executing again.
    let ledger = open_session_ledger(&dir.path().join("history.db"), session_id).unwrap();
    match reserve_operation_sync(&ledger, &succeeded_command, &history).unwrap() {
        OperationReservation::ReplayStored(StoredTerminalResult::Success(replayed)) => {
            assert_eq!(replayed, success);
        }
        other => panic!("expected replay of stored success, got {other:?}"),
    }
    // The reserved row is still reserved and continuable.
    match reserve_operation_sync(&ledger, &reserved_command, &history).unwrap() {
        OperationReservation::Reserved(stored) => {
            assert_eq!(stored.status, OperationStatus::Reserved);
        }
        other => panic!("expected continuable reservation, got {other:?}"),
    }
    assert!(ledger
        .lookup(&reserved_id)
        .unwrap()
        .unwrap()
        .result_json
        .is_none());
}

#[test]
fn rebuild_with_corrupt_orphan_blob_stops_and_leaves_original_db() {
    use praana_core::history::operation_ledger::{
        open_session_ledger, reserve_operation_sync, HistoryService, NullRecoveryProbe,
    };
    use praana_core::ui_contract::ids::OperationId;
    use praana_core::ui_contract::operation::OperationStatus;

    const FIXED_NOW_MS: i64 = 1_700_000_000_000;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let session_id = session_id();
    let history = HistoryService {
        session_ledger: None,
        host_ledger: None,
        session_id: Some(session_id),
        probe: Arc::new(NullRecoveryProbe),
        now_ms: Arc::new(|| FIXED_NOW_MS),
    };
    let operation_id = OperationId(ulid::Ulid::generate());
    let command = turn_submit_command(operation_id);
    let ledger = open_session_ledger(&dir.path().join("history.db"), session_id).unwrap();
    reserve_operation_sync(&ledger, &command, &history).unwrap();
    drop(ledger);

    // Orphan blob: an artifact_blobs row with no artifacts row, whose body
    // fails SHA-256. `verify_blob_hashes` must check every blob, including
    // orphans.
    {
        let writer = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        writer
            .execute(
                "INSERT INTO artifact_blobs(blob_id, sha256, canonical_result, byte_count, line_count, estimated_tokens, token_estimator_schema_version, token_estimator_id, token_input_sha256, result_encoding, redaction_version, redaction_json, created_at_ms)\n                 VALUES (?1, ?2, ?3, ?4, NULL, 1, 1, 'test-estimator', ?5, 'rfc8785-json', 'v1', '{}', 1700000000000)",
                rusqlite::params![
                    ulid("B9"),
                    "f".repeat(64),
                    b"corrupt orphan body",
                    17i64,
                    "0".repeat(64),
                ],
            )
            .unwrap();
    }

    let error = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert_eq!(error.code(), "HISTORY_CANONICAL_DB_CORRUPT");

    // No rename happened: no renamed-aside file, no half-replaced state, and
    // the original history.db is still the live database.
    let names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert!(
        names
            .iter()
            .all(|name| !name.starts_with("history.db.bad-")),
        "unexpected aside file: {names:?}"
    );
    assert!(dir.path().join("history.db").is_file());

    // The original database still serves its operation rows and search.
    let ledger = open_session_ledger(&dir.path().join("history.db"), session_id).unwrap();
    let stored = ledger.lookup(&operation_id).unwrap().unwrap();
    assert_eq!(stored.dto.status, OperationStatus::Reserved);
    let cancel = CancellationToken::new();
    let key = session.hmac_key();
    let conn = session.search_conn();
    let page = search_session(
        &conn,
        &search_request("alpha", SessionSearchMode::Fts),
        &key,
        &cancel,
    )
    .unwrap();
    assert_eq!(page.results.len(), 1);
}

// §9.4 canonical-table copy atomicity and error-code pins

fn insert_canonical_rows(writer: &rusqlite::Connection) {
    let content = b"hello rebuild world";
    let sha = format!("{:x}", Sha256::digest(content));
    let zeros = "0".repeat(64);
    writer
        .execute(
            "INSERT INTO artifact_blobs(blob_id, sha256, canonical_result, byte_count, line_count, estimated_tokens, token_estimator_schema_version, token_estimator_id, token_input_sha256, result_encoding, redaction_version, redaction_json, created_at_ms)\n             VALUES (?1, ?2, ?3, ?4, NULL, 1, 1, 'test-estimator', ?5, 'rfc8785-json', 'v1', '{}', 1700000000000)",
            rusqlite::params![ulid("BC"), sha, content.as_slice(), content.len() as i64, zeros],
        )
        .unwrap();
    writer
        .execute(
            "INSERT INTO artifacts(artifact_id, blob_id, producing_event_id, producing_sequence, turn_id, attempt_id, step_id, batch_id, execution_id, execution_started, started_event_id, tool_call_id, call_index, tool_name, result_message_id, result_status, result_media_type, result_sha256, result_byte_count, result_line_count, result_estimated_tokens, result_redacted, normalized_label, normalized_path, content_type, is_error, default_json_pointer, source_line_start, source_line_end, exit_code, text_view_byte_count, stdout_start_byte, stdout_end_byte, stderr_start_byte, stderr_end_byte, preview_schema_version, preview_json, preview_text, preview_estimated_tokens, preview_estimator_id, preview_input_sha256, created_at_ms)\n             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, 'call_001', 0, 'read_file', ?11, 'success', 'application/vnd.praana.tool-result+json;version=1', ?12, ?13, NULL, 1, 0, NULL, NULL, 'text', 0, '', NULL, NULL, NULL, ?13, NULL, NULL, NULL, NULL, 1, '{}', 'hello rebuild world', 1, 'test-estimator', ?14, 1700000000000)",
            rusqlite::params![
                ulid("BD"),
                ulid("BC"),
                ulid("BE"),
                7i64,
                ulid("AY"),
                ulid("B2"),
                ulid("B3"),
                ulid("B7"),
                ulid("BF"),
                ulid("BG"),
                ulid("BH"),
                sha,
                content.len() as i64,
                zeros,
            ],
        )
        .unwrap();
}

#[test]
fn rebuild_copy_of_canonical_tables_is_all_or_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let session = TestSession::new(dir.path());
    {
        let writer = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        insert_canonical_rows(&writer);
        // Recreate `operation_records` in the source without its CHECK
        // constraints so a row with an invalid `operation_kind` can be
        // stored. The destination table keeps the constraints, so the third
        // INSERT of the copy must fail there.
        writer
            .execute_batch(
                "DROP TABLE operation_records;\n                 CREATE TABLE operation_records (\n                   operation_id TEXT PRIMARY KEY NOT NULL,\n                   ui_contract_schema_version INTEGER NOT NULL,\n                   operation_kind TEXT NOT NULL,\n                   request_sha256 TEXT NOT NULL,\n                   status TEXT NOT NULL,\n                   session_id TEXT,\n                   planned_effects_json TEXT NOT NULL,\n                   result_json TEXT,\n                   result_sha256 TEXT,\n                   first_canonical_sequence INTEGER,\n                   terminal_canonical_sequence INTEGER,\n                   created_at_ms INTEGER NOT NULL,\n                   finished_at_ms INTEGER\n                 ) STRICT, WITHOUT ROWID;",
            )
            .unwrap();
        let zeros = "0".repeat(64);
        writer
            .execute(
                "INSERT INTO operation_records(operation_id, ui_contract_schema_version, operation_kind, request_sha256, status, session_id, planned_effects_json, result_json, result_sha256, first_canonical_sequence, terminal_canonical_sequence, created_at_ms, finished_at_ms)\n                 VALUES (?1, 1, 'bogus', ?2, 'succeeded', ?3, '{}', '{}', ?4, NULL, NULL, 1700000000000, 1700000000001)",
                rusqlite::params![ulid("FC"), zeros.clone(), SESSION_ID, zeros],
            )
            .unwrap();
    }

    let error = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert_eq!(
        error.code(),
        "HISTORY_CANONICAL_DB_CORRUPT",
        "corrupt canonical row must stop the rebuild with the corruption code"
    );
    let dest = rusqlite::Connection::open(dir.path().join("history.db.rebuild")).unwrap();
    for table in ["artifact_blobs", "artifacts", "operation_records"] {
        let count: i64 = dest
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            count, 0,
            "{table} must stay empty when the canonical copy fails ({error})"
        );
    }
}

#[test]
fn rebuild_dangling_artifact_reference_returns_canonical_corrupt() {
    let dir = tempfile::tempdir().unwrap();
    let session = TestSession::new(dir.path());
    {
        let writer = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        insert_canonical_rows(&writer);
        // The dangling reference must be storable, so disable the per-connection
        // foreign-key enforcement for this one mutation.
        writer.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        writer
            .execute("UPDATE artifacts SET blob_id = ?1", [ulid("FD")])
            .unwrap();
    }
    let error = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert_eq!(error.code(), "HISTORY_CANONICAL_DB_CORRUPT");
}

#[test]
fn rebuild_blob_with_bad_sha256_returns_canonical_corrupt() {
    let dir = tempfile::tempdir().unwrap();
    let session = TestSession::new(dir.path());
    {
        let writer = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        insert_canonical_rows(&writer);
        writer
            .execute(
                "UPDATE artifact_blobs SET sha256 = ?1",
                [format!("{:x}", Sha256::digest(b"not the stored body"))],
            )
            .unwrap();
    }
    let error = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert_eq!(error.code(), "HISTORY_CANONICAL_DB_CORRUPT");
}

// §11.5 manifest

#[test]
fn implementation_manifest_matches_runtime() {
    let path = fixture_dir().join("implementation_manifest.json");
    let raw = fs::read_to_string(&path).unwrap();
    let manifest: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(manifest["search_schema_version"], 1);
    assert_eq!(
        manifest["unicode_utility_version"],
        "praana-unicode-15.1-v1"
    );
    let dir = tempfile::tempdir().unwrap();
    let _db = HistoryDatabase::open(&dir.path().join("history.db")).unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
    let sqlite_version: String = conn
        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
        .unwrap();
    assert_eq!(manifest["sqlite_version"], sqlite_version);
    let fts_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'search_fts'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(manifest["fts5_declaration"], normalize_sql(&fts_sql));
}

fn normalize_sql(sql: &str) -> String {
    let mut out = String::new();
    let mut in_whitespace = false;
    for ch in sql.chars() {
        if ch.is_ascii_whitespace() {
            in_whitespace = true;
        } else {
            if in_whitespace && !out.is_empty() {
                out.push(' ');
            }
            in_whitespace = false;
            out.push(ch);
        }
    }
    out
}

// §10.4 tool bound constant

#[test]
fn tool_result_max_bytes_constant() {
    assert_eq!(HISTORY_TOOL_RESULT_MAX_BYTES, 65_536);
}

// §15.2 crash points 11, 12, 13, 15, 16 (P4A-owned points)

#[cfg(all(feature = "failpoints", unix))]
#[test]
fn child_crash_point() {
    let Ok(point) = std::env::var("PRAANA_P4A_CRASH_POINT") else {
        return;
    };
    let Ok(root) = std::env::var("PRAANA_P4A_ROOT") else {
        return;
    };
    praana_core::arm_test_failpoint(&point).expect("arm one child failpoint");
    let dir = PathBuf::from(&root);
    match std::env::var("PRAANA_P4A_ACTION").as_deref() {
        Ok("delete") => {
            let options = praana_core::history::deletion::DeleteSessionOptions {
                pinned: false,
                now_ms: i64::MAX / 4,
                retention_threshold_ms: 0,
            };
            let outcome =
                praana_core::history::deletion::delete_session(&dir, &session_id(), &options)
                    .expect("delete_session");
            assert!(
                matches!(
                    outcome,
                    praana_core::history::deletion::SessionRetention::Deleted(_)
                ),
                "crash point was not hit: {outcome:?}"
            );
        }
        _ => {
            let log = EventLogStore::open(&dir, SESSION_ID).expect("open log");
            let db = HistoryDatabase::open(&dir.join("history.db")).expect("open db");
            let projector = HistoryProjector::new(&db);
            if std::env::var("PRAANA_P4A_REBUILD").as_deref() == Ok("1") {
                projector.rebuild(&log).expect("rebuild");
            } else {
                projector.project(&log).expect("project");
            }
        }
    }
    if std::env::var("PRAANA_P4A_ACTION").as_deref() != Ok("project_without_summary") {
        panic!("crash point was not hit");
    }
}

#[cfg(all(feature = "failpoints", unix))]
fn spawn_crash_child(root: &Path, point: &str, action: &str) -> std::process::Output {
    std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("child_crash_point")
        .env("PRAANA_P4A_ROOT", root)
        .env("PRAANA_P4A_CRASH_POINT", point)
        .env("PRAANA_P4A_ACTION", action)
        .env(
            "PRAANA_P4A_REBUILD",
            if action == "rebuild" { "1" } else { "0" },
        )
        .output()
        .expect("spawn crash child")
}

#[cfg(all(feature = "failpoints", unix))]
fn assert_abort(output: &std::process::Output, point: &str) {
    use std::os::unix::process::ExitStatusExt;

    assert_eq!(
        output.status.signal(),
        Some(6),
        "{point}: expected SIGABRT, stdout={:?} stderr={:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn projected_document_count(dir: &Path) -> i64 {
    let conn = rusqlite::Connection::open(dir.join("history.db")).unwrap();
    conn.query_row("SELECT COUNT(*) FROM search_documents", [], |row| {
        row.get(0)
    })
    .unwrap()
}

#[cfg(all(feature = "failpoints", unix))]
#[test]
fn crash_before_projection_transaction_preserves_the_derived_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let before = projected_document_count(dir.path());
    assert!(before > 0);
    drop(session);

    for point in [
        "history.finish_fsync_before_projection",
        "history.derived_update_before_turns",
        "history.derived_update_before_search_documents",
        "history.derived_update_before_search_fts",
        "history.checkpoint_upsert_before_commit",
    ] {
        {
            // Remove only the checkpoint: the child must replay, and the
            // existing derived rows must survive an aborted transaction.
            let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
            conn.execute("DELETE FROM projection_checkpoints", [])
                .unwrap();
        }
        let output = spawn_crash_child(dir.path(), point, "project");
        assert_abort(&output, point);
        // A crash inside the transaction must not leave a partial projection.
        assert_eq!(
            projected_document_count(dir.path()),
            before,
            "{point}: derived rows changed across the crash"
        );
        // Idempotent replay in a fresh process restores the same state.
        let log = EventLogStore::open(dir.path(), SESSION_ID).unwrap();
        let db = HistoryDatabase::open(&dir.path().join("history.db")).unwrap();
        HistoryProjector::new(&db).project(&log).unwrap();
        assert_eq!(
            projected_document_count(dir.path()),
            before,
            "{point}: replay after the crash is not idempotent"
        );
    }
}

#[cfg(all(feature = "failpoints", unix))]
#[test]
fn crash_during_rebuild_wal_checkpoint_keeps_a_rebuildable_database() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    drop(session);
    {
        let writer = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        writer.execute("DELETE FROM search_fts", []).unwrap();
    }

    let output = spawn_crash_child(dir.path(), "history.wal_checkpoint", "rebuild");
    assert_abort(&output, "history.wal_checkpoint");
    // The live database is still the pre-rebuild file with corrupt FTS.
    assert!(!dir.path().join("history.db.bad-0").exists());

    // A later rebuild (which clears a stale `history.db.rebuild` first) works.
    let log = EventLogStore::open(dir.path(), SESSION_ID).unwrap();
    let db = HistoryDatabase::open(&dir.path().join("history.db")).unwrap();
    HistoryProjector::new(&db).rebuild(&log).unwrap();
    assert!(!dir.path().join("history.db.rebuild").exists());

    let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
    let key = {
        let text = fs::read_to_string(dir.path().join("meta.json")).unwrap();
        let meta: Value = serde_json::from_str(text.trim_end_matches('\n')).unwrap();
        decode_base64(meta["cursor_hmac_key_base64"].as_str().unwrap())
            .try_into()
            .unwrap()
    };
    let page = search_session(
        &conn,
        &search_request("alpha", SessionSearchMode::Fts),
        &key,
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(page.results.len(), 1, "fts is empty after the rebuild");
}

#[cfg(all(feature = "failpoints", unix))]
#[test]
fn crash_around_deletion_rename_keeps_or_removes_exactly_one_side() {
    let dir = tempfile::tempdir().unwrap();
    let sessions_root = dir.path().to_path_buf();
    let session_dir = sessions_root.join(SESSION_ID);
    std::fs::create_dir_all(&session_dir).unwrap();
    let session = build_session_with_texts(&session_dir, &["alpha"], &[]);
    drop(session);
    assert!(session_dir.join("events.jsonl").is_file());

    // Point 16, before the rename: the live session is untouched.
    let output = spawn_crash_child(&sessions_root, "history.deletion_before_rename", "delete");
    assert_abort(&output, "history.deletion_before_rename");
    assert!(session_dir.join("events.jsonl").is_file());
    // The trash directory is created before the rename (§14 step 2), but
    // nothing was moved into it.
    assert_eq!(
        fs::read_dir(sessions_root.join(".trash")).unwrap().count(),
        0
    );

    // Point 16, after the rename: no discoverable live session and a
    // retryable trash entry.
    let output = spawn_crash_child(&sessions_root, "history.deletion_after_rename", "delete");
    assert_abort(&output, "history.deletion_after_rename");
    assert!(!session_dir.exists());
    let trash = sessions_root.join(".trash");
    let entries: Vec<String> = fs::read_dir(&trash)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(entries.len(), 1, "expected one retryable trash entry");
    assert!(entries[0].starts_with(SESSION_ID));
    praana_core::history::deletion::remove_trash_entry(&trash.join(&entries[0])).unwrap();
    assert_eq!(fs::read_dir(&trash).unwrap().count(), 0);
}

// §5.2 checkpoint validation, §6.1 rule 5, §6.2 line identity, §10.1/§10.2,
// §10.3, §12 read-only readers, §13 busy, §14 deletion

#[test]
fn checkpoint_with_a_foreign_search_schema_version_is_discarded_and_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let before = projected_document_count(dir.path());
    {
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        let payload: String = conn
            .query_row(
                "SELECT payload_json FROM projection_checkpoints WHERE projection_name = 'history_derived'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut value: Value = serde_json::from_str(&payload).unwrap();
        value["search_schema_version"] = json!(99);
        conn.execute(
            "UPDATE projection_checkpoints SET payload_json = ?1 WHERE projection_name = 'history_derived'",
            [serde_json::to_string(&value).unwrap()],
        )
        .unwrap();
    }

    let projector = HistoryProjector::new(&session.db);
    // The stale row is never reported as authority.
    assert!(projector.checkpoint().unwrap().is_none());
    projector.project(&session.log).unwrap();
    // §9.4: the derived tables are rebuilt into a new file and the old one is
    // renamed aside, not repaired in place.
    let aside = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .find(|name| name.starts_with("history.db.bad-"))
        .expect("a bad checkpoint must route to the section 9.4 rebuild");
    assert!(!dir.path().join("history.db.rebuild").exists(), "{aside}");
    assert_eq!(projected_document_count(dir.path()), before);
    let payload: Value = {
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        let text: String = conn
            .query_row(
                "SELECT payload_json FROM projection_checkpoints WHERE projection_name = 'history_derived'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&text).unwrap()
    };
    assert_eq!(payload["search_schema_version"], 1);
}

#[test]
fn checkpoint_with_a_tampered_payload_hash_is_discarded() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    {
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        conn.execute(
            "UPDATE projection_checkpoints SET payload_hash = ?1 WHERE projection_name = 'history_derived'",
            ["0".repeat(64)],
        )
        .unwrap();
    }
    assert!(HistoryProjector::new(&session.db)
        .checkpoint()
        .unwrap()
        .is_none());
    // The tampered row is discarded and the derived tables are rebuilt rather
    // than repaired in place.
    HistoryProjector::new(&session.db)
        .project(&session.log)
        .unwrap();
    let aside = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .find(|name| name.starts_with("history.db.bad-"))
        .expect("a tampered payload hash must route to the section 9.4 rebuild");
    assert!(!dir.path().join("history.db.rebuild").exists(), "{aside}");
    assert!(HistoryProjector::new(&session.db)
        .checkpoint()
        .unwrap()
        .is_some());
}

#[test]
fn re_applying_an_identical_event_is_idempotent_and_a_divergent_row_is_integrity() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let before = projected_document_count(dir.path());
    HistoryProjector::new(&session.db)
        .project(&session.log)
        .unwrap();
    assert_eq!(projected_document_count(dir.path()), before);

    {
        // A row that no longer matches its replayed event is never overwritten.
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        conn.execute(
            "UPDATE search_documents SET text = 'divergent', content_sha256 = ?1 WHERE rowid = 1",
            ["f".repeat(64)],
        )
        .unwrap();
    }
    {
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        conn.execute("DELETE FROM projection_checkpoints", [])
            .unwrap();
    }
    let error = HistoryProjector::new(&session.db)
        .project(&session.log)
        .unwrap_err();
    assert_eq!(error.code(), "HISTORY_EVENT_INTEGRITY");
}

#[test]
fn history_tool_results_are_never_artifactized() {
    use praana_core::history::artifact::{plan_storage, PlanItem, StorageClass};
    let items = vec![
        PlanItem {
            call_index: 0,
            tool_name: "read_file".to_owned(),
            total_tokens: 1_000_000,
            binary: false,
        },
        PlanItem {
            call_index: 1,
            tool_name: "search_session_log".to_owned(),
            total_tokens: 1_000_000,
            binary: false,
        },
        PlanItem {
            call_index: 2,
            tool_name: "retrieve_artifact".to_owned(),
            total_tokens: 1_000_000,
            binary: false,
        },
        PlanItem {
            call_index: 3,
            tool_name: "read_session_source".to_owned(),
            total_tokens: 1_000_000,
            binary: false,
        },
    ];
    let policy = ArtifactPolicy {
        inline_tokens: 10,
        batch_inline_tokens: 10,
        preview_tokens: 10,
        orphan_retention_days: 7,
    };
    let decided = plan_storage(&items, &policy).unwrap();
    // The oversize read_file is artifactized; every history tool stays inline
    // and out of the batch inline sum.
    assert_eq!(decided[0], StorageClass::Artifact);
    assert_eq!(decided[1], StorageClass::Inline);
    assert_eq!(decided[2], StorageClass::Inline);
    assert_eq!(decided[3], StorageClass::Inline);
}

#[test]
fn search_tool_result_text_is_never_re_indexed() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[("retrieve_artifact", json!({"artifact_id": ulid("B1")}))],
    );
    let (finish_id, _) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        "call_001",
        0,
        "retrieve_artifact",
        ToolBody::Inline("hidden search output"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &["call_001"],
        &[finish_id],
    );
    let terminal = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
    session.assistant_step(turn_id, attempt_id, terminal, Some("done"), None, None, &[]);
    session.turn_committed(turn_id, user_message_id, terminal);
    session.project();

    let conn = session.search_conn();
    let page = search_session(
        &conn,
        &search_request("hidden", SessionSearchMode::Exact),
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert!(
        page.results.is_empty(),
        "history tool output was re-indexed"
    );
    let names: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM search_documents WHERE tool_name = 'retrieve_artifact' AND source_field = 'assistant.blocks[0].tool_call.name'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(names, 1, "the tool-call name row is still indexed");
}

#[test]
fn a_history_tool_call_argument_row_uses_the_session_redaction_version() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        // The token is built by concatenation, like the other redaction
        // fixtures, so no token-shaped literal is stored in the tree.
        &[(
            "shell",
            json!({"command": format!("echo ghp_{}", "a".repeat(36))}),
        )],
    );
    let (finish_id, _) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FB7",
        "call_001",
        0,
        "shell",
        ToolBody::Inline("done"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FB7",
        &["call_001"],
        &[finish_id],
    );
    let terminal = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
    session.assistant_step(turn_id, attempt_id, terminal, Some("done"), None, None, &[]);
    session.turn_committed(turn_id, user_message_id, terminal);
    session.project();

    let conn = session.search_conn();
    let text: String = conn
        .query_row(
            "SELECT text FROM search_documents WHERE source_field = 'assistant.blocks[0].tool_call.arguments'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!text.contains("ghp_"), "secret survived redaction");
    assert!(
        text.contains("[REDACTED"),
        "redaction marker missing: {text}"
    );
}

#[test]
fn binary_content_rejects_every_selector_except_complete_result() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[("read_file", json!({"path": "a.bin"}))],
    );
    let (finish_id, artifact_id) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        "call_001",
        0,
        "read_file",
        // A NUL byte makes the stored artifact binary.
        ToolBody::Artifact("ab\u{0}cd"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &["call_001"],
        &[finish_id],
    );
    let terminal = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
    session.assistant_step(turn_id, attempt_id, terminal, Some("done"), None, None, &[]);
    session.turn_committed(turn_id, user_message_id, terminal);
    session.project();

    let conn = session.search_conn();
    let cancel = CancellationToken::new();
    let artifact_id = artifact_id.unwrap();

    // §10.2: only complete_result (with optional max_bytes/byte_offset) is valid.
    for selector in [
        None,
        Some(ArtifactSelector::Default),
        Some(ArtifactSelector::Stdout),
        Some(ArtifactSelector::Stderr),
    ] {
        let mut request = retrieve_request(&artifact_id.to_string());
        request.selector = selector;
        let error = retrieve_artifact(&conn, &request, &cancel).unwrap_err();
        assert_eq!(error.code(), "HISTORY_SELECTOR_UNSUPPORTED", "{selector:?}");
    }

    let mut request = retrieve_request(&artifact_id.to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.max_bytes = Some(2);
    let response = retrieve_artifact(&conn, &request, &cancel).unwrap();
    assert_eq!(response.selected_line_start, None);
    assert_eq!(response.selected_line_end, None);
    assert_eq!(response.total_lines, None);
    assert!(matches!(
        response.content,
        ArtifactRetrievedContent::Base64(_)
    ));
}

#[test]
fn an_oversized_regex_group_reports_its_line_details() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let turn_id = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    let user_message_id = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    let attempt_id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    let step_id = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
    let batch_id = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
    session.user_message(turn_id, &["hello"]);
    session.turn_started(turn_id, user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        None,
        None,
        None,
        &[("read_file", json!({"path": "a.txt"}))],
    );
    let (finish_id, artifact_id) = session.tool_execution(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        "call_001",
        0,
        "read_file",
        ToolBody::Artifact("aaaa\nbbbb\ncccc\n"),
    );
    session.batch_completed(
        turn_id,
        attempt_id,
        step_id,
        batch_id,
        &["call_001"],
        &[finish_id],
    );
    let terminal = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
    session.assistant_step(turn_id, attempt_id, terminal, Some("done"), None, None, &[]);
    session.turn_committed(turn_id, user_message_id, terminal);
    session.project();

    let conn = session.search_conn();
    let mut request = retrieve_request(&artifact_id.unwrap().to_string());
    request.selector = Some(ArtifactSelector::CompleteResult);
    request.regex = Some(RegexFilter {
        pattern: "aaaa".to_owned(),
        case_sensitive: true,
        context_before: 0,
        context_after: 0,
        max_matches: 10,
    });
    request.max_bytes = Some(2);
    let error = retrieve_artifact(&conn, &request, &CancellationToken::new()).unwrap_err();
    assert_eq!(error.code(), "HISTORY_ARTIFACT_TOO_LARGE");
    assert_eq!(
        error.details(),
        Some(&json!({"line_start": 1, "line_end": 1}))
    );
}

#[test]
fn a_corrupt_stored_identifier_or_hash_is_event_integrity() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &[]);
    let conn = session.search_conn();
    let (result_id, original_text): (String, String) = {
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        conn.query_row(
            "SELECT document_id, text FROM search_documents WHERE source_field = 'user.blocks[0].text'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    };
    let request = ReadSessionSourceRequest {
        result_id: SearchResultId::from_str_canonical(&result_id).unwrap(),
        byte_offset: 0,
    };
    assert_eq!(original_text, "alpha");
    assert_eq!(
        read_session_source(&conn, &request, &CancellationToken::new())
            .unwrap()
            .text,
        "alpha"
    );

    {
        // A stored id column that is not canonical is never replaced by a
        // substitute value.
        let writer = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        writer
            .execute(
                "UPDATE search_documents SET event_id = 'not-a-ulid' WHERE document_id = ?1",
                [&result_id],
            )
            .unwrap();
    }
    let error = read_session_source(&conn, &request, &CancellationToken::new()).unwrap_err();
    assert_eq!(error.code(), "HISTORY_EVENT_INTEGRITY");
    assert!(error.message().contains("event_id"), "{}", error.message());

    {
        // §10.3: text that no longer hashes to content_sha256 is
        // HISTORY_EVENT_INTEGRITY.
        let writer = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        writer
            .execute(
                "UPDATE search_documents SET event_id = NULL, text = 'tampered' WHERE document_id = ?1",
                [&result_id],
            )
            .unwrap();
    }
    let error = read_session_source(&conn, &request, &CancellationToken::new()).unwrap_err();
    assert_eq!(error.code(), "HISTORY_EVENT_INTEGRITY");
    assert!(
        error.message().contains("content_sha256"),
        "{}",
        error.message()
    );
}

#[test]
fn search_and_retrieval_read_through_a_read_only_connection_during_a_writer_commit() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let key = session.hmac_key();
    let db_path = dir.path().join("history.db");

    // §12: a separate read-only handle opens without taking the writer mutex.
    drop(HistoryDatabase::open_read_only(&db_path).unwrap());
    // A read-only open never creates the file.
    let missing = dir.path().join("absent.db");
    assert!(HistoryDatabase::open_read_only(&missing).is_err());
    assert!(!missing.exists());

    let reader = rusqlite::Connection::open(&db_path).unwrap();
    reader
        .execute_batch("PRAGMA query_only = ON; BEGIN")
        .unwrap();
    let writer = rusqlite::Connection::open(&db_path).unwrap();
    writer.execute_batch("PRAGMA busy_timeout = 5000").unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    writer
        .execute(
            "INSERT INTO telemetry_counters(key, value, updated_at_ms) VALUES ('p4a', 1, 0)
             ON CONFLICT(key) DO UPDATE SET value = value + 1",
            [],
        )
        .unwrap();
    // The reader answers from its snapshot while the writer is mid-transaction.
    let page = search_session(
        &reader,
        &search_request("alpha", SessionSearchMode::Exact),
        &key,
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(page.results.len(), 1);
    writer.execute_batch("COMMIT").unwrap();
    let page = search_session(
        &reader,
        &search_request("alpha", SessionSearchMode::Exact),
        &key,
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(page.results.len(), 1);
    reader.execute_batch("COMMIT").unwrap();
}

#[test]
fn deletion_keeps_a_locked_or_recent_session() {
    use praana_core::history::deletion::{DeleteSessionOptions, SessionRetention};

    let sessions_root = tempfile::tempdir().unwrap();
    let session_dir = sessions_root.path().join(SESSION_ID);
    std::fs::create_dir_all(&session_dir).unwrap();
    let session = build_session_with_texts(&session_dir, &["alpha"], &[]);

    // A zero clock is older than nothing: the file mtimes are in the future
    // relative to it, so the session is never treated as inactive.
    let options = DeleteSessionOptions {
        pinned: false,
        now_ms: 0,
        retention_threshold_ms: 60_000,
    };
    // The open store still holds the writer lock, which is §14 step 1 and the
    // only condition that reports HISTORY_SESSION_LOCKED.
    let error = praana_core::history::deletion::delete_session(
        sessions_root.path(),
        &session_id(),
        &options,
    )
    .unwrap_err();
    assert_eq!(error.code(), "HISTORY_SESSION_LOCKED");
    assert!(session_dir.join("events.jsonl").is_file());
    drop(session);

    // Lock free but not inactive: kept, reported as a value with its age.
    let recent = praana_core::history::deletion::delete_session(
        sessions_root.path(),
        &session_id(),
        &options,
    )
    .unwrap();
    let SessionRetention::Active { last_activity_ms } = recent else {
        panic!("expected an active session, got {recent:?}");
    };
    assert!(last_activity_ms > options.now_ms);
    assert!(session_dir.join("events.jsonl").is_file());

    // Pinned: kept, and reported as a value rather than as a storage error.
    let pinned = DeleteSessionOptions {
        pinned: true,
        now_ms: i64::MAX / 4,
        retention_threshold_ms: 0,
    };
    assert_eq!(
        praana_core::history::deletion::delete_session(
            sessions_root.path(),
            &session_id(),
            &pinned
        )
        .unwrap(),
        SessionRetention::Pinned
    );
    assert!(session_dir.join("events.jsonl").is_file());
    assert!(
        !sessions_root.path().join(".trash").exists(),
        "a kept session must not create a trash entry"
    );
}

#[test]
fn deletion_removes_an_inactive_session_and_empties_the_trash() {
    let sessions_root = tempfile::tempdir().unwrap();
    let session_dir = sessions_root.path().join(SESSION_ID);
    std::fs::create_dir_all(&session_dir).unwrap();
    let session = build_session_with_texts(&session_dir, &["alpha"], &[]);
    drop(session);
    let outcome = praana_core::history::deletion::delete_session(
        sessions_root.path(),
        &session_id(),
        &praana_core::history::deletion::DeleteSessionOptions {
            pinned: false,
            now_ms: i64::MAX / 4,
            retention_threshold_ms: 0,
        },
    )
    .unwrap();
    let praana_core::history::deletion::SessionRetention::Deleted(deletion_id) = outcome else {
        panic!("expected a deletion, got {outcome:?}");
    };
    assert!(!session_dir.exists());
    let trash = praana_core::history::deletion::trash_dir_for(sessions_root.path());
    assert_eq!(
        fs::read_dir(&trash).unwrap().count(),
        0,
        "trash is not empty"
    );
    // The id is only a record of the operation; nothing references it now.
    assert!(deletion_id.to_string().len() == 26);
}

fn zero_digest() -> Sha256Digest {
    Sha256Digest::from_bytes([0; 32])
}

fn test_admission() -> AdmissionSnapshot {
    AdmissionSnapshot {
        token_estimator_schema_version: 1,
        estimator_id: "praana-generic-unicode-15.1-v1".to_owned(),
        estimated_input_sha256: Sha256Digest::from_hex_str(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap(),
        context_window_tokens: 128_000,
        estimated_input_tokens: 0,
        resolved_output_tokens: 0,
        requested_reasoning_tokens: 0,
        safety_margin_tokens: 0,
        projected_fill_millionths: 0,
        capability_profile_hash: Sha256Digest::from_hex_str(
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        )
        .unwrap(),
        estimate_reused_from_attempt_id: None,
    }
}

fn closed_turn(
    session: &mut TestSession,
    turn_id: &str,
    attempt_id: &str,
    step_id: &str,
    user_text: &str,
    assistant_text: &str,
) -> (u64, u64) {
    let user_message_id = session.user_message(turn_id, &[user_text]);
    session.turn_started(turn_id, &user_message_id);
    session.assistant_step(
        turn_id,
        attempt_id,
        step_id,
        Some(assistant_text),
        None,
        None,
        &[],
    );
    session.turn_committed(turn_id, &user_message_id, step_id);
    let events = session.log.events().unwrap();
    let start = events
        .iter()
        .find(|event| {
            event.turn_id.map(|id| id.to_string()).as_deref() == Some(turn_id)
                && matches!(event.event, CanonicalEvent::TurnStarted(_))
        })
        .unwrap()
        .sequence;
    let end = events
        .iter()
        .find(|event| {
            event.turn_id.map(|id| id.to_string()).as_deref() == Some(turn_id)
                && matches!(event.event, CanonicalEvent::TurnCommitted(_))
        })
        .unwrap()
        .sequence;
    (start, end)
}

struct CompactionIds {
    attempt: &'static str,
    compaction: &'static str,
    segment: &'static str,
    handoff: &'static str,
}

struct AppendedCompaction {
    segment_id: SummarySegmentId,
    event_id: EventId,
    source_hash: Sha256Digest,
    segment_json: String,
    handoff_json: String,
}

struct CompactionAppend<'a> {
    epoch: u32,
    reset_epoch: u32,
    turn_id: &'a str,
    start_sequence: u64,
    end_sequence: u64,
    segment_text: &'a str,
    handoff_text: &'a str,
    ids: CompactionIds,
    previous_handoff: Option<HandoffId>,
    handoff_start: u64,
}

fn append_history_compacted(
    session: &mut TestSession,
    spec: CompactionAppend<'_>,
) -> AppendedCompaction {
    append_history_compacted_with(session, spec, |_| {})
}

/// Like [`append_history_compacted`], but runs `tamper` on the fully-built
/// `HistoryCompactedV1` just before it is appended. Used by the integrity
/// tests to drive the projection's rejection branches.
fn append_history_compacted_with(
    session: &mut TestSession,
    spec: CompactionAppend<'_>,
    tamper: impl FnOnce(&mut HistoryCompactedV1),
) -> AppendedCompaction {
    let CompactionAppend {
        epoch,
        reset_epoch,
        turn_id,
        start_sequence,
        end_sequence,
        segment_text,
        handoff_text,
        ids,
        previous_handoff,
        handoff_start,
    } = spec;
    let lines = session.log.raw_lines();
    let source_hash =
        calculate_source_hash(&lines[(start_sequence as usize - 1)..end_sequence as usize]);
    let turn = TurnId::from_str_canonical(turn_id).unwrap();
    let segment_id = SummarySegmentId::from_str_canonical(ids.segment).unwrap();
    let handoff_id = HandoffId::from_str_canonical(ids.handoff).unwrap();
    let estimator = "praana-generic-unicode-15.1-v1".to_owned();
    let source_input = Sha256Digest::from_bytes([3; 32]);
    let mut segment_content = SummarySegmentContentV1::default();
    segment_content.user_goals.push(HistoricalStatementV1 {
        text: segment_text.to_owned(),
        confidence: StatementConfidence::Direct,
        evidence: EvidenceRefV1::default(),
        uncertainty: None,
    });
    let segment = SummarySegmentV1 {
        summary_segment_schema_version: 1,
        segment_id,
        epoch,
        source: SourceRangeV1 {
            reset_epoch,
            start_sequence,
            end_sequence,
            turn_ids: vec![turn],
            event_prefix_hash_before: zero_digest(),
            source_hash: source_hash.clone(),
            source_tokens: 11,
            source_estimator_id: estimator.clone(),
            source_input_sha256: source_input.clone(),
        },
        content: segment_content,
        artifact_ids: Vec::new(),
        state_ids: Vec::new(),
    };
    let mut handoff_content = HistoricalHandoffContentV1::default();
    handoff_content.current_goals.push(HistoricalStatementV1 {
        text: handoff_text.to_owned(),
        confidence: StatementConfidence::Direct,
        evidence: EvidenceRefV1::default(),
        uncertainty: None,
    });
    let handoff = HistoricalHandoffV1 {
        handoff_schema_version: 1,
        handoff_id,
        reason: HandoffReason::Compaction,
        label: "NON-AUTHORITATIVE HISTORICAL EVIDENCE".to_owned(),
        epoch,
        lineage_through_epoch: epoch,
        source_start_sequence: handoff_start,
        source_end_sequence: end_sequence,
        based_on_previous_handoff: previous_handoff,
        content: handoff_content,
        artifact_ids: Vec::new(),
        state_ids: Vec::new(),
        estimated_tokens: 0,
        estimator_id: estimator.clone(),
        rendered_input_sha256: zero_digest(),
    };
    let segment_json = serialize_canonical_string(&segment).unwrap();
    let handoff_json = serialize_canonical_string(&handoff).unwrap();
    let attempt_id = AttemptId::from_str_canonical(ids.attempt).unwrap();
    let started = session.append(
        CanonicalEvent::AssistantAttemptStarted(AssistantAttemptStarted {
            purpose: ProviderAttemptPurpose::Compaction(CompactionPurpose {
                compaction_id: CompactionId::from_str_canonical(ids.compaction).unwrap(),
                epoch,
            }),
            attempt_number: 1,
            model: model_selection(),
            request_hash: Sha256Digest::from_hex_str(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .unwrap(),
            admission: test_admission(),
            retry_of: None,
            emergency_context_retry: false,
            recovery_notices: Vec::new(),
        }),
        None,
        Some(attempt_id),
    );
    let event_id = {
        let mut compacted = HistoryCompactedV1 {
            compaction_schema_version: 1,
            compaction_id: CompactionId::from_str_canonical(ids.compaction).unwrap(),
            policy_version: "rust-v2-compaction-1".to_owned(),
            epoch,
            reset_epoch,
            source_start_sequence: start_sequence,
            source_end_sequence: end_sequence,
            source_hash: source_hash.clone(),
            source_turn_ids: vec![turn],
            eligible_source_tokens: 11,
            target_source_tokens: 6,
            retired_source_tokens: 11,
            segment,
            segment_hash: Sha256Digest::digest_bytes(segment_json.as_bytes()),
            handoff,
            handoff_hash: Sha256Digest::digest_bytes(handoff_json.as_bytes()),
            candidate_hash: Sha256Digest::from_bytes([5; 32]),
            output_tokens: 5,
            strategy: CompactorStrategy::Configured {
                provider: "openai".to_owned(),
                model: "gpt-test".to_owned(),
                config_id: "cfg".to_owned(),
            },
            provider: "openai".to_owned(),
            protocol: "openai-responses-v1".to_owned(),
            model: "gpt-test".to_owned(),
            model_revision: None,
            prompt_version: "compaction-v1:p54".to_owned(),
            token_estimator_schema_version: 1,
            estimator_id: estimator,
            output_input_sha256: Sha256Digest::from_bytes([4; 32]),
            artifact_ids: Vec::new(),
            state_ids: Vec::new(),
            attempt_started_event_id: started,
        };
        tamper(&mut compacted);
        session.append(
            CanonicalEvent::HistoryCompacted(compacted),
            None,
            Some(attempt_id),
        )
    };
    AppendedCompaction {
        segment_id,
        event_id,
        source_hash,
        segment_json,
        handoff_json,
    }
}

fn summary_count(dir: &Path) -> i64 {
    let conn = rusqlite::Connection::open(dir.join("history.db")).unwrap();
    conn.query_row("SELECT COUNT(*) FROM summary_segments", [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn checkpoint_sequence(dir: &Path) -> i64 {
    let conn = rusqlite::Connection::open(dir.join("history.db")).unwrap();
    conn.query_row(
        "SELECT applied_through_sequence FROM projection_checkpoints WHERE projection_name = 'history_derived'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn assert_checkpoint_payload_unchanged(dir: &Path) {
    let conn = rusqlite::Connection::open(dir.join("history.db")).unwrap();
    let (version, payload): (i64, String) = conn
        .query_row(
            "SELECT checkpoint_schema_version, payload_json FROM projection_checkpoints WHERE projection_name = 'history_derived'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        version, 1,
        "checkpoint_schema_version stays at History §5.2"
    );
    let value: Value = serde_json::from_str(&payload).unwrap();
    let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "applied_through_sequence".to_owned(),
            "checkpoint_schema_version".to_owned(),
            "event_prefix_hash".to_owned(),
            "projection_version".to_owned(),
            "reset_epoch".to_owned(),
            "search_schema_version".to_owned(),
            "session_id".to_owned(),
        ]
    );
    let parsed: HistoryDerivedCheckpointV1 = serde_json::from_str(&payload).unwrap();
    assert_eq!(parsed.checkpoint_schema_version, 1);
}

fn summary_hit(
    session: &TestSession,
    query: &str,
    mode: SessionSearchMode,
) -> praana_core::history::search::SessionSearchResult {
    let conn = session.search_conn();
    let mut request = search_request(query, mode);
    request.filters.source_kinds = vec![SearchSourceKind::SummarySegment];
    let page = search_session(
        &conn,
        &request,
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(page.results.len(), 1, "query {query:?} mode {mode:?}");
    page.results.into_iter().next().unwrap()
}

fn assert_summary_retrieval(
    session: &TestSession,
    hit: &praana_core::history::search::SessionSearchResult,
    field: &str,
    text: &str,
    segment_id: &SummarySegmentId,
) {
    assert_eq!(hit.source_kind, SearchSourceKind::SummarySegment);
    assert_eq!(hit.source_field, field);
    assert_eq!(hit.summary_segment_id.as_ref(), Some(segment_id));
    assert!(hit.turn_id.is_none());
    assert_eq!(hit.event_kind.as_deref(), Some("history_compacted"));
    assert_eq!(hit.retrieval.tool, "read_session_source");
    assert_eq!(
        hit.retrieval.arguments["result_id"],
        hit.result_id.to_string()
    );
    assert_eq!(hit.retrieval.arguments["byte_offset"], 0);
    let response = read_session_source(
        &session.search_conn(),
        &ReadSessionSourceRequest {
            result_id: hit.result_id,
            byte_offset: 0,
        },
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(
        response.source_kind,
        praana_core::history::retrieve::SearchSourceKind::SummarySegment
    );
    assert_eq!(response.source_field, field);
    assert_eq!(response.text, text);
    assert!(response.complete);
    assert!(response.text.contains('<'));
    assert!(!response.text.contains("\\u003c"));
}

#[test]
fn summary_segment_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let (start, end) = closed_turn(
        &mut session,
        "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "alpha source kept",
        "assistant alpha",
    );
    let appended = append_history_compacted(
        &mut session,
        CompactionAppend {
            epoch: 1,
            reset_epoch: 0,
            turn_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            start_sequence: start,
            end_sequence: end,
            segment_text: "zephyrgoal <kept",
            handoff_text: "quollhandoff <kept",
            ids: CompactionIds {
                attempt: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
                compaction: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
                segment: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
                handoff: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
            },
            previous_handoff: None,
            handoff_start: start,
        },
    );
    session.project();
    session.project();

    assert_eq!(summary_count(dir.path()), 1);
    let conn = session.search_conn();
    let row: (String, String, String, String, i64, String, String) = conn
        .query_row(
            "SELECT segment_json, handoff_json, segment_hash, handoff_hash, source_tokens, \
                    source_estimator_id, output_estimator_id \
             FROM summary_segments WHERE segment_id = ?1",
            [appended.segment_id.to_string()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(row.0, appended.segment_json);
    assert_eq!(row.1, appended.handoff_json);
    assert_eq!(row.2, Sha256Digest::digest_bytes(row.0.as_bytes()).as_str());
    assert_eq!(row.3, Sha256Digest::digest_bytes(row.1.as_bytes()).as_str());
    assert_eq!(row.4, 11);
    assert_eq!(row.5, "praana-generic-unicode-15.1-v1");
    assert_eq!(row.6, "praana-generic-unicode-15.1-v1");

    let retired: (Option<i64>, Option<String>) = conn
        .query_row(
            "SELECT retired_by_epoch, source_hash FROM turns WHERE turn_id = '01ARZ3NDEKTSV4RRFFQ69G5FAY'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(retired.0, Some(1));
    assert_eq!(retired.1.as_deref(), Some(appended.source_hash.as_str()));

    let exact = summary_hit(&session, "zephyrgoal", SessionSearchMode::Exact);
    assert_summary_retrieval(
        &session,
        &exact,
        "summary_segment.segment",
        &appended.segment_json,
        &appended.segment_id,
    );
    assert_eq!(exact.event_id, Some(appended.event_id));
    let fts = summary_hit(&session, "zephyrgoal", SessionSearchMode::Fts);
    assert_eq!(fts.result_id, exact.result_id);
    let handoff = summary_hit(&session, "quollhandoff", SessionSearchMode::Exact);
    assert_summary_retrieval(
        &session,
        &handoff,
        "summary_segment.handoff",
        &appended.handoff_json,
        &appended.segment_id,
    );

    let lookup = search_session(
        &conn,
        &SessionSearchRequest {
            query: String::new(),
            mode: SessionSearchMode::Exact,
            case_sensitive: false,
            filters: SessionSearchFilters {
                summary_segment_ids: vec![appended.segment_id],
                ..SessionSearchFilters::default()
            },
            limit: 20,
            cursor: None,
        },
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(lookup.results.len(), 2);
    assert!(lookup.results.iter().all(|hit| hit.occurrences.is_empty()));
    assert!(lookup
        .results
        .iter()
        .all(|hit| hit.retrieval.tool == "read_session_source"));

    let source = search_session(
        &conn,
        &search_request("alpha source kept", SessionSearchMode::Exact),
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(source.results.len(), 1);
    assert_eq!(source.results[0].source_kind, SearchSourceKind::Event);
    assert_checkpoint_payload_unchanged(dir.path());
}

/// History §5.2: the derived projection re-checks that the embedded segment
/// source range agrees with the top-level compaction fields. The event-log
/// replayer validates `segment_hash`/`handoff_hash` and the source hash, but
/// it never cross-checks the segment's own `source` block against the
/// compaction header, so this is the projection's own guard. We mutate the
/// segment's source range and recompute `segment_hash` so replay accepts the
/// event and the mismatch only surfaces inside `summary_from_event`.
#[test]
fn summary_segment_source_mismatch_is_rejected_by_projection() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let (start, end) = closed_turn(
        &mut session,
        "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "alpha source kept",
        "assistant alpha",
    );
    append_history_compacted_with(
        &mut session,
        CompactionAppend {
            epoch: 1,
            reset_epoch: 0,
            turn_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            start_sequence: start,
            end_sequence: end,
            segment_text: "zephyrgoal <kept",
            handoff_text: "quollhandoff <kept",
            ids: CompactionIds {
                attempt: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
                compaction: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
                segment: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
                handoff: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
            },
            previous_handoff: None,
            handoff_start: start,
        },
        |compacted| {
            // Diverge the segment's own estimator id from the compaction
            // header, then re-seal `segment_hash` so the replayer still
            // accepts the event. Only the projection notices the mismatch.
            compacted.segment.source.source_estimator_id = "tampered-estimator".to_owned();
            let bytes = serialize_canonical_string(&compacted.segment).unwrap();
            compacted.segment_hash = Sha256Digest::digest_bytes(bytes.as_bytes());
        },
    );

    let err = session
        .try_project()
        .expect_err("a segment that disagrees with the compaction header must be rejected");
    assert_eq!(err.code(), "HISTORY_EVENT_INTEGRITY");
    assert_eq!(
        err.message(),
        "summary segment does not match the compaction event"
    );
    assert_eq!(summary_count(dir.path()), 0);
}

/// Defense in depth: a `segment_hash` that does not seal the segment bytes
/// never reaches the projection. The event log validates the compaction
/// against §8 replay on append, so the tampered event is refused at write
/// time and `summary_from_event` never sees it.
#[test]
#[should_panic(expected = "E_COMPACTION_SOURCE_HASH_MISMATCH")]
fn summary_segment_hash_tamper_is_rejected_before_projection() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let (start, end) = closed_turn(
        &mut session,
        "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "alpha source kept",
        "assistant alpha",
    );
    // The event log refuses to append a compaction whose `segment_hash` does
    // not seal the segment bytes; this call panics inside `append`.
    append_history_compacted_with(
        &mut session,
        CompactionAppend {
            epoch: 1,
            reset_epoch: 0,
            turn_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            start_sequence: start,
            end_sequence: end,
            segment_text: "zephyrgoal <kept",
            handoff_text: "quollhandoff <kept",
            ids: CompactionIds {
                attempt: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
                compaction: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
                segment: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
                handoff: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
            },
            previous_handoff: None,
            handoff_start: start,
        },
        |compacted| {
            // Flip the sealed hash without touching the segment bytes.
            compacted.segment_hash = Sha256Digest::from_bytes([9; 32]);
        },
    );
}

#[test]
fn summary_segments_stay_searchable_across_epochs_and_reset() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let (start1, end1) = closed_turn(
        &mut session,
        "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "alpha source kept",
        "assistant alpha",
    );
    let (start2, end2) = closed_turn(
        &mut session,
        "01ARZ3NDEKTSV4RRFFQ69G5FD1",
        "01ARZ3NDEKTSV4RRFFQ69G5FD2",
        "01ARZ3NDEKTSV4RRFFQ69G5FD3",
        "bravo source kept",
        "assistant bravo",
    );
    let first = append_history_compacted(
        &mut session,
        CompactionAppend {
            epoch: 1,
            reset_epoch: 0,
            turn_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            start_sequence: start1,
            end_sequence: end1,
            segment_text: "zephyrgoal <kept",
            handoff_text: "quollhandoff <kept",
            ids: CompactionIds {
                attempt: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
                compaction: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
                segment: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
                handoff: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
            },
            previous_handoff: None,
            handoff_start: start1,
        },
    );
    let second = append_history_compacted(
        &mut session,
        CompactionAppend {
            epoch: 2,
            reset_epoch: 0,
            turn_id: "01ARZ3NDEKTSV4RRFFQ69G5FD1",
            start_sequence: start2,
            end_sequence: end2,
            segment_text: "epoch2segment <kept",
            handoff_text: "epoch2handoff <kept",
            ids: CompactionIds {
                attempt: "01ARZ3NDEKTSV4RRFFQ69G5FC5",
                compaction: "01ARZ3NDEKTSV4RRFFQ69G5FC6",
                segment: "01ARZ3NDEKTSV4RRFFQ69G5FC7",
                handoff: "01ARZ3NDEKTSV4RRFFQ69G5FC8",
            },
            previous_handoff: Some(
                HandoffId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FC4").unwrap(),
            ),
            handoff_start: start1,
        },
    );
    session.project();
    assert_eq!(summary_count(dir.path()), 2);
    let epoch1 = summary_hit(&session, "zephyrgoal", SessionSearchMode::Exact);
    assert_eq!(epoch1.summary_segment_id.as_ref(), Some(&first.segment_id));
    let epoch2 = summary_hit(&session, "epoch2segment", SessionSearchMode::Fts);
    assert_eq!(epoch2.summary_segment_id.as_ref(), Some(&second.segment_id));
    let conn = session.search_conn();
    let second_start: i64 = conn
        .query_row(
            "SELECT source_start_sequence FROM summary_segments WHERE segment_id = ?1",
            [second.segment_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(second_start, start2 as i64);

    session.reset();
    session.project();
    let hidden = search_session(
        &session.search_conn(),
        &search_request("zephyrgoal", SessionSearchMode::Exact),
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert!(hidden.results.is_empty());
    let mut prior = search_request("zephyrgoal", SessionSearchMode::Exact);
    prior.filters.include_prior_epochs = true;
    let found = search_session(
        &session.search_conn(),
        &prior,
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(found.results.len(), 1);
    assert_eq!(
        found.results[0].source_kind,
        SearchSourceKind::SummarySegment
    );
    let mut source = search_request("alpha source kept", SessionSearchMode::Exact);
    source.filters.include_prior_epochs = true;
    let source_page = search_session(
        &session.search_conn(),
        &source,
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(source_page.results.len(), 1);
    assert_eq!(source_page.results[0].source_kind, SearchSourceKind::Event);
    let mut later = search_request("epoch2handoff", SessionSearchMode::Fts);
    later.filters.include_prior_epochs = true;
    let later_page = search_session(
        &session.search_conn(),
        &later,
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(later_page.results.len(), 1);
}

#[test]
fn summary_segment_stale_checkpoint_inserts_the_row() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let (start, end) = closed_turn(
        &mut session,
        "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "alpha source kept",
        "assistant alpha",
    );
    session.project();
    let before = checkpoint_sequence(dir.path());
    {
        let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
        conn.execute(
            "INSERT INTO telemetry_counters(key, value, updated_at_ms) VALUES('p54-sentinel', 1, 1)",
            [],
        )
        .unwrap();
    }
    let appended = append_history_compacted(
        &mut session,
        CompactionAppend {
            epoch: 1,
            reset_epoch: 0,
            turn_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            start_sequence: start,
            end_sequence: end,
            segment_text: "zephyrgoal <kept",
            handoff_text: "quollhandoff <kept",
            ids: CompactionIds {
                attempt: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
                compaction: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
                segment: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
                handoff: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
            },
            previous_handoff: None,
            handoff_start: start,
        },
    );
    assert_eq!(summary_count(dir.path()), 0);
    assert_eq!(checkpoint_sequence(dir.path()), before);
    let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
    conn.execute_batch(&format!("CREATE TRIGGER reject_prefix_reprojection BEFORE INSERT ON search_documents WHEN NEW.event_sequence <= {before} BEGIN SELECT RAISE(ABORT, 'prefix reprojected'); END;")).unwrap();
    HistoryProjector::new(&session.db)
        .project_without_rebuild(&session.log)
        .unwrap();
    assert_eq!(summary_count(dir.path()), 1);
    assert!(checkpoint_sequence(dir.path()) > before);
    assert_checkpoint_payload_unchanged(dir.path());
    let sentinel: i64 = rusqlite::Connection::open(dir.path().join("history.db"))
        .unwrap()
        .query_row(
            "SELECT value FROM telemetry_counters WHERE key = 'p54-sentinel'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(sentinel, 1, "a stale checkpoint replays in place");
    HistoryProjector::new(&session.db)
        .project_without_rebuild(&session.log)
        .unwrap();
    assert_eq!(summary_count(dir.path()), 1);
    let hit = summary_hit(&session, "zephyrgoal", SessionSearchMode::Exact);
    assert_eq!(hit.summary_segment_id.as_ref(), Some(&appended.segment_id));
    assert_eq!(hit.retrieval.tool, "read_session_source");
}

#[test]
fn summary_rebuild_replays_equivalent_summary_search() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let (start, end) = closed_turn(
        &mut session,
        "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "alpha source kept",
        "assistant alpha",
    );
    append_history_compacted(
        &mut session,
        CompactionAppend {
            epoch: 1,
            reset_epoch: 0,
            turn_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            start_sequence: start,
            end_sequence: end,
            segment_text: "zephyrgoal <kept",
            handoff_text: "quollhandoff <kept",
            ids: CompactionIds {
                attempt: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
                compaction: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
                segment: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
                handoff: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
            },
            previous_handoff: None,
            handoff_start: start,
        },
    );
    session.project();
    let before = summary_hit(&session, "zephyrgoal", SessionSearchMode::Exact);
    let before_fts = summary_hit(&session, "quollhandoff", SessionSearchMode::Fts);
    HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap();
    let conn = session.search_conn();
    let after = search_session(
        &conn,
        &{
            let mut request = search_request("zephyrgoal", SessionSearchMode::Exact);
            request.filters.source_kinds = vec![SearchSourceKind::SummarySegment];
            request
        },
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    let after_fts = search_session(
        &conn,
        &{
            let mut request = search_request("quollhandoff", SessionSearchMode::Fts);
            request.filters.source_kinds = vec![SearchSourceKind::SummarySegment];
            request
        },
        &session.hmac_key(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(after.results.len(), 1);
    assert_eq!(after.results[0].result_id, before.result_id);
    assert_eq!(after.results[0].retrieval.tool, "read_session_source");
    assert_eq!(after_fts.results[0].result_id, before_fts.result_id);
    assert_eq!(summary_count(dir.path()), 1);
    assert_checkpoint_payload_unchanged(dir.path());
}

#[cfg(all(feature = "failpoints", unix))]
#[test]
fn summary_failpoint_skips_projection_without_compaction() {
    let dir = tempfile::tempdir().unwrap();
    let session = TestSession::new(dir.path());
    drop(session);

    let output = spawn_crash_child(
        dir.path(),
        "history.after_summary_insert_before_checkpoint",
        "project_without_summary",
    );
    assert!(
        output.status.success(),
        "projection without a summary must not hit the compaction failpoint: {output:?}"
    );
    assert_eq!(summary_count(dir.path()), 0);
}

#[cfg(all(feature = "failpoints", unix))]
#[test]
fn summary_segment_crash_before_checkpoint_replays() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = TestSession::new(dir.path());
    let (start, end) = closed_turn(
        &mut session,
        "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "alpha source kept",
        "assistant alpha",
    );
    session.project();
    let before = checkpoint_sequence(dir.path());
    append_history_compacted(
        &mut session,
        CompactionAppend {
            epoch: 1,
            reset_epoch: 0,
            turn_id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
            start_sequence: start,
            end_sequence: end,
            segment_text: "zephyrgoal <kept",
            handoff_text: "quollhandoff <kept",
            ids: CompactionIds {
                attempt: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
                compaction: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
                segment: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
                handoff: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
            },
            previous_handoff: None,
            handoff_start: start,
        },
    );
    drop(session);

    let output = spawn_crash_child(
        dir.path(),
        "history.after_summary_insert_before_checkpoint",
        "project",
    );
    assert_abort(&output, "history.after_summary_insert_before_checkpoint");
    assert_eq!(summary_count(dir.path()), 0);
    assert_eq!(checkpoint_sequence(dir.path()), before);

    let log = EventLogStore::open(dir.path(), SESSION_ID).unwrap();
    let db = HistoryDatabase::open(&dir.path().join("history.db")).unwrap();
    HistoryProjector::new(&db).project(&log).unwrap();
    assert_eq!(summary_count(dir.path()), 1);
    assert!(checkpoint_sequence(dir.path()) > before);
    assert_checkpoint_payload_unchanged(dir.path());
    HistoryProjector::new(&db).project(&log).unwrap();
    assert_eq!(summary_count(dir.path()), 1);
    let key = {
        let text = fs::read_to_string(dir.path().join("meta.json")).unwrap();
        let meta: Value = serde_json::from_str(text.trim_end_matches('\n')).unwrap();
        decode_base64(meta["cursor_hmac_key_base64"].as_str().unwrap())
            .try_into()
            .unwrap()
    };
    let conn = rusqlite::Connection::open(dir.path().join("history.db")).unwrap();
    let mut request = search_request("zephyrgoal", SessionSearchMode::Exact);
    request.filters.source_kinds = vec![SearchSourceKind::SummarySegment];
    let page = search_session(&conn, &request, &key, &CancellationToken::new()).unwrap();
    assert_eq!(page.results.len(), 1);
    assert_eq!(page.results[0].retrieval.tool, "read_session_source");
    let response = read_session_source(
        &conn,
        &ReadSessionSourceRequest {
            result_id: page.results[0].result_id,
            byte_offset: 0,
        },
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(
        response.source_kind,
        praana_core::history::retrieve::SearchSourceKind::SummarySegment
    );
    assert!(response.text.contains("zephyrgoal <kept"));
}

// History §9.4 rebuild fence (issue #669).

fn history_db_path(dir: &Path) -> PathBuf {
    dir.join("history.db")
}

fn open_production_conn(path: &Path) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA wal_autocheckpoint = 1000;
         PRAGMA journal_size_limit = 67108864;
         PRAGMA temp_store = MEMORY;
         PRAGMA trusted_schema = OFF;
         PRAGMA recursive_triggers = OFF;",
    )
    .unwrap();
    conn
}

fn sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut name = db_path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    db_path.with_file_name(name)
}

fn find_bad_main(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .find_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix("history.db.bad-")?;
            if rest.is_empty() || rest.ends_with("-wal") || rest.ends_with("-shm") {
                return None;
            }
            Some(entry.path())
        })
}

fn fence_trigger_count(path: &Path) -> i64 {
    if !path.is_file() {
        return 0;
    }
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'praana_fence_%'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn table_count(path: &Path, table: &str) -> i64 {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn named_checkpoint_count(path: &Path, name: &str) -> i64 {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM projection_checkpoints WHERE projection_name = ?1",
        [name],
        |row| row.get(0),
    )
    .unwrap()
}

fn force_invalid_derived_checkpoint(dir: &Path) {
    let conn = rusqlite::Connection::open(history_db_path(dir)).unwrap();
    let payload: String = conn
        .query_row(
            "SELECT payload_json FROM projection_checkpoints WHERE projection_name = 'history_derived'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut value: Value = serde_json::from_str(&payload).unwrap();
    value["search_schema_version"] = json!(99);
    conn.execute(
        "UPDATE projection_checkpoints SET payload_json = ?1 WHERE projection_name = 'history_derived'",
        [serde_json::to_string(&value).unwrap()],
    )
    .unwrap();
}

fn fixed_history() -> praana_core::history::operation_ledger::HistoryService {
    use praana_core::history::operation_ledger::{HistoryService, NullRecoveryProbe};
    HistoryService {
        session_ledger: None,
        host_ledger: None,
        session_id: Some(session_id()),
        probe: Arc::new(NullRecoveryProbe),
        now_ms: Arc::new(|| 1_700_000_000_000),
    }
}

fn terminal_probe_result() -> praana_core::ui_contract::operation::StoredTerminalResult {
    use praana_core::ui_contract::operation::StoredTerminalResult;
    use praana_core::ui_contract::result::{
        CoreErrorCode, CoreErrorDto, ErrorDetailsDto, ErrorRetryAdvice,
    };
    StoredTerminalResult::Error(CoreErrorDto {
        code: CoreErrorCode::DurabilityFailed,
        message: "fence probe".to_string(),
        retry: ErrorRetryAdvice::SameOperation,
        details: ErrorDetailsDto::None,
    })
}

fn domain_code(err: &praana_core::ui_contract::result::CoreErrorDto) -> String {
    use praana_core::ui_contract::result::ErrorDetailsDto;
    match &err.details {
        ErrorDetailsDto::Domain { code, .. } => code.clone(),
        other => format!("non-domain:{other:?}"),
    }
}

#[cfg(feature = "failpoints")]
fn ensure_wal_sidecars(path: &Path) {
    let conn = open_production_conn(path);
    conn.execute(
        "INSERT INTO schema_meta(key, value) VALUES ('wal_probe', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )
    .unwrap();
    drop(conn);
    assert!(
        sidecar_path(path, "-wal").is_file() || sidecar_path(path, "-shm").is_file(),
        "a committed write did not create WAL sidecars"
    );
}

#[cfg(feature = "failpoints")]
fn insert_reserved_probe(
    conn: &rusqlite::Connection,
    operation_id: &str,
) -> rusqlite::Result<usize> {
    let zeros = "0".repeat(64);
    conn.execute(
        "INSERT INTO operation_records(operation_id, ui_contract_schema_version, operation_kind, request_sha256, status, session_id, planned_effects_json, result_json, result_sha256, first_canonical_sequence, terminal_canonical_sequence, created_at_ms, finished_at_ms)
         VALUES (?1, 1, 'turn_submit', ?2, 'reserved', ?3, '{}', NULL, NULL, NULL, NULL, 1700000000000, NULL)",
        rusqlite::params![operation_id, zeros, SESSION_ID],
    )
}

#[cfg(feature = "failpoints")]
fn poll_until(bound: Duration, mut pred: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    loop {
        if pred() {
            return true;
        }
        if start.elapsed() >= bound {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(feature = "failpoints")]
static REBUILD_WRITER_CONTENDED: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "failpoints")]
fn rebuild_writer_busy(count: i32) -> bool {
    REBUILD_WRITER_CONTENDED.store(true, Ordering::SeqCst);
    if count >= 2000 {
        return false;
    }
    thread::sleep(Duration::from_millis(5));
    true
}

#[cfg(feature = "failpoints")]
fn rebuild_writer_no_retry(_count: i32) -> bool {
    false
}

#[test]
fn fence_t1_stale_ledger_writes_are_rejected_and_ledger_stays_usable() {
    use praana_core::history::operation_ledger::{open_session_ledger, reserve_operation_sync};
    use praana_core::ui_contract::ids::OperationId;
    use praana_core::ui_contract::operation::OperationStatus;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["hello world"], &["the answer"]);
    let history = fixed_history();
    let reserved_id = OperationId(ulid::Ulid::generate());
    let reserved_command = turn_submit_command(reserved_id);
    let ledger = open_session_ledger(&history_db_path(dir.path()), session_id()).unwrap();
    reserve_operation_sync(&ledger, &reserved_command, &history).unwrap();
    let before = dump_operation_records(&history_db_path(dir.path()));
    force_invalid_derived_checkpoint(dir.path());
    HistoryProjector::new(&session.db)
        .project(&session.log)
        .unwrap();

    let fresh_id = OperationId(ulid::Ulid::generate());
    let fresh_command = turn_submit_command(fresh_id);
    let mut reserve_markers = Vec::new();
    for _ in 0..3 {
        let err = reserve_operation_sync(&ledger, &fresh_command, &history).unwrap_err();
        let code = domain_code(&err);
        assert!(
            code.contains("HISTORY_FILE_REPLACED"),
            "reserve marker missing: {code}"
        );
        reserve_markers.push(code);
    }
    assert_eq!(reserve_markers[0], reserve_markers[1]);
    assert_eq!(reserve_markers[1], reserve_markers[2]);

    let mut complete_markers = Vec::new();
    for _ in 0..3 {
        let err = ledger
            .complete_terminal(
                &reserved_id,
                &terminal_probe_result(),
                None,
                None,
                1_700_000_000_000,
            )
            .unwrap_err();
        let praana_core::history::operation_ledger::LedgerError::Storage(text) = err else {
            panic!("expected storage error, got {err:?}");
        };
        assert!(
            text.contains("HISTORY_FILE_REPLACED"),
            "complete marker missing: {text}"
        );
        complete_markers.push(text);
    }
    assert_eq!(complete_markers[0], complete_markers[1]);
    assert_eq!(complete_markers[1], complete_markers[2]);

    let stored = ledger.lookup(&reserved_id).unwrap().unwrap();
    assert!(matches!(stored.dto.status, OperationStatus::Reserved));
    let bad = find_bad_main(dir.path()).expect("renamed-aside database");
    assert_eq!(dump_operation_records(&bad), before);
    let live_ledger = open_session_ledger(&history_db_path(dir.path()), session_id()).unwrap();
    assert_eq!(dump_operation_records(&history_db_path(dir.path())), before);
    assert!(matches!(
        live_ledger
            .lookup(&reserved_id)
            .unwrap()
            .unwrap()
            .dto
            .status,
        OperationStatus::Reserved
    ));
    let _ = fresh_id;
}

#[test]
fn fence_t2_stale_owner_handles_cannot_write() {
    use praana_core::history::artifact::{ArtifactPolicy, ArtifactStore};
    use praana_core::state::{StateService, StateWriteContext};

    let dir = tempfile::tempdir().unwrap();
    let mut session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let db_path = history_db_path(dir.path());
    let stale_db = HistoryDatabase::open(&db_path).unwrap();
    let stale_artifacts = ArtifactStore::open(
        &db_path,
        ArtifactPolicy {
            inline_tokens: 0,
            batch_inline_tokens: 0,
            preview_tokens: 160,
            orphan_retention_days: 7,
        },
        session.clock.clone(),
    )
    .unwrap();
    // create_task requires an assistant tool-call source, and that turn has to
    // be closed before another turn starts. Finish the batch, then open the
    // service so its graph matches the log head.
    let source_turn = ulid("C0");
    let source_attempt = ulid("C1");
    let source_step = ulid("C2");
    let source_batch = ulid("C3");
    let source_user = session.user_message(&source_turn, &["task source"]);
    session.turn_started(&source_turn, &source_user);
    session.assistant_step(
        &source_turn,
        &source_attempt,
        &source_step,
        None,
        None,
        None,
        &[("create_task", json!({"title": "fence"}))],
    );
    let (finish_id, _) = session.tool_execution(
        &source_turn,
        &source_attempt,
        &source_step,
        &source_batch,
        "call_001",
        0,
        "create_task",
        ToolBody::Inline("ok"),
    );
    session.batch_completed(
        &source_turn,
        &source_attempt,
        &source_step,
        &source_batch,
        &["call_001"],
        &[finish_id],
    );
    let close_attempt = ulid("C4");
    let close_step = ulid("C5");
    session.assistant_step(
        &source_turn,
        &close_attempt,
        &close_step,
        Some("done"),
        None,
        None,
        &[],
    );
    session.turn_committed(&source_turn, &source_user, &close_step);
    let mut stale_state = StateService::open(&session.log).unwrap();
    let clock = praana_core::clock::SystemClock;
    let ids = praana_core::id::MonotonicUlidGenerator::system();
    let mut ctx = StateWriteContext {
        log: &mut session.log,
        ids: &ids,
        clock: &clock,
        turn_id: TurnId::from_str_canonical(&source_turn).unwrap(),
        attempt_id: AttemptId::from_str_canonical(&source_attempt).unwrap(),
        call_id: ToolCallId::from_str_canonical("call_001").unwrap(),
        cancelled: false,
        active_max_tokens: 4096,
    };
    stale_state
        .create_task(&mut ctx, "fence", None)
        .expect("create_task before the rebuild");
    assert!(stale_state.checkpoint_due());
    drop(ctx);
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "DELETE FROM projection_checkpoints WHERE projection_name = 'state_graph'",
            [],
        )
        .unwrap();
    }

    HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap();
    let bad = find_bad_main(dir.path()).expect("renamed-aside database");
    let state_live = named_checkpoint_count(&db_path, "state_graph");
    let state_bad = named_checkpoint_count(&bad, "state_graph");
    stale_state.persist_checkpoint(&session.log);
    assert!(
        stale_state.checkpoint_due(),
        "stale state checkpoint write cleared checkpoint_due"
    );
    assert_eq!(named_checkpoint_count(&db_path, "state_graph"), state_live);
    assert_eq!(named_checkpoint_count(&bad, "state_graph"), state_bad);

    let docs_live = table_count(&db_path, "search_documents");
    let docs_bad = table_count(&bad, "search_documents");
    let turn_id = ulid("D0");
    let attempt_id = ulid("D1");
    let step_id = ulid("D2");
    let user_message_id = session.user_message(&turn_id, &["after rebuild"]);
    session.turn_started(&turn_id, &user_message_id);
    session.assistant_step(
        &turn_id,
        &attempt_id,
        &step_id,
        Some("later"),
        None,
        None,
        &[],
    );
    session.turn_committed(&turn_id, &user_message_id, &step_id);
    let projected = HistoryProjector::new(&stale_db).project_without_rebuild(&session.log);
    assert!(
        projected.is_err(),
        "stale history projection write succeeded"
    );
    assert_eq!(table_count(&db_path, "search_documents"), docs_live);
    assert_eq!(table_count(&bad, "search_documents"), docs_bad);

    let samples_live = table_count(&db_path, "telemetry_samples");
    let samples_bad = table_count(&bad, "telemetry_samples");
    let artifact_write = stale_artifacts.record_telemetry_sample("fence-probe", None, 1, "{}", 1);
    assert!(artifact_write.is_err(), "stale artifact write succeeded");
    assert_eq!(table_count(&db_path, "telemetry_samples"), samples_live);
    assert_eq!(table_count(&bad, "telemetry_samples"), samples_bad);

    let fresh_artifacts = ArtifactStore::open(
        &db_path,
        ArtifactPolicy {
            inline_tokens: 0,
            batch_inline_tokens: 0,
            preview_tokens: 160,
            orphan_retention_days: 7,
        },
        session.clock.clone(),
    )
    .unwrap();
    fresh_artifacts
        .record_telemetry_sample("fence-probe", None, 1, "{}", 1)
        .unwrap();
    assert_eq!(table_count(&db_path, "telemetry_samples"), samples_live + 1);
    assert_eq!(table_count(&bad, "telemetry_samples"), samples_bad);
    HistoryProjector::new(&session.db)
        .project_without_rebuild(&session.log)
        .unwrap();
    assert!(table_count(&db_path, "search_documents") > docs_live);
    assert_eq!(table_count(&bad, "search_documents"), docs_bad);
}

#[test]
fn fence_t3_tombstone_covers_every_table() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let db_path = history_db_path(dir.path());
    let stale = open_production_conn(&db_path);
    HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap();
    let bad = find_bad_main(dir.path()).expect("renamed-aside database");
    let bad_conn = rusqlite::Connection::open(&bad).unwrap();
    let mut tables = bad_conn
        .prepare(
            "SELECT name, sql FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .unwrap();
    let table_rows = tables
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(tables);
    let mut fenced = Vec::new();
    for (name, sql) in table_rows {
        let virtual_table = sql.as_deref().is_some_and(|sql| {
            sql.trim_start()
                .to_ascii_uppercase()
                .starts_with("CREATE VIRTUAL")
        });
        if virtual_table {
            continue;
        }
        fenced.push(name);
    }
    assert!(!fenced.is_empty());
    for name in &fenced {
        for event in ["insert", "update", "delete"] {
            let trigger = format!("praana_fence_{name}_{event}");
            let body: String = bad_conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
                    [&trigger],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| panic!("missing trigger {trigger}"));
            assert!(
                body.contains("HISTORY_FILE_REPLACED"),
                "{trigger} body: {body}"
            );
        }
    }
    let trigger_count = fence_trigger_count(&bad);
    assert_eq!(trigger_count, fenced.len() as i64 * 3);
    assert_eq!(fence_trigger_count(&db_path), 0);

    let meta_bad = table_count(&bad, "schema_meta");
    let meta_live = table_count(&db_path, "schema_meta");
    let docs_bad = table_count(&bad, "search_documents");
    let docs_live = table_count(&db_path, "search_documents");
    let ordinary = stale.execute(
        "INSERT INTO schema_meta(key, value) VALUES ('fence_probe_t3', '1')",
        [],
    );
    assert!(ordinary.is_err(), "stale ordinary write succeeded");
    assert!(
        ordinary
            .unwrap_err()
            .to_string()
            .contains("HISTORY_FILE_REPLACED"),
        "ordinary stale write did not raise the fence"
    );
    let fts = stale.execute("INSERT INTO search_fts(search_fts) VALUES('rebuild')", []);
    assert!(fts.is_err(), "stale search_fts rebuild command succeeded");
    let fts_text = fts.unwrap_err().to_string();
    assert!(
        fts_text.to_lowercase().contains("constraint failed"),
        "search_fts fence error: {fts_text}"
    );
    assert_eq!(table_count(&bad, "schema_meta"), meta_bad);
    assert_eq!(table_count(&db_path, "schema_meta"), meta_live);
    assert_eq!(table_count(&bad, "search_documents"), docs_bad);
    assert_eq!(table_count(&db_path, "search_documents"), docs_live);
}

#[cfg(feature = "failpoints")]
fn run_rebuild_window(label: &str, writer_commits_first: bool) {
    use praana_core::{register_rebuild_hook, RebuildHookKind};

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    drop(session);
    let db_path = history_db_path(dir.path());
    let operation_id = ulid::Ulid::generate().to_string();
    let writer = open_production_conn(&db_path);
    writer.busy_handler(Some(rebuild_writer_busy)).unwrap();
    let hook = register_rebuild_hook(&db_path, &[(label, RebuildHookKind::Pause)]);
    REBUILD_WRITER_CONTENDED.store(false, Ordering::SeqCst);
    let dir_buf = dir.path().to_path_buf();
    let rebuild_path = db_path.clone();
    let rebuild = thread::spawn(move || {
        let log = EventLogStore::open(&dir_buf, SESSION_ID).expect("open log");
        let db = HistoryDatabase::open(&rebuild_path).expect("open db");
        HistoryProjector::new(&db).rebuild(&log)
    });
    assert!(
        hook.wait_paused(label, Duration::from_secs(5)),
        "{label}: rebuild did not pause"
    );
    let finished = Arc::new(AtomicBool::new(false));
    let outcome = Arc::new(std::sync::Mutex::new(None));
    let finished_flag = Arc::clone(&finished);
    let outcome_slot = Arc::clone(&outcome);
    let writer_id = operation_id.clone();
    let writer_thread = thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            writer
                .execute_batch("BEGIN IMMEDIATE;")
                .map_err(|err| err.to_string())?;
            insert_reserved_probe(&writer, &writer_id).map_err(|err| err.to_string())?;
            writer
                .execute_batch("COMMIT;")
                .map_err(|err| err.to_string())?;
            Ok(())
        })();
        *outcome_slot.lock().unwrap() = Some(result);
        finished_flag.store(true, Ordering::SeqCst);
    });
    if writer_commits_first {
        assert!(
            poll_until(Duration::from_secs(5), || finished.load(Ordering::SeqCst)),
            "{label}: writer did not finish before the lock"
        );
        assert!(
            !REBUILD_WRITER_CONTENDED.load(Ordering::SeqCst),
            "{label}: writer contended before the rebuild took the lock"
        );
    } else {
        assert!(
            poll_until(Duration::from_secs(5), || {
                REBUILD_WRITER_CONTENDED.load(Ordering::SeqCst)
            }),
            "{label}: writer was not seen contending for the write lock"
        );
        assert!(
            !finished.load(Ordering::SeqCst),
            "{label}: writer finished while the rebuild held the lock"
        );
    }
    hook.resume();
    let rebuild_result = rebuild.join().expect("rebuild thread");
    rebuild_result.expect("rebuild");
    writer_thread.join().expect("writer thread");
    let writer_result = outcome.lock().unwrap().clone().expect("writer result");
    let bad = find_bad_main(dir.path());
    let in_live = dump_operation_records(&db_path)
        .into_iter()
        .any(|(id, _)| id == operation_id);
    let in_bad = bad
        .as_ref()
        .map(|path| {
            dump_operation_records(path)
                .into_iter()
                .any(|(id, _)| id == operation_id)
        })
        .unwrap_or(false);
    if writer_commits_first {
        writer_result.expect("writer commit");
        assert!(in_live, "{label}: committed row missing from the live file");
    } else {
        let err = writer_result.expect_err("writer should fail");
        assert!(
            err.contains("HISTORY_FILE_REPLACED"),
            "{label}: writer error: {err}"
        );
        assert!(!in_live, "{label}: rejected row is in the live file");
        assert!(
            !in_bad,
            "{label}: rejected row is in the renamed-aside file"
        );
    }
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t4_writer_before_lock_is_in_the_snapshot() {
    run_rebuild_window("history.rebuild_before_begin", true);
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t4_writer_after_begin_is_rejected() {
    run_rebuild_window("history.rebuild_after_begin", false);
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t4_writer_after_copy_is_rejected() {
    run_rebuild_window("history.rebuild_after_copy", false);
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t4_writer_after_rename_is_rejected() {
    run_rebuild_window("history.rebuild_after_rename", false);
}

fn mix_seed(mut state: u64) -> u64 {
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    state
}

#[test]
fn fence_t5_seeded_writer_stress() {
    use praana_core::history::operation_ledger::{open_session_ledger, reserve_operation_sync};
    use praana_core::ui_contract::ids::OperationId;

    const SEEDS: u64 = 8;
    let mut failed = Vec::new();
    for seed in 0..SEEDS {
        if let Err(message) = fence_stress_seed(seed) {
            eprintln!("fence stress seed {seed} failed: {message}");
            failed.push((seed, message));
        }
    }
    assert!(failed.is_empty(), "fence stress failed seeds: {failed:?}");

    fn fence_stress_seed(seed: u64) -> Result<(), String> {
        let dir = tempfile::tempdir().unwrap();
        let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
        let history = fixed_history();
        let seeded = OperationId(ulid::Ulid::generate());
        let ledger = Arc::new(
            open_session_ledger(&history_db_path(dir.path()), session_id())
                .map_err(|err| err.to_string())?,
        );
        reserve_operation_sync(&ledger, &turn_submit_command(seeded), &history)
            .map_err(|err| format!("seed reserve: {}", domain_code(&err)))?;
        let before = dump_operation_records(&history_db_path(dir.path()));
        let mut state = seed.wrapping_add(0x9E37);
        state = mix_seed(state);
        let writers = 2 + (state % 3) as usize;
        state = mix_seed(state);
        let spins = (state % 8) as usize;
        let stop = Arc::new(AtomicBool::new(false));
        let records = Arc::new(std::sync::Mutex::new(
            Vec::<(String, Result<(), String>)>::new(),
        ));
        thread::scope(|scope| {
            for _ in 0..writers {
                let ledger = Arc::clone(&ledger);
                let history = &history;
                let stop = Arc::clone(&stop);
                let records = Arc::clone(&records);
                scope.spawn(move || {
                    let mut made = 0usize;
                    while !stop.load(Ordering::SeqCst) && made < 20 {
                        made += 1;
                        let id = OperationId(ulid::Ulid::generate());
                        let command = turn_submit_command(id);
                        let outcome = match reserve_operation_sync(&ledger, &command, history) {
                            Ok(_) => Ok(()),
                            Err(err) => Err(domain_code(&err)),
                        };
                        records.lock().unwrap().push((id.to_string(), outcome));
                    }
                });
            }
            for _ in 0..spins {
                thread::yield_now();
            }
            HistoryProjector::new(&session.db)
                .rebuild(&session.log)
                .map_err(|err| err.to_string())
                .expect("rebuild");
            stop.store(true, Ordering::SeqCst);
        });
        let records = records.lock().unwrap().clone();
        let live_path = history_db_path(dir.path());
        let live = dump_operation_records(&live_path);
        let live_ids: HashSet<String> = live.iter().map(|(id, _)| id.clone()).collect();
        let before_ids: HashSet<String> = before.iter().map(|(id, _)| id.clone()).collect();
        let mut ok_ids = HashSet::new();
        for (id, outcome) in &records {
            match outcome {
                Ok(()) => {
                    if !live_ids.contains(id) {
                        return Err(format!(
                            "seed {seed}: ok id {id} missing from the live file"
                        ));
                    }
                    ok_ids.insert(id.clone());
                }
                Err(text) => {
                    if !text.contains("HISTORY_FILE_REPLACED")
                        && !text.contains("database is locked")
                    {
                        return Err(format!(
                            "seed {seed}: unexpected reserve error for {id}: {text}"
                        ));
                    }
                }
            }
        }
        let bad = find_bad_main(dir.path()).ok_or_else(|| format!("seed {seed}: no aside file"))?;
        let bad_ids: HashSet<String> = dump_operation_records(&bad)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        for id in &bad_ids {
            if !live_ids.contains(id) {
                return Err(format!(
                    "seed {seed}: id {id} is in the aside file and not in the live file"
                ));
            }
        }
        let mut expect = before_ids;
        expect.extend(ok_ids);
        if live_ids != expect {
            return Err(format!(
                "seed {seed}: live ids {live_ids:?} != pre-rebuild plus ok ids {expect:?}"
            ));
        }
        for (id, columns) in &before {
            let found = live.iter().find(|(live_id, _)| live_id == id);
            if found.map(|(_, live_columns)| live_columns) != Some(columns) {
                return Err(format!("seed {seed}: pre-rebuild row {id} changed"));
            }
        }
        let conn = rusqlite::Connection::open(&live_path).unwrap();
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        if integrity != "ok" {
            return Err(format!("seed {seed}: integrity_check {integrity}"));
        }
        Ok(())
    }
}

#[test]
fn fence_t6_failure_before_swap_leaves_original_usable() {
    use praana_core::history::operation_ledger::{open_session_ledger, reserve_operation_sync};
    use praana_core::ui_contract::ids::OperationId;
    use praana_core::ui_contract::operation::OperationStatus;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let history = fixed_history();
    let operation_id = OperationId(ulid::Ulid::generate());
    let ledger = open_session_ledger(&history_db_path(dir.path()), session_id()).unwrap();
    reserve_operation_sync(&ledger, &turn_submit_command(operation_id), &history).unwrap();
    drop(ledger);
    {
        let writer = rusqlite::Connection::open(history_db_path(dir.path())).unwrap();
        writer
            .execute(
                "INSERT INTO artifact_blobs(blob_id, sha256, canonical_result, byte_count, line_count, estimated_tokens, token_estimator_schema_version, token_estimator_id, token_input_sha256, result_encoding, redaction_version, redaction_json, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, NULL, 1, 1, 'test-estimator', ?5, 'rfc8785-json', 'v1', '{}', 1700000000000)",
                rusqlite::params![
                    ulid("B9"),
                    "f".repeat(64),
                    b"corrupt orphan body",
                    17i64,
                    "0".repeat(64),
                ],
            )
            .unwrap();
    }
    let error = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert_eq!(error.code(), "HISTORY_CANONICAL_DB_CORRUPT");
    assert_eq!(fence_trigger_count(&history_db_path(dir.path())), 0);
    let ledger = open_session_ledger(&history_db_path(dir.path()), session_id()).unwrap();
    let fresh = OperationId(ulid::Ulid::generate());
    reserve_operation_sync(&ledger, &turn_submit_command(fresh), &history).unwrap();
    assert!(matches!(
        ledger.lookup(&operation_id).unwrap().unwrap().dto.status,
        OperationStatus::Reserved
    ));
}

#[test]
fn fence_t7_closing_old_connection_keeps_live_sidecars() {
    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let db_path = history_db_path(dir.path());
    let before = dump_operation_records(&db_path);
    let stale = open_production_conn(&db_path);
    HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap();
    let version: String = {
        let probe = rusqlite::Connection::open(&db_path).unwrap();
        let version: String = probe
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .unwrap();
        println!("sqlite_version={version}");
        version
    };
    assert!(!version.is_empty(), "sqlite_version={version}");
    let live = open_production_conn(&db_path);
    live.execute_batch("BEGIN IMMEDIATE;").unwrap();
    live.execute(
        "INSERT INTO telemetry_samples(name, event_sequence, value_integer, dimensions_json, occurred_at_ms)
         VALUES ('t7-unflushed', NULL, 1, '{}', 1)",
        [],
    )
    .unwrap();
    assert!(sidecar_path(&db_path, "-wal").is_file());
    assert!(sidecar_path(&db_path, "-shm").is_file());
    drop(stale);
    assert!(
        sidecar_path(&db_path, "-wal").is_file(),
        "closing the pre-rebuild connection removed history.db-wal"
    );
    assert!(
        sidecar_path(&db_path, "-shm").is_file(),
        "closing the pre-rebuild connection removed history.db-shm"
    );
    let third = rusqlite::Connection::open(&db_path).unwrap();
    assert_eq!(dump_operation_records(&db_path), before);
    let visible: i64 = third
        .query_row(
            "SELECT COUNT(*) FROM telemetry_samples WHERE name = 't7-unflushed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        visible, 0,
        "uncommitted insert was visible to a new connection"
    );
    live.execute_batch("COMMIT;").unwrap();
    let visible: i64 = third
        .query_row(
            "SELECT COUNT(*) FROM telemetry_samples WHERE name = 't7-unflushed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        visible, 1,
        "committed row was lost after the old connection closed"
    );
    assert!(sidecar_path(&db_path, "-wal").is_file());
    assert!(sidecar_path(&db_path, "-shm").is_file());
}

#[cfg(all(feature = "failpoints", unix))]
fn crash_fenced_rebuild(point: &str) {
    use praana_core::history::operation_ledger::{open_session_ledger, reserve_operation_sync};
    use praana_core::ui_contract::ids::OperationId;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let history = fixed_history();
    let operation_id = OperationId(ulid::Ulid::generate());
    let ledger = open_session_ledger(&history_db_path(dir.path()), session_id()).unwrap();
    reserve_operation_sync(&ledger, &turn_submit_command(operation_id), &history).unwrap();
    drop(ledger);
    let before = dump_operation_records(&history_db_path(dir.path()));
    drop(session);
    let output = spawn_crash_child(dir.path(), point, "rebuild");
    assert_abort(&output, point);
    let log = EventLogStore::open(dir.path(), SESSION_ID).unwrap();
    let db = HistoryDatabase::open(&history_db_path(dir.path())).unwrap();
    HistoryProjector::new(&db).rebuild(&log).unwrap();
    assert!(!dir.path().join("history.db.rebuild").exists());
    let live_names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name == "history.db")
        .collect();
    assert_eq!(live_names, vec!["history.db".to_string()], "{point}");
    assert_eq!(
        dump_operation_records(&history_db_path(dir.path())),
        before,
        "{point}"
    );
}

#[cfg(all(feature = "failpoints", unix))]
#[test]
fn fence_t8_crash_during_fenced_rebuild_keeps_a_rebuildable_database() {
    crash_fenced_rebuild("history.rebuild_after_copy");
    crash_fenced_rebuild("history.rebuild_after_rename");
}

#[cfg(feature = "failpoints")]
fn run_failed_swap(
    actions: &[(&str, praana_core::RebuildHookKind)],
) -> (tempfile::TempDir, ArtifactError, rusqlite::Connection) {
    use praana_core::register_rebuild_hook;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let db_path = history_db_path(dir.path());
    ensure_wal_sidecars(&db_path);
    let probe = open_production_conn(&db_path);
    let _hook = register_rebuild_hook(&db_path, actions);
    let err = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    (dir, err, probe)
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t9_swap_replace_is_undone() {
    use praana_core::history::operation_ledger::{open_session_ledger, reserve_operation_sync};
    use praana_core::ui_contract::ids::OperationId;
    use praana_core::RebuildHookKind;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let db_path = history_db_path(dir.path());
    ensure_wal_sidecars(&db_path);
    let before = dump_operation_records(&db_path);
    let history = fixed_history();
    let _hook = praana_core::register_rebuild_hook(
        &db_path,
        &[("history.rebuild_swap_replace", RebuildHookKind::Fail)],
    );
    let err = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert!(
        err.message().contains("history.rebuild_swap_replace"),
        "{}",
        err.message()
    );
    assert!(db_path.is_file());
    assert_eq!(dump_operation_records(&db_path), before);
    assert_eq!(fence_trigger_count(&db_path), 0);
    assert!(sidecar_path(&db_path, "-wal").is_file() || sidecar_path(&db_path, "-shm").is_file());
    let ledger = open_session_ledger(&db_path, session_id()).unwrap();
    reserve_operation_sync(
        &ledger,
        &turn_submit_command(OperationId(ulid::Ulid::generate())),
        &history,
    )
    .unwrap();
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t9_swap_sidecar_is_undone() {
    use praana_core::history::operation_ledger::{open_session_ledger, reserve_operation_sync};
    use praana_core::ui_contract::ids::OperationId;
    use praana_core::RebuildHookKind;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let db_path = history_db_path(dir.path());
    ensure_wal_sidecars(&db_path);
    let before = dump_operation_records(&db_path);
    let history = fixed_history();
    let _hook = praana_core::register_rebuild_hook(
        &db_path,
        &[("history.rebuild_swap_sidecar", RebuildHookKind::Fail)],
    );
    let err = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert!(
        err.message().contains("history.rebuild_swap_sidecar"),
        "{}",
        err.message()
    );
    assert!(db_path.is_file());
    assert_eq!(dump_operation_records(&db_path), before);
    assert_eq!(fence_trigger_count(&db_path), 0);
    assert!(sidecar_path(&db_path, "-wal").is_file() || sidecar_path(&db_path, "-shm").is_file());
    let ledger = open_session_ledger(&db_path, session_id()).unwrap();
    reserve_operation_sync(
        &ledger,
        &turn_submit_command(OperationId(ulid::Ulid::generate())),
        &history,
    )
    .unwrap();
}

#[cfg(feature = "failpoints")]
fn assert_undo_stopped(err: &ArtifactError, dir: &Path, probe: &rusqlite::Connection) {
    let text = err.message();
    assert!(text.contains("swap failed"), "{text}");
    assert!(text.contains("manual recovery is needed"), "{text}");
    assert!(text.contains("other connections are not fenced"), "{text}");
    assert!(
        text.contains(&history_db_path(dir).display().to_string()),
        "{text}"
    );
    // The aside file's WAL may already have been renamed back to the live
    // sidecar names, so a fresh open of that path is a torn pair. The
    // connection that still holds the inode can see whether a trigger committed.
    assert_eq!(fence_trigger_count(&history_db_path(dir)), 0, "live file");
    assert_eq!(
        fence_trigger_count(&dir.join("history.db.rebuild")),
        0,
        "rebuild file"
    );
    let probe_triggers: i64 = probe
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'praana_fence_%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(probe_triggers, 0, "old connection");
    let operation_id = ulid::Ulid::generate().to_string();
    probe
        .execute_batch("BEGIN IMMEDIATE;")
        .unwrap_or_else(|err| {
            panic!("old connection could not start a write after rollback: {err}")
        });
    insert_reserved_probe(probe, &operation_id)
        .unwrap_or_else(|err| panic!("old connection could not write after rollback: {err}"));
    probe.execute_batch("ROLLBACK;").unwrap();
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t9_undo_main_names_paths() {
    use praana_core::RebuildHookKind;

    let (dir, err, probe) = run_failed_swap(&[
        ("history.rebuild_swap_replace", RebuildHookKind::Fail),
        ("history.rebuild_swap_undo_main", RebuildHookKind::Fail),
    ]);
    assert_undo_stopped(&err, dir.path(), &probe);
    // Sidecars are restored before the main file. A failure on that last step
    // leaves them beside the missing main file; that is the order the removal
    // check distinguishes from restoring the main file first.
    assert!(!history_db_path(dir.path()).is_file());
    assert!(
        sidecar_path(&history_db_path(dir.path()), "-wal").is_file()
            || sidecar_path(&history_db_path(dir.path()), "-shm").is_file(),
        "undo restored the main file before the sidecars"
    );
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t9_undo_first_stops_without_a_live_main() {
    use praana_core::RebuildHookKind;

    let (dir, err, probe) = run_failed_swap(&[
        ("history.rebuild_swap_replace", RebuildHookKind::Fail),
        ("history.rebuild_swap_undo_first", RebuildHookKind::Fail),
    ]);
    assert_undo_stopped(&err, dir.path(), &probe);
    assert!(!history_db_path(dir.path()).is_file());
    assert!(!sidecar_path(&history_db_path(dir.path()), "-wal").is_file());
    assert!(!sidecar_path(&history_db_path(dir.path()), "-shm").is_file());
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t10_fsync_error_keeps_the_swap() {
    use praana_core::RebuildHookKind;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let db_path = history_db_path(dir.path());
    let _hook = praana_core::register_rebuild_hook(
        &db_path,
        &[("history.rebuild_after_replace_fsync", RebuildHookKind::Fail)],
    );
    let err = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert!(
        err.message()
            .contains("history.rebuild_after_replace_fsync"),
        "{}",
        err.message()
    );
    let bad = find_bad_main(dir.path()).expect("aside file");
    assert!(fence_trigger_count(&bad) > 0);
    assert_eq!(fence_trigger_count(&db_path), 0);
    session
        .db
        .record_telemetry_sample("t10-fsync", None, 1, "{}", 1)
        .unwrap();
    assert_eq!(table_count(&db_path, "telemetry_samples"), 1);
    assert_eq!(named_sample_count(&bad, "t10-fsync"), 0);
}

#[cfg(feature = "failpoints")]
fn named_sample_count(path: &Path, name: &str) -> i64 {
    if !path.is_file() {
        return 0;
    }
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM telemetry_samples WHERE name = ?1",
        [name],
        |row| row.get(0),
    )
    .unwrap()
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t10_commit_error_is_fence_incomplete() {
    use praana_core::RebuildHookKind;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let db_path = history_db_path(dir.path());
    let probe = open_production_conn(&db_path);
    let _hook = praana_core::register_rebuild_hook(
        &db_path,
        &[("history.rebuild_commit", RebuildHookKind::Fail)],
    );
    let err = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert!(
        err.message().contains("fence incomplete"),
        "{}",
        err.message()
    );
    if let Some(bad) = find_bad_main(dir.path()) {
        assert_eq!(fence_trigger_count(&bad), 0);
    }
    let operation_id = ulid::Ulid::generate().to_string();
    probe.execute_batch("BEGIN IMMEDIATE;").unwrap();
    insert_reserved_probe(&probe, &operation_id).expect("old handle is not fenced");
    probe.execute_batch("ROLLBACK;").unwrap();
    session
        .db
        .record_telemetry_sample("t10-commit", None, 1, "{}", 1)
        .unwrap();
    assert_eq!(named_sample_count(&db_path, "t10-commit"), 1);
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t10_commit_failure_releases_the_write_lock() {
    use praana_core::{register_rebuild_hook, RebuildHookKind};

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    drop(session);
    let db_path = history_db_path(dir.path());
    let writer = open_production_conn(&db_path);
    writer.busy_handler(Some(rebuild_writer_no_retry)).unwrap();
    let hook = register_rebuild_hook(
        &db_path,
        &[
            ("history.rebuild_commit", RebuildHookKind::Fail),
            ("history.rebuild_reopen", RebuildHookKind::Pause),
        ],
    );
    let dir_buf = dir.path().to_path_buf();
    let rebuild_path = db_path.clone();
    let rebuild = thread::spawn(move || {
        let log = EventLogStore::open(&dir_buf, SESSION_ID).expect("open log");
        let db = HistoryDatabase::open(&rebuild_path).expect("open db");
        HistoryProjector::new(&db).rebuild(&log)
    });
    assert!(
        hook.wait_paused("history.rebuild_reopen", Duration::from_secs(5)),
        "rebuild did not pause after the failed commit"
    );
    writer
        .execute_batch("BEGIN IMMEDIATE;")
        .expect("write lock still held after the failed commit");
    writer.execute_batch("ROLLBACK;").unwrap();
    hook.resume();
    let err = rebuild.join().expect("rebuild thread").unwrap_err();
    assert!(
        err.message().contains("fence incomplete"),
        "{}",
        err.message()
    );
}

#[cfg(feature = "failpoints")]
#[test]
fn fence_t10_reopen_error_keeps_the_tombstoned_connection() {
    use praana_core::RebuildHookKind;

    let dir = tempfile::tempdir().unwrap();
    let session = build_session_with_texts(dir.path(), &["alpha"], &["beta"]);
    let db_path = history_db_path(dir.path());
    let stale = open_production_conn(&db_path);
    let samples_before = table_count(&db_path, "telemetry_samples");
    let _hook = praana_core::register_rebuild_hook(
        &db_path,
        &[("history.rebuild_reopen", RebuildHookKind::Fail)],
    );
    let err = HistoryProjector::new(&session.db)
        .rebuild(&session.log)
        .unwrap_err();
    assert!(
        err.message().contains("history.rebuild_reopen"),
        "{}",
        err.message()
    );
    let write = session
        .db
        .record_telemetry_sample("t10-reopen", None, 1, "{}", 1);
    assert!(
        write.is_err(),
        "write through the retained connection succeeded"
    );
    let bad = find_bad_main(dir.path()).expect("aside file");
    assert_eq!(named_sample_count(&db_path, "t10-reopen"), 0);
    assert_eq!(named_sample_count(&bad, "t10-reopen"), 0);
    assert_eq!(table_count(&bad, "telemetry_samples"), samples_before);
    let ordinary = stale.execute(
        "INSERT INTO schema_meta(key, value) VALUES ('t10_reopen', '1')",
        [],
    );
    assert!(ordinary.is_err(), "stale raw write succeeded");
    assert!(
        ordinary
            .unwrap_err()
            .to_string()
            .contains("HISTORY_FILE_REPLACED"),
        "retained inode did not raise the fence"
    );
    let fresh = HistoryDatabase::open(&db_path).unwrap();
    fresh
        .record_telemetry_sample("t10-reopen-fresh", None, 1, "{}", 1)
        .unwrap();
    assert_eq!(named_sample_count(&db_path, "t10-reopen-fresh"), 1);
}
