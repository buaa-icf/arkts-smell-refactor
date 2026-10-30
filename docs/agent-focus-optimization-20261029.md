# 2026-10-29：减少重复探索与补全 Linter 指导

> 实测更新：三条复跑仍为 0/3 限时通过，合计耗时比上轮同三条增加约 24.9%。见 [focus-v2 复跑复盘](code-clone-focus-v2-review-20261029.md)。下方命令仅作历史记录；当前已按用户要求禁用 DevEco 自带提供者，使用 [自定义提供者复跑命令](baseline-1012-model-audit-20261029.md)。

策略版本：`2026-10-29-focus-v2`。本轮针对 high 复跑审计发现的问题修改实现，未执行真实模型重构、构建测试批跑或任何 `tools` 脚本。

high 是同一模型的请求档位，不能保证约束执行正确或耗时下降。此前同五条返修从 8 次降到 3 次，说明质量有改善；首轮仍可能耗时约 1000 秒。除了模型的执行稳定性，本轮发现了可消除的无关上下文，以及可交给确定性代码的重复检查，因此先固定 high 验证这些修正。

## 修改内容

### 1. 缩小技能上下文

本机 DevEco 0.2.4 的只读 `debug skill` 对比：

| 设置 | 可用技能数 | description 字段字符总数 |
|---|---:|---:|
| 原默认 | 207 | 111335 |
| `DEVECO_DISABLE_EXTERNAL_SKILLS=1` | 5 | 1852 |

默认目录中包含大量与 ArkTS 无关的 MATLAB/Simulink 技能。开关来自本机 CLI 自带实现和帮助材料，已通过解析结果核对；保留的五项为三个 HarmonyOS 内置技能、deveco-cli、customize-deveco。只对流水线启动的子进程设置环境变量，不改写全局设置或删除技能，不禁用内置技能。首轮、返修、评审和 JSON 格式修复统一使用该策略，执行记录增加 `externalSkillsDisabled`。

上述是技能目录测量，不等同于模型实际输入 token 减少量或已证明的提速比例。原工具限制、模型选择、档位和门禁没有改动。

### 2. 把可机械比较的长文案提前比较

新增 `analysis/literals.py`，在 Code Clone 原始实例范围内识别长的静态字符串片段及仅用 `+` 连接的字符串序列，给出原始行列范围、短预览、字符串个数和 SHA-256。注释与连接空白不进入指纹；字符串内部字符、转义写法、私用区字符都原样保留，不执行源码或求值动态表达式、模板字符串。

相同 token 序列可以作为重构前片段一致的证据；不同指纹不能推出运行值不同。证据只覆盖所列字面量片段，不覆盖外层表达式和整个重构的行为。首轮、返修和独立评审均能获得这份证据；旧行号漂移时仍须按当前代码定位，不能照搬陈旧范围。

对真实 AuthenticationPage 只读核对：两个实例分别是 L18–67、L23–72，均含 50 个字符串 token，指纹同为 `b77c7f2236930357a3a0e0bc90b436ed904f788b743604fda44f1973704e61a4`。Agent 无须再次反复编写行号切片和正则来证明原文本相同。

### 3. 让探索和交回检查有明确终点

提示词改为批量读取已知实例、确定一个最小抽取方案、编辑全部实例、一轮定向源码自查、交回平台。只有出现具体缺口或矛盾才追加读取，不能为了减少步骤忽略必要证据。避免目录/资源遍历、重复证明已确认的类型和 ID、反复比较无关架构。

Code Clone 的纯 UI 共同片段优先使用保留宿主容器、属性链、ID、回调的 Builder；重复长文案优先考虑共享常量，再由实际 HomeCheck 判断是否仍需进一步抽取。交回前检查定义端 `export`、Index 再导出、消费端 import 三处一致，防止本轮 AuthenticationPage 的漏 export。

源码读取优先用 read；PowerShell 明确 UTF8 编码，避免 `$HOME/$home` 内置变量冲突。不让 Agent 为 BOM 和统一换行往返多轮。平台同步时保留已有 UTF-8 文件的 BOM，并对普通源码恢复原统一 CRLF/LF；二进制资源、新文件不适配，非 UTF-8 不转码，混合换行、模板或续行表达式不做换行重写。适配后的生产代码进入原有门禁和独立评审；基线原字节不变，记录 `sourceFormatsPreserved`。

### 4. 补全具体 Linter 约束

平台通过当前 PATH 中的 codelinter 定位本机 `linter/*/ruleSet.json`，只读展开已知关注规则，不执行 Linter 脚本。本机 `arkPerfCheck/ruleSet.json` 确认 `plugin:@performance/recommended` 包含 `avoid-overusing-custom-component-check`，提示中保留来源和配置值。

- 对已启用性能规则，明确纯展示、无独立状态/生命周期的共同 UI 优先 Builder；不能把需要状态/生命周期的组件强制替换，也不能在返回 void 的 Builder 上链式调用 width/height。
- 对明确的 private 命名选择器，给出 `STORE → _STORE` 的生成提示，提醒 UPPER_CASE 不豁免前导下划线，公共 API 不随意改名。
- 对分号规则，提示逐行核对新增字段、声明、赋值、return，不复制旧代码的漏分号；显式 never 不机械补分号。
- 显式 rules 覆盖继承项，off/0 不生成启用提示；存在条件 overrides 时保留原配置，不生成无条件执行清单。未找到规则目录不会猜测已启用规则，未展开的规则仍由实际 Linter 裁决。

## 已执行验证

- 206 项 Python 本地测试通过，排除 `tests/test_experiment_scripts.py`，未调用真实 Agent。
- 覆盖本机规则目录解析、显式关闭、条件覆盖、命名选择器过滤、semi=never；长文本注释/模板/动态操作数/特殊字符及范围；同步适配时基线与资源保护；三个提示阶段的证据传递。
- 用五条真实任务的恢复后生产源码只读生成新画像和提示：DataManager 收到 `_STORE` 提示，CollectionPage 收到 Builder 性能规则，AuthenticationPage 收到上述长文本证据。
- DevEco 技能目录的只读对比通过。没有将技能目录字符数当作实际推理 token 或端到端耗时。
- `git diff --check -- src tests` 通过；原 README 合并冲突与既有暂存改动保留。

## 交给用户的复跑命令

先保持与上轮相同的 GLM-5.3 high/high 和 Linter required，跑三条：4 检查同类 420 秒预算，6 检查长文本与探索耗时，8 检查性能规则是否避免首轮返修。以下命令未代跑。

```powershell
Set-Location 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$env:ARKTS_REFACTOR_MODEL = 'deveco/GLM-5.3'
$env:ARKTS_REFACTOR_VARIANT = 'high'
$env:ARKTS_REVIEW_MODEL = 'deveco/GLM-5.3'
$env:ARKTS_REVIEW_VARIANT = 'high'
$logDir = Join-Path $PWD ('reports\cc-focus-v2-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($i in @(4, 6, 8)) {
  .\tools\run_code_clone_instrument.ps1 -StartOrdinal $i -EndOrdinal $i -LinterMode required -LogDirectory $logDir
}
```

重点核对：新策略版本及 `externalSkillsDisabled=true`、首轮/评审时间、首轮 Linter 和构建是否通过、重复编码/换行/字符串比对工具调用、总耗时与返修次数。随后补 2、10 验证命名和特殊字符回归，再决定是否全批验收。三个样例不能替代全部同类 ≥70% 的验收；本轮实现尚未证明实际提速或达标。
