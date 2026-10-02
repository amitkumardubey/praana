//! Tool contract, common runtime, and Phase 3 built-in tools.

mod cancellation;
mod contract;
pub mod error;
pub mod intent;
mod locks;
mod registry;
pub mod result;
mod runtime;
pub(crate) mod shell_parse;

pub mod builtin;

pub use cancellation::CancelHub;
pub use contract::{
    ErasedTool, PreparedToolCall, ToolCapabilities, ToolCatalog, ToolContractError, ToolDescriptor,
    ToolName, TypedTool,
};
pub use error::{
    history_tool_error, map_history_error, map_result_error_surface, map_side_effect_uncertain,
    map_skipped_uncertain_peer, map_tool_error, MappedToolError, ToolError, ToolErrorCode,
};
pub use intent::{
    canonical_lock_key, normalize_lexical, CommandIntent, PathAccessIntent, PathAccessMode,
    RiskFact, ToolExecutionContext, ToolIdempotency, ToolInspectContext, ToolIntent, ToolMutation,
};
pub use locks::PathLockTable;
pub use registry::{normalize_schema, SchemaError, ToolAdapter, ToolRegistry};
pub use result::{canonical_tool_result_bytes, ToolResultDto};
pub use runtime::{
    AutoHydrateOutcome, BatchFinished, BatchOrigin, DurableBatchOutcome, DurableSession,
    FinishedCall, ProviderToolCall, ResultCommit, ToolBatchRequest, ToolCallOrigin, ToolRuntime,
};
