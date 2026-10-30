"""Process-local DevEco policy; never edit the user's global CLI configuration."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .utils import write_json


POLICY_VERSION = "2026-10-30-review-packet"
DEFAULT_AGENT_MODEL = "zhipu-coding/glm-5"
CODING_PLAN_VARIANTS = ("low", "high", "max")
DISABLED_AGENT_PROVIDERS = ("deveco",)
# The platform runs the authoritative build/static/test gates after each edit.
DISABLED_AGENT_TOOLS = ("webfetch", "websearch", "build_project", "arkts_check")


def resolve_agent_model(model: str | None) -> str:
    selected = (model or "").strip() or DEFAULT_AGENT_MODEL
    if selected.partition("/")[0].lower() in DISABLED_AGENT_PROVIDERS:
        raise ValueError(
            f"本项目禁止使用 DevEco 自带提供者：{selected}。"
            f"请将 --refactor-model/--review-model 或 ARKTS_REFACTOR_MODEL/ARKTS_REVIEW_MODEL "
            f"设为 {DEFAULT_AGENT_MODEL}，并清除旧的 ARKTS_REFACTOR_VARIANT/ARKTS_REVIEW_VARIANT。"
        )
    return selected


def _configure_coding_plan_variant(config: dict[str, Any], model: str | None, variant: str | None) -> None:
    if not variant or resolve_agent_model(model) != DEFAULT_AGENT_MODEL:
        return
    if variant not in CODING_PLAN_VARIANTS:
        raise ValueError("zhipu-coding/glm-5 的 variant 必须为 low/high/max；使用服务端默认时请不传 variant")

    settings = config
    for key in ("provider", "zhipu-coding", "models", "glm-5", "variants"):
        value = settings.setdefault(key, {})
        if not isinstance(value, dict):
            raise ValueError(f"DevEco Coding Plan {key} 配置必须是对象")
        settings = value
    previous = settings.get(variant, {})
    if not isinstance(previous, dict):
        raise ValueError(f"DevEco Coding Plan variant {variant} 配置必须是对象")
    # A CLI variant is a local preset, not itself an API parameter. The installed
    # openai-compatible adapter serializes reasoningEffort as reasoning_effort.
    # An explicit selection wins over stale effort spellings/disabled presets.
    settings[variant] = {key: value for key, value in previous.items()
                         if key not in {"reasoningEffort", "reasoning_effort", "disabled"}}
    settings[variant]["reasoningEffort"] = variant


def agent_environment(
    environ: dict[str, str] | None = None, *, cwd: Path | None = None,
    format_only: bool = False, model: str | None = None, variant: str | None = None,
) -> dict[str, str]:
    env = dict(os.environ if environ is None else environ)
    # DevEco 0.2.4: skip ~/.agents and ~/.claude skill catalogs for this local
    # refactoring task; retain built-in HarmonyOS skills and user provider config.
    env["DEVECO_DISABLE_EXTERNAL_SKILLS"] = "1"
    if cwd is not None:
        # Mirrors have no .git. Never discover the orchestrator's parent repo.
        env["GIT_CEILING_DIRECTORIES"] = str(cwd.resolve().parent)
        for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"):
            env.pop(name, None)
    raw = env.get("DEVECO_CONFIG_CONTENT", "")
    try:
        config = json.loads(raw) if raw.strip() else {}
    except ValueError as error:
        raise ValueError("DEVECO_CONFIG_CONTENT 必须是 JSON 对象，无法安全合并 Agent 策略") from error
    if not isinstance(config, dict):
        raise ValueError("DEVECO_CONFIG_CONTENT 必须是 JSON 对象")
    _configure_coding_plan_variant(config, model, variant)
    disabled_providers = config.get("disabled_providers", [])
    if not isinstance(disabled_providers, list) or not all(isinstance(name, str) for name in disabled_providers):
        raise ValueError("DevEco disabled_providers 配置必须是字符串数组")
    config["disabled_providers"] = list(dict.fromkeys([*disabled_providers, *DISABLED_AGENT_PROVIDERS]))

    def restrict(settings: dict[str, Any]) -> None:
        permission = settings.get("permission", {})
        if isinstance(permission, str):
            permission = {"*": permission}
        if not isinstance(permission, dict) or not isinstance(settings.get("tools", {}), dict):
            raise ValueError("DevEco permission/tools 配置格式无效")
        settings["permission"] = {**permission, **dict.fromkeys(DISABLED_AGENT_TOOLS, "deny")}
        settings["tools"] = {**settings.get("tools", {}), **dict.fromkeys(DISABLED_AGENT_TOOLS, False)}

    restrict(config)
    # Preserve explicit agents supplied in the existing overlay, including other
    # permissions and model options, while preventing a per-agent override.
    agents = config.get("agent", {})
    if not isinstance(agents, dict):
        raise ValueError("DevEco agent 配置必须是对象")
    for settings in agents.values():
        if isinstance(settings, dict):
            restrict(settings)
    if format_only:
        config["agent"] = {**agents, "arkts-review-format": {
            "description": "Only serialize the attached completed review as JSON; no tools or new review.",
            "mode": "primary", "permission": {"*": "deny"}, "tools": {"*": False},
        }}
    env["DEVECO_CONFIG_CONTENT"] = json.dumps(config, ensure_ascii=False)
    return env


def run_agent(
    deveco: Path, task_dir: Path, cwd: Path, prompt_file: Path,
    *, role: str, model: str | None = None, variant: str | None = None,
    title: str | None = None, format_only: bool = False, prompt_via_stdin: bool = False,
) -> int:
    model = resolve_agent_model(model)
    command = [str(deveco), "run", "-m", model]
    if variant:
        command.extend(["--variant", variant])
    if format_only:
        command.extend(["--agent", "arkts-review-format"])
    message = (
        "严格执行附件中的只读评审任务，只输出要求的 JSON。"
        if role.startswith("review") else "严格执行附件中的 ArkTS 重构任务，直接修改工作区内的生产代码。"
    )
    if prompt_via_stdin:
        message = message.replace("附件中", "标准输入中")
    command.append(message)
    if not prompt_via_stdin:
        command.extend(["-f", str(prompt_file.resolve())])
    command.extend(["--dir", str(cwd), "--format", "json"])
    if title:
        command.extend(["--title", title])
    command.append("--dangerously-skip-permissions")
    env = agent_environment(cwd=cwd, format_only=format_only, model=model, variant=variant)
    # Do not persist the merged config: it may contain user credentials. These
    # are requested settings, not proof of the provider's actual reasoning level.
    write_json(task_dir / f"{role}-execution-policy.json", {
        "policyVersion": POLICY_VERSION, "role": role,
        "requestedModel": model, "requestedVariant": variant,
        "requestedReasoningEffort": variant if model == DEFAULT_AGENT_MODEL and variant else None,
        "disabledTools": list(DISABLED_AGENT_TOOLS),
        "disabledProviders": json.loads(env["DEVECO_CONFIG_CONTENT"])["disabled_providers"],
        "validationOwner": "platform", "providerSettingsVerified": False,
        "formatOnly": format_only, "gitCeilingDirectory": env["GIT_CEILING_DIRECTORIES"],
        "externalSkillsDisabled": True,
        "reviewPacketAttached": role == "review" and prompt_file.name == "review-agent-prompt.md",
        "promptTransport": "stdin" if prompt_via_stdin else "file",
    })
    if prompt_via_stdin:
        # DevEco 0.2.4 truncates large -f text attachments. Stdin preserves the
        # full bounded packet and avoids Windows' command-line length limit.
        return subprocess.run(command, cwd=cwd, env=env,
                              input=prompt_file.read_text(encoding="utf-8"), encoding="utf-8").returncode
    return subprocess.run(command, cwd=cwd, env=env).returncode
