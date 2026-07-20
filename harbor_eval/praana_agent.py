"""Harbor installed-agent adapter for PRAANA.

Installs Bun + PRAANA inside the task container and runs a headless one-shot:

    praana run --incognito --max-steps N "<instruction>"

Usage (from the PRAANA repo root)::

    PYTHONPATH=. harbor run \\
      -d terminal-bench@2.0 \\
      -a harbor_eval.praana_agent:Praana \\
      -m openrouter/anthropic/claude-sonnet-4 \\
      -n 1 \\
      --ae OPENROUTER_API_KEY=$OPENROUTER_API_KEY

Optional agent kwargs (``--ak key=value``)::

    git_ref=main          # git ref / tag to clone (default: main, or Harbor --version)
    max_steps=80          # maps to praana --max-steps
    context_engine=true   # sets PRAANA_CONTEXT_ENGINE
    reasoning_effort=high # writes llm.reasoning_effort into praana config
    repo_url=...          # override clone URL

After each run, PRAANA writes ``/logs/agent/praana-usage.json`` (tokens +
optional ``cost_usd`` + ``reasoning_effort``). ``populate_context_post_run``
loads it into Harbor's ``AgentContext`` so jobs report token/cost efficiency
and which reasoning level ran.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any, ClassVar, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Keys commonly needed by PRAANA providers. Harbor's litellm helper does not
# know about umans; include it explicitly.
_PRAANA_API_KEYS = (
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
    "UMANS_AI_CODING_PLAN_API_KEY",
    "OLLAMA_API_BASE",
)

_DEFAULT_REPO = "https://github.com/amitkumardubey/praana.git"
_INSTALL_DIR = "$HOME/praana"
_BUN_BIN = "$HOME/.bun/bin"
_USAGE_FILENAME = "praana-usage.json"
_USAGE_PATH_IN_CONTAINER = f"/logs/agent/{_USAGE_FILENAME}"
_SUMMARY_FILENAME = "praana-summary.txt"
_REASONING_EFFORT_LEVELS = frozenset(
    {"off", "none", "minimal", "low", "medium", "high", "xhigh", "max"}
)


class Praana(BaseInstalledAgent):
    """Installed Harbor agent that drives PRAANA via ``praana run``."""

    CLI_FLAGS: ClassVar[list[CliFlag]] = [
        CliFlag(
            "max_steps",
            cli="--max-steps",
            type="int",
            default=80,
            env_fallback="PRAANA_MAX_STEPS",
        ),
    ]

    def __init__(
        self,
        logs_dir: Path,
        *args: Any,
        git_ref: str | None = None,
        context_engine: bool | str | None = None,
        reasoning_effort: str | None = None,
        repo_url: str | None = None,
        **kwargs: Any,
    ):
        self._git_ref = git_ref
        self._repo_url = repo_url or _DEFAULT_REPO
        self._context_engine = _coerce_bool(context_engine)
        self._reasoning_effort = _normalize_reasoning_effort(reasoning_effort)
        super().__init__(logs_dir, *args, **kwargs)

    @staticmethod
    @override
    def name() -> str:
        return "praana"

    @override
    def version(self) -> str | None:
        return self._version

    @override
    def get_version_command(self) -> str | None:
        return (
            f'export PATH="{_BUN_BIN}:$HOME/.local/bin:$PATH"; '
            f"praana --version 2>/dev/null || "
            f"bun {_INSTALL_DIR}/src/main.ts --version"
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && apt-get install -y curl git ca-certificates unzip"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        ref = self._git_ref or self._version or "main"
        repo = shlex.quote(self._repo_url)
        ref_q = shlex.quote(ref)

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "curl -fsSL https://bun.sh/install | bash; "
                f'export PATH="{_BUN_BIN}:$PATH"; '
                "bun --version; "
                f"rm -rf {_INSTALL_DIR}; "
                # Prefer shallow clone of the ref; fall back to full clone + checkout
                # (needed for commit SHAs that are not branch tips).
                f"git clone --depth 1 --branch {ref_q} {repo} {_INSTALL_DIR} "
                f"|| (git clone {repo} {_INSTALL_DIR} && "
                f"cd {_INSTALL_DIR} && git checkout {ref_q}); "
                f"cd {_INSTALL_DIR}; "
                "bun install; "
                'mkdir -p "$HOME/.local/bin"; '
                f'ln -sfn {_INSTALL_DIR}/bin/praana.js "$HOME/.local/bin/praana"; '
                f'ln -sfn {_INSTALL_DIR}/bin/pran.js "$HOME/.local/bin/pran"; '
                f'export PATH="{_BUN_BIN}:$HOME/.local/bin:$PATH"; '
                "praana --version"
            ),
            timeout_sec=600,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        # Harbor only calls this when AgentContext.is_empty() — do NOT write
        # context.metadata (or tokens) during run(), or token/cost import is skipped.
        apply_usage_report_to_context(self.logs_dir / _USAGE_FILENAME, context)
        meta = dict(context.metadata or {})
        if self.model_name and "/" in self.model_name:
            provider, model = self.model_name.split("/", 1)
            meta.setdefault("praana_provider", provider.strip())
            meta.setdefault("praana_model", model.strip())
        effort = self._reasoning_effort or "medium"
        meta.setdefault("praana_reasoning_effort", effort)
        context.metadata = meta
        write_praana_summary(self.logs_dir, context)
        print_praana_summary(context)

    def _provider_and_model(self) -> tuple[str, str]:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                "Harbor --model must be provider/model "
                "(e.g. openrouter/anthropic/claude-sonnet-4 or umans/umans-coder)"
            )
        provider, model = self.model_name.split("/", 1)
        return provider.strip(), model.strip()

    def _api_env(self) -> dict[str, str]:
        env: dict[str, str] = {
            "PRAANA_USAGE_PATH": _USAGE_PATH_IN_CONTAINER,
        }
        for key in _PRAANA_API_KEYS:
            if key in os.environ and os.environ[key]:
                env[key] = os.environ[key]
        if self._context_engine is not None:
            env["PRAANA_CONTEXT_ENGINE"] = (
                "true" if self._context_engine else "false"
            )
        return env

    def _write_config_command(self, provider: str, model: str) -> str:
        # TOML-safe: providers/models are identifiers without newlines.
        provider_q = provider.replace('"', '\\"')
        model_q = model.replace('"', '\\"')
        llm_lines = [
            "[llm]",
            f'provider = "{provider_q}"',
            f'model = "{model_q}"',
        ]
        if self._reasoning_effort:
            effort_q = self._reasoning_effort.replace('"', '\\"')
            llm_lines.append(f'reasoning_effort = "{effort_q}"')
        config = (
            "\\n".join(llm_lines)
            + "\\n\\n[memory]\\nenabled = false\\n\\n[edit]\\nconfirm = false\\n"
        )
        return (
            'mkdir -p "$HOME/.praana" && '
            f"printf '%b' {shlex.quote(config)} > \"$HOME/.praana/config.toml\""
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        provider, model = self._provider_and_model()
        env = self._api_env()
        env["PRAANA_MODEL"] = model

        escaped = shlex.quote(instruction)
        cli_flags = self.build_cli_flags()
        extra = (cli_flags + " ") if cli_flags else ""

        await self.exec_as_agent(
            environment,
            command=self._write_config_command(provider, model),
            env=env,
        )

        effort_note = self._reasoning_effort or "medium"
        banner = (
            f"praana: provider={provider} model={model} "
            f"reasoning_effort={effort_note}"
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f'export PATH="{_BUN_BIN}:$HOME/.local/bin:$PATH"; '
                "mkdir -p /logs/agent; "
                f"printf '%s\\n' {shlex.quote(banner)} >> /logs/agent/praana.txt; "
                f"praana run --incognito {extra}{escaped} "
                f"2>&1 | stdbuf -oL tee -a /logs/agent/praana.txt"
            ),
            env=env,
        )


def format_praana_summary_lines(context: AgentContext) -> list[str]:
    """Human-readable summary for Harbor CLI + agent/praana-summary.txt."""
    meta = dict(context.metadata or {})
    provider = meta.get("praana_provider") or "-"
    model = meta.get("praana_model") or "-"
    effort = meta.get("praana_reasoning_effort") or "-"
    wire = meta.get("praana_reasoning_effort_wire")
    wire_s = wire if wire not in (None, "") else "(omitted / n/a)"
    n_in = context.n_input_tokens
    n_out = context.n_output_tokens
    cost = context.cost_usd
    cost_s = f"${cost:.6f}" if isinstance(cost, (int, float)) else "n/a"
    return [
        "praana summary",
        f"  provider:           {provider}",
        f"  model:              {model}",
        f"  reasoning_effort:   {effort}",
        f"  reasoning_wire:     {wire_s}",
        f"  n_input_tokens:     {n_in if n_in is not None else 'n/a'}",
        f"  n_output_tokens:    {n_out if n_out is not None else 'n/a'}",
        f"  cost_usd:           {cost_s}",
    ]


def write_praana_summary(logs_dir: Path, context: AgentContext) -> Path:
    path = logs_dir / _SUMMARY_FILENAME
    path.write_text("\n".join(format_praana_summary_lines(context)) + "\n", encoding="utf-8")
    return path


def print_praana_summary(context: AgentContext) -> None:
    """Print on the Harbor host after logs sync (visible in `harbor run` output)."""
    import sys

    text = "\n".join(format_praana_summary_lines(context))
    print(f"\n{text}\n", file=sys.stderr, flush=True)


def apply_usage_report_to_context(
    usage_path: Path,
    context: AgentContext,
) -> bool:
    """Load praana-usage.json into Harbor AgentContext. Returns True if applied."""
    if not usage_path.exists():
        return False
    try:
        data = json.loads(usage_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False

    def _int_field(key: str) -> int | None:
        raw = data.get(key)
        if isinstance(raw, bool):
            return None
        if isinstance(raw, int):
            return raw
        if isinstance(raw, float) and raw == int(raw):
            return int(raw)
        return None

    n_in = _int_field("n_input_tokens")
    n_out = _int_field("n_output_tokens")
    n_cache = _int_field("n_cache_tokens")
    if n_in is not None:
        context.n_input_tokens = n_in
    if n_out is not None:
        context.n_output_tokens = n_out
    if n_cache is not None:
        context.n_cache_tokens = n_cache

    cost = data.get("cost_usd")
    if isinstance(cost, (int, float)) and not isinstance(cost, bool):
        context.cost_usd = float(cost)

    meta = dict(context.metadata or {})
    if data.get("session_id"):
        meta["praana_session_id"] = data["session_id"]
    if data.get("model"):
        meta["praana_model"] = data["model"]
    if data.get("provider"):
        meta["praana_provider"] = data["provider"]
    effort = data.get("reasoning_effort")
    if isinstance(effort, str) and effort.strip():
        meta["praana_reasoning_effort"] = effort.strip()
    wire = data.get("reasoning_effort_wire")
    if isinstance(wire, str) and wire.strip():
        meta["praana_reasoning_effort_wire"] = wire.strip()
    elif wire is None and "reasoning_effort_wire" in data:
        meta["praana_reasoning_effort_wire"] = None
    if meta:
        context.metadata = meta
    return True


def _normalize_reasoning_effort(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if not normalized:
        return None
    if normalized not in _REASONING_EFFORT_LEVELS:
        raise ValueError(
            f"Invalid reasoning_effort {value!r}; "
            f"expected one of {sorted(_REASONING_EFFORT_LEVELS)}"
        )
    # Align with PRAANA parseReasoningEffort: none → off
    if normalized == "none":
        return "off"
    if normalized == "max":
        return "xhigh"
    return normalized


def _coerce_bool(value: bool | str | None) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"Invalid boolean value: {value!r}")
