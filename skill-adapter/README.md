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

## DevEco Code 便捷安装

终端版 DevEco Code 从工程的 `.deveco/skills/<name>/SKILL.md` 发现技能，重启后在 `/skills` 中查看。用户级位置为 `~/.config/deveco/skills/`；本脚本使用项目级安装，以便每个工程绑定自己的配置。依据 [华为官方常用配置文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-deveco-code-common-configure/)。

在工具仓库根目录执行，替换工程和 DevEco Studio 路径：

```powershell
npm ci
npm run build
npm run skill:install -- --project "D:/harmonyos/MyApplication" --studio "D:/tool/DevEco/DevEco Studio"
```

也可直接沿用现有 TUI 设置，脚本从配置中读取工程路径：

```powershell
npm run skill:install -- --config "./opencode-plugin/examples/settings.local.json"
```

脚本复制 Skill 及参考资料，生成 `installation.json` 绑定和 `scripts/run.mjs` 启动入口。未指定 `--config` 时生成该工程的 `settings.json`，记录当前工具仓库、Node、SDK 和工程外的证据目录。`--studio` 省略时尝试 `DEVECO_HOME`；`--runs` 可显式指定持久化证据目录。已有配置会被直接引用，且必须使用绝对目录路径；脚本不会改写它。

两种入口共用历史时使用同一设置和 `runs`。命令工具要求 Node.js ≥20.19，使用既有 DevEco 测试版时按根 README 使用 Node.js 22 或更高版本。扫描需要 `studio` 下的 `sdk/default/openharmony/ets`；HomeCheck 来自本仓库固定 npm 包。默认 `linterMode: required`，工具路径可在生成的设置中调整。

先预览，或更新已有安装：

```powershell
npm run skill:install -- --project "D:/harmonyos/MyApplication" --dry-run
npm run skill:install -- --project "D:/harmonyos/MyApplication" --studio "D:/tool/DevEco/DevEco Studio" --force
```

`--dry-run` 不写文件。已有同名目录时默认拒绝覆盖；`--force` 先把旧目录完整备份到工程的 `.deveco/arkts-skill-backups/`，返回具体备份路径，再安装新版本。重新生成设置时沿用需要的 SDK、证据目录参数；旧设置可从备份取回。脚本不改 `deveco.jsonc`、工具权限、协议或登录，也不安装 npm 依赖。需要更新绑定时重新运行安装命令。

安装后退出 DevEco Code，从业务工程目录重新运行 `deveco`，输入 `/skills` 查看 `arkts-smell-refactor`。本机版本还支持只读检查 `deveco debug skill`。若不可见，检查 `SKILL.md` 文件名和 `permission.skill`、Agent 的 `tools.skill` 设置；无需打开全局自动允许权限。

若使用 IDE 内的 DevEco Code 插件，官方另提供 **File → Settings → AI → Skills** 导入目录或 ZIP 的界面；可导入脚本生成的完整 Skill 目录。该界面流程与终端版的项目目录扫描不同，见 [官方插件 Skill 文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-deveco-code-plugin-skill)。OpenCode 的项目目录是 `.opencode/skills/`，手工安装时使用完整源 Skill 目录并提供后端和设置路径，见 [OpenCode 文档](https://opencode.ai/docs/skills/)。

## 试用

在业务工程目录先检查已安装入口：

```powershell
node ./.deveco/skills/arkts-smell-refactor/scripts/run.mjs doctor
```

在已加载 Skill 的聊天中发送：

> 使用 arkts-smell-refactor 检测 entry/src/main/ets/pages/Index.ets，先展示检测结果和重构建议。

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
- 应用、跨调用恢复、应用后复检衔接和回滚通过受控后端与真实文件事务测试；回滚冲突会保留用户后续修改。未重新跑真实模型生成、签名和设备上的完整重构流程。
- DevEco 安装阶段：在隔离示例工程运行安装脚本后，本机 DevEco Code `0.2.5` 的 `deveco --pure debug skill` 确认发现该 Skill；安装后的 `scripts/run.mjs doctor` 返回 `canDetect/canRefactor: true`。这证明发现与命令绑定可用，尚不等于模型在聊天中完整遵循 Skill 的端到端验收。
- 安装器新增 5 项回归，覆盖中文空格路径、跨目录调用、现有配置不变、预览零写入、备份更新与失败恢复、路径链接拒绝；最终 `npm test` 共 326 项通过，无跳过。启动入口直接调用已构建的 `runSkill`，复用现有取消和事务处理。
