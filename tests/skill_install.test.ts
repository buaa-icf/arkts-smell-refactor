import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fixture } from "./helpers.js";
import { readJson, writeJson, writeText } from "../src/utils.js";

const repository = path.resolve(".");
const installer = path.join(repository, "scripts/install-deveco-skill.mjs");
const sourceLauncher = path.join(
  repository,
  "skills/arkts-smell-refactor/scripts/run.mjs",
);
function setup(t: TestContext) {
  const base = fixture(t);
  const source = path.join(base, "完整 Skill 制品");
  writeText(
    path.join(source, "SKILL.md"),
    "---\nname: arkts-smell-refactor\ndescription: fixture\n---\n",
  );
  writeJson(path.join(source, "runtime/package.json"), { type: "module" });
  writeText(
    path.join(source, "runtime/dist/portable_skill.js"),
    `export async function runPortableSkill(args, options) {
    console.log(JSON.stringify({ args, options, cwd: process.cwd() }));
    return args[0] === 'blocked-fixture' ? 3 : 0;
  }`,
  );
  for (const name of [
    "runtime/dist/ide_bridge.js",
    "runtime/node_modules/@arkts-refactor/homecheck-runtime/scan.cjs",
    "runtime/deveco-plugin/src/main/resources/bridge/ide_bridge.cjs",
    "runtime/deveco-plugin/src/main/resources/bridge/homecheck_scan.cjs",
  ])
    writeText(path.join(source, name), "// controlled installation fixture\n");
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  fs.copyFileSync(sourceLauncher, path.join(source, "scripts/run.mjs"));
  fs.copyFileSync(installer, path.join(source, "scripts/install.mjs"));
  fs.copyFileSync(
    path.join(repository, "scripts/skill-package-integrity.mjs"),
    path.join(source, "scripts/skill-package-integrity.mjs"),
  );
  const names = fs
    .readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(source, path.join(entry.parentPath, entry.name))
        .replaceAll("\\", "/"),
    );
  writeJson(path.join(source, "package-manifest.json"), {
    schemaVersion: 1,
    format: "arkts-smell-refactor-portable",
    files: Object.fromEntries(
      names.map((name) => [
        name,
        createHash("sha256")
          .update(fs.readFileSync(path.join(source, name)))
          .digest("hex"),
      ]),
    ),
  });
  const configHome = path.join(base, "用户 配置");
  const configDirectory = path.join(configHome, "deveco");
  const skill = path.join(configDirectory, "skills/arkts-smell-refactor");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    LOCALAPPDATA: path.join(base, "Local App Data"),
  };
  return {
    base,
    source,
    configHome,
    configDirectory,
    skill,
    env,
    launcher: path.join(skill, "scripts/run.mjs"),
    portableInstaller: path.join(source, "scripts/install.mjs"),
  };
}
function run(
  script: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  nodeArgs: string[] = [],
) {
  const result = spawnSync(process.execPath, [...nodeArgs, script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}

test("offline Skill installs without a project and forwards each invocation to its relative bundled runtime", (t) => {
  const f = setup(t);
  const installed = run(f.portableInstaller, [], f.base, f.env);
  assert.equal(installed.status, 0, installed.stderr);
  const result = JSON.parse(installed.stdout);
  assert.equal(result.scope, "user");
  assert.equal(result.skillDirectory, f.skill);
  assert.deepEqual(readJson(path.join(f.skill, "installation.json")), {
    schemaVersion: 2,
    runtime: "runtime",
    settingsFile: "settings.json",
  });
  assert.deepEqual(readJson(path.join(f.skill, "settings.json")), {
    linterMode: "required",
  });
  for (const name of ["第一个工程", "Second Project"]) {
    const project = path.join(f.base, name);
    fs.mkdirSync(project);
    const invoked = run(f.launcher, ["history"], project, f.env);
    assert.equal(invoked.status, 0, invoked.stderr + invoked.stdout);
    const value = JSON.parse(invoked.stdout);
    assert.equal(value.cwd, project);
    assert.deepEqual(value.args, ["history"]);
    assert.equal(value.options.runtimeRoot, path.join(f.skill, "runtime"));
    assert.equal(
      value.options.settingsFile,
      path.join(f.skill, "settings.json"),
    );
    assert.equal(fs.existsSync(path.join(project, ".deveco")), false);
  }
  const args = ["doctor", "--project", f.base, "--config", "one-run.json"];
  assert.deepEqual(
    JSON.parse(run(f.launcher, args, f.base, f.env).stdout).args,
    args,
  );
  assert.equal(run(f.launcher, ["blocked-fixture"], f.base, f.env).status, 3);
  assert.deepEqual(
    JSON.parse(run(f.launcher, ["--help"], f.base, f.env).stdout).args,
    ["--help"],
  );
});

test("installation copies only tool settings and discards old repository, project and credential fields", (t) => {
  const f = setup(t);
  const config = path.join(f.base, "old-config.json");
  const original = {
    projectRoot: f.base,
    backend: repository,
    bridgePath: "old-bridge",
    runs: "old-runs",
    node: process.execPath,
    token: "do-not-copy",
    studio: "",
    deveco: "deveco",
    linterMode: "skip",
    timeoutMs: 30_000,
  };
  writeJson(config, original);
  const bytes = fs.readFileSync(config);
  const installed = run(
    installer,
    ["--package", f.source, "--config", config],
    f.base,
    f.env,
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(fs.readFileSync(config), bytes);
  assert.deepEqual(readJson(path.join(f.skill, "settings.json")), {
    studio: "",
    deveco: "deveco",
    linterMode: "skip",
    timeoutMs: 30_000,
  });
  assert.deepEqual(JSON.parse(installed.stdout).ignoredSettings.sort(), [
    "backend",
    "bridgePath",
    "node",
    "projectRoot",
    "runs",
    "token",
  ]);
  assert.equal(
    fs
      .readFileSync(path.join(f.skill, "installation.json"), "utf8")
      .includes(repository),
    false,
  );
});

test("offline installation dry-run writes nothing and validates complete artifact integrity", (t) => {
  const f = setup(t);
  const dry = run(f.portableInstaller, ["--dry-run"], f.base, f.env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(fs.existsSync(f.configHome), false);
  writeText(
    path.join(f.source, "runtime/dist/portable_skill.js"),
    "throw new Error('tampered');",
  );
  const changed = run(f.portableInstaller, ["--dry-run"], f.base, f.env);
  assert.equal(changed.status, 2);
  assert.match(changed.stderr, /校验失败/);
  assert.equal(fs.existsSync(f.configHome), false);
});

test("offline installation preserves existing files, backs up on force, and restores after replacement failure", (t) => {
  const f = setup(t);
  assert.equal(run(f.portableInstaller, [], f.base, f.env).status, 0);
  const sentinel = path.join(f.skill, "custom.txt");
  writeText(sentinel, "preserve old installation");
  const oldTools = {
    studio: path.join(f.base, "Original Studio"),
    deveco: "deveco",
    linterMode: "skip",
    timeoutMs: 45_000,
  };
  writeJson(path.join(f.skill, "settings.json"), {
    ...oldTools,
    projectRoot: f.base,
    node: process.execPath,
  });
  const duplicate = run(f.portableInstaller, [], f.base, f.env);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /已存在/);
  const preload = path.join(f.base, "fail-stage-rename.cjs");
  writeText(
    preload,
    `const fs = require('node:fs'); const original = fs.renameSync;
    fs.renameSync = (from, to) => { if (String(from).includes('.arkts-smell-refactor-stage-')) throw new Error('controlled replacement failure'); return original(from,to); };`,
  );
  const failed = run(f.portableInstaller, ["--force"], f.base, f.env, [
    "--require",
    preload,
  ]);
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /旧版已恢复/);
  assert.equal(
    fs.readFileSync(sentinel, "utf8"),
    "preserve old installation\n",
  );
  const forced = run(f.portableInstaller, ["--force"], f.base, f.env);
  assert.equal(forced.status, 0, forced.stderr);
  const backup = JSON.parse(forced.stdout).backupDirectory;
  assert.equal(
    path.dirname(backup),
    path.join(f.configDirectory, "arkts-skill-backups"),
  );
  assert.equal(
    fs.readFileSync(path.join(backup, "custom.txt"), "utf8"),
    "preserve old installation\n",
  );
  assert.equal(fs.existsSync(sentinel), false);
  assert.deepEqual(readJson(path.join(f.skill, "settings.json")), oldTools);
  const overrides = path.join(f.base, "new-tools.json");
  writeJson(overrides, { ohpm: "ohpm", linterMode: "required" });
  const newStudio = path.join(f.base, "New Studio");
  const updated = run(
    f.portableInstaller,
    ["--force", "--config", overrides, "--studio", newStudio],
    f.base,
    f.env,
  );
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(readJson(path.join(f.skill, "settings.json")), {
    ...oldTools,
    studio: newStudio,
    ohpm: "ohpm",
    linterMode: "required",
  });
});

test("offline upgrade migrates legacy external tool settings and stops on unreadable previous configuration", (t) => {
  for (const reference of ["configFile", "settingsFile"]) {
    const f = setup(t);
    const legacyFile = path.join(f.base, "legacy-settings.json");
    const tools = {
      studio: path.join(f.base, "Legacy Studio"),
      hvigor: "hvigorw",
      linterMode: "skip",
    };
    writeJson(legacyFile, {
      ...tools,
      backend: repository,
      projectRoot: f.base,
      runs: "old-runs",
      node: process.execPath,
      token: "do-not-copy",
    });
    const original = fs.readFileSync(legacyFile);
    writeJson(path.join(f.skill, "installation.json"), {
      schemaVersion: 1,
      backend: repository,
      [reference]: legacyFile,
    });
    const migrated = run(f.portableInstaller, ["--force"], f.base, f.env);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.deepEqual(readJson(path.join(f.skill, "settings.json")), tools);
    assert.deepEqual(fs.readFileSync(legacyFile), original);
    assert.deepEqual(readJson(path.join(f.skill, "installation.json")), {
      schemaVersion: 2,
      runtime: "runtime",
      settingsFile: "settings.json",
    });
    const broken = path.join(f.skill, "settings.json");
    writeText(broken, "{ invalid previous JSON");
    const refused = run(f.portableInstaller, ["--force"], f.base, f.env);
    assert.equal(refused.status, 2);
    assert.ok(refused.stderr.includes(broken));
    assert.match(refused.stderr, /无法读取旧工具配置/);
    assert.equal(fs.readFileSync(broken, "utf8"), "{ invalid previous JSON\n");
  }
});

test("offline installation rejects invalid flags, nonportable tool paths, links, and incomplete runtime startup", (t) => {
  const f = setup(t);
  for (const args of [
    ["--project", f.base],
    ["--runs", f.base],
    ["--unknown"],
    ["--config"],
    ["--dry-run", "--dry-run"],
  ])
    assert.equal(run(f.portableInstaller, args, f.base, f.env).status, 2);
  const relative = run(f.portableInstaller, [], f.base, {
    ...f.env,
    XDG_CONFIG_HOME: "relative-config",
  });
  assert.equal(relative.status, 2);
  const invalid = path.join(f.base, "invalid.json");
  writeJson(invalid, { studio: "relative/studio" });
  assert.equal(
    run(f.portableInstaller, ["--config", invalid], f.base, f.env).status,
    2,
  );
  assert.equal(fs.existsSync(f.configHome), false);
  const missing = run(sourceLauncher, ["doctor"], f.base, f.env);
  assert.equal(missing.status, 3);
  assert.equal(JSON.parse(missing.stdout).result.verdict, "BLOCKED");
  const outside = path.join(f.base, "outside");
  writeText(path.join(outside, "sentinel.txt"), "unchanged");
  fs.mkdirSync(path.dirname(f.skill), { recursive: true });
  fs.symlinkSync(
    outside,
    f.skill,
    process.platform === "win32" ? "junction" : "dir",
  );
  const linked = run(f.portableInstaller, ["--force"], f.base, f.env);
  assert.equal(linked.status, 2);
  assert.match(linked.stderr, /链接|junction/);
  assert.equal(
    fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"),
    "unchanged\n",
  );
  assert.equal(
    fs.existsSync(path.join(f.configDirectory, "arkts-skill-backups")),
    false,
  );
});
