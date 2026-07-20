"""Tests for harbor_eval.praana_agent (run with: uv run --with pytest python -m pytest harbor_eval/)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

_REPO = Path(__file__).resolve().parents[1]


def _install_harbor_stubs() -> None:
    if "harbor.agents.installed.base" in sys.modules:
        return

    harbor = ModuleType("harbor")
    agents = ModuleType("harbor.agents")
    installed = ModuleType("harbor.agents.installed")
    base = ModuleType("harbor.agents.installed.base")
    environments = ModuleType("harbor.environments")
    env_base = ModuleType("harbor.environments.base")
    models = ModuleType("harbor.models")
    agent_pkg = ModuleType("harbor.models.agent")
    context_mod = ModuleType("harbor.models.agent.context")

    class CliFlag:
        def __init__(self, kwarg, cli, type="str", default=None, env_fallback=None, **_):
            self.kwarg = kwarg
            self.cli = cli
            self.type = type
            self.default = default
            self.env_fallback = env_fallback

    class BaseInstalledAgent:
        CLI_FLAGS: list = []

        def __init__(self, logs_dir, *args, version=None, **kwargs):
            self.logs_dir = logs_dir
            self._version = version
            self.model_name = kwargs.pop("model_name", None)
            self._resolved_flags = {}
            for flag in type(self).CLI_FLAGS:
                if flag.kwarg in kwargs:
                    self._resolved_flags[flag.kwarg] = kwargs[flag.kwarg]
                elif flag.default is not None:
                    self._resolved_flags[flag.kwarg] = flag.default

        def build_cli_flags(self) -> str:
            parts = []
            for flag in type(self).CLI_FLAGS:
                val = self._resolved_flags.get(flag.kwarg)
                if val is None:
                    continue
                parts.append(f"{flag.cli} {val}")
            return " ".join(parts)

    def with_prompt_template(fn):
        return fn

    base.BaseInstalledAgent = BaseInstalledAgent
    base.CliFlag = CliFlag
    base.with_prompt_template = with_prompt_template
    env_base.BaseEnvironment = object
    context_mod.AgentContext = object

    sys.modules["harbor"] = harbor
    sys.modules["harbor.agents"] = agents
    sys.modules["harbor.agents.installed"] = installed
    sys.modules["harbor.agents.installed.base"] = base
    sys.modules["harbor.environments"] = environments
    sys.modules["harbor.environments.base"] = env_base
    sys.modules["harbor.models"] = models
    sys.modules["harbor.models.agent"] = agent_pkg
    sys.modules["harbor.models.agent.context"] = context_mod

    sys.path.insert(0, str(_REPO))


@pytest.fixture(scope="module")
def praana_mod():
    _install_harbor_stubs()
    from harbor_eval.praana_agent import (  # noqa: WPS433
        Praana,
        _coerce_bool,
        apply_usage_report_to_context,
    )

    return Praana, _coerce_bool, apply_usage_report_to_context


def test_name(praana_mod):
    Praana, _, _ = praana_mod
    assert Praana.name() == "praana"


def test_provider_and_model_split(praana_mod):
    Praana, _, _ = praana_mod
    agent = Praana(Path("/tmp"), model_name="openrouter/org/model")
    assert agent._provider_and_model() == ("openrouter", "org/model")


def test_provider_and_model_umans(praana_mod):
    Praana, _, _ = praana_mod
    agent = Praana(Path("/tmp"), model_name="umans/umans-coder")
    assert agent._provider_and_model() == ("umans", "umans-coder")


def test_provider_and_model_requires_slash(praana_mod):
    Praana, _, _ = praana_mod
    agent = Praana(Path("/tmp"), model_name="umans-coder")
    with pytest.raises(ValueError, match="provider/model"):
        agent._provider_and_model()


def test_write_config_command(praana_mod):
    Praana, _, _ = praana_mod
    agent = Praana(Path("/tmp"), model_name="umans/umans-coder")
    cmd = agent._write_config_command("umans", "umans-coder")
    assert "umans" in cmd and "umans-coder" in cmd and "config.toml" in cmd
    assert "reasoning_effort" not in cmd


def test_write_config_includes_reasoning_effort(praana_mod):
    Praana, _, _ = praana_mod
    agent = Praana(
        Path("/tmp"),
        model_name="openrouter/z-ai/glm-5.2",
        reasoning_effort="high",
    )
    cmd = agent._write_config_command("openrouter", "z-ai/glm-5.2")
    assert 'reasoning_effort = "high"' in cmd


def test_reasoning_effort_none_aliases_off(praana_mod):
    Praana, _, _ = praana_mod
    agent = Praana(
        Path("/tmp"),
        model_name="openrouter/z-ai/glm-5.2",
        reasoning_effort="none",
    )
    assert agent._reasoning_effort == "off"


def test_reasoning_effort_rejects_invalid(praana_mod):
    Praana, _, _ = praana_mod
    with pytest.raises(ValueError, match="Invalid reasoning_effort"):
        Praana(Path("/tmp"), model_name="umans/umans-coder", reasoning_effort="turbo")


def test_build_cli_flags_max_steps(praana_mod):
    Praana, _, _ = praana_mod
    agent = Praana(Path("/tmp"), model_name="umans/umans-coder", max_steps=40)
    assert "--max-steps 40" in agent.build_cli_flags()


def test_api_env_sets_usage_path(praana_mod):
    Praana, _, _ = praana_mod
    agent = Praana(Path("/tmp"), model_name="umans/umans-coder")
    env = agent._api_env()
    assert env["PRAANA_USAGE_PATH"] == "/logs/agent/praana-usage.json"


def test_coerce_bool(praana_mod):
    _, coerce, _ = praana_mod
    assert coerce("true") is True
    assert coerce("0") is False
    assert coerce(None) is None


def test_apply_usage_report_to_context(praana_mod, tmp_path):
    _, _, apply = praana_mod
    usage = tmp_path / "praana-usage.json"
    usage.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "session_id": "01ABC",
                "provider": "openrouter",
                "model": "anthropic/claude-sonnet-5",
                "reasoning_effort": "medium",
                "reasoning_effort_wire": "medium",
                "n_input_tokens": 12000,
                "n_output_tokens": 800,
                "n_cache_tokens": 100,
                "cost_usd": 0.048,
            }
        ),
        encoding="utf-8",
    )

    class Ctx:
        n_input_tokens = None
        n_output_tokens = None
        n_cache_tokens = None
        cost_usd = None
        metadata = None

    ctx = Ctx()
    assert apply(usage, ctx) is True
    assert ctx.n_input_tokens == 12000
    assert ctx.n_output_tokens == 800
    assert ctx.n_cache_tokens == 100
    assert ctx.cost_usd == 0.048
    assert ctx.metadata["praana_session_id"] == "01ABC"
    assert ctx.metadata["praana_reasoning_effort"] == "medium"
    assert ctx.metadata["praana_reasoning_effort_wire"] == "medium"


def test_apply_usage_report_missing_file(praana_mod, tmp_path):
    _, _, apply = praana_mod

    class Ctx:
        n_input_tokens = None
        n_output_tokens = None
        n_cache_tokens = None
        cost_usd = None
        metadata = None

    assert apply(tmp_path / "missing.json", Ctx()) is False
