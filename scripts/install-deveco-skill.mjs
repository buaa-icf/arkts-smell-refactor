#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(repository, "skills/arkts-smell-refactor");
const usage = `Usage: node scripts/install-deveco-skill.mjs --project <directory>
       [--config <existing.json>] [--studio <directory>] [--runs <directory>]
       [--dry-run] [--force]
Or use --config alone when it contains an absolute projectRoot.
Existing config files are reused unchanged; --studio and --runs apply only to generated settings.
--force preserves the previous installation in .deveco/arkts-skill-backups/.
`;

function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (
      ![
        "--project",
        "--config",
        "--studio",
        "--runs",
        "--dry-run",
        "--force",
      ].includes(flag) ||
      Object.hasOwn(options, flag)
    )
      throw new Error(`参数无效或重复：${flag}`);
    if (["--dry-run", "--force"].includes(flag)) options[flag] = true;
    else {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("--"))
        throw new Error(`参数缺少值：${flag}`);
      options[flag] = value;
    }
  }
  if (!options["--project"] && !options["--config"])
    throw new Error("需要 --project 或 --config");
  if (options["--config"] && (options["--studio"] || options["--runs"]))
    throw new Error(
      "使用 --config 时请在原配置中设置 studio/runs，不能同时传 --studio/--runs",
    );
  return options;
}

function info(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function within(root, target) {
  const name = path.relative(root, target);
  return (
    name === "" ||
    (!path.isAbsolute(name) &&
      name !== ".." &&
      !name.startsWith(`..${path.sep}`))
  );
}

function noLinks(file) {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of path
    .relative(root, absolute)
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

function noTreeLinks(directory) {
  const stat = info(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Skill 必须是普通目录：${directory}`);
  for (const entry of fs.readdirSync(directory)) {
    const file = path.join(directory, entry);
    const child = fs.lstatSync(file);
    if (child.isSymbolicLink())
      throw new Error(`Skill 内不支持符号链接或 junction：${file}`);
    if (child.isDirectory()) noTreeLinks(file);
    else if (!child.isFile()) throw new Error(`Skill 内不是普通文件：${file}`);
  }
}

function canonical(file) {
  try {
    return fs.realpathSync.native(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(canonical(parent), path.basename(file));
  }
}

function projectPath(project, file) {
  const absolute = path.resolve(file);
  if (absolute === project || !within(project, absolute))
    throw new Error(`安装路径超出工程：${file}`);
  noLinks(absolute);
  if (!within(project, canonical(absolute)))
    throw new Error(`安装实际路径超出工程：${file}`);
  return absolute;
}

function absoluteSettings(config) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("配置必须为 JSON 对象");
  if (
    typeof config.projectRoot !== "string" ||
    !path.isAbsolute(config.projectRoot)
  )
    throw new Error("现有配置的 projectRoot 必须是绝对路径");
  for (const key of ["backend", "runs", "bridgePath", "studio", "homecheck"]) {
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "string" ||
        (config[key] && !path.isAbsolute(config[key])))
    )
      throw new Error(`现有配置的 ${key} 必须是绝对路径（可选工具路径可留空）`);
    if (["backend", "runs", "bridgePath"].includes(key) && config[key] === "")
      throw new Error(`现有配置的 ${key} 不能为空`);
  }
  if (config.node !== undefined && !config.node.trim())
    throw new Error("现有配置的 node 不能为空");
  for (const key of ["node", "deveco", "hvigor", "ohpm", "linter"]) {
    const value = config[key];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        value.includes("\0") ||
        (/[\\/]/.test(value) && !path.isAbsolute(value)))
    )
      throw new Error(`现有配置的 ${key} 必须是绝对路径或 PATH 命令名`);
  }
  if (
    config.linterMode !== undefined &&
    !["required", "skip"].includes(config.linterMode)
  )
    throw new Error("linterMode 必须为 required 或 skip");
  if (
    config.timeoutMs !== undefined &&
    (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100)
  )
    throw new Error("timeoutMs 必须是至少 100 的整数");
}

function install(args) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19))
    throw new Error("需要 Node.js >=20.19");
  const options = parse(args);
  const externalSettings = options["--config"]
    ? path.resolve(options["--config"])
    : undefined;
  let settings;
  if (externalSettings) {
    settings = JSON.parse(
      fs.readFileSync(externalSettings, "utf8").replace(/^\uFEFF/, ""),
    );
    absoluteSettings(settings);
  }
  const requested = path.resolve(options["--project"] ?? settings.projectRoot);
  noLinks(requested);
  if (!info(requested)?.isDirectory())
    throw new Error(`工程目录不存在：${requested}`);
  const projectRoot = fs.realpathSync.native(requested);
  if (settings && fs.realpathSync.native(settings.projectRoot) !== projectRoot)
    throw new Error("--project 与现有配置的 projectRoot 不一致");
  const skillDirectory = projectPath(
    projectRoot,
    path.join(projectRoot, ".deveco/skills/arkts-smell-refactor"),
  );
  if (externalSettings && within(skillDirectory, canonical(externalSettings)))
    throw new Error(
      "--config 请使用安装目录之外的配置文件，避免更新安装后绑定路径失效",
    );
  const hash = createHash("sha256")
    .update(projectRoot)
    .digest("hex")
    .slice(0, 16);
  if (!settings) {
    const data =
      process.platform === "win32"
        ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local")
        : path.join(os.homedir(), ".local/share");
    settings = {
      projectRoot,
      backend: repository,
      node: process.execPath,
      studio:
        options["--studio"] || process.env.DEVECO_HOME
          ? path.resolve(options["--studio"] || process.env.DEVECO_HOME)
          : "",
      runs: options["--runs"]
        ? path.resolve(options["--runs"])
        : path.resolve(data, "arkts-smell-refactor/runs", hash),
      linterMode: "required",
    };
  }
  const backend = path.resolve(settings.backend || repository);
  const runs = path.resolve(
    settings.runs ||
      path.join(
        os.tmpdir(),
        "arkts-refactor-tui",
        createHash("sha256")
          .update(path.resolve(settings.projectRoot))
          .digest("hex")
          .slice(0, 16),
        "runs",
      ),
  );
  if (within(projectRoot, canonical(runs)))
    throw new Error("runs 必须位于业务工程之外");
  if (!info(path.join(backend, "dist/skill.js"))?.isFile())
    throw new Error(
      `找不到 ${path.join(backend, "dist/skill.js")}；请先在后端目录运行 npm ci && npm run build`,
    );
  noLinks(source);
  noTreeLinks(source);
  const old = info(skillDirectory);
  if (old) {
    noTreeLinks(skillDirectory);
    if (!options["--force"])
      throw new Error(
        `Skill 已存在：${skillDirectory}；使用 --force 先备份再更新`,
      );
  }
  const settingsFile =
    externalSettings || path.join(skillDirectory, "settings.json");
  const backupDirectory = old
    ? projectPath(
        projectRoot,
        path.join(
          projectRoot,
          ".deveco/arkts-skill-backups",
          `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
        ),
      )
    : undefined;
  const result = {
    ok: true,
    dryRun: !!options["--dry-run"],
    projectRoot,
    skillDirectory,
    backend,
    settingsFile,
    runs,
    ...(backupDirectory ? { backupDirectory } : {}),
  };
  if (options["--dry-run"]) return result;

  const staging = projectPath(
    projectRoot,
    path.join(
      path.dirname(skillDirectory),
      `.arkts-smell-refactor-stage-${randomUUID()}`,
    ),
  );
  fs.mkdirSync(projectPath(projectRoot, path.dirname(staging)), {
    recursive: true,
  });
  let movedPrevious = false;
  try {
    fs.cpSync(source, projectPath(projectRoot, staging), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    });
    noTreeLinks(staging);
    fs.writeFileSync(
      path.join(staging, "installation.json"),
      JSON.stringify({ schemaVersion: 1, backend, settingsFile }, null, 2) +
        "\n",
      { flag: "wx" },
    );
    if (!externalSettings)
      fs.writeFileSync(
        path.join(staging, "settings.json"),
        JSON.stringify(settings, null, 2) + "\n",
        { flag: "wx" },
      );
    if (backupDirectory) {
      fs.mkdirSync(projectPath(projectRoot, path.dirname(backupDirectory)), {
        recursive: true,
      });
      noTreeLinks(projectPath(projectRoot, skillDirectory));
      fs.renameSync(skillDirectory, projectPath(projectRoot, backupDirectory));
      movedPrevious = true;
    } else if (info(projectPath(projectRoot, skillDirectory))) {
      throw new Error("安装目标在准备期间出现，请重新检查后重试");
    }
    fs.renameSync(
      projectPath(projectRoot, staging),
      projectPath(projectRoot, skillDirectory),
    );
  } catch (error) {
    let recovery = "";
    if (movedPrevious) {
      try {
        if (info(projectPath(projectRoot, skillDirectory)))
          recovery = "\n安装目标已出现，保留备份供人工恢复";
        else {
          noTreeLinks(projectPath(projectRoot, backupDirectory));
          fs.renameSync(
            backupDirectory,
            projectPath(projectRoot, skillDirectory),
          );
          recovery = "\n旧版已恢复到原安装目录";
        }
      } catch (restoreError) {
        recovery = `\n旧版自动恢复失败：${restoreError.message}；备份仍保留在 ${backupDirectory}`;
      }
    }
    throw new Error(
      `${error.message}\n暂存目录：${staging}${backupDirectory ? `\n备份路径：${backupDirectory}` : ""}${recovery}`,
    );
  }
  return result;
}

try {
  if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2]))
    process.stdout.write(usage);
  else
    process.stdout.write(JSON.stringify(install(process.argv.slice(2))) + "\n");
} catch (error) {
  process.stderr.write(`安装失败：${error.message}\n`);
  process.exitCode = 2;
}
