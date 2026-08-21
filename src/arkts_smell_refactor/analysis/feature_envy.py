from __future__ import annotations

import re
from collections import Counter
from typing import Any

from ..models import RefactorTask


ENVIED_TARGET_RE = re.compile(
    r"(?:feature-envious toward|highly coupled to)\s+['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)
METRIC_RE = re.compile(r"\b(ATFD|LDA|CPFD)\s*=\s*([0-9.]+)", re.IGNORECASE)
TYPED_NAME_RE = re.compile(
    r"\b(?:let|const|var|private|public|protected)?\s*([A-Za-z_$][\w$]*)\s*:\s*([^=;,\)]+)"
)
NEW_NAME_RE = re.compile(r"\b([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)")
MEMBER_ACCESS_RE = re.compile(
    r"\b(?P<receiver>this\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)"
    r"\??\.(?P<member>[A-Za-z_$][\w$]*)"
)
ASSIGNMENT_RE = re.compile(
    r"\b(?P<receiver>this\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)"
    r"\??\.(?P<member>[A-Za-z_$][\w$]*)\s*(?:[+\-*/%]?=|\+\+|--)"
)
SDK_HINTS = (
    "canvas", "pixelmap", "image", "path", "drawing", "render", "context2d",
    "want", "router", "http", "https",
)
GLOBAL_STATE_HINTS = ("appstorage", "localstorage", "persiststorage", "storagev2")


def analyze_feature_envy(
    task: RefactorTask,
    target_text: str,
    *,
    declaration: dict[str, Any],
    production_callers: list[dict[str, Any]],
    reactive_names: set[str] | None = None,
) -> dict[str, Any]:
    """Build a lexical ownership and extraction profile for Feature Envy."""
    region, start_line = _symbol_region(target_text, task.target.symbol)
    declared_types = _declared_types(target_text)
    accesses: dict[str, Counter[str]] = {}
    writes: dict[str, Counter[str]] = {}
    for match in MEMBER_ACCESS_RE.finditer(region):
        receiver = match.group("receiver")
        member = match.group("member")
        if receiver == "this" or _is_language_or_local_noise(receiver, member):
            continue
        accesses.setdefault(receiver, Counter())[member] += 1
    for match in ASSIGNMENT_RE.finditer(region):
        receiver = match.group("receiver")
        writes.setdefault(receiver, Counter())[match.group("member")] += 1

    reported_target = _reported_target(task.message)
    ranked = sorted(accesses, key=lambda name: sum(accesses[name].values()), reverse=True)
    selected = _select_receiver(ranked, declared_types, reported_target)
    target_type = declared_types.get(_short_name(selected), reported_target or "unknown")
    access_counter = accesses.get(selected, Counter())
    write_counter = writes.get(selected, Counter())
    ownership = _ownership_kind(reported_target, target_type, selected)
    classification = _classification(ownership, access_counter, write_counter, region)
    move_feasibility, move_reasons = _move_feasibility(ownership, reported_target, target_type)
    pattern, destination, recommendation_reason = _recommendation(
        ownership, classification, move_feasibility, bool(production_callers), declaration
    )
    extraction = _extraction_profile(region, start_line, selected)
    must_preserve = _must_preserve(region, reactive_names or set())
    metrics = {name.upper(): _number(value) for name, value in METRIC_RE.findall(task.message)}

    return {
        "located": region != target_text,
        "evidenceSource": "target-symbol" if region != target_text else "target-file",
        "reportedTarget": reported_target,
        "receiver": selected,
        "targetType": target_type,
        "ownershipKind": ownership,
        "classification": classification,
        "metrics": metrics,
        "readCount": sum(access_counter.values()),
        "writeCount": sum(write_counter.values()),
        "accessedMembers": [
            {"name": name, "count": count, "writes": write_counter.get(name, 0)}
            for name, count in access_counter.most_common()
        ],
        "receiverCandidates": [
            {"receiver": name, "accessCount": sum(accesses[name].values()), "type": declared_types.get(_short_name(name))}
            for name in ranked[:8]
        ],
        "moveFeasibility": move_feasibility,
        "moveReasons": move_reasons,
        "recommendedPattern": pattern,
        "recommendedDestination": destination,
        "recommendationReason": recommendation_reason,
        "extractionRegion": extraction,
        "mustPreserve": must_preserve,
        "limitations": [
            "成员访问和写入采用词法级近似，别名、解构、泛型和跨文件类型关系可能无法完整识别",
            "职责归属建议必须由 Refactor Agent 结合实际依赖方向确认",
        ],
    }


def feature_envy_risks_and_constraints(
    task: RefactorTask,
    analysis: dict[str, Any],
    declaration: dict[str, Any],
    production_callers: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    affected = [task.target.file_path]
    risks: list[dict[str, Any]] = []
    constraints: list[dict[str, str]] = []
    if analysis["moveFeasibility"] != "safe":
        risks.append(_risk(
            "ENVIED_TARGET_MOVE_RISK",
            "high" if analysis["moveFeasibility"] == "unsafe" else "medium",
            "; ".join(analysis["moveReasons"]),
            affected,
        ))
    if analysis["writeCount"]:
        risks.append(_risk(
            "ENVIED_STATE_WRITE",
            "high",
            f"目标方法会写入被依恋对象的 {analysis['writeCount']} 个成员访问",
            affected,
        ))
        constraints.append({
            "code": "PRESERVE_ENVIED_OBJECT_IDENTITY",
            "reason": "跨对象写入提取后容易变成创建新对象或替换引用",
            "instruction": "保持被依恋对象的身份、字段写入次数、写入顺序和条件边界",
        })
    if production_callers or declaration.get("visibility") == "public" or declaration.get("exported"):
        constraints.append({
            "code": "KEEP_COMPATIBILITY_ENTRY",
            "reason": "目标方法存在生产调用契约或对外可见",
            "instruction": "保留原方法名称、参数、返回值、可见性和所属类，以原方法作为委托入口",
        })
    constraints.append({
        "code": "FOLLOW_FEATURE_ENVY_OWNERSHIP",
        "reason": analysis["recommendationReason"],
        "instruction": (
            f"优先采用 {analysis['recommendedPattern']}，目标位置为 "
            f"{analysis['recommendedDestination']}；不要只改名、挪行或把依恋整体复制到无关工具类"
        ),
    })
    if analysis["mustPreserve"]:
        constraints.append({
            "code": "PRESERVE_EXTRACTION_SEMANTICS",
            "reason": "目标方法包含移动或提取时容易改变的行为边界",
            "instruction": "逐项保持：" + "；".join(analysis["mustPreserve"]),
        })
    return risks, constraints


def _reported_target(message: str) -> str | None:
    match = ENVIED_TARGET_RE.search(message)
    return match.group(1) if match else None


def _declared_types(text: str) -> dict[str, str]:
    result = {name: type_name.strip() for name, type_name in TYPED_NAME_RE.findall(text)}
    result.update({name: type_name for name, type_name in NEW_NAME_RE.findall(text)})
    return result


def _select_receiver(candidates: list[str], types: dict[str, str], reported: str | None) -> str | None:
    if reported:
        lowered = reported.lower()
        for receiver in candidates:
            type_name = types.get(_short_name(receiver), "").lower()
            if type_name and any(part.strip().lower() in type_name for part in reported.split("|")):
                return receiver
            if _short_name(receiver).lower() in lowered or lowered in _short_name(receiver).lower():
                return receiver
    return candidates[0] if candidates else None


def _ownership_kind(reported: str | None, target_type: str, receiver: str | None) -> str:
    value = " ".join(filter(None, (reported, target_type, receiver))).lower()
    if any(token in value for token in GLOBAL_STATE_HINTS):
        return "global-state"
    if any(token in value for token in SDK_HINTS):
        return "sdk-object"
    if "service" in value or "repository" in value or "http" in value:
        return "service-object"
    return "business-data"


def _classification(ownership: str, reads: Counter[str], writes: Counter[str], region: str) -> str:
    if ownership == "global-state":
        return "GLOBAL_STORAGE_ACCESS"
    if ownership == "sdk-object":
        return "SDK_ORCHESTRATION"
    if writes:
        return "STATE_MUTATION"
    if re.search(r"\.(?:map|forEach|filter|reduce|sort)\s*\(", region):
        return "COLLECTION_PROCESSING"
    if reads:
        return "DATA_TRANSFORMATION"
    return "DELEGATION_ORCHESTRATION"


def _move_feasibility(ownership: str, reported: str | None, target_type: str) -> tuple[str, list[str]]:
    if ownership == "sdk-object":
        return "unsafe", ["被依恋对象属于 SDK/框架类型，不能直接加入业务方法"]
    if ownership == "global-state":
        return "unsafe", ["被依恋对象是全局状态容器，直接 Move Method 会扩大耦合"]
    if "|" in (reported or target_type) or "interface" in target_type.lower():
        return "uncertain", ["被依恋类型是联合类型或接口，需要确认真实实现和依赖方向"]
    return "uncertain", ["尚未接入跨文件 ArkTS 类型与依赖图，不能自动证明 Move Method 安全"]


def _recommendation(
    ownership: str,
    classification: str,
    feasibility: str,
    has_callers: bool,
    declaration: dict[str, Any],
) -> tuple[str, str, str]:
    if ownership == "sdk-object":
        return "INTRODUCE_ADAPTER_OR_HELPER", "dedicated-production-helper", "SDK 类型不可修改，适合由专用生产 Helper 封装调用序列"
    if ownership == "global-state":
        return "INTRODUCE_DELEGATE", "state-service-or-owning-model", "全局状态访问应集中到明确的数据归属服务，而不是移动到存储容器"
    if classification in {"DATA_TRANSFORMATION", "COLLECTION_PROCESSING"}:
        return "EXTRACT_MAPPER_OR_BUILDER", "owning-model-or-dedicated-builder", "逻辑主要读取外部数据并构造结果，适合 Mapper/Builder"
    if classification == "STATE_MUTATION" and feasibility == "safe":
        return "MOVE_METHOD", "envied-business-object", "逻辑主要修改被依恋业务对象且移动可行"
    stable_entry = has_callers or declaration.get("visibility") == "public" or declaration.get("exported")
    return "INTRODUCE_DELEGATE", "owning-model-or-dedicated-helper", (
        "存在外部调用契约，保留稳定入口后委托更安全" if stable_entry else "类型归属仍需确认，先采用最小委托"
    )


def _extraction_profile(region: str, start_line: int, receiver: str | None) -> dict[str, Any] | None:
    if not receiver:
        return None
    lines = region.splitlines()
    indexes = [index for index, line in enumerate(lines) if receiver in line]
    if not indexes:
        return None
    return {"startLine": start_line + min(indexes), "endLine": start_line + max(indexes)}


def _must_preserve(region: str, reactive_names: set[str]) -> list[str]:
    result: list[str] = []
    if re.search(r"\.push\s*\(", region):
        result.append("数组 push 的累加语义和对象身份")
    if re.search(r"\bif\s*\(", region):
        result.append("条件不满足时不执行的边界")
    if re.search(r"\bawait\b", region):
        result.append("await 位置、异常传播和异步副作用顺序")
    used = sorted(name for name in reactive_names if re.search(rf"\bthis\.{re.escape(name)}\b", region))
    if used:
        result.append("响应式状态实时读取：" + ", ".join(used))
    return result


def _symbol_region(text: str, symbol: str | None) -> tuple[str, int]:
    if not symbol:
        return text, 1
    name = re.escape(symbol.split(".")[-1])
    match = re.search(rf"\b{name}\s*\([^)]*\)[^{{;=]*\{{", text)
    if not match:
        return text, 1
    opening = text.find("{", match.start())
    closing = _matching_brace(text, opening)
    if closing is None:
        return text, 1
    return text[match.start(): closing + 1], text.count("\n", 0, match.start()) + 1


def _matching_brace(text: str, opening: int) -> int | None:
    depth = 0
    quote: str | None = None
    index = opening
    while index < len(text):
        char = text[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in {"'", '"', "`"}:
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def _short_name(receiver: str | None) -> str:
    return receiver.split(".")[-1] if receiver else ""


def _is_language_or_local_noise(receiver: str, member: str) -> bool:
    return receiver in {"Math", "JSON", "Array", "Object", "String", "Number", "console"} or member in {"length", "toString"}


def _number(value: str) -> int | float:
    number = float(value)
    return int(number) if number.is_integer() else number


def _risk(code: str, level: str, evidence: str, affected: list[str]) -> dict[str, Any]:
    return {"code": code, "level": level, "evidence": evidence, "affectedFiles": sorted(set(affected))}
