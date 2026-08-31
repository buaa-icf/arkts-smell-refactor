# Code Clone 专项分析器与对比实验（2026-08-31）

## 实验目的与基线

- 专项分析器版本：本次工作区实现的 `analysis/code_clone.py`；通过 `risk-report.json`、重构提示、修复提示和只读语义评审提示生效。
- 数据集：`C:\Users\RoyCai\Desktop\group_project\arkts-code-smell\dataset\positive\instrument-test\code-clone.json`。
- 被测代码根目录：`D:\arktsProgram`；表中位置均相对此目录。
- 原始基线（未改动）：[2026-08-25 Code Clone 报告](C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\reports\code-clone-experiment-20260825.md) 与 [2026-08-30 Code Clone 报告](C:\Users\RoyCai\Desktop\group_project\TestResult0825\code-clone-experiment-20260830.md)。只纳入两份报告中流水线原始结论为 `FAIL` 的样本；`BLOCKED`、`PASS`、`INCOMPLETE` 不进入本轮对比。
- 基线 FAIL 候选：19 条，编号为 CC-001～CC-017、CC-019、CC-020。执行中按用户指令缩小为 CC-001、CC-014～CC-017、CC-019；CC-002 已人工中断而无终态，其他 12 条延期，不纳入本报告的专项对比统计。每条使用相同的六层门禁：R=重构 Agent、H=HomeCheck 复检、B=构建、T=测试、L=Code Linter、S=独立语义评审。
- 回滚：每条由 `tools/run_code_clone_series.ps1` 单独执行；完成后先对任务镜像和源文件做 SHA-256 一致性验证，再恢复原有生产文件或删除经验证的新文件。各条串行运行，绝不并发占用 `D:\arktsProgram`。
- 计时：从单条 JSON 提交到 `result.json` 写入的端到端耗时；回滚在随后立即执行，不单列入秒数。

## 专项分析器说明

### 输入和克隆组建模

分析器以数据集报告片段为主实例，解析 `is similar to` 后的每个对照片段（包括 `File.ets > Type.method():行号` 的方法限定写法）。对每个实例读取其准确行区间，形成稳定的 `clone-<hash>` 组 ID、文件边界和实例清单。未解析到的实例会显式标记，禁止 Agent 把局部修改宣称为“已完整消除”。

### 静态画像

它以词法级方式比较注释/字符串掩码后的控制骨架，并提取：`.id(...)`、`this` 状态引用与写入、ArkUI `on*` 回调、`await`、导航调用、字面量差异。输出分类为：完全相同、可参数化 Type-2、共同骨架变体、当前代码已偏离/检测陈旧、或对照片段未解析。推荐手法相应限定为私有方法/Builder 抽取、参数化 Builder/Helper、带显式回调的共同骨架，或先确认而不强行合并。

### 写入流水线的约束

每个 Code Clone 任务新增下列硬约束：

- `ELIMINATE_WHOLE_CLONE_GROUP`：必须同轮处理所有已知实例，避免只改报告片段而让 HomeCheck 在对照片段继续命中。
- `PRESERVE_CLONE_VARIATIONS`：UI ID、文案/资源、回调、状态和副作用差异必须作为显式参数或配置保留，不能用统一默认值抹平。
- 视画像追加 `PRESERVE_PER_INSTANCE_UI_ID`、`PRESERVE_CALLBACK_AND_STATE_ORDER`、`MINIMIZE_SHARED_HELPER_SCOPE` 或未解析保护约束。

独立评审被要求逐项核对完整实例组和新增共享实现，特别拒绝“共用组件”引入整行点击、导航、默认状态或额外副作用的改动。这直接针对旧基线中 CC-014、CC-016、CC-017 的 HomeCheck 持续命中，以及 CC-023 曾发现的导航/状态语义风险（CC-023 本身不属于本轮 FAIL 样本）。

### 验证

专项单元测试覆盖：跨文件 Type-2 片段、UI ID/回调/状态写入差异、风险和双 Agent 提示词注入、方法限定对照片段解析。执行 `python -m unittest discover -s tests -v`，共 40 项通过。

## 对比实验明细

“基线失败点”保留原报告的直接失败门禁及必要语境；本轮门禁结果在每条完成后填写。`SKIP` 表示受 fail-fast 规则影响而没有运行。下面的门禁与耗时来自用户提供的完整终端输出 `C:\Users\RoyCai\Desktop\1.txt`，失败归因再以相应任务目录的 `result.json`、变更清单和失败报告核对。

| ID | 位置 | 基线来源 | 基线失败点 | 专项分析器画像 / 建议 | 本轮门禁与耗时 | 对比结论 |
|---|---|---|---|---|---|---|
| CC-001 | `BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/AboutPage.ets:71-124` | 08-25 | S FAIL（评审基础设施） | `clone-8c93ef2c6ce5`，2/2 已解析；共同骨架变体，显式回调的共同骨架抽取 | R PASS 881.897 → H/B/T/L PASS (6.710/24.540/18.844/6.286) → S FAIL 8.767（ProviderNoProvidersError） → 修复 1 R FAIL 2178.330（已同步候选改动） → H/B/T/L PASS (6.391/16.989/14.010/5.807) → S PASS 529.456；总 3698.204s | PASS；两实例均改为参数化 `aboutCardRow`，回调/文案/条件渲染经评审确认等价；已哈希校验回滚 |
| CC-002 | `BusinessTemplate/OfficeAttendance/scenes/agency/src/main/ets/mock/DataManager.ets:13-33` | 08-25 | L FAIL；S FAIL（基础设施） | 已启动后人工中断，无最终 `result.json` | 不计入统计 | 待后续单独复跑 |
| CC-003～CC-013 | 见 08-25 基线报告 | 08-25 | 见基线报告 | 本轮延期 | 未运行 | 不纳入本轮结论 |
| CC-014 | `FinanceTemplate/FinancialManagement/scenes/tab/mine/src/main/ets/viewModels/EditNamePageVM.ets:6-40` | 08-30 | H FAIL，三次修复仍命中克隆 | `clone-c2b9abc5b9d0`，2/2；共同骨架变体（相似度 0.991），建议显式回调的共同骨架抽取 | R/H/B/T/L/S 全 PASS：204.731 / 8.108 / 20.288 / 20.245 / 14.694 / 144.222 秒；总 412.411 秒 | **PASS**。原 HomeCheck 失败消失；语义评审确认两个校验入口都委托给父类方法，同时保留 nickname/cellphone 规则与长度差异 |
| CC-015 | `KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets:90-100` | 08-30 | R FAIL | `clone-f9a0e8e81f8f`，2/2；可参数化 Type-2（相似度 1），建议参数化 Builder/Helper | R/H/B/T/L/S 全 PASS：753.037 / 6.674 / 15.421 / 14.262 / 5.236 / 144.577 秒；总 939.312 秒 | **PASS**。原 R FAIL 消失，全部门禁通过 |
| CC-016 | `KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets:165-179` | 08-30 | H FAIL，三次修复仍命中克隆 | `clone-f53f8d59eb7c`，2/2；可参数化 Type-2（相似度 1），建议参数化 Builder/Helper | R/H/B/T/L PASS：1209.294 / 6.672 / 16.150 / 14.130 / 5.200 秒；S **BLOCKED** 4333.612 秒（超过 3600 秒）；总 5585.162 秒 | **BLOCKED**。HomeCheck、构建、测试、Linter 均通过；仅独立语义评审超时，不能把它记为语义或克隆失败 |
| CC-017 | `PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets:443-475` | 08-30 | H FAIL，三次修复仍命中克隆 | `clone-7a2b6e2250a7`，2/2；共同骨架变体（相似度 0.725），建议显式回调的共同骨架抽取 | R **FAIL** 856.667 秒；H/B/T/L/S 均 SKIP；总 856.824 秒 | **FAIL（生产范围门禁）**。Agent 已抽取 `applyClipRectBounds`，其自检和 `assembleApp` 均成功，但额外创建 `local.properties`；该非生产配置被拒绝并使 R 以退出码 4 失败，因此不是 HomeCheck/编译/克隆消除本身的失败 |
| CC-019 | `ShoppingTemplate/Express/features/business_mine/src/main/ets/pages/EditNamePage.ets:18-70` | 08-30 | T FAIL（既有测试的可空性错误，工具判为非本轮归因） | `clone-eb5f93dce361`，2/2；可参数化 Type-2（相似度 1），建议参数化 Builder/Helper | R/H/B PASS：857.962 / 10.725 / 20.808 秒；T **FAIL** 12.323 秒；L/S SKIP；总 901.957 秒 | **FAIL（既有测试）**。失败报告分类为 `UNATTRIBUTED_TEST_FAILURE`：两个既有 VM 测试中 `vm.userInfo` “可能为 undefined”共 31 个 ArkTS 编译错误，和基线一致；不是本轮生产代码改动的归因失败 |
| CC-020 | `KidsTemplate/PostpartumCareCenter/scenes/activities/src/main/ets/view/ActivityBooking.ets:70-88` | 08-25 | S FAIL（评审基础设施） | 本轮延期 | 未运行 | 不纳入本轮结论 |

## 汇总（最终）

| 项目 | 数值 |
|---|---:|
| 基线 FAIL 候选 | 19 |
| 已完成专项对比 | 6 |
| 已中断、无终态 | 1（CC-002） |
| 延期未运行 | 12 |
| 本轮 PASS | 3 |
| 本轮 FAIL | 2 |
| 本轮 BLOCKED / INCOMPLETE | 1 / 0 |
| 08-31 新完成 5 条的端到端耗时 | 8695.666 秒 |
| 本轮已完成 6 条累计端到端耗时 | 12393.870 秒 |

### 结果解释

- 08-30 基线中 CC-014～CC-017、CC-019 的最终结论均为 `FAIL`；本轮变为 **2 PASS、1 BLOCKED、2 FAIL**。其中 CC-014、CC-015 的完整通过，直接表明专项画像能够把“完整克隆组处理”和“差异显式保留”的要求传给后续流程。
- 三条曾因 HomeCheck 持续失败的样本中，CC-014 已全通过，CC-016 的 H/B/T/L 已通过而仅 S 超时；CC-017 在 H 之前被生产范围门禁拦截。也就是说，这一轮没有出现可归因于“克隆未消除”的 HomeCheck 失败。
- CC-017 的失败应优先修复 Agent 的工作区卫生：禁止或在同步前移除 `local.properties`。其候选重构已经通过 Agent 内部 ArkTS 检查和 `assembleApp`，但流水线按规则拒绝非生产配置改动。
- CC-019 的测试失败是测试源代码的既有可空性编译错误；R、H、B 已通过，L/S 只是 fail-fast 未执行。若要验证该样本的完整专项效果，应先修复或隔离这两份测试的 `userInfo` 断言，再复跑。
- CC-016 的 4333.612 秒主要消耗在语义评审服务超过一小时后超时；它不能支持“语义不正确”的结论。
- 这是一组方向性对比，而非严格单变量因果实验：08-30 至 08-31 期间工具和模型服务也有更新。因此可确认专项分析器在当前版本下与 HomeCheck 通过相容，但要量化其单独贡献，仍需固定工具版本并复跑同一批基线样本。

### 回滚核验

- CC-014：已恢复 `EditNamePageVM.ets`、`EditPhonePageVM.ets`、`EditUserProfileVM.ets`。
- CC-015、CC-016：均已恢复 `TimeCtrl.ets`。
- CC-017：非生产文件门禁拒绝后未同步候选生产文件，无需恢复。
- CC-019：已删除新建的 `EditFieldPageView.ets`，并恢复 `EditNamePage.ets`、`EditPhonePage.ets`。

### CC-001 运行说明

- 首轮的 H/B/T/L 已全部通过；第一次 S 不是语义不通过，而是 `ProviderNoProvidersError` 基础设施失败。
- 修复 Agent 虽以退出码 4 结束，但其任务镜像中确有可同步的候选改动，随后 H/B/T/L 和第二次独立语义评审均通过；最终 `result.json` 判定为 `PASS`。
- 第二次语义评审确认两个片段都改为调用 `aboutCardRow`，并显式传入标题、副标题、标签、行 ID 和 `onClick`；无点击实例保留 `undefined`，客服电话实例保留箭头函数对 `this.PhoneSheetBuilder()` 的捕获。该结论和 HomeCheck 共同证明本克隆组被实质处理，而非仅移动或改名。

## 运行证据与可复现命令

```powershell
$env:PYTHONPATH = 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\src'
& 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\tools\run_code_clone_series.ps1' -StartOrdinal <N> -EndOrdinal <N>
```

每个任务的 `risk-report.json`、`result.json`、门禁日志、变更清单和回滚输出会保留在 `C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\<时间戳>\code-clone-0001-*`。
