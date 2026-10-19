# ArkTS Refactor for DevEco Studio

在 DevEco Studio 中检测代码异味、分析风险，在隔离工程中重构并验证，最后预览 Diff、整项应用或 Undo。插件界面和文件事务仍使用 Java，只将连接层从 Python 改为 Node.js / TypeScript。

适配目标：DevEco Studio DS-243、Java 21。版本 0.2.0。

## 安装后端

在本仓库根目录执行：

```sh
npm install
npm run build
npm test
```

需要 Node.js >= 20.19。插件设置中的“后端目录”选择本仓库根目录，而不是 `src` 或 `dist`；Node 选择真实的 Node 可执行文件。修改后端源码后重新执行 `npm run build`。不需要 Python、pip 或配置 Python PATH。

## 插件设置与使用

配置 Node、后端目录、HomeCheck 项目、DevEco Studio、任务目录及 DevEco Code / Hvigor / ohpm / Linter 工具路径。任务目录必须在业务工程之外；可留空的工具项从 Node 进程的 PATH 中发现。IDE 的 PATH 可能与终端不同，发现失败时选择绝对路径。

Linter 默认 `required`，必须执行并通过；已有的显式 `skip` 选项保留，只有用户主动选择才跳过，不计入验收，也不触发返修。设备测试仍需要真实连接设备和有效签名。

通过 Tools → ArkTS Refactor 或右侧工具窗口打开面板：

1. 环境检查，确认检测/重构所需工具齐全。
2. 扫描当前文件、目录或工程，或导入原有 `filePath + messages[]` JSON。
3. 选择异味，分析风险，生成候选。原业务工程此时不回写。
4. 候选工程执行 Agent、门禁与 Review；日志和结果保存在任务目录。
5. 预览 Diff，通过校验后整项应用；Java 文件事务负责冲突检查、回滚和 Undo。
6. 可重新验证冻结候选，或验证已应用内容；两者不再次调用重构/修复 Agent。

## 构建插件

在 `deveco-plugin` 目录执行，替换本机 JDK 和 Studio 路径：

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
.\gradlew.bat '-PdevecoStudioPath=E:/DevEco Studio' test buildPlugin verifyPluginStructure
```

macOS 使用 `./gradlew -PdevecoStudioPath=<Studio路径> test buildPlugin verifyPluginStructure`，并使用本机 JDK 21。首次构建需下载 Gradle/Maven 依赖。

产物为 `build/distributions/deveco_plugin-0.2.0.zip`。在 DevEco Studio 插件页选择“从磁盘安装”，选择 ZIP 并按提示重启。插件只包含 Java 界面与 Node 启动适配器；TypeScript 后端、依赖和 SDK 不打入 ZIP，仍从插件设置中指定的本地目录读取。

## 测试与只读烟测

仓库根目录的 `npm test` 同时运行后端与 Node 桥接测试；插件目录的 Gradle `test` 运行独立 Java 文件事务测试。受控 Agent/HomeCheck/Hvigor 用于校验编排，不能当作真实模型、设备或 IDE 交互已验收。

将插件设置字段另存为 JSON（`backend`、`node`、`homecheck`、`studio`、`runs` 等），检测真实项目文件：

```sh
node tools/smoke_detect.cjs --config <设置JSON路径> --project <业务工程根目录> --file <源文件绝对路径>
```

只重新运行已有冻结候选的异味门禁、不运行 Agent：

```sh
node tools/smoke_candidate_gate.mjs --candidate-run <候选任务绝对目录>
```

两种烟测只在任务目录写证据，执行前后校验业务工程未变化。旧 Python 桥接和烟测已删除，相关测试迁入根 `tests/ide_bridge.test.ts`。历史设计文档保留，但其中 Python 命令不再适用。

详见 [Node 连接适配](docs/node-backend-adaptation.md)、[协议](docs/backend-bridge-protocol.md)。
