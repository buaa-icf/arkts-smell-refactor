# 2026-11-05 全范围扩测结果与耗时分析

本轮 A/B/C/D 均已产生对应样本结果。跨类 Code Clone 限时通过 **8/14（57.1%）**，Long Method 类内暂排除 LM-I15 后为 **14/24（58.3%）**，均未达到严格 >70% 的目标。此前类内 Code Clone 批次仍为 **13/15（86.7%）**；I27 本轮重跑 305.252 秒 PASS 单列，不覆盖原批次失败。

本次只审计日志、快照和产物，更新实验文档；未修改重构器、业务工程、测试断言、SDK 或历史结果，未执行 `tools/` 脚本、模型请求或设备测试。

## 范围和统计规则

- A 批 10 条见 [A 批报告](agent-expanded-batch-a-results-20261105.md)。之后 CC-I6/I8 的恢复运行分别在 16:21、16:37 启动；断点续跑 29 条于 17:52～22:43 完成，24 PASS、5 BLOCKED。
- 本报告逐条指定 41 次已完成尝试：A 批 10 + I6/I8 恢复运行 2 + 续跑 29。LM-I15 按用户要求暂排除，待单独重测；不自动排除其他 BLOCKED。
- 16:05～16:10 的 I6/I8/I9 HTTP 500 失败和随后 I11、LM-I2、I9 的中断记录全部保留。本报告使用用户指定恢复运行的结果，未挑选最快尝试；这些旧记录不计入表中单次任务耗时。完整尝试记录与当前选定样本统计应区分。
- 41 条 `agentPolicy` 一致，运行时对应 `3b3e937`，策略 `2026-11-05-ui-attribution-reactivity`；请求模型 `zhipu-coding/glm-5`，重构/返修 max、评审默认，Linter skip。服务端实际档位仍不能仅凭请求记录证明。
- 端到端时间直接取终端 `RESULT totalSeconds`；类内 ≤420 秒、跨类 ≤900 秒且最终 PASS 才算成功。1200 秒是任务执行上限，不替代目标；测试已过但评审超时仍为 BLOCKED。
- I/L 是样本数据集来源；表中“最后测试”的 I/L 才表示实际 Instrument/Local 作业。当前没有独立 Long Method 跨类样本。

| 分组 | 最终 PASS | 限时 PASS | 成功率 | 目标判断 |
|---|---:|---:|---:|---|
| Code Clone 类内原 15 条批次 | 14/15 | 13/15 | 86.7% | 该批已超过 70%，保留历史口径 |
| Code Clone 跨类 | 11/14 | 8/14 | 57.1% | 未达到；至少需 10/14，差 2 条 |
| Long Method 类内（排除 I15） | 22/24 | 14/24 | 58.3% | 未达到；至少需 17/24，差 3 条 |
| Code Clone 顶层 Builder I22 | 1/1 | 1/1 | 单列 | 306.206 秒，不并入类内／跨类 |
| Code Clone I27 单条重跑 | 1/1 | 1/1 | 单列 | 305.252 秒，零返修 |

Long Method 的 Instrument 子集为 9/16 限时通过，Local 子集为 5/8。I15 重测纳回后分母恢复为 25，严格 >70% 至少需要 18 条。本轮 skip 结果不代表 required 模式已经达标。

## 跨类 Code Clone 逐条结果

| 样本 | 目标 | 秒数 | 终态 | 返修 | 限时达标 | 最后测试 | runs 批次 |
|---|---|---:|---|---:|---|---|---|
| CC-I02 | DataManager.ets | 471.182 | PASS | 0 | 是 | L 8/8 + I 4/4 + L 7/7 + I 2/2 | `20261105-145226-YKZ21h` |
| CC-I05 | PracticeMode.ets | 332.135 | PASS | 0 | 是 | I 5/5 + I 7/7 | `20261105-150023-w9nb1E` |
| CC-I06 | AuthenticationPage.ets | 956.050 | PASS | 0 | 否 | I 2/2 + I 2/2 | `20261105-162141-TmEyKN` |
| CC-I07 | CollectionPage.ets | 374.652 | PASS | 0 | 是 | I 6/6 + I 1/1 | `20261105-150601-tkxjtn` |
| CC-I08 | CollectionPage.ets | 943.024 | PASS | 1 | 否 | I 6/6 + I 1/1 | `20261105-163741-dGMkCb` |
| CC-I09 | CollectionPage.ets | 515.277 | PASS | 0 | 是 | I 6/6 + I 1/1 | `20261105-175213-UhLmyV` |
| CC-I10 | RecommendBar.ets | 484.900 | PASS | 0 | 是 | I 3/3 + I 3/3 | `20261105-151217-YxJxma` |
| CC-I11 | AddVisitorPage.ets | 705.500 | PASS | 0 | 是 | I 14/14 + I 10/10 | `20261105-180046-iuke9K` |
| CC-I13 | EditNamePage.ets | 535.236 | PASS | 0 | 是 | I 8/8 + I 8/8 | `20261105-181233-QLHCHU` |
| CC-I14 | EditNamePageVM.ets | 1201.578 | BLOCKED | 1 | 否 | I 9/9 + I 10/10 | `20261105-182129-5yHWL4` |
| CC-I18 | HomeVisit.ets | 1201.740 | BLOCKED | 0 | 否 | I 5/5 + I 4/4 | `20261105-184132-UtyTBw` |
| CC-I19 | EditNamePage.ets | 1201.466 | BLOCKED | 1 | 否 | I 4/5; 1 作业待执行 | `20261105-190135-Y5bJE8` |
| CC-I23 | MyFavoritesPage.ets | 1095.445 | PASS | 0 | 否 | I 1/1 + I 1/1 | `20261105-192644-LyeVnm` |
| CC-L03 | EditNamePageVM.ets | 582.523 | PASS | 1 | 是 | L 12/12 + L 12/12 | `20261105-152027-Mb47De` |

6 条未达标中，I6/I8/I23 最终 PASS 但超出 900 秒；I14/I18/I19 达到 1200 秒任务上限后 BLOCKED。跨类累计 10600.708 秒，不含等待、回滚和已被恢复运行取代的尝试。

## Long Method 逐条结果

| 样本 | 目标 | 秒数 | 终态 | 返修 | 限时达标 | 最后测试 | runs 批次 |
|---|---|---:|---|---:|---|---|---|
| LM-I01 | ReaderToolBar.ets / buildSettingSheet | 225.314 | PASS | 0 | 是 | I 1/1 | `20261105-153011-qQckP4` |
| LM-I02 | SearchPage.ets / build | 265.079 | PASS | 0 | 是 | I 2/2 | `20261105-194501-10AZTv` |
| LM-I03 | MyInfoCard.ets / build | 308.646 | PASS | 0 | 是 | I 1/1 | `20261105-194926-BUR1vg` |
| LM-I04 | AboutPage.ets / aboutCardView | 262.483 | PASS | 0 | 是 | I 1/1 | `20261105-195436-bbU1y0` |
| LM-I05 | FeedbackPage.ets / build | 511.703 | PASS | 0 | 否 | I 1/1 | `20261105-195859-K05JZe` |
| LM-I06 | LoginPage.ets / build | 492.099 | PASS | 0 | 否 | I 3/3 | `20261105-200731-qj8gmQ` |
| LM-I07 | MemberAgreementPage.ets / build | 232.462 | PASS | 0 | 是 | I 1/1 | `20261105-201544-JHbesz` |
| LM-I08 | MemberCenterPage.ets / build | 502.668 | PASS | 0 | 否 | I 1/1 | `20261105-201937-pZlsyj` |
| LM-I09 | RechargePage.ets / build | 539.085 | PASS | 0 | 否 | L 3/3 + I 1/1 | `20261105-202801-PswQc9` |
| LM-I10 | BookCoverCard.ets / build | 272.652 | PASS | 0 | 是 | I 2/2 | `20261105-203701-Q3kT1Z` |
| LM-I11 | TabSwiper.ets / onTabSwiperAttributeChange | 139.450 | PASS | 0 | 是 | L 8/8 | `20261105-153400-zXll43` |
| LM-I12 | TUISwiper.ets / initDataByIsCovered | 182.139 | PASS | 0 | 是 | I 7/7 | `20261105-204134-YkwNjP` |
| LM-I13 | QuickLoginPage.ets / handleLoginWithHuaweiIDButton | 598.806 | PASS | 0 | 否 | I 4/4 | `20261105-204437-im9FlQ` |
| LM-I14 | AgencyTaskCalender.ets / build | 1189.816 | PASS | 0 | 否 | I 4/4 | `20261105-205436-uYOlJh` |
| LM-I15 | ScheduleForm.ets / build | 20.295 | BLOCKED | 0 | 暂排除 | 未执行 | `20261105-153620-y5jiik` |
| LM-I16 | GoodDetailPage.ets / %AM19$goodPkgComp | 1200.911 | BLOCKED | 1 | 否 | I 0/1 | `20261105-211426-lUfWmP` |
| LM-I17 | AgreementView.ets / build | 345.709 | PASS | 0 | 是 | I 2/2 | `20261105-213428-M5AieK` |
| LM-L01 | AccessibilitySettingModel.ets / accessibilityConfigSetting | 409.351 | PASS | 0 | 是 | L 8/8 | `20261105-214019-Nwj3WW` |
| LM-L02 | ipsecVpnEdit.ets / initCertList | 362.242 | PASS | 0 | 是 | L 6/6 | `20261105-214708-BQGrID` |
| LM-L03 | BaseApi.ets / sendRequest | 198.324 | PASS | 0 | 是 | L 12/12 | `20261105-155138-4spR92` |
| LM-L04 | PatientViewModel.ets / checkPatientInfo | 251.327 | PASS | 0 | 是 | L 21/21 | `20261105-215311-2RxzJw` |
| LM-L05 | SubmitOrderPage.ets / submitOrder | 541.566 | PASS | 0 | 否 | L 12/12 | `20261105-215723-zl6rOG` |
| LM-L06 | PictureBeautification.ets / moveClipCanvasFreeType | 388.436 | PASS | 0 | 是 | L 18/18 | `20261105-220625-uqxEmC` |
| LM-L07 | PictureBeautification.ets / moveClipCanvasRatioType | 1200.827 | BLOCKED | 1 | 否 | L 18/18 | `20261105-221254-HgGV5L` |
| LM-L08 | UserDetail.ets / UploadProfilePicDialogBuilder | 656.195 | PASS | 0 | 否 | L 6/6 + I 3/3 | `20261105-223256-uGjprw` |

24 条纳入样本累计 11277.290 秒。10 条未达标中，I5/I6/I8/I9/I13/I14/L5/L8 最终 PASS 但超出 420 秒，I16/L7 为任务超时 BLOCKED。I15 的证书校验错误发生在 Agent 阶段，尚未执行设备测试，继续暂排除。

## 主要瓶颈：模型交互耗时，而非普遍构建失败

16 条未达标任务合计 14032.979 秒，其中重构及返修 Agent 为 10937.063 秒，评审为 1691.172 秒，合计约 **90.0%**。这里按 Agent/Review 子进程耗时求和，其余构建、测试等门禁可能并行，不能将所有阶段耗时直接累加成端到端时间。Agent 耗时包含模型推理、服务等待、往返和工具调用，日志不能将它全部归为纯推理时间。

6 条仅首轮重构就超过各自端到端目标：CC-I18；LM-I13/I14/I16/L7/L8。11 条“最终 PASS 但超时”中，只有 CC-I8 发生返修，其余 10 条均零返修；仅减少返修次数不足以解决本轮目标缺口。

典型证据：

| 样本 | 可确认的现象 | 影响 |
|---|---|---|
| CC-I14 | 首轮 681.270 秒、返修 444.324 秒；首个 edit/write 事件分别距各轮首事件 559.649、331.818 秒 | 修完残余克隆并通过测试后，只剩约 5 秒评审时间 |
| CC-I18 | 首轮 1090.034 秒；36 次 bash，其中 35 次查询 SDK 路径、声明或编译器实现，最后一次为内部 build；工具报告耗时合计约 11.682 秒 | 主要时间消耗在连续探索与模型往返，最终评审超时 |
| CC-I23 | 首轮 875.602 秒，首个 write 事件距首事件 779.331 秒；15 read、6 grep、4 glob | 即使零返修、最后全部通过，仍耗时 1095.445 秒 |
| LM-I14 | 首轮 895.800 秒，11 次 edit 中 3 次 oldString 不匹配；评审另用 238.382 秒 | 最终 PASS 但总耗时 1189.816 秒，需检查编辑粒度和反复输出成本 |
| LM-L5 | 零返修；重构 316.086 秒，评审 184.547 秒；评审没有工具调用 | 不能靠减少评审读文件次数解释或消除此条主要耗时 |

首个编辑时间仅指日志中的 edit/write 事件，不等同于所有潜在 shell 写入；本表不将其统一解释为首次磁盘变更。本轮选定运行的 Agent/Review JSONL 中除 LM-I15 外没有结构化 API 错误事件，也未见 step_finish reason=length；这不证明完全没有服务等待或 CLI 内部重试。此前 HTTP 500 不能直接解释所有后续长耗时。

## 5 条超时 BLOCKED 的具体触发链

| 样本 | 首轮问题／状态 | 最终中止位置 |
|---|---|---|
| CC-I14 | 两个 VM 抽取后仍残留 100 token、26 行克隆 | 一轮返修后 smell/build/contract/test PASS；评审受总时限中止 |
| CC-I18 | 首轮及门禁通过 | 首轮已消耗 1090 秒；评审受总时限中止 |
| CC-I19 | 设备用例 updatesNicknameWhenUserInfoExists 报 TextInput missing，末次设备结果 4/5 | 返修只留下 read/glob/grep 事件，未观察到写入；返修受总时限中止，另一设备作业 pending |
| LM-I16 | renders_package_good_detail_page 在用例内报 execute timeout 15000ms | 返修只留下 read/grep/glob 事件，未观察到写入；返修受总时限中止 |
| LM-L7 | 首轮修改了目标 ratio 方法及相邻 free 方法；free 方法仍被检测为 55 行、阈值 50 | 一轮返修后 smell/build/contract/test PASS；评审受总时限中止 |

CC-I19 和 LM-I16 记录的是实际测试失败现象；本次没有做原代码基线对照，因此不能仅凭症状确认业务回归根因。LM-L7 原 free 方法也超长；首轮把它从约 86 个物理行改为 59 行但仍超检测阈值，因改动范围扩大进入门禁返修。物理行数不是检测器的 55 行计数。此项属于抽取范围与异味消除问题，本轮不继续修改裁剪比例业务算法。

## 测试证据与回滚

- 41 条所选任务的终端均有 RESULT、ROLLBACK_SNAPSHOT、END；核对了任务身份、数据集定位和模型策略。
- 35 条最终 PASS 均有有效独立评审。末次测试共 58 个已执行作业：56 PASS、2 FAIL，另有 CC-I19 的 1 个作业 pending。通过作业的原始报告与 summary 全部一致，共 350 次用例执行通过；两个失败作业另含 4 次通过和 2 次 Error。最终 BLOCKED 的 I14/I18/L7 也有测试 PASS，不能据此升级最终 verdict。
- 41 个成功设备作业均有原始 TestFinished-ResultCode: 0 完成标记。LM-L6/L7 本轮实际仅运行 Local 18/18，不能沿用历史 25/25 设备结果声称这两条做了设备验证。
- 12 个设备作业日志仍包含覆盖率报告错误 00507008 / getInitCoverageData failed；不使用其百分比证明覆盖完整。本轮没有修改 SDK 或重新生成覆盖率材料。
- 运行前备份和当前源工程各完成 **7361 项 SHA-256 核对**，覆盖 **2845 个唯一源码文件**，全部一致；按快照忽略规则枚举，无新增源码残留。所选任务改动清单无生产资源修改或被拒绝文件。
- 本轮没有修改运行时代码，因此未重跑单元测试；以上检查针对实际实验产物和源工程回滚。

## 下一步建议（尚未实施）

1. 优先核对跨类候选方案提供是否足够具体，以及 CC-I18 这类 SDK／编译器探索为何未收敛。应保留必要验证，减少与局部抽取无关的长链探索；不以放宽 900 秒目标解决。
2. 以零返修却超时的 LM-I5/I6/I8/I9/L5 作为耗时对照，分别观察重构与评审；若做档位对比，保持相同输入、源码、工具策略与验证要求，先小批比较，再决定是否改默认档位。
3. CC-I19、LM-I16 另列为测试失败定位；LM-L7 关注抽取范围扩大导致的额外异味返修。不要从测试标题猜测新业务规则，也不把单条问题都扩展成新平台机制。
4. 继续保留 LM-I15 待重测，原批次失败与中断历史不改写。任何后续优化按独立问题分批 commit，并用新版本批次验证；本报告不把后续补跑最好成绩提前合入当前成功率。

## 逐条原始日志索引

终端日志统一位于 `C:\Users\RoyCai\Desktop\group_project\TestResult1028`。以下任务路径相对于本仓库 `runs/`；保留精确映射，避免同名文件和同序号数据集混淆。

| 样本 | 终端日志 | runs 下任务路径 |
|---|---|---|
| CC-I02 | `output20261105-145223-661.log` | `20261105-145226-YKZ21h/code-clone-0001-DataManager` |
| CC-I05 | `output20261105-150017-036.log` | `20261105-150023-w9nb1E/code-clone-0001-PracticeMode` |
| CC-I06 | `output20261105-162135-719.log` | `20261105-162141-TmEyKN/code-clone-0001-AuthenticationPage` |
| CC-I07 | `output20261105-150554-782.log` | `20261105-150601-tkxjtn/code-clone-0001-CollectionPage` |
| CC-I08 | `output20261105-163737-139.log` | `20261105-163741-dGMkCb/code-clone-0001-CollectionPage` |
| CC-I09 | `output20261105-175208-574.log` | `20261105-175213-UhLmyV/code-clone-0001-CollectionPage` |
| CC-I10 | `output20261105-151214-022.log` | `20261105-151217-YxJxma/code-clone-0001-RecommendBar` |
| CC-I11 | `output20261105-180045-613.log` | `20261105-180046-iuke9K/code-clone-0001-AddVisitorPage` |
| CC-I13 | `output20261105-181231-925.log` | `20261105-181233-QLHCHU/code-clone-0001-EditNamePage` |
| CC-I14 | `output20261105-182128-361.log` | `20261105-182129-5yHWL4/code-clone-0001-EditNamePageVM` |
| CC-I18 | `output20261105-184131-205.log` | `20261105-184132-UtyTBw/code-clone-0001-HomeVisit` |
| CC-I19 | `output20261105-190134-238.log` | `20261105-190135-Y5bJE8/code-clone-0001-EditNamePage` |
| CC-I22 | `output20261105-192136-925.log` | `20261105-192137-Qb898v/code-clone-0001-SubmitPointConfirm` |
| CC-I23 | `output20261105-192643-850.log` | `20261105-192644-LyeVnm/code-clone-0001-MyFavoritesPage` |
| CC-I27 | `output20261105-144716-531.log` | `20261105-144718-EbLntj/code-clone-0001-PictureBeautification` |
| CC-L03 | `output20261105-152021-872.log` | `20261105-152027-Mb47De/code-clone-0001-EditNamePageVM` |
| LM-I01 | `output20261105-153007-985.log` | `20261105-153011-qQckP4/long-method-0001-buildSettingSheet` |
| LM-I02 | `output20261105-194500-167.log` | `20261105-194501-10AZTv/long-method-0001-build` |
| LM-I03 | `output20261105-194925-972.log` | `20261105-194926-BUR1vg/long-method-0001-build` |
| LM-I04 | `output20261105-195435-359.log` | `20261105-195436-bbU1y0/long-method-0001-aboutCardView` |
| LM-I05 | `output20261105-195858-576.log` | `20261105-195859-K05JZe/long-method-0001-build` |
| LM-I06 | `output20261105-200731-005.log` | `20261105-200731-qj8gmQ/long-method-0001-build` |
| LM-I07 | `output20261105-201543-831.log` | `20261105-201544-JHbesz/long-method-0001-build` |
| LM-I08 | `output20261105-201936-987.log` | `20261105-201937-pZlsyj/long-method-0001-build` |
| LM-I09 | `output20261105-202800-444.log` | `20261105-202801-PswQc9/long-method-0001-build` |
| LM-I10 | `output20261105-203700-289.log` | `20261105-203701-Q3kT1Z/long-method-0001-build` |
| LM-I11 | `output20261105-153356-234.log` | `20261105-153400-zXll43/long-method-0001-onTabSwiperAttributeChange` |
| LM-I12 | `output20261105-204133-679.log` | `20261105-204134-YkwNjP/long-method-0001-initDataByIsCovered` |
| LM-I13 | `output20261105-204436-527.log` | `20261105-204437-im9FlQ/long-method-0001-handleLoginWithHuaweiIDButton` |
| LM-I14 | `output20261105-205435-719.log` | `20261105-205436-uYOlJh/long-method-0001-build` |
| LM-I15 | `output20261105-153618-217.log` | `20261105-153620-y5jiik/long-method-0001-build` |
| LM-I16 | `output20261105-211426-182.log` | `20261105-211426-lUfWmP/long-method-0001-AM19-goodPkgComp` |
| LM-I17 | `output20261105-213427-596.log` | `20261105-213428-M5AieK/long-method-0001-build` |
| LM-L01 | `output20261105-214018-590.log` | `20261105-214019-Nwj3WW/long-method-0001-accessibilityConfigSetting` |
| LM-L02 | `output20261105-214708-348.log` | `20261105-214708-BQGrID/long-method-0001-initCertList` |
| LM-L03 | `output20261105-155135-825.log` | `20261105-155138-4spR92/long-method-0001-sendRequest` |
| LM-L04 | `output20261105-215310-997.log` | `20261105-215311-2RxzJw/long-method-0001-checkPatientInfo` |
| LM-L05 | `output20261105-215722-865.log` | `20261105-215723-zl6rOG/long-method-0001-submitOrder` |
| LM-L06 | `output20261105-220625-014.log` | `20261105-220625-uqxEmC/long-method-0001-moveClipCanvasFreeType` |
| LM-L07 | `output20261105-221253-930.log` | `20261105-221254-HgGV5L/long-method-0001-moveClipCanvasRatioType` |
| LM-L08 | `output20261105-223255-246.log` | `20261105-223256-uGjprw/long-method-0001-UploadProfilePicDialogBuilder` |
