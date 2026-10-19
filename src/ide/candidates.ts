import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Json, Config, RefactorTask, CommandResult } from "../models.js";
import { taskFromJson } from "../models.js";
import { loadDatasetTasks } from "../dataset.js";
import { autoConfig, findHarmonyRoot, prepareTask } from "../automatic.js";
import {
  contextFor,
  executePipeline,
  finalResult,
  runGates,
} from "../runner.js";
import { prepareReviewMaterials } from "../workspace.js";
import {
  copyFile,
  hash,
  isDir,
  isFile,
  now,
  readJson,
  readText,
  relative,
  round,
  writeJson,
  writeText,
} from "../utils.js";
import {
  BridgeContext,
  BridgeError,
  RULES,
  allowedProduction,
  configurationDigest,
  copyProject,
  discoverTools,
  inspectEnvironment,
  loadRun,
  safePath,
  same,
  snapshot,
} from "./common.js";

export function prepareCandidate(
  ctx: BridgeContext,
  params: Json,
  run: string,
): Json {
  const issue = params.issue;
  if (!issue || !(issue.rule in RULES))
    throw new BridgeError("UNSUPPORTED_RULE", "插件仅开放四条已联调规则");
  const target = safePath(ctx.root, issue.absolutePath);
  if (!isFile(target) || hash(target) !== issue.sourceSha256)
    throw new BridgeError(
      "BASELINE_CHANGED",
      "检测后目标代码已变化，请重新检测",
    );
  const original = findHarmonyRoot(target, ctx.root);
  if (!original)
    throw new BridgeError("INVALID_INPUT", "目标不属于可构建的 Harmony 工程");
  if (!allowedProduction(relative(target, original)))
    throw new BridgeError("INVALID_INPUT", "目标不属于允许重构的生产源码");
  const related = issue.relatedTargets ?? [];
  for (const r of related) {
    const p = safePath(original, r.filePath);
    if (
      !isFile(p) ||
      !allowedProduction(relative(p, original)) ||
      findHarmonyRoot(p, ctx.root) !== original
    )
      throw new BridgeError(
        "INVALID_INPUT",
        "关联片段必须属于同一 Harmony 工程",
      );
    if (hash(p) !== r.sourceSha256)
      throw new BridgeError("BASELINE_CHANGED", "检测后关联片段已变化");
  }
  const instructions = String(params.instructions ?? "");
  if (instructions.length > 8000)
    throw new BridgeError("INVALID_INPUT", "业务说明最多 8000 字符");
  const baseline = snapshot(original);
  ctx.emit("workflow.changed", { status: "冻结工程基线并分析风险…" });
  const saved = path.join(run, "baseline");
  copyProject(original, saved);
  if (!same(snapshot(saved), baseline) || !same(snapshot(original), baseline))
    throw new BridgeError("BASELINE_CHANGED", "创建快照期间工程已变化");
  const stage = path.join(run, "staging", path.basename(original));
  copyProject(saved, stage);
  const targetRelative = relative(target, original),
    message = { ...issue.rawMessage };
  for (const r of related) {
    const replacement = `${path.basename(original)}/${relative(r.filePath, original)}`;
    for (const old of [
      r.reportedPath,
      r.filePath,
      String(r.reportedPath ?? "").replaceAll("/", "\\"),
    ].filter(Boolean))
      message.message = message.message.replaceAll(old, replacement);
  }
  message.message = message.message
    .replaceAll(original, stage)
    .replaceAll(original.replaceAll("\\", "/"), stage.replaceAll("\\", "/"));
  writeJson(path.join(run, "input.json"), [
    {
      filePath: `${path.basename(original)}/${targetRelative}`,
      sourceProject: path.basename(original),
      commitHash: issue.commitHash ?? "",
      messages: [message],
    },
  ]);
  const task = loadDatasetTasks(
    path.join(run, "input.json"),
    path.dirname(stage),
  )[0];
  task.target.related_targets = related.map((r: Json) => ({
    filePath: `${path.basename(original)}/${relative(r.filePath, original)}`,
    range: { startLine: r.startLine, endLine: r.endLine },
  }));
  const taskDir = path.join(run, "backend"),
    { risk } = prepareTask(task, taskDir, ctx.config.linterMode ?? "required");
  if (instructions.trim())
    fs.appendFileSync(
      path.join(taskDir, "refactor-prompt.md"),
      "\n\n用户业务说明（不得改变平台约束和门禁）：\n" + instructions,
      "utf8",
    );
  const prepared = {
    taskHandle: path.basename(run),
    taskId: task.task_id,
    originalRoot: original,
    targetRelativePath: targetRelative,
    issue,
    baselineFiles: baseline,
    configDigest: configurationDigest(ctx),
    risk,
    runDirectory: run,
    instructions,
  };
  writeJson(path.join(run, "prepared.json"), prepared);
  return prepared;
}
export function pipelineConfig(ctx: BridgeContext, taskDir: string): Config {
  const task = taskFromJson(readJson(path.join(taskDir, "task.json"))),
    config = autoConfig(
      task,
      taskDir,
      discoverTools(ctx.config),
      readJson(path.join(taskDir, "runtime-smoke-plan.json")),
      readJson(path.join(taskDir, "public-contract-plan.json")),
      ctx.config.linterMode ?? "required",
    ),
    settings = path.join(taskDir, "bridge-settings.json");
  writeJson(settings, ctx.config);
  // All candidate/apply checks use the plugin's direct HomeCheck entry rather than the benchmark/CLOC script.
  if (ctx.config.homecheck)
    config.gates!.smell.command = [
      process.execPath,
      fileURLToPath(new URL("../ide_bridge.js", import.meta.url)),
      "--gate",
      "smell",
      "--task-dir",
      taskDir,
      "--settings",
      settings,
      "--source-root",
      task.project_root,
      "--scanner",
      ctx.scanner,
    ];
  return config;
}
export async function runPipelineLogged(
  ctx: BridgeContext,
  taskDir: string,
  config: Config,
): Promise<Json> {
  const logged = new Map<string, number>();
  const flushLogs = () => {
    for (const file of fs
      .readdirSync(taskDir)
      .filter((n) => n.endsWith(".log"))) {
      const p = path.join(taskDir, file),
        text = readText(p),
        offset = logged.get(p) ?? 0;
      if (text.length > offset) ctx.log(`\n[${file}]\n` + text.slice(offset));
      logged.set(p, text.length);
    }
  };
  const result = await executePipeline(
    taskDir,
    config,
    false,
    (name, status) => {
      ctx.emit("step.updated", { stepId: name, status });
      ctx.emit("workflow.changed", { status: `${name}: ${status}` });
      // Completed step logs can be delivered without reading the original project or leaking stdout into JSONL.
      flushLogs();
    },
  );
  flushLogs();
  return result;
}
export function summarizeFailure(taskDir: string, result: Json): void {
  for (const step of result.steps ?? []) {
    if (!["FAIL", "BLOCKED", "INCOMPLETE"].includes(step.status)) continue;
    let reason = step.reason ?? "";
    if (
      step.name.startsWith("smell") &&
      step.status === "FAIL" &&
      isFile(path.join(taskDir, "smell-after.json"))
    ) {
      const issues = readJson(path.join(taskDir, "smell-after.json"));
      if (issues.length)
        reason =
          `候选仍有 ${issues.length} 条目标或变更异味：` +
          String(issues[0].message).slice(0, 350);
    }
    if (step.output_file) {
      const p = safePath(taskDir, step.output_file);
      if (isFile(p)) {
        const text = readText(p).slice(-12000);
        if (text.includes("SMELL_GATE_BLOCKED:"))
          reason = text
            .split("SMELL_GATE_BLOCKED:")
            .at(-1)!
            .split("\n")[0]
            .slice(0, 500);
        if (!reason)
          reason =
            /(?:^|\n)\s*(?:error:|Error:)\s*(.+)/
              .exec(text)?.[1]
              ?.slice(0, 500) ??
            `进程退出码 ${step.exit_code}；请查看 ${path.basename(p)}`;
        step.logPath = p;
      }
    }
    if (reason) {
      step.reason = reason;
      if (result.verdict !== "PASS")
        result.failureReason = `${step.name}：${reason}`;
    }
  }
}
function copyArtifacts(
  source: string,
  destination: string,
  oldStage: string,
  newStage: string,
): void {
  fs.mkdirSync(destination, { recursive: true });
  const names = [
    "task.json",
    "risk-report.json",
    "review-risk.json",
    "refactor-prompt.md",
    "review-prompt.md",
    "public-contract-before.json",
    "public-contract-plan.json",
    "runtime-smoke-plan.json",
  ];
  for (const name of names) {
    const p = path.join(source, name);
    if (!isFile(p)) continue;
    const text = readText(p)
      .replaceAll(
        JSON.stringify(oldStage).slice(1, -1),
        JSON.stringify(newStage).slice(1, -1),
      )
      .replaceAll(oldStage, newStage)
      .replaceAll(
        oldStage.replaceAll("\\", "/"),
        newStage.replaceAll("\\", "/"),
      );
    writeText(path.join(destination, name), text);
  }
  for (const dir of ["baseline-production", "runtime-smoke-baseline"])
    if (isDir(path.join(source, dir)))
      copyProject(path.join(source, dir), path.join(destination, dir));
}
export function freezeCandidate(
  ctx: BridgeContext,
  run: string,
  stage: string,
  original: string,
  preparedRun: string,
  prepared: Json,
  result: Json,
  digest: string,
): Json {
  if (configurationDigest(ctx) !== digest)
    throw new BridgeError(
      "BASELINE_CHANGED",
      "验证期间工具或配置变化，请重新验证",
    );
  const taskDir = path.join(run, "backend");
  summarizeFailure(taskDir, result);
  const before = prepared.baselineFiles,
    after = snapshot(stage),
    deleted = Object.keys(before).filter((p) => !(p in after)),
    changed = Object.keys(after).filter((p) => before[p] !== after[p]);
  if (deleted.length || changed.some((p) => !allowedProduction(p)))
    throw new BridgeError(
      "INVALID_INPUT",
      "候选包含删除、重命名或非生产修改，整项拒绝应用",
    );
  if (!same(snapshot(original), before))
    throw new BridgeError("BASELINE_CHANGED", "原工程已变化，候选失效");
  const changes = changed.map((name) => {
    const dest = path.join(run, "content/after", name);
    copyFile(path.join(stage, name), dest);
    if (name in before)
      copyFile(
        path.join(preparedRun, "baseline", name),
        path.join(run, "content/before", name),
      );
    return {
      relativePath: name,
      kind: ("/" + name).includes("/src/main/resources/")
        ? "resource"
        : "source",
      changeType: name in before ? "modified" : "added",
      beforeSha256: before[name] ?? null,
      afterSha256: after[name],
      size: fs.statSync(dest).size,
    };
  });
  if (!changes.length && result.verdict === "PASS") {
    result.verdict = "FAIL";
    result.reason = result.failureReason = "候选没有最终生产修改";
  }
  writeJson(path.join(taskDir, "result.json"), result);
  const manifest = {
    candidateId: path.basename(run),
    taskHandle: path.basename(preparedRun),
    taskId: prepared.taskId,
    originalRoot: original,
    baselineFiles: before,
    afterFiles: after,
    configDigest: digest,
    changes,
    verdict: result.verdict,
    runDirectory: run,
    result,
  };
  writeJson(path.join(run, "candidate.json"), manifest);
  return { candidate: manifest, result, runDirectory: run };
}
type PipelineRunner = (
  ctx: BridgeContext,
  taskDir: string,
  config: Config,
) => Promise<Json>;
export async function executeCandidate(
  ctx: BridgeContext,
  params: Json,
  run: string,
  runner: PipelineRunner = runPipelineLogged,
): Promise<Json> {
  const [preparedRun, prepared] = loadRun(
      ctx,
      params.taskHandle,
      "prepared.json",
    ),
    original = prepared.originalRoot;
  if (
    !same(snapshot(original), prepared.baselineFiles) ||
    configurationDigest(ctx) !== prepared.configDigest
  )
    throw new BridgeError(
      "BASELINE_CHANGED",
      "准备后工程或工具配置变化，请重新分析",
    );
  if (!inspectEnvironment(ctx.config).canRefactor)
    throw new BridgeError("TOOL_UNAVAILABLE", "重构环境不完整，请先检查环境");
  if (
    !same(snapshot(path.join(preparedRun, "baseline")), prepared.baselineFiles)
  )
    throw new BridgeError("CANDIDATE_CHANGED", "冻结工程基线已变化");
  const stage = path.join(run, "staging", path.basename(original));
  copyProject(path.join(preparedRun, "baseline"), stage);
  const taskDir = path.join(run, "backend");
  copyArtifacts(
    path.join(preparedRun, "backend"),
    taskDir,
    path.join(preparedRun, "staging"),
    path.dirname(stage),
  );
  const result = await runner(ctx, taskDir, pipelineConfig(ctx, taskDir));
  return freezeCandidate(
    ctx,
    run,
    stage,
    original,
    preparedRun,
    prepared,
    result,
    prepared.configDigest,
  );
}
export function loadCandidateForValidation(
  ctx: BridgeContext,
  id: string,
): [string, Json, string, Json] {
  const [run, candidate] = loadRun(ctx, id, "candidate.json"),
    original = candidate.originalRoot;
  if (!same(snapshot(original), candidate.baselineFiles))
    throw new BridgeError(
      "BASELINE_CHANGED",
      "原工程已变化或候选已应用，请重新检测",
    );
  const [preparedRun, prepared] = loadRun(
    ctx,
    candidate.taskHandle,
    "prepared.json",
  );
  if (
    prepared.originalRoot !== original ||
    !same(prepared.baselineFiles, candidate.baselineFiles) ||
    !same(snapshot(path.join(preparedRun, "baseline")), candidate.baselineFiles)
  )
    throw new BridgeError("CANDIDATE_CHANGED", "冻结基线已变化");
  if (!candidate.changes?.length)
    throw new BridgeError("INVALID_INPUT", "此记录没有生产代码候选变更");
  const names = new Set<string>();
  for (const item of candidate.changes) {
    const name = item.relativePath;
    if (
      typeof name !== "string" ||
      !allowedProduction(name) ||
      names.has(name.toLowerCase())
    )
      throw new BridgeError("CANDIDATE_CHANGED", "候选文件路径不合法");
    names.add(name.toLowerCase());
    for (const phase of ["before", "after"]) {
      const expected = item[phase + "Sha256"] ?? null,
        manifest =
          candidate[phase === "before" ? "baselineFiles" : "afterFiles"];
      if (expected !== (manifest[name] ?? null))
        throw new BridgeError("CANDIDATE_CHANGED", "候选哈希与清单不一致");
      if (expected !== null) {
        const file = safePath(run, path.join(run, "content", phase, name));
        if (!isFile(file) || hash(file) !== expected)
          throw new BridgeError("CANDIDATE_CHANGED", "冻结候选内容已变化");
      }
    }
  }
  const deleted = Object.keys(candidate.baselineFiles).some(
      (p) => !(p in candidate.afterFiles),
    ),
    changed = Object.keys(candidate.afterFiles).filter(
      (p) => candidate.afterFiles[p] !== candidate.baselineFiles[p],
    );
  if (
    deleted ||
    changed.length !== names.size ||
    changed.some((p) => !names.has(p.toLowerCase()))
  )
    throw new BridgeError("CANDIDATE_CHANGED", "候选变更清单与前后工程不一致");
  return [run, candidate, preparedRun, prepared];
}
export function checkCandidate(ctx: BridgeContext, id: string): Json {
  const [, candidate] = loadCandidateForValidation(ctx, id);
  if (
    candidate.verdict !== "PASS" ||
    configurationDigest(ctx) !== candidate.configDigest
  )
    throw new BridgeError(
      "BASELINE_CHANGED",
      "工程、工具配置或候选验证结论不满足应用条件",
    );
  return candidate;
}
export async function validateCandidate(
  ctx: BridgeContext,
  params: Json,
  run: string,
  runner: PipelineRunner = runPipelineLogged,
): Promise<Json> {
  const [oldRun, candidate, preparedRun, prepared] = loadCandidateForValidation(
      ctx,
      params.candidateId,
    ),
    digest = configurationDigest(ctx),
    original = candidate.originalRoot,
    stage = path.join(run, "staging", path.basename(original));
  copyProject(path.join(preparedRun, "baseline"), stage);
  for (const item of candidate.changes)
    copyFile(
      path.join(oldRun, "content/after", item.relativePath),
      safePath(stage, path.join(stage, item.relativePath)),
    );
  if (!same(snapshot(stage), candidate.afterFiles))
    throw new BridgeError("CANDIDATE_CHANGED", "重建候选与冻结清单不同");
  const taskDir = path.join(run, "backend");
  copyArtifacts(
    path.join(oldRun, "backend"),
    taskDir,
    path.join(oldRun, "staging"),
    path.dirname(stage),
  );
  for (const item of candidate.changes)
    if (item.beforeSha256)
      copyFile(
        path.join(oldRun, "content/before", item.relativePath),
        path.join(taskDir, "baseline-production", item.relativePath),
      );
  writeJson(path.join(taskDir, "refactor-changes.json"), {
    changedProductionFiles: candidate.changes
      .filter((i: Json) => i.kind === "source")
      .map((i: Json) => i.relativePath),
    changedProductionResources: candidate.changes
      .filter((i: Json) => i.kind === "resource")
      .map((i: Json) => i.relativePath),
  });
  const task = taskFromJson(readJson(path.join(taskDir, "task.json")));
  prepareReviewMaterials(
    taskDir,
    task.project_root,
    readJson(path.join(taskDir, "refactor-changes.json"))
      .changedProductionFiles,
  );
  const plan = pipelineConfig(ctx, taskDir);
  delete plan.refactorAgent;
  delete plan.repairAgent;
  plan.maxRepairAttempts = 0;
  ctx.emit("workflow.changed", {
    status: "正在重新验证冻结候选：执行门禁与评审…",
  });
  const result = await runner(ctx, taskDir, plan);
  result.refactorEvidenceFrom = oldRun;
  for (const step of result.steps ?? [])
    if (step.name === "refactor-agent" && step.status === "SKIPPED")
      step.reason = "使用已有冻结候选，不再次执行重构 Agent";
  if (!same(snapshot(stage), candidate.afterFiles))
    throw new BridgeError("CANDIDATE_CHANGED", "验证期间候选源码已变化");
  const response = freezeCandidate(
    ctx,
    run,
    stage,
    original,
    preparedRun,
    prepared,
    result,
    digest,
  );
  response.candidate.revalidatedFrom = candidate.candidateId;
  writeJson(path.join(run, "candidate.json"), response.candidate);
  return response;
}
export async function validateApplied(
  ctx: BridgeContext,
  params: Json,
  run: string,
): Promise<Json> {
  const [oldRun, candidate] = loadRun(
      ctx,
      params.candidateId,
      "candidate.json",
    ),
    original = candidate.originalRoot;
  if (
    candidate.verdict !== "PASS" ||
    !same(snapshot(original), candidate.afterFiles) ||
    configurationDigest(ctx) !== candidate.configDigest
  )
    throw new BridgeError(
      "BASELINE_CHANGED",
      "已应用内容或工具配置与候选不同，请重新检测",
    );
  const stage = path.join(run, "staging", path.basename(original));
  copyProject(original, stage);
  const taskDir = path.join(run, "backend");
  copyArtifacts(
    path.join(oldRun, "backend"),
    taskDir,
    path.join(oldRun, "staging"),
    path.dirname(stage),
  );
  const changes = readJson(path.join(oldRun, "backend/refactor-changes.json"));
  writeJson(path.join(taskDir, "refactor-changes.json"), changes);
  const task = taskFromJson(readJson(path.join(taskDir, "task.json"))),
    plan = pipelineConfig(ctx, taskDir),
    started = now();
  const steps = await runGates(
    taskDir,
    task,
    plan,
    contextFor(taskDir, task),
    false,
    (stepId, status) => ctx.emit("step.updated", { stepId, status }),
    "",
    started + 1200,
  );
  const required = steps.filter(
    (s) =>
      !(
        s.name === "linter" &&
        ctx.config.linterMode === "skip" &&
        s.status === "SKIPPED"
      ),
  );
  required.push({
    name: "review-agent",
    status: "PASS",
    duration_seconds: 0,
    reason: "复用完全相同源码、依赖和策略的候选 PASS 评审",
  });
  const result = finalResult(task.task_id, required);
  result.validationPolicy = { linterMode: ctx.config.linterMode ?? "required" };
  result.reviewEvidenceFrom = oldRun;
  result.durationSeconds = round(now() - started);
  result.timeoutSeconds = 1200;
  result.timedOut = steps.some((s) => s.reason?.includes("总执行时间超过限制"));
  summarizeFailure(taskDir, result);
  if (
    !same(snapshot(original), candidate.afterFiles) ||
    !same(snapshot(stage), candidate.afterFiles) ||
    configurationDigest(ctx) !== candidate.configDigest
  )
    throw new BridgeError(
      "BASELINE_CHANGED",
      "应用后验证期间工程或配置变化，结果失效",
    );
  writeJson(path.join(taskDir, "gates.json"), {
    schemaVersion: "1.0",
    taskId: task.task_id,
    validationPolicy: result.validationPolicy,
    gates: steps,
  });
  writeJson(path.join(taskDir, "result.json"), result);
  return { result, runDirectory: run };
}
