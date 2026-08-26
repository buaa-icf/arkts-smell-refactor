from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from .models import CommandResult, RefactorTask
from .utils import read_json, write_json, write_text


PLACEHOLDERS = {
    "task_dir",
    "task_file",
    "risk_file",
    "prompt_file",
    "review_prompt_file",
    "project_root",
    "workspace_root",
    "target_file",
}


def load_config(path: Path) -> dict[str, Any]:
    data = read_json(path)
    if not isinstance(data, dict):
        raise ValueError("配置文件顶层必须是 JSON 对象")
    return data


def execute_pipeline(task_dir: Path, config: dict[str, Any], dry_run: bool = False, progress=None) -> dict[str, Any]:
    task = _task_from_file(task_dir / "task.json")
    context = _context(task_dir, task)
    results: list[CommandResult] = []

    refactor = config.get("refactorAgent")
    if refactor:
        if progress: progress("重构 Agent", "开始")
        results.append(_run_spec("refactor-agent", refactor, context, task.project_root, task_dir, dry_run))
        if progress: progress("重构 Agent", results[-1].status)
    else:
        results.append(CommandResult("refactor-agent", "SKIPPED", reason="config 未配置 refactorAgent"))

    if refactor and not dry_run and results[-1].status != "PASS":
        reason = "重构 Agent 未成功，后续验证没有可验证的重构结果"
        gate_results = [CommandResult(name, "SKIPPED", reason=reason) for name in ("smell", "build", "test", "linter")]
        write_json(task_dir / "gates.json", {
            "schemaVersion": "1.0",
            "taskId": task.task_id,
            "gates": [item.to_dict() for item in gate_results],
        })
        results.extend(gate_results)
        results.append(CommandResult("review-agent", "SKIPPED", reason=reason))
        result = _final_result(task.task_id, results, dry_run)
        write_json(task_dir / "result.json", result)
        return result

    gate_results: list[CommandResult] = []
    for gate_name in ("smell", "build", "test", "linter"):
        spec = config.get("gates", {}).get(gate_name)
        if not spec or not spec.get("enabled", True):
            gate_results.append(CommandResult(gate_name, "SKIPPED", reason="未配置或已禁用"))
            continue
        if progress: progress(gate_name, "开始")
        gate_results.append(_run_spec(gate_name, spec, context, task.project_root, task_dir, dry_run))
        if progress: progress(gate_name, gate_results[-1].status)

    preliminary = {
        "schemaVersion": "1.0",
        "taskId": task.task_id,
        "gates": [item.to_dict() for item in gate_results],
    }
    write_json(task_dir / "gates.json", preliminary)
    results.extend(gate_results)

    review = config.get("reviewAgent")
    if review:
        if progress: progress("评审 Agent", "开始")
        review_result = _run_spec("review-agent", review, context, task.project_root, task_dir, dry_run)
        results.append(review_result)
        if review_result.status == "PASS" and not dry_run:
            review_json = _extract_review_json(task_dir / "review-agent.log", task_dir / "review.json")
            if review_json:
                verdict = str(review_json.get("verdict", "UNCERTAIN")).upper()
                review_result.status = verdict if verdict in {"PASS", "FAIL"} else "BLOCKED"
                review_result.reason = None if verdict in {"PASS", "FAIL"} else "评审输出为 UNCERTAIN 或缺少有效 verdict"
        if progress: progress("评审 Agent", review_result.status)
    else:
        results.append(CommandResult("review-agent", "SKIPPED", reason="config 未配置 reviewAgent"))

    result = _final_result(task.task_id, results, dry_run)
    write_json(task_dir / "result.json", result)
    return result


def _run_spec(name: str, spec: dict[str, Any], context: dict[str, str], default_cwd: str, task_dir: Path, dry_run: bool) -> CommandResult:
    command = spec.get("command")
    if not command:
        return CommandResult(name, "SKIPPED", reason="缺少 command")
    rendered = _render_command(command, context)
    cwd = Path(_render(str(spec.get("cwd", default_cwd)), context))
    if dry_run:
        return CommandResult(name, "DRY_RUN", command=_display_command(rendered), reason=f"cwd={cwd}")
    if not cwd.exists():
        return CommandResult(name, "BLOCKED", command=_display_command(rendered), reason=f"工作目录不存在：{cwd}")

    started = time.monotonic()
    timeout = int(spec.get("timeoutSeconds", 1800))
    try:
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        process = subprocess.Popen(
            rendered,
            cwd=cwd,
            shell=isinstance(rendered, str),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=None,
            creationflags=creationflags,
            start_new_session=os.name != "nt",
        )
        stdout, stderr = process.communicate(timeout=timeout)
        output = (stdout or "") + ("\n" + stderr if stderr else "")
        log_file = task_dir / f"{name}.log"
        write_text(log_file, output)
        success_regex = spec.get("successOutputRegex")
        blocked_regex = spec.get("blockedOutputRegex")
        passed = process.returncode == 0 or bool(success_regex and re.search(str(success_regex), output, re.IGNORECASE))
        blocked = bool(not passed and blocked_regex and re.search(str(blocked_regex), output, re.IGNORECASE))
        return CommandResult(
            name=name,
            status="PASS" if passed else ("BLOCKED" if blocked else "FAIL"),
            command=_display_command(rendered),
            exit_code=process.returncode,
            duration_seconds=round(time.monotonic() - started, 3),
            output_file=str(log_file),
            reason="环境或工具链阻塞" if blocked else None,
        )
    except subprocess.TimeoutExpired as error:
        _terminate_process_tree(process)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate()
        log_file = task_dir / f"{name}.log"
        output = _as_text(stdout or error.stdout) + ("\n" + _as_text(stderr or error.stderr) if stderr or error.stderr else "")
        write_text(log_file, output + "\nTIMEOUT")
        return CommandResult(name, "BLOCKED", _display_command(rendered), duration_seconds=round(time.monotonic() - started, 3), output_file=str(log_file), reason=f"超过 {timeout} 秒")
    except OSError as error:
        return CommandResult(name, "BLOCKED", _display_command(rendered), duration_seconds=round(time.monotonic() - started, 3), reason=str(error))


def _terminate_process_tree(process: subprocess.Popen) -> None:
    """Terminate the whole command tree so inherited pipes cannot hang timeout cleanup."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _as_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value


def _render_command(command: Any, context: dict[str, str]) -> str | list[str]:
    if isinstance(command, list):
        return [_render(str(item), context) for item in command]
    if isinstance(command, str):
        return _render(command, context)
    raise ValueError("command 必须是字符串或字符串数组")


def _render(value: str, context: dict[str, str]) -> str:
    result = value
    for key in PLACEHOLDERS:
        result = result.replace("{" + key + "}", context[key])
    return result


def _display_command(command: str | list[str]) -> str:
    return command if isinstance(command, str) else subprocess.list2cmdline(command)


def _context(task_dir: Path, task: RefactorTask) -> dict[str, str]:
    return {
        "task_dir": str(task_dir.resolve()),
        "task_file": str((task_dir / "task.json").resolve()),
        "risk_file": str((task_dir / "risk-report.json").resolve()),
        "prompt_file": str((task_dir / "refactor-prompt.md").resolve()),
        "review_prompt_file": str((task_dir / "review-prompt.md").resolve()),
        "project_root": task.project_root,
        "workspace_root": task.workspace_root,
        "target_file": str(task.target_path.resolve()),
    }


def _task_from_file(path: Path) -> RefactorTask:
    raw = read_json(path)
    target = raw["target"]
    range_data = target.get("range", {})
    from .models import SourceRange, Target
    return RefactorTask(
        schema_version=raw["schema_version"] if "schema_version" in raw else raw["schemaVersion"],
        task_id=raw["task_id"] if "task_id" in raw else raw["taskId"],
        source_project=raw.get("source_project", raw.get("sourceProject", "")),
        commit_hash=raw.get("commit_hash", raw.get("commitHash", "")),
        workspace_root=raw.get("workspace_root", raw.get("workspaceRoot", "")),
        project_root=raw.get("project_root", raw.get("projectRoot", "")),
        smell_type=raw.get("smell_type", raw.get("smellType", "")),
        rule=raw["rule"], severity=raw.get("severity", ""), message=raw["message"],
        target=Target(target["file_path"] if "file_path" in target else target["filePath"], target.get("symbol"), SourceRange(range_data.get("start_line", range_data.get("startLine")), range_data.get("end_line", range_data.get("endLine")), range_data.get("column")), target.get("related_targets", target.get("relatedTargets", []))),
        raw=raw.get("raw", {}),
    )


def _extract_review_json(log_path: Path, output_path: Path) -> dict[str, Any] | None:
    text = log_path.read_text(encoding="utf-8")
    candidates: list[dict[str, Any]] = []

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            verdict = str(value.get("verdict", "")).upper()
            if verdict in {"PASS", "FAIL", "UNCERTAIN"}:
                candidates.append(value)
            for nested in value.values():
                collect(nested)
        elif isinstance(value, list):
            for nested in value:
                collect(nested)
        elif isinstance(value, str) and "verdict" in value:
            collect_json_text(value)

    def collect_json_text(value: str) -> None:
        decoder = json.JSONDecoder()
        for index, char in enumerate(value):
            if char != "{":
                continue
            try:
                data, _ = decoder.raw_decode(value[index:])
            except json.JSONDecodeError:
                continue
            collect(data)

    # 支持旧版 default 文本日志，也支持 --format json 的 JSONL 事件日志。
    for line in text.splitlines():
        try:
            collect(json.loads(line))
        except json.JSONDecodeError:
            collect_json_text(line)
    if not candidates:
        return None
    data = candidates[-1]
    write_json(output_path, data)
    return data


def _final_result(task_id: str, results: list[CommandResult], dry_run: bool) -> dict[str, Any]:
    statuses = [item.status for item in results]
    if dry_run:
        verdict = "DRY_RUN"
    elif "FAIL" in statuses:
        verdict = "FAIL"
    elif "BLOCKED" in statuses:
        verdict = "BLOCKED"
    elif all(status == "PASS" for status in statuses):
        verdict = "PASS"
    else:
        verdict = "INCOMPLETE"
    return {"schemaVersion": "1.0", "taskId": task_id, "verdict": verdict, "steps": [item.to_dict() for item in results]}
