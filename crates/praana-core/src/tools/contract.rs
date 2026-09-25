//! Inert tool catalog contract required before the P2B provider adapter.
//!
//! Normative owner: `docs/RUST_V2_TOOL_RUNTIME_SPEC.md` §6.1.
//! This module does not execute tools.

use bitflags::bitflags;
use serde_json::Value;

use crate::protocol::id::Sha256Digest;

bitflags! {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct ToolCapabilities: u32 {
        const READ_FILES       = 1 << 0;
        const WRITE_FILES      = 1 << 1;
        const SPAWN_PROCESS    = 1 << 2;
        const NETWORK_POSSIBLE = 1 << 3;
        const GIT_READ         = 1 << 4;
        const GIT_WRITE        = 1 << 5;
        const STATE_READ       = 1 << 6;
        const STATE_WRITE      = 1 << 7;
        const ARTIFACT_READ    = 1 << 8;
        const MEMORY_READ      = 1 << 9;
        const MEMORY_WRITE     = 1 << 10;
        const LSP_READ         = 1 << 11;
        const LSP_WRITE        = 1 << 12;
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ToolName(String);

impl ToolName {
    pub fn new(name: &str) -> Result<Self, ToolContractError> {
        let bytes = name.as_bytes();
        let valid = (1..=64).contains(&bytes.len())
            && bytes[0].is_ascii_lowercase()
            && bytes[1..]
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_');
        if !valid {
            return Err(ToolContractError::InvalidName(name.to_owned()));
        }
        Ok(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolDescriptor {
    pub name: ToolName,
    pub order: u16,
    pub description: String,
    pub strict: bool,
    pub input_schema: Value,
    pub output_schema: Value,
    pub capabilities: ToolCapabilities,
    pub schema_sha256: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCatalog {
    descriptors: Vec<ToolDescriptor>,
}

impl ToolCatalog {
    pub fn try_from_descriptors(
        mut descriptors: Vec<ToolDescriptor>,
    ) -> Result<Self, ToolContractError> {
        let mut names = std::collections::BTreeSet::new();
        let mut orders = std::collections::BTreeSet::new();
        for descriptor in &descriptors {
            validate_descriptor(descriptor)?;
            if !names.insert(descriptor.name.as_str().to_owned()) {
                return Err(ToolContractError::DuplicateName(
                    descriptor.name.as_str().to_owned(),
                ));
            }
            if !orders.insert(descriptor.order) {
                return Err(ToolContractError::DuplicateOrder(descriptor.order));
            }
        }
        descriptors.sort_by_key(|descriptor| descriptor.order);
        Ok(Self { descriptors })
    }

    pub fn descriptors(&self) -> &[ToolDescriptor] {
        &self.descriptors
    }
}

fn validate_descriptor(descriptor: &ToolDescriptor) -> Result<(), ToolContractError> {
    if !descriptor.strict {
        return Err(ToolContractError::StrictRequired);
    }
    let description = descriptor.description.as_bytes();
    if description.is_empty() || description.len() > 4096 || descriptor.description.contains('\0') {
        return Err(ToolContractError::InvalidDescription);
    }
    let Some(object) = descriptor.input_schema.as_object() else {
        return Err(ToolContractError::InputSchemaNotObject);
    };
    if object.get("type").and_then(Value::as_str) != Some("object") {
        return Err(ToolContractError::InputSchemaNotObject);
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolContractError {
    InvalidName(String),
    DuplicateName(String),
    DuplicateOrder(u16),
    StrictRequired,
    InvalidDescription,
    InputSchemaNotObject,
}

impl std::fmt::Display for ToolContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidName(name) => write!(f, "TOOL_NAME_INVALID: {name}"),
            Self::DuplicateName(name) => write!(f, "TOOL_NAME_DUPLICATE: {name}"),
            Self::DuplicateOrder(order) => write!(f, "TOOL_ORDER_DUPLICATE: {order}"),
            Self::StrictRequired => f.write_str("TOOL_STRICT_REQUIRED"),
            Self::InvalidDescription => f.write_str("TOOL_DESCRIPTION_INVALID"),
            Self::InputSchemaNotObject => f.write_str("TOOL_INPUT_SCHEMA_NOT_OBJECT"),
        }
    }
}

impl std::error::Error for ToolContractError {}
