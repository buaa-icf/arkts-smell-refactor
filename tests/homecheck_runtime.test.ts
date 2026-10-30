import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { bundledHomecheck } from "../src/homecheck_runtime.js";
import { homecheckReport } from "../src/smell.js";
import { runCommand, which } from "../src/process.js";
import { fixture } from "./helpers.js";
import { hash, readJson, writeJson, writeText } from "../src/utils.js";

test("内置扫描器依赖完整且固定，ArkTS 扫描不需要本机 HomeCheck/npm/CLOC", async (t) => {
  const homecheck = bundledHomecheck();
  assert(homecheck);
  const manifest = readJson(path.join(homecheck, "runtime-manifest.json"));
  assert.equal(manifest.homecheck, "0.9.9-rc.26");
  assert.equal(manifest.arkanalyzer, "1.0.92");
  const require = createRequire(path.join(homecheck, "package.json"));
  for (const name of ["homecheck", "arkanalyzer", "ohos-typescript"])
    assert(require.resolve(name).startsWith(homecheck));
  const root = fixture(t),
    source = path.join(root, "中文 工程"),
    output = path.join(root, "out"),
    target = path.join(source, "src/main/ets/Page.ets"),
    unselected = path.join(source, "src/main/ets/Other.ets");
  const long =
    "export class Page {\n  work(): number {\n    let total = 0;\n" +
    Array.from({ length: 100 }, (_, i) => `    total += ${i};`).join("\n") +
    "\n    return total;\n  }\n}\n";
  writeText(target, long);
  writeText(unselected, long);
  const original = hash(target),
    config = path.join(root, "project.json"),
    rulesFile = path.join(root, "rules.json"),
    summary = path.join(output, "summary.json");
  const rules = [
    "feature-envy",
    "long-method",
    "switch-statement",
    "code-clone-fragment",
  ].map((n) => `@extrulesproject/${n}-check`);
  writeJson(config, {
    projectPath: source,
    projectName: "fixture",
    checkFiles: ["src/main/ets/Page.ets"],
    ohosSdkPath: "",
    hmsSdkPath: "",
  });
  writeJson(rulesFile, {
    ...readJson(path.join(homecheck, "config/ruleConfig.json")),
    extRuleSet: [
      {
        ruleSetName: "extrulesproject",
        extRules: Object.fromEntries(rules.map((rule) => [rule, 2])),
      },
    ],
  });
  const env = { ...process.env, PATH: "", NODE_PATH: "", EXTRULES_PERF: "1" };
  const result = await runCommand(
    [
      process.execPath,
      path.join(homecheck, "scan.cjs"),
      "--project-config",
      config,
      "--rule-config",
      rulesFile,
      "--summary",
      summary,
    ],
    { cwd: root, env },
  );
  assert.equal(result.code, 0, result.output);
  const report = readJson(summary);
  assert.equal(report.success, true);
  assert.deepEqual(report.loadedRules, rules);
  assert.deepEqual(report.scannedFiles, [fs.realpathSync(target)]);
  assert.equal(
    homecheckReport(output, source, rules[1]),
    path.join(output, "issuesReport.json"),
  );
  const issues = readJson(
    path.join(output, "issuesReport.json"),
  ) as unknown as any[];
  assert(
    issues.some((item) => item.messages.some((m: any) => m.rule === rules[1])),
    "actual detector must report the long method",
  );
  assert(!issues.some((item) => item.filePath.endsWith("Other.ets")));
  assert(!fs.existsSync(path.join(output, "perfReport.json")));
  assert.equal(hash(target), original);
  // An unsupported rule must fail rather than return a clean report.
  writeJson(rulesFile, {
    extRuleSet: [
      { ruleSetName: "extrulesproject", extRules: { "not-a-rule": 2 } },
    ],
  });
  const bad = await runCommand(
    [
      process.execPath,
      path.join(homecheck, "scan.cjs"),
      "--project-config",
      config,
      "--rule-config",
      rulesFile,
      "--summary",
      summary,
    ],
    { cwd: root, env },
  );
  assert.notEqual(bad.code, 0);
  assert.equal(readJson(summary).success, false);
  assert.throws(() => homecheckReport(output, source, rules[1]));
});

test("单个 tgz 可离线全新安装，扫描依赖不借用源仓库或上级 node_modules", async (t) => {
  const npm = which("npm");
  assert(npm);
  const root = fixture(t),
    tgz = path.resolve("vendor/arkts-refactor-homecheck-runtime-1.0.0.tgz");
  writeJson(path.join(root, "package.json"), {
    name: "runtime-clean-install",
    version: "1.0.0",
    private: true,
    dependencies: {
      "@arkts-refactor/homecheck-runtime": "file:" + tgz.replaceAll("\\", "/"),
    },
  });
  const installed = await runCommand(
    [
      npm,
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(root, "npm-cache"),
    ],
    { cwd: root },
  );
  assert.equal(installed.code, 0, installed.output);
  const runtime = path.join(
    root,
    "node_modules/@arkts-refactor/homecheck-runtime",
  );
  const probe = await runCommand(
    [
      process.execPath,
      "-e",
      `const assert=require('assert'),path=require('path'),{createRequire}=require('module');const base=${JSON.stringify(runtime)},r=createRequire(path.join(base,'package.json'));for(const p of ['homecheck','arkanalyzer','ohos-typescript','graceful-fs'])assert(r.resolve(p).startsWith(base));require(path.join(base,'rules/lib/index.js'));console.log('isolated runtime loaded')`,
    ],
    { cwd: root, env: { ...process.env, NODE_PATH: "" } },
  );
  assert.equal(probe.code, 0, probe.output);
  assert(probe.output.includes("isolated runtime loaded"));
  // Every bundled JS package must remain portable; no host-specific native binaries.
  const binaries: string[] = [];
  function visit(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (/\.(node|exe|dll|dylib|so)$/i.test(e.name)) binaries.push(p);
    }
  }
  visit(runtime);
  assert.deepEqual(binaries, []);
});
