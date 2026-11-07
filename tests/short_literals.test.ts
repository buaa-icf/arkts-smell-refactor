import test from "node:test";
import assert from "node:assert/strict";
import { asciiLiteral, compareShortLiterals, shortLiterals, scopedShortLiterals } from "../src/analysis/short_literals.js";

test("相似汉字的实际变更给出确定码点，同时排除注释和模板", () => {
  const before = "Text('鍑哄彂鍩庡競'); // Text('鍑哄彂鍩庡兢')\nconst example = `鍑哄彂鍩庡兢`;";
  const after = "shared('鍑哄彂鍩庡兢'); /* '鍑哄彂鍩庡競' */";
  const result = compareShortLiterals(before, after);
  assert.equal(result.baselineUniqueValues, 1);
  assert.equal(result.currentUniqueValues, 1);
  assert.equal(result.missingValueCount, 1);
  assert.equal(result.newValueCount, 1);
  assert.deepEqual(result.possibleReplacements[0].differences, [{ codePointIndex: 5, before: "U+7AF6", after: "U+5162" }]);
  assert.match(result.scope, /不证明调用位置/);
});

test("等值转义、换引号和重复实现合并不报丢失文案", () => {
  const result = compareShortLiterals("Text('城市'); Text(\"城市\");", 'shared("\\u57ce\\u5e02");');
  assert.equal(result.missingValueCount, 0);
  assert.equal(result.newValueCount, 0);
  assert.equal(shortLiterals("Text('\\u{1f600}');")[0].value, "😀");
  assert.equal(shortLiterals("Text('\\uD83D\\uDE00');")[0].value, "😀");
  assert.equal(shortLiterals("Text('城\\x41\\n');")[0].value, "城A\n");
  assert.equal(asciiLiteral('城"\\\n'), '"\\u57ce\\"\\\\\\n"');
});

test("不求值不支持的转义、模板、正则或动态表达式", () => {
  const source = "// '注释'\n/* '注释' */\nconst template = `前缀${'动态'}`;\nconst regex = /'正则'/;\nText('城市');\nText('城\\123');";
  assert.deepEqual(shortLiterals(source).map(s => s.value), ["城市"]);
  assert.deepEqual(shortLiterals("Text('城\\u{110000}');"), []);
  assert.deepEqual(shortLiterals("const r = /'正则'/; Text('城市'); const p = 'a/b'; Text('文案');").map(s => s.value), ["城市", "文案"]);
});

test("原文行列定位保持 CRLF，限量证据明确记录未展示数量", () => {
  const source = "// 注释\r\n  Text('城市');\r\n" + Array.from({ length: 20 }, (_, n) => `Text('标签${n}');`).join("\r\n");
  const evidence = scopedShortLiterals(source, 2, 22);
  assert.equal(evidence.count, 21);
  assert.equal(evidence.omitted, 9);
  assert.deepEqual(evidence.entries[0], { line: 2, column: 8, escapedValue: '"\\u57ce\\u5e02"' });
  assert.equal(scopedShortLiterals(source, 1, 1).count, 0);
  const report = compareShortLiterals(source, "");
  assert.equal(report.missingValueCount, 21);
  assert.equal(report.omittedMissing, 9);
});
