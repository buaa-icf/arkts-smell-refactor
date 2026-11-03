import path from "node:path";
import type { Json } from "./models.js";
import { within } from "./utils.js";

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
