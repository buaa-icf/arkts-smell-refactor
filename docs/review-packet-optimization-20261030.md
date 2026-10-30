# 集中评审材料优化（2026-10-30）

> 16:06 复跑已完成：评审降到 55.072 秒、1 个模型步骤、零额外工具调用；端到端 422.822 秒仍超过 420 秒，首轮重构增长到 311.485 秒。见 [复跑分析](review-packet-rerun-20261030.md)。下文保留实现时的方案与本地验证记录。

针对最新 QuickLogin 配对实验中评审的 8～12 个模型步骤，把路径、diff、风险和机械门禁结论集中提供给评审 Agent，减少列目录、分批读前后源码及重复取诊断的往返。独立语义检查、模型配置、420 秒验收和成功率口径保持原状。实现已完成；尚未运行真实模型实验，不能宣称已提速或达到 70%。

## 实现

每次正常语义评审启动前，在本轮 `gates.json` 写好之后重新生成：

- `review-packet.json`：变化文件的前后精确路径、存在性、字节 SHA-256、行数、完整内联标记，生产依赖路径，以及门禁明细是否内联。
- `review-agent-prompt.md`：原独立评审指令，加材料清单、门禁摘要、完整风险列表、完整 diff 和容量允许的完整前后源码。源码带原文件行号，便于直接引用证据。

源码正文合计最多 50,000 字符、单文件最多 30,000 字符；diff 最多 16,000 字符；每份 JSON 证据最多 12,000 字符。这些是附件组织上限，不是模型推理或输出限制。超出时整项不内联，并明确给出补读路径，不静默截取前半部分。依赖实现保留精确路径，新增委托链仍需追到实际实现。没有相关缺口时不重复读取已完整提供的源码、列目录或查原始门禁日志。

前后源码的相同头尾行数只是文本比较结果，不替代行为等价判断。对资源变更补齐当前资源快照，通过变更清单和原始文件核对，不把二进制资源强行转换成文本 diff。缺少必要证据仍须 UNCERTAIN；机械门禁通过仍不能替代语义评审。

返修后重新组装当前源码和当前 attempt 的门禁；本轮跳过或未执行的门禁不会内联残留明细。必要材料损坏或缺失导致打包失败时输出 `REVIEW_PACKET_BLOCKED`，不启动模型，不触发代码返修。仅 JSON 格式修复继续使用原先的工具禁用流程，不带源码重做评审。

策略版本：`2026-10-30-review-packet`。评审执行策略记录 `reviewPacketAttached=true`、`promptTransport=stdin`，方便下一轮审计。

## CLI 传输验证

发现当前 DevEco 0.2.4 的 `-f` 会截断约 70 KB 的集中附件。使用真实 CLI、虚拟密钥及本机 HTTP 模拟接口验证，未连接真实模型服务：

| 传输方式 | 附件起始标记 | 附件末尾标记 | 1,188 条不同非空行中缺失数量 |
|---|---|---|---:|
| `-f` | 收到 | 缺失 | 263 |
| 标准输入 | 收到 | 收到 | 0 |

因此正式语义评审通过 UTF-8 标准输入传入整份材料，避免附件截断以及 Windows 命令行长度限制；仍保存完整 Markdown 供复查。重构、返修及格式修复的传输方式不变。这次验证只证明客户端传递完整，不证明实际模型会充分使用证据或减少耗时。

本地验证记录：`.codex_tmp/review-attachment-delivery.json`、`.codex_tmp/review-attachment-delivery-stdin.json`。

## 本地检查

在 `.codex_tmp` 中复制最新两轮的评审输入后生成材料，没有修改历史 `runs`。逐文件核对每轮 17 份原始材料的 SHA-256 未变。

| 来源 | 源码内联字符 | 完整提示词字符 | 完整提示词 UTF-8 字节 | 生成耗时 |
|---|---:|---:|---:|---:|
| high：20261030-110429 | 40,276 | 60,124 | 69,462 | 0.0156s |
| max：20261030-111150 | 40,255 | 60,647 | 69,985 | 0.0147s |

两轮的前后源码、diff 均完整内联，各列出 4 份生产依赖。此处耗时只是本机材料生成时间，不是模型评审耗时；这些单次测量不构成稳定性能基准。记录在 `.codex_tmp/review-packet-audit.json`。

226 项 Python 本地测试通过（8.812 秒），排除会执行实验脚本的 `test_experiment_scripts.py`。覆盖传输完整性、Unicode/BOM/换行、容量上限、增删文件和二进制资源、返修刷新、跳过门禁的残留结果、路径边界、材料损坏阻断及仅格式修复隔离。未执行 `tools` 下脚本、真实模型、构建或设备测试。

## 用户复跑

先固定重构为 max、评审不传档位，复跑同类 Code Clone 样例 4，与上一轮 max 的 443.818 秒对照。两端继续使用 `zhipu-coding/glm-5`，Linter required。以下命令交由用户执行，终端日志直接放在 `TestResult1028`：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
Set-Location 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$env:ARKTS_REFACTOR_MODEL = 'zhipu-coding/glm-5'
$env:ARKTS_REVIEW_MODEL = 'zhipu-coding/glm-5'
$env:ARKTS_REFACTOR_VARIANT = 'max'
Remove-Item Env:ARKTS_REVIEW_VARIANT -ErrorAction SilentlyContinue
.\tools\run_code_clone_instrument.ps1 -StartOrdinal 4 -EndOrdinal 4 -LinterMode required -LogDirectory 'C:\Users\RoyCai\Desktop\group_project\TestResult1028'
```

下一轮重点核对评审模型步骤、重复读取次数、评审耗时、返修数及真实 PASS 的端到端时间。首轮产物仍可能变化，单次快慢不能证明因果或整体成功率；先确认集中材料没有遗漏语义，再决定是否扩展批量样例。
