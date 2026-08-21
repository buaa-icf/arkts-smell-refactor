from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from ..models import RefactorTask


SWITCH_COUNT_RE = re.compile(r"Switch statement with (\d+) cases", re.IGNORECASE)
IF_COUNT_RE = re.compile(r"Long if-else chain with (\d+) branches", re.IGNORECASE)
CASE_LINES_RE = re.compile(r"(?:^|;\s*)(.*?)\s+\((\d+)\s+lines?\)")


@dataclass
class _Case:
    label: str
    body: str
    is_default: bool = False


def analyze_switch_statement(task: RefactorTask, source: str) -> dict[str, Any]:
    """Describe the conditional reported by switch-statement-check.

    HomeCheck reports both large switches and long if/else-if chains under this
    rule. Some datasets contain CFG-relative line numbers (often 2 or 3), so the
    target method name and detector message are stronger location evidence than
    the raw line number.
    """
    message = task.message
    reported_kind, reported_count = _reported_shape(message)
    message_cases = _message_cases(message)
    region, region_start = _symbol_region(source, task.target.symbol)
    evidence_source = "target-symbol" if region != source else "target-file"

    if reported_kind == "if-else-chain":
        return _analyze_if_chain(region, region_start, reported_count, evidence_source)

    switches = _collect_switches(region, region_start)
    selected_switches = _select_switch_group(
        switches, reported_count, len(message_cases) or None, task.target.source_range.start_line
    )
    if not selected_switches:
        return {
            "conditionalType": reported_kind or "switch",
            "located": False,
            "evidenceSource": "detector-message",
            "reportedBranchCount": reported_count,
            "caseLabels": [item[0] for item in message_cases],
            "caseLineCounts": [{"label": label, "lines": lines} for label, lines in message_cases],
            "recommendedPattern": _message_only_pattern(message_cases),
            "limitations": ["未能在目标方法或文件中定位完整 switch；建议按检测消息中的标签人工核对"],
        }

    cases = [case for item in selected_switches for case in item["cases"]]
    substantive = [case for case in cases if case.body.strip()]
    grouped = [group for item in selected_switches for group in _grouped_labels(item["cases"])]
    executable_fallthrough = [
        label for item in selected_switches for label in _executable_fallthrough(item["cases"])
    ]
    selected_text = "\n".join(item["text"] for item in selected_switches)
    controls = _control_tokens(selected_text)
    writes = _state_writes(selected_text)
    recommendations = [
        _recommend_pattern(item["cases"], _grouped_labels(item["cases"]), _executable_fallthrough(item["cases"]))
        for item in selected_switches
    ]
    pattern = recommendations[0][0] if len({item[0] for item in recommendations}) == 1 else "mixed-strategies"
    reason = "; ".join(dict.fromkeys(item[1] for item in recommendations))
    labels = [case.label for case in cases]
    default_cases = [case for case in cases if case.is_default]
    parsed_counts = _case_line_counts(cases)
    details = [
        {
            "startLine": item["startLine"],
            "endLine": item["endLine"],
            "discriminant": item["discriminant"],
            "branchCount": len(item["cases"]),
            "recommendedPattern": recommendation[0],
        }
        for item, recommendation in zip(selected_switches, recommendations)
    ]
    discriminants = [item["discriminant"] for item in selected_switches]

    return {
        "conditionalType": "switch",
        "located": True,
        "evidenceSource": evidence_source,
        "startLine": min(item["startLine"] for item in selected_switches),
        "endLine": max(item["endLine"] for item in selected_switches),
        "switchCount": len(selected_switches),
        "switches": details,
        "discriminant": discriminants[0] if len(discriminants) == 1 else None,
        "discriminants": discriminants,
        "reportedBranchCount": reported_count,
        "messageCaseCount": len(message_cases) or None,
        "branchCount": len(cases),
        "branchCountMismatch": reported_count is not None and len(cases) != reported_count,
        "caseLabels": labels,
        "caseLineCounts": (
            [{"label": label, "lines": lines} for label, lines in message_cases]
            if message_cases
            else parsed_counts
        ),
        "hasDefault": bool(default_cases),
        "defaultCount": len(default_cases),
        "switchesWithoutDefault": len(selected_switches) - len(default_cases),
        "defaultBehavior": [_summarize_body(case.body) for case in default_cases],
        "groupedCaseLabels": grouped,
        "executableFallthrough": executable_fallthrough,
        "controlFlow": controls,
        "stateWrites": writes,
        "hasAsyncWork": bool(re.search(r"\bawait\b", _mask_non_code(selected_text))),
        "hasNestedConditional": any(
            re.search(r"\b(?:if|switch)\s*\(", _mask_non_code(case.body)) for case in substantive
        ),
        "recommendedPattern": pattern,
        "recommendationReason": reason,
        "limitations": ["分析为词法级近似；重构前仍需核对类型、重载、闭包捕获和 ArkUI 生命周期"],
    }


def _reported_shape(message: str) -> tuple[str | None, int | None]:
    switch_match = SWITCH_COUNT_RE.search(message)
    if switch_match:
        return "switch", int(switch_match.group(1))
    if_match = IF_COUNT_RE.search(message)
    if if_match:
        return "if-else-chain", int(if_match.group(1))
    return None, None


def _message_cases(message: str) -> list[tuple[str, int]]:
    marker = re.search(r"Case line counts:\s*(.*?)(?:\.\s*$|$)", message, re.IGNORECASE)
    if not marker:
        return []
    return [(match.group(1).strip(), int(match.group(2))) for match in CASE_LINES_RE.finditer(marker.group(1))]


def _symbol_region(source: str, symbol: str | None) -> tuple[str, int]:
    if not symbol:
        return source, 1
    short = re.escape(symbol.split(".")[-1])
    masked = _mask_non_code(source)
    patterns = [
        re.compile(
            rf"(?m)^[ \t]*(?:(?:export|public|private|protected|static|async|override)\s+)*"
            rf"(?:function\s+)?{short}(?:\s*<[^>{{}}]+>)?\s*\("
        ),
        re.compile(
            rf"(?m)^[ \t]*(?:(?:export|public|private|protected|static|readonly)\s+)*"
            rf"(?:(?:const|let|var)\s+)?"
            rf"{short}\s*=\s*(?:async\s*)?\("
        ),
    ]
    for pattern in patterns:
        match = pattern.search(masked)
        if not match:
            continue
        brace = masked.find("{", match.end())
        if brace < 0:
            continue
        end = _matching(masked, brace, "{", "}")
        if end is None:
            continue
        start_line = source.count("\n", 0, match.start()) + 1
        return source[match.start() : end + 1], start_line
    return source, 1


def _collect_switches(region: str, region_start_line: int) -> list[dict[str, Any]]:
    masked = _mask_non_code(region)
    results: list[dict[str, Any]] = []
    for match in re.finditer(r"\bswitch\s*\(", masked):
        open_paren = masked.find("(", match.start())
        close_paren = _matching(masked, open_paren, "(", ")")
        if close_paren is None:
            continue
        open_brace = masked.find("{", close_paren)
        if open_brace < 0:
            continue
        close_brace = _matching(masked, open_brace, "{", "}")
        if close_brace is None:
            continue
        cases = _parse_cases(region, masked, open_brace, close_brace)
        start_line = region_start_line + region.count("\n", 0, match.start())
        results.append(
            {
                "startLine": start_line,
                "endLine": region_start_line + region.count("\n", 0, close_brace),
                "discriminant": region[open_paren + 1 : close_paren].strip(),
                "text": region[match.start() : close_brace + 1],
                "cases": cases,
                "startOffset": match.start(),
                "endOffset": close_brace,
            }
        )
    return results


def _parse_cases(source: str, masked: str, open_brace: int, close_brace: int) -> list[_Case]:
    labels: list[tuple[int, int, str, bool]] = []
    depth = 1
    index = open_brace + 1
    while index < close_brace:
        char = masked[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        elif depth == 1:
            match = re.match(r"\b(case|default)\b", masked[index:])
            if match:
                kind = match.group(1)
                colon = _label_colon(masked, index + len(kind), close_brace)
                if colon is not None:
                    raw = source[index + len(kind) : colon].strip()
                    labels.append((index, colon + 1, "default" if kind == "default" else raw, kind == "default"))
                    index = colon
        index += 1
    cases: list[_Case] = []
    for position, (_, body_start, label, is_default) in enumerate(labels):
        body_end = labels[position + 1][0] if position + 1 < len(labels) else close_brace
        cases.append(_Case(label=label, body=source[body_start:body_end].strip(), is_default=is_default))
    return cases


def _label_colon(masked: str, start: int, limit: int) -> int | None:
    paren = bracket = 0
    for index in range(start, limit):
        char = masked[index]
        if char == "(":
            paren += 1
        elif char == ")":
            paren = max(0, paren - 1)
        elif char == "[":
            bracket += 1
        elif char == "]":
            bracket = max(0, bracket - 1)
        elif char == ":" and paren == 0 and bracket == 0:
            return index
        elif char in "{}" and paren == 0 and bracket == 0:
            return None
    return None


def _select_switch_group(
    switches: list[dict[str, Any]],
    reported_count: int | None,
    message_case_count: int | None,
    reported_line: int | None,
) -> list[dict[str, Any]]:
    if not switches:
        return []
    top_level = [
        item
        for item in switches
        if not any(
            other is not item
            and other["startOffset"] < item["startOffset"]
            and other["endOffset"] > item["endOffset"]
            for other in switches
        )
    ]
    expected = message_case_count or reported_count
    if expected is not None and len(top_level) > 1:
        if sum(len(item["cases"]) for item in top_level) == expected:
            return top_level
    exact = [item for item in switches if expected is not None and len(item["cases"]) == expected]
    if exact:
        if reported_line:
            return [min(exact, key=lambda item: abs(item["startLine"] - reported_line))]
        return [exact[0]]
    def score(item: dict[str, Any]) -> tuple[int, int]:
        count_delta = abs(len(item["cases"]) - expected) if expected is not None else 0
        line_delta = abs(item["startLine"] - reported_line) if reported_line else 0
        return count_delta, line_delta
    return [min(switches, key=score)]


def _grouped_labels(cases: list[_Case]) -> list[list[str]]:
    groups: list[list[str]] = []
    pending: list[str] = []
    for case in cases:
        if not case.body.strip():
            pending.append(case.label)
            continue
        if pending:
            groups.append([*pending, case.label])
            pending = []
    if pending:
        groups.append(pending)
    return groups


def _executable_fallthrough(cases: list[_Case]) -> list[str]:
    result: list[str] = []
    for case in cases[:-1]:
        body = _mask_non_code(case.body).strip()
        if not body:
            continue
        if _terminal_control(body) is None:
            result.append(case.label)
    return result


def _terminal_control(body: str) -> str | None:
    value = body.strip()
    if value.startswith("{"):
        closing = _matching(value, 0, "{", "}")
        if closing == len(value) - 1:
            value = value[1:closing].strip()
    depth = 0
    controls: list[tuple[str, int]] = []
    for match in re.finditer(r"[{}]|\b(?:break|return|throw|continue)\b", value):
        token = match.group(0)
        if token == "{":
            depth += 1
        elif token == "}":
            depth = max(0, depth - 1)
        elif depth == 0:
            controls.append((token, match.end()))
    if not controls:
        return None
    token, end = controls[-1]
    tail = value[end:].strip()
    if token in {"return", "throw"}:
        return token
    return token if re.fullmatch(r";?", tail) else None


def _control_tokens(text: str) -> list[str]:
    masked = _mask_non_code(text)
    return [token for token in ("break", "return", "throw", "continue", "await") if re.search(rf"\b{token}\b", masked)]


def _state_writes(text: str) -> list[str]:
    masked = _mask_non_code(text)
    names = set(re.findall(r"\bthis\.([A-Za-z_$][\w$]*)\s*(?:\+\+|--|[+\-*/%]?=(?!=))", masked))
    return sorted(names)


def _recommend_pattern(
    cases: list[_Case], grouped: list[list[str]], executable_fallthrough: list[str]
) -> tuple[str, str]:
    bodies = [case.body for case in cases if case.body.strip()]
    normalized = [_without_terminal_control(body) for body in bodies]
    if executable_fallthrough:
        return "extract-method-or-strategy", "存在执行语句后继续落入下一 case 的 fall-through，直接查表会改变执行序列"
    if normalized and all(re.fullmatch(r"return\s+[^;]+;?", body, re.DOTALL) for body in normalized):
        return "value-map", "各分支直接返回一个值，适合 Map<K, V> 并显式保留 fallback"
    assignments = [re.fullmatch(r"([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*.+;?", body, re.DOTALL) for body in normalized]
    if assignments and all(assignments) and len({match.group(1) for match in assignments if match}) == 1:
        return "value-map", "各分支给同一目标赋值，适合 Map<K, V> 后统一赋值"
    if grouped and len({ _without_terminal_control(case.body) for case in cases if case.body.strip() }) <= 2:
        return "set-or-value-map", "多个标签共享少量行为，适合 Set<K> 分组或 Map<K, V>"
    if normalized and all(_is_simple_handler(body) for body in normalized):
        return "handler-map", "各分支是独立动作，适合具名函数类型的 Map<K, Handler>"
    return "extract-method-or-strategy", "分支包含复合状态变化或嵌套控制流，优先提取具名方法/策略，避免巨型内联 handler Map"


def _without_terminal_control(body: str) -> str:
    value = _mask_comments(body).strip()
    if value.startswith("{"):
        masked = _mask_non_code(value)
        closing = _matching(masked, 0, "{", "}")
        if closing == len(value) - 1:
            value = value[1:closing].strip()
    value = re.sub(r"\b(?:break|continue)\s*;?\s*$", "", value).strip()
    return value


def _is_simple_handler(body: str) -> bool:
    if re.search(r"\b(?:if|switch|for|while|try|catch)\b", body):
        return False
    statements = [item.strip() for item in body.split(";") if item.strip()]
    return 1 <= len(statements) <= 2


def _case_line_counts(cases: list[_Case]) -> list[dict[str, Any]]:
    return [{"label": case.label, "lines": max(1, len(case.body.splitlines()) + 1)} for case in cases]


def _summarize_body(body: str) -> str:
    value = " ".join(_mask_comments(body).split())
    return value[:240] if value else "empty"


def _message_only_pattern(cases: list[tuple[str, int]]) -> str:
    if cases and max(lines for _, lines in cases) <= 3:
        return "value-map-or-handler-map"
    return "extract-method-or-strategy"


def _analyze_if_chain(
    region: str, region_start: int, reported_count: int | None, evidence_source: str
) -> dict[str, Any]:
    masked = _mask_non_code(region)
    first = re.search(r"\bif\s*\(", masked)
    actual_count = 1 + len(re.findall(r"\belse\s+if\s*\(", masked)) if first else 0
    equality_conditions = re.findall(
        r"(?:\bif|\belse\s+if)\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*={2,3}\s*([^\)]+)\)",
        region,
    )
    selector_count = len({item[0] for item in equality_conditions})
    simple_returns = len(re.findall(r"\{\s*return\s+[^;{}]+;?\s*\}", masked))
    value_map = bool(equality_conditions) and selector_count == 1 and simple_returns >= len(equality_conditions)
    start_line = region_start + region.count("\n", 0, first.start()) if first else None
    return {
        "conditionalType": "if-else-chain",
        "located": first is not None,
        "evidenceSource": evidence_source if first else "detector-message",
        "startLine": start_line,
        "reportedBranchCount": reported_count,
        "branchCount": actual_count or reported_count,
        "selector": equality_conditions[0][0] if equality_conditions and selector_count == 1 else None,
        "hasFinalElse": bool(re.search(r"\belse\s*\{", masked)),
        "controlFlow": _control_tokens(region),
        "stateWrites": _state_writes(region),
        "hasAsyncWork": bool(re.search(r"\bawait\b", masked)),
        "recommendedPattern": "value-map" if value_map else "extract-method-or-strategy",
        "recommendationReason": (
            "各条件比较同一选择值并直接返回，适合 Map<K, V>"
            if value_map
            else "条件并非单纯的同键值映射，优先提取谓词或策略，保留短路求值顺序"
        ),
        "limitations": ["if/else 链分析为词法级近似；必须保留条件求值、短路和最终 else 行为"],
    }


def _matching(text: str, start: int, opening: str, closing: str) -> int | None:
    depth = 0
    for index in range(start, len(text)):
        if text[index] == opening:
            depth += 1
        elif text[index] == closing:
            depth -= 1
            if depth == 0:
                return index
    return None


def _mask_comments(text: str) -> str:
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
                index += 2
                continue
            if char == state:
                state = "code"
        index += 1
    return "".join(chars)


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
                index += 1
                continue
        elif state == "line-comment":
            if char == "\n":
                state = "code"
            else:
                chars[index] = " "
            index += 1
            continue
        elif state == "block-comment":
            if char == "*" and nxt == "/":
                chars[index] = chars[index + 1] = " "
                state = "code"
                index += 2
                continue
            if char != "\n":
                chars[index] = " "
            index += 1
            continue
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
            continue
        index += 1
    return "".join(chars)
