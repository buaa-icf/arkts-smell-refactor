import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contextFor, executePipeline, runSpec } from "../src/runner.js";
import { completedPipeReview } from "../src/review_output.js";
import { taskFromJson } from "../src/models.js";
import { readJson, readText, writeJson, writeText } from "../src/utils.js";
import { fixture, goodConfig, setupTask, spec } from "./helpers.js";

const pipePass = { verdict: "PASS", summary: "unchanged", smellRemoved: true, behaviorEquivalent: true,
  riskChecks: [{ riskCode: "STATE", status: "passed", evidence: "original state owner" }], issues: [] };
const pipeFail = { ...pipePass, verdict: "FAIL", summary: "callback lost", behaviorEquivalent: false,
  issues: [{ severity: "blocking", filePath: "Page.ets", reason: "callback no longer fires" }] };
const stepStart = { type: "step_start", sessionID: "s", part: { type: "step-start", messageID: "final" } };
const stepStop = { type: "step_finish", sessionID: "s", part: { type: "step-finish", messageID: "final", reason: "stop" } };
const reviewText = (value: unknown) => ({ type: "text", sessionID: "s",
  part: { type: "text", messageID: "final", text: JSON.stringify(value) } });
const pipeLog = (...events: unknown[]) =>
  ["EPIPE: broken pipe, write", '    code: "EPIPE"', "", "      at end (unknown:1:1)", ...events.map(e => JSON.stringify(e))].join("\n");

test("EPIPE 只接受同一消息完整终止、自洽且唯一的评审", t => {
  const file = path.join(fixture(t), "review.log"), pass = reviewText(pipePass);
  for (const output of [
    pipeLog(stepStart, pass),
    pipeLog(stepStart, pass, { ...stepStop, sessionID: "other" }),
    pipeLog(stepStart, pass, { ...stepStop, part: { ...stepStop.part, messageID: "stale" } }),
    pipeLog(stepStart, pass, reviewText(pipeFail), stepStop),
    pipeLog(stepStart, { type: "error", error: "provider failed" }, pass, stepStop),
    pipeLog(stepStart, pass, stepStop) + "\nfatal: reviewer crashed",
    pipeLog(stepStart, reviewText({ ...pipePass, behaviorEquivalent: false }), stepStop),
    pipeLog(stepStart, reviewText({ verdict: "PASS" }), stepStop),
  ]) {
    writeText(file, output);
    assert.equal(completedPipeReview(file), null, output);
  }
});

test("评审进程的 EPIPE 保留完整 PASS 或语义 FAIL，截断或其他命令故障仅重试评审", async t => {
  for (const scenario of ["complete-pass", "complete-fail", "retry-pass", "blocked"]) {
    const dir = setupTask(fixture(t)), config = goodConfig();
    const complete = pipeLog(stepStart, reviewText(scenario === "complete-fail" ? pipeFail : pipePass), stepStop);
    const first = scenario === "retry-pass" ? pipeLog(stepStart, reviewText(pipePass)) :
      scenario === "blocked" ? "provider crashed" : complete;
    config.reviewAgent = spec(`
      const fs = require("node:fs");
      const retried = fs.existsSync("review-ran");
      fs.appendFileSync("review-ran", "x");
      console.log(retried && ${JSON.stringify(scenario)} === "retry-pass" ? ${JSON.stringify(complete)} : ${JSON.stringify(first)});
      process.exitCode = 1;`, { cwd: "{task_dir}", maxEnvironmentRetries: 1, retryDelaySeconds: 0 });
    config.repairAgent = spec("require('node:fs').writeFileSync('repaired', 'x')", { cwd: "{task_dir}" });
    config.maxRepairAttempts = scenario === "complete-fail" ? 1 : 3;
    if (scenario === "blocked") writeJson(path.join(dir, "review.json"), pipePass);
    const result = await executePipeline(dir, config);
    assert.equal(result.verdict, scenario === "complete-fail" ? "FAIL" : scenario === "blocked" ? "BLOCKED" : "PASS");
    assert.equal(result.repairAttempts, scenario === "complete-fail" ? 1 : 0);
    assert.equal(fs.existsSync(path.join(dir, "repaired")), scenario === "complete-fail");
    assert.equal(result.reviewRetries, ["retry-pass", "blocked"].includes(scenario) ? 1 : 0);
    if (scenario === "blocked") {
      const failure = readJson(path.join(dir, "failure-report.json"));
      assert.equal(failure.classification, "REVIEW_RESULT_UNAVAILABLE");
      assert.equal(failure.repairable, false);
      assert(!fs.existsSync(path.join(dir, "review.json")));
    }
    if (scenario === "complete-fail") {
      const failure = readJson(path.join(dir, "failure-report-1.json"));
      assert.equal(failure.classification, "SEMANTIC_REVIEW_FAILURE");
      assert.deepEqual(failure.issues, pipeFail.issues);
    }
    if (scenario === "retry-pass" || scenario === "complete-pass") {
      const suffix = scenario === "retry-pass" ? "-retry-1" : "";
      assert.deepEqual(readJson(path.join(dir, "review" + suffix + ".json")), pipePass);
      assert.equal(result.steps.find((s: { name: string }) => s.name === "review-agent" + suffix).exit_code, 1);
    }
  }
});

test("示例评审配置经过平台入口，完整材料走 stdin 且默认沿用本机模型", async (t) => {
  const dir = setupTask(fixture(t)), file = "entry/src/main/ets/Page.ets";
  writeText(path.join(dir, "review-prompt.md"), "只读评审集中材料");
  writeJson(path.join(dir, "review-risk.json"), { risks: [] });
  writeJson(path.join(dir, "review-context.json"), { productionDependencies: [] });
  writeJson(path.join(dir, "refactor-changes.json"), { changedProductionFiles: [file] });
  writeJson(path.join(dir, "gates.json"), {
    attempt: 0, gates: ["smell", "build", "test", "linter"].map(name => ({ name, status: "PASS" })),
  });
  writeText(path.join(dir, "review-diff.patch"), "-return 1\n+return 2\n");
  writeText(path.join(dir, "baseline-production", file), "export class Page { work() { return 1; } }");
  writeText(path.join(dir, "current-production", file), "export class Page { work() { return 2; } }");
  const script = path.join(dir, "fake-review.cjs"), capture = path.join(dir, "capture.json");
  writeText(script, `const fs=require('node:fs'); const args=process.argv.slice(2), chunks=[];
process.stdin.on('data', c=>chunks.push(c)); process.stdin.on('end', ()=>{
  const policy=JSON.parse(process.env.DEVECO_CONFIG_CONTENT);
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args, input:Buffer.concat(chunks).toString('utf8'),
    disabledProviders:policy.disabled_providers, tools:policy.tools, agent:policy.agent?.['arkts-review-format']}));
  console.log(JSON.stringify({type:'text',part:{type:'text',text:'{"verdict":"PASS","issues":[]}'}}));
});`);
  const launcher = path.join(dir, process.platform === "win32" ? "fake-review.cmd" : "fake-review");
  writeText(launcher, process.platform === "win32"
    ? `@"${process.execPath}" "${script}" %*`
    : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"`);
  if (process.platform !== "win32") fs.chmodSync(launcher, 0o755);
  const config = readJson(path.resolve("config.example.json"));
  const command = config.reviewAgent.command as string[];
  command[0] = process.execPath;
  command[command.indexOf("--deveco") + 1] = launcher;
  const context = contextFor(dir, taskFromJson(readJson(path.join(dir, "task.json"))));
  const result = await runSpec("review-agent", config.reviewAgent, context, dir, dir);
  assert.equal(result.status, "PASS", readText(result.output_file!));
  const captured = readJson(capture);
  assert(!captured.args.includes("-m"));
  assert(!captured.args.includes("--variant"));
  assert(captured.args.includes("--auto"));
  assert(!captured.args.includes("-f"));
  assert.match(captured.input, /review-packet.json（清单）/);
  assert.match(captured.input, /return 1;/);
  assert.match(captured.input, /return 2;/);
  assert.equal(captured.disabledProviders, undefined);
  assert.equal(captured.tools.skill, false);
  assert.equal(captured.tools.websearch, false);
  assert.equal(captured.tools.build_project, false);
  assert.equal(captured.tools.arkts_check, false);
  assert.equal(readJson(path.join(dir, "review-execution-policy.json")).promptTransport, "stdin");
  assert.equal(readJson(path.join(dir, "review-execution-policy.json")).modelSource, "deveco-local-config");

  writeText(path.join(dir, "format-input.md"), "completed review JSON");
  const format = config.reviewFormatAgent;
  format.command[0] = process.execPath;
  format.command[format.command.indexOf("--deveco") + 1] = launcher;
  const formatted = await runSpec("review-agent-format", format,
    { ...context, review_format_prompt_file: path.join(dir, "format-input.md") }, dir, dir);
  assert.equal(formatted.status, "PASS");
  const formatCapture = readJson(capture);
  assert(!formatCapture.args.includes("-m"));
  assert.equal(formatCapture.args[formatCapture.args.indexOf("--agent") + 1], "arkts-review-format");
  assert.deepEqual(formatCapture.agent.tools, { "*": false });
  assert.deepEqual(formatCapture.agent.permission, { "*": "deny" });
});
