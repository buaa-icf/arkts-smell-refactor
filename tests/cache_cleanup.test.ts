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

test("target and nested junctions cause the whole selected copy to be retained", t => {
  const root = fixture(t), run = path.join(root, "run"), outside = path.join(root, "outside");
  writeText(path.join(outside, "keep.txt"), "keep");
  fs.mkdirSync(run);
  if (!junction(t, outside, path.join(run, "edit"))) return;
  writeText(path.join(run, "staging/ordinary.txt"), "keep entire cache on refusal");
  if (!junction(t, outside, path.join(run, "staging/linked"))) return;
  const cleaned = cleanupRunCopies(run, ["edit", "staging"]);
  assert.equal(cleaned.removed.length, 0);
  assert.equal(cleaned.retained.length, 2);
  assert.equal(cleaned.warnings.length, 2);
  assert(fs.existsSync(path.join(run, "staging/ordinary.txt")));
  assert(fs.existsSync(path.join(outside, "keep.txt")));
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
  const original = fs.rmSync;
  const mock = t.mock.method(fs, "rmSync", (file: fs.PathLike, options?: fs.RmOptions) => {
    if (file === target) throw Object.assign(new Error("simulated Windows file in use"), { code: "EBUSY" });
    return original(file, options);
  });
  try {
    const cleaned = cleanupRunCopies(run, ["edit"]);
    assert.deepEqual(cleaned.retained, [target]);
    assert.match(cleaned.warnings[0], /simulated Windows file in use/);
    assert(fs.existsSync(path.join(target, "keep.txt")));
    assert(fs.existsSync(path.join(run, "backend/test.log")));
  } finally { mock.mock.restore(); }
});
