# 外层 DevEco 编排与共享验收

Skill 默认路径由外层 DevEco 调度重构和返修，后端保留工作区准备、修改接收、门禁、失败归因、独立语义评审和候选事务。Skill 随运行时独立分发，用户级安装按 cwd 或 --project 选择业务工程。

## 当前职责

    用户 / DevEco 对话 / Skill
      ├─ doctor：预检；缺项报告并结束
      ├─ scan / prepare：检测、选问题、解释风险
      ├─ open-workspace：取得工作区与提示材料
      ├─ 原生 task / general：在工作副本重构
      ├─ validate-workspace
      │    ├─ 修改边界、原工程基线与轮次检查
      │    ├─ 异味、构建、测试、Linter 等门禁
      │    ├─ 后端独立只读 reviewer
      │    └─ 候选、最终判定、失败归因及返修资格
      ├─ 允许返修时：启动新的定向返修子任务，再验收同一工作区
      └─ 展示 Diff → 按授权应用 → 应用后复检 / 回滚

open-workspace --task 返回 workspaceId、editDirectory、promptFile。外层编辑结束后调用 validate-workspace --workspace，读取本轮 candidate、result、attempt、repairEligible、repairPromptFile。首轮后最多三次返修，后端持久化轮次；重新聊天不重置额度。

只有 FAIL 且有归因、repairEligible 为 true 时启动定向返修。环境、设备、签名、证据或超时 BLOCKED 时停止；不能调用模型修改业务代码来排除环境故障。预检缺失依赖同样结束本次执行。

独立评审本阶段留在后端。没有 finalize-review 命令，也不接受重构子 Agent 的口头自查作为评审 PASS。原 task.execute / execute 保留给 TUI、独立 CLI 和批跑等兼容路径；共享验证与事务无需复制第二套实现。

## 原生子 Agent：文档、源码与本机证据

华为官方说明支持 Agent/Subagent 定制，见 [DevEco Code 产品说明](https://developer.huawei.com/consumer/cn/doc/guidebook/aitech2026-3-2-0000002686648665/)。Skill 的用户级与项目级目录、访问权限及重启要求见 [常用配置文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-deveco-code-common-configure/)。

本机只读执行 deveco.cmd --pure debug agent general，结果为 name=general、mode=subagent、native=true，read/edit/write/bash/task 工具均可用，external_directory 默认 ask。此次检查将日志、缓存和状态放在临时目录，没有调用模型；它证明原生 Agent 的发现和工具配置，不证明模型编辑已经通过端到端验收。使用显式 deveco.cmd 可避开本机被其他进程占用的 PowerShell shim。

具体子任务行为还可参考公开源码固定提交 b45c586a6b671cfa2bce51d3b00dd65cf93d1303：

- [task 参数与子会话创建](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/tool/task.ts#L43) 提供 description、prompt、subagent_type 等参数，不提供 cwd。
- [Session.create](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/session/session.ts#L716) 使用当前实例目录。
- [switch_cwd](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/tool/switch-cwd.ts#L65) 只修改按会话保存的目录记录；[read](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/tool/read.ts#L236) 和 [shell](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/tool/shell.ts#L644) 的目录解析不能统一依赖它。

公开 develop 快照与本机发行版不是同一份版本证据。实际调用以宿主暴露的工具 Schema 为准；Skill 不发送虚构的 cwd、permissions 或 sandbox 参数，也不依赖实验性后台子任务。

## 工作区边界

外层传入后端返回的 promptFile、editDirectory 绝对路径，要求子 Agent 只编辑副本中允许的生产文件。宿主外部目录权限应匹配本次副本及必要提示材料，不修改全局自动批准设置。只有后端工作区 ID 能被送入验收，不能提交任意目录作为可信候选。

原生 general 可编辑，且没有通用的逐次权限覆写接口。提示、绝对路径和宿主权限不等于操作系统沙箱；后端基线检查能够拒绝原工程漂移，但不能把事后检查描述为操作系统层的写入阻止。若需要更强的文件系统隔离，需要额外的宿主或进程隔离能力，本阶段没有实现该适配器。

后端保留生产修改范围、测试与配置保护、源码摘要及候选冻结。测试选择在外层编辑前冻结，验收不得按改名或提取后的代码重新猜测覆盖。后续轮次使用本轮证据，旧门禁和旧评审不能自动继承。副本内容通过验收后形成冻结候选，由既有 apply 事务写入原工程，rollback 保留后续修改并报告冲突。

validate-candidate 面向已经冻结的候选，校验清单和内容哈希；它不能接收外层编辑。外层不得编辑 content/after 或原工程后再用此命令补验，必须走 open-workspace / validate-workspace。

## 预检为什么要分别检查模型和认证

models <provider> 返回的模型可见性不能单独证明凭据已配置。公开 [models 命令](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/cli/cmd/models.ts) 使用 provider.list；[provider 加载逻辑](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/provider/provider.ts) 也会根据 provider 配置加入模型。

本机在隔离配置/认证目录、没有凭据的条件下，仅声明 zhipu-coding 的 glm-5 模型，models 仍输出 zhipu-coding/glm-5，同环境 auth list 显示 0 credentials。因此预检需要分别确认模型存在以及可识别的凭据来源。检查只报告是否配置和来源，不打印密钥或完整配置，也不通过付费模型请求验证密钥。

本地认证存在仍不能证明认证有效、额度充足或网络通畅。无法确认必要认证时返回 BLOCKED，并给出配置方法；真实调用期间出现相关故障也停止本轮工作。

## 分发与恢复

发行目录保留编译运行时、生产依赖和桥接资源，安装元数据使用包内相对位置。用户级安装没有工程绑定，按 cwd 或 --project 发现目标；证据按工程区分保存在工程外。旧配置仅迁移工具设置，不将旧 backend、projectRoot 或 runs 带入新绑定。

新检测/重构流程先预检，后续关键命令仍会检查环境。history、diff、restore、rollback、apply 保留已有结果的查看/恢复通道，环境坏了仍可处理已有事务；它们不因此跳过候选或文件基线检查。import 命令本身可离线解析报告，但 Skill 新对话流程仍要求 doctor 通过后才导入，不能用它绕过已经返回的停止要求。

恢复外层编辑需使用原 workspaceId 和当前返回的返修资格。子任务尚未结束时不能并发验收，也不能重开工作区绕过轮次上限。状态、完整提示、源码摘要和本轮结果由后端持久化，聊天模型只负责正确衔接这些标识。

## 验证边界

必须分别记录：静态/受控自动化测试、发行包移走开发仓库后的运行、原生子 Agent 能力发现、真实模型与 SDK/设备完整验收。原生 general 的只读配置检查和模型列表探测不等于真实重构、返修、独立评审、应用和回滚全链路已经完成。
