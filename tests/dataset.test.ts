import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  loadDatasetTasks,
  normalizeInput,
  relatedTargets,
} from "../src/dataset.js";
import { autoConfig, findHomecheck } from "../src/automatic.js";
import {
  buildRefactorPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
} from "../src/prompts.js";
import { readJson, writeJson, writeText } from "../src/utils.js";
import { fixture, makeProject, task } from "./helpers.js";
const record = {
  filePath: "demo/entry/src/main/ets/Page.ets",
  sourceProject: "demo",
  commitHash: "meta",
  messages: [
    {
      rule: "@extrulesproject/long-method-check",
      message: "Method 'work' is too long",
      line: 10,
      rangeEnd: 30,
    },
    {
      rule: "@extrulesproject/switch-statement-check",
      message: "Switch statement detected in method 'work'.",
      line: 12,
    },
  ],
};
test("HomeCheck 可独立于工作区指定，路径无效时禁止静默回退", (t) => {
  const root = fixture(t), workspace = path.join(root, "workspace"),
    scanner = path.join(root, "二阶段/homecheck-extrule");
  for (const dir of [path.join(workspace, "homecheck-extrule"), scanner]) {
    writeText(path.join(dir, "node_modules/homecheck/lib/run.js"), "");
    writeText(path.join(dir, "extrulesproject-1.0.0.tgz"), "fixture");
  }
  const previous = process.env.ARKTS_REFACTOR_HOMECHECK;
  try {
    delete process.env.ARKTS_REFACTOR_HOMECHECK;
    assert.equal(findHomecheck(workspace), path.join(workspace, "homecheck-extrule"));
    process.env.ARKTS_REFACTOR_HOMECHECK = scanner;
    assert.equal(findHomecheck(workspace), scanner);
    process.env.ARKTS_REFACTOR_HOMECHECK = path.join(root, "missing");
    assert.throws(() => findHomecheck(workspace), /指定的 HomeCheck 无效/);
  } finally {
    if (previous === undefined) delete process.env.ARKTS_REFACTOR_HOMECHECK;
    else process.env.ARKTS_REFACTOR_HOMECHECK = previous;
  }
});
test("粘贴对象和数组保持标准数据格式", () => {
  assert.deepEqual(normalizeInput(record), [record]);
  assert.deepEqual(normalizeInput([record]), [record]);
  assert.throws(() => normalizeInput({ filePath: "a", message: "flat" }));
  assert.throws(() => normalizeInput([null]));
});
test("每条 messages 独立任务、索引与行号保持", (t) => {
  const root = fixture(t),
    file = path.join(root, "input.json");
  writeJson(file, [record]);
  const tasks = loadDatasetTasks(file, root);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].task_id, "switch-statement-0002-work");
  assert.equal(tasks[0].target.range.end_line, 30);
  assert.equal(tasks[0].commit_hash, "meta");
  assert.equal(loadDatasetTasks(file, root, 2).length, 1);
  assert.throws(() => loadDatasetTasks(file, root, 9));
});
test("保留 God Class 与循环依赖 analysisContext", (t) => {
  const root = fixture(t),
    file = path.join(root, "input.json");
  writeJson(file, [
    {
      ...record,
      analysisContext: { baselineCycles: [["a", "b", "a"]] },
      messages: [{ rule: "formal/god-class", message: "God Class 'Service'" }],
    },
  ]);
  const current = loadDatasetTasks(file, root)[0];
  assert.equal(current.smell_type, "god-class");
  assert.equal(current.target.symbol, "Service");
  assert.deepEqual(current.raw.analysisContext.baselineCycles, [
    ["a", "b", "a"],
  ]);
});
test("数据集类型只作元信息并保持严格值", (t) => {
  const root = fixture(t),
    file = path.join(root, "instrument-test/input.json");
  writeJson(file, [record]);
  assert.equal(loadDatasetTasks(file, root)[0].raw.testKind, "instrument-test");
  writeJson(file, [{ ...record, testKind: "bad" }]);
  assert.throws(() => loadDatasetTasks(file, root));
});
test("克隆消息解析绝对路径和所属方法", () => {
  const targets = relatedTargets(
    "similar to D:\\demo\\Other.ets > Other.build():128-148. (100 tokens)",
  );
  assert.equal(targets[0].filePath, "D:/demo/Other.ets");
  assert.equal(targets[0].range.endLine, 148);
});
test("自动命令使用 Node 而非 Python，保留并行验证和返修配置", (t) => {
  const root = fixture(t),
    p = makeProject(root),
    current = readJson(path.join(p.taskDir, "task.json"));
  writeText(path.join(p.source, "hvigor/hvigor-config.json5"), "{}");
  const config = autoConfig(
    current as any,
    p.taskDir,
    {
      deveco: "deveco",
      hvigorw: "hvigorw",
      ohpm: "ohpm",
      homecheck: "homecheck",
      codelinter: "codelinter",
    },
    {},
    { enabled: true },
  );
  assert.equal(config.maxRepairAttempts, 3);
  assert.equal(config.taskTimeoutSeconds, 1200);
  assert.equal(
    (config.refactorAgent!.command as string[])[0],
    process.execPath,
  );
  assert(!JSON.stringify(config).includes("python"));
  assert(config.gates!.test.command!.includes("auto-test"));
});
test("首轮和返修保留验证限制、类型和键语义保护", (t) => {
  const root = fixture(t),
    current = task(root, "long-method");
  for (const prompt of [
    buildRefactorPrompt(current, {}),
    buildRepairPrompt(current, {}, { stage: "linter" }, 1),
  ]) {
    for (const fragment of [
      "两者每轮合计最多 2 次",
      "第一次通过即停止内部验证",
      "包括原来未提供的情况",
      "擅自新增 index-only key",
      "已有私有方法的前导下划线",
      "不反复猜测空白行数量",
      "不得到原仓库、历史 runs 或快照中搜索或复制实现",
    ])
      assert(prompt.includes(fragment), fragment);
  }
});
test("返修定向读取新增文件，允许必要上下文", (t) => {
  const current = task(fixture(t));
  const prompt = buildRepairPrompt(
    current,
    {},
    {
      stage: "smell",
      changedProductionFiles: ["entry/src/main/ets/NewHelper.ets"],
      issues: [
        {
          filePath: "entry/src/main/ets/NewHelper.ets",
          line: 9,
          reason: "remaining",
        },
      ],
    },
    1,
  );
  assert(prompt.includes("NewHelper.ets"));
  assert(prompt.includes("原画像行号可能已漂移"));
  assert(prompt.includes("定向查找并读取直接相关生产文件"));
});
test("Review 只读、完整依赖及 Linter skip 约定", (t) => {
  const current = task(fixture(t)),
    initial = buildRefactorPrompt(current, {}, "skip"),
    review = buildReviewPrompt(current, {});
  assert(initial.includes("本轮 Linter 已明确跳过"));
  assert(review.includes("传递生产依赖"));
  assert(review.includes("禁止读取或搜索原项目目录"));
  assert(review.includes("UNCERTAIN"));
  assert(review.includes("validationPolicy.linterMode=skip"));
});
