# ArkTS 代码异味重构增强与验证工具

这个工具以 `arkts-code-smell/dataset/positive` 中的阳性数据集 JSON 为输入，为每条异味生成：

- 统一重构任务 `task.json`；
- 不调用大模型的静态风险报告 `risk-report.json`；
- 带调用点、风险和约束的增强重构 Prompt；
- 给独立 DevEco Code Review Agent 使用的评审 Prompt；
- 可配置的“重构 Agent + 五层门禁”执行结果。

工具的目标不仅是自动化。它在重构前搜索生产代码与测试代码调用点、公开 API、ArkUI 响应式状态及异味专项风险，并把这些风险变成明确约束，从源头降低接口断裂、状态刷新失效、UI ID 改变等重构失败。

## 当前版本范围

第一版只接受阳性数据集的标准格式：

```json
[
  {
    "filePath": "applications_settings/product/phone/src/main/ets/pages/wifi.ets",
    "sourceProject": "applications_settings",
    "commitHash": "2b5f9146ba664424f2987983e4dab7e92f436fef",
    "messages": [
      {
        "line": 340,
        "column": 3,
        "severity": "SUGGESTION",
        "message": "Method 'isNeedRenderConnectedWiFi' is feature-envious toward 'WiFiMenuModel' ...",
        "rule": "@extrulesproject/feature-envy-check",
        "rangeStart": 340,
        "rangeEnd": 356
      }
    ]
  }
]
```

支持以下 HomeCheck 规则的数据集记录：

| 规则 | 异味类型 | 静态增强重点 |
| --- | --- | --- |
| `feature-envy-check` | Feature Envy | 调用点、公开接口、委托和兼容入口 |
| `long-method-check` | Long Method | ArkUI 状态、Builder、组件树、新增克隆 |
| `switch-statement-check` | Switch Statement | 按符号定位真实分支；区分值映射、分组 case、可执行 fall-through、行为策略和长 if/else 链 |
| `code-clone-fragment-check` | Code Clone | 关联片段、原入口保留、委托抽取、UI 宿主与片段差异 |

Code Clone 的专属画像默认要求保留原文件导出、类/组件/Builder 及静态入口（如 `ClassName.instance`），优先抽取内部共同逻辑。同类优先私有方法或成员 Builder，跨类优先保留各自入口并委托共享 Helper；使用共享基类/组件须确认状态所有权和生命周期不变。画像还提供生产文件中的入口线索，并明确保留独立单例、初始化时机、UI 宿主与选择器。首轮、返修及评审使用同一份策略；残留克隆不能通过删除旧入口、改名或调整检测规则消除。这些提示约束不能替代构建、测试和异味门禁。

## 目录结构

```text
arkts-smell-refactor/
├─ src/arkts_smell_refactor/
│  ├─ dataset.py       数据集展开与异味信息解析
│  ├─ risk.py          纯静态风险分析
│  ├─ analysis/        各异味独立的专项静态分析器
│  │  ├─ feature_envy.py      Feature Envy 访问画像、职责归属与提取建议
│  │  └─ switch_statement.py  Switch/长 if-else 结构画像与重构形态建议
│  ├─ prompts.py       重构与评审 Prompt 生成
│  ├─ runner.py        Agent 和五层门禁编排
│  └─ cli.py           命令行入口
├─ skills/
│  └─ arkts-refactor-review/SKILL.md
├─ tests/
├─ config.example.json
└─ pyproject.toml
```

## 环境要求

- Python 3.10 或更高版本；
- 不依赖第三方 Python 包；
- 待重构的项目已经存在于本机工作区；
- 若执行完整流水线，需要在本机安装 DevEco Code、hvigor、HomeCheck 和 Code Linter。工具会从 `PATH` 和工作区自动发现它们；特殊环境可使用高级配置覆盖。

## 安装

本项目默认不要求把 Python Scripts 目录加入 `PATH`。进入项目目录安装一次：

```text
python -m pip install --user --editable .
```

`--editable` 表示安装结果继续指向当前源码目录，修改源码后不需要重复安装。验证模块入口：

```text
python -m arkts_smell_refactor --help
```

macOS/Linux 如果命令名是 `python3`，把本页所有 `python` 换成 `python3` 即可，不需要另外配置本项目的 PATH。

首次在一台电脑上使用时，保存该电脑的默认仓库总目录：

```text
python -m arkts_smell_refactor configure --workspace "D:\ROG\Documents\harmonyos\test_supplement"
```

macOS 示例：

```text
python3 -m arkts_smell_refactor configure --workspace "$HOME/harmonyos/test_supplement"
```

以后每次直接启动：

```text
python -m arkts_smell_refactor start
```

命令行临时传入的 `--workspace` 优先级最高；其次是环境变量 `ARKTS_REFACTOR_WORKSPACE`；最后使用 `configure` 保存的本机配置。

换电脑或安装完外部工具后，建议先检查一次：

```text
python -m arkts_smell_refactor doctor
```

它会显示当前 Python、默认工作区，以及 `deveco`、`hvigorw`、`ohpm`、`codelinter` 和 HomeCheck 的实际识别路径。Windows、macOS 和 Linux 使用同一套检查逻辑：命令行工具从当前终端的 `PATH` 自动识别，HomeCheck 从工作区附近自动识别。

这里的 `-m` 不能省略：它要求 Python 查找并执行已安装的 `arkts_smell_refactor` 模块。去掉 `-m` 后，Python 会把后面的名称当作一个脚本文件路径。

## 正常使用：启动后粘贴 JSON

正常使用不需要复制配置文件，也不需要手工填写 DevEco Code、hvigor、HomeCheck 或 Code Linter 命令。完成上面的安装和一次性工作区配置后直接启动：

```text
python -m arkts_smell_refactor start
```

终端出现提示后，可以直接粘贴一条异味对象 `{...}`，也可以粘贴完整的阳性数据集数组 `[{...}, {...}]`。工具检测到 JSON 已经完整后会立即开始，不需要输入结束标记。

单条输入示例：

```json
{
  "filePath": "agc-template-market-harmonyos-demos/.../AccountCard.ets",
  "sourceProject": "agc-template-market-harmonyos-demos",
  "commitHash": "...",
  "messages": [
    {
      "line": 31,
      "message": "Method 'updateBookCoins' is feature-envious toward 'AppStorage' ...",
      "rule": "@extrulesproject/feature-envy-check",
      "rangeStart": 31,
      "rangeEnd": 39
    }
  ]
}
```

工具会自动把单条对象包装成数组。多条输入示例：

```text
请粘贴一条异味 JSON 对象或阳性数据集 JSON 数组。检测到完整 JSON 后会自动开始：
[
  {
    "filePath": "applications_settings/.../wifi.ets",
    "sourceProject": "applications_settings",
    "commitHash": "...",
    "messages": [ ... ]
  }
]
已接收 1 条异味
本地仓库根目录：D:\...\feature-envy_refactor
工具发现：deveco=已找到，hvigorw=已找到，codelinter=已找到，homecheck=已找到

[1/1] isNeedRenderConnectedWiFi
  静态风险：high；生产调用 1；测试调用 6
  重构 Agent: 开始
  重构 Agent: PASS
  smell: 开始
  smell: PASS
  build: PASS
  test: PASS
  linter: PASS
  评审 Agent: PASS
  最终结果：PASS
```

工具根据 JSON 中的 `sourceProject` 自动寻找本地仓库。默认从当前目录及其上级目录查找，同时识别 `feature-envy_refactor/<sourceProject>` 结构。如果自动定位失败，才需要显式指定工作区：

如果偶尔要覆盖默认工作区，可以运行：

```text
python -m arkts_smell_refactor start --workspace "D:\ROG\Documents\harmonyos\feature-envy_refactor"
```

`commitHash` 仅作为数据集元信息保存在任务文件中。交互模式直接重构本地仓库当前代码，不 checkout、不切换 commit、不创建 worktree。

后续步骤全部自动完成：

```text
粘贴 JSON
→ 静态风险分析
→ DevEco Code 重构
→ 并行验证：HomeCheck 异味复检、hvigorw 编译、公共契约、Code Linter
→ 按风险执行 runtime smoke
→ Local Test 或 Instrument Test
→ 独立 DevEco Code 评审
→ 失败时生成定向失败报告并最多修复 3 轮
→ 汇总 PASS / FAIL / BLOCKED
```

### Refactor Agent 看不到测试代码

平台不会把测试调用点写入 Refactor Agent 的风险报告或 Prompt。执行重构前，平台会创建仅包含生产代码的临时工作区，并物理排除：

```text
src/test/
src/ohosTest/
```

Refactor Agent 只在这个隔离工作区中修改代码。结束后平台只允许 `.ets/.ts` 的 `src/main` 生产代码同步回真实仓库；如果 Agent 尝试修改测试、依赖或构建配置，本次重构直接失败且这些越界修改不会回写。

隔离复制还会排除 Hvigor 生成的 `.test`、`coverage` 等测试缓存，避免缓存中的超长路径或临时文件导致复制失败。

Agent 在隔离区执行 Hvigor 验证时自动产生的模块级 `BuildProfile.ets` 属于临时构建产物：平台会忽略且不会回写，不能因此把正常的生产代码重构误判为越界修改。

默认重构规范是保留原方法、所属类、签名和调用关系，优先使用 Extract Method、Extract Class 或 Introduce Delegate。也就是把依恋外部对象的逻辑提取出去，由原方法委托，而不是删除/搬走原方法再批量修改调用方。

Review Agent 与 Refactor Agent 相互独立。平台只向 Review Agent 提供重构前/后生产代码快照、统一 diff、相关生产依赖、风险报告和门禁结果，并把其工作目录限制在任务目录；它不扫描原项目、调用点或测试代码，也不重复运行构建和测试。依赖材料沿相对 import/export、本地 `file:` 包和模块入口递归收集，覆盖新增委托、Mapper、Builder、Helper 的调用链，通过已处理文件集合终止循环；材料写入 `review-context-production` 和 `review-context.json`。

工具会自动从 PATH 查找实际安装的 `deveco`、`hvigorw`、`codelinter`，并自动定位同一工作区下的 `homecheck-extrule`。缺少工具时对应步骤记为 `BLOCKED/INCOMPLETE`，不会要求使用者临时拼接命令。

### HomeCheck 精确复检范围

异味门禁通过 HomeCheck 的公开文件级入口 `scan:files -- --files=...` 执行，不再用 `**/*.ets`、`**/*.ts` 扫描整个仓库。每个任务只传入：

- 阳性样本中的原异味文件；
- `refactor-changes.json` 记录的本次修改生产文件；
- 本次新增的生产文件。

数据集行号只用于重构前定位，不参与重构后的异味身份判断。结果判定检查原目标方法，以及本次实际修改或新增的方法；方法体发生修改时，即使 HomeCheck 把问题报在未改动的方法声明行，也会按当前方法范围正确归属。这样既不会把旧行号当前位置的无关方法算进来，也能发现把异味转移到新 Helper、Mapper 或委托类的情况。

ArkAnalyzer 为匿名函数生成的内部名称 `%AM<序号>$<外层方法名>` 会归属到外层方法。例如 `%AM2$initialiseUserInfoTextField` 会被视为 `initialiseUserInfoTextField` 内部的匿名函数异味。

对于包含多个独立 Harmony 工程的大仓（例如 `agc-template-market-harmonyos-demos`），工具不会在仓库总目录直接运行 hvigor。它会从目标源文件向上寻找最近的、同时包含 `hvigor/hvigor-config.json5` 与 `build-profile.json5` 的实际工程根目录，并在该目录执行构建和测试。

如果真实工程路径包含 hvigor 不支持的中文字符，平台会把当前工程同步到工具根目录下的纯英文、短路径 `v/<短哈希>`，自动安装该验证副本的 ohpm 依赖，并在副本中执行构建和测试。短路径同时规避 Windows/Hvigor 的259字符路径上限。重构结果仍回写到用户指定的真实本地仓库。

每次运行保存到：

```text
runs/YYYYMMDD-HHMMSS/
├─ input.json
├─ summary.json
└─ <task-id>/
   ├─ task.json
   ├─ risk-report.json
   ├─ refactor-prompt.md
   ├─ review-prompt.md
   ├─ 各阶段日志
   └─ result.json
```

## 高级/调试用法：只准备任务

假设工作区结构为：

```text
D:\ROG\Documents\harmonyos\feature-envy_refactor\
├─ applications_settings\
├─ agc-template-market-harmonyos-demos\
└─ arkts-code-smell\dataset\positive\local-test\feature-envy.json
```

执行：

```powershell
python -m arkts_smell_refactor prepare `
  --dataset D:\ROG\Documents\harmonyos\feature-envy_refactor\arkts-code-smell\dataset\positive\local-test\feature-envy.json `
  --workspace D:\ROG\Documents\harmonyos\feature-envy_refactor `
  --output D:\ROG\Documents\harmonyos\arkts-smell-refactor\runs\feature-envy-local
```

数据集中的每个 `message` 会展开为一个独立任务。只准备展开后的第一个异味：

```powershell
python -m arkts_smell_refactor prepare `
  --dataset D:\path\to\feature-envy.json `
  --workspace D:\path\to\workspace `
  --output .\runs\single `
  --index 1
```

输出示例：

```text
runs/feature-envy-local/
├─ index.json
└─ feature-envy-0001-isNeedRenderConnectedWiFi/
   ├─ task.json
   ├─ risk-report.json
   ├─ refactor-prompt.md
   └─ review-prompt.md
```

### `task.json`

保存数据集原始证据、工作区、项目、目标文件、目标符号和行号范围。原始 `message` 完整保存在 `raw` 中，便于追溯。

### `risk-report.json`

风险分析不调用大模型，当前会执行：

1. 从检测消息解析目标方法名；
2. 在对应 `sourceProject` 中扫描 `.ets`、`.ts` 文件；
3. 排除 `.git`、`build`、`node_modules`、`oh_modules`、`.hvigor` 和测试产物；
4. 将 `src/main` 调用归为生产代码；
5. 不读取或输出 `src/test`、`src/ohosTest` 调用点，避免向 Refactor Agent 暴露测试信息；测试契约由后续独立 Review Agent 检查；
6. 近似判断目标符号的可见性和类是否导出；
7. 识别目标范围是否读取 ArkUI 响应式字段；
8. 根据异味类型增加专项风险与约束。

对 `switch-statement-check`，风险报告还会生成 `switchStatementAnalysis`。分析器优先按检测消息中的方法名定位真实方法体，因此能处理部分 HomeCheck 数据中 `line=2/3` 这类 CFG 相对行号；随后识别：

- 目标是大型 `switch` 还是长 `if / else if` 链；
- selector、case/default 标签、分支数和检测器给出的 case 行数；
- 空 case 形成的共享标签组与包含执行语句的 fall-through；
- `return/throw/continue/await`、`this` 状态写入和嵌套条件；
- 更匹配当前结构的 `Map<K, V>`、`Set<K>`、`Map<K, Handler>` 或具名策略/方法提取。

这些证据会同时进入重构 Prompt 和独立评审 Prompt。框架不会把所有 switch 机械地改成函数 Map：纯值映射优先 `Map<K, V>`，共享标签优先 `Set`/值表，复合状态行为优先具名方法或策略；存在可执行 fall-through 时会直接标记高风险并要求保留原执行序列。

对 `feature-envy-check`，风险报告会生成 `featureEnvyAnalysis`。分析器按目标符号定位方法体，并结合检测消息生成：

- 被依恋类型与实际 receiver 候选；
- 字段/方法访问次数、写入次数和 ATFD/LDA/CPFD；
- 业务数据、SDK 对象、全局状态或服务对象等职责归属类型；
- 数据转换、集合处理、状态修改或 SDK 编排等依恋形态；
- Move Method 的可行性与依赖方向限制；
- Mapper、Builder、Adapter、Delegate 或 Move Method 等推荐重构形态；
- 本次提取必须保持的条件边界、数组累加、对象身份、异步顺序和响应式读取。

通用分析层只负责符号可见性、生产调用点、响应式状态与外部契约；Feature Envy 的委托、职责归属和提取方案由专项分析器生成。分析结果同时进入 Refactor Prompt 和 Review Prompt。

示例：

```json
{
  "riskLevel": "high",
  "callers": {"total": 2, "production": 2, "test": 0, "items": []},
  "featureEnvyAnalysis": {
    "reportedTarget": "ITransactionInfo|undefined",
    "receiver": "this.transactionInfo",
    "classification": "COLLECTION_PROCESSING",
    "readCount": 19,
    "writeCount": 0,
    "moveFeasibility": "uncertain",
    "recommendedPattern": "EXTRACT_MAPPER_OR_BUILDER",
    "recommendedDestination": "owning-model-or-dedicated-builder",
    "mustPreserve": ["数组 push 的累加语义和对象身份", "条件不满足时不执行的边界"]
  }
}
```

静态扫描采用保守的文本级分析，不是完整 ArkTS 编译器。动态注册、反射、字符串引用和跨语言调用可能无法识别，因此报告中会保留 `analysisLimitations`。

## 高级/调试用法：自定义外部命令

正常的 `python -m arkts_smell_refactor start` 不需要本节配置。只有调试单个门禁、替换工具版本或接入另一台机器的特殊命令时，才复制示例配置：

```powershell
Copy-Item .\config.example.json .\config.local.json
```

然后把 `deveco-code`、`your-smell-check-wrapper`、hvigor 参数等替换为本机真实命令。

命令既可以写成字符串数组，也可以写成字符串。推荐数组，避免路径和空格的转义问题：

```json
{
  "refactorAgent": {
    "command": ["真实的DevEco命令", "--prompt-file", "{prompt_file}"],
    "cwd": "{project_root}",
    "timeoutSeconds": 1800
  }
}
```

可使用的占位符：

| 占位符 | 含义 |
| --- | --- |
| `{task_dir}` | 当前任务输出目录 |
| `{task_file}` | `task.json` 绝对路径 |
| `{risk_file}` | `risk-report.json` 绝对路径 |
| `{prompt_file}` | 重构 Prompt 绝对路径 |
| `{review_prompt_file}` | 评审 Prompt 绝对路径 |
| `{project_root}` | `sourceProject` 根目录 |
| `{workspace_root}` | 包含多个项目的工作区根目录 |
| `{target_file}` | 目标源文件绝对路径 |

### 异味门禁的重要约定

HomeCheck 一般可能在发现异味时仍以退出码 0 结束。因此 `smell` 不能简单配置成“运行一次 HomeCheck”，而应配置成一个包装命令：

- 重新生成检测 JSON；
- 根据 `task.json` 的规则、目标文件和符号检查目标异味是否仍存在；
- 目标异味消失时返回退出码 0；
- 目标异味残留或产生禁止的新异味时返回非 0。

第一版将这个包装命令留作项目配置，因为不同仓库的 HomeCheck 启动命令和报告路径不统一。

## 高级/调试用法：Dry Run

Dry Run 不启动任何外部命令，只检查配置渲染和流水线步骤：

```powershell
python -m arkts_smell_refactor run `
  --task-dir .\runs\single\feature-envy-0001-isNeedRenderConnectedWiFi `
  --config .\config.local.json `
  --dry-run
```

生成的 `result.json` 会列出重构 Agent、四个自动门禁和 Review Agent 的实际渲染命令。

## 高级/调试用法：执行已准备的单个任务

```powershell
python -m arkts_smell_refactor run `
  --task-dir .\runs\single\feature-envy-0001-isNeedRenderConnectedWiFi `
  --config .\config.local.json
```

执行顺序：

```text
DevEco Code Refactor Agent
  → 并行：异味复检、编译、已配置的公共契约、Code Linter（required 模式）
  → runtime smoke（按风险启用）
  → 自动选择相关 Local Test / Instrument Test（必要时两者都运行）
  → 独立 DevEco Code Review Agent
```

流水线采用 fail-fast：并行组中任一门禁 FAIL/BLOCKED 时终止尚未完成的同组子进程，并跳过 runtime/test/review；已经完成的门禁保留实际结果。并行组完成后，runtime 与 test 依次执行，Review 只在本次必需门禁全部 PASS 后运行。`linterMode=skip` 时 Linter 不启动、不参与验收或返修。可归因于本次修改的失败会生成 `failure-report-N.json` 和 `repair-prompt-N.md`，交给隔离的重构 Agent 继续修复，最多修复 3 轮。每轮使用独立的 `refactor-workspace-repair-N`，从真实仓库中的上一轮代码创建；修改后重新执行本次启用的全部门禁。出现 `BLOCKED`（包括与其他门禁 FAIL 同时发生）或无法归因到本次修改的 build/test 失败时，不进入代码修复 loop。

自动运行的单条任务默认总上限为 1200 秒，覆盖风险及提示词准备、Refactor、门禁、Repair 和 Review；到达上限后终止正在执行的子进程树并记为 BLOCKED。高级配置通过 `taskTimeoutSeconds` 调整，非正值表示关闭总上限；各步骤的 `timeoutSeconds` 仍独立生效。`result.json` 记录 `durationSeconds`、`timeoutSeconds` 和 `timedOut`，自动运行的 `summary.json` 同时记录任务与批次耗时。批次耗时包含输入解析后的初始化，任务耗时从该条风险分析准备开始；外部计时若还包含源码快照、启动等步骤，应保留原口径，不能直接替换为这里的任务耗时。20 分钟是执行保护上限，不是同类 7 分钟或跨类 15 分钟的达标阈值。

HomeCheck 子进程使用任务内的 `homecheck-temp` 临时目录，避免 Windows 版 cloc 无法在系统临时目录创建文件。每次扫描保存独立报告，只接受本轮有效结果；扫描工具非零退出、报告缺失或格式错误记为 `BLOCKED`，不启动生产代码返修。只有扫描完成后仍命中目标或变更范围内异味，smell 才记为可返修的 `FAIL`。

测试门禁使用 `auto-test`：读取工程根 `build-profile.json5` 的模块映射，在各模块的 `src/test` 与 `src/ohosTest` 中查找与目标文件、克隆关联文件同名的 `Foo.test.ets/ts/js` 或 `FooTest.test.ets/ts/js`，从 `describe` 提取套件名并设置 `scope`。测试可以位于其他宿主模块（例如 `phone` 模块测试 `order` 模块的页面）。同一目标两类测试都有时均运行；目标无法匹配、套件名无法静态确定或新增变更模块没有对应目标时，回退到该模块全部现有测试类型。该匹配是命名约定，不代表已证明方法覆盖率；不使用数据集目录名或 UI 装饰器猜测测试类型。

数据集目录和显式 `testKind` 保留为任务元信息，不控制自动测试选择；交互粘贴不要求同一工作区下存在数据集目录。Code Clone 可以没有 `target.symbol`，仍按目标文件及关联片段选择套件。

选择候选文件前，从各测试类型的 `List.test.ets/ts/js` 沿静态 import/export 检查可达性，排除未接入入口的遗留测试文件，也不将其加入模块回退的预期套件。例如 Local 目录留有 `RecommendBar.test.ets`，但入口只注册了 LocalUnit，而 Instrument 入口接入了 RecommendBar，则选择目标 Instrument。支持入口别名、间接注册与重导出；没有标准入口、存在动态加载或无法解析的相对依赖时保守保留候选，不静默免除某类测试。静态可达不保证运行时确实注册，实际套件与用例证据仍必须通过下面的检查。

Local Test 使用 `test -p module=<模块名>`，Instrument Test 使用 `onDeviceTest -p module=<模块名>@ohosTest`，均开启 coverage。设备测试需要已连接设备和可用签名。每个子任务运行前清除验证副本中的旧结果，运行后必须同时满足 Hvigor 成功退出、产生新的 Hypium 结果、实际执行非零用例且无失败，以及预期套件确实执行。Instrument 还要求本轮 `coverage.log` 同时包含 `OHOS_REPORT_RESULT:` 和 `TestFinished-ResultCode: 0`。仅构建/签名成功、零用例、缺失结果或缺失预期套件不会 PASS；环境或证据不足记为 BLOCKED。所有用例在 beforeAll 因找不到宿主组件而中断时也记为 BLOCKED；断言阶段找不到组件仍是 FAIL。子任务仍遵循 fail-fast。

`test-plan.json` 保存选择依据；`test-results.json` 保存最新汇总；`test-attempts/<时间戳>/` 保留各轮每个子任务的命令、耗时、日志和原始测试结果。以前只执行 Local Test 的实验需按新门禁重新计时，不能直接沿用为完整测试验收指标。高级配置直接执行外部测试命令时，应自行提供等价的结果校验。

测试验收以本次选中套件的全部实际用例为准；模块回退时验收该模块实际运行的全部套件，不按方法名排除失败。返修归因只读取最新一轮失败子任务的报告：目标命名套件、指向变更生产文件的失败栈等可作为归因证据；通过子任务的编译日志、历史报告和无关失败不能单独触发生产代码返修。同一轮混有无法归因的失败时停止返修。只有编译失败、尚无用例结果时，使用本轮失败子任务的编译诊断。

若验收不要求 Linter，可显式跳过，避免纯格式/命名问题触发修复循环：

```powershell
python -m arkts_smell_refactor start --workspace D:\arktsProgram --linter-mode skip
```

通用 CLI 默认为 `--linter-mode required`；高级 `run --config` 用配置顶层 `"linterMode": "skip"` 表达相同策略。仅删除 Linter 配置或设置 `enabled: false` 不构成豁免，默认仍判 INCOMPLETE。跳过时不执行 Linter、不触发其返修，`gates.json` 和 `result.json` 保存 `validationPolicy.linterMode` 与 `linter: SKIPPED`；构建、测试、异味、已配置的契约/runtime 门禁和语义评审仍需通过。新批次需注明该策略，与历史完整门禁结果分别报告。

required 模式会把目标 ArkTS 项目 `code-linter.json5` 中明确配置的命名、可见性、分号、尾逗号、引号等风格规则摘录到首轮和返修 Prompt。摘要与自动门禁共用配置定位逻辑，保留文件范围、原始选项、关闭项和例外；不执行配置中的文本。`ruleSet` 的继承规则及未写出的默认选项尚未展开，因此摘要不能代替实际 Linter，也不保证消除全部返修。skip 模式不读取或注入此摘要。恢复 Linter 的实际耗时收益需重新实验确认。

对于包含普通构造和 `getContext/resourceManager` 风险的 God Class，框架会按风险自动生成公开 runtime smoke。它只检查目标类是否能构造、一个保守选择的无参读取入口是否立即抛错，并用重构前生产基线运行同一检查。该 gate 启用时位于 build 与项目 test 之间；未触发风险时不改变原四层门禁。详细设计和 `analysisContext` 格式见 [`docs/risk-aware-architecture-refactoring.md`](docs/risk-aware-architecture-refactoring.md)。

框架同时冻结模块导出和目标类公共成员的词法契约。build 之后会检查旧导出/公共成员是否被删除，以及静态性、参数和类型签名是否变化；新增公共成员不会失败。复杂别名与动态 re-export 仍作为已知限制记录。

Refactor/Repair Agent 的内部验证只允许使用 DevEco Code 的 `build_project` 与 `arkts_check`，两者每轮合计不超过 2 次：完成编辑后选择一种必要验证，首次通过即停止；只有确认是本轮修改导致的编译或静态检查缺陷，才允许修复后追加一次验证。任一次遇到 SDK、wrapper、证书、签名、依赖下载或网络环境错误都停止内部验证。第二次后交由平台 loop 管理，完整门禁仍由平台统一执行。

提示词要求优先批量读取目标、已知实例和静态画像列出的相关片段，不重复探索已确认的信息，信息足够后即开始编辑；画像缺失、未解析或与源码不符时，可在隔离工程内定向补齐直接依赖。修复轮优先读取失败文件及已修改/新增文件，按当前源码处理行号漂移。没有读取次数硬上限，也不允许从原仓库或历史快照搜索、复制实现。全部实例编辑完成后再验证，并保留行为等价约束。

执行层会把附件中的仓库相对、工作区相对和绝对源码路径转换为实际隔离 Harmony 工程的相对路径，避免大仓内多工程目录前缀导致首次读取失败。风险分析的源码枚举在进入目录前排除既有依赖/构建缓存忽略项，避免递归遍历无效子树；有效源码与调用点扫描范围保持不变。

提示词预置 `@Param`/`@Require`、组件输入和显式导出的常见缺陷，同时要求沿用局部命名/格式约定、保留 `ForEach` 键值语义，减少可避免的返修。目标是提升同类修改 ≤7 分钟、跨类修改 ≤15 分钟的端到端达标率（含修复与全部门禁），设计、基线和待验证项见 [`docs/agent-time-cost-optimization.md`](docs/agent-time-cost-optimization.md)。这些约束由提示词表达，不是工具调用层的强制计数或访问控制。

内部验证不能通过创建 wrapper、锁文件或修改 `local.properties` 绕过环境错误。同步回真实仓库时，平台会丢弃内部验证产生的 `local.properties`、Hvigor wrapper、`package-lock.json` 和 `pnpm-lock.yaml`；真实的业务配置、资源或依赖修改仍会拒绝整轮同步。

修复 Prompt 直接附带 build/test 失败日志尾部（最多 12000 字符）、本次修改文件，以及结构化问题中的文件、行列和修复要求，隔离 Agent 无需访问工作区外的日志。抽取辅助方法时要求核对调用处的真实可选类型与上下文；例如保留 `string | undefined` 参数或调整 `Date` 调用的抽取边界，避免用新增默认值或提前返回改变行为。修复成功后重新执行全部门禁，以最终一轮结果判定 PASS。

当前 DevEco Code CLI 没有提供本工具可用的“仅允许工作目录”无人值守权限参数，因此 Refactor/Repair Agent 的工作区隔离属于复制隔离和回写白名单，不是操作系统级沙箱。提示词已禁止工作区外操作，平台也只会回写白名单生产源码，但无法自动撤销 Agent 对工作区外文件已经发生的修改；应使用专用系统账户或受限执行环境运行不受信任的模型。

所有异味统一允许回写工程内的生产 ArkTS 源码、模块 `Index.ets` 和模块 `src/main/resources/**`。生产资源是通用重构内容，不作为风险报告中的专项权限。该边界不会放开测试、AppScope、构建配置、依赖配置、签名文件或工程外路径。资源变更在 `refactor-changes.json` 中与源码分开记录，并保存大小、变更类型和 SHA-256。

同步采用事务式变更清单：平台先扫描并分类整轮修改，存在未授权文件时不回写任何文件，也不更新正式的 `changedProductionFiles`；候选修改和拒绝原因单独写入 `agent-change-attempt-*.json`。Refactor/Repair Agent 自身失败也会生成失败报告，区分 `MODIFICATION_BOUNDARY_VIOLATION`、`NO_ALLOWED_PRODUCTION_CHANGE` 和一般执行失败。可重新规划的边界失败会把拒绝文件和平台边界交给下一轮，而不是再次使用旧的 smell 报告。

证书校验、SSL/TLS、鉴权、网络不可达、签名和设备缺失属于 `BLOCKED`，不会进入代码修复 loop。Instrument Test 的目标用例如果全部在 `beforeAll` 阶段因测试宿主组件找不到而报错，也记为 `TEST_HOST_UNAVAILABLE` / `BLOCKED`：用例已被选中，但尚未执行目标逻辑，需要检查测试宿主的启动与页面配置，不能让修复 Agent 猜测性修改生产代码。其他测试失败只有在日志明确指向本次修改文件、对应的类型名或目标符号时才进入 loop；否则标记为 `UNATTRIBUTED_TEST_FAILURE`，最终测试门禁仍为 FAIL。

自动配置按完整 SSL/TLS 标记及明确的签名失败信息识别环境阻塞，避免把 `ProcessLibs`、成功的 `SignHap` 或类型诊断中的 `signature` 误分类。`result.json` 的阻塞步骤 `reason` 会记录正则实际命中的文本。ArkTS 类型错误保持 `FAIL`，可归因于本次修改时进入修复 loop；例如抽取方法后将 `string | undefined` 传给严格的 `string` 或 `Date` 参数。

每一步的标准输出和错误输出保存在任务目录下，例如：

```text
refactor-agent.log
smell.log
build.log
test.log
linter.log
review-agent.log
failure-report-1.json
repair-prompt-1.md
repair-agent-1.log
runtime-smoke-plan.json
runtime-smoke-generated/
runtime-smoke-results.json
public-contract-before.json
public-contract-results.json
review-diff.patch
current-production/
review-context-production/
review-context.json
gates.json
review.json
review-repair-1.json
linter-after.json
result.json
```

外部命令退出码为 0 时，前四层门禁通常记为 `PASS`；非 0 且确认是代码问题时记为 `FAIL`；命令不存在、工作目录不存在、超时，以及签名证书、设备、ABI、路径权限等环境问题记为 `BLOCKED`。

## Review Agent 与评审 Skill

Review Agent 仍然是独立的 DevEco Code。仓库内附带了：

```text
skills/arkts-refactor-review/SKILL.md
```

该 Skill 固化了评审方法，包括：

- 必须对照平台保存的本地基线和完整 diff；
- 必须检查所有修改文件和新增实现；
- 必须逐项核对 `risk-report.json`；
- 必须检查语义异味、响应式状态、UI ID、对象身份和副作用；
- 禁止扫描原项目、测试代码或重复执行前四层工具；
- 不允许用“构建通过”或“检测器清零”代替语义评审；
- 只输出 `PASS / FAIL / UNCERTAIN` 结构化 JSON。

如果当前 DevEco Code 支持项目 Skill，可按其实际约定安装该目录。即使没有安装 Skill，生成的 `review-prompt.md` 也内嵌了相同的核心评审要求，因此流水线仍可使用。

Review Agent 命令退出码为 0 只代表命令正常结束。工具还会读取其输出 JSON：

- `verdict: PASS` → 评审通过；
- `verdict: FAIL` → 最终失败；
- `verdict: UNCERTAIN`、缺失或非法 JSON → 记为 `BLOCKED`，不能猜测通过。

支持多行 JSON 和 DevEco JSONL 文本事件。Refactor、Repair 和 Review Agent 使用相同的证书、网络、鉴权及服务不可用识别规则；JSONL 模式只从真实错误事件和非 JSON 进程诊断中识别环境阻塞，不扫描 Agent 正常文本或工具读取结果，避免源码中的错误关键字触发误判。Review 报 `unknown certificate verification error` 等已识别工具故障时，自动配置默认间隔 2 秒重试，最多额外重试 2 次；恢复后继续解析评审结论，可最终达到 PASS。仍失败时保留 BLOCKED 和前四层的 PASS，不启动代码修复或消耗修复轮数。命令缺失、超时、UNCERTAIN 和语义 FAIL 不触发环境重试。

可在 `reviewAgent` 配置中设置 `maxEnvironmentRetries`（自定义配置默认 0）和 `retryDelaySeconds`（上限 60 秒）。`result.json` 的 `reviewRetries` 记录实际重试次数，每次重试保留独立的 `review-agent-retry-N.log` 与 `review-retry-N.json`；代码修复后的评审文件还带有 `-repair-N` 标记。

## 最终状态

`result.json` 的 `verdict` 取值：

| 状态 | 含义 |
| --- | --- |
| `PASS` | 重构 Agent、四个自动门禁和 Review Agent 全部通过 |
| `FAIL` | 至少一个门禁或 Review Agent 明确失败 |
| `BLOCKED` | 环境、超时、命令不可用或评审证据不足 |
| `INCOMPLETE` | 某些步骤未配置或被跳过 |
| `DRY_RUN` | 只渲染命令，没有执行 |

签名、设备、ABI 或工具链问题应表现为 `BLOCKED`，不要与代码重构失败混为一类。

## 运行测试

无需安装第三方测试框架：

```powershell
$env:PYTHONPATH = "$PWD\src"
python -m unittest discover -s tests -v
```

测试覆盖：

- 一条记录多个 `message` 的任务展开；
- 特殊 Data Clumps 格式的明确拒绝；
- 生产代码和测试代码调用点分类；
- 测试调用导致的兼容入口约束；
- Switch 的符号级定位、值映射建议、分组 case、可执行 fall-through、状态写入和长 if/else 链分析；
- 六步流水线的 Dry Run 渲染。

## 已知限制与下一步

当前版本有意保留以下边界：

1. DevEco Code CLI 参数由使用者配置，尚未绑定特定版本。
2. 异味门禁需要项目提供能以退出码表达“目标异味是否消失”的包装命令。
3. 静态调用点与条件分支分析是文本/词法级近似，后续可接入 ArkTS AST/类型分析提高符号、类型和闭包捕获精度。
4. 自动返修最多 3 轮；当前 build/test 归因依据错误日志是否命中本次修改文件或目标符号，复杂跨模块错误仍可能被保守判为不可返修。
5. 暂未接入 Data Clumps 和循环依赖的特殊输入格式。
6. 异味、编译、公共契约和 Linter 可并行；build 与 test 仍保持串行并复用验证工作区，避免 Hvigor 缓存、构建产物和设备竞争。

后续可进一步用 ArkTS 编译诊断结构化输出增强 build/test 的失败归因，再考虑批量调度和可视化报告。
