#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonical,
  checkedPath,
  digest,
  files,
  info,
  noLinks,
  validatePackage,
  within,
} from "./skill-package-integrity.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const skillSource = path.join(repository, "skills/arkts-smell-refactor");
const bridgeRelative = "deveco-plugin/src/main/resources/bridge";
const readJson = (file) =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};

function parse(args) {
  let output = path.join(repository, "releases/arkts-smell-refactor");
  let force = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`重复参数：${flag}`);
    seen.add(flag);
    if (flag === "--force") force = true;
    else if (
      flag === "--output" &&
      args[index + 1] &&
      !args[index + 1].startsWith("--")
    )
      output = path.resolve(args[++index]);
    else throw new Error(`参数无效：${flag}`);
  }
  noLinks(output);
  output = canonical(output);
  if (within(output, repository))
    throw new Error("输出目录不能是仓库本身或仓库的祖先目录");
  for (const source of [
    "src",
    "node_modules",
    "skills",
    "scripts",
    "deveco-plugin",
  ])
    if (within(path.join(repository, source), output))
      throw new Error("输出目录不能覆盖源码或依赖");
  if (!force && (info(output) || info(output + ".tgz")))
    throw new Error("制品已存在；使用 --force 备份旧制品后重新打包");
  return { output, force };
}

function sourceDigest() {
  const inputs = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "scripts/package-skill.mjs",
    "scripts/install-deveco-skill.mjs",
    "scripts/skill-package-integrity.mjs",
    ...files(path.join(repository, "src")).map((name) => "src/" + name),
    ...files(skillSource).map((name) => "skills/arkts-smell-refactor/" + name),
    ...["ide_bridge.cjs", "homecheck_scan.cjs"].map(
      (name) => `${bridgeRelative}/${name}`,
    ),
  ];
  return digest(
    JSON.stringify(
      inputs
        .sort()
        .map((name) => [
          name,
          digest(fs.readFileSync(path.join(repository, name))),
        ]),
    ),
  );
}

function copyPackage(source, target) {
  noLinks(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    filter(file) {
      if (path.basename(file) === ".bin") return false;
      if (fs.lstatSync(file).isSymbolicLink())
        throw new Error(`依赖不能包含链接：${file}`);
      return true;
    },
  });
}

function productionDependencies(runtime, rootPackage, lock) {
  const visited = new Map();
  function locate(name, from, optional) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
      throw new Error(`依赖名称无效：${name}`);
    let current = from;
    while (within(repository, current)) {
      const directory = path.join(current, "node_modules", name);
      if (info(path.join(directory, "package.json"))) return directory;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (optional) return undefined;
    throw new Error(`缺少生产依赖 ${name}；请先在维护仓库运行 npm ci`);
  }
  function visit(name, from, optional = false) {
    const directory = locate(name, from, optional);
    if (!directory) return;
    const relative = path.relative(repository, directory).replaceAll("\\", "/");
    if (visited.has(relative)) return;
    const pkg = readJson(path.join(directory, "package.json"));
    if (pkg.name !== name || lock.packages?.[relative]?.version !== pkg.version)
      throw new Error(`已安装依赖与 package-lock.json 不一致：${relative}`);
    visited.set(relative, {
      name,
      version: pkg.version,
      path: relative,
      license: pkg.license || "SEE LICENSE IN PACKAGE",
    });
    const destination = path.join(runtime, relative);
    if (!info(destination)) copyPackage(directory, destination);
    const optionalDependencies = pkg.optionalDependencies || {};
    for (const dep of Object.keys({
      ...pkg.dependencies,
      ...optionalDependencies,
    }))
      visit(dep, directory, Object.hasOwn(optionalDependencies, dep));
    for (const dep of Object.keys(pkg.peerDependencies || {}))
      visit(dep, directory, pkg.peerDependenciesMeta?.[dep]?.optional === true);
  }
  for (const name of Object.keys(rootPackage.dependencies || {}))
    visit(name, repository);
  return [...visited.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function build(args) {
  const { output, force } = parse(args);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const staging = checkedPath(
    parent,
    path.join(parent, `.arkts-skill-package-${randomUUID()}`),
  );
  fs.mkdirSync(staging);
  const inputDigest = sourceDigest();
  const pkg = readJson(path.join(repository, "package.json"));
  const lock = readJson(path.join(repository, "package-lock.json"));
  if (
    JSON.stringify(lock.packages?.[""]?.dependencies) !==
    JSON.stringify(pkg.dependencies)
  )
    throw new Error(
      "package.json 生产依赖与 lock 不一致，请更新 lock 后再打包",
    );
  for (const name of files(skillSource)) {
    if (
      /(^|\/)(?:runtime|node_modules|\.git|\.env[^/]*|installation\.json|settings\.json|package-manifest\.json)(?:\/|$)/.test(
        name,
      )
    )
      throw new Error(`Skill 源目录包含不应发布的文件：${name}`);
    const destination = path.join(staging, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(skillSource, name), destination);
  }
  for (const [source, destination] of [
    ["install-deveco-skill.mjs", "install.mjs"],
    ["skill-package-integrity.mjs", "skill-package-integrity.mjs"],
  ])
    fs.copyFileSync(
      path.join(repository, "scripts", source),
      path.join(staging, "scripts", destination),
    );
  const runtime = path.join(staging, "runtime");
  const compiler = path.join(repository, "node_modules/typescript/bin/tsc");
  if (!info(compiler)?.isFile())
    throw new Error("缺少构建工具；请先在维护仓库运行 npm ci");
  const compiled = spawnSync(
    process.execPath,
    [
      compiler,
      "-p",
      path.join(repository, "tsconfig.json"),
      "--outDir",
      path.join(runtime, "dist"),
      "--sourceMap",
      "false",
      "--declaration",
      "false",
      "--declarationMap",
      "false",
    ],
    { cwd: repository, encoding: "utf8", windowsHide: true },
  );
  if (compiled.error || compiled.status !== 0)
    throw new Error(
      `根 TypeScript 构建失败：${compiled.error?.message || compiled.stdout + compiled.stderr}`,
    );
  const dependencies = productionDependencies(runtime, pkg, lock);
  writeJson(path.join(runtime, "package.json"), {
    name: "@arkts-refactor/skill-runtime",
    version: pkg.version,
    private: true,
    type: "module",
    engines: pkg.engines,
    dependencies: Object.fromEntries(
      Object.keys(pkg.dependencies).map((name) => [
        name,
        readJson(path.join(repository, "node_modules", name, "package.json"))
          .version,
      ]),
    ),
  });
  for (const name of ["ide_bridge.cjs", "homecheck_scan.cjs"]) {
    const target = path.join(runtime, bridgeRelative, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repository, bridgeRelative, name), target);
  }
  for (const name of fs
    .readdirSync(repository)
    .filter((name) => /^(?:licen[sc]e|notice|copying)(?:\.|$)/i.test(name))) {
    if (info(path.join(repository, name))?.isFile()) {
      fs.mkdirSync(path.join(staging, "licenses"), { recursive: true });
      fs.copyFileSync(
        path.join(repository, name),
        path.join(staging, "licenses", name),
      );
    }
  }
  fs.writeFileSync(
    path.join(staging, "THIRD_PARTY_NOTICES.md"),
    "# Bundled production dependencies\n\nLicense and copyright files are retained in each package under runtime/node_modules.\nHomeCheck's additional bundled notices are in runtime/node_modules/@arkts-refactor/homecheck-runtime/THIRD_PARTY_NOTICES.md.\n\n" +
      dependencies
        .map(
          (item) =>
            `- ${item.name}@${item.version}: ${item.license} (${item.path})`,
        )
        .join("\n") +
      "\n",
  );
  const content = Object.fromEntries(
    files(staging).map((name) => [
      name,
      digest(fs.readFileSync(path.join(staging, name))),
    ]),
  );
  if (inputDigest !== sourceDigest())
    throw new Error(`打包期间源码发生变化，请重试；暂存制品：${staging}`);
  writeJson(path.join(staging, "package-manifest.json"), {
    schemaVersion: 1,
    format: "arkts-smell-refactor-portable",
    version: pkg.version,
    node: pkg.engines.node,
    sourceDigest: inputDigest,
    dependencies,
    files: content,
  });
  validatePackage(staging);
  if (!force && (info(output) || info(output + ".tgz")))
    throw new Error("目标制品在打包期间出现，已保留；请检查后重试");
  const stamp = `${Date.now()}-${randomUUID()}`;
  if (info(output)) {
    files(output);
    fs.renameSync(output, checkedPath(parent, `${output}.previous-${stamp}`));
  }
  if (info(output + ".tgz")) {
    noLinks(output + ".tgz");
    fs.renameSync(
      output + ".tgz",
      checkedPath(parent, `${output}.tgz.previous-${stamp}`),
    );
  }
  fs.renameSync(staging, checkedPath(parent, output));
  const archive = output + ".tgz";
  const temporaryArchive = checkedPath(
    parent,
    archive + ".tmp-" + randomUUID(),
  );
  const packed = spawnSync(
    "tar",
    ["-czf", temporaryArchive, "-C", parent, "--", path.basename(output)],
    { encoding: "utf8", windowsHide: true },
  );
  if (packed.error || packed.status !== 0)
    throw new Error(
      `完整目录已生成，但 tar 归档失败：${packed.error?.message || packed.stderr}`,
    );
  fs.renameSync(temporaryArchive, checkedPath(parent, archive));
  return {
    ok: true,
    directory: output,
    archive,
    files: Object.keys(content).length,
    productionPackages: dependencies.length,
    sourceDigest: inputDigest,
    archiveSha256: digest(fs.readFileSync(archive)),
  };
}

try {
  if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2]))
    process.stdout.write(
      "Usage: node scripts/package-skill.mjs [--output <directory>] [--force]\n",
    );
  else
    process.stdout.write(JSON.stringify(build(process.argv.slice(2))) + "\n");
} catch (error) {
  process.stderr.write(`打包失败：${error.message}\n`);
  process.exitCode = 2;
}
