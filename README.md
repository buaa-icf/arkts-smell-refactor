# ArkTS 代码异味重构与验证工具

`deveco-plugin/` 包含 DevEco Studio 的 Java 插件，`opencode-plugin/` 包含 DevEco Code／OpenCode 的原生终端工作台。两者均通过 Node JSONL 桥接调用本仓库 TypeScript 后端。下文命令用于后端 CLI；TUI 的配置、`/arkts` 入口、候选 Diff、确认应用及回滚流程见 [TUI 使用说明](opencode-plugin/docs/usage-and-validation.md)。

## 1. 安装和启动

需要 Node.js **22 或更高版本**（官方构建 CLI 的运行要求）。

在本工具仓库根目录执行：

```sh
npm install
npm run build
```

首次保存包含待重构仓库的总目录：

```sh
npm run cli -- configure --workspace "D:/ROG/Documents/harmonyos/test_supplement"
```

然后检查外部工具是否可找到并启动：

```sh
npm run cli -- doctor
npm start
```

看到粘贴提示后输入完整 JSON，程序会自动开始。无需安装全局命令，也不用给本项目单独配置 PATH。

自动化批量跑全测试集脚本：

```sh
npm run batch -- --workspace "D:\ROG\Documents\harmonyos\test_supplement"
```

## 2. 外部工具和工作区

重构/评审使用本机 DevEco Code（`deveco`）。**build 门禁使用该 DevEco Code 安装中自带的官方 `@deveco/deveco-cli` 执行 `devecocli build`**，通过所选 DevEco Code 的 npm 安装位置解析 CLI，不单独搜索 `devecocli`、`hvigorw` 或 `ohpm` 的 PATH，不回退旧构建入口；没有完整 CLI/平台实现包时明确 BLOCKED。其底层 SDK、Java 和官方构建工具仍需安装，由官方 CLI 定位，不表示这些工具已经内置到 refactor。

Build 和 Linter 均复用所选 DevEco Code 安装中的官方 CLI，不需要额外配置检查器命令或路径。测试/Runtime Smoke 仍使用 `hvigorw` 和 ohpm，这两个入口目前按当前进程 PATH 查找（插件也可显式配置）。当前 CLI 1.3.4 没有独立的 `devecocli test` 命令，不能用 build/run 冒充测试。`doctor` 只显示官方 CLI 和仍需独立定位的测试工具；不输出 HomeCheck 条目或外部检查器路径，内置检测包缺失时才提示重新 `npm ci`。它是安装完整性检查，不能代替实际登录、SDK、签名、网络或设备验证。本项目本身无需加入 PATH。

DevEco Code 测试版 `@deveco-test/deveco-code@0.1.0-TD.52`（以及正式版 0.2.5）的重构、修复和评审调用使用 `deveco run ... --format json --auto`；`--auto` 自动批准未被明确拒绝的权限，不覆盖用户配置中的拒绝规则。TD.52 的部分依赖要求 Node.js ≥22，使用该测试版时请使用 Node.js 22 或更高的受支持版本。升级后若提示 `Review the product agreements`，请先自行打开 DevEco Code 阅读并确认协议，或运行 `deveco auth consent` 交互确认；本工具不会代替用户接受协议，未确认时记为 BLOCKED，而非重构 FAIL。自定义旧配置中的 `--dangerously-skip-permissions` 也需要改为 `--auto`。后端修改后运行 `npm run build` 再启动。

TD.52 自动生成的 `.homegraph/` 数据库、锁和日志作为运行缓存处理：不复制到隔离/验证副本，不参与生产变更比较，也不回写原仓库；这不放宽测试、构建配置等文件的修改边界。如果 Agent 内部命令报 `@deveco/deveco-cli-common` 缺失，切换到 Node.js ≥22 后执行 `npm install -g @deveco-test/deveco-code@0.1.0-TD.52 --include=optional` 补齐官方可选依赖。仅升级 Node 并不会自动修复先前的全局包安装。

**HomeCheck 固定使用本仓库自带的 npm 包** `@arkts-refactor/homecheck-runtime@1.0.0`。制品保存在 `vendor/arkts-refactor-homecheck-runtime-1.0.0.tgz`，约 9 MB；安装后位于 `node_modules/@arkts-refactor/homecheck-runtime/`。其中包含 HomeCheck 0.9.9-rc.26、ArkAnalyzer 1.0.92、ArkTS 解析器、编译后的自定义规则、既有补丁、范围外告警过滤和全部运行依赖。

命令行、DevEco Studio 桥接后端和 OpenCode 桥接后端均使用该包，不再查找工作区、当前目录或 PATH 中的 HomeCheck。旧的 `ARKTS_REFACTOR_HOMECHECK` 和插件 `homecheck` 路径设置不再参与选择，避免误用另一台电脑或旧版本的扫描器。

扫描由当前 Node.js 直接启动包内 `scan.cjs`，规则直接加载，不在扫描期间调用 npm、联网下载依赖、Git、CLOC、F1 或性能面板。包本身是跨平台 JavaScript，不打包平台专用 Node 可执行文件；需要本机已安装受支持的 Node.js。当前只支持四类 ArkTS 异味，不启用 ArkAnalyzer 可选的 C++ 原生解析器。ArkTS SDK 如存在则从 DevEco 环境/工具安装位置发现，不在包中保存本机 SDK 绝对路径。

依赖不完整时明确报 BLOCKED，并提示重新运行 `npm ci`，不会回退到本机其他 HomeCheck。包可只读安装；临时配置、报告和日志都写入本次任务输出目录。报告包含版本和已加载规则列表，缺少目标规则、Scene 失败、规则执行报错、文件数不符或报告缺失都不能当作“没有异味”。

工作区结构例如：

```text
test_supplement/
├─ agc-template-market-harmonyos-demos/
└─ applications_settings/
```

`--workspace` 指向这层总目录。实际 Harmony 工程从目标文件向上查找 `build-profile.json5` 和 `hvigor/hvigor-config.json5`，不把包含多个应用的仓库根目录直接当作可构建工程。

默认工作区优先级：命令行参数 → `ARKTS_REFACTOR_WORKSPACE` → 用户配置。用户配置保存在 Windows 的 `%APPDATA%/arkts-smell-refactor/config.json`，或 macOS/Linux 的 `$XDG_CONFIG_HOME/arkts-smell-refactor/config.json`（未设置时为 `~/.config/...`）。可沿用原来保存的工作区设置。

Instrument Test 需要可用设备/模拟器及工程要求的签名配置。工具不会因为只编译成功、设备未连接、报告为空或复用了旧报告而判测试通过。

## 3. 输入格式

交互输入接受单条对象，或由这些对象组成的数组。`prepare --dataset` 接受标准数组文件。

```json
{
  "filePath": "demo/entry/src/main/ets/model/OrderVM.ets",
  "sourceProject": "demo",
  "commitHash": "仅保留为元信息",
  "messages": [
    {
      "line": 31,
      "column": 3,
      "severity": "SUGGESTION",
      "message": "Method 'getTotalCash' is feature-envious toward 'OrderInfo' (ATFD=5, LDA=0.00, CPFD=1).",
      "rule": "@extrulesproject/feature-envy-check",
      "rangeStart": 31,
      "rangeEnd": 39
    }
  ]
}
```

每条 `messages` 展开为独立任务。直接针对本机当前代码重构，不自动 checkout、commit 或恢复到 `commitHash`。支持 Feature Envy、Long Method、Switch Statement、Code Clone，以及已有的 `formal/god-class` 和 `formal/directory-cycle` 分析输入。架构类任务所需的 `analysisContext` 会原样保留。

克隆消息中的关联文件及范围也会解析；测试类别以真实工程测试注册情况为准，数据集的 `testKind` 仅是输入元信息，不会用它跳过应执行的测试。

## 4. 执行流程

1. 解析数据集，生成统一 `task.json`。
2. 纯静态分析公开接口、生产调用点、响应式状态和异味专项结构，生成风险与约束。
3. 生成提示词；复制不含测试代码的生产工作区，调用 DevEco Code 重构 Agent。
4. 检查修改边界，拒绝删除和非授权修改；回写允许的生产源码、模块 `Index.ets` 和生产资源，保存修改前基线及完整 diff。
5. 并行运行异味复检、构建、公共契约检查（若启用）和 Linter（若 required）。任一失败即取消仍运行的同组任务。
6. 前面通过后，顺序运行风险触发的 Runtime Smoke（若启用）及测试。测试依赖构建完成，避免同时使用同一 Hvigor 工程。
7. 所有必需门禁通过后，启动独立只读 Review Agent。
8. 可归因于本次修改的失败生成失败分析，再调用同一类重构 Agent 做定向修复，最多 **3 次修复**。修复从当前已修改的代码继续，随后重新执行验证。

五层验收仍是：**异味消除、编译、测试、Linter、语义 Review**。公共契约和按风险触发的 Runtime Smoke 是额外验证，不是替代测试。

自动测试选择在重构前按“原文件 + 所属 class/struct + 方法名及参数签名”保存接口身份，通过测试导入、别名/重导出、接收对象类型和方法调用，以及可解析的辅助函数调用，关联实际注册的 suite。同一生产文件的不同方法、不同 Local Test 文件或不同 suite 可以分别选择；同一个 suite 内的全部用例仍一起运行，不只选单个 `it`。如果本地和设备测试都有明确接口关联，则两者都运行，不能为了避免签名而跳过设备测试；同名但没有原接口关联证据的测试记入排除记录，不声称已证明不存在间接覆盖。这是有界静态匹配，不是完整跨语言/UI 事件调用图；没有明确匹配时仍回退到同文件/模块的可用测试，不凭数据集 `testKind` 跳过设备测试。

Code Clone 同文件多个实例按各自所属方法合并选测。若已找到直接接口测试，同模块、按目标文件命名的已注册设备测试中，`it` 用例名等于某个克隆成员名或以 `成员名_` 开头的套件也会完整运行。计划用 `declared-device-case` 单独记录这种用例命名依据，便于区分直接调用和 UI 间接覆盖。

Code Clone 专属分析器为已确认同一宿主的 UI 克隆补充 `reactiveExtraction`：原 `ForEach/LazyForEach` 数据源、宿主字段或成员形参的声明位置、装饰器及宿主内直接读取/疑似写入位置，同时传入重构与评审提示词。宿主状态与形参混用时，优先保留原数据源读取及外层容器，抽取共同子项或事件实现。这是有范围限制的词法证据，不追踪别名、外部写入、框架更新及模板插值；未发现直接写入不能证明状态不变，也不能作为按值传参等价的依据。

专属分析器还会定位包含检测片段的完整 UI 节点及修饰符链（限 100 行、6000 字符），保持检测器原范围不变。同步事件中的同形配置调用若带内联回调和直接字段写入，`eventExtraction` 提供完整调用原文、同宿主候选位置及各自写入差异，优先提示保留 UI 原位、抽取普通成员 helper；不会仅因片段位于 `build()` 就统一推荐 `@Builder`。每组最多展示 8 处候选、每次最多 2 组；形态一致不代表配置值或行为等价，异步及无法解析的情况保留原建议。

完整节点内的非 ASCII 短文案附带原行列和等值 Unicode 源码转义，帮助 Agent 直接复制原值。评审材料中的 `review-literals.json` 比较前后生产快照的短字符串解码值，提供缺失/新增值、位置和可能的码点替换；允许重复实现合并、换引号及等值转义。模板、拼接及正则歧义不求值，证据有明确数量上限。该对照仅辅助 Agent 自查与独立评审，不自动修改代码、不改变门禁判定；值集合一致也不能证明调用顺序、次数或语义等价。

原计划保存在 Agent 工作区之外的 `baseline-test-plan.json`，包含接口身份、匹配依据及测试文件哈希；重构和每轮 Loop 后沿用，不根据改名/提取后的代码重新猜测测试。新增跨模块源码仍补充相应测试。原任务、已选测试内容或注册关系变化时记为 `TEST_PLAN_STALE`，不能复用旧证据。每轮实际计划、排除记录和覆盖缺口写入 `test-plan.json`。仅完整 SDK 原始字符串断言模板会按模板规则排除，显式指定测试任务不应用自动选择与模板排除。设备安装 ABI 不匹配记为 `BLOCKED / DEVICE_ABI_MISMATCH`，不进入代码修复 Loop；真实断言失败仍为 FAIL。

原计划还冻结 `uiCaseEvidence`：已选设备用例通过 `ON.id` 查询，或通过本文件直接转发到 `waitForComponent(ON.id(parameter))` 的函数，访问目标生产组件的静态 ID 时，保存用例名、UI ID、源码位置和哈希。ID 必须在应用生产源码中唯一，用例名必须在该作业内唯一；不借用 hooks、其他用例或普通字符串中的 ID。归因前核对原任务和测试哈希，按失败用例逐条关联；模块兜底测试也可进入返修，但同轮含无关失败仍不放行。动态 ID、嵌套回调和未解析 helper 保守不建立关联；此证据不改变测试选择，也不证明失败一定由重构引入。

每条异味默认总执行上限 **1200 秒**，包含 Agent、门禁、修复和 Review；达到上限终止当前进程树并记录超时。重构和返修 Agent 完成编辑与源码自查后，可在隔离工作区调用 `build_project` 或 `arkts_check`（新版对应 `devecocli build` / `devecocli check arkts`）做必要内部验证；提示词要求每轮合计最多两次，首次通过即停止，只有明确属于本轮修改的错误才修复并追加一次。环境或签名失败立即交回。完整的平台门禁仍执行，Linter 按 required/skip 配置；skip 时不为纯风格问题补跑或返修。网页与 `skill` 入口继续禁用；只读评审及 JSON 格式修复仍禁用内部构建/检查工具。

首次内部验证的交接要求同时前置到 Agent 启动指令：完成全部编辑和源码自查后，选择 check 或 build 之一，bash description 使用 `ARKTS_FINAL_CHECK`，成功后交回，避免 check 通过后继续 build。运行器仍要求本会话、真实 CLI 成功元数据、覆盖所有已观察到的源码编辑和独立验证步骤；没有标记不会自动终止 Agent，但成功的未标记检查会保留编辑状态，使后续显式收尾有效。失败或证据不完整的检查仍需新编辑后才能通过复验交接。

测试期间，Hvigor 的 stdout/stderr 按行脱敏后实时写入 `test-attempts/<轮次>/<作业>/hvigor.log`，并转发到 `test.log`（返修轮为 `test-repair-N.log`）。同目录 `progress.json` 保存阶段历史、时间、最后输出时间和报告快照路径；已生成的 `test_result.txt`、`coverage.log` 每 0.5 秒采样保存，子进程正常退出前也会最后采样一次。

每个测试作业另设以下阶段时限，按已确认的完成标记推进，重复输出不会重置计时；整条任务剩余时限更短时，仍以整条任务时限为准。可用对应环境变量设置正数秒值。

| 阶段 | 开始依据 | 默认时限 | 环境变量 |
|---|---|---:|---|
| `preparing-test` | 启动该测试作业的 Hvigor | 300 秒 | `ARKTS_TEST_PREPARE_TIMEOUT_SECONDS` |
| `awaiting-install` | 当前测试模块 `ohosTest@SignHap` 完成 | 90 秒 | `ARKTS_TEST_INSTALL_TIMEOUT_SECONDS` |
| `awaiting-test-result` | 安装完成，或已读到测试运行记录 | 300 秒 | `ARKTS_TEST_EXECUTION_TIMEOUT_SECONDS` |
| `collecting-results` | 设备执行结束标记，或 Local Test 汇总出现 | 60 秒 | `ARKTS_TEST_COLLECT_TIMEOUT_SECONDS` |

阶段名表示最后确认的进度，不能仅凭 `awaiting-install` 判断具体卡在安装还是安装前的设备命令。没有对应标记的阶段沿用之前的计时。阶段超时终止 Hvigor 进程树，记为 `BLOCKED / TEST_PHASE_TIMEOUT`，不进入代码返修。外层总超时强制结束门禁时，由仍在运行的外层 Runner 将未完成的测试索引收尾为 `BLOCKED / TEST_GATE_TIMEOUT`，保留已通过作业及最新快照，避免遗留 `RUNNING`；终止整个 Runner 进程不在此保证内。本地实验脚本仍按预运行快照回滚源码。

## 5. 各层如何判断

- **异味**：当前 Node.js 调用内置包的 `scan.cjs`，只扫描当前目标和本任务修改/新增的生产文件；使用独立本轮报告。判断原符号（含 `%AM序号$外层方法` 匿名名称）及本次变更方法的异味，不能直接复用数据集旧行号去判断别的方法。扫描工具错误是 BLOCKED，实际异味残留是 FAIL。
- **构建**：在 `v/` 下的验证副本调用所选 DevEco Code 自带的官方 CLI，显式指定模块，例如 `devecocli build --product default --modules entry@default hotel@default`。选择当前 product 对应的全部 HAP 入口/特性模块，并补充本次涉及的库模块；纯库工程构建库模块产物。根据 `src/main/module.json5` 和 targets/applyToProducts 解析，不靠模块名猜类型。**不能只传 `--product default`**：那会切到 `assembleApp`，额外校验整个应用包的卡片截图等资源，扩大原 HAP/模块编译验收范围。本门禁不声称已完成整包发布校验。依赖安装、同步和底层构建由 CLI 管理，不另找 hvigorw/ohpm。product、模块类型或 target 无法可靠确定时明确阻塞。必须同时有退出码 0 和官方 `Build completed successfully` 标记，帮助输出或缺少证据不能算 PASS。`build-evidence.json` 记录版本、命令、模块范围、工作区及判定。Agent 不得自行修改签名、wrapper 或依赖配置。
- **公共契约**：保存模块导出和公开成员签名，比较是否删除或不兼容变更。
- **测试**：解析 `build-profile.json5` 和 `List.test.*` 注册链；优先沿用重构前原接口关联的 suite，也能查找别的宿主模块；无法精确匹配时保守回退。每次先清除副本旧报告，必须有新生成的 Hypium 用例和完整汇总，Instrument 还要求设备完成标记。beforeAll 找不到测试宿主属于 BLOCKED，不冒充业务断言失败。
- **Linter**：仅判断本任务变更行引入/触及的诊断，不因文件里别的既有诊断判失败。提示词读取最近的项目风格配置，并展开 `ruleSet` 继承的显式风格规则，把 `semi`、`naming-convention` 的私有成员前导下划线、`avoid-overusing-custom-component-check` 等转成可执行的生成检查；存在 `overrides` 条件覆盖时不猜生效选择器。摘要不是完整生效配置，仍需实际 Linter 判定。
- **Review**：优先读取集中评审材料（`review-agent-prompt.md`：变化文件前后精确路径与 SHA-256、完整 diff、完整前后源码、风险清单和机械门禁摘要），只有 `inline=false` 的材料才按精确路径补读；不访问原项目、不读测试、不重复运行工具。材料损坏时输出 `REVIEW_PACKET_BLOCKED` 并中止，不启动模型。UNCERTAIN/无有效 JSON 记为 BLOCKED，不能借用旧评审 PASS。

测试的实际子进程命令格式如下，模块和 suite 由原接口测试计划自动生成，在隔离副本执行，并不是让使用者手动运行：

```sh
# Local Test；以下为 RechargePage 的实际参数示例
hvigorw --no-daemon test -p module=book_person -p coverage=true -p scope=RechargePageTest

# Instrument Test；模块名和套件名由计划替换
hvigorw --no-daemon onDeviceTest -p module=模块名@ohosTest -p coverage=true -p scope=套件名 -p ohos-debug-asan=true
```

副本依赖尚未准备时会先执行 `ohpm install`。没有可精确指定的 suite 时，保守回退会省略 `scope` 参数并记录原因；本地测试要求本轮 Hypium 用例/汇总，设备测试还要求本轮设备执行完成证据，不能只凭 `BUILD SUCCESSFUL` 判定通过。

设备、签名、下载、网络、工具缺失或总超时通常不能通过修改生产代码解决，不进入代码返修。失败分析保留阶段、分类、归因证据、具体文件/位置和可否修复。

构建成功不会额外跑基线。只有当前构建出现非环境类失败时，才在另一个隔离副本中根据本任务 `baseline-production/` 和变更清单恢复原代码/资源、移除本任务新增文件；保留其他既有修改，不使用 Git HEAD 替代任务开始时的代码。使用完全相同的 CLI、product 和模块参数验证基线。仅“基线 PASS、当前 FAIL”可归因为 `INTRODUCED_BUILD_FAILURE` 并进入修复；基线也失败记为 `BLOCKED / BASELINE_BUILD_FAILURE`，快照缺失、路径异常或基线证据不全记为 `BLOCKED / BUILD_BASELINE_UNAVAILABLE`。不能因为警告里出现变更文件名，就把无关打包错误归因于重构。`build-baseline-evidence.json`、带运行标识的基线日志及 `failure-report.json` 保留归因依据；基线验证也计入单例总时限。不会通过删除无关资源来让门禁通过。

## 6. 输出和结果含义

每批写入 `runs/YYYYMMDD-HHMMSS/`：

```text
input.json                         本批输入
summary.json                       整批结果和总耗时
feature-envy-0001-getTotalCash/
├─ task.json                       标准任务
├─ risk-report.json                完整静态风险
├─ review-risk.json                评审需要的语义风险
├─ effective-config.json           自动发现工具后的实际配置
├─ refactor-prompt.md               原始重构提示词
├─ refactor-agent-prompt.md         实际传入 Agent 的提示词审计副本
├─ refactor-workspace*/             无测试的重构工作副本
├─ refactor-changes.json            本任务生产修改清单
├─ baseline-production/            修改前代码
├─ current-production/             修改后代码
├─ review-context-production/      直接和传递生产依赖
├─ review-diff.patch                修改对比
├─ homecheck-report/               各轮检测报告
├─ test-plan.json                   测试选择计划
├─ test-results.json                最新一轮测试证据索引
├─ test-attempts/                   分轮、分 suite 的不可混用证据
├─ failure-report*.json             失败分类与归因
├─ repair-prompt-*.md               定向修复提示词
├─ *.log                           各阶段日志
├─ gates.json                      最新一轮门禁
├─ review*.json                    语义评审
└─ result.json                     最终判定、历轮步骤和耗时
```

PASS 表示本任务全部必需验收通过；FAIL 表示已确认的重构/验证缺陷；BLOCKED 表示环境、证据或超时阻止有效判定；INCOMPLETE 表示缺少必需步骤。`result.json` 中早期 FAIL 可在修复成功后成为最终 PASS，应结合 `attempts` 看最终轮次。

## 7. 分步命令和自定义配置

只准备任务，不调用 Agent：

```sh
npm run cli -- prepare --dataset "positive.json" --workspace "D:/workspace" --output "runs/prepared"
```

执行一个已准备的任务：

```sh
npm run cli -- run --task-dir "runs/prepared/feature-envy-0001-getTotalCash" --config "config.local.json" --dry-run
npm run cli -- run --task-dir "runs/prepared/feature-envy-0001-getTotalCash" --config "config.local.json"
```

通常直接 `npm start` 即可，自动发现和生成命令。自定义模式可复制 `config.example.json`；其中 `REPLACE_WITH_HOMECHECK_ROOT` 必须换为本机目录。命令使用字符串数组可避免路径和空格问题。旧配置若含 `python -m arkts_smell_refactor...`，需要手动改成 Node 命令，平台不会执行兼容的 Python 后端。

自动替换的占位符：`{task_dir}`、`{task_file}`、`{risk_file}`、`{prompt_file}`、`{review_prompt_file}`、`{repair_prompt_file}`、`{project_root}`、`{workspace_root}`、`{target_file}`、`{backend_root}`、`{harmony_root}`。`project_root` 是数据集源仓库根；`harmony_root` 是最近可构建的 Harmony 工程。占位符只替换路径，不执行命令。

## 8. 本地实验批跑脚本

按异味和数据集类型提供四个入口。这些 PowerShell 辅助脚本保存在本机 `tools/` 中，由 `.gitignore` 忽略，不随仓库分发；它们会调用本仓库 TypeScript CLI（`node dist/cli.js`），因此需先执行 `npm install` 和 `npm run build`。新克隆的仓库请直接使用上文的 CLI 或 `npm run batch`。

| 脚本（`tools/`） | 数据集（`dataset/positive/`） | 当前展开样本数 |
|---|---|---:|
| `run_long_method_local.ps1` | `local-test/long-method.json` | 8 |
| `run_code_clone_local.ps1` | `local-test/code-clone.json` | 3 |
| `run_long_method_instrument.ps1` | `instrument-test/long-method.json` | 17 |
| `run_code_clone_instrument.ps1` | `instrument-test/code-clone.json` | 27 |

四个入口共用 `run_refactor_experiment.ps1` 和 `task_source_rollback.ps1`；默认从第 1 条跑到数据集末尾，保留 `-StartOrdinal`、`-EndOrdinal`、`-ListOnly` 和 `-LinterMode required|skip`。Linter 默认仍为 `skip`；完整门禁实验显式传 `required`。`-LogDirectory` 可将终端输出同时写入指定目录的 `output<日期时间>.log`。每条结束或异常退出时按预运行快照回滚生产源码，正常结果目录另存 `experiment.json` 记录数据集类型及原序号。

`local`/`instrument` 表示样例来源，不强制覆盖 `auto-test` 的测试类型选择；目标同时有可达的两类测试时仍会全部运行。四个脚本共用源码和设备，必须串行执行。完整命令、单条重跑、日志和路径配置保存在本机 `docs/experiment-scripts.md`。根目录 `docs/` 由 `.gitignore` 忽略，其中的实验记录和报告保留在本机，不随仓库分发。

截至 2026-11-06，三个已有固定样本组均达到“最终 PASS 且在所属时限内”的成功率严格 >70% 目标（Linter skip）：

| 分组 | 时限 | 限时 PASS | 验证运行时 |
|---|---:|---:|---|
| Code Clone 类内 | 420秒 | 13/15（86.7%） | `3b3e937` |
| Long Method 类内 | 420秒 | 19/25（76.0%） | `7fcf2b3` |
| Code Clone 跨类 | 900秒 | 10/14（71.4%） | `2bddaf8` |

完整方法、逐条结果、测试与阶段耗时保存在本机 `docs/code-clone-experiment-20261106.md` 和 `docs/long-method-experiment-20261106.md`。各组对应其冻结验证批次，不表示最终版本一次重跑了全部样例；顶层 Builder 单列，目前没有独立的 Long Method 跨类样本。里程碑 tag 为 `agent-three-groups-passed-20261106`，指向 `ea370d4`，已合并回本地 `dev_cly`。

## 9. 开发与迁移范围

迁移后的 Agent、测试归因、评审及日志优化，以及截至 2026-11-05 的验证边界，保存在本机 `docs/typescript-agent-optimization-retrospective-20261105.md`。

```text
src/
├─ cli.ts / automatic.ts           命令行、配置、粘贴输入和批量调度
├─ models.ts / dataset.ts          任务类型和数据集解析
├─ risk.ts / analysis/             通用风险与六类专项分析（含 literals、long_method、detector_rules）
├─ prompts.ts / linter_profile.ts  提示词和项目规则摘要（含 ruleSet 继承与生成检查）
├─ agent_runtime.ts                Agent 模型/档位解析、工具禁用和环境隔离
├─ review_packet.ts / review_output.ts 集中评审材料与最终 JSON 评审解析
├─ source_format.ts                BOM/换行等常规编码适配
├─ runner.ts / process.ts          并行编排、Loop、失败分析、进程树和超时
├─ gate.ts / smell.ts              外部验证工具入口
├─ workspace.ts                   隔离副本、生产同步与评审材料
├─ test_plan.ts / test_execution.ts 测试发现及本轮真实执行证据
├─ public_contract.ts              公共契约
└─ runtime_smoke.ts                风险触发的公开构造验证
tests/                            Node 原生测试及原 Python 行为固定样本
package.json / package-lock.json   Node 依赖与命令
tsconfig*.json                    TypeScript 编译配置
deveco-plugin/                    Java 插件，通过 Node JSONL 连接 TypeScript 后端
runs/                             历史记录和新运行记录
```

执行回归：

```sh
npm test
```

回归包括原 Python 分析结果对照、受控 Agent/HomeCheck/Hvigor 子进程、测试注册选择、真实报告校验、并行 fail-fast、三轮修复、总超时、生产修改边界和传递依赖。受控测试不等于真实模型、SDK、签名和设备上的全量实验；使用新后端开展实验时应重新验证实际任务。

本次移除了旧 `src/arkts_smell_refactor/`、根 `tests/test_*.py` 和 `pyproject.toml`，清理旧 Python 缓存及临时验证副本；历史 `runs` 保留。插件界面及应用事务仍使用 Java，连接层已切换到 Node：配置 Node 可执行文件和本仓库根目录，先运行 `npm install`、`npm run build`。详见 [插件说明](deveco-plugin/README.md)。本机 `docs/` 中带日期的旧实验报告保留原始命令，属于历史证据。
