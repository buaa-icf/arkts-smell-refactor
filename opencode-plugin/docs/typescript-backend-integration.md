# 集成 main 的 TypeScript 后端（2026-10-22）

## 集成范围

源分支 `feat/opencode-tui-plugin` 已提交范围修复 `8cb14ec`；获取远端后，main 从 `a60e2a9` 前进到 `a445caf`（`feat:代码更改为ts语言`）。在 `codex/integrate-opencode-tui-main` 合并该提交，保留 TUI、应用事务和回滚功能，使用远端 TypeScript 后端。

Git 冲突为两处 modify/delete：旧 `ide_bridge.py` 和 Python bridge 测试。按远端迁移方向删除旧文件，把 scanScope 的校验、准备／冻结持久化、历史兼容及应用后范围刷新移植到 `src/ide/` 和 `src/ide_bridge.ts`，以 Node 回归测试代替已删除的 Python 测试。

## 实现计划

- TUI BridgeClient 通过设置中的 node 启动 `deveco-plugin/src/main/resources/bridge/ide_bridge.cjs`，由该入口加载 backend/dist/ide_bridge.js。JSONL 关联、UTF-8、超时和进程树中止沿用原协议。
- 设置示例与默认值移除 python，Node 默认为 `node`；旧本地 JSON 的 python 字段不再使用，其余路径保留。运行前先在后端根目录安装依赖并构建，再安装 TUI 依赖。
- scanScope 随 prepared/candidate 保存；应用后范围刷新采用保存的文件、目录、规则或报告文件集，旧记录回退任务目标和关联片段，不扩大为整个工程。工程门禁仍使用完整副本。
- 根 Node 测试覆盖元数据持久化、冻结候选复检及应用后真实 scan 入口；TUI 测试以真实 Node bridge 验证导入、准备、历史、取消与恢复。模型、SDK 和设备只做受控替身验证，不改动 BookRead。
- 原 Python 后端候选的工具／后端摘要与 Node 不同，不能继续宣称旧 PASS 可直接应用；记录可用于查看和基于冻结内容回滚，后续执行应重新分析／生成验证。

完成后记录实际验证命令、结果和 PR 文案。原功能分支保留，集成分支不自动推送或创建远端 PR。

## 实现及验证结果

- 两处 modify/delete 冲突按 main 的删除结果解决。扫描范围修复移植到 `src/ide/scan_scope.ts`、`src/ide/candidates.ts` 和 `src/ide_bridge.ts`，未恢复 Python 后端。
- TUI 设置、子进程调用、环境页、测试替身及示例全部改用 Node；旧 JSON 中的 python 字段忽略，不修改用户本地路径。
- 修复 main 的测试入口在本机 Node 24 下将测试目录当成模块路径的问题，改用 `dist-tests/tests/*.test.js` 明确匹配编译后的测试文件。
- Windows / Node 24.18.0：根 `npm test` 148 项通过；`opencode-plugin` 的 `npm run check` 完成严格类型检查、25 项 Node 及 6 项 OpenTUI 测试，总计 179 项通过。
- 使用现有 settings.local.json 只读调用 session.hello / environment.inspect，返回 backendLanguage=typescript、nodeVersion=24.18.0、canDetect=true、canRefactor=true，没有缺失工具；该检查不等于真实模型或 SDK 门禁执行。
- 覆盖文件、目录、全工程、报告文件集及旧任务文件范围回退；异味扫描实际文件列表与 project.json/checkFiles 对照；候选复检保留范围；工程门禁保留完整副本。

本次不运行真实模型、设备或用户 BookRead 的扫描／应用／回滚，不宣称重新完成 DevEco 宿主或 Java IDE 插件验收。此前真实宿主 0.2.4 验证记录仍为历史范围。PR 文案见 [pr-description.md](pr-description.md)。
