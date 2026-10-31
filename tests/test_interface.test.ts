import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildTestPlan, freezeTestPlan } from "../src/test_plan.js";
import { sourceInterface } from "../src/test_interface.js";
import { readJson, readText, writeJson, writeText } from "../src/utils.js";
import { fixture, makeProject } from "./helpers.js";

const source = `export class Page {
  work(): number { return 1; }
  other(): number { return 2; }
}`;
function setup(t: Parameters<typeof fixture>[0]) {
  const p = makeProject(fixture(t));
  writeText(p.target, source);
  return p;
}
function local(root: string, name: string, code: string) {
  const file = path.join(root, "feature/src/test", name + ".test.ets");
  writeText(file, code);
  return file;
}
const coins = `import { Page as Screen } from '../main/ets/Page';
export default function testPage() {
  describe('Coins', () => {
    let page: Screen;
    beforeEach(() => { page = new Screen(); });
    it('work', 0, () => { page.work(); });
  });
}`;

test("同名 Local/UI 套件按原接口选择，不因页面文件名强制设备测试", (t) => {
  const p = setup(t);
  local(p.source, "Page", coins);
  writeText(
    path.join(p.source, "feature/src/ohosTest/ets/test/Page.test.ets"),
    `describe('Coins', () => {it('build_controls', 0, () => {driver.click();});});`,
  );
  const plan = buildTestPlan(p.taskDir, p.source);
  assert.deepEqual(
    plan.jobs.map((j: any) => [j.kind, j.scope]),
    [["local", "Coins"]],
  );
  assert.equal(plan.jobs[0].reason, "original-interface-call");
  assert.equal(plan.selectionEvidence[0].target.owner, "Page");
  assert.equal(plan.selectionEvidence[0].target.method, "work");
  assert(
    plan.excludedTests.some(
      (e: any) =>
        e.kind === "instrument" &&
        e.reason === "no-proven-original-interface-link",
    ),
  );
});

test("同一生产文件的两份 Local Test 按方法区分，测试文件不必同名", (t) => {
  const p = setup(t);
  local(p.source, "BalanceCases", coins);
  local(
    p.source,
    "PriceCases",
    coins
      .replaceAll("Coins", "Price")
      .replaceAll("page.work()", "page.other()"),
  );
  const jobs = buildTestPlan(p.taskDir, p.source).jobs;
  assert.deepEqual(
    jobs.map((j: any) => j.scope),
    ["Coins"],
  );
  assert(jobs[0].testFiles[0].endsWith("BalanceCases.test.ets"));
});

test("一个测试文件的两个 suite 可区分；同一 suite 内仍完整运行", (t) => {
  const p = setup(t);
  local(
    p.source,
    "Cases",
    coins +
      `
describe('Price', () => { const other = new Screen(); it('other', 0, () => {other.other();}); });`,
  );
  assert.deepEqual(
    buildTestPlan(p.taskDir, p.source).jobs.map((j: any) => j.scope),
    ["Coins"],
  );
});

test("不同类型的同名方法、注释和字符串不能伪造接口关联", (t) => {
  const p = setup(t);
  writeText(
    path.join(p.source, "feature/src/main/ets/Other.ets"),
    "export class Other { work() {} }",
  );
  local(p.source, "Valid", coins);
  local(
    p.source,
    "Wrong",
    `import { Other } from '../main/ets/Other';
describe('Wrong', () => { const page = new Other(); it('page.work()', 0, () => { page.work(); /* Screen.work() */ }); });`,
  );
  assert.deepEqual(
    buildTestPlan(p.taskDir, p.source).jobs.map((j: any) => j.scope),
    ["Coins"],
  );
});

test("测试通过导入别名、重导出和辅助函数调用原接口也能关联", (t) => {
  const p = setup(t);
  writeText(
    path.join(p.source, "feature/src/main/ets/Facade.ets"),
    "export { Page as Screen } from './Page';",
  );
  writeText(
    path.join(p.source, "feature/src/test/helper.ets"),
    `import { Screen } from '../main/ets/Facade';
export function exercise() {const value = new Screen(); value.work();}`,
  );
  local(
    p.source,
    "Indirect",
    `import { exercise as invoke } from './helper'; describe('Indirect', () => { it('work', 0, () => { invoke(); }); });`,
  );
  const plan = buildTestPlan(p.taskDir, p.source);
  assert.equal(plan.jobs[0].scope, "Indirect");
  assert.equal(plan.selectionEvidence[0].evidence, "imported-helper-call");
});

test("同文件局部辅助函数可追踪；没有被调用的辅助函数不误选其他 suite", (t) => {
  const p = setup(t);
  local(
    p.source,
    "Helpers",
    `import { Page } from '../main/ets/Page';
function helper() {const p = new Page(); p.work();}
describe('Selected', () => {it('work', 0, () => {helper();});});
describe('Other', () => {it('noop', 0, () => {expect(1).assertEqual(1);});});`,
  );
  assert.deepEqual(
    buildTestPlan(p.taskDir, p.source).jobs.map((j: any) => j.scope),
    ["Selected"],
  );
});

test("同一个导入辅助文件的不同导出函数不能混用关联", (t) => {
  const p = setup(t);
  writeText(
    path.join(p.source, "feature/src/test/helper.ets"),
    `import { Page } from '../main/ets/Page';
export function coins() {const p = new Page(); p.work();}
export function price() {const p = new Page(); p.other();}`,
  );
  local(
    p.source,
    "CoinCases",
    `import {coins} from './helper'; describe('CoinCases', () => {it('coins', 0, () => {coins();});});`,
  );
  local(
    p.source,
    "PriceCases",
    `import {price} from './helper'; describe('PriceCases', () => {it('price', 0, () => {price();});});`,
  );
  assert.deepEqual(
    buildTestPlan(p.taskDir, p.source).jobs.map((j: any) => j.scope),
    ["CoinCases"],
  );
});

test("重构前冻结接口测试；修改后改名不重新猜测，同时补充新增跨模块测试", (t) => {
  const p = setup(t);
  local(p.source, "Original", coins);
  freezeTestPlan(p.taskDir, p.source);
  assert.equal(
    readJson(path.join(p.taskDir, "baseline-test-plan.json")).plan.jobs[0]
      .scope,
    "Coins",
  );
  writeText(p.target, source.replaceAll("work", "renamed"));
  writeText(
    path.join(p.source, "products/phone/src/test/Helper.test.ets"),
    "describe('HelperTest', () => {it('helper', 0, () => {});});",
  );
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: ["products/phone/src/main/ets/Helper.ets"],
  });
  const plan = buildTestPlan(p.taskDir, p.source);
  assert.equal(plan.selectionBasis, "frozen-before-refactor");
  assert(
    plan.jobs.some((j: any) => j.scope === "Coins" && j.frozenBeforeRefactor),
  );
  assert(plan.jobs.some((j: any) => j.scope === "HelperTest"));
  assert.equal(plan.selectionEvidence[0].target.method, "work");
});

test("冻结后测试内容或任务变化必须阻塞，不能借用旧计划", (t) => {
  const p = setup(t),
    file = local(p.source, "Original", coins);
  freezeTestPlan(p.taskDir, p.source);
  writeText(file, coins + "\n// changed test\n");
  assert.throws(() => buildTestPlan(p.taskDir, p.source), /TEST_PLAN_STALE/);
});

test("冻结后测试辅助函数变化也会阻塞，生产实现的正常修改不会", (t) => {
  const p = setup(t),
    helper = path.join(p.source, "feature/src/test/helper.ets");
  writeText(
    helper,
    `import {Page} from '../main/ets/Page'; export function run(){const p = new Page();p.work();}`,
  );
  local(
    p.source,
    "Indirect",
    `import {run} from './helper';describe('Indirect',()=>{it('work',0,()=>{run();});});`,
  );
  freezeTestPlan(p.taskDir, p.source);
  writeText(p.target, source.replace("return 1", "return 3"));
  assert.equal(buildTestPlan(p.taskDir, p.source).jobs[0].scope, "Indirect");
  writeText(helper, "export function run() {}");
  assert.throws(() => buildTestPlan(p.taskDir, p.source), /TEST_PLAN_STALE/);
});

test("同模块同类型 suite 重名时如实记录实际运行范围，不假装能只选一个文件", (t) => {
  const p = setup(t);
  local(p.source, "Coins", coins);
  local(p.source, "Other", `describe('Coins',()=>{it('other',0,()=>{});});`);
  const plan = buildTestPlan(p.taskDir, p.source);
  assert.equal(plan.jobs[0].testFiles.length, 2);
  assert(
    plan.selectionWarnings.some((w: any) =>
      w.reason.startsWith("suite-name-collision"),
    ),
  );
});

test("没有明确接口匹配时保留设备测试；两个类型都确实测该接口时两者都跑", (t) => {
  const p = setup(t);
  writeText(
    path.join(p.source, "feature/src/ohosTest/ets/test/Page.test.ets"),
    `describe('UI', () => {it('render', 0, () => {});});`,
  );
  assert.equal(buildTestPlan(p.taskDir, p.source).jobs[0].kind, "instrument");
  local(p.source, "Page", coins);
  writeText(
    path.join(p.source, "feature/src/ohosTest/ets/test/Page.test.ets"),
    coins.replace("../main/ets/Page", "../../../main/ets/Page"),
  );
  assert.deepEqual(
    buildTestPlan(p.taskDir, p.source)
      .jobs.map((j: any) => j.kind)
      .sort(),
    ["instrument", "local"],
  );
});

test("同文件同名方法用所属类型和重构前行号区分", (t) => {
  const p = setup(t);
  writeText(
    p.target,
    `export class First { work() {} }\nexport class Second { work() {} }`,
  );
  const identity = sourceInterface(p.target, "work", 2);
  assert.equal(identity?.owner, "Second");
  assert.equal(sourceInterface(p.target, "First.work", 1)?.owner, "First");
});
