"""Public module/class contract snapshots and compatibility comparison."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .models import RefactorTask
from .utils import write_json


NAMED_EXPORT_RE = re.compile(r"export\s*{(?P<names>[^}]+)}\s*from\s*['\"](?P<path>[^'\"]+)['\"]", re.S)
STAR_EXPORT_RE = re.compile(r"export\s*\*\s*from\s*['\"](?P<path>[^'\"]+)['\"]")
EXPORTED_DECL_RE = re.compile(r"(?m)^\s*export\s+(?:default\s+)?(?:class|struct|interface|enum|type|function|const|let|var)\s+([A-Za-z_$][\w$]*)")
CLASS_RE_TEMPLATE = r"\b(?:export\s+)?(?:default\s+)?(?:class|struct)\s+{name}\b"
METHOD_RE = re.compile(
    r"(?m)^\s*(?P<prefix>(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*)"
    r"(?P<name>[A-Za-z_$][\w$]*)\s*\((?P<params>[^)]*)\)\s*(?::\s*(?P<return>[^={\n]+))?\s*\{"
)
FIELD_RE = re.compile(
    r"(?m)^\s*(?P<prefix>(?:(?:public|private|protected|static|readonly)\s+)*)"
    r"(?P<name>[A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*(?P<type>[^=;\n]+)\s*(?:=|;)"
)


def prepare_public_contract(task: RefactorTask, task_dir: Path) -> dict[str, Any]:
    module = _module_info(task)
    plan = {
        "schemaVersion": "1.0", "enabled": bool(module),
        "module": module.get("module"), "modulePath": module.get("modulePath"),
        "targetSymbol": task.target.symbol, "targetFile": task.target.file_path,
        "reason": "public module/class surface available" if module else "module root not found",
    }
    write_json(task_dir / "public-contract-plan.json", plan)
    if plan["enabled"]:
        write_json(task_dir / "public-contract-before.json", snapshot_public_contract(task, Path(task.project_root), plan))
    return plan


def snapshot_public_contract(task: RefactorTask, project_root: Path, plan: dict[str, Any]) -> dict[str, Any]:
    module_root = project_root / str(plan["modulePath"])
    index = module_root / "Index.ets"
    exports: dict[str, dict[str, Any]] = {}
    if index.is_file():
        text = index.read_text(encoding="utf-8", errors="replace")
        for match in NAMED_EXPORT_RE.finditer(text):
            source = _resolve_export(index, match.group("path"))
            for item in match.group("names").split(","):
                parts = re.split(r"\s+as\s+", item.strip())
                original = parts[0].strip()
                exported = parts[-1].strip()
                if exported:
                    exports[exported] = _export_entry(exported, original, source)
        for match in STAR_EXPORT_RE.finditer(text):
            source = _resolve_export(index, match.group("path"))
            if source and source.is_file():
                source_text = source.read_text(encoding="utf-8", errors="replace")
                for name in EXPORTED_DECL_RE.findall(source_text):
                    exports.setdefault(name, _export_entry(name, name, source))
    symbol = task.target.symbol
    target = project_root / task.target.file_path
    target_contract = _class_contract(target, symbol) if symbol else None
    if target_contract and symbol:
        exports.setdefault(symbol, {"name": symbol, "kind": "target-class", "contract": target_contract})
    return {
        "schemaVersion": "1.0", "module": plan.get("module"),
        "modulePath": plan.get("modulePath"), "exports": exports,
    }


def compare_public_contract(before: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    old, new = before.get("exports", {}), current.get("exports", {})
    removed = sorted(name for name in old if name not in new)
    changed = []
    for name in sorted(set(old) & set(new)):
        old_contract = old[name].get("contract")
        new_contract = new[name].get("contract")
        if not old_contract or not new_contract:
            continue
        old_members = old_contract.get("members", {})
        new_members = new_contract.get("members", {})
        for member_name, signature in old_members.items():
            if member_name not in new_members:
                changed.append({"export": name, "member": member_name, "change": "removed", "before": signature})
            elif new_members[member_name] != signature:
                changed.append({
                    "export": name, "member": member_name, "change": "signature-changed",
                    "before": signature, "after": new_members[member_name],
                })
    return {
        "schemaVersion": "1.0", "removedExports": removed,
        "changedMembers": changed, "passed": not removed and not changed,
    }


def _export_entry(exported: str, original: str, source: Path | None) -> dict[str, Any]:
    contract = _class_contract(source, original) if source else None
    return {"name": exported, "kind": "named-export", "contract": contract}


def _class_contract(path: Path | None, class_name: str | None) -> dict[str, Any] | None:
    if not path or not class_name or not path.is_file():
        return None
    text = path.read_text(encoding="utf-8", errors="replace")
    match = re.search(CLASS_RE_TEMPLATE.format(name=re.escape(class_name)), text)
    if not match:
        return None
    start = text.find("{", match.end())
    end = _matching_brace(text, start)
    if end < 0:
        return None
    block = text[match.start():end + 1]
    depths = _brace_depths(block)
    members: dict[str, dict[str, Any]] = {}
    for method in METHOD_RE.finditer(block):
        if depths[method.start()] != 1 or any(x in method.group("prefix") for x in ("private", "protected")):
            continue
        params = _split_parameters(method.group("params"))
        members["method:" + method.group("name")] = {
            "kind": "method", "static": "static" in method.group("prefix"),
            "parameters": [_normalize_parameter(item) for item in params],
            "returnType": _normalize_type(method.group("return") or "unknown"),
        }
    for field in FIELD_RE.finditer(block):
        if depths[field.start()] != 1 or any(x in field.group("prefix") for x in ("private", "protected")):
            continue
        members["field:" + field.group("name")] = {
            "kind": "field", "static": "static" in field.group("prefix"),
            "readonly": "readonly" in field.group("prefix"),
            "type": _normalize_type(field.group("type")),
        }
    return {"kind": "class", "members": members}


def _resolve_export(index: Path, specifier: str) -> Path | None:
    if not specifier.startswith("."):
        return None
    base = (index.parent / specifier).resolve()
    return next((item for item in (base, base.with_suffix(".ets"), base / "Index.ets") if item.is_file()), None)


def _normalize_parameter(parameter: str) -> dict[str, Any]:
    head, _, type_text = parameter.partition(":")
    return {
        "optional": "?" in head or "=" in parameter,
        "type": _normalize_type(type_text.split("=", 1)[0] or "unknown"),
    }


def _normalize_type(value: str) -> str:
    return re.sub(r"\s+", "", value.strip())


def _split_parameters(params: str) -> list[str]:
    rows, start, depth = [], 0, 0
    for index, char in enumerate(params):
        if char in "<([{": depth += 1
        elif char in ">)]}" and depth: depth -= 1
        elif char == "," and depth == 0:
            if params[start:index].strip(): rows.append(params[start:index].strip())
            start = index + 1
    if params[start:].strip(): rows.append(params[start:].strip())
    return rows


def _module_info(task: RefactorTask) -> dict[str, str]:
    context = task.raw.get("analysisContext", {})
    if context.get("module") and context.get("modulePath"):
        return {"module": str(context["module"]), "modulePath": str(context["modulePath"])}
    target, project = task.target_path.resolve(), Path(task.project_root).resolve()
    for parent in [target.parent, *target.parents]:
        if (parent / "src" / "main").is_dir():
            try: return {"module": parent.name, "modulePath": parent.relative_to(project).as_posix()}
            except ValueError: return {}
        if parent == project: break
    return {}


def _matching_brace(source: str, start: int) -> int:
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{": depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0: return index
    return -1


def _brace_depths(source: str) -> list[int]:
    depths, depth = [0] * (len(source) + 1), 0
    for index, char in enumerate(source):
        depths[index] = depth
        if char == "{": depth += 1
        elif char == "}": depth = max(0, depth - 1)
    return depths
