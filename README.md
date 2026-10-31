# ArkTS 代码异味重构与验证工具

`deveco-plugin/` 包含 DevEco Studio 的 Java 插件，`opencode-plugin/` 包含 DevEco Code／OpenCode 的原生终端工作台。两者均通过 Node JSONL 桥接调用本仓库 TypeScript 后端。下文命令用于后端 CLI；TUI 的配置、`/arkts` 入口、候选 Diff、确认应用及回滚流程见 [TUI 使用说明](opencode-plugin/docs/usage-and-validation.md)。

## 1. 安装和启动

需要 Node.js **20.19 或更高版本**。

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

本工具调用本机已安装的 DevEco Code（`deveco`）、Hvigor（`hvigorw`）、ohpm 和 CodeLinter（`codelinter`），这些命令按当前进程的 PATH 查找；本项目本身无需加入 PATH。`doctor` 只检查路径，不能代替 Agent 登录、SDK、签名、网络或设备的实际验证。

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

原计划保存在 Agent 工作区之外的 `baseline-test-plan.json`，包含接口身份、匹配依据及测试文件哈希；重构和每轮 Loop 后沿用，不根据改名/提取后的代码重新猜测测试。新增跨模块源码仍补充相应测试。原任务、已选测试内容或注册关系变化时记为 `TEST_PLAN_STALE`，不能复用旧证据。每轮实际计划、排除记录和覆盖缺口写入 `test-plan.json`。仅完整 SDK 原始字符串断言模板会按模板规则排除，显式指定测试任务不应用自动选择与模板排除。设备安装 ABI 不匹配记为 `BLOCKED / DEVICE_ABI_MISMATCH`，不进入代码修复 Loop；真实断言失败仍为 FAIL。

每条异味默认总执行上限 **1200 秒**，包含 Agent、门禁、修复和 Review；达到上限终止当前进程树并记录超时。每轮 Agent 内部的 `build_project` 和 `arkts_check` 合计最多两次是提示词约束，不是对 DevEco 内部工具的强制拦截。

## 5. 各层如何判断

- **异味**：当前 Node.js 调用内置包的 `scan.cjs`，只扫描当前目标和本任务修改/新增的生产文件；使用独立本轮报告。判断原符号（含 `%AM序号$外层方法` 匿名名称）及本次变更方法的异味，不能直接复用数据集旧行号去判断别的方法。扫描工具错误是 BLOCKED，实际异味残留是 FAIL。
- **构建**：在 `v/` 下的验证副本执行 Hvigor；必要时由平台先调用 ohpm。Agent 不得自行修改签名、wrapper 或依赖配置。
- **公共契约**：保存模块导出和公开成员签名，比较是否删除或不兼容变更。
- **测试**：解析 `build-profile.json5` 和 `List.test.*` 注册链；优先沿用重构前原接口关联的 suite，也能查找别的宿主模块；无法精确匹配时保守回退。每次先清除副本旧报告，必须有新生成的 Hypium 用例和完整汇总，Instrument 还要求设备完成标记。beforeAll 找不到测试宿主属于 BLOCKED，不冒充业务断言失败。
- **Linter**：仅判断本任务变更行引入/触及的诊断，不因文件里别的既有诊断判失败。提示词读取最近的项目风格配置。
- **Review**：只读取本任务的前后生产代码、diff、风险、门禁结果和传递依赖材料；不访问原项目、不读测试、不重复运行工具。UNCERTAIN/无有效 JSON 记为 BLOCKED，不能借用旧评审 PASS。

设备、签名、下载、网络、工具缺失或总超时通常不能通过修改生产代码解决，不进入代码返修。失败分析保留阶段、分类、归因证据、具体文件/位置和可否修复。

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

## 8. 开发与迁移范围

```text
src/
├─ cli.ts / automatic.ts           命令行、配置、粘贴输入和批量调度
├─ models.ts / dataset.ts          任务类型和数据集解析
├─ risk.ts / analysis/             通用风险与六类专项分析
├─ prompts.ts / linter_profile.ts  提示词和项目规则摘要
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

本次移除了旧 `src/arkts_smell_refactor/`、根 `tests/test_*.py` 和 `pyproject.toml`，清理旧 Python 缓存及临时验证副本；历史 `runs` 保留。插件界面及应用事务仍使用 Java，连接层已切换到 Node：配置 Node 可执行文件和本仓库根目录，先运行 `npm install`、`npm run build`。详见 [插件说明](deveco-plugin/README.md)。`docs/` 中带日期的旧实验报告保留原始命令，属于历史证据。
