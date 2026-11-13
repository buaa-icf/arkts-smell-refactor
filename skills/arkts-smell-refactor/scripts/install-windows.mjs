#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// End-user installation uses only Node.js built-ins. No TypeScript or npm step.
const args = process.argv.slice(2).filter((arg) => arg !== "--no-pause");
const usage = `安装到当前用户的 DevEco Skill 目录，无须管理员权限。
默认自动备份并更新旧安装，保留工具配置。

双击 install.bat 即可安装。
命令行：install.bat --no-pause [--studio "SDK所在安装目录"] [--config "工具设置.json"]
预览：  install.bat --no-pause --dry-run

--no-pause 放在首个参数，执行结束后不等待按键。
安装脚本为普通 JavaScript，不需要 TypeScript、npm 或开发仓库。
`;

function main() {
  if (args.some((arg) => ["--help", "-h"].includes(arg))) {
    process.stdout.write(usage);
    return 0;
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19)) {
    process.stderr.write("安装已停止：需要 Node.js 20.19 或更高版本。\n");
    return 3;
  }
  const installer = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "install.mjs",
  );
  if (!fs.existsSync(installer)) {
    process.stderr.write(
      "安装已停止：缺少 scripts/install.mjs。请完整解压发行 ZIP，再双击其中的 install.bat；不要只复制安装脚本。\n",
    );
    return 3;
  }
  process.stdout.write("正在检查并安装 Skill，请稍候……\n");
  const result = spawnSync(
    process.execPath,
    [installer, ...args, ...(args.includes("--force") ? [] : ["--force"])],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    process.stderr.write(
      "安装失败，已停止。\n" +
        (result.error?.message ||
          result.stderr ||
          result.stdout ||
          "安装进程未正常退出。") +
        "\n",
    );
    return result.status || 3;
  }
  const installed = JSON.parse(result.stdout);
  if (installed.ok !== true || !installed.skillDirectory)
    throw new Error("安装程序未返回成功结果。");
  if (installed.dryRun) {
    process.stdout.write(
      `预览完成，未写入文件。\n安装位置：${installed.skillDirectory}\n`,
    );
    return 0;
  }
  process.stdout.write(`安装成功。\n安装位置：${installed.skillDirectory}\n`);
  if (installed.backupDirectory)
    process.stdout.write(`旧版本备份：${installed.backupDirectory}\n`);
  process.stdout.write(
    "\n下一步：\n1. 退出并重新启动 DevEco Code。\n2. 在业务工程中输入 /skills，确认 arkts-smell-refactor。\n3. 在对话中要求使用此 Skill 检测代码；它会先检查依赖，缺项时说明原因并结束。\n",
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`安装失败，已停止：${error.message}\n`);
  process.exitCode = 3;
}
