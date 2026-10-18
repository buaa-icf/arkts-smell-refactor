# PR 标题

feat: 集成 DevEco 插件，打通 ArkTS 异味检测与重构交互流程

# PR 正文

## 变更说明

将 ArkTS Refactor 插件合入后端仓库的 `deveco-plugin/`，让用户可以在 DevEco Studio 中完成异味检测、风险分析、候选生成、验证、Diff 预览、应用及复检。候选在工程副本中执行，全部必需检查通过后才允许应用；应用时核对基线，并支持事务回滚及 IDE Undo。

`deveco-plugin/` 是独立 Gradle 工程根目录，使用 Java 21，适配 DevEco Studio DS-243。Python 后端继续位于仓库根目录的 `src/arkts_smell_refactor/`，插件随包提供 JSONL 适配器及直接调用 HomeCheck 的 Node 入口。

## 功能与集成

- 提供原生 Tool Window、Tools 菜单、文件/目录检测入口和持久化设置；支持当前文件、目录、工程四类规则检测，以及报告导入、筛选和源码定位。
- 展示实际扫描目标、进度、完成/零结果/失败状态和日志；固定 UTF-8，支持中文路径。环境页自动检查工具依赖，并提供缺失提示、刷新和设置入口。
- 接入风险报告、冻结候选、Agent 与验证流水线；展示失败原因，支持历史候选恢复、重新验证及运行摘要导出。
- 提供文件 Diff、完整候选应用、冲突检查、回滚、Undo 与应用后验证；明确区分候选验证结论和原工程应用状态。
- 通过保留完整历史的 subtree 合仓，将原插件 14 次提交纳入同一仓库；迁移测试及烟测路径，补充主仓库和插件文档入口。

## 验证

- 在新的 Gradle 根目录使用 `D:\tool\java21` 完成 `test buildPlugin verifyPluginStructure`；7 项 Java 文件事务测试通过，无跳过。
- 插件 42 项 Python 桥接测试通过，无跳过；使用父仓库后端实际执行受控流水线。
- 主仓库原有 173 项 Python 后端测试通过。
- 从新目录运行真实 JSONL / HomeCheck 烟测，扫描 1 个样例文件并检出预期的 `calculate` 过长方法；扫描前后样例源码哈希一致。
- ZIP 校验通过：仅包含插件 JAR，26 个类均为 Java 21 字节码，适配器资源与源码一致，未包含 DevEco SDK 或初始化示例类。
- 核对插件历史及源文件迁移完整性：原插件 14 次提交可追溯，原目录及暂存区未改动，已有本地文件保留。

## 验收边界

构建、单元测试和 HomeCheck 烟测覆盖本次迁移及后端桥接行为。真实 Agent 登录、Hvigor/设备测试和 DevEco 界面到应用/Undo 的完整联调仍需在目标环境验收。

## 分支

- Base：`dev_cly`
- Head：`codex/integrate-deveco-plugin`
