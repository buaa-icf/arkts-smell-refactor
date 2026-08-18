from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .models import RefactorTask
from .utils import iter_source_files, normalized_relative


DECL_RE_TEMPLATE = r"(?P<prefix>(?:export\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?)\b{symbol}\s*\("
REACTIVE_DECORATORS = re.compile(
    r"@(State|Prop|Link|ObjectLink|Provide|Consume|StorageLink|StorageProp|Observed|Track)\b"
)


def analyze_risks(task: RefactorTask) -> dict[str, Any]:
    workspace = Path(task.workspace_root)
    target_path = workspace / task.target.file_path
    target_text = _read(target_path)
    symbol = task.target.symbol
    scan_root = Path(task.project_root)
    owner = _symbol_owner(target_text, symbol, target_path.stem) if symbol else target_path.stem
    callers = _find_callers(scan_root, workspace, symbol, target_path, owner) if symbol else []
    declaration = _declaration_info(target_text, symbol)
    range_text = _range_text(target_text, task.target.source_range.start_line, task.target.source_range.end_line)
    reactive_names = _reactive_names(target_text)
    reactive_reads = sorted(name for name in reactive_names if re.search(rf"\bthis\.{re.escape(name)}\b", range_text))

    risks: list[dict[str, Any]] = []
    constraints: list[dict[str, str]] = []
    production = [item for item in callers if item["kind"] == "production"]
    tests: list[dict[str, Any]] = []

    if declaration["visibility"] == "public" or declaration["exported"]:
        risks.append(_risk("PUBLIC_API_CHANGE", "high" if callers else "medium", "目标符号可被其他文件使用", [x["filePath"] for x in callers]))
    if callers:
        risks.append(_risk("CALL_SITE_BREAK", "high" if len(callers) >= 5 else "medium", f"发现 {len(callers)} 个静态调用点", [x["filePath"] for x in callers]))
    if reactive_reads:
        risks.append(_risk("REACTIVE_STATE", "high", "目标范围读取 ArkUI 响应式状态：" + ", ".join(reactive_reads), [task.target.file_path]))
        constraints.append(
            {
                "code": "PRESERVE_REACTIVE_READ",
                "reason": "普通值参数可能截断 ArkUI 状态刷新链",
                "instruction": "抽取 Builder/组件后必须保持对响应式状态的实时读取",
            }
        )
    _add_smell_specific(task, range_text, risks, constraints)

    rank = {"low": 1, "medium": 2, "high": 3}
    level = max((item["level"] for item in risks), key=rank.get, default="low")
    return {
        "schemaVersion": "1.0",
        "taskId": task.task_id,
        "riskLevel": level,
        "target": {
            "filePath": task.target.file_path,
            "symbol": symbol,
            **declaration,
        },
        "callers": {
            "total": len(callers),
            "production": len(production),
            "test": len(tests),
            "items": callers,
        },
        "risks": risks,
        "recommendedConstraints": constraints,
        "analysisLimitations": [
            "调用点采用文本级静态扫描，反射、字符串注册和跨语言调用可能无法识别",
            "ArkTS 类型解析器尚未接入，public/export 判断为保守近似",
        ],
    }


def _find_callers(scan_root: Path, workspace: Path, symbol: str, target_path: Path, owner: str) -> list[dict[str, Any]]:
    short = symbol.split(".")[-1]
    call_re = re.compile(rf"\b(?:(?P<receiver>[A-Za-z_$][\w$]*)\.)?{re.escape(short)}\s*\(")
    declaration_re = re.compile(rf"\b{re.escape(short)}\s*\([^)]*\)\s*(?::[^{{]+)?\s*{{")
    signature_re = re.compile(rf"^\s*{re.escape(short)}\s*\([^)]*\)\s*\??\s*:\s*[^=]+[,;]?\s*$")
    callers: list[dict[str, Any]] = []
    if not scan_root.exists():
        return callers
    for path in iter_source_files(scan_root):
        text = _read(path)
        is_target_file = path.resolve() == target_path.resolve()
        is_owner_test = path.name.lower() in {f"{owner}.test.ets".lower(), f"{owner}.test.ts".lower()}
        for line_number, line in enumerate(text.splitlines(), 1):
            match = call_re.search(line)
            if not match or declaration_re.search(line) or signature_re.search(line):
                continue
            receiver = match.group("receiver")
            # A short method name is not a stable symbol identity. Calls on `this` in
            # another class, or in a test named for another component, belong to a
            # different method and must not expand the refactoring scope.
            if not is_target_file and receiver != owner and not is_owner_test:
                continue
            normalized = path.as_posix().lower()
            kind = "test" if "/src/test/" in normalized or "/src/ohostest/" in normalized else "production"
            if kind == "test":
                continue
            callers.append(
                {
                    "filePath": normalized_relative(path, workspace),
                    "line": line_number,
                    "kind": kind,
                    "expression": line.strip()[:300],
                    "owner": owner,
                }
            )
    return callers


def _symbol_owner(text: str, symbol: str, fallback: str) -> str:
    method_match = re.search(rf"\b{re.escape(symbol.split('.')[-1])}\s*\(", text)
    prefix = text[: method_match.start()] if method_match else text
    owners = list(re.finditer(r"\b(?:class|struct)\s+([A-Za-z_$][\w$]*)", prefix))
    return owners[-1].group(1) if owners else fallback


def _declaration_info(text: str, symbol: str | None) -> dict[str, Any]:
    if not symbol:
        return {"visibility": "unknown", "exported": False}
    pattern = re.compile(DECL_RE_TEMPLATE.format(symbol=re.escape(symbol.split(".")[-1])))
    match = pattern.search(text)
    prefix = match.group("prefix") if match else ""
    if "private" in prefix:
        visibility = "private"
    elif "protected" in prefix:
        visibility = "protected"
    else:
        visibility = "public"
    return {"visibility": visibility, "exported": bool(re.search(r"\bexport\s+(?:default\s+)?(?:class|function|const|let|var)", text))}


def _reactive_names(text: str) -> set[str]:
    names: set[str] = set()
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if REACTIVE_DECORATORS.search(line):
            joined = line + (" " + lines[index + 1] if index + 1 < len(lines) else "")
            match = re.search(r"(?:@\w+(?:\([^)]*\))?\s*)+(?:public\s+|private\s+|protected\s+)?([A-Za-z_$][\w$]*)\s*[:=]", joined)
            if match:
                names.add(match.group(1))
    return names


def _add_smell_specific(task: RefactorTask, text: str, risks: list[dict[str, Any]], constraints: list[dict[str, str]]) -> None:
    if task.smell_type == "code-clone":
        if task.target.related_targets:
            risks.append(_risk("CLONE_VARIATION", "high", f"目标克隆涉及 {1 + len(task.target.related_targets)} 个片段，必须逐项保留差异", [task.target.file_path] + [x["filePath"] for x in task.target.related_targets]))
        if ".id(" in text:
            risks.append(_risk("UI_SELECTOR_CHANGE", "high", "克隆片段包含 .id(...)，自动化测试可能依赖其字面值", [task.target.file_path]))
    elif task.smell_type == "long-method":
        if "@Builder" in text or "build()" in text:
            risks.append(_risk("UI_STRUCTURE_CHANGE", "high", "目标可能包含 ArkUI Builder/组件树", [task.target.file_path]))
        constraints.append({"code": "NO_NEW_CLONE", "reason": "长方法拆分可能复制相同 UI 片段", "instruction": "拆分后复检修改区域是否产生代码克隆"})
    elif task.smell_type == "switch-statement":
        controls = [token for token in ("default", "return", "throw", "continue") if re.search(rf"\b{token}\b", text)]
        if controls:
            risks.append(_risk("CONTROL_FLOW_CHANGE", "high", "Switch 含控制流关键字：" + ", ".join(controls), [task.target.file_path]))
        constraints.append({"code": "PRESERVE_DEFAULT", "reason": "表驱动重构容易改变未匹配输入行为", "instruction": "保持 default、返回值、异常和副作用顺序"})
    elif task.smell_type == "feature-envy":
        constraints.append({"code": "PREFER_DELEGATION", "reason": "移动公开方法容易破坏调用契约", "instruction": "优先使用委托；需要搬迁时保留兼容入口"})


def _risk(code: str, level: str, evidence: str, affected: list[str]) -> dict[str, Any]:
    return {"code": code, "level": level, "evidence": evidence, "affectedFiles": sorted(set(affected))}


def _range_text(text: str, start: int | None, end: int | None) -> str:
    lines = text.splitlines()
    if not start:
        return text
    return "\n".join(lines[max(0, start - 1) : min(len(lines), end or start)])


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
