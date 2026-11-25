import fs from "node:fs";
import path from "node:path";
import type { Json, RefactorTask } from "./models.js";
import { taskFromJson, targetPath } from "./models.js";
import {
  isFile,
  readJson,
  readText,
  relative,
  slash,
  stamp,
  unique,
  within,
  writeJson,
} from "./utils.js";
import { runCommand } from "./process.js";
import { detectorSdkPaths } from "./homecheck_runtime.js";
import { changedCurrentLines } from "./workspace.js";
import { ownerAtLine, symbolRegion } from "./analysis/source.js";
export const reportedSymbol = (message: string) =>
  /(?:Method|Function)\s+['"]([^'"]+)['"]/.exec(message)?.[1] ?? null;
export const symbolMatches = (reported: string | null, target: string | null) =>
  !!reported &&
  !!target &&
  reported
    .split(".")
    .at(-1)!
    .replace(/^%AM\d+\$/, "") === target.split(".").at(-1);
export function issueTouchesChangedSymbol(
  text: string,
  reported: string | null,
  line: number,
  changed: Set<number>,
): boolean {
  if (changed.has(line)) return true;
  const region = symbolRegion(text, reported);
  return (
    region.located &&
    [...changed].some(
      (l) =>
        l >= region.startLine &&
        l <= region.startLine + region.text.split("\n").length - 1,
    )
  );
}
export function smellScanFiles(
  taskDir: string,
  source: string,
  target: string,
): string[] {
  const cp = path.join(taskDir, "refactor-changes.json"),
    changes = isFile(cp) ? (readJson(cp).changedProductionFiles ?? []) : [];
  return unique([
    path.resolve(target),
    ...changes
      .map((r: string) => path.resolve(source, r))
      .filter(
        (p: string) => within(p, source) && isFile(p) && /\.(ets|ts)$/i.test(p),
      ),
  ]);
}
export function homecheckReport(
  reportDir: string,
  source: string,
  rule: string,
): string {
  const summaryFile = path.join(reportDir, "summary.json");
  if (!isFile(summaryFile))
    throw new Error("未生成本轮扫描摘要：" + summaryFile);
  const summary = readJson(summaryFile);
  const samePath = (a: string, b: string) => {
    const normalize = (value: string) => {
      const resolved = slash(path.resolve(value));
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    return normalize(a) === normalize(b);
  };
  const repositories = Array.isArray(summary.repositories)
    ? summary.repositories.filter(
        (repo: Json) =>
          repo && typeof repo.path === "string" && samePath(repo.path, source),
      )
    : [];
  if (repositories.length !== 1)
    throw new Error("本轮扫描摘要未唯一匹配目标工程：" + source);
  const runs = Array.isArray(repositories[0].runs)
    ? repositories[0].runs.filter((run: Json) => run?.ruleName === rule)
    : [];
  if (runs.length !== 1)
    throw new Error("本轮扫描摘要未唯一匹配目标规则：" + rule);
  const run = runs[0];
  if (run.success !== true || run.exitCode !== 0 || run.timedOut || run.signal)
    throw new Error("HomeCheck 未成功完成目标规则扫描：" + rule);
  if (typeof run.issuesReportPath !== "string" || !run.issuesReportPath)
    throw new Error("本轮扫描摘要缺少目标规则报告路径");
  const report = path.resolve(reportDir, run.issuesReportPath);
  if (!within(report, reportDir))
    throw new Error("扫描摘要中的报告路径不在本轮输出目录：" + report);
  if (!isFile(report)) throw new Error("未生成本轮报告：" + report);
  if (!within(fs.realpathSync(report), fs.realpathSync(reportDir)))
    throw new Error("扫描报告通过链接越出本轮输出目录：" + report);
  return report;
}
async function scanRule(taskDir: string, homecheck: string, task: RefactorTask, source: string, files: string[]) {
  const relativeFiles = files.map((p) => relative(p, source)),
    reportDir = path.join(taskDir, "homecheck-report", stamp()),
    projectConfig = path.join(taskDir, "homecheck-project.json"),
    ruleConfig = path.join(taskDir, "homecheck-rule.json");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJson(projectConfig, {
    ...readJson(path.join(homecheck, "config/projectConfig.json")),
    ...detectorSdkPaths(),
    projectName: task.source_project,
    projectPath: source + path.sep,
    repos: [`${task.source_project}=${source}`],
    checkFiles: relativeFiles,
    datasetDir: "",
    reportDir,
    logPath: path.join(reportDir, "HomeCheck.log"),
    arkCheckPath: path.join(homecheck, "node_modules/homecheck"),
  });
  writeJson(ruleConfig, {
    ...readJson(path.join(homecheck, "config/ruleConfig.json")),
    files: relativeFiles,
    extRuleSet: [
      {
        ruleSetName: "extrulesproject",
        packagePath: path.join(homecheck, "rules"),
        extRules: { [task.rule]: 2 },
      },
    ],
  });
  const runner = path.join(homecheck, "scan.cjs");
  if (!isFile(runner))
    throw new Error("内置 HomeCheck 缺失，请运行 npm ci 安装项目依赖");
  const scratch = path.join(taskDir, "homecheck-temp");
  fs.mkdirSync(scratch, { recursive: true });
  const run = await runCommand(
    [
      process.execPath,
      runner,
      "--project-config",
      projectConfig,
      "--rule-config",
      ruleConfig,
      "--summary",
      path.join(reportDir, "summary.json"),
    ],
    {
      cwd: scratch,
      env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
      stream: true,
    },
  );
  if (run.code !== 0)
    throw new Error(
      `HomeCheck 扫描工具退出码 ${run.code}：${run.error ?? ""}`,
    );
  const report = homecheckReport(reportDir, source, task.rule);
  const evidence = {
    sourceRoot: source,
    summaryPath: path.join(reportDir, "summary.json"),
    reportPath: report,
    rule: task.rule,
    scannedFiles: files,
  };
  const issues: unknown = readJson(report);
  if (
    !Array.isArray(issues) ||
    issues.some(
      (i) =>
        !i ||
        typeof i.filePath !== "string" ||
        !Array.isArray(i.messages) ||
        i.messages.some((m: Json) => !m || typeof m.rule !== "string" || typeof m.message !== "string"),
    )
  )
    throw new Error("HomeCheck 报告结构无效");
  return { evidence, issues: issues as Json[] };
}
interface CloneLocation {
  file: string;
  start: number;
  end: number;
  member?: string;
}

// The detector prints a short left filename and a full right path. The report
// item supplies the authoritative left path, including for reversed pairs.
function cloneLocations(message: string, leftFile: string): CloneLocation[] {
  const body = /^Code Clone [^:]+:\s*(.+?)\s+is similar to\s+(.+?:\d+-\d+)\.?(?:\s*\([^)]*\))?\s*$/i.exec(message);
  if (!body) throw new Error("无法识别克隆组的两端位置");
  return body.slice(1).map((part, i) => {
    const match = /^(.+?\.(?:ets|ts))(?:\s*>\s*([^:]+))?:(\d+)-(\d+)$/i.exec(part.trim());
    if (!match) throw new Error("克隆组缺少文件或范围");
    return { file: i ? slash(match[1]) : leftFile, member: match[2]?.trim(),
      start: Number(match[3]), end: Number(match[4]) };
  });
}

function matchClonePair(group: CloneLocation[], pair: CloneLocation[]): "matched" | "uncertain" | "other" {
  let uncertain = false;
  const compatible = (a: CloneLocation, b: CloneLocation) =>
    a.file === b.file && (!a.member || !b.member || a.member === b.member);
  const overlaps = (a: CloneLocation, b: CloneLocation) => a.start <= b.end && b.start <= a.end;
  for (const left of group) {
    if (!compatible(left, pair[0])) continue;
    for (const right of group) {
      if (right === left || !compatible(right, pair[1])) continue;
      if (overlaps(left, pair[0]) && overlaps(right, pair[1])) return "matched";
      // Named methods in separate hosts can move; ranges alone cannot identify
      // two disjoint fragments within one method after their coordinates drift.
      if ((left.file !== right.file || left.member !== right.member) &&
          left.member?.endsWith("()") && left.member === pair[0].member &&
          right.member?.endsWith("()") && right.member === pair[1].member) return "matched";
      uncertain = true;
    }
  }
  return uncertain ? "uncertain" : "other";
}

function originalCloneGroup(task: RefactorTask, source: string): CloneLocation[] {
  const { start_line: start, end_line: end } = task.target.range;
  if (!start || !end || start < 1 || end < start) throw new Error("原始克隆片段缺少有效区间");
  let locations: CloneLocation[];
  try {
    locations = cloneLocations(task.message, targetPath(task));
  } catch {
    // Older imports may only carry the group in structured file/range fields.
    locations = [{ file: targetPath(task), start, end }];
  }
  const resolveFile = (file: string) => {
    const found = unique([
      path.resolve(task.workspace_root, file), path.resolve(task.project_root, file),
      path.resolve(source, file),
    ]).filter(f => within(f, source) && isFile(f));
    if (found.length !== 1 || !within(fs.realpathSync(found[0]), fs.realpathSync(source)))
      throw new Error("无法唯一定位原始克隆成员：" + file);
    return found[0];
  };
  for (const loc of locations) loc.file = resolveFile(loc.file);
  for (const related of task.target.related_targets) {
    const file = resolveFile(related.filePath ?? related.file_path);
    const range = related.range ?? {};
    const start = range.startLine ?? range.start_line, end = range.endLine ?? range.end_line;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)
      throw new Error("克隆成员缺少有效区间：" + file);
    if (!locations.some(l => l.file === file && l.start === start && l.end === end))
      locations.push({ file, start, end });
  }
  if (locations.length < 2) throw new Error("原始克隆对端缺失");
  return locations;
}

function matchReportFile(reported: string, files: string[], source: string): string | undefined {
  const normalized = slash(reported);
  if (path.isAbsolute(normalized)) return files.find(f => path.relative(f, normalized) === "");
  const candidates = files.filter(f => normalized === relative(f, source) ||
    normalized.endsWith("/" + relative(f, source)) || slash(f).endsWith("/" + normalized));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Re-scan the untouched source only after an initial agent returned no production diff. */
export async function recheckOriginalTarget(taskDir: string, homecheck: string | null, source: string): Promise<Json> {
  const task = taskFromJson(readJson(path.join(taskDir, "task.json")));
  let result: Json;
  try {
    if (!homecheck) throw new Error("未找到 HomeCheck");
    if (!task.rule.startsWith("@extrulesproject/")) throw new Error("该规则不支持 HomeCheck 复核");
    const target = targetPath(task);
    if (!isFile(target) || !within(target, source) || !within(fs.realpathSync(target), fs.realpathSync(source)))
      throw new Error("原始目标文件不存在或超出工程范围");
    const group = task.smell_type === "code-clone" ? originalCloneGroup(task, source) : [];
    const files = unique([target, ...group.map(l => l.file)]);
    const { evidence, issues } = await scanRule(taskDir, homecheck, task, source, files);
    const summary = readJson(evidence.summaryPath);
    if (!Array.isArray(summary.loadedRules) || !summary.loadedRules.includes(task.rule) || !Array.isArray(summary.scannedFiles) ||
        !files.every(file => summary.scannedFiles.some((scanned: string) =>
          typeof scanned === "string" && path.relative(fs.realpathSync(file), scanned) === "")))
      throw new Error("扫描摘要未确认所有原始文件及目标规则");
    const risk = path.join(taskDir, "risk-report.json");
    const expectedOwner = isFile(risk) ? readJson(risk).target?.owner : undefined;
    if (!group.length && !task.target.symbol) throw new Error("原始目标缺少可识别符号");
    const matched: Json[] = [];
    let uncertainClone = false;
    for (const item of issues) {
      const file = matchReportFile(item.filePath, files, source);
      for (const m of item.messages) {
        if (m.rule !== task.rule) continue;
        if (!file) throw new Error("无法确认报告文件与原始目标的对应关系：" + item.filePath);
        if (group.length) {
          const pair = cloneLocations(m.message, file);
          const right = matchReportFile(pair[1].file, files, source);
          if (!right) throw new Error("无法确认报告中的克隆对端：" + pair[1].file);
          pair[1].file = right;
          const kind = matchClonePair(group, pair);
          if (kind === "matched") matched.push({ file, ...m });
          if (kind === "uncertain") uncertainClone = true;
        } else {
          const symbol = reportedSymbol(m.message);
          if (!symbol) throw new Error("检测报告没有可识别的方法名");
          if (!symbolMatches(symbol, task.target.symbol)) continue;
          const line = Number(m.line ?? m.rangeStart);
          if (expectedOwner && !Number.isInteger(line)) throw new Error("检测报告缺少方法位置");
          if (!expectedOwner || ownerAtLine(readText(file), line, path.parse(file).name) === expectedOwner)
            matched.push({ file, ...m });
        }
      }
    }
    if (!matched.length && uncertainClone) throw new Error("同文件或成员存在其他克隆，当前区间无法唯一定位原组");
    result = { ...evidence, status: matched.length ? "DETECTED" : "NOT_REPRODUCED", matched };
  } catch (error) {
    result = { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : String(error) };
  }
  result.taskId = task.task_id;
  writeJson(path.join(taskDir, "original-target-recheck.json"), result);
  return result;
}

export async function smellGate(
  taskDir: string,
  homecheck: string,
  source?: string,
): Promise<number> {
  const findings = path.join(taskDir, "smell-after.json");
  fs.rmSync(findings, { force: true });
  const blocked = (reason: string) => {
    console.error("SMELL_GATE_BLOCKED: " + reason);
    return 3;
  };
  try {
    const task = taskFromJson(readJson(path.join(taskDir, "task.json")));
    source ??= task.project_root;
    const target = targetPath(task);
    if (!isFile(target) || !within(target, source))
      return blocked(`目标文件不存在或不在工程目录：${target}`);
    const files = smellScanFiles(taskDir, source, target);
    const { evidence, issues } = await scanRule(taskDir, homecheck, task, source, files);
    writeJson(path.join(taskDir, "smell-evidence.json"), evidence);
    const riskFile = path.join(taskDir, "risk-report.json"),
      risk = isFile(riskFile) ? readJson(riskFile) : {},
      expectedOwner = risk.target?.owner,
      targetText = readText(target),
      changes = new Map(
        files.map((p) => [
          relative(p, source!),
          changedCurrentLines(
            path.join(taskDir, "baseline-production", relative(p, source!)),
            p,
          ),
        ]),
      ),
      remaining: Json[] = [];
    for (const item of issues as Json[]) {
      const itemPath = slash(item.filePath),
        file = files.find(
          (p) =>
            itemPath === slash(p) ||
            itemPath === relative(p, source!) ||
            itemPath.endsWith("/" + relative(p, source!)),
        );
      if (!file) continue;
      for (const m of item.messages) {
        if (m.rule !== task.rule) continue;
        const reported = reportedSymbol(m.message ?? ""),
          line = Number(m.line ?? m.rangeStart ?? 1);
        let same =
          path.resolve(file) === path.resolve(target) &&
          symbolMatches(reported, task.target.symbol);
        if (same && expectedOwner)
          same =
            ownerAtLine(
              targetText,
              line,
              path.basename(target, path.extname(target)),
            ) === expectedOwner;
        if (
          same ||
          issueTouchesChangedSymbol(
            readText(file),
            reported,
            line,
            changes.get(relative(file, source))!,
          )
        )
          remaining.push({ ...m, filePath: itemPath });
      }
    }
    writeJson(findings, remaining);
    if (remaining.length) {
      console.error(`目标异味仍存在：${remaining.length} 条`);
      return 1;
    }
    console.log("目标异味复检未命中");
    return 0;
  } catch (e) {
    return blocked(e instanceof Error ? e.message : String(e));
  }
}
