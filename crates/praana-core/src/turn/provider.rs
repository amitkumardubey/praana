//! P3D (issue #624): `StepProvider` binding for the P2B OpenAI Chat /
//! Responses + OpenRouter Chat adapters.
//!
//! `prepare_admitted` projects the accepted conversation, resolves the P2A
//! capability profile, compiles the P1D instruction slots, and formats the
//! exact wire body. `complete_step` resolves the credential only after the
//! durable attempt start, sends over a cancellable streaming transport, and
//! converts the P2B parse into the protocol-owned [`StepOutcome`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use async_trait::async_trait;
use futures::StreamExt;
use serde_json::Value;

use crate::clock::{Clock, SystemClock};
use crate::config::EffectiveConfigV1;
use crate::credentials::store::{credentials_path, load_store, CredentialStoreV1};
use crate::history::projection::ConversationProjection;
use crate::id::{IdGenerator, MonotonicUlidGenerator};
use crate::protocol::events::EventEnvelope;
use crate::protocol::id::{MessageId, SessionId, TurnId};
use crate::protocol::messages::{
    AssistantBlock, ConversationMessage, ReasoningSummaryBlock, RefusalBlock, TextBlock, ToolCall,
    UserBlock, UserMessage,
};
use crate::protocol::models::{HistoryMode, ModelSelection, ProviderUsage};
use crate::provider::openai::{
    build_headers, classify_http, compile_instructions, format_chat_body, format_responses_body,
    http_error, parse_chat_stream, parse_responses_stream, resolve_provider_credential,
    ChatFormatInput, ChatProfileKind, OpenAiAdapterEvent, ProviderError, ProviderErrorCode,
    ResponsesFormatInput, SseFailure, SseFrame, SseParser, ToolChoiceV1,
};
use crate::provider::profile::{
    ImageInputCapability, ModelCapabilityProfile, ReasoningContextCapability,
};
use crate::provider::registry::ProviderProtocol;
use crate::provider::{catalog_cache_path, CatalogCacheV1, CATALOG_CACHE_SCHEMA_VERSION};
use crate::system_context::load::{ContextPathResolution, LoadedProjectContext};
use crate::system_context::render::build_instruction_slots;
use crate::system_context::{ComponentState, InstructionSlotsV1, SystemContextInputV1};
use crate::tools::builtin::production_tools;
use crate::tools::ToolRegistry;
use tokio_util::sync::CancellationToken;

use super::{
    model_selection, provider_failure_from_provider_error, provider_protocol_error,
    AdmittedRequest, AssistantDraft, DraftCall, PrepareContext, PreparedRequest, PreparedStep,
    ProviderFailure, SendAuthorization, StepOutcome, StepProvider, TurnError,
};

const ZERO_OUTPUT_RESERVE: u64 = 0;

pub struct OpenAiStepProvider {
    config: EffectiveConfigV1,
    home: PathBuf,
    workspace: PathBuf,
    git_root: Option<PathBuf>,
    endpoint: String,
    extra_headers: BTreeMap<String, String>,
    provider_id: String,
    protocol: ProviderProtocol,
    is_responses: bool,
    target: ModelSelection,
    registry: ToolRegistry,
    /// P1D project context discovered once per session (System Context §3).
    project_context: LoadedProjectContext,
    /// Instructions for the bound session id, rebuilt on `bind_session` so the
    /// compiled slots carry the real session id rather than a fresh one.
    instructions: RwLock<String>,
    session_id: RwLock<SessionId>,
    slots: RwLock<InstructionSlotsV1>,
    session: RwLock<Option<PathBuf>>,
    output_reserve: AtomicU64,
    client: reqwest::Client,
}

impl OpenAiStepProvider {
    pub fn new(
        config: &EffectiveConfigV1,
        home: &Path,
        workspace: &Path,
    ) -> Result<Self, TurnError> {
        Self::with_project_context(config, home, workspace, None)
    }

    /// Bind a provider to an already-discovered project context so session
    /// creation can record the same provenance digest the instructions were
    /// compiled from. `None` discovers here.
    pub fn with_project_context(
        config: &EffectiveConfigV1,
        home: &Path,
        workspace: &Path,
        project_context: Option<LoadedProjectContext>,
    ) -> Result<Self, TurnError> {
        let provider_id = config.llm.provider.clone();
        let protocol = resolve_wire_protocol(&provider_id, &config.llm.protocol)?;
        let (endpoint, extra_headers) = if provider_id == "openrouter" {
            (
                config.providers.openrouter.base_url.clone(),
                config.providers.openrouter.extra_headers.clone(),
            )
        } else {
            (
                config.providers.openai.base_url.clone(),
                config.providers.openai.extra_headers.clone(),
            )
        };
        let registry = ToolRegistry::try_from_erased(
            production_tools(&config.tools)
                .map_err(|error| TurnError::failed(error.to_string()))?,
        )
        .map_err(|error| TurnError::failed(error.to_string()))?;
        let git_root = find_git_root(workspace);
        let project_context = match project_context {
            Some(context) => context,
            None => crate::system_context::load::discover_project_context(
                home,
                workspace,
                git_root.as_deref(),
                &ContextPathResolution::new(workspace, home),
            )
            .map_err(|error| TurnError::failed(error.to_string()))?,
        };
        // Unbound: a placeholder session id keeps the unit-level
        // `prepare_admitted` seam usable; `bind_session` recompiles.
        let ids = MonotonicUlidGenerator::system();
        let placeholder = ids
            .next_id::<SessionId>()
            .map_err(|error| TurnError::failed(error.to_string()))?;
        let input = SystemContextInputV1 {
            praana_version: env!("CARGO_PKG_VERSION").to_owned(),
            cwd: workspace.to_string_lossy().into_owned(),
            git_root: git_root
                .as_ref()
                .map(|root| root.to_string_lossy().into_owned()),
            session_id: placeholder,
            history_mode: HistoryMode::Append,
            native_status: ComponentState::Unavailable,
            search_status: ComponentState::Unavailable,
            lsp_status: ComponentState::Disabled,
            skills: Vec::new(),
        };
        let slots = build_instruction_slots(&input, &project_context, &[], &[], "")
            .map_err(|error| TurnError::failed(error.to_string()))?;
        let instructions = compile_instructions(&slots).map_err(|error| {
            TurnError::Provider(Box::new(provider_failure_from_provider_error(&error)))
        })?;
        Ok(Self {
            target: model_selection(config),
            config: config.clone(),
            home: home.to_path_buf(),
            workspace: workspace.to_path_buf(),
            git_root,
            endpoint,
            extra_headers,
            provider_id,
            is_responses: matches!(protocol, ProviderProtocol::Responses),
            protocol,
            registry,
            project_context,
            instructions: RwLock::new(instructions),
            session_id: RwLock::new(placeholder),
            slots: RwLock::new(slots),
            session: RwLock::new(None),
            output_reserve: AtomicU64::new(ZERO_OUTPUT_RESERVE),
            client: reqwest::Client::new(),
        })
    }

    /// The discovered project context, so session creation can record its
    /// `project_context_source_sha256` provenance digest.
    pub fn project_context(&self) -> &LoadedProjectContext {
        &self.project_context
    }

    fn resolve_profile(&self) -> Option<ModelCapabilityProfile> {
        let now_ms = SystemClock.now_ms();
        let cache = read_catalog_cache(&catalog_cache_path(&self.home));
        let context_override =
            (self.config.llm.context_window > 0).then_some(self.config.llm.context_window);
        let max_output_override = Some(self.config.llm.max_output_tokens);
        crate::provider::catalog::resolve_profile_with_catalog(
            &self.provider_id,
            &self.protocol,
            &self.config.llm.model,
            &self.endpoint,
            now_ms,
            cache.as_ref(),
            context_override,
            max_output_override,
        )
        .ok()
    }

    fn conversation(
        &self,
        ctx: &PrepareContext<'_>,
    ) -> Result<
        (
            Vec<ConversationMessage>,
            Option<crate::protocol::continuation::ProviderContinuation>,
        ),
        TurnError,
    > {
        let session_dir = self.session.read().unwrap().clone();
        if let Some(dir) = session_dir {
            if let Some(events) = read_events(&dir) {
                if !events.is_empty() {
                    let projection = ConversationProjection::project_with_context(
                        &events,
                        None,
                        &ctx.notices,
                        Some(&self.target),
                    )
                    .map_err(|error| TurnError::failed(format!("projection: {error}")))?;
                    if !projection.messages.is_empty() {
                        return Ok((projection.messages, projection.active_continuation));
                    }
                }
            }
        }
        // Unbound (direct prepare) or empty session: the active input is the
        // only accepted conversation.
        let ids = MonotonicUlidGenerator::system();
        let message_id = ids
            .next_id::<MessageId>()
            .map_err(|error| TurnError::failed(error.to_string()))?;
        let turn_id = ids
            .next_id::<TurnId>()
            .map_err(|error| TurnError::failed(error.to_string()))?;
        Ok((
            vec![ConversationMessage::User(UserMessage {
                message_id,
                turn_id,
                blocks: vec![UserBlock::Text(TextBlock {
                    text: ctx.input.to_owned(),
                })],
            })],
            None,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn format_body(
        &self,
        instructions: &str,
        messages: &[ConversationMessage],
        continuation: Option<&crate::protocol::continuation::ProviderContinuation>,
        profile: Option<&ModelCapabilityProfile>,
        resolved_max_output_tokens: u64,
    ) -> Result<Value, TurnError> {
        let config = &self.config;
        let reasoning = reasoning_effort(&config.llm.reasoning_effort);
        let image_input_supported = profile
            .map(|profile| !matches!(profile.image_input, ImageInputCapability::Unsupported))
            .unwrap_or(false);
        let temperature_with_reasoning = profile
            .map(|profile| profile.temperature_with_reasoning)
            .unwrap_or(false);
        let parallel_tools = config.tools.max_parallel_calls > 1;
        let body = if self.is_responses {
            let openai_continuation = continuation.and_then(|continuation| match continuation {
                crate::protocol::continuation::ProviderContinuation::OpenAiResponses(inner) => {
                    Some(inner)
                }
                _ => None,
            });
            format_responses_body(&ResponsesFormatInput {
                model: &config.llm.model,
                instructions,
                messages,
                tools: self.registry.catalog(),
                tool_choice: ToolChoiceV1::Auto,
                parallel_tools,
                resolved_max_output_tokens,
                temperature_milli: config.llm.temperature_milli,
                temperature_with_reasoning,
                reasoning,
                reasoning_context: profile
                    .map(|profile| profile.reasoning_context.clone())
                    .unwrap_or(ReasoningContextCapability::Unsupported),
                image_input_supported,
                continuation: openai_continuation,
                target: &self.target,
                internal_compaction_control: None,
                compaction_schema: None,
                replay_policy: "active",
            })
        } else {
            format_chat_body(&ChatFormatInput {
                profile: if self.provider_id == "openrouter" {
                    ChatProfileKind::OpenRouter
                } else {
                    ChatProfileKind::OpenAi
                },
                model: &config.llm.model,
                instructions,
                messages,
                tools: self.registry.catalog(),
                tool_choice: ToolChoiceV1::Auto,
                parallel_tools,
                resolved_max_output_tokens,
                temperature_milli: config.llm.temperature_milli,
                temperature_with_reasoning,
                reasoning,
                image_input_supported,
                internal_compaction_control: None,
                compaction_schema: None,
            })
        };
        body.map_err(|error| {
            TurnError::Provider(Box::new(provider_failure_from_provider_error(&error)))
        })
    }

    fn image_count(messages: &[ConversationMessage]) -> usize {
        let mut count = 0usize;
        for message in messages {
            match message {
                ConversationMessage::User(user) => {
                    count += user
                        .blocks
                        .iter()
                        .filter(|block| matches!(block, UserBlock::Image(_)))
                        .count();
                }
                ConversationMessage::Assistant(assistant) => {
                    count += assistant
                        .blocks
                        .iter()
                        .filter(|block| matches!(block, AssistantBlock::Image(_)))
                        .count();
                }
                ConversationMessage::ToolResult(_) => {}
            }
        }
        count
    }

    async fn dispatch(
        &self,
        admitted: &AdmittedRequest,
        cancel: &CancellationToken,
        tracker: &mut EmissionTracker,
    ) -> Result<(Vec<u8>, SendAuthorization), DispatchError> {
        let store = load_store(&credentials_path(&self.home))
            .unwrap_or_else(|_| CredentialStoreV1::empty());
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let token = resolve_provider_credential(&store, &self.provider_id, None, &env)
            .map_err(DispatchError::Provider)?;
        let headers = build_headers(
            &self.provider_id,
            env!("CARGO_PKG_VERSION"),
            &self.extra_headers,
            Some(&token),
        )
        .map_err(DispatchError::Provider)?;
        let mut header_map = reqwest::header::HeaderMap::new();
        for (name, value) in &headers {
            let header_name =
                reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
                    DispatchError::Provider(ProviderError::new(
                        ProviderErrorCode::HeaderInvalid,
                        &self.provider_id,
                        "openai",
                        "header name is invalid",
                    ))
                })?;
            let header_value =
                reqwest::header::HeaderValue::from_bytes(value.as_bytes()).map_err(|_| {
                    DispatchError::Provider(ProviderError::new(
                        ProviderErrorCode::HeaderInvalid,
                        &self.provider_id,
                        "openai",
                        "header value is invalid",
                    ))
                })?;
            header_map.append(header_name, header_value);
        }
        // One frozen serialization: the exact bytes uploaded are the canonical
        // (RFC 8785) bytes the admission hash was computed over, so a later
        // different serialization of the same value is caught before the
        // network write rather than after the response.
        let body = crate::protocol::json::serialize_canonical_string(admitted.body()).map_err(
            |error| {
                DispatchError::Provider(ProviderError::new(
                    ProviderErrorCode::RequestSerializeFailed,
                    &self.provider_id,
                    "openai",
                    error.to_string(),
                ))
            },
        )?;
        // Proof that the wire body is byte-for-byte the admitted body, taken
        // before the socket write: the admission hash covers exactly these
        // canonical bytes, not a value compared with itself.
        let authorization = admitted.authorize_bytes(body.as_bytes()).map_err(|error| {
            DispatchError::Provider(ProviderError::new(
                ProviderErrorCode::RequestAdmissionDenied,
                &self.provider_id,
                "openai",
                error.to_string(),
            ))
        })?;
        let request = self
            .client
            .post(endpoint_url(
                &self.endpoint,
                if self.is_responses {
                    "responses"
                } else {
                    "chat/completions"
                },
            ))
            .headers(header_map)
            .body(body);
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err(DispatchError::Cancelled),
            result = request.send() => result.map_err(|error| {
                DispatchError::Provider(ProviderError::new(
                    ProviderErrorCode::TransportError,
                    &self.provider_id,
                    "openai",
                    format!("transport: {error}"),
                ))
            })?,
        };
        tracker.sent = true;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
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
            let error_body = tokio::select! {
                _ = cancel.cancelled() => return Err(DispatchError::Cancelled),
                result = response.bytes() => result.unwrap_or_default(),
            };
            // The body is classified (a 400 context-length error needs it) and
            // then dropped: a provider error body can echo the configured
            // credential, the Authorization header, or the request payload, and
            // no diagnostic may carry raw provider text into events or stderr.
            let code = classify_http(status, &error_body);
            let mut error = http_error(code, status, &response_headers, &[]);
            error.safe_message = format!("provider responded with HTTP {status}");
            return Err(DispatchError::Provider(error));
        }
        let mut stream = response.bytes_stream();
        let mut parser = SseParser::new();
        let mut bytes: Vec<u8> = Vec::new();
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(DispatchError::Cancelled),
                next = stream.next() => next,
            };
            match next {
                None => break,
                Some(Err(error)) => {
                    return Err(DispatchError::Provider(ProviderError::new(
                        ProviderErrorCode::TransportError,
                        &self.provider_id,
                        "openai",
                        format!("stream: {error}"),
                    )));
                }
                Some(Ok(chunk)) => {
                    bytes.extend_from_slice(&chunk);
                    let frames = parser.push(&chunk).map_err(|failure| {
                        DispatchError::Provider(sse_dispatch_failure(failure))
                    })?;
                    tracker.observe(&frames);
                }
            }
        }
        let trailing = parser
            .finish()
            .map_err(|failure| DispatchError::Provider(sse_dispatch_failure(failure)))?;
        tracker.observe(&trailing);
        Ok((bytes, authorization))
    }

    fn build_outcome(
        &self,
        bytes: Vec<u8>,
        tracker: &EmissionTracker,
        authorization: SendAuthorization,
    ) -> Result<StepOutcome, TurnError> {
        let parsed: Result<OutcomeParts, ProviderError> = if self.is_responses {
            parse_responses_stream(&bytes, &self.target).map(|outcome| OutcomeParts {
                text_refusal: split_text_refusal(&outcome.events),
                reasoning_summaries: split_reasoning_summaries(&outcome.events),
                tool_calls: outcome.tool_calls.iter().map(draft_call).collect(),
                finish_reason: outcome.finish_reason,
                usage: outcome.usage.usage,
                response_id: outcome.response_id,
                phase: responses_phase(&outcome.continuation),
                continuation: outcome
                    .continuation
                    .map(crate::protocol::continuation::ProviderContinuation::OpenAiResponses),
            })
        } else {
            parse_chat_stream(&bytes).map(|outcome| OutcomeParts {
                text_refusal: split_text_refusal(&outcome.events),
                reasoning_summaries: split_reasoning_summaries(&outcome.events),
                tool_calls: outcome.tool_calls.iter().map(draft_call).collect(),
                finish_reason: outcome.finish_reason,
                usage: outcome.usage.usage,
                response_id: None,
                phase: None,
                continuation: None,
            })
        };
        let parts = match parsed {
            Ok(parts) => parts,
            Err(error) => {
                return Err(TurnError::Provider(Box::new(parse_failure(
                    &error, tracker,
                ))));
            }
        };
        let (text, refusal) = parts.text_refusal;
        let blocks = ordered_blocks(
            &text,
            &refusal,
            &parts.reasoning_summaries,
            &parts.tool_calls,
        );
        let draft = AssistantDraft {
            text: if blocks.is_some() {
                None
            } else {
                (!text.is_empty()).then_some(text)
            },
            calls: parts.tool_calls,
            finish_reason: parts.finish_reason,
            usage: parts.usage,
        };
        Ok(StepOutcome {
            draft,
            blocks,
            continuation: parts.continuation,
            phase: parts.phase,
            authorization,
        })
    }
}

#[async_trait]
impl StepProvider for OpenAiStepProvider {
    fn prepare_admitted(
        &self,
        step_index: u32,
        ctx: &PrepareContext<'_>,
    ) -> Result<PreparedStep, TurnError> {
        let _ = step_index;
        let profile = self.resolve_profile();
        let (messages, continuation) = self.conversation(ctx)?;
        let session_id = *self.session_id.read().unwrap();
        let input = SystemContextInputV1 {
            praana_version: env!("CARGO_PKG_VERSION").to_owned(),
            cwd: self.workspace.to_string_lossy().into_owned(),
            git_root: self
                .git_root
                .as_ref()
                .map(|root| root.to_string_lossy().into_owned()),
            session_id,
            history_mode: HistoryMode::Append,
            native_status: ComponentState::Unavailable,
            search_status: ComponentState::Unavailable,
            lsp_status: ComponentState::Disabled,
            skills: Vec::new(),
        };
        let mut slots = self.slots.read().unwrap().clone();
        let current_state =
            crate::system_context::render::render_current_state(ctx.state_tail, &input)
                .map_err(|error| TurnError::failed(error.to_string()))?;
        let state_tail_offset = if ctx.state_tail.is_empty() {
            None
        } else {
            let mut prefix_blocks = vec![
                format!(
                    "[PRAANA:SYSTEM_POLICY]\n{}\n[/PRAANA:SYSTEM_POLICY]",
                    crate::provider::openai::normalize_newlines(&slots.system_policy)
                ),
                format!(
                    "[PRAANA:PROJECT_CONTEXT_DATA]\n{}\n[/PRAANA:PROJECT_CONTEXT_DATA]",
                    crate::provider::openai::normalize_newlines(&slots.project_context)
                ),
            ];
            if let Some(memory) = &slots.cross_session_memory {
                prefix_blocks.push(format!(
                    "[PRAANA:CROSS_SESSION_MEMORY_DATA]\n{}\n[/PRAANA:CROSS_SESSION_MEMORY_DATA]",
                    crate::provider::openai::normalize_newlines(memory)
                ));
            }
            let handoff = slots.historical_handoff.as_deref().unwrap_or("");
            prefix_blocks.push(format!(
                "[PRAANA:HISTORICAL_HANDOFF_DATA]\n{}\n[/PRAANA:HISTORICAL_HANDOFF_DATA]",
                crate::provider::openai::normalize_newlines(handoff)
            ));

            let prefix = prefix_blocks.join("\n\n");
            let offset = prefix.len() + "\n\n[PRAANA:CURRENT_STATE_DATA]\n".len();
            Some(offset)
        };
        slots.current_state = current_state;
        let instructions = compile_instructions(&slots).map_err(|error| {
            TurnError::Provider(Box::new(provider_failure_from_provider_error(&error)))
        })?;
        if let Some(offset) = state_tail_offset {
            debug_assert_eq!(
                &instructions.as_bytes()[offset..offset + ctx.state_tail.len()],
                ctx.state_tail.as_bytes()
            );
        }
        let reserve = self.output_reserve.load(Ordering::SeqCst);
        // The configured `llm.max_output_tokens` is the requested output window
        // and bounds the profile's model limit; without this cap a small
        // configured window would reserve the whole model output budget and
        // underflow admission arithmetic.
        let resolved_max_output_tokens = if reserve > ZERO_OUTPUT_RESERVE {
            reserve
        } else {
            profile
                .as_ref()
                .map_or(self.config.llm.max_output_tokens, |profile| {
                    profile
                        .max_output_tokens
                        .min(self.config.llm.max_output_tokens)
                })
        };
        let body = self.format_body(
            &instructions,
            &messages,
            continuation.as_ref(),
            profile.as_ref(),
            resolved_max_output_tokens,
        )?;
        Ok(PreparedStep {
            request: PreparedRequest {
                request_body: body,
                component_bytes: std::array::from_fn(|_| Vec::new()),
            },
            profile,
            image_count: Self::image_count(&messages),
            resolved_max_output_tokens: Some(resolved_max_output_tokens),
            state_tail_offset,
        })
    }

    async fn complete_step(
        &self,
        step_index: u32,
        admitted: &AdmittedRequest,
        cancel: &CancellationToken,
    ) -> Result<StepOutcome, TurnError> {
        let _ = step_index;
        let mut tracker = EmissionTracker::default();
        match self.dispatch(admitted, cancel, &mut tracker).await {
            // `dispatch` authorized the exact uploaded bytes before the write.
            Ok((bytes, authorization)) => self.build_outcome(bytes, &tracker, authorization),
            Err(DispatchError::Cancelled) => {
                Err(TurnError::Provider(Box::new(cancelled_failure(&tracker))))
            }
            Err(DispatchError::Provider(error)) => Err(TurnError::Provider(Box::new(
                provider_failure(&error, &tracker),
            ))),
        }
    }

    fn bind_session(&self, session_dir: &Path) {
        // Recompile the P1D slots for the real session id so `current_state`
        // and the request instructions match the session that is running.
        let session_id = std::fs::read_to_string(session_dir.join("meta.json"))
            .ok()
            .and_then(|text| {
                serde_json::from_str::<serde_json::Value>(text.trim_end_matches('\n')).ok()
            })
            .and_then(|v| {
                v.get("session_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .and_then(|s| SessionId::from_str_canonical(&s).ok())
            .or_else(|| {
                std::path::Path::new(session_dir)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(|name| SessionId::from_str_canonical(name).ok())
            });
        if let Some(session_id) = session_id {
            *self.session_id.write().unwrap() = session_id;
            let input = SystemContextInputV1 {
                praana_version: env!("CARGO_PKG_VERSION").to_owned(),
                cwd: self.workspace.to_string_lossy().into_owned(),
                git_root: self
                    .git_root
                    .as_ref()
                    .map(|root| root.to_string_lossy().into_owned()),
                session_id,
                history_mode: HistoryMode::Append,
                native_status: ComponentState::Unavailable,
                search_status: ComponentState::Unavailable,
                lsp_status: ComponentState::Disabled,
                skills: Vec::new(),
            };
            if let Ok(slots) = build_instruction_slots(&input, &self.project_context, &[], &[], "")
            {
                if let Ok(instructions) = compile_instructions(&slots) {
                    *self.instructions.write().unwrap() = instructions;
                }
                *self.slots.write().unwrap() = slots;
            }
        }
        *self.session.write().unwrap() = Some(session_dir.to_path_buf());
    }

    fn set_output_reserve(&self, tokens: u64) {
        self.output_reserve.store(tokens, Ordering::SeqCst);
    }

    fn clear_output_reserve(&self) {
        self.output_reserve
            .store(ZERO_OUTPUT_RESERVE, Ordering::SeqCst);
    }
}

/// Strict wire-protocol resolution for the StepProvider seam. Config load
/// already whitelists `llm.protocol` (unknown values fail there, before any
/// session exists); this is the authorized P3D backstop: `"auto"` follows the
/// same provider rule as setup, explicit names map one-to-one, and anything
/// else is an error — never a silent fallback to a different protocol.
fn resolve_wire_protocol(provider: &str, protocol: &str) -> Result<ProviderProtocol, TurnError> {
    match protocol {
        "auto" => Ok(if provider == "openai" {
            ProviderProtocol::Responses
        } else {
            ProviderProtocol::Chat
        }),
        "openai-chat-v1" => Ok(ProviderProtocol::Chat),
        "openai-responses-v1" => Ok(ProviderProtocol::Responses),
        other => Err(TurnError::failed(format!(
            "llm.protocol: unsupported protocol {other:?}"
        ))),
    }
}

enum DispatchError {
    Provider(ProviderError),
    Cancelled,
}

struct OutcomeParts {
    text_refusal: (String, String),
    reasoning_summaries: Vec<String>,
    tool_calls: Vec<DraftCall>,
    finish_reason: super::FinishReason,
    usage: ProviderUsage,
    #[allow(dead_code)]
    response_id: Option<String>,
    phase: Option<crate::protocol::messages::AssistantPhase>,
    continuation: Option<crate::protocol::continuation::ProviderContinuation>,
}

fn draft_call(call: &crate::protocol::messages::ToolCall) -> DraftCall {
    DraftCall {
        call_id: call.call_id.as_str().to_owned(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
    }
}

fn sse_dispatch_failure(failure: SseFailure) -> ProviderError {
    ProviderError::new(failure.code, "openai", "openai", "sse framing failed")
}

/// Parse failure after a possibly-emitted stream: the frame-level tracker
/// decides whether the failure may be retried and what partial output is
/// durable on the failed attempt.
fn parse_failure(error: &ProviderError, tracker: &EmissionTracker) -> ProviderFailure {
    ProviderFailure {
        error: provider_protocol_error(error),
        emission_crossed: tracker.emission_crossed,
        observable_delta: tracker.observable_delta,
        partial_blocks: tracker.partial_blocks(),
        provider_response_id: None,
        usage: ProviderUsage::default(),
        may_have_completed: tracker.sent,
        cancelled: false,
        retry_after_ms: error.retry_after_ms,
    }
}

fn provider_failure(error: &ProviderError, tracker: &EmissionTracker) -> ProviderFailure {
    ProviderFailure {
        error: provider_protocol_error(error),
        emission_crossed: tracker.emission_crossed,
        observable_delta: tracker.observable_delta,
        partial_blocks: tracker.partial_blocks(),
        provider_response_id: None,
        usage: ProviderUsage::default(),
        may_have_completed: tracker.sent && !is_auth_failure(error),
        cancelled: false,
        retry_after_ms: error.retry_after_ms,
    }
}

fn is_auth_failure(error: &ProviderError) -> bool {
    matches!(
        error.code,
        ProviderErrorCode::AuthMissing
            | ProviderErrorCode::ProviderAuthFailed
            | ProviderErrorCode::ProviderPermissionDenied
    )
}

fn cancelled_failure(tracker: &EmissionTracker) -> ProviderFailure {
    ProviderFailure {
        error: provider_protocol_error(&ProviderError::new(
            ProviderErrorCode::Aborted,
            "openai",
            "openai",
            "cancelled",
        )),
        emission_crossed: tracker.emission_crossed,
        observable_delta: tracker.observable_delta,
        partial_blocks: tracker.partial_blocks(),
        provider_response_id: None,
        usage: ProviderUsage::default(),
        may_have_completed: false,
        cancelled: true,
        retry_after_ms: None,
    }
}

/// Frame-level emission barrier: any nonempty semantic delta crosses
/// emission; user-visible text / refusal / reasoning-summary deltas are
/// observable. Handles both Chat (`choices[].delta`) and Responses
/// (`type`-tagged) frame shapes without waiting for a terminal parse.
#[derive(Default)]
struct EmissionTracker {
    emission_crossed: bool,
    observable_delta: bool,
    sent: bool,
    partial_text: String,
    partial_refusal: String,
}

impl EmissionTracker {
    fn observe(&mut self, frames: &[SseFrame]) {
        for frame in frames {
            if frame.data.is_empty() || frame.data == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&frame.data) else {
                continue;
            };
            if let Some(delta) = value.pointer("/choices/0/delta") {
                if let Some(content) = delta.get("content").and_then(Value::as_str) {
                    if !content.is_empty() {
                        self.emission_crossed = true;
                        self.observable_delta = true;
                        self.partial_text.push_str(content);
                    }
                }
                if let Some(refusal) = delta.get("refusal").and_then(Value::as_str) {
                    if !refusal.is_empty() {
                        // A refusal crosses emission but is not an observable
                        // delta: it never reaches the accepted-text sink.
                        self.emission_crossed = true;
                        self.partial_refusal.push_str(refusal);
                    }
                }
                if delta.get("tool_calls").is_some() {
                    self.emission_crossed = true;
                }
                continue;
            }
            let Some(kind) = value.get("type").and_then(Value::as_str) else {
                continue;
            };
            // A Responses tool start crosses OpenAI's emission barrier even
            // before any argument delta arrives (attempt.rs `crosses_emission`
            // treats `ToolCallStarted` as emission).
            if kind == "response.output_item.added" {
                let is_call = value
                    .pointer("/item/type")
                    .and_then(Value::as_str)
                    .is_some_and(|item| item == "function_call");
                if is_call {
                    self.emission_crossed = true;
                }
                continue;
            }
            if !kind.ends_with(".delta") {
                continue;
            }
            let delta = value.get("delta").and_then(Value::as_str).unwrap_or("");
            if delta.is_empty() {
                continue;
            }
            self.emission_crossed = true;
            if kind.contains("output_text") {
                // User-visible text.
                self.observable_delta = true;
                self.partial_text.push_str(delta);
            } else if kind.contains("summary") || kind.contains("reasoning") {
                // A reasoning summary is user-visible.
                self.observable_delta = true;
            } else if kind.contains("refusal") {
                // A refusal crosses emission but is not an observable delta.
                self.partial_refusal.push_str(delta);
            }
        }
    }

    fn partial_blocks(&self) -> Vec<AssistantBlock> {
        let mut blocks = Vec::new();
        if !self.partial_text.is_empty() {
            blocks.push(AssistantBlock::Text(TextBlock {
                text: self.partial_text.clone(),
            }));
        }
        if !self.partial_refusal.is_empty() {
            blocks.push(AssistantBlock::Refusal(RefusalBlock {
                text: self.partial_refusal.clone(),
                provider_item_id: None,
            }));
        }
        blocks
    }
}

fn split_text_refusal(events: &[OpenAiAdapterEvent]) -> (String, String) {
    let mut text = String::new();
    let mut refusal = String::new();
    for event in events {
        if let OpenAiAdapterEvent::TextDelta {
            delta,
            refusal: is_refusal,
            ..
        } = event
        {
            if *is_refusal {
                refusal.push_str(delta);
            } else {
                text.push_str(delta);
            }
        }
    }
    (text, refusal)
}

/// Ordered accepted blocks: reasoning summaries (never user-visible on
/// stdout), then text, then a refusal, then the tool calls. `None` keeps the
/// legacy draft conversion when the step carried only plain text.
fn ordered_blocks(
    text: &str,
    refusal: &str,
    reasoning_summaries: &[String],
    calls: &[DraftCall],
) -> Option<Vec<AssistantBlock>> {
    if refusal.is_empty() && reasoning_summaries.is_empty() && calls.is_empty() {
        return None;
    }
    let mut blocks = Vec::new();
    for summary in reasoning_summaries {
        if summary.is_empty() {
            continue;
        }
        blocks.push(AssistantBlock::ReasoningSummary(ReasoningSummaryBlock {
            text: summary.clone(),
            provider_item_id: None,
        }));
    }
    if !text.is_empty() {
        blocks.push(AssistantBlock::Text(TextBlock {
            text: text.to_owned(),
        }));
    }
    if !refusal.is_empty() {
        blocks.push(AssistantBlock::Refusal(RefusalBlock {
            text: refusal.to_owned(),
            provider_item_id: None,
        }));
    }
    // Tool calls are carried as blocks too: once any non-text block is present
    // the loop stops deriving them from the draft, so they must be explicit.
    for call in calls {
        let Ok(call_id) = crate::protocol::id::ToolCallId::from_str_canonical(&call.call_id) else {
            continue;
        };
        blocks.push(AssistantBlock::ToolCall(ToolCall {
            call_id,
            name: call.name.clone(),
            arguments: call.arguments.clone(),
            raw_arguments: serde_json::to_string(&Value::Object(call.arguments.clone()))
                .unwrap_or_default(),
        }));
    }
    Some(blocks)
}

/// Responses phase (OpenAI §8.3): the last message item that carries one wins,
/// so a commentary-then-final-answer stream records the final phase.
fn responses_phase(
    continuation: &Option<crate::protocol::continuation::OpenAiResponsesContinuation>,
) -> Option<crate::protocol::messages::AssistantPhase> {
    use crate::protocol::continuation::{OpenAiAssistantPhase, OpenAiResponseOutputItem};
    use crate::protocol::messages::AssistantPhase;
    let continuation = continuation.as_ref()?;
    continuation.output_items.iter().rev().find_map(|item| {
        let OpenAiResponseOutputItem::Message(message) = item else {
            return None;
        };
        match message.phase {
            Some(OpenAiAssistantPhase::Commentary) => Some(AssistantPhase::Commentary),
            Some(OpenAiAssistantPhase::FinalAnswer) => Some(AssistantPhase::FinalAnswer),
            None => None,
        }
    })
}

fn split_reasoning_summaries(events: &[OpenAiAdapterEvent]) -> Vec<String> {
    let mut summaries: Vec<String> = Vec::new();
    for event in events {
        if let OpenAiAdapterEvent::ReasoningDelta { delta, .. } = event {
            match summaries.last_mut() {
                Some(last) => last.push_str(delta),
                None => summaries.push(delta.clone()),
            }
        }
    }
    summaries
}

fn endpoint_url(endpoint: &str, path: &str) -> String {
    format!("{}/{}", endpoint.trim_end_matches('/'), path)
}

fn read_events(session_dir: &Path) -> Option<Vec<EventEnvelope>> {
    let text = std::fs::read_to_string(session_dir.join("events.jsonl")).ok()?;
    let mut events = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<EventEnvelope>(line) {
            Ok(envelope) => events.push(envelope),
            // A partially flushed final line is ignored; appends write whole
            // lines, so everything else parses.
            Err(_) => break,
        }
    }
    Some(events)
}

/// Lenient read of the on-disk catalog cache. Trust decisions (endpoint
/// fingerprint, expiry, official endpoint) happen inside
/// `resolve_profile_with_catalog`; untrusted rows never leak their window.
fn read_catalog_cache(path: &Path) -> Option<CatalogCacheV1> {
    let text = std::fs::read_to_string(path).ok()?;
    let cache: CatalogCacheV1 = serde_json::from_str(&text).ok()?;
    (cache.schema_version == CATALOG_CACHE_SCHEMA_VERSION).then_some(cache)
}

fn reasoning_effort(value: &str) -> crate::protocol::models::ReasoningEffort {
    use crate::protocol::models::ReasoningEffort;
    match value {
        "off" => ReasoningEffort::Off,
        "minimal" => ReasoningEffort::Minimal,
        "low" => ReasoningEffort::Low,
        "high" => ReasoningEffort::High,
        "xhigh" => ReasoningEffort::Xhigh,
        _ => ReasoningEffort::Medium,
    }
}

/// Discover the P1D project context for this workspace (System Context §3).
/// Missing instruction files are normal; an unreadable candidate or a detected
/// secret is a visible error, never a silent empty context.
pub fn discover_workspace_context(
    praana_home: &Path,
    workspace: &Path,
) -> Result<LoadedProjectContext, TurnError> {
    let resolution = ContextPathResolution::new(workspace, praana_home);
    let git_root = find_git_root(workspace);
    crate::system_context::load::discover_project_context(
        praana_home,
        workspace,
        git_root.as_deref(),
        &resolution,
    )
    .map_err(|error| TurnError::failed(error.to_string()))
}

/// `git rev-parse --show-toplevel`, best effort: a missing git binary or a
/// non-repository workspace simply means no git-root context sources.
fn find_git_root(workspace: &Path) -> Option<PathBuf> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(workspace)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let root = text.trim();
    if root.is_empty() {
        None
    } else {
        Some(PathBuf::from(root))
    }
}

/// Compile the P1D instruction slots for a real session id and the discovered
/// project context.
pub fn compile_workspace_instructions(
    praana_version: &str,
    workspace: &Path,
    git_root: Option<&Path>,
    session_id: SessionId,
    project_context: &LoadedProjectContext,
) -> Result<String, TurnError> {
    let input = SystemContextInputV1 {
        praana_version: praana_version.to_owned(),
        cwd: workspace.to_string_lossy().into_owned(),
        git_root: git_root.map(|root| root.to_string_lossy().into_owned()),
        session_id,
        history_mode: HistoryMode::Append,
        native_status: ComponentState::Unavailable,
        search_status: ComponentState::Unavailable,
        lsp_status: ComponentState::Disabled,
        skills: Vec::new(),
    };
    let slots: InstructionSlotsV1 = build_instruction_slots(&input, project_context, &[], &[], "")
        .map_err(|error| TurnError::failed(error.to_string()))?;
    compile_instructions(&slots).map_err(|error| {
        TurnError::Provider(Box::new(provider_failure_from_provider_error(&error)))
    })
}
