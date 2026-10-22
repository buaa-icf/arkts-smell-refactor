import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildTestPlan, isSdkTemplateTest } from "../src/test_plan.js";
import {
  resultEvidence,
  runTestPlan,
  testToolBlocker,
} from "../src/test_execution.js";
import { readJson, writeJson, writeText } from "../src/utils.js";
import { fixture, makeProject, suite, success } from "./helpers.js";
const sdkTemplate = (device = false) => `
import {describe, beforeAll, beforeEach, afterEach, afterAll, it, expect} from '@ohos/hypium';
${device ? "import { hilog } from '@kit.PerformanceAnalysisKit';" : ""}
export default function ${device ? "abilityTest" : "localUnitTest"}() {
  describe('${device ? "ActsAbilityTest" : "localUnitTest"}', () => {
    beforeAll(() => { /* no setup */ }); beforeEach(() => {});
    afterEach(() => {}); afterAll(() => {});
    it('assertContain', 0, () => {
      ${device ? "hilog.info(0x0000, 'testTag', '%{public}s', 'it begin');" : ""}
      let a = 'abc'; let b = 'b'; expect(a).assertContain(b); expect(a).assertEqual(a);
    });
  });
}`;
test("只识别完整 SDK 模板，业务修改、导入或同名套件不会被排除", (t) => {
  const dir = fixture(t),
    file = path.join(dir, "Ability.test.ets");
  for (const device of [false, true]) {
    writeText(file, sdkTemplate(device));
    assert.equal(isSdkTemplateTest(file), true);
  }
  for (const text of [
    sdkTemplate().replace("let a = 'abc'", "let a = Model.value"),
    "import { Model } from '../main/Model';\n" + sdkTemplate(),
    sdkTemplate().replace("/* no setup */", "initializeBusiness();"),
    "export default function f(){describe('ActsAbilityTest',()=>{it('business',0,()=>{verify();});});}",
  ]) {
    writeText(file, text);
    assert.equal(isSdkTemplateTest(file), false);
  }
});
test("跨模块只有 SDK 模板时不启动无关设备测试，保留覆盖缺口记录", (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "local");
  writeText(
    suite(p.source, "local", "LocalUnit", "products/phone"),
    sdkTemplate(),
  );
  writeText(
    suite(p.source, "instrument", "Ability", "products/phone"),
    sdkTemplate(true),
  );
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: ["products/phone/src/main/ets/Helper.ets"],
  });
  const plan = buildTestPlan(p.taskDir, p.source);
  assert.deepEqual(
    plan.jobs.map((j: any) => [j.module, j.scope]),
    [["featureName", "PageTest"]],
  );
  assert.equal(plan.excludedTests.length, 2);
  assert.deepEqual(plan.additionalModulesWithoutBusinessTests, ["host"]);
});
test("新增模块优先匹配 Helper 的测试，不扩大到该模块其他 suite", (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "local");
  suite(p.source, "local", "Helper", "products/phone");
  suite(p.source, "instrument", "Other", "products/phone");
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: ["products/phone/src/main/ets/Helper.ets"],
  });
  const plan = buildTestPlan(p.taskDir, p.source);
  assert.deepEqual(
    plan.jobs
      .filter((j: any) => j.module === "host")
      .map((j: any) => [j.kind, j.scope]),
    [["local", "HelperTest"]],
  );
});
test("原目标只有模板测试不能算通过；显式设备测试仍运行模板", (t) => {
  const p = makeProject(fixture(t));
  writeText(suite(p.source, "instrument", "Ability"), sdkTemplate(true));
  assert.throws(() => buildTestPlan(p.taskDir, p.source), /No runnable test/);
  assert.equal(
    buildTestPlan(p.taskDir, p.source, "onDeviceTest", "featureName").jobs[0]
      .kind,
    "instrument",
  );
});
for (const [label, output, expected] of [
  [
    "ABI",
    "error: install parse native so failed.\nIn the module named common_test, the Abi type supported by the device does not match the Abi type configured in the C++ project.",
    "BLOCKED",
  ],
  ["ABI Android-style", "INSTALL_FAILED_NO_MATCHING_ABIS", "BLOCKED"],
  ["业务测试失败", "assertion failed: expected 100 but got 0", "FAIL"],
  [
    "未知安装失败",
    "failed to install bundle: malformed application metadata",
    "FAIL",
  ],
] as const)
  test(`测试退出归因：${label}`, async (t) => {
    const p = makeProject(fixture(t));
    suite(p.source, "instrument");
    const plan = buildTestPlan(p.taskDir, p.source),
      script = path.join(p.source, "failed-hvigor.cjs");
    writeText(
      script,
      `console.error(${JSON.stringify(output)});process.exit(1);`,
    );
    assert.equal(
      await runTestPlan(p.taskDir, p.source, plan, [process.execPath, script]),
      expected === "BLOCKED" ? 3 : 1,
    );
    const results = readJson(path.join(p.taskDir, "test-results.json"));
    assert.equal(results.status, expected);
    if (expected === "BLOCKED")
      assert.equal(results.jobs[0].classification, "DEVICE_ABI_MISMATCH");
  });
test("真实 ABI 日志可识别；正常编译警告不被误判环境阻塞", () => {
  assert.equal(
    testToolBlocker(
      "The Abi type supported by the device does not match the Abi type configured in the C++ project.",
    )?.classification,
    "DEVICE_ABI_MISMATCH",
  );
  assert.equal(
    testToolBlocker("WARN: target ABI arm64-v8a; BUILD SUCCESSFUL"),
    null,
  );
});
test("真实断言失败不能被日志中 ABI 字样掩盖", async (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "local");
  const artifacts = path.join(
    p.source,
    "feature/.test/default/intermediates/test/coverage_data",
  );
  const failed = success()
    .replace(
      "result=Success",
      "assertion failure: INSTALL_FAILED_NO_MATCHING_ABIS\nresult=Failure",
    )
    .replace("Failure: 0", "Failure: 1")
    .replace("Pass: 1", "Pass: 0");
  const script = path.join(p.source, "assertion.cjs");
  writeText(
    script,
    `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(artifacts)},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(artifacts, "test_result.txt"))},${JSON.stringify(failed)});console.error('INSTALL_FAILED_NO_MATCHING_ABIS');process.exit(1);`,
  );
  assert.equal(
    await runTestPlan(p.taskDir, p.source, buildTestPlan(p.taskDir, p.source), [
      process.execPath,
      script,
    ]),
    1,
  );
  assert.equal(
    readJson(path.join(p.taskDir, "test-results.json")).status,
    "FAIL",
  );
});
test("目标 UI suite 优先于无关 Local 占位测试", (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "local", "LocalUnit");
  suite(p.source, "instrument");
  const jobs = buildTestPlan(p.taskDir, p.source).jobs;
  assert.deepEqual(
    jobs.map((j: any) => [j.kind, j.module, j.scope]),
    [["instrument", "featureName", "PageTest"]],
  );
});
test("目标同时有 Local 和 Instrument 时两种都执行", (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "local");
  suite(p.source, "instrument");
  assert.deepEqual(
    buildTestPlan(p.taskDir, p.source).jobs.map((j: any) => j.kind),
    ["local", "instrument"],
  );
});
test("跟踪 List 注册别名和重导出，剔除未注册用例", (t) => {
  const p = makeProject(fixture(t));
  const file = suite(p.source, "local", "Page", "feature", false),
    dir = path.dirname(file);
  suite(p.source, "local", "Dormant", "feature", false);
  writeText(
    path.join(dir, "List.test.ets"),
    "import {run as execute} from './register'; execute();",
  );
  writeText(
    path.join(dir, "register.ets"),
    "export {default as run} from './nested';",
  );
  writeText(
    path.join(dir, "nested.ets"),
    "import r from './Page.test.ets'; export default function f() {r();}",
  );
  assert.deepEqual(buildTestPlan(p.taskDir, p.source).jobs[0].expectedSuites, [
    "PageTest",
  ]);
});
test("注释、字符串、type import 不会注册假测试", (t) => {
  const p = makeProject(fixture(t)),
    local = suite(p.source, "local", "LocalUnit");
  suite(p.source, "local", "Page", "feature", false);
  suite(p.source, "instrument");
  const entry = path.join(path.dirname(local), "List.test.ets");
  fs.appendFileSync(
    entry,
    "\n// import run from './Page.test';\nconst hint = `import run from './Page.test';`;\nimport type { Page } from './Page.test';\n",
  );
  assert.deepEqual(
    buildTestPlan(p.taskDir, p.source).jobs.map((j: any) => j.kind),
    ["instrument"],
  );
});
test("跨模块测试宿主可被找到", (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "local", "LocalUnit");
  suite(p.source, "instrument", "Page", "products/phone");
  const jobs = buildTestPlan(p.taskDir, p.source).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].module, "host");
});
test("不能精准匹配时保守执行整个模块两种测试", (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "local", "Behavior");
  suite(p.source, "instrument", "UIBehavior");
  const jobs = buildTestPlan(p.taskDir, p.source).jobs;
  assert.equal(jobs.length, 2);
  assert(jobs.every((j: any) => j.scope === null));
});
test("新增其他模块需要验证，不隐藏原目标测试", (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "instrument");
  suite(p.source, "local", "Other", "products/phone");
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: ["products/phone/src/main/ets/Helper.ets"],
  });
  const jobs = buildTestPlan(p.taskDir, p.source).jobs;
  assert(jobs.some((j: any) => j.scope === "PageTest"));
  assert(jobs.some((j: any) => j.module === "host" && j.scope === null));
});
test("同模块新增 Helper 不会放大为无关测试", (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "instrument");
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: ["feature/src/main/ets/Helper.ets"],
  });
  assert.equal(buildTestPlan(p.taskDir, p.source).jobs[0].scope, "PageTest");
});
test("测试类型来自真实工程，数据集 testKind 不会跳过设备测试", (t) => {
  const p = makeProject(fixture(t));
  const task = readJson(path.join(p.taskDir, "task.json"));
  task.raw.testKind = "local-test";
  writeJson(path.join(p.taskDir, "task.json"), task);
  suite(p.source, "instrument");
  assert.equal(buildTestPlan(p.taskDir, p.source).jobs[0].kind, "instrument");
});
test("没有测试或跨工程关联目标必须阻塞", (t) => {
  const p = makeProject(fixture(t));
  assert.throws(() => buildTestPlan(p.taskDir, p.source), /No runnable test/);
  suite(p.source, "instrument");
  const raw = readJson(path.join(p.taskDir, "task.json"));
  raw.target.related_targets = [
    { filePath: "external/src/main/ets/Other.ets" },
  ];
  writeJson(path.join(p.taskDir, "task.json"), raw);
  assert.throws(() => buildTestPlan(p.taskDir, p.source), /No module owns/);
});
test("动态注册或缺失引用时不静默丢弃 Local 类型", (t) => {
  const p = makeProject(fixture(t)),
    file = suite(p.source, "local", "Page", "feature", false);
  writeText(
    path.join(path.dirname(file), "List.test.ets"),
    "import(suitePath);",
  );
  suite(p.source, "instrument");
  assert.deepEqual(
    buildTestPlan(p.taskDir, p.source).jobs.map((j: any) => j.kind),
    ["local", "instrument"],
  );
});
test("JSON5 模块配置拒绝越界，支持目录和模块名称不同", (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "local");
  assert.equal(
    buildTestPlan(p.taskDir, p.source).jobs[0].module,
    "featureName",
  );
  writeText(
    path.join(p.source, "build-profile.json5"),
    "{modules:[{name:'escape',srcPath:'../outside'}]}",
  );
  assert.throws(() => buildTestPlan(p.taskDir, p.source), /External/);
});
for (const [name, text, expected] of [
  ["空报告", "", "BLOCKED"],
  ["只打印成功无用例", "BUILD SUCCESSFUL", "BLOCKED"],
  ["零个用例", "Tests run: 0, Failure: 0, Error: 0, Pass: 0", "BLOCKED"],
  ["真实成功", success(), "PASS"],
  ["跳过不等于通过", success().replace("Success", "Ignored"), "BLOCKED"],
  [
    "断言失败",
    success()
      .replace("result=Success", "assertion failed\nresult=Failure")
      .replace("Failure: 0", "Failure: 1")
      .replace("Pass: 1", "Pass: 0"),
    "FAIL",
  ],
  [
    "beforeAll 宿主未找到",
    success()
      .replace(
        "result=Success",
        "Unable to find id: host, error in beforeAll function\nresult=Error",
      )
      .replace("Error: 0", "Error: 1")
      .replace("Pass: 1", "Pass: 0"),
    "BLOCKED",
  ],
  ["未完成", success().replace("Tests run: 1", "Tests run: 2"), "BLOCKED"],
] as const)
  test(`Hypium 真实执行证据：${name}`, (t) => {
    const file = path.join(fixture(t), "result.txt");
    writeText(file, text);
    assert.equal(resultEvidence(file, ["PageTest"]).status, expected);
  });
test("期望的 suite 未执行不能 PASS", (t) => {
  const file = path.join(fixture(t), "result.txt");
  writeText(file, success("OtherTest"));
  assert.equal(resultEvidence(file, ["PageTest"]).status, "BLOCKED");
});
test("旧报告会被清除：Hvigor exit 0 但无本轮报告仍 BLOCKED", async (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "instrument");
  const plan = buildTestPlan(p.taskDir, p.source),
    artifacts = path.join(
      p.source,
      "feature/.test/default/intermediates/ohosTest/coverage_data",
    );
  writeText(path.join(artifacts, "test_result.txt"), success());
  writeText(
    path.join(artifacts, "coverage.log"),
    "OHOS_REPORT_RESULT:\nTestFinished-ResultCode: 0",
  );
  const code = await runTestPlan(p.taskDir, p.source, plan, [
    process.execPath,
    "-e",
    "process.exit(0)",
    "--",
  ]);
  assert.equal(code, 3);
  assert.equal(
    readJson(path.join(p.taskDir, "test-results.json")).status,
    "BLOCKED",
  );
});
for (const deviceMarker of [false, true])
  test(`Instrument 必须包含本轮设备完成标记：${deviceMarker}`, async (t) => {
    const p = makeProject(fixture(t));
    suite(p.source, "instrument");
    const plan = buildTestPlan(p.taskDir, p.source),
      artifacts = path.join(
        p.source,
        "feature/.test/default/intermediates/ohosTest/coverage_data",
      ),
      script = path.join(p.source, "fake-hvigor.cjs");
    writeText(
      script,
      `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(artifacts)}, {recursive:true});fs.writeFileSync(${JSON.stringify(path.join(artifacts, "test_result.txt"))},${JSON.stringify(success())});${deviceMarker ? `fs.writeFileSync(${JSON.stringify(path.join(artifacts, "coverage.log"))},'OHOS_REPORT_RESULT: done\\nTestFinished-ResultCode: 0');` : ""}`,
    );
    assert.equal(
      await runTestPlan(p.taskDir, p.source, plan, [process.execPath, script]),
      deviceMarker ? 0 : 3,
    );
  });
test("Local Test 要求新报告，证据存入本轮独立目录", async (t) => {
  const p = makeProject(fixture(t));
  suite(p.source, "local");
  const plan = buildTestPlan(p.taskDir, p.source),
    artifacts = path.join(
      p.source,
      "feature/.test/default/intermediates/test/coverage_data",
    ),
    script = path.join(p.source, "fake.cjs");
  writeText(
    script,
    `const fs=require('node:fs'); fs.mkdirSync(${JSON.stringify(artifacts)},{recursive:true}); fs.writeFileSync(${JSON.stringify(path.join(artifacts, "test_result.txt"))},${JSON.stringify(success())});`,
  );
  assert.equal(
    await runTestPlan(p.taskDir, p.source, plan, [process.execPath, script]),
    0,
  );
  const results = readJson(path.join(p.taskDir, "test-results.json"));
  assert(
    results.jobs[0].artifacts["test_result.txt"].includes("test-attempts"),
  );
  assert.equal(results.status, "PASS");
});
