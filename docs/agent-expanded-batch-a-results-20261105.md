# 2026-11-05 扩测 A 批结果

已核对 14:47～15:55 的 10 份终端日志与对应任务，范围正好是 [扩测安排](agent-expanded-validation-20261105.md) 的 A 批。按用户最新要求，LM-I15 暂排除、留待重测；其余 9 条均最终 PASS，且均满足各自的 420/900 秒目标。继续当前策略扩测 B/C/D，不先增加专项修复。

## 分组结果

| 分组 | 本次纳入统计 | 最终 PASS | 限时 PASS | 本批限时成功率 |
|---|---:|---:|---:|---:|
| Code Clone 跨类（≤900 秒） | 5 | 5 | 5 | 100% |
| Long Method 类内（≤420 秒，暂排除 I15） | 3 | 3 | 3 | 100% |
| Code Clone 类内 I27 单条重跑（≤420 秒） | 1 | 1 | 1 | 仅记录单条通过 |

这是首批样本结果，不代表跨类 Clone 全部 14 条或 Long Method 全部 25 条已达标。原类内 Clone 批次的 13/15（86.7%）不改写，I27 新结果另列。LM-I15 的排除是本次用户明确指定的暂行口径，不推广为自动排除其他 BLOCKED，也不把原始结果改为 PASS。

运行时仍为 `3b3e937` 对应实现；10 条 `agentPolicy` 一致：`2026-11-05-ui-attribution-reactivity`、`zhipu-coding/glm-5`、重构/返修 `max`、评审不显式设置档位、Linter `skip`。当前证据不用于声称 required 模式达标。

## 逐条结果

I/L 表示数据集来源。秒数来自终端 `RESULT totalSeconds`，包括准备、Agent、返修、门禁和评审；任务内阶段可能并行，不直接相加充当端到端时间。

| 样本 | 目标 | 秒数 | 最终状态 | 返修 | 限时结论 | runs 批次 |
|---|---|---:|---|---:|---|---|
| CC-I27 | PictureBeautification | 305.252 | PASS | 0 | 类内通过 | `20261105-144718-EbLntj` |
| CC-I02 | DataManager | 471.182 | PASS | 0 | 跨类通过 | `20261105-145226-YKZ21h` |
| CC-I05 | PracticeMode | 332.135 | PASS | 0 | 跨类通过 | `20261105-150023-w9nb1E` |
| CC-I07 | CollectionPage | 374.652 | PASS | 0 | 跨类通过 | `20261105-150601-tkxjtn` |
| CC-I10 | RecommendBar | 484.900 | PASS | 0 | 跨类通过 | `20261105-151217-YxJxma` |
| CC-L03 | EditNamePageVM | 582.523 | PASS | 1 | 跨类通过 | `20261105-152027-Mb47De` |
| LM-I01 | ReaderToolBar.buildSettingSheet | 225.314 | PASS | 0 | 类内通过 | `20261105-153011-qQckP4` |
| LM-I11 | TabSwiper.onTabSwiperAttributeChange | 139.450 | PASS | 0 | 类内通过 | `20261105-153400-zXll43` |
| LM-I15 | ScheduleForm.build | 20.295 | BLOCKED | 0 | 用户指定暂排除、待重测 | `20261105-153620-y5jiik` |
| LM-L03 | BaseApi.sendRequest | 198.324 | PASS | 0 | 类内通过 | `20261105-155138-4spR92` |

9 条纳入任务累计 3113.732 秒，中位数 332.135 秒；不包含 LM-I15 的 20.295 秒，也不包含批次间等待。全部任务均无语义评审重试或评审格式重试。

## 第 27 条重跑

本次完整重构 305.252 秒、零返修；首轮 Agent 59.175 秒，平台测试阶段 174.637 秒，独立评审 28.981 秒。Local 18/18、Instrument 25/25 均通过，smell/build/contract/review 均 PASS。

产物将两处公共限界逻辑抽为同类 `limitClipRectToImageArea`；最终评审确认 ratio 分支特有的后置限幅顺序保留。本次没有为比例算法修改重构器、模型档位或测试。该结果支持继续暂停专项修复，但不覆盖凌晨的原始 FAIL，也不能确定原设备失败的具体波动来源。

## LM-I15：Agent 证书校验错误，尚未执行设备测试

原始 `refactor-agent.log` 只有一条错误事件：`UnknownError`，消息为 `unknown certificate verification error`。重构 Agent 在 13.053 秒后记为 BLOCKED；整条终端耗时 20.295 秒。后续 smell/build/contract/test/review 全部 SKIPPED，没有测试结果文件，也没有同步生产代码改动。

因此这次错误发生在 Agent/CLI 执行阶段，不是已运行设备用例的断言失败，也不是 Hvigor 应用签名阶段报错。日志没有给出具体证书、服务端点或网络原因，不能进一步断言根因。按用户要求暂不计入成功率，之后再提供单条重跑命令；本轮不绕过证书校验、不修业务代码、不立即重跑。

## 唯一返修：CC-L03

首次生产构建通过，测试包在 `UnitTestArkTS` 编译阶段失败，两个 VM 测试文件出现 `vm.userInfo is possibly undefined` 诊断；尚未进入这些用例的断言执行。平台触发一次返修，Agent 204.035 秒后交回，随后两个 Local suite 各 12/12 通过，最终独立评审 PASS，整条仍在 900 秒内。

最终差异中，两个 VM 的 `userInfo` 声明从 `UserInfo | undefined` 改为 `UserInfo`，初始化增加 `?? new UserInfo()`。原始声明本来就含 `undefined`；本次没有运行原代码测试编译对照，不能仅凭这一诊断认定它是首轮抽取新增的类型回归。这里保留编译失败、实际返修与最终门禁结论，不据单条已成功返修继续扩展平台规则。

## 测试与回滚核验

9 条 PASS 任务的最终 `test-results.json` 共 17 个作业，全部退出码 0、无 pending 作业；逐一核对原始 `test_result.txt`，共 134 次用例执行通过（Local 77、Instrument 57）。10 个 Instrument 作业均有归档的 `TestFinished-ResultCode: 0` 完成标记。数据集名称不能代替实际执行类型，例如 LM-I11 实际运行 Local 8/8。

CC-I02 的一个设备作业、CC-I05 的一个设备作业及 CC-I10 的两个设备作业仍出现 `00507008 / getInitCoverageData failed`。本报告只统计已核实的测试断言，不使用这些覆盖率报告的百分比证明覆盖充分；本次没有重做覆盖率诊断或修改 SDK。

10 份终端均有 `RESULT`、`ROLLBACK_SNAPSHOT`、`END`，任务身份、数据集条目、退出码与 result 一致。对每份运行前快照核对备份文件及当前源工程 SHA-256，各完成 1868 项核对，覆盖 1491 个唯一源码文件，全部一致；按快照同一忽略目录规则枚举源码，未发现新增残留。9 条成功任务的改动清单均无生产资源修改或被拒绝文件。没有修改原工程、测试断言或历史运行产物。

## 日志索引与下一步

终端日志根目录均为 `C:\Users\RoyCai\Desktop\group_project\TestResult1028`：

| 样本 | 终端日志 |
|---|---|
| CC-I27 | `output20261105-144716-531.log` |
| CC-I02 | `output20261105-145223-661.log` |
| CC-I05 | `output20261105-150017-036.log` |
| CC-I07 | `output20261105-150554-782.log` |
| CC-I10 | `output20261105-151214-022.log` |
| CC-L03 | `output20261105-152021-872.log` |
| LM-I01 | `output20261105-153007-985.log` |
| LM-I11 | `output20261105-153356-234.log` |
| LM-I15 | `output20261105-153618-217.log` |
| LM-L03 | `output20261105-155135-825.log` |

本次新结果覆盖 A 批 10 条；B/C/D 的 31 条尚未发现本轮新结果，继续沿用 [原分批命令](agent-expanded-validation-20261105.md)，按 B（10）→C（14）→D（7）串行运行。LM-I15 另列待重测，不加入这三批。待补齐后再判断完整分组是否超过 70%；若 I15 仍暂排除，Long Method 有效全组为 24 条，至少需 17 条限时通过，重测纳回 25 条后至少需 18 条。

本次只读取已有实验证据并更新文档，没有执行 `tools/` 脚本、调用模型或运行设备测试，没有修改运行时策略。
