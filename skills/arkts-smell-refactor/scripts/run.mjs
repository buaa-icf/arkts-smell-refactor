#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19))
    throw new Error("需要 Node.js >=20.19");
  const args = process.argv.slice(2);
  if (args.some((arg) => /^--(?:config|project|backend|runs)(?:=|$)/.test(arg)))
    throw new Error(
      "此 Skill 已绑定工程和配置，不接受 --config/--project/--backend/--runs 覆盖；请重新安装以改变绑定",
    );
  const binding = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../installation.json",
  );
  if (!fs.existsSync(binding))
    throw new Error(
      "请先运行工具仓库的 scripts/install-deveco-skill.mjs 安装 Skill，再使用安装目录中的 scripts/run.mjs",
    );
  const installation = JSON.parse(fs.readFileSync(binding, "utf8"));
  if (
    installation.schemaVersion !== 1 ||
    typeof installation.backend !== "string" ||
    !path.isAbsolute(installation.backend) ||
    typeof installation.settingsFile !== "string" ||
    !path.isAbsolute(installation.settingsFile)
  )
    throw new Error("Skill 安装绑定无效，请重新安装");
  const cli = path.join(installation.backend, "dist/skill.js");
  if (!fs.existsSync(cli))
    throw new Error(
      "找不到 dist/skill.js，请在绑定的后端目录运行 npm ci && npm run build",
    );
  if (!fs.existsSync(installation.settingsFile))
    throw new Error(
      `绑定配置不存在：${installation.settingsFile}；请重新安装或恢复配置`,
    );
  const help =
    args.length === 0 ||
    (args.length === 1 && ["help", "--help", "-h"].includes(args[0]));
  const { runSkill } = await import(pathToFileURL(cli).href);
  process.exitCode = await runSkill(
    help ? args : [...args, "--config", installation.settingsFile],
  );
} catch (error) {
  process.stderr.write(`启动失败：${error.message}\n`);
  process.exitCode = 2;
}
