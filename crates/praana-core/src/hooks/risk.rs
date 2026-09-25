use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::config::types::RiskConfig;
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::ToolIntent;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RiskConfirm {
    pub call_id: String,
    pub argument_hash: String,
    pub class_name: String,
}

#[async_trait]
pub trait RiskDecider: Send + Sync {
    async fn confirm(&self, request: &RiskConfirm) -> bool;
}

pub async fn check(
    intent: &ToolIntent,
    headless: bool,
    risk: &RiskConfig,
    call_id: &str,
    argument_hash: &str,
    decider: Option<&dyn RiskDecider>,
    gate: &Mutex<()>,
) -> Result<(), ToolError> {
    for fact in &intent.risk_facts {
        let name = fact.config_name();
        let allowed = risk.allow.iter().any(|item| item == name);
        if headless {
            if !allowed {
                return Err(ToolError::new(
                    ToolErrorCode::ToolRiskHeadlessDenied,
                    "headless risk confirmation denied",
                ));
            }
            continue;
        }
        if allowed {
            continue;
        }
        let Some(decider) = decider else {
            return Err(ToolError::new(
                ToolErrorCode::ToolRiskDeclined,
                "risk confirmation declined",
            ));
        };
        let _guard = gate.lock().await;
        let approved = decider
            .confirm(&RiskConfirm {
                call_id: call_id.to_owned(),
                argument_hash: argument_hash.to_owned(),
                class_name: name.to_owned(),
            })
            .await;
        if !approved {
            return Err(ToolError::new(
                ToolErrorCode::ToolRiskDeclined,
                "risk confirmation declined",
            ));
        }
    }
    Ok(())
}
