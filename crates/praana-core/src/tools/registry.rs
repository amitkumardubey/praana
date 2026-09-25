//! Schema normalization and the ordered registry. No built-in is registered here.

use std::collections::BTreeMap;
use std::sync::Arc;

use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::protocol::id::Sha256Digest;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::contract::{
    raw_contains_nul, ErasedTool, PreparedToolCall, ToolCatalog, ToolContractError, ToolDescriptor,
    TypedTool,
};
use super::error::{ToolError, ToolErrorCode};
use super::intent::{ToolExecutionContext, ToolInspectContext};
use super::ToolName;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SchemaError {
    NotObject,
    Generate,
    Recursive,
    Normalize,
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotObject => f.write_str("TOOL_INPUT_SCHEMA_NOT_OBJECT"),
            Self::Generate => f.write_str("schema generation failed"),
            Self::Recursive => f.write_str("recursive tool schema"),
            Self::Normalize => f.write_str("schema normalization failed"),
        }
    }
}

impl std::error::Error for SchemaError {}

pub fn normalize_schema(schema: &Value, request: bool) -> Result<Value, SchemaError> {
    let mut schema = schema.clone();
    inline_refs(&mut schema)?;
    let normalized = normalize_node(&schema, request)?;
    let Some(object) = normalized.as_object() else {
        return Err(SchemaError::NotObject);
    };
    if request && object.get("type").and_then(Value::as_str) != Some("object") {
        return Err(SchemaError::NotObject);
    }
    Ok(normalized)
}

fn inline_refs(schema: &mut Value) -> Result<(), SchemaError> {
    let defs = schema
        .as_object()
        .and_then(|object| object.get("$defs"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    inline_in(schema, &defs, &mut Vec::new())?;
    if let Some(object) = schema.as_object_mut() {
        object.remove("$defs");
    }
    Ok(())
}

fn inline_in(node: &mut Value, defs: &Value, stack: &mut Vec<String>) -> Result<(), SchemaError> {
    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        let name = reference
            .strip_prefix("#/$defs/")
            .ok_or(SchemaError::Normalize)?
            .to_owned();
        if stack.iter().any(|seen| seen == &name) {
            return Err(SchemaError::Recursive);
        }
        let replacement = defs.get(&name).cloned().ok_or(SchemaError::Normalize)?;
        stack.push(name);
        *node = replacement;
        inline_in(node, defs, stack)?;
        stack.pop();
        return Ok(());
    }
    match node {
        Value::Array(items) => {
            for item in items {
                inline_in(item, defs, stack)?;
            }
        }
        Value::Object(map) => {
            for value in map.values_mut() {
                inline_in(value, defs, stack)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn normalize_node(node: &Value, request: bool) -> Result<Value, SchemaError> {
    match node {
        Value::Object(map) => {
            let mut out = Map::new();
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            for key in keys {
                if key == "title" || key == "$defs" {
                    continue;
                }
                let mut child = if key == "enum" {
                    map[key].clone()
                } else if matches!(key.as_str(), "oneOf" | "anyOf" | "prefixItems") {
                    normalize_node(&map[key], request)?
                } else if key == "required" {
                    sort_required(&map[key])?
                } else {
                    normalize_node(&map[key], request && key != "enum")?
                };
                if key == "properties" {
                    child = normalize_node(&map[key], request)?;
                }
                out.insert(key.clone(), child);
            }
            if request
                && (out.get("type").and_then(Value::as_str) == Some("object")
                    || out.contains_key("properties"))
            {
                out.insert("additionalProperties".to_owned(), Value::Bool(false));
            }
            Ok(Value::Object(out))
        }
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(normalize_node(item, request)?);
            }
            Ok(Value::Array(out))
        }
        other => Ok(other.clone()),
    }
}

fn sort_required(value: &Value) -> Result<Value, SchemaError> {
    let Some(items) = value.as_array() else {
        return Err(SchemaError::Normalize);
    };
    let mut names: Vec<String> = items
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    names.sort();
    Ok(Value::Array(names.into_iter().map(Value::String).collect()))
}

pub fn schema_digest(input: &Value, output: &Value) -> Result<Sha256Digest, SchemaError> {
    let mut bytes = serde_json::to_vec(input).map_err(|_| SchemaError::Normalize)?;
    bytes.push(0);
    bytes.extend(serde_json::to_vec(output).map_err(|_| SchemaError::Normalize)?);
    Ok(Sha256Digest::digest_bytes(&bytes))
}

pub struct ToolRegistry {
    by_name: BTreeMap<ToolName, Arc<dyn ErasedTool>>,
    catalog: ToolCatalog,
    catalog_hash: Sha256Digest,
}

impl ToolRegistry {
    pub fn try_from_erased(tools: Vec<Arc<dyn ErasedTool>>) -> Result<Self, ToolError> {
        let mut descriptors = Vec::new();
        let mut by_name = BTreeMap::new();
        for tool in tools {
            let descriptor = tool.descriptor().clone();
            if by_name.contains_key(&descriptor.name) {
                return Err(ToolError::new(
                    ToolErrorCode::ToolInternal,
                    "duplicate tool name",
                ));
            }
            by_name.insert(descriptor.name.clone(), tool);
            descriptors.push(descriptor);
        }
        let catalog = ToolCatalog::try_from_descriptors(descriptors).map_err(contract_error)?;
        let catalog_hash = hash_catalog(&catalog);
        Ok(Self {
            by_name,
            catalog,
            catalog_hash,
        })
    }

    pub fn try_from_typed(tools: Vec<Arc<dyn ErasedTool>>) -> Result<Self, ToolError> {
        Self::try_from_erased(tools)
    }

    pub fn catalog(&self) -> &ToolCatalog {
        &self.catalog
    }

    pub fn catalog_hash(&self) -> &Sha256Digest {
        &self.catalog_hash
    }

    pub fn get(&self, name: &ToolName) -> Option<Arc<dyn ErasedTool>> {
        self.by_name.get(name).cloned()
    }
}

fn hash_catalog(catalog: &ToolCatalog) -> Sha256Digest {
    let mut bytes = Vec::new();
    for descriptor in catalog.descriptors() {
        bytes.extend(descriptor.name.as_str().as_bytes());
        bytes.push(0);
        bytes.extend(descriptor.schema_sha256.as_str().as_bytes());
        bytes.push(0);
        bytes.extend(descriptor.description.as_bytes());
    }
    Sha256Digest::digest_bytes(&bytes)
}

fn contract_error(error: ToolContractError) -> ToolError {
    ToolError::new(ToolErrorCode::ToolSchemaInvalid, error.to_string())
}

pub fn generated_schemas<I, O>() -> Result<(Value, Value, Sha256Digest), SchemaError>
where
    I: JsonSchema,
    O: JsonSchema + Serialize,
{
    let input_raw =
        serde_json::to_value(schemars::schema_for!(I)).map_err(|_| SchemaError::Generate)?;
    let output_raw =
        serde_json::to_value(schemars::schema_for!(O)).map_err(|_| SchemaError::Generate)?;
    let input = normalize_schema(&input_raw, true)?;
    let output = normalize_schema(&output_raw, false)?;
    let digest = schema_digest(&input, &output)?;
    Ok((input, output, digest))
}

pub struct ToolAdapter<T: TypedTool> {
    tool: T,
    descriptor: ToolDescriptor,
}

impl<T: TypedTool> ToolAdapter<T> {
    pub fn new(tool: T) -> Result<Self, SchemaError> {
        let descriptor = descriptor_for::<T>(tool.static_capabilities())?;
        Ok(Self { tool, descriptor })
    }

    pub fn arc(tool: T) -> Result<Arc<dyn ErasedTool>, SchemaError> {
        Ok(Arc::new(Self::new(tool)?))
    }
}

#[async_trait]
impl<T: TypedTool> ErasedTool for ToolAdapter<T> {
    fn descriptor(&self) -> &ToolDescriptor {
        &self.descriptor
    }

    fn parse_and_inspect(
        &self,
        raw: &Value,
        context: &ToolInspectContext,
    ) -> Result<PreparedToolCall, ToolError> {
        let bytes = serde_json::to_vec(raw).map_err(|_| {
            ToolError::new(ToolErrorCode::ToolInvalidJson, "arguments are not json")
        })?;
        if bytes.len() > 1024 * 1024 {
            return Err(ToolError::new(
                ToolErrorCode::ToolInputTooLarge,
                "arguments exceed 1 MiB",
            ));
        }
        if raw_contains_nul(raw) {
            return Err(ToolError::new(
                ToolErrorCode::ToolSchemaInvalid,
                "arguments contain NUL",
            ));
        }
        let input: T::Input = serde_json::from_value(raw.clone()).map_err(|_| {
            ToolError::new(
                ToolErrorCode::ToolSchemaInvalid,
                "arguments do not match the tool schema",
            )
        })?;
        let intent = self.tool.inspect(&input, context)?;
        Ok(PreparedToolCall {
            input: Box::new(input),
            intent,
        })
    }

    async fn execute_erased(
        &self,
        context: ToolExecutionContext,
        prepared: PreparedToolCall,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let input = prepared
            .input
            .downcast::<T::Input>()
            .map_err(|_| ToolError::new(ToolErrorCode::ToolInternal, "input type mismatch"))?;
        let output = self.tool.execute(context, *input, cancel).await?;
        serde_json::to_value(output).map_err(|_| {
            ToolError::new(
                ToolErrorCode::ToolSerializationFailed,
                "output serialization failed",
            )
        })
    }
}

pub fn descriptor_for<T: TypedTool>(
    capabilities: super::ToolCapabilities,
) -> Result<ToolDescriptor, SchemaError> {
    let (input, output, digest) = generated_schemas::<T::Input, T::Output>()?;
    let name = ToolName::new(T::NAME).map_err(|_| SchemaError::Normalize)?;
    Ok(ToolDescriptor {
        name,
        order: T::ORDER,
        description: T::DESCRIPTION.to_owned(),
        strict: true,
        input_schema: input,
        output_schema: output,
        capabilities,
        schema_sha256: digest,
    })
}
