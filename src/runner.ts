import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Config,
  CommandResult,
  CommandSpec,
  Json,
  RefactorTask,
  Status,
} from "./models.js";
import { taskFromJson, targetPath } from "./models.js";
import {
  escapeRe,
  isDir,
  isFile,
  now,
  parents,
  readJson,
  readText,
  relative,
  round,
  within,
  writeJson,
  writeText,
  walk,
} from "./utils.js";
import { displayCommand, runCommand } from "./process.js";
import { buildRepairPrompt } from "./prompts.js";
import {
  failedHypiumCases,
  hostUnavailable,
  parseHypiumCases,
} from "./test_execution.js";
export const PLACEHOLDERS = [
  "task_dir",
  "task_file",
  "risk_file",
  "prompt_file",
  "review_prompt_file",
  "repair_prompt_file",
  "project_root",
  "workspace_root",
  "target_file",
  "backend_root",
  "harmony_root",
];
export function loadConfig(file: string): Config {
  const data = readJson(file);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("配置顶层必须为 JSON 对象");
  return data as Config;
}
export function contextFor(
  taskDir: string,
  task: RefactorTask,
): Record<string, string> {
  const backendRoot =
    parents(path.dirname(fileURLToPath(import.meta.url))).find(
      (p) => isFile(path.join(p, "package.json")) && isDir(path.join(p, "src")),
    ) ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const harmonyRoot =
    parents(path.dirname(targetPath(task)), task.project_root).find(
      (p) =>
        isFile(path.join(p, "build-profile.json5")) &&
        isFile(path.join(p, "hvigor/hvigor-config.json5")),
    ) ?? task.project_root;
  return {
    task_dir: taskDir,
    task_file: path.join(taskDir, "task.json"),
    risk_file: path.join(taskDir, "risk-report.json"),
    prompt_file: path.join(taskDir, "refactor-prompt.md"),
    review_prompt_file: path.join(taskDir, "review-prompt.md"),
    repair_prompt_file: path.join(taskDir, "repair-prompt.md"),
    project_root: task.project_root,
    workspace_root: task.workspace_root,
    target_file: targetPath(task),
    backend_root: backendRoot,
    harmony_root: harmonyRoot,
  };
}
export function render(value: string, context: Record<string, string>): string {
  for (const key of PLACEHOLDERS)
    value = value.replaceAll("{" + key + "}", context[key] ?? "");
  return value;
}
const result = (
  name: string,
  status: Status,
  fields: Partial<CommandResult> = {},
): CommandResult => ({ name, status, duration_seconds: 0, ...fields });
export function agentErrorOutput(output: string): string {
  const selected: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event: Json;
    try {
      event = JSON.parse(line);
    } catch {
      selected.push(line);
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (
      String(event.type ?? "")
        .toLowerCase()
        .endsWith("error") ||
      event.error
    )
      selected.push(JSON.stringify(event));
    else if (event.part && typeof event.part === "object") {
      const p = event.part;
      if (
        String(p.type ?? "")
          .toLowerCase()
          .endsWith("error") ||
        p.error
      )
        selected.push(JSON.stringify(p));
      else if (p.state?.status === "error")
        selected.push(String(p.state.error ?? p.state.output ?? "tool error"));
    }
  }
  return selected.join("\n");
}
export async function runSpec(
  name: string,
  spec: CommandSpec,
  context: Record<string, string>,
  defaultCwd: string,
  taskDir: string,
  dry = false,
  signal?: AbortSignal,
  taskDeadline?: number,
): Promise<CommandResult> {
  if (!spec.command) return result(name, "SKIPPED", { reason: "缺少 command" });
  const command = Array.isArray(spec.command)
      ? spec.command.map((s) => render(String(s), context))
      : render(spec.command, context),
    display = displayCommand(command),
    cwd = render(spec.cwd ?? defaultCwd, context);
  if (dry)
    return result(name, "DRY_RUN", { command: display, reason: "cwd=" + cwd });
  if (!isDir(cwd))
    return result(name, "BLOCKED", {
      command: display,
      reason: "工作目录不存在：" + cwd,
    });
  if (taskDeadline !== undefined && now() >= taskDeadline)
    return result(name, "BLOCKED", {
      command: display,
      reason: "单条异味总执行时间超过限制",
    });
  const started = now(),
    timeout = spec.timeoutSeconds ?? 1800,
    seconds = Math.min(
      timeout,
      taskDeadline === undefined ? Infinity : taskDeadline - started,
    );
  const run = await runCommand(command, {
    cwd,
    signal,
    timeoutSeconds: seconds,
  });
  const log = path.join(taskDir, name + ".log");
  writeText(
    log,
    run.output +
      (run.timedOut
        ? "\nTIMEOUT"
        : run.cancelled
          ? "\nCANCELLED_BY_FAIL_FAST"
          : ""),
  );
  const fields = {
    command: display,
    duration_seconds: round(now() - started),
    output_file: log,
  };
  if (run.cancelled && !run.timedOut)
    return result(name, "SKIPPED", {
      ...fields,
      reason: "同组门禁未通过，已由 fail-fast 终止",
    });
  if (run.timedOut)
    return result(name, "BLOCKED", {
      ...fields,
      reason:
        taskDeadline !== undefined && now() >= taskDeadline
          ? "单条异味总执行时间超过限制"
          : `步骤执行时间超过 ${timeout} 秒`,
    });
  if (run.error)
    return result(name, "BLOCKED", { ...fields, reason: run.error });
  let passed = run.code === 0;
  if (spec.successOutputRegex)
    passed ||= new RegExp(spec.successOutputRegex, "i").test(run.output);
  const blockers =
      spec.blockedOutputScope === "agent-errors"
        ? agentErrorOutput(run.output)
        : run.output,
    blocked =
      !passed && spec.blockedOutputRegex
        ? new RegExp(spec.blockedOutputRegex, "i").exec(blockers)
        : null;
  return result(name, passed ? "PASS" : blocked ? "BLOCKED" : "FAIL", {
    ...fields,
    exit_code: run.code,
    reason: blocked ? `环境或工具链阻塞（匹配：${blocked[0]}）` : null,
  });
}
export function extractReviewJson(log: string, output?: string): Json | null {
  const candidates: Json[] = [];
  const seen = new Set<string>();
  const collect = (value: unknown, depth = 0) => {
    if (depth > 12) return;
    if (value && typeof value === "object") {
      if (!Array.isArray(value) && "verdict" in value)
        candidates.push(value as Json);
      for (const nested of Object.values(value)) collect(nested, depth + 1);
    } else if (
      typeof value === "string" &&
      value.includes("verdict") &&
      !seen.has(value)
    ) {
      seen.add(value);
      scan(value, depth + 1);
    }
  };
  const scan = (text: string, depth = 0) => {
    for (let start = 0; start < text.length; start++) {
      if (text[start] !== "{") continue;
      let level = 0,
        quote = false,
        escaped = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (quote) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') quote = false;
        } else if (c === '"') quote = true;
        else if (c === "{") level++;
        else if (c === "}" && --level === 0) {
          try {
            collect(JSON.parse(text.slice(start, i + 1)), depth);
          } catch {}
          start = i;
          break;
        }
      }
    }
  };
  scan(readText(log));
  const candidate = candidates.at(-1) ?? null;
  if (output) {
    if (candidate) writeJson(output, candidate);
    else fs.rmSync(output, { force: true });
  }
  return candidate;
}
export function mentionsChanged(log: string, changes: string[]): boolean {
  const normalized = log.toLowerCase().replaceAll("\\", "/");
  return changes.some(
    (f) =>
      normalized.includes(f.toLowerCase().replaceAll("\\", "/")) ||
      normalized.includes(path.basename(f).toLowerCase()) ||
      new RegExp(
        `(?<![\\w$])${escapeRe(path.basename(f, path.extname(f)))}(?![\\w$])`,
        "i",
      ).test(log),
  );
}
export function currentTestFailures(taskDir: string): Json[] | null {
  const manifest = path.join(taskDir, "test-results.json");
  if (!isFile(manifest)) return null;
  const current = readJson(manifest),
    plan = path.resolve(current.plan ?? "");
  if (!within(plan, path.join(taskDir, "test-attempts"))) return [];
  return (current.jobs ?? [])
    .filter((j: Json) => ["FAIL", "BLOCKED"].includes(j.status))
    .map((j: Json) => ({
      ...j,
      evidenceFiles: Object.fromEntries(
        Object.entries({ log: j.log, ...j.artifacts }).filter(
          ([, f]) =>
            typeof f === "string" && within(f, path.dirname(plan)) && isFile(f),
        ),
      ),
    }));
}
export function buildFailureReport(
  taskDir: string,
  task: RefactorTask,
  failed: CommandResult,
  attempt: number,
): Json {
  const stage = failed.name.replace(/-retry-\d+$/, "").split("-repair-")[0],
    suffix = failed.name.replace(/^review-agent/, ""),
    reviewFile = path.join(taskDir, `review${suffix}.json`),
    review =
      stage === "review-agent" && isFile(reviewFile)
        ? readJson(reviewFile)
        : {},
    cp = path.join(taskDir, "refactor-changes.json"),
    changes: string[] = isFile(cp)
      ? (readJson(cp).changedProductionFiles ?? [])
      : [];
  let issues: Json[] = review.issues ?? [],
    log =
      failed.output_file && isFile(failed.output_file)
        ? readText(failed.output_file).slice(-12000)
        : "";
  if (stage === "smell" && isFile(path.join(taskDir, "smell-after.json")))
    issues = (
      readJson(path.join(taskDir, "smell-after.json")) as unknown as Json[]
    ).map((i) => {
      const normalized = (i.filePath ?? "").replaceAll("\\", "/"),
        r = [...changes]
          .sort((a, b) => b.length - a.length)
          .find((p) => normalized === p || normalized.endsWith("/" + p));
      return {
        category: "remaining-smell",
        filePath: r ?? i.filePath ?? task.target.file_path,
        line: i.line,
        reason: i.message ?? "目标异味仍存在",
      };
    });
  if (stage === "linter" && isFile(path.join(taskDir, "linter-after.json")))
    issues = (
      readJson(path.join(taskDir, "linter-after.json")) as unknown as Json[]
    ).map((i) => ({
      ...i,
      category: "introduced-linter-defect",
      reason: i.message,
    }));
  if (
    stage === "runtime" &&
    isFile(path.join(taskDir, "runtime-smoke-results.json"))
  ) {
    const current = readJson(
      path.join(taskDir, "runtime-smoke-results.json"),
    ).current;
    if (current?.log && isFile(current.log))
      log = readText(current.log).slice(-12000);
  }
  if (
    stage === "contract" &&
    isFile(path.join(taskDir, "public-contract-results.json"))
  )
    log = JSON.stringify(
      readJson(path.join(taskDir, "public-contract-results.json")),
      null,
      2,
    );
  let attributable = mentionsChanged(log, changes),
    unavailable = false,
    hasCaseEvidence = false;
  if (stage === "test") {
    const jobs = currentTestFailures(taskDir);
    if (jobs !== null) {
      const cases: Json[] = [];
      for (const job of jobs)
        if (job.evidenceFiles["test_result.txt"])
          for (const c of failedHypiumCases(
            parseHypiumCases(job.evidenceFiles["test_result.txt"]),
          ))
            cases.push({
              ...c,
              targeted:
                job.selectionReason === "target-named-suite" &&
                (job.expectedSuites ?? []).includes(c.suite),
            });
      if (cases.length) {
        hasCaseEvidence = true;
        const formatted = (c: Json) =>
          `class=${c.suite}\ntest=${c.name}\n${c.details}\nresult=${c.result}`;
        log = cases.map(formatted).join("\n\n");
        attributable = cases.every(
          (c) =>
            c.targeted ||
            mentionsChanged(formatted(c), changes) ||
            changes.some((f) =>
              new RegExp(
                `^class=${escapeRe(path.basename(f, path.extname(f)))}(?:Instrument)?Test\\s*$`,
                "im",
              ).test(formatted(c)),
            ) ||
            (task.target.symbol &&
              formatted(c)
                .toLowerCase()
                .includes(task.target.symbol.toLowerCase())),
        );
        unavailable =
          attributable && cases.every((c) => hostUnavailable(c.details));
      } else {
        log = jobs
          .filter((j) => j.evidenceFiles.log)
          .map((j) => readText(j.evidenceFiles.log))
          .join("\n\n");
        attributable = mentionsChanged(log, changes);
      }
    }
  }
  const repairable =
    ["smell", "contract", "runtime", "linter", "review-agent"].includes(
      stage,
    ) ||
    (stage === "test" && hasCaseEvidence
      ? attributable && !unavailable
      : ["build", "test"].includes(stage) &&
        !unavailable &&
        (attributable ||
          (!!task.target.symbol &&
            log.toLowerCase().includes(task.target.symbol.toLowerCase()))));
  const classes: Record<string, string> = {
    smell: "SMELL_REMAINS_OR_MOVED",
    build: repairable
      ? "INTRODUCED_BUILD_FAILURE"
      : "UNATTRIBUTED_BUILD_FAILURE",
    test: unavailable
      ? "TEST_HOST_UNAVAILABLE"
      : repairable
        ? "RELATED_TEST_FAILURE"
        : "UNATTRIBUTED_TEST_FAILURE",
    linter: "INTRODUCED_LINTER_FAILURE",
    runtime: "INTRODUCED_RUNTIME_INITIALIZATION_FAILURE",
    contract: "PUBLIC_CONTRACT_BREAK",
    "review-agent": "SEMANTIC_REVIEW_FAILURE",
  };
  return {
    schemaVersion: "1.0",
    attempt,
    stage,
    classification: classes[stage] ?? "UNSUPPORTED_FAILURE",
    repairable,
    summary: unavailable
      ? "目标测试在 beforeAll 找不到测试宿主，未执行生产断言，不能归因于本次修改"
      : (review.summary ?? failed.reason ?? `${stage} 未通过`),
    changedProductionFiles: changes,
    issues,
    logTail: log,
  };
}
export function buildAgentFailureReport(
  taskDir: string,
  failed: CommandResult,
  attempt: number,
): Json {
  const files = fs
      .readdirSync(taskDir)
      .map((name) => path.join(taskDir, name))
      .filter(
        (p) =>
          path.dirname(p) === taskDir &&
          /^agent-change-attempt-.*\.json$/.test(path.basename(p)),
      )
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs),
    changes = files.length ? readJson(files[0]) : {},
    rejected = changes.rejectedFiles ?? [],
    log =
      failed.output_file && isFile(failed.output_file)
        ? readText(failed.output_file).slice(-12000)
        : "",
    noChange =
      log.includes("未产生允许的生产代码修改") || failed.exit_code === 5;
  const classification = rejected.length
      ? "MODIFICATION_BOUNDARY_VIOLATION"
      : noChange
        ? "NO_ALLOWED_PRODUCTION_CHANGE"
        : "AGENT_EXECUTION_FAILURE",
    summary = rejected.length
      ? "Agent 修改未授权文件；下一轮在授权范围内重新设计"
      : noChange
        ? "Agent 未完成可同步的生产变更"
        : (failed.reason ?? "Agent 执行失败，未形成可验证生产变更");
  return {
    schemaVersion: "1.0",
    attempt,
    stage: "repair-agent",
    classification,
    repairable: !!rejected.length || noChange,
    summary,
    candidateProductionFiles: changes.candidateProductionFiles ?? [],
    candidateProductionResources: changes.candidateProductionResources ?? [],
    rejectedFiles: rejected,
    issues: rejected.length
      ? rejected.map((p: string) => ({
          category: "unauthorized-file-change",
          filePath: p,
          reason: "不属于允许回写的生产源码、入口或资源",
        }))
      : [
          {
            category: noChange ? "no-change" : "agent-execution",
            reason: summary,
          },
        ],
    logTail: log,
  };
}
type Progress = (name: string, status: string) => void;
export async function runGates(
  taskDir: string,
  task: RefactorTask,
  config: Config,
  context: Record<string, string>,
  dry: boolean,
  progress?: Progress,
  suffix = "",
  deadline?: number,
): Promise<CommandResult[]> {
  const gates = config.gates ?? {},
    ordered = [
      "smell",
      "build",
      ...("contract" in gates ? ["contract"] : []),
      ...("runtime" in gates ? ["runtime"] : []),
      "test",
      "linter",
    ],
    parallel = [
      "smell",
      "build",
      ...("contract" in gates ? ["contract"] : []),
      "linter",
    ],
    controller = new AbortController(),
    byName: Record<string, CommandResult> = {};
  await Promise.all(
    parallel.map(async (name) => {
      if (name === "linter" && config.linterMode === "skip") {
        byName[name] = result(name + suffix, "SKIPPED", { reason: "按 linterMode=skip 跳过，不参与验收或返修" });
        return;
      }
      const spec = gates[name];
      if (!spec || spec.enabled === false) {
        byName[name] = result(name + suffix, "SKIPPED", {
          reason: "未配置或已禁用",
        });
        return;
      }
      progress?.(name, "开始");
      const current = await runSpec(
        name + suffix,
        spec,
        context,
        task.project_root,
        taskDir,
        dry,
        controller.signal,
        deadline,
      );
      byName[name] = current;
      progress?.(name, current.status);
      if (!dry && ["FAIL", "BLOCKED"].includes(current.status))
        controller.abort();
    }),
  );
  let stopped = parallel.find((n) =>
    ["FAIL", "BLOCKED"].includes(byName[n].status),
  );
  for (const name of ["runtime", "test"].filter((n) => ordered.includes(n))) {
    const spec = gates[name];
    if (stopped) {
      byName[name] = result(name + suffix, "SKIPPED", {
        reason: `${stopped} 未通过，fail-fast 跳过`,
      });
      continue;
    }
    if (!spec || spec.enabled === false) {
      byName[name] = result(name + suffix, "SKIPPED", {
        reason: "未配置或已禁用",
      });
      continue;
    }
    progress?.(name, "开始");
    const current = await runSpec(
      name + suffix,
      spec,
      context,
      task.project_root,
      taskDir,
      dry,
      undefined,
      deadline,
    );
    byName[name] = current;
    progress?.(name, current.status);
    if (!dry && current.status !== "PASS") stopped = name;
  }
  return ordered.map((n) => byName[n]);
}
export function finalResult(
  taskId: string,
  steps: CommandResult[],
  dry = false,
  terminal = steps,
): Json {
  const statuses = terminal.map((s) => s.status),
    verdict = dry
      ? "DRY_RUN"
      : statuses.includes("FAIL")
        ? "FAIL"
        : statuses.includes("BLOCKED")
          ? "BLOCKED"
          : statuses.length > 0 && statuses.every((s) => s === "PASS")
            ? "PASS"
            : "INCOMPLETE";
  return { schemaVersion: "1.0", taskId, verdict, steps };
}
export async function executePipeline(
  taskDir: string,
  config: Config,
  dry = false,
  progress?: Progress,
  taskStartedAt?: number,
): Promise<Json> {
  taskDir = path.resolve(taskDir);
  const mode = config.linterMode ?? "required";
  if (!["required", "skip"].includes(mode)) throw new Error("linterMode 必须为 required 或 skip");
  const started = taskStartedAt ?? now(),
    timeout = config.taskTimeoutSeconds ?? 1200,
    deadline = dry || timeout <= 0 ? undefined : started + timeout,
    policy = { linterMode: mode },
    task = taskFromJson(readJson(path.join(taskDir, "task.json"))),
    context = contextFor(taskDir, task),
    results: CommandResult[] = [],
    attempts: Json[] = [];
  const finish = (
    terminal: CommandResult[],
    repairs: number,
    retries: number,
  ) => {
    const filtered = terminal.filter(i => !(mode === "skip" && i.name.split("-repair-")[0] === "linter" && i.status === "SKIPPED"));
    const output = {
        ...finalResult(task.task_id, results, dry, filtered),
        validationPolicy: policy,
        repairAttempts: repairs,
        reviewRetries: retries,
        attempts,
        durationSeconds: round(now() - started),
        timeoutSeconds: timeout,
        timedOut: results.some(
          (s) =>
            s.status === "BLOCKED" && s.reason?.includes("总执行时间超过限制"),
        ),
      };
    writeJson(path.join(taskDir, "result.json"), output);
    return output;
  };
  const saveFailure = (failure: Json, index: number | string) => {
    writeJson(path.join(taskDir, "failure-report.json"), failure);
    writeJson(path.join(taskDir, `failure-report-${index}.json`), failure);
  };
  if (config.refactorAgent) {
    progress?.("重构 Agent", "开始");
    const current = await runSpec(
      "refactor-agent",
      config.refactorAgent,
      context,
      task.project_root,
      taskDir,
      dry,
      undefined,
      deadline,
    );
    results.push(current);
    progress?.("重构 Agent", current.status);
    if (!dry && current.status !== "PASS") {
      saveFailure(buildAgentFailureReport(taskDir, current, 0), "agent");
      const skipped = [
        "smell",
        "build",
        ...("contract" in (config.gates ?? {}) ? ["contract"] : []),
        ...("runtime" in (config.gates ?? {}) ? ["runtime"] : []),
        "test",
        "linter",
      ].map((n) =>
        result(n, "SKIPPED", { reason: "重构 Agent 未成功，无可验证结果" }),
      );
      writeJson(path.join(taskDir, "gates.json"), {
        schemaVersion: "1.0",
        taskId: task.task_id,
        validationPolicy: policy,
        gates: skipped,
      });
      results.push(
        ...skipped,
        result("review-agent", "SKIPPED", { reason: "重构 Agent 未成功" }),
      );
      return finish(results, 0, 0);
    }
  } else
    results.push(
      result("refactor-agent", "SKIPPED", {
        reason: "config 未配置 refactorAgent",
      }),
    );
  let repairs = 0,
    retries = 0,
    terminal: CommandResult[] = [];
  const maxRepairs = Math.max(0, Math.trunc(config.maxRepairAttempts ?? 3));
  while (true) {
    const suffix = repairs ? "-repair-" + repairs : "",
      gates = await runGates(
        taskDir,
        task,
        config,
        context,
        dry,
        progress,
        suffix,
        deadline,
      );
    results.push(...gates);
    writeJson(path.join(taskDir, "gates.json"), {
      schemaVersion: "1.0",
      taskId: task.task_id,
      validationPolicy: policy,
      attempt: repairs,
      gates,
    });
    const gatesPass = gates.filter(s => !(mode === "skip" && s.name === "linter" + suffix)).every(
        (s) => s.status === "PASS" || (dry && s.status === "DRY_RUN"),
      );
    let reviewResult: CommandResult;
    if (gatesPass && config.reviewAgent) {
      const spec = config.reviewAgent,
        maxRetries = dry ? 0 : Math.max(0, spec.maxEnvironmentRetries ?? 0);
      progress?.("评审 Agent", "开始");
      let retrySuffix = "";
      for (let n = 0; ; n++) {
        retrySuffix = n ? "-retry-" + n : "";
        if (n) {
          retries++;
          progress?.(`评审 Agent 环境重试第${n}次`, "开始");
          const remaining =
            deadline === undefined ? Infinity : deadline - now();
          await new Promise((r) =>
            setTimeout(
              r,
              Math.min(
                60,
                spec.retryDelaySeconds ?? 2,
                Math.max(0, remaining),
              ) * 1000,
            ),
          );
        }
        reviewResult = await runSpec(
          "review-agent" + suffix + retrySuffix,
          spec,
          context,
          taskDir,
          taskDir,
          dry,
          undefined,
          deadline,
        );
        if (
          reviewResult.status !== "BLOCKED" ||
          reviewResult.exit_code == null ||
          n >= maxRetries
        )
          break;
        results.push(reviewResult);
      }
      if (!dry && reviewResult!.status === "PASS") {
        const data = extractReviewJson(
            reviewResult!.output_file!,
            path.join(taskDir, `review${suffix}${retrySuffix}.json`),
          ),
          verdict = String(data?.verdict ?? "UNCERTAIN").toUpperCase();
        reviewResult!.status = ["PASS", "FAIL"].includes(verdict)
          ? (verdict as Status)
          : "BLOCKED";
        if (reviewResult!.status === "BLOCKED")
          reviewResult!.reason = "评审输出为 UNCERTAIN 或缺少有效 verdict JSON";
      }
      progress?.("评审 Agent", reviewResult!.status);
    } else
      reviewResult = result("review-agent" + suffix, "SKIPPED", {
        reason: gatesPass
          ? "config 未配置 reviewAgent"
          : "本次必需门禁未全部通过，Review 不执行",
      });
    results.push(reviewResult!);
    terminal = [...gates, reviewResult!];
    attempts.push({ attempt: repairs, steps: terminal });
    const failed =
      terminal.find((s) => s.status === "BLOCKED") ??
      terminal.find((s) => s.status === "FAIL");
    if (
      dry ||
      !failed ||
      failed.status === "BLOCKED" ||
      repairs >= maxRepairs ||
      !config.repairAgent
    )
      break;
    let failure = buildFailureReport(taskDir, task, failed, repairs + 1);
    saveFailure(failure, repairs + 1);
    if (!failure.repairable) break;
    let repaired = false;
    while (failure.repairable && repairs < maxRepairs) {
      repairs++;
      const prompt = path.join(taskDir, `repair-prompt-${repairs}.md`);
      writeText(
        prompt,
        buildRepairPrompt(
          task,
          readJson(path.join(taskDir, "risk-report.json")),
          failure,
          repairs,
          mode,
        ),
      );
      context.repair_prompt_file = prompt;
      progress?.(`修复 Agent 第${repairs}轮`, "开始");
      const current = await runSpec(
        "repair-agent-" + repairs,
        config.repairAgent,
        context,
        task.project_root,
        taskDir,
        false,
        undefined,
        deadline,
      );
      results.push(current);
      progress?.(`修复 Agent 第${repairs}轮`, current.status);
      if (current.status === "PASS") {
        repaired = true;
        break;
      }
      terminal = [current];
      attempts.push({ attempt: repairs, steps: terminal });
      failure = buildAgentFailureReport(taskDir, current, repairs + 1);
      saveFailure(failure, repairs + 1);
      if (current.status === "BLOCKED" || !failure.repairable) break;
    }
    if (!repaired) break;
  }
  return finish(terminal, repairs, retries);
}
