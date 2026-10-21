import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyCandidate, candidateDiff, readTransaction, recoverApplication, sha256 } from "../src/apply.ts";
import { fixture } from "./helpers.ts";

test("apply and recover a PASS candidate, retaining separate durable states", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  assert.match(await candidateDiff(f.config, f.candidate, f.name), /\+class Page.*this.value/);
  assert.equal((await applyCandidate(f.config, f.candidate)).state, "APPLIED");
  assert.deepEqual(await readFile(resolve(f.projectRoot, f.name)), f.after);
  await assert.rejects(applyCandidate(f.config, f.candidate), /已有 APPLIED/);
  assert.equal((await recoverApplication(f.config, f.candidate)).state, "ROLLED_BACK");
  assert.deepEqual(await readFile(resolve(f.projectRoot, f.name)), f.before);
  assert.equal((await readTransaction(f.config, f.candidate))?.state, "ROLLED_BACK");
});
test("a later user edit is preserved during recovery", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  await applyCandidate(f.config, f.candidate);
  await writeFile(resolve(f.projectRoot, f.name), "user edit");
  const result = await recoverApplication(f.config, f.candidate);
  assert.equal(result.state, "CONFLICT");
  assert.deepEqual(result.conflicts, [f.name]);
  assert.equal(await readFile(resolve(f.projectRoot, f.name), "utf8"), "user edit");
});
test("changed baseline and tampered frozen content are rejected before writes", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  await writeFile(resolve(f.projectRoot, f.name), "user edit");
  await assert.rejects(applyCandidate(f.config, f.candidate), /基线已变化/);
  await writeFile(resolve(f.projectRoot, f.name), f.before);
  await writeFile(resolve(f.candidate.runDirectory, "content/after", f.name), "tampered");
  await assert.rejects(applyCandidate(f.config, f.candidate), /冻结候选内容/);
  assert.deepEqual(await readFile(resolve(f.projectRoot, f.name)), f.before);
});
test("path traversal, tests, duplicate paths and failed candidates cannot be applied", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const change = f.candidate.changes[0]!;
  for (const name of ["../entry/src/main/ets/Page.ets", "entry/src/test/Test.ets", "C:/src/main/Page.ets"]) {
    await assert.rejects(applyCandidate(f.config, { ...f.candidate, changes: [{ ...change, relativePath: name }] }));
  }
  await assert.rejects(applyCandidate(f.config, { ...f.candidate, changes: [change, change] }), /重复/);
  await assert.rejects(applyCandidate(f.config, { ...f.candidate, verdict: "FAIL" }), /PASS/);
  assert.deepEqual(await readFile(resolve(f.projectRoot, f.name)), f.before);
});
test("new production files are applied and removed on recovery", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const name = "entry/src/main/ets/Helper.ets";
  const data = Buffer.from("export class Helper {}\n");
  const path = resolve(f.candidate.runDirectory, "content/after", name);
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, data);
  f.candidate.afterFiles[name] = sha256(data);
  f.candidate.changes.push({ relativePath: name, changeType: "added", beforeSha256: null,
    afterSha256: sha256(data), size: data.length, kind: "source" });
  await applyCandidate(f.config, f.candidate);
  assert.deepEqual(await readFile(resolve(f.projectRoot, name)), data);
  await recoverApplication(f.config, f.candidate);
  await assert.rejects(readFile(resolve(f.projectRoot, name)), { code: "ENOENT" });
});
test("junctions cannot redirect writes outside the business project", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const outside = resolve(f.directory, "outside"); await mkdir(outside);
  const link = resolve(f.projectRoot, "redirect");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  const original = f.candidate.changes[0]!;
  const name = "redirect/src/main/ets/Page.ets";
  const externalFile = resolve(outside, "src/main/ets/Page.ets");
  await mkdir(dirname(externalFile), { recursive: true });
  await writeFile(externalFile, f.before);
  for (const [phase, data] of [["before", f.before], ["after", f.after]] as const) {
    const frozen = resolve(f.candidate.runDirectory, "content", phase, name);
    await mkdir(dirname(frozen), { recursive: true }); await writeFile(frozen, data);
  }
  // Keep the manifest valid so this reaches link detection, not an earlier digest rejection.
  await assert.rejects(applyCandidate(f.config, { ...f.candidate,
    baselineFiles: { [name]: sha256(f.before) }, afterFiles: { [name]: sha256(f.after) },
    changes: [{ ...original, relativePath: name }] }), /链接路径/);
  assert.deepEqual(await readFile(externalFile), f.before);
  assert.deepEqual(await readFile(resolve(f.projectRoot, f.name)), f.before);
});
test("unfinished application can be recovered after a restart", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  await writeFile(resolve(f.projectRoot, f.name), f.after);
  await writeFile(resolve(f.candidate.runDirectory, "apply-transaction.json"), JSON.stringify({
    schemaVersion: 1, candidateId: f.candidate.candidateId, originalRoot: f.projectRoot,
    state: "APPLYING", attempted: [f.name], conflicts: [], updatedAt: new Date().toISOString(),
  }));
  assert.equal((await recoverApplication(f.config, f.candidate)).state, "ROLLED_BACK");
  assert.deepEqual(await readFile(resolve(f.projectRoot, f.name)), f.before);
});
