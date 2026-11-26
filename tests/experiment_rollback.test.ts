import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers.js";
import { writeJson, writeText } from "../src/utils.js";

const windowsOnly = { skip: process.platform !== "win32" };

test("Windows experiment restores binary resources and source after PASS, FAIL and interrupted CLI", windowsOnly, (t) => {
  const root = fixture(t), repo = path.join(root, "tool"), workspace = path.join(root, "workspace");
  const source = path.join(workspace, "demo"), temp = path.join(root, "temp");
  const scripts = path.join(repo, "tools"), dataset = path.join(root, "dataset");
  const target = "entry/src/main/ets/Target.ets", deleted = "entry/src/main/ets/Deleted.ts";
  const added = "entry/src/main/ets/New.ets", assets = "entry/src/main/resources/rawfile";
  const original = Buffer.from([0, 255, 128, 13, 10, 0]);
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of ["run_refactor_experiment.ps1", "task_source_rollback.ps1"])
    fs.copyFileSync(path.resolve("tools", file), path.join(scripts, file));
  writeText(path.join(source, "build-profile.json5"), "{}");
  writeText(path.join(source, "hvigor/hvigor-config.json5"), "{}");
  writeText(path.join(source, target), "original\r\n");
  writeText(path.join(source, deleted), "before deletion");
  const targetBytes = fs.readFileSync(path.join(source, target));
  const deletedBytes = fs.readFileSync(path.join(source, deleted));
  fs.mkdirSync(path.join(source, assets), { recursive: true });
  for (const name of ["changed.bin", "deleted.bin"])
    fs.writeFileSync(path.join(source, assets, name), original);
  writeJson(path.join(dataset, "local-test/long-method.json"), [{
    filePath: "demo/" + target, sourceProject: "demo", messages: [{ message: "fixture" }]
  }]);
  // The real PowerShell wrapper creates and restores its own snapshot before returning.
  writeJson(path.join(repo, "package.json"), { type: "commonjs" });
  writeText(path.join(repo, "dist/cli.js"), `
const fs = require("node:fs"), path = require("node:path");
const source = path.join(process.argv[process.argv.indexOf("--workspace") + 1], "demo");
const [modified, deleted, added, assets] = JSON.parse(process.env.FIXTURE_PATHS);
fs.writeFileSync(path.join(source, modified), "modified");
fs.unlinkSync(path.join(source, deleted));
fs.writeFileSync(path.join(source, added), "new");
fs.writeFileSync(path.join(source, assets, "changed.bin"), Buffer.from([1, 2, 3]));
fs.unlinkSync(path.join(source, assets, "deleted.bin"));
fs.writeFileSync(path.join(source, assets, "new.bin"), Buffer.from([4]));
const verdict = process.env.FIXTURE_VERDICT;
if (verdict === "interrupted") process.exit(7);
const task = path.join(__dirname, "..", "runs", verdict, "task");
fs.mkdirSync(task, {recursive: true});
fs.writeFileSync(path.join(task, "result.json"), JSON.stringify({taskId: "case", verdict}));
fs.writeFileSync(path.join(task, "task.json"), JSON.stringify({
  task_id: "case", smell_type: "long-method", target: {file_path: "demo/" + modified}
}));
process.exit(verdict === "PASS" ? 0 : 2);
`);
  for (const verdict of ["PASS", "FAIL", "interrupted"]) {
    const run = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(scripts, "run_refactor_experiment.ps1"), "-SmellType", "long-method",
      "-DatasetKind", "local-test", "-DatasetRoot", dataset, "-Workspace", workspace,
      "-NodeExe", process.execPath
    ], {
      encoding: "utf8", timeout: 30000,
      env: { ...process.env, TEMP: temp, FIXTURE_VERDICT: verdict,
        FIXTURE_PATHS: JSON.stringify([target, deleted, added, assets]) }
    });
    assert.ifError(run.error);
    const log = run.stdout + run.stderr;
    assert.equal(run.status, verdict === "interrupted" ? 1 : 0, log);
    assert.match(log, /restored=4 removedNew=2/);
    assert.deepEqual(fs.readFileSync(path.join(source, target)), targetBytes);
    assert.deepEqual(fs.readFileSync(path.join(source, deleted)), deletedBytes);
    assert.equal(fs.existsSync(path.join(source, added)), false);
    for (const name of ["changed.bin", "deleted.bin"])
      assert.deepEqual(fs.readFileSync(path.join(source, assets, name)), original);
    assert.equal(fs.existsSync(path.join(source, assets, "new.bin")), false);
    if (verdict === "interrupted") assert.match(log, /RECOVERY_FROM_SNAPSHOT/);
    else assert.ok(fs.existsSync(path.join(repo, "runs", verdict, "task/pre-run-production-baseline/manifest.json")));
  }
});

test("Windows snapshot ignores linked dependency caches and refuses redirected source writes", windowsOnly, (t) => {
  const root = fixture(t), source = path.join(root, "project"), outside = path.join(root, "outside");
  const original = path.join(source, "entry", "Index.ets");
  writeText(original, "baseline");
  writeText(path.join(outside, "Index.ets"), "external");
  const externalBytes = fs.readFileSync(path.join(outside, "Index.ets"));
  try { fs.symlinkSync(outside, path.join(source, "oh_modules"), "junction"); }
  catch (error) {
    if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    t.skip("NTFS directory junctions are unavailable in this process");
    return;
  }
  const script = path.join(root, "probe.ps1");
  writeText(script, `
param($Helper, $Project, $Snapshot, $Action)
$ErrorActionPreference = 'Stop'
. $Helper
if ($Action -eq 'save') { New-TaskSourceSnapshot $Project $Snapshot }
else { Restore-TaskSourceSnapshot $Project $Snapshot }
`);
  const run = (action: string) => spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    path.resolve("tools/task_source_rollback.ps1"), source, path.join(root, "snap"), action
  ], { encoding: "utf8", timeout: 30000 });
  const save = run("save");
  assert.equal(save.status, 0, save.stdout + save.stderr);
  assert.match(save.stdout, /SNAPSHOT_SOURCE_FILES=1/);
  fs.renameSync(path.join(source, "entry"), path.join(root, "original-entry"));
  fs.symlinkSync(outside, path.join(source, "entry"), "junction");
  const restore = run("restore");
  assert.equal(restore.status, 1, restore.stdout + restore.stderr);
  assert.match(restore.stderr, /linked path/);
  assert.deepEqual(fs.readFileSync(path.join(outside, "Index.ets")), externalBytes);
});
