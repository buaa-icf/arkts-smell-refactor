import path from "node:path";
import type { Json } from "./models.js";
import { readText, within } from "./utils.js";

/** Compare two lint runs for the same file, preserving the multiplicity of each finding. */
export function addedLintIssues(
  beforeFile: string, before: Json[], afterFile: string, after: Json[], changedLines: Set<number>,
): Json[] {
  const original = readText(beforeFile).split(/\r?\n/);
  const candidate = readText(afterFile).split(/\r?\n/);
  const key = (issue: Json, lines: string[]) => {
    const line = lines[issue.line - 1], statement = line?.trim();
    // For a bare closing brace there is no statement to identify across moves.
    if (!statement || !/[\p{L}\p{N}_$]/u.test(statement)) return null;
    const indent = line.length - line.trimStart().length;
    return JSON.stringify([issue.rule, issue.severity, issue.message, statement, Math.max(0, issue.column - indent)]);
  };
  const remaining = new Map<string, number>();
  for (const issue of before) {
    const signature = key(issue, original);
    if (signature !== null) remaining.set(signature, (remaining.get(signature) ?? 0) + 1);
  }
  // An unchanged copy consumes its own warning before any duplicate on a new line.
  const ordered = [...after].sort((a, b) => Number(changedLines.has(a.line)) - Number(changedLines.has(b.line)));
  return ordered.filter(issue => {
    const signature = key(issue, candidate);
    const count = signature === null ? 0 : remaining.get(signature) ?? 0;
    if (signature !== null && count > 0) {
      remaining.set(signature, count - 1);
      return false;
    }
    return changedLines.has(issue.line);
  });
}

/** Official devecocli check lint --format json schema, not terminal-table parsing. */
export function parseDevecoLintReport(
  report: unknown,
  workspace: string,
): Json[] {
  const data = report as Json;
  if (!data || !Array.isArray(data.issues) || !data.summary)
    throw new Error("缺少官方 Linter issues/summary");
  for (const key of [
    "filesChecked",
    "issues",
    "errors",
    "warnings",
    "suggestions",
  ])
    if (!Number.isSafeInteger(data.summary[key]) || data.summary[key] < 0)
      throw new Error("无效 Linter 汇总字段：" + key);
  if (data.summary.issues !== data.issues.length)
    throw new Error("Linter issue 数量与汇总不一致");
  const counts: Record<string, number> = {
    error: 0,
    warning: 0,
    suggestion: 0,
  };
  const issues: Json[] = [];
  for (const issue of data.issues) {
    const severity =
      typeof issue?.severity === "string"
        ? issue.severity.toLowerCase()
        : "unknown";
    if (["info", "off"].includes(severity)) continue;
    if (
      !Object.hasOwn(counts, severity) ||
      typeof issue.file !== "string" ||
      !issue.file ||
      !Number.isSafeInteger(issue.line) ||
      issue.line < 1 ||
      typeof issue.rule !== "string" ||
      typeof issue.message !== "string"
    )
      throw new Error("Linter 诊断缺少有效文件、行号、规则或严重级别");
    const file = path.resolve(workspace, issue.file);
    if (!within(file, workspace))
      throw new Error("Linter 诊断路径超出本次隔离副本");
    counts[severity]++;
    issues.push({
      filePath: file,
      line: issue.line,
      column: issue.column ?? 0,
      severity: severity === "warning" ? "warn" : severity,
      rule: issue.rule,
      message: issue.message,
    });
  }
  if (
    counts.error !== data.summary.errors ||
    counts.warning !== data.summary.warnings ||
    counts.suggestion !== data.summary.suggestions
  )
    throw new Error("Linter 严重级别计数与汇总不一致");
  // Native clean-file reports can be [], normalized by CLI as filesChecked=0.
  // Do not reinterpret that field as evidence of a tool error or invent a count.
  return issues;
}
