# 外层 DevEco Agent 调用

这份指南用于 open-workspace 成功返回之后。对话调用的是宿主原生 task 工具，它不是 shell 命令，也不是 Skill 新增 API。

## 使用实际可用的工具

确认当前 DevEco 暴露 task，并允许调用可编辑的 general 子 Agent。使用宿主展示的真实参数；常见必需项为 description、prompt、subagent_type。以下仅是调用内容示例，路径必须替换为本轮实际返回值：

    {
      "description": "ArkTS 异味重构",
      "subagent_type": "general",
      "prompt": "读取本轮提示文件 <promptFile绝对路径> 并按其要求完成重构。唯一可修改目录是 <editDirectory绝对路径>。所有读写路径使用绝对路径；不要在父对话的当前工程目录运行修改命令。不得修改原工程、测试、构建/依赖/签名配置、运行时或任务证据。只做提示要求的生产代码调整与自查，完成后报告修改文件和未解决问题，由父对话调用 validate-workspace 验收。不要调用 execute，不要应用候选，不要自行启动另一轮重构。"
    }

以实际宿主 Schema 为准，不添加未暴露的 cwd、working_directory、permissions 或 sandbox 字段。不要假定 switch_cwd 会改变所有文件工具的目录。宿主没有可用子 Agent 时，报告能力缺失并结束本次执行。

已有用户重构授权时可启动任务，不重复询问同一目标。应用原工程仍需对应应用授权。等待子任务结束才验收；使用宿主默认前台任务即可，不依赖实验性后台能力。

## 路径与权限

promptFile 和 editDirectory 都是后端返回的绝对路径。父对话通常位于原工程，副本一般在工程外：宿主外部目录权限应对应本轮具体副本及必要提示材料，遵守实际授权结果。不要将全局 permission 改为 allow，也不要为此新增原工程可写授权。

原生 task 没有通用的逐次工作目录或权限覆盖参数。这里依靠明确路径指令、宿主已有权限和后端验收，**不构成操作系统沙箱**。后端另外核对生产修改边界、原工程基线和候选内容；原工程漂移时拒绝验收或应用。发现子 Agent 访问错误目录时停止，不用复制、重置或重算基线掩盖问题。

需要命令时，子 Agent 使用工具支持的明确工作目录或在命令中明确进入 editDirectory，并遵守本轮提示的内部检查范围。不能仅凭相对路径认定命令作用在副本。

## 定向返修

只有后端本轮 FAIL、repairEligible 为 true 且返回 repairPromptFile 时才启动返修。使用新的子任务，读取该文件，继续修改同一 editDirectory，保留原文件边界。提示可写：

> 读取本轮 repairPromptFile 的绝对路径，只修复报告明确归因于本次修改的问题。唯一可修改目录是本轮 editDirectory 的绝对路径；沿用生产代码边界。不要修改环境、测试或验收材料来消除失败。完成编辑后报告结果，交回父对话验收。

每个工作区最多三次返修。环境、设备、签名、登录、证据或超时阻塞不进入返修。不得用“再试一次”绕过 repairEligible 为 false，不得新建工作区重置次数。

## 独立评审仍在后端

子 Agent 输出只是编辑反馈。完整门禁和独立只读 reviewer 由 validate-workspace 调用，最终状态及候选以其结果为准。当前流程不向外层请求评审 JSON，也没有 finalize-review 命令。
