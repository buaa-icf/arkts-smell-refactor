import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Json } from "../models.js";
import { taskFromJson, targetPath } from "../models.js";
import { relatedTargets, parseSymbol } from "../dataset.js";
import {
  copyFile,
  hash,
  isFile,
  isDir,
  readJson,
  readText,
  relative,
  slash,
  unique,
  writeJson,
} from "../utils.js";
import { runCommand } from "../process.js";
import { changedCurrentLines } from "../workspace.js";
import {
  issueTouchesChangedSymbol,
  reportedSymbol,
  smellScanFiles,
  symbolMatches,
} from "../smell.js";
import { ownerAtLine } from "../analysis/source.js";
import {
  BridgeContext,
  BridgeError,
  RULES,
  allowedProduction,
  fileInProject,
  inspectEnvironment,
  projectFiles,
  safePath,
} from "./common.js";

export function normalizeIssues(records: unknown, root: string): Json[] {
  if (records && typeof records === "object" && !Array.isArray(records))
    records = [records];
  if (!Array.isArray(records))
    throw new BridgeError("INVALID_INPUT", "顶层必须是异味对象或 JSON 数组");
  const result: Json[] = [];
  for (const [index, record] of records.entries()) {
    if (
      !record ||
      typeof record.filePath !== "string" ||
      !Array.isArray(record.messages)
    )
      throw new BridgeError(
        "INVALID_INPUT",
        `第 ${index + 1} 条缺少 filePath/messages[]`,
      );
    const file = fileInProject(root, record.filePath);
    for (const message of record.messages) {
      if (
        !message ||
        typeof message.message !== "string" ||
        typeof message.rule !== "string"
      )
        throw new BridgeError("INVALID_INPUT", "message/rule 必须为字符串");
      const start = message.rangeStart ?? message.line ?? 1,
        end = message.rangeEnd ?? start;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start
      )
        throw new BridgeError("INVALID_INPUT", "行号范围无效");
      const related = relatedTargets(message.message).map((r) => {
        const p = fileInProject(root, r.filePath);
        return {
          filePath: p,
          reportedPath: r.filePath,
          startLine: r.range.startLine,
          endLine: r.range.endLine,
          sourceSha256: hash(p),
        };
      });
      result.push({
        issueId: crypto.randomUUID(),
        filePath: relative(file, root),
        absolutePath: file,
        rule: message.rule,
        smellType: RULES[message.rule] ?? "unsupported",
        severity: String(message.severity ?? ""),
        message: message.message,
        symbol: parseSymbol(message.message),
        startLine: start,
        endLine: end,
        relatedTargets: related,
        sourceSha256: hash(file),
        rawMessage: message,
        commitHash: String(record.commitHash ?? ""),
        supported:
          message.rule in RULES &&
          allowedProduction(relative(file, root)) &&
          related.every((r) => allowedProduction(relative(r.filePath, root))),
      });
    }
  }
  return result;
}
export function scopeRuleIgnores(config: Json, root: string): Json {
  const result = { ...config };
  for (const key of ["ignore", "excluded"])
    if (Array.isArray(result[key]))
      result[key] = result[key].map((p: unknown) =>
        path.isAbsolute(String(p))
          ? String(p)
          : slash(root).replace(/\/$/, "") +
            "/" +
            slash(String(p)).replace(/^\//, ""),
      );
  if (Array.isArray(result.overrides))
    result.overrides = result.overrides.map((c: Json) =>
      scopeRuleIgnores(c, root),
    );
  return result;
}
export async function runTool(
  ctx: BridgeContext,
  command: string[],
  cwd: string,
  log: string,
  follow?: string,
): Promise<number> {
  const scratch = path.join(path.dirname(log), "temp");
  fs.mkdirSync(scratch, { recursive: true });
  let offset = 0;
  const decoder = new StringDecoder("utf8");
  const readNewLog = () => {
    if (!follow || !isFile(follow)) return;
    const size = fs.statSync(follow).size;
    if (size < offset) {
      offset = 0;
      decoder.end();
    }
    const fd = fs.openSync(follow, "r");
    try {
      while (offset < size) {
        const data = Buffer.alloc(Math.min(8000, size - offset)),
          count = fs.readSync(fd, data, 0, data.length, offset);
        if (!count) break;
        offset += count;
        ctx.log(decoder.write(data.subarray(0, count)));
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  const timer = follow
    ? setInterval(() => {
        try {
          readNewLog();
        } catch {}
      }, 200)
    : undefined;
  try {
    const run = await runCommand(command, {
      cwd,
      env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
      timeoutSeconds: 1200,
      onOutput: (text) => ctx.log(text),
    });
    fs.writeFileSync(log, run.output, "utf8");
    if (run.error || run.timedOut)
      throw new BridgeError("TOOL_UNAVAILABLE", run.error ?? "工具运行超时");
    return run.code ?? 3;
  } finally {
    if (timer) clearInterval(timer);
    try {
      readNewLog();
    } catch {}
    ctx.log(decoder.end());
  }
}
function scanFailure(
  ctx: BridgeContext,
  run: string,
  reason: string,
  exitCode?: number,
): BridgeError {
  const logs = [
      path.join(run, "scan.log"),
      path.join(run, "scan/HomeCheck.log"),
    ],
    diagnostic = logs
      .filter(isFile)
      .map((p) => `[${path.basename(p)}]\n${readText(p).slice(-8000)}`)
      .join("\n");
  ctx.log(reason + "\n" + diagnostic);
  const cause =
    diagnostic
      .split("\n")
      .find((l) => /\[ERROR\]|\b(?:Error|error):/.test(l)) ?? "";
  return new BridgeError(
    "TOOL_UNAVAILABLE",
    reason + (cause ? "：" + cause.slice(0, 300) : ""),
    {
      runDirectory: run,
      logPath: isFile(logs[1]) ? logs[1] : logs[0],
      exitCode,
      diagnostic,
    },
  );
}
export async function scan(
  ctx: BridgeContext,
  params: Json,
  run: string,
): Promise<Json> {
  const root = ctx.root,
    scope = safePath(root, path.resolve(params.scopePath || root));
  let files: string[] = params.files?.length
    ? params.files.map((p: string) => fileInProject(root, p))
    : isFile(scope)
      ? /\.(ets|ts)$/i.test(scope)
        ? [scope]
        : []
      : projectFiles(scope);
  files = unique(files as string[]).filter(
    (p) =>
      !relative(p, root)
        .split("/")
        .some((part) => ["test", "ohostest"].includes(part.toLowerCase())),
  );
  if (!files.length)
    throw new BridgeError("INVALID_INPUT", "检测范围内没有生产 .ets/.ts 文件");
  const rules: string[] = params.rules?.length
    ? params.rules
    : Object.keys(RULES);
  if (rules.some((rule) => !(rule in RULES)))
    throw new BridgeError("UNSUPPORTED_RULE", "扫描规则不受支持");
  const scopeInfo = {
    scopePath: scope,
    scannedFiles: files,
    fileCount: files.length,
    rules,
  };
  ctx.emit("scan.started", scopeInfo);
  if (!inspectEnvironment(ctx.config).canDetect)
    throw new BridgeError(
      "TOOL_UNAVAILABLE",
      "检测环境不完整，请检查 Node、HomeCheck 和 ArkTS SDK",
    );
  const homecheck = path.resolve(ctx.config.homecheck!),
    sdk = path.join(ctx.config.studio!, "sdk/default"),
    output = path.join(run, "scan"),
    projectConfig = {
      ...readJson(path.join(homecheck, "config/projectConfig.json")),
      projectName: path.basename(root),
      projectPath: root + path.sep,
      repos: [`${path.basename(root)}=${root}`],
      checkFiles: files.map((p) => relative(p, root)),
      datasetDir: "",
      ohosSdkPath: path.join(sdk, "openharmony/ets"),
      hmsSdkPath: path.join(sdk, "hms/ets"),
      fix: "false",
      reportDir: output,
      logPath: path.join(output, "HomeCheck.log"),
      homecheck_log_level: "info",
      arkCheckPath: path.join(homecheck, "node_modules/homecheck"),
      npmInstallDir: homecheck,
      checkPath: path.join(run, "check-paths.json"),
    };
  writeJson(path.join(run, "check-paths.json"), {
    checkPath: files.map((filePath) => ({ filePath, fixKey: [] })),
  });
  const ruleConfig = scopeRuleIgnores(
    readJson(path.join(homecheck, "config/ruleConfig.json")),
    root,
  );
  ruleConfig.extRuleSet = [
    {
      ruleSetName: "extrulesproject",
      packagePath: path.join(homecheck, "extrulesproject-1.0.0.tgz"),
      extRules: Object.fromEntries(rules.map((rule) => [rule, 2])),
    },
  ];
  writeJson(path.join(run, "project.json"), projectConfig);
  writeJson(path.join(run, "rules.json"), ruleConfig);
  ctx.emit("workflow.changed", {
    status: `正在运行 HomeCheck：${files.length} 个文件，${rules.length} 条规则…`,
  });
  let exit: number;
  try {
    exit = await runTool(
      ctx,
      [
        ctx.config.node || process.execPath,
        ctx.scanner,
        homecheck,
        path.join(run, "project.json"),
        path.join(run, "rules.json"),
        path.join(output, "summary.json"),
      ],
      homecheck,
      path.join(run, "scan.log"),
      path.join(output, "HomeCheck.log"),
    );
  } catch (e) {
    throw scanFailure(ctx, run, "无法完成 HomeCheck 扫描：" + String(e));
  }
  if (exit !== 0)
    throw scanFailure(ctx, run, `HomeCheck 扫描失败（exit ${exit}）`, exit);
  ctx.emit("workflow.changed", { status: "正在核对执行摘要并读取检测结果…" });
  const summaryFile = path.join(output, "summary.json");
  if (!isFile(summaryFile))
    throw new BridgeError("ARTIFACT_UNAVAILABLE", "扫描器未生成本轮执行摘要");
  const summary = readJson(summaryFile);
  if (
    summary.runner !== "direct-homecheck" ||
    summary.success !== true ||
    !Array.isArray(summary.loadedRules) ||
    !Array.isArray(summary.requestedRules) ||
    summary.requestedRules.length !== rules.length ||
    rules.some(
      (rule) =>
        !summary.loadedRules.includes(rule) ||
        !summary.requestedRules.includes(rule),
    )
  )
    throw scanFailure(ctx, run, "HomeCheck 未成功执行全部选中规则");
  const detectorLog = path.join(output, "HomeCheck.log"),
    text = isFile(detectorLog) ? readText(detectorLog) : "",
    counts = [...text.matchAll(/\[CheckEntry\] File count: (\d+)/g)],
    actual = counts.length ? +counts.at(-1)![1] : null;
  if (
    /\[ERROR\].*\[HomeCheck\]/.test(text) ||
    !text.includes("[Main] Checking completed.")
  )
    throw scanFailure(ctx, run, "HomeCheck 未完成检测或规则执行出错");
  if (actual !== files.length)
    throw scanFailure(
      ctx,
      run,
      "HomeCheck 实际文件数与请求不一致，部分目标可能被忽略",
    );
  const report = path.join(output, "issuesReport.json");
  if (!isFile(report))
    throw new BridgeError(
      "ARTIFACT_UNAVAILABLE",
      "本轮未生成 issuesReport.json",
    );
  const issues = normalizeIssues(readJson(report), root).filter((i) =>
    files.includes(i.absolutePath),
  );
  return { issues, runDirectory: run, reportPath: report, ...scopeInfo };
}
export async function smellCandidateGate(
  ctx: BridgeContext,
  taskDir: string,
  source: string,
): Promise<number> {
  const output = path.join(taskDir, "smell-after.json");
  fs.rmSync(output, { force: true });
  try {
    const task = taskFromJson(readJson(path.join(taskDir, "task.json"))),
      target = safePath(source, targetPath(task)),
      files = smellScanFiles(taskDir, source, target);
    for (const related of task.target.related_targets) {
      const file = safePath(
        source,
        path.resolve(task.workspace_root, related.filePath),
      );
      if (isFile(file) && !files.includes(file)) files.push(file);
    }
    const run = path.join(taskDir, "smell-scans", crypto.randomUUID());
    fs.mkdirSync(run, { recursive: true });
    const response = await scan(
        new BridgeContext(ctx.config, source, ctx.scanner, (event) =>
          ctx.log(JSON.stringify(event) + "\n"),
        ),
        { files, scopePath: source, rules: [task.rule] },
        run,
      ),
      riskFile = path.join(taskDir, "risk-report.json"),
      risk = isFile(riskFile) ? readJson(riskFile) : {},
      text = readText(target),
      remaining: Json[] = [];
    for (const issue of response.issues) {
      if (issue.rule !== task.rule) continue;
      const file = issue.absolutePath,
        m = issue.rawMessage,
        line = m.line ?? m.rangeStart ?? 1,
        reported = reportedSymbol(m.message);
      let sameTarget =
        file === target && symbolMatches(reported, task.target.symbol);
      if (sameTarget && risk.target?.owner)
        sameTarget =
          ownerAtLine(
            text,
            line,
            path.basename(target, path.extname(target)),
          ) === risk.target.owner;
      const lines = changedCurrentLines(
        path.join(taskDir, "baseline-production", relative(file, source)),
        file,
      );
      if (
        sameTarget ||
        issueTouchesChangedSymbol(readText(file), reported, line, lines) ||
        task.rule === "@extrulesproject/code-clone-fragment-check"
      )
        remaining.push({ ...m, filePath: issue.filePath });
    }
    writeJson(output, remaining);
    writeJson(path.join(taskDir, "smell-evidence.json"), {
      sourceRoot: source,
      reportPath: response.reportPath,
      scannedFiles: response.scannedFiles,
      remaining: remaining.length,
    });
    if (remaining.length) {
      console.error(`目标或变更方法仍有异味：${remaining.length} 条`);
      return 1;
    }
    console.log("候选副本异味复检通过");
    return 0;
  } catch (e) {
    console.error("SMELL_GATE_BLOCKED: 候选副本检测未完成：" + String(e));
    return 3;
  }
}
