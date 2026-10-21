import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { PluginConfig } from "./config.ts";
import { within } from "./config.ts";
import { canonicalPath, productionPath, safePath } from "./paths.ts";
import type { Candidate, Change } from "./types.ts";

export interface Transaction {
  schemaVersion: 1;
  candidateId: string;
  originalRoot: string;
  state: "APPLYING" | "APPLIED" | "ROLLED_BACK" | "CONFLICT";
  attempted: string[];
  conflicts: string[];
  recoveryIssues?: { path: string; kind: "CONTENT_CHANGED" | "IO_ERROR"; reason: string; code?: string }[];
  updatedAt: string;
}
interface Payload { change: Change; target: string; before: Buffer | null; after: Buffer }
export const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

async function contents(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`目标不是普通文件：${path}`);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function atomicWrite(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    // Retain permissions on production files when replacing them.
    const mode = await lstat(path).then((info) => info.mode, () => 0o600);
    await writeFile(temporary, data, { flag: "wx", mode });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function candidateLocation(config: PluginConfig, candidate: Candidate): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(candidate.candidateId)) throw new Error("候选 ID 无效");
  const project = await realpath(config.projectRoot);
  const original = await realpath(candidate.originalRoot);
  const runs = await canonicalPath(config.runs);
  if (!within(project, original) || within(project, runs)) throw new Error("候选工程或证据目录越界");
  const run = await safePath(config.runs, candidate.candidateId);
  if (await realpath(candidate.runDirectory) !== await realpath(run)) throw new Error("候选证据目录不匹配");
  return run;
}

async function payloads(config: PluginConfig, candidate: Candidate): Promise<{ run: string; files: Payload[] }> {
  const run = await candidateLocation(config, candidate);
  if (!Array.isArray(candidate.changes) || !candidate.changes.length) throw new Error("候选没有生产变更");
  const seen = new Set<string>();
  const files: Payload[] = [];
  for (const change of candidate.changes) {
    if (typeof change.relativePath !== "string" || seen.has(change.relativePath.toLowerCase()) ||
        !productionPath(change.relativePath) || !["added", "modified"].includes(change.changeType)) {
      throw new Error("候选包含重复、删除或非生产文件路径");
    }
    seen.add(change.relativePath.toLowerCase());
    const beforeHash = change.beforeSha256;
    if ((change.changeType === "added") !== (beforeHash === null) ||
        !/^[0-9a-f]{64}$/.test(change.afterSha256) ||
        (beforeHash !== null && !/^[0-9a-f]{64}$/.test(beforeHash)) ||
        (candidate.baselineFiles[change.relativePath] ?? null) !== beforeHash ||
        candidate.afterFiles[change.relativePath] !== change.afterSha256) throw new Error("候选摘要清单无效");
    const after = await readFile(await safePath(run, `content/after/${change.relativePath}`));
    const before = beforeHash === null ? null : await readFile(await safePath(run, `content/before/${change.relativePath}`));
    if (sha256(after) !== change.afterSha256 || after.length !== change.size ||
        (before && sha256(before) !== beforeHash)) throw new Error("冻结候选内容已变化");
    files.push({ change, before, after, target: await safePath(candidate.originalRoot, change.relativePath) });
  }
  return { run, files };
}
const digest = (value: Buffer | null) => value === null ? null : sha256(value);

async function save(run: string, transaction: Transaction): Promise<void> {
  transaction.updatedAt = new Date().toISOString();
  await atomicWrite(resolve(run, "apply-transaction.json"), JSON.stringify(transaction, null, 2));
}
async function withLock<T>(config: PluginConfig, work: () => Promise<T>): Promise<T> {
  await mkdir(config.runs, { recursive: true });
  const path = resolve(config.runs, ".apply.lock");
  const lock = await open(path, "wx").catch(() => { throw new Error(`另一个应用事务正在执行，或需检查遗留锁：${path}`); });
  try { await lock.writeFile(String(process.pid)); return await work(); }
  finally { await lock.close(); await unlink(path); }
}

async function rollback(candidate: Candidate, run: string, files: Payload[], transaction: Transaction): Promise<Transaction> {
  transaction.conflicts = [];
  transaction.recoveryIssues = [];
  for (const file of [...files].reverse()) {
    if (!transaction.attempted.includes(file.change.relativePath)) continue;
    try {
      await safePath(candidate.originalRoot, file.change.relativePath);
      const current = digest(await contents(file.target));
      if (current === file.change.beforeSha256) continue;
      if (current !== file.change.afterSha256) {
        transaction.conflicts.push(file.change.relativePath);
        transaction.recoveryIssues.push({ path: file.change.relativePath, kind: "CONTENT_CHANGED",
          reason: "当前内容与候选及原始基线均不同，已保留后续修改" });
        continue;
      }
      if (file.before === null) await unlink(file.target);
      else await atomicWrite(file.target, file.before);
    } catch (error) {
      transaction.conflicts.push(file.change.relativePath);
      const code = (error as NodeJS.ErrnoException).code;
      transaction.recoveryIssues.push({ path: file.change.relativePath, kind: "IO_ERROR",
        reason: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) });
    }
  }
  transaction.state = transaction.conflicts.length ? "CONFLICT" : "ROLLED_BACK";
  await save(run, transaction);
  return transaction;
}

/** Call candidate.check immediately before this function; it validates the entire Python baseline. */
export async function applyCandidate(config: PluginConfig, candidate: Candidate): Promise<Transaction> {
  if (candidate.verdict !== "PASS") throw new Error("只有 PASS 候选可以应用");
  return withLock(config, async () => {
    const { run, files } = await payloads(config, candidate);
    const existing = await readTransaction(config, candidate);
    if (existing && existing.state !== "ROLLED_BACK") throw new Error(`候选已有 ${existing.state} 应用记录，请先检查或恢复`);
    for (const file of files) {
      if (digest(await contents(file.target)) !== file.change.beforeSha256) throw new Error(`基线已变化：${file.change.relativePath}`);
    }
    const transaction: Transaction = { schemaVersion: 1, candidateId: candidate.candidateId,
      originalRoot: candidate.originalRoot, state: "APPLYING", attempted: [], conflicts: [], updatedAt: "" };
    await save(run, transaction);
    try {
      for (const file of files) {
        await safePath(candidate.originalRoot, file.change.relativePath);
        if (digest(await contents(file.target)) !== file.change.beforeSha256) throw new Error(`写入前基线已变化：${file.change.relativePath}`);
        transaction.attempted.push(file.change.relativePath);
        await save(run, transaction);
        await atomicWrite(file.target, file.after);
      }
      transaction.state = "APPLIED";
      await save(run, transaction);
      return transaction;
    } catch (error) {
      const restored = await rollback(candidate, run, files, transaction);
      throw new Error(`应用失败，恢复状态 ${restored.state}：${error instanceof Error ? error.message : error}`);
    }
  });
}

export async function readTransaction(config: PluginConfig, candidate: Candidate): Promise<Transaction | undefined> {
  const run = await candidateLocation(config, candidate);
  let transaction: Transaction;
  try { transaction = JSON.parse(await readFile(await safePath(run, "apply-transaction.json"), "utf8")) as Transaction; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (transaction.schemaVersion !== 1 || transaction.candidateId !== candidate.candidateId ||
      transaction.originalRoot !== candidate.originalRoot || !Array.isArray(transaction.attempted) ||
      !["APPLYING", "APPLIED", "ROLLED_BACK", "CONFLICT"].includes(transaction.state) ||
      transaction.attempted.some((name) => !candidate.changes.some((change) => change.relativePath === name))) {
    throw new Error("应用日志无效，请人工检查证据目录");
  }
  return transaction;
}

export async function recoverApplication(config: PluginConfig, candidate: Candidate): Promise<Transaction> {
  return withLock(config, async () => {
    const { run, files } = await payloads(config, candidate);
    const transaction = await readTransaction(config, candidate);
    if (!transaction) throw new Error("此候选没有应用事务");
    return rollback(candidate, run, files, transaction);
  });
}

export async function candidateDiff(config: PluginConfig, candidate: Candidate, name: string): Promise<string> {
  const { files } = await payloads(config, candidate);
  const file = files.find((entry) => entry.change.relativePath === name);
  if (!file) throw new Error("文件不属于当前候选");
  if (file.after.length > 512_000 || (file.before?.length ?? 0) > 512_000 ||
      file.after.includes(0) || file.before?.includes(0)) {
    return `${name}\n资源或大文件：${file.after.length} bytes\nSHA-256 ${file.change.afterSha256}\n完整内容：${candidate.runDirectory}/content/after/${name}`;
  }
  return createTwoFilesPatch(`a/${name}`, `b/${name}`, file.before?.toString("utf8") ?? "", file.after.toString("utf8"),
    undefined, undefined, { context: 3 });
}
