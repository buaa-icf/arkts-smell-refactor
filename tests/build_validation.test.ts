import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import {
  moduleBuildPlan,
  restoreBuildBaseline,
} from "../src/build_validation.js";
import { fixture, makeProject } from "./helpers.js";
import { readText, writeJson, writeText } from "../src/utils.js";
import { freshCopy } from "../src/workspace.js";

test("构建显式选择全部 HAP 和本次变更库模块，不误切到 assembleApp", (t) => {
  const p = makeProject(fixture(t));
  writeJson(path.join(p.source, "build-profile.json5"), {
    app: { products: [{ name: "default" }] },
    modules: [
      { name: "phone", srcPath: "products/phone" },
      { name: "tablet", srcPath: "products/tablet" },
      { name: "hotel", srcPath: "features/hotel" },
      { name: "unused", srcPath: "commons/unused" },
    ],
  });
  for (const [dir, type] of [
    ["products/phone", "entry"],
    ["products/tablet", "entry"],
    ["features/hotel", "shared"],
    ["commons/unused", "har"],
  ])
    writeJson(path.join(p.source, dir, "src/main/module.json5"), {
      module: { type },
    });
  const plan = moduleBuildPlan(p.source, [
    "features/hotel/src/main/ets/VM.ets",
  ]);
  assert.deepEqual(plan.modules, [
    "phone@default",
    "tablet@default",
    "hotel@default",
  ]);
  assert(plan.args.includes("--modules"));
  assert.equal(plan.scope, "module-artifacts-not-app");
});

test("模块 target 按所选 product 匹配；纯库工程仍构建模块产物", (t) => {
  const p = makeProject(fixture(t));
  writeJson(path.join(p.source, "build-profile.json5"), {
    app: { products: [{ name: "custom" }] },
    modules: [
      {
        name: "lib",
        srcPath: "feature",
        targets: [
          { name: "phone", applyToProducts: ["custom"] },
          { name: "other", applyToProducts: ["other"] },
        ],
      },
    ],
  });
  writeJson(path.join(p.source, "feature/src/main/module.json5"), {
    module: { type: "har" },
  });
  assert.deepEqual(moduleBuildPlan(p.source).args, [
    "build",
    "--product",
    "custom",
    "--modules",
    "lib@phone",
  ]);
});

test("构建范围无法确定时阻塞，不猜 product、类型或越界模块", (t) => {
  const p = makeProject(fixture(t));
  assert.throws(() => moduleBuildPlan(p.source), /无法确定模块/);
  writeJson(path.join(p.source, "build-profile.json5"), {
    app: { products: [{ name: "a" }, { name: "b" }] },
    modules: [{ name: "lib", srcPath: "feature" }],
  });
  assert.throws(() => moduleBuildPlan(p.source), /多个 product/);
  writeJson(path.join(p.source, "build-profile.json5"), {
    modules: [{ name: "external", srcPath: "../external" }],
  });
  assert.throws(() => moduleBuildPlan(p.source), /超出/);
});

test("构建基线只在独立副本回放本任务原始代码/资源并去掉新增文件，保留其他修改", (t) => {
  const p = makeProject(fixture(t)),
    dest = path.join(p.taskDir, "baseline-copy"),
    file = "feature/src/main/ets/Page.ets",
    resource = "feature/src/main/resources/base/element/string.json",
    added = "feature/src/main/ets/Added.ets";
  writeText(p.target, "refactored");
  writeText(path.join(p.source, resource), "new resource");
  writeText(path.join(p.source, added), "new source");
  writeText(path.join(p.source, "unrelated.txt"), "pre-existing dirty edit");
  writeText(
    path.join(p.taskDir, "baseline-production", file),
    "original dirty source, not Git HEAD",
  );
  writeText(
    path.join(p.taskDir, "baseline-production", resource),
    "original resource",
  );
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: [file, added],
    changedProductionResources: [resource],
    newProductionFiles: [added],
  });
  freshCopy(p.source, dest, false);
  const replay = restoreBuildBaseline(p.taskDir, p.source, dest);
  assert.equal(
    readText(path.join(dest, file)).trim(),
    "original dirty source, not Git HEAD",
  );
  assert.equal(readText(path.join(dest, resource)).trim(), "original resource");
  assert(!fs.existsSync(path.join(dest, added)));
  assert.equal(
    readText(path.join(dest, "unrelated.txt")).trim(),
    "pre-existing dirty edit",
  );
  assert.equal(readText(p.target).trim(), "refactored");
  assert(fs.existsSync(path.join(p.source, added)));
  assert.equal(replay.restored.length, 2);
});

test("基线快照缺失或路径越界不能补猜，更不能删除真实源文件", (t) => {
  const p = makeProject(fixture(t)),
    dest = path.join(p.taskDir, "baseline-copy");
  freshCopy(p.source, dest, false);
  assert.throws(
    () => restoreBuildBaseline(p.taskDir, p.source, dest),
    /缺少本任务/,
  );
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: ["feature/src/main/ets/Page.ets"],
  });
  assert.throws(
    () => restoreBuildBaseline(p.taskDir, p.source, dest),
    /缺少原始/,
  );
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: ["../outside"],
    newProductionFiles: ["../outside"],
  });
  assert.throws(() => restoreBuildBaseline(p.taskDir, p.source, dest), /越界/);
  assert.throws(
    () => restoreBuildBaseline(p.taskDir, p.source, p.source),
    /独立/,
  );
});
