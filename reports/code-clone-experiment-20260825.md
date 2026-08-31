# Code Clone 重构实验记录（2026-08-25）

## 实验范围

- 数据集：`C:\Users\RoyCai\Desktop\group_project\arkts-code-smell\dataset\positive\instrument-test\code-clone.json`
- 被测代码根目录：`D:\arktsProgram`；下表路径均相对此根目录。
- 样本数：27 个代码克隆异味片段（同一文件但行区间不同的片段分别编号）。
- 执行方式：对每个片段单独运行重构流水线；重构成功后依次执行 HomeCheck 复查、构建、测试、Code Linter、语义评审，然后按已记录的基线文件逐项恢复。没有专项 Code Clone 分析器时，HomeCheck 使用原始的 `@extrulesproject/code-clone-fragment-check` 规则复查。
- 计时口径：从单条任务提交到所有已触发门禁写入结果的耗时；恢复动作在结果产生后立即执行并逐文件校验，工具未对这段文件复制/删除单独计时。

## 状态说明

- `R`：重构 Agent；`H`：HomeCheck 异味复查；`B`：构建；`T`：测试；`L`：Code Linter；`S`：另一 Agent 的语义评审。
- `PASS`、`FAIL`、`BLOCKED` 与 `SKIPPED` 均为流水线原始状态，括号内是秒数。
- `S=FAIL` 不代表评审给出了“语义不通过”结论。本轮的 11 次语义评审均在启动阶段失败（附件路径/模型 Provider 不可用），没有产生可用的语义评审结果。
- `R=BLOCKED` 的日志均出现内置模型服务拥堵（`Built-in model service is currently overloaded`）或等效的 Agent 基础设施阻塞；后续门禁因而跳过。这是平台可用性问题，不应归因于该条代码质量。

## 汇总

| 项目 | 结果 |
|---|---:|
| 总样本 | 27 |
| 流水线原始结论 | FAIL 14；BLOCKED 13；PASS 0 |
| 重构 Agent 实际成功 | 11 |
| 成功重构后的 HomeCheck / 构建 / 测试 | 11 / 11 / 11 通过 |
| 成功重构后的 Code Linter | 6 通过，5 失败 |
| 可用语义评审结论 | 0（11 次调用均为基础设施失败） |
| 累计流水线耗时 | 15,495.022 秒（约 4 小时 18 分 15 秒） |
| 源码回滚 | 11 条发生写入的任务均已恢复；其余 16 条未向源项目落盘，无需回滚 |

## 明细

`主要片段 ↔ 对照片段` 是数据集中的克隆关系；`—` 表示该记录未提供可解析的对照片段。

| 异味编号 | 主要片段 ↔ 对照片段 | 门禁结果（秒） | 流水线耗时 | 原始结论与回滚 |
|---|---|---|---:|---|
| CC-001 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/AboutPage.ets:71-124` ↔ `…/AboutPage.ets:128-185` | R PASS (1078.651)<br>H PASS (80.162)<br>B PASS (29.306)<br>T PASS (24.074)<br>L PASS (7.344)<br>S FAIL (6.207, 基础设施) | 1225.762 | FAIL；已恢复重构文件 |
| CC-002 | `agc-template-market-harmonyos-demos/BusinessTemplate/OfficeAttendance/scenes/agency/src/main/ets/mock/DataManager.ets:13-33` ↔ `…/scenes/schedule/src/main/ets/mock/DataManager.ets:13-33` | R PASS (638.116)<br>H PASS (66.490)<br>B PASS (21.928)<br>T PASS (15.345)<br>L FAIL (16.800)<br>S FAIL (8.734, 基础设施) | 767.422 | FAIL；已恢复重构文件 |
| CC-003 | `agc-template-market-harmonyos-demos/CarsTemplate/DriverLicenseExam/products/entry/src/main/ets/pages/mine/PersonalSetting.ets:71-91` ↔ `…/PersonalSetting.ets:93-113` | R PASS (161.503)<br>H PASS (67.577)<br>B PASS (19.140)<br>T PASS (17.805)<br>L FAIL (5.533)<br>S FAIL (4.313, 基础设施) | 275.879 | FAIL；已恢复重构文件 |
| CC-004 | `agc-template-market-harmonyos-demos/EducationTemplate/Exam/components/login_info/src/main/ets/components/QuickLogin.ets:311-370` ↔ `…/QuickLogin.ets:453-510` | R FAIL (1513.565)<br>H/B/T/L/S SKIPPED | 1513.572 | FAIL；Agent 未向源项目同步，无需回滚 |
| CC-005 | `agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/homePage/src/main/ets/model/PracticeMode.ets:19-139` ↔ `…/features/topicPage/src/main/ets/viewModel/PracticeMode.ets:17-139` | R PASS (679.915)<br>H PASS (68.781)<br>B PASS (25.637)<br>T PASS (17.764)<br>L FAIL (22.907)<br>S FAIL (4.316, 基础设施) | 819.331 | FAIL；已恢复重构文件 |
| CC-006 | `agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/homePage/src/main/ets/pages/AuthenticationPage.ets:1-71` ↔ `…/features/minePage/src/main/ets/views/AuthenticationPage.ets:1-71` | R PASS (851.483)<br>H PASS (68.757)<br>B PASS (25.364)<br>T PASS (17.073)<br>L FAIL (22.584)<br>S FAIL (4.309, 基础设施) | 989.676 | FAIL；已恢复重构文件 |
| CC-007 | `agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/CollectionPage.ets:20-46` ↔ `…/features/minePage/src/main/ets/views/CoursePage.ets:20-47` | R PASS (1123.507)<br>H PASS (68.258)<br>B PASS (25.235)<br>T PASS (17.357)<br>L FAIL (28.072)<br>S FAIL (4.018, 基础设施) | 1266.554 | FAIL；已恢复重构文件 |
| CC-008 | `agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/CollectionPage.ets:73-93` ↔ `…/features/minePage/src/main/ets/views/CoursePage.ets:74-94` | R PASS (1423.127)<br>H PASS (67.571)<br>B PASS (24.113)<br>T PASS (17.059)<br>L PASS (11.752)<br>S FAIL (4.635, 基础设施) | 1548.358 | FAIL；已恢复重构文件 |
| CC-009 | `agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/CollectionPage.ets:95-125` ↔ `…/features/minePage/src/main/ets/views/CoursePage.ets:96-126` | R PASS (1130.463)<br>H PASS (91.722)<br>B PASS (27.181)<br>T PASS (19.640)<br>L PASS (12.165)<br>S FAIL (4.503, 基础设施) | 1285.779 | FAIL；已恢复重构文件 |
| CC-010 | `agc-template-market-harmonyos-demos/EntertainmentTemplate/MuseumTicket/features/home/src/main/ets/component/RecommendBar.ets:3-53` ↔ `…/features/mine/src/main/ets/components/RecommendBar.ets:3-53` | R PASS (1383.066)<br>H PASS (89.492)<br>B PASS (20.690)<br>T PASS (18.095)<br>L PASS (35.138)<br>S FAIL (3.777, 基础设施) | 1550.366 | FAIL；已恢复重构文件 |
| CC-011 | `agc-template-market-harmonyos-demos/EntertainmentTemplate/MuseumTicket/features/mine/src/main/ets/pages/AddVisitorPage.ets:1-158` ↔ `…/features/mine/src/main/ets/pages/EditVisitorPage.ets:1-158` | R FAIL (3.983)<br>H/B/T/L/S SKIPPED | 4.105 | FAIL；未产生重构改动，无需回滚 |
| CC-012 | `agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/commons/componentlib/src/main/ets/components/CommonProductProfile.ets:39-56` ↔ `…/CommonProductProfile.ets:67-84` | R PASS (288.622)<br>H PASS (67.045)<br>B PASS (24.068)<br>T PASS (20.695)<br>L PASS (5.910)<br>S FAIL (4.242, 基础设施) | 410.683 | FAIL；已恢复重构文件 |
| CC-013 | `agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/scenes/tab/mine/src/main/ets/pages/EditNamePage.ets:18-70` ↔ `…/scenes/tab/mine/src/main/ets/pages/EditPhonePage.ets:18-70` | R FAIL (1051.525)<br>H/B/T/L/S SKIPPED | 1051.629 | FAIL；Agent 未向源项目同步，无需回滚 |
| CC-014 | `agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/scenes/tab/mine/src/main/ets/viewModels/EditNamePageVM.ets:6-40` ↔ `…/EditPhonePageVM.ets:6-40` | R BLOCKED (380.217, 模型服务)<br>H/B/T/L/S SKIPPED | 380.351 | BLOCKED；未写入源码 |
| CC-015 | `agc-template-market-harmonyos-demos/KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets:90-100` ↔ `…/TimeCtrl.ets:114-124` | R BLOCKED (5.267, 模型服务)<br>H/B/T/L/S SKIPPED | 5.363 | BLOCKED；未写入源码 |
| CC-016 | `agc-template-market-harmonyos-demos/KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets:165-179` ↔ `…/TimeCtrl.ets:189-203` | R BLOCKED (580.182, 模型服务)<br>H/B/T/L/S SKIPPED | 580.276 | BLOCKED；未写入源码 |
| CC-017 | `agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets:443-475` ↔ `…/PictureBeautification.ets:557-588` | R BLOCKED (733.515, 模型服务)<br>H/B/T/L/S SKIPPED | 733.612 | BLOCKED；未写入源码 |
| CC-018 | `agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_home/src/main/ets/components/HomeVisit.ets:8-59` ↔ `…/features/business_home/src/main/ets/components/ShippingInfo.ets:9-61` | R BLOCKED (6.071, 模型服务)<br>H/B/T/L/S SKIPPED | 6.180 | BLOCKED；未写入源码 |
| CC-019 | `agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_mine/src/main/ets/pages/EditNamePage.ets:18-70` ↔ `…/features/business_mine/src/main/ets/pages/EditPhonePage.ets:18-70` | R BLOCKED (6.641, 模型服务)<br>H/B/T/L/S SKIPPED | 6.743 | BLOCKED；未写入源码 |
| CC-020 | `agc-template-market-harmonyos-demos/KidsTemplate/PostpartumCareCenter/scenes/activities/src/main/ets/view/ActivityBooking.ets:70-88` ↔ `…/ActivityBooking.ets:118-136` | R PASS (258.256)<br>H PASS (70.303)<br>B PASS (19.922)<br>T PASS (15.516)<br>L PASS (6.358)<br>S FAIL (4.289, 基础设施) | 374.657 | FAIL；已恢复重构文件 |
| CC-021 | `agc-template-market-harmonyos-demos/LifestyleAndServiceTemplate/AdministrativeAffairs/Application/commons/components/src/main/ets/components/AboutUs.ets:42-57` ↔ `…/AboutUs.ets:63-78` | R BLOCKED (117.650, 模型服务)<br>H/B/T/L/S SKIPPED | 117.745 | BLOCKED；未写入源码 |
| CC-022 | `agc-template-market-harmonyos-demos/LifestyleAndServiceTemplate/ShoppingMall/components/module_points/src/main/ets/components/SubmitPointConfirm.ets:15-36` ↔ `…/SubmitPointConfirm.ets:60-81` | R BLOCKED (5.535, 模型服务)<br>H/B/T/L/S SKIPPED | 5.641 | BLOCKED；未写入源码 |
| CC-023 | `agc-template-market-harmonyos-demos/MovieTVAndLivestreamingTemplate/WebShortDrama/features/mine/src/main/ets/pages/MyFavoritesPage.ets:8-32` ↔ `…/features/mine/src/main/ets/pages/WatchRecordsPage.ets:8-32` | R BLOCKED (341.672, 模型服务)<br>H/B/T/L/S SKIPPED | 341.776 | BLOCKED；未写入源码 |
| CC-024 | `agc-template-market-harmonyos-demos/NavigationTemplate/AirTrip/Application/features/home/src/main/ets/pages/HomePage.ets:194-209` ↔ `…/HomePage.ets:238-253` | R BLOCKED (124.261, 模型服务)<br>H/B/T/L/S SKIPPED | 124.370 | BLOCKED；未写入源码 |
| CC-025 | `agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/components/StickerToolBar.ets:78-131` ↔ `…/StickerToolBar.ets:141-194` | R BLOCKED (97.980, 模型服务)<br>H/B/T/L/S SKIPPED | 98.078 | BLOCKED；未写入源码 |
| CC-026 | `agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/commons/network/src/main/ets/mocks/mockData/TransactionDatasetMock.ets:49-61` ↔ — | R BLOCKED (5.463, 模型服务)<br>H/B/T/L/S SKIPPED | 5.555 | BLOCKED；未写入源码；数据集未提供对照片段 |
| CC-027 | `agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets:476-487` ↔ — | R BLOCKED (5.465, 模型服务)<br>H/B/T/L/S SKIPPED | 5.559 | BLOCKED；未写入源码；数据集未提供对照片段 |

## 回滚与有效性核验

1. 对每一条 `R PASS` 任务，先以变更清单定位源项目文件，再将其与重构工作区镜像进行 SHA-256 比对；确认同步后才用任务前基线恢复。对于重构中新建且没有基线的文件，只有在源文件和镜像哈希相同的情况下才删除。
2. 11 条实际发生重构写入的任务均完成上述恢复。`R FAIL` 与 `R BLOCKED` 条目没有同步到被测源码，因此没有对其进行删除或覆盖。
3. 被测仓库中仍可见构建/测试产生的缓存、锁文件、构建配置脏状态及部分早于本次实验的未跟踪源文件；它们不是本实验记录的重构源文件，未擅自清理。三个看似新增的 `.ets` 文件已核对其修改时间早于实验且与工作区镜像一致，因而保留。

## 结论与下一步

- 从已成功执行的 11 条看，重构后 HomeCheck、构建和测试都通过；但只有 6 条同时通过 Linter。由于语义评审服务 11/11 不可用，不能据此声称语义质量已通过。
- 后 13 条被同一个内置模型服务拥堵问题阻断，当前不能作为重构失败样本纳入质量对比；建议恢复 Agent 模型服务或配置可用的自定义模型后，仅重跑 CC-014～CC-019、CC-021～CC-027。
- 原始运行证据保存在 `C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\<时间戳>\code-clone-0001-*` 下：每条包含 `task.json`、`result.json`、各门禁日志以及（如有）`refactor-changes.json`。
