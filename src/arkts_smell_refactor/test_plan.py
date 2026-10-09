"""Conservative test discovery; never infer a test kind from the dataset location."""
from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

from .analysis.switch_statement import _mask_comments, _mask_non_code
from .linter_profile import _members, _tokens
from .utils import read_json


TEST_KINDS = {"local": ("src/test", "test"), "instrument": ("src/ohosTest", "onDeviceTest")}
_TEST_SUFFIXES = (".ets", ".ts", ".js")
_IMPORT = re.compile(
    r'''\b(?:import|export)\s+(?:(?:[^;'"`]+?)\s+from\s*)?['"]([^'"\r\n]+)['"]'''
)


def project_modules(source_root: Path) -> dict[str, Path]:
    # Reuse the non-evaluating JSON5 lexer: nested targets, comments, unquoted
    # keys and trailing commas must not confuse name/srcPath extraction.
    profile = dict(_members(_tokens((source_root / "build-profile.json5").read_text(encoding="utf-8-sig"))))
    tokens = profile.get("modules", [])
    if not tokens or tokens[0] != "[" or tokens[-1] != "]":
        raise ValueError("build-profile.json5 has no modules array")
    modules: dict[str, Path] = {}
    index = 1
    while index < len(tokens) - 1:
        if tokens[index] == ",":
            index += 1
            continue
        start, depth = index, 0
        if tokens[index] != "{":
            raise ValueError("Invalid module entry")
        while index < len(tokens) - 1:
            token = tokens[index]
            depth += (token == "{") - (token == "}")
            index += 1
            if depth == 0:
                break
        fields = dict(_members(tokens[start:index]))
        name = _string(fields.get("name", []))
        path = (source_root / _string(fields.get("srcPath", []))).resolve()
        if not name or name in modules or not path.is_relative_to(source_root.resolve()):
            raise ValueError("Invalid, duplicate or external module")
        modules[name] = path
    if not modules:
        raise ValueError("No project modules")
    return modules


def _string(tokens: list[str]) -> str:
    if len(tokens) != 1 or not tokens[0].startswith(("'", '"')):
        raise ValueError("Expected a literal string")
    value = ast.literal_eval(tokens[0])
    if not isinstance(value, str):
        raise ValueError("Expected a literal string")
    return value


def _test_files(module_root: Path, kind: str) -> list[Path]:
    directory = (module_root / TEST_KINDS[kind][0]).resolve()
    candidates = {path for path in directory.rglob("*.test.*")
                  if path.suffix in _TEST_SUFFIXES and path.stem != "List.test"}
    entries = sorted(path for path in directory.rglob("List.test.*") if path.suffix in _TEST_SUFFIXES)
    if not entries:
        # Custom runners may not use List.test. Do not silently discard a test
        # kind whose registration cannot be established statically.
        return sorted(candidates)
    reachable: set[Path] = set()
    pending = list(entries)
    while pending:
        path = pending.pop()
        if path in reachable:
            continue
        reachable.add(path)
        text = _mask_comments(path.read_text(encoding="utf-8-sig"))
        code = _mask_non_code(text)
        if re.search(r"\b(?:import|require)\s*\(", code):
            return sorted(candidates)  # Dynamic registration: retain conservative validation.
        for match in _IMPORT.finditer(text):
            if not code[match.start():match.start() + 6].strip():
                continue  # An import-looking string is not a dependency.
            declaration = match.group()
            if re.match(r"(?:import|export)\s+type\b", declaration):
                continue
            specifier = match[1]
            if not specifier.startswith("."):
                continue
            base = path.parent / specifier
            options = [base] + [Path(str(base) + suffix) for suffix in _TEST_SUFFIXES]
            options += [base / ("index" + suffix) for suffix in _TEST_SUFFIXES]
            dependency = next((item.resolve() for item in options if item.is_file()), None)
            if dependency is None:
                # A missing import may be a broken registration. Let the actual
                # compile/result check expose it instead of declaring no tests.
                return sorted(candidates)
            if dependency.is_relative_to(directory):
                pending.append(dependency)
    return sorted(candidates & reachable)


def _suite_names(path: Path) -> list[str]:
    text = _mask_comments(path.read_text(encoding="utf-8-sig"))
    return sorted(set(re.findall(r"\bdescribe\s*\(\s*['\"]([^'\"\r\n]+)['\"]\s*,", text)))


def build_test_plan(task_dir: Path, source_root: Path, mode: str = "auto-test", module: str | None = None) -> dict[str, Any]:
    """Prefer suites named for dataset targets; otherwise run both available kinds.

    List.test import reachability filters out dormant files before filename
    matching. It is a convention, not a coverage claim. An unmatched target
    widens the entire module to all tests. New affected modules also run in full.
    Actual suite execution is checked against fresh Hypium results by the gate.
    """
    source_root = source_root.resolve()
    modules = project_modules(source_root)
    affected: dict[str, set[Path]] = {}

    def add(path: Path, target: bool) -> None:
        path = path.resolve()
        owners = [(name, root) for name, root in modules.items() if path.is_relative_to(root)]
        if not owners:
            raise ValueError(f"No module owns test target: {path}")
        name, _ = max(owners, key=lambda pair: len(pair[1].parts))
        affected.setdefault(name, set())
        if target:
            affected[name].add(path)

    if mode == "auto-test":
        task = read_json(task_dir / "task.json")
        base = Path(task["workspace_root"])
        add(base / task["target"]["file_path"], True)
        for item in task["target"].get("related_targets", []):
            add(base / item["filePath"], True)
        changes_file = task_dir / "refactor-changes.json"
        if changes_file.exists():
            changes = read_json(changes_file)
            for relative in changes.get("changedProductionFiles", []):
                add(source_root / relative, False)
            for item in changes.get("changedProductionResources", []):
                add(source_root / (item["filePath"] if isinstance(item, dict) else item), False)
    else:
        if module:
            name = module.removesuffix("@ohosTest")
            if name not in modules:
                raise ValueError(f"Unknown test module: {name}")
            affected[name] = set()
        else:
            kind = "local" if mode == "test" else "instrument"
            affected = {name: set() for name, root in modules.items() if _test_files(root, kind)}
            if not affected:
                raise ValueError(f"No runnable {kind} tests in project")

    kinds = list(TEST_KINDS) if mode == "auto-test" else ["local" if mode == "test" else "instrument"]
    inventory = {(name, kind): _test_files(root, kind) for name, root in modules.items() for kind in kinds}
    matches: dict[tuple[str, str], set[Path]] = {}
    fallback: set[str] = set()
    for owner, targets in affected.items():
        if not targets:
            fallback.add(owner)
        for target in targets:
            found = False
            # UI suites can be hosted by the entry/phone module rather than the
            # HAR that owns the page. Search every declared module in this app.
            for key, files in inventory.items():
                selected = {path for path in files if path.stem in {target.stem + ".test", target.stem + "Test.test"}}
                if selected:
                    found = True
                    matches.setdefault(key, set()).update(selected)
                    if any(not _suite_names(path) or any(c in suite for suite in _suite_names(path) for c in "#,")
                           for path in selected):
                        fallback.add(key[0])
            if not found:
                fallback.add(owner)
    jobs: list[dict[str, Any]] = []
    for name in sorted(fallback | {key[0] for key in matches}):
        root = modules[name]
        specific = name not in fallback
        count_before = len(jobs)
        for kind in kinds:
            selected = sorted(matches.get((name, kind), set())) if specific else inventory[name, kind]
            if not selected:
                continue
            suites = sorted({suite for path in selected for suite in _suite_names(path)})
            # One suite per invocation avoids relying on SDK-specific multi-scope syntax.
            for scope in suites if specific else [None]:
                jobs.append({
                    "kind": kind, "task": TEST_KINDS[kind][1], "module": name,
                    "modulePath": root.relative_to(source_root).as_posix(), "scope": scope,
                    "expectedSuites": [scope] if scope else suites,
                    "testFiles": [path.relative_to(source_root).as_posix() for path in selected],
                    "reason": "target-named-suite" if specific else "module-fallback-all-available-kinds",
                })
        if len(jobs) == count_before:
            raise ValueError(f"No runnable test files in affected module: {name}")
    return {"schemaVersion": "1.0", "mode": mode, "jobs": jobs}
