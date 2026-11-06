# 2026-11-06：Long Method 类内限时优化

**全量已完成：A 批保留 7 条 + 本次 B 批 18 条，共 25 条，19/25（76%）限时 PASS、24/25（96%）最终 PASS。I15 已纳回，I6 按用户要求使用新完整结果；当前版本在该数据集和 Linter skip 配置下已超过 70%。平均完整耗时 408.522 秒，详见 [全量结果与耗时分析](long-method-full-results-20261106.md)。下文为历史优化过程和已执行命令，不需重复运行。**

本轮按用户要求只针对 Long Method 专属分析器改进初始重构证据。策略版本为 `2026-11-06-long-method-structure`，前置修复提交 `1f68126`。真实 Agent 复跑待用户执行，不能据静态检查或单元测试宣称限时成功率已提升。

**11 月 6 日 A 批更新：8 条已完成，最终 PASS 7/8、限时 PASS 5/8（62.5%），同样例前后均 PASS 的 7 条平均耗时下降 30.5%。I6 因评审输出格式无效 BLOCKED；跨轮最新 Long Method 已为 17/24（70.8%），仍待 B 批补齐同版本全量。详见 [A 批结果与耗时审计](long-method-analyzer-batch-a-results-20261106.md)。下文保留原计划，A 批命令不需重复执行。**

**用户后续调整：恢复纳入 I15，并完整重跑 I6；与原 B 批 16 条合并为下列 18 条队列，运行时仍为 `7fcf2b3`。历史 17/24 保留为当时口径；分母恢复 25 后，重跑前跨轮最新为 17/25（68.0%），严格 >70% 需至少 18/25（72%）。I6 原 BLOCKED 保留，最新状态采用本次重跑结果，不挑选最好结果。**

## 已确认的问题

1. **原始片段接线错误。** `analyzeRisks()` 先用报告绝对行号截取 `region`，再把该片段交给仍按原文件行号切片的 `analyzeLongMethod()`。例如 ReaderToolBar 原范围 199–346，传入的片段只有 148 行，因此被判为范围无效。最近 A 批 LM-I01、LM-I16、LM-L06、LM-L07 的 risk-report 均为 `targetContext.inline=false`；改为传入完整文件后，这四条均能内联原范围。已有测试直接调用分析器，未覆盖这个入口，故新增通过 `analyzeRisks()` 的高行号回归测试。
2. **只有泛化指导，缺少可定位的结构证据。** 旧画像没有给出完整子树、修饰符链终点、原形参及同宿主调用签名。AgencyTaskCalender 上轮首轮 Agent 用时 895.800 秒，产生 11 次 edit，其中包含锚点匹配失败；独立评审又用 238.382 秒。结构线索可以减少反复定位与拆分尝试，但不保证消除模型或服务延迟。
3. **嵌套状态访问没有提前提示。** 最新 LM-I01 的首轮 Agent 仅 125.377 秒，但把 `!this.selectState.isReadingBySwiper` 预计算成 Builder 普通布尔参数，评审发现响应式风险。两次评审 196.102 / 79.794 秒，加返修 52.976 秒，最终完整流水线 552.699 秒。专属画像现在可列出该嵌套访问及根字段 `@Local selectState: SelectState`，指导同宿主 Builder 保留现场读取。

时间来源为已归档的 result.json steps；完整时长沿用终端 RESULT，详见 [A 批审计](agent-blocked-batch-a-results-20261106.md)。上述原因解释优化方向，不把单次时长全部归因为分析器缺陷。

## 本轮实现

- 修正完整文件/片段坐标混用，保留 12000 字符内原报告范围的完整源码；过大范围提示定向补读，不静默截断。
- 新增有限的词法结构画像：结合符号和报告范围定位唯一成员及宿主，括号配对支持形参内的对象和回调类型；列出原形参、控制流词法线索和已调用同宿主成员的签名/行号。
- 对有 `@Builder`、`@LocalBuilder` 或组件/对话框 build 证据的成员，提出至多 6 个互不重叠的完整调用/子树候选，包含修饰符和事件回调。优先较完整的职责块，限制近似大小，为新增 Builder 包装和软阈值留余量。候选不是必须全部执行的方案，也不是精确 HomeCheck 计数。
- 不进入 ForEach 等调用参数内的回调，也不进入未知控制块和 GridItem/ListItem 等布局专属节点；这些区域由 Agent 按当前源码核对。普通方法提供类型、调用和控制流线索，不伪造 UI 抽取方案。
- 列出至多 12 项宿主访问，包括嵌套属性和可选链，以及本文件可解析的根字段类型/装饰器。UI 指导明确保留取反、比较、条件表达式的现场状态读取；事件内读取仍留在事件内。普通逻辑保持 this 归属及异步时序。
- `%AM...` 仅标明外围成员，不能把整个外围成员当作匿名目标。旧报告与源码冲突、泛型方法声明、复杂返回对象类型及疑似正则字面量等不支持情形明确回退，不强选同名方法。
- 原始结构只传给首轮重构提示；返修和评审继续使用其当前证据，不注入旧源码行号和签名。

画像只读当前目标文件，不运行 ArkAnalyzer，不追踪外部类型、别名、动态属性或模板插值。没有访问记录不等于没有响应式依赖，候选不证明可抽取或行为等价。最终仍经过原有异味、编译、测试、契约和独立评审门禁。

模型、档位、1200 秒总上限和验收门槛保持原配置；没有改比例业务算法、测试超时阈值、生产工程或实验脚本。LM-I16 对照四次 PASS 的结论仍见 [对照记录](long-method-i16-test-comparison-20261106.md)，本轮没有重复该诊断。

## 本地验证

- `npm test`：**295/295 PASS**，包括 TypeScript 构建。新增覆盖入口绝对行号、同名成员消歧、宿主装饰器归属、过期范围、复杂形参、完整链边界、回调/Item 保护、嵌套状态、旧画像隔离及不支持语法回退。
- 对现有 25 条任务的当前生产源码进行了只读分析：22 条定位具名成员，LM-I16 仅定位外围；LM-I09 的旧 build 范围实际落在 rechargeContent，LM-L03 的 sendRequest 为泛型声明，两条回退。没有改这些任务的原报告或排除其真实复跑结果。
- 24 条报告范围可内联，I15 因超过 12000 字符仍按路径补读；12 条 UI 样例提供候选。单条新增结构提示最多 1994 字符，25 条该分析器调用合计约 61 毫秒（单次本机测量，不含通用风险分析，也不是性能基准）。
- 上述离线覆盖包含 I15，只说明分析器适用性；真实成功率继续按用户要求暂排除 I15。`tools/` 脚本没有由助手执行，且仍被 Git 忽略、未被跟踪。

## 固定复跑队列

原计划先跑 A 批 8 条再分析结果，随后用户纳回 I15 并指定重跑 I6，B 批调整为 18 条；两批现已完成同一版本的 25 个独立样例验证。历史尝试全部保留，不取各版本最好成绩。

| 批次 | Instrument 来源 | Local 来源 | 用途 |
|---|---|---|---|
| A，8 条 | I1、3、5、6、8、14 | L3、8 | I1 响应式返修；I5/6/8/14、L8 超时 UI；I3、L3 对照 |
| B，调整后 18 条 | I15、6、2、4、7、9、10、11、12、13、16、17 | L1、2、4、5、6、7 | 纳回 I15、复跑 I6，并补齐原 B 批 |

验收仍为**最终 PASS 且完整流水线 ≤420 秒**，目标严格超过 70%。按最新要求纳回 I15，25 条至少需要 18 条限时 PASS。A 批保留其余 7 条结果，其中 5 条限时成功；调整后 B 批 18 条需要至少 13 条限时成功。固定完整队列包括 I9、I16 等困难样例，不因静态解析失败删除样本。

主要观察完整 RESULT totalSeconds、首轮 Agent 时间、edit/read 次数、返修次数、独立评审时长和回滚结果。尤其核对 I1 是否直接保留嵌套状态读取，I14 是否减少改动/锚点失败。各项门禁全部通过后才能记成功。

## 用户终端命令

各批串行执行。以下代码由用户运行，日志统一放到指定目录；脚本或终端异常中止时先核对生产源码回滚，不直接重复启动。

准备并运行 A 批：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$logDir = 'C:\Users\RoyCai\Desktop\group_project\TestResult1028'
Set-Location -LiteralPath $repo
$env:ARKTS_REFACTOR_MODEL = 'zhipu-coding/glm-5'
$env:ARKTS_REVIEW_MODEL = 'zhipu-coding/glm-5'
$env:ARKTS_REFACTOR_VARIANT = 'max'
Remove-Item Env:ARKTS_REVIEW_VARIANT -ErrorAction SilentlyContinue
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }

foreach ($i in @(1, 3, 5, 6, 8, 14)) {
    & "$repo\tools\run_long_method_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
foreach ($i in @(3, 8)) {
    & "$repo\tools\run_long_method_local.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
```

B 批已完成执行前审计，按用户要求扩为 18 条；新终端先执行上面的准备段（至 build 检查），然后运行：

```powershell
foreach ($i in @(15, 6, 2, 4, 7, 9, 10, 11, 12, 13, 16, 17)) {
    & "$repo\tools\run_long_method_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
foreach ($i in @(1, 2, 4, 5, 6, 7)) {
    & "$repo\tools\run_long_method_local.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
```
