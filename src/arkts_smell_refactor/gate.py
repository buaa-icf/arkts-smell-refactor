from __future__ import annotations

import argparse
import difflib
import filecmp
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from .runtime_smoke import render_runtime_smoke_list, render_runtime_smoke_test
from .public_contract import compare_public_contract, snapshot_public_contract
from .utils import read_json, write_json


IGNORED_DIRS = {".git", ".hvigor", ".cache", ".test", "build", "coverage", "oh_modules", "node_modules"}
GENERATED_FILES = {"buildprofile.ets", "oh-package-lock.json5"}


def refactor_gate(task_dir: Path, source_root: Path, deveco: Path, prompt_file: Path | None = None) -> int:
    """Run the refactor agent in a production-only mirror, then copy back code only."""
    task = read_json(task_dir / "task.json")
    workspace_name = "refactor-workspace" if prompt_file is None else f"refactor-workspace-{prompt_file.stem}"
    workspace = task_dir / workspace_name
    _fresh_copy(source_root, workspace, exclude_tests=True)
    target_file = Path(task["workspace_root"]) / task["target"]["file_path"]
    try:
        target_relative = target_file.resolve().relative_to(source_root.resolve())
    except ValueError:
        print("目标文件不在检测到的 Harmony 工程内", file=sys.stderr)
        return 3
    prompt = (prompt_file or (task_dir / "refactor-prompt.md")).read_text(encoding="utf-8")
    prompt = prompt.replace(task["target"]["file_path"], target_relative.as_posix())
    agent_prompt = task_dir / "refactor-agent-prompt.md"
    agent_prompt.write_text(prompt, encoding="utf-8")
    completed = subprocess.run(
        [str(deveco), "run", "严格执行附件中的重构任务。", "-f", str(agent_prompt),
         "--dir", str(workspace), "--format", "json", "--dangerously-skip-permissions"],
        cwd=workspace,
    )
    if completed.returncode != 0:
        return completed.returncode
    return _sync_production_changes(workspace, source_root)


def hvigor_gate(task_dir: Path, source_root: Path, hvigorw: Path, ohpm: Path | None, task_name: str, module: str | None = None) -> int:
    """Validate from an ASCII-path copy so hvigor never sees a Chinese project path."""
    tool_root = task_dir.parents[2]
    short_id = hashlib.sha1(str(task_dir).encode("utf-8")).hexdigest()[:8]
    workspace = tool_root / "v" / short_id
    write_json(task_dir / "validation-workspace.json", {"path": str(workspace), "sourceRoot": str(source_root)})
    if not workspace.exists():
        _fresh_copy(source_root, workspace, exclude_tests=False)
    else:
        _overlay_copy(source_root, workspace, exclude_tests=False)
    install_marker = workspace / ".arkts-refactor-ohpm-installed"
    if ohpm and not install_marker.exists():
        installed = subprocess.run([str(ohpm), "install"], cwd=workspace)
        if installed.returncode != 0:
            return installed.returncode
        install_marker.write_text("ok", encoding="ascii")
    command = [str(hvigorw), task_name]
    if task_name == "test":
        if module:
            command.extend(["-p", f"module={module}"])
        command.extend(["-p", "coverage=true"])
    elif task_name == "onDeviceTest":
        command.extend(["-p", "coverage=true"])
    command.append("--no-daemon")
    return subprocess.run(command, cwd=workspace).returncode


def runtime_smoke_gate(
    task_dir: Path, source_root: Path, hvigorw: Path, ohpm: Path | None,
) -> int:
    plan_path = task_dir / "runtime-smoke-plan.json"
    if not plan_path.is_file():
        print("RUNTIME_SMOKE_DISABLED: no plan")
        return 0
    plan = read_json(plan_path)
    if not plan.get("enabled"):
        print("RUNTIME_SMOKE_DISABLED: " + str(plan.get("reason", "risk not triggered")))
        return 0
    baseline = task_dir / "runtime-smoke-baseline"
    if not baseline.is_dir():
        print("RUNTIME_SMOKE_BASELINE_UNAVAILABLE: missing baseline", file=sys.stderr)
        return 3
    baseline_result_path = task_dir / "runtime-smoke-baseline-result.json"
    if baseline_result_path.is_file():
        baseline_result = read_json(baseline_result_path)
    else:
        baseline_result = _run_runtime_smoke_copy(task_dir, baseline, plan, hvigorw, ohpm, "baseline")
        write_json(baseline_result_path, baseline_result)
    if not baseline_result.get("passed"):
        write_json(task_dir / "runtime-smoke-results.json", {
            "schemaVersion": "1.0", "enabled": True, "baseline": baseline_result,
            "current": None, "passed": None, "classification": "BASELINE_UNAVAILABLE",
        })
        print("RUNTIME_SMOKE_BASELINE_UNAVAILABLE: baseline did not pass the same smoke", file=sys.stderr)
        return 3
    current_result = _run_runtime_smoke_copy(task_dir, source_root, plan, hvigorw, ohpm, "current")
    passed = bool(current_result.get("passed"))
    write_json(task_dir / "runtime-smoke-results.json", {
        "schemaVersion": "1.0", "enabled": True, "baseline": baseline_result,
        "current": current_result, "passed": passed,
        "classification": "PASS" if passed else "INTRODUCED_RUNTIME_INITIALIZATION_FAILURE",
    })
    if not passed:
        print("Runtime smoke regression: baseline passes, current source throws or cannot run", file=sys.stderr)
        return 1
    print("Runtime smoke passed")
    return 0


def public_contract_gate(task_dir: Path, source_root: Path) -> int:
    plan_path = task_dir / "public-contract-plan.json"
    before_path = task_dir / "public-contract-before.json"
    if not plan_path.is_file() or not before_path.is_file():
        print("PUBLIC_CONTRACT_DISABLED: no baseline")
        return 0
    plan = read_json(plan_path)
    if not plan.get("enabled"):
        print("PUBLIC_CONTRACT_DISABLED: " + str(plan.get("reason", "no public surface")))
        return 0
    task = read_json(task_dir / "task.json")
    from .runner import _task_from_file
    current = snapshot_public_contract(_task_from_file(task_dir / "task.json"), source_root, plan)
    write_json(task_dir / "public-contract-current.json", current)
    result = compare_public_contract(read_json(before_path), current)
    write_json(task_dir / "public-contract-results.json", result)
    if not result["passed"]:
        print("Public contract regression: export or public member removed/changed", file=sys.stderr)
        return 1
    print("Public contract passed")
    return 0


def _run_runtime_smoke_copy(
    task_dir: Path, source: Path, plan: dict[str, Any], hvigorw: Path,
    ohpm: Path | None, label: str,
) -> dict[str, Any]:
    generated = task_dir / "runtime-smoke-generated"
    generated.mkdir(parents=True, exist_ok=True)
    test_text, list_text = render_runtime_smoke_test(plan), render_runtime_smoke_list()
    (generated / "PublicRuntimeSmoke.test.ets").write_text(test_text, encoding="utf-8")
    (generated / "List.test.ets").write_text(list_text, encoding="utf-8")
    short = hashlib.sha1((str(task_dir) + "-runtime-" + label).encode()).hexdigest()[:8]
    workspace = Path(tempfile.gettempdir()) / "arkts-smell-refactor-runtime" / short
    _fresh_copy(source, workspace, exclude_tests=False)
    module_root = workspace / str(plan["modulePath"])
    tests = module_root / "src" / "test"
    if tests.exists():
        shutil.rmtree(tests)
    tests.mkdir(parents=True)
    (tests / "PublicRuntimeSmoke.test.ets").write_text(test_text, encoding="utf-8")
    (tests / "List.test.ets").write_text(list_text, encoding="utf-8")
    if ohpm:
        installed = subprocess.run([str(ohpm), "install"], cwd=workspace, capture_output=True, text=True)
        install_log = task_dir / f"runtime-smoke-{label}-install.log"
        install_log.write_text((installed.stdout or "") + (installed.stderr or ""), encoding="utf-8")
        if installed.returncode != 0:
            return {"passed": False, "phase": "dependency-install", "exitCode": installed.returncode, "log": str(install_log), "summary": None}
    command = [*_hvigor_launcher(hvigorw), "test", "-p", f"module={plan['module']}", "-p", "coverage=false", "--no-daemon"]
    completed = subprocess.run(command, cwd=workspace, capture_output=True, text=True, encoding="utf-8", errors="replace", env=_deveco_environment(hvigorw))
    log = task_dir / f"runtime-smoke-{label}.log"
    log.write_text((completed.stdout or "") + (completed.stderr or ""), encoding="utf-8")
    result_file = module_root / ".test/default/intermediates/test/coverage_data/test_result.txt"
    summary = _parse_hypium_result(result_file)
    passed = bool(summary and summary["failures"] == 0 and summary["errors"] == 0)
    return {"passed": passed, "phase": "runtime" if summary else "compile-or-run", "exitCode": completed.returncode, "log": str(log), "summary": summary}


def _parse_hypium_result(path: Path) -> dict[str, int] | None:
    if not path.is_file():
        return None
    match = re.search(
        r"Tests run:\s*(\d+),\s*Failure:\s*(\d+),\s*Error:\s*(\d+),\s*Pass:\s*(\d+)",
        path.read_text(encoding="utf-8", errors="replace"),
    )
    if not match:
        return None
    tests, failures, errors, passed = map(int, match.groups())
    return {"tests": tests, "failures": failures, "errors": errors, "passed": passed}


def _hvigor_launcher(hvigorw: Path) -> list[str]:
    if hvigorw.suffix.lower() != ".js":
        return [str(hvigorw)]
    root = hvigorw.parents[3] if len(hvigorw.parents) >= 4 else None
    bundled = root / "tools" / "node" / "bin" / "node" if root else None
    return [str(bundled if bundled and bundled.is_file() else shutil.which("node") or "node"), str(hvigorw)]


def _deveco_environment(hvigorw: Path) -> dict[str, str]:
    env = os.environ.copy()
    root = hvigorw.parents[3] if len(hvigorw.parents) >= 4 else None
    sdk = root / "sdk" if root else None
    java = root / "jbr" / "Contents" / "Home" if root else None
    if sdk and sdk.is_dir():
        env["DEVECO_SDK_HOME"] = str(sdk)
    if java and java.is_dir():
        env["JAVA_HOME"] = str(java)
        env["PATH"] = str(java / "bin") + os.pathsep + env.get("PATH", "")
    return env


def linter_gate(task_dir: Path, source_root: Path, codelinter: Path, config: Path | None) -> int:
    """Fail only for linter defects introduced on changed production lines."""
    changes = read_json(task_dir / "refactor-changes.json").get("changedProductionFiles", [])
    introduced: list[str] = []
    for relative_text in changes:
        relative = Path(relative_text)
        current = source_root / relative
        if not current.is_file():
            continue
        command = [str(codelinter), str(current)]
        if config:
            command.extend(["-c", str(config)])
        command.extend(["-e", "error,warn,suggestion"])
        completed = subprocess.run(
            command,
            cwd=source_root, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        output = (completed.stdout or "") + (completed.stderr or "")
        print(output, end="" if output.endswith("\n") else "\n")
        defect_lines = [int(match.group(1)) for match in re.finditer(r"(?m)^\s*(\d+):(\d+)\s+(?:error|warn|suggestion)\b", output)]
        baseline = task_dir / "baseline-production" / relative
        changed_lines = _changed_current_lines(baseline, current)
        for line in defect_lines:
            if not baseline.exists() or line in changed_lines:
                introduced.append(f"{relative.as_posix()}:{line}")
        if completed.returncode not in {0, 1}:
            return completed.returncode
    if introduced:
        print("本次变更新增或触及 Linter 缺陷：" + ", ".join(introduced), file=sys.stderr)
        return 1
    print("本次变更范围未引入 Linter 缺陷")
    return 0


def _changed_current_lines(baseline: Path, current: Path) -> set[int]:
    current_lines = current.read_text(encoding="utf-8", errors="replace").splitlines()
    if not baseline.exists():
        return set(range(1, len(current_lines) + 1))
    before = baseline.read_text(encoding="utf-8", errors="replace").splitlines()
    changed: set[int] = set()
    for tag, _i1, _i2, j1, j2 in difflib.SequenceMatcher(None, before, current_lines).get_opcodes():
        if tag != "equal":
            changed.update(range(j1 + 1, j2 + 1))
    return changed


def _fresh_copy(source: Path, destination: Path, exclude_tests: bool) -> None:
    if destination.exists():
        _discard_workspace(destination)
    shutil.copytree(source, destination, ignore=_ignore(exclude_tests))


def _discard_workspace(destination: Path) -> None:
    """Remove a generated workspace robustly even when build caches disappear mid-walk."""
    def onexc(function, path, error):
        if isinstance(error, FileNotFoundError):
            return
        try:
            Path(path).chmod(0o700)
            function(path)
        except FileNotFoundError:
            return
        except OSError:
            pass

    for _ in range(2):
        if not destination.exists():
            return
        shutil.rmtree(destination, onexc=onexc)
    if destination.exists():
        stale = destination.with_name(f"{destination.name}.stale-{time.time_ns()}")
        destination.rename(stale)


def _overlay_copy(source: Path, destination: Path, exclude_tests: bool) -> None:
    shutil.copytree(source, destination, dirs_exist_ok=True, ignore=_ignore(exclude_tests))


def _ignore(exclude_tests: bool):
    def callback(directory: str, names: list[str]) -> set[str]:
        ignored = {name for name in names if name in IGNORED_DIRS}
        if exclude_tests and Path(directory).name == "src":
            ignored.update(name for name in names if name.lower() in {"test", "ohostest"})
        return ignored
    return callback


def _sync_production_changes(mirror: Path, source: Path) -> int:
    forbidden: list[str] = []
    changed: list[str] = []
    allowed_changes: list[tuple[Path, Path, Path]] = []
    for mirror_file in mirror.rglob("*"):
        if not mirror_file.is_file() or any(part in IGNORED_DIRS for part in mirror_file.parts):
            continue
        relative = mirror_file.relative_to(mirror)
        # Hvigor creates this module-level file while the agent validates its
        # change. It is a disposable build product, not an agent-authored
        # source/configuration change, and must never be synchronized back.
        if mirror_file.name.lower() in GENERATED_FILES:
            continue
        source_file = source / relative
        differs = not source_file.exists() or not filecmp.cmp(mirror_file, source_file, shallow=False)
        if not differs:
            continue
        normalized = relative.as_posix().lower()
        is_main_source = mirror_file.suffix.lower() in {".ets", ".ts"} and "/src/main/" in f"/{normalized}"
        # Harmony modules expose their production API through a module-root
        # Index.ets. Moving logic into an owning module commonly requires a
        # matching export here, so it is production source rather than config.
        is_module_entry = mirror_file.name.lower() == "index.ets" and len(relative.parts) >= 2
        allowed = is_main_source or is_module_entry
        if not allowed:
            forbidden.append(relative.as_posix())
            continue
        allowed_changes.append((mirror_file, source_file, relative))
    changes_file = mirror.parent / "refactor-changes.json"
    previous = read_json(changes_file).get("changedProductionFiles", []) if changes_file.exists() else []
    combined = list(dict.fromkeys([*previous, *[x[2].as_posix() for x in allowed_changes]]))
    write_json(changes_file, {"changedProductionFiles": combined, "rejectedFiles": forbidden})
    if forbidden:
        print("Refactor Agent 尝试修改非生产代码或配置：" + ", ".join(forbidden), file=sys.stderr)
        return 4
    for mirror_file, source_file, relative in allowed_changes:
        baseline_file = mirror.parent / "baseline-production" / relative
        if source_file.exists() and not baseline_file.exists():
            baseline_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_file, baseline_file)
        source_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(mirror_file, source_file)
        changed.append(relative.as_posix())
    if not changed:
        print("Refactor Agent 未产生允许的生产代码修改", file=sys.stderr)
        return 5
    _prepare_review_materials(mirror.parent, source, combined)
    print("已同步生产代码修改：" + ", ".join(changed))
    return 0


def _prepare_review_materials(task_dir: Path, source: Path, changes: list[str]) -> None:
    """Materialize a review-only evidence pack so the reviewer never needs project access."""
    current_root = task_dir / "current-production"
    context_root = task_dir / "review-context-production"
    if current_root.exists():
        shutil.rmtree(current_root)
    if context_root.exists():
        shutil.rmtree(context_root)
    patch_parts: list[str] = []
    added_text: list[str] = []
    changed_current_files: list[Path] = []
    for relative_text in changes:
        relative = Path(relative_text)
        baseline = task_dir / "baseline-production" / relative
        current = source / relative
        if current.is_file():
            changed_current_files.append(current)
            destination = current_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(current, destination)
        before = baseline.read_text(encoding="utf-8", errors="replace").splitlines() if baseline.is_file() else []
        after = current.read_text(encoding="utf-8", errors="replace").splitlines() if current.is_file() else []
        current_diff = list(difflib.unified_diff(
            before, after,
            fromfile=f"baseline/{relative.as_posix()}",
            tofile=f"current/{relative.as_posix()}",
            lineterm="",
        ))
        patch_parts.extend(current_diff)
        added_text.extend(line[1:] for line in current_diff if line.startswith("+") and not line.startswith("+++"))
    (task_dir / "review-diff.patch").write_text("\n".join(patch_parts) + "\n", encoding="utf-8")
    _collect_review_dependencies(source, changed_current_files, "\n".join(added_text), context_root)


def _collect_review_dependencies(source: Path, changed_files: list[Path], added_text: str, destination: Path) -> None:
    """Copy direct relative imports actually referenced by added lines into the review evidence pack."""
    copied: list[str] = []
    for current in changed_files:
        text = current.read_text(encoding="utf-8", errors="replace")
        for match in re.finditer(r"(?m)^\s*import\s+(.+?)\s+from\s+['\"]([^'\"]+)['\"]", text):
            binding, specifier = match.group(1), match.group(2)
            if not specifier.startswith("."):
                continue
            base = (current.parent / specifier)
            candidates = [base.with_suffix(".ets"), base / "Index.ets", base]
            dependency = next((item for item in candidates if item.is_file()), None)
            if not dependency:
                continue
            try:
                relative = dependency.resolve().relative_to(source.resolve())
            except ValueError:
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dependency, target)
            copied.append(relative.as_posix())
    write_json(destination.parent / "review-context.json", {"productionDependencies": list(dict.fromkeys(copied))})


def smell_gate(task_dir: Path, homecheck_root: Path, source_root: Path | None = None) -> int:
    task = read_json(task_dir / "task.json")
    project_root = Path(task.get("project_root", task.get("projectRoot", "")))
    source_root = source_root or project_root
    source_project = task.get("source_project", task.get("sourceProject", project_root.name))
    rule = task["rule"]
    target = task["target"]
    target_file = target.get("file_path", target.get("filePath", "")).replace("\\", "/")
    symbol = target.get("symbol")
    risk = read_json(task_dir / "risk-report.json") if (task_dir / "risk-report.json").exists() else {}
    expected_owner = risk.get("target", {}).get("owner")
    target_source = Path(task.get("workspace_root", task.get("workspaceRoot", ""))) / target_file
    target_text = target_source.read_text(encoding="utf-8", errors="replace") if target_source.is_file() else ""
    if not target_source.is_file():
        print(f"HomeCheck 指定文件不存在：{target_source}", file=sys.stderr)
        return 3
    try:
        target_source.resolve().relative_to(source_root.resolve())
    except ValueError:
        print(f"HomeCheck 指定文件不在工程目录内：{target_source}", file=sys.stderr)
        return 3

    base_project = read_json(homecheck_root / "config" / "projectConfig.json")
    base_rule = read_json(homecheck_root / "config" / "ruleConfig.json")
    report_dir = task_dir / "homecheck-report"
    scan_files = _smell_scan_files(task_dir, source_root, target_source)
    relative_scan_files = [path.resolve().relative_to(source_root.resolve()).as_posix() for path in scan_files]
    project_config = {
        **base_project,
        "projectName": source_project,
        "projectPath": str(source_root.parent.resolve()),
        "repos": [f"{source_project}={source_root.resolve()}"],
        "checkFiles": relative_scan_files,
        "datasetDir": "",
        "reportDir": str(report_dir.resolve()),
        "logPath": str((report_dir / "HomeCheck.log").resolve()),
        "arkCheckPath": str((homecheck_root / "node_modules" / "homecheck").resolve()),
    }
    package_path = homecheck_root / "extrulesproject-1.0.0.tgz"
    rule_config = {
        **base_rule,
        "files": relative_scan_files,
        "extRuleSet": [
            {
                "ruleSetName": "extrulesproject",
                "packagePath": str(package_path.resolve()),
                "extRules": {rule: 2},
            }
        ],
    }
    report_dir.mkdir(parents=True, exist_ok=True)
    project_path = task_dir / "homecheck-project.json"
    rule_path = task_dir / "homecheck-rule.json"
    write_json(project_path, project_config)
    write_json(rule_path, rule_config)

    runner = homecheck_root / "scripts" / "gitcodeArktsPerfTest.js"
    npm = shutil.which("npm")
    if not runner.is_file() or not npm:
        print(f"HomeCheck 文件级扫描入口或 npm 不存在：{runner}", file=sys.stderr)
        return 3
    smell_name = rule.rsplit("/", 1)[-1].removesuffix("-check")
    completed = subprocess.run(
        [
            npm, "run", "scan:files", "--", "--f1=false", "--dashboard=false",
            f"--files={','.join(relative_scan_files)}",
            f"--baseProjectConfig={project_path}", f"--baseRuleConfig={rule_path}",
            f"--includeRules={smell_name}", f"--outputDir={report_dir}",
        ],
        cwd=homecheck_root,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        return completed.returncode
    issue_candidates = list((report_dir / "runs").glob("*/issuesReport.json"))
    issues_path = issue_candidates[0] if len(issue_candidates) == 1 else report_dir / "issuesReport.json"
    if not issues_path.exists():
        print(f"HomeCheck 未生成 {issues_path}", file=sys.stderr)
        return 3
    issues = read_json(issues_path)
    remaining = []
    short_target = _strip_project(target_file, source_project)
    scan_by_suffix = {
        path.resolve().relative_to(source_root.resolve()).as_posix(): path for path in scan_files
    }
    changed_lines = _smell_changed_lines(task_dir, source_root, scan_files)
    for item in issues if isinstance(issues, list) else []:
        item_path = str(item.get("filePath", "")).replace("\\", "/")
        relative = next((key for key in scan_by_suffix if item_path.endswith(key)), None)
        if relative is None:
            continue
        for message in item.get("messages", []):
            if message.get("rule") != rule:
                continue
            text = str(message.get("message", ""))
            issue_line = int(message.get("line", message.get("rangeStart", 1)))
            is_target_file = item_path.endswith(short_target) or item_path.endswith(target_file)
            reported = _reported_symbol(text)
            same_target = is_target_file and _symbol_matches(reported, symbol)
            if same_target and expected_owner:
                issue_owner = _owner_at_line(target_text, issue_line, target_source.stem)
                same_target = issue_owner == expected_owner
            current_text = scan_by_suffix[relative].read_text(encoding="utf-8", errors="replace")
            changed_symbol = _issue_touches_changed_symbol(
                current_text, reported, issue_line, changed_lines.get(relative, set())
            )
            if same_target or changed_symbol:
                remaining.append({**message, "filePath": item_path})
    write_json(task_dir / "smell-after.json", remaining)
    if remaining:
        print(f"目标异味仍存在：{len(remaining)} 条", file=sys.stderr)
        return 1
    print("目标异味复检未命中")
    return 0


def _strip_project(path: str, project: str) -> str:
    prefix = project.rstrip("/") + "/"
    return path[len(prefix) :] if path.startswith(prefix) else path


def _owner_at_line(text: str, line: int, fallback: str) -> str:
    prefix = "\n".join(text.splitlines()[:max(0, line - 1)])
    owners = list(re.finditer(r"\b(?:class|struct)\s+([A-Za-z_$][\w$]*)", prefix))
    return owners[-1].group(1) if owners else fallback


def _smell_scan_files(task_dir: Path, source_root: Path, target_source: Path) -> list[Path]:
    """Return only the original smell file and changed/new production files."""
    selected = [target_source.resolve()]
    changes_path = task_dir / "refactor-changes.json"
    changes = read_json(changes_path).get("changedProductionFiles", []) if changes_path.exists() else []
    for relative in changes:
        candidate = (source_root / relative).resolve()
        try:
            candidate.relative_to(source_root.resolve())
        except ValueError:
            continue
        if candidate.is_file() and candidate.suffix.lower() in {".ets", ".ts"}:
            selected.append(candidate)
    return list(dict.fromkeys(selected))


def _smell_changed_lines(task_dir: Path, source_root: Path, files: list[Path]) -> dict[str, set[int]]:
    result: dict[str, set[int]] = {}
    baseline_root = task_dir / "baseline-production"
    for current in files:
        relative = current.resolve().relative_to(source_root.resolve())
        baseline = baseline_root / relative
        key = relative.as_posix()
        result[key] = _changed_current_lines(baseline, current) if baseline.exists() else set(range(1, len(current.read_text(encoding="utf-8", errors="replace").splitlines()) + 1))
    return result


def _reported_symbol(message: str) -> str | None:
    match = re.search(r"(?:Method|Function)\s+['\"]([^'\"]+)['\"]", message)
    return match.group(1) if match else None


def _symbol_matches(reported: str | None, target: str | None) -> bool:
    if not reported or not target:
        return False
    reported_short = reported.split(".")[-1]
    target_short = target.split(".")[-1]
    if reported_short == target_short:
        return True
    anonymous = re.fullmatch(r"%AM\d+\$(.+)", reported_short)
    return bool(anonymous and anonymous.group(1) == target_short)


def _issue_touches_changed_symbol(text: str, reported: str | None, issue_line: int, changed: set[int]) -> bool:
    """Attribute an issue to the current diff, never to the dataset's stale line range."""
    if issue_line in changed:
        return True
    span = _symbol_line_span(text, reported)
    return bool(span and any(line in changed for line in range(span[0], span[1] + 1)))


def _symbol_line_span(text: str, symbol: str | None) -> tuple[int, int] | None:
    if not symbol:
        return None
    short = symbol.split(".")[-1]
    anonymous = re.fullmatch(r"%AM\d+\$(.+)", short)
    if anonymous:
        short = anonymous.group(1)
    escaped = re.escape(short)
    patterns = (
        rf"(?m)^\s*(?:(?:export|public|private|protected|static|async)\s+)*(?:function\s+)?{escaped}\s*\([^)]*\)[^{{;]*\{{",
        rf"(?m)^\s*(?:(?:export|public|private|protected|static)\s+)*(?:const|let|var)?\s*{escaped}\s*=.*?=>\s*\{{",
    )
    match = next((found for pattern in patterns if (found := re.search(pattern, text))), None)
    if not match:
        return None
    brace = text.find("{", match.start(), match.end())
    if brace < 0:
        return None
    depth = 0
    end = brace
    for index in range(brace, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                end = index
                break
    return text.count("\n", 0, match.start()) + 1, text.count("\n", 0, end) + 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    smell = sub.add_parser("smell")
    smell.add_argument("--task-dir", required=True, type=Path)
    smell.add_argument("--homecheck-root", required=True, type=Path)
    smell.add_argument("--source-root", type=Path)
    refactor = sub.add_parser("refactor")
    refactor.add_argument("--task-dir", required=True, type=Path)
    refactor.add_argument("--source-root", required=True, type=Path)
    refactor.add_argument("--deveco", required=True, type=Path)
    refactor.add_argument("--prompt-file", type=Path)
    hvigor = sub.add_parser("hvigor")
    hvigor.add_argument("--task-dir", required=True, type=Path)
    hvigor.add_argument("--source-root", required=True, type=Path)
    hvigor.add_argument("--hvigorw", required=True, type=Path)
    hvigor.add_argument("--ohpm", type=Path)
    hvigor.add_argument("--task", required=True)
    hvigor.add_argument("--module")
    linter = sub.add_parser("linter")
    linter.add_argument("--task-dir", required=True, type=Path)
    linter.add_argument("--source-root", required=True, type=Path)
    linter.add_argument("--codelinter", required=True, type=Path)
    linter.add_argument("--config", type=Path)
    runtime = sub.add_parser("runtime-smoke")
    runtime.add_argument("--task-dir", required=True, type=Path)
    runtime.add_argument("--source-root", required=True, type=Path)
    runtime.add_argument("--hvigorw", required=True, type=Path)
    runtime.add_argument("--ohpm", type=Path)
    contract = sub.add_parser("public-contract")
    contract.add_argument("--task-dir", required=True, type=Path)
    contract.add_argument("--source-root", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "smell":
        return smell_gate(args.task_dir.resolve(), args.homecheck_root.resolve(), args.source_root.resolve() if args.source_root else None)
    if args.command == "refactor":
        return refactor_gate(args.task_dir.resolve(), args.source_root.resolve(), args.deveco.resolve(), args.prompt_file.resolve() if args.prompt_file else None)
    if args.command == "linter":
        return linter_gate(args.task_dir.resolve(), args.source_root.resolve(), args.codelinter.resolve(), args.config.resolve() if args.config else None)
    if args.command == "runtime-smoke":
        return runtime_smoke_gate(args.task_dir.resolve(), args.source_root.resolve(), args.hvigorw.resolve(), args.ohpm.resolve() if args.ohpm else None)
    if args.command == "public-contract":
        return public_contract_gate(args.task_dir.resolve(), args.source_root.resolve())
    return hvigor_gate(args.task_dir.resolve(), args.source_root.resolve(), args.hvigorw.resolve(), args.ohpm.resolve() if args.ohpm else None, args.task, args.module)


if __name__ == "__main__":
    raise SystemExit(main())
