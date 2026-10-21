import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { Workbench } from "../src/controller.ts";
import type { Backend, BridgeMethods, Issue } from "../src/types.ts";
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
