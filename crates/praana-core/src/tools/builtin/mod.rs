//! Phase 3 built-in tools. Registration goes through the P3A registry only.

pub(crate) mod confine;
mod dto;
mod files;
mod git_read;
mod search;
mod shell;
mod tests;

use std::path::Path;
use std::sync::Arc;

use crate::config::types::ToolsConfig;
use crate::protocol::constants::BUILTIN_TOOL_CATALOG_SCHEMA_VERSION;
use crate::protocol::id::Sha256Digest;
use crate::tools::contract::{ErasedTool, ToolCapabilities, ToolDescriptor};
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::registry::{ToolAdapter, ToolRegistry};

pub use dto::*;
pub(crate) use files::apply_edit;
pub use files::{BatchEditTool, BatchWriteTool, EditFileTool, ReadFileTool, WriteFileTool};
pub use git_read::{GitDiffTool, GitStatusTool};
pub use search::{FindFilesTool, SearchCodeTool};
pub use shell::ShellTool;
pub use tests::RunTestsTool;

pub fn phase3_tools(config: &ToolsConfig) -> Result<Vec<Arc<dyn ErasedTool>>, ToolError> {
    let mut tools = vec![
        adapt(ReadFileTool)?,
        adapt(WriteFileTool)?,
        adapt(EditFileTool)?,
        adapt(BatchWriteTool)?,
        adapt(BatchEditTool)?,
        adapt(SearchCodeTool)?,
        adapt(FindFilesTool)?,
        adapt(RunTestsTool)?,
        adapt(GitStatusTool)?,
        adapt(GitDiffTool)?,
    ];
    if config.shell_enabled {
        tools.push(adapt(ShellTool)?);
    }
    Ok(tools)
}

pub fn register_phase3(config: &ToolsConfig) -> Result<ToolRegistry, ToolError> {
    ToolRegistry::try_from_erased(phase3_tools(config)?)
}

fn adapt<T: crate::tools::contract::TypedTool>(tool: T) -> Result<Arc<dyn ErasedTool>, ToolError> {
    ToolAdapter::arc(tool).map_err(|error| {
        ToolError::new(
            ToolErrorCode::ToolSchemaInvalid,
            format!("builtin schema failed: {error}"),
        )
    })
}

pub fn write_schema_snapshots(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let registry = register_phase3(&ToolsConfig {
        allowed_paths: Vec::new(),
        default_timeout_ms: 60_000,
        max_parallel_calls: 8,
        max_spawned_processes: 4,
        shell_enabled: true,
        shell_max_timeout_ms: 600_000,
        shell_timeout_ms: 30_000,
    })
    .expect("phase 3 schemas");
    let mut rows = Vec::new();
    for descriptor in registry.catalog().descriptors() {
        let input_name = format!(
            "{}-{}-input.json",
            descriptor.order,
            descriptor.name.as_str()
        );
        let output_name = format!(
            "{}-{}-output.json",
            descriptor.order,
            descriptor.name.as_str()
        );
        std::fs::write(
            dir.join(&input_name),
            serde_json::to_string_pretty(&descriptor.input_schema).unwrap() + "\n",
        )?;
        std::fs::write(
            dir.join(&output_name),
            serde_json::to_string_pretty(&descriptor.output_schema).unwrap() + "\n",
        )?;
        rows.push(manifest_row(descriptor));
    }
    let manifest = serde_json::json!({
        "catalog_schema_version": BUILTIN_TOOL_CATALOG_SCHEMA_VERSION,
        "tools": rows,
    });
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap() + "\n",
    )?;
    Ok(())
}

fn manifest_row(descriptor: &ToolDescriptor) -> serde_json::Value {
    serde_json::json!({
        "name": descriptor.name.as_str(),
        "order": descriptor.order,
        "description_sha256": Sha256Digest::digest_bytes(descriptor.description.as_bytes()).as_str(),
        "input_schema_sha256": Sha256Digest::digest_bytes(&serde_json::to_vec(&descriptor.input_schema).unwrap()).as_str(),
        "output_schema_sha256": Sha256Digest::digest_bytes(&serde_json::to_vec(&descriptor.output_schema).unwrap()).as_str(),
        "capabilities": capability_names(descriptor.capabilities),
        "strict": descriptor.strict,
    })
}

fn capability_names(capabilities: ToolCapabilities) -> Vec<&'static str> {
    let flags = [
        (ToolCapabilities::READ_FILES, "READ_FILES"),
        (ToolCapabilities::WRITE_FILES, "WRITE_FILES"),
        (ToolCapabilities::SPAWN_PROCESS, "SPAWN_PROCESS"),
        (ToolCapabilities::NETWORK_POSSIBLE, "NETWORK_POSSIBLE"),
        (ToolCapabilities::GIT_READ, "GIT_READ"),
        (ToolCapabilities::GIT_WRITE, "GIT_WRITE"),
        (ToolCapabilities::STATE_READ, "STATE_READ"),
        (ToolCapabilities::STATE_WRITE, "STATE_WRITE"),
        (ToolCapabilities::ARTIFACT_READ, "ARTIFACT_READ"),
        (ToolCapabilities::MEMORY_READ, "MEMORY_READ"),
        (ToolCapabilities::MEMORY_WRITE, "MEMORY_WRITE"),
        (ToolCapabilities::LSP_READ, "LSP_READ"),
        (ToolCapabilities::LSP_WRITE, "LSP_WRITE"),
    ];
    flags
        .into_iter()
        .filter(|(flag, _)| capabilities.contains(*flag))
        .map(|(_, name)| name)
        .collect()
}
