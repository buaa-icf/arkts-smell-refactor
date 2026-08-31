from __future__ import annotations

import hashlib
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from ..models import RefactorTask


CLONE_KIND_RE = re.compile(r"Code\s+Clone\s+(Type-\d+)(?:\s*\(([^)]+)\))?", re.IGNORECASE)
IDENTIFIER_RE = re.compile(r"\b[A-Za-z_$][\w$]*\b")
NUMBER_RE = re.compile(r"\b(?:0[xX][0-9A-Fa-f]+|\d+(?:\.\d+)?)\b")
STRING_RE = re.compile(r"(['\"])(?:\\.|(?!\1)[^\\\r\n])*\1|`(?:\\.|[^`])*`")
UI_ID_RE = re.compile(r"\.id\s*\(\s*(['\"])(.*?)\1\s*\)", re.DOTALL)
THIS_REF_RE = re.compile(r"\bthis\.([A-Za-z_$][\w$]*)")
THIS_WRITE_RE = re.compile(
    r"\bthis\.([A-Za-z_$][\w$]*)\s*(?:[+\-*/%]?=|\+\+|--)",
)
CALLBACK_RE = re.compile(r"\.((?:on|aboutTo)[A-Z][A-Za-z0-9_$]*)\s*\(")
NAVIGATION_RE = re.compile(r"\b(?:router|navigator)\.[A-Za-z_$][\w$]*|\b(?:pushUrl|replaceUrl|back)\s*\(")


def analyze_code_clone(task: RefactorTask, target_text: str) -> dict[str, Any]:
    """Create a conservative, group-wide lexical profile for a clone finding.

    HomeCheck evaluates the resulting source tree, not merely the reported range.  The
    profile consequently describes every counterpart supplied by the detector and
    makes the group-wide removal obligation explicit to both agents.
    """
    instances = [_instance(
        task.target.file_path,
        task.target.source_range.start_line,
        task.target.source_range.end_line,
        target_text,
        "target",
        True,
    )]
    for related in task.target.related_targets:
        file_path = str(related.get("filePath", "")).replace("\\", "/")
        range_info = related.get("range") if isinstance(related.get("range"), dict) else {}
        related_text, resolved = _read_related(task, file_path)
        instances.append(_instance(
            file_path,
            _as_int(range_info.get("startLine")),
            _as_int(range_info.get("endLine")),
            related_text,
            "related",
            resolved,
        ))

    available = [item for item in instances if item["resolved"]]
    classification, recommendation, reason = _classify(instances, available)
    dimensions = _variation_dimensions(available)
    affected_files = list(dict.fromkeys(item["filePath"] for item in instances if item["filePath"]))
    clone_kind, detector_context = _clone_kind(task.message)
    group_key = "|".join(
        sorted(f"{item['filePath']}:{item['startLine']}-{item['endLine']}" for item in instances)
    )
    group_id = hashlib.sha256(group_key.encode("utf-8")).hexdigest()[:12]
    must_preserve = _must_preserve(instances, available, dimensions)
    similarity = _similarity(available)
    for instance in instances:
        instance.pop("_shape", None)
    return {
        "groupId": f"clone-{group_id}",
        "detectorCloneKind": clone_kind,
        "detectorContext": detector_context,
        "instanceCount": len(instances),
        "resolvedInstanceCount": len(available),
        "instances": instances,
        "classification": classification,
        "similarity": similarity,
        "variationDimensions": dimensions,
        "recommendedPattern": recommendation,
        "recommendationReason": reason,
        "modificationBoundary": {
            "requiredFiles": affected_files,
            "rule": "必须在同一轮处理所有已解析片段；不得只改报告片段后把等价克隆留在同一 HomeCheck 范围内。",
            "crossFile": len({item["filePath"] for item in instances}) > 1,
        },
        "mustPreserve": must_preserve,
        "postConditions": [
            "逐个核对所有实例仍保留各自的 UI ID、文案、资源、回调、状态读写和副作用顺序。",
            "重构后由 HomeCheck 在完整 Harmony 工程中复检；若仍报告该克隆组，按剩余实例定向修复，而不是只改名、换行或移动原样代码。",
        ],
        "limitations": [
            "这是词法级画像：不能证明跨文件类型、ArkUI 生命周期、闭包或资源引用的行为等价。",
            "检测消息只提供直接对照片段；若 HomeCheck 报出额外实例，必须把它们纳入下一轮处理。",
        ],
    }


def code_clone_risks_and_constraints(
    task: RefactorTask, analysis: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    affected = analysis.get("modificationBoundary", {}).get("requiredFiles", [task.target.file_path])
    risks: list[dict[str, Any]] = [
        _risk(
            "CLONE_GROUP_INCOMPLETE",
            "high",
            f"{analysis.get('groupId')} 含 {analysis.get('instanceCount', 1)} 个检测器已知片段；仅重构首个片段通常无法通过 HomeCheck。",
            affected,
        ),
    ]
    constraints: list[dict[str, str]] = [
        {
            "code": "ELIMINATE_WHOLE_CLONE_GROUP",
            "reason": "HomeCheck 对完整源树复检，保留任一已知对照片段都可能继续命中同一克隆。",
            "instruction": "在一个最小、可编译的方案中同时处理静态画像列出的所有实例；每个实例保留其独有差异。",
        },
        {
            "code": "PRESERVE_CLONE_VARIATIONS",
            "reason": "Type-2 克隆的字面量、ID、回调或状态访问差异常是其业务语义的一部分。",
            "instruction": "把差异显式作为参数、回调或配置传入共享实现；禁止以统一默认值、统一事件或统一状态字段抹平差异。",
        },
    ]
    if analysis.get("resolvedInstanceCount", 0) < analysis.get("instanceCount", 0):
        risks.append(_risk(
            "CLONE_COUNTERPART_UNRESOLVED",
            "high",
            "至少一个检测器对照片段未能从当前工作区解析，无法自动证明完整克隆组已消除。",
            affected,
        ))
        constraints.append({
            "code": "CONFIRM_COUNTERPART_BEFORE_EXTRACTION",
            "reason": "缺少对照片段时，抽取范围和参数差异均不完整。",
            "instruction": "先定位缺失对照片段；在确认前仅做保守且可回滚的局部准备，不得声称已完整消除克隆。",
        })
    if any(item.get("uiIds") for item in analysis.get("instances", [])):
        risks.append(_risk(
            "UI_SELECTOR_CHANGE",
            "high",
            "克隆组包含 .id(...)；自动化测试和 UI 查询可能依赖每个字面选择器。",
            affected,
        ))
        constraints.append({
            "code": "PRESERVE_PER_INSTANCE_UI_ID",
            "reason": "共享 Builder/组件很容易把多个页面的 ID 误收敛为一个值。",
            "instruction": "逐实例保留相同的 .id(...) 值及其生成时机；若抽取为 Builder/组件，ID 必须是显式输入而非新默认值。",
        })
    if any(item.get("callbacks") or item.get("stateWrites") for item in analysis.get("instances", [])):
        risks.append(_risk(
            "CLONE_CALLBACK_OR_STATE_VARIATION",
            "high",
            "克隆组含事件回调或 this 状态写入；抽取时可能丢失闭包、this 或执行顺序。",
            affected,
        ))
        constraints.append({
            "code": "PRESERVE_CALLBACK_AND_STATE_ORDER",
            "reason": "回调参数化后，闭包捕获和状态写入顺序可能变化。",
            "instruction": "对每个实例保持原回调、this 绑定、状态写入次数、await 位置和副作用顺序；不要新增整行点击、导航或状态重置。",
        })
    if analysis.get("modificationBoundary", {}).get("crossFile"):
        risks.append(_risk(
            "CROSS_FILE_CLONE_EXTRACTION",
            "medium",
            "对照片段位于不同文件；共享实现的可见性、依赖方向和构建模块必须保持最小。",
            affected,
        ))
        constraints.append({
            "code": "MINIMIZE_SHARED_HELPER_SCOPE",
            "reason": "跨文件共用 Helper 可能引入错误的模块依赖或扩大生产修改范围。",
            "instruction": "优先放入两个实例可见的现有中立层；若不能证明依赖方向安全，保留独立入口并只抽取局部可验证的共同骨架。",
        })
    return risks, constraints


def _instance(
    file_path: str,
    start_line: int | None,
    end_line: int | None,
    text: str,
    role: str,
    resolved: bool,
) -> dict[str, Any]:
    fragment = _range_text(text, start_line, end_line) if resolved else ""
    masked = _mask_non_code(fragment)
    shape = _shape(masked)
    return {
        "role": role,
        "filePath": file_path,
        "startLine": start_line,
        "endLine": end_line,
        "resolved": resolved,
        "lineCount": len(fragment.splitlines()) if fragment else 0,
        "rawFingerprint": _digest(fragment),
        "shapeFingerprint": _digest(shape),
        "_shape": shape,
        "uiIds": sorted(set(UI_ID_RE.findall(fragment) and [value for _, value in UI_ID_RE.findall(fragment)])),
        "thisReferences": sorted(set(THIS_REF_RE.findall(masked))),
        "stateWrites": sorted(set(THIS_WRITE_RE.findall(masked))),
        "callbacks": sorted(set(CALLBACK_RE.findall(masked))),
        "hasAsyncWork": bool(re.search(r"\bawait\b", masked)),
        "hasNavigation": bool(NAVIGATION_RE.search(masked)),
        "stringLiterals": _string_literals(fragment),
    }


def _read_related(task: RefactorTask, file_path: str) -> tuple[str, bool]:
    if not file_path:
        return "", False
    workspace = Path(task.workspace_root)
    candidate = workspace / file_path
    if not candidate.is_file() and task.source_project and not file_path.startswith(task.source_project + "/"):
        candidate = workspace / task.source_project / file_path
    try:
        return candidate.read_text(encoding="utf-8"), True
    except (OSError, UnicodeDecodeError):
        return "", False


def _classify(instances: list[dict[str, Any]], available: list[dict[str, Any]]) -> tuple[str, str, str]:
    if len(available) != len(instances):
        return (
            "COUNTERPART_UNRESOLVED",
            "CONFIRM_COUNTERPART_BEFORE_EXTRACTION",
            "对照片段不完整；先补齐证据，不能把局部修改误判为完整克隆消除。",
        )
    if len(available) < 2:
        return "SINGLE_INSTANCE", "LOCAL_EXTRACTION_AFTER_CONFIRMATION", "检测消息没有可解析对照片段，无法自动确定共享边界。"
    shapes = {item["_shape"] for item in available}
    raw = {item["rawFingerprint"] for item in available}
    same_file = len({item["filePath"] for item in available}) == 1
    if len(raw) == 1:
        return (
            "EXACT",
            "EXTRACT_PRIVATE_BUILDER_OR_METHOD" if same_file else "EXTRACT_SHARED_COMPONENT_OR_HELPER",
            "所有片段文本相同；可抽取共同实现，但仍须保持每处调用的上下文与生命周期。",
        )
    if len(shapes) == 1:
        return (
            "TYPE_2_PARAMETERIZABLE",
            "PARAMETERIZED_BUILDER_OR_HELPER",
            "控制结构相同而标识符、字面量或回调存在差异；应把差异显式参数化。",
        )
    similarity = _similarity(available)
    if similarity >= 0.60:
        return (
            "STRUCTURAL_VARIANT",
            "EXTRACT_COMMON_SKELETON_WITH_EXPLICIT_CALLBACKS",
            "片段有共同骨架但并非完全同形；只抽取可证明等价的骨架，保留各自控制流。",
        )
    return (
        "DIVERGENT_OR_STALE",
        "DO_NOT_FORCE_MERGE",
        "当前代码的词法骨架相似度较低；先确认检测基线与当前源码，再决定是否进行最小局部重构。",
    )


def _variation_dimensions(instances: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(instances) < 2:
        return []
    fields = [
        ("ui-id", "uiIds"),
        ("callback", "callbacks"),
        ("this-reference", "thisReferences"),
        ("state-write", "stateWrites"),
        ("string-literal", "stringLiterals"),
        ("async-work", "hasAsyncWork"),
        ("navigation", "hasNavigation"),
    ]
    result: list[dict[str, Any]] = []
    for label, field in fields:
        values = {repr(item.get(field)) for item in instances}
        if len(values) <= 1:
            continue
        result.append({
            "kind": label,
            "instances": [
                {"filePath": item["filePath"], "range": f"{item['startLine']}-{item['endLine']}", "value": item.get(field)}
                for item in instances
            ],
        })
    return result


def _must_preserve(
    instances: list[dict[str, Any]], available: list[dict[str, Any]], dimensions: list[dict[str, Any]]
) -> list[str]:
    result = ["所有实例的调用位置、条件边界和片段执行次数"]
    if any(item.get("uiIds") for item in instances):
        result.append("每个实例各自的 .id(...) 字面值和生成时机")
    if any(item.get("callbacks") for item in instances):
        result.append("每个实例的事件回调、闭包捕获和 this 绑定")
    if any(item.get("stateWrites") for item in instances):
        result.append("每个实例 this 状态写入的字段、次数和顺序")
    if any(item.get("hasAsyncWork") for item in instances):
        result.append("await 位置、异常传播和异步副作用顺序")
    if any(item.get("hasNavigation") for item in instances):
        result.append("原有导航触发条件；不得为共用组件新增整行点击或导航")
    if dimensions:
        result.append("静态画像列出的每一项实例差异")
    if len(available) != len(instances):
        result.append("缺失对照片段定位完成前不得声称完整克隆组已消除")
    return result


def _clone_kind(message: str) -> tuple[str | None, str | None]:
    match = CLONE_KIND_RE.search(message)
    return (match.group(1).upper(), match.group(2)) if match else (None, None)


def _range_text(text: str, start_line: int | None, end_line: int | None) -> str:
    if not start_line:
        return text
    lines = text.splitlines()
    return "\n".join(lines[max(0, start_line - 1): min(len(lines), end_line or start_line)])


def _shape(masked: str) -> str:
    without_numbers = NUMBER_RE.sub("NUM", masked)
    return re.sub(r"\s+", "", IDENTIFIER_RE.sub("ID", without_numbers))


def _mask_non_code(text: str) -> str:
    chars = list(text)
    state = "code"
    index = 0
    while index < len(chars):
        char = chars[index]
        nxt = chars[index + 1] if index + 1 < len(chars) else ""
        if state == "code":
            if char == "/" and nxt == "/":
                chars[index] = chars[index + 1] = " "
                state = "line-comment"
                index += 2
                continue
            if char == "/" and nxt == "*":
                chars[index] = chars[index + 1] = " "
                state = "block-comment"
                index += 2
                continue
            if char in {"'", '"', "`"}:
                chars[index] = " "
                state = char
        elif state == "line-comment":
            if char == "\n":
                state = "code"
            else:
                chars[index] = " "
        elif state == "block-comment":
            if char == "*" and nxt == "/":
                chars[index] = chars[index + 1] = " "
                state = "code"
                index += 2
                continue
            if char != "\n":
                chars[index] = " "
        else:
            if char == "\\":
                chars[index] = " "
                if index + 1 < len(chars) and chars[index + 1] != "\n":
                    chars[index + 1] = " "
                index += 2
                continue
            if char == state:
                chars[index] = " "
                state = "code"
            elif char != "\n":
                chars[index] = " "
        index += 1
    return "".join(chars)


def _string_literals(fragment: str) -> list[str]:
    values: list[str] = []
    for match in STRING_RE.finditer(fragment):
        value = match.group(0)
        if len(value) > 2:
            values.append(value[1:-1][:120])
    return sorted(set(values))


def _similarity(instances: list[dict[str, Any]]) -> float | None:
    if len(instances) < 2:
        return None
    representations = [item["_shape"] for item in instances]
    scores = [
        SequenceMatcher(a=representations[0], b=value, autojunk=False).ratio()
        for value in representations[1:]
    ]
    return round(min(scores), 3) if scores else None


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _as_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _risk(code: str, level: str, evidence: str, affected: list[str]) -> dict[str, Any]:
    return {"code": code, "level": level, "evidence": evidence, "affectedFiles": sorted(set(affected))}
