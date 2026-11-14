import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { cleanupRunCopies, cleanupTaskCaches } from "../src/cache_cleanup.js";
import { fixture } from "./helpers.js";
import { writeJson, writeText } from "../src/utils.js";

function taskCaches(t: TestContext) {
  const root = fixture(t), taskDir = path.join(root, "run", "backend");
  fs.mkdirSync(taskDir, { recursive: true });
  // Exercise real filesystem deletion inside isolated, uniquely named test locations.
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  const temporary = path.join(root, "temporary");
  fs.mkdirSync(temporary);
  Object.assign(process.env, { TEMP: temporary, TMP: temporary, TMPDIR: temporary });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const shortHash = (value: string) => crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
  const runtime = path.resolve(fileURLToPath(new URL("../src/cache_cleanup.js", import.meta.url)), "../..");
  const validation = path.join(runtime, "v", shortHash(taskDir));
  const baseline = path.join(os.tmpdir(), "arkts-smell-refactor-runtime", shortHash(taskDir + "baseline"));
  const current = path.join(os.tmpdir(), "arkts-smell-refactor-runtime", shortHash(taskDir + "current"));
  t.after(() => {
    assert.equal(path.dirname(validation), path.join(runtime, "v"));
    fs.rmSync(validation, { recursive: true, force: true });
  });
  return { root, taskDir, validation, baseline, current };
}

function junction(t: TestContext, target: string, link: string): boolean {
  try { fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir"); return true; }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Directory links are unavailable in this environment");
      return false;
    }
    throw error;
  }
}

test("finished task caches are removed after raw test reports are archived; metadata cannot redirect deletion", t => {
  const f = taskCaches(t), outside = path.join(f.root, "unrelated"), result = "entry/.test/coverage_data/test_result.txt";
  writeText(path.join(outside, "keep.txt"), "keep");
  writeJson(path.join(f.taskDir, "validation-workspace.json"), { path: outside });
  writeText(path.join(f.taskDir, "test.log"), "persistent log");
  for (const cache of [f.validation, f.baseline, f.current]) {
    writeText(path.join(cache, result), "Tests run: 1, Failure: 0");
    writeText(path.join(cache, "entry/.test/coverage_data/coverage.log"), "TestFinished-ResultCode: 0");
    writeText(path.join(cache, "entry/.test/coverage_data/js_coverage.json"), "{}");
    writeText(path.join(cache, ".hvigor/build.log"), "build diagnostics");
    writeText(path.join(cache, "entry/build/application.hap"), "disposable build");
    writeText(path.join(cache, "entry/src/main/ets/Page.ets"), "disposable source copy");
  }
  const cleaned = cleanupTaskCaches(f.taskDir);
  assert.deepEqual(cleaned.warnings, []);
  assert.equal(cleaned.removed.length, 3);
  assert.equal(cleaned.archived?.length, 12);
  assert(cleaned.removed.every(file => !fs.existsSync(file)));
  for (const label of ["validation", "runtime-smoke-baseline", "runtime-smoke-current"])
    assert.equal(fs.readFileSync(path.join(f.taskDir, "cache-evidence", label, result), "utf8"), "Tests run: 1, Failure: 0\n");
  assert.equal(fs.readFileSync(path.join(f.taskDir, "test.log"), "utf8"), "persistent log\n");
  assert(fs.existsSync(path.join(outside, "keep.txt")));
  assert.deepEqual(cleanupTaskCaches(f.taskDir), { removed: [], retained: [], warnings: [], archived: [] });
});

test("only explicit disposable run copies are deleted; candidate, baseline, transactions and logs survive", t => {
  const run = path.join(fixture(t), "run");
  const caches = ["staging", "edit", "backend/external-edits", "backend/refactor-workspace", "backend/refactor-workspace-repair-prompt-2"];
  const evidence = ["baseline/entry.ets", "content/before/entry.ets", "content/after/entry.ets", "candidate.json", "apply-transaction.json", "backend/test.log", "backend/baseline-production/entry.ets"];
  for (const name of caches) writeText(path.join(run, name, "file.txt"), "cache");
  for (const name of evidence) writeText(path.join(run, name), "evidence");
  const cleaned = cleanupRunCopies(run, [...caches, "staging", "../outside", "baseline", "backend", "content", "edit/..", "backend/refactor-workspace-repair-prompt-2/../baseline-production"]);
  assert.equal(cleaned.removed.length, caches.length);
  assert.equal(cleaned.warnings.length, 6);
  assert(evidence.every(name => fs.readFileSync(path.join(run, name), "utf8") === "evidence\n"));
  assert.deepEqual(cleanupRunCopies(run, caches).removed, []);
});

test("an ancestor junction cannot redirect run cleanup", t => {
  const root = fixture(t), actual = path.join(root, "actual"), linked = path.join(root, "linked");
  writeText(path.join(actual, "run/edit/keep.txt"), "keep");
  if (!junction(t, actual, linked)) return;
  const cleaned = cleanupRunCopies(path.join(linked, "run"), ["edit"]);
  assert.equal(cleaned.removed.length, 0);
  assert.equal(cleaned.warnings.length, 1);
  assert(fs.existsSync(path.join(actual, "run/edit/keep.txt")));
});

test("a cache root junction is retained while nested dependency junctions are unlinked", t => {
  const root = fixture(t), run = path.join(root, "run"), outside = path.join(root, "outside");
  writeText(path.join(outside, "keep.txt"), "keep");
  fs.mkdirSync(run);
  if (!junction(t, outside, path.join(run, "edit"))) return;
  writeText(path.join(run, "staging/ordinary.txt"), "disposable cache");
  if (!junction(t, outside, path.join(run, "staging/linked"))) return;
  const cleaned = cleanupRunCopies(run, ["edit", "staging"]);
  assert.deepEqual(cleaned.removed, [path.join(run, "staging")]);
  assert.deepEqual(cleaned.retained, [path.join(run, "edit")]);
  assert.equal(cleaned.warnings.length, 1);
  assert.equal(fs.existsSync(path.join(run, "staging")), false);
  assert(fs.existsSync(path.join(outside, "keep.txt")));
  assert(fs.lstatSync(path.join(run, "edit")).isSymbolicLink());
});

test("OHPM internal, external, broken and cyclic junctions do not prevent cleanup or expose target logs", t => {
  const f = taskCaches(t), outside = path.join(f.root, "external-project");
  const dependency = path.join(f.validation, "oh_modules/.ohpm/vendor+sdk@1.0.0/oh_modules/@vendor/sdk");
  const modules = path.join(f.validation, "commons/common/oh_modules");
  writeText(path.join(dependency, "sdk.ets"), "package source");
  writeText(path.join(outside, "external.log"), "must not read or delete");
  writeText(path.join(f.validation, ".hvigor/build.log"), "own build log");
  writeText(path.join(f.validation, "entry/.test/coverage_data/test_result.txt"), "own test report");
  fs.mkdirSync(path.join(modules, "@vendor"), { recursive: true });
  if (!junction(t, dependency, path.join(modules, "@vendor/sdk"))) return;
  if (!junction(t, outside, path.join(modules, "external"))) return;
  if (!junction(t, path.join(f.root, "missing"), path.join(modules, "broken"))) return;
  if (!junction(t, f.validation, path.join(modules, "cycle"))) return;
  const cleaned = cleanupTaskCaches(f.taskDir);
  assert.deepEqual(cleaned.warnings, []);
  assert.deepEqual(cleaned.removed, [f.validation]);
  assert.equal(fs.existsSync(f.validation), false);
  assert.equal(fs.readFileSync(path.join(outside, "external.log"), "utf8"), "must not read or delete\n");
  assert.equal(cleaned.archived?.length, 2);
  assert(cleaned.archived?.every(file => !file.includes("external.log")));
  assert.equal(fs.readFileSync(path.join(f.taskDir, "cache-evidence/validation/.hvigor/build.log"), "utf8"), "own build log\n");
});

test("file symlinks are unlinked without reading target reports or changing external files", t => {
  const f = taskCaches(t), outside = path.join(f.root, "original.log");
  writeText(outside, "external evidence");
  fs.mkdirSync(f.validation, { recursive: true });
  const alias = path.join(f.validation, "aliased.log");
  try { fs.symlinkSync(outside, alias, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      // Creating file symlinks requires a Windows privilege even though directory
      // junctions do not. A hardlink preserves real unlink/target survival behavior;
      // only lstat's link classification is simulated for this branch coverage.
      fs.linkSync(outside, alias);
      const lstat = fs.lstatSync;
      t.mock.method(fs, "lstatSync", (file: fs.PathLike) => {
        const stat = lstat(file);
        if (file === alias) stat.isSymbolicLink = () => true;
        return stat;
      });
      t.diagnostic("File symlink creation is unavailable; lstat classification simulated with a real hardlink/unlink.");
    } else throw error;
  }
  const cleaned = cleanupTaskCaches(f.taskDir);
  assert.deepEqual(cleaned.warnings, []);
  assert.deepEqual(cleaned.removed, [f.validation]);
  assert.deepEqual(cleaned.archived, []);
  assert.equal(fs.readFileSync(outside, "utf8"), "external evidence\n");
});

test("a directory changed to a junction during deletion cannot redirect subsequent child deletion", t => {
  const root = fixture(t), run = path.join(root, "run"), target = path.join(run, "edit");
  const directory = path.join(target, "dependency"), moved = path.join(target, "moved-dependency");
  const outside = path.join(root, "outside");
  writeText(path.join(directory, "first.txt"), "cache");
  writeText(path.join(directory, "second.txt"), "cache");
  writeText(path.join(outside, "second.txt"), "original");
  const probe = path.join(root, "probe");
  if (!junction(t, outside, probe)) return;
  fs.unlinkSync(probe);
  const unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    unlink(file);
    if (file === path.join(directory, "first.txt")) {
      fs.renameSync(directory, moved);
      fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
    }
  });
  try {
    const cleaned = cleanupRunCopies(run, ["edit"]);
    assert.deepEqual(cleaned.retained, [target]);
    assert.match(cleaned.warnings[0], /链接|junction/);
    assert.equal(fs.readFileSync(path.join(outside, "second.txt"), "utf8"), "original\n");
  } finally { mock.mock.restore(); }
});

test("test report archive junction is rejected before deleting the source cache", t => {
  const f = taskCaches(t), outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  writeText(path.join(f.validation, "entry/.test/test_result.txt"), "test result");
  if (!junction(t, outside, path.join(f.taskDir, "cache-evidence"))) return;
  const cleaned = cleanupTaskCaches(f.taskDir);
  assert.deepEqual(cleaned.retained, [f.validation]);
  assert.equal(cleaned.warnings.length, 1);
  assert(fs.existsSync(path.join(f.validation, "entry/.test/test_result.txt")));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("conflicting archived reports retain the cache and existing evidence", t => {
  const f = taskCaches(t), report = "entry/.test/test_result.txt";
  writeText(path.join(f.validation, report), "new report");
  const archive = path.join(f.taskDir, "cache-evidence/validation", report);
  writeText(archive, "previous evidence");
  const cleaned = cleanupTaskCaches(f.taskDir);
  assert.deepEqual(cleaned.retained, [f.validation]);
  assert.equal(cleaned.warnings.length, 1);
  assert.equal(fs.readFileSync(archive, "utf8"), "previous evidence\n");
});

test("deletion failure is reported without throwing or deleting other evidence", t => {
  const run = path.join(fixture(t), "run"), target = path.join(run, "edit");
  writeText(path.join(target, "keep.txt"), "keep");
  writeText(path.join(run, "backend/test.log"), "log");
  const original = fs.unlinkSync;
  const mock = t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    if (file === path.join(target, "keep.txt")) throw Object.assign(new Error("simulated Windows file in use"), { code: "EBUSY" });
    return original(file);
  });
  try {
    const cleaned = cleanupRunCopies(run, ["edit"]);
    assert.deepEqual(cleaned.retained, [target]);
    assert.match(cleaned.warnings[0], /simulated Windows file in use/);
    assert(fs.existsSync(path.join(target, "keep.txt")));
    assert(fs.existsSync(path.join(run, "backend/test.log")));
  } finally { mock.mock.restore(); }
});
