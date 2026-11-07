import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { builderStateRisks } from "../src/analysis/builder_state.js";
import { collectReactiveEvidence } from "../src/reactive_evidence.js";
import { buildFailureReport } from "../src/runner.js";
import { buildRepairPrompt } from "../src/prompts.js";
import { taskFromJson } from "../src/models.js";
import { readJson, writeJson, writeText } from "../src/utils.js";
import { fixture, setupTask } from "./helpers.js";

const before = `@ComponentV2
struct Page {
  @Local city: string = '';
  @Builder Booking() { Text(this.city).fontColor(this.city ? Color.Black : Color.Gray); }
  build() { this.Booking(); }
}`;
const after = `@ComponentV2
struct Page {
  @Local city: string = '';
  @Builder Value(label: string, value: string, onTap: () => void) { Text(value); }
  @Builder Booking() { this.Value('label, with comma', this.city, () => {}); }
  build() { this.Booking(); }
}`;
test("记录原响应式字段读取、Builder 普通参数与当前调用位置", () => {
  const issues = builderStateRisks(before, after);
  assert.equal(issues.length, 1);
  assert.deepEqual(
    [issues[0].field, issues[0].builder, issues[0].parameter],
    ["city", "Value", "value"],
  );
  assert.deepEqual(issues[0].baselineReadLines, [4]);
  assert.equal(issues[0].callLine, 5);
  assert.equal(issues[0].parameterReadLine, 4);
  assert.equal(
    builderStateRisks(after, after + "\n// unrelated edit").length,
    0,
  );
});
test("保留宿主实时读取、getter 回调、引用参数、普通字段和其他宿主不误报", () => {
  const branch = after
    .replace("value: string", "isCity: boolean")
    .replace("Text(value)", "Text(isCity ? this.city : this.city)")
    .replace("this.city, ()", "true, ()");
  const getter = after
    .replace("value: string", "value: () => string")
    .replace("Text(value)", "Text(value())")
    .replace("this.city, ()", "() => this.city, ()");
  const reference = after
    .replace("value: string", "$$: CityData")
    .replace("Text(value)", "Text($$.value)")
    .replace("this.city, ()", "{ value: this.city }, ()");
  for (const source of [
    branch,
    getter,
    reference,
    after.replace("@Local city", "city"),
    after.replace("struct Page", "struct Other"),
  ])
    assert.deepEqual(builderStateRisks(before, source), []);
  assert.deepEqual(
    builderStateRisks(before.replace("@Local city", "city"), after),
    [],
  );
  assert.deepEqual(
    builderStateRisks(
      before.replace(
        "Text(this.city).fontColor(this.city ? Color.Black : Color.Gray)",
        'Text("this.city")',
      ),
      after,
    ),
    [],
  );
});
test("证据按当前快照重新计算，修复后不残留上一轮风险", (t) => {
  const dir = fixture(t),
    file = "feature/src/main/ets/Page.ets";
  writeText(path.join(dir, "baseline-production", file), before);
  writeText(path.join(dir, "current-production", file), after);
  const first = collectReactiveEvidence(dir, [file]);
  assert.equal(first.issues.length, 1);
  assert.match(first.issues[0].baselineSha256, /^[0-9a-f]{64}$/i);
  writeText(path.join(dir, "current-production", file), before);
  assert.equal(collectReactiveEvidence(dir, [file]).issues.length, 0);
  assert.equal(
    collectReactiveEvidence(dir, ["../../outside.ets"]).issues.length,
    0,
  );
});

test("相关测试失败的返修提示携带前后读取位置，测试源码仍不可见", (t) => {
  const dir = setupTask(fixture(t)),
    file = "entry/src/main/ets/Page.ets",
    attempt = path.join(dir, "test-attempts/current");
  const report = path.join(attempt, "test_result.txt");
  writeText(path.join(dir, "baseline-production", file), before);
  writeText(path.join(dir, "current-production", file), after);
  writeJson(path.join(dir, "refactor-changes.json"), {
    changedProductionFiles: [file],
  });
  writeText(
    report,
    "class=PageTest\ntest=refresh city\nexpect true, actual false\nresult=Failure\n",
  );
  writeJson(path.join(dir, "test-results.json"), {
    plan: path.join(attempt, "plan.json"),
    jobs: [
      {
        status: "FAIL",
        selectionReason: "target-named-suite",
        expectedSuites: ["PageTest"],
        artifacts: { "test_result.txt": report },
      },
    ],
  });
  const task = taskFromJson(readJson(path.join(dir, "task.json")));
  const failure = buildFailureReport(
    dir,
    task,
    { name: "test", status: "FAIL", duration_seconds: 0 },
    1,
  );
  assert.equal(failure.repairable, true);
  assert.equal(failure.issues.length, 1);
  const prompt = buildRepairPrompt(task, {}, failure, 1, "skip");
  assert.match(prompt, /this.city/);
  assert.match(prompt, /普通 string 形参 value/);
  assert.match(prompt, /UI 内 L4/);
  assert.match(prompt, /refresh city/);
  assert.match(prompt, /风险线索，非独立失败结论/);
});
