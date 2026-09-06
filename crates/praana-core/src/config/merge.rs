use super::raw::RawConfigV1;
use super::types::EffectiveConfigV1;

pub fn merge_raw_into_effective(base: &mut EffectiveConfigV1, layer: RawConfigV1) {
    if let Some(history) = layer.history {
        if let Some(v) = history.artifact_batch_inline_tokens {
            base.history.artifact_batch_inline_tokens = v;
        }
        if let Some(v) = history.artifact_inline_tokens {
            base.history.artifact_inline_tokens = v;
        }
        if let Some(v) = history.artifact_preview_tokens {
            base.history.artifact_preview_tokens = v;
        }
        if let Some(v) = history.compact_at {
            base.history.compact_at = v;
        }
        if let Some(v) = history.compact_clear_at {
            base.history.compact_clear_at = v;
        }
        if let Some(v) = history.compact_mass_fraction {
            base.history.compact_mass_fraction = v;
        }
        if let Some(v) = history.compactor_max_output_tokens {
            base.history.compactor_max_output_tokens = v;
        }
        if let Some(v) = history.compactor_model {
            base.history.compactor_model = v;
        }
        if let Some(v) = history.compactor_provider {
            base.history.compactor_provider = v;
        }
        if let Some(v) = history.compactor_timeout_ms {
            base.history.compactor_timeout_ms = v;
        }
        if let Some(v) = history.handoff_max_tokens {
            base.history.handoff_max_tokens = v;
        }
        if let Some(v) = history.mode {
            base.history.mode = v;
        }
        if let Some(v) = history.reasoning_replay {
            base.history.reasoning_replay = v;
        }
        if let Some(v) = history.safety_margin_min_tokens {
            base.history.safety_margin_min_tokens = v;
        }
        if let Some(v) = history.safety_margin_ratio {
            base.history.safety_margin_ratio = v;
        }
        if let Some(v) = history.summary_segment_max_tokens {
            base.history.summary_segment_max_tokens = v;
        }
    }

    if let Some(state) = layer.state {
        if let Some(v) = state.active_max_tokens {
            base.state.active_max_tokens = v;
        }
        if let Some(v) = state.auto_hydrate {
            base.state.auto_hydrate = v;
        }
        if let Some(v) = state.auto_hydrate_max {
            base.state.auto_hydrate_max = v;
        }
        if let Some(v) = state.automation_policy_version {
            base.state.automation_policy_version = v;
        }
        if let Some(v) = state.idle_hard_after_turns {
            base.state.idle_hard_after_turns = v;
        }
        if let Some(v) = state.idle_soft_after_turns {
            base.state.idle_soft_after_turns = v;
        }
    }

    if let Some(llm) = layer.llm {
        if let Some(v) = llm.context_window {
            base.llm.context_window = v;
        }
        if let Some(v) = llm.fallback_context_window {
            base.llm.fallback_context_window = v;
        }
        if let Some(v) = llm.fallback_model {
            base.llm.fallback_model = v;
        }
        if let Some(v) = llm.fallback_protocol {
            base.llm.fallback_protocol = v;
        }
        if let Some(v) = llm.fallback_provider {
            base.llm.fallback_provider = v;
        }
        if let Some(v) = llm.max_output_tokens {
            base.llm.max_output_tokens = v;
        }
        if let Some(v) = llm.min_output_tokens {
            base.llm.min_output_tokens = v;
        }
        if let Some(v) = llm.model {
            base.llm.model = v;
        }
        if let Some(v) = llm.protocol {
            base.llm.protocol = v;
        }
        if let Some(v) = llm.provider {
            base.llm.provider = v;
        }
        if let Some(v) = llm.reasoning_effort {
            base.llm.reasoning_effort = v;
        }
        if let Some(v) = llm.reasoning_reserve_tokens {
            base.llm.reasoning_reserve_tokens = v;
        }
        if let Some(v) = llm.request_timeout_ms {
            base.llm.request_timeout_ms = v;
        }
        if let Some(v) = llm.temperature_milli {
            base.llm.temperature_milli = v;
        }
        if let Some(v) = llm.unsafe_allow_context_window_increase {
            base.llm.unsafe_allow_context_window_increase = v;
        }
    }

    if let Some(providers) = layer.providers {
        if let Some(openai) = providers.openai {
            if let Some(v) = openai.base_url {
                base.providers.openai.base_url = v;
            }
            if let Some(v) = openai.extra_headers {
                base.providers.openai.extra_headers = v;
            }
        }
        if let Some(openrouter) = providers.openrouter {
            if let Some(v) = openrouter.base_url {
                base.providers.openrouter.base_url = v;
            }
            if let Some(v) = openrouter.extra_headers {
                base.providers.openrouter.extra_headers = v;
            }
        }
    }

    if let Some(turn) = layer.turn {
        if let Some(v) = turn.max_attempts {
            base.turn.max_attempts = v;
        }
        if let Some(v) = turn.max_steps {
            base.turn.max_steps = v;
        }
    }

    if let Some(tools) = layer.tools {
        if let Some(v) = tools.allowed_paths {
            base.tools.allowed_paths = v;
        }
        if let Some(v) = tools.default_timeout_ms {
            base.tools.default_timeout_ms = v;
        }
        if let Some(v) = tools.max_parallel_calls {
            base.tools.max_parallel_calls = v;
        }
        if let Some(v) = tools.max_spawned_processes {
            base.tools.max_spawned_processes = v;
        }
        if let Some(v) = tools.shell_enabled {
            base.tools.shell_enabled = v;
        }
        if let Some(v) = tools.shell_max_timeout_ms {
            base.tools.shell_max_timeout_ms = v;
        }
        if let Some(v) = tools.shell_timeout_ms {
            base.tools.shell_timeout_ms = v;
        }
    }

    if let Some(risk) = layer.risk {
        if let Some(v) = risk.allow {
            base.risk.allow = v;
        }
    }

    if let Some(circuit) = layer.circuit {
        if let Some(v) = circuit.loop_threshold {
            base.circuit.loop_threshold = v;
        }
        if let Some(v) = circuit.max_tokens {
            base.circuit.max_tokens = v;
        }
        if let Some(v) = circuit.max_wall_ms {
            base.circuit.max_wall_ms = v;
        }
    }

    if let Some(session) = layer.session {
        if let Some(v) = session.incognito {
            base.session.incognito = v;
        }
        if let Some(v) = session.orphan_retention_days {
            base.session.orphan_retention_days = v;
        }
        if let Some(v) = session.retention_days {
            base.session.retention_days = v;
        }
        if let Some(v) = session.root {
            base.session.root = v;
        }
        if let Some(v) = session.shutdown_grace_ms {
            base.session.shutdown_grace_ms = v;
        }
    }

    if let Some(logging) = layer.logging {
        if let Some(v) = logging.directory {
            base.logging.directory = v;
        }
        if let Some(v) = logging.file {
            base.logging.file = v;
        }
        if let Some(v) = logging.format {
            base.logging.format = v;
        }
        if let Some(v) = logging.keep_files {
            base.logging.keep_files = v;
        }
        if let Some(v) = logging.level {
            base.logging.level = v;
        }
        if let Some(v) = logging.rotate_bytes {
            base.logging.rotate_bytes = v;
        }
        if let Some(v) = logging.stderr {
            base.logging.stderr = v;
        }
    }

    if let Some(memory) = layer.memory {
        if let Some(v) = memory.plugin {
            base.memory.plugin = v;
        }
        if let Some(options) = memory.options {
            if let Some(v) = options.db_path {
                base.memory.options.db_path = v;
            }
            if let Some(v) = options.digest_max_tokens {
                base.memory.options.digest_max_tokens = v;
            }
            if let Some(v) = options.extraction {
                base.memory.options.extraction = v;
            }
            if let Some(v) = options.llm_contradictions {
                base.memory.options.llm_contradictions = v;
            }
            if let Some(v) = options.recall_limit {
                base.memory.options.recall_limit = v;
            }
        }
        if let Some(timeouts) = memory.timeouts {
            if let Some(v) = timeouts.close_ms {
                base.memory.timeouts.close_ms = v;
            }
            if let Some(v) = timeouts.end_ms {
                base.memory.timeouts.end_ms = v;
            }
            if let Some(v) = timeouts.feedback_ms {
                base.memory.timeouts.feedback_ms = v;
            }
            if let Some(v) = timeouts.open_ms {
                base.memory.timeouts.open_ms = v;
            }
            if let Some(v) = timeouts.pin_ms {
                base.memory.timeouts.pin_ms = v;
            }
            if let Some(v) = timeouts.recall_ms {
                base.memory.timeouts.recall_ms = v;
            }
            if let Some(v) = timeouts.remember_ms {
                base.memory.timeouts.remember_ms = v;
            }
            if let Some(v) = timeouts.retract_ms {
                base.memory.timeouts.retract_ms = v;
            }
            if let Some(v) = timeouts.start_ms {
                base.memory.timeouts.start_ms = v;
            }
            if let Some(v) = timeouts.stats_ms {
                base.memory.timeouts.stats_ms = v;
            }
        }
    }
}
