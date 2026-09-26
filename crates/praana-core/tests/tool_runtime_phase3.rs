//! P3A common tool runtime. Built-in tools stay unregistered.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use praana_core::config::types::{CircuitConfig, RiskConfig, ToolsConfig};
use praana_core::process::{supervise, SuperviseRequest};
use praana_core::protocol::errors::ErrorClass;
use praana_core::protocol::id::{AttemptId, SessionId, ToolBatchId, TurnId};
use praana_core::protocol::tool_result::ToolResultStatus;
use praana_core::tools::{
    canonical_tool_result_bytes, map_side_effect_uncertain, map_skipped_uncertain_peer,
    map_tool_error, normalize_schema, BatchOrigin, PathAccessMode, PathLockTable, ProviderToolCall,
    SchemaError, ToolAdapter, ToolBatchRequest, ToolCallOrigin, ToolCapabilities, ToolError,
    ToolErrorCode, ToolExecutionContext, ToolIdempotency, ToolInspectContext, ToolIntent,
    ToolMutation, ToolName, ToolRegistry, ToolResultDto, ToolRuntime, TypedTool,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn aws() -> String {
    "AKIA".to_owned() + &"C".repeat(16)
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EchoInput {
    value: String,
}

#[derive(Debug, Serialize, JsonSchema)]
struct EchoOutput {
    value: String,
}

struct EchoTool;

#[async_trait]
impl TypedTool for EchoTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "echo_value";
    const ORDER: u16 = 1;
    const DESCRIPTION: &'static str = "Echo a value";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }

    fn inspect(&self, input: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        let _ = input.value.len();
        Ok(intent(ToolMutation::PureCompute, Vec::new()))
    }

    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        Ok(EchoOutput { value: input.value })
    }
}

struct AlphaTool;
struct ZetaTool;

#[async_trait]
impl TypedTool for AlphaTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "alpha_tool";
    const ORDER: u16 = 10;
    const DESCRIPTION: &'static str = "Alpha";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }
    fn inspect(&self, _: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(intent(ToolMutation::ReadOnly, Vec::new()))
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        Ok(EchoOutput { value: input.value })
    }
}

#[async_trait]
impl TypedTool for ZetaTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "zeta_tool";
    const ORDER: u16 = 20;
    const DESCRIPTION: &'static str = "Zeta";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }
    fn inspect(&self, _: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(intent(ToolMutation::ReadOnly, Vec::new()))
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        Ok(EchoOutput { value: input.value })
    }
}

struct WriteTool;

#[async_trait]
impl TypedTool for WriteTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "write_value";
    const ORDER: u16 = 30;
    const DESCRIPTION: &'static str = "Write a value";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::WRITE_FILES
    }
    fn inspect(&self, _: &EchoInput, ctx: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(ToolIntent {
            mutation: ToolMutation::Workspace,
            path_accesses: vec![praana_core::tools::PathAccessIntent {
                requested: "out.txt".into(),
                normalized_absolute: ctx.cwd.join("out.txt"),
                mode: PathAccessMode::Write,
            }],
            command: None,
            risk_facts: Vec::new(),
            timeout_ms: 5_000,
            idempotency: ToolIdempotency::IdempotentWrite,
            planned: Vec::new(),
        })
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        Ok(EchoOutput { value: input.value })
    }
}

struct PanicTool;

#[async_trait]
impl TypedTool for PanicTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "panic_value";
    const ORDER: u16 = 40;
    const DESCRIPTION: &'static str = "Panic";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }
    fn inspect(&self, _: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(intent(ToolMutation::PureCompute, Vec::new()))
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        _: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        panic!("tool body panicked");
    }
}

struct SlowTool {
    entered: Arc<AtomicUsize>,
}

#[async_trait]
impl TypedTool for SlowTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "slow_value";
    const ORDER: u16 = 50;
    const DESCRIPTION: &'static str = "Slow";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }
    fn inspect(&self, _: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(ToolIntent {
            mutation: ToolMutation::PureCompute,
            path_accesses: Vec::new(),
            command: None,
            risk_facts: Vec::new(),
            timeout_ms: 80,
            idempotency: ToolIdempotency::ReadOnly,
            planned: Vec::new(),
        })
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        cancel: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        self.entered.fetch_add(1, Ordering::SeqCst);
        tokio::select! {
            _ = cancel.cancelled() => Err(ToolError::new(ToolErrorCode::ToolCancelled, "cancelled")),
            _ = tokio::time::sleep(Duration::from_secs(30)) => Ok(EchoOutput { value: input.value }),
        }
    }
}

fn intent(mutation: ToolMutation, paths: Vec<praana_core::tools::PathAccessIntent>) -> ToolIntent {
    ToolIntent {
        mutation,
        path_accesses: paths,
        command: None,
        risk_facts: Vec::new(),
        timeout_ms: 5_000,
        idempotency: ToolIdempotency::ReadOnly,
        planned: Vec::new(),
    }
}

fn tools_config() -> ToolsConfig {
    ToolsConfig {
        allowed_paths: Vec::new(),
        default_timeout_ms: 60_000,
        max_parallel_calls: 2,
        max_spawned_processes: 2,
        shell_enabled: false,
        shell_max_timeout_ms: 600_000,
        shell_timeout_ms: 30_000,
    }
}

fn runtime_with(tools: Vec<Arc<dyn praana_core::tools::ErasedTool>>) -> ToolRuntime {
    let registry = ToolRegistry::try_from_erased(tools).unwrap();
    ToolRuntime::new(
        registry,
        tools_config(),
        RiskConfig { allow: Vec::new() },
        CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
    )
}

fn echo_runtime() -> ToolRuntime {
    runtime_with(vec![ToolAdapter::arc(EchoTool).unwrap()])
}

fn batch(name: &str, calls: Vec<ProviderToolCall>) -> ToolBatchRequest {
    let _ = name;
    ToolBatchRequest {
        batch_id: ToolBatchId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
        session_id: SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
        turn_id: TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
        attempt_id: AttemptId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
        calls,
        origin: ToolCallOrigin::Model,
    }
}

fn call(name: &str, id: &str, ordinal: u32, value: &str) -> ProviderToolCall {
    ProviderToolCall {
        tool_call_id: praana_core::protocol::id::ToolCallId::from_str_canonical(id).unwrap(),
        tool_name: ToolName::new(name).unwrap(),
        arguments: json!({"value": value}),
        provider_ordinal: ordinal,
    }
}

#[test]
fn schema_normalization_is_stable_and_hashes_normalized_bytes() {
    let raw = json!({
        "title": "EchoInput",
        "type": "object",
        "required": ["value", "extra"],
        "properties": {
            "value": {"type": "string", "title": "Value"},
            "extra": {"enum": ["b", "a"]}
        },
        "oneOf": [{
            "title": "Branch",
            "type": "object",
            "properties": {"z": {"type": "string"}, "a": {"type": "string"}}
        }]
    });
    let normalized = normalize_schema(&raw, true).unwrap();
    assert_eq!(normalized, normalize_schema(&raw, true).unwrap());
    assert!(normalized.get("title").is_none());
    assert_eq!(normalized["required"], json!(["extra", "value"]));
    assert_eq!(normalized["properties"]["extra"]["enum"], json!(["b", "a"]));
    assert_eq!(normalized["additionalProperties"], json!(false));
    assert!(normalized["oneOf"][0].get("title").is_none());
    let keys: Vec<_> = normalized["oneOf"][0]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(keys, vec!["a".to_owned(), "z".to_owned()]);
    let bytes = serde_json::to_vec(&normalized).unwrap();
    let digest = praana_core::protocol::id::Sha256Digest::digest_bytes(&bytes);
    assert_eq!(
        digest.as_str(),
        include_str!("fixtures/tool_schema_echo_v1.sha256").trim()
    );
}

#[test]
fn registry_startup_rejects_invalid_required_schema() {
    let err = normalize_schema(&json!({"type": "array"}), true).unwrap_err();
    assert!(matches!(err, SchemaError::NotObject));
}

#[test]
fn catalog_order_ignores_registration_permutation() {
    let first = ToolRegistry::try_from_erased(vec![
        ToolAdapter::arc(ZetaTool).unwrap(),
        ToolAdapter::arc(AlphaTool).unwrap(),
    ])
    .unwrap();
    let second = ToolRegistry::try_from_erased(vec![
        ToolAdapter::arc(AlphaTool).unwrap(),
        ToolAdapter::arc(ZetaTool).unwrap(),
    ])
    .unwrap();
    let names = |reg: &ToolRegistry| {
        reg.catalog()
            .descriptors()
            .iter()
            .map(|d| d.name.as_str().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&first), names(&second));
    assert_eq!(
        names(&first),
        vec!["alpha_tool".to_owned(), "zeta_tool".to_owned()]
    );
    assert_eq!(first.catalog_hash(), second.catalog_hash());
}

#[test]
fn inspect_does_not_execute() {
    let executed = Arc::new(AtomicUsize::new(0));
    let tool = EchoTool;
    let input = EchoInput {
        value: "same".into(),
    };
    let ctx = ToolInspectContext {
        cwd: PathBuf::from("/tmp"),
        plan_mode: false,
    };
    let first = tool.inspect(&input, &ctx).unwrap();
    let second = tool.inspect(&input, &ctx).unwrap();
    assert_eq!(first, second);
    assert_eq!(executed.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn success_runs_full_hook_order_and_canonical_bytes_are_stable() {
    let rt = echo_runtime();
    let finished = rt
        .execute_batch(
            batch("echo", vec![call("echo_value", "call-1", 0, "ok")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        rt.trace().snapshot(),
        vec![
            "plan".to_owned(),
            "validate".to_owned(),
            "risk".to_owned(),
            "circuit".to_owned(),
            "write_lock".to_owned(),
            "execute".to_owned(),
            "lsp".to_owned(),
            "verify".to_owned(),
            "enrich".to_owned(),
            "redact".to_owned(),
            "circuit_account".to_owned(),
            "write_lock_release".to_owned(),
        ]
    );
    let dto = &finished.results[0].dto;
    assert!(dto.ok);
    assert_eq!(
        finished.results[0].canonical_bytes,
        canonical_tool_result_bytes(dto).unwrap()
    );
    assert!(!finished.results[0].canonical_bytes.ends_with(b"\n"));
}

#[tokio::test]
async fn plan_block_does_not_acquire_a_lock() {
    let rt = runtime_with(vec![ToolAdapter::arc(WriteTool).unwrap()]);
    rt.set_plan_mode(true);
    let finished = rt
        .execute_batch(
            batch("write", vec![call("write_value", "call-block", 0, "x")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let trace = rt.trace().snapshot();
    assert!(trace.contains(&"plan".to_owned()));
    assert!(!trace
        .iter()
        .any(|stage| stage == "write_lock" || stage == "execute"));
    assert_eq!(rt.locks().held_count(), 0);
    assert!(!finished.results[0].execution_started);
    assert_eq!(
        finished.results[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolPlanBlocked
    );
    assert_eq!(
        map_tool_error(ToolErrorCode::ToolPlanBlocked).status,
        ToolResultStatus::Blocked
    );
}

#[tokio::test]
async fn panic_releases_the_lock() {
    let rt = runtime_with(vec![ToolAdapter::arc(PanicTool).unwrap()]);
    let finished = rt
        .execute_batch(
            batch("panic", vec![call("panic_value", "call-panic", 0, "x")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        finished.results[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolPanicked
    );
    assert_eq!(rt.locks().held_count(), 0);
    assert!(rt
        .trace()
        .snapshot()
        .ends_with(&["write_lock_release".to_owned()]));
}

#[test]
fn path_alias_cannot_bypass_exclusion() {
    let table = PathLockTable::new();
    let cwd = PathBuf::from("/tmp/workspace");
    let _held = table
        .try_acquire(&cwd, "dir/../file.txt", true, "call-a")
        .unwrap();
    let busy = table.try_acquire(&cwd, "file.txt", false, "call-b");
    assert_eq!(busy.unwrap_err().code(), ToolErrorCode::ToolPathBusy);
}

#[test]
fn error_codes_map_to_protocol_status_and_class() {
    let mapped = map_tool_error(ToolErrorCode::ToolPathBusy);
    assert_eq!(mapped.canonical_code, "TOOL_PATH_BUSY");
    assert_eq!(mapped.class, ErrorClass::Conflict);
    assert_eq!(mapped.status, ToolResultStatus::Blocked);
    assert!(mapped.retryable);
    let redaction = map_tool_error(ToolErrorCode::ToolRedactionFailed);
    assert_eq!(redaction.canonical_code, "TOOL_REDACTION_FAILED");
    assert_eq!(redaction.class, ErrorClass::Integrity);
    let skipped = map_skipped_uncertain_peer();
    assert_eq!(skipped.status, ToolResultStatus::Skipped);
    assert_eq!(skipped.canonical_code, "E_TOOL_SKIPPED_UNCERTAIN_PEER");
    let uncertain = map_side_effect_uncertain();
    assert_eq!(uncertain.status, ToolResultStatus::Uncertain);
    assert_eq!(uncertain.canonical_code, "E_TOOL_SIDE_EFFECT_UNCERTAIN");
    assert_eq!(
        map_tool_error(ToolErrorCode::ToolCancelled).status,
        ToolResultStatus::Cancelled
    );
}

#[test]
fn blocked_cancelled_and_skipped_results_are_complete() {
    let blocked = ToolResultDto::failure(
        ToolErrorCode::ToolPlanBlocked,
        "blocked",
        false,
        "echo_value",
        "call-1",
    );
    assert!(!blocked.ok && blocked.data.is_none() && blocked.error.is_some());
    assert!(canonical_tool_result_bytes(&blocked).is_ok());
    let skipped = map_skipped_uncertain_peer();
    assert_eq!(skipped.status, ToolResultStatus::Skipped);
}

#[tokio::test]
async fn cancellation_before_preflight_yields_cancelled_result() {
    let rt = echo_runtime();
    let token = CancellationToken::new();
    token.cancel();
    let finished = rt
        .execute_batch(
            batch("echo", vec![call("echo_value", "call-cancel", 0, "x")]),
            BatchOrigin::Model,
            token,
        )
        .await
        .unwrap();
    assert_eq!(
        finished.results[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolCancelled
    );
    assert!(finished.results[0].dto.meta.cancelled);
    assert!(!finished.results[0].execution_started);
}

#[test]
fn cancelling_a_parent_cancels_descendants() {
    let hub = praana_core::tools::CancelHub::new();
    let session = hub.session();
    let turn = praana_core::tools::CancelHub::child(&session);
    let call = praana_core::tools::CancelHub::child(&turn);
    session.cancel();
    assert!(turn.is_cancelled());
    assert!(call.is_cancelled());
}

#[tokio::test]
async fn timeout_returns_timed_out_for_a_slow_tool() {
    let entered = Arc::new(AtomicUsize::new(0));
    let rt = runtime_with(vec![ToolAdapter::arc(SlowTool { entered }).unwrap()]);
    let finished = rt
        .execute_batch(
            batch("slow", vec![call("slow_value", "call-slow", 0, "x")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        finished.results[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolTimedOut
    );
    assert!(finished.results[0].dto.meta.timed_out);
}

#[tokio::test]
async fn secret_canary_is_removed_from_the_canonical_result() {
    let rt = echo_runtime();
    let finished = rt
        .execute_batch(
            batch("echo", vec![call("echo_value", "call-secret", 0, &aws())]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let bytes = String::from_utf8(finished.results[0].canonical_bytes.clone()).unwrap();
    assert!(!bytes.contains(&aws()));
    assert!(bytes.contains("[REDACTED:aws-access-key]"));
}

#[tokio::test]
async fn process_tree_is_killed_on_timeout_and_cancel() {
    let cwd = std::env::temp_dir();
    let timed = supervise(SuperviseRequest {
        command: "sleep 30".into(),
        cwd: cwd.clone(),
        env: std::env::vars().collect(),
        timeout: Duration::from_millis(200),
        cancel: CancellationToken::new(),
        session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
        stdout_limit: 4096,
        stderr_limit: 4096,
        argv: None,
        process_slots: None,
    })
    .await
    .unwrap();
    assert!(timed.timed_out);
    if let Some(group) = timed.group_id {
        assert!(!praana_core::process::unix::group_alive(group as i32));
    }
    let cancel = CancellationToken::new();
    let child = cancel.clone();
    let task = tokio::spawn(async move {
        supervise(SuperviseRequest {
            command: "sleep 30".into(),
            cwd,
            env: std::env::vars().collect(),
            timeout: Duration::from_secs(30),
            cancel: child,
            session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
            stdout_limit: 4096,
            stderr_limit: 4096,
            argv: None,
            process_slots: None,
        })
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    cancel.cancel();
    let cancelled = task.await.unwrap().unwrap();
    assert!(cancelled.cancelled);
}

struct DuplicateOrderTool;

#[async_trait]
impl TypedTool for DuplicateOrderTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "beta_tool";
    const ORDER: u16 = 10;
    const DESCRIPTION: &'static str = "Duplicate order";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }
    fn inspect(&self, _: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(intent(ToolMutation::ReadOnly, Vec::new()))
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        Ok(EchoOutput { value: input.value })
    }
}

struct ConcurrencyTool {
    inflight: Arc<AtomicUsize>,
    max_seen: Arc<AtomicUsize>,
}

#[async_trait]
impl TypedTool for ConcurrencyTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "parallel_value";
    const ORDER: u16 = 60;
    const DESCRIPTION: &'static str = "Parallel";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }
    fn inspect(&self, _: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(intent(ToolMutation::PureCompute, Vec::new()))
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        let now = self.inflight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_seen.fetch_max(now, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(150)).await;
        self.inflight.fetch_sub(1, Ordering::SeqCst);
        Ok(EchoOutput { value: input.value })
    }
}

#[test]
fn registry_rejects_duplicate_order_at_startup() {
    let err = ToolRegistry::try_from_erased(vec![
        ToolAdapter::arc(AlphaTool).unwrap(),
        ToolAdapter::arc(DuplicateOrderTool).unwrap(),
    ]);
    assert!(err.is_err());
}

#[tokio::test]
async fn concurrency_limit_is_enforced() {
    let inflight = Arc::new(AtomicUsize::new(0));
    let max_seen = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::try_from_erased(vec![ToolAdapter::arc(ConcurrencyTool {
        inflight,
        max_seen: Arc::clone(&max_seen),
    })
    .unwrap()])
    .unwrap();
    let mut config = tools_config();
    config.max_parallel_calls = 1;
    let rt = ToolRuntime::new(
        registry,
        config,
        RiskConfig { allow: Vec::new() },
        CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
    );
    let finished = rt
        .execute_batch(
            batch(
                "parallel",
                vec![
                    call("parallel_value", "call-p1", 0, "a"),
                    call("parallel_value", "call-p2", 1, "b"),
                ],
            ),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(finished.results.iter().all(|result| result.dto.ok));
    assert_eq!(max_seen.load(Ordering::SeqCst), 1);
}

#[test]
fn sanitized_env_drops_provider_keys_and_sets_tool_marker() {
    let mut parent = std::collections::HashMap::new();
    parent.insert("PATH".into(), "/usr/bin".into());
    parent.insert("OPENAI_API_KEY".into(), aws());
    let clean = praana_core::process::env::sanitize_env(&parent, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert!(!clean.keys().any(|key| key == "OPENAI_API_KEY"));
    assert_eq!(clean.get("PRAANA_TOOL").map(String::as_str), Some("1"));
    assert_eq!(clean.get("PATH").map(String::as_str), Some("/usr/bin"));
    let block = praana_core::process::env::unicode_environment_block(&clean);
    let rendered = String::from_utf16_lossy(&block);
    assert!(rendered.contains("PATH=/usr/bin"));
    assert!(rendered.contains("PRAANA_TOOL=1"));
    assert!(!rendered.contains("OPENAI_API_KEY"));
    assert!(block.ends_with(&[0, 0]));
}

struct MissingReadTool;

#[async_trait]
impl TypedTool for MissingReadTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "missing_read";
    const ORDER: u16 = 70;
    const DESCRIPTION: &'static str = "Read a missing path";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::READ_FILES
    }
    fn inspect(&self, _: &EchoInput, ctx: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(ToolIntent {
            mutation: ToolMutation::ReadOnly,
            path_accesses: vec![praana_core::tools::PathAccessIntent {
                requested: "missing-file.txt".into(),
                normalized_absolute: ctx.cwd.join("missing-file.txt"),
                mode: PathAccessMode::Read,
            }],
            command: None,
            risk_facts: Vec::new(),
            timeout_ms: 5_000,
            idempotency: ToolIdempotency::ReadOnly,
            planned: Vec::new(),
        })
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        Ok(EchoOutput { value: input.value })
    }
}

#[tokio::test]
async fn validation_failure_is_returned_without_a_lock() {
    let rt = runtime_with(vec![ToolAdapter::arc(MissingReadTool).unwrap()]);
    let finished = rt
        .execute_batch(
            batch("missing", vec![call("missing_read", "call-m", 0, "x")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        finished.results[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolPathNotFound
    );
    assert_eq!(rt.locks().held_count(), 0);
}

#[tokio::test]
async fn same_path_later_ordinal_is_busy() {
    let rt = runtime_with(vec![ToolAdapter::arc(WriteTool).unwrap()]);
    rt.set_plan_mode(false);
    let finished = rt
        .execute_batch(
            batch(
                "busy",
                vec![
                    call("write_value", "call-w1", 1, "later"),
                    call("write_value", "call-w2", 0, "earlier"),
                ],
            ),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(finished.results[0].dto.ok);
    assert_eq!(
        finished.results[1].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolPathBusy
    );
}

#[tokio::test]
async fn symlink_alias_shares_the_lock() {
    let root = std::env::temp_dir().join(format!("praana-lock-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("real")).unwrap();
    std::fs::write(root.join("real/file.txt"), b"x").unwrap();
    std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
    let direct = praana_core::tools::canonical_lock_key(&root, "real/file.txt").unwrap();
    let via = praana_core::tools::canonical_lock_key(&root, "link/file.txt").unwrap();
    assert_eq!(direct, via);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn headless_risk_denies_without_allow() {
    let rt = runtime_with(vec![ToolAdapter::arc(RiskTool).unwrap()]);
    let finished = rt
        .execute_batch(
            batch("risk", vec![call("risk_value", "call-r", 0, "x")]),
            BatchOrigin::HeadlessCommand,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        finished.results[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolRiskHeadlessDenied
    );
}

struct RiskTool;

#[async_trait]
impl TypedTool for RiskTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "risk_value";
    const ORDER: u16 = 80;
    const DESCRIPTION: &'static str = "Risky";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }
    fn inspect(&self, _: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(ToolIntent {
            mutation: ToolMutation::External,
            path_accesses: Vec::new(),
            command: None,
            risk_facts: vec![praana_core::tools::RiskFact::Rm],
            timeout_ms: 5_000,
            idempotency: ToolIdempotency::NonIdempotent,
            planned: Vec::new(),
        })
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        Ok(EchoOutput { value: input.value })
    }
}

struct RecordingCommit {
    hit: Arc<AtomicUsize>,
}

impl praana_core::tools::ResultCommit for RecordingCommit {
    fn commit(&self, finished: &praana_core::tools::FinishedCall) {
        assert!(finished.dto.ok);
        self.hit.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn result_commit_runs_after_the_lock_is_released() {
    let hit = Arc::new(AtomicUsize::new(0));
    let rt = echo_runtime();
    rt.set_result_commit(Arc::new(RecordingCommit {
        hit: Arc::clone(&hit),
    }));
    let finished = rt
        .execute_batch(
            batch("commit", vec![call("echo_value", "call-c", 0, "ok")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(finished.results[0].dto.ok);
    assert_eq!(hit.load(Ordering::SeqCst), 1);
    assert!(rt
        .trace()
        .snapshot()
        .ends_with(&["write_lock_release".to_owned()]));
    assert_eq!(rt.locks().held_count(), 0);
}

struct FailingTool;

#[async_trait]
impl TypedTool for FailingTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "fail_value";
    const ORDER: u16 = 90;
    const DESCRIPTION: &'static str = "Fail";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::WRITE_FILES
    }
    fn inspect(&self, _: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(ToolIntent {
            mutation: ToolMutation::Workspace,
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
        _: ToolExecutionContext,
        _: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        Err(ToolError::new(ToolErrorCode::ToolIoFailed, "failed"))
    }
}

#[tokio::test]
async fn two_failures_block_the_third_attempt() {
    let rt = runtime_with(vec![ToolAdapter::arc(FailingTool).unwrap()]);
    for id in ["fail-1", "fail-2"] {
        let finished = rt
            .execute_batch(
                batch("fail", vec![call("fail_value", id, 0, "x")]),
                BatchOrigin::Model,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            finished.results[0].dto.error.as_ref().unwrap().code,
            ToolErrorCode::ToolIoFailed
        );
    }
    let finished = rt
        .execute_batch(
            batch("fail", vec![call("fail_value", "fail-3", 0, "x")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        finished.results[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolCircuitOpen
    );
}

struct StuckTool;

#[async_trait]
impl TypedTool for StuckTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "stuck_value";
    const ORDER: u16 = 91;
    const DESCRIPTION: &'static str = "Stuck";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::WRITE_FILES
    }
    fn inspect(&self, _: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(ToolIntent {
            mutation: ToolMutation::Workspace,
            path_accesses: Vec::new(),
            command: None,
            risk_facts: Vec::new(),
            timeout_ms: 40,
            idempotency: ToolIdempotency::NonIdempotent,
            planned: Vec::new(),
        })
    }
    async fn execute(
        &self,
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        tokio::time::sleep(Duration::from_secs(30)).await;
        Ok(EchoOutput { value: input.value })
    }
}

#[tokio::test]
async fn uncooperative_side_effect_timeout_is_uncertain() {
    let rt = runtime_with(vec![ToolAdapter::arc(StuckTool).unwrap()]);
    let finished = rt
        .execute_batch(
            batch("stuck", vec![call("stuck_value", "stuck-1", 0, "x")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(finished.poisoned);
    assert_eq!(finished.results[0].status, ToolResultStatus::Uncertain);
    let details = finished.results[0]
        .dto
        .error
        .as_ref()
        .unwrap()
        .details
        .as_ref()
        .unwrap()
        .as_str()
        .unwrap();
    assert_eq!(details, "E_TOOL_SIDE_EFFECT_UNCERTAIN");
}

struct WriterTool;

#[async_trait]
impl TypedTool for WriterTool {
    type Input = EchoInput;
    type Output = EchoOutput;
    const NAME: &'static str = "writer_value";
    const ORDER: u16 = 92;
    const DESCRIPTION: &'static str = "Writes until stopped";
    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::WRITE_FILES
    }
    fn inspect(&self, input: &EchoInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(ToolIntent {
            mutation: ToolMutation::Workspace,
            path_accesses: vec![praana_core::tools::PathAccessIntent {
                requested: input.value.clone(),
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
        _: ToolExecutionContext,
        input: EchoInput,
        _: CancellationToken,
    ) -> Result<EchoOutput, ToolError> {
        loop {
            let _ = std::fs::write(&input.value, b"still-writing");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

#[tokio::test]
async fn uncooperative_writer_keeps_its_lock_and_records_the_execution() {
    let dir = tempfile::tempdir().unwrap();
    let note = dir.path().join("note.txt");
    let rt = runtime_with(vec![ToolAdapter::arc(WriterTool).unwrap()]);
    rt.set_workspace(dir.path().to_path_buf());
    let finished = rt
        .execute_batch(
            batch(
                "writer",
                vec![call("writer_value", "writer-1", 0, note.to_str().unwrap())],
            ),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(finished.poisoned);
    assert_eq!(finished.results[0].status, ToolResultStatus::Uncertain);
    assert_eq!(finished.uncertain_execution_ids.len(), 1);
    assert_eq!(rt.locks().held_count(), 1);
    assert_eq!(std::fs::read(&note).unwrap(), b"still-writing");
    drop(rt);
    tokio::time::sleep(Duration::from_millis(150)).await;
    std::fs::write(&note, b"probe").unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(std::fs::read(&note).unwrap(), b"probe");
}

#[test]
fn dropping_poisoned_runtime_outside_the_async_context_stops_the_writer() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let note = dir.path().join("note.txt");
    let workspace = dir.path().to_path_buf();
    let note_for_run = note.clone();
    let tool_rt = runtime.block_on(async move {
        let rt = runtime_with(vec![ToolAdapter::arc(WriterTool).unwrap()]);
        rt.set_workspace(workspace);
        let finished = rt
            .execute_batch(
                batch(
                    "writer",
                    vec![call(
                        "writer_value",
                        "writer-1",
                        0,
                        note_for_run.to_str().unwrap(),
                    )],
                ),
                BatchOrigin::Model,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(finished.poisoned);
        assert_eq!(rt.locks().held_count(), 1);
        rt
    });
    assert!(tokio::runtime::Handle::try_current().is_err());
    drop(tool_rt);
    std::fs::write(&note, b"probe").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(std::fs::read(&note).unwrap(), b"probe");
}

#[tokio::test]
async fn grandchild_and_term_ignored_processes_are_reaped() {
    let cwd = std::env::temp_dir();
    let timed = supervise(SuperviseRequest {
        command: "sleep 30 & wait".into(),
        cwd: cwd.clone(),
        env: std::env::vars().collect(),
        timeout: Duration::from_millis(200),
        cancel: CancellationToken::new(),
        session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
        stdout_limit: 4096,
        stderr_limit: 4096,
        argv: None,
        process_slots: None,
    })
    .await
    .unwrap();
    assert!(timed.timed_out);
    if let Some(group) = timed.group_id {
        assert!(!praana_core::process::unix::group_alive(group as i32));
    }
    let ignored = supervise(SuperviseRequest {
        command: "trap '' TERM; sleep 30".into(),
        cwd,
        env: std::env::vars().collect(),
        timeout: Duration::from_millis(200),
        cancel: CancellationToken::new(),
        session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
        stdout_limit: 4096,
        stderr_limit: 4096,
        argv: None,
        process_slots: None,
    })
    .await
    .unwrap();
    assert!(ignored.timed_out);
    if let Some(group) = ignored.group_id {
        assert!(!praana_core::process::unix::group_alive(group as i32));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn descendant_holding_a_pipe_is_reaped_after_leader_exit() {
    let started = std::time::Instant::now();
    let output = supervise(SuperviseRequest {
        command: "trap '' HUP; sleep 30 >/dev/fd/1 & disown; exit 0".into(),
        cwd: std::env::temp_dir(),
        env: std::env::vars().collect(),
        timeout: Duration::from_secs(8),
        cancel: CancellationToken::new(),
        session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
        stdout_limit: 4096,
        stderr_limit: 4096,
        argv: None,
        process_slots: None,
    })
    .await
    .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "elapsed {:?}",
        started.elapsed()
    );
    if let Some(group) = output.group_id {
        assert!(!praana_core::process::unix::group_alive(group as i32));
    }
}

#[tokio::test]
async fn process_stdout_is_redacted() {
    let token = aws();
    let timed = supervise(SuperviseRequest {
        command: format!("printf '%s' {token}"),
        cwd: std::env::temp_dir(),
        env: std::env::vars().collect(),
        timeout: Duration::from_secs(5),
        cancel: CancellationToken::new(),
        session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
        stdout_limit: 4096,
        stderr_limit: 4096,
        argv: None,
        process_slots: None,
    })
    .await
    .unwrap();
    let stdout = String::from_utf8(timed.stdout).unwrap();
    assert!(!stdout.contains(&token));
    assert!(stdout.contains("[REDACTED:aws-access-key]"));
}

struct ApproveRm;

#[async_trait]
impl praana_core::hooks::risk::RiskDecider for ApproveRm {
    async fn confirm(&self, request: &praana_core::hooks::risk::RiskConfirm) -> bool {
        request.class_name == "rm" && request.call_id == "risk-ok"
    }
}

#[tokio::test]
async fn tty_risk_confirm_is_bound_to_the_call() {
    let rt = runtime_with(vec![ToolAdapter::arc(RiskTool).unwrap()]);
    rt.set_headless(false);
    rt.set_risk_decider(Arc::new(ApproveRm));
    let approved = rt
        .execute_batch(
            batch("risk", vec![call("risk_value", "risk-ok", 0, "x")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(approved.results[0].dto.ok);
    let denied = rt
        .execute_batch(
            batch("risk", vec![call("risk_value", "risk-other", 0, "x")]),
            BatchOrigin::Model,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        denied.results[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolRiskDeclined
    );
}
