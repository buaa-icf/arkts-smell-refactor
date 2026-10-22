# TypeScript 后端迁移说明

迁移日期：2026-10-19。后端版本：0.2.0。

## 迁移范围

原 Python 后端已替换为 TypeScript，使用 Node.js 执行编译产物。除 `src/` 和 `tests/` 外，还新增了 npm 依赖、锁文件和 TypeScript 编译配置，更新了 README、配置示例及忽略规则。初次迁移没有修改插件；随后按用户要求适配了 `deveco-plugin/` 的 Node 连接层，Java 界面和应用事务保留。没有提交任何改动，也没有修改历史 `runs/`。

命令行主入口由 `python -m arkts_smell_refactor` 改为 `node dist/cli.js`。在仓库内用 `npm start` 启动交互模式，其他子命令用 `npm run cli -- <子命令>`。新电脑执行 `npm ci` 和 `npm run build`，无需 Python 或全局安装本项目。

## 保留的执行能力

- 标准数据集对象/数组输入、每条消息独立任务、测试类别和分析上下文元信息。
- Feature Envy、Long Method、Switch Statement、Code Clone、God Class、循环依赖分析与约束生成。
- 不含测试的 Agent 副本、生产源码/模块入口/生产资源同步、前后基线与完整 diff。
- 五层验收，附加公共契约和按风险触发的 Runtime Smoke。
- 异味、构建、契约、Linter 并行，失败取消同组剩余任务；随后测试，全部通过再 Review。
- 最多三轮定向修复、可归因失败分析、环境阻塞、每例总时限与进程树终止。
- 测试注册链、跨模块测试宿主、Local/Instrument 选择、新鲜 Hypium 报告及设备完成标记校验。
- 评审前后代码、完整传递依赖、JSONL 内嵌评审解析，以及 PASS/FAIL/BLOCKED/INCOMPLETE 区分。

保持既有 JSON 的字段和主要结果文件名，历史记录不需要转换。旧自定义配置中的 Python 启动命令不会自动迁移，应按新的配置示例修改。

## 验证证据与边界

移除旧实现之前，原 Python 的 173 项测试全部通过。固定保存了其中 12 组真实分析输出作为 TypeScript 行为对照，覆盖 Switch、Feature Envy、Clone、God Class 和循环依赖；这些是静态 JSON 样本，运行新测试不需要 Python。

初次迁移后 96 项后端测试全部通过；完成 Node 连接适配后，`npm test` 的 **124 项测试全部通过**（本机 Windows，无跳过）。除了分析对照，还验证了 CLI prepare→dry-run、真实 Node/npm 子进程启动、中文和空格路径、Agent 附件边界、测试报告新鲜度、设备完成标记、三轮 Loop、失败取消、总超时、配置/删除拒绝、生产基线和二级依赖材料。新增覆盖 Node JSONL 请求关联、直接扫描完成证据、候选隔离、冻结哈希、旧候选复检、必需/可选 Linter 策略及 Windows 命令 shim 选择。

测试中的 Agent、HomeCheck 和 Hvigor 使用受控替身，校验的是平台的命令、文件和证据处理。本次未调用真实模型，也未重新执行业务工程的设备测试，不能把上述测试理解为业务样例已重新验证。

TypeScript 版使用 `json5` 解析配置、`diff` 生成行级变化与克隆形态相似度、`cross-spawn` 调用跨平台命令；词法风险画像仍不是类型级行为等价证明。

## 清理和恢复

已移除旧后端 `src/arkts_smell_refactor/`、根 `tests/test_*.py` 和 `pyproject.toml`，清理其 `__pycache__`、测试临时目录、空工作区链接目录及 `v/` 中 131 个旧验证副本。旧后端源码和测试可从迁移前的 Git 历史恢复；临时副本和缓存可重新生成。

`runs/`、本机 `config.local.json` 和用户工作区设置保留。后续按用户要求适配了插件连接层：Java 插件启动 Node，使用原有版本 1 JSONL 协议调用 `dist/ide_bridge.js`，不再需要 Python。插件设置、候选冻结、Diff、应用和 Undo 的交互保持，详见 [Node 连接适配](../deveco-plugin/docs/node-backend-adaptation.md)。`required` / `skip` 策略保留，默认 `required`。
