import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Json } from "../src/models.js";
import { analyzeLongMethod } from "../src/analysis/long_method.js";
import { LONG_METHOD_DETECTOR_RULES } from "../src/analysis/detector_rules.js";
import { analyzeRisks } from "../src/risk.js";
import { buildRefactorPrompt } from "../src/prompts.js";
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
