import path from "node:path";
import type { Json } from "./models.js";
import {
  isDir,
  isFile,
  isTest,
  readJson,
  readJson5,
  readText,
  walk,
  within,
  relative,
  unique,
} from "./utils.js";
import { mask } from "./analysis/source.js";
export const TEST_KINDS: Record<string, [string, string]> = {
  local: ["src/test", "test"],
  instrument: ["src/ohosTest", "onDeviceTest"],
};
const extensions = [".ets", ".ts", ".js"];
export function projectModules(root: string): Map<string, string> {
  const profile = readJson5(path.join(root, "build-profile.json5"));
  if (!Array.isArray(profile.modules) || !profile.modules.length)
    throw new Error("build-profile.json5 has no modules array");
  const modules = new Map<string, string>();
  for (const m of profile.modules) {
    if (
      typeof m.name !== "string" ||
      typeof m.srcPath !== "string" ||
      !m.name ||
      modules.has(m.name)
    )
      throw new Error("Invalid or duplicate module");
    const p = path.resolve(root, m.srcPath);
    if (!within(p, root)) throw new Error("External module");
    modules.set(m.name, p);
  }
  return modules;
}
export function testFiles(moduleRoot: string, kind: string): string[] {
  const dir = path.join(moduleRoot, TEST_KINDS[kind][0]),
    all = [...walk(dir)].filter((p) => extensions.includes(path.extname(p))),
    candidates = all.filter(
      (p) =>
        /\.test\.(ets|ts|js)$/.test(p) &&
        !/List\.test\./.test(path.basename(p)),
    ),
    entries = all.filter((p) => /^List\.test\./.test(path.basename(p))).sort();
  if (!entries.length) return candidates.sort();
  const reached = new Set<string>(),
    pending = [...entries];
  while (pending.length) {
    const file = pending.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const text = mask(readText(file), false),
      code = mask(text);
    if (/\b(?:import|require)\s*\(/.test(code)) return candidates.sort();
    for (const m of text.matchAll(
      /\b(?:import|export)\s+(?:(?:[^;'"`]+?)\s+from\s*)?['"]([^'"\r\n]+)['"]/g,
    )) {
      if (
        !code.slice(m.index!, m.index! + 6).trim() ||
        /^(?:import|export)\s+type\b/.test(m[0]) ||
        !m[1].startsWith(".")
      )
        continue;
      const base = path.resolve(path.dirname(file), m[1]),
        dependency = [
          base,
          ...extensions.map((e) => base + e),
          ...extensions.map((e) => path.join(base, "index" + e)),
        ].find(isFile);
      if (!dependency) return candidates.sort();
      if (within(dependency, dir)) pending.push(dependency);
    }
  }
  return candidates.filter((p) => reached.has(p)).sort();
}
export const suiteNames = (file: string) =>
  unique(
    [
      ...mask(readText(file), false).matchAll(
        /\bdescribe\s*\(\s*['"]([^'"\r\n]+)['"]\s*,/g,
      ),
    ].map((m) => m[1]),
  ).sort();
/** Match only the complete unmodified SDK string-assertion scaffold, not names alone. */
export function isSdkTemplateTest(file: string): boolean {
  let text = mask(readText(file), false);
  text = text.replace(
    /\bimport\s*\{([^}]+)\}\s*from\s*['"](@ohos\/hypium|@kit\.PerformanceAnalysisKit)['"]\s*;?/g,
    (statement, names: string, source: string) => {
      const allowed =
        source === "@ohos/hypium"
          ? [
              "describe",
              "beforeAll",
              "beforeEach",
              "afterEach",
              "afterAll",
              "it",
              "expect",
            ]
          : ["hilog"];
      return names.split(",").every((name) => allowed.includes(name.trim()))
        ? ""
        : statement;
    },
  );
  text = text.replace(
    /\b(?:beforeAll|beforeEach|afterEach|afterAll)\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)\s*;?/g,
    "",
  );
  const normalized = text
    .replace(/\s+|;/g, "")
    .replaceAll('"', "'")
    .replace("hilog.info(0x0000,'testTag','%{public}s','itbegin')", "");
  return ["localUnitTest", "abilityTest"].some(
    (name) =>
      normalized ===
      `exportdefaultfunction${name}(){describe('${name === "abilityTest" ? "ActsAbilityTest" : "localUnitTest"}',()=>{it('assertContain',0,()=>{leta='abc'letb='b'expect(a).assertContain(b)expect(a).assertEqual(a)})})}`,
  );
}
export function buildTestPlan(
  taskDir: string,
  root: string,
  mode = "auto-test",
  module?: string,
): Json {
  root = path.resolve(root);
  const modules = projectModules(root),
    affected = new Map<string, Set<string>>(),
    primaryModules = new Set<string>(),
    excludedTests: Json[] = [];
  const add = (p: string, target: boolean) => {
    p = path.resolve(p);
    const owner = [...modules]
      .filter(([, r]) => within(p, r))
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (!owner) throw new Error(`No module owns test target: ${p}`);
    const set = affected.get(owner[0]) ?? new Set<string>();
    if (target) primaryModules.add(owner[0]);
    if (target || !primaryModules.has(owner[0])) set.add(p);
    affected.set(owner[0], set);
  };
  if (mode === "auto-test") {
    const task = readJson(path.join(taskDir, "task.json")),
      base = task.workspace_root ?? task.workspaceRoot,
      target = task.target;
    add(path.resolve(base, target.file_path ?? target.filePath), true);
    for (const r of target.related_targets ?? target.relatedTargets ?? [])
      add(path.resolve(base, r.filePath), true);
    const cp = path.join(taskDir, "refactor-changes.json");
    if (isFile(cp)) {
      const c = readJson(cp);
      for (const f of c.changedProductionFiles ?? [])
        add(path.resolve(root, f), false);
      for (const f of c.changedProductionResources ?? [])
        add(path.resolve(root, typeof f === "string" ? f : f.filePath), false);
    }
  } else if (module) {
    const name = module.replace(/@ohosTest$/, "");
    if (!modules.has(name)) throw new Error(`Unknown test module: ${name}`);
    affected.set(name, new Set());
  } else {
    const kind = mode === "test" ? "local" : "instrument";
    for (const [name, r] of modules)
      if (testFiles(r, kind).length) affected.set(name, new Set());
    if (!affected.size) throw new Error(`No runnable ${kind} tests in project`);
  }
  const kinds =
      mode === "auto-test"
        ? Object.keys(TEST_KINDS)
        : [mode === "test" ? "local" : "instrument"],
    inventory = new Map<string, string[]>(),
    matches = new Map<string, Set<string>>(),
    fallback = new Set<string>();
  for (const [name, r] of modules)
    for (const kind of kinds) {
      const files = testFiles(r, kind).filter((file) => {
        if (mode !== "auto-test" || !isSdkTemplateTest(file)) return true;
        excludedTests.push({
          module: name,
          kind,
          filePath: relative(file, root),
          reason: "unmodified-sdk-template-only",
        });
        return false;
      });
      inventory.set(JSON.stringify([name, kind]), files);
    }
  for (const [owner, targets] of affected) {
    if (!targets.size) fallback.add(owner);
    for (const target of targets) {
      let found = false;
      const stem = path.basename(target, path.extname(target));
      for (const [key, files] of inventory) {
        const selected = files.filter((p) =>
          [stem + ".test", stem + "Test.test"].includes(
            path.basename(p, path.extname(p)),
          ),
        );
        if (!selected.length) continue;
        found = true;
        const set = matches.get(key) ?? new Set<string>();
        for (const p of selected) set.add(p);
        matches.set(key, set);
        if (
          selected.some(
            (p) =>
              !suiteNames(p).length ||
              suiteNames(p).some((s) => /[#,]/.test(s)),
          )
        )
          fallback.add(JSON.parse(key)[0]);
      }
      if (!found) fallback.add(owner);
    }
  }
  const jobs: Json[] = [];
  for (const name of unique([
    ...fallback,
    ...[...matches.keys()].map((k) => JSON.parse(k)[0]),
  ]).sort()) {
    const r = modules.get(name)!,
      specific = !fallback.has(name),
      before = jobs.length;
    for (const kind of kinds) {
      const key = JSON.stringify([name, kind]),
        selected = specific
          ? [...(matches.get(key) ?? [])].sort()
          : inventory.get(key)!;
      if (!selected.length) continue;
      const suites = unique(selected.flatMap(suiteNames)).sort();
      for (const scope of specific ? suites : [null])
        jobs.push({
          kind,
          task: TEST_KINDS[kind][1],
          module: name,
          modulePath: relative(r, root),
          scope,
          expectedSuites: scope ? [scope] : suites,
          testFiles: selected.map((p) => relative(p, root)),
          reason: specific
            ? "target-named-suite"
            : "module-fallback-all-available-kinds",
        });
    }
    if (
      jobs.length === before &&
      !(
        mode === "auto-test" &&
        !primaryModules.has(name) &&
        excludedTests.some((item) => item.module === name)
      )
    )
      throw new Error(`No runnable test files in affected module: ${name}`);
  }
  if (!jobs.length)
    throw new Error("No runnable test files beyond SDK templates");
  return {
    schemaVersion: "1.0",
    mode,
    jobs,
    excludedTests: excludedTests.filter((item) => affected.has(item.module)),
    additionalModulesWithoutBusinessTests: [...affected.keys()].filter(
      (name) =>
        !primaryModules.has(name) && !jobs.some((job) => job.module === name),
    ),
  };
}
