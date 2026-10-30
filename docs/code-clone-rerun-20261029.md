# 2026-10-29：Code Clone 首批 low 实验复盘

> 后续五条 high 复跑已完成：3 PASS、2 BLOCKED，限时通过仍为 0/5。结果见 [high 复跑审计](code-clone-high-review-20261029.md)。本文 high 命令仅作历史记录；当前已按用户要求禁用 DevEco 自带提供者，使用 [自定义提供者复跑命令](baseline-1012-model-audit-20261029.md)。

这批结果不支持继续扩大 low 实验。先恢复 `deveco/GLM-5.3` 的 `high`，在修复平台问题后验证代表性失败样例。之前把 low 作为提速候选尚未得到真实实验支持，不能把参数降低当成耗时降低。

## 证据和口径

- 本批终端：`C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261028-220658-307.log`（UTF-16）。
- 完整任务：本仓库 `runs/20261028-220659` 至 `runs/20261028-235732` 对应的 10 个任务；核对 `result.json`、逐阶段日志、`failure-report-*.json`、生产差异及最终评审原文。
- 历史对照：`C:/Users/RoyCai/Desktop/group_project/TestResult1012/code-clone-experiment-20261012-entry-preservation.md` 中相同 ordinal 的 CC-I001～I010。它是历史对照，不是同模型、同版本的受控 A/B。
- 本批请求配置：首轮与返修 `deveco/GLM-5.3 / low`，评审 `deveco/GLM-5.3 / high`，Linter required。日志里的 reasoning token 在 high 评审中也为 0，不能据此认定模型没有推理。
- 秒数采用终端 `totalSeconds`，包含准备、重构、返修、门禁及评审；成功仍要求最终 PASS 且同类 ≤420 秒、跨类 ≤900 秒。保留原始失败结果，不把评审原文中的 PASS 手动改记为任务通过。

## 结果

| ordinal | 目标 | 分类 | 历史秒数 / 返修 | 本批秒数 | 本批返修 | 结果 / 限时达标 |
|---|---|---|---:|---:|---:|---|
| 1 | AboutPage | 同类 | 306.242 / 0 | 238.086 | 0 | PASS / 是 |
| 2 | DataManager | 跨类 | 675.393 / 0 | 1201.201 | 3 | BLOCKED / 否 |
| 3 | PersonalSetting | 同类 | 413.937 / 1 | 243.826 | 1 | PASS / 是 |
| 4 | QuickLogin | 同类 | 386.351 / 0 | 863.717 | 1 | PASS / 否 |
| 5 | PracticeMode | 跨类 | 1071.950 / 0 | 1118.997 | 0 | PASS / 否 |
| 6 | AuthenticationPage | 跨类 | 780.259 / 0 | 1012.686 | 1 | BLOCKED / 否 |
| 7 | CollectionPage | 跨类 | 622.795 / 0 | 588.681 | 0 | PASS / 是 |
| 8 | CollectionPage | 跨类 | 595.544 / 0 | 910.059 | 2 | PASS / 否 |
| 9 | CollectionPage | 跨类 | 437.962 / 0 | 442.376 | 0 | PASS / 是 |
| 10 | RecommendBar | 跨类 | 854.801 / 0 | 1201.851 | 1 | BLOCKED / 否 |

历史 10 条全部 PASS，仅 1 条返修 1 次；本批 7 PASS、3 BLOCKED，6 条发生返修，共 9 次。按各自限时汇总从 9/10 降到 4/10；这个混合比例不能代替分类指标。本批同类 2/3（66.7%，历史 3/3），跨类 2/7（28.6%，历史 6/7），更不能外推全部 15 条同类或全部 30 条 Code Clone 的成功率。

## 具体原因

| ordinal | 证据与判断 |
|---|---|
| 2 | 首轮回调被声明为 boolean，但实际返回 boolean 或 -1，构建失败；随后新增 private STORE 命名和分号触发 Linter；再后空名称查询的测试期望 1 条却返回 2 条。三次返修后评审撞上 1200 秒任务上限。存在真实类型、风格和行为问题。 |
| 3 | 新增代码缺少分号，返修后通过。 |
| 4 | 抽取后丢失 `quick_login_cover_privacy_checkbox`、`quick_login_cover_privacy_link_1`、`quick_login_default_privacy_text`。首轮 444.280 秒，已经超过同类总预算；还查询了工作区外 SDK，并用 git diff/status 误读工具仓库的 README 冲突及改动。 |
| 5 | 零返修仍耗时 1118.997 秒，其中首轮 855.698 秒，存在较多资源/类型探索。不能只靠减少返修解决。 |
| 6 | 首轮丢失 `authentication_page_content`，返修恢复。最终评审原文判 PASS，但 evidence 内双引号未转义，另有 JSON 不允许的单引号转义，导致解析失败。这里的 BLOCKED 是输出格式故障，不是任务超时；即使格式正常，1012.686 秒也已超跨类指标。 |
| 8 | 新增 DeleteButton 触发 `@performance/avoid-overusing-custom-component-check`；第一次返修改成 Builder 后仍链式调用 `.width`，构建报 `Property 'width' does not exist on type 'void'`。第二次返修后 PASS，但已超过 900 秒。 |
| 10 | 首轮遗漏原文案末尾私用区字符 U+E74D，独立评审正确判 FAIL，不应当作“乱码误报”。首次评审 481.285 秒；返修后再次评审时总任务超时。 |

本批已执行的 HomeCheck 阶段均通过，主要失败不在残余克隆。未发现 `webfetch`、`websearch`、`build_project`、`arkts_check` 工具事件，上一轮的工具限制有起效。shell 中仍存在越界探索，不能把提示词约束说成操作系统隔离。

low 与这次质量下降同时出现，足以暂停扩大实验，但提供者/模型 ID、CLI 和策略也变了，不能把全部差异归因为推理档位。后续精确关联会话查明，1012 基线为 `zhipu-coding/glm-5`、variant `default`、CLI 0.1.8，详见 [基线核查](baseline-1012-model-audit-20261029.md)。尤其第 6 条格式问题发生在 high 评审中。

## 本次代码修正

1. Code Clone UI ID 画像从跨行正则改为在屏蔽注释/字符串的源码上匹配括号，完整保留 `.id('prefix_' + index)`、变量及嵌套调用表达式，不再吞入后续属性链。提示词展示文件内的具体表达式及行号，覆盖检测范围之后的链式 ID；全文件线索不扩大允许修改范围。
2. 对包含 Unicode 私用区/格式字符的字符串提供转义证据，并要求保留原字符、代入 ID 参数核对、避免顺带改写过滤逻辑。画像是词法线索，不替代语义核对。
3. Agent 进程设置 Git 搜索上界并移除继承的 Git 仓库定位变量，避免无 `.git` 的隔离副本向上误认工具仓库。没有初始化新仓库或修改全局 Git 配置；显式越界命令仍依赖现有提示约束。
4. 评审只解析最后一条助手文本，不再从工具输出或先前答案捞取 verdict；重复 JSON 字段拒绝接受。提示词明确 JSON 转义要求。
5. 自动配置新增一次格式修复机会：仅对有明确 verdict、完整但无效的评审对象启用，使用评审的模型/档位，关闭全部工具，最多 90 秒且仍受原任务总截止时间限制。逐 token 核对只发生引号转义/排版变化，保留字符串内部空白、所有字段和结论；PASS 还必须具有一致的行为/异味/风险/issue 字段。改判、删减证据、格式仍错、进程失败都维持 BLOCKED。有效 FAIL 继续走语义返修，UNCERTAIN 不重做评审。`reviewFormatRetries` 与代码返修分别记录，不重跑门禁、不刷新总时限。

未调整 HomeCheck 判据、Linter required、测试、公共契约、业务 PASS 条件及限时指标。模型参数仍由 CLI/环境变量明确指定；代码没有静默覆盖用户选择的 low。

## 交给用户运行

建议先跑 2、4、6、8、10 五条，分别覆盖类型/过滤、UI ID、格式、Linter 返修和特殊字符。以下命令未代跑；本轮没有执行 `tools` 下的脚本。

```powershell
Set-Location 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$env:ARKTS_REFACTOR_MODEL = 'deveco/GLM-5.3'
$env:ARKTS_REFACTOR_VARIANT = 'high'
$env:ARKTS_REVIEW_MODEL = 'deveco/GLM-5.3'
$env:ARKTS_REVIEW_VARIANT = 'high'
$logDir = Join-Path $PWD ('reports\cc-high-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($i in @(2, 4, 6, 8, 10)) {
  .\tools\run_code_clone_instrument.ps1 -StartOrdinal $i -EndOrdinal $i -LinterMode required -LogDirectory $logDir
}
```

这是新策略的故障回归，不是只改变一个变量的 high/low 对照。先看首轮质量能否恢复，再看总耗时；需要测档位因果时必须固定本轮代码、同模型、同源码基线和评审设置，并交换运行顺序。回归稳定后仍需完整同类样本验证 420 秒内 ≥70%，不能用这五条代替验收。

检查每条 `result.json` 的 `agentPolicy`、`repairAttempts`、`reviewFormatRetries`，及终端原始 `totalSeconds`。特别记录首轮/评审耗时，避免忽略第 5、10 条暴露的长时间探索。

## 已验证与尚未验证

- 193 项 Python 单元测试通过；明确排除 `test_experiment_scripts.py`。临时目录移至工作区后通过，系统沙箱临时目录曾拒绝写入，这不是产品测试失败。
- 本机 DevEco 只读 `debug agent arkts-review-format` 确认所列工具均为 false，包括 bash/read/edit/write/task/skill。未调用模型生成。
- 第 6 条真实评审原文只读检查证实可通过补正引号转义得到合法且内容保留的对象；未改写历史任务产物。
- 未验证新增格式修复的真实模型表现、恢复 high 后的首轮质量及实际成功率，等待上述用户复跑。
- 保留仓库原有 README 合并冲突与既有暂存改动。
