import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refactorGate } from "../src/gate.js";
import { repairLongCallLines } from "../src/linter_repair.js";
import { executePipeline } from "../src/runner.js";
import { freshCopy } from "../src/workspace.js";
import { hash, readJson, readText, writeJson, writeText } from "../src/utils.js";
import { fixture, goodConfig, makeProject, spec } from "./helpers.js";

const sourceLine = (field: string) =>
  `    this.${field} = initUserFieldValue(this.userInfo, (id: number): void => this.checkLogin(id), (info: UserInfo): string => info.${field})`;
function setup(t: TestContext, second = sourceLine("cellphone")) {
  const p = makeProject(fixture(t)), files = ["Page", "Phone"].map(n => `feature/src/main/ets/${n}.ets`);
  const rows = [sourceLine("nickname"), second];
  const issues = files.map((r, i) => {
    const file = path.join(p.source, r), before = "  work() {\r\n    init();\r\n  }\r\n";
    writeText(path.join(p.taskDir, "baseline-production", r), before);
    fs.writeFileSync(file, before.replace("    init();", rows[i]));
    return { filePath: r, line: 2, column: 5, rule: "@hw-stylistic/max-len", sourceSha256: hash(file),
      message: `This line has a length of ${rows[i].length}. Maximum allowed is 120.` };
  });
  const report = { attempt: 1, classification: "INTRODUCED_LINTER_FAILURE", stage: "linter",
    repairable: true, changedProductionFiles: files, issues };
  writeJson(path.join(p.taskDir, "failure-report-1.json"), report);
  writeJson(path.join(p.taskDir, "refactor-changes.json"), { changedProductionFiles: files });
  const prompt = path.join(p.taskDir, "repair-prompt-1.md");
  writeText(prompt, "repair the two overlong lines");
  return { ...p, prompt, files, rows, report };
}

test("072 的两条有类型回调调用仅在外层实参逗号处换行，经正常修复入口同步，两份原始快照保留", async t => {
  const p = setup(t);
  const code = await refactorGate(p.taskDir, p.source, "unused-agent-executable", p.prompt);
  assert.equal(code, 0);
  for (const [index, r] of p.files.entries()) {
    const contents = fs.readFileSync(path.join(p.source, r), "utf8");
    assert(contents.split("\r\n").every(line => line.length <= 120));
    assert(contents.includes(p.rows[index].replaceAll(", ", ",\r\n      ")));
    assert(readText(path.join(p.taskDir, "baseline-production", r)).includes("init();"));
    assert.equal(fs.readFileSync(path.join(p.taskDir, "current-production", r), "utf8"), contents);
  }
  assert(!fs.existsSync(path.join(p.taskDir, "repair-execution-policy.json")));
  assert.equal(readJson(path.join(p.taskDir, "refactor-changes.json")).changedProductionFiles.length, 2);
});

test("非纯规则、过期哈希、未变更行、复杂实参、模板和注释整轮交回 Agent，之前的可修文件不变", t => {
  const regular = sourceLine("cellphone");
  for (const scenario of ["mixed", "stale", "unchanged", "string", "comment", "template", "generic"]) {
    const rows: Record<string,string> = { string:regular.replace("this.userInfo", "'embedded,a,b,content'"),
      comment:regular.replace("this.userInfo", "this.userInfo /* optional */"), generic:regular.replace("initUserFieldValue(", "initUserFieldValue<T,U>(") };
    const p = setup(t, rows[scenario] ?? regular);
    const src = path.join(p.source, p.files[1]);
    if (scenario === "mixed") p.report.issues[1].rule = "other-rule";
    if (scenario === "stale") p.report.issues[1].sourceSha256 = "stale";
    if (scenario === "unchanged") fs.copyFileSync(src, path.join(p.taskDir, "baseline-production", p.files[1]));
    if (scenario === "template") {
      fs.writeFileSync(src, "const text = `\r\n" + regular + "\r\n`\r\n");
      p.report.issues[1].sourceSha256 = hash(src);
    }
    writeJson(path.join(p.taskDir, "failure-report-1.json"), p.report);
    const workspace = path.join(p.taskDir, "repair-copy");
    freshCopy(p.source, workspace, true);
    assert.equal(repairLongCallLines(p.taskDir, p.source, workspace, 1), false, scenario);
    for (const r of p.files) assert.equal(hash(path.join(workspace, r)), hash(path.join(p.source, r)), scenario);
  }
});

test("纯行长修复经批处理返修入口再次执行全部门禁和评审", async t => {
  const p = setup(t), config = goodConfig();
  config.gates!.contract = spec();
  config.gates!.runtime = spec();
  config.gates!.linter = spec(`const fs = require('node:fs');
    const remaining = ${JSON.stringify(p.report.issues)}.filter(issue =>
      fs.readFileSync(issue.filePath, 'utf8').split(/\\r?\\n/)[issue.line-1].length > 120);
    fs.writeFileSync(${JSON.stringify(path.join(p.taskDir, "linter-after.json"))}, JSON.stringify(remaining));
    process.exitCode = remaining.length ? 1 : 0;`);
  config.repairAgent = { command: [process.execPath, path.resolve("dist/gate.js"),
    "refactor", "--task-dir", "{task_dir}", "--source-root", p.source,
    "--deveco", "unused-agent-executable", "--prompt-file", "{repair_prompt_file}"] };
  const result = await executePipeline(p.taskDir, config);
  assert.equal(result.verdict, "PASS");
  assert.equal(result.repairAttempts, 1);
  for (const gate of ["smell", "contract", "runtime", "linter", "build", "test", "review-agent"])
    assert.equal(result.steps.find((s: { name: string }) => s.name === gate + "-repair-1")?.status, "PASS", gate);
  assert(!fs.existsSync(path.join(p.taskDir, "repair-execution-policy.json")));
});
