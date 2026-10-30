# feat: 新增 DevEco Code 原生 TUI 异味重构工作台

为 DevEco Code／OpenCode 增加 `/arkts` 独立终端工作台，贯通检测或报告导入、风险分析、隔离候选生成、Diff 审阅、确认应用、应用后复检和事务回滚。

## 主要改动

- 使用 TypeScript／Solid／OpenTUI 实现专属页面、固定导航、方法及异味说明和阶段提示；支持 120×36、80×24 终端及弹窗按键隔离。
- 通过 Node JSONL 复用 main 的 TypeScript 后端，保留串行操作、UTF-8、超时及进程树取消；配置失败仍可通过 `/arkts` 查看诊断。
- 候选应用核对冻结内容和当前基线，保存逐文件事务；回滚从持久化应用历史选择目标，保留后续用户编辑并记录内容冲突及 I/O 原因。
- 保存初次检测范围到任务与候选；应用后异味列表沿用原文件、目录或报告文件集，历史恢复后仍有效，构建与测试继续使用完整工程。

## 集成说明

已合入 main 的 `a445caf`（TypeScript 后端迁移），按迁移方向删除旧 Python 桥接及测试，将范围修复移植到新后端。修正 Windows／Node 24 下的后端测试入口。根目录先执行 `npm ci && npm run build`，再安装 TUI 依赖；旧设置中的 python 字段忽略。

## 验证

- 根目录 `npm test`：148 项通过。
- `opencode-plugin` 中 `npm run check`：严格类型检查、25 项 Node 和 6 项原生 TUI 测试通过。
- 现有本地配置的 Node hello／环境检查通过，检测和重构工具均可找到。

编排、模型和 SDK 工具使用受控替身验证；本次未在用户业务工程运行模型、扫描、应用或回滚，也未重新执行真实 DevEco 宿主及 Java IDE 插件验收。安装与使用说明见 `opencode-plugin/docs/usage-and-validation.md`。
