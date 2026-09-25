//! Tool contract and the common runtime. Built-in tools are not registered.

mod cancellation;
mod contract;
pub mod error;
pub mod intent;
mod locks;
mod registry;
pub mod result;
mod runtime;

pub use cancellation::CancelHub;
pub use contract::{
    ErasedTool, PreparedToolCall, ToolCapabilities, ToolCatalog, ToolContractError, ToolDescriptor,
    ToolName, TypedTool,
};
pub use error::{
    map_side_effect_uncertain, map_skipped_uncertain_peer, map_tool_error, MappedToolError,
    ToolError, ToolErrorCode,
};
pub use intent::{
    canonical_lock_key, normalize_lexical, CommandIntent, PathAccessIntent, PathAccessMode,
    RiskFact, ToolExecutionContext, ToolIdempotency, ToolInspectContext, ToolIntent, ToolMutation,
};
pub use locks::PathLockTable;
pub use registry::{normalize_schema, SchemaError, ToolAdapter, ToolRegistry};
pub use result::{canonical_tool_result_bytes, ToolResultDto};
pub use runtime::{
    BatchFinished, BatchOrigin, FinishedCall, ProviderToolCall, ResultCommit, ToolBatchRequest,
    ToolCallOrigin, ToolRuntime,
};
