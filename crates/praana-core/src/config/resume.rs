use super::error::{ConfigError, ConfigWarning};
use super::types::EffectiveConfigV1;
use crate::token::Sha256Digest;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq)]
pub struct ResumeConfigResult {
    pub creation_config_digest: Sha256Digest,
    pub loaded_config_digest: Sha256Digest,
    pub runtime_config_digest: Sha256Digest,
    pub changed_since_create: bool,
    pub changed_keys: Vec<String>,
    pub runtime_config: EffectiveConfigV1,
    pub warnings: Vec<ConfigWarning>,
}

fn diff_json_values(prefix: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
    if a == b {
        return;
    }
    match (a, b) {
        (Value::Object(map_a), Value::Object(map_b)) => {
            let mut keys: BTreeSet<&String> = map_a.keys().collect();
            keys.extend(map_b.keys());
            for k in keys {
                let next_prefix = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                let val_a = map_a.get(k).unwrap_or(&Value::Null);
                let val_b = map_b.get(k).unwrap_or(&Value::Null);
                diff_json_values(&next_prefix, val_a, val_b, out);
            }
        }
        _ => {
            out.push(prefix.to_string());
        }
    }
}

pub fn detect_changed_keys(a: &EffectiveConfigV1, b: &EffectiveConfigV1) -> Vec<String> {
    let json_a = serde_json::to_value(a).expect("serialize EffectiveConfigV1 to json value");
    let json_b = serde_json::to_value(b).expect("serialize EffectiveConfigV1 to json value");
    let mut out = Vec::new();
    diff_json_values("", &json_a, &json_b, &mut out);
    out.sort();
    out
}

pub fn resolve_resume_config(
    creation_cfg: &EffectiveConfigV1,
    creation_digest: &Sha256Digest,
    loaded_cfg: &EffectiveConfigV1,
    loaded_digest: &Sha256Digest,
) -> Result<ResumeConfigResult, ConfigError> {
    // 1. Start with creation configuration
    let mut runtime_config = creation_cfg.clone();

    // 2. Apply resume rules from section 12.3:
    // - session.root: use creation value
    // - session.incognito: logical OR of creation and loaded
    runtime_config.session.incognito =
        creation_cfg.session.incognito || loaded_cfg.session.incognito;
    // - session retention / shutdown grace: use loaded values
    runtime_config.session.retention_days = loaded_cfg.session.retention_days;
    runtime_config.session.orphan_retention_days = loaded_cfg.session.orphan_retention_days;
    runtime_config.session.shutdown_grace_ms = loaded_cfg.session.shutdown_grace_ms;
    // - logging: use loaded values
    runtime_config.logging = loaded_cfg.logging.clone();

    // 3. Compute runtime digest
    let runtime_config_digest = runtime_config.config_digest_sha256();

    // 4. Change detection
    let changed_since_create = creation_digest != loaded_digest;
    let changed_keys = if changed_since_create {
        detect_changed_keys(creation_cfg, loaded_cfg)
    } else {
        Vec::new()
    };

    let mut warnings = Vec::new();
    if changed_since_create {
        warnings.push(ConfigWarning::ChangedSinceCreate {
            changed_keys: changed_keys.clone(),
        });
    }

    Ok(ResumeConfigResult {
        creation_config_digest: creation_digest.clone(),
        loaded_config_digest: loaded_digest.clone(),
        runtime_config_digest,
        changed_since_create,
        changed_keys,
        runtime_config,
        warnings,
    })
}
