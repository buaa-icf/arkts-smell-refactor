import fs from "node:fs";
import path from "node:path";
import type { Json } from "../models.js";
import { hash, isFile, readJson, writeJson } from "../utils.js";
import { assertUnlinkedPath, cleanupRunCopies, cleanupTaskCaches, type CacheCleanupReport } from "../cache_cleanup.js";
import { BridgeContext, BridgeError, loadRun, safePath, same, snapshot } from "./common.js";

const report = (): CacheCleanupReport => ({ removed: [], retained: [], warnings: [] });
function merge(into: CacheCleanupReport, part: CacheCleanupReport): void {
  for (const key of ["removed", "retained", "warnings"] as const) into[key].push(...part[key]);
  if (part.archived?.length) (into.archived ??= []).push(...part.archived);
}

/** Serialize backend mutations with finalization; native agents must be joined by the host first. */
export function lockOperation(ctx: BridgeContext): () => void {
  const base = path.resolve(ctx.config.runs!);
  fs.mkdirSync(base, { recursive: true });
  const lock = safePath(base, path.join(base, ".operation.lock"));
  let fd: number;
  try { fd = fs.openSync(lock, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new BridgeError("WORKFLOW_BUSY", "另一个后端操作正在执行或有中断遗留锁；请先检查运行记录");
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  return () => { fs.closeSync(fd); fs.unlinkSync(lock); };
}

export function assertTaskOpen(ctx: BridgeContext, taskHandle: string): void {
  const [run] = loadRun(ctx, taskHandle, "prepared.json");
  if (isFile(path.join(run, "task-lifecycle.json")) &&
      readJson(path.join(run, "task-lifecycle.json")).state === "FINISHED")
    throw new BridgeError("TASK_FINISHED", "任务已收尾；可查看、应用或复验已封存候选，重新编辑请重新准备任务");
}

/** Called only after the pipeline and its evidence checks have finished. */
export function cleanupAttempt(run: string, method: string, completed: boolean, pipeline: Json = {}): CacheCleanupReport & { deferred?: boolean } {
  const result = report();
  if (!completed || pipeline.timedOut || (pipeline.steps ?? []).some((step: Json) =>
    step.timedOut || /超时|超过.*时间|时间超过|timed?\s*out|timeout|已中止/i.test(step.reason ?? ""))) {
    const deferred = { ...result, retained: [run], deferred: true,
      warnings: ["异常或超时后无法确认子进程已退出，暂缓清理；确认所有编辑、构建及测试进程停止后再调用 finish"] };
    writeJson(path.join(run, "cache-cleanup.json"), { ...deferred, updatedAt: new Date().toISOString() });
    return deferred;
  }
  merge(result, cleanupTaskCaches(path.join(run, "backend")));
  if (completed && (isFile(path.join(run, "candidate.json")) || method === "task.validateApplied")) {
    const copies = ["staging", "backend/external-edits"];
    const backend = path.join(run, "backend");
    if (fs.existsSync(backend)) for (const name of fs.readdirSync(backend))
      if (/^refactor-workspace(?:-repair-prompt-\d+)?$/.test(name)) copies.push(`backend/${name}`);
    merge(result, cleanupRunCopies(run, copies));
  }
  writeJson(path.join(run, "cache-cleanup.json"), { ...result, updatedAt: new Date().toISOString() });
  return result;
}

/** Preserve the last unsubmitted edits as a draft before retiring an editable copy. */
function archiveDraft(run: string, workspace: Json): void {
  assertUnlinkedPath(path.join(run, "edit"));
  const edit = safePath(run, path.join(run, "edit"));
  if (!fs.existsSync(edit)) return;
  const current = snapshot(edit), baseline = workspace.editBaseline ?? {};
  const changed = Object.keys(current).filter(name => current[name] !== baseline[name]);
  const deleted = Object.keys(baseline).filter(name => !(name in current));
  if (!changed.length && !deleted.length) return;
  assertUnlinkedPath(path.join(run, "draft"));
  const directory = safePath(run, path.join(run, "draft"));
  for (const name of changed) {
    const source = safePath(edit, path.join(edit, name));
    assertUnlinkedPath(path.join(directory, "content", name));
    const target = safePath(run, path.join(directory, "content", name));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    if (hash(target) !== current[name]) throw new BridgeError("WORKSPACE_CHANGED", "保存草稿期间编辑内容发生变化，未清理工作区");
  }
  if (!same(snapshot(edit), current)) throw new BridgeError("WORKSPACE_CHANGED", "保存草稿期间编辑内容发生变化，未清理工作区");
  writeJson(path.join(directory, "manifest.json"), {
    schemaVersion: 1, workspaceId: workspace.workspaceId, taskHandle: workspace.taskHandle,
    status: "UNVALIDATED_DRAFT", changed: Object.fromEntries(changed.map(name => [name, current[name]])),
    deleted, lastCandidateId: workspace.lastCandidateId ?? null,
  });
}

/** Explicit end of a host-owned task, independent of SDK/model availability or validation verdict. */
export function finishTask(ctx: BridgeContext, taskHandle: string): Json {
  const [preparedRun, prepared] = loadRun(ctx, taskHandle, "prepared.json");
  if (prepared.taskHandle !== taskHandle || fs.lstatSync(path.join(ctx.config.runs!, taskHandle)).isSymbolicLink())
    throw new BridgeError("INVALID_INPUT", "准备记录或任务目录不匹配，未清理");
  const base = path.resolve(ctx.config.runs!), runs: { run: string; session: Json; workspace?: Json; candidate?: Json }[] = [];
  const locks: { path: string; fd: number }[] = [];
  const result = report();
  // Cooperate with client-side apply/rollback, which run outside the bridge process.
  const applyLock = safePath(base, path.join(base, ".apply.lock"));
  try {
    try { locks.push({ path: applyLock, fd: fs.openSync(applyLock, "wx") }); }
    catch { throw new BridgeError("WORKFLOW_BUSY", "应用或回滚事务正在执行或有遗留锁，未清理任务"); }
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        result.warnings.push(`跳过链接运行目录：${path.join(base, entry.name)}`);
        continue;
      }
      const run = safePath(base, path.join(base, entry.name));
      if (!isFile(path.join(run, "session.json"))) continue;
      const session = readJson(path.join(run, "session.json"));
      if (session.projectRoot !== ctx.root) continue;
      const workspace = isFile(path.join(run, "workspace.json")) ? readJson(path.join(run, "workspace.json")) : undefined;
      const candidate = isFile(path.join(run, "candidate.json")) ? readJson(path.join(run, "candidate.json")) : undefined;
      if (run !== preparedRun && session.taskHandle !== taskHandle &&
          workspace?.taskHandle !== taskHandle && candidate?.taskHandle !== taskHandle) continue;
      if (workspace) {
        const lockPath = safePath(run, path.join(run, ".validate.lock"));
        try { locks.push({ path: lockPath, fd: fs.openSync(lockPath, "wx") }); }
        catch { throw new BridgeError("WORKSPACE_BUSY", "工作区正在验收或有遗留锁，未清理任务"); }
      }
      runs.push({ run, session, workspace, candidate });
    }
    if (runs.some(({ session }) => session.state === "RUNNING"))
      throw new BridgeError("WORKFLOW_BUSY", "关联运行记录仍为 RUNNING，无法确认旧进程已结束，未清理任务");
    // Keep the one complete baseline: candidate checking/revalidation still depends on it.
    if (!same(snapshot(path.join(preparedRun, "baseline")), prepared.baselineFiles))
      throw new BridgeError("CANDIDATE_CHANGED", "冻结基线不完整，未清理任务副本");
    for (const { run, workspace } of runs) if (workspace) archiveDraft(run, workspace);
    const lifecycleFile = path.join(preparedRun, "task-lifecycle.json");
    const finishedAt = isFile(lifecycleFile) ? readJson(lifecycleFile).finishedAt : new Date().toISOString();
    writeJson(lifecycleFile, { schemaVersion: 1, taskHandle, state: "FINISHED", finishedAt });
    for (const { run, session, workspace, candidate } of runs) {
      const copies: string[] = [];
      if (run === preparedRun || workspace || candidate || session.method === "task.validateApplied") copies.push("staging");
      if (workspace) {
        writeJson(path.join(run, "workspace.json"), { ...workspace, lifecycle: "FINISHED", finishedAt });
        copies.push("edit");
      }
      if (candidate) {
        copies.push("backend/external-edits");
        const backend = path.join(run, "backend");
        if (fs.existsSync(backend)) for (const name of fs.readdirSync(backend))
          if (/^refactor-workspace(?:-repair-prompt-\d+)?$/.test(name)) copies.push(`backend/${name}`);
      }
      // Failed attempts without a frozen candidate may contain the only edited source.
      if (!copies.includes("staging") && fs.existsSync(path.join(run, "staging"))) {
        result.retained.push(path.join(run, "staging"));
        result.warnings.push(`未封存的失败副本已保留：${run}`);
      }
      merge(result, cleanupRunCopies(run, copies));
      merge(result, cleanupTaskCaches(path.join(run, "backend")));
    }
    result.retained.push(path.join(preparedRun, "baseline"));
    const response = { taskHandle, state: "FINISHED", runDirectory: preparedRun, ...result };
    writeJson(path.join(preparedRun, "finish-result.json"), response);
    return response;
  } finally {
    for (const lock of locks.reverse()) { fs.closeSync(lock.fd); fs.unlinkSync(lock.path); }
  }
}
