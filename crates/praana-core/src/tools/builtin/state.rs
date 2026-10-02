//! P4B-1 StateGraph tools (orders 200–300).

use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::protocol::id::StateId;
use crate::protocol::state_graph::{ConstraintStrength, StateKind, StateTier};
use crate::state::{
    ListQuery, StateListToolOutput, StateMutationToolOutput, StateObjectToolOutput, StateService,
    StateStatusFilter, StateWriteContext,
};
use crate::tools::contract::{ErasedTool, TypedTool};
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{
    ToolExecutionContext, ToolIdempotency, ToolInspectContext, ToolIntent, ToolMutation,
};
use crate::tools::registry::ToolRegistry;
use crate::tools::ToolCapabilities;

pub fn default_constraint_strength() -> ConstraintStrength {
    ConstraintStrength::Hard
}

pub fn default_state_limit() -> i64 {
    50
}

fn state_limit_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    serde_json::from_value(serde_json::json!({
        "default": 50,
        "type": "integer"
    }))
    .expect("state limit schema")
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CreateTaskInput {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CompleteTaskInput {
    pub id: StateId,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RetractStateInput {
    pub id: StateId,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AddConstraintInput {
    pub text: String,
    #[serde(default = "default_constraint_strength")]
    pub strength: ConstraintStrength,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DecideInput {
    pub summary: String,
    pub rationale: String,
    #[serde(default)]
    pub supersedes_id: Option<StateId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AddNoteInput {
    pub text: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateIdInput {
    pub id: StateId,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FocusTaskInput {
    pub id: StateId,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ListStateInput {
    #[serde(default)]
    pub kinds: Vec<StateKind>,
    #[serde(default)]
    pub tiers: Vec<StateTier>,
    #[serde(default)]
    pub statuses: Vec<StateStatusFilter>,
    #[serde(default)]
    pub include_retracted: bool,
    #[serde(default = "default_state_limit")]
    #[schemars(schema_with = "state_limit_schema")]
    pub limit: i64,
    #[serde(default)]
    pub cursor: Option<String>,
}

pub struct CreateTaskTool;
pub struct CompleteTaskTool;
pub struct RetractTaskTool;
pub struct AddConstraintTool;
pub struct DecideTool;
pub struct AddNoteTool;
pub struct SoftUnloadTool;
pub struct HardUnloadTool;
pub struct HydrateTool;
pub struct ListStateTool;
pub struct FocusTaskTool;

pub fn is_state_tool(name: &str) -> bool {
    matches!(
        name,
        "create_task"
            | "complete_task"
            | "retract_task"
            | "add_constraint"
            | "decide"
            | "add_note"
            | "soft_unload"
            | "hard_unload"
            | "hydrate"
            | "list_state"
            | "focus_task"
    )
}

pub fn phase4_state_tools() -> Result<Vec<Arc<dyn ErasedTool>>, ToolError> {
    Ok(vec![
        super::adapt(CreateTaskTool)?,
        super::adapt(CompleteTaskTool)?,
        super::adapt(RetractTaskTool)?,
        super::adapt(AddConstraintTool)?,
        super::adapt(DecideTool)?,
        super::adapt(AddNoteTool)?,
        super::adapt(SoftUnloadTool)?,
        super::adapt(HardUnloadTool)?,
        super::adapt(HydrateTool)?,
        super::adapt(ListStateTool)?,
        super::adapt(FocusTaskTool)?,
    ])
}

pub fn register_phase4_state() -> Result<ToolRegistry, ToolError> {
    ToolRegistry::try_from_erased(phase4_state_tools()?)
}

fn write_intent() -> ToolIntent {
    ToolIntent {
        mutation: ToolMutation::SessionState,
        path_accesses: Vec::new(),
        command: None,
        risk_facts: Vec::new(),
        timeout_ms: 30_000,
        idempotency: ToolIdempotency::NonIdempotent,
        planned: Vec::new(),
    }
}

fn read_intent() -> ToolIntent {
    ToolIntent {
        mutation: ToolMutation::ReadOnly,
        path_accesses: Vec::new(),
        command: None,
        risk_facts: Vec::new(),
        timeout_ms: 30_000,
        idempotency: ToolIdempotency::ReadOnly,
        planned: Vec::new(),
    }
}

fn unavailable<T>() -> Result<T, ToolError> {
    Err(ToolError::new(
        ToolErrorCode::ToolUnavailable,
        "state tools require a durable session",
    ))
}

pub fn run_state_tool(
    service: &mut StateService,
    ctx: &mut StateWriteContext<'_>,
    name: &str,
    arguments: &Value,
) -> Result<Value, ToolError> {
    let value = match name {
        "create_task" => {
            let input: CreateTaskInput = parse(arguments)?;
            json(service.create_task(ctx, &input.title, input.description)?)?
        }
        "complete_task" => {
            let input: CompleteTaskInput = parse(arguments)?;
            json(service.complete_task(ctx, input.id)?)?
        }
        "retract_task" => {
            let input: RetractStateInput = parse(arguments)?;
            json(service.retract(ctx, input.id, &input.reason)?)?
        }
        "add_constraint" => {
            let input: AddConstraintInput = parse(arguments)?;
            json(service.add_constraint(ctx, &input.text, input.strength)?)?
        }
        "decide" => {
            let input: DecideInput = parse(arguments)?;
            json(service.decide(ctx, &input.summary, &input.rationale, input.supersedes_id)?)?
        }
        "add_note" => {
            let input: AddNoteInput = parse(arguments)?;
            json(service.add_note(ctx, &input.text, input.tags)?)?
        }
        "soft_unload" => {
            let input: StateIdInput = parse(arguments)?;
            json(service.set_tier(ctx, input.id, StateTier::Soft)?)?
        }
        "hard_unload" => {
            let input: StateIdInput = parse(arguments)?;
            json(service.set_tier(ctx, input.id, StateTier::Hard)?)?
        }
        "hydrate" => {
            let input: StateIdInput = parse(arguments)?;
            json(service.hydrate(ctx, input.id)?)?
        }
        "focus_task" => {
            let input: FocusTaskInput = parse(arguments)?;
            json(service.focus_task(ctx, input.id)?)?
        }
        "list_state" => {
            let input: ListStateInput = parse(arguments)?;
            let session_id = *ctx.log.session_id();
            json(service.list(
                ctx.log,
                ListQuery {
                    kinds: input.kinds,
                    tiers: input.tiers,
                    statuses: input.statuses,
                    include_retracted: input.include_retracted,
                    limit: input.limit,
                    cursor: input.cursor,
                },
                session_id,
                ctx.cancelled,
            )?)?
        }
        _ => {
            return Err(ToolError::new(
                ToolErrorCode::ToolUnknown,
                "unknown state tool",
            ));
        }
    };
    Ok(value)
}

fn parse<T: for<'de> Deserialize<'de>>(arguments: &Value) -> Result<T, ToolError> {
    serde_json::from_value(arguments.clone()).map_err(|_| {
        ToolError::new(
            ToolErrorCode::ToolSchemaInvalid,
            "state arguments are invalid",
        )
    })
}

fn json<T: Serialize>(value: T) -> Result<Value, ToolError> {
    serde_json::to_value(value).map_err(|_| {
        ToolError::new(
            ToolErrorCode::ToolSerializationFailed,
            "state result serialization failed",
        )
    })
}

macro_rules! state_mutation_tool {
    ($ty:ident, $name:literal, $order:literal, $desc:literal, $input:ty, $output:ty) => {
        #[async_trait]
        impl TypedTool for $ty {
            type Input = $input;
            type Output = $output;
            const NAME: &'static str = $name;
            const ORDER: u16 = $order;
            const DESCRIPTION: &'static str = $desc;

            fn static_capabilities(&self) -> ToolCapabilities {
                ToolCapabilities::STATE_WRITE
            }

            fn inspect(
                &self,
                _input: &Self::Input,
                _context: &ToolInspectContext,
            ) -> Result<ToolIntent, ToolError> {
                Ok(write_intent())
            }

            async fn execute(
                &self,
                _context: ToolExecutionContext,
                _input: Self::Input,
                _cancel: CancellationToken,
            ) -> Result<Self::Output, ToolError> {
                unavailable()
            }
        }
    };
}

state_mutation_tool!(
    CreateTaskTool,
    "create_task",
    200,
    "Create a current-session task with status todo in the active StateGraph tier.",
    CreateTaskInput,
    StateMutationToolOutput
);
state_mutation_tool!(
    CompleteTaskTool,
    "complete_task",
    210,
    "Mark one current-session task done and move it to the soft StateGraph tier.",
    CompleteTaskInput,
    StateMutationToolOutput
);
state_mutation_tool!(
    RetractTaskTool,
    "retract_task",
    220,
    "Retract any current-session StateGraph object by ID with a reason; it remains searchable.",
    RetractStateInput,
    StateMutationToolOutput
);
state_mutation_tool!(
    AddConstraintTool,
    "add_constraint",
    230,
    "Record a current-session constraint in the active StateGraph tier; strength defaults to hard.",
    AddConstraintInput,
    StateMutationToolOutput
);
state_mutation_tool!(
    DecideTool,
    "decide",
    240,
    "Record a current-session decision with its rationale, optionally superseding an active decision.",
    DecideInput,
    StateMutationToolOutput
);
state_mutation_tool!(
    AddNoteTool,
    "add_note",
    250,
    "Record a semantic current-session note or finding, with optional lowercase tags.",
    AddNoteInput,
    StateMutationToolOutput
);
state_mutation_tool!(
    SoftUnloadTool,
    "soft_unload",
    260,
    "Move one StateGraph object to the soft tier; it stays listed and can be hydrated.",
    StateIdInput,
    StateMutationToolOutput
);
state_mutation_tool!(
    HardUnloadTool,
    "hard_unload",
    270,
    "Archive one StateGraph object to the hard tier; its content then requires hydrate.",
    StateIdInput,
    StateMutationToolOutput
);
state_mutation_tool!(
    HydrateTool,
    "hydrate",
    280,
    "Move one StateGraph object to the active tier and return its complete content.",
    StateIdInput,
    StateObjectToolOutput
);
state_mutation_tool!(
    FocusTaskTool,
    "focus_task",
    300,
    "Make one current StateGraph object the single focus, activating it if needed, and return its content.",
    FocusTaskInput,
    StateObjectToolOutput
);

#[async_trait]
impl TypedTool for ListStateTool {
    type Input = ListStateInput;
    type Output = StateListToolOutput;
    const NAME: &'static str = "list_state";
    const ORDER: u16 = 290;
    const DESCRIPTION: &'static str = "List current-session StateGraph objects with bounded summaries, filtered by kind, tier, and status.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::STATE_READ
    }

    fn inspect(
        &self,
        _input: &Self::Input,
        _context: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        Ok(read_intent())
    }

    async fn execute(
        &self,
        _context: ToolExecutionContext,
        _input: Self::Input,
        _cancel: CancellationToken,
    ) -> Result<Self::Output, ToolError> {
        unavailable()
    }
}
