# 1012 基线模型与推理档位核查（2026-10-29）

> 2026-10-30 补充：官方确认 GLM-5.3 不传 effort 时默认 max，本地 `variants={}` 不代表服务端没有档位。下文“没有显式 max”仅指客户端记录，不能排除基线实际使用服务端 max。已补齐 Coding Plan 档位映射，最新方案见 [high/max 对照](coding-plan-high-trial-20261030.md)。项目继续默认使用用户 `deveco.jsonc` 配置的 `zhipu-coding/glm-5`，禁用 DevEco 自带提供者。

结论：1012 基线没有显式使用 `max` 的记录。报告选定的 55 个任务、117 个 Agent 会话全部记录为 `zhipu-coding/glm-5`、`variant=default`、DevEco `0.1.8`。即使仅取 **10 月 12 日当天**执行的 11 个任务、24 个会话，结论也相同。`default` 不能证明服务端实际推理预算大小，因此不能进一步断言默认预算低于或等于 max。

## 只使用 1012 报告选定的有效结果

本次不纳入更早报告的其他尝试，也不通过文件名相同的旧会话猜测模型。核查来源为：

- [1012 Code Clone 报告](<C:/Users/RoyCai/Desktop/group_project/TestResult1012/code-clone-experiment-20261012-entry-preservation.md>)。
- [1012 Long Method 报告](<C:/Users/RoyCai/Desktop/group_project/TestResult1012/long-method-experiment-20261012.md>)。
- 两份报告明确采用的运行目录及 `最新版日志` 中对应的 `*agent*.log`。
- `C:/Users/RoyCai/.local/share/deveco/deveco.db` 的只读会话及消息元数据。

1012 是汇总报告日期，不代表所有样例都在当天运行。报告选用的 Code Clone Instrument 结果实际在 10 月 10～11 日；Long Method Instrument 在 10 月 9 日；两种 Local 在 10 月 12 日。这里仅沿用这两份最新报告明确选定的结果。

逐任务核对报告中的运行路径，再从日志提取 `sessionID`，精确查询会话，不按标题模糊匹配。全部会话均存在；会话模型与 assistant 消息中的 `providerID/modelID` 一致。用户消息没有显式 variant 字段，会话存储值为 `default`。

| 范围 | 任务数 | Agent 会话数 | 模型 / 提供者标识 | 会话 variant | CLI |
|---|---:|---:|---|---|---|
| 1012 两份报告全部有效结果 | 55 | 117 | `zhipu-coding/glm-5` | `default` | 0.1.8 |
| 其中仅 10 月 12 日当天的有效结果 | 11 | 24 | `zhipu-coding/glm-5` | `default` | 0.1.8 |
| 10 月 29 日下午 focus-v2 三条 | 3 | 6 | `deveco/GLM-5.3` | `high` | 0.2.4 |

本机逐任务审计清单保存在 `.codex_tmp/baseline-1012-selected-model-audit.json`，只含路径、耗时、会话标识和模型元数据，不含凭据或完整提示词。

可复核的 1012 当天记录：

| 样例 | 运行目录 | 首轮 sessionID | 评审 sessionID |
|---|---|---|---|
| CC-L001 | `20261012-210928/code-clone-0001-CartPageLogic` | `ses_ecfc47657ffeBxBCUc5fKVf7mg` | `ses_ecfbf5cf8ffe8TplOU5kBYrLpK` |
| LM-L001 | `20261012-164256/long-method-0001-accessibilityConfigSetting` | `ses_ed0b868acffem5uAPQjuZrtw4q` | `ses_ed0b38200ffeFJDW5m3DbNURdB` |

## 模型 ID 与显示名称不能混用

只读检查当前 DevEco 0.2.4 的 `models zhipu-coding --verbose` 和有效配置后确认：

- 当前仍有 `zhipu-coding/glm-5`，其配置中的显示名称是 **GLM-5.3**。
- 它是 `@ai-sdk/openai-compatible` 自定义提供者配置，当前模型目录的 `api.id` 为 `glm-5`。
- 当时该条目的 `variants={}`、`options={}`，没有本地已配置的 low/high/max 档位。这不表示服务端不支持这些档位；2026-10-30 已按官方规则补齐映射并用本机 HTTP 模拟接口验证。目录的 reasoning 能力标志也不能单独证明服务端没有推理。
- 当前配置不能代替 10 月 12 日的服务端请求配置，更不能恢复当时服务端将模型 ID 路由到哪个具体版本。

因此，先前仅凭 ID 将历史模型称为“GLM-5”，或断言底层模型必然发生版本切换，都超出了现有证据。能够确认的是 **提供者、模型 ID、显式档位和 CLI 版本不同**。此前直接选用 `deveco/GLM-5.3` 做 low/high 实验，没有固定历史路由，不能将和 1012 基线的差异全部归因于推理程度。

## 下一步：先恢复基线路由做小样本验证

当前不继续增加提示词、降低推理档位或盲设输出 token 上限。保留已有 UI ID、字面量、Linter 规则及工具限制修正，以当前代码和 CLI 切回基线的提供者/模型 ID，清除两个阶段残留的 variant 环境变量。不要传入字符串 `default` 冒充支持的档位。

先跑 CC-I004（同类，420 秒）和 CC-I008（跨类，900 秒）：前者检查同类预算，后者是上一轮没有网络重试但首轮生成很慢的样例。CC-I008 不计入同类成功率。命令由用户执行，本次未代跑：

```powershell
Set-Location 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$env:ARKTS_REFACTOR_MODEL = 'zhipu-coding/glm-5'
$env:ARKTS_REVIEW_MODEL = 'zhipu-coding/glm-5'
Remove-Item Env:ARKTS_REFACTOR_VARIANT -ErrorAction SilentlyContinue
Remove-Item Env:ARKTS_REVIEW_VARIANT -ErrorAction SilentlyContinue
$logDir = Join-Path $PWD ('reports\cc-baseline-route-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($i in @(4, 8)) {
  .\tools\run_code_clone_instrument.ps1 -StartOrdinal $i -EndOrdinal $i -LinterMode required -LogDirectory $logDir
}
```

以上只恢复提供者/模型 ID 与不显式指定档位，不是完整复现历史 CLI、提示词和服务状态。它先检验当前实现下这个路由是否有实用价值；若需证明路由导致提速，还须在同一版本、同一源码和相近运行条件下交替复测两个路由。不能拿这一轮与两周前的单次耗时直接下因果结论。

复盘看真实总耗时、首轮和评审耗时、输出量、返修和最终 PASS；网络重试单列，但不从正式指标中扣除。两条通过也不能替代完整同类样本 420 秒内至少 70% 的验收。当前没有新实验结果，不宣称已经提速。

本次仅审计和更新文档，没有修改全局模型配置、生产源码、验收门禁或历史结果；没有执行 `tools` 下任何脚本，也没有调用真实模型生成。

## 用户确认后的路由修复

已只读核对用户指定的 `C:/Users/RoyCai/.config/deveco/deveco.jsonc`：它配置了 `zhipu-coding/glm-5`，没有顶层 `model`、`small_model` 或 agent 模型覆盖。提供者注册不等同于强制选择该模型。之前给出的实验命令将两个 `ARKTS_*_MODEL` 环境变量设为 `deveco/GLM-5.3`，程序再将它们转成显式 `-m` 参数，导致选择 DevEco 自带提供者；不是用户的自定义配置失效。

用户明确要求使用自定义提供者后，已在仓库中完成以下修复，全局配置和密钥不作修改：

- 首轮、返修、评审和评审格式修复默认显式指定 `zhipu-coding/glm-5`；`start`、自动配置和直接 gate 调用均覆盖，不再依赖 CLI 最近使用的模型。
- 显式 CLI 参数仍优先于对应环境变量；两者均未配置模型时使用上述项目默认。不自动添加 low/high/max。
- 进程内合并 `disabled_providers: ["deveco"]`，保留用户已有禁用列表、提供者及其他设置；不写回配置文件。
- 选择 `deveco/…` 时在模型调用前报错，并提示修正环境变量；`start` 在读取任务前检查两个阶段，避免跑完首轮后才发现评审选错模型。
- 执行策略记录显式模型和禁用提供者，策略版本更新为 `2026-10-29-custom-provider`。已有历史结果不改写。

验证：210 项本地测试通过（排除会执行实验脚本的 `test_experiment_scripts.py`）。本机 CLI 只读 `debug config` 验证配置合并有效，`models` 验证自定义模型存在且没有 `deveco/` 条目。没有运行真实模型或 `tools` 脚本，尚无修正路由后的耗时结论。
