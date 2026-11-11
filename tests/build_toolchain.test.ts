import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { devecoBuildGate, devecoTestGate } from "../src/gate.js";
import {
  capturedToolchain,
  successfulBuildToolchain,
} from "../src/build_toolchain.js";
import {
  readJson,
  removeGenerated,
  writeJson,
  writeText,
} from "../src/utils.js";
import { fixture, makeProject, suite, success } from "./helpers.js";

test("官方 CLI 成功环境跨 wrapper 捕获，测试不借用 PATH 的其他 SDK/Hvigor", async (t) => {
  const root = fixture(t),
    p = makeProject(root);
  const prefix = path.join(root, "global 安装"),
    pkg = path.join(prefix, "node_modules/@deveco-test/deveco-code");
  const cli = path.join(pkg, "node_modules/@deveco/deveco-cli");
  const impl = path.join(
    pkg,
    "node_modules/@deveco/deveco-cli-common/dist/cli.js",
  );
  const launcher = path.join(
    prefix,
    process.platform === "win32" ? "deveco.cmd" : "deveco",
  );
  const sdk = path.join(root, "配套 SDK"),
    javaBin = path.join(root, "jbr/bin");
  const hvigor = path.join(root, "同一套工具/hvigor/bin/hvigorw.js"),
    capture = path.join(root, "test-env.json");
  fs.mkdirSync(sdk, { recursive: true });
  writeJson(path.join(root, "package.json"), { type: "commonjs" });
  writeText(
    path.join(javaBin, process.platform === "win32" ? "java.exe" : "java"),
    "fixture",
  );
  writeJson(path.join(pkg, "package.json"), {
    name: "@deveco-test/deveco-code",
  });
  writeJson(path.join(cli, "package.json"), {
    name: "@deveco/deveco-cli",
    version: "1.3.4",
    bin: { devecocli: "cli.cjs" },
  });
  writeText(launcher, `# node_modules/@deveco-test/deveco-code/bin/deveco`);
  if (process.platform !== "win32") fs.chmodSync(launcher, 0o755);
  writeText(
    path.join(cli, "cli.cjs"),
    `const cp=require('node:child_process'); const r=cp.spawnSync(process.execPath,[${JSON.stringify(impl)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status ?? 1);`,
  );
  writeText(
    impl,
    `const cp=require('node:child_process');const r=cp.spawnSync(process.execPath,[${JSON.stringify(hvigor)},'assembleHap'],{env:{...process.env,DEVECO_SDK_HOME:${JSON.stringify(sdk)},PATH:${JSON.stringify(javaBin)},JAVA_HOME:${JSON.stringify(path.dirname(javaBin))}},stdio:'inherit'});if(r.status)process.exit(r.status);console.log('Build completed successfully');`,
  );
  writeText(
    hvigor,
    `const fs=require('node:fs'),path=require('node:path');if(process.argv.includes('test')){fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({node:process.execPath,sdk:process.env.DEVECO_SDK_HOME,java:process.env.JAVA_HOME,args:process.argv.slice(2)}));const dir=path.join('feature','.test/default/intermediates/test/coverage_data');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'test_result.txt'),${JSON.stringify(success())});}console.log('BUILD SUCCESSFUL');`,
  );
  writeJson(path.join(p.source, "build-profile.json5"), {
    app: { products: [{ name: "demo" }] },
    modules: [{ name: "featureName", srcPath: "feature" }],
  });
  writeJson(path.join(p.source, "feature/src/main/module.json5"), {
    module: { type: "entry", name: "featureName" },
  });
  suite(p.source, "local");
  const oldPath = process.env.PATH,
    oldSdk = process.env.DEVECO_SDK_HOME;
  try {
    process.env.PATH = "";
    process.env.DEVECO_SDK_HOME = path.join(root, "错误 SDK");
    assert.equal(await devecoBuildGate(p.taskDir, p.source, launcher), 0);
    const build = readJson(path.join(p.taskDir, "build-evidence.json"));
    t.after(() =>
      removeGenerated(build.workspace, path.dirname(build.workspace)),
    );
    assert.equal(build.toolchain.sdk, sdk);
    assert.equal(build.toolchain.hvigor, hvigor);
    assert.equal(build.toolchain.status, "CONFIRMED");
    assert.equal(await devecoTestGate(p.taskDir, p.source, launcher), 0);
    const actual = readJson(capture);
    assert.equal(actual.sdk, sdk);
    assert.equal(actual.node.toLowerCase(), process.execPath.toLowerCase());
    assert.equal(actual.java, path.dirname(javaBin));
    assert(actual.args.includes("product=demo"));
    assert.equal(
      readJson(path.join(p.taskDir, "test-results.json")).jobs[0].summary.tests,
      1,
    );
    assert.equal(
      readJson(path.join(p.taskDir, "test-toolchain.json")).buildRunId,
      build.runId,
    );
    for (const bad of [
      { ...build, status: "FAIL" },
      { ...build, runId: "" },
      { ...build, sourceRoot: root },
      { ...build, cliEntry: "another CLI" },
      { ...build, toolchain: { status: "UNAVAILABLE" } },
      {
        ...build,
        toolchain: {
          ...build.toolchain,
          env: { ...build.toolchain.env, DEVECO_SDK_HOME: "another SDK" },
        },
      },
      { ...build, toolchain: { ...build.toolchain, sdk: "missing SDK" } },
    ]) {
      writeJson(path.join(p.taskDir, "build-evidence.json"), bad);
      assert.throws(() =>
        successfulBuildToolchain(
          p.taskDir,
          p.source,
          build.workspace,
          path.join(cli, "cli.cjs"),
        ),
      );
    }
    assert.equal(await devecoTestGate(p.taskDir, p.source, launcher), 3);
    assert.equal(
      readJson(path.join(p.taskDir, "test-results.json")).status,
      "BLOCKED",
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldSdk === undefined) delete process.env.DEVECO_SDK_HOME;
    else process.env.DEVECO_SDK_HOME = oldSdk;
  }
});

test("缺少实际 CLI 环境或存在多个 SDK 时阻塞，不根据目录名猜测", (t) => {
  const root = fixture(t),
    captures = path.join(root, "capture");
  fs.mkdirSync(captures);
  assert.throws(() => capturedToolchain(captures, root), /未产生/);
  for (const [i, sdk] of ["SDK1", "SDK2"].entries())
    writeJson(path.join(captures, `${i}.json`), {
      cwd: root,
      node: process.execPath,
      hvigor: "hvigorw.js",
      sdk,
      env: { PATH: "" },
    });
  assert.throws(() => capturedToolchain(captures, root), /多套/);
});
