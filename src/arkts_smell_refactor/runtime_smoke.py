"""Risk-triggered, public runtime smoke planning and test generation."""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from .models import RefactorTask
from .utils import write_json


CONTEXT_SIGNAL_RE = re.compile(r"\b(?:getContext|resourceManager)\b")
UNSAFE_PROBE_NAME_RE = re.compile(r"^(?:add|clear|create|delete|destroy|dispose|init|load|login|logout|remove|reset|save|set|update)", re.I)
SAFE_PROBE_NAME_RE = re.compile(r"^(?:calculate|cal|get|has|is|list|read|size)", re.I)


def build_runtime_smoke_plan(task: RefactorTask, risk: dict[str, Any]) -> dict[str, Any]:
    base = {
        "schemaVersion": "1.0", "kind": "ordinary-construction",
        "enabled": False, "taskId": task.task_id, "hiddenTestsUsed": False,
    }
    analysis = risk.get("godClassAnalysis")
    if task.smell_type != "god-class" or not analysis or not task.target.symbol:
        return {**base, "reason": "ordinary-construction smoke currently supports explicit God Class targets"}
    source = task.target_path.read_text(encoding="utf-8", errors="replace")
    matches = list(CONTEXT_SIGNAL_RE.finditer(source))
    if not matches:
        return {**base, "reason": "no getContext/resourceManager risk"}
    constructor = next((item for item in analysis.get("methods", []) if item.get("name") == "constructor"), None)
    if constructor and int(constructor.get("requiredParameterCount", 0)) != 0:
        return {**base, "reason": "constructor requires arguments; planner does not invent inputs"}
    context = task.raw.get("analysisContext", {})
    inferred = _infer_module(task)
    module_path = str(context.get("modulePath") or inferred.get("modulePath", ""))
    module = str(context.get("module") or inferred.get("module", ""))
    if not module_path or not module:
        return {**base, "reason": "analysisContext.module/modulePath is required"}
    module_index = Path(task.project_root) / module_path / "Index.ets"
    index_text = module_index.read_text(encoding="utf-8", errors="replace") if module_index.is_file() else ""
    symbol = task.target.symbol
    if re.search(rf"\b{re.escape(symbol)}\b", index_text):
        public_import, public_surface = "../../Index", "module-index"
    elif re.search(rf"\bexport\s+class\s+{re.escape(symbol)}\b", source):
        relative = Path(task.target.file_path).relative_to(module_path).with_suffix("").as_posix().removeprefix("src/")
        public_import, public_surface = "../" + relative, "exported-target-file"
    else:
        return {**base, "reason": "target class is not publicly importable"}
    return {
        **base, "enabled": True,
        "reason": "zero-argument construction plus getContext/resourceManager risk",
        "triggerCodes": ["OBJECT_INITIALIZATION", "RUNTIME_CONTEXT_ACCESS"],
        "evidence": [{
            "filePath": task.target.file_path, "line": source.count("\n", 0, match.start()) + 1,
            "signal": match.group(0),
        } for match in matches[:8]],
        "module": module, "modulePath": module_path,
        "publicImport": public_import, "publicSurface": public_surface,
        "targetClass": symbol, "constructorKind": "explicit-zero-argument" if constructor else "implicit-default",
        "probeMethod": _select_probe(analysis.get("methods", [])),
        "assertionScope": "construction-and-direct-throw-only",
        "businessExpectedValues": [],
    }


def prepare_runtime_smoke(task: RefactorTask, risk: dict[str, Any], task_dir: Path) -> dict[str, Any]:
    plan = build_runtime_smoke_plan(task, risk)
    write_json(task_dir / "runtime-smoke-plan.json", plan)
    baseline = task_dir / "runtime-smoke-baseline"
    if plan.get("enabled") and not baseline.exists():
        source = Path(task.project_root).resolve()
        excluded_root = None
        try:
            task_relative = task_dir.resolve().relative_to(source)
            excluded_root = task_relative.parts[0] if task_relative.parts else None
        except ValueError:
            pass

        def ignore(directory: str, names: list[str]) -> set[str]:
            ignored = _production_baseline_ignore(directory, names)
            if excluded_root and Path(directory).resolve() == source:
                ignored.add(excluded_root)
            return ignored

        shutil.copytree(source, baseline, ignore=ignore)
    return plan


def _production_baseline_ignore(directory: str, names: list[str]) -> set[str]:
    ignored_names = {
        ".git", ".hvigor", ".cache", ".test", "build", "coverage",
        "node_modules", "oh_modules",
    }
    ignored = {name for name in names if name in ignored_names or name.endswith((".log", ".tmp"))}
    if Path(directory).name == "src":
        ignored.update(name for name in names if name.lower() in {"test", "ohostest"})
    return ignored


def render_runtime_smoke_test(plan: dict[str, Any]) -> str:
    target, probe = str(plan["targetClass"]), plan.get("probeMethod")
    probe_line = f"      instance.{probe}();\n" if probe else ""
    return f"""import {{ describe, expect, it }} from '@ohos/hypium';
import {{ {target} }} from '{plan['publicImport']}';

export default function PublicRuntimeSmokeTest() {{
  describe('PublicRuntimeSmokeTest', () => {{
    it('constructs the public target without an immediate runtime error', 0, () => {{
      const instance: {target} = new {target}();
{probe_line}      expect(instance !== undefined).assertTrue();
    }});
  }});
}}
"""


def render_runtime_smoke_list() -> str:
    return """import publicRuntimeSmokeTest from './PublicRuntimeSmoke.test';
export default function testsuite() { publicRuntimeSmokeTest(); }
"""


def _select_probe(methods: list[dict[str, Any]]) -> str | None:
    candidates = []
    for method in methods:
        name = str(method.get("name", ""))
        if (not name or name == "constructor" or method.get("static")
            or method.get("visibility") != "public" or int(method.get("requiredParameterCount", 0)) != 0
            or method.get("riskSignals") or UNSAFE_PROBE_NAME_RE.search(name) or not SAFE_PROBE_NAME_RE.search(name)):
            continue
        candidates.append(name)
    preferred = ["getTotalCount", "size", "getCount", "isEmpty"]
    return next((name for name in preferred if name in candidates), None) or (sorted(candidates)[0] if candidates else None)


def _infer_module(task: RefactorTask) -> dict[str, str]:
    target = task.target_path.resolve()
    project = Path(task.project_root).resolve()
    for parent in [target.parent, *target.parents]:
        if (parent / "src" / "main").is_dir():
            try:
                return {"module": parent.name, "modulePath": parent.relative_to(project).as_posix()}
            except ValueError:
                return {}
        if parent == project:
            break
    return {}
