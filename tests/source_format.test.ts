import test from "node:test";
import assert from "node:assert/strict";
import { preserveSourceFormat } from "../src/source_format.js";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf8 = (text: string) => Buffer.from(text, "utf8");
test("保留原有 BOM", () => {
  const original = Buffer.concat([BOM, utf8("export class Page {}\n")]),
    edited = utf8("export class Page {\n  work() {}\n}\n"),
    result = preserveSourceFormat(original, edited);
  assert.deepEqual(result.subarray(0, 3), BOM);
  assert.equal(result.subarray(3).toString("utf8"), edited.toString("utf8"));
});
test("原文件使用 CRLF 时恢复 CRLF", () => {
  const original = utf8("a\r\nb\r\nc\r\n"),
    edited = utf8("a\nb\nc\n"),
    result = preserveSourceFormat(original, edited);
  assert.equal(result.toString("utf8"), "a\r\nb\r\nc\r\n");
});
test("原文件使用 LF 时不引入 CR", () => {
  const original = utf8("a\nb\nc\n"),
    result = preserveSourceFormat(original, utf8("a\nb\nc\nd\n"));
  assert.equal(result.toString("utf8"), "a\nb\nc\nd\n");
});
test("模板与续行表达式的文件不做换行改写", () => {
  const original = utf8("const t = `a\r\nb`;\r\n"),
    edited = utf8("const t = `a\r\nb`;\r\nconst u = 1;\r\n"),
    result = preserveSourceFormat(original, edited);
  assert.equal(result.toString("utf8"), edited.toString("utf8"));
});
test("非 UTF-8 内容原样返回编辑结果", () => {
  const original = Buffer.from([0xff, 0xfe, 0x00, 0x41]),
    edited = Buffer.from([0xff, 0xfe, 0x00, 0x42]);
  assert.equal(preserveSourceFormat(original, edited), edited);
});
