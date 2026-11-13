import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const digest = (data) => createHash("sha256").update(data).digest("hex");
export function info(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
export function within(root, target) {
  const name = path.relative(root, target);
  return (
    name === "" ||
    (!path.isAbsolute(name) &&
      name !== ".." &&
      !name.startsWith(`..${path.sep}`))
  );
}
export function noLinks(file) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of path
    .relative(current, absolute)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const stat = info(current);
    if (!stat) break;
    if (stat.isSymbolicLink())
      throw new Error(`不支持符号链接或 junction：${current}`);
    if (current !== absolute && !stat.isDirectory())
      throw new Error(`祖先不是目录：${current}`);
  }
}
export function canonical(file) {
  try {
    return fs.realpathSync.native(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(canonical(parent), path.basename(file));
  }
}
export function checkedPath(root, file) {
  const absolute = path.resolve(file);
  if (absolute === root || !within(root, absolute))
    throw new Error(`路径超出目标目录：${file}`);
  noLinks(absolute);
  if (!within(root, canonical(absolute)))
    throw new Error(`实际路径超出目标目录：${file}`);
  return absolute;
}
export function files(root) {
  noLinks(root);
  if (!info(root)?.isDirectory()) throw new Error(`不是普通目录：${root}`);
  const result = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink())
        throw new Error(`不支持符号链接或 junction：${file}`);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile())
        result.push(path.relative(root, file).replaceAll("\\", "/"));
      else throw new Error(`不是普通文件：${file}`);
    }
  }
  visit(root);
  return result.sort();
}
export function validatePackage(root) {
  const names = files(root).filter((name) => name !== "package-manifest.json");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "package-manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.format !== "arkts-smell-refactor-portable" ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw new Error(
      "不是完整的独立 Skill 制品，请先运行 npm run package:skill",
    );
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error("制品文件清单不完整或包含额外文件");
  for (const name of names) {
    if (
      !/^[a-f0-9]{64}$/.test(manifest.files[name]) ||
      digest(fs.readFileSync(path.join(root, name))) !== manifest.files[name]
    )
      throw new Error(`制品文件校验失败：${name}`);
  }
  for (const name of [
    "SKILL.md",
    "scripts/run.mjs",
    "scripts/install.mjs",
    "scripts/skill-package-integrity.mjs",
    "runtime/package.json",
    "runtime/dist/portable_skill.js",
    "runtime/dist/ide_bridge.js",
    "runtime/node_modules/@arkts-refactor/homecheck-runtime/scan.cjs",
    "runtime/deveco-plugin/src/main/resources/bridge/ide_bridge.cjs",
    "runtime/deveco-plugin/src/main/resources/bridge/homecheck_scan.cjs",
  ])
    if (!Object.hasOwn(manifest.files, name))
      throw new Error(`制品缺少 ${name}`);
  return manifest;
}
