//! Adapter-local usage accumulation. Absence stays `None` until conversion.

use serde_json::Value;

use crate::protocol::models::ProviderUsage;

use super::error::ProviderErrorCode;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenAiUsageAccumulator {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageConversion {
    pub usage: ProviderUsage,
    pub incomplete_fields: Vec<&'static str>,
    pub inconsistent: bool,
}

impl UsageConversion {
    /// Names required by OpenAI spec §16. Zeros stay in the converted usage.
    pub fn telemetry_names(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if !self.incomplete_fields.is_empty() {
            names.push("usage_incomplete");
        }
        if self.inconsistent {
            names.push("usage_inconsistent");
        }
        names
    }
}

impl OpenAiUsageAccumulator {
    pub fn into_protocol_usage(self) -> UsageConversion {
        let mut incomplete = Vec::new();
        let input = field(self.input_tokens, "input_tokens", &mut incomplete);
        let output = field(self.output_tokens, "output_tokens", &mut incomplete);
        let total = field(self.total_tokens, "total_tokens", &mut incomplete);
        let cache_read = field(
            self.cache_read_input_tokens,
            "cache_read_input_tokens",
            &mut incomplete,
        );
        let cache_write = field(
            self.cache_write_input_tokens,
            "cache_write_input_tokens",
            &mut incomplete,
        );
        let reasoning = field(
            self.reasoning_output_tokens,
            "reasoning_output_tokens",
            &mut incomplete,
        );
        let inconsistent = self.total_tokens.is_some()
            && self.input_tokens.is_some()
            && self.output_tokens.is_some()
            && self.total_tokens != Some(input.saturating_add(output));
        UsageConversion {
            usage: ProviderUsage {
                input_tokens: input,
                output_tokens: output,
                reasoning_tokens: reasoning,
                total_tokens: total,
                cache_read_tokens: cache_read,
                cache_write_tokens: cache_write,
            },
            incomplete_fields: incomplete,
            inconsistent,
        }
    }

    pub fn observe(&mut self, next: &OpenAiUsageAccumulator) -> Result<(), ProviderErrorCode> {
        merge_nondecreasing(&mut self.input_tokens, next.input_tokens)?;
        merge_nondecreasing(&mut self.output_tokens, next.output_tokens)?;
        merge_nondecreasing(&mut self.total_tokens, next.total_tokens)?;
        merge_nondecreasing(
            &mut self.cache_read_input_tokens,
            next.cache_read_input_tokens,
        )?;
        merge_nondecreasing(
            &mut self.cache_write_input_tokens,
            next.cache_write_input_tokens,
        )?;
        merge_nondecreasing(
            &mut self.reasoning_output_tokens,
            next.reasoning_output_tokens,
        )?;
        Ok(())
    }
}

fn field(value: Option<u64>, name: &'static str, missing: &mut Vec<&'static str>) -> u64 {
    match value {
        Some(value) => value,
        None => {
            missing.push(name);
            0
        }
    }
}

fn merge_nondecreasing(
    slot: &mut Option<u64>,
    incoming: Option<u64>,
) -> Result<(), ProviderErrorCode> {
    let Some(incoming) = incoming else {
        return Ok(());
    };
    if let Some(current) = *slot {
        if incoming < current {
            return Err(ProviderErrorCode::ProtocolViolation);
        }
    }
    *slot = Some(incoming);
    Ok(())
}

pub fn usage_from_chat(value: &Value) -> OpenAiUsageAccumulator {
    let mut acc = OpenAiUsageAccumulator {
        input_tokens: u64_field(value, "prompt_tokens"),
        output_tokens: u64_field(value, "completion_tokens"),
        total_tokens: u64_field(value, "total_tokens"),
        ..OpenAiUsageAccumulator::default()
    };
    if let Some(details) = value.get("prompt_tokens_details") {
        acc.cache_read_input_tokens = u64_field(details, "cached_tokens");
    }
    if acc.cache_read_input_tokens.is_none() {
        acc.cache_read_input_tokens = u64_field(value, "prompt_cache_hit_tokens");
    }
    if let Some(details) = value.get("completion_tokens_details") {
        acc.reasoning_output_tokens = u64_field(details, "reasoning_tokens");
    }
    acc.cache_write_input_tokens = explicit_cache_write(value);
    acc
}

pub fn usage_from_responses(value: &Value) -> OpenAiUsageAccumulator {
    let mut acc = OpenAiUsageAccumulator {
        input_tokens: u64_field(value, "input_tokens"),
        output_tokens: u64_field(value, "output_tokens"),
        total_tokens: u64_field(value, "total_tokens"),
        ..OpenAiUsageAccumulator::default()
    };
    if let Some(details) = value.get("input_tokens_details") {
        acc.cache_read_input_tokens = u64_field(details, "cached_tokens");
    }
    if let Some(details) = value.get("output_tokens_details") {
        acc.reasoning_output_tokens = u64_field(details, "reasoning_tokens");
    }
    acc.cache_write_input_tokens = explicit_cache_write(value);
    acc
}

fn explicit_cache_write(value: &Value) -> Option<u64> {
    u64_field(value, "cache_write_input_tokens")
        .or_else(|| u64_field(value, "cache_creation_input_tokens"))
}

fn u64_field(value: &Value, name: &str) -> Option<u64> {
    value.get(name).and_then(|item| match item {
        Value::Number(number) => number.as_u64(),
        _ => None,
    })
}
