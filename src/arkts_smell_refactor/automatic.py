from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from .dataset import load_dataset_tasks
from .prompts import build_refactor_prompt, build_review_prompt
from .risk import analyze_risks
from .runner import execute_pipeline
from .utils import write_json, write_text


def read_pasted_json() -> list[dict[str, Any]]:
    print("请粘贴一条异味 JSON 对象或阳性数据集 JSON 数组。检测到完整 JSON 后会自动开始：")
    lines: list[str] = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        lines.append(line)
        text = "\n".join(lines).strip()
        if not text:
            continue
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            continue
        return _normalize_pasted_data(data)
    if not lines:
        raise ValueError("没有收到 JSON 输入")
    data = json.loads("\n".join(lines))
    return _normalize_pasted_data(data)


def _normalize_pasted_data(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict):
        if "filePath" not in data or not isinstance(data.get("messages"), list):
            raise ValueError("单条 JSON 对象必须包含 filePath 和 messages 数组")
        return [data]
    if isinstance(data, list):
        if not all(isinstance(item, dict) for item in data):
            raise ValueError("JSON 数组中的每一项都必须是对象")
        return data
    raise ValueError("请输入一条异味 JSON 对象 {...} 或阳性数据集 JSON 数组 [{...}]")


def run_interactive(base_dir: Path, workspace_hint: Path | None = None) -> dict[str, Any]:
    data = read_pasted_json()
    session = base_dir / "runs" / datetime.now().strftime("%Y%m%d-%H%M%S")
    session.mkdir(parents=True, exist_ok=False)
    dataset_path = session / "input.json"
    write_json(dataset_path, data)
    workspace = _discover_workspace(data, workspace_hint or Path.cwd())
    print(f"已接收 {sum(len(x.get('messages', [])) for x in data)} 条异味")
    print(f"本地仓库根目录：{workspace}")
    tools = _discover_tools(workspace)
    print("工具发现：" + "，".join(f"{k}={'已找到' if v else '未找到'}" for k, v in tools.items()))

    tasks = load_dataset_tasks(dataset_path, workspace)
    summary: list[dict[str, Any]] = []
    for number, task in enumerate(tasks, 1):
        task_dir = session / task.task_id
        task_dir.mkdir(parents=True)
        risk = analyze_risks(task)
        write_json(task_dir / "task.json", task.to_dict())
        write_json(task_dir / "risk-report.json", risk)
        write_json(task_dir / "review-risk.json", _review_risk(risk))
        write_text(task_dir / "refactor-prompt.md", build_refactor_prompt(task, risk))
        review_prompt = build_review_prompt(task, risk)
        review_prompt += f"\n\n本次直接重构本地当前代码，commitHash 仅为元信息，不得用它作为语义基线。"
        review_prompt += "\n平台会在任务目录生成 baseline-production、current-production、review-context-production 与 review-diff.patch。只允许使用这些材料评审，禁止访问原项目。\n"
        write_text(task_dir / "review-prompt.md", review_prompt)
        print(f"\n[{number}/{len(tasks)}] {task.target.symbol or task.target.file_path}")
        print(f"  静态风险：{risk['riskLevel']}；Refactor Agent 仅接收生产代码与重构规范")
        config = _auto_config(task, task_dir, risk, tools)
        result = execute_pipeline(task_dir, config, progress=lambda name, status: print(f"  {name}: {status}"))
        print(f"  最终结果：{result['verdict']}")
        summary.append({"taskId": task.task_id, "target": task.target.symbol or task.target.file_path, "verdict": result["verdict"], "taskDir": str(task_dir)})
    counts = {name: sum(1 for item in summary if item["verdict"] == name) for name in ("PASS", "FAIL", "BLOCKED", "INCOMPLETE")}
    final = {"sessionDir": str(session), "workspace": str(workspace), "counts": counts, "tasks": summary}
    write_json(session / "summary.json", final)
    print(f"\n完成：PASS={counts['PASS']} FAIL={counts['FAIL']} BLOCKED={counts['BLOCKED']} INCOMPLETE={counts['INCOMPLETE']}")
    print(f"结果目录：{session}")
    return final


def _discover_workspace(data: list[dict[str, Any]], start: Path) -> Path:
    projects = {str(x.get("sourceProject", "")) for x in data if x.get("sourceProject")}
    roots = [start.resolve(), *start.resolve().parents]
    for root in roots:
        for candidate in (root, root / "feature-envy_refactor"):
            if projects and all((candidate / project).is_dir() for project in projects):
                return candidate.resolve()
    raise ValueError("无法自动定位 sourceProject 本地仓库；请在包含这些仓库的目录或其上级目录启动工具")


def _review_risk(risk: dict[str, Any]) -> dict[str, Any]:
    """Remove caller/test evidence already covered by compile and test gates."""
    hidden_codes = {"CALL_SITE_BREAK", "TEST_REFERENCE_BREAK", "TEST_CALLERS"}
    return {
        key: value for key, value in risk.items() if key != "callers"
    } | {
        "risks": [item for item in risk.get("risks", []) if item.get("code") not in hidden_codes],
        "recommendedConstraints": [
            item for item in risk.get("recommendedConstraints", [])
            if item.get("code") not in {"KEEP_COMPATIBILITY_ENTRY"}
        ],
    }


def _discover_tools(workspace: Path) -> dict[str, str | None]:
    homecheck = _find_homecheck(workspace)
    return {
        "deveco": shutil.which("deveco"),
        "hvigorw": shutil.which("hvigorw"),
        "ohpm": shutil.which("ohpm"),
        "codelinter": shutil.which("codelinter"),
        "homecheck": str(homecheck) if homecheck else None,
    }


def _find_homecheck(workspace: Path) -> Path | None:
    candidates = [workspace / "homecheck-extrule", workspace.parent / "homecheck-extrule", Path.cwd() / "homecheck-extrule"]
    for candidate in candidates:
        if (candidate / "node_modules" / "homecheck" / "lib" / "run.js").is_file() and (candidate / "extrulesproject-1.0.0.tgz").is_file():
            return candidate.resolve()
    return None


def _auto_config(task, task_dir: Path, risk: dict[str, Any], tools: dict[str, str | None]) -> dict[str, Any]:
    def missing(name: str) -> dict[str, Any]:
        return {"enabled": False, "reason": f"未找到 {name}"}

    harmony_root = _find_harmony_project_root(Path(task.target_path), Path(task.project_root))
    refactor = {
        "command": [sys.executable, "-m", "arkts_smell_refactor.gate", "refactor", "--task-dir", "{task_dir}", "--source-root", str(harmony_root), "--deveco", tools["deveco"]],
        "cwd": "{task_dir}",
        "blockedOutputRegex": "model service is currently overloaded|service.*overloaded|rate limit|temporarily unavailable",
        "timeoutSeconds": 3600,
    } if tools["deveco"] and harmony_root else None
    repair = {
        "command": [sys.executable, "-m", "arkts_smell_refactor.gate", "refactor", "--task-dir", "{task_dir}", "--source-root", str(harmony_root), "--deveco", tools["deveco"], "--prompt-file", "{repair_prompt_file}"],
        "cwd": "{task_dir}",
        "blockedOutputRegex": "model service is currently overloaded|service.*overloaded|rate limit|temporarily unavailable",
        "timeoutSeconds": 3600,
    } if tools["deveco"] and harmony_root else None
    review = {"command": [tools["deveco"], "run", "严格执行附件中的只读评审任务，只输出要求的 JSON。", "-f", "{review_prompt_file}", "--dir", "{task_dir}", "--format", "json", "--dangerously-skip-permissions"], "cwd": "{task_dir}", "timeoutSeconds": 3600} if tools["deveco"] else None
    smell = {"command": [sys.executable, "-m", "arkts_smell_refactor.gate", "smell", "--task-dir", "{task_dir}", "--source-root", str(harmony_root), "--homecheck-root", tools["homecheck"]], "timeoutSeconds": 1800} if tools["homecheck"] and harmony_root else missing("HomeCheck 或 Harmony 工程根目录")
    environment_blockers = (
        "Invalid project path|Permissions Error|signing|signature|SignHap|"
        "Invalid storeFile value|device not found|no devices"
    )
    build = {"command": _hvigor_gate_command(task_dir, harmony_root, tools, "assembleHap"), "cwd": "{task_dir}", "blockedOutputRegex": environment_blockers, "timeoutSeconds": 3600} if tools["hvigorw"] and harmony_root else missing("hvigorw 或 Harmony 工程根目录")
    test_task = "test"
    test_module = _target_module_name(Path(task.target_path), harmony_root) if harmony_root else None
    test = {"command": _hvigor_gate_command(task_dir, harmony_root, tools, test_task, test_module), "cwd": "{task_dir}", "blockedOutputRegex": environment_blockers, "timeoutSeconds": 3600} if tools["hvigorw"] and harmony_root else missing("hvigorw 或 Harmony 工程根目录")
    linter_config = _find_linter_config(Path(task.target_path), Path(task.project_root))
    if tools["codelinter"] and harmony_root:
        linter_command = [sys.executable, "-m", "arkts_smell_refactor.gate", "linter", "--task-dir", "{task_dir}", "--source-root", str(harmony_root), "--codelinter", tools["codelinter"]]
        if linter_config:
            linter_command.extend(["--config", str(linter_config)])
        linter = {"command": linter_command, "cwd": "{task_dir}", "timeoutSeconds": 1200}
    else:
        linter = missing("codelinter 或 Harmony 工程根目录")
    return {"refactorAgent": refactor, "repairAgent": repair, "maxRepairAttempts": 3, "gates": {"smell": smell, "build": build, "test": test, "linter": linter}, "reviewAgent": review}


def _hvigor_gate_command(task_dir: Path, harmony_root: Path, tools: dict[str, str | None], task_name: str, module: str | None = None) -> list[str]:
    command = [sys.executable, "-m", "arkts_smell_refactor.gate", "hvigor", "--task-dir", "{task_dir}", "--source-root", str(harmony_root), "--hvigorw", str(tools["hvigorw"]), "--task", task_name]
    if tools.get("ohpm"):
        command.extend(["--ohpm", str(tools["ohpm"])])
    if module:
        command.extend(["--module", module])
    return command


def _target_module_name(target: Path, harmony_root: Path) -> str | None:
    for parent in [target.parent, *target.parents]:
        if (parent / "src" / "main").is_dir():
            return parent.name
        if parent == harmony_root:
            break
    return None


def _find_linter_config(target: Path, project_root: Path) -> Path | None:
    for parent in [target.parent, *target.parents]:
        candidate = parent / "code-linter.json5"
        if candidate.is_file():
            return candidate
        if parent == project_root:
            break
    matches = list(project_root.glob("code-linter.json5"))
    return matches[0] if matches else None


def _find_harmony_project_root(target: Path, source_project_root: Path) -> Path | None:
    """Find the nearest buildable Harmony project, not merely the source repository root."""
    for parent in [target.parent, *target.parents]:
        if (parent / "hvigor" / "hvigor-config.json5").is_file() and (parent / "build-profile.json5").is_file():
            return parent.resolve()
        if parent == source_project_root:
            break
    return None
