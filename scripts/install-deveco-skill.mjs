#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  info,
  within,
  noLinks,
  canonical,
  checkedPath,
  files,
  validatePackage,
} from "./skill-package-integrity.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packaged = info(path.join(scriptDirectory, "../package-manifest.json"));
const defaultPackage = path.resolve(
  scriptDirectory,
  packaged ? ".." : "../releases/arkts-smell-refactor",
);
const usage = `Usage: node scripts/install.mjs [--package <complete-skill-directory>]
       [--config <tool-settings.json>] [--studio <directory>] [--dry-run] [--force]
Installs an offline Skill for this user in ~/.config/deveco/skills/arkts-smell-refactor.
An absolute XDG_CONFIG_HOME overrides ~/.config. No business project is selected during installation.
--config copies only tool settings; old backend/projectRoot/runs/node values are discarded.
Select a project at runtime from the current directory or with scripts/run.mjs <command> --project <directory>.
--force backs up the previous Skill before replacing it.
`;
const toolKeys = [
  "studio",
  "deveco",
  "hvigor",
  "ohpm",
  "linter",
  "linterMode",
  "timeoutMs",
];

function parse(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (["--project", "--runs"].includes(flag))
      throw new Error(
        `${flag} 不用于安装；请在运行 scripts/run.mjs 时选择 --project 或 --config`,
      );
    if (
      !["--package", "--config", "--studio", "--dry-run", "--force"].includes(
        flag,
      ) ||
      Object.hasOwn(options, flag)
    )
      throw new Error(`参数无效或重复：${flag}`);
    if (["--dry-run", "--force"].includes(flag)) options[flag] = true;
    else {
      const value = args[++index];
      if (!value?.trim() || value.startsWith("--"))
        throw new Error(`参数缺少值：${flag}`);
      options[flag] = value;
    }
  }
  return options;
}

function readSettings(file, purpose) {
  try {
    const input = JSON.parse(
      fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
    );
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("必须是 JSON 对象");
    return input;
  } catch (error) {
    throw new Error(`无法读取${purpose} ${file}：${error.message}`);
  }
}

function previousSettings(skillDirectory) {
  const local = path.join(skillDirectory, "settings.json");
  if (info(local)) return local;
  const metadata = path.join(skillDirectory, "installation.json");
  if (!info(metadata)) return undefined;
  const installation = readSettings(metadata, "旧安装元数据");
  const reference = installation.settingsFile ?? installation.configFile;
  if (reference === undefined) return undefined;
  if (typeof reference !== "string" || !reference.trim())
    throw new Error(`旧安装配置引用无效：${metadata}`);
  return path.resolve(skillDirectory, reference);
}

function toolSettings(options, previous) {
  const settings = { linterMode: "required" };
  const ignoredSettings = new Set();
  for (const [file, purpose] of [
    [previous, "旧工具配置"],
    [options["--config"] && path.resolve(options["--config"]), "工具配置"],
  ]) {
    if (!file) continue;
    const input = readSettings(file, purpose);
    for (const key of Object.keys(input)) {
      if (toolKeys.includes(key)) settings[key] = input[key];
      else ignoredSettings.add(key);
    }
  }
  if (options["--studio"]) settings.studio = path.resolve(options["--studio"]);
  for (const key of ["studio", "deveco", "hvigor", "ohpm", "linter"]) {
    const value = settings[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      (value &&
        (key === "studio" || /[\\/]/.test(value)) &&
        !path.isAbsolute(value))
    )
      throw new Error(`${key} 必须是绝对路径或 PATH 命令名；可选工具可留空`);
  }
  if (!["required", "skip"].includes(settings.linterMode))
    throw new Error("linterMode 必须为 required 或 skip");
  if (
    settings.timeoutMs !== undefined &&
    (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 100)
  )
    throw new Error("timeoutMs 必须是至少 100 的整数");
  return {
    settings,
    ignoredSettings: [...ignoredSettings],
  };
}

function install(args) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19))
    throw new Error("需要 Node.js >=20.19");
  const options = parse(args);
  const source = path.resolve(options["--package"] || defaultPackage);
  if (!info(source))
    throw new Error(
      `找不到完整 Skill 制品：${source}；请先运行 npm run package:skill，或用 --package 指定已解压的制品`,
    );
  validatePackage(source);
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  if (!path.isAbsolute(configHome))
    throw new Error("XDG_CONFIG_HOME 必须是绝对路径");
  noLinks(path.join(configHome, "deveco"));
  const configDirectory = canonical(path.join(configHome, "deveco"));
  const skillDirectory = checkedPath(
    configDirectory,
    path.join(configDirectory, "skills/arkts-smell-refactor"),
  );
  if (within(skillDirectory, canonical(source)))
    throw new Error("请从安装目录之外的原始制品执行安装");
  const old = info(skillDirectory);
  if (old) {
    files(skillDirectory);
    if (!options["--force"])
      throw new Error(
        `Skill 已存在：${skillDirectory}；使用 --force 先备份再更新`,
      );
  }
  const { settings, ignoredSettings } = toolSettings(
    options,
    old ? previousSettings(skillDirectory) : undefined,
  );
  const backupDirectory = old
    ? checkedPath(
        configDirectory,
        path.join(
          configDirectory,
          "arkts-skill-backups",
          `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
        ),
      )
    : undefined;
  const result = {
    ok: true,
    dryRun: !!options["--dry-run"],
    scope: "user",
    configDirectory,
    skillDirectory,
    runtimeDirectory: path.join(skillDirectory, "runtime"),
    settingsFile: path.join(skillDirectory, "settings.json"),
    ignoredSettings,
    ...(backupDirectory ? { backupDirectory } : {}),
  };
  if (options["--dry-run"]) return result;
  const staging = checkedPath(
    configDirectory,
    path.join(
      path.dirname(skillDirectory),
      `.arkts-smell-refactor-stage-${randomUUID()}`,
    ),
  );
  fs.mkdirSync(checkedPath(configDirectory, path.dirname(staging)), {
    recursive: true,
  });
  let movedPrevious = false;
  try {
    fs.cpSync(source, checkedPath(configDirectory, staging), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    });
    validatePackage(staging);
    fs.writeFileSync(
      path.join(staging, "installation.json"),
      JSON.stringify(
        { schemaVersion: 2, runtime: "runtime", settingsFile: "settings.json" },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    fs.writeFileSync(
      path.join(staging, "settings.json"),
      JSON.stringify(settings, null, 2) + "\n",
      { flag: "wx" },
    );
    if (backupDirectory) {
      fs.mkdirSync(
        checkedPath(configDirectory, path.dirname(backupDirectory)),
        { recursive: true },
      );
      files(checkedPath(configDirectory, skillDirectory));
      fs.renameSync(
        skillDirectory,
        checkedPath(configDirectory, backupDirectory),
      );
      movedPrevious = true;
    } else if (info(checkedPath(configDirectory, skillDirectory)))
      throw new Error("安装目标在准备期间出现，请检查后重试");
    fs.renameSync(
      checkedPath(configDirectory, staging),
      checkedPath(configDirectory, skillDirectory),
    );
  } catch (error) {
    let recovery = "";
    if (movedPrevious) {
      try {
        if (info(checkedPath(configDirectory, skillDirectory)))
          recovery = "\n安装目标已出现，保留备份供人工恢复";
        else {
          files(checkedPath(configDirectory, backupDirectory));
          fs.renameSync(
            backupDirectory,
            checkedPath(configDirectory, skillDirectory),
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
