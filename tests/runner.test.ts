import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  executePipeline,
  extractReviewJson,
  buildFailureReport,
  buildAgentFailureReport,
  agentErrorOutput,
} from "../src/runner.js";
import { taskFromJson } from "../src/models.js";
import { readJson, writeJson, writeText, now } from "../src/utils.js";
import { fixture, setupTask, goodConfig, spec } from "./helpers.js";
test("Dry Run 渲染六个步骤且不运行不存在的命令", async (t) => {
  const dir = setupTask(fixture(t)),
    config = goodConfig();
  config.refactorAgent = { command: ["must-not-exist", "{prompt_file}"] };
  const r = await executePipeline(dir, config, true);
  assert.equal(r.verdict, "DRY_RUN");
  assert.equal(r.steps.length, 6);
  assert(r.steps.every((s: any) => s.status === "DRY_RUN"));
  assert(r.steps[0].command.includes(dir));
});
test("真实子进程完整通过，记录墙上时间", async (t) => {
  const dir = setupTask(fixture(t)),
    r = await executePipeline(dir, goodConfig());
  assert.equal(r.verdict, "PASS");
  assert(r.durationSeconds > 0);
  assert.equal(r.repairAttempts, 0);
});
test("首轮 Agent 失败时不执行后续门禁", async (t) => {
  const dir = setupTask(fixture(t)),
    c = goodConfig();
  c.refactorAgent = spec("process.exit(1)");
  const r = await executePipeline(dir, c);
  assert.equal(r.verdict, "FAIL");
  assert(r.steps.slice(1).every((s: any) => s.status === "SKIPPED"));
  assert.equal(
    readJson(path.join(dir, "failure-report-agent.json")).classification,
    "AGENT_EXECUTION_FAILURE",
  );
});
test("并行任一失败会取消同组慢任务，不运行 Test 和 Review", async (t) => {
  const dir = setupTask(fixture(t)),
    c = goodConfig();
  c.gates!.smell = spec("process.exit(1)");
  c.gates!.build = spec("setTimeout(()=>process.exit(0), 30000)");
  const begin = now(),
    r = await executePipeline(dir, c);
  assert(now() - begin < 10);
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.steps.find((s: any) => s.name === "build").status, "SKIPPED");
  assert.equal(r.steps.find((s: any) => s.name === "test").status, "SKIPPED");
  assert.equal(
    r.steps.find((s: any) => s.name === "review-agent").status,
    "SKIPPED",
  );
});
test("单例总期限终止进程并记录 TIMEOUT，而非等待单步超时", async (t) => {
  const dir = setupTask(fixture(t)),
    c = goodConfig();
  c.taskTimeoutSeconds = 0.3;
  c.refactorAgent = spec("setInterval(()=>{},1000)", { timeoutSeconds: 60 });
  const begin = now(),
    r = await executePipeline(dir, c);
  assert(now() - begin < 10);
  assert.equal(r.verdict, "BLOCKED");
  assert.equal(r.timedOut, true);
  assert(readJson(path.join(dir, "result.json")).timedOut);
});
test("语义 Review 失败进入定向修复，随后重新验证通过", async (t) => {
  const dir = setupTask(fixture(t)),
    c = goodConfig();
  c.reviewAgent = spec(
    'const fs=require("node:fs");console.log(JSON.stringify({verdict:fs.existsSync("repaired")?"PASS":"FAIL",summary:"guard changed",issues:[]}))',
    { cwd: "{task_dir}" },
  );
  c.repairAgent = spec('require("node:fs").writeFileSync("repaired","yes")', {
    cwd: "{task_dir}",
  });
  const r = await executePipeline(dir, c);
  assert.equal(r.verdict, "PASS");
  assert.equal(r.repairAttempts, 1);
  assert.equal(
    readJson(path.join(dir, "failure-report-1.json")).classification,
    "SEMANTIC_REVIEW_FAILURE",
  );
  assert(fs.existsSync(path.join(dir, "repair-prompt-1.md")));
});
test("异味持续失败最多三轮修复，修复基于已有修改继续", async (t) => {
  const dir = setupTask(fixture(t)),
    c = goodConfig();
  c.gates!.smell = spec("process.exit(1)");
  c.repairAgent = spec(
    'require("node:fs").appendFileSync("repair-count","x")',
    { cwd: "{task_dir}" },
  );
  const r = await executePipeline(dir, c);
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.repairAttempts, 3);
  assert.equal(fs.readFileSync(path.join(dir, "repair-count"), "utf8"), "xxx");
  assert.equal(
    readJson(path.join(dir, "failure-report-3.json")).stage,
    "smell",
  );
});
test("修复 Agent 无有效改动可继续下一轮，而非第一轮失败立即退出", async (t) => {
  const dir = setupTask(fixture(t)),
    c = goodConfig();
  c.gates!.smell = spec("process.exit(1)");
  c.repairAgent = spec(
    'console.log("未产生允许的生产代码修改"); process.exit(5)',
  );
  const r = await executePipeline(dir, c);
  assert.equal(r.repairAttempts, 3);
  assert.equal(r.verdict, "FAIL");
  assert.equal(
    readJson(path.join(dir, "failure-report-2.json")).classification,
    "NO_ALLOWED_PRODUCTION_CHANGE",
  );
});
test("环境错误 BLOCKED 不进入生产修复", async (t) => {
  const dir = setupTask(fixture(t)),
    c = goodConfig();
  c.gates!.build = spec(
    'console.log("Invalid storeFile value");process.exit(1)',
    { blockedOutputRegex: "Invalid storeFile value" },
  );
  const r = await executePipeline(dir, c);
  assert.equal(r.verdict, "BLOCKED");
  assert.equal(r.repairAttempts, 0);
});
test("Linter skip 是明确豁免，其他门禁仍须通过", async (t) => {
  const dir = setupTask(fixture(t)),
    c = goodConfig();
  c.linterMode = "skip";
  c.gates!.linter = spec("process.exit(1)");
  const r = await executePipeline(dir, c);
  assert.equal(r.verdict, "PASS");
  assert.equal(r.steps.find((s: any) => s.name === "linter").status, "SKIPPED");
});
test("缺少必需门禁不误报 PASS", async (t) => {
  const dir = setupTask(fixture(t)),
    c = goodConfig();
  delete c.gates!.test;
  const r = await executePipeline(dir, c);
  assert.equal(r.verdict, "INCOMPLETE");
  assert.equal(r.steps.at(-1).status, "SKIPPED");
});
for (const output of [
  "",
  "finished",
  '{"verdict":',
  '{"verdict":"UNCERTAIN"}',
  '{"verdict":"PASS"}\n{"verdict":"UNKNOWN"}',
])
  test(`无效或不确定评审不得借用旧 PASS：${output}`, async (t) => {
    const dir = setupTask(fixture(t)),
      c = goodConfig();
    writeJson(path.join(dir, "review.json"), { verdict: "PASS" });
    c.reviewAgent = spec(`console.log(${JSON.stringify(output)})`);
    const r = await executePipeline(dir, c);
    assert.equal(r.verdict, "BLOCKED");
    assert.equal(r.repairAttempts, 0);
  });
test("解析多行 JSON 和 JSONL 内嵌中文评审", (t) => {
  const dir = fixture(t),
    file = path.join(dir, "review.log");
  writeText(
    file,
    "noise\n" +
      JSON.stringify({
        type: "text",
        part: {
          text: JSON.stringify(
            { verdict: "PASS", summary: "语义一致" },
            null,
            2,
          ),
        },
      }),
  );
  assert.equal(extractReviewJson(file)?.summary, "语义一致");
});
test("Agent 错误匹配排除正常工具输出里的网络字符串", () => {
  const normal = JSON.stringify({
    type: "tool_use",
    part: {
      state: { status: "completed", output: "TLS environment unavailable" },
    },
  });
  assert.equal(agentErrorOutput(normal), "");
  assert(
    agentErrorOutput('{"type":"error","error":"overloaded"}').includes(
      "overloaded",
    ),
  );
});
test("异味转移报告定位新增 Helper，不错误指回原样例", (t) => {
  const dir = setupTask(fixture(t));
  writeJson(path.join(dir, "refactor-changes.json"), {
    changedProductionFiles: ["entry/src/main/ets/NewMapper.ets"],
  });
  writeJson(path.join(dir, "smell-after.json"), [
    {
      filePath: "D:/validation/entry/src/main/ets/NewMapper.ets",
      message: "remaining",
      line: 5,
    },
  ]);
  const task = taskFromJson(readJson(path.join(dir, "task.json"))),
    failure = buildFailureReport(
      dir,
      task,
      { name: "smell", status: "FAIL", duration_seconds: 0 },
      1,
    );
  assert.equal(failure.issues[0].filePath, "entry/src/main/ets/NewMapper.ets");
  assert.equal(failure.classification, "SMELL_REMAINS_OR_MOVED");
});

test("测试失败归因不能因日志含目标名就掩盖同轮无关失败", (t) => {
  const dir = setupTask(fixture(t)),
    attempt = path.join(dir, "test-attempts/current"),
    report = path.join(attempt, "test_result.txt");
  writeText(
    report,
    "class=PageTest\ntest=work\nassertion failed\nresult=Failure\nclass=UnrelatedTest\ntest=other\nother failure\nresult=Failure\n",
  );
  writeJson(path.join(dir, "test-results.json"), {
    plan: path.join(attempt, "plan.json"),
    jobs: [
      {
        status: "FAIL",
        selectionReason: "target-named-suite",
        expectedSuites: ["PageTest"],
        artifacts: { "test_result.txt": report },
      },
    ],
  });
  writeJson(path.join(dir, "refactor-changes.json"), {
    changedProductionFiles: ["entry/src/main/ets/Page.ets"],
  });
  const current = taskFromJson(readJson(path.join(dir, "task.json"))),
    failure = buildFailureReport(
      dir,
      current,
      { name: "test", status: "FAIL", duration_seconds: 0 },
      1,
    );
  assert.equal(failure.repairable, false);
  assert.equal(failure.classification, "UNATTRIBUTED_TEST_FAILURE");
});

test("失败分析不读取旧轮次或验证副本共享测试报告", (t) => {
  const dir = setupTask(fixture(t)),
    report = path.join(dir, "old/test_result.txt");
  writeText(report, "class=PageTest\ntest=work\nresult=Failure\n");
  writeJson(path.join(dir, "test-results.json"), {
    plan: path.join(dir, "test-attempts/current/plan.json"),
    jobs: [
      {
        status: "FAIL",
        selectionReason: "target-named-suite",
        expectedSuites: ["PageTest"],
        artifacts: { "test_result.txt": report },
      },
    ],
  });
  const failure = buildFailureReport(
    dir,
    taskFromJson(readJson(path.join(dir, "task.json"))),
    { name: "test", status: "FAIL", duration_seconds: 0 },
    1,
  );
  assert.equal(failure.repairable, false);
  assert.equal(failure.logTail, "");
});
