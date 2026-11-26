import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { analyzeFeatureEnvy, recurringEnvyAdvice } from "../src/analysis/feature_envy.js";
import { bundledHomecheck } from "../src/homecheck_runtime.js";
import { executePipeline } from "../src/runner.js";
import { recheckOriginalTarget } from "../src/smell.js";
import { hash, readJson, writeJson, writeText } from "../src/utils.js";
import { fixture, goodConfig, makeProject, spec, task } from "./helpers.js";

test("原始目标用内置 HomeCheck 复扫，其他长方法不能替代目标", async t => {
  const p = makeProject(fixture(t));
  const target = readJson(path.join(p.taskDir, "task.json"));
  target.rule = "@extrulesproject/long-method-check";
  target.smell_type = "long-method";
  writeJson(path.join(p.taskDir, "task.json"), target);
  const longMethod = (name: string) => "  " + name + "(): number {\n    let x = 0;\n" +
    Array.from({length: 100}, (_, i) => "    x += " + i + ";").join("\n") + "\n    return x;\n  }\n";
  const homecheck = bundledHomecheck();
  assert.ok(homecheck);
  for (const [name, status] of [["work", "DETECTED"], ["other", "NOT_REPRODUCED"]]) {
    writeText(p.target, "export class Page {\n" + longMethod(name) +
      (name === "work" ? "" : "  work() { return 0; }\n") + "}");
    const original = hash(p.target);
    const recheck = await recheckOriginalTarget(p.taskDir, homecheck, p.source);
    assert.equal(recheck.status, status, recheck.reason);
    assert.equal(hash(p.target), original);
  }
});

test("原始克隆复核按成员对匹配，支持反向报告及多文件", async t => {
  const root = fixture(t), p = makeProject(root);
  const scanner = path.join(root, "scanner"), rule = "@extrulesproject/code-clone-fragment-check";
  const json = readJson(path.join(p.taskDir, "task.json"));
  const right = "app/feature/src/main/ets/Other.ets";
  const description = (left: string, right: string) =>
    "Code Clone Type-2 (different classes): " + left + " is similar to " + right + ". (100 tokens, 10 lines)";
  json.rule = rule;
  json.smell_type = "code-clone";
  json.target.symbol = null;
  json.message = description("Page.ets > Page.work():1-10", right + " > Other.build():20-29");
  json.target.related_targets = [{ filePath: right, range: { startLine: 20, endLine: 29 } }];
  writeJson(path.join(p.taskDir, "task.json"), json);
  writeText(path.join(root, right), "class Other {}");
  writeJson(path.join(scanner, "config/projectConfig.json"), {});
  writeJson(path.join(scanner, "config/ruleConfig.json"), {});
  writeText(path.join(scanner, "scan.cjs"), [
    "const fs=require('node:fs'),p=require('node:path');",
    "const arg=k=>process.argv[process.argv.indexOf(k)+1], read=f=>JSON.parse(fs.readFileSync(f));",
    "const summary=arg('--summary'), cfg=read(arg('--project-config'));",
    "const data=read(p.join(__dirname,'input.json')), files=cfg.checkFiles.map(f=>p.join(cfg.projectPath,f));",
    "if(files.length!==2) process.exit(1);",
    "fs.writeFileSync(p.join(p.dirname(summary),'report.json'),JSON.stringify(data.items));",
    "fs.writeFileSync(summary,JSON.stringify({scannedFiles:data.partial?files.slice(0,1):files,loadedRules:[" + JSON.stringify(rule) +
      "],repositories:[{path:" + JSON.stringify(p.source) + ",runs:[{success:true,exitCode:0,ruleName:" +
      JSON.stringify(rule) + ",issuesReportPath:'report.json'}]}]}));",
  ].join("\n"));
  for (const [member, partial, expected] of [
    ["Other.build()", false, "DETECTED"], ["Other.unrelated()", false, "NOT_REPRODUCED"],
    ["Other.build()", true, "UNAVAILABLE"],
  ] as const) {
    writeJson(path.join(scanner, "input.json"), { partial, items: [{ filePath: path.join(root, right),
      messages: [{rule, message: description("Other.ets > " + member + ":35-45", p.target + " > Page.work():14-23")}] }] });
    const recheck = await recheckOriginalTarget(p.taskDir, scanner, p.source);
    assert.equal(recheck.status, expected, recheck.reason);
  }
});

test("初始零变更保留三种结论，不沿用上次复扫", async t => {
  const p = makeProject(fixture(t)), cfg = goodConfig();
  const file = path.join(p.taskDir, "original-target-recheck.json");
  for (const [state, status, classification] of [
    ["NOT_REPRODUCED", "INCOMPLETE", "ORIGINAL_TARGET_NOT_REPRODUCED"],
    ["UNAVAILABLE", "BLOCKED", "ORIGINAL_TARGET_RECHECK_UNAVAILABLE"],
    ["DETECTED", "FAIL", "NO_ALLOWED_PRODUCTION_CHANGE"],
    ["", "FAIL", "NO_ALLOWED_PRODUCTION_CHANGE"],
  ]) {
    cfg.refactorAgent = spec((state ? "require('node:fs').writeFileSync(" + JSON.stringify(file) + "," +
      JSON.stringify(JSON.stringify({ taskId: "T", status: state, reason: "fixture" })) + ");" : "") + "process.exit(5)");
    const result = await executePipeline(p.taskDir, cfg);
    assert.equal(result.verdict, status);
    assert.equal(result.repairAttempts, 0);
    assert.equal(readJson(path.join(p.taskDir, "failure-report.json")).classification, classification);
  }
});

test("017 类跨类型复制同时记录读取、原地写入和修复迁移", t => {
  const root = fixture(t), current = task(root);
  const source = [
    "import { Contacts } from 'network';", "import { VM } from './VM';",
    "class Page {", "  contactInfo: Contacts;", "  vm: VM;", "  work() {",
    "    if (this.vm.contactInfo) {", "      this.contactInfo.name = this.vm.contactInfo.name;",
    "      this.contactInfo.phone = this.vm.contactInfo.phone;", "    }", "  }", "}",
  ].join("\n");
  const file = path.join(root, current.target.file_path);
  writeText(file, source);
  writeText(path.join(path.dirname(file), "VM.ets"), "import { Contacts } from './types';\nexport class VM {\n  contactInfo: Contacts | undefined;\n}");
  const analysis = analyzeFeatureEnvy(current, source);
  assert.equal(analysis.classification, "STATE_MUTATION");
  assert.deepEqual(analysis.fieldTransfers[0].fields, ["name", "phone"]);
  assert.match(analysis.fieldTransfers[0].sourceType, /Contacts \| undefined.*\.\/types/);
  assert.match(analysis.fieldTransfers[0].destinationType, /Contacts.*network/);
  assert.match(analysis.mustPreserve.join(" "), /原顺序.*对象身份/);
  const failure = (name: string) => ({stage: "smell", issues: [{reason:
    "Method '" + name + "' is feature-envious toward 'Contacts' (ATFD=5, LDA=0.00, CPFD=1)."}]});
  assert.match(recurringEnvyAdvice(failure("buildEditableContact"), failure("copyContactInfo")), /buildEditableContact.*copyContactInfo/);
  assert.equal(recurringEnvyAdvice({stage: "build"}, failure("work")), "");
});
