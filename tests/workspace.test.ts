import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  freshCopy,
  syncProductionChanges,
  changedCurrentLines,
  prepareReviewMaterials,
} from "../src/workspace.js";
import {
  issueTouchesChangedSymbol,
  smellScanFiles,
  symbolMatches,
} from "../src/smell.js";
import {
  parseLinterIssues,
  refactorGate,
  publicContractGate,
} from "../src/gate.js";
import {
  preparePublicContract,
  comparePublicContract,
  snapshotPublicContract,
} from "../src/public_contract.js";
import {
  buildRuntimeSmokePlan,
  renderRuntimeSmokeTest,
} from "../src/runtime_smoke.js";
import { analyzeRisks } from "../src/risk.js";
import {
  hash,
  readJson,
  readText,
  writeJson,
  writeText,
} from "../src/utils.js";
import { taskFromJson } from "../src/models.js";
import { fixture, makeProject, task } from "./helpers.js";
test("重构副本排除测试、依赖与缓存；验证副本保留测试", (t) => {
  const root = fixture(t),
    source = path.join(root, "source"),
    mirror = path.join(root, "mirror");
  for (const r of [
    "feature/src/main/ets/Foo.ets",
    "feature/src/test/Foo.test.ets",
    "feature/src/ohosTest/Foo.test.ets",
    "node_modules/foo/index.ts",
    ".git/config",
    ".homegraph/homegraph.db",
  ])
    writeText(path.join(source, r), "data");
  freshCopy(source, mirror, true);
  assert(fs.existsSync(path.join(mirror, "feature/src/main/ets/Foo.ets")));
  assert(!fs.existsSync(path.join(mirror, "feature/src/test/Foo.test.ets")));
  assert(!fs.existsSync(path.join(mirror, "node_modules")));
  assert(!fs.existsSync(path.join(mirror, ".homegraph")));
  freshCopy(source, mirror, false);
  assert(fs.existsSync(path.join(mirror, "feature/src/test/Foo.test.ets")));
  assert(!fs.existsSync(path.join(mirror, ".homegraph")));
});

test("TD.52 HomeGraph 缓存不参与回写和删除判定，其他配置边界仍严格", (t) => {
  const p = makeProject(fixture(t)),
    mirror = path.join(p.taskDir, "refactor-workspace"),
    originalCache = path.join(p.source, ".homegraph/existing.db");
  writeText(originalCache, "original runtime state");
  freshCopy(p.source, mirror, true);
  writeText(path.join(mirror, "feature/src/main/ets/Page.ets"), "modified");
  for (const name of [".gitignore", "daemon.log", "homegraph.db", "homegraph.lock", "homegraph.db-shm", "homegraph.db-wal"])
    writeText(path.join(mirror, ".homegraph", name), "live runtime state");
  assert.equal(syncProductionChanges(mirror, p.source), 0);
  assert.equal(readText(p.target).trimEnd(), "modified");
  assert.equal(readText(originalCache).trimEnd(), "original runtime state");
  assert(!fs.existsSync(path.join(p.source, ".homegraph/homegraph.db")));
  assert.deepEqual(
    readJson(path.join(p.taskDir, "refactor-changes.json")).changedProductionFiles,
    ["feature/src/main/ets/Page.ets"],
  );
  // An exact cache-directory exemption must not authorize neighboring files/configs.
  writeText(path.join(mirror, ".homegraph-config.json"), "unauthorized");
  writeText(path.join(mirror, "feature/src/main/ets/Page.ets"), "must not sync");
  assert.equal(syncProductionChanges(mirror, p.source), 4);
  assert.equal(readText(p.target).trimEnd(), "modified");
});
test("拒绝副本嵌套在原工程，避免递归复制或删除", (t) => {
  const root = fixture(t),
    source = path.join(root, "source");
  writeText(path.join(source, "x"), "x");
  assert.throws(() => freshCopy(source, path.join(source, "mirror"), false));
  assert.throws(() => freshCopy(source, root, false));
});
test("只同步生产源码、模块入口和生产资源，保留精确基线", (t) => {
  const root = fixture(t),
    p = makeProject(root),
    mirror = path.join(p.taskDir, "refactor-workspace");
  freshCopy(p.source, mirror, true);
  const before = hash(p.target);
  writeText(
    path.join(mirror, "feature/src/main/ets/Page.ets"),
    "export class Page { work() { return 2; } }",
  );
  writeText(
    path.join(mirror, "feature/Index.ets"),
    "export { Page } from './src/main/ets/Page';",
  );
  writeText(
    path.join(mirror, "feature/src/main/resources/base/element/string.json"),
    '{"key":"value"}',
  );
  assert.equal(syncProductionChanges(mirror, p.source), 0);
  assert.equal(
    hash(
      path.join(p.taskDir, "baseline-production/feature/src/main/ets/Page.ets"),
    ),
    before,
  );
  assert(
    readJson(path.join(p.taskDir, "refactor-changes.json"))
      .changedProductionResources.length,
  );
});
test("配置被修改时整批拒绝，不能先同步一半", (t) => {
  const p = makeProject(fixture(t)),
    mirror = path.join(p.taskDir, "refactor-workspace");
  freshCopy(p.source, mirror, true);
  const before = hash(p.target);
  writeText(path.join(mirror, "feature/src/main/ets/Page.ets"), "modified");
  writeText(path.join(mirror, "build-profile.json5"), "{}");
  assert.equal(syncProductionChanges(mirror, p.source), 4);
  assert.equal(hash(p.target), before);
});
test("生产删除拒绝；生成 wrapper/lock 不回写", (t) => {
  const p = makeProject(fixture(t)),
    mirror = path.join(p.taskDir, "refactor-workspace");
  freshCopy(p.source, mirror, true);
  fs.rmSync(path.join(mirror, "feature/src/main/ets/Page.ets"));
  assert.equal(syncProductionChanges(mirror, p.source), 4);
  freshCopy(p.source, mirror, true);
  writeText(path.join(mirror, "feature/src/main/ets/Page.ets"), "modified");
  writeText(path.join(mirror, "local.properties"), "discard");
  writeText(path.join(mirror, "oh-package-lock.json5"), "{}");
  assert.equal(syncProductionChanges(mirror, p.source), 0);
  assert(!fs.existsSync(path.join(p.source, "local.properties")));
});
test("新增文件跨 Loop 仍算新增，不能把上一轮内容伪装原始基线", (t) => {
  const p = makeProject(fixture(t));
  for (const index of [1, 2]) {
    const mirror = path.join(p.taskDir, "refactor-workspace-" + index);
    freshCopy(p.source, mirror, true);
    writeText(
      path.join(mirror, "feature/src/main/ets/Helper.ets"),
      `export const value = ${index};`,
    );
    assert.equal(syncProductionChanges(mirror, p.source), 0);
  }
  assert(
    !fs.existsSync(
      path.join(
        p.taskDir,
        "baseline-production/feature/src/main/ets/Helper.ets",
      ),
    ),
  );
  assert(
    readJson(
      path.join(p.taskDir, "refactor-changes.json"),
    ).newProductionFiles.includes("feature/src/main/ets/Helper.ets"),
  );
});
test("Review 材料包含二级依赖、本地包入口和末端实现", (t) => {
  const p = makeProject(fixture(t));
  writeText(
    p.target,
    "import { Facade } from '../../../../common/Index';\nexport class Page {}\n",
  );
  writeText(
    path.join(p.source, "common/Index.ets"),
    "export { Facade } from './Facade';",
  );
  writeText(
    path.join(p.source, "common/Facade.ets"),
    "import { Mapper } from './Mapper'; export class Facade {}",
  );
  writeText(path.join(p.source, "common/Mapper.ets"), "export class Mapper {}");
  prepareReviewMaterials(p.taskDir, p.source, [
    "feature/src/main/ets/Page.ets",
  ]);
  assert(
    fs.existsSync(
      path.join(p.taskDir, "review-context-production/common/Mapper.ets"),
    ),
  );
});
test("本地 Harmony 包别名和循环重导出解析有限终止", (t) => {
  const p = makeProject(fixture(t));
  writeText(
    p.target,
    "import { Facade } from 'common'; export class Page {}\n",
  );
  writeText(
    path.join(p.source, "feature/oh-package.json5"),
    "{dependencies:{common:'file:../common'}}",
  );
  writeText(
    path.join(p.source, "common/oh-package.json5"),
    "{main:'Index.ets'}",
  );
  writeText(
    path.join(p.source, "common/Index.ets"),
    "export { Facade } from './Facade';",
  );
  writeText(
    path.join(p.source, "common/Facade.ets"),
    "import { Facade } from './Index'; export class Facade {}\n",
  );
  prepareReviewMaterials(p.taskDir, p.source, [
    "feature/src/main/ets/Page.ets",
  ]);
  assert(
    fs.existsSync(
      path.join(p.taskDir, "review-context-production/common/Facade.ets"),
    ),
  );
});
test("变更行定位使用修改后代码，旧行号不能命中无关方法", (t) => {
  const root = fixture(t),
    before = path.join(root, "before"),
    after = path.join(root, "after");
  writeText(
    before,
    "class Page {\n  old() { return 1; }\n  target() { return 2; }\n}",
  );
  writeText(
    after,
    "class Page {\n  old() { return 1; }\n  target() { return 3; }\n}",
  );
  const changed = changedCurrentLines(before, after);
  assert.deepEqual([...changed], [3]);
  assert(!issueTouchesChangedSymbol(readText(after), "old", 2, changed));
  assert(issueTouchesChangedSymbol(readText(after), "target", 3, changed));
});
test("HomeCheck 只扫描本任务目标和变更文件，支持匿名方法归属", (t) => {
  const p = makeProject(fixture(t));
  writeText(
    path.join(p.source, "feature/src/main/ets/Helper.ets"),
    "export class Helper {}",
  );
  writeText(
    path.join(p.source, "feature/src/main/ets/Unrelated.ets"),
    "export class Other {}",
  );
  writeJson(path.join(p.taskDir, "refactor-changes.json"), {
    changedProductionFiles: ["feature/src/main/ets/Helper.ets"],
  });
  assert.equal(smellScanFiles(p.taskDir, p.source, p.target).length, 2);
  assert(symbolMatches("%AM2$work", "work"));
  assert(!symbolMatches("%AM2$work", "other"));
});
test("Linter 解析位置、规则与多行输出", () => {
  const issues = parseLinterIssues(
    "  12:3 warning bad naming @rule/naming\nfile.ets:15:2 error missing semi @rule/semi",
    "Page.ets",
  );
  assert.equal(issues.length, 2);
  assert.equal(issues[0].rule, "@rule/naming");
  assert.equal(issues[0].severity, "warn");
  assert.equal(issues[1].filePath, "file.ets");
});
test("契约比较忽略新增接口，但拒绝删除和参数变更", () => {
  const before = {
    exports: {
      Foo: {
        contract: { members: { "method:run": { parameters: ["string"] } } },
      },
    },
  };
  assert(comparePublicContract(before, before).passed);
  assert(!comparePublicContract(before, { exports: {} }).passed);
  assert(
    !comparePublicContract(before, {
      exports: {
        Foo: {
          contract: { members: { "method:run": { parameters: ["number"] } } },
        },
      },
    }).passed,
  );
});
test("模块 Index 契约基线能验证方法保留与移除", (t) => {
  const root = fixture(t),
    current = task(
      root,
      "god-class",
      "common/src/main/ets/Service.ets",
      "Service",
    );
  writeText(
    path.join(root, current.target.file_path),
    "export class Service {\n public run(x: string): number { return 1; }\n}",
  );
  writeText(
    path.join(root, "common/Index.ets"),
    "export {Service} from './src/main/ets/Service';",
  );
  const dir = path.join(root, "task");
  writeJson(path.join(dir, "task.json"), current);
  const plan = preparePublicContract(current, dir);
  assert(plan.enabled);
  assert.equal(publicContractGate(dir, root), 0);
  writeText(
    path.join(root, current.target.file_path),
    "export class Service {}",
  );
  assert.equal(publicContractGate(dir, root), 1);
});
test("Runtime smoke 只对零参数可公开构造的 God Class 触发", (t) => {
  const root = fixture(t),
    current = task(
      root,
      "god-class",
      "common/src/main/ets/Service.ets",
      "Service",
    );
  writeText(
    path.join(root, current.target.file_path),
    "export class Service {\n constructor() { getContext().resourceManager; }\n public getCount(): number { return 1; }\n}",
  );
  writeText(
    path.join(root, "common/Index.ets"),
    "export {Service} from './src/main/ets/Service';",
  );
  const risk = analyzeRisks(current),
    plan = buildRuntimeSmokePlan(current, risk);
  assert(plan.enabled);
  assert(renderRuntimeSmokeTest(plan).includes("new Service()"));
  assert.equal(plan.hiddenTestsUsed, false);
  risk.godClassAnalysis.methods[0].requiredParameterCount = 1;
  assert(!buildRuntimeSmokePlan(current, risk).enabled);
});
