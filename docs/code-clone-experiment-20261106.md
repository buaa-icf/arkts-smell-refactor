# Code Clone 重构实验报告（2026-11-06）

## 摘要

本报告评估Code Clone自动重构的门禁通过率、限时成功率与执行成本，按实际源码宿主将30个数据集条目分为类内15条、跨类14条和同文件顶层Builder 1条。类内保留已冻结的11月5日验证批次，跨类采用专属分析器优化后的11月6日同版本全量结果；**这些是分组验证证据，不是最终版本一次重跑全部30条。**

**类内最终PASS 14/15，420秒内PASS 13/15（86.7%）；跨类最终PASS 11/14，900秒内PASS 10/14（71.4%），两个适用分组均严格超过70%。** 顶层Builder I22为306.206秒PASS，单列，不并入类内分母。组合描述统计为26/30最终PASS、按各自阈值24/30，但这个混合比例不用于分组验收。

组合端到端合计13729.499秒（3小时48分49.499秒）。3个任务共发生5次返修；模型与评审仍是主要时间成本，且跨类最后6条并未全面变快。I27后续305.252秒重跑PASS仅作补充记录，不覆盖原类内批次FAIL；本报告不依赖挑选最快或最好尝试提高成功率。

## 1. 实验范围与方法

### 1.1 样本与编号

| 来源 | 编号 / ordinal | 数量 | 原数据集 |
|---|---|---:|---|
| Instrument | CC-I001～CC-I027 / 1～27 | 27 | [instrument-test/code-clone.json](<C:/Users/RoyCai/Desktop/group_project/arkts-code-smell/dataset/positive/instrument-test/code-clone.json>) |
| Local | CC-L001～CC-L003 / 1～3 | 3 | [local-test/code-clone.json](<C:/Users/RoyCai/Desktop/group_project/arkts-code-smell/dataset/positive/local-test/code-clone.json>) |

I/L表示样本来源，不限定实际测试类型。Instrument的24条记录扁平化为27个异味，Local为3个异味；每个ID对应相应数据集的ordinal，运行目录中的任务名保持原样。生产工作区为 `D:/arktsProgram`。

分类按原源码所属类、组件或顶层函数判定，不直接采用检测消息的“different classes”字样。I21、I25以及L1、L2属于各自同一宿主，纳入类内；I22的两个顶层Builder单列。不同条目可能涉及同一工程、同一文件或关联VM，测试用例也可重复执行，30条不等于30个完全独立实现。

### 1.2 冻结分组、运行版本与证据

| 分组 | 指定样例 | 运行时 / 策略 | 实际执行时段（北京时间） |
|---|---|---|---|
| 类内15条 | I1,3,4,12,15,16,17,20,21,24,25,26,27；L1,2 | `3b3e937` / `2026-11-05-ui-attribution-reactivity` | 11月5日01:31～02:14及08:01～08:13 |
| 跨类14条 | I2,5,6,7,8,9,10,11,13,14,18,19,23；L3 | `2bddaf8` / `2026-11-06-cross-host-clone-evidence` | 11月6日17:20～18:50、19:16～20:38 |
| 顶层Builder 1条 | I22 | `3b3e937` / `2026-11-05-ui-attribution-reactivity` | 11月5日19:21～19:26 |
| 补充重跑，不进入上述30条 | I27，305.252秒PASS | `3b3e937`，独立完整重跑 | 11月5日14:47～14:52 |

里程碑tag `agent-three-groups-passed-20261106` 指向 `ea370d4`，包含上述验证记录及最终运行时，随后已合并回本地 `dev_cly`。tag不是全部分组在同一个最终版本重新执行的证明。类内策略未在跨类专属优化中改写，但本报告仍保留类内实际验证版本。

终端日志统一位于 `C:/Users/RoyCai/Desktop/group_project/TestResult1028`。端到端秒数核对终端RESULT；步骤、状态及返修核对result.json；测试核对test-results.json与test-attempts原始汇总；抽取说明结合review-diff.patch与独立评审。精确映射见附录B。[2026-10-12报告](<C:/Users/RoyCai/Desktop/group_project/TestResult1012/code-clone-experiment-20261012-entry-preservation.md>)仅作为章节和表格格式参考，不沿用其中数据、required配置或结论。

### 1.3 策略、流程和指标

所有选定任务使用Linter **skip**，模型请求 `zhipu-coding/glm-5`，重构/返修请求max，评审不显式指定档位；服务端实际内部档位未独立确认。与10月12日required模式的结果只能并列描述，不能把差异单独归因于某一提示、档位或commit。

执行链为重构Agent（R）→HomeCheck（H）/构建（B）/契约（C）→测试（T）→独立语义评审（S）；H/B/C可并行，附加Linter（L）按skip跳过。门禁失败时按策略返修（A）并重新验证，阻塞或任务总时限会中止后续阶段。

- 最终通过要求业务verdict为PASS；测试PASS或Agent自行声明完成均不能替代整条流水线PASS。
- 限时成功要求最终PASS且类内端到端≤420秒、跨类≤900秒；FAIL、BLOCKED、超时PASS都保留在分母。判定使用未四舍五入的原始秒数。
- totalSeconds包含准备、初始化、重构、实际门禁、返修和评审，截止结果写入；随后回滚和跨批次等待不计入。
- “零返修且最终PASS”只描述选定尝试内部的首次验证结果，不表示此目标此前没有其他历史尝试。
- 步骤耗时只累计result.steps的实际执行项，不重复加总attempts中的副本；并行阶段之和不能作为墙钟耗时或据差额推断初始化开销。
- I19的接口兼容项已由用户确认为项目自身问题，不算重构失败；其原流水线PASS、887.462秒正常计入，不另扣分或删除样例。

## 2. 总体结果与时间指标

### 2.1 按分组验收

| 分组 | 最终PASS | 限时PASS | 限时率 | 严格>70%最少成功数 | 判断 |
|---|---:|---:|---:|---:|---|
| 类内，420秒 | 14/15 | **13/15** | **86.7%** | 11/15 | 达标 |
| 跨类，900秒 | 11/14 | **10/14** | **71.4%** | 10/14 | 达标，刚好达到最低数量 |
| 同文件顶层Builder | 1/1 | 1/1 | 100%（参考420秒） | 不适用 | 单列 |

类内Instrument来源12/13限时通过，Local来源1/2；跨类Instrument来源10/13、Local来源0/1。各子集样本很少，不由整体达标推断每个来源都达标。类内中位数134.414秒，平均222.404秒；跨类中位数698.378秒，平均720.516秒。跨类10条限时PASS平均656.254秒，11条最终PASS平均688.366秒。

### 2.2 30条组合描述统计

以下用于完整呈现报告所选证据，不称为最终版本单批30条成绩。

| 指标 | Instrument来源 | Local来源 | 组合30条 |
| --- | --- | --- | --- |
| 样本 / 最终PASS | 27 / 24 | 3 / 2 | 30 / 26 |
| 最终PASS率 | 88.9% | 66.7% | 86.7% |
| FAIL / BLOCKED / INCOMPLETE | 2 / 1 / 0 | 0 / 1 / 0 | 2 / 2 / 0 |
| 零返修且最终PASS | 23/27 | 2/3 | 25/30 |
| 发生返修任务 / 调用 | 2 / 4 | 1 / 1 | 3 / 5 |
| 按各自阈值限时PASS | 23/27 | 1/3 | 24/30（80.0%，不替代分组） |
| 累计端到端 / 秒 | 11797.329 | 1932.170 | 13729.499 |
| 平均 / 秒 | 436.938 | 644.057 | 457.650 |
| 中位数 / 秒 | 365.821 | 427.913 | 396.867 |
| 最短 / 最长 / 秒 | 100.361 / 1011.259 | 302.427 / 1201.830 | 100.361 / 1201.830 |

类内累计3336.065秒，跨类10087.228秒，顶层306.206秒。组合平均457.650秒、中位数396.867秒；混合均值不能替代各组420/900秒验收。最短I3为100.361秒，最长L3为1201.830秒；跨类I18的365.821秒是提前阻塞，不是快速成功。

## 3. 样例明细与重构方式

### 3.1 逐条结果

行号采用数据集原始定位，不等同于修改后边界。链接指向原生产文件，最终改动与基线位于附录B的任务快照中。

| ID | 原始目标及对照片段 | 分组 / 时限 | 端到端 / 秒 | 终态 | 返修 | 限时通过 |
| --- | --- | --- | --- | --- | --- | --- |
| CC-I001 | [AboutPage.ets:71–124](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/AboutPage.ets>)；↔ [AboutPage.ets:128–185](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/AboutPage.ets>) | 类内 / 420秒 | 116.033 | PASS | 0 | 是 |
| CC-I002 | [DataManager.ets:13–33](<D:/arktsProgram/agc-template-market-harmonyos-demos/BusinessTemplate/OfficeAttendance/scenes/agency/src/main/ets/mock/DataManager.ets>)；↔ [DataManager.ets:13–33](<D:/arktsProgram/agc-template-market-harmonyos-demos/BusinessTemplate/OfficeAttendance/scenes/schedule/src/main/ets/mock/DataManager.ets>) | 跨类 / 900秒 | 520.433 | PASS | 0 | 是 |
| CC-I003 | [PersonalSetting.ets:71–91](<D:/arktsProgram/agc-template-market-harmonyos-demos/CarsTemplate/DriverLicenseExam/products/entry/src/main/ets/pages/mine/PersonalSetting.ets>)；↔ [PersonalSetting.ets:93–113](<D:/arktsProgram/agc-template-market-harmonyos-demos/CarsTemplate/DriverLicenseExam/products/entry/src/main/ets/pages/mine/PersonalSetting.ets>) | 类内 / 420秒 | 100.361 | PASS | 0 | 是 |
| CC-I004 | [QuickLogin.ets:311–370](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/components/login_info/src/main/ets/components/QuickLogin.ets>)；↔ [QuickLogin.ets:453–510](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/components/login_info/src/main/ets/components/QuickLogin.ets>) | 类内 / 420秒 | 134.414 | PASS | 0 | 是 |
| CC-I005 | [PracticeMode.ets:19–139](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/homePage/src/main/ets/model/PracticeMode.ets>)；↔ [PracticeMode.ets:17–139](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/topicPage/src/main/ets/viewModel/PracticeMode.ets>) | 跨类 / 900秒 | 470.957 | PASS | 0 | 是 |
| CC-I006 | [AuthenticationPage.ets:1–71](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/homePage/src/main/ets/pages/AuthenticationPage.ets>)；↔ [AuthenticationPage.ets:1–71](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/AuthenticationPage.ets>) | 跨类 / 900秒 | 718.284 | PASS | 0 | 是 |
| CC-I007 | [CollectionPage.ets:20–46](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/CollectionPage.ets>)；↔ [CoursePage.ets:20–47](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/CoursePage.ets>) | 跨类 / 900秒 | 668.554 | PASS | 0 | 是 |
| CC-I008 | [CollectionPage.ets:73–93](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/CollectionPage.ets>)；↔ [CoursePage.ets:74–94](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/CoursePage.ets>) | 跨类 / 900秒 | 759.918 | PASS | 1 | 是 |
| CC-I009 | [CollectionPage.ets:95–125](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/CollectionPage.ets>)；↔ [CoursePage.ets:96–126](<D:/arktsProgram/agc-template-market-harmonyos-demos/EducationTemplate/Exam/features/minePage/src/main/ets/views/CoursePage.ets>) | 跨类 / 900秒 | 536.124 | PASS | 0 | 是 |
| CC-I010 | [RecommendBar.ets:3–53](<D:/arktsProgram/agc-template-market-harmonyos-demos/EntertainmentTemplate/MuseumTicket/features/home/src/main/ets/component/RecommendBar.ets>)；↔ [RecommendBar.ets:3–53](<D:/arktsProgram/agc-template-market-harmonyos-demos/EntertainmentTemplate/MuseumTicket/features/mine/src/main/ets/components/RecommendBar.ets>) | 跨类 / 900秒 | 774.671 | PASS | 0 | 是 |
| CC-I011 | [AddVisitorPage.ets:1–158](<D:/arktsProgram/agc-template-market-harmonyos-demos/EntertainmentTemplate/MuseumTicket/features/mine/src/main/ets/pages/AddVisitorPage.ets>)；↔ [EditVisitorPage.ets:1–158](<D:/arktsProgram/agc-template-market-harmonyos-demos/EntertainmentTemplate/MuseumTicket/features/mine/src/main/ets/pages/EditVisitorPage.ets>) | 跨类 / 900秒 | 1009.477 | PASS | 0 | 否 |
| CC-I012 | [CommonProductProfile.ets:39–56](<D:/arktsProgram/agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/commons/componentlib/src/main/ets/components/CommonProductProfile.ets>)；↔ [CommonProductProfile.ets:67–84](<D:/arktsProgram/agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/commons/componentlib/src/main/ets/components/CommonProductProfile.ets>) | 类内 / 420秒 | 173.058 | PASS | 0 | 是 |
| CC-I013 | [EditNamePage.ets:18–70](<D:/arktsProgram/agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/scenes/tab/mine/src/main/ets/pages/EditNamePage.ets>)；↔ [EditPhonePage.ets:18–70](<D:/arktsProgram/agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/scenes/tab/mine/src/main/ets/pages/EditPhonePage.ets>) | 跨类 / 900秒 | 547.670 | PASS | 0 | 是 |
| CC-I014 | [EditNamePageVM.ets:6–40](<D:/arktsProgram/agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/scenes/tab/mine/src/main/ets/viewModels/EditNamePageVM.ets>)；↔ [EditPhonePageVM.ets:6–40](<D:/arktsProgram/agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/scenes/tab/mine/src/main/ets/viewModels/EditPhonePageVM.ets>) | 跨类 / 900秒 | 678.471 | PASS | 0 | 是 |
| CC-I015 | [TimeCtrl.ets:90–100](<D:/arktsProgram/agc-template-market-harmonyos-demos/KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets>)；↔ [TimeCtrl.ets:114–124](<D:/arktsProgram/agc-template-market-harmonyos-demos/KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets>) | 类内 / 420秒 | 103.297 | PASS | 0 | 是 |
| CC-I016 | [TimeCtrl.ets:165–179](<D:/arktsProgram/agc-template-market-harmonyos-demos/KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets>)；↔ [TimeCtrl.ets:189–203](<D:/arktsProgram/agc-template-market-harmonyos-demos/KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets>) | 类内 / 420秒 | 161.632 | PASS | 0 | 是 |
| CC-I017 | [PictureBeautification.ets:443–475](<D:/arktsProgram/agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets>)；↔ [PictureBeautification.ets:557–588](<D:/arktsProgram/agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets>) | 类内 / 420秒 | 227.328 | PASS | 0 | 是 |
| CC-I018 | [HomeVisit.ets:8–59](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_home/src/main/ets/components/HomeVisit.ets>)；↔ [ShippingInfo.ets:9–61](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_home/src/main/ets/components/ShippingInfo.ets>) | 跨类 / 900秒 | 365.821 | BLOCKED | 0 | 否 |
| CC-I019 | [EditNamePage.ets:18–70](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_mine/src/main/ets/pages/EditNamePage.ets>)；↔ [EditPhonePage.ets:18–70](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_mine/src/main/ets/pages/EditPhonePage.ets>) | 跨类 / 900秒 | 887.462 | PASS | 0 | 是 |
| CC-I020 | [ActivityBooking.ets:70–88](<D:/arktsProgram/agc-template-market-harmonyos-demos/KidsTemplate/PostpartumCareCenter/scenes/activities/src/main/ets/view/ActivityBooking.ets>)；↔ [ActivityBooking.ets:118–136](<D:/arktsProgram/agc-template-market-harmonyos-demos/KidsTemplate/PostpartumCareCenter/scenes/activities/src/main/ets/view/ActivityBooking.ets>) | 类内 / 420秒 | 136.602 | PASS | 0 | 是 |
| CC-I021 | [AboutUs.ets:42–57](<D:/arktsProgram/agc-template-market-harmonyos-demos/LifestyleAndServiceTemplate/AdministrativeAffairs/Application/commons/components/src/main/ets/components/AboutUs.ets>)；↔ [AboutUs.ets:63–78](<D:/arktsProgram/agc-template-market-harmonyos-demos/LifestyleAndServiceTemplate/AdministrativeAffairs/Application/commons/components/src/main/ets/components/AboutUs.ets>) | 类内 / 420秒 | 103.108 | PASS | 0 | 是 |
| CC-I022 | [SubmitPointConfirm.ets:15–36](<D:/arktsProgram/agc-template-market-harmonyos-demos/LifestyleAndServiceTemplate/ShoppingMall/components/module_points/src/main/ets/components/SubmitPointConfirm.ets>)；↔ [SubmitPointConfirm.ets:60–81](<D:/arktsProgram/agc-template-market-harmonyos-demos/LifestyleAndServiceTemplate/ShoppingMall/components/module_points/src/main/ets/components/SubmitPointConfirm.ets>) | 顶层Builder / 420秒参考 | 306.206 | PASS | 0 | 是 |
| CC-I023 | [MyFavoritesPage.ets:8–32](<D:/arktsProgram/agc-template-market-harmonyos-demos/MovieTVAndLivestreamingTemplate/WebShortDrama/features/mine/src/main/ets/pages/MyFavoritesPage.ets>)；↔ [WatchRecordsPage.ets:8–32](<D:/arktsProgram/agc-template-market-harmonyos-demos/MovieTVAndLivestreamingTemplate/WebShortDrama/features/mine/src/main/ets/pages/WatchRecordsPage.ets>) | 跨类 / 900秒 | 947.556 | FAIL | 0 | 否 |
| CC-I024 | [HomePage.ets:194–209](<D:/arktsProgram/agc-template-market-harmonyos-demos/NavigationTemplate/AirTrip/Application/features/home/src/main/ets/pages/HomePage.ets>)；↔ [HomePage.ets:238–253](<D:/arktsProgram/agc-template-market-harmonyos-demos/NavigationTemplate/AirTrip/Application/features/home/src/main/ets/pages/HomePage.ets>) | 类内 / 420秒 | 119.114 | PASS | 0 | 是 |
| CC-I025 | [StickerToolBar.ets:78–131](<D:/arktsProgram/agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/components/StickerToolBar.ets>)；↔ [StickerToolBar.ets:141–194](<D:/arktsProgram/agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/components/StickerToolBar.ets>) | 类内 / 420秒 | 116.934 | PASS | 0 | 是 |
| CC-I026 | [TransactionDatasetMock.ets:49–61](<D:/arktsProgram/agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/commons/network/src/main/ets/mocks/mockData/TransactionDatasetMock.ets>)；↔ [TransactionDatasetMock.ets:82–94](<D:/arktsProgram/agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/commons/network/src/main/ets/mocks/mockData/TransactionDatasetMock.ets>) | 类内 / 420秒 | 102.585 | PASS | 0 | 是 |
| CC-I027 | [PictureBeautification.ets:476–487](<D:/arktsProgram/agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets>)；↔ [PictureBeautification.ets:590–600](<D:/arktsProgram/agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets>) | 类内 / 420秒 | 1011.259 | FAIL | 3 | 否 |
| CC-L001 | [CartPageLogic.ets:139–156](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/ComprehensiveMall/modules/scene/shopping/src/main/ets/logic/CartPageLogic.ets>)；↔ [CartPageLogic.ets:238–255](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/ComprehensiveMall/modules/scene/shopping/src/main/ets/logic/CartPageLogic.ets>) | 类内 / 420秒 | 427.913 | PASS | 0 | 否 |
| CC-L002 | [CartPageLogic.ets:122–139](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/ComprehensiveMall/scenes/shopping/src/main/ets/logic/CartPageLogic.ets>)；↔ [CartPageLogic.ets:181–198](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/ComprehensiveMall/scenes/shopping/src/main/ets/logic/CartPageLogic.ets>) | 类内 / 420秒 | 302.427 | PASS | 0 | 是 |
| CC-L003 | [EditNamePageVM.ets:10–49](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_mine/src/main/ets/viewModels/EditNamePageVM.ets>)；↔ [EditPhonePageVM.ets:10–49](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_mine/src/main/ets/viewModels/EditPhonePageVM.ets>) | 跨类 / 900秒 | 1201.830 | BLOCKED | 1 | 否 |

### 3.2 抽取方式与语义核对

下表记录实际产物和评审支持的抽取方式；FAIL/BLOCKED只描述尝试，不当作已验证重构。

| ID | 抽取方式及验证结论 |
| --- | --- |
| CC-I001 | 同宿主提取 aboutArrowView、aboutLabelView(label,value)，参数化文案与数值，保留原调用位置。 |
| CC-I002 | 提取共享 `MockDataStore<T>`，原 DataManager 静态方法薄委托；不同ID访问器、存储键和独立STORE实例保留。 |
| CC-I003 | 同宿主 @Builder settingItem(title,itemId)，保留原协议入口和回调时读取。 |
| CC-I004 | 同宿主 @Builder PrivacyContent(idPrefix)，保留两组UI ID前缀、状态读取与事件回调。 |
| CC-I005 | 共享 `CommonDataSource<T>` 与 PRACTICE_ITEM_DATA；原类名、构造入口及各自图片字段/对象身份保留。 |
| CC-I006 | 将已核实的重复长文案提取为 AUTHENTICATION_AGREEMENT_TEXT，共享常量而保留外围页面和属性。 |
| CC-I007 | 提取 SelectListPageIds 与 @ObservedV2/@Trace SelectListPageState；每组件独立状态，保留删除与选择逻辑差异。 |
| CC-I008 | 提取 DeleteButtonBar 共享删除骨架；首次 @Require @Event 组合编译失败，一次返修后通过。 |
| CC-I009 | 共享 OrderSelectionHelper 的全选/过滤逻辑；保留isDelete判定、selectCount守卫及状态写入顺序。 |
| CC-I010 | 提取 RecommendBarView，共享UI骨架、显式传递标题/价格/ID前缀；保留两端原有文案与资源。 |
| CC-I011 | 提取 VisitorForm 与 VisitorFormLogic，页面保留NavDestination、Builder及各自初始化/保存流程；零返修但超900秒。 |
| CC-I012 | 同宿主 actionBuilder(text,actionId,toastMessage)，保留产品状态读取及每个动作的文案/ID。 |
| CC-I013 | 提取 EditFieldForm，原页面保留VM和路由根，以参数和回调共享内部表单。 |
| CC-I014 | 提取 EditUserInfoVMCore 静态Helper，保留原VM单例、Trace字段、init/clear/modify与昵称/手机差异。 |
| CC-I015 | 同宿主 showTimePickerDialog(onAccept)合并四处配置，差异保留为状态写入回调。 |
| CC-I016 | 同宿主 showTimePickerDialog(onAccept)共享四处时间选择配置，保留各调用点的字段与时机。 |
| CC-I017 | 提取 copyClipRect、limitClipRectToBounds、applyClipRect；保留free/ratio各自计算分支和一次状态赋值。 |
| CC-I018 | 尝试提取 BottomSheetDialogOptions，控制器留在宿主但CustomContentDialog创建仍进入普通函数；设备进程死亡，未获完整验证。 |
| CC-I019 | 原页面保留NavDestination及生命周期，委托 EditFieldPage 显式传入差异与回调。 |
| CC-I020 | 同宿主 bookingTextInput 共享TextInput链，保留各实例ID、绑定与回调。 |
| CC-I021 | 同宿主 ListRowBuilder 共享行结构，以参数保留文案、UI ID及路由回调。 |
| CC-I022 | 同文件私有 @Builder pointConfirmActionButtons(idPrefix,param)，两个顶层导出Builder委托，单列统计。 |
| CC-I023 | 模型输出长度终止前仅完成读取/搜索，没有允许的生产代码修改，不能列为已完成抽取。 |
| CC-I024 | 同宿主 CitySelectorView；城市/ID等差异参数化，响应式字段保留在Builder中按分支读取。 |
| CC-I025 | 同宿主 stickerGridBuilder，共享搜索/内容网格，保留不同ID和原有状态/事件。 |
| CC-I026 | 同类私有静态 groupByMonth 合并分组骨架，公共静态入口和过滤分支保持。 |
| CC-I027 | 首轮抽取 clampClipRectToImageArea，设备断言失败后返修又引入balance逻辑及本地数值回归；原批最终FAIL。 |
| CC-L001 | 同类 buildCartCards 共享DTO到VM构造；正常测试通过，但事后离线检查发现循环中途异常的部分结果差异。 |
| CC-L002 | 同类 toCartCards 共享映射循环；正常测试通过，异常时部分结果仍需按历史审计保留限制。 |
| CC-L003 | 提取 EditFieldPageHelper，返修处理UserInfo可空声明与连接兜底；Local24/24通过，评审总超时，未获最终等价结论。 |

## 4. 测试门禁与执行证据

### 4.1 最后一次实际测试

26条最终PASS任务共42个成功测试作业、**290/290次用例执行通过**：33个设备作业181次、9个Local作业109次。它们按实际执行次数统计，不跨任务或重复套件去重。

若包含最终BLOCKED的L3测试，所有任务末次测试中有44个成功作业、314次通过；另有I27末次Local 17/18失败和I18设备进程死亡。末次已启动测试作业共46个（44PASS、1FAIL、1BLOCKED）；I27与I18后续未执行的计划作业不记作已启动测试。I23没有进入测试阶段。

| ID | 最后一次实际测试 | 测试记录 |
| --- | --- | --- |
| CC-I001 | 设备 book_person/AboutPageTest：1/1 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013107-Dl3NxD/code-clone-0001-AboutPage/test-results.json>) |
| CC-I002 | Local agency/DataManagerTest：8/8<br>设备 agency/DataManagerTest：4/4<br>Local schedule/DataManagerTest：7/7<br>设备 schedule/ScheduleDataManagerTest：2/2 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-183247-U1CWvU/code-clone-0001-DataManager/test-results.json>) |
| CC-I003 | 设备 entry/PersonalSettingTest：3/3 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013305-0CFz5u/code-clone-0001-PersonalSetting/test-results.json>) |
| CC-I004 | 设备 login_info/QuickLoginCoverTest：5/5 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013447-1j46XB/code-clone-0001-QuickLogin/test-results.json>) |
| CC-I005 | 设备 homePage/PracticeModeInstrumentTest：5/5<br>设备 topicPage/PracticeModeInstrumentTest：7/7 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-191613-r0tnh1/code-clone-0001-PracticeMode/test-results.json>) |
| CC-I006 | 设备 homePage/AuthenticationPageInstrumentTest：2/2<br>设备 minePage/AuthenticationPageInstrumentTest：2/2 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-172002-FupOJN/code-clone-0001-AuthenticationPage/test-results.json>) |
| CC-I007 | 设备 minePage/CollectionPageInstrumentTest：6/6<br>设备 minePage/CoursePageInstrumentTest：1/1 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-192406-dVkWji/code-clone-0001-CollectionPage/test-results.json>) |
| CC-I008 | 设备 minePage/CollectionPageInstrumentTest：6/6<br>设备 minePage/CoursePageInstrumentTest：1/1 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-173202-hekixf/code-clone-0001-CollectionPage/test-results.json>) |
| CC-I009 | 设备 minePage/CollectionPageInstrumentTest：6/6<br>设备 minePage/CoursePageInstrumentTest：1/1 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-193516-BqrizZ/code-clone-0001-CollectionPage/test-results.json>) |
| CC-I010 | 设备 home/RecommendBarTest：3/3<br>设备 mine/MineRecommendBarTest：3/3 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-194413-cwCLfM/code-clone-0001-RecommendBar/test-results.json>) |
| CC-I011 | 设备 mine/AddVisitorPageTest：14/14<br>设备 mine/EditVisitorPageTest：10/10 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-195708-af2IVJ/code-clone-0001-AddVisitorPage/test-results.json>) |
| CC-I012 | 设备 componentlib/CommonProductProfileTest：2/2 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013703-oYOsgh/code-clone-0001-CommonProductProfile/test-results.json>) |
| CC-I013 | 设备 mine/EditNamePageTest：8/8<br>设备 mine/EditPhonePageTest：8/8 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-184128-d6jHs7/code-clone-0001-EditNamePage/test-results.json>) |
| CC-I014 | 设备 mine/EditNamePageVMTest：9/9<br>设备 mine/EditPhonePageVMTest：10/10 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-174444-Y3SOuG/code-clone-0001-EditNamePageVM/test-results.json>) |
| CC-I015 | Local minepage/TimeCtrlTest：24/24 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013957-FhWLha/code-clone-0001-TimeCtrl/test-results.json>) |
| CC-I016 | Local minepage/TimeCtrlTest：24/24 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-014141-WhCNfv/code-clone-0001-TimeCtrl/test-results.json>) |
| CC-I017 | Local picture_beautification/PictureBeautificationTest：18/18<br>设备 picture_beautification/PictureBeautificationTest：25/25 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-014424-eyJUtS/code-clone-0001-PictureBeautification/test-results.json>) |
| CC-I018 | 设备 business_home/HomeVisitTest：BLOCKED，App died | [未全部通过](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-175603-RUDoW5/code-clone-0001-HomeVisit/test-results.json>) |
| CC-I019 | 设备 business_mine/EditNamePageTest：5/5<br>设备 business_mine/EditPhonePageTest：5/5 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-180210-eir8hN/code-clone-0001-EditNamePage/test-results.json>) |
| CC-I020 | 设备 activities/ActivityBookingUiTest：1/1 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-014812-0hS7ab/code-clone-0001-ActivityBooking/test-results.json>) |
| CC-I021 | 设备 components/模块可达套件：4/4 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015029-X5Of8n/code-clone-0001-AboutUs/test-results.json>) |
| CC-I022 | 设备 module_points/SubmitPointConfirmTest：3/3 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-192137-Qb898v/code-clone-0001-SubmitPointConfirm/test-results.json>) |
| CC-I023 | Agent失败，未执行 | — |
| CC-I024 | 设备 home/模块可达套件：7/7 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015213-uE45SJ/code-clone-0001-HomePage/test-results.json>) |
| CC-I025 | 设备 picture_beautification/StickerToolBarInstrumentTest：8/8 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015413-mC9ZyQ/code-clone-0001-StickerToolBar/test-results.json>) |
| CC-I026 | 设备 network/TransactionDatasetMockTest：4/4 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015612-7BIi2J/code-clone-0001-TransactionDatasetMock/test-results.json>) |
| CC-I027 | Local picture_beautification/PictureBeautificationTest：17/18 FAIL | [未全部通过](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015755-mPQfbj/code-clone-0001-PictureBeautification/test-results.json>) |
| CC-L001 | Local scene_shopping_v2/CartPageLogicTest：7/7<br>Local shopping/CartPageLogicTest：7/7 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-080113-iUtyaG/code-clone-0001-CartPageLogic/test-results.json>) |
| CC-L002 | Local scene_shopping_v2/CartPageLogicTest：7/7<br>Local shopping/CartPageLogicTest：7/7 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-080824-X1zCYL/code-clone-0001-CartPageLogic/test-results.json>) |
| CC-L003 | Local business_mine/EditNamePageVMTest：12/12<br>Local business_mine/EditPhonePageVMTest：12/12 | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-201844-OwZJf3/code-clone-0001-EditNamePageVM/test-results.json>) |

### 4.2 返修重测与覆盖边界

计入所有test-attempts中的实际测试尝试，共51个已启动作业：45PASS、5FAIL、1BLOCKED。有有效用例汇总的执行共411次，407PASS、4Failure、0Error。另一个FAIL为L3首轮Local测试编译失败，没有本次有效用例汇总；I18 BLOCKED也没有完整汇总。不能将编译诊断数或未执行的pending作业数写成失败用例数。

类内I27共4次测试尝试：首轮Local18/18、设备24/25，三次返修均Local17/18，后续设备作业因fail-fast未执行。L1、L2每条都运行两个模块中的CartPageLogicTest，各7/7；这不等于28个独立测试函数。I15/I16实际是Local24/24，不能因其Instrument数据集来源称为设备覆盖。

跨类14条有26个成功作业157次用例通过，其中22个设备作业原始完成码为0；这包含L3最终BLOCKED前的24次Local测试。只计跨类最终PASS任务为133次用例执行。成功测试与任务最终状态分别记录，测试通过但评审超时的L3仍为BLOCKED。

覆盖率采集被启用不等于覆盖率报告完整。若干设备日志有00507008/getInitCoverageData错误，既有审计已将测试完成证据与覆盖率生成分开核对；本报告未重算方法级行/分支覆盖率，不用相关百分比证明所有异常路径等价。

## 5. 语义评审与结果边界

26条最终PASS均有有效独立评审。类内14份评审均未列issue，但此前针对L1/L2保存产物的离线故障注入发现：将逐项push改为helper构建完数组后返回时，如果循环中途抛错，基线可保留此前部分结果，新实现得到空列表。正常输入结果一致，这不证明生产环境一定会出现该异常，也不是设备实测；却说明正常测试和评审PASS不能覆盖所有异常路径。该事实保留，原流水线计数不改写。

I27首轮设备断言失败后，原代码与首次重构代码各两次纯测试对照均通过，支持初次失败具有波动性，但未确定机制。纯测试诊断以及后续305.252秒完整重跑均不覆盖原15条批次的FAIL。用户已明确暂不修改裁剪比例业务算法，因此不将业务特判作为当前实验结论的前提。

I18没有完整测试汇总，I23没有生产修改，L3没有完成评审，均不能凭某个前置阶段通过升级为PASS。当前两组“达标”指已定义流水线与限时口径；required配置、独立新工程或重复运行稳定性仍未由本报告证明。

## 6. 失败与返修分析

| 样例 | 触发位置 | 返修调用 / 秒数 | 终态与影响 |
|---|---|---:|---|
| I27，类内 | 首轮设备boundsChanged断言失败；返修后出现Local数值回归 | 3 / 731.580 | FAIL，1011.259秒；保留原批失败 |
| I8，跨类 | DeleteButtonBar的@Require与@Event组合不合法，构建10905325 | 1 / 76.833 | 修复后PASS，759.918秒，仍限时成功 |
| L3，跨类 | Local测试编译报vm.userInfo可能undefined | 1 / 394.410 | 返修后测试24/24，评审总超时，BLOCKED |
| I18，跨类 | 首个设备用例App died、无完整Hypium汇总 | 0 | BLOCKED，365.821秒，评审未执行 |
| I23，跨类 | 模型step_finish.reason=length，未产生生产修改 | 0 | FAIL，947.556秒，门禁未执行 |

I27的三轮返修分别302.581、251.119、177.880秒。初始设备失败的实际断言是边界是否变化，不能仅据测试名推导新比例算法；后续返修从原Local18/18变成17/18，属于真实新回归证据。

L3的可空声明在原始与首次重构源码中均存在，旧轮首次测试也出现同样诊断，不能把它简单归因于本轮新引入。首轮Agent625.866秒、返修394.410秒后，评审仅运行104.748秒即被1200秒总时限中止。没有有效评审结论，不能把通过的Local测试代替最终验收。

I18虽保留了new CustomDialogController的位置，仍将配置内CustomContentDialog创建移入普通函数，说明“配置”可能含依赖宿主的框架创建逻辑。这是与死亡现象相关的定位线索，不是缺少崩溃栈情况下已证实的唯一根因。I23整轮13 read、8 grep、1 glob而无edit/write/bash，最后一步报告reasoning32728和output40、reason=length，属于模型输出长度终止，非1200秒任务总超时。

## 7. 耗时构成与性能观察

### 7.1 分阶段耗时

| 阶段 | 实际调用 | PASS / FAIL / BLOCKED | 类内 / 秒 | 跨类 / 秒 | 顶层 / 秒 | 合计 / 秒 | 占组合端到端 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R：首轮重构 | 30 | 29 / 1 / 0 | 998.588 | 6814.937 | 202.184 | 8015.709 | 58.4% |
| A：返修Agent | 5 | 5 / 0 / 0 | 731.580 | 471.243 | 0.000 | 1202.823 | 8.8% |
| H：HomeCheck | 34 | 34 / 0 / 0 | 88.412 | 62.877 | 3.888 | 155.177 | 1.1% |
| B：构建 | 34 | 33 / 1 / 0 | 479.728 | 318.267 | 17.670 | 815.665 | 5.9% |
| C：公共契约 | 34 | 34 / 0 / 0 | 2.119 | 1.667 | 0.092 | 3.878 | 0.0% |
| T：测试 | 33 | 27 / 5 / 1 | 857.009 | 1040.120 | 23.350 | 1920.479 | 14.0% |
| L：Linter | 0 | 0 / 0 / 0 | 0.000 | 0.000 | 0.000 | 0.000 | 0.0% |
| S：独立评审 | 27 | 26 / 0 / 1 | 240.689 | 1419.860 | 61.816 | 1722.365 | 12.5% |

执行项累计13836.096秒，包含可并行阶段；它与端到端13729.499秒不是互斥分解，不能将差额解释为初始化或纯模型推理。R+A+S累计10940.897秒，约为组合端到端的79.7%，说明Agent相关时间仍占主要量级，但其中包括服务等待、工具交互和子进程时间。

### 7.2 六条未限时成功样例

| ID | 分组 / 阈值 | 端到端 / 秒 | 状态 | 时间或质量瓶颈 |
|---|---|---:|---|---|
| I27 | 类内 / 420 | 1011.259 | FAIL | 初始测试失败后3次返修，仍失败 |
| L1 | 类内 / 420 | 427.913 | PASS | 超7.913秒；Agent205.431、build74.227、test116.493秒 |
| I11 | 跨类 / 900 | 1009.477 | PASS | 超109.477秒；首轮Agent599.927秒，测试302.976秒 |
| I18 | 跨类 / 900 | 365.821 | BLOCKED | 时间未超目标，但设备进程死亡，不能计成功 |
| I23 | 跨类 / 900 | 947.556 | FAIL | 输出长度耗尽且无修改 |
| L3 | 跨类 / 900 | 1201.830 | BLOCKED | 测试返修消耗大部分预算，评审中止 |

### 7.3 优化效果与余量

跨类限时成功从优化前固定组的8/14（57.1%）提高到10/14（71.4%）：I6/I8/I14/I19新增四条，I11/L3回退两条，净增两条。I14和I19省掉原先长返修；I8仍复现相同装饰器错误，本次主要是返修和评审缩短。不能将其描述为所有问题已根治。

跨类B批六条端到端均比各自历史记录更慢；I11测试302.976秒与旧299.587秒基本相同，回退主要来自首轮Agent264.401→599.927秒。I5未获得新增跨宿主画像却也变慢，说明无法把时间变化全部归因于新分析器。不同执行时段、模型输出和外部状态未控制，不据单次耗时差值作因果结论。

类内15条已达到本轮目标，I27保持历史失败与后续重跑记录分离。跨类10/14正好达到最低成功数量，I19仅有12.538秒余量；后续如继续研究，应优先关注I11首轮探索、L3返修/评审预算与I18宿主创建边界，保持原门禁和计时规则，不通过换分母或挑选重试结果宣称稳定提升。

## 8. 基线、回滚与验收结论

类内原15条审计完成2527项源码SHA-256核对，全部匹配运行前快照；当前跨类14条复核2925项、1222个唯一源码文件，当前源码和备份均匹配，无新增/缺失/改动残留。核对范围沿用原脚本.ets/.ts及忽略规则，不覆盖所有资源、签名、配置、SDK或设备状态。顶层I22在原扩测审计中有RESULT/ROLLBACK_SNAPSHOT/END及快照核对记录。

各样例采用运行前快照恢复，不把业务工程重置到Git HEAD。实验脚本只由用户执行，日志保存在指定目录；本次报告整理只读取已有证据，没有运行tools脚本、模型、构建或设备，也没有修改原始结果、生产代码或测试断言。

**验收结论：所选冻结类内组13/15（86.7%）和当前跨类同版本组10/14（71.4%）均达到严格>70%的限时PASS目标。** 顶层Builder单列，I27补跑单列；两组实际版本不同，不将本报告改写为最终tag版本一次全量30条实验。

## 附录 A：逐任务阶段耗时

单位为秒。R首轮Agent、A全部返修、H异味复检、B构建、C公共契约、T测试、L附加Linter、S独立评审；仅累计实际执行steps。所有L为0表示skip，不表示已执行并通过。并行步骤不可与端到端直接相减解释开销。

| ID | R | A | H | B | C | T | L | S | 端到端 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CC-I001 | 37.835 | 0.000 | 4.359 | 25.856 | 0.111 | 40.555 | 0.000 | 10.457 | 116.033 |
| CC-I002 | 349.363 | 0.000 | 4.025 | 18.603 | 0.112 | 77.646 | 0.000 | 73.689 | 520.433 |
| CC-I003 | 29.855 | 0.000 | 4.241 | 21.488 | 0.086 | 36.460 | 0.000 | 10.969 | 100.361 |
| CC-I004 | 59.918 | 0.000 | 4.129 | 26.114 | 0.094 | 28.604 | 0.000 | 17.064 | 134.414 |
| CC-I005 | 316.440 | 0.000 | 4.396 | 23.147 | 0.134 | 54.908 | 0.000 | 74.315 | 470.957 |
| CC-I006 | 444.535 | 0.000 | 4.673 | 28.479 | 0.124 | 70.391 | 0.000 | 172.865 | 718.284 |
| CC-I007 | 423.503 | 0.000 | 4.241 | 21.926 | 0.115 | 65.143 | 0.000 | 156.297 | 668.554 |
| CC-I008 | 468.593 | 76.833 | 7.892 | 45.318 | 0.218 | 71.203 | 0.000 | 95.625 | 759.918 |
| CC-I009 | 387.010 | 0.000 | 3.728 | 20.688 | 0.100 | 64.285 | 0.000 | 62.327 | 536.124 |
| CC-I010 | 502.147 | 0.000 | 4.442 | 20.934 | 0.111 | 72.567 | 0.000 | 177.930 | 774.671 |
| CC-I011 | 599.927 | 0.000 | 4.768 | 22.017 | 0.115 | 302.976 | 0.000 | 83.610 | 1009.477 |
| CC-I012 | 84.217 | 0.000 | 4.275 | 25.744 | 0.118 | 44.923 | 0.000 | 15.981 | 173.058 |
| CC-I013 | 366.088 | 0.000 | 4.091 | 20.063 | 0.107 | 46.739 | 0.000 | 113.151 | 547.670 |
| CC-I014 | 527.215 | 0.000 | 4.356 | 20.825 | 0.120 | 50.578 | 0.000 | 77.749 | 678.471 |
| CC-I015 | 52.596 | 0.000 | 4.492 | 20.924 | 0.089 | 19.227 | 0.000 | 9.593 | 103.297 |
| CC-I016 | 105.374 | 0.000 | 4.962 | 22.093 | 0.106 | 19.456 | 0.000 | 13.797 | 161.632 |
| CC-I017 | 63.137 | 0.000 | 4.308 | 20.189 | 0.091 | 116.350 | 0.000 | 26.311 | 227.328 |
| CC-I018 | 314.005 | 0.000 | 4.119 | 20.311 | 0.096 | 29.875 | 0.000 | 0.000 | 365.821 |
| CC-I019 | 543.967 | 0.000 | 4.002 | 20.102 | 0.118 | 94.443 | 0.000 | 227.554 | 887.462 |
| CC-I020 | 58.290 | 0.000 | 4.273 | 21.523 | 0.096 | 39.032 | 0.000 | 16.779 | 136.602 |
| CC-I021 | 36.666 | 0.000 | 3.631 | 20.245 | 0.109 | 31.584 | 0.000 | 13.589 | 103.108 |
| CC-I022 | 202.184 | 0.000 | 3.888 | 17.670 | 0.092 | 23.350 | 0.000 | 61.816 | 306.206 |
| CC-I023 | 946.278 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 947.556 |
| CC-I024 | 40.925 | 0.000 | 3.784 | 21.732 | 0.090 | 37.405 | 0.000 | 17.840 | 119.114 |
| CC-I025 | 45.298 | 0.000 | 3.564 | 19.634 | 0.098 | 31.290 | 0.000 | 19.785 | 116.934 |
| CC-I026 | 40.301 | 0.000 | 3.557 | 24.131 | 0.093 | 26.150 | 0.000 | 9.735 | 102.585 |
| CC-I027 | 52.356 | 731.580 | 15.441 | 68.386 | 0.383 | 157.662 | 0.000 | 0.000 | 1011.259 |
| CC-L001 | 205.431 | 0.000 | 12.236 | 74.227 | 0.324 | 116.493 | 0.000 | 26.800 | 427.913 |
| CC-L002 | 86.389 | 0.000 | 11.160 | 67.442 | 0.231 | 111.818 | 0.000 | 31.989 | 302.427 |
| CC-L003 | 625.866 | 394.410 | 8.144 | 35.854 | 0.197 | 39.366 | 0.000 | 104.748 | 1201.830 |

## 附录 B：运行产物索引

以下结果、评审、终端日志均对应本报告选定的一次任务。目录还保留task、提示、Agent日志、测试计划/归档、基线、生产diff及必要的返修材料。未取得有效评审的条目不链接不存在的review文件。

| ID | 运行批次 / 任务 | 终端日志 | 最终结果 | 终态评审 |
| --- | --- | --- | --- | --- |
| CC-I001 | `20261105-013107-Dl3NxD/code-clone-0001-AboutPage` | [output20261105-013106-711.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-013106-711.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013107-Dl3NxD/code-clone-0001-AboutPage/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013107-Dl3NxD/code-clone-0001-AboutPage/review.json>) |
| CC-I002 | `20261106-183247-U1CWvU/code-clone-0001-DataManager` | [output20261106-183246-100.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-183246-100.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-183247-U1CWvU/code-clone-0001-DataManager/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-183247-U1CWvU/code-clone-0001-DataManager/review.json>) |
| CC-I003 | `20261105-013305-0CFz5u/code-clone-0001-PersonalSetting` | [output20261105-013303-853.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-013303-853.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013305-0CFz5u/code-clone-0001-PersonalSetting/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013305-0CFz5u/code-clone-0001-PersonalSetting/review.json>) |
| CC-I004 | `20261105-013447-1j46XB/code-clone-0001-QuickLogin` | [output20261105-013445-436.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-013445-436.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013447-1j46XB/code-clone-0001-QuickLogin/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013447-1j46XB/code-clone-0001-QuickLogin/review.json>) |
| CC-I005 | `20261106-191613-r0tnh1/code-clone-0001-PracticeMode` | [output20261106-191612-030.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-191612-030.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-191613-r0tnh1/code-clone-0001-PracticeMode/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-191613-r0tnh1/code-clone-0001-PracticeMode/review.json>) |
| CC-I006 | `20261106-172002-FupOJN/code-clone-0001-AuthenticationPage` | [output20261106-172000-207.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-172000-207.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-172002-FupOJN/code-clone-0001-AuthenticationPage/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-172002-FupOJN/code-clone-0001-AuthenticationPage/review.json>) |
| CC-I007 | `20261106-192406-dVkWji/code-clone-0001-CollectionPage` | [output20261106-192404-570.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-192404-570.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-192406-dVkWji/code-clone-0001-CollectionPage/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-192406-dVkWji/code-clone-0001-CollectionPage/review.json>) |
| CC-I008 | `20261106-173202-hekixf/code-clone-0001-CollectionPage` | [output20261106-173200-676.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-173200-676.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-173202-hekixf/code-clone-0001-CollectionPage/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-173202-hekixf/code-clone-0001-CollectionPage/review-repair-1.json>) |
| CC-I009 | `20261106-193516-BqrizZ/code-clone-0001-CollectionPage` | [output20261106-193514-667.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-193514-667.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-193516-BqrizZ/code-clone-0001-CollectionPage/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-193516-BqrizZ/code-clone-0001-CollectionPage/review.json>) |
| CC-I010 | `20261106-194413-cwCLfM/code-clone-0001-RecommendBar` | [output20261106-194412-110.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-194412-110.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-194413-cwCLfM/code-clone-0001-RecommendBar/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-194413-cwCLfM/code-clone-0001-RecommendBar/review.json>) |
| CC-I011 | `20261106-195708-af2IVJ/code-clone-0001-AddVisitorPage` | [output20261106-195707-499.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-195707-499.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-195708-af2IVJ/code-clone-0001-AddVisitorPage/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-195708-af2IVJ/code-clone-0001-AddVisitorPage/review.json>) |
| CC-I012 | `20261105-013703-oYOsgh/code-clone-0001-CommonProductProfile` | [output20261105-013701-922.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-013701-922.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013703-oYOsgh/code-clone-0001-CommonProductProfile/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013703-oYOsgh/code-clone-0001-CommonProductProfile/review.json>) |
| CC-I013 | `20261106-184128-d6jHs7/code-clone-0001-EditNamePage` | [output20261106-184127-203.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-184127-203.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-184128-d6jHs7/code-clone-0001-EditNamePage/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-184128-d6jHs7/code-clone-0001-EditNamePage/review.json>) |
| CC-I014 | `20261106-174444-Y3SOuG/code-clone-0001-EditNamePageVM` | [output20261106-174442-595.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-174442-595.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-174444-Y3SOuG/code-clone-0001-EditNamePageVM/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-174444-Y3SOuG/code-clone-0001-EditNamePageVM/review.json>) |
| CC-I015 | `20261105-013957-FhWLha/code-clone-0001-TimeCtrl` | [output20261105-013956-932.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-013956-932.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013957-FhWLha/code-clone-0001-TimeCtrl/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-013957-FhWLha/code-clone-0001-TimeCtrl/review.json>) |
| CC-I016 | `20261105-014141-WhCNfv/code-clone-0001-TimeCtrl` | [output20261105-014140-976.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-014140-976.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-014141-WhCNfv/code-clone-0001-TimeCtrl/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-014141-WhCNfv/code-clone-0001-TimeCtrl/review.json>) |
| CC-I017 | `20261105-014424-eyJUtS/code-clone-0001-PictureBeautification` | [output20261105-014423-354.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-014423-354.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-014424-eyJUtS/code-clone-0001-PictureBeautification/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-014424-eyJUtS/code-clone-0001-PictureBeautification/review.json>) |
| CC-I018 | `20261106-175603-RUDoW5/code-clone-0001-HomeVisit` | [output20261106-175602-305.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-175602-305.log>) | [BLOCKED](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-175603-RUDoW5/code-clone-0001-HomeVisit/result.json>) | 未取得有效评审 |
| CC-I019 | `20261106-180210-eir8hN/code-clone-0001-EditNamePage` | [output20261106-180209-234.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-180209-234.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-180210-eir8hN/code-clone-0001-EditNamePage/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-180210-eir8hN/code-clone-0001-EditNamePage/review.json>) |
| CC-I020 | `20261105-014812-0hS7ab/code-clone-0001-ActivityBooking` | [output20261105-014811-420.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-014811-420.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-014812-0hS7ab/code-clone-0001-ActivityBooking/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-014812-0hS7ab/code-clone-0001-ActivityBooking/review.json>) |
| CC-I021 | `20261105-015029-X5Of8n/code-clone-0001-AboutUs` | [output20261105-015028-631.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-015028-631.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015029-X5Of8n/code-clone-0001-AboutUs/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015029-X5Of8n/code-clone-0001-AboutUs/review.json>) |
| CC-I022 | `20261105-192137-Qb898v/code-clone-0001-SubmitPointConfirm` | [output20261105-192136-925.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-192136-925.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-192137-Qb898v/code-clone-0001-SubmitPointConfirm/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-192137-Qb898v/code-clone-0001-SubmitPointConfirm/review.json>) |
| CC-I023 | `20261106-181658-bDzwg7/code-clone-0001-MyFavoritesPage` | [output20261106-181657-797.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-181657-797.log>) | [FAIL](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-181658-bDzwg7/code-clone-0001-MyFavoritesPage/result.json>) | 未取得有效评审 |
| CC-I024 | `20261105-015213-uE45SJ/code-clone-0001-HomePage` | [output20261105-015212-457.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-015212-457.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015213-uE45SJ/code-clone-0001-HomePage/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015213-uE45SJ/code-clone-0001-HomePage/review.json>) |
| CC-I025 | `20261105-015413-mC9ZyQ/code-clone-0001-StickerToolBar` | [output20261105-015412-389.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-015412-389.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015413-mC9ZyQ/code-clone-0001-StickerToolBar/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015413-mC9ZyQ/code-clone-0001-StickerToolBar/review.json>) |
| CC-I026 | `20261105-015612-7BIi2J/code-clone-0001-TransactionDatasetMock` | [output20261105-015610-004.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-015610-004.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015612-7BIi2J/code-clone-0001-TransactionDatasetMock/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015612-7BIi2J/code-clone-0001-TransactionDatasetMock/review.json>) |
| CC-I027 | `20261105-015755-mPQfbj/code-clone-0001-PictureBeautification` | [output20261105-015754-377.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-015754-377.log>) | [FAIL](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-015755-mPQfbj/code-clone-0001-PictureBeautification/result.json>) | 未取得有效评审 |
| CC-L001 | `20261105-080113-iUtyaG/code-clone-0001-CartPageLogic` | [output20261105-080108-631.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-080108-631.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-080113-iUtyaG/code-clone-0001-CartPageLogic/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-080113-iUtyaG/code-clone-0001-CartPageLogic/review.json>) |
| CC-L002 | `20261105-080824-X1zCYL/code-clone-0001-CartPageLogic` | [output20261105-080108-631.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-080108-631.log>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-080824-X1zCYL/code-clone-0001-CartPageLogic/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-080824-X1zCYL/code-clone-0001-CartPageLogic/review.json>) |
| CC-L003 | `20261106-201844-OwZJf3/code-clone-0001-EditNamePageVM` | [output20261106-201843-440.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-201843-440.log>) | [BLOCKED](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-201844-OwZJf3/code-clone-0001-EditNamePageVM/result.json>) | 未取得有效评审 |

补充I27重跑：[305.252秒PASS结果](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261105-144718-EbLntj/code-clone-0001-PictureBeautification/result.json>)；[重跑终端日志](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261105-144716-531.log>)。该记录与原批次I27 FAIL并存，不替换正文统计。

相关审计：[迁移后优化复盘](typescript-agent-optimization-retrospective-20261105.md)、[跨类同版本全量结果](code-clone-cross-host-full-results-20261106.md)、[跨类A批失败链](code-clone-cross-host-batch-a-results-20261106.md)、[全范围原始扩测](agent-expanded-results-20261105.md)。
