import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Json } from "../src/models.js";
import { analyzeCodeClone } from "../src/analysis/code_clone.js";
import { CLONE_DETECTOR_RULES } from "../src/analysis/detector_rules.js";
import { buildRefactorPrompt } from "../src/prompts.js";
import { writeText } from "../src/utils.js";
import { fixture, task } from "./helpers.js";
const LONG = "'" + "协议".repeat(110) + "'";
const panel = (prefix: string) =>
  `@Component
export struct Panel {
  build() {
    Row() {
      Text(${LONG})
        .id('${prefix}_' + this.index)
        .fontSize(12)
    }
  }
}
`;
test("动态 UI ID 保留完整表达式，不误吞前缀字面量", (t) => {
  const root = fixture(t),
    file = "app/entry/src/main/ets/pages/A.ets",
    related = "app/entry/src/main/ets/pages/B.ets",
    source = panel("a");
  writeText(path.join(root, file), source);
  writeText(path.join(root, related), panel("b"));
  const current = {
      ...task(root, "code-clone", file, "build"),
      target: {
        file_path: file,
        symbol: "build",
        range: { start_line: 1, end_line: 10, column: 1 },
        related_targets: [
          { filePath: related, range: { startLine: 1, endLine: 10 } },
        ],
      },
    },
    analysis = analyzeCodeClone(current, source),
    instances = analysis.instances as Json[];
  assert.deepEqual(instances[0].uiIds, []);
  const evidence = instances[0].uiIdEvidence as Json[];
  assert.equal(evidence.length, 1);
  assert.match(String(evidence[0].expression), /^'a_' \+ this\.index$/);
  assert.equal(evidence[0].line, 6);
  assert.deepEqual(analysis.detectorRules, CLONE_DETECTOR_RULES);
});
test("长字面量指纹与跨实例相同片段作为证据下传", (t) => {
  const root = fixture(t),
    file = "app/entry/src/main/ets/pages/A.ets",
    related = "app/entry/src/main/ets/pages/B.ets",
    source = panel("a");
  writeText(path.join(root, file), source);
  writeText(path.join(root, related), panel("b"));
  const current = {
      ...task(root, "code-clone", file, "build"),
      target: {
        file_path: file,
        symbol: "build",
        range: { start_line: 1, end_line: 10, column: 1 },
        related_targets: [
          { filePath: related, range: { startLine: 1, endLine: 10 } },
        ],
      },
    },
    analysis = analyzeCodeClone(current, source),
    instances = analysis.instances as Json[],
    segments = instances[0].longLiteralSegments as Json[];
  assert.equal(segments.length, 1);
  assert.equal(segments[0].literalCount, 1);
  assert.equal(
    segments[0].tokenSha256,
    (instances[1].longLiteralSegments as Json[])[0].tokenSha256,
  );
  const groups = analysis.sharedLiteralGroups as Json[];
  assert.equal(groups.length, 1);
  assert.equal((groups[0].occurrences as Json[]).length, 2);
  const prompt = buildRefactorPrompt(current, { codeCloneAnalysis: analysis });
  assert.match(prompt, /相同长字面量 SHA256=/);
  assert.match(prompt, /原长字面量片段 app\/entry.*:5:.*个字符串 token/);
  assert.match(prompt, /原 UI ID 表达式 app\/entry/);
  assert.match(prompt, /检测判据：已核对的 HomeCheck 默认规则/);
});
test("私用区字面量以 JSON 转义提示保留，不进入 .id 字面量集合", (t) => {
  const root = fixture(t),
    file = "app/entry/src/main/ets/pages/A.ets",
    source = `@Component\nexport struct Panel {\n  build() {\n    Text('\\ue74d提示')\n      .id('static_id')\n  }\n}\n`;
  writeText(path.join(root, file), source.replace("\\ue74d", "\ue74d"));
  const current = {
      ...task(root, "code-clone", file, "build"),
      target: {
        file_path: file,
        symbol: "build",
        range: { start_line: 1, end_line: 7, column: 1 },
        related_targets: [],
      },
    },
    analysis = analyzeCodeClone(current, source.replace("\\ue74d", "\ue74d")),
    first = (analysis.instances as Json[])[0];
  assert.deepEqual(first.uiIds, ["static_id"]);
  const literals = first.sensitiveLiteralEvidence as Json[];
  assert.equal(literals.length, 1);
  assert.equal(literals[0].line, 4);
  const prompt = buildRefactorPrompt(current, { codeCloneAnalysis: analysis });
  assert.match(prompt, /含私用区\/格式字符的原字面量/);
  assert.match(prompt, /\\ue74d/);
});
