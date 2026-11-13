# CLI 调用与结果约定

使用已安装 Skill 的入口，不依赖开发仓库：

    node "<Skill目录>/scripts/run.mjs" <command> [--project "<工程绝对路径>"] [--config "<工具配置.json>"] [选项]

全局 Skill 根据每次调用的 cwd 向上寻找最近的 Harmony 工程。目录不明确或用户指定其他工程时，用 --project 选择；不要沿用其他项目的历史绑定。第一次确认工程后，后续显式传同一 --project。相对的扫描和输入路径按调用时 cwd 解析，建议使用绝对路径。

--config 可选，仅提供 SDK 和工具策略。运行时决定自身后端位置，无需用户填写 backend、bridgePath 或 runs。同一流程保持工具策略一致，策略或源码改变会使旧证据失效。

## 预检

每次新检测/重构流程先运行 doctor。阻塞时 stdout 返回以下结构，退出码为 3：

    {
      "schemaVersion": 1,
      "ok": false,
      "command": "doctor",
      "result": {
        "verdict": "BLOCKED",
        "stop": true,
        "missing": [
          { "name": "缺失能力", "reason": "实际检查原因", "action": "补齐或配置方法" }
        ]
      }
    }

预检成功时 result.verdict 为 PASS、stop 为 false、missing 为空。doctor 不生成 responseFile。遇阻塞或预检命令失败，向用户呈现缺项并结束，不运行后续检测或模型任务。scan、prepare、open-workspace、validate-workspace 等命令也会预检；不能省略首次向用户解释依赖检查的步骤。

检查范围以返回证据为准。Node、打包依赖、HomeCheck、SDK、工具路径、模型可见性、凭据存在性，与真实网络调用、凭据有效性、签名和设备运行分别说明。未执行的能力不能报告为已验证。history、diff、restore、rollback、apply 不要求 SDK/模型预检，便于环境故障时查看或恢复已有结果；apply 自身仍要求有效 PASS 候选、基线一致和应用授权。

import 的命令实现也支持离线读取报告，无须 SDK 或模型。但在 Skill 发起的新检测/重构对话中，仍必须先 doctor，再 import；不能在预检失败后用离线导入继续该流程。

后端独立评审默认使用 zhipu-coding/glm-5，沿用现有模型策略。使用其他已配置模型时，在启动 DevEco 的环境中设置 ARKTS_REVIEW_MODEL=provider/model；可选 ARKTS_REVIEW_VARIANT。doctor 同时检查模型可见性和认证配置存在性，不显示凭据。自定义 provider 可通过用户级 DevEco 配置的 provider.options.apiKey（支持环境变量引用）配置；只有 models 列表而没有认证不能通过预检。

## 工作流命令

| 命令及选项 | 用途与衔接 |
| --- | --- |
| doctor | 检查环境，返回缺项及停止要求。 |
| scan --scope "<文件或目录>" | 执行检测；保存 responseFile，保留原范围。 |
| import --file "<报告.json>" | 规范化并保存已有报告，不等于重新检测。 |
| prepare --from "<responseFile>" --issue "<issueId>" | 选择问题，冻结基线、分析风险，返回 taskHandle。 |
| prepare … --instructions-file "<UTF-8文本>" | 准备时加入用户业务约束。 |
| open-workspace --task "<taskHandle>" | 创建外层可编辑副本，返回 workspaceId、editDirectory、promptFile。 |
| validate-workspace --workspace "<workspaceId>" | 接收副本修改、验收并独立评审；返回候选及返修资格。 |
| diff --candidate "<candidateId>" [--file "<候选内相对路径>"] | 读取冻结候选全部或单文件 Diff。 |
| validate-candidate --candidate "<candidateId>" | 对冻结候选重新验收，返回新候选 ID；不是外层编辑接收入口。 |
| apply --candidate "<candidateId>" --confirm "<同一ID>" | 检查基线并事务化应用 PASS 候选，须有用户授权。 |
| validate-applied --candidate "<candidateId>" | 验证实际应用结果，通过后按原范围刷新问题。 |
| history | 列出当前工程运行记录及应用状态。 |
| restore --candidate "<candidateId>" | 查看具有候选的历史记录和事务，不写回生产源码。 |
| rollback --candidate "<candidateId>" --confirm "<同一ID>" | 按事务恢复应用前内容，保留后续修改并报告冲突。 |

execute --task 保留兼容原后端自动编排，不属于此 Skill 默认流程。原生子 Agent 缺失或权限阻塞时，不自动回退 execute。

## 外层编辑与返修

open-workspace 返回后，当前 DevEco 对话调用原生 task，详见 [外层 Agent 指南](outer-agent.md)。子任务真正结束后才运行 validate-workspace。验收数据包含 candidate、result、workspaceId、attempt、repairEligible、repairPromptFile；具体字段是否存在以本轮结果为准。

- result.verdict 为 PASS：读取 candidate.candidateId，展示 Diff 后按授权应用。
- result.verdict 为 FAIL，repairEligible 为 true 且有 repairPromptFile：在同一 editDirectory 启动定向返修，随后验收同一 workspaceId。
- BLOCKED、stop 为 true、无返修资格或次数耗尽：报告并结束，不再启动编辑 Agent。

后端记录轮次并限制首次重构后的三次返修。聊天也应记录实际启动次数；换聊天、子任务或提示文件不能重置计数。同一工作区不可并发编辑或验收。

## 输出与恢复

stdout 为 JSON，stderr 提供阶段事件。业务操作的公共外层包含 ok、command、projectRoot、result 和保存完整结果的 responseFile；doctor 与启动预检阻塞结果不生成结果文件。门禁可能位于外层 result 内的流水线 result，不能只看 ok。

| 内容 | 从最外层 JSON 读取 |
| --- | --- |
| 目标工程 | projectRoot |
| 预检结论 | result.verdict、result.stop、result.missing |
| 问题及身份 | result.issues 各项的 issueId |
| 检测证据文件 | responseFile |
| 准备结果 | result.taskHandle、result.risk |
| 编辑入口 | result.workspaceId、result.editDirectory、result.promptFile |
| 验收与返修 | result.result.verdict、result.repairEligible、result.repairPromptFile、result.attempt |
| 验收候选 | result.candidate.candidateId |
| 应用/恢复状态 | result.transaction.state，冲突见 result.transaction.conflicts |
| 历史/恢复查看 | result.records；restore 的 result.candidate 和可选 result.transaction |

退出码 0 表示命令完成，仍需解读结果；2 表示参数、桥接或执行错误；3 表示未通过、环境阻塞或回滚冲突。非零退出也要读取完整结果。Node 或启动器无法运行时，报告错误并结束，不能先尝试其他工作流命令。

跨聊天继续编辑/验收前重新预检，再读取原 responseFile。taskHandle、workspaceId、candidateId 不能互换。不要手工造 Issue、哈希或验收结果。中断记录不表示任务完成；未确认子任务结束时，不可启动并发返修或验收。
