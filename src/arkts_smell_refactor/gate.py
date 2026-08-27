from __future__ import annotations

import argparse
import difflib
import filecmp
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

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


def smell_gate(task_dir: Path, homecheck_root: Path) -> int:
    task = read_json(task_dir / "task.json")
    project_root = Path(task.get("project_root", task.get("projectRoot", "")))
    source_project = task.get("source_project", task.get("sourceProject", project_root.name))
    rule = task["rule"]
    target = task["target"]
    target_file = target.get("file_path", target.get("filePath", "")).replace("\\", "/")
    symbol = target.get("symbol")
    risk = read_json(task_dir / "risk-report.json") if (task_dir / "risk-report.json").exists() else {}
    expected_owner = risk.get("target", {}).get("owner")
    target_source = Path(task.get("workspace_root", task.get("workspaceRoot", ""))) / target_file
    target_text = target_source.read_text(encoding="utf-8", errors="replace") if target_source.is_file() else ""

    base_project = read_json(homecheck_root / "config" / "projectConfig.json")
    base_rule = read_json(homecheck_root / "config" / "ruleConfig.json")
    report_dir = task_dir / "homecheck-report"
    project_config = {
        **base_project,
        "projectName": source_project,
        "projectPath": str(project_root.resolve()) + "\\",
        "datasetDir": "",
        "reportDir": str(report_dir.resolve()),
        "logPath": str((report_dir / "HomeCheck.log").resolve()),
        "arkCheckPath": str((homecheck_root / "node_modules" / "homecheck").resolve()),
    }
    package_path = homecheck_root / "extrulesproject-1.0.0.tgz"
    rule_config = {
        **base_rule,
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

    runner = homecheck_root / "node_modules" / "homecheck" / "lib" / "run.js"
    completed = subprocess.run(
        ["node", str(runner), "--configPath", str(rule_path), "--projectConfigPath", str(project_path)],
        cwd=homecheck_root,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        return completed.returncode
    issues_path = report_dir / "issuesReport.json"
    if not issues_path.exists():
        print(f"HomeCheck 未生成 {issues_path}", file=sys.stderr)
        return 3
    issues = read_json(issues_path)
    remaining = []
    short_target = _strip_project(target_file, source_project)
    for item in issues if isinstance(issues, list) else []:
        item_path = str(item.get("filePath", "")).replace("\\", "/")
        if not (item_path.endswith(short_target) or item_path.endswith(target_file)):
            continue
        for message in item.get("messages", []):
            if message.get("rule") != rule:
                continue
            text = str(message.get("message", ""))
            if symbol and not re.search(rf"['\"]{re.escape(symbol)}['\"]", text):
                continue
            issue_owner = _owner_at_line(target_text, int(message.get("line", 1)), target_source.stem)
            if expected_owner and issue_owner != expected_owner:
                continue
            remaining.append(message)
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    smell = sub.add_parser("smell")
    smell.add_argument("--task-dir", required=True, type=Path)
    smell.add_argument("--homecheck-root", required=True, type=Path)
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
    args = parser.parse_args(argv)
    if args.command == "smell":
        return smell_gate(args.task_dir.resolve(), args.homecheck_root.resolve())
    if args.command == "refactor":
        return refactor_gate(args.task_dir.resolve(), args.source_root.resolve(), args.deveco.resolve(), args.prompt_file.resolve() if args.prompt_file else None)
    if args.command == "linter":
        return linter_gate(args.task_dir.resolve(), args.source_root.resolve(), args.codelinter.resolve(), args.config.resolve() if args.config else None)
    return hvigor_gate(args.task_dir.resolve(), args.source_root.resolve(), args.hvigorw.resolve(), args.ohpm.resolve() if args.ohpm else None, args.task, args.module)


if __name__ == "__main__":
    raise SystemExit(main())
