import fs from "node:fs";
import path from "node:path";
import type { Json } from "./models.js";
import {
  copyFile,
  hash,
  isFile,
  readJson,
  readJson5,
  unique,
  within,
} from "./utils.js";

/** Explicit module artifacts avoid the assembleApp semantics of --product alone. */
export function moduleBuildPlan(
  source: string,
  changedFiles: string[] = [],
): Json {
  const profile = readJson5(path.join(source, "build-profile.json5")),
    products = profile.app?.products ?? [];
  if (
    !Array.isArray(products) ||
    !Array.isArray(profile.modules) ||
    !profile.modules.length
  )
    throw new Error("无有效 products/modules 构建配置");
  const product =
    products.find((p: Json) => p.name === "default")?.name ??
    (products.length === 1
      ? products[0].name
      : products.length === 0
        ? "default"
        : null);
  if (typeof product !== "string" || !product)
    throw new Error("多个 product 且没有 default，不能任意选择");
  const active: Json[] = [];
  for (const module of profile.modules) {
    if (
      typeof module.name !== "string" ||
      !module.name ||
      typeof module.srcPath !== "string"
    )
      throw new Error("无效模块定义");
    const root = path.resolve(source, module.srcPath);
    if (!within(root, source)) throw new Error("模块路径超出工程范围");
    const targets = (module.targets ?? [{ name: "default" }]).filter(
      (t: Json) => !t.applyToProducts || t.applyToProducts.includes(product),
    );
    if (!targets.length) continue;
    const target =
      targets.find((t: Json) => t.name === "default") ??
      (targets.length === 1 ? targets[0] : null);
    if (!target?.name) throw new Error(`模块 ${module.name} 的 target 不明确`);
    const meta = ["module.json5", "module.json"]
      .map((f) => path.join(root, "src/main", f))
      .find(isFile);
    if (!meta)
      throw new Error(`无法确定模块 ${module.name} 类型（缺少 module.json5）`);
    const type = readJson5(meta).module?.type;
    if (!["entry", "feature", "shared", "har"].includes(type))
      throw new Error(`未知模块类型：${module.name}/${type}`);
    active.push({ name: module.name, target: target.name, type, root });
  }
  const chosen = new Set(
    active
      .filter((m) => ["entry", "feature"].includes(m.type))
      .map((m) => m.name),
  );
  for (const file of changedFiles) {
    const absolute = path.resolve(source, file);
    if (!within(absolute, source)) throw new Error("变更路径越界");
    const owner = active
      .filter((m) => within(absolute, m.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (owner) chosen.add(owner.name);
  }
  if (!chosen.size) for (const m of active) chosen.add(m.name);
  const modules = active
    .filter((m) => chosen.has(m.name))
    .map((m) => `${m.name}@${m.target}`);
  if (!modules.length || new Set(modules).size !== modules.length)
    throw new Error("没有可构建模块或模块名称重复");
  return {
    product,
    modules,
    scope: "module-artifacts-not-app",
    args: ["build", "--product", product, "--modules", ...modules],
  };
}

/** Reconstruct this task's original code, preserving every unrelated pre-existing edit. */
export function restoreBuildBaseline(
  taskDir: string,
  source: string,
  workspace: string,
): Json {
  if (within(workspace, source) || within(source, workspace))
    throw new Error("基线只允许写入独立验证副本");
  const manifestFile = path.join(taskDir, "refactor-changes.json");
  if (!isFile(manifestFile))
    throw new Error("缺少本任务变更清单，无法重建构建基线");
  const manifest = readJson(manifestFile),
    baselineRoot = path.join(taskDir, "baseline-production"),
    added = new Set<string>(manifest.newProductionFiles ?? []),
    changed = unique([
      ...(manifest.changedProductionFiles ?? []),
      ...(manifest.changedProductionResources ?? []).map((r: string | Json) =>
        typeof r === "string" ? r : r.filePath,
      ),
      ...added,
    ]) as string[];
  if (!changed.length) throw new Error("没有可核验的原始变更范围");
  const actions = changed.map((file) => {
    if (typeof file !== "string" || !file || path.isAbsolute(file))
      throw new Error("无效基线路径");
    const destination = path.resolve(workspace, file),
      before = path.resolve(baselineRoot, file);
    if (!within(destination, workspace) || !within(before, baselineRoot))
      throw new Error("基线路径越界");
    if (
      !added.has(file) &&
      (!isFile(before) || fs.lstatSync(before).isSymbolicLink())
    )
      throw new Error("缺少原始文件快照：" + file);
    if (
      fs.existsSync(destination) &&
      (!fs.lstatSync(destination).isFile() ||
        fs.lstatSync(destination).isSymbolicLink())
    )
      throw new Error("基线目标不是普通文件");
    return { file, destination, before, added: added.has(file) };
  });
  for (const item of actions) {
    if (item.added) fs.rmSync(item.destination, { force: true });
    else copyFile(item.before, item.destination);
  }
  return {
    restored: actions
      .filter((a) => !a.added)
      .map((a) => ({ file: a.file, sha256: hash(a.before) })),
    removedNewFiles: actions.filter((a) => a.added).map((a) => a.file),
  };
}
