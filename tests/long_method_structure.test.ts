import test from "node:test";
import assert from "node:assert/strict";
import {
  longMethodStructure,
  longMethodStructureHints,
} from "../src/analysis/long_method_structure.js";
import { analyzeLongMethod } from "../src/analysis/long_method.js";
import {
  buildRefactorPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
} from "../src/prompts.js";
import { task } from "./helpers.js";

function analyze(
  source: string,
  symbol = "build",
  start = 1,
  end = source.split("\n").length,
) {
  const current = task("/tmp", "long-method", "Page.ets", symbol);
  current.target.range = { start_line: start, end_line: end, column: 1 };
  return longMethodStructure(current, source);
}
const textNode = (label: string) =>
  `      Text('${label}')\n        .fontSize(16)\n        .width(100)\n        .height(40)\n        .fontColor(Color.Black)\n        .backgroundColor(Color.White)\n        .borderRadius(2)\n        .opacity(1)`;

test("同名成员按报告位置消歧，不能选择文件中第一个 build", () => {
  const source =
    "@Component\nstruct A {\n  build() {\n    Text('first')\n  }\n}\n@ComponentV2\nstruct B {\n  build() {\n    Text('second')\n  }\n}";
  assert.equal(analyze(source).status, "unresolved");
  const result = analyze(source, "build", 9, 11);
  assert.equal(result.status, "located");
  assert.equal(result.target.owner, "B");
  assert.equal(result.target.startLine, 9);
  assert.equal(result.target.endLine, 11);
  assert.equal(result.uiEvidence, "@ComponentV2 struct build");
  assert.equal(analyze(source, "build", 40, 50).status, "unresolved");
});

test("UI 装饰器归属于当前宿主，普通 build 不继承上一组件分类", () => {
  const source =
    "@Component\nstruct A {}\nstruct Worker {\n  build() { return 1; }\n}\n@CustomDialog\nexport struct Dialog {\n  build() { Text('dialog') }\n}";
  assert.equal(analyze(source, "build", 4, 4).uiEvidence, "未确认 UI 分类");
  assert.equal(
    analyze(source, "build", 8, 8).uiEvidence,
    "@CustomDialog struct build",
  );
});

test("报告范围已漂移时指出范围内成员，不把另一个 build 当成原目标", () => {
  const source =
    "@Component\nstruct Page {\n  @Builder\n  content() {\n    Text('moved')\n  }\n  build() { this.content(); }\n}";
  const result = analyze(source, "build", 3, 6);
  assert.equal(result.status, "unresolved");
  assert.match(result.reason, /content L4–6/);
  assert.equal(result.candidates, undefined);
});

test("具名方法保留复杂形参类型及控制流，不能把参数对象类型当成方法体", () => {
  const source = `class Worker {
  work(error: BusinessError | undefined, options: { retry: boolean }, cb: (value: number) => void): Promise<void> {
    try {
      if (error) { return; }
      await send(options);
    } finally { cb(1); }
  }
}`;
  const result = analyze(source, "work");
  assert.equal(result.status, "located");
  assert.deepEqual(result.parameters, [
    "error: BusinessError | undefined",
    "options: { retry: boolean }",
    "cb: (value: number) => void",
  ]);
  assert.deepEqual(result.controlFlow, ["return", "await"]);
  assert.equal(result.target.endLine, 7);
  assert.deepEqual(result.candidates, []);
  assert.match(
    longMethodStructureHints(result).join("\n"),
    /try\/catch\/finally/,
  );
});

test("子树边界含完整修饰符与事件回调，不拆回调内节点和固定 Item", () => {
  const source = `@ComponentV2
struct Page {
  build() {
    Column() {
      Row() {
${textNode("one")}
      }
      .width(200)
      .onClick(() => {
${textNode("inside-event")}
      })
      GridItem() {
${textNode("fixed-grid-item")}
      }
      ForEach(this.items, (item: Item, index: number) => {
${textNode("inside-iterator")}
      }, (item: Item) => item.key)
    }
  }
}`;
  const result = analyze(source);
  const row = result.candidates.find((n: any) => n.node === "Row");
  assert.ok(row);
  const fragment = source
    .split("\n")
    .slice(row.startLine - 1, row.endLine)
    .join("\n");
  assert.match(fragment, /\.width\(200\)/);
  assert.match(fragment, /inside-event/);
  assert.equal(fragment.trim().endsWith("})"), true);
  assert(
    !result.candidates.some(
      (n: any) => n.node === "GridItem" || n.node === "Text",
    ),
  );
  const iterator = result.candidates.find((n: any) => n.node === "ForEach");
  assert.ok(iterator);
  assert.match(source.split("\n")[iterator.endLine - 1], /item\.key/);
  const nodes = result.candidates;
  for (let i = 1; i < nodes.length; i++)
    assert(nodes[i - 1].endLine < nodes[i].startLine);
});

test("匿名报告只定位外围，不把外围全部代码冒充回调抽取目标", () => {
  const source = `struct Page {\n  @Builder\n  goodPkgComp() {\n    ForEach(this.items, (item: Item) => {\n${textNode("item")}\n    })\n  }\n}`;
  const result = analyze(source, "%AM19$goodPkgComp", 2, 14);
  assert.equal(result.status, "enclosing-only");
  assert.equal(result.target.name, "goodPkgComp");
  assert.equal(result.candidates, undefined);
  assert.match(longMethodStructureHints(result).join("\n"), /匿名回调身份无法/);
});

test("嵌套、可选链、取反和比较的宿主访问提供根字段证据，不要求先证明外部类型", () => {
  const source = `@ComponentV2
struct Page {
  @Local selectState: SelectState = new SelectState();
  @Param vm: ViewModel
  @Builder
  private options() {
    Text('option')
      .fontColor(!this.selectState.isReadingBySwiper ? Color.White : Color.Black)
      .backgroundColor(this.selectState.isReadingBySwiper === false ? Color.Black : Color.White)
      .opacity(this.vm?.enabled ? 1 : 0)
      .onClick(() => { this.selectState.isReadingBySwiper = true; })
    // this.fake.value
    Text('this.stringFake.value')
    this.updateOption(false);
  }
  updateOption(value: boolean): void { this.vm.update(value); }
  unrelated() {}
}`;
  const result = analyze(source, "options");
  assert.equal(result.uiEvidence, "@Builder/@LocalBuilder");
  const state = result.stateAccesses.find(
    (r: any) => r.expression === "this.selectState.isReadingBySwiper",
  );
  assert.deepEqual(state.declaration, {
    line: 3,
    decorators: ["Local"],
    type: "SelectState",
  });
  assert.deepEqual(state.lines, [8, 9, 11]);
  assert.ok(
    result.stateAccesses.find((r: any) => r.expression === "this.vm?.enabled"),
  );
  assert.equal(
    result.stateAccesses.find((r: any) => r.expression === "this.vm?.enabled")
      .declaration.type,
    "ViewModel",
  );
  assert(
    !result.stateAccesses.some((r: any) => /Fake|fake/.test(r.expression)),
  );
  assert.equal(result.calledMembers.length, 1);
  assert.equal(
    result.calledMembers[0].signature,
    "updateOption(value: boolean): void",
  );
  const hints = longMethodStructureHints(result).join("\n");
  assert.match(hints, /不要预先计算成 selected\/value/);
  assert.match(hints, /事件内原本延迟执行的读取仍留在事件内/);
});

test("仅原始重构输入使用结构行号和成员签名，返修及评审不混入陈旧画像", () => {
  const source = `@Component\nstruct Page {\n  build() {\n    Text(this.preEditState)\n    this.preEditHelper();\n  }\n  preEditHelper(): void {}\n}`;
  const current = task("/tmp", "long-method", "Page.ets", "build");
  current.target.range = { start_line: 3, end_line: 6, column: 1 };
  const risk = { longMethodAnalysis: analyzeLongMethod(current, source) };
  const initial = buildRefactorPrompt(current, risk);
  assert.match(initial, /preEditHelper\(\): void/);
  assert.match(initial, /宿主访问 this.preEditState/);
  for (const prompt of [
    buildRepairPrompt(current, risk, { stage: "test" }, 1),
    buildReviewPrompt(current, risk),
  ])
    assert(!/preEditHelper|preEditState|原始结构与抽取线索/.test(prompt));
});

test("无法证明边界的正则、泛型方法和大文件回退定位，不输出抽取候选", () => {
  for (const source of [
    "class Page {\n  work() {\n    const rule = /[{}]/;\n    return rule.test('a');\n  }\n}",
    "class Page {\n  work<T>(item: T) { return item; }\n}",
    "class Page {\n  work(): { value: number } { return { value: 1 }; }\n}",
    " ".repeat(500_001),
  ]) {
    const result = analyze(source, "work");
    assert.equal(result.status, "unresolved");
    assert.equal(result.candidates, undefined);
  }
});

test("画像限制字段和成员签名数量，并注明模板插值及绑定分析限制", () => {
  const source = `@Component\nstruct Page {\n  build() {\n${Array.from({ length: 30 }, (_, i) => `    Text(this.field${i}.value)`).join("\n")}\n    Text(\`state: \${this.templateOnly}\`)\n  }\n}`;
  const result = analyze(source);
  assert.equal(result.stateAccesses.length, 12);
  assert.equal(result.stateAccessesTruncated, true);
  assert(
    !result.stateAccesses.some(
      (r: any) => r.expression === "this.templateOnly",
    ),
  );
  const hints = longMethodStructureHints(result).join("\n");
  assert.match(hints, /模板插值/);
  assert.match(hints, /缺少记录不证明不响应式/);
  assert(hints.length < 5000);
});
