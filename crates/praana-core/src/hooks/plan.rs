use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{ToolIntent, ToolMutation};

pub fn check(plan_mode: bool, intent: &ToolIntent) -> Result<(), ToolError> {
    if !plan_mode {
        return Ok(());
    }
    match intent.mutation {
        ToolMutation::Workspace | ToolMutation::External | ToolMutation::SessionState => {
            Err(ToolError::new(
                ToolErrorCode::ToolPlanBlocked,
                "plan mode blocked this call",
            ))
        }
        ToolMutation::PureCompute | ToolMutation::ReadOnly => Ok(()),
    }
}
