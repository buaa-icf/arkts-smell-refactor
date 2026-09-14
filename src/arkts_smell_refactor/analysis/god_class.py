"""Static planning evidence for ArkTS God Class refactoring tasks."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..models import RefactorTask
from ..utils import iter_source_files, normalized_relative


METHOD_RE = re.compile(
    r"(?m)^\s*(?P<prefix>(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*)"
    r"(?P<name>[A-Za-z_$][\w$]*)\s*\((?P<params>[^)]*)\)\s*(?::\s*(?P<return>[^={\n]+))?\s*\{"
)
FIELD_RE = re.compile(
    r"(?m)^\s*(?P<decorators>(?:@\w+(?:\([^)]*\))?\s*)*)"
    r"(?P<prefix>(?:(?:public|private|protected|static|readonly)\s+)*)"
    r"(?P<name>[A-Za-z_$][\w$]*)\s*[?!]?\s*(?::\s*(?P<type>[^=;\n]+))?\s*(?:=|;)"
)
CLASS_RE_TEMPLATE = r"\b(?:export\s+)?(?:default\s+)?(?:class|struct)\s+{name}\b"
HIGH_RISK_NAME = re.compile(
    r"(?:init|reset|clear|delete|remove|update|set|load|save|create|complete|destroy|dispose|login|logout)",
    re.IGNORECASE,
)


def analyze_god_class(task: RefactorTask, source: str, scan_root: Path) -> dict[str, Any]:
    class_name = task.target.symbol or Path(task.target.file_path).stem
    block = _class_block(source, class_name)
    fields = _fields(block)
    methods = _methods(block, fields, class_name)
    mutable_static = [field for field in fields if field["static"] and not field["readonly"]]
    high_risk = [
        method for method in methods
        if method["riskSignals"] or HIGH_RISK_NAME.search(method["name"])
    ]
    return {
        "targetClass": class_name,
        "classLocated": bool(block),
        "lineCount": len(block.splitlines()) if block else 0,
        "fieldCount": len(fields),
        "methodCount": len(methods),
        "fields": fields,
        "methods": methods,
        "mutableStaticFields": [item["name"] for item in mutable_static],
        "externalCallers": _external_callers(
            task, scan_root, class_name, {item["name"] for item in methods},
        ),
        "responsibilityCandidates": _responsibility_groups(methods),
        "highRiskMethods": [
            {"name": item["name"], "signals": item["riskSignals"]}
            for item in high_risk
        ],
        "candidateHint": (
            "Use field reads/writes and business actions as responsibility evidence; "
            "assign one owner to each mutable state group and preserve the original public class "
            "as a facade when compatibility is uncertain. This is evidence, not a fixed plan."
        ),
        "analysisLimitations": [
            "Method/field relations use lexical analysis; dynamic and cross-language calls may be missed",
            "Responsibility candidates do not decide final class boundaries",
        ],
    }


def risks_and_constraints(analysis: dict[str, Any], target_file: str) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    risks: list[dict[str, Any]] = []
    constraints: list[dict[str, str]] = []
    if analysis.get("mutableStaticFields"):
        names = ", ".join(analysis["mutableStaticFields"])
        risks.append({
            "code": "GOD_CLASS_SHARED_MUTABLE_STATE", "level": "high",
            "evidence": "Mutable static state: " + names, "affectedFiles": [target_file],
        })
        constraints.append({
            "code": "ASSIGN_SINGLE_STATE_OWNER",
            "reason": "Copying fields or initial references creates divergent state",
            "instruction": "Assign one real owner to each mutable state group; compatibility entries must delegate to that same state",
        })
    if analysis.get("highRiskMethods"):
        names = ", ".join(item["name"] for item in analysis["highRiskMethods"][:12])
        risks.append({
            "code": "GOD_CLASS_SIDE_EFFECT_FLOW", "level": "high",
            "evidence": "Initialization/context/state/callback/async signals in: " + names,
            "affectedFiles": [target_file],
        })
        constraints.append({
            "code": "PRESERVE_SIDE_EFFECT_FLOW",
            "reason": "Moving methods can change context acquisition, order and side effects",
            "instruction": "Preserve initialization, cleanup, runtime context, callbacks, async work, state writes and data reconstruction",
        })
    if analysis.get("externalCallers"):
        constraints.append({
            "code": "PRESERVE_GOD_CLASS_ENTRY_POINTS",
            "reason": f"Found {len(analysis['externalCallers'])} external production call sites",
            "instruction": "Preserve existing public class, method and field contracts unless migration is explicitly justified",
        })
    constraints.append({
        "code": "NO_GOD_CLASS_TRANSFER",
        "reason": "Mechanical extraction can move the smell to a new helper",
        "instruction": "Each extracted class needs one coherent responsibility; do not move most methods and state into another threshold-sized class",
    })
    return risks, constraints


def _class_block(source: str, class_name: str) -> str:
    match = re.search(CLASS_RE_TEMPLATE.format(name=re.escape(class_name)), source)
    if not match:
        return ""
    start = source.find("{", match.end())
    end = _matching_brace(source, start) if start >= 0 else -1
    return source[match.start():end + 1] if end >= 0 else ""


def _matching_brace(source: str, start: int) -> int:
    depth = 0
    quote = None
    escaped = line_comment = block_comment = False
    index = start
    while index < len(source):
        char = source[index]
        nxt = source[index + 1] if index + 1 < len(source) else ""
        if line_comment:
            line_comment = char != "\n"
        elif block_comment:
            if char == "*" and nxt == "/":
                block_comment = False; index += 1
        elif quote:
            if escaped: escaped = False
            elif char == "\\": escaped = True
            elif char == quote: quote = None
        elif char == "/" and nxt == "/": line_comment = True; index += 1
        elif char == "/" and nxt == "*": block_comment = True; index += 1
        elif char in {"'", '"', "`"}: quote = char
        elif char == "{": depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0: return index
        index += 1
    return -1


def _brace_depths(source: str) -> list[int]:
    depths = [0] * (len(source) + 1)
    depth = 0
    quote = None
    escaped = line_comment = block_comment = False
    index = 0
    while index < len(source):
        depths[index] = depth
        char = source[index]
        nxt = source[index + 1] if index + 1 < len(source) else ""
        if line_comment:
            if char == "\n": line_comment = False
        elif block_comment:
            if char == "*" and nxt == "/": block_comment = False; index += 1
        elif quote:
            if escaped: escaped = False
            elif char == "\\": escaped = True
            elif char == quote: quote = None
        elif char == "/" and nxt == "/": line_comment = True; index += 1
        elif char == "/" and nxt == "*": block_comment = True; index += 1
        elif char in {"'", '"', "`"}: quote = char
        elif char == "{": depth += 1
        elif char == "}": depth = max(0, depth - 1)
        index += 1
    return depths


def _fields(block: str) -> list[dict[str, Any]]:
    rows = []
    depths = _brace_depths(block)
    for match in FIELD_RE.finditer(block):
        if depths[match.start()] != 1: continue
        prefix = match.group("prefix")
        rows.append({
            "name": match.group("name"), "type": (match.group("type") or "unknown").strip(),
            "visibility": "private" if "private" in prefix else "protected" if "protected" in prefix else "public",
            "static": "static" in prefix, "readonly": "readonly" in prefix,
            "decorators": re.findall(r"@(\w+)", match.group("decorators")),
        })
    return rows


def _methods(block: str, fields: list[dict[str, Any]], class_name: str) -> list[dict[str, Any]]:
    rows = []
    depths = _brace_depths(block)
    for match in METHOD_RE.finditer(block):
        if depths[match.start()] != 1: continue
        start = block.find("{", match.end() - 1); end = _matching_brace(block, start)
        body = block[start:end + 1] if end >= 0 else ""
        reads = [field["name"] for field in fields if re.search(rf"(?:this|{re.escape(class_name)})\.{re.escape(field['name'])}\b", body)]
        writes = [field["name"] for field in fields if re.search(rf"(?:this|{re.escape(class_name)})\.{re.escape(field['name'])}\s*(?:=|\+=|-=|\+\+|--)", body)]
        signals = [name for name, pattern in (
            ("async", r"\b(?:await|Promise)\b"),
            ("runtime-context", r"\b(?:getContext|resourceManager|AppStorage|preferences\.)"),
            ("callback", r"\b(?:callback|on[A-Z]\w*)\s*\("),
        ) if re.search(pattern, body)]
        if writes: signals.append("state-write")
        prefix = match.group("prefix"); params = _split_parameters(match.group("params"))
        rows.append({
            "name": match.group("name"), "parameterCount": len(params),
            "requiredParameterCount": sum(1 for item in params if "=" not in item and "?" not in item.split(":", 1)[0]),
            "returnType": (match.group("return") or "unknown").strip(),
            "visibility": "private" if "private" in prefix else "protected" if "protected" in prefix else "public",
            "static": "static" in prefix, "async": "async" in prefix or "async" in signals,
            "readsFields": reads, "writesFields": writes, "riskSignals": signals,
        })
    return rows


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


def _external_callers(task: RefactorTask, root: Path, class_name: str, methods: set[str]) -> list[dict[str, Any]]:
    if not methods: return []
    result = []
    target = task.target_path.resolve()
    pattern = re.compile(rf"\b{re.escape(class_name)}\.({'|'.join(map(re.escape, sorted(methods)))})\s*\(")
    for path in iter_source_files(root):
        if path.resolve() == target: continue
        for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            match = pattern.search(line)
            if match: result.append({"filePath": normalized_relative(path, Path(task.workspace_root)), "line": number, "method": match.group(1)})
    return result


def _responsibility_groups(methods: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, ...], list[str]] = {}
    for method in methods:
        key = tuple(sorted(set(method["readsFields"]) | set(method["writesFields"])))
        if key: groups.setdefault(key, []).append(method["name"])
    ranked = sorted(groups.items(), key=lambda item: (-len(item[1]), item[0]))
    return [{"sharedFields": list(fields), "methods": names} for fields, names in ranked[:12]]
