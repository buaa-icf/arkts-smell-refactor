import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { analyzeCodeClone } from "../src/analysis/code_clone.js";
import { cloneUiContext, cloneEventEvidence } from "../src/analysis/clone_boundaries.js";
import { buildRefactorPrompt } from "../src/prompts.js";
import { writeText } from "../src/utils.js";
import { fixture, task } from "./helpers.js";

const row = (field: string) => `    Row() {
      Text('开始时间');
      Text(this.${field});
    }
    .onClick(() => {
      TimePickerDialog.show({
        selected: this.selectTime,
        useMilitaryTime: true,
        onAccept: (value: TimePickerResult) => {
          this.${field} = this.format(value);
        }
      });
    });`;
const line = (source: string, text: string) => source.slice(0, source.indexOf(text)).split("\n").length;

test("截断在对话框配置内的克隆补全事件、回调写入与同宿主额外实例", (t) => {
  const root = fixture(t), current = task(root, "code-clone");
  const source = `struct Times {\n  build() {\n${row("nightStart")}\n${row("nightEnd")}\n${row("lunchStart")}\n${row("lunchEnd")}\n  }\n}\nstruct Other {\n  build() {\n${row("outside")}\n  }\n}`;
  const first = line(source, "Text(this.nightStart)"), second = line(source, "Text(this.nightEnd)");
  current.target.range = { start_line: first, end_line: first + 5, column: 1 };
  current.target.related_targets = [{ filePath: current.target.file_path, range: { startLine: second, endLine: second + 5 } }];
  writeText(path.join(root, current.target.file_path), source);
  const analysis = analyzeCodeClone(current, source), group = analysis.eventExtraction.groups[0];
  assert.equal(analysis.instances[0].endLine, first + 5, "不改写检测器范围");
  assert.equal(group.callee, "TimePickerDialog.show");
  assert.equal(group.occurrenceCount, 4, "不纳入 Other 宿主");
  assert.deepEqual(group.occurrences.map((c: any) => c.stateWrites), [["nightStart"], ["nightEnd"], ["lunchStart"], ["lunchEnd"]]);
  assert.deepEqual(group.occurrences.map((c: any) => c.reported), [true, true, false, false]);
  assert.match(group.exemplar.source, /this.nightStart = this.format\(value\);/);
  assert.match(group.exemplar.source, /\}\s*\}\)$/);
  const prompt = buildRefactorPrompt(current, { codeCloneAnalysis: analysis });
  assert.match(prompt, /普通成员 helper/);
  assert.match(prompt, /Text\(this.field\)/);
  assert.match(prompt, /同形候选共 4 处/);
  assert.doesNotMatch(analysis.refactoringPolicy.sameHostExtraction[1], /先在当前宿主内提取成员 @Builder/);
});

test("节点证据涵盖片段前的短标签和片段后的 ID、事件链", () => {
  const source = `struct Page {
  build() {
    Column() {
      Text('鍑哄彂鍩庡競');
      Text(this.departure);
    }
    .id('departure')
    .onClick(() => { this.open(); });
  }
}`;
  const region = cloneUiContext(source, 5, 7)!;
  assert.equal(region.name, "Column");
  assert.deepEqual([region.startLine, region.endLine], [3, 8]);
  assert.equal(cloneUiContext(source, 5, 50), null);
  assert.equal(cloneUiContext(source.replace("this.open(); });", "this.open();"), 5, 7), null);
});

test("超大容器、注释伪节点不成为完整抽取证据", () => {
  assert.equal(cloneUiContext("// Row() { Text('x') }\nconst x = 1;", 1, 1), null);
  const source = "Column() {\n" + "  Text(this.item);\n".repeat(105) + "}";
  assert.equal(cloneUiContext(source, 2, 104), null);
});

test("额外实例很多时优先展示报告关联实例并标记省略数量", () => {
  const source = `struct Times {\n build() {\n${Array.from({ length: 12 }, (_, n) => row(`field${n}`)).join("\n")}\n }\n}`;
  const instances = [10, 11].map(n => {
    const start = line(source, `Text(this.field${n})`);
    return { startLine: start, endLine: start + 5 };
  });
  const group = cloneEventEvidence(source, instances, source.indexOf("{"), source.lastIndexOf("}"))!.groups[0];
  assert.equal(group.occurrenceCount, 12);
  assert.equal(group.omittedOccurrences, 4);
  assert.equal(group.occurrences.length, 8);
  assert.deepEqual(group.occurrences.slice(0, 2).map((c: any) => c.stateWrites), [["field10"], ["field11"]]);
  assert(group.occurrences.slice(0, 2).every((c: any) => c.reported));
});

test("异步事件和仅导航的配置对象保留原 Builder 建议", (t) => {
  const root = fixture(t), current = task(root, "code-clone");
  for (const event of ["async () => { await this.load();", "() => {"]) {
    const section = (field: string) => `Row() {\n  Text(this.${field});\n}.onClick(${event}\n  AppRouter.push({ url: 'Page', param: this.${field} });\n});`;
    const source = `struct Page {\n build() {\n${section("first")}\n${section("second")}\n }\n}`;
    const first = line(source, "Text(this.first)"), second = line(source, "Text(this.second)");
    current.target.range = { start_line: first, end_line: first + 2, column: 1 };
    current.target.related_targets = [{ filePath: current.target.file_path, range: { startLine: second, endLine: second + 2 } }];
    writeText(path.join(root, current.target.file_path), source);
    const analysis = analyzeCodeClone(current, source);
    assert.equal(analysis.eventExtraction, undefined);
    assert.match(analysis.refactoringPolicy.sameHostExtraction[1], /@Builder/);
  }
});

test("短标签在检测范围之前仍以精确转义进入 Code Clone 提示", (t) => {
  const root = fixture(t), current = task(root, "code-clone");
  const section = (name: string, label: string) => `Column() {\n  Text('${label}');\n  Text(this.${name});\n}.id('${name}');`;
  const source = `struct Page {\n build() {\n${section("departure", "鍑哄彂鍩庡競")}\n${section("destination", "鍒拌揪鍩庡競")}\n }\n}`;
  const first = line(source, "Text(this.departure)"), second = line(source, "Text(this.destination)");
  current.target.range = { start_line: first, end_line: first + 1, column: 1 };
  current.target.related_targets = [{ filePath: current.target.file_path, range: { startLine: second, endLine: second + 1 } }];
  writeText(path.join(root, current.target.file_path), source);
  const analysis = analyzeCodeClone(current, source), prompt = buildRefactorPrompt(current, { codeCloneAnalysis: analysis });
  assert.equal(analysis.instances[0].shortLiteralEvidence.entries[0].line, first - 1);
  assert.match(prompt, /\\u9351\\u54c4\\u5f42\\u9369\\u5ea1\\u7af6/);
  assert.match(prompt, /\\u9352\\u62cc\\u63ea\\u9369\\u5ea1\\u7af6/);
  assert.doesNotMatch(prompt, /\\u5162/);
});
