# 插件仓库集成说明

迁移日期：2026-10-18。插件版本与 ID 保持为 `0.1.5` / `org.buaa.arktsrefactor`。

## 目录与构建入口

```text
arkts-smell-refactor/                 Git 仓库根目录、Python 后端工程
├─ pyproject.toml
├─ src/arkts_smell_refactor/
├─ tests/                            后端回归测试
└─ deveco-plugin/                     独立 Gradle 工程根目录
   ├─ settings.gradle.kts
   ├─ build.gradle.kts
   ├─ gradlew / gradlew.bat
   ├─ gradle/wrapper/
   ├─ src/main/java/                  DevEco 原生 UI 与 Java 服务
   ├─ src/main/resources/bridge/      随插件发布的 Python / Node 适配器
   ├─ src/test/java/                  文件事务测试
   ├─ tests/                         Python 桥接回归测试
   ├─ tools/                         真实 HomeCheck 烟测
   ├─ verification/                  Java 事务测试的独立验证工程
   └─ docs/
```

本机 Gradle 根目录为 `C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\deveco-plugin`，在 IDE 中打开或导入此目录即可。主仓库根目录仍是 Python 工程，不增加聚合 Gradle 项目。插件继续通过本地 Python worker 使用父仓库的后端源码；插件设置中的“后端目录”应指向 `arkts-smell-refactor` 根目录。

## Git 集成与本地内容

- 基线为 `dev_cly` 的 `c24daa34954c11db67ead73c772fccb34e18be59`，工作分支为 `codex/integrate-deveco-plugin`。
- 合仓提交 `02e3b10fb7256449ce2ad80fc1046e7e95d53af3` 通过不压缩的 Git subtree 导入插件。原插件 `ef3f9258c0eda5249055650e32ae48fd46b5b74b` 及其 14 次提交保留为祖先，导入时的 `deveco-plugin` 子树与原插件 HEAD 的树对象相同。
- 插件目录没有嵌套 `.git`，也没有 submodule；后端和插件由同一个仓库管理。`dev_cly` 分支及 origin 配置保持原状，本分支供后续 PR 合并。
- 原项目的本地 `.idea` 配置和 `Main.java` 示例已一并复制；IDE 配置沿用主仓库忽略规则，示例继续由现有 Gradle 配置排除编译。原仓库及其暂存区保留作为迁移备份，已有构建缓存、安装包和历史烟测证据仍可从原目录读取。
- 目标仓库原有 `.codex_tmp` 保留；生成目录、缓存、运行证据和本机配置不加入本次提交。

桥接测试从 `deveco-plugin/tests` 向上定位父仓库后端，后端源码缺失时直接失败，避免因旧目录假设跳过回归。烟测脚本同样使用父目录后端，不依赖仓库名称。

## 复现验证

从 `deveco-plugin` 目录执行：

```powershell
$env:JAVA_HOME = 'D:\tool\java21'
./gradlew.bat '-PdevecoStudioPath=D:/tool/DevEco/DevEco Studio' test buildPlugin verifyPluginStructure
python -W error::ResourceWarning -m unittest discover -s tests -v
python tools/smoke_detect.py
```

后端回归在主仓库根目录执行：

```powershell
python -m unittest discover -s tests -v
```

`tools/smoke_detect.py` 的 Node、DevEco SDK 与 HomeCheck 默认路径对应当前开发机；其他机器需调整工具路径。安装包位于 `deveco-plugin/build/distributions/deveco_plugin-0.1.5.zip`，通过 DevEco 插件页“从磁盘安装”加载。

- 在新的 Gradle 根目录使用 `D:\tool\java21` 完成 `test buildPlugin verifyPluginStructure`；7 项 Java 文件事务测试通过，无跳过。
- 插件 42 项 Python 桥接测试通过，无跳过；使用父仓库后端实际执行受控流水线。
- 主仓库原有 173 项 Python 后端测试通过。
- 从新目录运行真实 JSONL / HomeCheck 烟测，扫描 1 个样例文件并检出预期的 `calculate` 过长方法；扫描前后样例源码哈希一致。
- ZIP 校验通过：仅包含插件 JAR，26 个类均为 Java 21 字节码，适配器资源与源码一致，未包含 DevEco SDK 或初始化示例类。
- 核对插件历史及源文件迁移完整性：原插件 14 次提交可追溯，原目录及暂存区未改动，已有本地文件保留。
