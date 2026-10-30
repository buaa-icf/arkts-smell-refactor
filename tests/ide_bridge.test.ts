import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, goodConfig, spec } from "./helpers.js";
import { readJson, writeJson, writeText, hash } from "../src/utils.js";
import { which } from "../src/process.js";
import {
  BridgeContext,
  BridgeError,
  configurationDigest,
  inspectEnvironment,
  loadRun,
  safePath,
  snapshot,
} from "../src/ide/common.js";
import {
  normalizeIssues,
  scan,
  scopeRuleIgnores,
  smellCandidateGate,
} from "../src/ide/scan.js";
import {
  prepareCandidate,
  executeCandidate,
  validateCandidate,
  checkCandidate,
  runPipelineLogged,
  validateApplied,
} from "../src/ide/candidates.js";
import { serveRequest } from "../src/ide_bridge.js";
import {
  normalizeScanScope,
  preparedScanScope,
} from "../src/ide/scan_scope.js";
import type { Json } from "../src/models.js";

const backend = path.resolve(".");
const launcher = path.join(
  backend,
  "deveco-plugin/src/main/resources/bridge/ide_bridge.cjs",
);
function setup(t: TestContext) {
  const base = fixture(t),
    root = path.join(base, "中文 工程"),
    target = path.join(root, "entry/src/main/ets/Page.ets");
  writeText(target, "export class Page {\n  update() { return 1; }\n}\n");
  writeText(path.join(root, "hvigor/hvigor-config.json5"), "{}");
  writeText(
    path.join(root, "build-profile.json5"),
    '{modules:[{name:"entry",srcPath:"entry"}]}',
  );
  const homecheck = path.join(base, "homecheck"),
    studio = path.join(base, "studio");
  writeText(path.join(homecheck, "node_modules/homecheck/lib/run.js"), "");
  writeText(path.join(homecheck, "extrulesproject-1.0.0.tgz"), "fixture");
  writeJson(path.join(homecheck, "config/projectConfig.json"), {});
  writeJson(path.join(homecheck, "config/ruleConfig.json"), {});
  fs.mkdirSync(path.join(studio, "sdk/default/openharmony/ets"), {
    recursive: true,
  });
  const config = {
    backend,
    homecheck,
    studio,
    runs: path.join(base, "runs"),
    node: process.execPath,
    deveco: process.execPath,
    hvigor: process.execPath,
    ohpm: process.execPath,
    linter: process.execPath,
    linterMode: "required",
  };
  const events: Json[] = [],
    scanner = path.join(base, "fake-scanner.cjs");
  const ctx = new BridgeContext(config, root, scanner, (e) => events.push(e));
  const record = {
    filePath: "entry/src/main/ets/Page.ets",
    messages: [
      {
        line: 2,
        rule: "@extrulesproject/long-method-check",
        message: "Method 'update' is too long",
      },
    ],
  };
  return { base, root, target, config, ctx, record, events, scanner };
}
const code = (expected: string) => (e: unknown) =>
  e instanceof BridgeError && e.code === expected;

test(
  "Windows resolves npm CMD shim before extensionless Unix script",
  { skip: process.platform !== "win32" },
  (t) => {
    const base = fixture(t),
      command = path.join(base, "sample");
    writeText(command, "#!/bin/sh\n");
    writeText(command + ".CMD", "@exit /b 0");
    assert.equal(which(command), command + ".CMD");
    const old = process.env.PATH;
    t.after(() => {
      process.env.PATH = old;
    });
    process.env.PATH = base;
    assert.equal(which("sample"), command + ".CMD");
  },
);
test("bridge import expands messages with unique identities and UTF-8 paths", (t) => {
  const f = setup(t);
  f.record.messages.push({ ...f.record.messages[0] });
  const issues = normalizeIssues(f.record, f.root);
  assert.equal(issues.length, 2);
  assert.notEqual(issues[0].issueId, issues[1].issueId);
  assert.equal(issues[0].absolutePath, f.target);
  assert.equal(issues[0].sourceSha256, hash(f.target));
});
test("bridge distinguishes empty, invalid, unsupported and test reports", (t) => {
  const f = setup(t);
  assert.deepEqual(normalizeIssues([], f.root), []);
  assert.throws(
    () => normalizeIssues({ filePath: f.target }, f.root),
    code("INVALID_INPUT"),
  );
  assert.equal(
    normalizeIssues(
      {
        ...f.record,
        messages: [{ ...f.record.messages[0], rule: "formal/god-class" }],
      },
      f.root,
    )[0].supported,
    false,
  );
  const file = path.join(f.root, "entry/src/test/Page.test.ets");
  writeText(file, "class Test {}");
  assert.equal(
    normalizeIssues({ ...f.record, filePath: file }, f.root)[0].supported,
    false,
  );
});
test("bridge rejects traversal, external roots and nested run storage", (t) => {
  const f = setup(t);
  assert.throws(
    () => normalizeIssues({ ...f.record, filePath: "../outside.ets" }, f.root),
    code("PATH_OUTSIDE_ROOT"),
  );
  assert.throws(() => safePath(f.root, f.base), code("PATH_OUTSIDE_ROOT"));
  assert.throws(
    () =>
      new BridgeContext(
        { ...f.config, runs: path.join(f.root, "runs") },
        f.root,
        f.scanner,
      ).createRun("scan.start"),
    code("INVALID_INPUT"),
  );
  assert.throws(
    () => loadRun(f.ctx, "../bad", "candidate.json"),
    code("INVALID_REQUEST"),
  );
});
test("bridge retains clone counterpart hash and marks test counterparts read-only", (t) => {
  const f = setup(t),
    other = path.join(f.root, "entry/src/main/ets/Other.ets");
  writeText(other, "class Other {}");
  const message =
    "Code Clone: Page.ets:1-2 is similar to entry/src/main/ets/Other.ets:1-2.";
  const issue = normalizeIssues(
    {
      ...f.record,
      messages: [
        {
          ...f.record.messages[0],
          rule: "@extrulesproject/code-clone-fragment-check",
          message,
        },
      ],
    },
    f.root,
  )[0];
  assert.equal(issue.relatedTargets[0].filePath, other);
  assert.equal(issue.relatedTargets[0].sourceSha256, hash(other));
});
test("bridge required/skip policy changes only linter requirement", (t) => {
  const f = setup(t),
    config = { ...f.config, linter: path.join(f.base, "missing.exe") };
  assert.equal(inspectEnvironment(config).canDetect, true);
  assert.equal(inspectEnvironment(config).canRefactor, false);
  const skipped = inspectEnvironment({ ...config, linterMode: "skip" });
  assert.equal(skipped.canRefactor, true);
  assert.equal(
    skipped.tools.find((r: Json) => r.name === "codelinter").required,
    false,
  );
  assert.notEqual(
    skipped.tools.find((r: Json) => r.name === "HomeCheck").path,
    f.config.homecheck,
  );
  fs.rmdirSync(path.join(f.config.studio, "sdk/default/openharmony/ets"));
  assert.equal(
    inspectEnvironment({ ...config, linterMode: "skip" }).canDetect,
    false,
  );
});
test("real Node bootstrap returns correlated UTF-8 JSONL without Python", (t) => {
  const f = setup(t),
    request = {
      protocolVersion: 1,
      requestId: "中文请求",
      method: "issues.import",
      projectRoot: f.root,
      config: f.config,
      params: { records: f.record },
    };
  const child = spawnSync(process.execPath, [launcher], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  const response = JSON.parse(child.stdout.trim());
  assert.equal(response.requestId, request.requestId);
  assert.equal(response.result.issues[0].absolutePath, f.target);
});
for (const [name, request, expected] of [
  ["protocol", { protocolVersion: 2 }, "UNSUPPORTED_PROTOCOL"],
  [
    "backend",
    {
      protocolVersion: 1,
      requestId: "x",
      config: { backend: "missing-backend" },
    },
    "TOOL_UNAVAILABLE",
  ],
] as const)
  test("Node bootstrap reports " + name + " errors structurally", () => {
    const child = spawnSync(process.execPath, [launcher], {
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(child.status, 2);
    const r = JSON.parse(child.stdout.trim());
    assert.equal(r.error.code, expected);
  });
test("bridge hello and invalid request preserve protocol response", async (t) => {
  const f = setup(t),
    output: Json[] = [];
  const req = {
    protocolVersion: 1,
    requestId: "hello",
    method: "session.hello",
    projectRoot: f.root,
    config: f.config,
  };
  assert.equal(
    await serveRequest(req, {
      scanner: f.scanner,
      output: (e) => output.push(e),
    }),
    0,
  );
  assert.equal(output[0].result.backendLanguage, "typescript");
  assert.equal(
    await serveRequest(
      { ...req, config: { ...f.config, linterMode: "wrong" } },
      { scanner: f.scanner, output: (e) => output.push(e) },
    ),
    2,
  );
  assert.equal(output.at(-1)!.error.code, "INVALID_INPUT");
});
test("relative HomeCheck ignores are anchored to source instead of task build parent", (t) => {
  const f = setup(t),
    result = scopeRuleIgnores(
      {
        ignore: ["build/**"],
        overrides: [{ excluded: ["entry/src/test/**"] }],
      },
      f.root,
    );
  assert.equal(result.ignore[0], f.root.replaceAll("\\", "/") + "/build/**");
  assert.ok(
    result.overrides[0].excluded[0].startsWith(f.root.replaceAll("\\", "/")),
  );
});

function scannerFixture(f: ReturnType<typeof setup>, scenario: string) {
  writeText(
    f.scanner,
    `const fs=require('node:fs'),path=require('node:path');
const [home,project,rules,summary]=process.argv.slice(2);
const p=JSON.parse(fs.readFileSync(project,'utf8')),r=JSON.parse(fs.readFileSync(rules,'utf8'));
const selected=Object.keys(r.extRuleSet[0].extRules), mode=${JSON.stringify(scenario)};
fs.mkdirSync(path.dirname(summary),{recursive:true});
fs.writeFileSync(summary,JSON.stringify({runner:'direct-homecheck',success:mode!=='failed-summary',requestedRules:selected,loadedRules:mode==='unloaded'?[]:selected}));
fs.writeFileSync(path.join(path.dirname(summary),'issuesReport.json'),JSON.stringify(mode==='remaining'?[{filePath:p.checkFiles[0],messages:[{line:2,rule:selected[0],message:"Method 'update' is too long"}]}]:[]));
fs.writeFileSync(path.join(path.dirname(summary),'HomeCheck.log'),
(mode==='exception'?'[ERROR] [HomeCheck] checker failed\\n':'')+
'[CheckEntry] File count: '+(mode==='partial'?0:p.checkFiles.length)+'\\n'+
(mode==='incomplete'?'':'[Main] Checking completed.\\n'));
console.log('中文检测日志');
`,
  );
}
for (const scenario of [
  "success",
  "failed-summary",
  "unloaded",
  "exception",
  "partial",
  "incomplete",
])
  test("direct scan validates actual completion: " + scenario, async (t) => {
    const f = setup(t);
    scannerFixture(f, scenario);
    const run = f.ctx.createRun("scan.start");
    const promise = scan(f.ctx, { scopePath: f.target }, run);
    if (scenario === "success") {
      const result = await promise;
      assert.deepEqual(result.issues, []);
      assert.deepEqual(result.scannedFiles, [f.target]);
      assert.ok(
        f.events.some(
          (e) =>
            e.event === "log.appended" && e.data.text.includes("中文检测日志"),
        ),
      );
    } else await assert.rejects(promise, code("TOOL_UNAVAILABLE"));
    assert.equal(
      readJson(path.join(run, "project.json")).checkFiles[0],
      "entry/src/main/ets/Page.ets",
    );
  });

function prepare(f: ReturnType<typeof setup>, scanScope?: Json) {
  const run = f.ctx.createRun("task.prepare"),
    issue = normalizeIssues(f.record, f.root)[0];
  return {
    run,
    prepared: prepareCandidate(
      f.ctx,
      {
        issue,
        instructions: "keep public entry",
        ...(scanScope ? { scanScope } : {}),
      },
      run,
    ),
  };
}
async function candidate(f: ReturnType<typeof setup>, scanScope?: Json) {
  const p = prepare(f, scanScope),
    run = f.ctx.createRun("task.execute");
  const response = await executeCandidate(
    f.ctx,
    { taskHandle: p.prepared.taskHandle },
    run,
    async (_ctx, dir, plan) => {
      const task = readJson(path.join(dir, "task.json"));
      assert.notEqual(task.project_root, f.root);
      assert.ok(task.project_root.startsWith(run));
      assert.ok(Array.isArray(plan.gates!.smell.command));
      writeText(
        path.join(task.project_root, "entry/src/main/ets/Page.ets"),
        "export class Page {\n update() { return this.value(); }\n value() { return 1; }\n}\n",
      );
      writeJson(path.join(dir, "refactor-changes.json"), {
        changedProductionFiles: ["entry/src/main/ets/Page.ets"],
      });
      return { verdict: "PASS", steps: [], repairAttempts: 0 };
    },
  );
  return { p, run, response };
}
test("candidate freezes before/after and leaves original and tests untouched", async (t) => {
  const f = setup(t);
  writeText(path.join(f.root, "entry/src/test/Page.test.ets"), "test fixture");
  const before = snapshot(f.root);
  const { response, run } = await candidate(f);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(response.candidate.verdict, "PASS");
  assert.equal(response.candidate.changes.length, 1);
  assert.equal(
    hash(path.join(run, "content/after/entry/src/main/ets/Page.ets")),
    response.candidate.changes[0].afterSha256,
  );
  assert.equal(
    checkCandidate(f.ctx, response.candidate.candidateId).verdict,
    "PASS",
  );
});
test("baseline/config changes prevent executing Agent", async (t) => {
  const f = setup(t),
    p = prepare(f);
  writeText(path.join(f.root, "build-profile.json5"), "user change");
  let called = false;
  await assert.rejects(
    executeCandidate(
      f.ctx,
      { taskHandle: p.prepared.taskHandle },
      f.ctx.createRun("task.execute"),
      async () => {
        called = true;
        return {};
      },
    ),
    code("BASELINE_CHANGED"),
  );
  assert.equal(called, false);
});
test("candidate deletion and non-production edits are rejected", async (t) => {
  for (const deletion of [true, false]) {
    const f = setup(t),
      p = prepare(f);
    await assert.rejects(
      executeCandidate(
        f.ctx,
        { taskHandle: p.prepared.taskHandle },
        f.ctx.createRun("task.execute"),
        async (_ctx, dir) => {
          const stage = readJson(path.join(dir, "task.json")).project_root;
          if (deletion)
            fs.unlinkSync(path.join(stage, "entry/src/main/ets/Page.ets"));
          else writeText(path.join(stage, "build-profile.json5"), "changed");
          return { verdict: "PASS", steps: [] };
        },
      ),
      code("INVALID_INPUT"),
    );
    assert.ok(fs.existsSync(f.target));
  }
});
test("frozen content tampering cannot pass application check", async (t) => {
  const f = setup(t),
    c = await candidate(f);
  writeText(
    path.join(c.run, "content/after/entry/src/main/ets/Page.ets"),
    "tampered",
  );
  assert.throws(
    () => checkCandidate(f.ctx, c.response.candidate.candidateId),
    code("CANDIDATE_CHANGED"),
  );
});
test("candidate revalidation runs gates/review but no refactor or repair Agent", async (t) => {
  const f = setup(t),
    c = await candidate(f);
  const before = snapshot(f.root),
    run = f.ctx.createRun("task.validateCandidate");
  const result = await validateCandidate(
    f.ctx,
    { candidateId: c.response.candidate.candidateId },
    run,
    async (_ctx, dir, plan) => {
      assert.equal(plan.refactorAgent, undefined);
      assert.equal(plan.repairAgent, undefined);
      assert.equal(plan.maxRepairAttempts, 0);
      assert.ok(plan.reviewAgent);
      assert.equal(
        readJson(path.join(dir, "task.json")).project_root,
        path.join(run, "staging", path.basename(f.root)),
      );
      return { verdict: "PASS", steps: [] };
    },
  );
  assert.equal(result.candidate.verdict, "PASS");
  assert.deepEqual(result.candidate.scanScope, c.response.candidate.scanScope);
  assert.deepEqual(snapshot(f.root), before);
});
test("config digest detects policy changes but ignores obsolete Python executable", (t) => {
  const f = setup(t),
    digest = configurationDigest(f.ctx);
  f.ctx.config.linterMode = "skip";
  assert.notEqual(configurationDigest(f.ctx), digest);
  f.ctx.config.linterMode = "required";
  (f.ctx.config as Json).python = "obsolete";
  assert.equal(configurationDigest(f.ctx), digest);
});
test("smell candidate gate distinguishes remaining smell from tool failure without stale evidence", async (t) => {
  const f = setup(t),
    p = prepare(f),
    dir = path.join(p.run, "backend"),
    stage = readJson(path.join(dir, "task.json")).project_root;
  const oldLog = console.log,
    oldError = console.error;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = oldLog;
    console.error = oldError;
  });
  const ctx = new BridgeContext(f.config, stage, f.scanner, () => {});
  scannerFixture(f, "remaining");
  assert.equal(await smellCandidateGate(ctx, dir, stage), 1);
  assert.equal(readJson(path.join(dir, "smell-after.json")).length, 1);
  scannerFixture(f, "failed-summary");
  assert.equal(await smellCandidateGate(ctx, dir, stage), 3);
  assert.equal(fs.existsSync(path.join(dir, "smell-after.json")), false);
  scannerFixture(f, "success");
  assert.equal(await smellCandidateGate(ctx, dir, stage), 0);
});
test("actual candidate runner orchestrates controlled child tools, progress and review in staging only", async (t) => {
  const f = setup(t),
    p = prepare(f),
    run = f.ctx.createRun("task.execute"),
    before = snapshot(f.root);
  const response = await executeCandidate(
    f.ctx,
    { taskHandle: p.prepared.taskHandle },
    run,
    async (ctx, dir) => {
      const stage = readJson(path.join(dir, "task.json")).project_root,
        config = goodConfig();
      config.refactorAgent = spec(
        `require('node:fs').writeFileSync(${JSON.stringify(path.join(stage, "entry/src/main/ets/Page.ets"))},'export class Page { update() { return 2; } }');console.log('agent done');`,
      );
      return runPipelineLogged(ctx, dir, config);
    },
  );
  assert.equal(response.candidate.verdict, "PASS");
  assert.deepEqual(snapshot(f.root), before);
  assert.ok(
    response.result.steps.some(
      (s: Json) => s.name === "review-agent" && s.status === "PASS",
    ),
  );
  assert.ok(f.events.some((e) => e.event === "step.updated"));
  assert.ok(
    f.events.some(
      (e) => e.event === "log.appended" && e.data.text.includes("agent done"),
    ),
  );
});
test("applied validation rejects changed content before starting tools", async (t) => {
  const f = setup(t),
    c = await candidate(f);
  await assert.rejects(
    validateApplied(
      f.ctx,
      { candidateId: c.response.candidate.candidateId },
      f.ctx.createRun("task.validateApplied"),
    ),
    code("BASELINE_CHANGED"),
  );
});
test("prepare rejects stale target bytes before running risk analysis", (t) => {
  const f = setup(t),
    issue = normalizeIssues(f.record, f.root)[0];
  writeText(f.target, "changed source");
  assert.throws(
    () => prepareCandidate(f.ctx, { issue }, f.ctx.createRun("task.prepare")),
    code("BASELINE_CHANGED"),
  );
});
test("nonexistent UUID history is artifact-unavailable rather than an internal error", (t) => {
  const f = setup(t);
  f.ctx.createRun("history.fixture");
  assert.throws(
    () =>
      loadRun(f.ctx, "00000000-0000-0000-0000-000000000000", "candidate.json"),
    code("ARTIFACT_UNAVAILABLE"),
  );
});

for (const kind of [
  "file",
  "directory",
  "project",
  "report-files",
  "legacy",
] as const) {
  test(`applied validation retains ${kind} scan scope and full engineering context`, async (t) => {
    const f = setup(t);
    const unrelated = path.join(f.root, "feature/other/src/main/ets/Other.ets");
    writeText(unrelated, "export class Other {}");
    const scope =
      kind === "directory"
        ? {
            scopePath: path.dirname(f.target),
            rules: ["@extrulesproject/long-method-check"],
          }
        : kind === "project"
          ? { scopePath: f.root }
          : kind === "report-files"
            ? { scopePath: f.root, files: [f.target] }
            : { scopePath: f.target };
    const c = await candidate(f, scope);
    assert.deepEqual(c.p.prepared.scanScope, scope);
    assert.deepEqual(c.response.candidate.scanScope, scope);
    if (kind === "legacy") {
      delete c.response.candidate.scanScope;
      delete c.p.prepared.scanScope;
      writeJson(path.join(c.run, "candidate.json"), c.response.candidate);
      writeJson(path.join(c.p.run, "prepared.json"), c.p.prepared);
    }
    fs.copyFileSync(
      path.join(c.run, "content/after/entry/src/main/ets/Page.ets"),
      f.target,
    );
    const run = f.ctx.createRun("task.validateApplied");
    const result = await validateApplied(
      f.ctx,
      { candidateId: c.response.candidate.candidateId },
      run,
      async (_dir, task) => {
        assert.ok(
          fs.existsSync(
            path.join(task.project_root, path.relative(f.root, unrelated)),
          ),
        );
        return ["smell", "build", "contract", "test", "linter"].map((name) => ({
          name,
          status: "PASS",
          duration_seconds: 0,
        }));
      },
    );
    assert.equal(result.result.verdict, "PASS");
    assert.deepEqual(result.scanScope, scope);
    scannerFixture(f, "success");
    const refreshed = await scan(f.ctx, result.scanScope, run);
    assert.deepEqual(
      refreshed.scannedFiles,
      kind === "project" ? [f.target, unrelated] : [f.target],
    );
    assert.deepEqual(
      readJson(path.join(run, "project.json")).checkFiles,
      refreshed.scannedFiles.map((file: string) =>
        path.relative(f.root, file).replaceAll("\\", "/"),
      ),
    );
  });
}

test("scope rejects outside paths, empty file sets, unsupported rules and unknown legacy targets", (t) => {
  const f = setup(t);
  const outside = path.join(f.base, "Outside.ets");
  writeText(outside, "class Outside {}");
  for (const value of [
    { scopePath: outside },
    { scopePath: f.root, files: [outside] },
    { scopePath: f.root, files: [] },
    { scopePath: f.root, rules: ["custom/rule"] },
  ]) {
    assert.throws(
      () => normalizeScanScope(f.ctx, value),
      (error) => error instanceof BridgeError,
    );
  }
  assert.throws(() => preparedScanScope(f.ctx, {}), /缺少异味检测范围/);
});
