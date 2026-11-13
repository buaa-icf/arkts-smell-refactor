# 将 Agent 编排交给外层 DevEco 的方案

可以进一步简化：由加载 Skill 的 DevEco 对话负责启动重构、返修和独立评审 Agent，后端提供准备工作区、接收修改、执行验收和应用事务的命令。这样模型任务的衔接集中在外层，TUI 与 Skill 继续共用确定性的检测和验收能力。

**本文是设计提案，文中的三个新接口尚未实现。** 当前可用命令仍以 [CLI 参考](../skills/arkts-smell-refactor/references/cli.md) 为准；现有 `execute` 仍会由后端启动 DevEco Agent。

## 当前链路与目标链路

当前 Skill 已接入共享后端，主要改变结果展示和用户选择的方式：

```text
用户 → DevEco 对话 / Skill → skill.js execute
                              ↓
                     后端 executePipeline
                              ├─ 启动 DevEco 重构 Agent
                              ├─ 执行机械验收
                              ├─ 启动独立评审 Agent
                              └─ 按失败归因决定是否启动返修 Agent
                              ↓
                       冻结候选 → 对话展示 → 应用事务
```

目标是把模型任务调度移到外层，后端保持可独立执行、可追溯的验收与文件操作：

```text
用户 → DevEco 对话 / Skill
          ├─ 请求后端准备隔离编辑目录与任务材料
          ├─ 启动重构 Agent，在该目录编辑
          ├─ 调用后端验收命令，读取本轮结果
          ├─ 必要时启动返修 Agent，再提交一轮验收
          ├─ 启动独立只读评审 Agent，提交本轮评审结果
          └─ 展示候选，按用户选择调用应用 / 复检 / 回滚
                         ↓
                共享检测、验收、证据与事务实现
```

同样使用 DevEco 不意味着现有每个模型调用都可以合并。重构 Agent 负责修改；独立 reviewer 负责审查冻结后的修改和证据。可以改变它们的启动位置，仍需保留不同职责和独立评审上下文。

本机已经确认 DevEco Code 版本为 `0.2.5`。在独立示例工程中，`deveco --pure debug skill` 找到了安装到 `.deveco/skills/arkts-smell-refactor/` 的 Skill；写入一个临时的 `.deveco/agents/arkts-native-probe.md` 后，`deveco --pure debug agent arkts-native-probe` 返回 `mode: subagent`。检查时将日志、缓存和状态重定向到临时目录，未启动模型任务。这验证了本机 Skill 与自定义子 Agent 的发现入口，尚不能证明子任务已具备指定工作目录、独立权限和完整候选验收的能力。

## 宿主 Agent 能力与工作区隔离

Huawei 官方提供 [DevEco Code 配置文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-deveco-code-common-configure/)。Agent / Subagent 的具体配置还可参照 [DevEco Code 公开仓库文档](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/docs/deveco-code-docs.html)。以下源码结论固定在 AgentGear 提交 `b45c586a6b671cfa2bce51d3b00dd65cf93d1303`。

原生 [`task` 的参数定义](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/tool/task.ts#L43) 没有 `cwd`，[创建子会话时](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/tool/task.ts#L147) 也不传独立工作目录；[`Session.create`](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/session/session.ts#L716) 沿用当前实例上下文中的目录。因此，原生子任务调用本身不能当作“在后端隔离目录执行”的保证。

这些公开实现证据也不能直接证明本机 DevEco 0.2.5 的全部内部行为。落地前应在实际宿主确认工作目录和权限。可以试验两种方式：原生子 Agent 使用副本的绝对路径，并配置经实测有效的文件/命令权限，使其只能修改该副本；或者通过支持明确工作目录的独立会话启动 Agent。前者更接近直接复用宿主 Agent，后者更容易沿用现有工作目录约束。两者都仍由后端接收并核验修改；仅在提示词中写一个目录，不等于已经建立隔离边界。

该快照的 [`switch_cwd`](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/tool/switch-cwd.ts#L65) 只更新按会话保存的目录记录；[`read`](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/tool/read.ts#L236) 与 [`shell`](https://github.com/AgentGear/deveco-code/blob/b45c586a6b671cfa2bce51d3b00dd65cf93d1303/packages/opencode/src/tool/shell.ts#L644) 的目录解析并不统一使用这份记录。不能把调用 `switch_cwd` 当作所有工具已经切换目录或原工程已得到保护的证据。

## 为什么不能直接使用 validate-candidate

现有 [`validateCandidate`](../src/ide/candidates.ts) 面向已经封存的候选。它先通过 `loadCandidateForValidation` 读取 `candidate.json`，检查原工程基线、前后文件清单和冻结内容哈希，再从基线与 `content/after` 重建验证副本。

因此存在三个区别：

1. 外层直接改原工程之后再调用，会因原工程偏离基线而被拒绝。
2. 外层直接改 `content/after`，会因冻结内容与清单哈希不符而被拒绝；这些目录不是编辑入口。
3. 它虽然移除了 `refactorAgent` 和 `repairAgent`，但仍保留 `reviewAgent`，调用 [`executePipeline`](../src/runner.ts) 运行门禁及模型评审。它不是仅执行机械验收的命令。

继续删除 reviewer 配置也不能得到完整通过结论。当前流水线将缺失评审记为 `SKIPPED`，最终为 `INCOMPLETE`。外移评审需要显式接收、校验并绑定外层的评审证据。

## 建议增加的三个接口（提案，尚未实现）

以下名称用于讨论职责，不是当前可以执行的命令。已有 `scan`、`prepare`、`diff`、`apply`、`validate-applied` 和 `rollback` 继续复用。

| 提议接口 | 输入与返回 | 后端负责的工作 |
| --- | --- | --- |
| `open-workspace --task <taskHandle>` | 返回受控工作区 ID、编辑目录、重构提示词及材料路径 | 校验准备时基线和策略；创建编辑副本；在交给外层 Agent 前冻结原接口测试选择。 |
| `validate-workspace --workspace <workspaceId>` | 返回本轮验证 ID、各门禁结果、失败归因及评审材料 | 接收合法生产修改；建立不可变验证快照；运行机械门禁；绑定源码、策略和证据摘要。 |
| `finalize-review --attempt <attemptId> --review-file <file>` | 返回最终结果及已封存候选 ID | 校验独立评审记录与本轮材料一致，严格解析结果，合并机械门禁和评审结论，再封存候选。 |

机械门禁通过、等待评审时，应明确返回“等待评审”状态，不能先生成可应用的完整 `PASS`。外层返修后须生成新的验证轮次，旧门禁和旧评审不能自动沿用。

后端可复用 [`runGates`](../src/runner.ts) 执行机械验收，将 [`refactorGate`](../src/gate.ts) 中的“创建编辑副本、启动 Agent、接收修改”拆开复用，保留 [`syncProductionChanges`](../src/workspace.ts) 的生产修改检查。外层提交受控工作区 ID，由后端解析路径，避免把任意目录直接当作可信候选。

`finalize-review` 需要记录 reviewer 的独立任务或会话标识，并绑定本轮评审材料与源码摘要。一个 JSON 文件本身不能证明评审任务独立；这部分需要宿主提供的任务记录配合。缺少有效评审、评审为 `UNCERTAIN` 或材料已改变时，不应封存为可应用的 `PASS`。

## 继续由代码保证的边界

### 基线、修改范围和事务

[`prepareCandidate`](../src/ide/candidates.ts) 保存目标及关联文件哈希、工程基线、配置摘要、原扫描范围和风险材料。外层 Agent 应编辑受控副本，原工程到应用前保持原基线；即使用户已经授权自动应用，也先形成经过验证的候选，再由现有事务写回。

接收修改时继续拒绝非授权的测试、构建配置、删除、重命名及路径越界。保留新增文件、生产资源、源码编码和换行处理。现有 [`freezeCandidate` / `checkCandidate`](../src/ide/candidates.ts) 及 [`src/client/apply.ts`](../src/client/apply.ts) 的哈希校验、应用日志和冲突回滚继续使用。

### 修改前选测

[`freezeTestPlan`](../src/test_plan.ts) 根据重构前的文件、所属类型、方法及测试注册关系冻结选择，保留测试哈希和 UI 归因证据。方法提取或改名后不能重新猜测覆盖关系；新增跨模块修改可以补充测试，但不能丢掉原先已选套件。

这里有一个现有实现细节需要先处理：[`copyArtifacts`](../src/ide/candidates.ts) 没有迁移 `baseline-test-plan.json`。正常 `execute` 路径依靠 `refactorGate` 在新副本修改前再次冻结；`validateCandidate` 跳过重构步骤后不经过该冻结调用。新增外层编辑入口不能依赖“进入验收时再选测”，必须在编辑前保存计划，并明确跨副本迁移规则。直接复制计划也不足够，因为 [`buildTestPlan`](../src/test_plan.ts) 会核对 `sourceRoot` 与 `taskSha256`；应先校验原计划，再受控调整路径和任务绑定，保留原接口、测试选择与哈希证据。

### 机械验收与失败归因

保留异味、构建、测试、Linter，以及按策略启用的公共契约和 Runtime Smoke。现有 `runGates` 先并行执行前置检查，再顺序执行依赖构建的验证与测试，包含 fail-fast 和超时处理。这些逻辑与谁启动模型无关，仍适合放在后端。

机械验收不能只看一条 shell 命令的退出码。测试需要本轮真实报告与完整状态；设备、签名、SDK、登录及超时阻塞不能被解释为生产代码缺陷。跳过的 Linter 要保留跳过状态，不能宣称全部检查通过。

外层返修仍应读取 [`buildFailureReport`](../src/runner.ts) 生成的分类与归因。当前 `executePipeline` 在没有 `repairAgent` 时会先退出修复循环，不一定生成这份报告；拆分时应将失败分析独立为验收输出，而不是依赖是否配置了后端返修 Agent。返修次数和停止条件也需要持久化，不能因为换一个对话轮次就无限重试。

### 独立语义评审

机械门禁不能完整证明行为等价。独立 reviewer 读取本轮前后源码、完整 Diff、静态风险及机械证据，特别核对公共接口、副作用顺序、响应式状态、UI ID 和字面量变化。

继续复用 [`prepareReviewPrompt`](../src/review_packet.ts) 的集中材料，以及 [`parseReview`](../src/review_output.ts) 的严格结果解析。reviewer 应使用独立只读上下文；重构 Agent 的自查不能直接作为独立评审结果。评审绑定的源码或策略改变后，必须重新生成材料和评审。

## 迁移顺序与实际能减少的代码

1. **先抽出确定性服务。** 分离编辑副本准备、生产变更接收、机械验收、失败分析和评审材料生成；补齐跨副本的冻结选测处理。保持 TUI 原有入口可用。
2. **外移重构与返修。** 增加前两个提议接口，让外层 DevEco 调度编辑 Agent。第一阶段可暂时保留后端独立 reviewer，先验证工作目录、取消、基线失效和多轮返修衔接。
3. **外移独立评审。** 增加第三个提议接口，接入宿主独立 reviewer 任务记录和本轮材料绑定。完整外移后，Skill 路径不再通过后端启动模型。
4. **收敛旧执行路径。** TUI、独立 CLI 和批跑仍通过 `task.execute` 自动编排时，把它保留为同一组底层服务的适配器；只有这些入口也完成迁移，才考虑删除无人使用的模型启动代码。

Skill 路径可以减少后端的模型选择、`deveco run` 启动、模型输出交接识别、自动返修循环以及额外格式修复模型调用。底层检测、工具执行、证据校验和事务不会因此消失。现有 [`agent_runtime.ts`](../src/agent_runtime.ts) 与部分 `executePipeline` 仍服务于 TUI、独立 CLI 和批跑，不能现在整块删除；目前没有足够依据估算净删除行数。

落地验证应同时覆盖外层编辑工作目录、候选原工程隔离、修改前选测、机械通过但未评审、旧评审失效、环境阻塞、应用后复检与冲突回滚。本文没有实现上述新接口，也没有宣称已完成外层 Agent 编排的端到端验收。
