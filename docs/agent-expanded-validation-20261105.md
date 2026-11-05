# 2026-11-05：重跑第 27 条并扩大验证范围

按用户最新要求，暂停第 27 条比例算法及专项返修优化，先运行当前重构器。原代码与首次重构各两轮的测试均已通过，无需再做相同诊断。第 27 条改为完整重构重跑；同时扩测跨类 Code Clone 和 Long Method。问题背景见 [复盘第 7、8 节](typescript-agent-optimization-retrospective-20261105.md)。

**执行进展：A/B/C/D 已完成，包括关机后的 29 条续跑。完整跨类 Clone 为 8/14（57.1%）限时 PASS；按用户要求暂排除 LM-I15 后，Long Method 为 14/24（58.3%）。两组均未达标；I15 保留证书校验 BLOCKED，仍待单独重测。详见 [全范围扩测结果](agent-expanded-results-20261105.md)。下列命令保留为本次执行记录，无需原样再跑全批。**

## 固定配置与操作约定

- 运行时基准 `3b3e937`，策略 `2026-11-05-ui-attribution-reactivity`；之后截至本安排的提交只改文档。执行前构建当前 TypeScript 产物。
- 重构、返修、评审模型均为 `zhipu-coding/glm-5`；重构/返修请求 `max`，评审不显式指定档位；Linter `skip`，沿用其余门禁与返修策略。
- `tools/` 实验脚本只提供命令，由用户运行；本机 `tools/*.ps1` 继续忽略，不进入 Git。各批串行，共用工程及设备，不并发。
- 终端实验日志统一使用 `C:\Users\RoyCai\Desktop\group_project\TestResult1028`。流水线原有 `runs/` 任务证据和源码回滚快照继续保留，脚本输出精确任务路径。
- 每条结束检查 `RESULT`、`ROLLBACK_SNAPSHOT`、`END`；异常中止先核对回滚再续跑。失败有有效结果且回滚完成时，现有脚本继续下一条；缺结果、身份矛盾或回滚错误时停止。
- 每轮优化按独立问题分批 commit，完成相关构建/回归后提交，并提供下一轮命令。本轮没有运行时修改，不为扩大测试先新增专项策略。

## 样本与验收口径

I/L 表示 Instrument/Local 数据集来源，不等于实际执行的测试类型。序号按 JSON 中 `messages` 展开。已核对四份数据集共 55 条，目标文件全部存在。

| 分组 | 固定样本 | 数量 | 单条成功条件 | 严格超过 70% 所需成功数 |
|---|---|---:|---|---:|
| Code Clone 类内 | I: 1,3,4,12,15,16,17,20,21,24,25,26,27；L: 1,2 | 15 | 最终 PASS 且 totalSeconds ≤420 | 11/15 |
| Code Clone 跨类 | I: 2,5,6,7,8,9,10,11,13,14,18,19,23；L: 3 | 14 | 最终 PASS 且 totalSeconds ≤900 | 10/14 |
| Code Clone 同文件顶层 Builder | I: 22 | 1 | 单列，参考 PASS 且 ≤420 | 不作为类内/跨类达标证据 |
| Long Method 类内 | I: 1～17；L: 1～8 | 25 | 最终 PASS 且 totalSeconds ≤420 | 18/25 |
| Long Method 跨类 | 当前数据集没有独立样本 | 0 | 尚未评估 | 不适用 |

Code Clone 分类沿用实际源码宿主核对结果，不按检测器的 `different classes` 字样分类；I22 当前仍是两个顶层 `@Builder` 函数。I19 与 L3 涉及同一对 Express VM，作为不同数据集任务分别保留，但不是两个完全独立的实现。

计时使用终端 `RESULT totalSeconds`，包含准备、Agent、返修、门禁和评审，结束于结果写入；不把回滚时间计入，也不把 1200 秒执行上限当作目标。最终 FAIL/BLOCKED/INCOMPLETE、超时 PASS 都计入相应已启动批次的分母且不计成功；中断且无结果的已启动任务单列未完成，不能删除后提高成功率。尚未启动的计划样本显示待跑，完整分组跑完前不宣称全组达标。

本批例外：用户在 A 批完成后明确要求 LM-I15 暂不计入、以后重测。因此统计中显式排除这一条，保留原 BLOCKED 和排除原因；这一要求覆盖上面的默认统计规则，不自动排除其他阻塞样本。

现有类内 Clone 批次为 13/15 限时通过（86.7%，Linter skip），保持原记录。第 27 条这次作为重跑结果另列，不替换历史 FAIL，不用重复尝试的最好成绩重算原批次。新扩测的 40 个数据集条目组成跨类 Clone 14、顶层 Builder 1、Long Method 25；加第 27 条复跑共执行 41 次。各组分别报告，不能汇总成一个 41 条成功率来代替目标。

分批期间保持运行时不变。若发现共性工具问题需要优化，则先归档已完成结果、单独提交改动，再为新版本建立新批次，重跑相应分组；不把改动前后结果混成同一版本成绩。历史 required 模式结果仅作背景，本轮 skip 结果不代表 required 已达标。

## 分批范围

| 批次 | 范围 | 条数 | 目的 |
|---|---|---:|---|
| A | CC-I27；CC-I2,5,7,10；CC-L3；LM-I1,11,15；LM-L3 | 10 | 单条重跑，覆盖跨类数据/页面/VM、类内 UI/普通方法/异步请求 |
| B | CC-I6,8,9,11,13,14,18,19,22,23 | 10 | 补齐跨类 Clone 及顶层 Builder |
| C | LM-I2,3,4,5,6,7,8,9,10,12,13,14,16,17 | 14 | 补齐 Instrument 来源 Long Method |
| D | LM-L1,2,4,5,6,7,8 | 7 | 补齐 Local 来源 Long Method |

A 是发现问题的首批，不是全量验收。A 完成后先核对结果与回滚；没有需要改变运行时的共性问题则按 B、C、D 补齐。LM-L6/7 是原数据集中的裁剪长方法，仍只要求等价抽取，不修改比例业务规则。任何个别失败都不会自动成为扩测前必须新增机制的理由。

## 用户终端命令

在 PowerShell 5.1 或 7 中执行。每个新终端先运行准备段；下列代码块和 `tools/` 脚本没有由助手代跑。

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

批次 A（10 条，第一个循环先跑第 27 条）：

```powershell
foreach ($i in @(27, 2, 5, 7, 10)) {
    & "$repo\tools\run_code_clone_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
& "$repo\tools\run_code_clone_local.ps1" -StartOrdinal 3 -EndOrdinal 3 -LinterMode skip -LogDirectory $logDir
foreach ($i in @(1, 11, 15)) {
    & "$repo\tools\run_long_method_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
& "$repo\tools\run_long_method_local.ps1" -StartOrdinal 3 -EndOrdinal 3 -LinterMode skip -LogDirectory $logDir
```

批次 B（10 条）：

```powershell
foreach ($i in @(6, 8, 9, 11, 13, 14, 18, 19, 22, 23)) {
    & "$repo\tools\run_code_clone_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
```

批次 C（14 条）：

```powershell
foreach ($i in @(2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 16, 17)) {
    & "$repo\tools\run_long_method_instrument.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
```

批次 D（7 条）：

```powershell
foreach ($i in @(1, 2, 4, 5, 6, 7, 8)) {
    & "$repo\tools\run_long_method_local.ps1" -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
```

## 本次准备验证

已只读核对脚本参数、数据集展开计数和全部目标文件存在性，确认本机实验脚本未被 Git 跟踪且处于忽略规则内；`npm run build` 通过。本次不涉及运行时变更，未重跑完整单元测试，未调用模型、Hvigor 或设备测试。

为核对后续数据集变动，记录本次四份 JSON 的 SHA-256：

| 数据集 | SHA-256 |
|---|---|
| instrument-test/code-clone.json | `31D8D202970AE0A7863825B833E37D55DAFC603A384845A45B2AC844AB15DC64` |
| local-test/code-clone.json | `AE45C1CCF15928F582C13ED52E2FF46CA3D0548AD85C350F1446CE849E6B59B0` |
| instrument-test/long-method.json | `A22220C67CCF2159623E17178B078FAE72BEADE80FF3950A08C4818F492E40B0` |
| local-test/long-method.json | `8C1C784E4EF796C2530C5F08B0C4BC58535C4C89236AF69D4095CEAD077522F7` |
