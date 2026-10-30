import test from "node:test";
import assert from "node:assert/strict";
import { longLiteralSegments, sharedLiteralGroups } from "../src/analysis/literals.js";
const lines = (text: string) => text.split(/\r?\n/);
test("注释与缩进不改变精确 token 指纹", () => {
  const first = "'" + "协议".repeat(110) + "'",
    second = "'end\\n\ue74d'",
    a = "Text(" + first + " +\n  " + second + ").id('content')",
    b = "// 'ignored'\nText(" + first + " /* explain 'ignored' */ +\n    " + second + ")",
    left = longLiteralSegments(a, 1, 3)[0],
    right = longLiteralSegments(b, 1, 4)[0];
  assert.equal(left.tokenSha256, right.tokenSha256);
  assert.equal(left.literalCount, 2);
  const source = lines(a);
  assert.equal(
    source[(left.startLine as number) - 1][(left.startColumn as number) - 1],
    "'",
  );
  assert.equal(
    source[(left.endLine as number) - 1][(left.endColumnExclusive as number) - 1],
    ")",
  );
  const groups = sharedLiteralGroups([
    { filePath: "A.ets", longLiteralSegments: [left] },
    { filePath: "B.ets", longLiteralSegments: [right] },
  ]);
  assert.equal(groups.length, 1);
});
test("模板、注释与动态操作数不折叠", () => {
  const token = "'" + "x".repeat(220) + "'";
  assert.deepEqual(
    longLiteralSegments("/* " + token + " */\n`" + "x".repeat(220) + "${value}`", 1, 9),
    [],
  );
  const segments = longLiteralSegments(token + " + value + " + token, 1, 1);
  assert.deepEqual(
    segments.map((segment) => segment.literalCount),
    [1, 1],
  );
  assert.deepEqual(
    sharedLiteralGroups([{ filePath: "A", longLiteralSegments: segments }]),
    [],
  );
});
test("私用区字符与源码转义拼写不做归一化", () => {
  const prefix = "'" + "x".repeat(220),
    raw = longLiteralSegments(prefix + "\ue74d'", 1, 1)[0],
    escaped = longLiteralSegments(prefix + "\\ue74d'", 1, 1)[0],
    removed = longLiteralSegments(prefix + "'", 1, 1)[0];
  assert.equal(
    new Set([raw, escaped, removed].map((item) => item.tokenSha256)).size,
    3,
  );
});
test("报告范围外的片段被排除", () => {
  assert.deepEqual(
    longLiteralSegments("Text('" + "x".repeat(220) + "')\nnext()", 2, 3),
    [],
  );
});
