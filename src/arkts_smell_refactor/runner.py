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
    "repair_prompt_file",
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
        gate_names = ["smell", "build"]
        if "contract" in config.get("gates", {}):
            gate_names.append("contract")
        if "runtime" in config.get("gates", {}):
            gate_names.append("runtime")
        gate_names.extend(["test", "linter"])
        gate_results = [CommandResult(name, "SKIPPED", reason=reason) for name in gate_names]
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

    max_repairs = int(config.get("maxRepairAttempts", 3))
    repair_spec = config.get("repairAgent")
    attempts: list[dict[str, Any]] = []
    terminal: list[CommandResult] = []
    repair_number = 0

    while True:
        suffix = "" if repair_number == 0 else f"-repair-{repair_number}"
        gate_results = _run_gates_fail_fast(task_dir, task, config, context, dry_run, progress, suffix)
        results.extend(gate_results)
        write_json(task_dir / "gates.json", {
            "schemaVersion": "1.0", "taskId": task.task_id,
            "attempt": repair_number, "gates": [item.to_dict() for item in gate_results],
        })

        accepted = {"PASS", "DRY_RUN"} if dry_run else {"PASS"}
        by_name = {item.name: item for item in gate_results}
        core_names = [name + suffix for name in ("smell", "build", "test", "linter")]
        core_pass = all(name in by_name and by_name[name].status in accepted for name in core_names)
        runtime_name = "runtime" + suffix
        runtime_pass = runtime_name not in by_name or by_name[runtime_name].status in accepted
        contract_name = "contract" + suffix
        contract_pass = contract_name not in by_name or by_name[contract_name].status in accepted
        if core_pass and contract_pass and runtime_pass:
            review = config.get("reviewAgent")
            if review:
                review_name = "review-agent" + suffix
                if progress: progress("评审 Agent", "开始")
                review_result = _run_spec(review_name, review, context, str(task_dir), task_dir, dry_run)
                if review_result.status == "PASS" and not dry_run:
                    review_path = task_dir / f"{review_name}.log"
                    review_json = _extract_review_json(review_path, task_dir / "review.json")
                    if review_json:
                        verdict = str(review_json.get("verdict", "UNCERTAIN")).upper()
                        review_result.status = verdict if verdict in {"PASS", "FAIL"} else "BLOCKED"
                        review_result.reason = None if verdict in {"PASS", "FAIL"} else "评审输出为 UNCERTAIN 或缺少有效 verdict"
                results.append(review_result)
                terminal = [*gate_results, review_result]
                if progress: progress("评审 Agent", review_result.status)
            else:
                skipped = CommandResult("review-agent" + suffix, "SKIPPED", reason="config 未配置 reviewAgent")
                results.append(skipped)
                terminal = [*gate_results, skipped]
        else:
            reason = "前四层门禁未全部通过，Review 不执行"
            skipped = CommandResult("review-agent" + suffix, "SKIPPED", reason=reason)
            results.append(skipped)
            terminal = [*gate_results, skipped]

        failed = next((item for item in terminal if item.status in {"FAIL", "BLOCKED"}), None)
        attempts.append({"attempt": repair_number, "steps": [item.to_dict() for item in terminal]})
        if dry_run or not failed or failed.status == "BLOCKED" or repair_number >= max_repairs or not repair_spec:
            break

        failure = _build_failure_report(task_dir, task, failed, repair_number + 1)
        write_json(task_dir / "failure-report.json", failure)
        write_json(task_dir / f"failure-report-{repair_number + 1}.json", failure)
        if not failure["repairable"]:
            break
        from .prompts import build_repair_prompt
        risk = read_json(task_dir / "risk-report.json")
        repair_number += 1
        repair_prompt = task_dir / f"repair-prompt-{repair_number}.md"
        write_text(repair_prompt, build_repair_prompt(task, risk, failure, repair_number))
        context["repair_prompt_file"] = str(repair_prompt.resolve())
        if progress: progress(f"修复 Agent 第{repair_number}轮", "开始")
        repair_result = _run_spec(f"repair-agent-{repair_number}", repair_spec, context, task.project_root, task_dir, False)
        results.append(repair_result)
        if progress: progress(f"修复 Agent 第{repair_number}轮", repair_result.status)
        if repair_result.status != "PASS":
            terminal = [repair_result]
            attempts.append({"attempt": repair_number, "steps": [repair_result.to_dict()]})
            if repair_result.status == "BLOCKED" or repair_number >= max_repairs:
                break
            continue

    result = _final_result(task.task_id, results, dry_run, terminal)
    result["repairAttempts"] = repair_number
    result["attempts"] = attempts
    write_json(task_dir / "result.json", result)
    return result


def _run_gates_fail_fast(task_dir: Path, task: RefactorTask, config: dict[str, Any], context: dict[str, str], dry_run: bool, progress, suffix: str) -> list[CommandResult]:
    gate_results: list[CommandResult] = []
    stopped_by: str | None = None
    gate_names = ["smell", "build"]
    if "contract" in config.get("gates", {}):
        gate_names.append("contract")
    if "runtime" in config.get("gates", {}):
        gate_names.append("runtime")
    gate_names.extend(["test", "linter"])
    for gate_name in gate_names:
        display = gate_name
        result_name = gate_name + suffix
        if stopped_by:
            gate_results.append(CommandResult(result_name, "SKIPPED", reason=f"{stopped_by} 未通过，fail-fast 跳过"))
            continue
        spec = config.get("gates", {}).get(gate_name)
        if not spec or not spec.get("enabled", True):
            gate_results.append(CommandResult(result_name, "SKIPPED", reason="未配置或已禁用"))
            continue
        if progress: progress(display, "开始")
        current = _run_spec(result_name, spec, context, task.project_root, task_dir, dry_run)
        gate_results.append(current)
        if progress: progress(display, current.status)
        if not dry_run and current.status != "PASS":
            stopped_by = display
    return gate_results


def _build_failure_report(task_dir: Path, task: RefactorTask, failed: CommandResult, next_attempt: int) -> dict[str, Any]:
    logical_stage = failed.name.split("-repair-", 1)[0]
    review = read_json(task_dir / "review.json") if logical_stage == "review-agent" and (task_dir / "review.json").exists() else {}
    issues = review.get("issues", []) if isinstance(review, dict) else []
    if logical_stage == "smell" and (task_dir / "smell-after.json").exists():
        issues = [
            {
                "category": "remaining-smell",
                "filePath": task.target.file_path,
                "line": item.get("line"),
                "reason": item.get("message", "目标异味仍存在"),
            }
            for item in read_json(task_dir / "smell-after.json")
        ]
    log_text = ""
    if failed.output_file and Path(failed.output_file).is_file():
        log_text = Path(failed.output_file).read_text(encoding="utf-8", errors="replace")[-12000:]
    if logical_stage == "runtime" and (task_dir / "runtime-smoke-results.json").is_file():
        current = read_json(task_dir / "runtime-smoke-results.json").get("current") or {}
        runtime_log = Path(str(current.get("log", "")))
        if runtime_log.is_file(): log_text = runtime_log.read_text(encoding="utf-8", errors="replace")[-12000:]
    if logical_stage == "contract" and (task_dir / "public-contract-results.json").is_file():
        log_text = json.dumps(read_json(task_dir / "public-contract-results.json"), ensure_ascii=False, indent=2)
    changes = read_json(task_dir / "refactor-changes.json").get("changedProductionFiles", []) if (task_dir / "refactor-changes.json").exists() else []
    attributable = any(Path(item).name.lower() in log_text.lower() or item.lower() in log_text.lower() for item in changes)
    if logical_stage in {"smell", "contract", "runtime", "linter", "review-agent"}:
        repairable = True
    elif logical_stage in {"build", "test"}:
        repairable = attributable or (task.target.symbol and task.target.symbol.lower() in log_text.lower())
    else:
        repairable = False
    classification = {
        "smell": "SMELL_REMAINS_OR_MOVED",
        "build": "INTRODUCED_BUILD_FAILURE" if repairable else "UNATTRIBUTED_BUILD_FAILURE",
        "test": "RELATED_TEST_FAILURE" if repairable else "UNATTRIBUTED_TEST_FAILURE",
        "linter": "INTRODUCED_LINTER_FAILURE",
        "runtime": "INTRODUCED_RUNTIME_INITIALIZATION_FAILURE",
        "contract": "PUBLIC_CONTRACT_BREAK",
        "review-agent": "SEMANTIC_REVIEW_FAILURE",
    }.get(logical_stage, "UNSUPPORTED_FAILURE")
    summary = review.get("summary") if isinstance(review, dict) else None
    return {
        "schemaVersion": "1.0", "attempt": next_attempt, "stage": logical_stage,
        "classification": classification, "repairable": repairable,
        "summary": summary or failed.reason or f"{logical_stage} 未通过",
        "changedProductionFiles": changes, "issues": issues,
        "logTail": log_text,
    }


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
        "repair_prompt_file": str((task_dir / "repair-prompt.md").resolve()),
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


def _final_result(task_id: str, results: list[CommandResult], dry_run: bool, terminal: list[CommandResult] | None = None) -> dict[str, Any]:
    statuses = [item.status for item in (terminal or results)]
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
