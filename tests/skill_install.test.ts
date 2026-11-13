import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
  const project = path.join(base, "中文 安装 Project");
  const name = "entry/src/main/ets/Page.ets";
  writeText(
    path.join(project, name),
    "export class Page { update() { return 1; } }\n",
  );
  writeText(path.join(project, "build-profile.json5"), "{}");
  writeText(path.join(project, "hvigor/hvigor-config.json5"), "{}");
  writeJson(path.join(base, "report.json"), {
    filePath: name,
    messages: [
      {
        line: 1,
        rule: "@extrulesproject/long-method-check",
        message: "Method 'update' is too long",
      },
    ],
  });
  const runs = path.join(base, "持久证据 runs");
  const skill = path.join(project, ".deveco/skills/arkts-smell-refactor");
  const launcher = path.join(skill, "scripts/run.mjs");
  const studio = path.join(base, "DevEco Studio");
  const env = {
    ...process.env,
    LOCALAPPDATA: path.join(base, "Local App Data"),
    DEVECO_HOME: studio,
  };
  return { base, project, runs, skill, launcher, studio, env };
}

function run(
  script: string,
  args: string[],
  cwd = repository,
  env = process.env,
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

test("DevEco skill installs into a Chinese spaced project and launches the real backend with caller-relative inputs", (t) => {
  const f = setup(t);
  const installation = run(
    installer,
    ["--project", f.project, "--runs", f.runs],
    repository,
    f.env,
  );
  assert.equal(installation.status, 0, installation.stderr);
  const output = JSON.parse(installation.stdout);
  assert.equal(output.skillDirectory, f.skill);
  assert.equal(output.dryRun, false);
  assert.ok(fs.existsSync(path.join(f.skill, "SKILL.md")));
  assert.equal(
    fs.readFileSync(path.join(f.skill, "references/cli.md"), "utf8"),
    fs.readFileSync(
      path.join(repository, "skills/arkts-smell-refactor/references/cli.md"),
      "utf8",
    ),
  );
  const binding = readJson(path.join(f.skill, "installation.json"));
  assert.deepEqual(binding, {
    schemaVersion: 1,
    backend: repository,
    settingsFile: path.join(f.skill, "settings.json"),
  });
  const settings = readJson(binding.settingsFile);
  assert.equal(settings.projectRoot, fs.realpathSync.native(f.project));
  assert.equal(settings.node, process.execPath);
  assert.equal(settings.studio, f.studio);
  assert.equal(settings.runs, f.runs);
  assert.equal(settings.linterMode, "required");

  const doctor = run(f.launcher, ["doctor"], f.base, f.env);
  assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
  const checked = JSON.parse(doctor.stdout);
  assert.equal(checked.ok, true);
  assert.equal(checked.projectRoot, settings.projectRoot);
  assert.equal(checked.result.hello.backendLanguage, "typescript");
  assert.ok(Array.isArray(checked.result.environment.tools));
  const imported = run(
    f.launcher,
    ["import", "--file", "report.json"],
    f.base,
    f.env,
  );
  assert.equal(imported.status, 0, imported.stderr + imported.stdout);
  assert.equal(JSON.parse(imported.stdout).result.issues.length, 1);
  assert.equal(
    run(f.launcher, ["doctor", "--project", f.project], f.base, f.env).status,
    2,
  );
  assert.equal(
    run(f.launcher, ["doctor", "--config=other.json"], f.base, f.env).status,
    2,
  );
  const invalidCommand = run(f.launcher, ["unknown-command"], f.base, f.env);
  assert.equal(
    invalidCommand.status,
    2,
    "launcher must preserve backend failure status",
  );
  assert.equal(JSON.parse(invalidCommand.stdout).ok, false);
  const help = run(f.launcher, ["--help"], f.base, f.env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
});

test("DevEco skill reuses an existing absolute config without changing its bytes", (t) => {
  const f = setup(t);
  const settingsFile = path.join(f.base, "existing settings.json");
  const original =
    JSON.stringify(
      {
        projectRoot: f.project,
        backend: repository,
        runs: f.runs,
        node: process.execPath,
        studio: "",
        linterMode: "skip",
        timeoutMs: 30_000,
      },
      null,
      4,
    ) + "\n";
  writeText(settingsFile, original);
  const installation = run(
    installer,
    ["--config", settingsFile],
    repository,
    f.env,
  );
  assert.equal(installation.status, 0, installation.stderr);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), original);
  assert.equal(fs.existsSync(path.join(f.skill, "settings.json")), false);
  assert.equal(
    readJson(path.join(f.skill, "installation.json")).settingsFile,
    settingsFile,
  );
  const history = run(f.launcher, ["history"], f.base, f.env);
  assert.equal(history.status, 0, history.stderr + history.stdout);
  assert.deepEqual(JSON.parse(history.stdout).result.records, []);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), original);
});

test("DevEco skill dry-run validates and reports persistent defaults without writing files", (t) => {
  const f = setup(t);
  const before = fs.readdirSync(f.project, { recursive: true });
  const installation = run(
    installer,
    ["--project", f.project, "--dry-run"],
    repository,
    f.env,
  );
  assert.equal(installation.status, 0, installation.stderr);
  const plan = JSON.parse(installation.stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.skillDirectory, f.skill);
  assert.equal(fs.existsSync(path.join(f.project, ".deveco")), false);
  assert.equal(fs.existsSync(plan.runs), false);
  assert.equal(fs.existsSync(f.env.LOCALAPPDATA!), false);
  assert.deepEqual(fs.readdirSync(f.project, { recursive: true }), before);
  if (process.platform === "win32")
    assert.ok(
      plan.runs.startsWith(
        path.join(f.env.LOCALAPPDATA!, "arkts-smell-refactor/runs") + path.sep,
      ),
    );
});

test("DevEco skill refuses replacement by default and force preserves the whole old installation", (t) => {
  const f = setup(t);
  const args = ["--project", f.project, "--runs", f.runs];
  const first = run(installer, args, repository, f.env);
  assert.equal(first.status, 0, first.stderr);
  const sentinel = path.join(f.skill, "custom.txt");
  writeText(sentinel, "保留旧版用户文件\n");
  const oldBinding = fs.readFileSync(path.join(f.skill, "installation.json"));
  const duplicate = run(installer, args, repository, f.env);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /已存在/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "保留旧版用户文件\n");
  assert.equal(
    fs.existsSync(path.join(f.project, ".deveco/arkts-skill-backups")),
    false,
  );

  const preload = path.join(f.base, "fail-stage-rename.cjs");
  writeText(
    preload,
    `const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(from).includes('.arkts-smell-refactor-stage-')) throw new Error('controlled replacement failure');
  return rename(from, to);
};\n`,
  );
  const failed = run(installer, [...args, "--force"], repository, f.env, [
    "--require",
    preload,
  ]);
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /旧版已恢复/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "保留旧版用户文件\n");
  assert.deepEqual(
    fs.readFileSync(path.join(f.skill, "installation.json")),
    oldBinding,
  );

  const forced = run(installer, [...args, "--force"], repository, f.env);
  assert.equal(forced.status, 0, forced.stderr);
  const backup = JSON.parse(forced.stdout).backupDirectory;
  assert.equal(
    path.dirname(backup),
    path.join(f.project, ".deveco/arkts-skill-backups"),
  );
  assert.equal(
    fs.readFileSync(path.join(backup, "custom.txt"), "utf8"),
    "保留旧版用户文件\n",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(backup, "installation.json")),
    oldBinding,
  );
  assert.equal(fs.existsSync(sentinel), false);
  assert.ok(fs.existsSync(f.launcher));
});

test("DevEco skill rejects invalid options, unsafe configs, and links before changing installation paths", (t) => {
  const f = setup(t);
  for (const args of [
    [],
    ["--project"],
    ["--project", f.project, "--unknown"],
    ["--project", f.project, "--project", f.project],
    ["--project", path.join(f.base, "missing")],
    ["--project", f.project, "--runs", path.join(f.project, "runs")],
  ])
    assert.equal(run(installer, args, repository, f.env).status, 2);
  const settingsFile = path.join(f.base, "invalid-settings.json");
  for (const config of [
    {
      projectRoot: f.project,
      backend: repository,
      runs: path.join(f.project, "runs"),
    },
    { projectRoot: f.project, backend: repository, runs: "relative-runs" },
    { projectRoot: f.base, backend: repository, runs: f.runs },
    { projectRoot: f.project, backend: "", runs: f.runs },
    { projectRoot: f.project, backend: repository, runs: "" },
    {
      projectRoot: f.project,
      backend: repository,
      runs: f.runs,
      bridgePath: "",
    },
    { projectRoot: f.project, backend: repository, runs: f.runs, node: "" },
  ]) {
    writeJson(settingsFile, config);
    assert.equal(
      run(
        installer,
        ["--project", f.project, "--config", settingsFile],
        repository,
        f.env,
      ).status,
      2,
    );
  }
  assert.equal(fs.existsSync(path.join(f.project, ".deveco")), false);
  const uninstalled = run(sourceLauncher, ["doctor"], f.base, f.env);
  assert.equal(uninstalled.status, 2);
  assert.match(uninstalled.stderr, /请先.*安装 Skill/);

  const outside = path.join(f.base, "outside");
  writeText(path.join(outside, "sentinel.txt"), "unchanged");
  fs.mkdirSync(path.dirname(f.skill), { recursive: true });
  fs.symlinkSync(
    outside,
    f.skill,
    process.platform === "win32" ? "junction" : "dir",
  );
  const linkedTarget = run(
    installer,
    ["--project", f.project, "--runs", f.runs, "--force"],
    repository,
    f.env,
  );
  assert.equal(linkedTarget.status, 2);
  assert.match(linkedTarget.stderr, /链接|junction/);
  assert.equal(
    fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"),
    "unchanged\n",
  );
  assert.equal(
    fs.existsSync(path.join(f.project, ".deveco/arkts-skill-backups")),
    false,
  );

  const nested = setup(t);
  const initial = run(
    installer,
    ["--project", nested.project, "--runs", nested.runs],
    repository,
    nested.env,
  );
  assert.equal(initial.status, 0, initial.stderr);
  const alias = path.join(nested.base, "config-alias");
  fs.symlinkSync(
    nested.skill,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const aliasedConfig = run(
    installer,
    ["--config", path.join(alias, "settings.json"), "--force"],
    repository,
    nested.env,
  );
  assert.equal(aliasedConfig.status, 2);
  assert.match(aliasedConfig.stderr, /安装目录之外/);
  assert.ok(fs.existsSync(path.join(nested.skill, "settings.json")));
  fs.symlinkSync(
    outside,
    path.join(nested.skill, "linked-resource"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const linkedResource = run(
    installer,
    ["--project", nested.project, "--runs", nested.runs, "--force"],
    repository,
    nested.env,
  );
  assert.equal(linkedResource.status, 2);
  assert.match(linkedResource.stderr, /链接|junction/);
  assert.equal(
    fs.existsSync(path.join(nested.project, ".deveco/arkts-skill-backups")),
    false,
  );

  const ancestor = setup(t);
  fs.symlinkSync(
    outside,
    path.join(ancestor.project, ".deveco"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const linkedAncestor = run(
    installer,
    ["--project", ancestor.project, "--runs", ancestor.runs],
    repository,
    ancestor.env,
  );
  assert.equal(linkedAncestor.status, 2);
  assert.match(linkedAncestor.stderr, /链接|junction/);
  assert.equal(fs.existsSync(path.join(outside, "skills")), false);
});
