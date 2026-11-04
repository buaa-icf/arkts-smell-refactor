import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { freezeTestPlan, buildTestPlan } from "../src/test_plan.js";
import { productionUiIds, uiTestCases } from "../src/test_ui.js";
import { buildFailureReport, executePipeline } from "../src/runner.js";
import { taskFromJson } from "../src/models.js";
import { readJson, writeJson, writeText } from "../src/utils.js";
import { fixture, goodConfig, makeProject, spec } from "./helpers.js";

const original = `@ComponentV2
export struct Page {
  @Local departure: string = '';
  @Local destination: string = '';
  @Builder Booking() {
    Text(this.departure).id('departure_value');
    Text(this.destination).id('destination_value');
  }
  build() { this.Booking(); }
}`;
const updated = `@ComponentV2
export struct Page {
  @Local departure: string = '';
  @Local destination: string = '';
  @Builder Value(label: string, value: string, onTap: () => void) { Text(value); }
  @Builder Booking() {
    this.Value('departure', this.departure, () => {});
    this.Value('destination', this.destination, () => {});
  }
  build() { this.Booking(); }
}`;
const tests = `import { Driver, ON, Component } from '@kit.TestKit';
async function waitById(driver: Driver, id: string): Promise<Component> {
  const component = await driver.waitForComponent(ON.id(id), 10000);
  if (!component) { throw new Error('missing'); }
  return component;
}
describe('FlightBookingTest', () => {
  beforeEach(async () => { await waitById(driver, 'departure_value'); });
  it('swap cities', 0, async () => {
    const a = await (await waitById(driver, 'departure_value')).getText();
    const b = await (await waitById(driver, 'destination_value')).getText();
    expect(a).assertEqual(b);
  });
  it('clear city', 0, async () => { await driver.waitForComponent(ON.id('departure_value')); });
  it('unrelated', 0, () => { expect('departure_value').assertEqual('text'); });
});`;

function setup(t: Parameters<typeof fixture>[0]) {
  const p = makeProject(fixture(t)),
    file = path.join(
      p.source,
      "feature/src/ohosTest/ets/test/FlightBooking.test.ets",
    );
  const task = readJson(path.join(p.taskDir, "task.json"));
  task.target.symbol = null;
  task.smell_type = "code-clone";
  writeJson(path.join(p.taskDir, "task.json"), task);
  writeText(p.target, original);
  writeText(file, tests);
  writeText(
    path.join(path.dirname(file), "List.test.ets"),
    "import run from './FlightBooking.test'; run();",
  );
  const relative = "feature/src/main/ets/Page.ets";
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: [relative],
  });
  writeText(path.join(p.taskDir, "baseline-production", relative), original);
  writeText(path.join(p.taskDir, "current-production", relative), updated);
  return { ...p, file, relative };
}
function fail(
  p: ReturnType<typeof setup>,
  names = ["swap cities", "clear city"],
) {
  const plan = buildTestPlan(p.taskDir, p.source),
    job = plan.jobs[0];
  const attempt = path.join(p.taskDir, "test-attempts/current"),
    report = path.join(attempt, "test_result.txt");
  writeText(
    report,
    names
      .map(
        (name) =>
          `class=FlightBookingTest\ntest=${name}\nexpect true, actualValue false\nresult=Failure\n`,
      )
      .join(""),
  );
  writeJson(path.join(p.taskDir, "test-results.json"), {
    plan: path.join(attempt, "plan.json"),
    jobs: [
      {
        ...job,
        status: "FAIL",
        selectionReason: job.reason,
        artifacts: { "test_result.txt": report },
      },
    ],
  });
  return buildFailureReport(
    p.taskDir,
    taskFromJson(readJson(path.join(p.taskDir, "task.json"))),
    { name: "test", status: "FAIL", duration_seconds: 0 },
    1,
  );
}

test("冻结 UI ID 关联使非同名模块兜底用例进入返修", (t) => {
  const p = setup(t);
  freezeTestPlan(p.taskDir, p.source);
  assert.equal(
    buildTestPlan(p.taskDir, p.source).jobs[0].reason,
    "module-fallback-all-available-kinds",
  );
  // Production may change after freezing; test identity must not.
  writeText(p.target, updated);
  const report = fail(p);
  assert.equal(report.classification, "RELATED_TEST_FAILURE");
  assert.equal(report.repairable, true);
  assert.deepEqual(
    report.testAttribution.map((e: any) => e.caseName),
    ["swap cities", "clear city"],
  );
});

test("同一套件无关断言不能借用其他用例或 beforeEach 的 ID 进入返修", (t) => {
  const p = setup(t);
  freezeTestPlan(p.taskDir, p.source);
  const report = fail(p, ["swap cities", "unrelated"]);
  assert.equal(report.repairable, false);
  assert.equal(report.classification, "UNATTRIBUTED_TEST_FAILURE");
  assert.equal(report.issues.length, 0);
});

test("重复组件 ID 和重复用例名不建立关联", (t) => {
  const p = setup(t);
  writeText(
    path.join(p.source, "feature/src/main/ets/Other.ets"),
    "Text('other').id('departure_value');",
  );
  writeText(
    p.file,
    tests +
      "\ndescribe('FlightBookingTest', () => { it('swap cities', 0, () => {}); });",
  );
  freezeTestPlan(p.taskDir, p.source);
  assert.equal(
    readJson(path.join(p.taskDir, "baseline-test-plan.json")).uiCaseEvidence
      .length,
    0,
  );
  assert.equal(fail(p).repairable, false);
});

test("跨模块复用 ID 也不能归因到目标组件", (t) => {
  const p = setup(t);
  writeText(
    path.join(p.source, "products/phone/src/main/ets/Other.ets"),
    "Text('other').id('departure_value');",
  );
  freezeTestPlan(p.taskDir, p.source);
  assert.equal(fail(p, ["clear city"]).repairable, false);
  assert.equal(fail(p, ["swap cities"]).repairable, true); // Still has a unique destination selector.
});

test("不存在冻结证据、任务变化或测试哈希变化时不能使用 UI 关联", (t) => {
  const p = setup(t);
  assert.equal(fail(p).repairable, false);
  freezeTestPlan(p.taskDir, p.source);
  const manifest = path.join(p.taskDir, "test-results.json");
  fail(p);
  writeText(p.file, tests + "\n// changed after freeze");
  const check = () =>
    buildFailureReport(
      p.taskDir,
      taskFromJson(readJson(path.join(p.taskDir, "task.json"))),
      { name: "test", status: "FAIL", duration_seconds: 0 },
      1,
    );
  assert.equal(check().repairable, false);
  writeText(p.file, tests);
  const data = readJson(path.join(p.taskDir, "task.json"));
  data.message = "changed task";
  writeJson(path.join(p.taskDir, "task.json"), data);
  assert.equal(check().repairable, false);
  assert(readJson(manifest).jobs.length);
});

test("UI 选择器识别排除注释、字符串、动态 ID、伪 helper 和重绑定参数", () => {
  assert.deepEqual(
    productionUiIds(
      "// Text('').id('fake');\nText('').id('real'); const text = `.id('fake')`;",
    ),
    [{ id: "real", line: 2 }],
  );
  const cases = uiTestCases(tests);
  assert.deepEqual(
    cases.map((c) => [c.caseName, c.selectors.map((s: any) => s.id)]),
    [
      ["swap cities", ["departure_value", "destination_value"]],
      ["clear city", ["departure_value"]],
      ["unrelated", []],
    ],
  );
  for (const source of [
    tests.replace("ON.id(id)", "ON.text(id)"),
    tests.replace("const component =", "id = 'elsewhere'; const component ="),
    tests.replace("from '@kit.TestKit'", "from './FakeKit'"),
    tests.replace("ON.id(id)", "ON.id(id + suffix)"),
  ]) {
    assert.equal(uiTestCases(source)[0].selectors.length, 0);
  }
  const shadowed = tests.replace(
    "describe('FlightBookingTest', () => {",
    "describe('FlightBookingTest', () => { const ON = fake;",
  );
  assert(uiTestCases(shadowed).every((c) => c.selectors.length === 0));
  const unused = tests.replace(
    "await driver.waitForComponent(ON.id('departure_value'))",
    "const unused = ON.id('departure_value')",
  );
  assert.equal(uiTestCases(unused)[1].selectors.length, 0);
  const nested = tests.replace(
    "await driver.waitForComponent(ON.id('departure_value'))",
    "const unused = () => driver.waitForComponent(ON.id('departure_value'))",
  );
  assert.equal(uiTestCases(nested)[1].selectors.length, 0);
});

test("原 UI 关联的测试失败实际调度一次返修，而非仅修改报告标志", async (t) => {
  const p = setup(t);
  freezeTestPlan(p.taskDir, p.source);
  fail(p);
  const config = goodConfig();
  config.gates = { test: spec("process.exit(1)") };
  config.maxRepairAttempts = 1;
  const marker = path.join(p.taskDir, "repaired.txt");
  config.repairAgent = spec(
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'repaired')`,
  );
  const result = await executePipeline(p.taskDir, config);
  assert.equal(result.repairAttempts, 1);
  assert.equal(result.verdict, "FAIL"); // Stubbed test still fails; evidence never creates a PASS.
  assert(
    result.steps.some(
      (s: any) => s.name === "repair-agent-1" && s.status === "PASS",
    ),
  );
});
