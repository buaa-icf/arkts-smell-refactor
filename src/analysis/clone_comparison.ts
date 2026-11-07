import { diffArrays } from "diff";
import type { Json } from "../models.js";

export interface CloneSourceInput {
  filePath: string;
  identityPath?: string;
  source: string;
  startLine: number | null;
  endLine: number | null;
  resolved: boolean;
}

/** Original report coordinates only: no guessed expansion or generated rewrite. */
export function cloneComparisonEvidence(inputs: CloneSourceInput[]): Json {
  let budget = 16_000;
  const contexts = inputs.slice(0, 6).map(input => {
    const lines = input.source.split(/\r?\n/);
    const valid = input.resolved && Number.isInteger(input.startLine) && Number.isInteger(input.endLine) &&
      input.startLine! > 0 && input.endLine! >= input.startLine! && input.endLine! <= lines.length;
    const source = valid ? lines.slice(input.startLine! - 1, input.endLine!).join("\n") : "";
    const inline = valid && source.length <= 6000 && source.length <= budget;
    if (inline) budget -= source.length;
    return {
      filePath: input.filePath, startLine: input.startLine, endLine: input.endLine,
      inline, ...(inline ? { source } : { reason: !valid ? "报告范围缺失、无效或源码未解析" : "超过单片段或总内联预算，按原路径范围补读，未截断" }),
    };
  });
  const pairs: Json[] = [];
  // Diff work is bounded independently from the prompt budget. Large reports
  // retain a read hint rather than doing unbounded sequence comparison.
  const reportLines = (input: CloneSourceInput) => {
    if (!input.resolved || !Number.isInteger(input.startLine) || !Number.isInteger(input.endLine) ||
        input.startLine! < 1 || input.endLine! < input.startLine! || input.endLine! - input.startLine! > 400) return null;
    const lines = input.source.split(/\r?\n/);
    if (input.endLine! > lines.length) return null;
    const result = lines.slice(input.startLine! - 1, input.endLine!).map(line => line.trim());
    return result.join("\n").length <= 16_000 ? result : null;
  };
  const first = inputs[0], left = first ? reportLines(first) : null;
  if (left) for (const other of inputs.slice(1, 4)) {
    const right = reportLines(other);
    if (!right) continue;
    const changes = diffArrays(left, right, { maxEditLength: 160 });
    if (!changes) continue;
    let a = first.startLine!, b = other.startLine!;
    const shared: Json[] = [], differences: Json[] = [];
    for (const [index, part] of changes.entries()) {
      if (!part.added && !part.removed && part.count >= 2 && part.value.some(line => /\w/.test(line)))
        shared.push({ leftStart: a, leftEnd: a + part.count - 1, rightStart: b, rightEnd: b + part.count - 1, lines: part.count });
      const next = changes[index + 1];
      if (part.removed && next?.added)
        differences.push({ leftStart: a, leftEnd: a + part.count - 1, rightStart: b, rightEnd: b + next.count - 1 });
      else if (part.removed)
        differences.push({ leftStart: a, leftEnd: a + part.count - 1, rightStart: null, rightEnd: null, rightBefore: b });
      else if (part.added && !changes[index - 1]?.removed)
        differences.push({ leftStart: null, leftEnd: null, leftBefore: a, rightStart: b, rightEnd: b + part.count - 1 });
      if (!part.added) a += part.count;
      if (!part.removed) b += part.count;
    }
    pairs.push({ leftFile: first.filePath, rightFile: other.filePath,
      shared: shared.sort((a, b) => b.lines - a.lines).slice(0, 3), differences: differences.slice(0, 4),
      omittedShared: Math.max(0, shared.length - 3), omittedDifferences: Math.max(0, differences.length - 4) });
  }
  return { contexts, pairs, omittedContexts: Math.max(0, inputs.length - contexts.length),
    scope: "重构前报告范围；相同行仅忽略行首尾空白。差异位置不是参数化方案，既非完整语义 diff，也不证明可移动边界或等价。编辑后按当前源码定位。" };
}

export function cloneComparisonHints(evidence: Json, relative: (file: string) => string): string[] {
  const hints = [String(evidence.scope)];
  for (const pair of evidence.pairs) {
    const left = relative(pair.leftFile), right = relative(pair.rightFile);
    for (const row of pair.shared)
      hints.push(`相同行块：${left}:L${row.leftStart}–${row.leftEnd} ↔ ${right}:L${row.rightStart}–${row.rightEnd}；仍需逐实例核对状态、类型和生命周期。`);
    for (const row of pair.differences) {
      const a = row.leftStart === null ? `${left}:L${row.leftBefore} 前（无对应行）` : `${left}:L${row.leftStart}–${row.leftEnd}`;
      const b = row.rightStart === null ? `${right}:L${row.rightBefore} 前（无对应行）` : `${right}:L${row.rightStart}–${row.rightEnd}`;
      hints.push(`差异块：${a} ↔ ${b}；差异必须显式保留，不能按其中一端覆盖另一端。`);
    }
    if (pair.omittedShared || pair.omittedDifferences) hints.push("仅展示部分相同/差异块，完整原文见报告范围或当前文件。");
  }
  for (const context of evidence.contexts) {
    const label = `${relative(context.filePath)}:L${context.startLine}–${context.endLine}`;
    if (!context.inline) { hints.push(`${label}：${context.reason}。`); continue; }
    const source = String(context.source), fence = "`".repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map(m => m[0].length + 1)));
    hints.push(`${label} 原报告片段完整提供；仅补读缺失上下文，不把报告首尾当作可直接剪切的边界：\n${fence}\n${source}\n${fence}`);
  }
  if (evidence.omittedContexts) hints.push(`另有 ${evidence.omittedContexts} 个实例未内联，仍必须核对全部已知实例。`);
  return hints;
}
