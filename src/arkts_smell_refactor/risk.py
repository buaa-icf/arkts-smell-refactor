from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .models import RefactorTask
from .analysis.feature_envy import analyze_feature_envy, feature_envy_risks_and_constraints
from .analysis.switch_statement import analyze_switch_statement
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
        constraints.append({
            "code": "PRESERVE_PUBLIC_CONTRACT",
            "reason": "目标符号对外可见",
            "instruction": "除非专项分析明确证明可以安全移动，否则保持名称、参数、返回值、可见性和所属类型",
        })
    if callers:
        risks.append(_risk("CALL_SITE_BREAK", "high" if len(callers) >= 5 else "medium", f"发现 {len(callers)} 个静态调用点", [x["filePath"] for x in callers]))
        if declaration["visibility"] != "public" and not declaration["exported"]:
            constraints.append({
                "code": "PRESERVE_PRODUCTION_CALLERS",
                "reason": f"发现 {len(callers)} 个生产代码调用点",
                "instruction": "保持现有生产调用方式有效；优先保留兼容入口，不要求修改调用方",
            })
    if reactive_reads:
        risks.append(_risk("REACTIVE_STATE", "high", "目标范围读取 ArkUI 响应式状态：" + ", ".join(reactive_reads), [task.target.file_path]))
        constraints.append(
            {
                "code": "PRESERVE_REACTIVE_READ",
                "reason": "普通值参数可能截断 ArkUI 状态刷新链",
                "instruction": "抽取 Builder/组件后必须保持对响应式状态的实时读取",
            }
        )
    smell_analysis = _add_smell_specific(
        task,
        target_text,
        range_text,
        risks,
        constraints,
        declaration=declaration,
        production_callers=production,
        reactive_names=reactive_names,
    )
    if task.smell_type == "feature-envy" and smell_analysis:
        smell_analysis["executionContext"] = _feature_envy_execution_context(
            task,
            smell_analysis,
            production,
            scan_root,
            workspace,
            target_path,
        )

    rank = {"low": 1, "medium": 2, "high": 3}
    level = max((item["level"] for item in risks), key=rank.get, default="low")
    return {
        "schemaVersion": "1.1",
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
        **({"switchStatementAnalysis": smell_analysis} if task.smell_type == "switch-statement" and smell_analysis else {}),
        **({"featureEnvyAnalysis": smell_analysis} if task.smell_type == "feature-envy" and smell_analysis else {}),
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


def _add_smell_specific(
    task: RefactorTask,
    target_text: str,
    range_text: str,
    risks: list[dict[str, Any]],
    constraints: list[dict[str, str]],
    *,
    declaration: dict[str, Any],
    production_callers: list[dict[str, Any]],
    reactive_names: set[str],
) -> dict[str, Any] | None:
    if task.smell_type == "code-clone":
        if task.target.related_targets:
            risks.append(_risk("CLONE_VARIATION", "high", f"目标克隆涉及 {1 + len(task.target.related_targets)} 个片段，必须逐项保留差异", [task.target.file_path] + [x["filePath"] for x in task.target.related_targets]))
        if ".id(" in range_text:
            risks.append(_risk("UI_SELECTOR_CHANGE", "high", "克隆片段包含 .id(...)，自动化测试可能依赖其字面值", [task.target.file_path]))
    elif task.smell_type == "long-method":
        if "@Builder" in range_text or "build()" in range_text:
            risks.append(_risk("UI_STRUCTURE_CHANGE", "high", "目标可能包含 ArkUI Builder/组件树", [task.target.file_path]))
        constraints.append({"code": "NO_NEW_CLONE", "reason": "长方法拆分可能复制相同 UI 片段", "instruction": "拆分后复检修改区域是否产生代码克隆"})
    elif task.smell_type == "switch-statement":
        analysis = analyze_switch_statement(task, target_text)
        controls = analysis.get("controlFlow", [])
        risky_controls = [token for token in controls if token != "break"]
        if risky_controls:
            risks.append(_risk("CONTROL_FLOW_CHANGE", "high", "条件分支含非局部控制流关键字：" + ", ".join(risky_controls), [task.target.file_path]))
        if analysis.get("switchCount", 1) > 1:
            risks.append(_risk(
                "MULTIPLE_SWITCH_SCOPE",
                "high",
                f"检测器将目标方法中的 {analysis['switchCount']} 个 switch 聚合为一个异味任务",
                [task.target.file_path],
            ))
            constraints.append({
                "code": "PRESERVE_SWITCH_PARTITIONS",
                "reason": "多个 switch 可能位于不同循环、回调或 if/else 上下文中",
                "instruction": "逐个消除画像列出的 switch，并保留各自的 selector、外层条件、迭代对象和执行次数；不要仅处理第一个，也不要无条件合并",
            })
        if analysis.get("branchCountMismatch"):
            risks.append(_risk(
                "DETECTOR_COUNT_MISMATCH",
                "medium",
                f"检测消息声称 {analysis.get('reportedBranchCount')} 个分支，但源码/消息明细解析为 {analysis.get('branchCount')} 个",
                [task.target.file_path],
            ))
            constraints.append({
                "code": "TRUST_SOURCE_LABELS",
                "reason": "检测器汇总数字与源码或 case 明细冲突",
                "instruction": "以当前源码和画像中的完整 case 标签为准逐项重构，不按消息头数字删减分支",
            })
        if analysis.get("executableFallthrough"):
            labels = ", ".join(analysis["executableFallthrough"])
            risks.append(_risk("EXECUTABLE_FALLTHROUGH", "high", "以下 case 执行后继续落入下一分支：" + labels, [task.target.file_path]))
            constraints.append({
                "code": "PRESERVE_FALLTHROUGH_SEQUENCE",
                "reason": "可执行 fall-through 不是简单的多标签共享行为",
                "instruction": "逐个保留 fall-through 的执行序列；不要把这些 case 当作独立 Map 项",
            })
        if analysis.get("groupedCaseLabels"):
            constraints.append({
                "code": "PRESERVE_GROUPED_CASES",
                "reason": "空 case 标签与后续标签共享同一行为",
                "instruction": "查表或 Set 重构必须让每个分组标签继续解析到完全相同的值或处理器",
            })
        if analysis.get("hasAsyncWork"):
            risks.append(_risk("ASYNC_HANDLER_CHANGE", "high", "分支包含 await，处理器抽取可能改变等待、异常传播或返回时机", [task.target.file_path]))
            constraints.append({
                "code": "PRESERVE_ASYNC_CONTRACT",
                "reason": "异步 handler 的调用和返回方式会影响异常与完成时机",
                "instruction": "保持 await 位置、Promise 返回类型、异常传播和异步副作用顺序",
            })
        if analysis.get("stateWrites"):
            names = ", ".join(analysis["stateWrites"])
            risks.append(_risk("BRANCH_STATE_WRITE", "high", "分支写入 this 状态：" + names, [task.target.file_path]))
            constraints.append({
                "code": "PRESERVE_HANDLER_CONTEXT",
                "reason": "把分支改为函数表时容易丢失 this 或改变闭包捕获时机",
                "instruction": "处理器必须保留 this 绑定、参数、状态写入次数和执行顺序；优先具名方法，避免巨型内联闭包表",
            })
        if analysis.get("conditionalType") == "if-else-chain":
            constraints.append({
                "code": "PRESERVE_CONDITION_EVALUATION",
                "reason": "if/else if 具有从左到右短路语义，条件本身可能有副作用",
                "instruction": "保持条件求值顺序、短路行为和最终 else；只有同一选择值的纯等值比较才直接改为 Map",
            })
        constraints.extend([
            {
                "code": "PRESERVE_FALLBACK",
                "reason": "查表重构容易改变 default、缺失 default 或未匹配输入行为",
                "instruction": "精确保留未匹配输入的原行为；不得擅自新增默认值、日志、异常或状态重置",
            },
            {
                "code": "SAFE_TABLE_LOOKUP",
                "reason": "对象属性会字符串化键，|| 会把 0、false、空串等合法值误判为缺失",
                "instruction": "枚举/数字/对象键优先使用 Map；fallback 优先用 Map.has 区分缺失，仅当值类型不含 undefined 时才用显式 undefined 判断；不使用 value || fallback",
            },
        ])
        return analysis
    elif task.smell_type == "feature-envy":
        analysis = analyze_feature_envy(
            task,
            target_text,
            declaration=declaration,
            production_callers=production_callers,
            reactive_names=reactive_names,
        )
        feature_risks, feature_constraints = feature_envy_risks_and_constraints(
            task, analysis, declaration, production_callers
        )
        risks.extend(feature_risks)
        constraints.extend(feature_constraints)
        return analysis
    return None


def _risk(code: str, level: str, evidence: str, affected: list[str]) -> dict[str, Any]:
    return {"code": code, "level": level, "evidence": evidence, "affectedFiles": sorted(set(affected))}


def _feature_envy_execution_context(
    task: RefactorTask,
    analysis: dict[str, Any],
    production_callers: list[dict[str, Any]],
    scan_root: Path,
    workspace: Path,
    target_path: Path,
) -> dict[str, Any]:
    definition_file = _find_type_definition(scan_root, workspace, analysis.get("targetType"), target_path)
    focus_files = [task.target.file_path]
    if definition_file and definition_file not in focus_files:
        focus_files.append(definition_file)
    for caller in production_callers:
        caller_file = caller.get("filePath")
        if caller_file and caller_file not in focus_files:
            focus_files.append(caller_file)

    default_modification_files = [task.target.file_path]
    if definition_file and definition_file not in default_modification_files:
        default_modification_files.append(definition_file)
    destination = str(analysis.get("recommendedDestination", ""))
    suggested_scope = "intra-class" if destination == "target-class" else "inter-class"
    return {
        "suggestedScope": suggested_scope,
        "focusFiles": focus_files,
        "modificationBoundary": {
            "defaultFiles": default_modification_files,
            "allowNewProductionHelper": "helper" in destination or "builder" in destination,
            "expansionRule": "仅当类型导出、依赖方向或编译错误直接要求时扩大范围，并保持改动最小",
        },
        "buildTarget": _nearest_module_name(target_path),
    }


def _find_type_definition(scan_root: Path, workspace: Path, type_text: str | None, target_path: Path) -> str | None:
    if not type_text:
        return None
    candidates = [
        token for token in re.findall(r"\b[A-Za-z_$][\w$]*\b", type_text)
        if token not in {"undefined", "null", "unknown", "Object", "string", "number", "boolean"}
    ]
    target_text = _read(target_path)
    for type_name in candidates:
        import_match = re.search(
            rf"import\s*{{[^}}]*\b{re.escape(type_name)}\b[^}}]*}}\s*from\s*['\"]([^'\"]+)['\"]",
            target_text,
        )
        if import_match and import_match.group(1).startswith("."):
            base = (target_path.parent / import_match.group(1)).resolve()
            for candidate in (base, base.with_suffix(".ets"), base.with_suffix(".ts"), base / "Index.ets", base / "index.ets"):
                if candidate.is_file():
                    return normalized_relative(candidate, workspace)

    # Avoid a second full-project content scan. Filename matches are cheap and
    # sufficiently precise for a navigation hint; unresolved types stay omitted.
    names = {name.lower() for name in candidates}
    for path in iter_source_files(scan_root):
        if path.resolve() == target_path.resolve() or path.stem.lower() not in names:
            continue
        for type_name in candidates:
            declaration = re.compile(rf"\b(?:export\s+)?(?:default\s+)?(?:class|interface|struct|type)\s+{re.escape(type_name)}\b")
            if declaration.search(_read(path)):
                return normalized_relative(path, workspace)
    return None


def _nearest_module_name(target_path: Path) -> str | None:
    for directory in (target_path.parent, *target_path.parents):
        module_file = directory / "src" / "main" / "module.json5"
        package_file = directory / "oh-package.json5"
        for path in (module_file, package_file):
            if not path.is_file():
                continue
            match = re.search(r"(?:\"|')name(?:\"|')\s*:\s*(?:\"|')([^\"']+)", _read(path))
            if match:
                return match.group(1)
        if directory == target_path.anchor:
            break
    return None


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
