import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { hvigorGate } from "../src/gate.js";
import {
  compareFailedTestJob,
  compareTestOutcomes,
} from "../src/test_baseline.js";
import { interruptTestResults } from "../src/test_progress.js";
import { buildFailureReport, runSpec } from "../src/runner.js";
import { taskFromJson } from "../src/models.js";
import { readJson, readText, writeJson, writeText } from "../src/utils.js";
import { fixture, makeProject, spec, suite, success } from "./helpers.js";

test("准备阶段日志中的 build 和目标名不能把未执行的用例归因到生产代码", (t) => {
  const p = makeProject(fixture(t));
  const attempt = path.join(p.taskDir, "test-attempts", "current");
  const log = path.join(attempt, "hvigor.log");
  const task = readJson(path.join(p.taskDir, "task.json"));
  task.target.symbol = "build";
  writeText(
    log,
    "Compiling Page.ets for build\nError Message: module packaging did not finish",
  );
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: ["feature/src/main/ets/Page.ets"],
  });
  writeJson(path.join(p.taskDir, "test-results.json"), {
    plan: path.join(attempt, "plan.json"),
    jobs: [{ status: "FAIL", log }],
  });
  const report = buildFailureReport(
    p.taskDir,
    taskFromJson(task),
    { name: "test", status: "FAIL", duration_seconds: 0 },
    1,
  );
  assert.equal(report.repairable, false);
  assert.equal(report.classification, "UNATTRIBUTED_TEST_FAILURE");
});

test("基线日志里的环境阻塞不能覆盖已执行的候选断言", async (t) => {
  const root = fixture(t);
  const manifest = {
    status: "FAIL",
    classification: "TEST_BASELINE_INCONCLUSIVE",
    reason: "assertion failed",
    jobs: [
      {
        status: "FAIL",
        baselineComparison: { classification: "TEST_BASELINE_INCONCLUSIVE" },
      },
    ],
  };
  const script = `require("node:fs").writeFileSync("test-results.json", ${JSON.stringify(JSON.stringify(manifest))}); console.error("TEST_GATE_BLOCKED: baseline only"); process.exit(1)`;
  const result = await runSpec(
    "test",
    spec(script, { blockedOutputRegex: "TEST_GATE_BLOCKED" }),
    {},
    root,
    root,
  );
  assert.equal(result.status, "FAIL");
  assert.equal(result.reason, "assertion failed");
});

test("测试基线中断时收尾两份运行清单并保留候选的真实失败", (t) => {
  const root = fixture(t),
    attempt = path.join(root, "test-attempts", "current");
  const baseline = path.join(attempt, "baseline");
  writeJson(path.join(root, "test-results.json"), {
    plan: path.join(attempt, "plan.json"),
    status: "RUNNING",
    jobs: [
      {
        status: "FAIL",
        baselineComparison: { classification: "TEST_BASELINE_PENDING" },
      },
    ],
  });
  writeJson(path.join(baseline, "test-results.json"), {
    status: "RUNNING",
    jobs: [{ status: "RUNNING" }],
  });
  interruptTestResults(root, "timed out", "TEST_TIMEOUT");
  const result = readJson(path.join(root, "test-results.json"));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.jobs[0].status, "FAIL");
  assert.equal(
    result.jobs[0].baselineComparison.classification,
    "TEST_BASELINE_INTERRUPTED",
  );
  assert.equal(
    readJson(path.join(baseline, "test-results.json")).jobs[0].status,
    "BLOCKED",
  );
});

test("相同测试名及断言文字但栈帧位置不同，不能视为原始失败", (t) => {
  const root = fixture(t),
    report = path.join(root, "test_result.txt");
  writeText(
    report,
    "class=PageTest\ntest=case\nassertion failed\n at run test (app/src/ohosTest/test/Page.test.ets:50:2)\nresult=Failure",
  );
  const verdict = compareTestOutcomes(
    {
      failedCases: [
        {
          suite: "PageTest",
          name: "case",
          result: "Failure",
          details:
            "assertion failed\n at run test (app/src/ohosTest/test/Page.test.ets:30:2)",
        },
      ],
    },
    { status: "FAIL", artifacts: { "test_result.txt": report } },
    root,
  );
  assert.equal(verdict, "TEST_BASELINE_INCONCLUSIVE");
});

test("基线准备错误和持久化文件均脱敏", async (t) => {
  const root = fixture(t),
    attempt = path.join(root, "test-attempts", "current");
  const job = {
    kind: "local",
    module: "entry",
    scope: "Example",
    status: "FAIL",
    failedCases: [{}],
  };
  writeJson(path.join(root, "test-results.json"), {
    plan: path.join(attempt, "plan.json"),
    status: "FAIL",
    jobs: [job],
  });
  assert.equal(
    await compareFailedTestJob(
      root,
      { jobs: [job] },
      async () => {
        throw new Error("sensitive-fixture");
      },
      (text) => text.replaceAll("sensitive-fixture", "[REDACTED]"),
    ),
    1,
  );
  for (const manifest of [
    path.join(root, "test-results.json"),
    path.join(attempt, "results.json"),
  ]) {
    assert.doesNotMatch(readText(manifest), /sensitive-fixture/);
    assert.equal(
      readJson(manifest).jobs[0].baselineComparison.classification,
      "TEST_BASELINE_UNAVAILABLE",
    );
  }
});

for (const scenario of [
  "introduced-assertion",
  "existing-assertion",
  "different-assertion",
  "existing-test-compile",
] as const) {
  test(`相同套件比较基线与候选：${scenario}`, async (t) => {
    const root = fixture(t),
      p = makeProject(root);
    const relative = "feature/src/main/ets/Page.ets";
    suite(p.source, "local");
    writeText(p.target, "export const version = 'candidate';");
    writeText(
      path.join(p.taskDir, "baseline-production", relative),
      "export const version = 'baseline';",
    );
    writeJson(path.join(p.taskDir, "refactor-changes.json"), {
      changedProductionFiles: [relative],
    });
    writeJson(path.join(root, "package.json"), { type: "commonjs" });
    const stub = path.join(root, "hvigor.js");
    const failure = success()
      .replace("result=Success", "assertion false\nresult=Failure")
      .replace("Failure: 0", "Failure: 1")
      .replace("Pass: 1", "Pass: 0");
    writeText(
      stub,
      `
      const fs = require("node:fs"), path = require("node:path");
      const before = fs.readFileSync(${JSON.stringify(relative)}, "utf8").includes("baseline");
      const scenario = ${JSON.stringify(scenario)};
      if (scenario === "existing-test-compile") {
        console.error("Error Message: 'vm.userInfo' is possibly 'undefined'. At File: " + path.resolve("feature/src/test/Page.test.ets") + ":40:7");
        process.exit(255);
      }
      const dir = "feature/.test/default/intermediates/test/coverage_data";
      fs.mkdirSync(dir, {recursive:true});
      let result = ${JSON.stringify(failure)};
      if (before && scenario === "introduced-assertion") result = ${JSON.stringify(success())};
      if (before && scenario === "different-assertion") result = result.replace("assertion false", "different assertion");
      fs.writeFileSync(path.join(dir, "test_result.txt"), result);
    `,
    );
    try {
      const code = await hvigorGate(
        p.taskDir,
        p.source,
        stub,
        undefined,
        "auto-test",
      );
      const expected =
        scenario === "introduced-assertion"
          ? "INTRODUCED_TEST_FAILURE"
          : scenario === "different-assertion"
            ? "TEST_BASELINE_INCONCLUSIVE"
            : "BASELINE_TEST_FAILURE";
      const result = readJson(path.join(p.taskDir, "test-results.json"));
      assert.equal(code, expected === "BASELINE_TEST_FAILURE" ? 3 : 1);
      assert.equal(result.jobs[0].status, "FAIL");
      assert.equal(result.jobs[0].baselineComparison.classification, expected);
      assert(readJson(result.jobs[0].baselineComparison.manifest).jobs[0]);
      const report = buildFailureReport(
        p.taskDir,
        taskFromJson(readJson(path.join(p.taskDir, "task.json"))),
        { name: "test", status: "FAIL", duration_seconds: 0 },
        1,
      );
      assert.equal(report.classification, expected);
      assert.equal(report.repairable, expected === "INTRODUCED_TEST_FAILURE");
      assert.match(readText(p.target), /candidate/);
    } finally {
      const metadata = path.join(p.taskDir, "validation-workspace.json");
      if (fs.existsSync(metadata))
        fs.rmSync(readJson(metadata).path, { recursive: true, force: true });
    }
  });
}
