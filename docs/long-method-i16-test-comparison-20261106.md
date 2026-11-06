# 2026-11-06：LM-I16 原始代码与首次重构对照

用户执行了 [A 批审计](agent-blocked-batch-a-results-20261106.md) 中的诊断命令：原始代码 baseline、首次重构 initial 各两轮，共四次冻结设备测试。运行时间为北京时间 2026-11-06 10:38～10:41。

结论：**四次全部 PASS，没有复现稳定的重构回归。** 两种版本的用例耗时均约 13 秒，离原失败中的 15 秒期限只有约 2 秒。现有证据更支持测试时序敏感或设备状态波动这一排查方向，但不能据此确认具体慢在哪个 await，也不能证明首次重构在所有行为上等价。

## 实测结果

| 轮次 | 代码版本 | 用例结果 | 用例 consuming | 测试作业总耗时 |
|---|---|---|---:|---:|
| 1 | 原始 baseline | PASS，1/1 | 12.971 秒 | 47.604 秒 |
| 1 | 首次重构 initial | PASS，1/1 | 13.146 秒 | 45.757 秒 |
| 2 | 原始 baseline | PASS，1/1 | 13.007 秒 | 44.383 秒 |
| 2 | 首次重构 initial | PASS，1/1 | 13.001 秒 | 46.225 秒 |

每次实际执行 `GoodDetailPageTest.renders_package_good_detail_page`，均有 `result=Success`、完整 Hypium `Tests run: 1 ... Pass: 1`、`TestFinished-ResultCode: 0` 和设备结束标记，pendingJobs 为空。用例 consuming 来自各轮 coverage.log；右列包含构建、安装与测试，不是用例的 15 秒期限，也不是完整重构端到端时间。

原始版本两次平均 12.989 秒，首次重构两次平均 13.074 秒，差约 0.085 秒。四次样本不足以估计稳定失败概率，但没有出现首次重构持续显著变慢的证据。此前两次 `execute timeout 15000ms` 仍是有效历史失败，不能因这次通过而删除。

## 对上一轮判断的影响

- LM-I16 首轮生成的代码无需再次编辑，在本次条件下已连续两次通过原冻结测试。因此之前一看到笼统的用例超时就进入生产代码返修，归因证据不足；不能继续以该超时单独证明 UI 抽取破坏了行为。
- A 批两轮返修累计消耗 839.328 秒，最后触发总上限。本次不证明“零返修一定能在 420 秒内完成”，因为诊断没有执行完整异味、契约及独立语义评审。
- 这组对照已经完成，没有必要原样再做一组。当前不修改 GoodDetailPage 业务逻辑、测试断言或 15 秒期限；也不将此次诊断替代 A 批的 BLOCKED 结果，A 批仍为 6/8 最终 PASS、3/8 限时 PASS。
- 下一轮可优先改善通用归因流程：对于只有用例内超时、缺少明确行为差异的失败，考虑在同一冻结测试和同一生产代码下最多复测一次，再决定返修。首次失败与复测都应保存，复测时间计入原有 420/900 秒目标与 1200 秒总上限，不能无限重试直到通过。这是后续建议，本次尚未实施。
- CC-I18 的 `App died` 与这里的用例超时不同，仍需独立处理进程死亡诊断及宿主上下文保护，不能据此把应用崩溃统一视为瞬时环境故障。

## 输入和恢复核对

- 输入指向 `runs/20261106-002402-aFr36K/long-method-0001-AM19-goodPkgComp`；没有调用模型或修改测试。
- baseline 的 GoodDetailPage.ets SHA-256 为 `1e9d5841db0757a8e4eb457ca958141136fe24f9364c74388996a795948503c3`；initial 为 `696e3105ac691ec5012b23acefde688b7075c77cc6c6546c90cce317d4f8c5c5`，与原任务快照一致。initial 是首次重构，不是返修后的版本。
- 两份冻结测试文件在原工程和验证副本中均与冻结哈希一致。
- 原工程 113 份源码与 pre-run 快照、备份一致。
- `comparison-summary.json` 为 `restored=true`，无 error/interrupted；验证副本目标文件与诊断前备份、原任务 current-production 末次同步内容一致，比较锁已清理。
- 本次助手只读核对日志、输入与恢复状态，更新审计文档；未代跑 tools 脚本、模型或设备实验，未改运行时。

## 证据位置

- 汇总：[comparison-summary.json](C:/Users/RoyCai/Desktop/group_project/TestResult1028/test-compare-20261106-103810-548/comparison-summary.json)
- 原生输出：[node-output.log](C:/Users/RoyCai/Desktop/group_project/TestResult1028/test-compare-20261106-103810-548/node-output.log)
- 四次测试明细位于同一诊断目录的 `repeat-1-baseline`、`repeat-1-initial`、`repeat-2-baseline`、`repeat-2-initial`；每轮 test-results.json 指向对应 test_result.txt 和 coverage.log。
- 终端记录：`C:\Users\RoyCai\Desktop\group_project\TestResult1028\output-test-compare-20261106-103810-548.log`。
