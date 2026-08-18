---
name: arkts-refactor-review
description: 对 ArkTS 代码异味重构进行独立只读语义评审，结合 Git 基线、完整 diff、静态风险报告与自动门禁证据，输出结构化 PASS/FAIL/UNCERTAIN 结论。
---

# ArkTS 重构评审

仅在用户要求评审已经完成的 ArkTS 异味重构时使用。该 Skill 只读，禁止修改任何文件。

## 必须读取的证据

1. `task.json`：原始异味、目标文件、符号和基线 commit。
2. `risk-report.json`：重构前发现的调用点和风险。
3. Git 基线中的原实现与当前完整 diff。
4. diff 涉及的每个生产代码文件和新增实现。
5. `gates.json`：异味、编译、测试和 Linter 的实际结果。

不得仅查看原始行号。重构会导致行号变化，应使用目标符号、检测规则和 diff 定位。

## 通用评审要求

- 确认目标异味实质消除，而不是改名、挪行或规避检测规则。
- 检查是否引入新异味，尤其是长方法拆分后产生克隆、克隆提取后产生过度参数化。
- 逐项关闭 `risk-report.json` 中的风险；没有代码证据时标为 `uncertain`。
- 检查公开 API、调用点、默认值、null/undefined、异常、数组顺序、对象身份、异步时序和副作用顺序。
- 检查重构是否把原本位于 `if` 等条件分支中的调用移到分支外；“条件不满足时不操作”不能被等同为“重置到默认状态”。
- 按所属类区分同名方法，不得把其他类的同名方法、调用点或测试混入目标范围。
- ArkUI 代码额外检查响应式状态读取、Builder 参数、组件树、`.id()` 与事件回调。
- 测试和构建通过不是语义等价证明；检测器清零也不是异味实质消除证明。
- 不得假设新增加的方法“应该等价”，必须打开并对照其实现。

## 异味专项检查

- Feature Envy：职责是否回到合适对象；原方法是否只剩合理委托；调用契约是否保留。
- Long Method：是否按职责拆分；局部变量、闭包和响应式刷新链是否保持；是否新增克隆。
- Code Clone：检测报告涉及的所有片段是否处理；片段差异、UI ID、默认参数是否逐项保留。
- Switch Statement：default、fall-through、return/throw、执行顺序和副作用是否一致；行为分支是否被机械塞入难读的函数表。
- Cyclic Dependency：重构前的每条环是否逐条断开；编译通过不能代替依赖图复扫。

## 输出

只输出合法 JSON，不使用 Markdown 围栏：

```json
{
  "verdict": "PASS | FAIL | UNCERTAIN",
  "summary": "简要结论",
  "smellRemoved": true,
  "behaviorEquivalent": true,
  "riskChecks": [
    {
      "riskCode": "风险编号",
      "status": "passed | failed | uncertain",
      "evidence": "具体代码证据"
    }
  ],
  "issues": [
    {
      "category": "问题类别",
      "filePath": "文件路径",
      "line": 1,
      "reason": "未通过原因"
    }
  ]
}
```

只有异味实质消除、行为等价、所有高风险项关闭且没有明确回归时才能输出 `PASS`。证据不足输出 `UNCERTAIN`，不能猜测通过。
