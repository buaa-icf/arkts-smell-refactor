import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BATCH_INPUT_FILE, loadBatch } from "../src/batch.js";
import { runTasks } from "../src/automatic.js";
import { signingSource, withBatchWorkspace } from "../src/batch_workspace.js";
import { targetPath } from "../src/models.js";
import { readJson, writeText, isFile } from "../src/utils.js";
import { fixture } from "./helpers.js";

test("回滚批次隔离每条的改写和新增文件，异常退出也保留原工作区及证据", async (t) => {
  const root = fixture(t),
    workspace = batchFixture(root);
  const original = loadBatch(workspace).tasks[0],
    target = targetPath(original);
  const previous = fs.readFileSync(target),
    resource = "entry/src/main/resources/rawfile/data.bin";
  const testFile = "entry/src/ohosTest/ets/test/Ability.test.ets";
  writeText(path.join(original.project_root, testFile), "original suite");
  const runs = path.join(root, "receipts");
  for (const fail of [false, true]) {
    const receipt = path.join(runs, String(fail));
    const result = withBatchWorkspace(original, receipt, async (task) => {
      assert.deepEqual(signingSource(receipt, task.project_root, task.workspace_root), {
        source: original.project_root, workspaceRoot: original.workspace_root,
      });
      assert.deepEqual(fs.readFileSync(targetPath(task)), previous);
      assert.match(
        fs.readFileSync(path.join(task.project_root, testFile), "utf8"),
        /original suite/,
      );
      assert.equal(
        fs.existsSync(path.join(task.project_root, resource)),
        false,
      );
      writeText(targetPath(task), "candidate");
      writeText(path.join(task.project_root, resource), "one new resource");
      if (fail) throw new Error("fixture fail");
      return "PASS";
    });
    if (fail) await assert.rejects(result, /fixture fail/);
    else assert.equal(await result, "PASS");
    const status = readJson(path.join(receipt, "batch-rollback.json"));
    assert.equal(status.cleanup, "complete");
    assert.equal(fs.existsSync(status.privateProject), false);
    assert.match(status.initialTargetSha256, /^[\da-f]{64}$/);
    assert.deepEqual(fs.readFileSync(target), previous);
    assert.equal(
      fs.existsSync(path.join(original.project_root, resource)),
      false,
    );
  }
});

function batchFixture(root: string) {
  const workspace = path.join(root, "workspace");
  for (const record of readJson(BATCH_INPUT_FILE) as unknown as {
    filePath: string;
  }[])
    writeText(
      path.join(workspace, record.filePath),
      "export class Page { work() { return 1; } }",
    );
  return workspace;
}

test("batch 内置固定100条，不依赖工作区数据集，保留47/53测试类型", (t) => {
  const workspace = batchFixture(fixture(t));
  // Even a corrupt unrelated workspace dataset must never be consulted.
  writeText(
    path.join(
      workspace,
      "arkts-code-smell/dataset/positive/local-test/feature-envy.json",
    ),
    "not JSON",
  );
  const batch = loadBatch(workspace);
  assert.equal(batch.tasks.length, 100);
  assert.equal(batch.data.length, 100);
  assert.equal(new Set(batch.tasks.map((task) => task.task_id)).size, 100);
  assert.equal(
    batch.tasks.filter((task) => task.raw.testKind === "local-test").length,
    47,
  );
  assert.equal(
    batch.tasks.filter((task) => task.raw.testKind === "instrument-test")
      .length,
    53,
  );
  assert.deepEqual(batch.metadata.smellCounts, {
    "feature-envy": 20,
    "long-method": 25,
    "switch-statement": 25,
    "code-clone": 30,
  });
  assert.equal(batch.metadata.sampleSet, "batch-100-v1");
  assert.equal(batch.metadata.sampleFile, BATCH_INPUT_FILE);
});

test("batch 只用指定工作区定位源代码，缺少源文件时预检报错", (t) => {
  const root = fixture(t),
    workspace = batchFixture(root),
    another = batchFixture(path.join(root, "another"));
  const first = loadBatch(workspace),
    second = loadBatch(another);
  assert.deepEqual(first.data, second.data);
  assert.notEqual(first.tasks[0].project_root, second.tasks[0].project_root);
  assert(!fs.existsSync(path.join(another, "arkts-code-smell")));
  fs.unlinkSync(path.join(workspace, first.tasks[0].target.file_path));
  assert.throws(() => loadBatch(workspace), /源文件不存在或越界/);
  assert.throws(
    () => loadBatch(path.join(root, "missing")),
    /工作区目录不存在/,
  );
});

test("batch dry-run 仅输出内置100条清单，不启动工具、不改源代码", async (t) => {
  const root = fixture(t),
    workspace = batchFixture(root),
    batch = loadBatch(workspace);
  const target = path.join(workspace, batch.tasks[0].target.file_path);
  const before = fs.readFileSync(target, "utf8");
  const result = await runTasks(
    root,
    workspace,
    batch.data,
    batch.tasks,
    "required",
    true,
    batch.metadata,
  );
  const manifest = readJson(path.join(result.sessionDir, "manifest.json"));
  assert.equal(manifest.total, 100);
  assert.equal(manifest.workspace, workspace);
  assert.deepEqual(manifest.tools, {});
  assert.equal(manifest.dryRun, true);
  assert.equal(fs.readdirSync(result.sessionDir).length, 2);
  assert.equal(fs.readFileSync(target, "utf8"), before);
  assert(!fs.existsSync(path.join(workspace, "arkts-code-smell")));
});

test("batch 单条异常不终止后续样例，并保存进度汇总", async (t) => {
  const root = fixture(t),
    workspace = batchFixture(root),
    batch = loadBatch(workspace);
  const tasks = batch.tasks.slice(0, 2);
  fs.unlinkSync(path.join(workspace, tasks[0].target.file_path));
  // No Harmony build root: the second task is INCOMPLETE, with no external commands.
  const result = await runTasks(root, workspace, batch.data, tasks);
  assert.equal(result.completed, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.counts.BLOCKED, 1);
  assert.equal(result.counts.INCOMPLETE, 1);
  assert.equal(
    readJson(path.join(result.sessionDir, "summary.json")).completed,
    2,
  );
  for (const item of result.tasks)
    assert(isFile(path.join(item.taskDir, "result.json")));
});
