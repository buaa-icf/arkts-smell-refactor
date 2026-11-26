import fs from "node:fs";
import path from "node:path";
import { callArguments, mask, matching } from "./analysis/source.js";
import type { Json } from "./models.js";
import { hash, isFile, readJson, within } from "./utils.js";
import { changedCurrentLines, productionKind } from "./workspace.js";

const identifier = "[A-Za-z_$][\\w$]*";
const member = `${identifier}(?:\\.${identifier})*`;
const callStart = new RegExp(`^ *(?:return +|${member} *= *)?(${member})\\(`);
const simpleValue = `${member}(?:\\( *(?:${member}(?: *, *${member})*)? *\\))?`;
const parameter = `${identifier}(?: *: *${member})?`;
const callback = `\\(${parameter}(?: *, *${parameter})*\\)(?: *: *${member})? *=> *${simpleValue}`;
const argument = new RegExp(`^(?:${simpleValue}|[0-9]+|${callback})$`);

function wrapCall(line: string, max: number): string[] | null {
  const start = callStart.exec(line);
  if (!start || /^(if|for|switch|while|catch|function|super|import|throw|with)$/.test(start[1])) return null;
  const open = start[0].length - 1, end = matching(line, open, "(", ")");
  if (end < 0 || !/^;? *$/.test(line.slice(end + 1))) return null;
  const args = callArguments(line, open, end);
  if (args.length < 2 || !args.every(value => argument.test(value))) return null;
  // Only replace spaces after outer commas. This equality also rejects comments,
  // trailing commas, opaque literals and any whitespace normalized by the scanner.
  if (args.join(", ") !== line.slice(open + 1, end)) return null;
  const indent = /^ */.exec(line)![0] + "  ";
  const parts = args.map((value, index) =>
    (index === 0 ? line.slice(0, open + 1) : indent) + value + (index + 1 === args.length ? line.slice(end) : ","));
  return parts.every(part => part.length <= max) ? parts : null;
}

function prepareEdits(taskDir: string, source: string, workspace: string, round: number): Map<string, string> | null {
  const reportPath = path.join(taskDir, `failure-report-${round}.json`);
  if (!isFile(reportPath)) return null;
  const report = readJson(reportPath);
  if (report.attempt !== round || report.stage !== "linter" || !report.repairable ||
      report.classification !== "INTRODUCED_LINTER_FAILURE" || !Array.isArray(report.issues) ||
      !report.issues.length || report.issues.length > 32) return null;
  const changes = readJson(path.join(taskDir, "refactor-changes.json"));
  const byFile = new Map<string, Json[]>();
  for (const issue of report.issues) {
    const r = issue.filePath;
    if (issue.rule !== "@hw-stylistic/max-len" || typeof r !== "string" || path.isAbsolute(r) ||
        !changes.changedProductionFiles?.includes(r) || !report.changedProductionFiles?.includes(r) ||
        productionKind(r) !== "source" || !Number.isSafeInteger(issue.line) || issue.line < 1) return null;
    if (!byFile.has(r)) byFile.set(r, []);
    byFile.get(r)!.push(issue);
  }
  const edits = new Map<string, string>();
  for (const [r, issues] of byFile) {
    const file = path.resolve(workspace, r), live = path.resolve(source, r);
    const baseline = path.resolve(taskDir, "baseline-production", r);
    if (!within(file, workspace) || !within(live, source) || !within(baseline, path.join(taskDir, "baseline-production")) ||
        !isFile(file) || !isFile(live) || (!isFile(baseline) && !changes.newProductionFiles?.includes(r))) return null;
    const digest = hash(file);
    if (digest !== hash(live) || issues.some(issue => issue.sourceSha256 !== digest)) return null;
    const changed = changedCurrentLines(baseline, file);
    const text = fs.readFileSync(file, "utf8"), lines = text.split("\n"), code = mask(text).split("\n");
    // The masker does not lex regex literals or nested template substitutions.
    const last = Math.max(...issues.map(issue => issue.line));
    if (lines.slice(0, last).join("\n").includes("`") || code.slice(0, last).join("\n").includes("/")) return null;
    for (const issue of issues) {
      const index = issue.line - 1, raw = lines[index];
      if (raw === undefined || !changed.has(issue.line) || code[index] !== raw) return null;
      const line = raw.replace(/\r$/, "");
      const lengths = /^This line has a length of (\d+)\. Maximum allowed is (\d+)\.$/.exec(issue.message);
      if (!lengths || Number(lengths[1]) !== line.length || line.length <= Number(lengths[2])) return null;
      const parts = wrapCall(line, Number(lengths[2]));
      if (!parts) return null;
      lines[index] = raw.endsWith("\r") ? parts.join("\r\n") + "\r" : parts.join("\n");
    }
    edits.set(file, lines.join("\n"));
  }
  return edits;
}

export function repairLongCallLines(taskDir: string, source: string, workspace: string, round: number): boolean {
  let edits: Map<string, string> | null;
  try { edits = prepareEdits(taskDir, source, workspace, round); } catch { return false; }
  if (!edits) return false;
  // Every diagnostic was validated first. An I/O failure in this private copy
  // aborts the gate before syncProductionChanges can publish a partial repair.
  for (const [file, text] of edits) fs.writeFileSync(file, text);
  return true;
}
