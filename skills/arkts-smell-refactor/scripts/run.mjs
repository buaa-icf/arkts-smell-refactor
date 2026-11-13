#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let prerequisite = "runtime";

try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19)) {
    prerequisite = "Node.js";
    throw new Error("需要 Node.js >=20.19");
  }
  const skillRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const metadata = path.join(skillRoot, "installation.json");
  if (fs.existsSync(metadata)) {
    const installed = JSON.parse(fs.readFileSync(metadata, "utf8"));
    if (
      installed.schemaVersion !== 2 ||
      installed.runtime !== "runtime" ||
      installed.settingsFile !== "settings.json"
    )
      throw new Error("Skill 安装元数据无效，请使用独立制品重新安装");
  }
  const runtimeRoot = path.join(skillRoot, "runtime");
  const entry = path.join(runtimeRoot, "dist/portable_skill.js");
  if (!fs.existsSync(entry))
    throw new Error(
      "缺少独立 runtime，请使用完整 Skill 制品；开发时先运行 npm run package:skill",
    );
  const settingsFile = path.join(skillRoot, "settings.json");
  const { runPortableSkill } = await import(pathToFileURL(entry).href);
  process.exitCode = await runPortableSkill(process.argv.slice(2), {
    runtimeRoot,
    ...(fs.existsSync(settingsFile) ? { settingsFile } : {}),
  });
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: process.argv[2],
      result: {
        verdict: "BLOCKED",
        stop: true,
        missing: [
          {
            name: prerequisite,
            reason: error.message,
            action:
              prerequisite === "Node.js"
                ? "安装受支持的 Node.js 后重试"
                : "重新获取并安装完整独立 Skill 制品；开发时运行 npm run package:skill",
          },
        ],
      },
    }) + "\n",
  );
  process.exitCode = 3;
}
