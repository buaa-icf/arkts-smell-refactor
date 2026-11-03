import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contextFor, runSpec } from "../src/runner.js";
import { taskFromJson } from "../src/models.js";
import { readJson, readText, writeJson, writeText } from "../src/utils.js";
import { fixture, setupTask } from "./helpers.js";

test("示例评审配置经过平台入口，完整材料走 stdin 并应用 Coding Plan 策略", async (t) => {
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
  assert.equal(captured.args[captured.args.indexOf("-m") + 1], "zhipu-coding/glm-5");
  assert(captured.args.includes("--auto"));
  assert(!captured.args.includes("-f"));
  assert.match(captured.input, /review-packet.json（清单）/);
  assert.match(captured.input, /return 1;/);
  assert.match(captured.input, /return 2;/);
  assert(captured.disabledProviders.includes("deveco"));
  assert.equal(captured.tools.skill, false);
  assert.equal(captured.tools.websearch, false);
  assert.equal(captured.tools.build_project, false);
  assert.equal(captured.tools.arkts_check, false);
  assert.equal(readJson(path.join(dir, "review-execution-policy.json")).promptTransport, "stdin");

  writeText(path.join(dir, "format-input.md"), "completed review JSON");
  const format = config.reviewFormatAgent;
  format.command[0] = process.execPath;
  format.command[format.command.indexOf("--deveco") + 1] = launcher;
  const formatted = await runSpec("review-agent-format", format,
    { ...context, review_format_prompt_file: path.join(dir, "format-input.md") }, dir, dir);
  assert.equal(formatted.status, "PASS");
  const formatCapture = readJson(capture);
  assert.equal(formatCapture.args[formatCapture.args.indexOf("--agent") + 1], "arkts-review-format");
  assert.deepEqual(formatCapture.agent.tools, { "*": false });
  assert.deepEqual(formatCapture.agent.permission, { "*": "deny" });
});
