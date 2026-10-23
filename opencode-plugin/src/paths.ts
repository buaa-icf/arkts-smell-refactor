import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { within } from "./config.ts";

export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalPath(parent), basename(path));
  }
}

export async function safePath(root: string, name: string): Promise<string> {
  if (!name || isAbsolute(name) || /^[a-z]:/i.test(name) || name.includes("\\") ||
      name.split("/").some((part) => !part || part === ".." || part === ".") || name.includes(":")) {
    throw new Error(`不安全的相对路径：${name}`);
  }
  const target = resolve(root, name);
  if (!within(root, target)) throw new Error(`路径超出范围：${name}`);
  let current = root;
  // lstat detects both Windows junctions and symbolic links.
  for (const part of ["", ...name.split("/")]) {
    current = part ? resolve(current, part) : current;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`不支持链接路径：${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const actualRoot = await realpath(root);
  if (!within(actualRoot, await canonicalPath(target))) throw new Error(`实际路径超出范围：${name}`);
  return target;
}

export function productionPath(name: string): boolean {
  const parts = name.toLowerCase().split("/");
  if (parts.some((part) => ["test", "ohostest", "appscope"].includes(part))) return false;
  const path = "/" + parts.join("/");
  return path.includes("/src/main/resources/") ||
    (path.includes("/src/main/") && /\.(ets|ts)$/.test(path)) ||
    (parts.length >= 2 && parts.at(-1) === "index.ets");
}
