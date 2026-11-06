# Long Method 重构实验报告（2026-11-06）

## 摘要

本实验评估长方法在同一类或组件内自动重构的正确性与端到端效率，覆盖 Instrument 数据集17条、Local数据集8条，共25个目标、24个不同生产源码文件。采用 TypeScript 后端和 Long Method 专属结构/状态分析，Linter 为 skip，其余必需门禁及独立语义评审保留。

**最终24/25 PASS（96.0%），其中19条在420秒内完成并PASS，限时成功率76.0%，达到严格>70%的目标。** Instrument来源限时成功12/17（70.6%），Local来源7/8（87.5%）。24条最终PASS均零返修，唯一返修发生于I16；该任务测试失败后返修耗尽1200秒总预算，最终BLOCKED。

25条累计端到端10213.044秒，约2小时50分13秒，平均408.522秒、中位数368.140秒。首轮重构、返修及评审子进程累计占端到端时间85.6%，仍是主要耗时来源。五条最终PASS超过420秒，另有一条BLOCKED；完整逐条证据、实际测试与阶段耗时见正文及附录。

**版本边界：本报告25条均在运行时`7fcf2b3`、策略`2026-11-06-long-method-structure`下完成。后续跨类Clone优化及里程碑tag保留了这些结果，不表示25条已在最终`2bddaf8`运行时重新执行。** 本报告参照[10月12日报告](<C:/Users/RoyCai/Desktop/group_project/TestResult1012/long-method-experiment-20261012.md>)的组织格式，数据和结论均来自本轮选定记录。

## 1. 实验范围与方法

### 1.1 目标与样本

验收要求为类内重构最终PASS且端到端不超过420秒，分组成功率严格超过70%；25条至少需18条成功。本报告不使用跨类900秒阈值，目前没有独立Long Method跨类样本，也不能将本结论外推到该分组。

| 样本来源 | 编号 | 数量 | 数据集 |
|---|---|---:|---|
| Instrument | LM-I001～LM-I017 | 17 | [instrument-test/long-method.json](<C:/Users/RoyCai/Desktop/group_project/arkts-code-smell/dataset/positive/instrument-test/long-method.json>) |
| Local | LM-L001～LM-L008 | 8 | [local-test/long-method.json](<C:/Users/RoyCai/Desktop/group_project/arkts-code-smell/dataset/positive/local-test/long-method.json>) |

编号I/L表示数据集来源，后三位是展平后的ordinal；实际测试类型以门禁执行结果为准。I11只运行Local测试，I9和L8同时运行Local与设备测试，L6/L7本轮仅运行Local测试。L6与L7为同一生产文件的两个不同方法目标，不能称为25个完全独立工程。

### 1.2 有效运行、版本与例外记录

有效运行均发生于北京时间2026-11-06：保留A批中的7条，随后B批补跑18条，形成25条主口径。A原批另有I6的格式BLOCKED，该次完整记录仍保留。

| 项目 | 本轮设置或记录 |
|---|---|
| 验证运行时 | `7fcf2b3`，包含`1f68126`完整源码坐标接线修复 |
| Agent策略 | `2026-11-06-long-method-structure` |
| 请求模型 | 重构、返修、评审均为`zhipu-coding/glm-5` |
| 请求档位 | 重构/返修max，评审未显式指定；供应商实际内部档位未独立验证 |
| Linter | skip；不据此声称required模式达标 |
| 生产工作区 | `D:/arktsProgram` |
| 终端日志 | `C:/Users/RoyCai/Desktop/group_project/TestResult1028` |
| 原始产物 | 仓库`runs/`下逐任务result、test-results、原始测试汇总、review、生产diff和快照 |
| 状态归档 | `agent-long-method-passed-20261106`；后续三组里程碑`agent-three-groups-passed-20261106`指向`ea370d4` |

I15按用户要求恢复计入：本轮完整运行930.970秒PASS，但不计限时成功；更早的证书错误不再作为本轮排除理由。I6按用户事先指定重跑采用最新341.740秒PASS，不取最快或最好成绩，历史293.922秒格式BLOCKED仍保留。附录B为主口径每条精确映射。

| 口径 | 最终PASS | 限时PASS | 说明 |
|---|---:|---:|---|
| 主口径25目标 | 24/25 | **19/25（76.0%）** | I6采用用户指定的最新完整结果 |
| 本版本每目标首次尝试 | 23/25 | 18/25（72.0%） | I6保留首次格式BLOCKED |
| 所有26次实际尝试 | 24/26 | 19/26（73.1%） | 包含I6两次，非26个独立目标 |

26次总投入10506.966秒；主口径累计仅统计所选25次，不隐去额外尝试，也不把重复执行当新增样本。

### 1.3 执行流程与统计定义

流程为重构Agent（R）→异味复检（H）、构建（B）、公共契约（C）→测试（T）→独立语义评审（S）。本轮附加Linter（L）全部按skip策略跳过；H/B/C可并行。必要门禁失败后停止后续阶段，符合条件时调用返修Agent（A）并重新验证。

- 最终通过以`result.json`的业务verdict为准，不能用退出码、测试通过或自然语言好评替代。
- 限时成功必须同时满足最终PASS和终端`RESULT totalSeconds <= 420`；FAIL/BLOCKED/超时PASS均留在分母，不四舍五入边界秒数。
- 端到端包含准备、初始化、Agent、返修与实际门禁，截止结果写入；不含后续回滚与批次间等待。1200秒执行上限不替代420秒目标。
- 首轮全部通过指所选任务首次必需门禁及评审均PASS，Linter按skip明确豁免；不表示目标从未有过其他尝试。
- 阶段耗时只从`result.steps`的实际执行项累加，不重复累加`attempts`；门禁并行，因此阶段之和不等于墙钟总时长，其差额也不能直接当作初始化成本。
- 测试数量按实际执行次数计数，不跨目标去重；覆盖率开关或进程完成码不等于用例通过或覆盖完整。

## 2. 总体结果与时间指标

| 指标 | Instrument来源 | Local来源 | 全部25条 |
| --- | --- | --- | --- |
| 有效样本 | 17 | 8 | 25 |
| PASS / FAIL / BLOCKED / INCOMPLETE | 16 / 0 / 1 / 0 | 8 / 0 / 0 / 0 | 24 / 0 / 1 / 0 |
| 最终通过率 | 94.1% | 100.0% | 96.0% |
| 首轮必需门禁及评审通过 | 16/17 | 8/8 | 24/25 |
| PASS且端到端≤420秒 | 12/17 | 7/8 | 19/25 |
| 限时成功率 | 70.6% | 87.5% | 76.0% |
| 发生返修的任务 / 调用数 | 1 / 1 | 0 / 0 | 1 / 1 |
| 累计端到端 / 秒 | 7427.092 | 2785.952 | 10213.044 |
| 均值 / 秒 | 436.888 | 348.244 | 408.522 |
| 中位数 / 秒 | 377.846 | 338.933 | 368.140 |
| 最短 / 最长 / 秒 | 215.677 / 1200.915 | 275.360 / 460.362 | 215.677 / 1200.915 |

主口径24个PASS均在首轮完成必需验证，无额外返修。唯一返修任务I16为BLOCKED；没有FAIL或INCOMPLETE终态。最终PASS样例平均375.505秒，明显低于包含超时失败的全量均值，但验收分母仍为全部25条。

## 3. 样例结果与重构方式

### 3.1 逐条结果

行号为数据集原始定位，不能当作重构后行号。I9报告符号为build，实际目标区域为rechargeContent；I16为匿名函数定位`%AM19$goodPkgComp`，不是可直接改名的方法声明。

| ID | 目标文件 / 原始行 | 目标方法 | 终态 | 端到端 / 秒 | ≤420秒且PASS | 返修 |
| --- | --- | --- | --- | --- | --- | --- |
| LM-I001 | [ReaderToolBar.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/components/reader_tool_bar/src/main/ets/components/ReaderToolBar.ets>)：199–346 | buildSettingSheet | PASS | 426.446 | 否 | 0 |
| LM-I002 | [SearchPage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_home/src/main/ets/views/SearchPage.ets>)：90–219 | build | PASS | 401.692 | 是 | 0 |
| LM-I003 | [MyInfoCard.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/comp/MyInfoCard.ets>)：145–265 | build | PASS | 393.289 | 是 | 0 |
| LM-I004 | [AboutPage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/AboutPage.ets>)：68–194 | aboutCardView | PASS | 247.900 | 是 | 0 |
| LM-I005 | [FeedbackPage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/FeedbackPage.ets>)：26–194 | build | PASS | 467.938 | 否 | 0 |
| LM-I006 | [LoginPage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/LoginPage.ets>)：233–415 | build | PASS | 341.740 | 是 | 0 |
| LM-I007 | [MemberAgreementPage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/MemberAgreementPage.ets>)：7–152 | build | PASS | 377.846 | 是 | 0 |
| LM-I008 | [MemberCenterPage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/MemberCenterPage.ets>)：29–244 | build | PASS | 384.757 | 是 | 0 |
| LM-I009 | [RechargePage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/RechargePage.ets>)：37–226 | build | PASS | 489.214 | 否 | 0 |
| LM-I010 | [BookCoverCard.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_read_kit/src/main/ets/components/BookCoverCard.ets>)：42–161 | build | PASS | 325.146 | 是 | 0 |
| LM-I011 | [TabSwiper.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/ShoppingTemplate/ComprehensiveMall/commons/lib_foundation/src/main/ets/featurecomponents/tabswiper/TabSwiper.ets>)：235–304 | onTabSwiperAttributeChange | PASS | 279.606 | 是 | 0 |
| LM-I012 | [TUISwiper.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/components/swiper_card/src/main/ets/components/TUISwiper.ets>)：68–124 | initDataByIsCovered | PASS | 215.677 | 是 | 0 |
| LM-I013 | [QuickLoginPage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/ToolsTemplate/SmartHome/features/device_service/src/main/ets/pages/QuickLoginPage.ets>)：103–179 | handleLoginWithHuaweiIDButton | PASS | 332.084 | 是 | 0 |
| LM-I014 | [AgencyTaskCalender.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BusinessTemplate/OfficeAttendance/scenes/agency/src/main/ets/agency/components/AgencyTaskCalender.ets>)：128–308 | build | PASS | 374.064 | 是 | 0 |
| LM-I015 | [ScheduleForm.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/BusinessTemplate/OfficeAttendance/scenes/schedule/src/main/ets/schedule/components/ScheduleForm.ets>)：257–633 | build | PASS | 930.970 | 否 | 0 |
| LM-I016 | [GoodDetailPage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/FoodAndDrinkTemplate/TeaDrinkOrders/features/order/src/main/ets/pages/GoodDetailPage.ets>)：287–389 | %AM19$goodPkgComp | BLOCKED | 1200.915 | 否 | 1 |
| LM-I017 | [AgreementView.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/ToolsTemplate/SmartHome/features/device_service/src/main/ets/view/AgreementView.ets>)：54–149 | build | PASS | 237.808 | 是 | 0 |
| LM-L001 | [AccessibilitySettingModel.ets](<D:/arktsProgram/applications_settings/product/phone/src/main/ets/model/accessibilityImpl/AccessibilitySettingModel.ets>)：32–101 | accessibilityConfigSetting | PASS | 275.360 | 是 | 0 |
| LM-L002 | [ipsecVpnEdit.ets](<D:/arktsProgram/applications_settings/product/phone/src/main/ets/pages/vpn/ipsecVpnEdit.ets>)：60–153 | initCertList | PASS | 310.751 | 是 | 0 |
| LM-L003 | [BaseApi.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/MedicalTemplate/MedicalCare/common/common/src/main/ets/api/BaseApi.ets>)：67–141 | sendRequest | PASS | 311.408 | 是 | 0 |
| LM-L004 | [PatientViewModel.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/MedicalTemplate/MedicalCare/features/patient/src/main/ets/viewmodel/PatientViewModel.ets>)：147–216 | checkPatientInfo | PASS | 291.903 | 是 | 0 |
| LM-L005 | [SubmitOrderPage.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/NavigationTemplate/AirTrip/Application/features/flight/src/main/ets/pages/SubmitOrderPage.ets>)：98–200 | submitOrder | PASS | 460.362 | 否 | 0 |
| LM-L006 | [PictureBeautification.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets>)：413–498 | moveClipCanvasFreeType | PASS | 368.140 | 是 | 0 |
| LM-L007 | [PictureBeautification.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets>)：501–618 | moveClipCanvasRatioType | PASS | 401.571 | 是 | 0 |
| LM-L008 | [UserDetail.ets](<D:/arktsProgram/agc-template-market-harmonyos-demos/SocialTemplate/SocialDating/features/user/src/main/ets/pages/UserDetail.ets>)：607–707 | UploadProfilePicDialogBuilder | PASS | 366.457 | 是 | 0 |

### 3.2 抽取方式与语义核对

下表结合实际生产差异与终态评审概括抽取方案。PASS表示本轮门禁和评审支持该结论，不把词法画像本身当作完整行为证明；I16没有有效终态评审，单独注明。

| ID | 实际抽取及验证说明 |
| --- | --- |
| LM-I001 | 提取buildFontSizeRow、buildLineHeightRow、buildFlipModeRow三个无参成员Builder；字号/行距/翻页状态仍在同宿主内通过this直读，原回调及UI ID保留。 |
| LM-I002 | 提取搜索栏、无结果、结果列表、建议列表四个成员Builder；保留条件结构、ForEach键函数、状态写入和回调顺序。 |
| LM-I003 | 提取avatarBuilder、vipBadgeBuilder、userInfoBuilder；原isLogin分支、组件顺序和修饰符链保留。 |
| LM-I004 | 提取版本信息和客服入口两个同宿主Builder；保留弹窗回调、PhoneSheetBuilder闭包及外层容器属性。 |
| LM-I005 | 提取问题描述、截图、电话、提交按钮四个无参Builder；原UI结构与状态读取保留，最终PASS但超时。 |
| LM-I006 | 提取AppInfoSection、PhoneSection、LoginButtonSection、AgreementSection四个私有Builder；原组件层级、ID和状态行为经本次评审确认。 |
| LM-I007 | 提取agreementHeader、agreementSection、agreementFooter，正文标题/文案显式传参；不新增包装组件，保留布局和原长文案。 |
| LM-I008 | 只提取memberPackagesSection和memberPrivilegesSection两个职责块；VM属性级状态读取继续留在成员Builder内。 |
| LM-I009 | 把实际rechargeContent拆成背景、套餐、说明、底部操作四个私有Builder；保留双向绑定、键函数和支付相关回调，build等相邻方法不变。 |
| LM-I010 | 将书籍统计Row整体提为bookStatsRow，原调用位置及修饰符链保留；有限抽取即可消除长方法。 |
| LM-I011 | 入口保留dirty循环，提取属性分派与索引同步、布局、轨道、指示器helper；核对14个监听键及layout触发条件和副作用顺序。 |
| LM-I012 | 提取initCoveredMode、initTiledMode、limitImgWidth；保持覆盖/平铺分支的状态写入和限宽运算顺序。 |
| LM-I013 | 提取私有handleLoginError、handleLoginSuccess；保留错误分支、enableStatus恢复时机及原异常传播。 |
| LM-I014 | 提取遮罩、把手、月份选择、星期标题、日期网格、时间行六个成员Builder；原循环、ID及嵌套状态直读保留。 |
| LM-I015 | 提取标题、位置、全天开关、起止时间、重复提醒、说明七个无参Builder；保留双向绑定和DatePickerDialog参数，最终PASS但首轮耗时较长。 |
| LM-I016 | 首轮提取套餐项目、媒体和按钮相关Builder；异味/构建/契约通过，设备用例超时。后续返修未完成，不能认定其行为等价或将副本视为完成产物。 |
| LM-I017 | 提取标题、隐私文本和操作按钮三个无参Builder；保留状态守卫、UI ID及回调。 |
| LM-L001 | 提取私有静态setBooleanConfig处理Promise日志；保留九个switch选择器及shortKey到shortkey的原有大小写映射，不修正业务规则。 |
| LM-L002 | 提取initCaCertList、initUserCertList、initServerCertList并保持原顺序调用；闭包、回调注册与选中ID逻辑保留。 |
| LM-L003 | 提取ensureAuthorization、notifyCacheIfPresent、processResponse三个私有helper；保持鉴权、缓存通知和响应处理的顺序与公共签名。 |
| LM-L004 | 提取checkRequiredFields与checkFieldFormat；保留校验短路顺序、Toast文案，patient入口单次读取后传同一引用。 |
| LM-L005 | 提取输入校验、订单构建、弹窗参数、模拟流程和保存五个helper；保留orderData对象身份、定时器回调与副作用顺序，最终PASS但超时。 |
| LM-L006 | 提取applyFreeTypeMove与limitClipRectToImageArea；保留移动及边界夹取逻辑、状态写入及Watch触发时机。 |
| LM-L007 | 按动作/四角移动/对角增量/边界夹取拆分七个私有helper；保留原比例计算与不同分支应用差异，相邻free方法不变，未改业务算法。 |
| LM-L008 | 只提取示例图Row为UploadProfilePicSampleRowBuilder；按钮与异步回调继续留在原方法，保留原状态读取与宿主归属。 |

## 4. 测试门禁与执行证据

### 4.1 实际测试范围

| ID | 实际作业 / 套件 | 用例结果 | 任务终态 |
| --- | --- | --- | --- |
| LM-I001 | 设备 ReaderToolBarTest | 1/1 PASS | PASS |
| LM-I002 | 设备 SearchPageTest | 2/2 PASS | PASS |
| LM-I003 | 设备 MyInfoCardTest | 1/1 PASS | PASS |
| LM-I004 | 设备 AboutPageTest | 1/1 PASS | PASS |
| LM-I005 | 设备 FeedbackPageTest | 1/1 PASS | PASS |
| LM-I006 | 设备 LoginPageTest | 3/3 PASS | PASS |
| LM-I007 | 设备 MemberAgreementPageTest | 1/1 PASS | PASS |
| LM-I008 | 设备 MemberCenterPageTest | 1/1 PASS | PASS |
| LM-I009 | Local RechargePageTest；设备 RechargePageTest | 3/3 PASS；1/1 PASS | PASS |
| LM-I010 | 设备 BookCoverCardTest | 2/2 PASS | PASS |
| LM-I011 | Local TabSwiperTest | 8/8 PASS | PASS |
| LM-I012 | 设备 TUISwiperTest | 7/7 PASS | PASS |
| LM-I013 | 设备 QuickLoginPageTest | 4/4 PASS | PASS |
| LM-I014 | 设备 AgencyTaskCalenderTest | 4/4 PASS | PASS |
| LM-I015 | 设备 ScheduleFormTest | 4/4 PASS | PASS |
| LM-I016 | 设备 GoodDetailPageTest | 0/1 PASS，1 Error | BLOCKED |
| LM-I017 | 设备 AgreementViewTest | 2/2 PASS | PASS |
| LM-L001 | Local AccessibilitySettingModelTest | 8/8 PASS | PASS |
| LM-L002 | Local ipsecVpnEditTest | 6/6 PASS | PASS |
| LM-L003 | Local BaseApiTest | 12/12 PASS | PASS |
| LM-L004 | Local PatientViewModelTest | 21/21 PASS | PASS |
| LM-L005 | Local SubmitOrderPageTest | 12/12 PASS | PASS |
| LM-L006 | Local PictureBeautificationTest | 18/18 PASS | PASS |
| LM-L007 | Local PictureBeautificationTest | 18/18 PASS | PASS |
| LM-L008 | Local UserDetailTest；设备 UserDetailTest | 6/6 PASS；3/3 PASS | PASS |

末次测试共27个作业：26PASS、1FAIL，包含17个设备作业和10个Local作业；共151次用例执行，150PASS、1Error，无pending作业。24个最终PASS目标对应150次通过执行；I16的唯一用例为Error。

本次只读核对原始测试文件存在、汇总和终态评审。16个通过的设备作业都有`TestFinished-ResultCode: 0`；I16也有进程完成码0，但Hypium报告用例Error，因此完成码不能替代测试汇总。24份有效终态评审均为PASS且`issues=[]`，I16没有有效终态评审。

### 4.2 证据解释

I9与L8各执行两类测试，不能只按数据集I/L字母统计真实验证范围。L6/L7本轮各Local18/18，不沿用旧报告的设备测试结果声称本次也已执行设备验证。测试通过证明已执行用例满足断言；没有额外证据时，不把coverage参数、空issues或一次PASS解释为所有路径和异常状态均获完整证明。

## 5. 失败、返修与超时分析

### 5.1 I16：用例超时后，返修耗尽总预算

`GoodDetailPageTest.renders_package_good_detail_page`再次报`execute timeout 15000ms`，1条用例Error。首轮重构272.079秒，异味、构建及契约通过；测试失败后评审未运行，返修851.995秒后被1200秒任务上限中止，最终端到端1200.915秒BLOCKED。

返修有read3、grep1、bash1、edit2；首个edit约在返修开始后822.017秒出现。隔离副本虽然已有编辑，但没有后续门禁及评审结果，不能当作完成的修复。此项是本轮唯一修复Agent调用，也是唯一非PASS终态。

[此前四轮原始代码/另一份首次重构对照](long-method-i16-test-comparison-20261106.md)均通过，用例约13秒，提示测试时序敏感。但本轮生成代码不同，旧对照不能证明本轮无回归，也不能据此删除此次失败或直接延长15秒测试期限。

### 5.2 I6、I15的恢复计入

I6首次评审使用弯引号和中文verdict，虽测试3/3通过，仍因缺少合法结构化评审而BLOCKED。本轮按用户指定重跑后输出合法PASS JSON，341.740秒限时通过。期间没有修改评审解析器，因此这次成功不等于协议问题已被代码修复。

I15本次未再被证书错误提前阻断，ScheduleFormTest4/4、评审PASS。首轮重构718.115秒、评审148.357秒，最终930.970秒；提取七个无参成员Builder后功能门禁通过，但耗时仍超目标510.970秒。首个edit约在首事件后530.737秒，日志包含双向绑定与既有Builder用法核对；不能把整段等待都视为纯推理。

### 5.3 未限时成功的六条

| ID | 最终状态 | 端到端 / 秒 | 超过420秒 / 秒 | 主要表现 |
| --- | --- | --- | --- | --- |
| LM-I001 | PASS | 426.446 | 6.446 | 零返修；重构223.419、评审137.637秒 |
| LM-I005 | PASS | 467.938 | 47.938 | 零返修；重构261.494、评审133.959秒 |
| LM-I009 | PASS | 489.214 | 69.214 | 零返修；重构255.163、评审158.197秒 |
| LM-I015 | PASS | 930.970 | 510.970 | 首轮718.115秒，方案形成较长 |
| LM-I016 | BLOCKED | 1200.915 | 780.915 | 设备用例Error；返修被总时限中止 |
| LM-L005 | PASS | 460.362 | 40.362 | 零返修；重构272.584、评审146.762秒 |

五条超时PASS均零返修；仅继续减少返修次数不足以让它们全部进入420秒。I1只超6.446秒，但按原始秒数仍不计成功。

## 6. 耗时构成与改进效果

### 6.1 分阶段耗时

| 阶段 | 实际调用 | PASS / FAIL / BLOCKED | Instrument来源 / 秒 | Local来源 / 秒 | 总计 / 秒 | 占端到端 |
| --- | --- | --- | --- | --- | --- | --- |
| R：首轮重构 | 25 | 25 / 0 / 0 | 3908.463 | 1579.293 | 5487.756 | 53.7% |
| A：返修Agent | 1 | 0 / 0 / 1 | 851.995 | 0.000 | 851.995 | 8.3% |
| H：异味复检 | 25 | 25 / 0 / 0 | 74.178 | 33.526 | 107.704 | 1.1% |
| B：构建 | 25 | 25 / 0 / 0 | 400.423 | 168.139 | 568.562 | 5.6% |
| C：公共契约 | 25 | 25 / 0 / 0 | 1.882 | 0.829 | 2.711 | 0.0% |
| T：测试 | 25 | 24 / 1 / 0 | 664.609 | 159.250 | 823.859 | 8.1% |
| L：附加Linter | 0 | 0 / 0 / 0 | 0.000 | 0.000 | 0.000 | 0.0%（全部skip） |
| S：语义评审 | 24 | 24 / 0 / 0 | 1546.888 | 858.991 | 2405.879 | 23.6% |

首轮重构5487.756秒、返修851.995秒、评审2405.879秒，合计8745.630秒，占端到端85.6%。这些子进程时间包含模型生成、服务等待、工具调用与进程开销，不等于纯推理。其他门禁存在并行，下面附录的各阶段合计也不能直接当作端到端时间。

### 6.2 与优化前的可比观察

以本轮前每个目标最近一次完整尝试为历史背景，暂排除更早仅20.295秒证书阻塞的I15，只比较相同24个目标的耗时：累计10685.952→9282.074秒，均值445.248→386.753秒，下降13.1%；限时成功14/24→19/24。该排除只用于时间对比，不从本轮25条验收分母删除I15。

新增限时成功为I6、I8、I13、I14、L8，原已限时成功目标没有跌出420秒边界，但部分变慢。前后均最终PASS的23条均值412.393→351.355秒，下降14.8%。既有全量审计确认25对目标文件重构前SHA-256一致，但历史对照涉及不同策略版本，未控制模型随机性、服务负载、设备及缓存，不能单独归因于某一提交。

10月12日报告同为25目标，但采用Linter required且后端/环境不同，其16/25（64%）可作历史背景，不能与本轮skip结果构成单因素对照，也不能由本轮76%推断required已经达标。

### 6.3 分析器优化的作用与剩余空间

本轮修正完整源码坐标接线，向初始重构提供有界的目标片段、完整UI子树及修饰符范围、成员类型与嵌套状态线索；提示默认只修改报告目标及必要helper。返修使用当前轮基线/diff，评审不混入新增的旧源码材料。未修改裁剪比例业务规则，也未放宽门禁与时限。

I14按职责拆分同宿主UI子树，完整时间明显下降；I1保留成员Builder内的响应式直读，避免上轮按值传参引起的返修；I8和L8通过有限抽取进入时限。它们支持方向有效，但不证明所有工具读取已消除或所有样例都加速。进一步改进可关注I1/I5等零返修任务的正常执行链、I15的长时间方案形成，以及I16失败诊断期间的返修收敛；这些是后续提升空间，不是本轮>70%目标尚未完成。

## 7. 基线控制与验收结论

25条均有RESULT、ROLLBACK_SNAPSHOT、END；每条只同步一个目标生产文件，无新增生产文件/资源或rejectedFiles。I16未完成的返修副本仅留作诊断，未被当作验证通过的生产产物。

既有[全量审计](long-method-full-results-20261106.md)对运行前快照与当时当前工程完成4159项SHA-256核对，覆盖1591个唯一源码文件，全部一致，按快照忽略规则无新增残留。该范围不证明资源、JSON配置、SDK、设备状态或模型服务完全相同。本报告重读指定任务结果、阶段、测试与评审材料，没有执行`tools/`脚本、真实Agent或设备实验，也未修改生产代码。

**验收结论：当前固定Long Method类内组，在验证运行时`7fcf2b3`和Linter skip口径下，最终PASS24/25，420秒限时PASS19/25（76.0%），达到严格>70%的目标。** 当前归档版本包含该优化及后续Clone优化，不能将不同组的验证历史改写为最终tag下的统一重跑。

## 附录 A：逐任务阶段耗时

单位秒。R首轮重构、A全部返修、H异味复检、B构建、C契约、T测试、L附加Linter、S评审；只统计实际执行steps，不计SKIPPED，不重复累加attempts。I16的A为被总时限中止的调用。H/B/C可并行，各行阶段之和不等于端到端。

| ID | R | A | H | B | C | T | L | S | 端到端 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LM-I001 | 223.419 | 0.000 | 5.248 | 29.091 | 0.103 | 32.582 | 0.000 | 137.637 | 426.446 |
| LM-I002 | 242.102 | 0.000 | 5.451 | 28.153 | 0.109 | 39.375 | 0.000 | 89.054 | 401.692 |
| LM-I003 | 200.952 | 0.000 | 4.440 | 26.494 | 0.112 | 41.068 | 0.000 | 121.410 | 393.289 |
| LM-I004 | 142.735 | 0.000 | 4.165 | 26.911 | 0.121 | 40.455 | 0.000 | 34.293 | 247.900 |
| LM-I005 | 261.494 | 0.000 | 4.988 | 28.081 | 0.123 | 40.579 | 0.000 | 133.959 | 467.938 |
| LM-I006 | 201.759 | 0.000 | 4.250 | 21.373 | 0.120 | 35.765 | 0.000 | 79.634 | 341.740 |
| LM-I007 | 173.077 | 0.000 | 4.064 | 20.866 | 0.116 | 57.193 | 0.000 | 123.719 | 377.846 |
| LM-I008 | 233.550 | 0.000 | 3.586 | 20.490 | 0.120 | 36.414 | 0.000 | 91.271 | 384.757 |
| LM-I009 | 255.163 | 0.000 | 3.612 | 20.223 | 0.111 | 52.582 | 0.000 | 158.197 | 489.214 |
| LM-I010 | 181.488 | 0.000 | 4.615 | 27.354 | 0.115 | 36.407 | 0.000 | 76.553 | 325.146 |
| LM-I011 | 183.872 | 0.000 | 4.473 | 27.542 | 0.093 | 17.727 | 0.000 | 46.751 | 279.606 |
| LM-I012 | 104.413 | 0.000 | 3.810 | 25.471 | 0.110 | 29.507 | 0.000 | 53.658 | 215.677 |
| LM-I013 | 164.531 | 0.000 | 4.298 | 21.024 | 0.102 | 39.319 | 0.000 | 104.285 | 332.084 |
| LM-I014 | 255.103 | 0.000 | 4.125 | 19.057 | 0.121 | 35.176 | 0.000 | 61.774 | 374.064 |
| LM-I015 | 718.115 | 0.000 | 4.360 | 19.536 | 0.113 | 41.066 | 0.000 | 148.357 | 930.970 |
| LM-I016 | 272.079 | 851.995 | 4.340 | 17.872 | 0.096 | 56.232 | 0.000 | 0.000 | 1200.915 |
| LM-I017 | 94.611 | 0.000 | 4.353 | 20.885 | 0.097 | 33.162 | 0.000 | 86.336 | 237.808 |
| LM-L001 | 166.612 | 0.000 | 3.919 | 21.407 | 0.091 | 14.471 | 0.000 | 72.108 | 275.360 |
| LM-L002 | 188.693 | 0.000 | 3.615 | 20.097 | 0.096 | 13.874 | 0.000 | 87.370 | 310.751 |
| LM-L003 | 171.397 | 0.000 | 4.903 | 25.608 | 0.116 | 16.526 | 0.000 | 93.924 | 311.408 |
| LM-L004 | 119.086 | 0.000 | 3.612 | 19.758 | 0.102 | 13.024 | 0.000 | 137.144 | 291.903 |
| LM-L005 | 272.584 | 0.000 | 4.243 | 18.720 | 0.096 | 19.479 | 0.000 | 146.762 | 460.362 |
| LM-L006 | 221.475 | 0.000 | 4.376 | 17.696 | 0.108 | 13.781 | 0.000 | 112.103 | 368.140 |
| LM-L007 | 236.980 | 0.000 | 4.931 | 23.091 | 0.122 | 18.473 | 0.000 | 120.114 | 401.571 |
| LM-L008 | 202.466 | 0.000 | 3.927 | 21.762 | 0.098 | 49.622 | 0.000 | 89.466 | 366.457 |

## 附录 B：运行产物索引

每行对应主口径的一次明确任务，目录名保留原样；结果和评审链接指向同一所选任务。I16无有效评审，以返修日志作为失败诊断入口。终端日志均在用户指定的TestResult1028目录。

| ID | runs批次 / 任务 | 最终结果 | 评审或未完成返修 | 终端日志 |
| --- | --- | --- | --- | --- |
| LM-I001 | 20261106-112754-P3MX5p / long-method-0001-buildSettingSheet | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-112754-P3MX5p/long-method-0001-buildSettingSheet/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-112754-P3MX5p/long-method-0001-buildSettingSheet/review.json>) | [output20261106-112752-889.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-112752-889.log>) |
| LM-I002 | 20261106-143941-OLptCf / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-143941-OLptCf/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-143941-OLptCf/long-method-0001-build/review.json>) | [output20261106-143940-328.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-143940-328.log>) |
| LM-I003 | 20261106-113501-ofwLDD / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-113501-ofwLDD/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-113501-ofwLDD/long-method-0001-build/review.json>) | [output20261106-113500-470.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-113500-470.log>) |
| LM-I004 | 20261106-144624-0ms4Ja / long-method-0001-aboutCardView | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-144624-0ms4Ja/long-method-0001-aboutCardView/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-144624-0ms4Ja/long-method-0001-aboutCardView/review.json>) | [output20261106-144623-123.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-144623-123.log>) |
| LM-I005 | 20261106-114136-y0t1ZX / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-114136-y0t1ZX/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-114136-y0t1ZX/long-method-0001-build/review.json>) | [output20261106-114134-973.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-114134-973.log>) |
| LM-I006 | 20261106-143358-ZavDcr / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-143358-ZavDcr/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-143358-ZavDcr/long-method-0001-build/review.json>) | [output20261106-143357-796.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-143357-796.log>) |
| LM-I007 | 20261106-145032-sFTWsM / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-145032-sFTWsM/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-145032-sFTWsM/long-method-0001-build/review.json>) | [output20261106-145031-769.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-145031-769.log>) |
| LM-I008 | 20261106-115419-8MaHiw / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-115419-8MaHiw/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-115419-8MaHiw/long-method-0001-build/review.json>) | [output20261106-115418-779.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-115418-779.log>) |
| LM-I009 | 20261106-145651-oGMS2X / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-145651-oGMS2X/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-145651-oGMS2X/long-method-0001-build/review.json>) | [output20261106-145650-334.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-145650-334.log>) |
| LM-I010 | 20261106-150501-fzjyqb / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-150501-fzjyqb/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-150501-fzjyqb/long-method-0001-build/review.json>) | [output20261106-150500-581.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-150500-581.log>) |
| LM-I011 | 20261106-151028-zgSTvL / long-method-0001-onTabSwiperAttributeChange | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-151028-zgSTvL/long-method-0001-onTabSwiperAttributeChange/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-151028-zgSTvL/long-method-0001-onTabSwiperAttributeChange/review.json>) | [output20261106-151026-838.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-151026-838.log>) |
| LM-I012 | 20261106-151508-y4m3Ni / long-method-0001-initDataByIsCovered | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-151508-y4m3Ni/long-method-0001-initDataByIsCovered/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-151508-y4m3Ni/long-method-0001-initDataByIsCovered/review.json>) | [output20261106-151507-544.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-151507-544.log>) |
| LM-I013 | 20261106-151844-lOE3Hj / long-method-0001-handleLoginWithHuaweiIDButton | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-151844-lOE3Hj/long-method-0001-handleLoginWithHuaweiIDButton/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-151844-lOE3Hj/long-method-0001-handleLoginWithHuaweiIDButton/review.json>) | [output20261106-151844-220.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-151844-220.log>) |
| LM-I014 | 20261106-120045-km8w6x / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-120045-km8w6x/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-120045-km8w6x/long-method-0001-build/review.json>) | [output20261106-120044-292.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-120044-292.log>) |
| LM-I015 | 20261106-141827-IhTxvK / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-141827-IhTxvK/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-141827-IhTxvK/long-method-0001-build/review.json>) | [output20261106-141826-029.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-141826-029.log>) |
| LM-I016 | 20261106-152417-i5Ic5h / long-method-0001-AM19-goodPkgComp | [BLOCKED](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-152417-i5Ic5h/long-method-0001-AM19-goodPkgComp/result.json>) | [返修超时日志，无有效评审](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-152417-i5Ic5h/long-method-0001-AM19-goodPkgComp/repair-agent-1.log>) | [output20261106-152416-718.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-152416-718.log>) |
| LM-I017 | 20261106-154418-GedTs1 / long-method-0001-build | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-154418-GedTs1/long-method-0001-build/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-154418-GedTs1/long-method-0001-build/review.json>) | [output20261106-154418-107.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-154418-107.log>) |
| LM-L001 | 20261106-155437-9PPZpc / long-method-0001-accessibilityConfigSetting | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-155437-9PPZpc/long-method-0001-accessibilityConfigSetting/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-155437-9PPZpc/long-method-0001-accessibilityConfigSetting/review.json>) | [output20261106-155437-157.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-155437-157.log>) |
| LM-L002 | 20261106-155913-Act20e / long-method-0001-initCertList | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-155913-Act20e/long-method-0001-initCertList/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-155913-Act20e/long-method-0001-initCertList/review.json>) | [output20261106-155912-921.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-155912-921.log>) |
| LM-L003 | 20261106-131635-LjvBgB / long-method-0001-sendRequest | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-131635-LjvBgB/long-method-0001-sendRequest/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-131635-LjvBgB/long-method-0001-sendRequest/review.json>) | [output20261106-131634-855.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-131634-855.log>) |
| LM-L004 | 20261106-160424-MInvUz / long-method-0001-checkPatientInfo | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-160424-MInvUz/long-method-0001-checkPatientInfo/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-160424-MInvUz/long-method-0001-checkPatientInfo/review.json>) | [output20261106-160424-099.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-160424-099.log>) |
| LM-L005 | 20261106-160917-XsXDgd / long-method-0001-submitOrder | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-160917-XsXDgd/long-method-0001-submitOrder/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-160917-XsXDgd/long-method-0001-submitOrder/review.json>) | [output20261106-160916-655.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-160916-655.log>) |
| LM-L006 | 20261106-161658-hveXu0 / long-method-0001-moveClipCanvasFreeType | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-161658-hveXu0/long-method-0001-moveClipCanvasFreeType/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-161658-hveXu0/long-method-0001-moveClipCanvasFreeType/review.json>) | [output20261106-161657-660.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-161657-660.log>) |
| LM-L007 | 20261106-162306-twVBaH / long-method-0001-moveClipCanvasRatioType | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-162306-twVBaH/long-method-0001-moveClipCanvasRatioType/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-162306-twVBaH/long-method-0001-moveClipCanvasRatioType/review.json>) | [output20261106-162306-281.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-162306-281.log>) |
| LM-L008 | 20261106-132148-BfwADQ / long-method-0001-UploadProfilePicDialogBuilder | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-132148-BfwADQ/long-method-0001-UploadProfilePicDialogBuilder/result.json>) | [PASS](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-132148-BfwADQ/long-method-0001-UploadProfilePicDialogBuilder/review.json>) | [output20261106-132147-300.log](<C:/Users/RoyCai/Desktop/group_project/TestResult1028/output20261106-132147-300.log>) |

I6首次格式BLOCKED另存于[runs/20261106-114925-o1NdFa](<C:/Users/RoyCai/Desktop/group_project/arkts-smell-refactor/runs/20261106-114925-o1NdFa>)；保留在26次尝试辅助口径中，未覆盖原始记录。
