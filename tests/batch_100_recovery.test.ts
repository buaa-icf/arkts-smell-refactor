import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fixture } from "./helpers.js";

test("batch recovery retires only stopped, owned backend operations and preserves unknown or live locks", async t => {
  const root = fixture(t), project = path.join(root, "project"), dir = path.join(root, "output", "001");
  const runs = path.join(dir, "runs"), stateRoot = path.join(root, "state"), journal = path.join(stateRoot, "active-case.json");
  for (const directory of [project, runs, stateRoot]) fs.mkdirSync(directory, { recursive: true });
  const recoveryToken = randomUUID(), host = { stateRoot, endpoint: { host: "127.0.0.1", port: 0, exclusive: true } };
  // Simulate an abruptly terminated backend using the actual lock and session writers.
  const common = new URL("../src/ide/common.js", import.meta.url).href;
  const lifecycle = new URL("../src/ide/lifecycle.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", [
    "import { BridgeContext } from " + JSON.stringify(common),
    "import { lockOperation } from " + JSON.stringify(lifecycle),
    "const ctx = new BridgeContext({runs:process.argv[1]}, process.argv[2], '', () => {})",
    "lockOperation(ctx)",
    "console.log(ctx.createRun('task.prepare'))",
  ].join(";\n"), runs, project], { env: { ...process.env, ARKTS_BATCH_RECOVERY_TOKEN: recoveryToken }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const session = path.join(child.stdout.trim(), "session.json"), opLock = path.join(runs, ".operation.lock");
  const owner = JSON.parse(fs.readFileSync(opLock, "utf8")), applyLock = path.join(runs, ".apply.lock");
  assert.equal(owner.batchRecoveryToken, recoveryToken);
  fs.writeFileSync(journal, JSON.stringify({ version: 1, recoveryToken, dir, runs, project, ordinal: 1,
    baseline: createHash("sha256").digest("hex"), pending: { command: "prepare", pid: owner.pid } }));
  const { runBatch } = await import(pathToFileURL(path.resolve("tools/batch-100-runner.mjs")).href);
  for (const [lock, reason] of [
    [JSON.stringify({ ...owner, batchRecoveryToken: randomUUID() }), /无法确认/],
    [String(owner.pid), /无法确认/],
    ["", /无法确认/],
    [JSON.stringify({ ...owner, pid: process.pid }), /仍在运行/],
  ] as const) {
    fs.writeFileSync(applyLock, lock);
    await assert.rejects(runBatch(["--recover"], host), reason);
    assert.equal(fs.readFileSync(applyLock, "utf8"), lock);
    assert.ok(fs.existsSync(opLock));
    assert.equal(JSON.parse(fs.readFileSync(session, "utf8")).state, "RUNNING");
  }
  fs.writeFileSync(applyLock, JSON.stringify(owner));
  assert.equal(await runBatch(["--recover"], host), 0);
  assert.ok(!fs.existsSync(applyLock) && !fs.existsSync(opLock) && !fs.existsSync(journal));
  assert.equal(JSON.parse(fs.readFileSync(session, "utf8")).state, "INTERRUPTED");
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "recovery.json"), "utf8")).rollbackVerified);
});
