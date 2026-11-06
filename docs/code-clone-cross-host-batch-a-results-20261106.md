# 2026-11-06：Code Clone 跨类分析器 A 批结果

**本批流水线限时 PASS 为 6/8（75%），由同样例上轮的 2/8 提升四条。最终 PASS 则从 7/8 降为 6/8：I23 本轮未产生修改而 FAIL，I18 仍 BLOCKED。** I19 虽为流水线 PASS，但查实存在旧接口兼容风险，见下文，不将六条 PASS 描述为全部无质量疑点。

本批是预先固定的 6 条未达标样例加 2 条对照，不能代表完整跨类组。同版本 14 条尚余 6 条待跑，至少再有 4 条限时 PASS 才能达到 10/14（71.4%）。按最新结果拼接旧版剩余六条会得到 12/14，但这不是本版本全量结果，不作为验收结论。

## 配置、计时与逐条结果

运行时 `2bddaf8`，策略均为 `2026-11-06-cross-host-clone-evidence`；执行于北京时间 11 月 6 日 17:20～18:50。模型请求均为 `zhipu-coding/glm-5`，重构/返修 max、评审默认，Linter skip；供应商实际档位未独立验证。8 条均按 [固定安排](code-clone-cross-host-optimization-20261106.md) 各执行一次，无格式重试、无 1200 秒任务总超时。

计时取终端 `RESULT totalSeconds`，包含准备、重构、门禁、返修、评审，截止结果写入；不包含回滚。最终 PASS 且 ≤900 秒才算跨类限时成功。失败和 BLOCKED 保留在分母。

| 样例 | 上轮结果 / 秒 | 本轮结果 / 秒 | 限时通过 | 本轮返修 | 末次测试证据 |
|---|---:|---:|---|---:|---|
| I6 | PASS / 956.050 | PASS / 718.284 | 是，新增 | 0 | 设备 2/2 + 2/2 |
| I8 | PASS / 943.024 | PASS / 759.918 | 是，新增 | 1 | 设备 6/6 + 1/1 |
| I14 | PASS / 1186.518 | PASS / 678.471 | 是，新增 | 0 | 设备 9/9 + 10/10 |
| I18 | BLOCKED / 339.829 | BLOCKED / 365.821 | 否 | 0 | 首用例 App died，另一作业未执行 |
| I19 | PASS / 1171.240 | PASS / 887.462 | 是，新增；有接口警告 | 0 | 设备 5/5 + 5/5 |
| I23 | PASS / 1095.445 | FAIL / 947.556 | 否 | 0 | 未执行 |
| I2 对照 | PASS / 471.182 | PASS / 520.433 | 是，保留 | 0 | Local 8/8 + 7/7，设备 4/4 + 2/2 |
| I13 对照 | PASS / 710.954 | PASS / 547.670 | 是，保留 | 0 | 设备 8/8 + 8/8 |

总耗时 **5425.615 秒（约 90 分 26 秒）**，平均 **678.202 秒**，中位数 **698.378 秒**；6 条最终 PASS 平均 685.373 秒。总时间比对应历史尝试的 6874.242 秒少 21.1%，但包含 I18 提前阻塞和 I23 无产出失败，不能解释为稳定吞吐提升。两轮均最终 PASS 的六条总计 5438.968→4112.238 秒，减少 24.4%；仍只是单次观察。

## 优化效果及未解决问题

| 样例 | 首轮 Agent 秒数：旧→新 | 本轮返修秒数 | 本轮评审秒数 | 解释 |
|---|---:|---:|---:|---|
| I6 | 536.678→444.535 | 0 | 172.865 | 采用共享长字面量常量方案，总耗时减少 237.766 秒 |
| I8 | 405.432→468.593 | 76.833 | 95.625 | 首轮变慢；返修和评审缩短，不能说已消除原编译问题 |
| I14 | 658.205→527.215 | 0 | 77.749 | 具名类型 Helper 一次通过，省去旧 343.761 秒返修 |
| I18 | 272.275→314.005 | 0 | 未执行 | 仍有框架 Builder 构造被移出宿主 |
| I19 | 377.711→543.967 | 0 | 227.554 | 保留页面根与生命周期，省去旧 359.822 秒返修；距900秒仅12.538秒 |
| I23 | 875.602→946.278 | 0 | 未执行 | 模型输出长度终止，整轮无代码修改 |
| I2 | 182.369→349.363 | 0 | 73.689 | 对照首轮也变慢，限时通过仍保留 |
| I13 | 550.236→366.088 | 0 | 113.151 | 对照总耗时减少163.284秒 |

首个结构化 edit/write 事件距首事件的时间：I6 245.900 秒、I8 317.425 秒、I14 390.201 秒、I18 226.659 秒、I19 462.536 秒、I2 216.748 秒、I13 286.833 秒；I23 无写入。该口径不包括潜在 shell 写入，Agent 时间也包含服务等待和工具往返，不等于纯推理。

### I18：构造归属问题仍未收敛

本轮把 `new CustomDialogController` 留在 HomeVisit/ShippingInfo，但新普通函数 `BottomSheetDialogOptions.ets` 内仍执行 `CustomContentDialog({ contentBuilder })`。抽出的对象含框架节点创建，并非纯数据配置。现有编译产物的该调用及控制器调用未呈现原内联对象场景的同样宿主/Builder 转换，这是继续定位的强线索，尚无崩溃栈证明唯一因果。

本轮 `mountsHomeVisitAndShowsLabels` 第一个用例内即 `TestFinished-ResultCode: -1 / App died`；上轮第一个用例通过、第二个打开弹窗时死亡。本轮缺少有效 Hypium 汇总，ShippingInfo 作业未执行，评审未运行，BLOCKED 成立。不能因为平台将缺汇总称为环境阻塞，就认定与重构代码无关。后续通用改进应区分纯配置与配置中嵌入的 Builder/框架创建，并保留真实死亡诊断；本轮没有修改分类或放宽测试。

### I23：模型长度终止，而非总时限

首轮工具轨迹为 13 read、8 grep、1 glob，没有 edit/write/bash；末个工具在首事件后481.757秒搜索 `Repeat<`，最后在约940.533秒出现 `step_finish.reason="length"`，该步报告 reasoning=32728、output=40，合计32768。最终“Refactor Agent 未产生允许的生产代码修改”，改动清单各数组为空，因此平台 FAIL；测试、门禁和评审均未执行。

这次可确认模型输出长度用尽，不能再笼统归因于1200秒超时、测试或API错误。源码对照仍没有让该条及时形成方案；没有依据把最后无工具事件的间隔完全归因于纯推理。本轮不加业务特判，也不靠扩大预算改写该次结果。

### I8：相同装饰器编译错误仍出现

首轮新增 `DeleteButtonBar.ets:21` 再次组合 `@Require @Event`，构建报10905325。返修一次移除不合法组合后通过，耗时76.833秒。新增类型/宿主证据没有避免此错误；不能把它列作已根治。

### I19：流水线 PASS 中有已确认的接口破坏

`EditFieldPage.ets` 是两轮基线均存在的生产文件，非本轮新增，也不是回滚残留。原文件导出 `EditFieldVM` 接口，并通过 `@Require @Param vm: EditFieldVM` 接受参数；本轮删除该导出、改为六个必填参数，旧直接导入及 `EditFieldPage({vm: ...})` 调用不再兼容。

机械契约快照只包含模块 Index 导出的 `MinePage`，没有覆盖此文件的直接导出，故 `removedExports=[]` 不能证明其旧入口保留。`review.json` 也明确列出 entry-contract-change，但以未发现当前消费方为由降为 warning，违背原提示中“未发现调用方不等于可删旧入口”的要求。

保留原始流水线 PASS 统计，同时将此条标为兼容性疑点；当前内部无消费方，不足以消除接口已变更的事实。后续需要通用的变更文件直接导出检查或更严格的评审契约执行，不能仅通过这一条的现有测试就宣称入口等价。此次只审计，没有改重构器或源工程。

## 测试证据及回滚

- 六条 PASS 均有有效结构化评审，其中 I19 有上述 warning，其余无 issue。14 个成功测试作业共 **77/77** 用例通过；12 个设备作业均有原始 `TestFinished-ResultCode: 0`，汇总与 JSON 一致。
- 若干设备作业仍出现覆盖率生成错误，不使用其百分比证明覆盖完整；已完成用例结果和有效完成标记单独核对。
- 8 条终端各有唯一 BEGIN/RESULT/ROLLBACK_SNAPSHOT/END，序号、任务和状态一致。
- 当前工程与本轮快照完成 **1741 项 SHA-256 核对，覆盖1078个唯一源码文件**，全部一致，备份本身也匹配 manifest；按原快照规则无缺失、改动或新增源码残留。
- 本轮与指定历史运行的源码基线逐路径/哈希比较也是1741项一致、零新增/删除/修改。I19原组件两轮哈希相同。范围限于原脚本的 `.ets/.ts` 与忽略规则，不证明资源、配置和外部环境完全相同。
- 本次没有改运行时代码，未重复运行单元测试或任何 `tools/` 脚本；只读审计实验产物并更新文档。

## 下一批

先保持 `2bddaf8` 运行时，按原队列补齐 B：I5/I7/I9/I10/I11/L3。这样可评价本版本全量结果；I18/I23及I19的兼容问题另列后续优化，不择优重跑覆盖本批记录。

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

foreach ($i in @(5, 7, 9, 10, 11)) {
    & "$repo\tools\run_code_clone_instrument.ps1" `
        -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
& "$repo\tools\run_code_clone_local.ps1" `
    -StartOrdinal 3 -EndOrdinal 3 -LinterMode skip -LogDirectory $logDir
```

## 原始记录索引

终端日志目录：`C:\Users\RoyCai\Desktop\group_project\TestResult1028`。各 runs 下仅一个对应 code-clone 任务目录，含 result、评审、测试与快照材料。

| 样例 | 终端日志 | runs 批次 |
|---|---|---|
| I6 | output20261106-172000-207.log | 20261106-172002-FupOJN |
| I8 | output20261106-173200-676.log | 20261106-173202-hekixf |
| I14 | output20261106-174442-595.log | 20261106-174444-Y3SOuG |
| I18 | output20261106-175602-305.log | 20261106-175603-RUDoW5 |
| I19 | output20261106-180209-234.log | 20261106-180210-eir8hN |
| I23 | output20261106-181657-797.log | 20261106-181658-bDzwg7 |
| I2 | output20261106-183246-100.log | 20261106-183247-U1CWvU |
| I13 | output20261106-184127-203.log | 20261106-184128-d6jHs7 |
