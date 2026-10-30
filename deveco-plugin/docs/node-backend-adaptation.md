# Node 后端连接适配（0.2.0）

## 改了什么

界面、候选 Diff、用户确认应用、文件事务和 Undo 仍是原 Java 插件。`NodeBridgeClient` 替代 `PythonBridgeClient`，每次操作启动一个 Node 子进程，向 stdin 写一个版本 1 JSON 请求，从 stdout 读取 JSONL 日志、阶段事件及带相同 requestId 的响应。

启动链路：Java → 插件内 `bridge/ide_bridge.cjs` → 设置中后端的 `dist/ide_bridge.js` → TypeScript 风险分析和流水线。HomeCheck 继续由随插件发布的 `homecheck_scan.cjs` 直接调用，不依赖 CLOC 或性能统计脚本。取消会终止 worker 与工具子进程树。

## 接口保持

方法保留：`session.hello`、`environment.inspect`、`issues.import`、`scan.start`、`task.prepare`、`task.execute`、`task.validateCandidate`、`task.validateApplied`、`candidate.restore/check/describe`、`history.list`。事件保留 `run.started`、`workflow.changed`、`step.updated`、`scan.started`、`log.appended`。Java 数据模型无需更换协议。

`session.hello` 增加 `backendLanguage: typescript` 和 `nodeVersion`。设置中的旧 `python` 字段不再使用，旧持久化设置中的该值不会影响候选配置摘要。Node、后端、工具或策略变化会使已有候选的应用校验失效，必须重新验证。

## 原工程保护

prepare 保存完整非缓存工程基线；execute 在独立 staging 工程中运行后端。freeze 保存允许的生产源码/资源前后内容及 SHA-256，拒绝删除、测试与配置修改。应用前再次比较原工程、工具配置、候选清单和内容哈希；工程路径越界、符号链接/junction 越界、重复候选路径都会被拒绝。

重新验证冻结候选只运行门禁和评审，无重构或修复 Agent；已应用验证运行门禁，复用源码、依赖和工具策略完全一致的候选评审。工程副本不是操作系统沙箱，工具与 Agent 的系统权限没有因此被扩大或隔离。

## 验证策略

默认 Linter 必须执行。已有显式 `skip` 模式按用户决定保留，不会自动启用。五层门禁、契约、按风险触发的 runtime、三轮 Loop、单样例 20 分钟总时限由统一 TypeScript runner 执行。

扫描不仅检查退出码，还校验本轮摘要成功、选中规则全部加载、检测完成标记、实际文件数和本轮报告；工具失败不能变成“零异味”。

根 `npm test` 包含旧 Python 分析结果固定对照、受控工具编排与桥接回归。插件 Gradle 测试覆盖字节保持的应用/Undo 事务。真实 IDE 安装、登录模型、签名和设备上的业务实验需要独立验收，不能用受控测试或 ZIP 构建代替。

## 本次验证结果（2026-10-19）

- `npm test`：124 项通过，无失败、无跳过。
- 独立 `verification` Gradle 工程：7 项 Java 文件事务测试通过。
- Java 21 `javac --release 21 -proc:none`，使用本机 DevEco Studio `lib/*` 编译：通过。
- 安装包 `build/distributions/deveco_plugin-0.2.0.zip` 已生成；对包中同一目录执行 Gradle `verifyPluginStructure`：通过。

本机完整 `test buildPlugin verifyPluginStructure` 在 Gradle 对整个 Studio 安装目录生成指纹时长期无进展，已停止该次构建。因此本次安装包由上述已编译的 Java 类和原资源直接打包，再单独运行结构验证；不将其描述为完整 Gradle `buildPlugin` 已通过。此替代方式没有修改 SDK、编译器或生产代码，没有跳过 Java 编译或插件结构校验。没有自动安装到正在使用的 IDE，也未调用真实 Agent 或设备。
