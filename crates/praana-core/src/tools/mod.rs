//! Shared tool contract. Execution, hooks, and built-ins remain later packets.

mod contract;

pub use contract::{ToolCapabilities, ToolCatalog, ToolContractError, ToolDescriptor, ToolName};
