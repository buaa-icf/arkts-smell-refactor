# 安装、使用与验证

更新：2026-10-22。先阅读[技术设计](technical-design.md)。

## 1. 安装 TypeScript 插件依赖

在本仓库根目录打开 PowerShell：

```powershell
npm ci
npm run build
cd .\opencode-plugin
npm ci --registry=https://registry.npmjs.org
npm run check
cd ..
```

`check` 包含严格类型检查、25 项后端／事务／状态测试，以及 6 项真正调用 OpenTUI 原生渲染器的 TSX 测试（含固定导航、方法选择、阶段提示、检测范围、回滚与配置错误诊断）。Windows 沙箱可能拒绝原子替换、junction、进程树终止和 Bun 模块解析，需要在普通终端执行。

插件使用宿主的 Solid 转换器直接加载 TSX，插件目录的 `npm run build` 执行类型检查；仓库根目录的同名命令构建 TypeScript 后端。推荐 Node.js 22+（后端要求至少 20.19）；不再依赖 Python。Bun 测试运行时已包含在插件开发依赖中。`check` 的 Node 测试前会重新构建后端，单独运行 TUI 测试前也须先完成根目录构建。

## 2. 配置工程和工具

复制配置示例：

```powershell
Copy-Item .\opencode-plugin\examples\settings.example.json .\opencode-plugin\examples\settings.local.json
```

编辑 `settings.local.json`：

| 字段 | 用途 |
| --- | --- |
| `projectRoot` | 要检测和重构的 Harmony 工程／包含工程的工作区 |
| `backend` | 当前 `arkts-smell-refactor` 仓库绝对路径 |
| `node` | Node.js 可执行文件路径或 PATH 命令名，默认 `node`；旧 python 字段忽略 |
| `homecheck` | `homecheck-extrule` 根目录，含 HomeCheck 及自定义规则包 |
| `studio` | DevEco Studio 安装目录，用于 SDK 和工具发现 |
| `deveco` | 留空使用 PATH 中的 `deveco`；可指定实际可执行文件 |
| `hvigor` / `ohpm` / `linter` | 工具路径覆盖，留空交由现有后端发现 |
| `linterMode` | 默认 `required`；`skip` 是明确跳过 linter 的策略，其他门禁仍生效 |
| `runs` | 可选，证据目录。必须位于 `projectRoot` 之外，建议指定持久化目录 |
| `timeoutMs` | 单次操作超时，默认 7,200,000 ms |
| `bridgePath` | 可选，默认使用 backend 下现有 `deveco-plugin/.../ide_bridge.cjs`，加载 dist/ide_bridge.js |

设置文件是严格 JSON。Windows 路径请写成 `D:/path/to/project`，或使用双反斜杠 `D:\\path\\to\\project`；直接粘贴 `D:\path\to\project` 会造成非法转义，部分 `\t`、`\n` 还会被解释成制表符、换行。`node` 等命令字段只填写可执行文件，不附带命令参数。

编辑后可先在本仓库根目录验证设置：

```powershell
Get-Content -Raw .\opencode-plugin\examples\settings.local.json | ConvertFrom-Json | Out-Null
```

默认 runs 位于系统临时目录，系统清理临时文件后历史证据可能丢失；需要长期保存请配置工程之外的专用目录。环境、历史和候选均按 projectRoot 隔离，不依赖宿主聊天上下文。

## 3. 从 deveco 进入工作台

继续在**本仓库根目录**执行：

```powershell
$env:DEVECO_TUI_CONFIG = (Resolve-Path .\opencode-plugin\examples\tui.json).Path
deveco
```

首次使用或协议更新时，请本人完成 DevEco 的协议确认与登录。进入宿主主界面后输入：

```text
/arkts
```

也可在命令面板搜索“ArkTS 异味重构工作台”。不需要运行可执行文件的内部绝对路径。

`examples/tui.json` 的插件路径相对于该 TUI 配置文件解析；其中 `configFile` 相对于宿主工程目录解析，因此上面的命令固定从本仓库启动。在别的工程目录启动时，应在自己的 TUI 配置中把插件入口和 configFile 都写成绝对路径。业务工程仍由 settings 中的 projectRoot 指定。

例如：

```json
{
  "plugin": [[
    "C:/path/to/arkts-smell-refactor/opencode-plugin/src/tui.tsx",
    { "configFile": "C:/path/to/arkts-smell-refactor/opencode-plugin/examples/settings.local.json" }
  ]]
}
```

TUI 模块必须出现在 **TUI 配置的 plugin 列表**，不能放进 `deveco.jsonc` 的服务器 plugin 列表。OpenCode 使用 `OPENCODE_TUI_CONFIG` 指定同一份配置。取消临时指定可执行 `Remove-Item Env:DEVECO_TUI_CONFIG`。

DevEco 可能自行提示或执行升级；可在验证固定版本期间设置 `$env:DEVECO_DISABLE_AUTOUPDATE = '1'`。正常开发不强制修改用户升级策略。

## 4. 交互流程与快捷键

| 按键 | 功能 |
| --- | --- |
| `e` / `6` | 检查环境／环境标签 |
| `s` | 输入工程内目录或文件，运行异味检测 |
| `i` | 输入 JSON 报告文件路径 |
| `o` | 粘贴标准 JSON 对象或数组 |
| `j` / `k` | 切换问题，也可鼠标选择 |
| `b` | 补充业务说明；修改后需要重新准备 |
| `p` | 冻结当前工程基线，生成静态风险和约束 |
| `x` | 在隔离副本执行重构 Agent、门禁、评审和后端返修 |
| `1` / `2` / `3` / `4` / `5` / `6` | 风险／结果／Diff／日志／历史／环境标签 |
| `d` | 选择候选变更文件，查看统一 Diff |
| `t` | 重新验证尚未应用的冻结候选，不重新运行重构 Agent |
| `a` | 确认应用 PASS 候选，写入前再次检查基线与摘要 |
| `v` | 已应用候选的门禁和异味复检 |
| `h` | 刷新历史；点击带候选的记录恢复详情 |
| `r` | 从已保存的应用记录选择回滚目标，确认后恢复基线；保留之后的用户编辑并报告原因 |
| `c` | 中止当前后端操作的进程树；本地应用事务等待完成 |
| `Esc` | 关闭弹窗，或返回进入工作台前的宿主页面 |

详情区域支持方向键、PageUp / PageDown 和鼠标滚轮。宽度至少 110 列使用左右分栏；80 列使用上下布局。

六个视图入口位于固定导航栏，日志仅在正文区域滚动。左侧“检测到的异味方法”列出检测结果：方法名下方显示异味类型和文件行号。这些条目是要处理的问题，不是构建模式或样式选项。点击或按 j/k 选择后自动打开问题／风险详情，再按 p 分析风险、按 x 生成候选。

左侧边框底部的灰色提示随阶段更新：p 风险分析 → x 生成候选 → d 审阅 Diff、a 应用 → v 应用后复检。运行中、候选未通过、复检失败和回滚冲突均显示相应提示。r 独立查找当前工程的已保存应用事务，切换方法或重新启动后仍可使用；多条记录先选择，再确认候选 ID 与文件列表。

例如本次 `SearchPage.ets` 检测结果：`build` 是第 90 行的长方法（108 行，检测阈值 80 行）；`labelBaseStyle` 是第 333 行的 Feature Envy，检测器报告依恋 `CommonMethod`。可分别选择处理，候选应用之前仍需审阅风险和 Diff。

候选 PASS 只表示候选副本验证通过。应用后需要按 `v` 复检，工作台单独显示候选、应用和复检三项状态。离开页面不会停止仍在执行的任务，禁用插件或退出宿主会停止其后端子进程。

`settings.local.json` 的 projectRoot 是构建、测试和路径解析的工程上下文。异味扫描范围由 s 中输入的文件或目录决定，应用后 v 刷新的异味列表也沿用它；范围随候选保存，恢复历史后有效。导入报告使用报告目标及关联文件，旧候选缺少范围记录时回退到任务目标及关联文件。只有初次明确选择整个工程时，列表才按整个工程刷新；变更文件的异味门禁仍会检查候选改动涉及的源码。

## 5. 历史测试记录（Python 后端，迁移前）

2026-10-19 在 Windows、Node 24.18.0、Python 3.13 和 Bun 1.3.14 下运行：

| 检查 | 结果 |
| --- | --- |
| TypeScript 严格类型检查 | 通过 |
| Node 集成与边界测试 | 19/19 通过 |
| 120×36 OpenTUI 原生渲染、命令、真实报告导入、标签、弹窗隔离、退出 | 通过 |
| 80×24 同一交互流程 | 通过 |
| 真实 Python bridge hello、导入、静态风险准备、历史 | 通过；无模型调用、无业务源文件修改 |
| Windows 子进程取消与超时 | 通过；核验 Python 孙进程已停止 |
| 插件销毁时等待子进程终止 | 通过 |
| 候选应用、恢复、用户修改冲突、失效基线、篡改、junction | 通过 |
| 依赖审计 | 更新补丁后 0 个已知漏洞 |
| npm 包文件清单 | 已检查；仅源码、文档、示例，无本地配置、缓存或依赖目录 |

原生渲染测试模拟宿主 API，使用真实 OpenTUI、Solid、Keymap 和 Python 子进程，不等同于真实 DevEco 的全部生命周期验收。界面字符帧位于 `opencode-plugin/.artifacts/workbench-120x36.txt` 和 `workbench-80x24.txt`，该目录已忽略。

实际宿主验证分开记录：

| 宿主 | 已验证范围 |
| --- | --- |
| DevEco Code 0.1.8 | 可以启动并读取／应用 `DEVECO_TUI_CONFIG`；隔离配置进入协议／账号引导，未完成工作台交互验收 |
| DevEco Code 0.2.4（npm latest） | 在本仓库直接执行 `deveco`；斜杠补全显示 `/arkts`；成功进入独立工作台；按 i 导入真实 JSON；按 p 调用真实 Python bridge 冻结基线并生成风险；按 e 检查环境；按 h 查看历史；Esc 返回宿主主界面 |

0.2.4 实测使用 `.artifacts/host-smoke/project` 空白示例 Harmony 工程。生成任务 `long-method-0001-update`，静态风险为 medium，runId 为 `90967c40-4fe3-4a6e-a1df-1a0347898dac`，`session.json` 记录 `SUCCEEDED`。核对示例 `Page.ets` 仍为原始代码。此前“Checking setup”属于启动过程；正常进入主界面后插件可以加载，无需改动宿主源码。

尚未在真实业务工程上执行 HomeCheck → 模型重构 → hvigor → 测试 → 应用的整链路。本轮开发只对自动创建的示例工程做无模型验证。

## 6. 故障定位与恢复

- 配置文件解析失败：插件仍注册 `/arkts`，启动提示“配置加载失败”；输入命令可以查看设置文件路径、具体错误和 Windows 路径写法。修复后退出并重启 DevEco。
- `/arkts` 不出现：确认已完成 DevEco 首次引导、TUI 配置入口正确、依赖已经安装；修改配置后重启宿主。旧宿主缺少 API 时会报告所缺接口。
- 找不到 Node、bridge 或 dist：在设置中填写 node/backend 的路径，并在 backend 根目录运行 npm ci、npm run build；需要共享 CJS 引导文件及 dist/ide_bridge.js。
- 检测／重构缺少工具：按 `e` 查看实际路径，配置 HomeCheck、Studio 与工具覆盖；缺工具不代表“没有异味”。
- 基线变化：重新检测／导入并分析风险，不重复套用旧候选。
- 候选失败：查看阶段结论和失败原因，完整证据位于界面显示的 runDirectory。日志标签只保留最后 80,000 字符。
- 应用失败或重启中断：按 `r` 选择对应应用记录并确认，检查该记录的 `apply-transaction.json`。文件内容冲突与 I/O 错误会分别记录在 recoveryIssues；已在 IDE 恢复为原始基线的文件会跳过，不重复写入。
- TUI 操作失败：按 `4` 查看当前日志；配置 runs 根目录下的 `tui-operations.jsonl` 记录操作 ID、候选 ID、起止时间和错误，重启后仍可排查。不会记录输入的业务说明及源码正文。
- 遗留 `.apply.lock`：确认同一证据目录没有仍在运行的应用事务，再手动删除该单个锁文件；插件不会猜测另一个进程是否仍在写入。

应用采用逐文件替换和日志恢复，不是整个工程级文件系统事务。写入前后仍应避免外部编辑器同时保存相同文件。

## 7. 2026-10-21 加载问题修复

用户按安装步骤启动后，宿主已读取 `examples/tui.json`，但 `/arkts` 未出现在补全列表。实际原因是本地设置中的 Windows 路径使用未转义反斜杠，JSON 解析失败；原实现先加载配置再注册命令，导致命令也未注册。修复保留用户的全部路径，仅规范分隔符，并让设置加载失败时保留诊断入口。此前的正常配置测试没有覆盖此失败分支，本次新增非法 JSON 与设置文件缺失的回归验证。

修复后 `npm run check` 通过：19 项 Node 测试、4 项 OpenTUI 原生测试，共 23 项。正常界面测试现在通过实际 JSON 设置文件初始化；两个错误分支验证命令仍然注册、弹窗说明文件路径与修复方法。另使用用户的 `examples/tui.json` 与修复后的 `settings.local.json` 启动本机 DevEco Code 0.2.4，确认 `/arkts` 出现在补全并能打开工作台；没有执行业务工程的扫描或重构。

## 8. 2026-10-21 导航与方法列表改进

当前基线提交为 `46b3b5b`。后续界面改进把六个视图入口移出右侧详情面板，使用独立固定导航栏；详情正文限制绘制范围，日志滚动不影响导航。列表增加“检测到的异味方法”小标题、选择提示、异味类型及文件行号，选择方法后自动显示问题／风险详情。

回归验证覆盖 120×36、80×24 两种终端：160 行长日志滚动到底后，导航字符帧保持不变；方法列表显示长方法／Feature Envy；鼠标选择和 j/k 键可从日志切回所选方法详情。总计 19 项 Node 测试与 6 项 OpenTUI 原生测试。

## 9. 2026-10-21 阶段提示与回滚修复

先更新技术设计，再实现左侧底部灰色阶段提示和独立于当前方法的事务回滚。旧版切换问题会清除候选引用，r 无法找到此前已应用事务；另外旧版没有持久化 TUI 错误、把文件系统异常统一当作用户修改。本次分别修复这些可复现缺陷。用户 SearchPage.ets 的日志、摘要与结论边界见 [回滚调查](rollback-investigation-20261021.md)，由于旧版缺少回滚错误日志，无法断言当时的具体失败分支。

`npm run check` 通过 TypeScript 检查、23 项 Node 测试及 6 项 OpenTUI 原生测试（29 项）：覆盖应用→复检刷新问题→切换方法→按历史记录回滚、重启恢复、IDE 手动恢复后幂等处理、内容冲突、文件系统错误原因持久化，以及 120×36／80×24 灰色提示从分析风险到复检／恢复的变化。原生键盘 r 使用真实 Python history.list / candidate.describe 找到与当前方法无关的应用记录，经确认后恢复示例文件。本次没有再次应用或回滚用户的 BookRead 工程。

## 10. 2026-10-22 应用后列表范围修复

旧实现丢弃 scan.start 返回的 scopePath，候选没有保存原范围；共享 bridge 的 validate_applied 在门禁通过后固定执行 scan(originalRoot)。因此原本只检测 SearchPage.ets，应用后却展示整个 BookRead 的 25 条问题。修复保存 scanScope 到工作台、prepared.json、candidate.json，候选复检与历史恢复继续沿用；应用后列表按此范围实际扫描，阶段页显示检测范围并说明构建／测试按完整工程执行。

验证命令：`npm run check`（25 项 Node + 6 项 OpenTUI、严格类型检查）；仓库根目录执行 `python -X utf8 -m unittest discover -s deveco-plugin/tests -p test_bridge.py`（45 项共享 bridge 测试）。覆盖文件、目录、明确选择全工程、报告文件集、旧候选回退、范围越界拒绝、准备与冻结持久化及历史恢复。Python 门禁和检测器使用受控替身，未调用模型或修改用户 BookRead 工程；不能将该回归视为真实 HomeCheck／SDK 的完整业务联调。

## 11. 2026-10-22 TypeScript 后端集成

集成 main/a445caf 后，实际链路为 TUI → node → 共享 ide_bridge.cjs → dist/ide_bridge.js。范围修复已移植到 Node 候选与列表刷新流程，旧 Python 文件及其测试随 main 删除；上述第 5–10 节保留迁移前的历史验证记录，当前验证不再执行 Python 命令。

根目录 `npm test` 148 项通过；插件 `npm run check` 25 项 Node、6 项原生 TUI 和严格类型检查通过，总计 179 项。现有 settings.local.json 的只读 hello／环境检查返回 TypeScript 后端、Node 24.18.0、canDetect/canRefactor 均为 true。本次未重新执行真实模型、SDK／设备或 DevEco 宿主界面验收。旧 Python 候选摘要不适用于新后端的直接应用，后续任务应重新分析／生成验证；旧冻结事务仍可用于查看和回滚。见[集成记录](typescript-backend-integration.md)。
