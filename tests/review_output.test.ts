import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  finalReviewText,
  formatRetryPrompt,
  parseReview,
  preservesReview,
} from "../src/review_output.js";
import { writeText } from "../src/utils.js";
import { fixture } from "./helpers.js";
const event = (type: string, text: string) =>
  JSON.stringify({ type, part: { type: "text", text } });
const review = (verdict: string, extra = "") =>
  `{"verdict":"${verdict}","summary":"ok","issues":[]${extra}}`;
test("只取日志最后一条文本事件作为评审输出", (t) => {
  const root = fixture(t),
    log = path.join(root, "review.log");
  writeText(
    log,
    [
      event("step_start", "忽略"),
      event("text", '{"verdict":"FAIL","summary":"先失败"}'),
      event("tool", "忽略"),
      event("text", review("PASS", ',"smellRemoved":true,"behaviorEquivalent":true,"riskChecks":[]')),
    ].join("\n"),
  );
  const text = finalReviewText(log);
  assert.match(text, /"verdict":"PASS"/);
  assert.doesNotMatch(text, /先失败/);
});
test("非事件日志回退到最后一个 JSON 对象", (t) => {
  const root = fixture(t),
    log = path.join(root, "plain.log");
  writeText(log, "分析过程 {不是评审}\n" + review("PASS") + "\n");
  const text = finalReviewText(log);
  assert.match(text, /"verdict":"PASS"/);
  assert.equal((parseReview(text) as Record<string, unknown>).verdict, "PASS");
});
test("评审解析拒绝重复键、数组与缺失 verdict", () => {
  assert.equal(parseReview('```json\n{"verdict":"PASS"}\n```')?.verdict, "PASS");
  assert.equal(
    parseReview('{"verdict":"PASS","verdict":"FAIL"}'),
    null,
    "重复键不能静默采用最后一个值",
  );
  assert.equal(parseReview('["verdict"]'), null);
  assert.equal(parseReview('{"summary":"no verdict"}'), null);
  assert.equal(parseReview("not json"), null);
});
test("仅格式修复只接受已完成的评审 JSON", () => {
  const malformed =
    '{"verdict":"PASS","summary":"引号未转义：{"a":1}","issues":[]}';
  const prompt = formatRetryPrompt(malformed);
  assert.ok(prompt);
  assert.match(String(prompt), /禁止重新评审/);
  assert.match(String(prompt), /原评审原文（JSON 字符串编码）/);
  assert.equal(formatRetryPrompt(review("PASS")), null, "已合法则无需修复");
  assert.equal(formatRetryPrompt('{"summary":"没有 verdict"}'), null);
  assert.equal(formatRetryPrompt('{"verdict":"PASS","issues":[]'), null);
  assert.equal(formatRetryPrompt("不是 JSON"), null);
});
test("格式修复不得改变结论与证据", () => {
  const original =
    '{"verdict":"PASS","summary":"引号应为 \\"转义\\"","smellRemoved":true,"behaviorEquivalent":true,"riskChecks":[],"issues":[]}';
  const formatted =
    '{\n  "verdict": "PASS",\n  "summary": "引号应为 \\"转义\\"",\n  "smellRemoved": true,\n  "behaviorEquivalent": true,\n  "riskChecks": [],\n  "issues": []\n}';
  assert.equal(preservesReview(original, formatted), true);
  assert.equal(preservesReview(original, formatted.replace('"PASS"', '"FAIL"')), false);
  assert.equal(preservesReview(original, formatted.replace('"引号应为', '"引号已改')), false);
  assert.equal(preservesReview(original, formatted.replace('"smellRemoved": true', '"smellRemoved": false')), false);
  const blocking =
    '{"verdict":"PASS","smellRemoved":true,"behaviorEquivalent":true,"riskChecks":[],"issues":[{"severity":"blocking"}]}';
  assert.equal(preservesReview(blocking, blocking), false, "PASS 不得含 blocking issue");
  const uncertain = review("UNCERTAIN");
  assert.equal(preservesReview(uncertain, uncertain), true);
});
