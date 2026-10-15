# ArkTS Refactor for DevEco Studio

在 DevEco Studio 中检测 ArkTS 代码异味、分析重构风险、验证候选修改并预览应用。

适配目标：DevEco Studio 6.1.1.300（DS-243），Java 21。技术设计见 [docs](docs/README.md)。

## 编译

```powershell
$env:JAVA_HOME = 'D:\tool\java21'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
.\gradlew.bat '-PdevecoStudioPath=D:/tool/DevEco/DevEco Studio' buildPlugin verifyPluginStructure
```

Gradle Wrapper 使用 9.8.0，IntelliJ Platform Gradle Plugin 使用 2.19.0。
SDK 仅用于编译，不打入发布 ZIP。未使用 GUI Designer 表单，关闭代码 instrumentation；构建不启动 IDE 生成 searchable options。

产物为 `build/distributions/deveco_plugin-0.1.0.zip`。
在 DevEco Studio 设置的插件页选择“从磁盘安装”，选择 ZIP，并按宿主提示重启。
通过 Tools → ArkTS Refactor 或右侧工具窗口打开面板；设置页为 ArkTS Refactor。

## 环境

Python ≥ 3.10；本机 `arkts-smell-refactor` 源码；HomeCheck 扩展规则项目及已打包的规则；Node；DevEco ArkTS SDK。
执行完整重构还需要 DevEco Code、Hvigor、ohpm 和 Linter；设备测试需要对应签名及连接设备。
工具路径可以在插件设置中选择，默认值为当前开发机配置，其他机器需调整。

## 实施进度

- 阶段一：Java 21、插件描述符、原生 Tool Window、Tools 菜单、持久化设置及 ZIP 构建。
- 阶段二：本地 Python 适配器、环境检查、四规则检测、JSON 文件/粘贴导入、结果筛选、源码/关联片段定位、进程树取消和日志。
- 后续阶段：候选重构、Diff、应用事务和历史。

适配器作为插件资源发布，每次操作启动独立 Python worker；协议使用版本 1 JSONL，不要求修改后端仓库或安装新 Python 包。

桥接测试：`python -m unittest discover -s tests -v`。真实 HomeCheck 开发机烟测：`python tools/smoke_detect.py`。

插件的真实加载和 Harmony 工程执行需在目标 DevEco 中验收；构建/结构检查不代替宿主交互验收。
