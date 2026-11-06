# 2026-11-05：五条总超时样例的优化与复跑

优化前本地 tag：`agent-baseline-20261105`，指向 `b31542c70d0da1577c1df497834d577a039496a7`。原始实验结果见 [全范围审计](agent-expanded-results-20261105.md)。本轮不修改裁剪比例业务算法，不延长 1200 秒总上限，不降低门禁标准。

**11 月 6 日进展：A 批 8 条已完成，6/8 最终 PASS，3/8 限时 PASS；没有净增加限时成功数。CC-I18 在测试用例中 App died，LM-I16 仍返修总超时。详见 [A 批结果与下一步诊断](agent-blocked-batch-a-results-20261106.md)。建议先完成这些诊断，再决定是否继续本页 B/C；下面命令是原固定安排，不表示 B/C 已执行。**

**后续对照：LM-I16 原始代码和首次重构各两轮设备测试均通过，用例耗时约 13 秒；未复现稳定回归。详见 [对照记录](long-method-i16-test-comparison-20261106.md)。该诊断不回填 A 批统计，CC-I18 进程死亡与通用失败归因仍待处理。**

## 问题依据

| 样例 | 原始主要耗时与失败位置 | 本轮处理方向 |
|---|---|---|
| CC-I14 | 重构 681s，残留克隆返修 444s；测试通过后评审只剩约 5s | 返修附原始/当前生产源码及差异，减少重新还原修改意图 |
| CC-I18 | 重构 1090s；35 次 shell 调用探索外部 SDK，首次编辑在约 1007s | 明确禁止 SDK/编译器实现探索，优先保留现有宿主机制 |
| CC-I19 | 重构 645s，UI 测试失败；返修 487s 内没有写入 | 将失败诊断与实际 diff 集中提供；测试报错本身不等于已定位根因 |
| LM-I16 | 重构 588s，设备测试 15s 超时；返修 538s 内没有写入 | 提供原始目标片段和返修差异，保持现有 Builder/状态语义 |
| LM-L07 | 重构 875s，顺带改邻近 free 方法触发残留；返修 215s | 限制初始抽取范围，避免把相邻旧异味纳入本轮 |

这五条都触发任务总上限；三条最终处于评审，不代表评审本身各运行了 1200 秒。两个测试失败的业务根因尚未由设备重测证实。

## 批次一：返修生产证据

- 从本任务原始 `baseline-production` 与本轮隔离工作区生成差异；不使用可能陈旧的 review diff，不引入其他任务的实现或测试源码。
- 小文件直接附完整前后代码与 diff。源码总内联预算 24,000 字符，单对 12,000；diff 总预算 24,000。大文件不截断后声称完整，提供工作区内精确只读材料路径。
- 基线缺失与真实新增分别记录。拒绝越界、测试路径和指向工作区外的链接。
- 材料仅供当前返修，成功或失败均清理后再决定是否同步生产代码；快照、生产同步边界与机械/语义门禁不变。
- 初始提示词不再被返修覆盖；各轮保存独立提示词和 `repair-context-*.json`，可核对本轮材料哈希。

验证：TypeScript 测试编译通过；返修证据、Agent 启动集成、内部验证交回三组共 28/28。Windows junction 路径测试需在沙箱外运行，已通过；未执行 `tools/` 脚本、真实模型或设备实验。

提交：`f49b2a9 fix: give repair agents fresh production baselines and diffs`。

## 批次二：收窄初始探索和长方法修改范围

- 初始 Long Method 输入附原始检测范围的完整片段（最多 12,000 字符），明确只是定位证据，不将匿名方法报告误当作可重命名方法。超大/无效范围要求定向读取，不截断冒充完整。
- 返修/评审不重复附初始源码片段，避免把旧代码当成最新代码；返修使用批次一每轮刷新的证据包。
- 默认只修改报告目标和必要的新 helper。邻近方法不是自动扩大的重构目标；若无关改动引出残留，先判断是否应撤销这部分改动。
- 保留旧报告 `statements` 计数和单位，修复以前只能解析 `lines` 导致 Current/Max 丢失的问题；不把旧 statements 转换成当前 HomeCheck 行数。
- 明确禁止读取外部 SDK、ets-loader、编译器/转译器与 CLI 安装目录。缺少新框架机制证据时缩小抽取边界，保持现有宿主、装饰器和 Builder 绑定。这是提示约束，尚非 shell 权限强制拦截，需从下一轮工具轨迹验证是否遵守。
- 策略版本更新为 `2026-11-05-bounded-repair-context`。模型/档位、返修次数、门禁、1200 秒总上限均不变。

验证：`npm test` **284/284**，包含 TypeScript 构建；未调用真实 Agent/设备。另从历史任务快照在仓库临时目录重建四份证据包（不重新运行重构）：CC-I14 四份 diff/四对源码内联，CC-I19 三份 diff/三对源码内联，LM-I16 与 LM-L07 各一份完整 diff 内联、完整大文件按路径补读。提示增量分别约 23,773 / 20,688 / 9,835 / 9,449 字符；输入变大是否换来更少往返，待实测。历史任务与原工程没有修改。

## 固定复跑顺序与口径

先跑 A 共 8 条：五条 BLOCKED（CC-I14/I18/I19、LM-I16/L07），加三个已限时通过的对照（CC-I13、LM-I01、LM-L06）。比较最终 verdict、端到端 `RESULT totalSeconds`、首次编辑时间、工具次数、返修次数、评审剩余时间和回滚记录。不能用 A 的小样本率宣称全组达标。

A 审计后，如果不再改运行时，则按 B/C 补齐本版本全量：CC 共 30 条、LM 共 24 条，合计 54 条。LM-I15 按用户要求继续暂排除，保留证书失败历史并另择批次重测。A/B/C 统一使用本版首次完整尝试，不用重试中的最好成绩替换失败；若期间改版，为新版本重新固定验证范围。

| 批次 | 固定范围 | 条数 |
|---|---|---:|
| A 问题与对照 | CC-I14,18,19,13；LM-I16,1；LM-L7,6 | 8 |
| B Clone 补齐 | CC-I1～27 排除 13,14,18,19；CC-L1～3 | 26 |
| C Long Method 补齐 | LM-I1～17 排除 1,15,16；LM-L1～8 排除 6,7 | 20 |

限时成功仍要求最终 PASS，类内 ≤420 秒、跨类 ≤900 秒。Clone 类内/跨类分别报告，顶层 Builder I22 单列；Long Method 当前只有类内样本。现有固定组跨类 Clone 8/14，达到严格 >70% 需至少 10/14（净增 2）；Long Method 14/24，需至少 17/24（净增 3）。新增样本与旧批次分开记录，待新版本全组完成再计算其分组率。

再次核对四份阳性 JSON：CC-I27/CC-L3/LM-I17/LM-L8，共 55 条，哈希仍与 [原验证安排](agent-expanded-validation-20261105.md) 一致。当前数据集中没有额外未测的两类阳性任务；负样本不能加入重构成功率分母。继续扩充应预先选定新的工程/宿主、确认可复现的目标异味和对应测试，再冻结新队列；优先补跨类 Clone 的独立工程及当前空缺的跨类 Long Method，而不是按预期能通过筛选。真实新增队列尚未建立，本轮先完成现有全量的新版本验证。

## 用户终端命令

以下仅为命令文本，助手未执行 `tools/` 脚本；脚本继续本地忽略，不入 Git。各批串行运行，共享工程和设备。每次新终端先执行准备段，日志统一放入指定目录。原有脚本对有效 FAIL/BLOCKED 记录结果并完成回滚后继续；异常无结果或回滚失败会停止，不能强制忽略。

准备段：

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
```

A（本轮先运行）：

```powershell
foreach ($i in @(14, 18, 19, 13)) {
    & "$repo\tools\run_code_clone_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
foreach ($i in @(16, 1)) {
    & "$repo\tools\run_long_method_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
foreach ($i in @(7, 6)) {
    & "$repo\tools\run_long_method_local.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
```

B（A 审计后，同一版本补齐 Clone）：

```powershell
foreach ($i in 1..27) {
    if ($i -notin @(13, 14, 18, 19)) {
        & "$repo\tools\run_code_clone_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
    }
}
& "$repo\tools\run_code_clone_local.ps1" -StartOrdinal 1 -EndOrdinal 3 -LinterMode skip -LogDirectory $logDir
```

C（同一版本补齐 Long Method）：

```powershell
foreach ($i in 1..17) {
    if ($i -notin @(1, 15, 16)) {
        & "$repo\tools\run_long_method_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
    }
}
foreach ($i in 1..8) {
    if ($i -notin @(6, 7)) {
        & "$repo\tools\run_long_method_local.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
    }
}
```
