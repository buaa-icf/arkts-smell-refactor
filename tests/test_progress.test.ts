import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runTestPlan } from "../src/test_execution.js";
import { buildTestPlan } from "../src/test_plan.js";
import { executePipeline, runSpec } from "../src/runner.js";
import {
  TEST_PHASE_TIMEOUTS,
  testPhaseTimeouts,
} from "../src/test_progress.js";
import { now, readJson, readText, writeText } from "../src/utils.js";
import {
  fixture,
  goodConfig,
  makeProject,
  setupTask,
  suite,
  success,
} from "./helpers.js";

const testEnv = (overrides: NodeJS.ProcessEnv = {}) => ({
  ...process.env,
  ARKTS_TEST_PREPARE_TIMEOUT_SECONDS: "10",
  ARKTS_TEST_INSTALL_TIMEOUT_SECONDS: "10",
  ARKTS_TEST_EXECUTION_TIMEOUT_SECONDS: "10",
  ARKTS_TEST_COLLECT_TIMEOUT_SECONDS: "10",
  ...overrides,
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert(
      Date.now() < deadline,
      "expected live evidence before the child exited",
    );
    await delay(20);
  }
}
const signed =
  "> hvigor \u001b[32mFinished :featureName:ohosTest@SignHap... after 1 s";

test("签名后卡住：日志实时脱敏落盘，重复输出不延长阶段时限", async (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "instrument");
  const script = path.join(p.source, "hang.cjs"),
    manifest = path.join(p.taskDir, "test-results.json");
  writeText(
    script,
    `
    process.stdout.write('password=fixture-');
    setTimeout(() => {
      process.stdout.write('secret\\n');
      process.stderr.write('stderr=fixture-');
      setTimeout(() => {
        process.stderr.write('secret\\n');
        console.log(${JSON.stringify(signed)});
        setInterval(() => console.log(${JSON.stringify(signed)}), 50);
      }, 30);
    }, 30);
  `,
  );
  let finished = false;
  const run = runTestPlan(
    p.taskDir,
    p.source,
    buildTestPlan(p.taskDir, p.source),
    [process.execPath, script],
    testEnv({ ARKTS_TEST_INSTALL_TIMEOUT_SECONDS: "1" }),
    (text) => text.replaceAll("fixture-secret", "[REDACTED]"),
  ).finally(() => {
    finished = true;
  });
  try {
    await until(
      () =>
        fs.existsSync(manifest) &&
        readJson(manifest).jobs[0]?.phase === "awaiting-install",
    );
    const live = readJson(manifest).jobs[0];
    assert.equal(finished, false);
    assert.equal(live.status, "RUNNING");
    const log = readText(live.log);
    assert.match(log, /password=\[REDACTED\]/);
    assert.match(log, /stderr=\[REDACTED\]/);
    assert(!log.includes("fixture-secret"));
    assert.match(log, /ohosTest@SignHap/);
  } finally {
    assert.equal(await run, 3);
  }
  const results = readJson(manifest),
    job = results.jobs[0];
  assert.equal(results.status, "BLOCKED");
  assert.equal(job.classification, "TEST_PHASE_TIMEOUT");
  assert.equal(job.timeoutPhase, "awaiting-install");
  assert(job.durationSeconds < 8);
  assert.deepEqual(
    job.phaseHistory.map((item: any) => item.phase),
    ["preparing-test", "awaiting-install"],
  );
  assert.equal(readJson(job.progressFile).status, "BLOCKED");
  assert.equal(
    readJson(path.join(path.dirname(results.plan), "results.json")).status,
    "BLOCKED",
  );
});

for (const phase of [
  "preparing-test",
  "awaiting-test-result",
  "collecting-results",
] as const)
  test(`阶段卡住 ${phase}：保留部分证据，不将未退出的测试判为 PASS`, async (t) => {
    const p = makeProject(fixture(t));
    suite(p.source, "instrument");
    const artifacts = path.join(
        p.source,
        "feature/.test/default/intermediates/ohosTest/coverage_data",
      ),
      script = path.join(p.source, "hang.cjs");
    const coverage =
      phase === "collecting-results"
        ? "OHOS_REPORT_RESULT: done\nTestFinished-ResultCode: 0"
        : "OHOS_REPORT_STATUS: class=PageTest\nOHOS_REPORT_STATUS: test=case";
    writeText(
      script,
      `
      const fs = require('node:fs');
      ${
        phase === "preparing-test"
          ? "console.log('preparing');"
          : `
        console.log(${JSON.stringify(signed)});
        console.log('> hvigor Finished install haps');
        fs.mkdirSync(${JSON.stringify(artifacts)}, {recursive:true});
        fs.writeFileSync(${JSON.stringify(path.join(artifacts, "coverage.log"))}, ${JSON.stringify(coverage)});
        fs.writeFileSync(${JSON.stringify(path.join(artifacts, "test_result.txt"))}, ${JSON.stringify(phase === "collecting-results" ? success() : "class=PageTest\ntest=case\n")});
      `
      }
      setInterval(() => {}, 1000);
    `,
    );
    const envName = {
      "preparing-test": "ARKTS_TEST_PREPARE_TIMEOUT_SECONDS",
      "awaiting-test-result": "ARKTS_TEST_EXECUTION_TIMEOUT_SECONDS",
      "collecting-results": "ARKTS_TEST_COLLECT_TIMEOUT_SECONDS",
    }[phase];
    assert.equal(
      await runTestPlan(
        p.taskDir,
        p.source,
        buildTestPlan(p.taskDir, p.source),
        [process.execPath, script],
        testEnv({ [envName]: "1" }),
      ),
      3,
    );
    const results = readJson(path.join(p.taskDir, "test-results.json")),
      job = results.jobs[0];
    assert.equal(results.status, "BLOCKED");
    assert.equal(job.classification, "TEST_PHASE_TIMEOUT");
    assert.equal(job.timeoutPhase, phase);
    if (phase !== "preparing-test") {
      assert.equal(readText(job.artifacts["coverage.log"]), coverage);
      assert(fs.existsSync(job.artifacts["test_result.txt"]));
    }
  });

test("只有当前模块的签名完成消息会开启安装阶段", async (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "instrument");
  const script = path.join(p.source, "wrong-module.cjs");
  writeText(
    script,
    `
    console.log('> hvigor Finished :other:ohosTest@SignHap');
    console.log('> hvigor Finished :featureName:default@SignHap');
    console.log('assertion text: > hvigor Finished install haps');
    setInterval(() => {}, 1000);
  `,
  );
  assert.equal(
    await runTestPlan(
      p.taskDir,
      p.source,
      buildTestPlan(p.taskDir, p.source),
      [process.execPath, script],
      testEnv({
        ARKTS_TEST_PREPARE_TIMEOUT_SECONDS: "0.6",
        ARKTS_TEST_INSTALL_TIMEOUT_SECONDS: "5",
      }),
    ),
    3,
  );
  const job = readJson(path.join(p.taskDir, "test-results.json")).jobs[0];
  assert.equal(job.timeoutPhase, "preparing-test");
});

// This child stands in for a gate killed by its parent before it can flush a finally block.
function interruptedGate(taskDir: string, exitCode?: number) {
  const script = path.join(taskDir, "interrupted-gate.cjs"),
    attempt = path.join(taskDir, "test-attempts", "interrupted"),
    progressFile = path.join(attempt, "progress.json"),
    artifact = path.join(attempt, "coverage.log");
  writeText(
    script,
    `
    const fs = require('node:fs');
    const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
    fs.mkdirSync(${JSON.stringify(attempt)}, {recursive:true});
    const job = { status: 'RUNNING', phase: 'awaiting-install', startedAt: new Date().toISOString(),
      progressFile: ${JSON.stringify(progressFile)}, artifacts: {} };
    write(${JSON.stringify(path.join(taskDir, "test-results.json"))}, {
      status:'RUNNING', plan:${JSON.stringify(path.join(attempt, "plan.json"))},
      jobs:[{status:'PASS', module:'finished'},job], pendingJobs:[{module:'pending'}]
    });
    fs.writeFileSync(${JSON.stringify(artifact)}, 'OHOS_REPORT_STATUS: test=case');
    write(${JSON.stringify(progressFile)}, {...job, phase: 'awaiting-test-result', artifacts:{'coverage.log':${JSON.stringify(artifact)}}});
    console.log('live output before interruption');
    ${exitCode === undefined ? "setInterval(() => {}, 1000);" : `process.exitCode=${exitCode};`}
  `,
  );
  return script;
}

test("外层总超时强杀：test.log 已实时保存，主/轮次/作业索引均收尾且保留最新快照", async (t) => {
  const dir = setupTask(fixture(t)),
    script = interruptedGate(dir),
    log = path.join(dir, "test.log");
  let finished = false;
  const run = runSpec(
    "test",
    { command: [process.execPath, script], timeoutSeconds: 10 },
    {},
    dir,
    dir,
    false,
    undefined,
    now() + 1.5,
  ).finally(() => {
    finished = true;
  });
  try {
    await until(
      () =>
        fs.existsSync(log) &&
        readText(log).includes("live output before interruption"),
    );
    assert.equal(finished, false);
  } finally {
    await run;
  }
  const result = await run,
    manifest = readJson(path.join(dir, "test-results.json")),
    job = manifest.jobs[1];
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "单条异味总执行时间超过限制");
  assert.equal(manifest.status, "BLOCKED");
  assert.equal(manifest.classification, "TEST_GATE_TIMEOUT");
  assert.equal(manifest.jobs[0].status, "PASS");
  assert.equal(manifest.pendingJobs.length, 1);
  assert.equal(job.status, "BLOCKED");
  assert.equal(job.phase, "awaiting-test-result");
  assert.equal(
    readText(job.artifacts["coverage.log"]),
    "OHOS_REPORT_STATUS: test=case",
  );
  assert.equal(readJson(job.progressFile).status, "BLOCKED");
  assert.equal(
    readJson(path.join(path.dirname(manifest.plan), "results.json")).status,
    "BLOCKED",
  );
  assert.match(readText(log), /live output before interruption[\s\S]*TIMEOUT/);
});

for (const code of [0, 3])
  test(`测试进程异常收尾 code=${code}：残留 RUNNING 阻塞且不触发代码返修`, async (t) => {
    const dir = setupTask(fixture(t)),
      config = goodConfig();
    config.gates!.test = {
      command: [process.execPath, interruptedGate(dir, code)],
    };
    const result = await executePipeline(dir, config);
    assert.equal(result.verdict, "BLOCKED");
    assert.equal(result.repairAttempts, 0);
    assert.equal(
      readJson(path.join(dir, "test-results.json")).classification,
      "TEST_GATE_INTERRUPTED",
    );
  });

test("阶段时限仅接受正数，未设置时采用默认值", () => {
  assert.deepEqual(testPhaseTimeouts({}), TEST_PHASE_TIMEOUTS);
  assert.equal(
    testPhaseTimeouts({ ARKTS_TEST_EXECUTION_TIMEOUT_SECONDS: "123" })[
      "awaiting-test-result"
    ],
    123,
  );
  for (const value of ["", "0", "-1", "NaN", "Infinity"])
    assert.throws(
      () => testPhaseTimeouts({ ARKTS_TEST_INSTALL_TIMEOUT_SECONDS: value }),
      /positive number/,
    );
});
