import fs from "node:fs";
import path from "node:path";
import type { Json, CommandResult } from "../models.js";
import { taskFromJson } from "../models.js";
import { hash, isTest, readJson, readText, writeJson, writeText } from "../utils.js";
import { freshCopy, syncProductionChanges } from "../workspace.js";
import { relocateFrozenTestPlan } from "../test_plan.js";
import { normalizeAgentPromptPaths } from "../gate.js";
import { buildFailureReport } from "../runner.js";
import { buildRepairPrompt } from "../prompts.js";
import {
  BridgeContext, BridgeError, allowedProduction, configurationDigest,
  copyProject, loadRun, safePath, same, snapshot,
} from "./common.js";
import {
  copyArtifacts, freezeCandidate, pipelineConfig, runPipelineLogged, type PipelineRunner,
} from "./candidates.js";

const MAX_VALIDATIONS = 4; // Initial submission and at most three externally performed repairs.

function unchanged(ctx: BridgeContext, preparedRun: string, prepared: Json): void {
  if (configurationDigest(ctx) !== prepared.configDigest ||
      !same(snapshot(prepared.originalRoot), prepared.baselineFiles))
    throw new BridgeError("BASELINE_CHANGED", "准备后原工程或工具配置变化，请重新检测并准备");
  if (!same(snapshot(path.join(preparedRun, "baseline")), prepared.baselineFiles))
    throw new BridgeError("CANDIDATE_CHANGED", "冻结工程基线已变化");
}

function editPrompt(text: string, taskDir: string, stage: string, edit: string): string {
  return `本次由外层对话安排重构/返修。唯一允许编辑的目录：${edit}\n` +
    "只修改该目录中的生产源码与本任务必要资源，不编辑原工程、冻结基线、测试或验证材料。完成后交回外层，由外层调用 validate-workspace 验收，不自行再次启动重构流水线。\n\n" +
    normalizeAgentPromptPaths(text, readJson(path.join(taskDir, "task.json")), stage);
}

/** Prepare the only editable copy. Tests and frozen evidence remain outside this directory. */
export function openWorkspace(ctx: BridgeContext, params: Json, run: string): Json {
  const [preparedRun, prepared] = loadRun(ctx, params.taskHandle, "prepared.json");
  unchanged(ctx, preparedRun, prepared);
  const original = prepared.originalRoot,
    originalStage = path.join(preparedRun, "staging", path.basename(original)),
    stage = path.join(run, "staging", path.basename(original)),
    taskDir = path.join(run, "backend"),
    editDirectory = path.join(run, "edit"),
    promptFile = path.join(run, "prompts", "refactor.md");
  if (!same(snapshot(originalStage), prepared.baselineFiles))
    throw new BridgeError("CANDIDATE_CHANGED", "准备阶段的选测来源已变化");
  copyProject(path.join(preparedRun, "baseline"), stage);
  copyArtifacts(path.join(preparedRun, "backend"), taskDir, path.dirname(originalStage), path.dirname(stage));
  relocateFrozenTestPlan(path.join(preparedRun, "backend"), taskDir, originalStage, stage);
  freshCopy(stage, editDirectory, true);
  const editBaseline = snapshot(editDirectory);
  if (Object.keys(editBaseline).some(isTest)) throw new BridgeError("INVALID_INPUT", "编辑副本包含测试文件");
  writeText(promptFile, editPrompt(readText(path.join(taskDir, "refactor-prompt.md")), taskDir, stage, editDirectory));
  unchanged(ctx, preparedRun, prepared);
  const workspaceId = path.basename(run);
  writeJson(path.join(run, "workspace.json"), {
    schemaVersion: 1, workspaceId, taskHandle: prepared.taskHandle,
    originalRoot: original, configDigest: prepared.configDigest, preparedSha256: hash(path.join(preparedRun, "prepared.json")),
    editBaseline, artifactFiles: snapshot(taskDir), validations: 0,
  });
  return { workspaceId, taskHandle: prepared.taskHandle, editDirectory, promptFile, runDirectory: run,
    scanScope: prepared.scanScope, maxRepairAttempts: MAX_VALIDATIONS - 1 };
}

/** Snapshot external edits, run the existing gates/reviewer, and freeze a regular shared candidate. */
export async function validateWorkspace(
  ctx: BridgeContext, params: Json, run: string, runner: PipelineRunner = runPipelineLogged,
): Promise<Json> {
  const [workspaceRun, workspace] = loadRun(ctx, params.workspaceId, "workspace.json");
  if (workspace.schemaVersion !== 1 || workspace.workspaceId !== params.workspaceId ||
      !Number.isInteger(workspace.validations) || workspace.validations < 0)
    throw new BridgeError("INVALID_INPUT", "工作区记录无效");
  const lockPath = safePath(workspaceRun, path.join(workspaceRun, ".validate.lock"));
  let lock: number;
  try { lock = fs.openSync(lockPath, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new BridgeError("WORKSPACE_BUSY", "工作区正在验收或有中断遗留锁，请先检查已有运行记录");
    throw error;
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, runDirectory: run }));
    // Reload under the lock so two processes cannot consume the same attempt.
    const current = readJson(path.join(workspaceRun, "workspace.json"));
    if (!same(current, workspace)) throw new BridgeError("WORKSPACE_CHANGED", "工作区状态已变化，请重新读取");
    if (workspace.validations >= MAX_VALIDATIONS)
      throw new BridgeError("REPAIR_LIMIT", "已完成初次验收和最多 3 次返修验收，请查看最后一轮结果");
    const [preparedRun, prepared] = loadRun(ctx, workspace.taskHandle, "prepared.json");
    if (prepared.originalRoot !== workspace.originalRoot || prepared.configDigest !== workspace.configDigest ||
        hash(path.join(preparedRun, "prepared.json")) !== workspace.preparedSha256)
      throw new BridgeError("CANDIDATE_CHANGED", "工作区所关联的准备记录已变化");
    unchanged(ctx, preparedRun, prepared);
    const original = prepared.originalRoot,
      workspaceStage = safePath(workspaceRun, path.join(workspaceRun, "staging", path.basename(original))),
      edit = safePath(workspaceRun, path.join(workspaceRun, "edit")),
      workspaceTask = safePath(workspaceRun, path.join(workspaceRun, "backend")),
      stage = path.join(run, "staging", path.basename(original)),
      taskDir = path.join(run, "backend"),
      incoming = path.join(taskDir, "external-edits");
    if (fs.lstatSync(path.join(workspaceRun, "edit")).isSymbolicLink())
      throw new BridgeError("PATH_OUTSIDE_ROOT", "编辑目录不可替换为链接或 junction");
    if (!same(snapshot(workspaceStage), prepared.baselineFiles) ||
        !same(snapshot(workspaceTask), workspace.artifactFiles))
      throw new BridgeError("CANDIDATE_CHANGED", "工作区的冻结基线或选测/风险材料已变化");
    const submitted = snapshot(edit),
      deleted = Object.keys(workspace.editBaseline).filter(name => !(name in submitted)),
      changed = Object.keys(submitted).filter(name => submitted[name] !== workspace.editBaseline[name]);
    if (deleted.length || changed.some(name => !allowedProduction(name)))
      throw new BridgeError("INVALID_INPUT", "编辑副本包含测试、配置、删除或其他非生产修改，未执行验收");
    if (!changed.length) throw new BridgeError("NO_CHANGES", "编辑副本没有生产修改，未执行验收");
    copyProject(edit, incoming);
    if (!same(snapshot(incoming), submitted) || !same(snapshot(edit), submitted))
      throw new BridgeError("WORKSPACE_CHANGED", "复制期间编辑内容变化，请停止编辑后重新验收");
    copyProject(path.join(preparedRun, "baseline"), stage);
    copyArtifacts(workspaceTask, taskDir, path.dirname(workspaceStage), path.dirname(stage));
    relocateFrozenTestPlan(workspaceTask, taskDir, workspaceStage, stage);
    // This writes only to this attempt's full validation copy, never the original project.
    const log = (text: string) => ctx.log(text + "\n");
    const synced = syncProductionChanges(incoming, stage, log, log);
    if (synced !== 0) throw new BridgeError("INVALID_INPUT", "无法接收外部生产修改（code=" + synced + "）");
    const frozenSource = snapshot(stage), attempt = workspace.validations;
    if (same(frozenSource, prepared.baselineFiles))
      throw new BridgeError("NO_CHANGES", "保留原源码格式后没有生产修改，未执行验收");
    const plan = pipelineConfig(ctx, taskDir);
    delete plan.refactorAgent;
    delete plan.repairAgent;
    plan.maxRepairAttempts = 0;
    plan.agentPolicy = { ...plan.agentPolicy, editingOwner: "external", externalAttempt: attempt };
    workspace.validations++;
    workspace.lastRunDirectory = run;
    writeJson(path.join(workspaceRun, "workspace.json"), workspace);
    writeJson(path.join(run, "external-submission.json"), { workspaceId: workspace.workspaceId, attempt, submitted });
    const protectedEvidence = snapshot(taskDir);
    ctx.emit("workflow.changed", { status: "外部修改已冻结，正在执行门禁与独立评审…" });
    const result = await runner(ctx, taskDir, plan);
    result.externalWorkspaceId = workspace.workspaceId;
    result.externalAttempt = attempt;
    for (const step of result.steps ?? [])
      if (step.name === "refactor-agent" && step.status === "SKIPPED")
        step.reason = "本轮生产修改由外层 Agent 提供，后端未启动重构或返修 Agent";
    const evidenceAfter = snapshot(taskDir);
    if (Object.entries(protectedEvidence).some(([name, digest]) => evidenceAfter[name] !== digest))
      throw new BridgeError("CANDIDATE_CHANGED", "验收期间冻结任务、选测或修改证据已变化，本轮结果不能封存");
    if (!same(snapshot(stage), frozenSource) || !same(snapshot(edit), submitted))
      throw new BridgeError("WORKSPACE_CHANGED", "验收期间源码或编辑副本变化，本轮结果不能封存，请停止编辑后重试");
    unchanged(ctx, preparedRun, prepared);
    const task = taskFromJson(readJson(path.join(taskDir, "task.json"))),
      failed = (result.steps ?? []).find((step: CommandResult) => step.status === "FAIL") as CommandResult | undefined;
    let repairEligible = false, repairPromptFile: string | undefined;
    if (result.verdict === "FAIL" && failed && !(result.steps ?? []).some((s: CommandResult) => s.status === "BLOCKED")) {
      const failure = buildFailureReport(taskDir, task, failed, attempt + 1);
      writeJson(path.join(taskDir, "failure-report.json"), failure);
      repairEligible = !!failure.repairable && workspace.validations < MAX_VALIDATIONS;
      if (repairEligible) {
        repairPromptFile = path.join(workspaceRun, "prompts", `repair-${attempt + 1}.md`);
        writeText(repairPromptFile, editPrompt(buildRepairPrompt(task, readJson(path.join(taskDir, "risk-report.json")),
          failure, attempt + 1, ctx.config.linterMode ?? "required"), taskDir, stage, edit));
      }
    }
    const response = freezeCandidate(ctx, run, stage, original, preparedRun, prepared, result, prepared.configDigest);
    Object.assign(response, { workspaceId: workspace.workspaceId, attempt, repairEligible,
      ...(repairPromptFile ? { repairPromptFile } : {}) });
    workspace.lastCandidateId = response.candidate.candidateId;
    workspace.lastVerdict = response.result.verdict;
    workspace.repairEligible = repairEligible;
    writeJson(path.join(workspaceRun, "workspace.json"), workspace);
    return response;
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
