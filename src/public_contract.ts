import path from "node:path";
import type { Json, RefactorTask } from "./models.js";
import { targetPath } from "./models.js";
import {
  isDir,
  isFile,
  parents,
  readText,
  relative,
  within,
  writeJson,
} from "./utils.js";
import { braceDepths, classBlock, METHOD } from "./analysis/god_class.js";
import { splitParameters } from "./analysis/source.js";
export function moduleInfo(task: RefactorTask): Json {
  const c = task.raw.analysisContext ?? {};
  if (c.module && c.modulePath)
    return { module: c.module, modulePath: c.modulePath };
  for (const p of parents(path.dirname(targetPath(task)), task.project_root))
    if (within(p, task.project_root) && isDir(path.join(p, "src/main")))
      return {
        module: path.basename(p),
        modulePath: relative(p, task.project_root),
      };
  return {};
}
export function classContract(file: string, name: string): Json | null {
  if (!isFile(file)) return null;
  const block = classBlock(readText(file), name);
  if (!block) return null;
  const depths = braceDepths(block),
    members: Json = {},
    normalize = (s: string) => s.replace(/\s+/g, "");
  for (const m of block.matchAll(METHOD))
    if (depths[m.index!] === 1 && !/private|protected/.test(m[1]))
      members["method:" + m[2]] = {
        kind: "method",
        static: m[1].includes("static"),
        parameters: splitParameters(m[3]).map((p) => ({
          optional: p.split(":")[0].includes("?") || p.includes("="),
          type: normalize(
            p.slice(p.indexOf(":") + 1).split("=")[0] || "unknown",
          ),
        })),
        returnType: normalize(m[4] ?? "unknown"),
      };
  for (const m of block.matchAll(
    /^\s*((?:(?:public|private|protected|static|readonly)\s+)*)([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*([^=;\n]+)\s*(?:=|;)/gm,
  ))
    if (depths[m.index!] === 1 && !/private|protected/.test(m[1]))
      members["field:" + m[2]] = {
        kind: "field",
        static: m[1].includes("static"),
        readonly: m[1].includes("readonly"),
        type: normalize(m[3]),
      };
  return { kind: "class", members };
}
export function snapshotPublicContract(
  task: RefactorTask,
  root: string,
  plan: Json,
): Json {
  const moduleRoot = path.resolve(root, plan.modulePath),
    index = path.join(moduleRoot, "Index.ets"),
    exports: Json = {};
  const entry = (name: string, original: string, file: string | null) => ({
    name,
    kind: "named-export",
    contract: file ? classContract(file, original) : null,
  });
  const resolveExport = (specifier: string) => {
    if (!specifier.startsWith(".")) return null;
    const base = path.resolve(moduleRoot, specifier);
    return (
      [base, base + ".ets", path.join(base, "Index.ets")].find(isFile) ?? null
    );
  };
  if (isFile(index)) {
    const text = readText(index);
    for (const m of text.matchAll(
      /export\s*{([^}]+)}\s*from\s*['"]([^'"]+)['"]/gs,
    )) {
      const file = resolveExport(m[2]);
      for (const item of m[1].split(",")) {
        const parts = item.trim().split(/\s+as\s+/),
          name = parts.at(-1)!.trim();
        if (name) exports[name] = entry(name, parts[0].trim(), file);
      }
    }
    for (const m of text.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
      const file = resolveExport(m[1]);
      if (file)
        for (const d of readText(file).matchAll(
          /^\s*export\s+(?:default\s+)?(?:class|struct|interface|enum|type|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
        ))
          exports[d[1]] ??= entry(d[1], d[1], file);
    }
  }
  if (task.target.symbol) {
    const actual = within(targetPath(task), task.project_root)
        ? path.resolve(root, path.relative(task.project_root, targetPath(task)))
        : targetPath(task),
      contract = classContract(actual, task.target.symbol);
    if (contract)
      exports[task.target.symbol] ??= {
        name: task.target.symbol,
        kind: "target-class",
        contract,
      };
  }
  return {
    schemaVersion: "1.0",
    module: plan.module,
    modulePath: plan.modulePath,
    exports,
  };
}
export function comparePublicContract(before: Json, current: Json): Json {
  const old = before.exports ?? {},
    updated = current.exports ?? {},
    removed = Object.keys(old)
      .filter((k) => !(k in updated))
      .sort(),
    changed: Json[] = [];
  for (const name of Object.keys(old)
    .filter((k) => k in updated)
    .sort()) {
    const a = old[name].contract,
      b = updated[name].contract;
    if (!a || !b) continue;
    for (const [key, signature] of Object.entries(a.members ?? {}))
      if (!(key in b.members))
        changed.push({
          export: name,
          member: key,
          change: "removed",
          before: signature,
        });
      else if (JSON.stringify(b.members[key]) !== JSON.stringify(signature))
        changed.push({
          export: name,
          member: key,
          change: "signature-changed",
          before: signature,
          after: b.members[key],
        });
  }
  return {
    schemaVersion: "1.0",
    removedExports: removed,
    changedMembers: changed,
    passed: !removed.length && !changed.length,
  };
}
export function preparePublicContract(
  task: RefactorTask,
  taskDir: string,
): Json {
  const module = moduleInfo(task),
    plan = {
      schemaVersion: "1.0",
      enabled: !!module.module,
      ...module,
      targetSymbol: task.target.symbol,
      targetFile: task.target.file_path,
      reason: module.module
        ? "public module/class surface available"
        : "module root not found",
    };
  writeJson(path.join(taskDir, "public-contract-plan.json"), plan);
  if (plan.enabled)
    writeJson(
      path.join(taskDir, "public-contract-before.json"),
      snapshotPublicContract(task, task.project_root, plan),
    );
  return plan;
}
