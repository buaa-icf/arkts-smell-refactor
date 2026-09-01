from __future__ import annotations

import json
from typing import Any

from .models import RefactorTask


SMELL_GUIDANCE = {
    "feature-envy": "结合源码确认静态画像给出的职责归属；不得只改名、挪行、按检测阈值拆小方法，或把依恋整体复制到无关工具类。",
    "long-method": "按职责拆分，保持局部变量作用域、闭包捕获、ArkUI 状态读取和组件树不变；避免产生新克隆。",
    "code-clone": "先比较所有克隆片段的差异，再提取共享实现；保持 UI ID、默认值、事件和副作用逐项一致。",
    "switch-statement": "按静态分析建议选择 Map<K, V>、Set<K>、Map<K, Handler> 或具名策略/方法提取；不要为了统一使用 Map 而制造更长的内联闭包表。保持 default、分组 case、可执行 fall-through、return/throw、短路求值与副作用顺序。",
    "cyclic-dependency": "先枚举全部环，再说明每条环切断哪条依赖边；共享类型优先下沉到中立层。",
}


def build_refactor_prompt(task: RefactorTask, risk: dict[str, Any]) -> str:
    risks = "\n".join(f"- [{x['level']}] {x['code']}: {x['evidence']}" for x in risk.get("risks", [])) or "- 未发现额外静态风险。"
    constraints = "\n".join(f"- {x['instruction']}（原因：{x['reason']}）" for x in risk.get("recommendedConstraints", [])) or "- 采用最小、行为保持的修改。"
    analysis_text, analysis_title = _smell_analysis_text(risk)
    analysis_section = f"\n## {analysis_title}\n\n{analysis_text}\n" if analysis_text else ""
    target_range = task.target.source_range
    return f"""你正在重构一个 ArkTS 代码异味。请直接修改工作区中的生产代码并保存修改。

## 目标

- 异味类型：{task.smell_type}
- 检测规则：{task.rule}
- 文件：{task.target.file_path}
- 符号：{task.target.symbol or '检测消息未提供，请按行号定位'}
- 范围：{target_range.start_line or '?'}-{target_range.end_line or '?'}
- 检测消息：{task.message}

## 重构前风险

{risks}

## 强制约束

{constraints}
- 测试目录已从隔离工作区移除；不修改构建配置、依赖和无关生产文件。
- 保持状态更新、默认值、null/undefined、异常、数组顺序、对象身份和副作用顺序。
- 根据风险报告和专项静态画像选择 Extract Method、Move Method、Extract Class、Mapper、Builder、Adapter、Delegate 或其他最小重构；不要机械套用同一种手法。
- 不把原条件分支内的操作无条件移到分支外；提取前后必须保持条件和副作用边界。
- 不要把“检测器不再命中”当作行为等价的证明。
- 验证只能调用 DevEco Code 内置的 `build_project`；禁止手工运行 hvigor、npm、pnpm 或 ohpm，禁止创建、复制、删除或修改 `local.properties`、Hvigor wrapper、lock 文件及工作区外任何文件。
- 第一次构建若失败于 SDK、wrapper、证书、签名、依赖下载或网络环境，立即停止验证，不得修改环境文件来绕过。
- 每轮重构最多执行两次 `build_project`：重构后允许第一次；只有第一次失败且确认是本轮修改导致的编译错误，才允许修复后执行第二次。第二次后不得继续构建，失败交由平台 loop 处理。
{analysis_section}

## 异味专项指导

{SMELL_GUIDANCE.get(task.smell_type, '采用最小且可验证的重构，保留原行为和调用契约。')}

完成后简要说明修改文件、重构手法、风险处理方式和你实际执行的验证。不要修改风险报告和任务文件。
"""


def build_review_prompt(task: RefactorTask, risk: dict[str, Any], gates_file: str = "gates.json") -> str:
    analysis_text, analysis_title = _smell_analysis_text(risk)
    analysis_section = f"\n{analysis_title}：\n{analysis_text}\n" if analysis_text else ""
    return f"""你是独立的 ArkTS 重构评审 Agent。该任务仅做只读评审，禁止修改任何文件。

只使用任务目录中平台提供的 `review-diff.patch`、`baseline-production`、`current-production`、`review-context-production`、review-context.json、task.json、review-risk.json、refactor-changes.json 和 {gates_file} 评审以下重构。`review-context-production` 包含本次 diff 直接依赖的只读生产实现，必须核对新增委托、Mapper、Builder、Helper 等被调用实现。禁止读取 risk-report.json 中的调用点信息，禁止读取或搜索原项目目录，禁止运行构建、测试、HomeCheck、Linter 或任何写入命令。`commitHash` 只是输入元信息，不得替代本地重构前基线：

- 异味：{task.smell_type}
- 文件：{task.target.file_path}
- 符号：{task.target.symbol or '未解析'}
- 原始证据：{task.message}
{analysis_section}

必须执行以下检查：

1. 目标异味是否实质消除，而不只是逃避检测器；是否产生新异味。
2. 打开并检查平台提供的 diff 涉及的每个生产代码文件及新增实现，不得用“只要新方法等价”代替实际核对；证据不足时必须输出 UNCERTAIN，不得扫描项目补充上下文。
3. 根据 review-risk.json 的每项语义风险检查响应式状态、UI ID、默认值、null/undefined、异常、数组顺序、对象引用和副作用顺序。
   特别检查条件分支内的调用是否被移到分支外；“无数据时不执行”与“无数据时重置状态”不等价。
4. 调用点、编译和测试正确性由前四层门禁负责，评审 Agent 不重复搜索调用点或测试代码；只核对 diff 中可见的入口契约变化、语义异味和风险是否消除。
5. 前四层门禁结果只能作为已完成的机械验证证据，不能代替语义评审。
6. 对 switch-statement 任务逐项核对 selector、每个 case 标签、default/无 default、分组 case 和可执行 fall-through；确认 Map/Set 的键语义以及 0、false、空串、null/undefined 等值没有被错误当成缺失。
7. 若使用函数/策略表，核对 this 绑定、闭包捕获、表创建时机、await/异常传播和每次调用的状态读取；若重构的是 if/else if，核对条件从左到右求值与短路行为。
8. 对 feature-envy 任务核对被依恋对象、访问成员、职责归属和建议重构形态；确认原入口契约、对象身份、条件边界、读取时机、累加/替换语义和依赖方向没有变化，并检查依恋是否只是被搬到新的方法或工具类。

判定必须自洽：异味未实质消除、行为不等价或存在 blocking issue 时必须 FAIL；证据不足时必须 UNCERTAIN；PASS 不得包含 blocking issue。不得使用“通常”“应该”“可能一致”等推测作为 passed 证据。

最终只输出一个 JSON 对象，不要使用 Markdown 代码围栏：

{json.dumps({
  'verdict': 'PASS | FAIL | UNCERTAIN',
  'summary': '简要结论',
  'smellRemoved': True,
  'behaviorEquivalent': True,
  'riskChecks': [{'riskCode': '风险编号', 'status': 'passed | failed | uncertain', 'evidence': '代码证据'}],
  'issues': [{'severity': 'blocking | warning', 'category': '问题类型', 'filePath': '路径', 'line': 1, 'reason': '原因', 'requiredFix': '阻断问题的修复要求'}]
}, ensure_ascii=False, indent=2)}
"""


def build_repair_prompt(task: RefactorTask, risk: dict[str, Any], failure: dict[str, Any], attempt: int) -> str:
    issues = "\n".join(
        f"- {item.get('category', failure.get('classification', 'failure'))}: {item.get('reason') or item.get('evidence') or '见失败日志'}"
        for item in failure.get("issues", [])
    ) or f"- {failure.get('summary', '见失败报告与对应日志')}"
    return f"""你正在执行 ArkTS 重构的第 {attempt} 轮定向修复。直接修改工作区中的生产代码并保存。

## 原任务

- 异味：{task.smell_type}
- 目标文件：{task.target.file_path}
- 目标符号：{task.target.symbol or '未解析'}
- 原始消息：{task.message}

## 本轮唯一修复目标

失败阶段：{failure.get('stage', 'unknown')}
{issues}

## 强制边界

- 只修复 failure-report.json 中列出的本轮阻断问题，不重新设计已经通过的部分。
- 保持原条件边界、默认值、null/undefined、对象身份、数组累加/替换语义、响应式读取时机和副作用顺序。
- 不读取或修改测试代码、构建配置、依赖及无关生产文件。
- 不通过改名、挪行或按阈值拆小方法逃避异味检测。
- 验证只能调用 DevEco Code 内置的 `build_project`；禁止手工运行 hvigor、npm、pnpm 或 ohpm，禁止创建、复制、删除或修改 `local.properties`、Hvigor wrapper、lock 文件及工作区外任何文件。
- 第一次构建若失败于 SDK、wrapper、证书、签名、依赖下载或网络环境，立即停止验证，不得修改环境文件来绕过。
- 本轮最多执行两次 `build_project`：修复后允许第一次；只有第一次失败且确认是本轮修改导致的编译错误，才允许继续修复并执行第二次。第二次后禁止继续构建，失败交由平台重新分析。

完成后简要说明修复了哪条失败证据、修改文件和实际验证。
"""


def _conditional_analysis_text(risk: dict[str, Any]) -> str:
    analysis = risk.get("switchStatementAnalysis")
    if not analysis:
        return ""
    labels = ", ".join(analysis.get("caseLabels", [])) or "未解析"
    grouped = "; ".join(" / ".join(group) for group in analysis.get("groupedCaseLabels", [])) or "无"
    fallthrough = ", ".join(analysis.get("executableFallthrough", [])) or "无"
    controls = ", ".join(analysis.get("controlFlow", [])) or "无"
    writes = ", ".join(analysis.get("stateWrites", [])) or "无"
    selector = analysis.get("discriminant") or analysis.get("selector")
    if not selector:
        selector = ", ".join(analysis.get("discriminants", [])) or "未解析"
    return "\n".join([
        f"- 类型：{analysis.get('conditionalType', 'unknown')}；定位：{'成功' if analysis.get('located') else '未定位'}；证据：{analysis.get('evidenceSource', 'unknown')}",
        f"- selector：{selector}；switch 数：{analysis.get('switchCount', 1)}；分支数：{analysis.get('branchCount') or analysis.get('reportedBranchCount') or '未知'}；default：{analysis.get('hasDefault', analysis.get('hasFinalElse', '未知'))}",
        f"- 标签：{labels}",
        f"- 分组 case：{grouped}；可执行 fall-through：{fallthrough}",
        f"- 控制流：{controls}；this 状态写入：{writes}；异步：{analysis.get('hasAsyncWork', False)}",
        f"- 建议形态：{analysis.get('recommendedPattern', '人工判断')}（{analysis.get('recommendationReason', '需结合源码确认')}）",
    ])


def _feature_envy_analysis_text(risk: dict[str, Any]) -> str:
    analysis = risk.get("featureEnvyAnalysis")
    if not analysis:
        return ""
    members = ", ".join(
        f"{item['name']}×{item['count']}" + (f"（写{item['writes']}）" if item.get("writes") else "")
        for item in analysis.get("accessedMembers", [])
    ) or "未解析"
    candidates = ", ".join(
        f"{item['receiver']}×{item['accessCount']}"
        for item in analysis.get("receiverCandidates", [])
    ) or "无"
    preserve = "；".join(analysis.get("mustPreserve", [])) or "按原方法逐项核对"
    reasons = "；".join(analysis.get("moveReasons", [])) or "无"
    extraction = analysis.get("extractionRegion") or {}
    extraction_text = (
        f"{extraction.get('startLine')}-{extraction.get('endLine')}"
        if extraction else "未定位"
    )
    execution = analysis.get("executionContext") or {}
    boundary = execution.get("modificationBoundary") or {}
    focus_files = "，".join(execution.get("focusFiles", [])) or "仅目标文件"
    modification_files = "，".join(boundary.get("defaultFiles", [])) or "仅目标文件"
    helper_rule = "允许新增一个最小生产 Helper" if boundary.get("allowNewProductionHelper") else "默认不新增生产 Helper"
    return "\n".join([
        f"- 被依恋目标：{analysis.get('reportedTarget') or '未解析'}；实际 receiver：{analysis.get('receiver') or '未解析'}；类型：{analysis.get('targetType', 'unknown')}",
        f"- 归属类型：{analysis.get('ownershipKind', 'unknown')}；依恋形态：{analysis.get('classification', 'unknown')}；读取：{analysis.get('readCount', 0)}；写入：{analysis.get('writeCount', 0)}",
        f"- 访问成员：{members}",
        f"- receiver 候选：{candidates}；建议提取范围：{extraction_text}",
        f"- Move Method 可行性：{analysis.get('moveFeasibility', 'unknown')}（{reasons}）",
        f"- 建议形态：{analysis.get('recommendedPattern', '人工判断')}；目标位置：{analysis.get('recommendedDestination', '人工判断')}（{analysis.get('recommendationReason', '需结合源码确认')}）",
        f"- 建议范围：{execution.get('suggestedScope', '人工判断')}；重点文件：{focus_files}",
        f"- 默认修改边界：{modification_files}；{helper_rule}；扩大规则：{boundary.get('expansionRule', '保持最小改动')}",
        f"- 建议构建模块：{execution.get('buildTarget') or '未解析，由工程配置确定'}",
        f"- 必须保持：{preserve}",
    ])


def _smell_analysis_text(risk: dict[str, Any]) -> tuple[str, str]:
    feature_envy = _feature_envy_analysis_text(risk)
    if feature_envy:
        return feature_envy, "Feature Envy 静态画像"
    conditional = _conditional_analysis_text(risk)
    if conditional:
        return conditional, "条件分支静态画像"
    return "", "专项静态画像"
