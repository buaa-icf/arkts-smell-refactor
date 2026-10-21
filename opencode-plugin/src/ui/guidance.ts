import type { WorkbenchState } from "../controller.ts";

export function guidance(state: WorkbenchState): { title: string; detail: string } {
  if (state.busy) return { title: state.stopping ? "正在停止，请稍候" : "操作进行中，请稍候",
    detail: state.stopping ? "进程退出后可继续操作" : "2 查看阶段 · 4 日志 · c 中止" };
  if (state.applyState === "CONFLICT") return { title: "恢复存在待处理项", detail: "4 查看原因，处理后按 r 重试" };
  if (state.error) return { title: "操作失败，请查看上方原因", detail: "4 查看日志 · r 选择应用回滚" };
  if (state.applyState === "ROLLED_BACK") return { title: "已恢复应用前内容", detail: "s 重新检测 · p 重新分析" };
  if (state.applyState === "APPLYING") return { title: "应用事务尚未完成", detail: "r 选择记录，恢复应用前内容" };
  if (state.applyState === "APPLIED") {
    if (!state.appliedResult) return { title: "下一步：应用后复检", detail: "v 复检 · r 回滚应用" };
    return state.appliedResult.verdict === "PASS"
      ? { title: "复检通过，可继续处理方法", detail: "j/k 选择方法 · r 回滚应用" }
      : { title: "应用后复检未通过", detail: "2 查看原因 · r 回滚应用" };
  }
  if (state.candidate) return state.candidate.verdict === "PASS"
    ? { title: "下一步：审阅并应用", detail: "d 查看 Diff，确认后按 a 应用" }
    : { title: `候选 ${state.candidate.verdict}，暂不可应用`, detail: "2 查看原因 · t 复检 · x 重试" };
  const issue = state.issues[state.selected];
  if (!issue) return { title: "开始：检测或导入", detail: "s 检测 · i 导入 · h 历史" };
  if (!issue.supported) return { title: "当前规则仅支持查看", detail: "j/k 选择其他可重构方法" };
  if (state.prepared) return { title: "下一步：生成候选", detail: "确认风险后按 x；2 查看阶段" };
  return { title: "下一步：分析风险", detail: "p 分析 · b 可补充业务说明" };
}
