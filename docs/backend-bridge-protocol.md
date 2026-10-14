# DevEco 插件与 ArkTS 重构后端桥接协议

日期：2026-10-14  
协议：拟新增 `ide-bridge/1`，尚未实现。  
关联：[端到端 UI 与实现设计](deveco-plugin-end-to-end-design.md)。

## 1. 当前接口与缺口

后端现有入口为 `python -m arkts_smell_refactor`，支持：

```text
configure --workspace <包含 sourceProject 的根目录>
doctor [--workspace <根目录>]
prepare --dataset <JSON数组文件> --workspace <根目录> --output <目录> [--index N]
run --task-dir <目录> --config <配置文件> [--dry-run]
start [--workspace <根目录>] [--linter-mode required|skip]
```

`prepare` 生成静态风险、任务、Prompt、契约和适用的 runtime smoke 计划，不启动重构 Agent。`run` 执行流水线，CLI 以 PASS/DRY_RUN 返回 0，其他结论返回 2；退出码不能区分 FAIL 与 BLOCKED，必须读取结果。`start` 接收 JSON 后自动执行并直接写回所定位的工程，不能用它实现“预览后应用”。

`runner.execute_pipeline(..., progress=...)` 已提供阶段名称和状态回调，但名称为显示文本，没有完整 IDE 协议。阶段日志通常在子进程结束后落盘；已有 fail-fast/超时取消没有公开的用户级取消接口。

桥接层要补充：初次检测、公开服务、任务与 Issue 映射、候选工程、结构化事件、流式日志、用户取消、持久化快照、门禁单独重跑，以及协议能力协商。普通 CLI 保持原行为。

## 2. 进程与协议约定

拟新增启动命令：

```text
<pythonExecutable> -u -m arkts_smell_refactor.ide_bridge --stdio --protocol 1
```

该命令不是当前可执行入口。运行 cwd 为已配置后端根目录；插件提供其 `src` 的受控模块搜索路径或使用已安装模块，启动后核对真实模块路径，防止调用到另一份安装。

每个 IDE Project 有独立 bridge 会话。stdin 接收 UTF-8 JSONL 请求，stdout 只输出 UTF-8 JSONL 响应/事件，stderr 为诊断。单行不得含未经 JSON 转义的换行。任一底层 `print`、Agent 或工具 stdout 都必须由桥接捕获，不得混入协议输出。

这是应用自定义协议，不标称 JSON-RPC。基本信封：

| 字段 | 说明 |
| --- | --- |
| `protocolVersion` | 整数 1 |
| `type` | `request / response / event` |
| `requestId` | 请求和对应响应的唯一 ID；事件可携带来源请求 ID |
| `method` | request 的固定方法名 |
| `params` | request 的结构化参数 |
| `ok` | response 是否成功接受/处理请求 |
| `result` / `error` | response 二选一，不能用退出码替代结构化错误 |
| `sessionId` | hello 后返回的进程会话标识 |
| `runId` | 长任务运行标识；不同重试分配新值 |
| `seq` | 同一 run 内事件递增序号 |
| `event` / `data` | 事件名称与数据 |
| `timestamp` | UTC ISO 8601；UI 按本地时区显示 |

hello 响应返回协议版本、后端版本、模块路径、源码/构建摘要和 capabilities。主版本不兼容时，插件提示升级；旧后端仍可通过专门的旧产物导入适配器只读展示历史，不解析中文 stdout 驱动实时 UI。

首版同一工程只执行一个长任务；请求读取线程与执行线程分离，所以取消、快照和日志查询不被正在运行的流水线阻塞。普通短查询可并发，状态变更按 run 顺序持久化后发布。请求超时与执行超时分别处理。

同一 session 内重复 requestId 返回已受理结果，不再次启动任务；受理记录先持久化，再回响应。客户端请求超时后查询运行状态，不自动重发执行。跨 session 恢复读取历史索引，新执行分配新 runId。

后端 taskId 带输入展开序号，可能在不同运行中重复。bridge 为每次准备分配 UUID `taskHandle`，后续方法按它定位绑定任务；taskId 只作为原产物名称与展示字段。prepare 和 execute 各有 runId，执行记录引用准备记录的冻结摘要和产物，不能原地覆盖准备证据。

请求大小、JSON 深度和日志事件大小设置上限，大产物通过受控 artifact ID 读取。日志拥塞时可合并/限流，状态和最终结果不得丢失；日志事件注明缺口并提供完整日志入口。

## 3. 拟新增方法

| 方法 | 核心参数 | 结果/用途 |
| --- | --- | --- |
| `session.hello` | 客户端版本、支持协议 | 会话、后端信息、能力及限制 |
| `environment.inspect` | 工具覆盖、工程根、SDK | 每项实际路径/版本、诊断、检测/候选/验证能力 |
| `scan.start` | 工程、范围/文件清单、rules | 立即返回 runId，异步输出本轮问题 |
| `issues.import` | JSON 文本或已授权导入文件 ID、路径映射 | 标准问题、每条兼容性和失败位置 |
| `task.prepare` | issueId、扫描 ID、业务说明、linterMode | 受理返回 runId/taskHandle；完成快照含后端 taskId 和 PREPARED |
| `task.execute` | taskHandle、准备摘要、`mode=candidate` | 在绑定候选根运行，不接受任意新 source-root |
| `task.cancel` | runId | 取消受理；最终取消需等事件/快照确认 |
| `task.snapshot` | runId、可选 afterSeq | 持久化状态、各轮结果、证据索引和事件位置 |
| `candidate.describe` | candidateId | 冻结变更清单、摘要、Diff/资源产物 ID、候选验证 |
| `task.validateApplied` | taskHandle、applyTransactionId、已应用内容摘要 | 单独验证当前工程，不运行 Refactor/Repair Agent |
| `history.list` | 工程 ID、分页游标、状态筛选 | 本 bridge 可见运行的摘要索引 |
| `artifact.read` | artifactId、offset、limit | 受控分块读日志/文本/元信息，不读任意本机文件 |

`apply` 和 `undo` 属于 Java IDE 事务，由插件负责，bridge 不直接写真实工程。应用前插件使用 `candidate.describe` 的冻结清单，成功后保存事务并调用 `task.validateApplied`。

hello capabilities 至少包括 supportedRules、supportedInputFormats、streamingLogs、userCancellation、candidateExecution、appliedValidation。界面据能力开启按钮；协议连接成功不代表所有工具都可用。

### 3.1 交互例子

生成候选请求：

```json
{
  "protocolVersion": 1,
  "type": "request",
  "requestId": "req-21",
  "sessionId": "session-demo",
  "method": "task.execute",
  "params": {
    "taskHandle": "task-handle-demo",
    "preparedDigest": "sha256:example-prepared-digest",
    "mode": "candidate"
  }
}
```

受理响应：

```json
{
  "protocolVersion": 1,
  "type": "response",
  "requestId": "req-21",
  "sessionId": "session-demo",
  "ok": true,
  "result": {
    "runId": "run-demo-001",
    "taskHandle": "task-handle-demo",
    "taskId": "long-method-0001-build",
    "workflowState": "QUEUED"
  }
}
```

阶段事件：

```json
{
  "protocolVersion": 1,
  "type": "event",
  "sessionId": "session-demo",
  "runId": "run-demo-001",
  "seq": 7,
  "timestamp": "2026-10-14T14:30:00Z",
  "event": "step.updated",
  "data": {
    "stepId": "build",
    "attempt": 0,
    "phase": "candidate",
    "status": "RUNNING",
    "durationSeconds": 3.5,
    "logArtifactId": "artifact-build-log"
  }
}
```

文中示例 ID 和摘要为示意值；实现使用实际 UUID 与 SHA-256，不能使用示例摘要进行有效性校验。

### 3.2 错误响应

```json
{
  "protocolVersion": 1,
  "type": "response",
  "requestId": "req-21",
  "sessionId": "session-demo",
  "ok": false,
  "error": {
    "code": "BASELINE_CHANGED",
    "message": "任务准备后工程内容已变化",
    "retryable": true,
    "details": {
      "changedFiles": ["entry/src/main/ets/pages/Index.ets"],
      "nextAction": "REPREPARE"
    }
  }
}
```

固定错误类别：`INVALID_REQUEST / UNSUPPORTED_PROTOCOL / UNSUPPORTED_RULE / INVALID_INPUT / PATH_OUTSIDE_ROOT / TOOL_UNAVAILABLE / SDK_INVALID / PROJECT_BUSY / BASELINE_CHANGED / CANDIDATE_CHANGED / ARTIFACT_UNAVAILABLE / PROCESS_EXITED / INTERNAL_ERROR`。

请求错误与执行结果不同：接受一个任务后出现编译失败，由结果事件报告 FAIL；不是把所有门禁失败转成协议 `ok=false`。`retryable` 仅表示满足条件后可重新请求，不指示插件无限自动重试。

## 4. 事件与一致性

事件包括：`run.started / workflow.changed / step.updated / log.appended / issue.batch / candidate.ready / run.completed / run.stopped / artifact.available`。

每项阶段使用机器 ID：`prepare / refactor-agent / smell / build / contract / runtime / test / linter / review-agent / repair-agent / applied-validation`。`attempt=0` 表示首轮，`attempt=1..3` 表示返修；Review 环境重试另存 `retry`，不消耗返修轮数。

桥接不能仅把 `progress("重构 Agent", "开始")` 的中文字符串匹配成状态；为 runner 增加结构化回调，原回调保持兼容。并行门禁有独立 stepId，事件到达顺序不能表示门禁依赖。

run 最终快照先写临时文件，再同目录原子替换正式文件，完成后才发送 `run.completed`。现有 `utils.write_json()` 为直接写文件，新桥接快照需要独立的原子写实现；UI 不把半写 JSON 作为真实结果。

插件按 `(runId, seq)` 去重，乱序缺口触发快照查询。启动新 bridge 后 sessionId 更新，旧会话不能继续更新新运行。项目服务串行归并快照，再切到 EDT 渲染。

`run.completed` 表示本次执行已结束；只有候选 PASS 才出现 `candidate.ready`，两者仍不代表代码已应用。用户取消发送 `run.stopped`，保存停止原因和已结束阶段；不伪造 backendVerdict 为 CANCELLED。

stdout EOF 或进程异常使所有无终态请求结束，运行转为 INTERRUPTED。读取已有快照可以展示阶段结果；重新执行必须新建 run。旧 PID 不作为恢复执行的身份凭据。

## 5. 现有产物适配

UI DTO 统一 camelCase，适配层保留原产物并记录其 schemaVersion。当前 `task.json` 使用 snake_case，风险/门禁/结果使用 camelCase，且嵌套字段也不统一。

| 现有字段 | UI 字段/含义 |
| --- | --- |
| `task.schema_version` | `taskSchemaVersion` |
| `task.task_id` | `taskId` |
| `task.source_project` | `sourceProject` |
| `task.commit_hash` | `datasetCommitHash`，不当作当前基线 |
| `task.workspace_root / project_root` | 候选执行路径，仅桥接层使用；UI 显示原始映射 |
| `task.target.file_path` | `target.filePath` |
| `task.target.range.start_line / end_line` | `target.range.startLine / endLine` |
| `task.target.related_targets` | `target.relatedTargets`；其元素本来使用 filePath/startLine 等 |
| `risk.riskLevel / risks / recommendedConstraints` | 直接转换成风险和约束 DTO |
| `risk.schemaVersion` | 当前可见 1.0、1.1、1.2；未知主版本只读展示原文 |
| `gates.gates[].duration_seconds / output_file / exit_code` | `durationSeconds / logArtifactId / exitCode` |
| `result.verdict` | `executionVerdict` 原值 |
| `result.steps / attempts` | 全部阶段轨迹/轮次，不能将早期 FAIL 当最终轮结论 |
| `result.repairAttempts / reviewRetries` | 真实返修/评审环境重试数，缺失时显示未知 |
| `result.validationPolicy.linterMode` | 当前策略，旧产物缺失显示“未记录” |
| `refactor-changes.changedProductionFiles` | 后端源码变更线索，须再与最终候选快照核对 |
| `changedProductionResources / productionResourceManifest` | 资源变更线索，最终清单由全量 Diff 计算 |

缺失字段不默认为成功或零值。`target.symbol` 可以为 null。行号通常从 1 开始，但旧数据可能有 CFG 行号；column 可能为 0，不能统一假设为编辑器一基列。导航优先符号和片段上下文，兜底行范围限幅并提示定位精度。

### 5.1 产物用途

| 产物 | 展示/校验用途 |
| --- | --- |
| `index.json` | prepare 后的 taskId、taskDir 列表 |
| `task.json`、`risk-report.json` | 输入证据、目标、风险、专项画像和约束 |
| `refactor-prompt.md`、`review-prompt.md` | 高级诊断中查看实际 Prompt |
| `gates.json`、`result.json` | 最新门禁及最终执行结论 |
| `review*.json` | 最终独立评审、失败问题和不确定结论 |
| `refactor-changes.json`、`agent-change-attempt-*.json` | 允许变更、候选和拒绝原因 |
| `baseline-production/`、`current-production/`、`review-diff.patch` | 后端评审材料；不替代插件完整资源/Undo 快照 |
| `test-plan.json`、`test-results.json`、`test-attempts/` | 套件选择、实际执行、新鲜证据及各轮原报告 |
| `public-contract-before.json`、`public-contract-results.json` | 旧 API 基线与公共契约检查 |
| `runtime-smoke-plan.json`、`runtime-smoke-results.json` | 适用时的公开 runtime smoke 证据 |
| `smell-after.json`、`linter-after.json` | 目标/变更范围的剩余问题 |
| `failure-report*.json`、`repair-prompt-*.md`、阶段日志 | 失败归因、返修策略和详细诊断 |
| `summary.json` | 现有 start 的批次汇总；插件批次另建索引，不能假定 run 自动生成它 |

产物链接注册为 artifactId，附带类型、相对位置、大小和摘要。读取前确认实际路径在允许 run 目录内，禁止任意绝对路径、符号链接逃逸以及通过 taskDir 访问其他工程。

## 6. 候选与应用数据边界

拟新增插件事务产物，与后端现有产物分开：

```text
<configured-run-root>/<runId>/
├─ session.json                 工程映射、版本、策略、issue/taskHandle/taskId 关联
├─ snapshot.json                可恢复状态
├─ events.jsonl                 持久化事件
├─ baseline-manifest.json       原始文件、缺失标记和内容摘要
├─ staging/                     完整候选工程；Agent 副本仍排除测试
├─ backend/                     原有流水线任务与产物
├─ candidate-manifest.json      最终新增/修改清单与验证摘要
├─ retained-content/            Diff、资源、Undo 所需的冻结前后内容
├─ apply-transaction.json        Java 写入日志和应用状态
└─ applied-validation/          应用后独立验证结果
```

实际临时副本可放短英文路径，session 保存受控映射；所有目录名/任务 ID 校验，不接受客户端拼出的任意路径。插件自有目录不落入下一次扫描的生产范围。

candidate-manifest 每项至少记录：`relativePath`、`kind=source|resource`、`changeType=added|modified`、`beforeExists`、`beforeSha256`、`afterSha256`、`size`、编码/换行元信息及冻结内容 artifactId。删除/重命名首版拒绝。

候选生成只使用准备时绑定的 staging 根；bridge 不允许后续请求通过 source-root 覆盖绑定。Agent、返修、门禁和 Review 的路径都要重映射，不能仅改目标文件而保留原始 project_root。

backendVerdict、candidateValidation、applyState 和 appliedValidation 分开持久化。候选 PASS + NOT_APPLIED 显示“候选已验证，待应用”；应用后的旧候选证据不能直接改写成当前工程 PASS。

## 7. 取消、日志和恢复实现要求

为 `execute_pipeline` 增加公开 cancellation token，并传入 Agent、所有并行门禁、runtime、测试、评审、环境重试等待和返修。已有 fail-fast token 与用户取消需要保留不同原因。桥接读请求线程仍能立即接受取消。

每个任务登记其进程树，沿用后端的 Windows PID 树终止机制或等价的受控实现。确认相关进程全部停止后写终态；日志读取器退出不能先于尾部日志落盘。取消超时显示“正在停止”，最终异常保存 PROCESS_EXITED 或停止失败信息。

日志同时流式写文件和发布有限 `log.appended` 事件，包含 stepId、attempt、stream、offset。不以日志关键字自行覆写最终判定；环境错误使用后端结构化 reason。用户名路径、命令参数和凭据在默认日志视图/导出中按策略处理，完整证据路径受控。

应用事务由 Java 持久化，每个文件写入前后记账。重启后结合日志及实际哈希判断已完成、未完成或冲突；异常恢复需要按原始内容/本事务写入内容分别核对，禁止把后续编辑当作待回滚内容。

## 8. 协议验收

实现时至少验证：

1. hello 主版本不兼容、旧模块路径、缺少能力时按钮正确禁用。
2. JSONL 跨读取块、多事件粘连、非法行、过大消息、重复事件和序号缺口。
3. 并行阶段、三轮返修及 Review 环境重试不混淆轮次。
4. 子进程中文日志、stderr、EOF 和崩溃不污染协议或冻结 UI。
5. Windows 空格/中文路径、逗号文件名、路径逃逸及 artifact 越界。
6. 候选运行修改 staging，真实工程保持原始内容；非法配置/测试变更整轮拒绝。
7. 每个运行阶段可以取消，进程树停止且证据保留。
8. 旧产物缺失字段、未知 schema、空 symbol、混合大小写命名正确展示。
9. 应用后验证不重复 Agent，并使用候选前的公共契约基线。
10. 基线变化、资源变化、新增文件冲突、事务异常和 IDE 重启恢复。

先用受控假工具验证协议和状态，再联调真实 HomeCheck/DevEco/Hvigor。最终验收要求见[端到端设计](deveco-plugin-end-to-end-design.md)。
