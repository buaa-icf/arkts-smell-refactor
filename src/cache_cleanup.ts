import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export interface CacheCleanupReport {
  removed: string[];
  retained: string[];
  warnings: string[];
  archived?: string[];
}

const report = (): CacheCleanupReport => ({ removed: [], retained: [], warnings: [], archived: [] });
const shortHash = (value: string): string => crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
const fileHash = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Check lexical containment before inspecting any directory supplied by saved task data. */
function childPath(root: string, name: string): string {
  const base = path.resolve(root), target = path.resolve(base, name), relative = path.relative(base, target);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("缓存路径必须严格位于预期目录内");
  return target;
}

/** Reject links in every existing ancestor, including a junction used as the cache root. */
function noLinkedAncestors(target: string): void {
  const absolute = path.resolve(target), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    if (!part) continue;
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("缓存路径包含符号链接或 junction：" + current);
    if (current !== absolute && !stat.isDirectory()) throw new Error("缓存祖先不是目录：" + current);
  }
}

function cacheFiles(target: string): string[] | undefined {
  noLinkedAncestors(target);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("缓存目标不是目录：" + target);
  const files: string[] = [];
  const visit = (directory: string): void => {
    noLinkedAncestors(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = childPath(target, path.relative(target, path.join(directory, entry.name)));
      noLinkedAncestors(directory);
      const current = fs.lstatSync(file);
      // OHPM creates dependency links inside its cache. Treat them as leaves:
      // never enumerate their targets or archive target files, even for internal links.
      if (current.isSymbolicLink()) continue;
      if (current.isDirectory()) visit(file);
      else if (current.isFile()) files.push(file);
      else throw new Error("缓存包含非普通文件：" + file);
    }
  };
  visit(target);
  return files;
}

/** Unlink nested links themselves; do not delegate traversal to recursive rm. */
function removeWithoutFollowingLinks(target: string): void {
  noLinkedAncestors(target);
  const remove = (entry: string): void => {
    // Check ancestors again before every destructive operation. A directory that
    // was replaced with a junction after inspection must not redirect a child path.
    noLinkedAncestors(path.dirname(entry));
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) {
      if (entry === target) throw new Error("缓存根已被替换为符号链接或 junction：" + entry);
      noLinkedAncestors(path.dirname(entry));
      fs.unlinkSync(entry);
    } else if (stat.isDirectory()) {
      noLinkedAncestors(entry);
      for (const name of fs.readdirSync(entry))
        remove(childPath(target, path.relative(target, path.join(entry, name))));
      noLinkedAncestors(entry);
      fs.rmdirSync(entry);
    } else if (stat.isFile()) {
      noLinkedAncestors(path.dirname(entry));
      fs.unlinkSync(entry);
    } else throw new Error("缓存包含非普通文件：" + entry);
  };
  remove(target);
}

/** Normal test runs already copy these into test-attempts; preserve any remaining raw reports too. */
function preserveTestReports(taskDir: string, cache: string, files: string[], label: string, result: CacheCleanupReport): void {
  const archive = childPath(taskDir, path.join("cache-evidence", label));
  for (const file of files) {
    const relative = path.relative(cache, file), parts = relative.split(path.sep);
    if (!/\.log$/i.test(file) && (!parts.includes(".test") ||
        !["test_result.txt", "js_coverage.json"].includes(path.basename(file)))) continue;
    const destination = childPath(archive, relative);
    noLinkedAncestors(file);
    noLinkedAncestors(destination);
    if (fs.existsSync(destination)) {
      if (!fs.lstatSync(destination).isFile() || fileHash(destination) !== fileHash(file))
        throw new Error("已有归档与缓存报告不同，保留缓存：" + destination);
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      noLinkedAncestors(destination);
      fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
      if (fileHash(destination) !== fileHash(file)) throw new Error("缓存报告归档校验失败：" + destination);
    }
    (result.archived ??= []).push(destination);
  }
}

function removeCache(target: string, result: CacheCleanupReport, archive?: { taskDir: string; label: string }): void {
  try {
    const files = cacheFiles(target);
    if (!files) return;
    if (archive) preserveTestReports(archive.taskDir, target, files, archive.label, result);
    // Recheck after archiving, then delete entries without following dependency links.
    cacheFiles(target);
    removeWithoutFollowingLinks(target);
    result.removed.push(target);
  } catch (error) {
    result.retained.push(target);
    result.warnings.push(`缓存未清理：${target}；${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Call only after all gate/agent processes and frozen-evidence checks have finished. */
export function cleanupTaskCaches(taskDir: string): CacheCleanupReport {
  const result = report(), task = path.resolve(taskDir);
  try {
    noLinkedAncestors(task);
    if (!fs.lstatSync(task).isDirectory()) throw new Error("任务目录不存在或不是目录");
  } catch (error) {
    result.warnings.push(`无法安全检查任务缓存：${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  const runtime = path.resolve(fileURLToPath(import.meta.url), "../..");
  // Match gate.ts derivation exactly, never trust validation-workspace.json.path.
  removeCache(childPath(path.join(runtime, "v"), shortHash(taskDir)), result, { taskDir: task, label: "validation" });
  for (const label of ["baseline", "current"])
    removeCache(childPath(path.join(os.tmpdir(), "arkts-smell-refactor-runtime"), shortHash(taskDir + label)), result,
      { taskDir: task, label: "runtime-smoke-" + label });
  return result;
}

const copyNames = new Set(["staging", "edit", "backend/external-edits", "backend/refactor-workspace"]);
export { noLinkedAncestors as assertUnlinkedPath };

/** Remove only named disposable copies, never prepared/baseline, backend evidence, or candidate content. */
export function cleanupRunCopies(run: string, names: string[]): CacheCleanupReport {
  const result = report(), root = path.resolve(run);
  try {
    noLinkedAncestors(root);
    if (!fs.lstatSync(root).isDirectory()) throw new Error("运行目录不存在或不是目录");
  } catch (error) {
    result.warnings.push(`无法安全检查运行副本：${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  for (const name of new Set(names)) {
    if (!copyNames.has(name) && !/^backend\/refactor-workspace-repair-prompt-[1-9][0-9]*$/.test(name)) {
      result.warnings.push("拒绝清理非缓存目录：" + name);
      continue;
    }
    removeCache(childPath(root, name), result);
  }
  return result;
}
