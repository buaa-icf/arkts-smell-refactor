import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import JSON5 from "json5";
import type { Json } from "./models.js";
export const slash = (s: string) => s.replaceAll("\\", "/");
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const exists = (p: string) => fs.existsSync(p);
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
export const readText = (p: string) =>
  fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
export const readJson = (p: string): Json => JSON.parse(readText(p));
export const readJson5 = (p: string): Json => JSON5.parse(readText(p));
export function writeText(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text.trimEnd() + "\n", "utf8");
}
export function writeJson(p: string, data: unknown): void {
  writeText(p, JSON.stringify(data, null, 2));
}
export const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80) || "task";
export const within = (p: string, root: string) => {
  const r = path.relative(path.resolve(root), path.resolve(p));
  return (
    r === "" ||
    (!r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r))
  );
};
export const relative = (p: string, root: string) =>
  within(p, root) ? slash(path.relative(root, p)) : slash(path.resolve(p));
export const hash = (p: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
export const unique = <T>(items: T[]) => [...new Set(items)];
export const now = () => performance.now() / 1000;
export const round = (n: number) => Math.round(n * 1000) / 1000;
export const stamp = () =>
  `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
export const IGNORED = new Set([
  ".git",
  ".hvigor",
  // DevEco Code TD.52 generates its own database, locks and logs here.
  // Never copy, hash, review or synchronize live agent runtime state.
  ".homegraph",
  ".cache",
  ".test",
  "build",
  "coverage",
  "oh_modules",
  "node_modules",
]);
export const isTest = (p: string) =>
  /\/src\/(?:test|ohostest)\//i.test("/" + slash(p));
export function* walk(
  root: string,
  ignored: Set<string> = IGNORED,
): Generator<string> {
  if (!isDir(root)) return;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (ignored.has(item.name) || item.isSymbolicLink()) continue;
    const p = path.join(root, item.name);
    if (item.isDirectory()) yield* walk(p, ignored);
    else if (item.isFile()) yield p;
  }
}
export const sourceFiles = (root: string) =>
  [...walk(root)].filter((p) => /\.(ets|ts)$/i.test(p));
export function parents(p: string, root?: string): string[] {
  const a: string[] = [];
  let current = path.resolve(p);
  while (true) {
    a.push(current);
    if (root && current === path.resolve(root)) break;
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return a;
}
export function copyFile(source: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}
export function copyTree(
  source: string,
  dest: string,
  excludeTests = false,
): void {
  if (within(dest, source)) throw new Error("副本目录不能位于来源工程内部");
  fs.mkdirSync(dest, { recursive: true });
  for (const p of walk(source)) {
    const r = path.relative(source, p);
    if (excludeTests && isTest(r)) continue;
    copyFile(p, path.join(dest, r));
  }
}
export function removeGenerated(p: string, root: string): void {
  if (!within(p, root) || path.resolve(p) === path.resolve(root))
    throw new Error("拒绝删除边界外目录或根目录");
  fs.rmSync(p, {
    recursive: true,
    force: true,
    maxRetries: 2,
    retryDelay: 100,
  });
}
