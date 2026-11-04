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
test("非事件日志保留完整回复，再提取唯一评审对象", (t) => {
  const root = fixture(t),
    log = path.join(root, "plain.log");
  writeText(log, "分析过程 {不是评审}\n" + review("PASS") + "\n");
  const text = finalReviewText(log);
  assert.match(text, /分析过程/);
  assert.match(text, /"verdict":"PASS"/);
  assert.equal((parseReview(text) as Record<string, unknown>).verdict, "PASS");
});

test("说明文字和代码围栏不影响唯一完整评审，字符串内花括号与转义保持原样", () => {
  const value = {
    verdict: "PASS", summary: '保留 [日志]、{x: 1}、引号 "与反斜杠 \\，示例 {"verdict":"FAIL"}',
    smellRemoved: true, behaviorEquivalent: true,
    riskChecks: [{riskCode:"REACTIVE_STATE",status:"passed",evidence:"读取时机不变"}], issues: [],
  };
  const json = JSON.stringify(value, null, 2);
  for (const output of [
    "核对完成。裁剪顺序保留 [高→宽上限] 与 [日志]。\n\n" + json,
    "核对完成。\n```json\n" + json + "\n```\n评审结束。",
    "  " + json + "\n已完成。",
  ]) {
    assert.deepEqual(parseReview(output), value);
    assert.equal(formatRetryPrompt(output), null, "不为合法对象再次调用模型");
  }
  for (const verdict of ["FAIL", "UNCERTAIN"])
    assert.equal(parseReview("核对完成。\n" + review(verdict))?.verdict, verdict);
});

test("不从冲突、嵌套、重复字段或损坏内容中挑选 PASS", () => {
  const pass = review("PASS"), fail = review("FAIL");
  for (const output of [
    fail + "\n" + pass,
    pass + "\n" + pass,
    "说明\n```json\n" + fail + "\n```\n```json\n" + pass + "\n```",
    '[' + pass + ']',
    "说明\n[" + pass + "]",
    '{"result":' + pass + '}',
    "说明\n{\"result\":" + pass + '}',
    "说明\n{\"verdict\":\"FAIL\",\"nested\":" + pass, // missing outer brace
    "说明\n{\"verdict\":\"FAIL\",\"nested\":" + pass + ']。',
    '说明\n{"verdict":"PASS","verdict":"FAIL"}',
    '说明\n{"verdict":"PASS","\\u0076erdict":"FAIL"}',
    '说明\n{"verdict":"PASS","issues":[{"severity":"warning","severity":"blocking"}]}',
    '说明\n{"verdict":"PASS","summary":"未转义 "引用""}',
    '{"verdict":"FAIL",}\n' + pass,
    "{'verdict':'FAIL'}\n" + pass,
    '{verdict:"FAIL"}\n' + pass,
    '{"Verdict":"FAIL"}\n' + pass,
    pass + '\n{"verdict":"FAIL"',
    '说明\n{"verdict":"PASS"} trailing {',
  ]) assert.equal(parseReview(output), null, output);
  for (const output of [fail + "\n" + pass, pass + "\n" + pass, '{"verdict":"PASS","verdict":"FAIL"}'])
    assert.equal(formatRetryPrompt(output), null, "冲突或重复字段不请求格式修复");
});

test("普通日志和同一最终消息的多份结论均不得静默取最后一份", (t) => {
  const log = path.join(fixture(t), "review.log");
  writeText(log, review("FAIL") + "\n" + review("PASS"));
  assert.equal(parseReview(finalReviewText(log)), null);
  const part = (messageID: string, text: string) => JSON.stringify({
    type:"text",sessionID:"session",part:{type:"text",messageID,text},
  });
  writeText(log, [part("old",review("PASS")),part("final",review("FAIL")),part("final",review("PASS"))].join("\n"));
  assert.equal(parseReview(finalReviewText(log)), null);
  writeText(log, [part("old",review("FAIL")),part("final","核对完成。"),part("final",review("PASS"))].join("\n"));
  assert.equal(parseReview(finalReviewText(log))?.verdict, "PASS");
  writeText(log, [part("old",review("PASS")),part("final","证据不足，无法完成评审。")].join("\n"));
  assert.equal(parseReview(finalReviewText(log)), null, "不能退回旧消息的 PASS");
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
