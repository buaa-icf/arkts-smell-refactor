# SearchPage.ets 回滚调查（2026-10-21）

本次仅只读检查用户工程及实际运行证据；用户已在 IDE 手动恢复，不执行业务文件回滚，也不改写旧事务。

## 已确认的记录

证据根目录：`C:/Users/RoyCai/AppData/Local/Temp/arkts-refactor-tui/0446837cede4dc96/runs`。下列时间为北京时间。

| 时间 | 证据 | 结果 |
| --- | --- | --- |
| 17:11:48–17:19:51 | `06b69252-db6a-495e-9648-941513a1e28a/session.json`、`candidate.json` | `long-method-0001-build` 候选 PASS；重构、异味、构建、契约、测试、linter、评审均 PASS |
| 17:23:19.983 | 同一候选的 `apply-transaction.json` | APPLIED，仅写入 `feature/book_home/src/main/ets/views/SearchPage.ets`，attempted 一项、conflicts 空 |
| 17:23:27–17:26:03 | `8ff4bee2-0bb2-444b-a366-9f33d87ccd71/response.json` | 应用后复检 PASS；返回全工程 25 个问题，原 SearchPage 的长方法已消除，Feature Envy 仍在 |
| 17:27:31 | 当前 SearchPage.ets 的文件时间及 SHA-256 | 用户手动恢复后的文件与冻结 before 逐字节一致 |

原始／当前 SHA-256：`03cc696d86663a3cff94db529c63ac2e84235785c342b485e626e8c7f863dc49`（12087 bytes）。候选 after：`0ac6f93083469254878f82a698b7914ad77c2cde9e6b1b4bbc7a97fe095d9777`（11445 bytes）。冻结 before/after 摘要与清单相符，检查时无 `.apply.lock`。

## 原因范围与代码缺陷

事务仍停在 APPLIED，更新时间仍是应用时刻，没有留下 ROLLED_BACK 或 CONFLICT。旧版 r 失败只写内存 state.error，未持久化到运行目录；宿主日志也没有这次回滚的错误详情。因此现存日志无法精确证明当时在哪一步失败，不能据此断言文件占用、权限或用户修改冲突。

已发现可复现的状态缺陷：Workbench.select、setInstructions、resetEvidence 会清空当前 candidate；recover 却只接受 state.candidate。应用后复检刷新了列表，随后切换方法或重扫／导入，r 将提示“请先从历史选择候选”，不会触达原来的应用事务。另一种情况是当前选中未应用候选，r 会报“此候选没有应用事务”。这些都与“原事务仍 APPLIED”相容，但由于缺少旧版操作日志，不能确认用户当时的具体按键顺序。

另一个诊断缺陷是 rollback 捕获所有文件异常后仅存文件名，controller 统一提示“保留用户修改”，将 I/O 故障也混为内容冲突。

## 修复与验证范围

先记录设计，再实现左侧阶段提示、从持久化应用历史选择回滚目标、带候选 ID 和文件列表的确认、TypeScript 操作日志和逐文件恢复原因。回归使用仓库内临时示例，覆盖应用→复检刷新问题→切换方法→按历史事务回滚、重启恢复、手动回滚幂等、内容冲突和文件系统异常；不在该业务工程再次执行应用或恢复。
