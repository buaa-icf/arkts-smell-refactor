import fs from "node:fs";
import path from "node:path";
import type { Json } from "./models.js";
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
import { runCommand, which } from "./process.js";
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
    const files = smellScanFiles(taskDir, source, target),
      relativeFiles = files.map((p) => relative(p, source!)),
      reportDir = path.join(taskDir, "homecheck-report", stamp()),
      projectConfig = path.join(taskDir, "homecheck-project.json"),
      ruleConfig = path.join(taskDir, "homecheck-rule.json");
    fs.mkdirSync(reportDir, { recursive: true });
    writeJson(projectConfig, {
      ...readJson(path.join(homecheck, "config/projectConfig.json")),
      projectName: task.source_project,
      projectPath: path.dirname(source),
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
          packagePath: path.join(homecheck, "extrulesproject-1.0.0.tgz"),
          extRules: { [task.rule]: 2 },
        },
      ],
    });
    const runner = path.join(homecheck, "scripts/gitcodeArktsPerfTest.js"),
      npm = which("npm");
    if (!isFile(runner) || !npm)
      return blocked("HomeCheck 文件级扫描入口或 npm 不存在");
    const scratch = path.join(taskDir, "homecheck-temp");
    fs.mkdirSync(scratch, { recursive: true });
    const run = await runCommand(
      [
        npm,
        "run",
        "scan:files",
        "--",
        "--f1=false",
        "--dashboard=false",
        "--files=" + relativeFiles.join(","),
        "--baseProjectConfig=" + projectConfig,
        "--baseRuleConfig=" + ruleConfig,
        "--includeRules=" +
          task.rule
            .split("/")
            .at(-1)!
            .replace(/-check$/, ""),
        "--outputDir=" + reportDir,
      ],
      {
        cwd: homecheck,
        env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
        stream: true,
      },
    );
    if (run.code !== 0)
      return blocked(
        `HomeCheck 扫描工具退出码 ${run.code}：${run.error ?? ""}`,
      );
    const report = homecheckReport(reportDir, source, task.rule);
    writeJson(path.join(taskDir, "smell-evidence.json"), {
      sourceRoot: source,
      summaryPath: path.join(reportDir, "summary.json"),
      reportPath: report,
      rule: task.rule,
      scannedFiles: files,
    });
    const issues: unknown = readJson(report);
    if (
      !Array.isArray(issues) ||
      issues.some(
        (i) =>
          !i ||
          typeof i.filePath !== "string" ||
          !Array.isArray(i.messages) ||
          i.messages.some((m: unknown) => !m || typeof m !== "object"),
      )
    )
      return blocked("HomeCheck 报告结构无效");
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
