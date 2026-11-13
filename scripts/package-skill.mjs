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
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`重复参数：${flag}`);
    seen.add(flag);
    if (flag === "--force")
      continue; // Accepted for compatibility; replacement is now the default.
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
  checkOutput(output);
  return { output };
}

function checkOutput(output) {
  noLinks(output);
  if (info(output)) {
    files(output); // Refuse links anywhere inside a directory that may be replaced.
    const manifest = path.join(output, "package-manifest.json");
    if (
      !info(manifest)?.isFile() ||
      readJson(manifest).format !== "arkts-smell-refactor-portable"
    )
      throw new Error(`输出目录不是已有 Skill 制品，拒绝覆盖：${output}`);
  }
  for (const suffix of [".tgz", ".zip"]) {
    noLinks(output + suffix);
    const archive = info(output + suffix);
    if (archive && !archive.isFile())
      throw new Error(`归档目标不是普通文件：${output + suffix}`);
  }
}

/** Every recursive removal is confined to the explicitly checked artifact/transaction directory. */
function removeBuildPath(root, target) {
  const absolute = checkedPath(root, target),
    entry = info(absolute);
  if (!entry) return;
  if (entry.isDirectory()) files(absolute);
  else if (!entry.isFile())
    throw new Error(`清理目标不是普通文件或目录：${absolute}`);
  fs.rmSync(absolute, {
    recursive: entry.isDirectory(),
    maxRetries: 3,
    retryDelay: 100,
  });
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

function createZip(directory, archive) {
  if (process.platform === "win32") {
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    return spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:ARKTS_PACKAGE_DIRECTORY, $env:ARKTS_PACKAGE_ARCHIVE, [System.IO.Compression.CompressionLevel]::Optimal, $true, [System.Text.Encoding]::UTF8)",
      ],
      {
        env: {
          ...process.env,
          ARKTS_PACKAGE_DIRECTORY: directory,
          ARKTS_PACKAGE_ARCHIVE: archive,
        },
        encoding: "utf8",
        windowsHide: true,
      },
    );
  }
  return spawnSync("zip", ["-q", "-r", archive, path.basename(directory)], {
    cwd: path.dirname(directory),
    encoding: "utf8",
    windowsHide: true,
  });
}

function buildContents(staging) {
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
    if (/\.bat$/i.test(name)) {
      const batch = fs.readFileSync(path.join(skillSource, name), "utf8");
      fs.writeFileSync(destination, batch.replace(/\r\n|\r|\n/g, "\r\n"));
    } else fs.copyFileSync(path.join(skillSource, name), destination);
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
    throw new Error("打包期间源码发生变化，请重试");
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
  return {
    files: Object.keys(content).length,
    productionPackages: dependencies.length,
    sourceDigest: inputDigest,
  };
}

/** Retain the old set only while publishing, then delete it with the transaction directory. */
function publish(output, staging, transaction) {
  const parent = path.dirname(output),
    previous = path.join(transaction, "previous");
  checkOutput(output);
  fs.mkdirSync(checkedPath(transaction, previous));
  const entries = ["", ".tgz", ".zip"].map((suffix) => ({
    target: checkedPath(parent, output + suffix),
    next: checkedPath(transaction, staging + suffix),
    old: checkedPath(
      transaction,
      path.join(previous, path.basename(output) + suffix),
    ),
  }));
  const moved = [],
    published = [];
  try {
    for (const entry of entries) {
      if (!info(entry.target)) continue;
      fs.renameSync(entry.target, entry.old);
      moved.push(entry);
    }
    for (const entry of entries) {
      fs.renameSync(entry.next, entry.target);
      published.push(entry);
    }
  } catch (error) {
    try {
      for (const entry of published.reverse())
        removeBuildPath(parent, entry.target);
      for (const entry of moved.reverse()) {
        if (info(entry.target))
          throw new Error(`恢复位置被占用：${entry.target}`);
        fs.renameSync(
          checkedPath(transaction, entry.old),
          checkedPath(parent, entry.target),
        );
      }
    } catch (recovery) {
      const failure = new Error(
        `发布失败：${error.message}；恢复失败：${recovery.message}；恢复材料已保留在 ${transaction}`,
      );
      failure.preserveTransaction = true;
      throw failure;
    }
    throw error;
  }
}

function build(args) {
  const { output } = parse(args),
    parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const lockPath = checkedPath(
    parent,
    path.join(parent, `.${path.basename(output)}.package.lock`),
  );
  let lock;
  try {
    lock = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `已有打包任务或中断遗留锁：${lockPath}；请确认原任务已结束后处理`,
      );
    throw error;
  }
  const transaction = checkedPath(
    parent,
    path.join(parent, `.arkts-skill-package-${randomUUID()}`),
  );
  let preserveTransaction = false;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const staging = path.join(transaction, "next", path.basename(output));
    fs.mkdirSync(checkedPath(parent, staging), { recursive: true });
    const metadata = buildContents(staging);
    const packed = spawnSync(
      "tar",
      [
        "-czf",
        staging + ".tgz",
        "-C",
        path.dirname(staging),
        "--",
        path.basename(staging),
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (packed.error || packed.status !== 0)
      throw new Error(
        `tar 归档失败：${packed.error?.message || packed.stderr}`,
      );
    const zipped = createZip(staging, staging + ".zip");
    if (zipped.error || zipped.status !== 0)
      throw new Error(
        `ZIP 归档失败（Windows 需要系统 PowerShell，其他平台需要 zip）：${zipped.error?.message || zipped.stderr}`,
      );
    for (const suffix of [".tgz", ".zip"]) {
      const archive = info(staging + suffix);
      if (!archive?.isFile() || !archive.size)
        throw new Error(`归档未生成有效文件：${staging + suffix}`);
    }
    validatePackage(staging);
    if (metadata.sourceDigest !== sourceDigest())
      throw new Error("打包期间源码发生变化，请重试");
    const archiveSha256 = digest(fs.readFileSync(staging + ".tgz")),
      zipSha256 = digest(fs.readFileSync(staging + ".zip"));
    publish(output, staging, transaction);
    return {
      ok: true,
      directory: output,
      archive: output + ".tgz",
      zipArchive: output + ".zip",
      ...metadata,
      archiveSha256,
      zipSha256,
    };
  } catch (error) {
    preserveTransaction = error.preserveTransaction === true;
    throw error;
  } finally {
    try {
      if (!preserveTransaction) removeBuildPath(parent, transaction);
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(checkedPath(parent, lockPath));
    }
  }
}

try {
  if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2]))
    process.stdout.write(
      "Usage: node scripts/package-skill.mjs [--output <directory>] [--force]\nReplaces the latest directory, ZIP and TGZ only after a successful build. --force is accepted for compatibility.\n",
    );
  else
    process.stdout.write(JSON.stringify(build(process.argv.slice(2))) + "\n");
} catch (error) {
  process.stderr.write(`打包失败：${error.message}\n`);
  process.exitCode = 2;
}
