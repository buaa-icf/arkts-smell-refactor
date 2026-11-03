# 2026-11-03 内部验证恢复与签名误判修复

本轮撤销“重构 Agent 完成源码自查后直接交回、验证完全交给平台”的设置。重构和返修 Agent 可在隔离工作区做必要构建或 ArkTS 检查；提示词要求首次通过即停止，每轮合计最多两次，环境失败立即交回。完整的平台门禁继续执行。网页和内置技能入口限制、模型路由、集中评审材料及评审格式修复保留。

策略版本为 `2026-11-03-bounded-agent-validation`。子进程配置对重构/返修开放 `build_project`、`arkts_check`，评审仍禁用；JSON 格式修复仍使用无工具 Agent。两次限制属于提示词约束，不声称 CLI 已硬性计数执行。下一轮显式使用 `-LinterMode skip`，Linter 记为 SKIPPED，不参与验收或返修；内部编译/类型检查、异味、契约、构建、测试及语义评审仍保留。

## 最新运行与回滚核验

终端日志：`TestResult1028/output20261103-102444-919.log`。实际完成两条运行，第 3 条仅出现 SELECTED，没有对应新运行目录。

| 序号 | 目标 | 端到端秒数 | 结果 | 返修次数 | 回滚核验 |
|---|---|---:|---|---:|---|
| 1 | BookRead / AboutPage | 305.842 | BLOCKED | 0 | 187 个文件与运行前快照 SHA-256 一致 |
| 2 | OfficeAttendance / DataManager | 806.615 | BLOCKED | 2 | 150 个文件与运行前快照 SHA-256 一致 |

快照备份本身的哈希也通过核验；没有缺失或额外新增的 `.ets`/`.ts` 源码。第二条创建的 `MockDataStore.ets` 已删除。两条 `refactor-changes.json` 均没有资源修改，因此无遗漏的本轮代码变更需要补回滚。核对依据为运行前快照，不重置至仓库 HEAD。

## test BLOCKED 原因

两条在安装/执行测试前均被签名准备阶段拦截，`test-results.json` 为 `SIGNING_UNAVAILABLE`，`jobs=[]`。详细报告中候选配置被拒绝的原因均为 `PROFILE_CERTIFICATE_MISMATCH`，该轮没有进入模拟器执行。

进一步只读核对发现，两份配置的 `.cer` 均为三个 PEM 证书组成的链，`.p7b` 中的开发证书确实存在于链内，应用标识也一致。旧实现用 `new X509Certificate(fileBytes)` 只读第一张证书，错误地将整份配置判为不匹配。

修复后按 profile 引用的开发/发布证书指纹，在配置文件的全部证书中选取精确匹配项，再沿用应用标识、有效期、profile 签名和设备授权检查。支持单证书 DER；不修改源工程签名配置或证书材料，也不把静态匹配当作实际设备测试已通过。

修复后的本机签名准备核验继续报告 `DEVICE_AUTHORIZATION_UNVERIFIED_OR_MISMATCH`。随后只读查询确认：实际 HDC 能识别 1 台设备并正常读取其 UDID；两个 profile 的 `device-id-type` 均为 udid，各有 3 个授权 UDID，但都不包含当前连接设备。需要在 DevEco 中为当前模拟器更新这两个工程的签名 profile。此项是真实授权缺口，不能通过跳过 Linter 或忽略签名检查消除；原始运行则是先被证书链误判挡住，尚未走到该项检查。

## 验证

`npm test` 共 225 项全部通过。新增真实 CMS 用例覆盖证书在链尾/链首、真正缺失证书时拒绝；既有过期、应用不匹配、设备未授权与签名被跳过用例继续通过。对两份实际材料复核：旧“只读首张”仍返回不匹配，新“完整证书文件”均通过证书绑定检查。

只读审计：`.codex_tmp/rollback-audit-20261103.json`、`.codex_tmp/signing-certificate-audit-20261103.json`、`.codex_tmp/signing-preparation-probe-20261103.json`、`.codex_tmp/hdc-signing-audit-20261103.json`。审计未保存实际设备 UDID 或密码；本机核验生成的签名配置副本已删除。本轮没有运行 `tools` 下的实验脚本；后续十条命令见 [实验说明](experiment-scripts.md)。限时成功仍要求最终 PASS 且 `RESULT totalSeconds <= 420`。
