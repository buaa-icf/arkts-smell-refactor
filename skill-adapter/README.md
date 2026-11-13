# 对话式 Skill 试验入口

Skill 版本将检测结果、风险、重构建议、候选 Diff 和执行反馈呈现在聊天中，用户通过对话选择下一步。TUI 和 Skill 共用检测、重构、验证以及应用/回滚实现，两种入口可读取同一设置和证据目录。

```text
OpenCode / DevEco 对话                    现有终端工作台
        │                                      │
skills/arkts-smell-refactor               opencode-plugin
        │                                      │
dist/skill.js ────────── src/client ─────────────┘
                             │
              JSONL bridge → src/ide_bridge.ts
                             │
         HomeCheck / 风险分析 / 隔离重构 / 验证 / 独立评审

src/client/apply.ts：双方共用的冻结候选 Diff、应用事务与回滚
```

## 安装与配置

在工具仓库根目录执行：

```powershell
npm ci
npm run build
Copy-Item .\skill-adapter\examples\settings.example.json .\skill-adapter\examples\config.local.json
```

编辑 `skill-adapter/examples/config.local.json`，填写业务工程 `projectRoot`、本工具仓库 `backend` 及工程外的 `runs` 绝对路径。配置可直接沿用现有 TUI 设置文件；两种入口共用历史时必须使用同一工程、配置与 `runs`。命令工具需要 Node.js ≥20.19，使用本仓库既有 DevEco 测试版时按根 README 使用 Node.js 22 或更高版本。

执行扫描时，`studio` 需填写包含 `sdk/default/openharmony/ets` 的 DevEco Studio 安装目录；`deveco`、`hvigor`、`ohpm`、`linter` 留空时使用现有工具发现逻辑。HomeCheck 始终来自本仓库固定 npm 包，不需要另配 HomeCheck 路径。`linterMode` 默认为 `required`，只有明确接受跳过 Linter 时才改成 `skip`。

将完整的 `skills/arkts-smell-refactor/` 目录复制到目标工程的 `.opencode/skills/arkts-smell-refactor/`。例如，在工具仓库根目录执行以下命令前，将工程路径改为自己的路径：

```powershell
$skillProject = 'D:/harmonyos/MyApplication'
New-Item -ItemType Directory -Force -Path "$skillProject/.opencode/skills" | Out-Null
Copy-Item -LiteralPath './skills/arkts-smell-refactor' -Destination "$skillProject/.opencode/skills/arkts-smell-refactor" -Recurse
```

上述是首次安装示例；已有同名 Skill 时先检查已有内容，再选择更新。无需将 Skill 添加到 TUI 插件配置。OpenCode 官方支持项目内的 `.opencode/skills/<id>/SKILL.md`，可随 Skill 放置参考资料，见 [Skills 文档](https://opencode.ai/docs/skills/)。DevEco 的发现路径与调用方式需以实际安装版本为准，不能将 OpenCode 新版配置字段直接当作 DevEco 配置。

宿主需要提供读取文件和执行命令的能力，以及对 `arkts-smell-refactor` Skill 的访问权限。复制 Skill 只提供流程说明；工具仓库、已构建的后端、DevEco 登录及工程所需 SDK/设备仍须可用。此试验不修改用户全局配置，也不自动接受产品协议。

## 试用

先直接检查入口与配置：

```powershell
node ./dist/skill.js doctor --config ./skill-adapter/examples/config.local.json
```

在已加载 Skill 的聊天中发送类似请求，并替换绝对路径：

> 使用 arkts-smell-refactor 检测 D:/harmonyos/MyApplication/entry/src/main/ets/pages/Index.ets。后端在 C:/tools/arkts-smell-refactor，设置文件是 C:/tools/arkts-smell-refactor/skill-adapter/examples/config.local.json。先展示检测结果。

接下来可以说“分析第 2 个问题”“保留公开接口，生成候选”“查看这个文件的 Diff”“应用当前候选并复检”或“回滚刚才的应用”。Skill 根据已获得的授权继续；原工程应用通过候选事务执行。

详细命令见 [CLI 参考](../skills/arkts-smell-refactor/references/cli.md)。检测/导入的规范化结果保存为 `responseFile`，后续准备使用该文件与稳定的 `issueId`；执行使用 `taskHandle`，审阅和应用使用 `candidateId`。聊天丢失后可以从 `history` 与 `restore` 恢复；无需重新输入整个检测 JSON。

## 复用范围与边界

| 能力 | 实现 |
| --- | --- |
| 对话流程、结果说明、下一步选择 | `skills/arkts-smell-refactor/SKILL.md` |
| 命令参数、跨进程结果保存、命令反馈 | `src/skill.ts` |
| 配置、JSONL 协议、路径检查、Diff、应用与回滚 | `src/client/`，TUI 保留原导入入口并转出共享实现 |
| 检测、静态风险、候选、复检、历史 | 现有 `src/ide_bridge.ts` 和 `src/ide/` |
| 重构与独立语义评审 | 现有后端调用的 DevEco Agent |

当前版本将外层交互改为 Skill，仍由后端 Agent 生成候选和评审；没有实现“当前聊天模型直接编辑隔离候选”的另一套执行器。聊天模型可以解释建议，不能用自己的口头判断替代真实门禁。内层 Agent 的工具限制保持原实现，启用外层 Skill 不需要解除内层 `skill` 限制。

后端支持四类检测异味；原 CLI 可以导入的其他分析类型不代表此插件/Skill 候选流程支持它们。`doctor` 是路径与能力检查，不证明真实登录、SDK、签名、设备或全流程已通过。`PASS` 候选、`APPLIED` 事务和应用后验证结论分别记录。后端更新、配置变化或源码变化后，旧候选可能失效，需要重新准备。

## 验收方式

在仓库根目录运行 `npm test`，验证后端与 Skill 命令；在 `opencode-plugin/` 中运行 `npm run check`，验证共享客户端提取后的 TUI 行为。Skill 结构可用 `skill-creator` 的 `quick_validate.py` 检查，结构检查不能替代实际对话验收。

真实环境试验应选一个可恢复的 Harmony 工程，记录以下结果：

1. 对指定文件检测，在聊天中展示问题；原工程生产文件未变化。
2. 选定一个问题，说明风险并生成候选，展示本轮门禁和 Diff；生成阶段原工程仍未变化。
3. 用户选择应用后，事务写入与候选一致的内容；应用后复检保留原检测范围。
4. 新聊天通过历史恢复记录，再回滚该事务；源码恢复或明确报告后续编辑冲突。
5. 环境缺失、过期基线和非 PASS 候选均提供实际错误，不误报完成或写入原工程。

上述是验收步骤，不代表已经完成真实模型、SDK、设备或宿主 Skill 加载验收。自动化测试使用受控环境时，应与真实工程试验结果分别记录。

## 本分支验证记录（2026-11-13）

- 清理本地旧测试编译产物后，`npm test`：321 项通过，包含 9 项 Skill 命令测试。Windows junction 用例需在正常权限环境运行。
- TUI 类型检查、25 项 Node 测试、6 项原生界面测试通过。沙箱下 Bun 使用显式 preload 路径 `./node_modules/@opentui/solid/scripts/preload.ts` 执行界面测试。
- Skill 结构验证与示例 JSON 检查通过。Windows 使用 `python -X utf8` 调用 Skill 验证器。
- 在隔离 Harmony 示例中使用本机 SDK 和内置 HomeCheck，实际完成 `doctor → 指定单文件扫描 → prepare`，独立试用确认范围外文件未被扫描、生产源码哈希未变。
- 应用、跨调用恢复、应用后复检衔接和回滚通过受控后端与真实文件事务测试；回滚冲突会保留用户后续修改。尚未在真实 OpenCode/DevEco 聊天宿主中验收 Skill 加载，也未重新跑真实模型生成、签名和设备上的完整重构流程。
