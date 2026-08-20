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
| `switch-statement-check` | Switch Statement | default、return/throw、控制流顺序 |
| `code-clone-fragment-check` | Code Clone | 关联片段、UI ID、片段差异 |

## 目录结构

```text
arkts-smell-refactor/
├─ src/arkts_smell_refactor/
│  ├─ dataset.py       数据集展开与异味信息解析
│  ├─ risk.py          纯静态风险分析
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
→ HomeCheck 异味复检
→ hvigorw 编译
→ Local Test 或 Instrument Test
→ Code Linter
→ 独立 DevEco Code 评审
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

Review Agent 与 Refactor Agent 相互独立。Review Agent 可以读取已有测试代码，用测试作为验收证据，但仍禁止修改测试。

工具会自动从 PATH 查找实际安装的 `deveco`、`hvigorw`、`codelinter`，并自动定位同一工作区下的 `homecheck-extrule`。缺少工具时对应步骤记为 `BLOCKED/INCOMPLETE`，不会要求使用者临时拼接命令。

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
5. 将 `src/test`、`src/ohosTest` 调用归为测试代码；
6. 近似判断目标符号的可见性和类是否导出；
7. 识别目标范围是否读取 ArkUI 响应式字段；
8. 根据异味类型增加专项风险与约束。

示例：

```json
{
  "riskLevel": "high",
  "callers": {
    "total": 13,
    "production": 6,
    "test": 7,
    "items": []
  },
  "risks": [
    {
      "code": "TEST_REFERENCE_BREAK",
      "level": "high",
      "evidence": "测试目录中发现 7 个调用点，测试禁止修改"
    }
  ],
  "recommendedConstraints": [
    {
      "code": "KEEP_COMPATIBILITY_ENTRY",
      "instruction": "若移动或重命名实现，保留原入口并委托给新实现"
    }
  ]
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
  → 异味复检
  → 编译
  → 目标模块 Local Test
  → Code Linter（只判定本次变更行和新增文件中的缺陷）
  → 独立 DevEco Code Review Agent
```

每一步的标准输出和错误输出保存在任务目录下，例如：

```text
refactor-agent.log
smell.log
build.log
test.log
linter.log
review-agent.log
gates.json
review.json
result.json
```

外部命令退出码为 0 时，前四层门禁通常记为 `PASS`；非 0 且确认是代码问题时记为 `FAIL`；命令不存在、工作目录不存在、超时，以及签名证书、设备、ABI、路径权限等环境问题记为 `BLOCKED`。

## Review Agent 与评审 Skill

Review Agent 仍然是独立的 DevEco Code。仓库内附带了：

```text
skills/arkts-refactor-review/SKILL.md
```

该 Skill 固化了评审方法，包括：

- 必须对照 Git 基线和完整 diff；
- 必须检查所有修改文件和新增实现；
- 必须逐项核对 `risk-report.json`；
- 必须检查调用点、响应式状态、UI ID、对象身份和副作用；
- 不允许用“构建通过”或“检测器清零”代替语义评审；
- 只输出 `PASS / FAIL / UNCERTAIN` 结构化 JSON。

如果当前 DevEco Code 支持项目 Skill，可按其实际约定安装该目录。即使没有安装 Skill，生成的 `review-prompt.md` 也内嵌了相同的核心评审要求，因此流水线仍可使用。

Review Agent 命令退出码为 0 只代表命令正常结束。工具还会读取其输出 JSON：

- `verdict: PASS` → 评审通过；
- `verdict: FAIL` → 最终失败；
- `verdict: UNCERTAIN`、缺失或非法 JSON → 记为 `BLOCKED`，不能猜测通过。

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
- 六步流水线的 Dry Run 渲染。

## 已知限制与下一步

当前版本有意保留以下边界：

1. DevEco Code CLI 参数由使用者配置，尚未绑定特定版本。
2. 异味门禁需要项目提供能以退出码表达“目标异味是否消失”的包装命令。
3. 静态调用点扫描是文本级近似，后续可接入 ArkTS AST/类型分析提高精度。
4. 暂未自动返修；当前会完整保存失败证据，可在下一版把失败门禁转换成定向返修 Prompt。
5. 暂未接入 Data Clumps 和循环依赖的特殊输入格式。
6. 当前按任务顺序执行门禁，不并行运行构建和测试。

推荐下一步优先实现“HomeCheck 结果判定包装器”和“失败证据生成返修 Prompt”，再考虑批量调度和可视化报告。
