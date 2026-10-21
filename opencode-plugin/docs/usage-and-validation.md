# 安装、使用与验证

更新：2026-10-21。先阅读[技术设计](technical-design.md)。

## 1. 安装 TypeScript 插件依赖

在本仓库根目录打开 PowerShell：

```powershell
cd .\opencode-plugin
npm ci --registry=https://registry.npmjs.org
npm run check
cd ..
```

`check` 包含严格类型检查、19 项后端／事务／状态测试，以及 4 项真正调用 OpenTUI 原生渲染器的 TSX 测试（含配置错误诊断）。Windows 沙箱可能拒绝原子替换、junction、进程树终止和 Bun 模块解析，需要在普通终端执行。

插件使用宿主的 Solid 转换器直接加载 TSX，`npm run build` 执行类型检查；不需要把 TSX 转成 React JavaScript。Node.js 22+ 用于依赖和测试，Python 3.10+ 用于后端；Bun 测试运行时已包含在开发依赖中。

## 2. 配置工程和工具

复制配置示例：

```powershell
Copy-Item .\opencode-plugin\examples\settings.example.json .\opencode-plugin\examples\settings.local.json
```

编辑 `settings.local.json`：

| 字段 | 用途 |
| --- | --- |
| `projectRoot` | 要检测和重构的 Harmony 工程／包含工程的工作区，不是 Python 工程 |
| `backend` | 当前 `arkts-smell-refactor` 仓库绝对路径 |
| `python` | Python 可执行文件路径或 PATH 命令名；macOS/Linux 常用 `python3` |
| `homecheck` | `homecheck-extrule` 根目录，含 HomeCheck 及自定义规则包 |
| `studio` | DevEco Studio 安装目录，用于 SDK 和工具发现 |
| `node` | Node 可执行文件路径或 `node` |
| `deveco` | 留空使用 PATH 中的 `deveco`；可指定实际可执行文件 |
| `hvigor` / `ohpm` / `linter` | 工具路径覆盖，留空交由现有后端发现 |
| `linterMode` | 默认 `required`；`skip` 是明确跳过 linter 的策略，其他门禁仍生效 |
| `runs` | 可选，证据目录。必须位于 `projectRoot` 之外，建议指定持久化目录 |
| `timeoutMs` | 单次操作超时，默认 7,200,000 ms |
| `bridgePath` | 可选，默认使用 backend 下现有 `deveco-plugin/.../ide_bridge.py` |

设置文件是严格 JSON。Windows 路径请写成 `D:/path/to/project`，或使用双反斜杠 `D:\\path\\to\\project`；直接粘贴 `D:\path\to\project` 会造成非法转义，部分 `\t`、`\n` 还会被解释成制表符、换行。`python` 等命令字段只填写可执行文件，不附带命令参数。

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
| `r` | 确认恢复应用前内容，保留之后的用户编辑并报告冲突 |
| `c` | 中止当前后端操作的进程树；本地应用事务等待完成 |
| `Esc` | 关闭弹窗，或返回进入工作台前的宿主页面 |

详情区域支持方向键、PageUp / PageDown 和鼠标滚轮。宽度至少 110 列使用左右分栏；80 列使用上下布局。

候选 PASS 只表示候选副本验证通过。应用后需要按 `v` 复检，工作台单独显示候选、应用和复检三项状态。离开页面不会停止仍在执行的任务，禁用插件或退出宿主会停止其后端子进程。

## 5. 测试记录

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
- 找不到 Python 或 bridge：在设置中填写 python/backend 的绝对路径；backend 必须包含本仓库现有 bridge 和 Python src。
- 检测／重构缺少工具：按 `e` 查看实际路径，配置 HomeCheck、Studio 与工具覆盖；缺工具不代表“没有异味”。
- 基线变化：重新检测／导入并分析风险，不重复套用旧候选。
- 候选失败：查看阶段结论和失败原因，完整证据位于界面显示的 runDirectory。日志标签只保留最后 80,000 字符。
- 应用失败或重启中断：从历史打开对应候选，检查 `apply-transaction.json`，按 `r` 恢复。后续用户修改会留下 CONFLICT，需要人工处理。
- 遗留 `.apply.lock`：确认同一证据目录没有仍在运行的应用事务，再手动删除该单个锁文件；插件不会猜测另一个进程是否仍在写入。

应用采用逐文件替换和日志恢复，不是整个工程级文件系统事务。写入前后仍应避免外部编辑器同时保存相同文件。

## 7. 2026-10-21 加载问题修复

用户按安装步骤启动后，宿主已读取 `examples/tui.json`，但 `/arkts` 未出现在补全列表。实际原因是本地设置中的 Windows 路径使用未转义反斜杠，JSON 解析失败；原实现先加载配置再注册命令，导致命令也未注册。修复保留用户的全部路径，仅规范分隔符，并让设置加载失败时保留诊断入口。此前的正常配置测试没有覆盖此失败分支，本次新增非法 JSON 与设置文件缺失的回归验证。

修复后 `npm run check` 通过：19 项 Node 测试、4 项 OpenTUI 原生测试，共 23 项。正常界面测试现在通过实际 JSON 设置文件初始化；两个错误分支验证命令仍然注册、弹窗说明文件路径与修复方法。另使用用户的 `examples/tui.json` 与修复后的 `settings.local.json` 启动本机 DevEco Code 0.2.4，确认 `/arkts` 出现在补全并能打开工作台；没有执行业务工程的扫描或重构。
