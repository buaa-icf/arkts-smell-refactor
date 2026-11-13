import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runSkill } from "../src/skill.js";
import { loadConfig, type PluginConfig } from "../src/client/config.js";
import type {
  Backend,
  BridgeMethods,
  Candidate,
  Issue,
  ScanScope,
} from "../src/client/types.js";
import type { Json } from "../src/models.js";
import { fixture } from "./helpers.js";
import { hash, readJson, writeJson, writeText } from "../src/utils.js";

function setup(t: TestContext) {
  const base = fixture(t);
  const project = path.join(base, "中文 Skill Project");
  const name = "entry/src/main/ets/Page.ets";
  const target = path.join(project, name);
  const before = "export class Page {\n  update() { return 1; }\n}\n";
  writeText(target, before);
  writeText(
    path.join(project, "build-profile.json5"),
    "{modules:[{name:'entry',srcPath:'entry'}]}",
  );
  writeText(path.join(project, "hvigor/hvigor-config.json5"), "{}");
  const config = path.join(base, "settings.json");
  const runs = path.join(base, "runs");
  writeJson(config, {
    projectRoot: project,
    backend: path.resolve("."),
    runs,
    node: process.execPath,
    timeoutMs: 30_000,
  });
  const report = path.join(base, "report.json");
  const message = {
    line: 2,
    rangeStart: 2,
    rangeEnd: 2,
    rule: "@extrulesproject/long-method-check",
    message: "Method 'update' is too long",
  };
  writeJson(report, { filePath: name, messages: [message] });
  const issue: Issue = {
    issueId: randomUUID(),
    filePath: name,
    absolutePath: target,
    rule: message.rule,
    smellType: "long-method",
    message: message.message,
    symbol: "update",
    startLine: 2,
    endLine: 2,
    supported: true,
    sourceSha256: hash(target),
    rawMessage: message,
    relatedTargets: [],
    commitHash: "",
  };
  return { base, project, name, target, before, config, runs, report, issue };
}

function fakeBackend(
  handler: (
    method: keyof BridgeMethods,
    params: Record<string, unknown>,
  ) => unknown,
): Backend {
  return {
    request: async (method, params = {}) => handler(method, params) as never,
  };
}

test("skill delegates external workspace creation and validation without executing an inner refactor", async t => {
  const f = setup(t), calls: string[] = [];
  const backend = () => fakeBackend((method, params) => {
    calls.push(method);
    if (method === "task.openWorkspace") {
      assert.equal(params.taskHandle, "task-1");
      return { workspaceId: "work-1", taskHandle: "task-1", editDirectory: "edit", promptFile: "prompt", runDirectory: "run" };
    }
    assert.equal(method, "task.validateWorkspace");
    assert.equal(params.workspaceId, "work-1");
    return { result: { verdict: "BLOCKED" }, workspaceId: "work-1", attempt: 0, repairEligible: false };
  });
  const opened = await invoke(["open-workspace", "--config", f.config, "--task", "task-1"], backend);
  assert.equal(opened.code, 0);
  assert.equal(opened.value.result.workspaceId, "work-1");
  const validated = await invoke(["validate-workspace", "--config", f.config, "--workspace", "work-1"], backend);
  assert.equal(validated.code, 3);
  assert.equal(validated.value.result.repairEligible, false);
  assert.deepEqual(calls, ["task.openWorkspace", "task.validateWorkspace"]);
});

async function invoke(
  args: string[],
  backend?: (config: PluginConfig) => Backend,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runSkill(args, {
    directory: path.resolve("."),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...(backend ? { backend } : {}),
  });
  const lines = stdout.join("").trim().split(/\r?\n/);
  assert.equal(
    lines.length,
    1,
    "stdout must contain exactly one JSON envelope",
  );
  return { code, value: JSON.parse(lines[0]!) as Json, stderr };
}

test("skill imports a report and prepares from durable evidence across calls using the real bridge", async (t) => {
  const f = setup(t);
  const other = path.join(f.project, "entry/src/main/ets/Other.ets");
  writeText(other, "export class Other { update() { return 2; } }\n");
  const record = readJson(f.report);
  writeJson(f.report, [
    record,
    { ...record, filePath: "entry/src/main/ets/Other.ets" },
  ]);

  const imported = await invoke([
    "import",
    "--config",
    f.config,
    "--file",
    f.report,
  ]);
  assert.equal(imported.code, 0);
  assert.equal(imported.value.schemaVersion, 1);
  assert.equal(imported.value.ok, true);
  assert.equal(imported.value.projectRoot, fs.realpathSync(f.project));
  assert.equal(imported.value.result.issues.length, 2);
  assert.deepEqual(readJson(imported.value.responseFile), imported.value);
  assert.deepEqual(imported.value.scanScope.files, [f.target, other]);
  const issue = imported.value.result.issues[0];
  assert.equal(issue.sourceSha256, hash(f.target));

  const instructions = path.join(f.base, "业务约束.txt");
  writeText(instructions, "保留 update 的公开接口和返回值。\n");
  const prepared = await invoke([
    "prepare",
    "--config",
    f.config,
    "--from",
    imported.value.responseFile,
    "--issue",
    issue.issueId,
    "--instructions-file",
    instructions,
  ]);
  assert.equal(prepared.code, 0, JSON.stringify(prepared.value));
  assert.equal(prepared.value.ok, true);
  assert.equal(prepared.value.result.issue.issueId, issue.issueId);
  assert.equal(prepared.value.result.issue.sourceSha256, issue.sourceSha256);
  assert.equal(
    prepared.value.result.instructions,
    fs.readFileSync(instructions, "utf8"),
  );
  assert.ok(prepared.value.result.taskHandle);
  assert.ok(prepared.value.result.risk);
  assert.deepEqual(prepared.value.result.scanScope, imported.value.scanScope);
  assert.deepEqual(readJson(prepared.value.responseFile), prepared.value);
  assert.notEqual(prepared.value.responseFile, imported.value.responseFile);
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
  assert.ok(
    prepared.stderr.length > 0,
    "backend progress must be kept separate from stdout JSON",
  );
});

test("skill refuses stale imported bytes instead of reimporting the report during prepare", async (t) => {
  const f = setup(t);
  const imported = await invoke([
    "import",
    "--config",
    f.config,
    "--file",
    f.report,
  ]);
  assert.equal(imported.code, 0);
  const originalHash = imported.value.result.issues[0].sourceSha256;
  const changed = f.before.replace("return 1", "return 9");
  writeText(f.target, changed);
  const prepared = await invoke([
    "prepare",
    "--config",
    f.config,
    "--from",
    imported.value.responseFile,
    "--issue",
    imported.value.result.issues[0].issueId,
  ]);
  assert.equal(prepared.code, 2);
  assert.equal(prepared.value.ok, false);
  assert.equal(prepared.value.error.code, "BASELINE_CHANGED");
  assert.equal(
    readJson(imported.value.responseFile).result.issues[0].sourceSha256,
    originalHash,
  );
  assert.equal(fs.readFileSync(f.target, "utf8"), changed);
});

test("skill requires matching candidate confirmation before creating an apply or rollback backend", async (t) => {
  const f = setup(t);
  let created = 0;
  const backend = () => {
    created++;
    return fakeBackend(() => {
      throw new Error("mutation backend must not be reached");
    });
  };
  for (const command of ["apply", "rollback"]) {
    for (const confirmation of [[], ["--confirm", randomUUID()]]) {
      const response = await invoke(
        [
          command,
          "--config",
          f.config,
          "--candidate",
          randomUUID(),
          ...confirmation,
        ],
        backend,
      );
      assert.equal(response.code, 2);
      assert.equal(response.value.ok, false);
      assert.equal(response.value.error.code, "INVALID_INPUT");
    }
  }
  assert.equal(created, 0);
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
});

for (const kind of ["file", "directory"] as const) {
  test(`skill preserves a ${kind} scan scope across calls without contaminating backend configuration`, async (t) => {
    const f = setup(t);
    const scopePath = kind === "file" ? f.target : path.dirname(f.target);
    const scope: ScanScope = { scopePath, rules: [f.issue.rule] };
    const configs: PluginConfig[] = [];
    const requests: {
      method: keyof BridgeMethods;
      params: Record<string, unknown>;
    }[] = [];
    const backend = (config: PluginConfig) => {
      configs.push(structuredClone(config));
      return fakeBackend((method, params) => {
        requests.push({ method, params });
        if (method === "scan.start")
          return {
            issues: [f.issue],
            runDirectory: path.join(f.runs, randomUUID()),
            ...scope,
            scannedFiles: [f.target],
          };
        if (method === "task.prepare")
          return {
            taskHandle: randomUUID(),
            taskId: "long-method-0001-update",
            originalRoot: f.project,
            baselineFiles: { [f.name]: f.issue.sourceSha256 },
            risk: { riskLevel: "medium" },
            issue: params.issue,
            instructions: params.instructions,
            scanScope: params.scanScope,
            runDirectory: path.join(f.runs, randomUUID()),
          };
        throw new Error(`unexpected method ${method}`);
      });
    };
    const globals = [
      "--project",
      f.project,
      "--backend",
      path.resolve("."),
      "--runs",
      f.runs,
    ];
    const scanned = await invoke(
      ["scan", ...globals, "--scope", scopePath],
      backend,
    );
    assert.equal(scanned.code, 0, JSON.stringify(scanned.value));
    const prepared = await invoke(
      [
        "prepare",
        ...globals,
        "--from",
        scanned.value.responseFile,
        "--issue",
        f.issue.issueId,
      ],
      backend,
    );
    assert.equal(prepared.code, 0, JSON.stringify(prepared.value));
    assert.deepEqual(
      requests.map((entry) => entry.method),
      ["scan.start", "task.prepare"],
    );
    assert.deepEqual(requests[0].params, { scopePath });
    assert.deepEqual(requests[1].params.scanScope, scope);
    assert.deepEqual(prepared.value.scanScope, scope);
    assert.equal(
      "files" in prepared.value.scanScope,
      false,
      "directory scans must retain their scope instead of freezing scannedFiles",
    );
    assert.deepEqual(
      configs[0],
      configs[1],
      "per-command options must not invalidate configurationDigest",
    );
    for (const field of ["scope", "from", "issue", "command", "responseFile"])
      assert.equal(Object.hasOwn(configs[0], field), false);
  });
}

test("skill rejects another project's stored issue selection before preparing a task", async (t) => {
  const f = setup(t);
  const imported = await invoke([
    "import",
    "--config",
    f.config,
    "--file",
    f.report,
  ]);
  assert.equal(imported.code, 0);
  const otherProject = path.join(f.base, "Different Project");
  fs.mkdirSync(otherProject);
  let requests = 0;
  const response = await invoke(
    [
      "prepare",
      "--config",
      f.config,
      "--project",
      otherProject,
      "--from",
      imported.value.responseFile,
      "--issue",
      imported.value.result.issues[0].issueId,
    ],
    () =>
      fakeBackend(() => {
        requests++;
        throw new Error("must reject before task.prepare");
      }),
  );
  assert.equal(response.code, 2);
  assert.equal(response.value.ok, false);
  assert.equal(response.value.error.code, "INVALID_INPUT");
  assert.equal(requests, 0);
});

test("skill retains a completed BLOCKED candidate as structured evidence with a non-success exit code", async (t) => {
  const f = setup(t);
  const result = {
    candidate: { candidateId: randomUUID(), verdict: "BLOCKED", changes: [] },
    result: {
      verdict: "BLOCKED",
      steps: [{ name: "build", status: "BLOCKED", reason: "SDK unavailable" }],
    },
    runDirectory: path.join(f.runs, randomUUID()),
  };
  const response = await invoke(
    ["execute", "--config", f.config, "--task", randomUUID()],
    () =>
      fakeBackend((method) => {
        assert.equal(method, "task.execute");
        return result;
      }),
  );
  assert.equal(response.code, 3);
  assert.equal(
    response.value.ok,
    true,
    "operation completion and validation verdict are independent",
  );
  assert.deepEqual(response.value.result, result);
  assert.deepEqual(readJson(response.value.responseFile), response.value);
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);
});

test(
  "Windows skill keeps configured path casing compatible with TUI while reporting the canonical project",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = setup(t);
    const project = f.project.toUpperCase();
    const expected = await loadConfig(
      { configFile: f.config, projectRoot: project },
      path.resolve("."),
    );
    let received: PluginConfig | undefined;
    const response = await invoke(
      ["history", "--config", f.config, "--project", project],
      (config) => {
        received = structuredClone(config);
        return fakeBackend((method) => {
          assert.equal(method, "history.list");
          return { records: [] };
        });
      },
    );
    assert.equal(response.code, 0, JSON.stringify(response.value));
    assert.deepEqual(received, expected);
    assert.equal(
      response.value.projectRoot,
      await fs.promises.realpath(project),
    );
    assert.deepEqual(response.value.result, { records: [] });
  },
);

test("skill resumes applied transactions across calls and preserves later edits during rollback", async (t) => {
  const f = setup(t);
  const candidateId = randomUUID();
  const runDirectory = path.join(f.runs, candidateId);
  const after =
    "export class Page {\n  update() { return this.value(); }\n  private value() { return 1; }\n}\n";
  const beforeFile = path.join(runDirectory, "content/before", f.name);
  const afterFile = path.join(runDirectory, "content/after", f.name);
  writeText(beforeFile, f.before);
  writeText(afterFile, after);
  const candidate: Candidate = {
    candidateId,
    taskHandle: randomUUID(),
    originalRoot: f.project,
    runDirectory,
    verdict: "PASS",
    configDigest: "controlled-backend",
    baselineFiles: { [f.name]: hash(beforeFile) },
    afterFiles: { [f.name]: hash(afterFile) },
    changes: [
      {
        relativePath: f.name,
        changeType: "modified",
        kind: "source",
        beforeSha256: hash(beforeFile),
        afterSha256: hash(afterFile),
        size: Buffer.byteLength(after),
      },
    ],
    result: { verdict: "PASS", steps: [{ name: "build", status: "PASS" }] },
    scanScope: { scopePath: f.target },
  };
  writeJson(path.join(runDirectory, "candidate.json"), candidate);
  const methods: (keyof BridgeMethods)[] = [];
  const backend = () =>
    fakeBackend((method, params) => {
      methods.push(method);
      assert.equal(params.candidateId, candidateId);
      if (method === "candidate.check" || method === "candidate.describe")
        return candidate;
      if (method === "task.validateApplied")
        return {
          result: { verdict: "PASS" },
          issues: [],
          runDirectory,
          scanScope: candidate.scanScope,
        };
      throw new Error(`unexpected lifecycle method ${method}`);
    });
  const step = async (
    command: string,
    expectedMethods: (keyof BridgeMethods)[],
  ) => {
    methods.length = 0;
    const response = await invoke(
      [
        command,
        "--config",
        f.config,
        "--candidate",
        candidateId,
        ...(["apply", "rollback"].includes(command)
          ? ["--confirm", candidateId]
          : []),
      ],
      backend,
    );
    assert.deepEqual(methods, expectedMethods);
    if (response.value.ok)
      assert.deepEqual(readJson(response.value.responseFile), response.value);
    return response;
  };

  const premature = await step("validate-applied", ["candidate.describe"]);
  assert.equal(premature.code, 2);
  assert.equal(premature.value.ok, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);

  const applied = await step("apply", ["candidate.check"]);
  assert.equal(applied.code, 0, JSON.stringify(applied.value));
  assert.equal(applied.value.result.transaction.state, "APPLIED");
  assert.equal(fs.readFileSync(f.target, "utf8"), after);

  const restored = await step("restore", ["candidate.describe"]);
  assert.equal(restored.code, 0, JSON.stringify(restored.value));
  assert.equal(restored.value.result.transaction.state, "APPLIED");
  assert.equal(restored.value.result.candidate.candidateId, candidateId);

  const validated = await step("validate-applied", [
    "candidate.describe",
    "task.validateApplied",
  ]);
  assert.equal(validated.code, 0, JSON.stringify(validated.value));
  assert.equal(validated.value.result.result.verdict, "PASS");

  const rolledBack = await step("rollback", ["candidate.describe"]);
  assert.equal(rolledBack.code, 0, JSON.stringify(rolledBack.value));
  assert.equal(rolledBack.value.result.transaction.state, "ROLLED_BACK");
  assert.equal(fs.readFileSync(f.target, "utf8"), f.before);

  const reapplied = await step("apply", ["candidate.check"]);
  assert.equal(reapplied.code, 0, JSON.stringify(reapplied.value));
  assert.equal(fs.readFileSync(f.target, "utf8"), after);
  const manualEdit = after + "// 用户之后的编辑必须保留\n";
  writeText(f.target, manualEdit);
  const conflict = await step("rollback", ["candidate.describe"]);
  assert.equal(conflict.code, 3);
  assert.equal(conflict.value.ok, true);
  assert.equal(conflict.value.result.transaction.state, "CONFLICT");
  assert.deepEqual(conflict.value.result.transaction.conflicts, [f.name]);
  assert.equal(
    conflict.value.result.transaction.recoveryIssues[0].kind,
    "CONTENT_CHANGED",
  );
  assert.equal(fs.readFileSync(f.target, "utf8"), manualEdit);
  assert.equal(
    readJson(path.join(runDirectory, "apply-transaction.json")).state,
    "CONFLICT",
  );
});
