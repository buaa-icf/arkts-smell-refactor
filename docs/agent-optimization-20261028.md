# 2026-10-28 Agent 优化：日志依据、实现与复跑

> 2026-10-29 更新：本文 low/high 命令仅作历史记录，不再执行。已确认 1012 基线使用自定义提供者；当前项目默认 `zhipu-coding/glm-5` 并禁用 `deveco` 自带提供者。请使用 [1012 基线核查与路由修复](baseline-1012-model-audit-20261029.md) 中的命令。

本轮已完成代码修改和本地回归，未运行真实重构实验，不能据此宣称达标率已达到 70%。没有执行 `tools` 下的任何脚本，也排除了会调用这些脚本副本的 `tests/test_experiment_scripts.py`。

## 依据与验收口径

输入为 `C:/Users/RoyCai/Desktop/最新版日志/{long_method,code_clone}/runs` 中的 25 / 30 份任务结果及 Agent 日志，对照 `C:/Users/RoyCai/Desktop/group_project/TestResult1012` 的两份报告和终端输出。沿用报告选定的有效运行，不以旧批次数据替换最新版。

| 分组 | 最终通过 | 420 秒内 PASS | 达标率 | 达到 70% 的最低条数 |
|---|---:|---:|---:|---:|
| Long Method | 24/25 | 16/25 | 64.0% | 18/25，净增 2 条 |
| Code Clone 同类 | 15/15 | 9/15 | 60.0% | 11/15，净增 2 条 |
| Code Clone 同类及顶层 Builder | 16/16 | 10/16 | 62.5% | 12/16，净增 2 条 |

Code Clone 跨类为 10/14 在 900 秒内通过（71.4%），不并入类内指标。计时仍取终端 `RESULT totalSeconds`，包括快照准备、编排、首轮、返修和全部实际门禁；最终 PASS 且原始秒数 ≤420 才算类内成功，不能把 420.300 四舍五入为达标。失败、BLOCKED、未完成和超时均留在预先固定的分母中。

## 日志中的具体问题

1. **正常 Agent 流程耗时占主要部分。** Long Method 首轮加评审 7399.378 秒，占端到端 68.4%；Code Clone 为 14329.511 秒，占 78.7%。LM Local 的 8 条全部零返修通过，但 7 条超时。不能只靠少跑一次 Linter 解决。
2. **内部构建工具没有产生成功证据。** 汇总 `*agent*.log` 的结构化 tool 事件，LM 的 `build_project` 为 19 次、CC 为 33 次，52 次全部报 `An error occurred in Effect.tryPromise`。这是 Agent 内置工具失败，不是平台构建失败，也不能从这个通用异常断定 SDK 的根因。随后部分 `arkts_check` 结果含 SDK `@arkts.lang.d.ets` 的解析诊断，形成额外探索；平台之后仍运行正式构建和测试。
3. **403 来自查文档的扩散。** `code_clone/runs/20261012-212358/code-clone-0001-EditNamePageVM/refactor-agent.log` 第 14 行先执行文档 CLI，第 28、31、34、37、40、44、47 行执行 7 次 webfetch。目的为确认 `@ObservedV2/@Monitor` 继承语义；网页缺内容、多个 404 后，第 40 行访问 GitHub code search API 返回 403，随后还改用代理。这不是模型 API 鉴权失败。现有证据不能确定 GitHub 403 是鉴权、限额还是其他策略。第一次抓取到最后一次结束相隔约 150.8 秒，其中工具记录的直接执行时间合计约 12.8 秒，其余不能全部归为网络等待。该任务首轮 980.699 秒，之后还有两轮类型返修，禁止网页不等于能独自省掉全部超时。
4. **另一条文档探索发生在类内 TimeCtrl。** `code_clone/runs/20261010-233406/code-clone-0001-TimeCtrl/refactor-agent.log` 第 5、8、11 行尝试寻找文档 CLI，第 25、28 行抓取 Builder 文档。本批 CC 共 9 次 webfetch，均集中在上述两条；LM 没有 webfetch。因此网页问题不能解释所有超时。
5. **不知道检测规则会增加探索和返修。** 上述 VM 日志第 17～19 行试图在业务工作区找 clone 规则。CC-I014 首轮留下 100 tokens / 21 行克隆，修复 Agent 又花 574.700 秒。LM-I015 首轮留下 90 行的 UI build（Max=80），其后又因分号/尾逗号返修。UI 只降到硬阈值 120 行以内仍会报 warning，不能通过当前 smell 门禁。
6. **Linter 摘要已有，但不是完整配置展开。** 原实现摘录显式命名、分号、尾逗号等规则，没有展开继承 ruleSet；还遗漏了 `object-property-newline`。LM-I014 日志含该规则及 `foreach-args-check`。ForEach 缺 key 与行为等价可能有冲突，不能为通过 Linter 随手新增 index-only key。

CC-L003 的返修是 Local Test 编译发现公共字段可空类型问题、随后生产构建再次类型不匹配；与 403 不是同一个故障。继续保留公共成员、可空性、状态/生命周期和抽取类型约束，不能用类型断言掩盖问题来换取提速。

## 实现

- `agent_runtime.py` 统一启动重构、返修、评审进程，通过进程级 `DEVECO_CONFIG_CONTENT` 合并工具开关及显式 deny：`webfetch`、`websearch`、`build_project`、`arkts_check`。没有改写用户全局 DevEco 配置。已有 inline provider/options/其他权限保留，含凭据的合并配置不写入日志或任务产物。格式非法时明确失败，不静默丢弃原配置。
- Prompt 要求只使用本地生产代码与平台附件，不调用文档 CLI、远程 MCP、curl 或代理；缺少新机制的语义证据时缩小抽取边界，优先保留原装饰器、状态归属及宿主 Builder，不反复枚举新架构。保留必要的类型/副作用核对；不能证明等价仍须报告。工具开关约束上述内置工具，shell/远程 MCP 的联网限制是提示词要求，并非操作系统网络沙箱。
- Agent 完成全部编辑后做源码自查并交回；正式 HomeCheck、构建、公共契约、测试、按配置执行的 Linter、独立语义评审仍由平台负责。没有放宽 verdict、检测阈值、超时、返修次数或评审证据标准。
- 新增 `analysis/long_method.py`：传递报告 Current/Max、去注释/空行/纯大括号的行数口径、普通 50 行及 UI 80/120 双阈值，并提醒原入口和 helper 都要按职责拆分、不能搬移或压行规避。
- `analysis/code_clone.py` 增加默认 token 判据、归一化行为、跨方法窗口及兼容外壳残留风险；提醒不能靠改名或改变字面量去重。它的词法相似度不是 HomeCheck 判定结果。
- 两种规则通过专项画像进入首轮、返修和评审。LM 也支持缺少新画像的旧任务生成提示。规则说明区分已核对的默认值、原始报告证据和最终门禁，没有实现第二套近似检测器来替代 HomeCheck。
- `linter_profile.py` 补充显式 `object-property-newline` 和 `foreach-args-check` 摘录；继承 ruleSet 仍未自动展开，实际 Linter 继续裁决。保留“不改变 ForEach 键语义”的约束。

阈值来自本机 HomeCheck 的源码、规则文档及实际 `.tgz` 内实现三方核对。包路径为 `../arkts异味检查工具/homecheck-extrule/extrulesproject-1.0.0.tgz`，SHA-256 为 `db9cae7b5488b0edfc2f10fcd0ef7c93ef916d0e567519c676bc48429047ef4d`。更换规则包或自定义规则选项后需要重新核对，摘要不保证适用于所有版本。平台实际扫描目标及修改/新增生产文件，并按原目标及变更关联过滤结果。

## 模型推理配置

本机 DevEco Code 为 0.2.4。已执行只读的 `deveco run --help`、`deveco models deveco --verbose`，并用 `debug agent build` 验证临时权限解析；没有调用模型生成。模型目录结果为：

| 模型 | 支持的 variant | 目录中的默认选项 |
|---|---|---|
| `deveco/GLM-5.3` | `low`、`high`、`max` | `reasoningEffort: high` |
| `deveco/GLM-5.1` | 无 | 无显式 effort |

`--thinking` 只是显示思考块，不降低推理。`--variant low` 在已核对的 GLM-5.3 目录中映射到 `reasoningEffort: low`；不能把这个选项视为所有模型通用。关于 variant 和工具配置亦可参见 [OpenCode 模型说明](https://docs.opencode.ai/docs/models/)及[工具权限说明](https://opencode.ai/docs/tools/)，DevEco 以本机帮助和解析结果为准。

`start` 新增四个参数，并提供供现有批跑脚本继承的环境变量：

| CLI 参数 | 环境变量 | 影响 |
|---|---|---|
| `--refactor-model` | `ARKTS_REFACTOR_MODEL` | 首轮及所有返修模型 |
| `--refactor-variant` | `ARKTS_REFACTOR_VARIANT` | 首轮及所有返修推理档位 |
| `--review-model` | `ARKTS_REVIEW_MODEL` | 独立评审模型 |
| `--review-variant` | `ARKTS_REVIEW_VARIANT` | 独立评审推理档位 |

显式 CLI 参数优先，未配置则沿用 CLI 默认，不自动切换模型，也不向不支持档位的模型强塞参数。`result.json`、`summary.json` 的 `agentPolicy` 及任务中的 `*-execution-policy.json` 保存策略版本和**请求值**。`providerSettingsVerified=false` 表示没有通过真实模型响应验证服务端实际推理行为，不能把配置文件当作提速证据。补充核查已通过日志 sessionID 查明 1012 基线记录为 `zhipu-coding/glm-5`、variant `default`；当前该 ID 的显示名称为 GLM-5.3。此前的实验改变了提供者/模型 ID，不能视为只改变推理档位的对照，详见 [1012 基线模型核查](baseline-1012-model-audit-20261029.md)。

## 交给用户执行的命令

以下均未代跑。脚本原有默认是 `-LinterMode skip`，这里显式用 `required`，保持与 TestResult1012 一致。四个脚本及回滚逻辑没有修改。日志留在不同目录，任务源代码由脚本按预运行快照恢复。

先在相同版本和源码基线上，对四条边界样本做 high/low 对照；评审固定 high。LM-L001 原为 420.300 秒、LM-L004 为 453.704 秒；CC-I024/025 为 511.938/514.622 秒。它们只是定向验证样本，不能替代全批指标。

```powershell
Set-Location 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$env:ARKTS_REFACTOR_MODEL = 'deveco/GLM-5.3'
$env:ARKTS_REVIEW_MODEL = 'deveco/GLM-5.3'
$env:ARKTS_REVIEW_VARIANT = 'high'

foreach ($effort in @('high', 'low')) {
  $env:ARKTS_REFACTOR_VARIANT = $effort
  $logDir = Join-Path $PWD "reports\agent-opt-20261028\$effort"
  foreach ($i in @(1, 4)) {
    .\tools\run_long_method_local.ps1 -StartOrdinal $i -EndOrdinal $i -LinterMode required -LogDirectory $logDir
  }
  foreach ($i in @(24, 25)) {
    .\tools\run_code_clone_instrument.ps1 -StartOrdinal $i -EndOrdinal $i -LinterMode required -LogDirectory $logDir
  }
}
```

同一轮全先 high 后 low 会受热缓存和服务波动影响；需要重复对照时交换执行顺序、保留所有结果，不挑最快一次。补充核查后，不再建议通过清空四个变量猜测历史默认模型；恢复基线路由应显式指定 `zhipu-coding/glm-5`，只清除两个 variant 变量，具体命令见 [1012 基线模型核查](baseline-1012-model-audit-20261029.md)。

定向故障回归（使用选定档位，主要验证无重复工具调用、无网页探索及不增加返修）：

```powershell
$env:ARKTS_REFACTOR_VARIANT = 'low'
$logDir = Join-Path $PWD 'reports\agent-opt-20261028\regressions'
.\tools\run_code_clone_instrument.ps1 -StartOrdinal 15 -EndOrdinal 16 -LinterMode required -LogDirectory $logDir
.\tools\run_long_method_instrument.ps1 -StartOrdinal 14 -EndOrdinal 15 -LinterMode required -LogDirectory $logDir
.\tools\run_code_clone_local.ps1 -StartOrdinal 3 -EndOrdinal 3 -LinterMode required -LogDirectory $logDir
```

方向验证后，全量验收仍需固定全部 25 条 LM、30 条 CC，分别报告同类、跨类、顶层 Builder，关注原达标样本是否退化：

```powershell
$logDir = Join-Path $PWD 'reports\agent-opt-20261028\full-low'
.\tools\run_long_method_instrument.ps1 -StartOrdinal 1 -EndOrdinal 17 -LinterMode required -LogDirectory $logDir
.\tools\run_long_method_local.ps1 -StartOrdinal 1 -EndOrdinal 8 -LinterMode required -LogDirectory $logDir
.\tools\run_code_clone_instrument.ps1 -StartOrdinal 1 -EndOrdinal 27 -LinterMode required -LogDirectory $logDir
.\tools\run_code_clone_local.ps1 -StartOrdinal 1 -EndOrdinal 3 -LinterMode required -LogDirectory $logDir
```

同时检查 `verdict`、原始 `totalSeconds`、首轮/评审时间、返修次数/触发阶段和禁用工具事件数。模型 reasoning token 只作辅助指标，不能换算成实际节省秒数。若 low 增加返修或语义问题，保持同模型切回 high；本轮没有调整评审为 low。

## 已执行的验证与限制

- Python 本地回归 180 项通过，明确排除 `test_experiment_scripts.py`；其余测试未调用真实重构 Agent。
- CLI 帮助确认四个参数；本机 DevEco debug 确认 webfetch/websearch/build_project/arkts_check 的 deny 规则被加载，可见工具中的 webfetch/arkts_check 为 false。
- 回归覆盖首轮模型/variant 传递、返修继承而评审独立、环境配置保留、敏感配置不落盘、默认不伪造推理参数、LM 规则传到三个阶段以及 Linter 摘录。
- 还未验证真实请求的模型行为、真实端到端耗时和新达标率，需用户执行上面的批跑。
- 仓库已有的 README 合并冲突、暂存改动及外部报告未处理；本轮分析放在此独立文件中。
