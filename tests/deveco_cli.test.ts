import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundledDevecoCli } from "../src/deveco_cli.js";
import { devecoBuildGate, linterGate } from "../src/gate.js";
import { parseDevecoLintReport } from "../src/linter_report.js";
import { fixture, makeProject } from "./helpers.js";
import {
  readJson,
  readText,
  writeJson,
  writeText,
  removeGenerated,
} from "../src/utils.js";

function installation(
  root: string,
  script: string,
  name = "@deveco-test/deveco-code",
) {
  const prefix = path.join(root, "Global Node 有空格"),
    pkg = path.join(prefix, "node_modules", name),
    wrapper = path.join(pkg, "node_modules/@deveco/deveco-cli"),
    entry = path.join(wrapper, "cli.cjs"),
    launcher = path.join(
      prefix,
      process.platform === "win32" ? "deveco.cmd" : "deveco",
    );
  writeJson(path.join(pkg, "package.json"), { name, version: "test" });
  writeJson(path.join(wrapper, "package.json"), {
    name: "@deveco/deveco-cli",
    version: "1.3.4",
    bin: { devecocli: "cli.cjs" },
  });
  writeText(entry, script);
  writeText(
    path.join(pkg, "node_modules/@deveco/deveco-cli-common/dist/cli.js"),
    "// official implementation fixture",
  );
  writeJson(
    path.join(
      pkg,
      "node_modules/@deveco/deveco-cli-common/templates/application/code-linter.json5",
    ),
    {
      files: ["**/*.ets"],
      ruleSet: ["plugin:@typescript-eslint/recommended"],
      rules: {},
    },
  );
  writeText(
    launcher,
    process.platform === "win32"
      ? `@echo off\nrem node_modules/${name}/bin/deveco`
      : `#!/bin/sh\n# node_modules/${name}/bin/deveco`,
  );
  if (process.platform !== "win32") fs.chmodSync(launcher, 0o755);
  return { launcher, entry, prefix, wrapper, pkg };
}

test("从所选 DevEco Code npm shim 定位绑定的官方 CLI，不搜索其他 CLI PATH", (t) => {
  const root = fixture(t),
    installed = installation(root, ""),
    wrong = installation(path.join(root, "wrong"), "", "@deveco/deveco-code");
  const old = process.env.PATH;
  try {
    process.env.PATH = wrong.prefix;
    assert.equal(bundledDevecoCli(installed.launcher)?.entry, installed.entry);
    assert.equal(
      bundledDevecoCli(installed.launcher)?.devecoPackage,
      "@deveco-test/deveco-code",
    );
    fs.rmSync(
      path.join(
        installed.pkg,
        "node_modules/@deveco/deveco-cli-common/dist/cli.js",
      ),
    );
    assert.equal(bundledDevecoCli(installed.launcher), null);
  } finally {
    process.env.PATH = old;
  }
});

for (const [mode, expected] of [
  ["pass", 0],
  ["compile-fail", 3],
  ["introduced", 1],
  ["missing-baseline", 3],
  ["silent", 3],
  ["environment", 3],
] as const)
  test(`官方 CLI build 门禁 ${mode}：隔离副本、退出码与新完成证据`, async (t) => {
    const root = fixture(t),
      p = makeProject(root),
      capture = path.join(root, "captured.json");
    const installed = installation(
      root,
      `const fs=require('node:fs');if(process.argv[2]!=='build')throw Error('not build');if(!fs.existsSync(${JSON.stringify(capture)}))fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));fs.writeFileSync('only-in-validation.txt','runtime');${mode === "pass" ? "console.log('> hvigor BUILD SUCCESSFUL');console.log('Build completed successfully');" : mode === "introduced" ? "if(fs.readFileSync('feature/src/main/ets/Page.ets','utf8').includes('return 2')){console.error('ArkTS compilation failed in Page.ets');process.exit(1);}console.log('Build completed successfully');" : ["compile-fail", "missing-baseline"].includes(mode) ? "console.error('ArkTS compilation failed: Type number is not assignable');process.exit(1);" : mode === "environment" ? "console.error('SDK path not found');process.exit(1);" : "console.log('Usage: devecocli build');"}`,
    );
    writeJson(path.join(p.source, "build-profile.json5"), {
      app: { products: [{ name: "default" }] },
      modules: [{ name: "feature", srcPath: "feature" }],
    });
    writeJson(path.join(p.source, "feature/src/main/module.json5"), {
      module: { type: "entry", name: "feature" },
    });
    if (["compile-fail", "introduced"].includes(mode)) {
      writeText(
        path.join(
          p.taskDir,
          "baseline-production/feature/src/main/ets/Page.ets",
        ),
        readText(p.target),
      );
      writeJson(path.join(p.taskDir, "refactor-changes.json"), {
        changedProductionFiles: ["feature/src/main/ets/Page.ets"],
        newProductionFiles: [],
      });
      writeText(p.target, readText(p.target).replace("return 1", "return 2"));
    }
    const before = readText(p.target),
      old = process.env.PATH;
    let code: number;
    try {
      process.env.PATH = "";
      code = await devecoBuildGate(p.taskDir, p.source, installed.launcher);
    } finally {
      process.env.PATH = old;
    }
    assert.equal(code!, expected);
    const captured = readJson(capture),
      workspace = readJson(
        path.join(p.taskDir, "validation-workspace.json"),
      ).path;
    t.after(() => removeGenerated(workspace, path.dirname(workspace)));
    assert.equal(captured.cwd.toLowerCase(), workspace.toLowerCase());
    assert.deepEqual(captured.args, [
      "build",
      "--product",
      "default",
      "--modules",
      "feature@default",
    ]);
    const baselineMeta = path.join(
      p.taskDir,
      "build-baseline-validation/validation-workspace.json",
    );
    if (fs.existsSync(baselineMeta)) {
      const baselineWorkspace = readJson(baselineMeta).path;
      t.after(() =>
        removeGenerated(baselineWorkspace, path.dirname(baselineWorkspace)),
      );
    }
    assert.equal(readText(p.target), before);
    assert(!fs.existsSync(path.join(p.source, "only-in-validation.txt")));
    assert.equal(
      readJson(path.join(p.taskDir, "build-evidence.json")).status,
      expected === 0 ? "PASS" : expected === 1 ? "FAIL" : "BLOCKED",
    );
    if (mode === "introduced")
      assert.equal(
        readJson(path.join(p.taskDir, "build-evidence.json")).baseline.status,
        "PASS",
      );
    if (mode === "compile-fail")
      assert.equal(
        readJson(path.join(p.taskDir, "build-evidence.json")).classification,
        "BASELINE_BUILD_FAILURE",
      );
    if (mode === "missing-baseline")
      assert.equal(
        readJson(path.join(p.taskDir, "build-evidence.json")).classification,
        "BUILD_BASELINE_UNAVAILABLE",
      );
  });

test("未安装 CLI 平台实现时明确 BLOCKED，不回退 hvigor 或执行 Agent", async (t) => {
  const root = fixture(t),
    p = makeProject(root),
    installed = installation(root, "throw Error('must not run');");
  fs.rmSync(
    path.join(
      installed.pkg,
      "node_modules/@deveco/deveco-cli-common/dist/cli.js",
    ),
  );
  assert.equal(
    await devecoBuildGate(p.taskDir, p.source, installed.launcher),
    3,
  );
  assert.equal(
    readJson(path.join(p.taskDir, "build-evidence.json")).status,
    "BLOCKED",
  );
});

for (const [mode, expected] of [
  ["clean", 0],
  ["existing", 0],
  ["introduced", 1],
  ["new-file", 1],
  ["missing", 3],
  ["invalid", 3],
  ["tool-error", 3],
] as const)
  test(`官方 CLI Linter ${mode}：新 JSON 证据、变更范围、独立副本`, async (t) => {
    const root = fixture(t),
      p = makeProject(root),
      capture = path.join(root, "lint-capture.json"),
      before =
        "export class Page {\n  work(): number {\n    return 1;\n  }\n}\n";
    writeText(p.target, before.replace("return 1", "return 2"));
    if (mode !== "new-file")
      writeText(
        path.join(
          p.taskDir,
          "baseline-production/feature/src/main/ets/Page.ets",
        ),
        before,
      );
    writeJson(path.join(p.taskDir, "refactor-changes.json"), {
      changedProductionFiles: ["feature/src/main/ets/Page.ets"],
    });
    const line = mode === "existing" ? 1 : 3,
      hasIssue = ["existing", "introduced", "new-file"].includes(mode);
    const installed = installation(
      root,
      `const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);if(a[0]!=='check'||a[1]!=='lint'||a.includes('--fix'))throw Error('wrong command');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:a,cwd:process.cwd()}));if(${JSON.stringify(mode)}==='tool-error')process.exit(7);if(${JSON.stringify(mode)}!=='missing'){const out=a[a.indexOf('--output-path')+1];fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,${JSON.stringify(mode)}==='invalid'?'{}':JSON.stringify({issues:${hasIssue ? `[{file:a[2],line:${line},column:1,severity:'Warning',rule:'rule/test',message:'diagnostic'}]` : "[]"},summary:{filesChecked:${hasIssue ? 1 : 0},issues:${hasIssue ? 1 : 0},errors:0,warnings:${hasIssue ? 1 : 0},suggestions:0}}));}console.log('lint finished');`,
    );
    const old = process.env.PATH;
    let code: number;
    try {
      process.env.PATH = "";
      code = await linterGate(p.taskDir, p.source, installed.launcher);
    } finally {
      process.env.PATH = old;
    }
    assert.equal(code!, expected);
    const state = readJson(path.join(p.taskDir, "linter-evidence.json"));
    assert.equal(
      state.status,
      expected === 0 ? "PASS" : expected === 1 ? "FAIL" : "BLOCKED",
    );
    const copied = readJson(
      path.join(p.taskDir, "linter-validation/validation-workspace.json"),
    ).path;
    t.after(() => removeGenerated(copied, path.dirname(copied)));
    const captured = readJson(capture);
    assert.equal(captured.cwd.toLowerCase(), copied.toLowerCase());
    assert(!captured.args.includes("--incremental"));
    assert(captured.args.includes("--config-path"));
    assert.equal(readText(p.target), before.replace("return 1", "return 2"));
    assert(!fs.existsSync(path.join(p.source, "code-linter.json5")));
    assert.equal(
      readJson(path.join(p.taskDir, "linter-after.json")).length,
      expected === 1 ? 1 : 0,
    );
  });

test("Linter JSON 不能用损坏的计数、未知严重级别或越界文件冒充有效结果", (t) => {
  const root = fixture(t),
    base = {
      issues: [
        {
          file: "Page.ets",
          line: 1,
          severity: "Error",
          rule: "rule",
          message: "bad",
        },
      ],
      summary: {
        filesChecked: 1,
        issues: 1,
        errors: 1,
        warnings: 0,
        suggestions: 0,
      },
    };
  assert.equal(parseDevecoLintReport(base, root).length, 1);
  for (const mutate of [
    (r: any) => (r.summary.issues = 0),
    (r: any) => (r.issues[0].severity = "constructor"),
    (r: any) => (r.issues[0].file = "../outside.ets"),
    (r: any) => (r.issues[0].line = 0),
  ]) {
    const copy = structuredClone(base);
    mutate(copy);
    assert.throws(() => parseDevecoLintReport(copy, root));
  }
});
