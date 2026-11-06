# 2026-11-06：BLOCKED 优化后 A 批 8 条审计

运行版本 `af52e19`（含 `f49b2a9`），策略 `2026-11-05-bounded-repair-context`。执行时间为北京时间 11 月 5 日 23:27 至 11 月 6 日 01:08。按 [固定复跑安排](agent-blocked-optimization-20261105.md) 执行 5 条问题样例和 3 条对照，模型仍为 `zhipu-coding/glm-5`，重构/返修请求 `max`，评审未指定档位，Linter skip。供应商实际档位仍未独立验证。

## 结论与逐条结果

最终 PASS 从同样例上一轮的 3/8 提升至 **6/8**，但限时 PASS 仍为 **3/8（37.5%）**。Code Clone 这 4 条为 1/4 限时成功，Long Method 这 4 条为 2/4。该批刻意包含困难样例，不代表全量成功率；6/8=75% 也不能替代用户要求的限时成功率。

原 5 条 BLOCKED 中，CC-I14、CC-I19、LM-L07 变为 PASS，只有 LM-L07 同时达成限时目标。本轮只剩 LM-I16 触发 1200 秒总上限；CC-I18 提前因测试进程死亡而 BLOCKED，不能将它当成评审通过或排除出分母。

计时均取终端 `RESULT totalSeconds`，包含准备，截止 result.json 写入，排除回滚；不能改用较短的 Agent 时间。

| 样例 | 上轮结果 / 秒 | 本轮结果 / 秒 | 本轮限时成功 | 返修轮数 | 实际主要结果 |
|---|---|---|---|---:|---|
| CC-I14 | BLOCKED / 1201.578 | PASS / 1186.518 | 否，>900 | 1 | 测试构建报新 Helper 的对象字面量类型错误；返修后设备 9/9 + 10/10、评审通过 |
| CC-I18 | BLOCKED / 1201.740 | BLOCKED / 339.829 | 否 | 0 | HomeVisitTest 第 1 条通过，第 2 条打开弹窗时 App died；ShippingInfoTest 未执行 |
| CC-I19 | BLOCKED / 1201.466 | PASS / 1171.240 | 否，>900 | 1 | 首轮仍报 TextInput missing；返修恢复宿主 NavDestination/生命周期边界后设备 5/5 + 5/5、评审通过 |
| CC-I13 对照 | PASS / 535.236 | PASS / 710.954 | 是，≤900 | 0 | 设备 8/8 + 8/8，评审通过，但总耗时增加 |
| LM-I16 | BLOCKED / 1200.911 | BLOCKED / 1200.909 | 否 | 2 | 首轮与返修后都为同一用例 15 秒超时；第二轮返修受总期限终止 |
| LM-I01 对照 | PASS / 225.314 | PASS / 552.699 | 否，>420 | 1 | 首轮测试通过但独立评审发现响应式状态按值传参风险；修复后通过 |
| LM-L07 | BLOCKED / 1200.827 | PASS / 397.941 | 是，≤420 | 0 | 只抽取 ratio 目标及 helper，未修改相邻 free 方法；Local 18/18、评审通过 |
| LM-L06 对照 | PASS / 388.436 | PASS / 272.601 | 是，≤420 | 0 | Local 18/18、评审通过 |

LM-L07 的限时成功增量被 LM-I01 的超时抵消，因此同组净限时成功数未增加。LM-I15 未在本批运行，沿用用户的暂排除要求。不能把本轮成绩择优回填旧的 14 条 Clone / 24 条 Long Method 分母。

## 哪些优化有证据支持

1. **SDK 探索减少。** CC-I18 首轮 Agent 1090.034→272.275 秒，SDK 相关 bash 查询 35→0，首个 edit/write 事件从约 1007→167 秒出现。但新方案引出了运行失败，速度改善不等于该条成功。
2. **返修具备实际落笔能力。** CC-I19 旧返修 487.098 秒内只读并超时；本轮 359.822 秒完成，read/glob/grep 总次数 19→4，写入后测试与评审通过。CC-I14 本轮返修直接使用内联证据，没有 read/grep/glob，343.761 秒完成；不过这次修的是测试构建错误，和旧轮残留克隆并非相同任务，不能把差值全部归因于证据包。
3. **长方法范围收敛。** LM-L07 首轮 Agent 875.415→262.845 秒，返修从 1 轮降为 0，diff 保留了相邻 `moveClipCanvasFreeType`。未修改比例业务算法规则，仍接受 Local 测试与独立评审。
4. **证据包仍不能替代明确的失败位置。** LM-I16 已收到完整 diff（大源码按路径提供），首轮 Agent 降至 219.331 秒，但两轮返修累计 839.328 秒。第一轮返修确实把 GridItem 放回原 ForEach 内，实际测试仍报同样超时；第二轮临近总期限才编辑，没有成功同步，不应把其工作区内容当成已验证结果。

这些都是同样例的单次前后观察，不是控制模型随机性和服务延迟后的因果实验。本轮总耗时 5832.691 秒，比上轮 7155.508 秒少 18.5%，其中包含 CC-I18 崩溃提前结束；不据此宣称整体吞吐已提升 18.5%。本轮重构、返修、评审子进程合计 5060.621 秒（约 86.8%），仍为主要耗时。它包含模型生成、服务等待和往返，不等于纯推理时间。已读取的新轮 Agent 日志未见结构化 API error 或 step_finish reason=length。

## 优先问题一：CC-I18 的进程死亡与宿主上下文

直接证据在 `runs/20261105-234657-5w4TER/code-clone-0001-HomeVisit/test.log` 及对应 test-attempts 的 coverage.log：

```text
test=mountsHomeVisitAndShowsLabels
result=Success
test=opensExpressDialog
...
TestFinished-ResultCode: -1
TestFinished-ResultMsg: App died
```

这不是“测试未启动”或只有缺失文件：安装和首个用例均已完成，第二个用例中进程死亡，未产生完整 Hypium summary。当前 `src/test_execution.ts` 的 `resultEvidence()` 仅从 test_result.txt 解析结果/汇总，将该情况归入 `missing, empty or incomplete Hypium summary`；`src/runner.ts` 遇到 BLOCKED 直接结束，所以没有触发返修或评审。保守不判 PASS 是正确的，但具体死亡诊断没有进入修复链路，终端的“环境或工具链阻塞”描述过于笼统。

本轮把 `new CustomDialogController(...)` 从 HomeVisit/ShippingInfo 宿主移到顶层 `createBottomSheetDialogController()`。保留的本轮编译产物直接显示：

- `v/782c1758/features/business_home/build/default/cache/default/default@HarCompileArkTS/esmodule/debug/business_home/src/main/ets/components/BottomSheetDialogFactory.ts:45` 生成 `new CustomContentDialog(this, ...)`，第 67 行生成 `new CustomDialogController(..., this)`。
- 同目录 `HomeVisit.ts:54` 是普通函数调用 `createBottomSheetDialogController(...)`，没有绑定宿主对象。
- 上轮设备测试通过的版本在 `v/91cd4502/.../HomeVisit.ts:430` 是宿主成员方法 `createSheetDialogController()`，其内部生成的 `this` 保留宿主归属。

这是明确的上下文丢失风险，且与打开弹窗时死亡相符，是优先根因候选；现存日志缺少死亡堆栈/对照重测，尚不把它宣称为已由运行堆栈证明的唯一根因。下一轮应保留用例中死亡的专门诊断与正在执行的 case，再按归因证据决定是否返修；不能把所有无 summary 都自动当代码失败，也不能放宽测试通过条件。抽取指导应保护依赖宿主的构造与生命周期，不能仅禁止 SDK 搜索后假定普通共享函数安全。

## 优先问题二：LM-I16 需要原始代码对照

**11 月 6 日 10:41 更新：下面安排的对照已完成，原始代码和首次重构各两次均 PASS，用例均约 13 秒。未复现稳定的重构回归，无需重复此命令；详见 [LM-I16 对照结果](long-method-i16-test-comparison-20261106.md)。此前失败记录及 A 批统计保留。下文描述的是发起对照时的依据。**

两个完整测试尝试都为 `GoodDetailPageTest.renders_package_good_detail_page: execute timeout 15000ms`，不是 beforeAll 宿主缺失。失败摘要没有告诉 Agent 具体卡在哪个 await。

只读核对原测试：用例体包含首个添加按钮查找/点击、等待空闲、滚动列表、第二个按钮查找/点击及等待空闲；多个单步查找允许 10 秒、等待空闲允许 5 秒，而用例总期限是 15 秒。因此现有错误不能单独区分 UI 抽取回归与原测试时序不稳定，也不能证明页面首次渲染失败。原始版本尚未在本轮条件下对照执行。

下一步先用同一冻结测试分别运行原始代码和首次重构代码各两轮，仅作诊断，不调用模型、不改变测试超时、不回填成功率。已只读验证该任务保留的验证副本：生产代码与末次同步快照一致、未变更源码与基线一致、两份冻结测试哈希及 task 哈希一致、没有新增生产文件，符合现有对照脚本的前提。

## 对照样例的回退

LM-I01 首轮 Agent 125.377 秒、测试 1/1 通过，独立评审 196.102 秒后判 FAIL。实际 diff 把 `this.selectState.isReadingBySwiper` / 其取反先算成 boolean，传入新 `@Builder flipModeOption(..., selected, ...)`；评审指出它失去了原来在属性绑定内读取 `@Trace` 状态的方式。返修移除 selected 形参，在 Builder 内直接比较状态与 swiperMode，测试和复审通过，总计仍达 552.699 秒。

不能因此跳过评审。现有自动响应式证据的边界主要是 `this.field` 直接传参，未覆盖此次嵌套属性加取反的表达式，属于可扩展的通用分析缺口；本次只记录，不修改运行时代码。CC-I13 的首轮 Agent 349.917→550.236 秒，也说明本轮不是所有样例都变快。

## 回滚与证据完整性

- 八条都有有效 result.json、匹配的终端 RESULT、ROLLBACK_SNAPSHOT 和 END，没有未完成任务。
- 核对每条 pre-run-production-baseline 的备份文件和原工程文件哈希，共 1362 份记录、831 个不同源码文件；全部一致，原工程没有额外 `.ets/.ts` 文件。
- 本轮变更清单没有资源变更或被拒绝的文件；新增 Helper 均已回滚删除。
- 各轮合计 15 个测试作业目录：10 个完整通过、3 个有用例错误、1 个测试构建失败、1 个 App died 无完整汇总。进程死亡作业已有 1 个成功用例，不能据此视为整组通过。最终 CC-I18 的 ShippingInfoTest 保持 pending。
- LM-L06/L07 本轮实际运行的是 Local 18/18，不能写成设备测试通过。
- 本次仅分析、记录和检查输入，没有运行 tools 脚本、模型、Hvigor 或设备测试，也没有修改生产代码、测试或运行时。

## 下一步与用户命令

建议先完成 CC-I18 崩溃诊断/宿主上下文保护，以及 LM-I16 的基线对照，再决定是否保持版本继续 B/C 全量。本轮不追加随机样例来抬高成功率。保留当前 A 批全部结果；若后续优化改版，应为新版本记录独立批次。

下面使用已有本地诊断脚本，名字虽为 code_clone，但其实现按传入任务的冻结计划运行，不限制异味类型。本次无需修改脚本，脚本继续不入 Git。日志和诊断产物统一写入 `C:\Users\RoyCai\Desktop\group_project\TestResult1028`。串行执行，不与其他设备实验同时运行。

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
Set-Location -LiteralPath $repo
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
& "$repo\tools\compare_code_clone_test.ps1" `
    -RunDirectory "$repo\runs\20261106-002402-aFr36K\long-method-0001-AM19-goodPkgComp" `
    -RepeatCount 2 `
    -LogDirectory 'C:\Users\RoyCai\Desktop\group_project\TestResult1028'
```

该脚本只在保留的 `v/e4d42eb9` 验证副本中切换生产快照，结束恢复验证副本原内容，不改原工程；本轮仅核对脚本与输入，命令由用户执行。输出 `comparison-summary.json` 中 baseline/initial 结果及 restored 字段用于下一次审计。

## 本轮定位表

所有终端日志均在约定 TestResult1028 目录，任务证据仍在仓库忽略的 runs 目录。

| 样例 | 终端日志 | runs 下任务路径 |
|---|---|---|
| CC-I14 | output20261105-232707-297.log | 20261105-232708-rj1i8G/code-clone-0001-EditNamePageVM |
| CC-I18 | output20261105-234655-714.log | 20261105-234657-5w4TER/code-clone-0001-HomeVisit |
| CC-I19 | output20261105-235237-179.log | 20261105-235239-cEFzqG/code-clone-0001-EditNamePage |
| CC-I13 | output20261106-001209-998.log | 20261106-001211-s0DTCu/code-clone-0001-EditNamePage |
| LM-I16 | output20261106-002402-191.log | 20261106-002402-aFr36K/long-method-0001-AM19-goodPkgComp |
| LM-I01 | output20261106-004403-626.log | 20261106-004404-ml9bQo/long-method-0001-buildSettingSheet |
| LM-L07 | output20261106-005743-389.log | 20261106-005744-Ju7Tob/long-method-0001-moveClipCanvasRatioType |
| LM-L06 | output20261106-010421-837.log | 20261106-010422-9bzUcx/long-method-0001-moveClipCanvasFreeType |
