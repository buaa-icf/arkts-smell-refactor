import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cloneComparisonEvidence, cloneComparisonHints } from "../src/analysis/clone_comparison.js";
import { analyzeCodeClone } from "../src/analysis/code_clone.js";
import { buildRefactorPrompt, buildRepairPrompt, buildReviewPrompt } from "../src/prompts.js";
import { fixture, task } from "./helpers.js";
import { writeText } from "../src/utils.js";

const input = (filePath: string, source: string, startLine = 1, endLine = source.split("\n").length) =>
  ({ filePath, source, startLine, endLine, resolved: true });

test("跨文件相同行与差异块保持各自绝对坐标，不靠重命名归一化抹去差异", () => {
  const left = input("a.ets", "// outside\nprepare();\nconst mode = 'left';\napply(mode);\nfinish();\n// tail", 2, 5);
  const right = input("b.ets", "// lead\n// lead\nprepare();\nconst mode = 'right';\napply(mode);\nfinish();", 3, 6);
  const evidence = cloneComparisonEvidence([left, right]);
  assert.deepEqual(evidence.pairs[0].shared, [{ leftStart: 4, leftEnd: 5, rightStart: 5, rightEnd: 6, lines: 2 }]);
  assert.deepEqual(evidence.pairs[0].differences, [{ leftStart: 3, leftEnd: 3, rightStart: 4, rightEnd: 4 }]);
  assert.equal(evidence.contexts[0].source, "prepare();\nconst mode = 'left';\napply(mode);\nfinish();");
  assert(!cloneComparisonHints(evidence, p => p).join("\n").includes("// outside"));
});

test("缺失、无效和大范围只提供补读线索，不能截断后声称完整", () => {
  const rows = [input("missing.ets", ""), input("invalid.ets", "work();", 1, 30), input("large.ets", "x".repeat(6001))];
  rows[0].resolved = false;
  const evidence = cloneComparisonEvidence(rows);
  assert(evidence.contexts.every((c: any) => !c.inline && c.source === undefined));
  assert.deepEqual(evidence.pairs, []);
  const many = cloneComparisonEvidence(Array.from({ length: 9 }, (_, i) => input(`${i}.ets`, "x".repeat(5500))));
  assert.equal(many.contexts.filter((c: any) => c.inline).length, 2);
  assert.equal(many.omittedContexts, 3);
  assert(many.contexts.filter((c: any) => c.inline).reduce((sum: number, c: any) => sum + c.source.length, 0) <= 16000);
});

test("单侧新增或删除的副作用显式保留，不伪造另一侧行范围", () => {
  const simple = input("simple.ets", "prepare();\napply();\nfinish();");
  const guarded = input("guarded.ets", "prepare();\napply();\nguard();\nfinish();");
  const inserted = cloneComparisonEvidence([simple, guarded]);
  assert.deepEqual(inserted.pairs[0].differences, [{ leftStart: null, leftEnd: null, leftBefore: 3, rightStart: 3, rightEnd: 3 }]);
  const deleted = cloneComparisonEvidence([guarded, simple]);
  assert.deepEqual(deleted.pairs[0].differences, [{ leftStart: 3, leftEnd: 3, rightStart: null, rightEnd: null, rightBefore: 3 }]);
  assert.match(cloneComparisonHints(inserted, p => p).join("\n"), /simple\.ets:L3 前（无对应行）/);
});

test("源码包含 Markdown 围栏时仍作为完整数据呈现", () => {
  const evidence = cloneComparisonEvidence([input("a.ets", "const marker = '```';")]);
  const hints = cloneComparisonHints(evidence, p => "relative/" + p).join("\n");
  assert.match(hints, /relative\/a\.ets:L1–1/);
  assert.match(hints, /````\nconst marker = '```';\n````/);
});

test("跨宿主初始提示提供原始片段，修复与评审不混入陈旧源码", t => {
  const root = fixture(t), file = "entry/src/main/ets/A.ets", other = "entry/src/main/ets/B.ets";
  const source = "export class Alpha {\n  work() {\n    prepare('raw-context-sentinel');\n    finish();\n  }\n}";
  writeText(path.join(root, file), source);
  writeText(path.join(root, other), source.replace("Alpha", "Beta"));
  const current = task(root, "code-clone", file, "work");
  current.target.range = { start_line: 2, end_line: 5, column: 1 };
  current.target.related_targets = [{ filePath: other, range: { startLine: 2, endLine: 5 } }];
  const risk = { codeCloneAnalysis: analyzeCodeClone(current, source) };
  assert.ok(risk.codeCloneAnalysis.crossHostExtraction);
  assert.equal(risk.codeCloneAnalysis.originalComparison.contexts[0].inline, true);
  const initial = buildRefactorPrompt(current, risk);
  assert.match(initial, /raw-context-sentinel/);
  assert.match(initial, /原始跨宿主证据/);
  for (const prompt of [buildRepairPrompt(current, risk, { stage: "test" }, 1), buildReviewPrompt(current, risk)]) {
    assert(!prompt.includes("raw-context-sentinel"));
    assert(!prompt.includes("原始跨宿主证据"));
  }
});

test("同宿主现有画像不叠加跨宿主原文包", t => {
  const root = fixture(t), file = "entry/src/main/ets/A.ets";
  const source = "class Alpha {\n  left() {\n    prepare();\n    finish();\n  }\n  right() {\n    prepare();\n    finish();\n  }\n}";
  writeText(path.join(root, file), source);
  const current = task(root, "code-clone", file);
  current.target.range = { start_line: 2, end_line: 5, column: 1 };
  current.target.related_targets = [{ filePath: file, range: { startLine: 6, endLine: 9 } }];
  const profile = analyzeCodeClone(current, source);
  assert.ok(profile.refactoringPolicy.sameHostExtraction);
  assert.equal(profile.crossHostExtraction, undefined);
  assert.equal(profile.originalComparison, undefined);
});
