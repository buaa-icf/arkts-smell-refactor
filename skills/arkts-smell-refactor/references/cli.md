# CLI 调用与结果约定

所有命令使用同一设置文件。下面的 `<backend>`、`<settings>`、`<id>` 表示实际绝对路径或返回的标识，执行时替换并对路径加引号。

```text
node "<backend>/dist/skill.js" <command> --config "<settings>" [选项]
```

设置兼容 TUI 使用的 JSON：`projectRoot` 是业务工程根目录，`backend` 是工具仓库，`runs` 必须在业务工程外。路径字段建议全部使用绝对路径；Windows JSON 路径使用 `/` 或转义后的 `\\`。`node`、`deveco` 等命令字段只填写可执行文件或 PATH 命令名，不附带参数。配置或后端版本变化可能使已有候选失效。

## 命令

| 命令及选项 | 用途与衔接 |
| --- | --- |
| `doctor` | 检查后端与外部工具；分别读取 `canDetect`、`canRefactor`。 |
| `scan --scope "<工程内文件或目录绝对路径>"` | 执行真实检测；保存结果 `responseFile`，保留原范围。 |
| `import --file "<报告 JSON 绝对路径>"` | 规范化现有报告并持久化问题。导入不等于重新检测。 |
| `prepare --from "<检测或导入的 responseFile>" --issue "<issueId>"` | 从原证据选中一个问题，冻结基线、分析风险，返回 `taskHandle`。 |
| `prepare … --instructions-file "<UTF-8 约束文本路径>"` | 在准备时补充用户业务约束；文本作为数据读取，不拼接为 shell 命令。 |
| `execute --task "<taskHandle>"` | 调用既有隔离重构与验证流程；返回候选、结果、`candidateId`。 |
| `diff --candidate "<candidateId>"` | 读取冻结候选的全部变更。 |
| `diff --candidate "<candidateId>" --file "entry/src/main/ets/Page.ets"` | 查看一个候选内的相对文件路径；使用 `/`。 |
| `validate-candidate --candidate "<candidateId>"` | 重新验证候选并返回新候选 ID，之后使用新 ID。 |
| `apply --candidate "<candidateId>" --confirm "<同一candidateId>"` | 再检查当前基线和候选，事务化写回原工程；仅允许通过验证的候选。 |
| `validate-applied --candidate "<candidateId>"` | 验证实际应用后的代码；通过后按原范围刷新问题。 |
| `history` | 列出当前工程的运行记录及应用状态。 |
| `restore --candidate "<candidateId>"` | 仅用于 `history` 中 `hasCandidate: true` 的记录，读取持久化候选/结果和应用事务状态。此命令不写回生产源码。 |
| `rollback --candidate "<candidateId>" --confirm "<同一candidateId>"` | 按该候选的事务恢复应用前内容，保留用户后续修改并报告冲突。 |

不要自行拼造 `Issue`、基线哈希或候选对象。`prepare --from` 必须引用这套 CLI 保存的扫描/导入结果，且工程一致。`scan` 的目录范围沿用 `scopePath`/规则；导入报告的范围是报告涉及的文件集合。历史回滚不要求用户仍选中原来的检测问题。

## 输出与进程状态

stdout 是单个 JSON 结果；stderr 提供阶段事件。成功操作的公共外层包括：

```json
{
  "ok": true,
  "command": "execute",
  "projectRoot": "D:/harmonyos/MyApplication",
  "result": {},
  "responseFile": "D:/arkts-runs/skill-results/实际结果文件.json"
}
```

`result` 随命令变化：检测返回 `issues`，准备返回风险和 `taskHandle`，执行/验证返回后端流水线结果及候选，事务命令返回实际应用/恢复状态。不要把外层 `ok` 当作门禁结论；读取本轮流水线的 `verdict` 和具体步骤。

以下路径均从 stdout 的最外层 JSON 开始：

| 需要读取的内容 | 字段路径 |
| --- | --- |
| `doctor` 检测/重构能力 | `result.environment.canDetect` / `result.environment.canRefactor` |
| 检测问题 | `result.issues`，问题身份是各项的 `issueId` |
| 后续准备使用的证据文件 | `responseFile` |
| 准备结果与风险 | `result.taskHandle` / `result.risk` |
| 执行或候选复检返回的候选 | `result.candidate.candidateId` |
| 执行、候选复检、应用后复检的本轮判定 | `result.result.verdict` / `result.result.steps` |
| 应用、回滚的事务状态 | `result.transaction.state`，冲突见 `result.transaction.conflicts` |
| 历史列表 | `result.records` |
| 恢复查看的候选与事务 | `result.candidate` / `result.transaction`，未应用时事务可能不存在 |

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令完成；仍需读取结果判断检测数、环境能力和事务状态。 |
| `2` | 参数、桥接或执行错误；读取错误对象和已保留的证据。 |
| `3` | 操作得到有效结果，但门禁未通过或回滚存在冲突。仍需读取完整 JSON。 |

长任务应使用宿主支持的后台命令/等待机制持续读取状态，直到退出或用户取消。CLI 的取消会交给共享桥接客户端终止后端进程树。中断后的历史记录不代表完成；通过 `history` 恢复查看证据，不能自动重试原工程写入。

## 最小串联示例

1. `scan` 返回问题与 `responseFile`，在对话中展示问题并记录用户选择的 `issueId`。
2. `prepare --from … --issue …` 返回风险及 `taskHandle`；解释建议后按已有授权执行 `execute --task …`。
3. 从执行结果取得 `candidateId`，调用 `diff` 并解释门禁结果；若 `FAIL/BLOCKED/INCOMPLETE`，报告原因，不应用。
4. 用户选择应用且结果为 `PASS` 时，调用 `apply --candidate … --confirm …`，随后调用 `validate-applied`。
5. 如用户选择恢复，使用相同候选 ID 调用 `rollback`。结束时给出实际事务状态与证据路径。
