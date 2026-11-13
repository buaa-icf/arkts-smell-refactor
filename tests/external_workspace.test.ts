import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, goodConfig } from "./helpers.js";
import type { Json } from "../src/models.js";
import { hash, readJson, readText, writeJson, writeText } from "../src/utils.js";
import { BridgeContext, BridgeError, snapshot } from "../src/ide/common.js";
import { normalizeIssues } from "../src/ide/scan.js";
import { prepareCandidate, checkCandidate, copyArtifacts, validateCandidate, validateApplied } from "../src/ide/candidates.js";
import { openWorkspace, validateWorkspace } from "../src/ide/external_workspace.js";
import { buildTestPlan, relocateFrozenTestPlan } from "../src/test_plan.js";
import { executePipeline } from "../src/runner.js";

const name = "entry/src/main/ets/Page.ets";
const source = "export class Page {\n  work(): number { return 1; }\n  other(): number { return 9; }\n}\n";

function setup(t: TestContext) {
  const base = fixture(t), root = path.join(base, "中文外部工程"), target = path.join(root, name);
  writeText(target, source);
  writeText(path.join(root, "build-profile.json5"), '{modules:[{name:"entry",srcPath:"entry"}]}');
  writeText(path.join(root, "hvigor/hvigor-config.json5"), "{}");
  for (const [suite, method] of [["Original", "work"], ["Other", "other"]]) {
    writeText(path.join(root, `entry/src/test/${suite}.test.ets`),
      `import { Page } from '../main/ets/Page';\nexport default function run() { describe('${suite}', () => {\n` +
      `let page: Page; beforeEach(() => { page = new Page(); }); it('case',0,()=>{page.${method}();}); }); }`);
  }
  writeText(path.join(root, "entry/src/test/List.test.ets"),
    "import original from './Original.test'; import other from './Other.test'; original(); other();");
  const config = { backend: path.join(base, "backend"), runs: path.join(base, "runs"), node: process.execPath,
    deveco: process.execPath, hvigor: process.execPath, ohpm: process.execPath, linter: process.execPath, linterMode: "required" };
  const events: Json[] = [], ctx = new BridgeContext(config, root, path.join(base, "scanner.cjs"), event => events.push(event));
  const issue = normalizeIssues({ filePath: name, messages: [{ line: 2, rule: "@extrulesproject/long-method-check",
    message: "Method 'work' is too long" }] }, root)[0];
  const prepareRun = ctx.createRun("task.prepare");
  const prepared = prepareCandidate(ctx, { issue, scanScope: { scopePath: target } }, prepareRun);
  const openRun = ctx.createRun("task.openWorkspace");
  const opened = openWorkspace(ctx, { taskHandle: prepared.taskHandle }, openRun);
  const editFile = path.join(opened.editDirectory, name);
  const edit = (value = 2) => writeText(editFile, source.replace("return 1", "return " + value));
  const validate = (runner: Parameters<typeof validateWorkspace>[3]) =>
    validateWorkspace(ctx, { workspaceId: opened.workspaceId }, ctx.createRun("task.validateWorkspace"), runner);
  return { base, root, target, config, ctx, events, prepareRun, prepared, openRun, opened, editFile, edit, validate };
}
const code = (expected: string) => (error: unknown) => error instanceof BridgeError && error.code === expected;
const pass = async () => ({ verdict: "PASS", steps: [{ name: "review-agent", status: "PASS", duration_seconds: 0 }] });

test("external workspace exposes no tests and freezes original test identity before editing", async t => {
  const f = setup(t), baseline = snapshot(f.root);
  assert.equal(fs.existsSync(path.join(f.opened.editDirectory, "entry/src/test")), false);
  assert.ok(readText(f.opened.promptFile).includes(f.opened.editDirectory));
  assert.equal(readText(f.opened.promptFile).includes(path.join(f.openRun, "staging")), false);
  assert.equal(readText(f.opened.promptFile).includes(path.join(f.prepareRun, "staging")), false);
  const frozen = readJson(path.join(f.openRun, "backend/baseline-test-plan.json"));
  assert.deepEqual(frozen.plan.jobs.map((job: Json) => job.scope), ["Original"]);
  // Rename and remove the original interface: selection must still follow pre-edit identity.
  writeText(f.editFile, source.replace("work", "renamed"));
  const response = await f.validate(async (_ctx, taskDir, plan) => {
    assert.equal(plan.refactorAgent, undefined);
    assert.equal(plan.repairAgent, undefined);
    assert.equal(plan.maxRepairAttempts, 0);
    assert.ok(plan.reviewAgent);
    const raw = readJson(path.join(taskDir, "task.json"));
    const selected = buildTestPlan(taskDir, raw.project_root);
    assert.equal(selected.selectionBasis, "frozen-before-refactor");
    assert.deepEqual(selected.jobs.map((job: Json) => job.scope), ["Original"]);
    assert.equal(selected.selectionEvidence[0].target.method, "work");
    return pass();
  });
  assert.equal(response.candidate.verdict, "PASS");
  assert.equal(response.attempt, 0);
  assert.equal(response.workspaceId, f.opened.workspaceId);
  assert.equal(response.repairEligible, false);
  assert.deepEqual(response.candidate.scanScope, { scopePath: f.target });
  assert.deepEqual(snapshot(f.root), baseline);
  assert.equal(checkCandidate(f.ctx, response.candidate.candidateId).verdict, "PASS");
  assert.equal(hash(path.join(response.runDirectory, "content/before", name)), hash(f.target));
  const rechecked = await validateCandidate(f.ctx, { candidateId: response.candidate.candidateId },
    f.ctx.createRun("task.validateCandidate"), async (_ctx, taskDir) => {
      const selected = buildTestPlan(taskDir, readJson(path.join(taskDir, "task.json")).project_root);
      assert.deepEqual(selected.jobs.map((job: Json) => job.scope), ["Original"]);
      assert.equal(selected.selectionEvidence[0].target.method, "work");
      return pass();
    });
  fs.copyFileSync(path.join(rechecked.runDirectory, "content/after", name), f.target);
  const applied = await validateApplied(f.ctx, { candidateId: rechecked.candidate.candidateId },
    f.ctx.createRun("task.validateApplied"), async (taskDir, task) => {
      const selected = buildTestPlan(taskDir, task.project_root);
      assert.equal(selected.selectionBasis, "frozen-before-refactor");
      assert.deepEqual(selected.jobs.map((job: Json) => job.scope), ["Original"]);
      return ["smell", "build", "test", "linter"].map(name => ({ name, status: "PASS", duration_seconds: 0 }));
    });
  assert.equal(applied.result.verdict, "PASS");
});

test("external validation uses existing pipeline gates and reviewer without a refactor or repair process", async t => {
  const f = setup(t);
  f.edit();
  const response = await f.validate(async (_ctx, taskDir, plan) => {
    assert.equal(plan.refactorAgent, undefined);
    assert.equal(plan.repairAgent, undefined);
    const controlled = goodConfig();
    return executePipeline(taskDir, { ...plan, gates: controlled.gates, reviewAgent: controlled.reviewAgent,
      reviewFormatAgent: null, taskTimeoutSeconds: 20 });
  });
  assert.equal(response.result.verdict, "PASS");
  assert.equal(response.result.steps.find((s: Json) => s.name === "refactor-agent").status, "SKIPPED");
  assert.equal(response.result.steps.some((s: Json) => s.name.startsWith("repair-agent")), false);
  assert.equal(response.result.steps.find((s: Json) => s.name === "review-agent").status, "PASS");
});

test("empty edits never reach verification and do not consume an attempt", async t => {
  const f = setup(t);
  await assert.rejects(f.validate(async () => { assert.fail("runner must not execute"); }), code("NO_CHANGES"));
  assert.equal(readJson(path.join(f.openRun, "workspace.json")).validations, 0);
  fs.writeFileSync(f.editFile, source.replaceAll("\n", "\r\n"));
  await assert.rejects(f.validate(async () => { assert.fail("format-only changes must not run tools"); }), code("NO_CHANGES"));
  assert.equal(readJson(path.join(f.openRun, "workspace.json")).validations, 0);
});

test("external DevEco HomeGraph cache is excluded while production changes remain verifiable", async t => {
  const f = setup(t);
  f.edit();
  writeText(path.join(f.opened.editDirectory, ".homegraph/runtime.db"), "disposable agent cache");
  const response = await f.validate(pass);
  assert.deepEqual(response.candidate.changes.map((change: Json) => change.relativePath), [name]);
  assert.equal(fs.existsSync(path.join(response.runDirectory, "backend/external-edits/.homegraph")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".homegraph")), false);
});

for (const mutation of ["test", "config", "delete"] as const) {
  test(`external validation rejects ${mutation} changes before running tools`, async t => {
    const f = setup(t);
    f.edit();
    if (mutation === "test") writeText(path.join(f.opened.editDirectory, "entry/src/test/Fake.test.ets"), "fake");
    if (mutation === "config") writeText(path.join(f.opened.editDirectory, "build-profile.json5"), "{}");
    if (mutation === "delete") fs.unlinkSync(f.editFile);
    await assert.rejects(f.validate(async () => { assert.fail("runner must not execute"); }), code("INVALID_INPUT"));
    assert.equal(readText(f.target), source);
  });
}

test("external validation rejects original, config, frozen plan and baseline drift", async t => {
  for (const mutation of ["original", "config", "plan", "baseline"]) {
    const f = setup(t);
    f.edit();
    if (mutation === "original") writeText(f.target, "user changes");
    if (mutation === "config") f.ctx.config.linterMode = "skip";
    if (mutation === "plan") writeJson(path.join(f.openRun, "backend/baseline-test-plan.json"), {});
    if (mutation === "baseline") writeText(path.join(f.prepareRun, "baseline", name), "changed");
    await assert.rejects(f.validate(pass), code(["original", "config"].includes(mutation) ? "BASELINE_CHANGED" : "CANDIDATE_CHANGED"));
  }
});

test("concurrent validation is rejected and edits during validation invalidate the result", async t => {
  const f = setup(t);
  f.edit();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const first = f.validate(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return pass(); });
  await ready;
  await assert.rejects(f.validate(pass), code("WORKSPACE_BUSY"));
  f.edit(3);
  release();
  await assert.rejects(first, code("WORKSPACE_CHANGED"));
  assert.equal(fs.existsSync(path.join(f.openRun, ".validate.lock")), false);
  assert.equal(readText(f.target), source);
});

test("verification cannot seal a candidate if the validator changes its source", async t => {
  const f = setup(t);
  f.edit();
  await assert.rejects(f.validate(async (_ctx, taskDir) => {
    const task = readJson(path.join(taskDir, "task.json"));
    writeText(path.join(task.project_root, name), "unexpected validator edit");
    return pass();
  }), code("WORKSPACE_CHANGED"));
});

test("verification cannot seal a candidate if frozen task evidence is modified", async t => {
  const f = setup(t);
  f.edit();
  await assert.rejects(f.validate(async (_ctx, taskDir) => {
    const task = readJson(path.join(taskDir, "task.json"));
    task.target.symbol = "other";
    writeJson(path.join(taskDir, "task.json"), task);
    return pass();
  }), code("CANDIDATE_CHANGED"));
});

test("repair attribution is available without a repair agent and stops after three repairs", async t => {
  const f = setup(t);
  const ids: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    f.edit(2 + attempt);
    const response = await f.validate(async () => ({ verdict: "FAIL", steps: [
      { name: "smell", status: "FAIL", duration_seconds: 0, reason: "remaining smell" },
    ] }));
    ids.push(response.candidate.candidateId);
    assert.equal(response.attempt, attempt);
    assert.equal(response.repairEligible, attempt < 3);
    assert.equal(readJson(path.join(response.runDirectory, "backend/failure-report.json")).repairable, true);
    if (attempt < 3) {
      assert.ok(fs.existsSync(response.repairPromptFile));
      assert.ok(readText(response.repairPromptFile).includes(f.opened.editDirectory));
    } else assert.equal(response.repairPromptFile, undefined);
  }
  assert.equal(new Set(ids).size, 4);
  await assert.rejects(f.validate(pass), code("REPAIR_LIMIT"));
  assert.equal(readText(f.target), source);
});

test("environment BLOCKED never offers external code repair or reuses an old repair prompt", async t => {
  const f = setup(t);
  f.edit();
  const response = await f.validate(async () => ({ verdict: "BLOCKED", steps: [
    { name: "build", status: "BLOCKED", duration_seconds: 0, reason: "SDK unavailable" },
  ] }));
  assert.equal(response.repairEligible, false);
  assert.equal(response.repairPromptFile, undefined);
  assert.equal(response.result.verdict, "BLOCKED");
});

test("frozen test relocation rejects changed tests and changed task identity", t => {
  const f = setup(t), sourceDir = path.join(f.openRun, "backend"),
    sourceRoot = readJson(path.join(sourceDir, "task.json")).project_root;
  const destinationDir = path.join(f.base, "relocated-task");
  copyArtifacts(sourceDir, destinationDir, path.dirname(sourceRoot), path.dirname(sourceRoot));
  const raw = readJson(path.join(destinationDir, "task.json"));
  raw.target.symbol = "other";
  writeJson(path.join(destinationDir, "task.json"), raw);
  assert.throws(() => relocateFrozenTestPlan(sourceDir, destinationDir, sourceRoot, sourceRoot), /TEST_PLAN_STALE/);
  copyArtifacts(sourceDir, destinationDir, path.dirname(sourceRoot), path.dirname(sourceRoot));
  writeText(path.join(sourceRoot, "entry/src/test/Original.test.ets"), "tampered");
  assert.throws(() => relocateFrozenTestPlan(sourceDir, destinationDir, sourceRoot, sourceRoot), /TEST_PLAN_STALE/);
});

test("junctions or symbolic links cannot redirect external edits", async t => {
  const f = setup(t), linked = path.join(f.opened.editDirectory, "entry/src/main/ets/link"), outside = path.join(f.base, "outside");
  fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("link creation is unavailable in this sandbox"); return; }
    throw error;
  }
  f.edit();
  await assert.rejects(f.validate(pass), code("PATH_OUTSIDE_ROOT"));
});
