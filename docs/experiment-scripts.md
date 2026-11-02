# 异味重构实验批跑脚本

本文记录本机 `tools/*.ps1` 辅助脚本的用法。这些脚本由 Git 忽略，不随仓库分发；新克隆仓库可使用正式 CLI 入口。运行 PowerShell 示例前执行 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`。

脚本调用本仓库 TypeScript 后端的编译产物 `dist/cli.js`，因此首次使用前须在仓库根目录执行 `npm install` 和 `npm run build`；缺少 `dist/cli.js` 时脚本直接报错，不会回退到旧 Python 入口。

四个入口按“异味类型 + 样例数据集”命名，执行的是完整重构实验：首轮 Agent、异味/构建/契约/测试门禁、可选 Linter、语义评审及必要返修。每条任务结束后恢复运行前的 `.ets` / `.ts` 源码快照，并清理该条新增的源码。

| 入口（仓库 `tools/` 目录） | 样例来源 | 当前序号 |
|---|---|---|
| `run_long_method_local.ps1` | `positive/local-test/long-method.json` | 1～8 |
| `run_code_clone_local.ps1` | `positive/local-test/code-clone.json` | 1～3 |
| `run_long_method_instrument.ps1` | `positive/instrument-test/long-method.json` | 1～17 |
| `run_code_clone_instrument.ps1` | `positive/instrument-test/code-clone.json` | 1～27 |

Local 长方法 JSON 有 7 个文件记录、8 条异味；序号按每条 `messages` 展开，保持 JSON 中原有顺序。默认末尾从数据集计算，后续增删样例无需修改脚本中的条数。

原 `run_long_method_series.ps1` 改为 `run_long_method_instrument.ps1`，原 `run_code_clone_series.ps1` 改为 `run_code_clone_instrument.ps1`。旧命令需替换入口名。四个入口共用 `run_refactor_experiment.ps1`（批跑）和 `task_source_rollback.ps1`（源码快照），使用时无需修改这两个内部实现或流水线配置。

## 终端准备

在 PowerShell 5.1 或 PowerShell 7 执行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$repo = 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$logDir = 'C:\Users\RoyCai\Desktop\group_project\TestResult1028'
Set-Location -LiteralPath $repo
$env:ARKTS_REFACTOR_MODEL = 'zhipu-coding/glm-5'
$env:ARKTS_REVIEW_MODEL = 'zhipu-coding/glm-5'
Remove-Item Env:ARKTS_REFACTOR_VARIANT -ErrorAction SilentlyContinue
Remove-Item Env:ARKTS_REVIEW_VARIANT -ErrorAction SilentlyContinue
```

项目默认使用用户 `deveco.jsonc` 中的自定义模型 `zhipu-coding/glm-5`，流水线子进程禁用 DevEco 自带提供者。上述设置覆盖旧终端遗留的模型变量并清除 low/high/max；不能沿用历史文档中的 `deveco/GLM-5.3` 命令。配置优先级与核查依据见 [1012 基线模型与路由修复](baseline-1012-model-audit-20261029.md)。

需要测试 Coding Plan 的增强推理时，单独设置 `$env:ARKTS_REFACTOR_VARIANT = 'high'`，首轮与返修均生效，评审保持独立。当前已接通 low/high/max 到实际 HTTP `reasoning_effort` 的映射；不传档位时保持服务端默认（官方 GLM-5.3 为 max）。完整对照命令见 [Coding Plan high/max 试验](coding-plan-high-trial-20261030.md)。

2026-11-02 合并修复后的首轮复测固定重构档位为 `max`，评审使用服务端默认，开启 Linter，执行 Instrument Code Clone 第 1～10 条。终端运行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
Set-Location -LiteralPath 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$env:ARKTS_REFACTOR_MODEL = 'zhipu-coding/glm-5'
$env:ARKTS_REVIEW_MODEL = 'zhipu-coding/glm-5'
$env:ARKTS_REFACTOR_VARIANT = 'max'
Remove-Item Env:ARKTS_REVIEW_VARIANT -ErrorAction SilentlyContinue
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
.\tools\run_code_clone_instrument.ps1 -StartOrdinal 1 -EndOrdinal 10 -LinterMode required -LogDirectory 'C:\Users\RoyCai\Desktop\group_project\TestResult1028'
```

本轮仍按 `RESULT totalSeconds <= 420` 且最终 PASS 统计限时成功；后端 1200 秒执行上限不替代 7 分钟指标。十条中至少七条限时成功才达到本批 70% 目标。

脚本自动设置原生进程输入/输出所需的 UTF-8 编码，运行结束后恢复原目录与控制台编码。`-LogDirectory` 同时显示终端输出并保存日志，每次脚本调用生成一个 `outputyyyyMMdd-HHmmss-fff.log`。PowerShell 5.1 的 Tee-Object 默认保存 UTF-16 LE，PowerShell 7 默认保存 UTF-8；日志读取程序应按 BOM/实际编码读取。

## 四种完整运行

以下均开启 Linter，按需选一条执行，完成后再运行下一条。

```powershell
# Local Test 数据集：长方法，共 8 条
& "$repo\tools\run_long_method_local.ps1" -LinterMode required -LogDirectory $logDir
```

```powershell
# Local Test 数据集：代码克隆，共 3 条
& "$repo\tools\run_code_clone_local.ps1" -LinterMode required -LogDirectory $logDir
```

```powershell
# Instrument Test 数据集：长方法，共 17 条
& "$repo\tools\run_long_method_instrument.ps1" -LinterMode required -LogDirectory $logDir
```

```powershell
# Instrument Test 数据集：代码克隆，共 27 条
& "$repo\tools\run_code_clone_instrument.ps1" -LinterMode required -LogDirectory $logDir
```

`local` / `instrument` 仅选择 JSON 数据集。测试门禁仍按实际可达测试入口自动选择 Local / Instrument：同一目标两类都有时都运行，变更新增模块时也可能触发两类测试。因此 Local 数据集不承诺完全不需要模拟器；涉及设备测试时须连接模拟器/真机并配置签名。所有实验共用源码目录及设备，不能并发批跑。

## 跳过 Linter、范围选择与单条重跑

四个脚本参数一致：

| 参数 | 默认值 | 作用 |
|---|---|---|
| `-LinterMode required` | 默认是 `skip` | 执行 Linter，新增/触及缺陷可触发返修 |
| `-LinterMode skip` | `skip` | 不执行 Linter，不因它返修；其他门禁继续执行 |
| `-StartOrdinal N` | `1` | 从展开后的第 N 条开始，包含 N |
| `-EndOrdinal N` | `0`，表示末尾 | 跑到第 N 条结束，包含 N；省略则到末尾 |
| `-ListOnly` | 不启用 | 仅列出所选序号和源码路径，不调用 Agent 或门禁，不创建源码快照 |
| `-LogDirectory PATH` | 不保存额外终端日志 | 同时在终端显示并保存 `output<日期时间>.log` |

```powershell
# 查看 Local 长方法数据集的全部 8 条
& "$repo\tools\run_long_method_local.ps1" -ListOnly

# 仅跑 Local 代码克隆第 2 条，跳过 Linter
& "$repo\tools\run_code_clone_local.ps1" -StartOrdinal 2 -EndOrdinal 2 -LinterMode skip -LogDirectory $logDir

# 跑 Instrument 长方法第 5～8 条
& "$repo\tools\run_long_method_instrument.ps1" -StartOrdinal 5 -EndOrdinal 8 -LinterMode required -LogDirectory $logDir

# Instrument 代码克隆从第 23 条续跑到末尾
& "$repo\tools\run_code_clone_instrument.ps1" -StartOrdinal 23 -LinterMode required -LogDirectory $logDir
```

按不连续序号重跑时，逐条调用；本例每条产生一个日志：

```powershell
foreach ($ordinal in @(1, 3)) {
    & "$repo\tools\run_code_clone_local.ps1" `
        -StartOrdinal $ordinal -EndOrdinal $ordinal `
        -LinterMode required -LogDirectory $logDir
}
```

## 默认路径与结果

脚本通过自身位置定位仓库，默认数据集位于同级项目 `arkts-code-smell/dataset/positive`；默认源码工作区为 `D:\arktsProgram`，默认 HomeCheck 工作目录为同级 `arkts异味检查工具`。可以用以下参数覆盖本机路径：

| 参数 | 含义 |
|---|---|
| `-DatasetRoot PATH` | `positive` 目录，其下须有 `local-test` / `instrument-test` 及对应 JSON |
| `-Workspace PATH` | 包含各 `sourceProject` 仓库的目录 |
| `-HomeCheckRoot PATH` | 包含 `homecheck-extrule` 子目录的工作目录（仅用于旧本机布局；后端默认使用仓库内置的 HomeCheck 包） |
| `-NodeExe PATH` | Node.js 可执行文件路径或命令名，默认 `node`；要求 20.19 或更高版本 |

`-ListOnly` 只需数据集可读，不要求源码工程、Node 构建产物或 HomeCheck 可用。超出范围或反向区间会在启动实验前报错。

每条正常完成仍输出 `RESULT ordinal=... verdict=... pipelineExit=... totalSeconds=... task=...`、`ROLLBACK_SNAPSHOT=...` 和 `END ordinal=...`，结果保存在本工具仓库 `runs/` 下。任务目录新增 `experiment.json`，记录 `dataset`、`datasetKind`、`smellType`、`ordinal`、`linterMode`，用于区分不同数据集的同名任务与序号。端到端 `totalSeconds` 口径与旧脚本一致，源码回滚在计时之后。

TS CLI 以退出码 0 表示 PASS，2 表示未通过。脚本核对本次新增运行的 result.json、退出码与任务身份后，FAIL/BLOCKED/INCOMPLETE 样例输出 RESULT、回滚并继续下一条；其他退出码、结果缺失、结果与退出码矛盾或任务身份不符则回滚并停止当前批次，避免误用其他运行的结果。恢复的是运行前源码快照，不等于自动重置至 Git HEAD。正常异常处理会尝试回滚；强制结束整个终端/进程后仍需检查日志末尾是否出现回滚与 END。
