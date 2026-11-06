import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCrossHostClone,
  crossHostCloneHints,
} from "../src/analysis/clone_cross_host.js";

const line = (source: string, needle: string) => {
  const offset = source.indexOf(needle);
  assert(offset >= 0, `Missing fixture marker: ${needle}`);
  return source.slice(0, offset).split("\n").length;
};
function input(filePath: string, source: string, first: string, last = first) {
  return {
    filePath,
    source,
    startLine: line(source, first),
    endLine: line(source, last),
    resolved: true,
  };
}
const uiHost = (name: string) => `@Entry
@ComponentV2
struct ${name} {
  @Local title: string = '';
  private pathStack: NavPathStack = new NavPathStack();
  private dialog: CustomDialogController = new CustomDialogController({
    builder: ContentDialog({ onDone: () => { this.title = ''; } }),
    customStyle: true
  });
  aboutToAppear(): void { this.title = this.loadTitle(); }
  build() {
    NavDestination() {
      Column() {
        Text(this.title)
          .fontSize(18)
          .fontColor(Color.Black)
      }
    }
    .onReady((context: NavDestinationContext) => {
      this.pathStack = context.pathStack;
    })
    .onShown(() => { this.title = this.loadTitle(); })
  }
  private loadTitle(): string { return ''; }
}`;

test("跨文件同名宿主仍属于不同实例，报告截断不丢宿主边界线索", () => {
  const left = uiHost("Panel"),
    right = uiHost("Panel");
  const profile = analyzeCrossHostClone([
    input("featureA/Panel.ets", left, "Text(this.title)", ".fontColor"),
    input("featureB/Panel.ets", right, "Text(this.title)", ".fontColor"),
  ]);
  assert.ok(profile);
  assert.equal(profile.kind, "cross-host");
  assert.deepEqual(
    profile.hosts.map((h: any) => h.host.name),
    ["Panel", "Panel"],
  );
  for (const host of profile.hosts) {
    assert(
      host.controllers.some((c: any) => c.name === "CustomDialogController"),
    );
    assert(host.uiRoots.some((r: any) => r.name === "NavDestination"));
    assert(host.lifecycle.some((l: any) => l.name === "onReady"));
    assert(host.lifecycle.some((l: any) => l.name === "aboutToAppear"));
    assert(host.controllers[0].startLine < host.reportStartLine);
    const root = host.uiRoots.find((r: any) => r.name === "NavDestination");
    assert.ok(root);
    assert(root.startLine < host.reportStartLine);
    assert(
      root.endLine > host.reportEndLine,
      "NavDestination 的完整链范围包含报告后生命周期修饰符",
    );
  }
  const hints = crossHostCloneHints(profile).join("\n");
  assert.match(hints, /featureA\/Panel\.ets/);
  assert.match(hints, /featureB\/Panel\.ets/);
  assert.match(hints, /CustomDialogController/);
  assert.match(hints, /NavDestination/);
  assert.match(hints, /onReady/);
  assert.match(hints, /aboutToAppear/);
});

test("同文件不同 struct 可以形成跨宿主画像，不能按文件名归为类内", () => {
  const left = uiHost("LeftPanel"),
    right = uiHost("RightPanel");
  const source = left + "\n\n" + right;
  const secondStart = source
    .slice(0, source.indexOf("struct RightPanel"))
    .split("\n").length;
  const first = input("Panels.ets", source, "Text(this.title)", ".fontColor");
  const second = input("Panels.ets", right, "Text(this.title)", ".fontColor");
  second.source = source;
  const offset =
    source.slice(0, source.indexOf("@Entry", left.length)).split("\n").length -
    1;
  second.startLine += offset;
  second.endLine += offset;
  assert(second.startLine > secondStart);
  const profile = analyzeCrossHostClone([first, second]);
  assert.ok(profile);
  const hints = crossHostCloneHints(profile).join("\n");
  assert.match(hints, /LeftPanel/);
  assert.match(hints, /RightPanel/);
});

test("报告涵盖导入和顶层入口时仍识别唯一宿主，顶层线索不归入宿主", () => {
  const source = (name: string) => `import { Model } from './model';
const initialTitle: string = '';
const sharedDialog = new CustomDialogController({ builder: SharedDialog() });
@Builder
function renderHeader() {
  Text(initialTitle)
}
function aboutToDisappear() { sharedDialog.close(); }
${uiHost(name)}`;
  const profile = analyzeCrossHostClone([
    input("PanelA.ets", source("PanelA"), "import { Model }", ".fontColor"),
    input("PanelB.ets", source("PanelB"), "import { Model }", ".fontColor"),
  ]);
  assert.ok(profile);
  for (const host of profile.hosts) {
    assert.equal(host.reportStartLine, 1);
    assert(host.host.startLine > host.reportStartLine);
    assert.equal(host.hostReportStartLine, host.host.startLine);
    assert.equal(host.hostReportEndLine, host.reportEndLine);
    assert.equal(host.controllers.length, 1);
    assert(host.controllers[0].startLine > host.host.startLine);
    assert(!host.lifecycle.some((m) => m.name === "aboutToDisappear"));
    assert(!host.memberTypes.some((m) => m.name === "initialTitle"));
  }
  assert.doesNotMatch(
    crossHostCloneHints(profile).join("\n"),
    /SharedDialog|renderHeader|initialTitle/,
  );
});

test("画像不混入范围外其他宿主的 controller、生命周期或字段", () => {
  const source =
    uiHost("VisiblePanel") +
    `
@Component
struct UnrelatedPanel {
  @State outsiderSecret: number = 7;
  extra = new CustomDialogController({ builder: OtherDialog() });
  aboutToDisappear() { this.outsiderSecret = 0; }
  build() { Navigation() { Text(this.outsiderSecret) } }
}`;
  const profile = analyzeCrossHostClone([
    input("A.ets", source, "Text(this.title)", ".fontColor"),
    input("B.ets", uiHost("PeerPanel"), "Text(this.title)", ".fontColor"),
  ]);
  assert.ok(profile);
  assert.equal(profile.hosts[0].host.name, "VisiblePanel");
  assert.equal(profile.hosts[0].controllers.length, 1);
  assert(
    !profile.hosts[0].lifecycle.some((l: any) => l.name === "aboutToDisappear"),
  );
  assert(
    !profile.hosts[0].memberTypes.some((m: any) => m.name === "outsiderSecret"),
  );
  assert.doesNotMatch(
    crossHostCloneHints(profile).join("\n"),
    /UnrelatedPanel|outsiderSecret|OtherDialog/,
  );
});

test("类内状态类型保留 undefined，静态单例入口作为所有权证据", () => {
  const source = (name: string) => `export class ${name} {
  private static singleton: ${name} | undefined;
  private payload: Payload | undefined;
  public static get instance(): ${name} {
    if (!this.singleton) { this.singleton = new ${name}(); }
    return this.singleton;
  }
  public update(value: Payload | undefined): void {
    this.payload = value;
    this.persist(this.payload);
  }
  private persist(value: Payload | undefined): void { save(value); }
}`;
  const left = source("FirstStore"),
    right = source("SecondStore");
  const profile = analyzeCrossHostClone([
    input(
      "FirstStore.ets",
      left,
      "public update",
      "this.persist(this.payload)",
    ),
    input(
      "SecondStore.ets",
      right,
      "public update",
      "this.persist(this.payload)",
    ),
  ]);
  assert.ok(profile);
  for (const host of profile.hosts) {
    const field = host.memberTypes.find((m: any) => m.name === "payload");
    assert.ok(field);
    assert.match(field.type, /Payload\s*\|\s*undefined/);
    assert(host.staticEntries.some((e: any) => e.name === "instance"));
    assert.equal(host.controllers.length, 0);
    assert.equal(host.uiRoots.length, 0);
  }
  assert.match(
    crossHostCloneHints(profile).join("\n"),
    /Payload\s*\|\s*undefined/,
  );
});

test("字符串和注释中的 controller、UI 根和生命周期不形成证据", () => {
  const source = (name: string) => `class ${name} {
  value: string = '';
  work() {
    // new CustomDialogController({ builder: FakeDialog() });
    // NavDestination().onReady(() => this.fake());
    const example = 'Navigation() { Text(this.fake) }.onShown(() => {})';
    this.value = example;
  }
}`;
  const profile = analyzeCrossHostClone([
    input("One.ets", source("One"), "work()", "this.value = example"),
    input("Two.ets", source("Two"), "work()", "this.value = example"),
  ]);
  assert.ok(profile);
  for (const host of profile.hosts) {
    assert.equal(host.controllers.length, 0);
    assert.equal(host.uiRoots.length, 0);
    assert.equal(host.lifecycle.length, 0);
  }
});

test("对象返回类型保持完整或省略，不将类型声明当成方法体", () => {
  const source = (name: string) => `class ${name} {
  make(): {
    value: string;
    aboutToDisappear(): void;
  } {
    return { value: '', aboutToDisappear() {} };
  }
  async makeAsync(): Promise<{
    value: string;
    aboutToAppear(): void;
  }> {
    return { value: '', aboutToAppear() {} };
  }
  work() {
    this.make();
    this.makeAsync();
  }
}`;
  const profile = analyzeCrossHostClone([
    input(
      "ShapesA.ets",
      source("ShapesA"),
      "this.make();",
      "this.makeAsync();",
    ),
    input(
      "ShapesB.ets",
      source("ShapesB"),
      "this.make();",
      "this.makeAsync();",
    ),
  ]);
  assert.ok(profile);
  for (const host of profile.hosts) {
    const plain = host.memberTypes.find((m) => m.name === "make");
    if (plain) {
      assert.equal(plain.type, "{ value: string; aboutToDisappear(): void; }");
      assert.equal(
        plain.signature,
        "make(): { value: string; aboutToDisappear(): void; }",
      );
    }
    const promised = host.memberTypes.find((m) => m.name === "makeAsync");
    if (promised) {
      assert.equal(
        promised.type,
        "Promise<{ value: string; aboutToAppear(): void; }>",
      );
      assert.equal(
        promised.signature,
        "async makeAsync(): Promise<{ value: string; aboutToAppear(): void; }>",
      );
    }
    assert.deepEqual(host.lifecycle, [], "对象类型的成员不是宿主生命周期方法");
  }
});

test("范围缺失、歧义、跨宿主或未解析输入保守回退", () => {
  const source = uiHost("One"),
    good = input("One.ets", source, "Text(this.title)");
  const peer = input("Two.ets", uiHost("Two"), "Text(this.title)");
  for (const bad of [
    { ...peer, resolved: false },
    { ...peer, startLine: null },
    { ...peer, endLine: 9999 },
    { ...peer, startLine: 20, endLine: 2 },
    {
      ...peer,
      source: "function work() { return 1; }",
      startLine: 1,
      endLine: 1,
    },
  ])
    assert.equal(analyzeCrossHostClone([good, bad]), null);
  const combined = source + "\n" + uiHost("Three");
  assert.equal(
    analyzeCrossHostClone([
      {
        ...good,
        source: combined,
        startLine: 1,
        endLine: combined.split("\n").length,
      },
      peer,
    ]),
    null,
  );
  assert.equal(analyzeCrossHostClone([good]), null);
});

test("超预算来源和实例组直接回退，不输出被截断后伪完整的画像", () => {
  const source = uiHost("One"),
    good = input("One.ets", source, "Text(this.title)");
  assert.equal(
    analyzeCrossHostClone([
      good,
      { ...good, filePath: "Huge.ets", source: source + " ".repeat(400_001) },
    ]),
    null,
  );
  assert.equal(
    analyzeCrossHostClone(
      Array.from({ length: 9 }, (_, i) => ({
        ...good,
        filePath: `Panel${i}.ets`,
      })),
    ),
    null,
  );
});

test("同文件同宿主的两个片段不生成跨宿主画像", () => {
  const source = `@Component
struct Panel {
  @State first: string = '';
  @State second: string = '';
  build() {
    Column() {
      Text(this.first)
      Text(this.second)
    }
  }
}`;
  assert.equal(
    analyzeCrossHostClone([
      input("Panel.ets", source, "Text(this.first)"),
      input("Panel.ets", source, "Text(this.second)"),
    ]),
    null,
  );
});

test("宿主身份使用规范路径，路径别名和 Windows 大小写不生成跨宿主画像", () => {
  const source = uiHost("Panel");
  const first = input("Panel.ets", source, "Text(this.title)");
  assert.equal(
    analyzeCrossHostClone([first, { ...first, filePath: "./Panel.ets" }]),
    null,
  );
  assert.equal(
    analyzeCrossHostClone([
      {
        ...first,
        filePath: "display/First.ets",
        identityPath: "C:\\project\\views\\Panel.ets",
      },
      {
        ...first,
        filePath: "display/Second.ets",
        identityPath: "c:/PROJECT/views/./panel.ets",
      },
    ]),
    null,
  );
});
