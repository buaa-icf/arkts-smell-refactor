import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.js";
import type { Json } from "../src/models.js";
import { readJson, readText, writeJson, writeText } from "../src/utils.js";
import { loadConfig } from "../src/client/config.js";
import type { Candidate } from "../src/client/types.js";
import { applyCandidate, candidateDiff, recoverApplication } from "../src/client/apply.js";
import { BridgeContext } from "../src/ide/common.js";
import { normalizeIssues } from "../src/ide/scan.js";
import { checkCandidate, copyArtifacts, prepareCandidate, validateApplied, validateCandidate } from "../src/ide/candidates.js";
import { openWorkspace, validateWorkspace } from "../src/ide/external_workspace.js";
import { dispatch } from "../src/ide_bridge.js";
import { buildTestPlan } from "../src/test_plan.js";

const filename = "entry/src/main/ets/Page.ets";
const original = "export class Page {\n  work(): number { return 1; }\n  other(): number { return 9; }\n}\n";
const pass = async () => ({ verdict: "PASS", steps: [{ name: "review-agent", status: "PASS", duration_seconds: 0 }] });

async function setup(t: TestContext) {
  const base = fixture(t), root = path.join(base, "app"), target = path.join(root, filename);
  writeText(target, original);
  writeText(path.join(root, "build-profile.json5"), '{modules:[{name:"entry",srcPath:"entry"}]}');
  writeText(path.join(root, "hvigor/hvigor-config.json5"), "{}");
  for (const [suite, method] of [["Original", "work"], ["Other", "other"]])
    writeText(path.join(root, `entry/src/test/${suite}.test.ets`),
      `import { Page } from '../main/ets/Page';\nexport default function run() { describe('${suite}', () => {\n` +
      `let page: Page; beforeEach(() => { page = new Page(); }); it('case',0,()=>{page.${method}();}); }); }`);
  writeText(path.join(root, "entry/src/test/List.test.ets"),
    "import original from './Original.test'; import other from './Other.test'; original(); other();");
  const config = await loadConfig({ projectRoot: root, backend: path.join(base, "backend"), runs: path.join(base, "runs"),
    node: process.execPath, deveco: process.execPath, hvigor: process.execPath, ohpm: process.execPath, linter: process.execPath });
  const ctx = new BridgeContext(config, root, path.join(base, "scanner.cjs"), () => {});
  const issue = normalizeIssues({ filePath: filename, messages: [{ line: 2, rule: "@extrulesproject/long-method-check",
    message: "Method 'work' is too long" }] }, root)[0];
  const preparedRun = ctx.createRun("task.prepare");
  const prepared = prepareCandidate(ctx, { issue, scanScope: { scopePath: target } }, preparedRun);
  const openRun = ctx.createRun("task.openWorkspace");
  const workspace = openWorkspace(ctx, { taskHandle: prepared.taskHandle }, openRun);
  // Re-selecting tests against the edited name would lose the original work() test.
  writeText(path.join(workspace.editDirectory, filename), original.replace("work", "renamed"));
  const candidate = await validateWorkspace(ctx, { workspaceId: workspace.workspaceId }, ctx.createRun("task.validateWorkspace"), pass);
  const removeStage = (run: string) => {
    const stage = path.resolve(run, "staging"), relative = path.relative(base, stage);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(stage, { recursive: true, force: true });
  };
  return { base, root, target, config, ctx, preparedRun, prepared, openRun, candidate, removeStage };
}

test("archived staging retains restore, frozen test revalidation, application and rollback", async t => {
  const f = await setup(t);
  f.removeStage(f.preparedRun);
  f.removeStage(f.candidate.runDirectory);
  const restored = await dispatch(f.ctx, "candidate.restore", { candidateId: f.candidate.candidate.candidateId });
  assert.equal(restored.candidate.verdict, "PASS");
  assert.match(await candidateDiff(f.config, restored.candidate, filename), /renamed/);
  const rechecked = await validateCandidate(f.ctx, { candidateId: restored.candidate.candidateId },
    f.ctx.createRun("task.validateCandidate"), async (_ctx, taskDir) => {
      const task = readJson(path.join(taskDir, "task.json"));
      const selected = buildTestPlan(taskDir, task.project_root);
      assert.equal(selected.selectionBasis, "frozen-before-refactor");
      assert.deepEqual(selected.jobs.map((job: Json) => job.scope), ["Original"]);
      return pass();
    });
  assert.equal(fs.existsSync(path.join(f.preparedRun, "staging")), false);
  assert.equal(fs.existsSync(path.join(f.candidate.runDirectory, "staging")), false);
  f.removeStage(rechecked.runDirectory);
  const checked = checkCandidate(f.ctx, rechecked.candidate.candidateId);
  assert.equal((await applyCandidate(f.config, checked as Candidate)).state, "APPLIED");
  const applied = await validateApplied(f.ctx, { candidateId: checked.candidateId },
    f.ctx.createRun("task.validateApplied"), async (taskDir, task) => {
      const selected = buildTestPlan(taskDir, task.project_root);
      assert.equal(selected.selectionBasis, "frozen-before-refactor");
      assert.deepEqual(selected.jobs.map((job: Json) => job.scope), ["Original"]);
      return ["smell", "build", "test", "linter"].map(name => ({ name, status: "PASS", duration_seconds: 0 }));
    });
  assert.equal(applied.result.verdict, "PASS");
  assert.equal(fs.existsSync(path.join(rechecked.runDirectory, "staging")), false);
  assert.equal((await recoverApplication(f.config, checked as Candidate)).state, "ROLLED_BACK");
  assert.equal(readText(f.target), original);
});

test("missing staging never bypasses frozen task or baseline tampering", async t => {
  const f = await setup(t);
  f.removeStage(f.preparedRun);
  f.removeStage(f.candidate.runDirectory);
  const frozenFile = path.join(f.candidate.runDirectory, "backend/baseline-test-plan.json");
  const frozen = readJson(frozenFile);
  writeJson(frozenFile, { ...frozen, taskSha256: "0".repeat(64) });
  await assert.rejects(validateCandidate(f.ctx, { candidateId: f.candidate.candidate.candidateId },
    f.ctx.createRun("task.validateCandidate"), pass), /TEST_PLAN_STALE/);
  const firstTest = Object.keys(frozen.testHashes)[0];
  assert.ok(firstTest);
  writeJson(frozenFile, { ...frozen, testHashes: { ...frozen.testHashes, [firstTest]: "0".repeat(64) } });
  await assert.rejects(validateCandidate(f.ctx, { candidateId: f.candidate.candidate.candidateId },
    f.ctx.createRun("task.validateCandidate"), pass), /TEST_PLAN_STALE/);
  writeJson(frozenFile, frozen);
  writeText(path.join(f.preparedRun, "baseline", filename), "tampered baseline");
  await assert.rejects(validateCandidate(f.ctx, { candidateId: f.candidate.candidate.candidateId },
    f.ctx.createRun("task.validateCandidate"), pass), /冻结基线已变化/);
});

test("existing staging tests remain checked even when a verified reconstruction is supplied", async t => {
  const f = await setup(t);
  const originalStage = path.join(f.candidate.runDirectory, "staging", path.basename(f.root));
  writeText(path.join(originalStage, "entry/src/test/Original.test.ets"), "tampered test");
  await assert.rejects(validateCandidate(f.ctx, { candidateId: f.candidate.candidate.candidateId },
    f.ctx.createRun("task.validateCandidate"), pass), /TEST_PLAN_STALE/);
});

test("artifact fallback rejects a reconstruction that does not match its manifest", async t => {
  const f = await setup(t);
  f.removeStage(f.preparedRun);
  assert.throws(() => copyArtifacts(path.join(f.preparedRun, "backend"), path.join(f.base, "artifact-copy"),
    path.join(f.preparedRun, "staging"), path.join(f.base, "destination"),
    { root: f.root, files: {} }), /重建工程与冻结清单不同/);
});
