---
name: arkts-smell-refactor
description: 在 DevEco 对话中检测 ArkTS 异味，调度子 Agent 在副本中重构和返修，由共享后端验收并生成候选，按用户选择应用、复检或回滚。用于 HarmonyOS 工程的完整异味重构流程。
---

# ArkTS 异味检测与重构

你负责对话和外层重构、返修任务的衔接。Skill 自带运行时，检测、风险分析、工作区准备、验收、独立语义评审和文件事务由运行时执行。支持 Feature Envy、Long Method、Switch Statement、Code Clone。

首次执行前阅读 [CLI 约定](references/cli.md)。使用安装目录中的 scripts/run.mjs，不寻找开发仓库，不要求用户填写 backend。默认从当前工作目录向上找到最近的 Harmony 工程，也可用 --project 指定。沿用用户明确选择的工程；全局安装不绑定某个业务项目。一次流程中的工程、工具配置保持一致，不能因切换聊天目录而改变目标。

## 启动预检：缺项即结束

任何检测、导入、准备或模型任务之前，先对目标工程执行 doctor。Node 无法启动、预检命令报错、result.stop 为 true 或 result.verdict 为 BLOCKED 时，列出 missing 中具体缺项、reason 和 action，说明“本次执行到此结束”，然后结束本轮回复。**不继续扫描，不打开副本，不调用重构或返修模型，不尝试改业务代码、配置或权限来绕过缺项。** 用户补齐环境并再次发起请求后，重新预检。

预检通过也不能宣称全部外部环境已验证。工具存在、SDK 可读、模型可见或凭据已配置，不等于网络、凭据有效性、签名或设备测试实际成功；按 doctor 的检查范围说明。当前宿主缺少可用的原生 task 或可编辑子 Agent 时，同样报告能力缺失并结束，不能自行换成后台 execute 掩盖差异。

用户明确要求查看已有历史、Diff、恢复查看或回滚时，可直接使用对应恢复命令，不因当前 SDK 或模型故障阻止找回已有结果。这不是继续一个已被预检阻断的新重构流程。

## 对话流程

1. **检测或导入。** 预检通过后运行 scan，已有报告则运行 import。保留 responseFile，用 issueId 标识问题。在对话中展示序号、异味、文件/行号、概述和支持状态。用户指定的文件或目录就是扫描范围。仅要求检测时展示结果及下一步选择；已经指定重构目标时继续，不重复询问已明确的选择。
2. **准备并解释建议。** 用原 responseFile 和选定 issueId 调用 prepare，保存 taskHandle。说明风险、建议调整和必须保留的行为；业务约束经 --instructions-file 传入。约束改变后重新准备。证据过期时重新检测，不通过重复导入旧报告刷新哈希绕过检查。
3. **打开编辑副本。** 用户选择生成候选或已经要求重构该问题时，调用 open-workspace --task。保存返回的 workspaceId、editDirectory 和 promptFile。这些是实际编辑入口；原工程、冻结候选的 content/after 和验证目录都不是编辑入口。
4. **外层启动重构 Agent。** 阅读 [外层 Agent 指南](references/outer-agent.md)，通过当前 DevEco 已提供的原生 task 调用可编辑的 general 子 Agent。传入本次 promptFile、editDirectory 的绝对路径和修改边界，等待子任务真正结束。不要虚构 task 的 cwd 或权限参数；遵守宿主对具体副本路径的权限要求。子 Agent 的“完成”只表示编辑结束。
5. **验收并按证据返修。** 调用 validate-workspace --workspace。后端检查修改、执行门禁，并在条件满足时启动独立只读 reviewer。只有本轮 FAIL 且 repairEligible 为 true，并提供 repairPromptFile 时，才在同一副本启动新的返修子任务，读取该提示后定向修复，再验收同一 workspaceId。首次重构后最多三次返修，以后端轮次和资格为准；不得重开工作区重置次数。BLOCKED、stop 为 true、不可归因或无返修资格时，报告原因并结束本次执行。
6. **展示候选并应用。** 展示本轮判定、门禁状态、关键 Diff、变更文件和证据路径。只有通过验收的候选才可应用。先展示具体变更；用户已授权应用该候选或已明确授权相应范围的自动应用时，调用 apply --candidate <id> --confirm <同一id>，随后 validate-applied。没有应用授权时提供查看完整 Diff、应用或停止的选择。不要手工复制候选文件绕过事务。
7. **反馈或回滚。** 分别报告候选结论、应用事务状态和原工程复检结果。应用后验证阻塞时报告并结束，不能自动返修原工程。用户选择恢复时，使用对应候选的 rollback --confirm；报告 ROLLED_BACK 或具体冲突，保留用户后续修改。

## 状态和证据

- ok 为 true 表示命令执行完毕，不等于门禁通过。读取本轮 verdict；缺证据、工具异常、空报告不能当作通过。Linter 跳过时明确标为跳过。
- 外层子 Agent 的编辑与自查不能替代后端独立评审。Skill 默认流程不用 execute；它只保留给兼容入口。
- 保留工程路径、检测 responseFile、issueId、taskHandle、workspaceId 和当前 candidateId。validate-candidate 会生成新 ID，后续审阅与应用使用新候选。
- 恢复工作区执行时先预检，再读取保存的结果。工作区续验使用原 workspaceId，准备任务使用 taskHandle；候选历史仅对 hasCandidate 为 true 的记录调用 restore。标识和材料不完整时说明缺项，不猜测或自行造对象。
- 同一工程逐项执行。原工程或配置漂移时按后端拒绝结果重新准备，不覆盖当前源码。副本与基线检查是后端边界，不能宣称原生子 Agent 具有操作系统沙箱。

最后说明原工程是否实际修改、本轮验证结论、当前候选/事务状态及证据位置。发现环境缺项时，最后一条回复列出缺项和补齐方法，不附带继续自动执行的承诺。
