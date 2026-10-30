# 2026-10-29：Code Clone 五条 high 复跑审计

> 后续实现已完成，见 [减少重复探索与补全 Linter 指导](agent-focus-optimization-20261029.md)。本文保留当时的审计结果。

本次首轮质量有所恢复，但限时指标仍未改善：3 PASS、2 BLOCKED，返修 3 次；按各自时限计为 0/5。不能继续把切换推理档位本身当作提速方案。以下五条是定向选择的困难样例，不能代表全部 Code Clone 成功率。

## 运行配置与数据核对

终端目录为 `C:/Users/RoyCai/Desktop/group_project/TestResult1028`，本批读取五个 `output20261029-*.log`（UTF-16）及其 RESULT 指向的任务目录。请求配置均为 `deveco/GLM-5.3`，首轮/返修 high、评审 high，Linter required，策略版本 2026-10-29。

| ordinal | 终端文件 | runs 批次 |
|---|---|---|
| 2 | output20261029-104013-707.log | 20261029-104014 |
| 4 | output20261029-105516-102.log | 20261029-105518 |
| 6 | output20261029-110348-181.log | 20261029-110350 |
| 8 | output20261029-112352-418.log | 20261029-112354 |
| 10 | output20261029-113947-989.log | 20261029-113949 |

对每条 `pre-run-production-baseline` 做逐文件 SHA-256 比对，与上一轮同 ordinal 的生产文件完全一致；仅快照元数据 `manifest.json` 不同。重构策略和提示词在两轮之间有修改，因此仍不是只改变 high/low 的受控实验。

## 结果与分阶段耗时

总耗时沿用终端 RESULT 的原始 `totalSeconds`；阶段耗时取 `result.json`。显示的流水线耗时与终端总耗时存在小幅差别，不能混用或向下取整把 901 秒算作 900 秒以内。

| ordinal / 目标 | 时限 | 上轮 low 总秒数 / 结果 | 本轮 high 总秒数 / 结果 | 返修次数 low → high |
|---|---:|---|---|---:|
| 2 DataManager | 900s | 1201.201 / BLOCKED | 901.377 / PASS | 3 → 1 |
| 4 QuickLogin | 420s | 863.717 / PASS | 510.346 / PASS | 1 → 0 |
| 6 AuthenticationPage | 900s | 1012.686 / BLOCKED | 1202.304 / BLOCKED | 1 → 1 |
| 8 CollectionPage | 900s | 910.059 / PASS | 953.820 / PASS | 2 → 1 |
| 10 RecommendBar | 900s | 1201.851 / BLOCKED | 1201.592 / BLOCKED | 1 → 0 |

相同五条的最终 PASS 从 2/5 升到 3/5，返修从 8 次降到 3 次；两轮限时通过均为 0/5。本轮同类仅 1 条、跨类 4 条，不能据此计算全部同类的 70% 指标。DataManager 超时限 1.377 秒，QuickLogin 超出 90.346 秒，CollectionPage 超出 53.820 秒，均仍计不达标。

| ordinal | 首轮 Agent / 秒 | 返修 Agent / 秒 | 评审 Agent / 秒 | 最终阻断或首轮缺陷 |
|---|---:|---:|---:|---|
| 2 | 450.704 | 126.843 | 153.352 | private STORE 缺前导下划线，以及 5 处缺分号 |
| 4 | 293.069 | 0 | 157.399 | 首轮所有门禁及评审通过，但总耗时超同类时限 |
| 6 | 1009.513 | 41.591 | 1.745（被截止） | 新常量漏 export；返修后机械门禁通过，评审未完成 |
| 8 | 447.511 | 62.075 | 329.329 | 小型共享组件触发 avoid-overusing-custom-component-check |
| 10 | 989.774 | 0 | 74.793（被截止） | 机械门禁通过，评审未完成 |

五条观察到的总耗时 4769.439 秒，其中 Agent 步骤累计 4137.698 秒，约 86.8%。并行机械门禁的阶段耗时不能简单相加。两个任务受 1200 秒截止限制，不能将它们的截断总时间视为正常完成所需时间。

## 日志揭示的原因

### 1. 首轮仍存在长时间探索，high 没有自动收敛

AuthenticationPage 首轮使用 20 次 bash，反复以行号切片和正则比对长协议文本，经历默认编码读取、无效的 `[array]::Slice`、片段边界不准以及多次重新选择字符串起止位置；还重复检查 BOM 和 CRLF。约第 815 秒才通过 shell 创建共享实现，后续仍漏了 export。首轮输出 token 汇总为 29754。

RecommendBar 首轮使用 17 次 bash，探索多个模块的类型/导出/资源，尝试覆盖 PowerShell 只读变量 `$home` 后又重试，重复检查字面量、BOM 和 CRLF。首个 edit/write 工具出现在首轮事件开始后约 872 秒，首轮输出 token 汇总为 30217。

两条日志记录的所有工具自身执行时间分别约 1.77、1.84 秒，大部分墙钟时间发生在模型交互之间；不能由此精确分出思考、生成和服务等待时间。日志的 reasoning token 为 0，也不能当成没有推理的证据。问题不仅是工具数量，还包括围绕工具结果继续展开的推导与反复自查。

### 2. Linter 规则存在“已传但未执行”和“继承项未传”两种缺口

DataManager 的首轮提示词已经包含完整 `naming-convention` 的 private/leadingUnderscore=require 选择器和 semi 规则。首轮仍新增 `private static readonly STORE` 与缺分号代码，说明仅把原始规则数组贴进去不足以确保执行。127 秒返修加重新验证是本可避免的开销；不能把原因误判为没找到配置。

CollectionPage 的配置只声明了 `plugin:@performance/recommended` 等 ruleSet。当前摘要不展开继承规则，Agent 没收到具体的 `@performance/avoid-overusing-custom-component-check` 条件，连续两轮选择小型共享组件后再返修成 Builder。这里需要补的是继承规则的可操作摘要，并保留 override/off 的语义。

### 3. 上轮修正有部分正向证据，但没有全部验证

- QuickLogin 本轮没有再次丢 UI ID，首轮及评审通过，返修从 1 次降为 0。
- RecommendBar 的 mine 标题已逐码点比对，六个字符 `U+93BA U+3128 U+5D18 U+705E U+66E1 U+E74D` 全部保留，修复了上轮已观察到的字符丢失；独立语义评审仍未完成，不能据此补记 PASS。
- AuthenticationPage 本轮不是非法评审 JSON：评审日志无模型输出，启动约 1.745 秒便碰到任务截止时间。需要先压缩首轮耗时。
- 全部 `reviewFormatRetries=0`。三个完成的评审 JSON 可解析，但新增的格式修复分支本轮没有真实触发，不能宣称该分支已经端到端验证。
- 所有 Agent 日志均未发现 webfetch/websearch/build_project/arkts_check 工具事件，未复发网页 403 问题。

## 后续优化顺序

1. 先压缩首轮准备和自查：由平台提供可靠的字面量/差异证据，明确一次局部核对的停止条件，避免 Agent 自己反复编写编码、切片、换行检查脚本。保留真实字符和必要语义核对，不靠删掉验证去换 PASS。
2. 把明确适用的 Linter 条件变成短的生成约束和交回前检查点；补全影响抽取方案的继承性能规则。避免继续堆叠未经筛选的长提示。
3. 对纯 UI 共同片段优先选择能保留现有状态/容器/ID 的 Builder 抽取；对新增符号同时核对定义端 export 与聚合出口，避免本轮已出现的低成本可预防错误。
4. 再对固定代码版本进行小样本模型/档位对照。当前不建议照原命令重复跑这五条或扩大到全批；继续同配置批跑不能定位上述问题。

本轮仅完成日志审计和本报告，没有调整运行代码、模型配置、检测阈值或历史结果，也没有执行任何 `tools` 脚本。尚未有证据证明成功率达到 70%。
