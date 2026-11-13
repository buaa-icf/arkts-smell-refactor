# 独立运行的对话式 Skill

Skill 在 DevEco 对话中展示检测结果、风险、建议、候选 Diff 和反馈。外层 DevEco 原生子 Agent 负责重构与返修；Skill 自带的运行时准备编辑副本、接收修改、执行验收和独立评审，再按用户选择应用或回滚。TUI 与 Skill 继续复用检测、风险、门禁、证据和事务实现。

## Windows 使用者安装

1. 下载发布者提供的 arkts-smell-refactor.zip，**完整解压**到一个目录。目录中应同时有 install.bat、SKILL.md、scripts 和 runtime；不要在压缩包预览中运行。
2. 确认本机有 Node.js **20.19 或更高版本**，且 node 在 PATH 中；DevEco Code 要求更高版本时以其要求为准。没有 Node 或版本过低时，安装入口会明确提示并结束，不会自动下载或安装。可从 [Node.js 官方下载页](https://nodejs.org/en/download) 安装受支持的 LTS 版本，重新打开终端后运行 `node --version` 检查。
3. 双击解压目录中的 **install.bat**。已有同名安装时自动备份升级，并保留原有工具设置；查看窗口中的安装结果、实际位置和备份路径。
4. 退出并重启 DevEco Code，在目标业务工程打开聊天，通过 /skills 确认 arkts-smell-refactor，然后说“使用 arkts-smell-refactor，先检查环境，再检测 entry/src/main/ets/pages/Index.ets”。请把文件路径换成工程中的实际文件。

安装入口是批处理，后续执行包内 JavaScript。使用者无需 TypeScript、npm 或开发仓库。安装成功只表示文件就绪；首次流程仍会预检 SDK、工具和审查模型配置，缺项时列出补齐方法并结束本次执行。完整包内向导见 [INSTALL.txt](../skills/arkts-smell-refactor/INSTALL.txt)。

如需从终端安装或提供工具路径，在完整解压目录执行：

    .\install.bat --no-pause
    .\install.bat --no-pause --studio "D:/tool/DevEco/DevEco Studio"
    .\install.bat --no-pause --config "D:/settings/arkts-tools.json"

--no-pause 仅关闭结束前的按键等待。--studio 使用绝对路径；--config 读取 JSON 工具设置。

安装位置是用户级 ~/.config/deveco/skills/arkts-smell-refactor，Windows 对应用户主目录下的 .config/deveco/skills。设置了绝对 XDG_CONFIG_HOME 时使用其下的 deveco/skills。安装时不选择业务工程；不把某个工程、开发仓库或历史 runs 路径写入用户级绑定。

--config 仅复制受支持的工具设置，如 studio、deveco、hvigor、ohpm、linter、linterMode 和 timeoutMs，见 [工具设置示例](examples/settings.example.json)。旧配置中的 projectRoot、backend、bridgePath、runs、node 不作为发行包绑定；原配置不改写。安装内 settings.json 可保存共用工具设置，运行时还可单次传 --config。

批处理入口自动启用备份升级；升级默认沿用旧安装中的工具设置，本次 --config 和 --studio 可覆盖，旧工程和仓库路径不迁移。脚本不改业务工程的配置、宿主权限、协议或登录。

退出并重启 DevEco Code，在 /skills 中确认 arkts-smell-refactor。官方支持此用户级目录，见 [华为常用配置文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-deveco-code-common-configure/)。若有旧项目级同名 Skill，通过 deveco debug skill 的 location 核对实际加载版本。IDE 插件也可导入完整目录或 ZIP，但应保留 runtime 和脚本，见 [官方 Skill 配置页面](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-deveco-code-plugin-skill)。

运行仍需要本机 Node.js、DevEco Code 和工程要求的 DevEco SDK、构建及测试环境；发行包包含 JavaScript 运行时依赖，不包含平台专用 Node、SDK 或设备。

SDK 优先使用显式 studio 或 DEVECO_HOME；未设置时从 DEVECO_SDK_HOME、已有 Hvigor/OHPM/codelinter 命令的安装位置发现标准 SDK 目录。无法发现时 doctor 会列出配置方法。

## 维护者打包与其他安装入口

维护者在工具仓库编译 TypeScript 源码并构建发行包：

    npm ci
    npm run package:skill

默认生成 releases/arkts-smell-refactor 完整目录，以及同名 .zip 和 .tgz。可用 --output 指定发行目录。重复执行会在新目录及两种归档全部生成并校验后替换旧产物，只保留最新一套；失败时保留或恢复上次产物，并清理本次临时文件。--force 仅作为兼容参数保留，无需再添加。发行包包含 INSTALL.txt、SKILL.md、参考资料、批处理和 JavaScript 脚本，以及 runtime 下 JavaScript 后端、生产依赖和桥接资源。发布时提供完整 ZIP；使用者安装和运行无需再次编译。

也可直接从完整发行目录运行 JavaScript 安装器：

    node scripts/install.mjs
    node scripts/install.mjs --dry-run
    node scripts/install.mjs --force

JavaScript 安装器默认拒绝覆盖，--force 才备份升级；--dry-run 仅预览。覆盖失败时尝试恢复旧目录。维护仓库可用 `npm run skill:install -- --package "releases/arkts-smell-refactor"` 安装已经打好的包。完整发行目录也可直接运行 scripts/run.mjs。

## 切换工程与启动预检

从任意业务工程目录调用，默认向上发现最近的 Harmony 工程：

    node "<已安装Skill目录>/scripts/run.mjs" doctor

也可显式选择：

    node "<已安装Skill目录>/scripts/run.mjs" doctor --project "D:/harmonyos/MyApplication"

--project 只影响当前调用，不需要重新安装 Skill。指定文件位于另一工程时，使用它所属的工程路径；不会自动退回某个历史项目。若目录中无法确定工程，按照错误提示给出 --project。

任何新检测、重构流程首先运行 doctor。缺项返回 BLOCKED、stop 为 true、missing 列表和退出码 3。对话会列出具体原因和设置方法，然后结束本次执行；不会继续扫描、调用模型，或通过修改业务代码、权限、测试配置绕过缺项。补齐后由用户再次发起。

预检区分本地能力和真实执行：路径、SDK、依赖、模型可见性及凭据存在不等于凭据有效、网络可用、签名完成或设备测试成功。凭据缺失会明确阻塞；不会为了探测凭据而发起付费模型请求。已有历史查看和回滚不依赖 SDK/模型预检，以便环境异常时恢复代码。

## 实际对话流程

在加载 Skill 的业务工程聊天中说：

> 使用 arkts-smell-refactor 检测 entry/src/main/ets/pages/Index.ets，先展示检测结果和重构建议。

之后可选择“重构第 2 个问题，保留公开接口”“查看完整 Diff”“应用当前候选并复检”或“回滚刚才的应用”。

    doctor
      → scan / import
      → prepare
      → open-workspace
      → 外层 DevEco task / general 在 editDirectory 编辑
      → validate-workspace（门禁 + 后端独立 reviewer）
           ├─ 可归因 FAIL 且允许返修 → 外层定向返修 → 再验收
           ├─ BLOCKED / 无返修资格 → 报告并结束
           └─ PASS → 展示 Diff → 按授权 apply → validate-applied
                                                     → 按选择 rollback

每个工作区首次重构后最多三次返修。外层不启动独立 reviewer，评审仍在后端验收内；execute 保留兼容 TUI 和旧自动编排，不是 Skill 的默认路径。

详细命令见 [CLI 参考](../skills/arkts-smell-refactor/references/cli.md)，子任务调用见 [外层 Agent 指南](../skills/arkts-smell-refactor/references/outer-agent.md)，实现边界见 [编排说明](agent-orchestration.md)。

## 证据与限制

候选 PASS、事务 APPLIED、应用后复检结论分别记录。检测 responseFile、taskHandle、workspaceId、candidateId 用于不同阶段，结果持久化后可跨聊天恢复。同一工程逐项执行；原工程、工具策略或基线变化时，旧任务可能被拒绝。

原生 task 没有通用的 cwd 或单次权限覆盖参数。子 Agent 使用后端返回的绝对路径，遵守宿主具体路径权限；后端验收生产修改并检查原工程漂移。这不是操作系统沙箱。不能以提示词中写了“只改副本”作为底层文件隔离的证明。

维护者验证应覆盖包脱离仓库后的启动、不同 cwd 切换工程、预检缺项立即停止、外层编辑/返修的轮次控制、原工程漂移、应用后复检和回滚冲突。自动化测试与本机能力检查不能代替真实模型、SDK、签名、设备和宿主完整对话验收；实际完成范围以本次测试记录为准。
