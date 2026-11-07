import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { prepareRepairContext } from "../src/repair_context.js";
import { refactorGate } from "../src/gate.js";
import { freshCopy } from "../src/workspace.js";
import { hash, readJson, readText, writeJson, writeText } from "../src/utils.js";
import { fixture, makeProject } from "./helpers.js";

const file = "feature/src/main/ets/Page.ets";
function setup(root: string) {
  const p = makeProject(root), workspace = path.join(p.taskDir, "repair-workspace");
  writeText(path.join(p.taskDir, "baseline-production", file), "export class Page { work() { return 1; } }");
  writeText(p.target, "export class Page { work() { return 2; } }");
  writeJson(path.join(p.taskDir, "refactor-changes.json"), { changedProductionFiles: [file], newProductionFiles: [] });
  freshCopy(p.source, workspace, true);
  return { ...p, workspace };
}
test("返修证据使用原始基线与本轮副本，第二轮刷新且不读取陈旧 review diff", t => {
  const p = setup(fixture(t)), baseline = path.join(p.taskDir, "baseline-production", file), original = hash(baseline);
  writeText(path.join(p.taskDir, "review-diff.patch"), "STALE REVIEW");
  for (const value of [2, 3]) {
    writeText(path.join(p.workspace, file), `export class Page { work() { return ${value}; } }`);
    const packet = prepareRepairContext(p.taskDir, p.workspace, String(value));
    assert.match(packet.prompt, /return 1/);
    assert(packet.prompt.includes(`return ${value}`));
    assert(!packet.prompt.includes("STALE REVIEW"));
    const entry = readJson(path.join(p.taskDir, `repair-context-${value}.json`)).files[0];
    assert.equal(entry.current.sha256, hash(path.join(p.workspace, file)));
    assert.equal(entry.baseline.inline, true);
    assert(fs.existsSync(path.join(p.workspace, entry.baseline.path)));
    packet.dispose();
    assert(!fs.existsSync(path.join(p.workspace, entry.baseline.path)));
    assert.equal(hash(baseline), original);
  }
});
test("大型证据不伪装为完整内联；完整差异与基线在工作区中按路径可读", t => {
  const p = setup(fixture(t));
  const before = "original\n".repeat(5000), after = "current\n".repeat(5000);
  writeText(path.join(p.taskDir, "baseline-production", file), before);
  writeText(path.join(p.workspace, file), after);
  const packet = prepareRepairContext(p.taskDir, p.workspace, "large");
  const entry = readJson(path.join(p.taskDir, "repair-context-large.json")).files[0];
  assert.equal(entry.diff.inline, false);
  assert.equal(entry.baseline.inline, false);
  assert.equal(entry.current.inline, false);
  assert.equal(readText(path.join(p.workspace, entry.baseline.path)), before);
  assert(readText(path.join(p.workspace, entry.diff.path)).includes("+current"));
  assert(packet.prompt.length < 6000);
  packet.dispose();
});
test("缺失基线与确实新增分别记录，不用空基线伪造 diff", t => {
  const p = setup(fixture(t)), missing = "feature/src/main/ets/Missing.ets", added = "feature/src/main/ets/New.ets";
  for (const name of [missing, added]) writeText(path.join(p.workspace, name), "export class Other {}");
  writeJson(path.join(p.taskDir, "refactor-changes.json"), { changedProductionFiles: [missing, added], newProductionFiles: [added] });
  const packet = prepareRepairContext(p.taskDir, p.workspace, "missing");
  const [a, b] = readJson(path.join(p.taskDir, "repair-context-missing.json")).files;
  assert.equal(a.added, false);
  assert.equal(a.diff, undefined);
  assert.match(a.baseline.reason, /基线缺失/);
  assert.equal(b.added, true);
  assert.equal(b.diff.inline, true);
  packet.dispose();
});
test("证据路径拒绝测试、越界与符号链接，异常也清理临时材料", t => {
  const p = setup(fixture(t));
  for (const invalid of ["../feature/src/main/ets/Other.ets", "C:/outside/src/main/ets/Other.ets", "feature/src/test/Secret.test.ets"]) {
    writeJson(path.join(p.taskDir, "refactor-changes.json"), { changedProductionFiles: [invalid] });
    assert.throws(() => prepareRepairContext(p.taskDir, p.workspace, "invalid"), /Invalid repair/);
    assert(!fs.readdirSync(p.workspace).some(n => n.startsWith(".arkts-repair-evidence-")));
  }
  const external = path.join(p.source, "outside");
  writeText(path.join(external, "src/main/ets/Other.ets"), "secret");
  fs.symlinkSync(external, path.join(p.workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  writeJson(path.join(p.taskDir, "refactor-changes.json"), { changedProductionFiles: ["linked/src/main/ets/Other.ets"] });
  assert.throws(() => prepareRepairContext(p.taskDir, p.workspace, "symlink"), /escapes snapshot/);
});
test("返修入口清理材料后才同步，失败也清理，初始提示词审计不被覆盖", async t => {
  const p = setup(fixture(t)), prompt = path.join(p.taskDir, "repair-prompt-1.md");
  writeText(prompt, "repair");
  writeText(path.join(p.taskDir, "refactor-agent-prompt.md"), "initial prompt");
  for (const exit of [0, 17]) {
    writeText(path.join(p.source, "run"), [
      "import fs from 'node:fs';",
      "const prompt = fs.readFileSync(process.argv[process.argv.indexOf('-f') + 1], 'utf8');",
      "if (!prompt.includes('本轮返修生产证据') || !fs.readdirSync('.').some(n => n.startsWith('.arkts-repair-evidence-'))) process.exit(91);",
      `fs.writeFileSync(${JSON.stringify(file)}, 'export class Page { work() { return 9; } }');`,
      `process.exit(${exit});`,
    ].join("\n"));
    assert.equal(await refactorGate(p.taskDir, p.source, process.execPath, prompt), exit);
    const workspace = path.join(p.taskDir, "refactor-workspace-repair-prompt-1");
    assert(!fs.readdirSync(workspace).some(n => n.startsWith(".arkts-")));
    assert(!fs.readdirSync(p.source).some(n => n.startsWith(".arkts-")));
    assert.equal(readText(path.join(p.taskDir, "refactor-agent-prompt.md")).trim(), "initial prompt");
    assert.match(readText(path.join(p.taskDir, "repair-prompt-1-agent-prompt.md")), /本轮返修生产证据/);
  }
});
