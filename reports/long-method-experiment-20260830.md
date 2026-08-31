# Long Method 重构实验记录（2026-08-30，进行中）

> 数据集共有 17 条 Long Method 阳性样本。每条单独运行，生产源码在任务结束后按任务内 `baseline-production` 与重构镜像的 SHA-256 一致性校验恢复。

> 截止记录时间：2026-08-31 11:46（Asia/Shanghai）。17 条样本均已处理。

## 运行范围

- 数据集：`C:\Users\RoyCai\Desktop\group_project\arkts-code-smell\dataset\positive\instrument-test\long-method.json`
- 代码根目录：`D:\arktsProgram`
- 自动回滚脚本：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\tools\run_long_method_series.ps1`
- 本仓库当前只有 Switch Statement 与 Feature Envy 专项分析器；Long Method 走通用风险分析、Long Method 重构约束和 HomeCheck 复检，不伪称使用了 Long Method 专项分析器。

## 单条命令链

外层执行：

```powershell
$env:PYTHONPATH = 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\src'
& 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\tools\run_long_method_series.ps1' -StartOrdinal <N> -EndOrdinal <N>
```

每条内部按门禁顺序执行：重构 Agent（R）→ HomeCheck（H）→ 构建（B）→ 测试（T）→ Code Linter（L）→ 语义评审。某项失败时，工具最多进行三轮定向修复；未通过的前置门禁会触发 fail-fast 跳过后续项目。

## 结果

| ID | 目标位置 | 执行序列 | 耗时 | 结论与回滚 |
|---|---|---|---:|---|
| LM-001 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/components/reader_tool_bar/src/main/ets/components/ReaderToolBar.ets:199-346`（`buildSettingSheet`） | R PASS (708.169s) → H PASS (6.895s) → B PASS (26.658s) → T PASS (14.336s) → L PASS (5.976s) → 语义评审 PASS (202.628s) | 1074.344s | PASS；恢复 `ReaderToolBar.ets` |
| LM-002 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_home/src/main/ets/views/SearchPage.ets:90-219`（`build`） | R PASS (358.083s) → H PASS (6.648s) → B PASS (25.742s) → T PASS (17.549s) → L PASS (5.934s) → 语义评审 PASS (199.776s) | 754.209s | PASS；恢复 `SearchPage.ets` |
| LM-003 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/comp/MyInfoCard.ets:145-265`（`build`） | R FAIL (767.998s)<br>H/B/T/L/语义评审均按 fail-fast 跳过 | 908.822s | FAIL；Agent 已完成 `@Builder` 提取并在隔离区 `assembleHar` 成功，但额外新建 `local.properties`，被生产代码范围门禁拒绝；候选改动未同步，哈希保护判定无需回滚 |
| LM-004 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/AboutPage.ets:68-194`（`aboutCardView`） | R PASS (637.027s) → H PASS (6.739s) → B PASS (28.218s) → T PASS (21.422s) → L PASS (6.337s) → 语义评审 PASS (102.192s) | 951.851s | PASS；提取 `versionInfoRow`、`contactServiceRow` 两个 `@Builder`，语义评审确认 UI 树、ID 与点击回调等价；恢复 `AboutPage.ets` |
| LM-005 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/FeedbackPage.ets:26-194`（`build`） | R PASS (570.623s) → H PASS (6.671s) → B PASS (27.642s) → T PASS (20.696s) → L PASS (6.307s) → 语义评审 PASS (91.295s) | 863.749s | PASS；提取 `issueDescriptionSection`、`screenshotSection`、`phoneSection` 三个 `@Builder`；评审确认 UI 结构、状态引用、事件与条件渲染等价；恢复 `FeedbackPage.ets` |
| LM-006 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/LoginPage.ets:233-415`（`build`） | R PASS (487.077s) → H PASS (6.577s) → B PASS (24.468s) → T PASS (17.676s) → L PASS (5.696s) → 语义评审 PASS (102.587s) | 755.366s | PASS；提取 `AppHeader`、`PhoneDisplay`、`HuaweiLoginButton`、`PrivacyAgreementRow` 四个 `@Builder`；评审确认组件树、状态绑定、事件、ID 与布局属性等价；恢复 `LoginPage.ets` |
| LM-007 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/MemberAgreementPage.ets:7-152`（`build`） | R PASS (440.170s) → H PASS (5.275s) → B PASS (22.561s) → T PASS (17.332s) → L PASS (5.269s) → 语义评审 PASS (138.819s) | 738.054s | PASS；提取参数化 `agreementSection` 和协议正文 `agreementContent` 两个 `@Builder`；评审确认组件树、文本和属性等价，无公共 API 变化；恢复 `MemberAgreementPage.ets` |
| LM-008 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/MemberCenterPage.ets:29-244`（`build`） | R PASS (292.357s) → H PASS (5.608s) → B PASS (22.274s) → T PASS (17.446s) → L PASS (5.615s) → 语义评审 PASS (301.751s) | 749.660s | PASS；语义评审通过；恢复 `MemberCenterPage.ets` |
| LM-009 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_person/src/main/ets/views/RechargePage.ets:37-226`（`build`） | R PASS (418.062s) → H PASS (6.184s) → B PASS (22.743s) → T PASS (17.652s) → L PASS (5.620s) → 语义评审 PASS (129.163s) | 706.515s | PASS；恢复 `RechargePage.ets` |
| LM-010 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/feature/book_read_kit/src/main/ets/components/BookCoverCard.ets:42-161`（`build`） | R FAIL (466.367s)<br>H/B/T/L/语义评审均按 fail-fast 跳过 | 574.526s | FAIL；Agent 的 `BookStatsBuilder` 提取与隔离构建均成功，但额外修改 `hvigorw.bat`、`hvigorw.js`，被生产代码范围门禁拒绝；候选改动未同步，无需回滚 |
| LM-011 | `agc-template-market-harmonyos-demos/ShoppingTemplate/ComprehensiveMall/commons/lib_foundation/src/main/ets/featurecomponents/tabswiper/TabSwiper.ets:235-304`（`onTabSwiperAttributeChange`） | 初始：R/H/B/T PASS，L FAIL (5.550s)<br>修复 1：R/H/B/T PASS，L FAIL (10.529s)<br>修复 2：R/H/B/T PASS，L FAIL (10.584s)<br>修复 3：R/H/B/T PASS，L FAIL (10.299s)<br>语义评审均跳过 | 4084.151s | FAIL；Linter 反复报告两个 `TabSwiper.ets` 的 brace-style、命名、逗号、分号等缺陷，最后一次为 37 项（32 errors、5 warns）；三轮修复均未消除。两个文件均已恢复 |
| LM-012 | `agc-template-market-harmonyos-demos/BooksAndReferenceTemplate/BookRead/components/swiper_card/src/main/ets/components/TUISwiper.ets:68-124`（`initDataByIsCovered`） | R PASS (212.727s) → H PASS (5.774s) → B PASS (23.005s) → T PASS (12.167s) → L PASS (5.682s) → 语义评审 PASS (69.026s) | 437.646s | PASS；拆分为 `clampImgDimensions`、`initCoveredMode`、`initNonCoveredMode` 和精简主方法；评审确认状态赋值顺序、条件与算术逻辑等价；恢复 `TUISwiper.ets` |
| LM-013 | `agc-template-market-harmonyos-demos/ToolsTemplate/SmartHome/features/device_service/src/main/ets/pages/QuickLoginPage.ets:103-179`（`handleLoginWithHuaweiIDButton`） | R PASS (622.970s) → H PASS (7.449s) → B PASS (22.408s) → T PASS (16.086s) → L PASS (5.510s) → 语义评审 PASS (139.651s) | 926.220s | PASS；拆分为入口方法、私有 `handleLoginError` 与 `handleLoginSuccess`，保留公开签名、状态更新和副作用顺序，无新增克隆；恢复 `QuickLoginPage.ets` |
| LM-014 | `agc-template-market-harmonyos-demos/BusinessTemplate/OfficeAttendance/scenes/agency/src/main/ets/agency/components/AgencyTaskCalender.ets:128-308`（`build`） | 初始：R/H/B/T PASS，L FAIL (5.753s)<br>修复 1：R/H/B/T PASS，L FAIL (6.131s)<br>修复 2：R/H/B/T PASS，L FAIL (6.124s)<br>修复 3：R/H/B/T PASS，L FAIL (5.960s)<br>语义评审均跳过 | 2103.094s | FAIL；Linter 每轮均报告 `_monitor` 命名/未使用、分号、尾逗号、对象属性换行、`ForEach` keyGenerator 等缺陷；最后一次 12 项（8 errors、4 warns），三轮修复均未消除。恢复 `AgencyTaskCalender.ets` |
| LM-015 | `agc-template-market-harmonyos-demos/BusinessTemplate/OfficeAttendance/scenes/schedule/src/main/ets/schedule/components/ScheduleForm.ets:257-633`（`build`） | R FAIL (426.806s)<br>H/B/T/L/语义评审按 fail-fast 跳过 | 565.872s | FAIL；Agent 已开始提取 `@Builder`，但其内部构建服务报 `unknown certificate verification error`，未能提交合规的结构化重构结果；无 `refactor-changes.json`，源文件未同步 |
| LM-016 | `agc-template-market-harmonyos-demos/FoodAndDrinkTemplate/TeaDrinkOrders/features/order/src/main/ets/pages/GoodDetailPage.ets:287-389`（`%AM19$goodPkgComp`） | R PASS (1499.403s) → H PASS (10.041s) → B PASS (17.892s) → T PASS (17.300s) → L PASS (5.873s) → 语义评审 PASS (81.880s) | 1743.296s | PASS；将内嵌 `GridItem` 内容提取为同类 `@Builder specValItemComp`，保留 `goodPkgComp` 签名、组件树、ID、点击事件、可见性条件与副作用顺序；无新代码克隆；恢复 `GoodDetailPage.ets` |
| LM-017 | `agc-template-market-harmonyos-demos/ToolsTemplate/SmartHome/features/device_service/src/main/ets/view/AgreementView.ets:54-149`（`build`） | R PASS (1022.375s) → H PASS (8.121s) → B PASS (30.410s) → T PASS (16.920s) → L PASS (5.609s) → 语义评审 PASS (189.954s) | 1417.506s | PASS；全部门禁通过。重构提取内部 `@Builder buildButtons`，语义评审确认 UI 树、ID、点击事件与样式等价；恢复 `AgreementView.ets` |

已覆盖全部 17 条样本，累计耗时 **19354.881 秒（322 分 34.881 秒）**；统计：PASS=12、FAIL=5、BLOCKED=0。

## 原始证据位置

每条的 `result.json`、各门禁日志和回滚记录均保存于：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\<timestamp>\long-method-<编号>-<目标名>`。

- LM-001：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-181751\long-method-0001-buildSettingSheet`
- LM-002：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-183629\long-method-0001-build`
- LM-003：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-184954\long-method-0001-build`
- LM-004：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-190704\long-method-0001-aboutCardView`
- LM-005：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-192405\long-method-0001-build`
- LM-006：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-215252\long-method-0001-build`
- LM-007：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-220636\long-method-0001-build`
- LM-008：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-221944\long-method-0001-build`
- LM-009：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-223310\long-method-0001-build`
- LM-010：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-224544\long-method-0001-build`
- LM-011：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-225615\long-method-0001-onTabSwiperAttributeChange`
- LM-012：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260831-000518\long-method-0001-initDataByIsCovered`
- LM-013：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260831-113012\long-method-0001-handleLoginWithHuaweiIDButton`
- LM-014：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260831-002410\long-method-0001-build`
- LM-015：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260831-092752\long-method-0001-build`
- LM-016：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260831-101212\long-method-0001-AM19-goodPkgComp`
- LM-017：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260831-110017\long-method-0001-build`
