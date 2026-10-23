import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BridgeClient, JsonLines } from "../src/bridge.ts";
import { fixture } from "./helpers.ts";

test("JSONL handles Chinese UTF-8 across individual bytes and an unterminated tail", () => {
  const values: unknown[] = [];
  const parser = new JsonLines((value) => values.push(value));
  const bytes = Buffer.from('{"text":"中文"}\r\n{"tail":true}');
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(values, [{ text: "中文" }, { tail: true }]);
});
test("JSONL rejects pollution and oversized messages", () => {
  assert.throws(() => new JsonLines(() => {}).push(Buffer.from("debug text\n")), /非法 JSON/);
  assert.throws(() => new JsonLines(() => {}).push(Buffer.alloc(8 * 1024 * 1024 + 1, 120)), /8 MiB/);
});
test("real Node bridge hello, import and prepare run without model calls or source edits", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const client = new BridgeClient(f.config);
  const hello = await client.request("session.hello");
  assert.equal(hello.transport, "one-request-per-process");
  assert.equal(hello.protocolVersion, 1);
  assert.equal(hello.backendLanguage, "typescript");
  const imported = await client.request("issues.import", { records: f.record });
  assert.equal(imported.issues.length, 1);
  assert.equal(imported.issues[0]?.symbol, "update");
  const events: string[] = [];
  const prepared = await client.request("task.prepare", { issue: imported.issues[0], instructions: "保持行为" },
    undefined, (event) => events.push(event.event));
  assert.ok(prepared.risk.riskLevel);
  assert.equal(prepared.instructions, "保持行为");
  assert.ok(events.includes("run.started"));
  assert.ok(events.includes("workflow.changed"));
  assert.deepEqual(await readFile(resolve(f.projectRoot, f.name)), f.before);
  const history = await client.request("history.list");
  assert.ok(history.records.some((record) => record.method === "task.prepare"));
  await assert.rejects(client.request("issues.import", { records: [{ ...f.record, filePath: "../outside.ets" }] }), /不允许包含/);
});

const fakeBackend = `const {spawn}=require('node:child_process');
let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk=>text+=chunk);
process.stdin.on('end', ()=>{
 const r=JSON.parse(text), mode=r.params.mode||'ok';
 const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 if(mode==='crash'){process.stderr.write('诊断信息');process.exitCode=7;return;}
 if(mode==='wrong')r.requestId='different';
 if(mode==='sequence')send({protocolVersion:1,type:'event',seq:2,event:'log.appended',data:{}});
 if(mode==='sleep'){
   const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});
   send({protocolVersion:1,type:'event',seq:1,event:'child',data:{pid:child.pid}});
   setTimeout(()=>{},60000);return;
 }
 send({protocolVersion:1,type:'response',requestId:r.requestId,ok:true,result:{protocolVersion:1,transport:'test',supportedRules:[]}});
});
`;
test("bridge reports EOF, mismatched requests and sequence gaps", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const path = resolve(f.directory, "fake.cjs"); await writeFile(path, fakeBackend);
  const client = new BridgeClient({ ...f.config, bridgePath: path });
  await assert.rejects(client.request("session.hello", { mode: "crash" }), /未返回响应.*诊断信息/);
  await assert.rejects(client.request("session.hello", { mode: "wrong" }), /响应关联/);
  await assert.rejects(client.request("session.hello", { mode: "sequence" }), /序号/);
});
test("user cancellation terminates the Node worker and its child", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const path = resolve(f.directory, "sleep.cjs"); await writeFile(path, fakeBackend);
  const client = new BridgeClient({ ...f.config, bridgePath: path });
  const abort = new AbortController();
  let pid = 0;
  const pending = client.request("session.hello", { mode: "sleep" }, abort.signal, (event) => {
    pid = Number(event.data.pid); abort.abort();
  });
  await assert.rejects(pending, (error: unknown) => error instanceof Error && "code" in error && error.code === "CANCELLED");
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0));
});
test("timeout terminates a nonresponsive operation", async (t) => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const path = resolve(f.directory, "sleep.cjs"); await writeFile(path, fakeBackend);
  const client = new BridgeClient({ ...f.config, bridgePath: path, timeoutMs: 300 });
  await assert.rejects(client.request("session.hello", { mode: "sleep" }), /超时/);
});
