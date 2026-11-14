import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.js";
import { readJson, readText, writeJson, writeText } from "../src/utils.js";
import { loadConfig } from "../src/client/config.js";
import { candidateDiff, applyCandidate, recoverApplication } from "../src/client/apply.js";
import { BridgeContext } from "../src/ide/common.js";
import { normalizeIssues } from "../src/ide/scan.js";
import { checkCandidate, prepareCandidate, validateCandidate } from "../src/ide/candidates.js";
import { openWorkspace, validateWorkspace } from "../src/ide/external_workspace.js";
import { cleanupAttempt, finishTask, lockOperation } from "../src/ide/lifecycle.js";
import { dispatch, serveRequest } from "../src/ide_bridge.js";
import { runSkill } from "../src/skill.js";
import type { Json } from "../src/models.js";

const filename = "entry/src/main/ets/Page.ets";
const original = "export class Page {\n  work(): number { return 1; }\n}\n";
const complete = (run: string) => writeJson(path.join(run, "session.json"),
  { ...readJson(path.join(run, "session.json")), state: "SUCCEEDED" });
async function setup(t: TestContext) {
  const base = fixture(t), root = path.join(base, "project"), target = path.join(root, filename);
  writeText(target, original);
  writeText(path.join(root, "build-profile.json5"), '{modules:[{name:"entry",srcPath:"entry"}]}');
  writeText(path.join(root, "hvigor/hvigor-config.json5"), "{}");
  const config = await loadConfig({ projectRoot: root, backend: path.join(base, "backend"), runs: path.join(base, "runs"),
    node: process.execPath, deveco: process.execPath, hvigor: process.execPath, ohpm: process.execPath, linter: process.execPath });
  const ctx = new BridgeContext(config, root, path.join(base, "scanner.cjs"), () => {});
  const issue = normalizeIssues({ filePath: filename, messages: [{ line: 2, rule: "@extrulesproject/long-method-check",
    message: "Method 'work' is too long" }] }, root)[0];
  const preparedRun = ctx.createRun("task.prepare");
  const prepared = prepareCandidate(ctx, { issue, scanScope: { scopePath: target } }, preparedRun);
  complete(preparedRun);
  const openRun = ctx.createRun("task.openWorkspace");
  const workspace = openWorkspace(ctx, { taskHandle: prepared.taskHandle }, openRun);
  complete(openRun);
  const edit = (n: number) => writeText(path.join(workspace.editDirectory, filename), original.replace("return 1", "return " + n));
  const validate = async (verdict: string): Promise<Json> => {
    const run = ctx.createRun("task.validateWorkspace");
    const response = await validateWorkspace(ctx, { workspaceId: workspace.workspaceId }, run, async () => ({ verdict, steps: [] }));
    writeText(path.join(run, "backend/build.log"), "build evidence\n");
    const cleanup = cleanupAttempt(run, "task.validateWorkspace", true);
    complete(run);
    return { ...response, cleanup };
  };
  return { base, root, target, ctx, config, preparedRun, prepared, openRun, workspace, edit, validate };
}

test("task completion removes duplicate copies but preserves usable candidates, logs and rollback", async t => {
  const f = await setup(t);
  const spareRun = f.ctx.createRun("task.openWorkspace");
  openWorkspace(f.ctx, { taskHandle: f.prepared.taskHandle }, spareRun);
  complete(spareRun);
  f.edit(2);
  const response = await f.validate("PASS");
  assert.equal(fs.existsSync(path.join(response.runDirectory, "staging")), false);
  assert.equal(fs.existsSync(path.join(f.openRun, "edit")), true); // host still owns the task
  const result = finishTask(f.ctx, f.prepared.taskHandle);
  assert.equal(result.state, "FINISHED");
  assert.deepEqual(result.warnings, []);
  for (const run of [f.preparedRun, f.openRun, spareRun, response.runDirectory])
    assert.equal(fs.existsSync(path.join(run, "staging")), false);
  assert.equal(fs.existsSync(path.join(f.openRun, "edit")), false);
  assert.equal(fs.existsSync(path.join(spareRun, "edit")), false);
  assert.equal(readText(path.join(f.preparedRun, "baseline", filename)), original);
  assert.equal(readText(path.join(response.runDirectory, "backend/build.log")), "build evidence\n");
  const candidate = checkCandidate(f.ctx, response.candidate.candidateId);
  assert.match(await candidateDiff(f.config, candidate as any, filename), /return 2/);
  assert.equal((await applyCandidate(f.config, candidate as any)).state, "APPLIED");
  // Finishing again must not remove the application journal or before payload.
  assert.deepEqual(finishTask(f.ctx, f.prepared.taskHandle).removed, []);
  assert.equal((await recoverApplication(f.config, candidate as any)).state, "ROLLED_BACK");
  assert.equal(readText(f.target), original);
  assert.throws(() => openWorkspace(f.ctx, { taskHandle: f.prepared.taskHandle }, spareRun), /任务已收尾/);
  await assert.rejects(validateWorkspace(f.ctx, { workspaceId: f.workspace.workspaceId }, spareRun), /工作区已收尾/);
});

test("BLOCKED completion preserves evidence and supports later candidate validation", async t => {
  const f = await setup(t);
  f.edit(2);
  const response = await f.validate("BLOCKED");
  finishTask(f.ctx, f.prepared.taskHandle);
  const checked = (await dispatch(f.ctx, "candidate.restore", { candidateId: response.candidate.candidateId })).candidate;
  assert.equal(checked.verdict, "BLOCKED");
  assert.match(readText(path.join(response.runDirectory, "backend/build.log")), /evidence/);
  const rechecked = await validateCandidate(f.ctx, { candidateId: checked.candidateId },
    f.ctx.createRun("task.validateCandidate"), async () => ({ verdict: "PASS", steps: [] }));
  assert.equal(rechecked.result.verdict, "PASS");
});

test("finish archives never-validated and subsequently changed edits as unvalidated drafts", async t => {
  const f = await setup(t);
  f.edit(3);
  writeText(path.join(f.workspace.editDirectory, "entry/src/main/ets/New.ets"), "export class New {}\n");
  finishTask(f.ctx, f.prepared.taskHandle);
  const draft = readJson(path.join(f.openRun, "draft/manifest.json"));
  assert.equal(draft.status, "UNVALIDATED_DRAFT");
  assert.match(readText(path.join(f.openRun, "draft/content", filename)), /return 3/);
  assert.ok(draft.changed["entry/src/main/ets/New.ets"]);
  assert.equal(fs.existsSync(path.join(f.openRun, "candidate.json")), false);
  assert.equal(readText(f.target), original);
});

test("finish refuses live validation/apply locks and never touches another task", async t => {
  const f = await setup(t);
  const other = f.ctx.createRun("task.openWorkspace");
  writeText(path.join(other, "edit/keep.txt"), "unrelated");
  const lock = path.join(f.openRun, ".validate.lock");
  writeJson(lock, { pid: process.pid });
  assert.throws(() => finishTask(f.ctx, f.prepared.taskHandle), /正在验收/);
  assert.equal(fs.existsSync(path.join(f.openRun, "edit")), true);
  assert.equal(fs.existsSync(path.join(f.preparedRun, "task-lifecycle.json")), false);
  fs.unlinkSync(lock);
  writeText(path.join(f.config.runs, ".apply.lock"), String(process.pid));
  assert.throws(() => finishTask(f.ctx, f.prepared.taskHandle), /应用或回滚/);
  fs.unlinkSync(path.join(f.config.runs, ".apply.lock"));
  finishTask(f.ctx, f.prepared.taskHandle);
  assert.equal(readText(path.join(other, "edit/keep.txt")), "unrelated\n");
});

test("bridge serializes finish against running operations and CLI exposes a durable finish receipt", async t => {
  const f = await setup(t), output: Json[] = [];
  const unlock = lockOperation(f.ctx);
  try {
    assert.equal(await serveRequest({ protocolVersion: 1, requestId: "busy", method: "task.finish",
      config: f.config, projectRoot: f.root, params: { taskHandle: f.prepared.taskHandle } },
    { scanner: f.ctx.scanner, output: message => output.push(message) }), 2);
    assert.equal(output.at(-1)?.error.code, "WORKFLOW_BUSY");
  } finally { unlock(); }
  const lines: string[] = [];
  const code = await runSkill(["finish", "--task", f.prepared.taskHandle], {
    config: f.config, stdout: line => lines.push(line),
    backend: () => ({ request: async (method, params) => {
      assert.equal(method, "task.finish");
      return finishTask(f.ctx, String(params?.taskHandle)) as any;
    } }),
  });
  assert.equal(code, 0);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.result.state, "FINISHED");
  assert.equal(readJson(receipt.responseFile).command, "finish");
});

test("legacy RUNNING records block finish even without a new operation lock", async t => {
  const f = await setup(t), sessionFile = path.join(f.openRun, "session.json");
  writeJson(sessionFile, { ...readJson(sessionFile), state: "RUNNING" });
  assert.throws(() => finishTask(f.ctx, f.prepared.taskHandle), /仍为 RUNNING/);
  assert.equal(fs.existsSync(path.join(f.openRun, "edit")), true);
  assert.equal(fs.existsSync(path.join(f.preparedRun, "staging")), true);
});

test("draft archives refuse internal junctions before retiring the only edited copy", async t => {
  const f = await setup(t);
  f.edit(4);
  const draft = path.join(f.openRun, "draft");
  fs.mkdirSync(draft);
  try { fs.symlinkSync(path.join(f.openRun, "staging", path.basename(f.root)), path.join(draft, "content"),
    process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Directory links are unavailable in this environment"); return;
    }
    throw error;
  }
  assert.throws(() => finishTask(f.ctx, f.prepared.taskHandle), /链接|junction/);
  assert.match(readText(path.join(f.openRun, "edit", filename)), /return 4/);
  assert.equal(readText(path.join(f.openRun, "staging", path.basename(f.root), filename)), original);
});

test("timeout and interrupted attempts defer cleanup until all child processes are confirmed stopped", async t => {
  const run = path.join(fixture(t), "run");
  writeText(path.join(run, "staging/project/keep.ets"), "pending source");
  writeJson(path.join(run, "candidate.json"), {});
  for (const [completed, pipeline] of [[false, {}], [true, { timedOut: true }],
    [true, { steps: [{ reason: "总执行时间超过限制" }] }]] as [boolean, Json][]) {
    const result = cleanupAttempt(run, "task.validateWorkspace", completed, pipeline);
    assert.equal(result.deferred, true);
    assert.deepEqual(result.removed, []);
    assert.ok(result.warnings.length);
    assert.equal(fs.existsSync(path.join(run, "staging/project/keep.ets")), true);
  }
});
