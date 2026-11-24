import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const runner = path.resolve("tools/batch-100-runner.mjs");
// Each simulated Skill call is a separate Node process, using the release CLI protocol.
const fakeSkill = `
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
const argv = process.argv.slice(2), command = argv[0];
const flag = name => argv[argv.indexOf("--" + name) + 1];
const dir = process.cwd(), project = flag("project"), root = path.dirname(path.dirname(project));
const options = JSON.parse(fs.readFileSync(flag("config"), "utf8"));
const report = JSON.parse(fs.readFileSync(path.join(dir, "input.json"), "utf8"))[0];
const target = path.resolve(project, report.filePath), text = () => fs.readFileSync(target, "utf8");
const ordinal = Number(path.basename(dir));
const ids = Array.from({ length: 3 }, (_, i) => "11111111-1111-1111-1111-11111111111" + i);
const issue = { issueId: ids[0], rule: report.messages[0].rule, supported: true,
  absolutePath: target, sourceSha256: createHash("sha256").update(text()).digest("hex") };
const candidate = { candidateId: ids[2], taskHandle: ids[1], originalRoot: project };
const txn = path.join(dir, "transaction.json");
const receipt = { schemaVersion: 1, command, projectRoot: project, ok: true };
const transaction = state => ({ candidateId: ids[2], state, conflicts: [] });
fs.appendFileSync(options.events, JSON.stringify({ ordinal, command, text: text() }) + "\\n");
switch(command) {
  case "doctor":
    receipt.result = { verdict: "PASS", stop: false };
    if (options.missing) {
      receipt.ok = false;
      receipt.result = { verdict: "BLOCKED", stop: true, missing: [{ name: "SDK", reason: "missing", action: "set path" }] };
      process.exitCode = 3;
    }
    break;
  case "import":
    if (report.messages[0].testKind !== "instrument-test" || !report.messages[0].message.includes("similar to entry/"))
      throw new Error("dataset metadata/related path lost");
    receipt.result = { issues: [issue] };
    receipt.responseFile = path.join(dir, "imported.json");
    break;
  case "prepare": receipt.result = { taskHandle: ids[1], originalRoot: project, issue }; break;
  case "execute": {
    const verdict = options.blocked === ordinal ? "BLOCKED" : "PASS";
    receipt.result = { result: { verdict, reason: verdict === "BLOCKED" ? "no test for this sample" : "" }, candidate: { ...candidate, verdict } };
    if (verdict !== "PASS") process.exitCode = 3;
    break;
  }
  case "finish": receipt.result = { state: "FINISHED", taskHandle: ids[1] }; break;
  case "apply":
    fs.writeFileSync(txn, JSON.stringify(transaction("APPLIED")));
    fs.writeFileSync(target, "applied");
    receipt.result = { transaction: transaction("APPLIED") };
    break;
  case "validate-applied":
    if (options.hold) {
      fs.writeFileSync(options.hold, String(process.pid));
      while (!fs.existsSync(options.release)) await wait(20);
    }
    receipt.result = { result: { verdict: options.fail === ordinal ? "FAIL" : "PASS" } };
    if (receipt.result.result.verdict === "FAIL") process.exitCode = 3;
    break;
  case "restore":
    receipt.result = { candidate, transaction: fs.existsSync(txn) ? JSON.parse(fs.readFileSync(txn, "utf8")) : null };
    if (receipt.result.transaction?.state === "CONFLICT") process.exitCode = 3;
    break;
  case "rollback": {
    const state = text() === "applied" ? "ROLLED_BACK" : "CONFLICT";
    if (state === "ROLLED_BACK") fs.writeFileSync(target, "user baseline");
    else process.exitCode = 3;
    fs.writeFileSync(txn, JSON.stringify(transaction(state)));
    receipt.result = { transaction: transaction(state) };
    break;
  }
  default: throw new Error(command);
}
console.log(JSON.stringify(receipt));
`;

async function until(ready: () => boolean) {
  const end = Date.now() + 20_000;
  while (!ready()) {
    if (Date.now() >= end) throw new Error("fixture timed out");
    await delay(20);
  }
}

async function fixture(t: TestContext, opts: Record<string, unknown> = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-100-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(temp, "repos", "repo", "Nested");
  const file = "entry/src/main/ets/File.ets", target = path.join(root, file);
  const write = (name: string, value: string) => {
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, value);
  };
  write(target, "user baseline");
  write(path.join(root, "build-profile.json5"), "{}");
  write(path.join(root, "hvigor/hvigor-config.json5"), "{}");
  const skill = path.join(temp, "portable"), dataset = path.join(temp, "samples.json");
  write(path.join(skill, "scripts/run.mjs"), fakeSkill);
  write(path.join(skill, "package-manifest.json"), JSON.stringify({ version: "fixture", sourceDigest: "123" }));
  const record = { filePath: "repo/Nested/" + file, sourceProject: "repo", commitHash: "example",
    testKind: "instrument-test", messages: [{ line: 2, rangeStart: 2, rangeEnd: 3,
      rule: "@extrulesproject/code-clone-fragment-check", message: "is similar to repo/Nested/" + file + ":5-6." }] };
  write(dataset, JSON.stringify({ workspaceRoot: "repos", samples: [record, record, record] }));
  const config = path.join(temp, "config.json"), events = path.join(temp, "events.jsonl");
  const hold = path.join(temp, "hold"), release = path.join(temp, "release");
  write(config, JSON.stringify({ ...opts, events, ...(opts.hold ? { hold, release } : {}) }));
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const host = { stateRoot: path.join(temp, "state"), endpoint: { host: "127.0.0.1", port, exclusive: true } };
  const script = path.join(temp, "start.mjs");
  write(script, `import fs from "node:fs";
import { runBatch } from ${JSON.stringify(pathToFileURL(runner).href)};
if (process.platform === "win32" && ${opts.transientRename === true}) {
  const rename = fs.renameSync;
  let attempt = 0;
  fs.renameSync = (src, dest) => {
    if (dest.endsWith("active-case.json") && attempt++ === 1) {
      const error = new Error("temporary file sharing violation");
      error.code = "EPERM";
      throw error;
    }
    return rename(src, dest);
  };
}
try { process.exitCode = await runBatch(process.argv.slice(2), ${JSON.stringify(host)}); }
catch (err) { console.error(err.message); process.exitCode = 2; }`);
  const output = path.join(temp, "out");
  const args = ["--dataset", dataset, "--skill-dir", skill, "--config", config, "--output", output];
  function start(extra: string[], standalone = false) {
    const child = spawn(process.execPath, [script, ...(standalone ? [] : args), ...extra],
      { cwd: temp, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { log += bytes.toString(); });
    const done = new Promise<{ code: number | null; log: string }>((resolve, reject) => {
      child.once("error", reject); child.once("close", code => resolve({ code, log }));
    });
    return { child, done };
  }
  return { start, dataset, record, target, output, events, hold, release, host };
}

test("batch preserves test kind and clone paths, continues sample gate failures, and verifies rollback before the next case", async t => {
  const f = await fixture(t, { blocked: 1, fail: 2, transientRename: true });
  // A source bundle inside somebody else's checkout must not inherit its revision.
  const parent = path.dirname(f.dataset);
  assert.equal(spawnSync("git", ["init", "--quiet", parent]).status, 0);
  assert.equal(spawnSync("git", ["-C", parent, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "enclosing repository"]).status, 0);
  const run = await f.start([]).done;
  assert.equal(run.code, 3, run.log);
  const events = fs.readFileSync(f.events, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.filter(e => e.command === "doctor").map(e => e.text), Array(3).fill("user baseline"));
  assert.deepEqual(events.filter(e => e.command === "rollback").map(e => e.ordinal), [2, 3]);
  assert.deepEqual(events.map(e => e.ordinal), events.map(e => e.ordinal).sort());
  const batch = path.join(f.output, fs.readdirSync(f.output)[0]);
  const summary = JSON.parse(fs.readFileSync(path.join(batch, "summary.json"), "utf8"));
  assert.deepEqual(summary.results.map((r: { verdict: string }) => r.verdict), ["BLOCKED", "FAIL", "PASS"]);
  assert.equal(summary.completedRange, true);
  assert.equal(summary.skillVersion, "fixture");
  assert.ok(summary.results.every((r: { rollbackVerified: boolean }) => r.rollbackVerified));
  assert.ok(summary.results.every((r: { gitHead: string | null; baselineSha256: string; restoredSha256: string }) =>
    r.gitHead === null && /^[0-9a-f]{64}$/.test(r.baselineSha256) && r.baselineSha256 === r.restoredSha256));
  assert.equal(fs.readFileSync(f.target, "utf8"), "user baseline");
});

test("list supports original arrays, inclusive ranges and no project or Skill; preflight prints missing dependencies and stops", async t => {
  const f = await fixture(t, { missing: true });
  const run = await f.start(["--start", "2", "--end", "3"]).done;
  assert.equal(run.code, 3, run.log);
  assert.match(run.log, /SDK.*set path/);
  assert.equal(fs.readFileSync(f.events, "utf8").trim().split("\n").length, 1);
  fs.writeFileSync(f.dataset, JSON.stringify([f.record, f.record, f.record]));
  const list = await f.start(["--dataset", f.dataset, "--list", "--start", "2", "--end", "2"], true).done;
  assert.equal(list.code, 0, list.log);
  assert.match(list.log.trim(), /^2\s+instrument-test[^\n]+File\.ets$/);
  const missing = await f.start([]).done;
  assert.equal(missing.code, 2);
  assert.match(missing.log, /workspaceRoot/);
});

test("independent runners contend for one lock, hard interruption requires recovery, and rollback protects concurrent user edits", async t => {
  const f = await fixture(t, { hold: true });
  const active = f.start(["--end", "1"]);
  t.after(() => { active.child.kill(); });
  try {
    await until(() => fs.existsSync(f.hold));
    const second = await f.start(["--start", "2", "--end", "2"]).done;
    assert.equal(second.code, 2, second.log);
    assert.match(second.log, /EADDRINUSE/);
    const before = JSON.parse(fs.readFileSync(path.join(f.host.stateRoot, "active-case.json"), "utf8"));
    assert.equal(before.pending?.pid, Number(fs.readFileSync(f.hold)), JSON.stringify(before));
    active.child.kill("SIGKILL");
    await active.done;
    // Some Windows hosts terminate the entire job when its runner dies. Others leave the
    // CLI alive. Only the latter can exercise the active-child branch on this host.
    let orphanAlive = true;
    try { process.kill(before.pending.pid, 0); } catch { orphanAlive = false; }
    if (orphanAlive) {
      const blocked = await f.start(["--recover"], true).done;
      assert.equal(blocked.code, 2, blocked.log);
      assert.match(blocked.log, /仍在运行/);
    }
  } finally { fs.writeFileSync(f.release, "done"); }
  const pid = Number(fs.readFileSync(f.hold));
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  const journal = path.join(f.host.stateRoot, "active-case.json");
  assert.equal((await f.start(["--end", "1"]).done).code, 2);
  fs.writeFileSync(f.target, "concurrent user edit");
  assert.equal((await f.start(["--recover"], true).done).code, 2);
  assert.equal(fs.readFileSync(f.target, "utf8"), "concurrent user edit");
  assert.ok(fs.existsSync(journal));
  fs.writeFileSync(f.target, "applied"); // Resolve the conflict explicitly before retry.
  const recovered = await f.start(["--recover"], true).done;
  assert.equal(recovered.code, 0, recovered.log);
  assert.equal(fs.readFileSync(f.target, "utf8"), "user baseline");
  assert.equal(fs.existsSync(journal), false);
});
