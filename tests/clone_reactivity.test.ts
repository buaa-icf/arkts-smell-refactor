import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { TestContext } from "node:test";
import { analyzeCodeClone } from "../src/analysis/code_clone.js";
import { buildRefactorPrompt, buildReviewPrompt } from "../src/prompts.js";
import { writeText } from "../src/utils.js";
import { fixture, task } from "./helpers.js";

function profile(t: TestContext, extra = "", type = "struct") {
  const root = fixture(t),
    current = task(root, "code-clone");
  const lines = [
    type + " Panel {",
    "  @State",
    "  searchList: Item[] = []",
    "  @Link selected: Item[]", // no initializer or semicolon
    "  @StorageProp('enabled') @Watch('changed') enabled: boolean = false;",
    "  build() {",
    "    ForEach(this.searchList, (item: Item) => {",
    "      Text(item.name).onClick(() => {",
    "        if (this.enabled === true) this.selected.push(item)",
    "      })",
    "    })",
    "  }",
    "  @Builder",
    "  items(list: Item[]) {",
    "    ForEach(list, (item: Item) => {",
    "      Text(item.name).onClick(() => {",
    "        if (this.enabled === true) this.selected.push(item)",
    "      })",
    "    })",
    "  }",
    "  update() {",
    extra,
    "  }",
    "}",
    "struct Other { @State searchList: Item[] = []; update() { this.searchList = []; } }",
  ];
  const source = lines.join("\r\n");
  current.target.range = { start_line: 7, end_line: 11, column: 1 };
  current.target.related_targets = [
    {
      filePath: current.target.file_path,
      range: { startLine: 15, endLine: 19 },
    },
  ];
  writeText(path.join(root, current.target.file_path), source);
  return { current, source, analysis: analyzeCodeClone(current, source) };
}

test("同宿主数据源区分响应式字段和 Builder 形参，并包含回调中的无分号 Link 字段", (t) => {
  const { analysis, current } = profile(t),
    evidence = analysis.reactiveExtraction;
  assert.equal(evidence.owner, "struct Panel");
  assert.deepEqual(
    evidence.dataSources.map((s: any) => [
      s.expression,
      s.binding,
      s.declarationLine,
    ]),
    [
      ["this.searchList", "host-field", 3],
      ["list", "member-parameter", 14],
    ],
  );
  const list = evidence.fields.find((f: any) => f.name === "searchList");
  assert.equal(list.reactive, true);
  assert.equal(list.writeCandidateCount, 0);
  assert.deepEqual(list.readLines, [7]);
  const selected = evidence.fields.find((f: any) => f.name === "selected");
  assert.deepEqual(selected.decorators, ["Link"]);
  assert.equal(selected.declarationLine, 4);
  assert.deepEqual(
    selected.writeCandidates.map((w: any) => [
      w.line,
      w.kind,
      w.member,
      w.inClone,
    ]),
    [
      [9, "mutating-call-candidate", "build", true],
      [17, "mutating-call-candidate", "items", true],
    ],
  );
  const enabled = evidence.fields.find((f: any) => f.name === "enabled");
  assert.deepEqual(enabled.decorators, ["StorageProp", "Watch"]);
  assert.equal(enabled.writeCandidateCount, 0); // === is not assignment
  const risk = { codeCloneAnalysis: analysis, risks: [], constraints: [] };
  for (const prompt of [
    buildRefactorPrompt(current, risk),
    buildReviewPrompt(current, risk),
  ]) {
    assert.match(prompt, /数据源 L7 build.*this.searchList.*@State/);
    assert.match(prompt, /数据源 L15 items.*成员形参 list: Item\[\]/);
    assert.match(prompt, /只抽取共同子项/);
    assert.match(prompt, /未发现写入不代表状态不变/);
  }
});

test("宿主内范围外的赋值、索引写入、前缀更新和可能改变状态的方法均提供定位", (t) => {
  const { analysis } = profile(
    t,
    [
      "    this.searchList = []",
      "    this.searchList[0].name = 'changed'",
      "    ++this.enabled",
      "    this.selected.customMutation()",
      "    this.enabled ||= false",
      "    this.enabled !== false",
    ].join("\n"),
  );
  const fields = analysis.reactiveExtraction.fields;
  assert.deepEqual(
    fields
      .find((f: any) => f.name === "searchList")
      .writeCandidates.map((w: any) => [w.line, w.kind, w.inClone]),
    [
      [22, "assignment-or-update", false],
      [23, "member-write-or-call-candidate", false],
    ],
  );
  assert.deepEqual(
    fields
      .find((f: any) => f.name === "enabled")
      .writeCandidates.map((w: any) => w.line),
    [24, 26],
  );
  assert.equal(
    fields.find((f: any) => f.name === "selected").writeCandidateCount,
    3,
  );
});

test("注释、字符串、模板和别名不伪装成直接写入；缺少直接写入不能推出不可变", (t) => {
  const { analysis } = profile(
    t,
    [
      "    // this.searchList = []",
      "    const text = 'this.searchList = []'",
      "    const template = `value ${this.searchList}`",
      "    const alias = this.searchList",
      "    alias.push(item)",
      "    this['searchList'] = []",
    ].join("\n"),
  );
  const evidence = analysis.reactiveExtraction;
  const list = evidence.fields.find((f: any) => f.name === "searchList");
  assert.equal(list.referenceCount, 2);
  assert.equal(list.writeCandidateCount, 0);
  assert.match(evidence.limitations, /未追踪别名、外部调用/);
  assert.match(evidence.limitations, /模板插值不计入/);
  assert.match(
    evidence.guidance.join("\n"),
    /不因本地无写入记录认定可安全传值/,
  );
});

test("普通类和无法解析的对照不生成同宿主 UI 响应式建议", (t) => {
  assert.equal(profile(t, "", "class").analysis.reactiveExtraction, undefined);
  const { current, source } = profile(t);
  current.target.related_targets[0].filePath = "missing.ets";
  assert.equal(analyzeCodeClone(current, source).reactiveExtraction, undefined);
});

test("写入候选过多时保留总数并标记截断，不把位置摘要当完整清单", (t) => {
  const { analysis } = profile(
    t,
    Array.from({ length: 12 }, () => "    this.searchList.push(item)").join(
      "\n",
    ),
  );
  const list = analysis.reactiveExtraction.fields.find(
    (f: any) => f.name === "searchList",
  );
  assert.equal(list.writeCandidateCount, 12);
  assert.equal(list.writeCandidates.length, 8);
  assert.equal(list.truncated, true);
});
