use serde_json::Value;

use crate::redaction::{redact_json_v1, RedactionError};
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::result::ToolResultDto;

pub fn apply(dto: &mut ToolResultDto) -> Result<(), ToolError> {
    let value = serde_json::to_value(&*dto)
        .map_err(|_| ToolError::new(ToolErrorCode::ToolRedactionFailed, "redaction failed"))?;
    let redacted = redact_json_v1(&value).map_err(redaction_error)?;
    let restored: ToolResultDto = serde_json::from_value(redacted.value)
        .map_err(|_| ToolError::new(ToolErrorCode::ToolRedactionFailed, "redaction failed"))?;
    *dto = restored;
    dto.meta.redacted = redacted.summary.replacement_count > 0;
    Ok(())
}

fn redaction_error(error: RedactionError) -> ToolError {
    let _ = error;
    ToolError::new(ToolErrorCode::ToolRedactionFailed, "redaction failed")
}

pub fn redact_value(value: &Value) -> Result<Value, ToolError> {
    redact_json_v1(value)
        .map(|redacted| redacted.value)
        .map_err(redaction_error)
}
