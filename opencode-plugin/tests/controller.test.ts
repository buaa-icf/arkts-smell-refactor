import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readTransaction } from "../src/apply.ts";
import { Workbench } from "../src/controller.ts";
import type { Backend, BridgeMethods, Candidate, Issue, Prepared } from "../src/types.ts";
import { BridgeClient, BridgeError } from "../src/bridge.ts";
import { assertCompatible } from "../src/compatibility.ts";
import { loadConfig } from "../src/config.ts";
import { fixture } from "./helpers.ts";

test("configuration rejects in-project evidence and invalid settings", async () => {
  await assert.rejects(loadConfig({ runs: "./runs" }), /之外/);
  await assert.rejects(loadConfig({ linterMode: "anything" }), /linterMode/);
  await assert.rejects(loadConfig({ timeoutMs: -1 }), /timeoutMs/);
  assert.throws(() => assertCompatible({}), /原生 TUI/);
});
test("changing issues or instructions invalidates prepared evidence", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const controller = new Workbench(f.config);
  await controller.importReport({ text: JSON.stringify([f.record, f.record]) });
  await controller.prepare();
  assert.ok(controller.state.prepared);
  controller.select(1);
  assert.equal(controller.state.prepared, undefined);
  await controller.prepare();
  controller.setInstructions("new requirement");
  assert.equal(controller.state.prepared, undefined);
  assert.equal(controller.state.instructions, "new requirement");
});
test("operation serialization and cancellation do not manufacture a verdict", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const backend: Backend = {
    request: async <M extends keyof BridgeMethods>(_method: M, _params?: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeMethods[M]> =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new BridgeError("CANCELLED", "stopped")))),
  };
  const controller = new Workbench(f.config, backend);
  const task = controller.history();
  assert.equal(controller.state.busy, true);
  await assert.rejects(controller.scan(f.projectRoot), /等待当前操作/);
  controller.cancel();
  await task;
  assert.equal(controller.state.busy, false);
  assert.equal(controller.state.status, "已中止");
  assert.equal(controller.state.result, undefined);
});
test("pipeline failure is a structured result, while protocol errors stay errors", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const actual = new BridgeClient(f.config);
  const backend: Backend = { request: async (method, params, signal, event) => {
    if (method === "task.execute") return { candidate: { ...f.candidate, verdict: "BLOCKED" },
      result: { verdict: "BLOCKED", failureReason: "SDK unavailable" }, runDirectory: f.candidate.runDirectory } as never;
    return actual.request(method, params, signal, event);
  } };
  const controller = new Workbench(f.config, backend);
  await controller.importReport({ text: JSON.stringify(f.record) });
  await controller.prepare();
  await controller.execute();
  assert.equal(controller.state.result?.verdict, "BLOCKED");
  assert.equal(controller.state.error, undefined);
  assert.equal(controller.state.applyState, undefined);
  // A failed replacement import must not leave an old candidate actionable.
  await controller.importReport({ text: "bad JSON" });
  assert.equal(controller.state.candidate, undefined);
  assert.ok(controller.state.error);
});
test("unsupported imported rules are read-only", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const controller = new Workbench(f.config);
  f.record.messages[0]!.rule = "custom/unsupported";
  await controller.importReport({ text: JSON.stringify(f.record) });
  assert.equal((controller.issue as Issue).supported, false);
  await controller.prepare();
  assert.match(controller.state.error ?? "", /支持重构/);
});

test("plugin disposal waits for backend cancellation to finish", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  let childStopped = false;
  const backend: Backend = {
    request: async <M extends keyof BridgeMethods>(_method: M, _params?: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeMethods[M]> =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        setTimeout(() => { childStopped = true; reject(new BridgeError("CANCELLED", "stopped")); }, 20);
      })),
  };
  const controller = new Workbench(f.config, backend);
  const running = controller.history();
  const disposal = controller.dispose();
  assert.equal(childStopped, false);
  await disposal;
  assert.equal(childStopped, true);
  assert.equal(controller.state.busy, false);
  await running;
});

test("applied history remains recoverable after validation, method changes and restart", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const actual = new BridgeClient(f.config);
  let refreshedIssues: Issue[] = [];
  const backend: Backend = { request: async (method, params, signal, event) => {
    if (method === "candidate.check" || method === "candidate.describe") return f.candidate as never;
    if (method === "task.validateApplied") return { result: { verdict: "PASS" }, issues: refreshedIssues,
      runDirectory: resolve(f.config.runs, "validation-run") } as never;
    if (method === "history.list") return { records: [{ runId: f.candidate.candidateId, candidateId: f.candidate.candidateId,
      hasCandidate: true, method: "task.execute", startedAt: "2026-10-21", state: "SUCCEEDED",
      applyState: (await readTransaction(f.config, f.candidate))?.state, runDirectory: f.candidate.runDirectory }] } as never;
    return actual.request(method, params, signal, event);
  } };
  const controller = new Workbench(f.config, backend);
  await controller.importReport({ text: JSON.stringify([f.record, f.record]) });
  refreshedIssues = controller.state.issues;
  controller.state = { ...controller.state, candidate: f.candidate };
  await controller.apply();
  await controller.validateApplied();
  assert.equal(controller.state.appliedResult?.verdict, "PASS");
  controller.select(1);
  assert.equal(controller.state.candidate, undefined);
  assert.equal((await controller.recoveryTargets())?.[0]?.candidateId, f.candidate.candidateId);
  assert.equal((await controller.recoveryTarget(f.candidate.candidateId))?.candidateId, f.candidate.candidateId);
  await controller.dispose();
  const restarted = new Workbench(f.config, backend);
  assert.equal((await restarted.recoveryTargets())?.length, 1);
  await restarted.recover(f.candidate.candidateId);
  assert.equal(restarted.state.error, undefined);
  assert.deepEqual(await readFile(resolve(f.projectRoot, f.name)), f.before);
  assert.deepEqual(await restarted.recoveryTargets(), []);
  const entries = (await readFile(resolve(f.config.runs, "tui-operations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(entries.some((entry) => entry.operation === "恢复应用前内容" && entry.phase === "DONE" && entry.candidateId === f.candidate.candidateId));
  await restarted.dispose();
});

test("recovery errors persist the target ID and distinguish content conflicts", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const backend: Backend = { request: async () => f.candidate as never };
  const controller = new Workbench(f.config, backend);
  controller.state = { ...controller.state, candidate: f.candidate };
  await controller.apply();
  await writeFile(resolve(f.projectRoot, f.name), "user edit");
  await controller.recover(f.candidate.candidateId);
  assert.equal(controller.state.applyState, "CONFLICT");
  assert.match(controller.state.error ?? "", /当前内容与候选及原始基线均不同/);
  const log = await readFile(resolve(f.config.runs, "tui-operations.jsonl"), "utf8");
  const error = log.trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.phase === "ERROR");
  assert.equal(error.candidateId, f.candidate.candidateId);
  assert.match(error.message, /恢复未完成/);
  assert.match(controller.state.logs, /恢复未完成/);
  await controller.dispose();
});

for (const kind of ["file", "directory"] as const) {
  test(`initial ${kind} scan scope survives preparation, application and history restoration`, async (t) => {
    const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
    const actual = new BridgeClient(f.config);
    const { issues } = await actual.request("issues.import", { records: f.record });
    const scopePath = resolve(f.projectRoot, kind === "file" ? f.name : "entry/src/main/ets");
    let prepared: Prepared | undefined;
    let candidate: Candidate = f.candidate;
    const backend: Backend = { request: async (method, params, signal, event) => {
      if (method === "scan.start") return { issues, scopePath, runDirectory: f.candidate.runDirectory } as never;
      if (method === "task.prepare") {
        assert.deepEqual(params?.scanScope, { scopePath });
        prepared = await actual.request("task.prepare", params, signal, event);
        return prepared as never;
      }
      if (method === "task.execute") {
        candidate = { ...f.candidate, taskHandle: prepared!.taskHandle, scanScope: prepared!.scanScope };
        return { candidate, result: candidate.result, runDirectory: candidate.runDirectory } as never;
      }
      if (method === "candidate.check" || method === "candidate.describe") return candidate as never;
      if (method === "task.validateApplied") return { result: { verdict: "PASS" }, issues: [],
        scanScope: candidate.scanScope, runDirectory: candidate.runDirectory } as never;
      throw new Error(`Unexpected method ${method}`);
    } };
    const controller = new Workbench(f.config, backend);
    await controller.scan(scopePath);
    await controller.prepare();
    assert.deepEqual(controller.state.prepared?.scanScope, { scopePath });
    await controller.execute();
    await controller.apply();
    await controller.validateApplied();
    assert.deepEqual(controller.state.scanScope, { scopePath });
    assert.deepEqual(controller.state.issues, []);
    const restarted = new Workbench(f.config, backend);
    await restarted.restore(candidate.candidateId);
    assert.deepEqual(restarted.state.scanScope, { scopePath });
    await restarted.validateApplied();
    assert.deepEqual(restarted.state.scanScope, { scopePath });
    assert.equal(restarted.state.error, undefined);
    await controller.dispose(); await restarted.dispose();
  });
}
