import fs from "node:fs";
import path from "node:path";
import { createPatch, diffLines } from "diff";
import type { Json } from "./models.js";
import {
  copyFile,
  copyTree,
  hash,
  IGNORED,
  isFile,
  isTest,
  readJson,
  readJson5,
  readText,
  relative,
  removeGenerated,
  stamp,
  unique,
  walk,
  within,
  writeJson,
  writeText,
  parents,
} from "./utils.js";
const GENERATED = new Set(["buildprofile.ets", "oh-package-lock.json5"]);
const DISPOSABLE = new Set([
  "local.properties",
  "hvigorw",
  "hvigorw.bat",
  "hvigorw.js",
  "package-lock.json",
  "pnpm-lock.yaml",
]);
export function productionKind(p: string): "source" | "resource" | null {
  const s = "/" + p.replaceAll("\\", "/").toLowerCase();
  if (isTest(p)) return null;
  if (s.includes("/src/main/resources/")) return "resource";
  if (/\.(ets|ts)$/.test(s) && s.includes("/src/main/")) return "source";
  if (
    path.basename(p).toLowerCase() === "index.ets" &&
    p.split(/[\\/]/).length >= 2
  )
    return "source";
  return null;
}
export function freshCopy(
  source: string,
  dest: string,
  excludeTests: boolean,
): void {
  if (
    !within(dest, path.dirname(dest)) ||
    path.resolve(source) === path.resolve(dest) ||
    within(source, dest) ||
    within(dest, source)
  )
    throw new Error("非法的隔离工作区路径");
  if (fs.existsSync(dest)) {
    try {
      removeGenerated(dest, path.dirname(dest));
    } catch {
      fs.renameSync(dest, dest + ".stale-" + stamp());
    }
  }
  copyTree(source, dest, excludeTests);
}
export function changedCurrentLines(
  baseline: string,
  current: string,
): Set<number> {
  const after = readText(current);
  if (!isFile(baseline))
    return new Set(
      after
        .trimEnd()
        .split("\n")
        .map((_, i) => i + 1),
    );
  const result = new Set<number>();
  let line = 1;
  for (const part of diffLines(
    readText(baseline).replaceAll("\r\n", "\n"),
    after.replaceAll("\r\n", "\n"),
  )) {
    if (part.removed) continue;
    const count =
      part.count ??
      part.value.split("\n").length - (part.value.endsWith("\n") ? 1 : 0);
    if (part.added) for (let i = 0; i < count; i++) result.add(line + i);
    line += count;
  }
  return result;
}
export function firstSource(base: string): string | null {
  return (
    [
      base,
      base + ".ets",
      base + ".ts",
      path.join(base, "Index.ets"),
      path.join(base, "Index.ts"),
      path.join(base, "index.ets"),
    ].find(isFile) ?? null
  );
}
export function resolveDependency(
  current: string,
  specifier: string,
  root: string,
): string | null {
  let result: string | null = null;
  if (specifier.startsWith("."))
    result = firstSource(path.resolve(path.dirname(current), specifier));
  else {
    const pkg = parents(path.dirname(current), root)
      .filter((p) => within(p, root))
      .map((p) => path.join(p, "oh-package.json5"))
      .find(isFile);
    if (!pkg) return null;
    const data = readJson5(pkg),
      aliases = { ...data.dependencies, ...data.devDependencies },
      alias = Object.keys(aliases)
        .sort((a, b) => b.length - a.length)
        .find(
          (k) =>
            (specifier === k || specifier.startsWith(k + "/")) &&
            typeof aliases[k] === "string" &&
            aliases[k].startsWith("file:"),
        );
    if (!alias) return null;
    const pkgRoot = path.resolve(path.dirname(pkg), aliases[alias].slice(5));
    if (!within(pkgRoot, root)) return null;
    const subpath = specifier.slice(alias.length).replace(/^\//, ""),
      meta = path.join(pkgRoot, "oh-package.json5");
    result = firstSource(
      path.resolve(
        pkgRoot,
        subpath ||
          (isFile(meta) ? (readJson5(meta).main ?? "Index.ets") : "Index.ets"),
      ),
    );
  }
  return result && within(result, root) && !isTest(result) ? result : null;
}
export function prepareReviewMaterials(
  taskDir: string,
  source: string,
  changes: string[],
): void {
  const current = path.join(taskDir, "current-production"),
    context = path.join(taskDir, "review-context-production");
  for (const dir of [current, context])
    if (fs.existsSync(dir)) removeGenerated(dir, taskDir);
  const patches: string[] = [],
    files: string[] = [];
  for (const r of changes) {
    const before = path.join(taskDir, "baseline-production", r),
      after = path.join(source, r);
    if (!within(after, source)) throw new Error("评审文件越界");
    if (isFile(after)) {
      copyFile(after, path.join(current, r));
      files.push(after);
    }
    patches.push(
      createPatch(
        r,
        isFile(before) ? readText(before) : "",
        isFile(after) ? readText(after) : "",
        "baseline",
        "current",
      ),
    );
  }
  writeText(path.join(taskDir, "review-diff.patch"), patches.join("\n"));
  const processed = new Set<string>(),
    changed = new Set(files.map((p) => path.resolve(p))),
    queue = [...files],
    copied: string[] = [];
  while (queue.length) {
    const file = queue.shift()!;
    if (processed.has(file) || !isFile(file)) continue;
    processed.add(file);
    const text = readText(file);
    for (const m of text.matchAll(
      /^\s*(?:import|export)\s+(.+?)\s+from\s+['"]([^'"]+)['"]/gm,
    )) {
      const dep = resolveDependency(file, m[2], source);
      if (!dep) continue;
      queue.push(dep);
      if (!changed.has(dep)) {
        const r = relative(dep, source);
        copyFile(dep, path.join(context, r));
        copied.push(r);
      }
    }
  }
  writeJson(path.join(taskDir, "review-context.json"), {
    productionDependencies: unique(copied),
  });
}
export function syncProductionChanges(mirror: string, source: string): number {
  const taskDir = path.dirname(mirror),
    forbidden: string[] = [],
    discarded: string[] = [],
    allowed: { from: string; to: string; relative: string; kind: string }[] =
      [];
  for (const file of walk(mirror)) {
    const r = relative(file, mirror),
      name = path.basename(file).toLowerCase(),
      to = path.resolve(source, r);
    if (!within(to, source) || !within(file, mirror))
      throw new Error("变更文件越界");
    if (GENERATED.has(name) || (isFile(to) && hash(file) === hash(to)))
      continue;
    if (DISPOSABLE.has(name)) {
      discarded.push(r);
      continue;
    }
    const kind = productionKind(r);
    if (!kind) forbidden.push(r);
    else allowed.push({ from: file, to, relative: r, kind });
  }
  // Missing files are not an authorized rename/deletion, including source files omitted by the agent.
  for (const file of walk(source)) {
    const r = relative(file, source);
    if (
      !isTest(r) &&
      !GENERATED.has(path.basename(file).toLowerCase()) &&
      !DISPOSABLE.has(path.basename(file).toLowerCase()) &&
      !isFile(path.join(mirror, r))
    )
      forbidden.push(r + " (deleted)");
  }
  writeJson(
    path.join(taskDir, `agent-change-attempt-${path.basename(mirror)}.json`),
    {
      candidateProductionFiles: allowed
        .filter((a) => a.kind === "source")
        .map((a) => a.relative),
      candidateProductionResources: allowed
        .filter((a) => a.kind === "resource")
        .map((a) => a.relative),
      discardedValidationFiles: discarded,
      rejectedFiles: forbidden,
    },
  );
  if (forbidden.length) {
    console.error(
      "Refactor Agent 尝试修改非生产代码或删除文件：" + forbidden.join(", "),
    );
    return 4;
  }
  if (!allowed.length) {
    console.error("Refactor Agent 未产生允许的生产代码修改");
    return 5;
  }
  const manifest = path.join(taskDir, "refactor-changes.json"),
    previous: Json = isFile(manifest) ? readJson(manifest) : {},
    newFiles = new Set<string>(previous.newProductionFiles ?? []),
    resources: Json[] = [];
  for (const a of allowed) {
    const existed = isFile(a.to),
      baseline = path.join(taskDir, "baseline-production", a.relative);
    if (existed && !isFile(baseline) && !newFiles.has(a.relative))
      copyFile(a.to, baseline);
    if (!existed) newFiles.add(a.relative);
    copyFile(a.from, a.to);
    if (a.kind === "resource")
      resources.push({
        filePath: a.relative,
        size: fs.statSync(a.from).size,
        sha256: hash(a.from),
        changeType: existed ? "modified" : "added",
      });
  }
  const combined = unique([
    ...(previous.changedProductionFiles ?? []),
    ...allowed.filter((a) => a.kind === "source").map((a) => a.relative),
  ]);
  writeJson(manifest, {
    changedProductionFiles: combined,
    changedProductionResources: unique([
      ...(previous.changedProductionResources ?? []),
      ...allowed.filter((a) => a.kind === "resource").map((a) => a.relative),
    ]),
    productionResourceManifest: [
      ...(previous.productionResourceManifest ?? []).filter(
        (r: Json) => !resources.some((n) => n.filePath === r.filePath),
      ),
      ...resources,
    ],
    newProductionFiles: [...newFiles],
    discardedValidationFiles: discarded,
    rejectedFiles: [],
  });
  prepareReviewMaterials(taskDir, source, combined);
  console.log(
    "已同步生产代码修改：" + allowed.map((a) => a.relative).join(", "),
  );
  return 0;
}
