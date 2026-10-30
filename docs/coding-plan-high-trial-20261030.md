# 智谱 Coding Plan：重构 high / max 对照（2026-10-30）

> 实测已完成：high 439.346 秒、max 443.818 秒，均 PASS、零返修但超过 420 秒；max 的首轮重构更快，评审耗时抵消了优势。见 [复跑分析](coding-plan-high-max-review-20261030.md)。下方命令保留为本轮方案，不据此直接扩大 high 全批。

本次固定使用用户配置的 `zhipu-coding/glm-5`。只比较重构及返修的 high / max；评审和评审格式修复不传档位，保留服务端默认。DevEco 自带提供者仍被禁用。策略版本为 `2026-10-30-coding-plan-effort`。

## 官方规则与历史结论修正

[GLM-5.3 官方说明](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)明确列出 `reasoning_effort` 支持 low/high/max，默认 max，复杂 Coding 任务推荐 max。[Coding Plan 档位说明](https://docs.bigmodel.cn/cn/coding-plan/latest-model)也说明了显式 effort 优先于 thinking 开关和默认档位。

本地 `variants={}` 只表示客户端没有定义档位预设，不能推出服务端不支持推理档位。1012 会话的 `variant=default` 完全可能对应服务端默认 max。此前“没有显式 max 记录”只能描述客户端记录，不能解读为“基线服务端不是 max”。历史请求体及底层模型路由未完整保存，仍不能把全部历史记录直接重标为已验证的 max。

此前 `deveco/GLM-5.3` 的 low/high 实验改变了提供者，不能替代本次 Coding Plan 内部的 high/max 对照。这里保持用户现有模型 ID、端点和凭据，不擅自将 `glm-5` 改为另一个 ID。

## 实现与请求体验证

`agent_runtime.py` 在显式选择 `zhipu-coding/glm-5` 的 low/high/max 时，仅向当前 Agent 子进程的 `DEVECO_CONFIG_CONTENT` 合并所选档位。例如 high：

```json
{
  "provider": {
    "zhipu-coding": {
      "models": {
        "glm-5": {
          "variants": {
            "high": { "reasoningEffort": "high" }
          }
        }
      }
    }
  }
}
```

保留原有 API 地址、密钥及无关配置；不写回用户 `deveco.jsonc`。显式选择覆盖该档位中旧的 effort 写法，拼错档位会报错，避免静默回退。其他自定义提供者仍走原有传参方式；没有选择档位时不添加 effort 配置。

使用当前安装的真实 DevEco CLI 和流水线的环境构造函数，将该提供者临时指向 `127.0.0.1` HTTP 模拟接口，并换成虚拟密钥。模拟接口只返回固定 OK，不转发请求、不执行工具、不调用真实模型。捕获到的请求白名单字段如下：

| CLI 档位 | 发出的 model | 实际 HTTP `reasoning_effort` |
|---|---|---|
| 不传 | `glm-5` | 不存在 |
| low | `glm-5` | `low` |
| high | `glm-5` | `high` |
| max | `glm-5` | `max` |

因此已验证客户端到 HTTP 请求体的映射，不仅是配置文本里出现 high。该模拟验证不证明智谱服务端实际采用的预算或重构表现。记录在 `.codex_tmp/zhipu-effort-request-probe.json`；执行策略新增 `requestedReasoningEffort`，仍保留 `providerSettingsVerified=false`，不将请求值冒充服务端验证结果。

214 项本地测试通过，排除 `test_experiment_scripts.py`。覆盖配置和凭据保留、low/high/max 映射、拼错档位阻断、首轮与返修设置一致、评审独立、high 不泄漏到后续默认评审。本次没有改变提示词、异味判据、Linter、测试或验收时限。

## 用户执行：先测同类样例 4

QuickLogin 为同类 Code Clone，限时 420 秒。先 high 再 max，两轮均保持同一代码版本、提供者、模型 ID、评审设置及 Linter required，脚本按原有逻辑恢复各轮源码。这样比直接拿 high 与两周前的记录比较更有解释力。以下命令未代跑：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
Set-Location 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$env:ARKTS_REFACTOR_MODEL = 'zhipu-coding/glm-5'
$env:ARKTS_REVIEW_MODEL = 'zhipu-coding/glm-5'
Remove-Item Env:ARKTS_REVIEW_VARIANT -ErrorAction SilentlyContinue
$logDir = 'C:\Users\RoyCai\Desktop\group_project\TestResult1028'
foreach ($effort in @('high', 'max')) {
  $env:ARKTS_REFACTOR_VARIANT = $effort
  .\tools\run_code_clone_instrument.ps1 -StartOrdinal 4 -EndOrdinal 4 -LinterMode required -LogDirectory $logDir
}
$env:ARKTS_REFACTOR_VARIANT = 'high'
```

按用户要求，终端输出直接保存到 `TestResult1028`，不建立子目录，通过时间戳文件及其中的 Agent 配置区分 high/max；完整过程仍在仓库 `runs`。这里的 max 是重构阶段显式档位，评审两轮均不传档位。按官方当前 GLM-5.3 规则，未传 effort 且无关闭思考配置时服务端默认 max；上述模拟请求也确认当前不传档位时没有额外 effort/thinking 字段。

先核对模型、策略版本和 `requestedReasoningEffort`，再比较首轮耗时、返修次数、评审与机械门禁耗时以及最终 PASS 和端到端 420 秒。单样例的一次 high/max 只能筛选候选；若结果接近或有网络/设备波动，需要交换顺序复测，不能宣称高低档位的因果结论，更不能替代全部同类样本至少 70% 的验收。
