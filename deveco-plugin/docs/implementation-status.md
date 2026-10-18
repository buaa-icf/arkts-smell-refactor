# 插件主体实现与使用

更新：2026-10-18，插件版本 0.1.5。本文记录当前代码行为；[端到端设计](deveco-plugin-end-to-end-design.md)与[桥接协议设计](backend-bridge-protocol.md)保留完整目标方案。

Gradle 工程根目录现为主仓库下的 `deveco-plugin/`，本页构建和测试命令均在该目录执行；[仓库集成说明](repository-integration.md)记录迁移方式。

## 已实现流程

1. 打开 Tools → ArkTS Refactor，设置 Python、后端、HomeCheck、DevEco SDK 和任务目录；进入“环境”页自动检查，也可点击工具栏“环境检查”。
2. 检测当前文件、目录或工程，选择四类规则；也可导入标准 JSON 或粘贴对象/数组。文件和目录右键有检测入口。
3. 筛选结果，双击定位方法或行范围，打开重复片段的关联文件。
4. 选择问题，填写业务说明，点击“分析重构风险”。插件保存工程基线并展示风险、生产调用点、约束和专项画像。
5. 点击“生成候选变更”，在候选工程中调用现有后端，执行 Agent、门禁、测试、评审及返修。
6. 在“变更预览”查看最终文件列表、原生 Diff、资源、各轮结果和 Linter 策略。FAIL/BLOCKED/INCOMPLETE 不能应用。
7. 点击“应用全部变更”，再次核对原始工程、工具配置和冻结候选；一致时以事务应用，自动启动当前工程门禁和异味复检。
8. 查看日志、证据及运行记录，导出运行摘要；可用按钮或 IDE Undo 撤销本会话的应用。后续用户编辑冲突会阻止覆盖。

任务执行互斥范围为一个 IDE Project。关闭面板不终止任务；取消结束本次进程树，关闭 Project 释放服务并停止 worker。

## 环境页

“环境”用于检查 Python、重构后端、Node、HomeCheck、ArkTS SDK、DevEco Code / Agent CLI、Hvigor、ohpm 和 Linter 共九项依赖的路径，并汇总检测与候选重构所需工具是否齐全。此检查只确认路径及必要文件，Agent 登录、实际构建与设备测试仍由具体任务验证。

0.1.4 及以前仅在手动点击“环境检查”并成功返回后填充页面，未检查和检查失败时都没有页面提示。0.1.5 首次进入环境页自动检查，显示等待/检查进度、结果、上次检查时间或失败原因，提供“重新检查”和“打开设置…”按钮。工具栏“环境检查”会切换到该页。结果在当前工程会话中缓存；修改设置后自动失效，页面可见时重新检查，文件或工具安装状态在设置未变时可手动刷新。

环境检查使用独立状态，保留当前检测/重构的日志、步骤和任务目录；当前任务运行时检查排队，并明确提示等待。缺失必需 Linter 时不能显示重构依赖齐全；设置为跳过时显示该项可选。HomeCheck 检查同时要求入口、规则包和项目/规则配置存在。

2026-10-18 使用本机已有任务的工具配置，通过真实 JSONL worker 完成只读检查，九项依赖均已找到；响应保存在 `build/smoke-environment/response.json`。此次未调用 Agent、构建或设备测试，也未据此宣称宿主界面交互已验收。

## 检测目标与运行状态

“当前文件”读取点击开始检测时编辑器选中的 `.ets/.ts` 文件。开始后，工具栏下方显示本次请求的完整路径；后台会再返回实际扫描文件数、文件列表和规则。切换编辑器不改变已经提交的任务。

后台工作期间，工具栏下方显示带“正在检测中”和累计耗时的滚动进度条，取消按钮可用。HomeCheck 没有可靠的总体完成百分比，因此显示持续活动状态；运行日志保留扫描器输出，底部状态显示启动、报告读取等阶段。

检测结果区域始终显示本轮状态。成功时显示文件数、规则数、异味数；失败、取消与正常完成但零异味分别提示。原有结果被筛选条件全部隐藏时，提示“当前筛选无匹配结果”。

0.1.0 在 Windows 的 GBK 环境下可能无法解码配置中的中文路径，Python 尚未解析请求便返回空 requestId，界面继而显示“后端响应不属于当前请求”。0.1.1 在 Java 启动参数、子进程环境和 Python 标准流三处固定 UTF-8，并在无法读取请求时保留实际错误原因。此错误意味着本次操作失败，不能用空表判断没有异味。

0.1.2 修复了交互扫描对性能统计脚本的依赖。实际 IDE 失败日志位于 `e1968edc-9764-4649-b80a-564ce6fedf34/scan.log`：`cloc-2.10.exe` 在创建 `par-.../cache-...` 临时缓存时失败，扫描尚未进入 HomeCheck 检测阶段。新的插件侧 `homecheck_scan.cjs` 直接调用 HomeCheck 入口，不启动 CLOC、Git 或性能面板；性能评测脚本仍留在外部工具中，插件不修改其源码。

检测为每轮生成绝对路径的 `check-paths.json`、项目配置、规则配置和扫描报告。相对 ignore/excluded 模式锚定到业务工程，避免任务目录的 `build` 等父目录导致目标被全部过滤。成功必须同时满足 Node 正常退出、HomeCheck 返回成功、全部选中规则已注册、日志具有完成标记及对应文件数，且无 HomeCheck 错误；单凭空报告或 exit 0 不显示成功。

“查看运行日志”在检测期间也可使用；HomeCheck 文件日志与控制台日志均实时推送。失败后可点“打开本轮日志…”在编辑器中查看本轮 `scan/HomeCheck.log` 和 `scan.log`。错误返回保留日志路径、退出码和有长度限制的诊断内容；顶部错误及底部状态按窗口宽度换行。

## Agent 提示词附件范围

0.1.2 的一次真实重构任务 `4193710a-c90e-43bc-b10d-eae1a2b515e5` 在 `backend/refactor-agent.log` 中报错 `File attachment path is outside the allowed roots`。后端把提示词写到 `backend/refactor-agent-prompt.md`，而 Agent 的 `--dir` 是 `backend/refactor-workspace`，附件不在 Agent 工作区中，导致读取提示词时退出；后续 smell/build/test/linter/review 均跳过，真实工程未应用修改。

0.1.3 的插件适配器复用后端生产副本与变更同步策略，在 Agent 工作区内创建唯一的临时提示词附件，通过 `-f` 传入，并在 CLI 返回或抛异常时清理。审计用的提示词仍保留在任务目录。初次重构与 repair 共用该入口；生产删除拒绝、测试排除与原工程保护仍适用。

失败步骤从本轮受控日志提取简短原因，写入 `result.json`、候选结果和界面；“变更预览”顶部优先显示原因，“打开本轮日志…”也支持 Agent 日志。此次验证使用受控 CLI 检查附件真实位置、生产同步、失败清理及删除拒绝，未再次调用真实 Agent 或宣称完整门禁通过。0.1.4 支持从历史恢复已有生产变更候选，原工程或冻结内容变化时仍需重新检测。

## 候选阻塞、恢复与重试

候选验证在工程副本中完成，不要求先应用到原工程。“原工程状态：尚未应用”单独表示磁盘状态，不能作为候选 BLOCKED 的原因。界面明确区分两个状态，并在禁用应用按钮时显示候选未通过的原因。

0.1.3 的实际候选 `cc9b21f1-95fe-431a-b560-c2ebbdbce0fa` 已由重构 Agent 生成修改，但后端 smell 门禁仍通过性能脚本启动 CLOC，发生临时缓存错误。0.1.4 将首次检测、候选门禁和应用后门禁统一到直接 HomeCheck 入口。门禁仅扫描候选中的目标、变更源码和关联片段；保留目标/变更方法匹配、转移异味拒绝、无符号克隆复检及完整执行检查。检测工具失败返回 BLOCKED，真正残留异味返回 FAIL，二者均不能应用。

未应用时可点击“重新验证候选”：验证冻结哈希及原工程基线，在新的任务副本中重建候选，重新执行门禁及评审，不运行重构/返修 Agent，不改写旧任务记录。全部必需检查与评审通过后，新候选才可应用；验证期间源码或工具指纹变化会使结果失效。需要修改候选代码时，仍通过重新分析/生成候选进入自动返修流程。

升级重启后，可进入“运行记录 → 刷新记录”，选择有候选的 task.execute/task.validateCandidate 记录并“恢复候选”，然后查看 Diff 或重新验证。恢复需核对原工程、冻结基线和每项变更内容；已应用、源码过期、无最终变更及冻结内容被修改的记录不能恢复。历史恢复不提供跨 IDE 会话 Undo 或半完成事务自动恢复。

真实候选烟测入口 `tools/smoke_candidate_gate.py --candidate-run <任务绝对目录>` 在插件工程 build 中复制候选，只重跑实际 smell 门禁。2026-10-18 对上述候选实测已摆脱 CLOC 阻塞，但仍检出 `applyNormalAttribute` 的特性依恋（ATFD=8，LDA=0.00，CPFD=2），因此实际退出码为 1（FAIL）。原工程及候选生产内容哈希未变，证据为 `build/smoke-candidate-gate/b7ca64d6-04cd-4c2e-879f-6e48f02ae17c/backend/smell-after.json`。这不是完整门禁通过证明。

## 构建与测试

```powershell
$env:JAVA_HOME = 'D:\tool\java21'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
.\gradlew.bat '-PdevecoStudioPath=D:/tool/DevEco/DevEco Studio' test buildPlugin verifyPluginStructure
python -m unittest discover -s tests -v
```

`test` 委托 `verification/` 的普通 Java 21 测试项目执行文件事务测试。本机 Huawei SDK 缺少标准 IntelliJ 平台测试启动器要求的 Core 插件描述符，因此这些测试不启动 IDE。生产源码仍直接针对本机 DevEco SDK 编译。

Java 事务测试覆盖：多文件应用与 Undo/Redo、BOM/CRLF 保持、资源二进制恢复、基线变化、新文件冲突、第二次写入失败回滚、用户后续编辑保护和越界/测试文件拒绝。

当前回归集为 7 项 Java 事务测试与 42 项 Python 桥接测试。完整工程哈希在后台核对；应用临界区再次检查受影响文件、未保存编辑和设置变化。日志刷新合并到 UI 更新队列，避免每个日志块重新布局整个面板。

Python 测试覆盖：输入展开、克隆无符号、目标/关联片段过期、测试代码只读、路径边界、JSONL 响应、协议版本、候选冻结与原工程不被回写、删除拒绝、实际 runner 的受控工具编排，以及应用后验证不再次执行 Agent。

新增回归使用包含中文路径、中文消息的原始 UTF-8 字节，在 `PYTHONIOENCODING=gbk`、`PYTHONUTF8=0` 环境中启动真实 worker，校验请求关联与返回内容；同时验证单文件扫描配置及结果过滤、成功零结果的范围元信息和 `scan.started` 事件。

直接检测新增回归覆盖：Node 入口成功/失败/缺失规则注册、规则内部异常被吞后的失败判定、实际扫描文件数和完成标记校验、工程内忽略模式以及控制台/文件日志推送。

本机真实 HomeCheck 烟测入口为 `tools/smoke_detect.py`，在 `build/smoke-detection` 中检测 160 条语句的方法。已实际检出 1 条过长方法；原样例源码保持不变。本次扫描执行摘要与问题报告均保存在独立 run 中。

该脚本现在通过真实 JSONL 子进程调用插件适配器。可指定 `--project <工程根目录> --file <绝对文件路径>` 只读检测现有文件，默认执行全部四条规则；检查实际目标范围、请求关联、进度事件与检测前后目标文件 SHA-256，JSONL 原始事件和响应保存在 `build/smoke-detection/worker-<requestId>.jsonl`。

2026-10-18 实际检测 `D:\arktsProgram\agc-template-market-harmonyos-demos\BooksAndReferenceTemplate\BookRead\feature\book_person\src\main\ets\comp\MyBalanceCard.ets`：HomeCheck 日志确认文件数为 1，四条规则均成功完成，结果为 0 条异味，目标内容哈希保持不变。该结果仅表示当前规则未检出问题。运行证据为 `build/smoke-detection/runs/a06288aa-a4aa-4ffa-a171-d53851100567/scan/summary.json` 和同轮 `runs/BookRead/issuesReport.json`。

0.1.2 安装包内的适配器已提取后实测 `feature/book_home/src/main/ets/views/SearchPage.ets`，使用原 IDE 任务根目录 `C:\Users\RoyCai\AppData\Local\Huawei\DevEcoStudio6.1\arkts-refactor\runs`。四条选中规则均加载完成，扫描 1 个文件，检出 `build` 过长方法（108 行，阈值 80）和 `labelBaseStyle` 特性依恋两条异味。源码哈希未变，报告为该任务根目录下的 `be550f9e-2280-4535-bbdf-561317830cf3/scan/issuesReport.json`；JSONL 证据为 `build/smoke-detection/worker-584974eb-757e-4ce9-b6f4-77d8d6ef2568.jsonl`。这验证了后端链路及打包资源，实际 DevEco 面板仍需安装新版后使用。

## 与设计方案的实现差异

| 项目 | 当前实现 |
| --- | --- |
| 后端改动 | 适配器随插件打包；后端源码不修改。直接调用现有 Python API，并将门禁子进程的 SDK 配置与同步边界适配在插件侧 |
| 传输 | 每项操作一个 Python worker，stdin 一个请求、stdout JSONL 事件/响应；当前不是长连接多请求服务 |
| 执行 | 当前按单个问题操作，未实现批量勾选队列和跨 Project 调度锁 |
| 初次扫描 | 插件侧 Node 入口直接调用 HomeCheck；不依赖性能评测脚本、CLOC、F1 或实时 HTTP 面板 |
| 日志 | 检测日志实时推送；后端 Agent/门禁日志在该阶段落盘后显示，阶段进度持续可见 |
| 评审复用 | 应用后源码、测试、配置和工具指纹完全一致时引用候选 PASS 评审，重新运行实际门禁及扫描；变化时拒绝旧证据 |
| Undo | 支持当前 IDE 会话的应用与撤销，持久化写入日志；重启后有历史证据，但尚无自动恢复半完成事务或历史应用撤销按钮 |
| 大资源 | 单个应用内容限制 32 MiB，累计 Undo 内容 64 MiB；Diff 预览每份内容限制 8 MiB。超限提示缩小任务或查看元信息 |
| 范围 | 新增/修改生产 ArkTS、模块 Index.ets 和生产资源；删除、重命名、测试/配置修改及跨工程关联片段拒绝 |

候选有独立 taskHandle 和 candidateId，工程快照、工具指纹、前后文件内容和应用日志保存在配置的任务目录；该目录必须在业务工程之外。原始检测 commitHash 仅保留元信息。

原生 UI 使用宿主组件和多行按钮布局，窗口收窄时操作按钮仍可见。源码导航优先按方法声明匹配，再按行范围定位，无法静态解析的符号保留检测证据。

## 验收边界

已执行 Java 21 编译、事务与桥接测试、插件 ZIP 结构检查和真实 HomeCheck 检测。受控工具用于验证后端编排，不代表真实 DevEco Code、Hvigor、设备测试及语义评审已经通过。

仍需在目标 DevEco 中安装 ZIP，选择一个真实 Harmony 工程完成 UI 操作、Agent 登录、签名/设备、候选生成、应用、IDE Undo 和复检联调。当前构建产物是主体代码的可安装包，未声明所有宿主交互已验收。

现有后端的复制隔离和同步白名单不提供 OS 沙箱。插件沿用该边界，并阻止把真实工程路径作为候选执行根；实际工具和 Agent 的系统权限仍由运行环境决定。
