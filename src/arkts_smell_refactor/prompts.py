from __future__ import annotations

import json
from typing import Any

from .models import RefactorTask


SMELL_GUIDANCE = {
    "feature-envy": "保留原方法和签名，在原方法中引入委托；把对外部对象的读取、计算和写入提取到数据归属类或专用生产类。不要删除或移动原入口。",
    "long-method": "按职责拆分，保持局部变量作用域、闭包捕获、ArkUI 状态读取和组件树不变；避免产生新克隆。",
    "code-clone": "先比较所有克隆片段的差异，再提取共享实现；保持 UI ID、默认值、事件和副作用逐项一致。",
    "switch-statement": "按静态分析建议选择 Map<K, V>、Set<K>、Map<K, Handler> 或具名策略/方法提取；不要为了统一使用 Map 而制造更长的内联闭包表。保持 default、分组 case、可执行 fall-through、return/throw、短路求值与副作用顺序。",
    "cyclic-dependency": "先枚举全部环，再说明每条环切断哪条依赖边；共享类型优先下沉到中立层。",
}


def build_refactor_prompt(task: RefactorTask, risk: dict[str, Any]) -> str:
    risks = "\n".join(f"- [{x['level']}] {x['code']}: {x['evidence']}" for x in risk.get("risks", [])) or "- 未发现额外静态风险。"
    constraints = "\n".join(f"- {x['instruction']}（原因：{x['reason']}）" for x in risk.get("recommendedConstraints", [])) or "- 采用最小、行为保持的修改。"
    conditional_analysis = _conditional_analysis_text(risk)
    conditional_section = (
        f"\n## 条件分支静态画像\n\n{conditional_analysis}\n" if conditional_analysis else ""
    )
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
- 不修改测试、构建配置、依赖和无关文件。
- 保持公开 API、状态更新、默认值、null/undefined、异常、数组顺序和副作用顺序，除非为消除异味必须调整且提供兼容入口。
- 不读取、搜索或修改 `src/test`、`src/ohosTest` 及任何测试文件；测试对 Refactor Agent 不可见。
- 保留目标方法的名称、参数、返回值、可见性和所属类，不要求修改任何调用方。
- 默认采用 Extract Method / Extract Class / Introduce Delegate：原方法作为稳定入口，把依恋外部对象的逻辑提取到合适的生产类，再由原方法委托。
- 不把原条件分支内的操作无条件移到分支外；提取前后必须保持条件和副作用边界。
- 不要把“检测器不再命中”当作行为等价的证明。
{conditional_section}

## 异味专项指导

{SMELL_GUIDANCE.get(task.smell_type, '采用最小且可验证的重构，保留原行为和调用契约。')}

完成后简要说明修改文件、重构手法、风险处理方式和你实际执行的验证。不要修改风险报告和任务文件。
"""


def build_review_prompt(task: RefactorTask, risk: dict[str, Any], gates_file: str = "gates.json") -> str:
    conditional_analysis = _conditional_analysis_text(risk)
    conditional_section = (
        f"\n条件分支静态画像：\n{conditional_analysis}\n" if conditional_analysis else ""
    )
    return f"""你是独立的 ArkTS 重构评审 Agent。该任务仅做只读评审，禁止修改任何文件。

请对照平台保存的重构前本地文件、当前生产代码、task.json、risk-report.json 和 {gates_file}，评审以下重构。`commitHash` 只是输入元信息，不得替代本地重构前基线：

- 异味：{task.smell_type}
- 文件：{task.target.file_path}
- 符号：{task.target.symbol or '未解析'}
- 原始证据：{task.message}
{conditional_section}

必须执行以下检查：

1. 目标异味是否实质消除，而不只是逃避检测器；是否产生新异味。
2. 打开并检查 diff 涉及的每个生产代码文件及新增实现，不得用“只要新方法等价”代替实际核对。
3. 根据 risk-report.json 的每项风险检查调用契约、响应式状态、UI ID、默认值、null/undefined、异常、数组顺序、对象引用和副作用顺序。
   特别检查条件分支内的调用是否被移到分支外；“无数据时不执行”与“无数据时重置状态”不等价。
4. 检查旧符号的生产代码与测试代码调用点是否仍然有效；测试代码本身不得被修改。
   同名方法不一定是同一个符号，不得把其他类的同名方法及其测试当作目标调用点，也不得因此扩大修改范围。
5. 前四层门禁结果只能作为证据，不能代替语义评审。
6. 对 switch-statement 任务逐项核对 selector、每个 case 标签、default/无 default、分组 case 和可执行 fall-through；确认 Map/Set 的键语义以及 0、false、空串、null/undefined 等值没有被错误当成缺失。
7. 若使用函数/策略表，核对 this 绑定、闭包捕获、表创建时机、await/异常传播和每次调用的状态读取；若重构的是 if/else if，核对条件从左到右求值与短路行为。

最终只输出一个 JSON 对象，不要使用 Markdown 代码围栏：

{json.dumps({
  'verdict': 'PASS | FAIL | UNCERTAIN',
  'summary': '简要结论',
  'smellRemoved': True,
  'behaviorEquivalent': True,
  'riskChecks': [{'riskCode': '风险编号', 'status': 'passed | failed | uncertain', 'evidence': '代码证据'}],
  'issues': [{'category': '问题类型', 'filePath': '路径', 'line': 1, 'reason': '原因'}]
}, ensure_ascii=False, indent=2)}
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
