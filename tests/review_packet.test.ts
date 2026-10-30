import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS, PACKET_VERSION, prepareReviewPrompt } from "../src/review_packet.js";
import { readJson, readText, writeJson, writeText } from "../src/utils.js";
import { fixture } from "./helpers.js";
function taskDir(root: string, options: { gates?: unknown; files?: string[] } = {}): string {
  const dir = path.join(root, "task"),
    files = options.files ?? ["entry/src/main/ets/Page.ets"];
  writeJson(path.join(dir, "refactor-changes.json"), {
    changedProductionFiles: files,
    changedProductionResources: [],
  });
  writeJson(path.join(dir, "review-risk.json"), { riskLevel: "medium", risks: [] });
  writeJson(path.join(dir, "review-context.json"), { productionDependencies: [] });
  writeJson(
    path.join(dir, "gates.json"),
    options.gates ?? {
      attempt: 1,
      validationPolicy: { linterMode: "required" },
      gates: [
        { name: "smell", status: "PASS", exit_code: 0 },
        { name: "build", status: "PASS", exit_code: 0 },
        { name: "test", status: "PASS", exit_code: 0 },
      ],
    },
  );
  writeText(path.join(dir, "review-diff.patch"), "--- a\n+++ b\n+changed\n");
  for (const file of files) {
    writeText(path.join(dir, "baseline-production", file), "export class Page {\n  work() { return 1; }\n}\n");
    writeText(path.join(dir, "current-production", file), "export class Page {\n  work() { return 2; }\n}\n");
  }
  writeText(path.join(dir, "review-prompt.md"), "你是独立的评审 Agent。");
  return dir;
}
test("集中材料内联完整源码、diff 与门禁摘要并记录版本", (t) => {
  const root = fixture(t),
    dir = taskDir(root),
    destination = prepareReviewPrompt(dir, path.join(dir, "review-prompt.md"));
  assert.equal(path.basename(destination), "review-agent-prompt.md");
  const manifest = readJson(path.join(dir, "review-packet.json"));
  assert.equal(manifest.packetVersion, PACKET_VERSION);
  assert.equal(manifest.gateAttempt, 1);
  assert.equal(manifest.diff.inline, true);
  const changed = manifest.changedFiles[0];
  assert.equal(changed.file, "entry/src/main/ets/Page.ets");
  assert.equal(changed.before.inline, true);
  assert.equal(changed.after.inline, true);
  assert.equal(changed.before.lines, 3);
  assert.equal(changed.byteIdentical, false);
  assert.deepEqual(changed.textComparison, { identicalPrefixLines: 1, identicalSuffixLines: 1 });
  assert.match(String(changed.after.sha256), /^[0-9a-f]{64}$/);
  const prompt = readText(destination);
  assert.match(prompt, /你是独立的评审 Agent。/);
  assert.match(prompt, /## 本轮集中评审材料/);
  assert.match(prompt, /review-packet\.json（清单）/);
  assert.match(prompt, /2: +work\(\) \{ return 2; \}/, "源码带原文件行号");
  assert.match(prompt, /review-diff\.patch（完整）/);
});
test("超出上限的源码与 diff 不截断内联，改为定向补读", (t) => {
  const root = fixture(t),
    dir = taskDir(root),
    destination = prepareReviewPrompt(dir, path.join(dir, "review-prompt.md"), {
      source: 10,
      file: 40,
      diff: 4,
      json: DEFAULT_LIMITS.json,
    }),
    manifest = readJson(path.join(dir, "review-packet.json")),
    prompt = readText(destination);
  assert.equal(manifest.diff.inline, false);
  assert.match(String(manifest.diff.readHint), /未截断/);
  assert.equal(manifest.changedFiles[0].before.inline, false);
  assert.equal(manifest.changedFiles[0].after.inline, false);
  assert.match(String(manifest.changedFiles[0].before.readHint), /按精确路径读取/);
  assert.doesNotMatch(prompt, /work\(\) \{ return 2; \}/, "未内联时不能只附前半部分");
  assert.match(prompt, /inline=false 的必要证据须按精确路径批量补读/);
});
test("门禁缺少当前 attempt 时阻止生成材料", (t) => {
  const root = fixture(t),
    dir = taskDir(root, {
      gates: { validationPolicy: {}, gates: [{ name: "smell", status: "PASS" }] },
    });
  assert.throws(
    () => prepareReviewPrompt(dir, path.join(dir, "review-prompt.md")),
    /gates\.json lacks current attempt or gates/,
  );
});
test("变化的文件必须出现在至少一侧快照", (t) => {
  const root = fixture(t),
    dir = taskDir(root);
  writeJson(path.join(dir, "refactor-changes.json"), {
    changedProductionFiles: ["entry/src/main/ets/Missing.ets"],
    changedProductionResources: [],
  });
  assert.throws(
    () => prepareReviewPrompt(dir, path.join(dir, "review-prompt.md")),
    /missing from both snapshots/,
  );
});
test("越界证据路径被拒绝", (t) => {
  const root = fixture(t),
    dir = taskDir(root);
  writeJson(path.join(dir, "refactor-changes.json"), {
    changedProductionFiles: ["../outside.ets"],
    changedProductionResources: [],
  });
  assert.throws(
    () => prepareReviewPrompt(dir, path.join(dir, "review-prompt.md")),
    /Invalid review evidence path|escapes snapshot/,
  );
});
test("本轮跳过或未执行的门禁不内联残留明细", (t) => {
  const root = fixture(t),
    dir = taskDir(root, {
      gates: {
        attempt: 2,
        validationPolicy: { linterMode: "skip" },
        gates: [
          { name: "smell", status: "PASS" },
          { name: "linter", status: "SKIPPED" },
        ],
      },
    });
  writeJson(path.join(dir, "linter-after.json"), { status: "FAIL", residual: "STALE_LINTER_OUTPUT" });
  const destination = prepareReviewPrompt(dir, path.join(dir, "review-prompt.md")),
    manifest = readJson(path.join(dir, "review-packet.json")),
    entry = (manifest.evidence as Record<string, any>[]).find((item) => item.path === "linter-after.json");
  assert.ok(entry);
  assert.equal(entry!.inline, false);
  assert.match(String(entry!.readHint), /勿使用残留文件/);
  assert.doesNotMatch(readText(destination), /STALE_LINTER_OUTPUT/);
});
test("返修后重新生成材料反映当前源码", (t) => {
  const root = fixture(t),
    dir = taskDir(root),
    source = path.join(dir, "review-prompt.md");
  prepareReviewPrompt(dir, source);
  writeText(
    path.join(dir, "current-production/entry/src/main/ets/Page.ets"),
    "export class Page {\n  work() { return 3; }\n}\n",
  );
  const destination = prepareReviewPrompt(dir, source),
    text = readText(destination);
  assert.match(text, /return 3;/);
  assert.doesNotMatch(text, /return 2;/);
  assert.ok(fs.existsSync(path.join(dir, "review-packet.json")));
});
