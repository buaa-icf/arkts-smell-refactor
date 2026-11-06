# 2026-11-06：Code Clone 跨类分析器优化与固定复跑

**全量验证已完成：14条中10条限时PASS（71.4%），11条最终PASS。用户确认I19项目自身接口问题不计重构失败，正常保留该条PASS。见 [同版本全量结果与耗时](code-clone-cross-host-full-results-20261106.md)；本页后续的“尚未运行/待补齐”等文字均为实施时记录。**

优化前已创建本地 annotated tag **`agent-long-method-passed-20261106`**，指向 `5031f8c4be957a878356c537151aebd3d1c94f93`。该点包含 Long Method 类内全量 19/25 限时 PASS（76%）的实验记录；运行时为 `7fcf2b3`。tag 未推送。

本轮运行时提交：**`2bddaf8 feat: provide bounded cross-host clone extraction evidence`**。策略版本 `2026-11-06-cross-host-clone-evidence`。本轮仅完成实现、单元/受控集成测试及只读离线分析，**尚未运行真实 Agent 或设备实验，不能提前更新成功率**。

**后续进展：A 批8条已完成，6/8流水线限时PASS（75%），新增I6/I8/I14/I19四条限时成功；I18仍App died，I23模型长度终止无修改。I19有已确认的旧接口兼容问题，不能把流水线PASS等同无质量疑点。完整14条仍待B批6条，见 [A批结果与补齐命令](code-clone-cross-host-batch-a-results-20261106.md)。下面“尚未运行”保留为实现时记录。**

## 为什么先优化 Clone 分析器

上一轮 `1f68126` 修复 Long Method 的完整源码坐标接线，`7fcf2b3` 增加 Long Method 结构和状态证据，提示接入也只作用于 Long Method；共享修改主要是策略版本记录，没有改变 Code Clone 分析行为。直接用该版重跑 Clone，可能出现模型波动，但没有针对跨类抽取的新证据。

现有固定跨类组仍为 **8/14 限时 PASS（57.1%）**。严格超过 70% 需至少 **10/14（71.4%）**，即净增加两条，同时不能回退已有通过样例。最新结果参考 [全量历史审计](agent-expanded-results-20261105.md) 和 [BLOCKED 优化后 A 批](agent-blocked-batch-a-results-20261106.md)，不是将每条历史最好成绩混为同一版本。

| 未达标样例 | 最新完整结果 / 秒数 | 可确认的主要问题 | 本轮可泛化的处理 |
|---|---:|---|---|
| I6 AuthenticationPage | PASS / 956.050 | 零返修，首轮 536.678 秒；已有相同长字面量证据，但仍探索组件/模块抽取 | 展示原始对照，并将已确认的长字面量共享常量列为最小候选；不承诺只抽常量就能消除整个克隆 |
| I8 CollectionPage | PASS / 943.024 | 首轮 405.432 秒，返修 134.215 秒；新增组件的 `@Require @Event` 组合被编译器拒绝 | 提供实际宿主装饰器、相关字段/方法签名和逐实例差异，减少脱离原机制设计共享接口 |
| I14 EditNamePageVM | PASS / 1186.518 | 首轮 658.205 秒，返修 343.761 秒；共享 Helper 对象字面量缺少 ArkTS 接受的类型上下文 | 保留实际类型及可选值、静态入口；提醒新共享对象和参数使用可见具名类型或原 API 的明确上下文类型 |
| I18 HomeVisit | BLOCKED / 339.829 | 首轮 272.275 秒；把控制器构造移入普通工厂后设备 `App died`，缺少最终汇总 | 给出控制器构造、`this` 捕获和宿主位置，优先保留原构造上下文。宿主丢失是产物支持的嫌疑，尚无崩溃栈证明因果 |
| I19 EditNamePage | PASS / 1171.240 | 首轮 377.711 秒，返修 359.822 秒；测试报 TextInput missing，返修恢复原 NavDestination/生命周期后通过 | 给出完整路由容器 modifier 链与生命周期归属，避免抽内部 UI 时连根节点一起搬走 |
| I23 MyFavoritesPage | PASS / 1095.445 | 零返修，首轮 875.602 秒；15 read、6 grep、4 glob，首个 write 约在 779 秒 | 提供各实例原报告片段、现有成员类型和生命周期，减少重新拼装上下文 |

I6/I8/I23 沿用此前已完成运行，I14/I18/I19 采用后续 A 批指定结果。Agent 耗时含模型、服务等待和工具往返，不能把无工具事件的间隔都解释为纯推理；分析器改进也不能保证消除这些等待。

## 实现及边界

- 新增 `clone_cross_host.ts`：只在至少两个不同宿主且各实例可唯一定位时给出证据。报告可含 import、顶层常量或 Builder 入口；宿主信息只对应与报告相交的部分，不把顶层代码归进类。路径用已解析身份归一，避免 `./`、项目名前缀或 Windows 大小写造成假跨类。
- 附带宿主装饰器、CustomDialogController 构造及 `this` 引用、NavDestination/Navigation 完整 modifier 链、宿主生命周期、相关字段/方法签名、静态入口。这些是源码位置与现有声明，不替模型生成重构架构。
- 新增 `clone_comparison.ts`：提供原报告范围的完整源码，以及跨实例相同行和差异行的位置；单侧新增/删除的副作用也显式列出。只忽略行首尾空白，不通过重命名或字面量替换掩盖差异。
- 原文最多 6 个实例、每段 6000 字符、总共 16000 字符；不能完整内联则给出补读位置，不截断冒充完整。行对照最多 3 对，每段最多 401 行/16000 字符，编辑距离有上限。宿主画像最多 8 实例、单源 400000 字符，事实数量和签名长度也有限制。
- 新证据仅用于初始重构提示。返修使用现有每轮刷新的生产基线与 diff；评审不重复注入这轮新增的旧源码。原有同宿主专属提示不叠加跨宿主证据。
- 无样例编号、工程路径或业务类名分支；不修改裁剪比例算法，不改模型档位、门禁、420/900 秒成功目标及 1200 秒执行上限。

这仍是词法分析：复杂对象/函数返回类型保守省略，正则和模板插值不作完整语义解析；未列出的字段或差异不意味着不存在。报告跨多个宿主、位置无效或超预算时回退已有分析，不据此宣称安全等价。

## 已完成验证

- `npm test`：**312/312 PASS**，含 TypeScript 构建、原有各异味/调度/隔离测试和新增 17 项测试。新增用例覆盖一般结构和负例，不复刻数据集业务实现。
- 只读分析当前 30 个 Clone 数据集输入，未调用 Agent、HomeCheck 构建或设备：14 条跨类中 13 条得到新画像，6 条未达标样例均覆盖；15 条类内和顶层 Builder I22 均未添加新提示。
- I5 一端报告末行为 139，当前文件只有 138 行，因此保守回退，没有猜测修正检测坐标。其原有分析/执行路径继续可用，也继续计入固定 14 条验证分母。
- 此次离线 30 条专属分析累计约 147 毫秒，仅作运行开销观察，不是基准性能承诺。13 条新增提示约 4748～16023 字符；输入变长是否换来更少往返与返修，仍待真实实验。
- 6 条问题样例的新增提示字符数：I6 7742、I8 4748、I14 6864、I18 8675、I19 6550、I23 6883。初始原文全部完整内联；返修和评审均未出现新增原始证据段。
- 没有修改真实工程、实验断言、设备或 SDK；没有执行 `tools/` 脚本。实验 PowerShell 脚本继续本地忽略，不进入 Git。

## 固定复跑范围

先 A 后 B，同一运行时、相同配置。A 共 8 条：6 条未达标样例 I6/I8/I14/I18/I19/I23，加普通数据类 I2 和 UI 页面 I13 两条已通过对照。A 审计后，如不再改版，B 补 I5/I7/I9/I10/I11/L3，共 6 条；两批构成本版本跨类全量 14 条。

每条采用本版本首次完整尝试，保留失败和中断，不取重跑最好值；有计划外重跑时单独说明原因与统计口径。最终 PASS 且终端 `RESULT totalSeconds <= 900` 才算跨类成功；A 的小样本率不能代替全量。观测端到端耗时、返修次数、首个 edit/write 时间、工具调用及评审耗时，但不把首个工具写入事件当成所有 shell 写入的完整记录。

本轮不先扩大分母来争取 70%。现有阳性样例已全覆盖，新增范围应预先冻结新的独立工程/宿主及对应测试，作为独立扩展组；长期仍需补独立 Long Method 跨类样例。Long Method 已验证的类内 76% 和 Clone 类内历史结果保留原版本口径，见 [Long Method 全量结果](long-method-full-results-20261106.md)。

## 用户 PowerShell 命令

以下命令仅供用户运行，所有实验终端日志写入指定目录，原有 `runs/` 任务证据仍保留。串行执行，保持原脚本对结果缺失、身份矛盾、回滚失败的停止行为。

A 批（现在先运行这 8 条）：

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

foreach ($i in @(6, 8, 14, 18, 19, 23, 2, 13)) {
    & "$repo\tools\run_code_clone_instrument.ps1" `
        -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
```

B 批（A 审计后、确认运行时未改再补齐；新终端先执行上面的准备段）：

```powershell
foreach ($i in @(5, 7, 9, 10, 11)) {
    & "$repo\tools\run_code_clone_instrument.ps1" `
        -StartOrdinal $i -EndOrdinal $i -LinterMode skip -LogDirectory $logDir
}
& "$repo\tools\run_code_clone_local.ps1" `
    -StartOrdinal 3 -EndOrdinal 3 -LinterMode skip -LogDirectory $logDir
```
