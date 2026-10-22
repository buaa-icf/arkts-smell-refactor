import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Json } from "../src/models.js";
import { taskFromJson } from "../src/models.js";
import { analyzeFeatureEnvy } from "../src/analysis/feature_envy.js";
import { analyzeSwitch } from "../src/analysis/switch_statement.js";
import { analyzeCodeClone } from "../src/analysis/code_clone.js";
import { analyzeGodClass } from "../src/analysis/god_class.js";
import { analyzeCyclicDependency } from "../src/analysis/cyclic_dependency.js";
import { analyzeRisks } from "../src/risk.js";
import { mask, symbolRegion } from "../src/analysis/source.js";
import { readJson, writeText } from "../src/utils.js";
import { fixture, task } from "./helpers.js";
const fixtures = JSON.parse(
  fs.readFileSync("tests/fixtures/legacy-analysis.json", "utf8"),
) as Json[];
const keys: Record<string, string[]> = {
  switch: [
    "conditionalType",
    "located",
    "evidenceSource",
    "startLine",
    "endLine",
    "switchCount",
    "discriminant",
    "discriminants",
    "reportedBranchCount",
    "branchCount",
    "branchCountMismatch",
    "caseLabels",
    "hasDefault",
    "groupedCaseLabels",
    "executableFallthrough",
    "controlFlow",
    "stateWrites",
    "hasAsyncWork",
    "recommendedPattern",
    "selector",
    "hasFinalElse",
  ],
  envy: [
    "located",
    "reportedTarget",
    "receiver",
    "targetType",
    "ownershipKind",
    "classification",
    "metrics",
    "readCount",
    "writeCount",
    "accessedMembers",
    "receiverCandidates",
    "moveFeasibility",
    "recommendedPattern",
    "recommendedDestination",
    "extractionRegion",
    "mustPreserve",
  ],
  clone: [
    "groupId",
    "detectorCloneKind",
    "detectorContext",
    "instanceCount",
    "resolvedInstanceCount",
    "classification",
    "recommendedPattern",
    "variationDimensions",
  ],
  god: [
    "targetClass",
    "classLocated",
    "lineCount",
    "fieldCount",
    "methodCount",
    "fields",
    "methods",
    "mutableStaticFields",
    "externalCallers",
    "responsibilityCandidates",
    "highRiskMethods",
  ],
  cycle: [
    "module",
    "modulePath",
    "baselineCycles",
    "cycleEdges",
    "publicEntryFiles",
  ],
};
fixtures.forEach((f, i) =>
  test(`原 Python 行为对照 ${i + 1}: ${f.kind}`, (t) => {
    const root = fixture(t),
      raw = JSON.parse(
        JSON.stringify(f.task).replaceAll(
          "$ROOT",
          root.replaceAll("\\", "\\\\"),
        ),
      ),
      current = taskFromJson(raw);
    if (raw.workspace_root === ".") current.workspace_root = root;
    if (raw.project_root === ".") current.project_root = root;
    for (const [r, text] of Object.entries(f.files ?? {}))
      writeText(path.join(root, r), text as string);
    const actual =
      f.kind === "switch"
        ? analyzeSwitch(current, f.source)
        : f.kind === "envy"
          ? analyzeFeatureEnvy(
              current,
              f.source,
              f.declaration,
              f.callers,
              f.reactive,
            )
          : f.kind === "clone"
            ? analyzeCodeClone(current, f.source)
            : f.kind === "god"
              ? analyzeGodClass(current, f.source)
              : analyzeCyclicDependency(current);
    for (const key of keys[f.kind])
      if (key in f.expected)
        assert.deepEqual(actual[key], f.expected[key], key);
  }),
);
test("生产调用点与响应式风险；隐藏测试不进入 Agent 风险报告", (t) => {
  const root = fixture(t),
    current = task(root);
  writeText(
    path.join(root, current.target.file_path),
    "export class Page {\n @State count: number = 0;\n private work() { this.count++; this.work(); }\n}",
  );
  writeText(path.join(root, "entry/src/test/Page.test.ets"), "this.work();");
  const report = analyzeRisks(current);
  assert.equal(report.callers.test, 0);
  assert(!JSON.stringify(report).includes("src/test"));
  assert(report.risks.some((r: Json) => r.code === "REACTIVE_STATE"));
});
test("掩码保留换行和字符串中的注释符，忽略注释假声明", () => {
  const text = `// work() { fake }\nclass Page {\n  work() { const x = "// hi }"; return x; }\n}`;
  assert.equal(mask(text).length, text.length);
  assert.equal(mask(text).split("\n").length, 4);
  assert(symbolRegion(text, "work").located);
  assert(symbolRegion(text, "work").text.includes("return x"));
});
test("未定位符号保持文件证据，不能误声称已定位", () => {
  const source = "class Page {}";
  assert.equal(symbolRegion(source, "missing").located, false);
});
