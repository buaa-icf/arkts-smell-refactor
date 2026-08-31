# Code Clone 重构重跑记录（2026-08-30，进行中）

> 截止记录时间：2026-08-30 17:53（Asia/Shanghai）。原先因模型服务拥堵而 `BLOCKED` 的 CC-014～CC-027 已全部处理：13 条完成，CC-023 记录为 INCOMPLETE 并已回滚。

## 运行范围与隔离

- 数据集：`C:\Users\RoyCai\Desktop\group_project\arkts-code-smell\dataset\positive\instrument-test\code-clone.json`
- 代码根目录：`D:\arktsProgram`
- 本次仅重跑旧版因模型服务拥堵而 `BLOCKED` 的条目。当前批次顺序为 CC-014～CC-027；CC-019 由用户手工触发、由本记录接续归档，之后从 CC-020 接续运行。
- 每条均在临时 `refactor-workspace*` 中由 Agent 修改；只有 `.ets/.ts` 的 `src/main` 生产代码能同步回真实项目。任务结束后，脚本先对源文件和对应重构镜像做 SHA-256 一致性校验，再恢复 `baseline-production`；新文件只有在哈希匹配时才删除。

## 每条的命令链

外层批处理命令如下；它会把每个编号对应的一条 JSON 输入给新版工具：

```powershell
$env:PYTHONPATH = 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\src'
Set-Location 'C:\Users\RoyCai\Desktop\group_project\arkts异味检查工具'
& 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\tools\run_code_clone_series.ps1' -StartOrdinal 14 -EndOrdinal 19
```

脚本对每个 `CC-nnn` 单独执行：

```text
cmd /c type <该条临时 JSON 文件> | D:\tool\python3.13\python.exe -m arkts_smell_refactor start --workspace D:\arktsProgram
```

工具在每条任务内依次调用下列命令（`<task-dir>`、`<harmony-root>` 和 `<repair-N>` 随条目替换）：

```text
# 首轮重构
D:\tool\python3.13\python.exe -m arkts_smell_refactor.gate refactor \
  --task-dir <task-dir> --source-root <harmony-root> \
  --deveco C:\Users\RoyCai\AppData\Roaming\npm\deveco.CMD

# HomeCheck 文件级异味复检
D:\tool\python3.13\python.exe -m arkts_smell_refactor.gate smell \
  --task-dir <task-dir> --source-root <harmony-root> \
  --homecheck-root C:\Users\RoyCai\Desktop\group_project\arkts异味检查工具\homecheck-extrule

# 异味仍存在时，最多三次定向修复；每次后重新执行 HomeCheck
D:\tool\python3.13\python.exe -m arkts_smell_refactor.gate refactor \
  --task-dir <task-dir> --source-root <harmony-root> \
  --deveco C:\Users\RoyCai\AppData\Roaming\npm\deveco.CMD \
  --prompt-file <task-dir>\repair-prompt-<N>.md
```

当前四条在 HomeCheck 阶段均失败，因此 fail-fast 规则跳过了 `hvigor build`、`hvigor test`、Code Linter 和语义评审；这些命令没有被执行。每条的完整、已展开命令保存在其 `result.json` 的 `steps[].command` 中。

## 已完成结果

| ID | 目标位置 | 执行序列 | 耗时 | 结论与回滚 |
|---|---|---|---:|---|
| CC-014 | `agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/scenes/tab/mine/src/main/ets/viewModels/EditNamePageVM.ets:6-40` | R PASS (1028.019s) → H FAIL (0.426s)<br>修复 1：R PASS (618.193s) → H FAIL (0.369s)<br>修复 2：R PASS (579.304s) → H FAIL (0.337s)<br>修复 3：R FAIL (711.552s)<br>B/T/L/语义评审均按 fail-fast 跳过 | 2938.350s | FAIL；恢复 `EditNamePageVM.ets`、`EditPhonePageVM.ets`、`EditUserProfileVM.ets`、`EditNamePage.ets`、`EditPhonePage.ets` |
| CC-015 | `agc-template-market-harmonyos-demos/KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets:90-100` | R FAIL (1528.158s)<br>H/B/T/L/语义评审均跳过 | 1528.308s | FAIL；候选改动未同步到源项目，哈希保护判定为无需回滚 |
| CC-016 | `agc-template-market-harmonyos-demos/KidsTemplate/ChildrenEducation/scenes/tabs/minepage/src/main/ets/views/settings/TimeCtrl.ets:165-179` | R PASS (312.838s) → H FAIL (0.395s)<br>修复 1：R PASS (590.408s) → H FAIL (0.378s)<br>修复 2：R FAIL (639.171s) → H FAIL (0.340s)<br>修复 3：R PASS (907.454s) → H FAIL (0.309s)<br>B/T/L/语义评审均按 fail-fast 跳过 | 2451.443s | FAIL；恢复 `TimeCtrl.ets` |
| CC-017 | `agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets:443-475` | R PASS → H FAIL<br>修复 1：R PASS → H FAIL<br>修复 2：R PASS → H FAIL<br>修复 3：R FAIL<br>B/T/L/语义评审均按 fail-fast 跳过 | 2266.665s | FAIL；恢复 `PictureBeautification.ets` |
| CC-018 | `agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_home/src/main/ets/components/HomeVisit.ets:8-59` | R PASS (1351.506s) → H FAIL (0.373s)<br>修复 1：R PASS (509.171s) → H FAIL (0.327s)<br>修复 2：R FAIL (1978.189s) → H PASS (12.381s) → B PASS (15.443s) → T PASS (16.915s) → L PASS (15.834s) → 语义评审 PASS (301.691s) | 4201.981s | PASS；恢复 `HomeVisit.ets`、`SharedDialogUtils.ets`、`ShippingInfo.ets` |
| CC-019 | `agc-template-market-harmonyos-demos/ShoppingTemplate/Express/features/business_mine/src/main/ets/pages/EditNamePage.ets` | R PASS (232.253s) → H PASS (10.481s) → B PASS (21.405s) → T FAIL (12.051s)<br>L/语义评审按 fail-fast 跳过 | 276.327s | FAIL；测试编译报 31 个 `vm.userInfo` 可能为 `undefined`，涉及既有的 `src/test/EditNamePageVM.test.ets`、`EditPhonePageVM.test.ets`，本轮生产改动未涉及这两个 VM，工具分类为 `UNATTRIBUTED_TEST_FAILURE`；已删除新建 `EditFieldPage.ets`，并恢复 `EditNamePage.ets`、`EditPhonePage.ets` |
| CC-020 | `agc-template-market-harmonyos-demos/KidsTemplate/PostpartumCareCenter/scenes/activities/src/main/ets/view/ActivityBooking.ets:70-88` | R PASS (930.660s) → H PASS (7.051s) → B PASS (18.230s) → T PASS (14.590s) → L PASS (5.511s) → 语义评审 PASS (187.573s) | 1163.766s | PASS；恢复 `ActivityBooking.ets` |
| CC-021 | `agc-template-market-harmonyos-demos/LifestyleAndServiceTemplate/AdministrativeAffairs/Application/commons/components/src/main/ets/components/AboutUs.ets:42-57` | R PASS (189.227s) → H PASS (5.972s) → B PASS (18.632s) → T PASS (14.865s) → L PASS (5.754s) → 语义评审 PASS (411.003s) | 645.604s | PASS；恢复 `AboutUs.ets` |
| CC-022 | `agc-template-market-harmonyos-demos/LifestyleAndServiceTemplate/ShoppingMall/components/module_points/src/main/ets/components/SubmitPointConfirm.ets:15-36` | R PASS (338.240s) → H PASS (18.686s) → B PASS (19.866s) → T PASS (12.480s) → L FAIL (5.210s)<br>修复 1：R PASS (356.820s) → H PASS (18.472s) → B PASS (15.083s) → T PASS (11.384s) → L PASS (5.191s) → 语义评审 PASS (187.518s) | 989.107s | PASS；首轮 Linter 失败，经 1 轮修复后所有门禁通过；恢复 `SubmitPointConfirm.ets` |
| CC-023 | `agc-template-market-harmonyos-demos/MovieTVAndLivestreamingTemplate/WebShortDrama/features/mine/src/main/ets/pages/MyFavoritesPage.ets:8-32` | R PASS（无 `result.json`，未写入结构化耗时）→ H PASS (6.724s) → B PASS (20.940s) → T PASS (24.606s) → L PASS (17.473s) → 语义评审 FAIL<br>修复 1 Agent 无响应，人工中止 | 1819.839s | INCOMPLETE；评审发现 WatchRecordsPage 新增整行点击导航、且将 `currentWatch` 改为无法证实等价的 `curIndex`；中止后经哈希校验已删除 `DramaListLayout.ets` 并恢复 `MyFavoritesPage.ets`、`WatchRecordsPage.ets` |
| CC-024 | `agc-template-market-harmonyos-demos/NavigationTemplate/AirTrip/Application/features/home/src/main/ets/pages/HomePage.ets:194-209` | R PASS (212.066s) → H PASS (6.223s) → B PASS (17.938s) → T PASS (12.888s) → L PASS (5.177s) → 语义评审 PASS (123.072s) | 377.525s | PASS；恢复 `HomePage.ets` |
| CC-025 | `agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/components/StickerToolBar.ets:78-131` | R PASS (375.944s) → H PASS (5.197s) → B PASS (17.663s) → T PASS (13.200s) → L PASS (5.037s) → 语义评审 PASS (141.681s) | 558.876s | PASS；恢复 `StickerToolBar.ets` |
| CC-026 | `agc-template-market-harmonyos-demos/FinanceTemplate/FinancialManagement/commons/network/src/main/ets/mocks/mockData/TransactionDatasetMock.ets:49-61` | R PASS (206.840s) → H PASS (9.660s) → B PASS (21.101s) → T PASS (13.086s) → L PASS (4.960s) → 语义评审 PASS (311.908s) | 567.699s | PASS；恢复 `TransactionDatasetMock.ets` |
| CC-027 | `agc-template-market-harmonyos-demos/PhotographyTemplate/ImageProcessing/scenes/picture_beautification/src/main/ets/pages/PictureBeautification.ets:476-487` | R PASS (243.123s) → H PASS (5.529s) → B PASS (17.531s) → T PASS (12.980s) → L PASS (5.344s) → 语义评审 PASS (99.754s) | 384.407s | PASS；恢复 `PictureBeautification.ets` |

已完成 13 条的累计耗时为 **18350.058 秒（5 小时 5 分 50.058 秒）**；含 CC-023 中止调用的 14 次实验尝试累计耗时为 **20169.897 秒（5 小时 36 分 9.897 秒）**。CC-014、CC-016、CC-017 的共同直接失败原因是：新版的文件级 HomeCheck 复检仍报告目标 Code Clone；因此构建、测试、Linter、语义评审均没有执行，不能将该结果解释为这些门禁失败。CC-018、CC-020、CC-021、CC-022、CC-024、CC-025、CC-026 与 CC-027 最终的 HomeCheck 复检和所有剩余门禁均通过。CC-019 的重构、HomeCheck 和构建均通过，因既有测试源码的 ArkTS 可空性错误而在测试门禁终止。

## 暂停点、CC-019 与后续计划

- CC-018 最终通过且已经回滚。
- 早先首次 CC-019 已在 Agent 阶段中断，未产生可记入结果；用户于 15:38 重新单独执行 CC-019，生成了完整的 `result.json`，该次结果已计入上表。
- CC-019 已完成保护性回滚：`EditFieldPage.ets` 已删除，`EditNamePage.ets` 与 `EditPhonePage.ets` 已恢复。
- CC-020～CC-022、CC-024～CC-027 均已完成并回滚；CC-023 已人工中止并完成哈希保护回滚。本批重跑结束。

## 各条实际执行命令（以变量展开）

下列变量对应本机的实际绝对路径。将变量替换后即为 `result.json` 中保存的完整 `steps[].command`；这些文件也保留了未压缩的原始命令。

```text
PY      = D:\tool\python3.13\python.exe
DEV     = C:\Users\RoyCai\AppData\Roaming\npm\deveco.CMD
HOME    = C:\Users\RoyCai\Desktop\group_project\arkts异味检查工具\homecheck-extrule
HVIGOR  = D:\OpenHarmony\command-line-tools\bin\hvigorw.BAT
OHPM    = D:\OpenHarmony\command-line-tools\bin\ohpm.BAT
LINTER  = D:\OpenHarmony\command-line-tools\bin\codelinter.BAT
```

| 条目 | `task-dir` / `source-root` | 实际执行顺序 |
|---|---|---|
| CC-014 | `runs\20260830-113909\code-clone-0001-EditNamePageVM` / `D:\arktsProgram\agc-template-market-harmonyos-demos\FinanceTemplate\FinancialManagement` | `PY -m arkts_smell_refactor.gate refactor --task-dir <task-dir> --source-root <source-root> --deveco DEV`<br>`PY -m arkts_smell_refactor.gate smell --task-dir <task-dir> --source-root <source-root> --homecheck-root HOME`<br>随后以 `--prompt-file <task-dir>\repair-prompt-1.md`、`repair-prompt-2.md`、`repair-prompt-3.md` 各执行一次 refactor；前两轮后各执行一次 smell。 |
| CC-015 | `runs\20260830-122807\code-clone-0001-TimeCtrl` / `D:\arktsProgram\agc-template-market-harmonyos-demos\KidsTemplate\ChildrenEducation` | 只执行首轮 `PY -m arkts_smell_refactor.gate refactor --task-dir <task-dir> --source-root <source-root> --deveco DEV`；R FAIL 后其余门禁全部跳过。 |
| CC-016 | `runs\20260830-125335\code-clone-0001-TimeCtrl` / `D:\arktsProgram\agc-template-market-harmonyos-demos\KidsTemplate\ChildrenEducation` | 首轮 refactor → smell；随后 `--prompt-file repair-prompt-1.md`、`repair-prompt-2.md`、`repair-prompt-3.md` 的 refactor；每轮都尝试 smell。H 均失败，B/T/L/评审都跳过。 |
| CC-017 | `runs\20260830-133427\code-clone-0001-PictureBeautification` / `D:\arktsProgram\agc-template-market-harmonyos-demos\PhotographyTemplate\ImageProcessing` | 首轮 refactor → smell；随后带 `repair-prompt-1.md`、`repair-prompt-2.md`、`repair-prompt-3.md` 的 refactor，并在成功修复轮后再次执行 smell。H 未通过，B/T/L/评审跳过。 |
| CC-018 | `runs\20260830-141214\code-clone-0001-HomeVisit` / `D:\arktsProgram\agc-template-market-harmonyos-demos\ShoppingTemplate\Express` | 首轮 refactor → smell；修复 1（`repair-prompt-1.md`）→ smell；修复 2（`repair-prompt-2.md`）后执行 smell、`PY -m arkts_smell_refactor.gate hvigor ... --hvigorw HVIGOR --task assembleHap --ohpm OHPM`、`PY -m arkts_smell_refactor.gate hvigor ... --hvigorw HVIGOR --task test --ohpm OHPM --module business_home`、`PY -m arkts_smell_refactor.gate linter ... --codelinter LINTER --config D:\arktsProgram\agc-template-market-harmonyos-demos\ShoppingTemplate\Express\code-linter.json5`，最后执行 `DEV run "严格执行附件中的只读评审任务，只输出要求的 JSON。" -f <task-dir>\review-prompt.md --dir <task-dir> --format json --dangerously-skip-permissions`。 |
| CC-019 | `runs\20260830-153844\code-clone-0001-EditNamePage` / `D:\arktsProgram\agc-template-market-harmonyos-demos\ShoppingTemplate\Express` | `PY -m arkts_smell_refactor.gate refactor --task-dir <task-dir> --source-root <source-root> --deveco DEV` → `PY -m arkts_smell_refactor.gate smell --task-dir <task-dir> --source-root <source-root> --homecheck-root HOME` → `PY -m arkts_smell_refactor.gate hvigor ... --task assembleHap --ohpm OHPM` → `PY -m arkts_smell_refactor.gate hvigor ... --task test --ohpm OHPM --module business_mine`。测试失败后，Linter 与评审按 fail-fast 跳过。 |
| CC-020 | `runs\20260830-155637\code-clone-0001-ActivityBooking` / `D:\arktsProgram\agc-template-market-harmonyos-demos\KidsTemplate\PostpartumCareCenter` | `PY -m arkts_smell_refactor.gate refactor --task-dir <task-dir> --source-root <source-root> --deveco DEV` → `PY -m arkts_smell_refactor.gate smell --task-dir <task-dir> --source-root <source-root> --homecheck-root HOME` → `PY -m arkts_smell_refactor.gate hvigor ... --task assembleHap --ohpm OHPM` → `PY -m arkts_smell_refactor.gate hvigor ... --task test --ohpm OHPM --module activities` → `PY -m arkts_smell_refactor.gate linter ... --codelinter LINTER --config D:\arktsProgram\agc-template-market-harmonyos-demos\KidsTemplate\PostpartumCareCenter\code-linter.json5` → `DEV run "严格执行附件中的只读评审任务，只输出要求的 JSON。" -f <task-dir>\review-prompt.md --dir <task-dir> --format json --dangerously-skip-permissions`。 |
| CC-021 | `runs\20260830-161703\code-clone-0001-AboutUs` / `D:\arktsProgram\agc-template-market-harmonyos-demos\LifestyleAndServiceTemplate\AdministrativeAffairs\Application` | `PY -m arkts_smell_refactor.gate refactor --task-dir <task-dir> --source-root <source-root> --deveco DEV` → `PY -m arkts_smell_refactor.gate smell --task-dir <task-dir> --source-root <source-root> --homecheck-root HOME` → `PY -m arkts_smell_refactor.gate hvigor ... --task assembleHap --ohpm OHPM` → `PY -m arkts_smell_refactor.gate hvigor ... --task test --ohpm OHPM --module components` → `PY -m arkts_smell_refactor.gate linter ... --codelinter LINTER --config D:\arktsProgram\agc-template-market-harmonyos-demos\LifestyleAndServiceTemplate\AdministrativeAffairs\Application\code-linter.json5` → `DEV run "严格执行附件中的只读评审任务，只输出要求的 JSON。" -f <task-dir>\review-prompt.md --dir <task-dir> --format json --dangerously-skip-permissions`。 |
| CC-022 | `runs\20260830-162852\code-clone-0001-SubmitPointConfirm` / `D:\arktsProgram\agc-template-market-harmonyos-demos\LifestyleAndServiceTemplate\ShoppingMall` | 首轮依次执行 refactor → smell → build → test → linter（FAIL）；再以 `--prompt-file <task-dir>\repair-prompt-1.md` 执行 refactor，随后 smell → build → test → linter → review，最终通过。测试模块为 `module_points`。 |
| CC-023 | `runs\20260830-164629\code-clone-0001-MyFavoritesPage` / `D:\arktsProgram\agc-template-market-harmonyos-demos\MovieTVAndLivestreamingTemplate\WebShortDrama` | 首轮 refactor → smell → build → test（模块 `mine`）→ linter → review；语义评审 FAIL 后，工具以 `repair-prompt-1.md` 启动修复 Agent。该 Agent 超过 33 分钟无终态，人工中止；无 `result.json`，所有已经同步的文件均已按基线回滚。 |
| CC-024 | `runs\20260830-171844\code-clone-0001-HomePage` / `D:\arktsProgram\agc-template-market-harmonyos-demos\NavigationTemplate\AirTrip\Application` | 依次执行 refactor → smell → build → test → linter → review，全部通过。 |
| CC-025 | `runs\20260830-172604\code-clone-0001-StickerToolBar` / `D:\arktsProgram\agc-template-market-harmonyos-demos\PhotographyTemplate\ImageProcessing` | 依次执行 refactor → smell → build → test → linter → review，全部通过。 |
| CC-026 | `runs\20260830-173623\code-clone-0001-TransactionDatasetMock` / `D:\arktsProgram\agc-template-market-harmonyos-demos\FinanceTemplate\FinancialManagement` | 依次执行 refactor → smell → build → test → linter → review，全部通过。 |
| CC-027 | `runs\20260830-174648\code-clone-0001-PictureBeautification` / `D:\arktsProgram\agc-template-market-harmonyos-demos\PhotographyTemplate\ImageProcessing` | 依次执行 refactor → smell → build → test → linter → review，全部通过。 |

## 原始证据位置

- CC-014：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-113909\code-clone-0001-EditNamePageVM`
- CC-015：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-122807\code-clone-0001-TimeCtrl`
- CC-016：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-125335\code-clone-0001-TimeCtrl`
- CC-017：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-133427\code-clone-0001-PictureBeautification`
- CC-018：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-141214\code-clone-0001-HomeVisit`
- CC-019：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-153844\code-clone-0001-EditNamePage`
- CC-020：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-155637\code-clone-0001-ActivityBooking`
- CC-021：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-161703\code-clone-0001-AboutUs`
- CC-022：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-162852\code-clone-0001-SubmitPointConfirm`
- CC-023：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-164629\code-clone-0001-MyFavoritesPage`
- CC-024：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-171844\code-clone-0001-HomePage`
- CC-025：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-172604\code-clone-0001-StickerToolBar`
- CC-026：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-173623\code-clone-0001-TransactionDatasetMock`
- CC-027：`C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor\runs\20260830-174648\code-clone-0001-PictureBeautification`
