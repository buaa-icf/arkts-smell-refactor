import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Json } from "../src/models.js";
import { analyzeLongMethod } from "../src/analysis/long_method.js";
import { LONG_METHOD_DETECTOR_RULES } from "../src/analysis/detector_rules.js";
import { analyzeRisks } from "../src/risk.js";
import { buildRefactorPrompt, buildRepairPrompt, buildReviewPrompt } from "../src/prompts.js";
import { writeText } from "../src/utils.js";
import { fixture, task } from "./helpers.js";
test("Long Method 画像解析原检测计数并传递检测判据", () => {
  const profile = analyzeLongMethod(
    task("/tmp", "long-method"),
    "build() { return 1; }",
  );
  assert.equal(profile.reportedLineCount, null);
  assert.equal(profile.reportedMax, null);
  const located = analyzeLongMethod(
    { ...task("/tmp", "long-method"), message: "Long method (Current: 91 lines, Max: 50)" },
    "build() {}",
  );
  assert.equal(located.reportedLineCount, 91);
  assert.equal(located.reportedMax, 50);
  assert.equal(located.sourceAvailable, true);
  assert.deepEqual(located.detectorRules, LONG_METHOD_DETECTOR_RULES);
  assert.match(
    String(located.recommendedPattern),
    /私有方法或成员 @Builder/,
  );
  assert((located.limitations as string[]).length > 0);
});
test("风险报告写入 longMethodAnalysis，无源码时计数仍可为空", (t) => {
  const root = fixture(t),
    current = {
      ...task(root, "long-method"),
      message:
        "Long method 'render' (Current: 91 lines, Max: 50) severity=SUGGESTION",
      target: {
        ...task(root, "long-method").target,
        symbol: "render",
        range: { start_line: 1, end_line: 3, column: 1 },
      },
    };
  writeText(
    path.join(root, current.target.file_path),
    "export class Page {\n  render() {\n    return 1;\n  }\n}",
  );
  const report = analyzeRisks(current),
    analysis = report.longMethodAnalysis as Json;
  assert.ok(analysis, "longMethodAnalysis 应写入风险报告");
  assert.equal(analysis.reportedLineCount, 91);
  assert.equal(analysis.reportedMax, 50);
  assert.equal(analysis.sourceAvailable, true);
  assert.match(String(analysis.recommendedPattern), /@Builder/);
  const prompt = buildRefactorPrompt(current, report);
  assert.match(prompt, /Long Method 检测规则与抽取指导/);
  assert.match(prompt, /原检测计数：91；原报告 Max：50/);
  assert.match(prompt, /检测判据：已核对的 HomeCheck 默认阈值/);
});
test("缺少画像的旧任务仍生成检测指导，不回退为无判据", (t) => {
  const root = fixture(t),
    current = {
      ...task(root, "long-method"),
      message: "Long method (Current: 60 lines, Max: 50)",
    };
  const prompt = buildRefactorPrompt(current, { risks: [] });
  assert.match(prompt, /原检测计数：60/);
  assert.match(prompt, /检测判据：/);
});

test("风险入口按原文件绝对行号提供目标，不能对已截取片段再次切片", t => {
  const root = fixture(t), current = task(root, "long-method", "entry/src/main/ets/Page.ets", "build");
  current.target.range = { start_line: 103, end_line: 105, column: 3 };
  const source = "// unrelated context\n".repeat(100) + "@Component\nstruct Page {\n  build() {\n    Text('target-at-line-104')\n  }\n}";
  writeText(path.join(root, current.target.file_path), source);
  const risk = analyzeRisks(current), context = risk.longMethodAnalysis.targetContext;
  assert.equal(context.inline, true);
  assert.equal(context.source, "  build() {\n    Text('target-at-line-104')\n  }");
  const initial = buildRefactorPrompt(current, risk);
  assert.match(initial, /target-at-line-104/);
  assert(!initial.includes("unrelated context"));
  for (const prompt of [buildRepairPrompt(current, risk, { stage: "test" }, 1), buildReviewPrompt(current, risk)])
    assert(!prompt.includes("target-at-line-104"));
});
test("原始目标范围只附在初始重构输入，返修与评审不混入旧源码", t => {
  const root = fixture(t), current = task(root, "long-method", "entry/src/main/ets/Page.ets", "%AM19$build");
  current.target.range = { start_line: 3, end_line: 5, column: 3 };
  const source = "struct Page {\n  unrelated() {}\n  build() {\n    Text('original-only-sentinel')\n  }\n}";
  const analysis = analyzeLongMethod(current, source), risk = { longMethodAnalysis: analysis };
  assert.equal(analysis.targetContext.source, "  build() {\n    Text('original-only-sentinel')\n  }");
  assert.equal(analysis.targetContext.inline, true);
  const initial = buildRefactorPrompt(current, risk);
  assert.match(initial, /original-only-sentinel/);
  assert(!initial.includes("unrelated()"));
  for (const prompt of [buildRepairPrompt(current, risk, { stage: "test" }, 1), buildReviewPrompt(current, risk)])
    assert(!prompt.includes("original-only-sentinel"));
  for (const prompt of [initial, buildRepairPrompt(current, risk, { stage: "smell" }, 1)]) {
    assert.match(prompt, /不为复用顺带修改相邻旧方法/);
    assert.match(prompt, /不读取或遍历工作区外的 SDK/);
  }
});
test("旧 statements 计数保留原单位，缺失或过大范围不会伪造完整源码", () => {
  const current = task("/tmp", "long-method");
  current.message = "Method 'work' (Current: 189 statements, Max: 50)";
  current.target.range = { start_line: 1, end_line: 1, column: 1 };
  const profile = analyzeLongMethod(current, "x".repeat(12_001));
  assert.equal(profile.reportedCount, 189);
  assert.equal(profile.reportedUnit, "statements");
  assert.equal(profile.reportedLineCount, null);
  assert.equal(profile.reportedMax, 50);
  assert.equal(profile.targetContext.inline, false);
  assert.equal(profile.targetContext.source, undefined);
  current.target.range.end_line = 99;
  assert.match(analyzeLongMethod(current, "work() {}").targetContext.reason, /不符合当前源码/);
});
