import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { smellGate, homecheckReport } from "../src/smell.js";
import { refactorGate, ensureValidationModuleScope } from "../src/gate.js";
import {
  isFile,
  readJson,
  readText,
  writeJson,
  writeText,
} from "../src/utils.js";
import { runCommand } from "../src/process.js";
import { fixture, makeProject } from "./helpers.js";
test("验证副本不继承工具 ESM；不覆盖工程自身的模块配置", async (t) => {
  const root = fixture(t), storage = path.join(root, "v"),
    project = path.join(storage, "project");
  writeJson(path.join(root, "package.json"), { type: "module" });
  writeText(path.join(project, "hvigorfile.js"), "module.exports = { loaded: true };");
  const probe = [process.execPath, "-e", "console.log(require('./hvigorfile.js').loaded)"];
  ensureValidationModuleScope(storage);
  const result = await runCommand(probe, { cwd: project });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trim(), "true");
  assert(!isFile(path.join(project, "package.json")));
  writeJson(path.join(project, "package.json"), { type: "module", name: "source-config" });
  ensureValidationModuleScope(storage);
  assert.deepEqual(readJson(path.join(project, "package.json")), { type: "module", name: "source-config" });
  assert.equal(readJson(path.join(root, "package.json")).type, "module");
});
for (const mode of [
  "multiple-reports",
  "failed",
  "wrong-project",
  "wrong-rule",
  "duplicate-rule",
  "missing-summary",
  "missing-report",
  "outside-report",
]) {
  test(`HomeCheck 按本轮工程和规则摘要定位报告：${mode}`, (t) => {
    const root = fixture(t),
      source = path.join(root, "source"),
      output = path.join(root, "output"),
      rule = "@extrulesproject/feature-envy-check";
    const report =
      mode === "outside-report"
        ? path.join(root, "old/issuesReport.json")
        : path.join(output, "runs/app/feature-envy/issuesReport.json");
    writeJson(path.join(output, "runs/app/issuesReport.json"), []);
    writeJson(path.join(output, "other/issuesReport.json"), []);
    if (mode !== "missing-report")
      writeJson(report, [{ filePath: "Page.ets", messages: [] }]);
    const run = {
      ruleName: mode === "wrong-rule" ? "other/rule" : rule,
      success: mode !== "failed",
      exitCode: mode === "failed" ? 1 : 0,
      issuesReportPath: report,
    };
    if (mode !== "missing-summary")
      writeJson(path.join(output, "summary.json"), {
        repositories: [
          {
            path: mode === "wrong-project" ? root : source,
            runs: mode === "duplicate-rule" ? [run, run] : [run],
          },
        ],
      });
    if (mode === "multiple-reports")
      assert.equal(homecheckReport(output, source, rule), report);
    else assert.throws(() => homecheckReport(output, source, rule));
  });
}
for (const mode of [
  "clean",
  "remaining",
  "tool-error",
  "missing-report",
  "malformed",
])
  test(`HomeCheck 实际 npm 子进程编排：${mode}`, async (t) => {
    const root = fixture(t),
      p = makeProject(root),
      homecheck = path.join(root, "检测工具 有空格"),
      script = path.join(homecheck, "scripts/gitcodeArktsPerfTest.js");
    writeJson(path.join(homecheck, "package.json"), {
      scripts: { "scan:files": "node scripts/gitcodeArktsPerfTest.js" },
    });
    writeJson(path.join(homecheck, "config/projectConfig.json"), {});
    writeJson(path.join(homecheck, "config/ruleConfig.json"), {});
    const detectionOnlyCheck = "if(!args.includes('--perf=false')||!args.includes('--f1=false'))throw Error('refactor must disable CLOC/performance and F1');";
    writeText(
      script,
      `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),get=k=>args.find(a=>a.startsWith(k+'=')).slice(k.length+1);const report=get('--outputDir'),cfg=JSON.parse(fs.readFileSync(get('--baseProjectConfig'),'utf8'));if(cfg.checkFiles.length!==1||cfg.checkFiles[0]!=='feature/src/main/ets/Page.ets')throw Error('bad scan scope');if(!process.env.TEMP.includes('homecheck-temp'))throw Error('missing private temp');if(${JSON.stringify(mode)}==='tool-error')process.exit(13);if(${JSON.stringify(mode)}==='missing-report')process.exit(0);const output=path.join(report,'runs/app/feature-envy/issuesReport.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,${JSON.stringify(mode)}==='malformed'?'bad':JSON.stringify(${mode === "remaining" ? JSON.stringify([{ filePath: p.target, messages: [{ rule: "@extrulesproject/feature-envy-check", message: "Method 'work' is feature-envious toward 'Info'", line: 2 }] }]) : "[]"}));fs.writeFileSync(path.join(report,'runs/app/issuesReport.json'),'[]');fs.writeFileSync(path.join(report,'summary.json'),JSON.stringify({repositories:[{path:${JSON.stringify(p.source)},runs:[{ruleName:'@extrulesproject/feature-envy-check',success:true,exitCode:0,issuesReportPath:output}]}]}));`,
    );
    writeJson(path.join(p.taskDir, "smell-after.json"), [{ message: "stale" }]);
    writeText(script, fs.readFileSync(script, 'utf8').replace("const report=get('--outputDir')", detectionOnlyCheck + "const report=get('--outputDir')"));
    writeJson(
      path.join(p.taskDir, "homecheck-report/runs/old/issuesReport.json"),
      [],
    );
    const before = process.env.TEMP,
      code = await smellGate(p.taskDir, homecheck, p.source);
    assert.equal(code, mode === "clean" ? 0 : mode === "remaining" ? 1 : 3);
    assert.equal(process.env.TEMP, before);
    if (mode === "clean")
      assert.deepEqual(readJson(path.join(p.taskDir, "smell-after.json")), []);
    else if (mode === "remaining")
      assert.equal(
        readJson(path.join(p.taskDir, "smell-after.json")).length,
        1,
      );
    else assert(!isFile(path.join(p.taskDir, "smell-after.json")));
  });
test("真实 Agent 启动协议：附件位于隔离工作区，隐藏测试，保留模型参数并清理附件", async (t) => {
  const root = fixture(t),
    p = makeProject(root),
    script = path.join(root, "fake-agent.cjs"),
    capture = path.join(root, "command.json");
  writeText(
    path.join(p.source, "feature/src/test/Hidden.test.ets"),
    "hidden tests",
  );
  writeText(path.join(p.taskDir, "refactor-prompt.md"), "生产重构提示词");
  writeText(
    script,
    `const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),attachment=a[a.indexOf('-f')+1],dir=a[a.indexOf('--dir')+1];if(path.dirname(attachment)!==dir||fs.existsSync('feature/src/test/Hidden.test.ets'))throw Error('invalid isolation');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:a,prompt:fs.readFileSync(attachment,'utf8')}));fs.writeFileSync('feature/src/main/ets/Page.ets','export class Page { work() { return 9; } }');`,
  );
  const launcher = path.join(
    root,
    process.platform === "win32" ? "fake-agent.cmd" : "fake-agent",
  );
  writeText(
    launcher,
    process.platform === "win32"
      ? `@"${process.execPath}" "${script}" %*`
      : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"`,
  );
  if (process.platform !== "win32") fs.chmodSync(launcher, 0o755);
  assert.equal(
    await refactorGate(
      p.taskDir,
      p.source,
      launcher,
      undefined,
      "provider/model",
    ),
    0,
  );
  const captured = readJson(capture);
  assert(captured.args.includes("provider/model"));
  assert(captured.prompt.includes("生产重构提示词"));
  assert(!fs.existsSync(captured.args[captured.args.indexOf("-f") + 1]));
  assert(readText(p.target).includes("return 9"));
  assert(
    readText(path.join(p.source, "feature/src/test/Hidden.test.ets")).includes(
      "hidden",
    ),
  );
});
test("命令参数中的空格、中文和 shell 字符保持为单一参数", async (t) => {
  const root = fixture(t),
    args = ["中文 path", "value&more", "a|b", "$HOME", '"quoted"'];
  const result = await runCommand(
    [
      process.execPath,
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)))",
      "--",
      ...args,
    ],
    { cwd: root },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.output), args);
});
