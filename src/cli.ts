#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discoverTools, prepareTask, runInteractive } from "./automatic.js";
import { loadDatasetTasks } from "./dataset.js";
import { executePipeline, loadConfig } from "./runner.js";
import { isDir, isFile, readJson, writeJson } from "./utils.js";
import { installCancellationHandlers } from "./process.js";
export const userConfigPath = () =>
  path.join(
    process.platform === "win32" && process.env.APPDATA
      ? process.env.APPDATA
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")),
    "arkts-smell-refactor/config.json",
  );
export function defaultWorkspace(explicit?: string): string | undefined {
  if (explicit) return path.resolve(explicit);
  if (process.env.ARKTS_REFACTOR_WORKSPACE)
    return path.resolve(process.env.ARKTS_REFACTOR_WORKSPACE);
  const file = userConfigPath();
  return isFile(file) && readJson(file).workspace
    ? path.resolve(readJson(file).workspace)
    : undefined;
}
const HELP = `ArkTS 异味重构工具（TypeScript / Node.js）

node dist/cli.js configure --workspace <仓库总目录>
node dist/cli.js doctor [--workspace <仓库总目录>]
node dist/cli.js start [--workspace <仓库总目录>] [--linter-mode required|skip]
node dist/cli.js prepare --dataset <JSON> --workspace <仓库总目录> --output <任务目录> [--index N]
node dist/cli.js run --task-dir <任务目录> --config <JSON> [--dry-run]

npm start 会执行 start；npm run cli -- <子命令> 可执行其他命令。`;
export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const command = argv[0],
    { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        workspace: { type: "string" },
        dataset: { type: "string" },
        output: { type: "string" },
        index: { type: "string" },
        "task-dir": { type: "string" },
        config: { type: "string" },
        "dry-run": { type: "boolean" },
        "linter-mode": { type: "string", default: "required" },
      },
    });
  if (positionals.length)
    throw new Error("不支持的位置参数：" + positionals.join(" "));
  const required = (
    key: "workspace" | "dataset" | "output" | "task-dir" | "config",
  ) => {
    const v = values[key];
    if (!v) throw new Error("缺少 --" + key);
    return path.resolve(v);
  };
  if (command === "configure") {
    const workspace = required("workspace");
    if (!isDir(workspace)) throw new Error("工作区目录不存在：" + workspace);
    writeJson(userConfigPath(), { workspace });
    console.log(
      `已保存默认工作区：${workspace}\n配置文件：${userConfigPath()}`,
    );
    return 0;
  }
  if (command === "doctor") {
    const workspace = defaultWorkspace(values.workspace);
    console.log(`Node.js：${process.execPath}\n用户配置：${userConfigPath()}`);
    if (!workspace) {
      console.log("工作区未配置，请执行 configure --workspace <目录>");
      return 2;
    }
    console.log("工作区：" + workspace);
    const tools = discoverTools(workspace);
    for (const [k, v] of Object.entries(tools))
      console.log(`${k}：${v ?? "未找到"}`);
    return isDir(workspace) && Object.values(tools).every(Boolean) ? 0 : 2;
  }
  if (command === "prepare") {
    const index = values.index === undefined ? undefined : Number(values.index);
    if (index !== undefined && (!Number.isInteger(index) || index < 1))
      throw new Error("--index 必须为正整数");
    const tasks = loadDatasetTasks(
        required("dataset"),
        required("workspace"),
        index,
      ),
      output = required("output"),
      prepared = [];
    for (const task of tasks) {
      const taskDir = path.join(output, task.task_id);
      prepareTask(task, taskDir);
      prepared.push({ taskId: task.task_id, taskDir });
      console.log("prepared: " + task.task_id);
    }
    writeJson(path.join(output, "index.json"), prepared);
    console.log(`共生成 ${tasks.length} 个任务：${output}`);
    return 0;
  }
  if (command === "run") {
    const result = await executePipeline(
      required("task-dir"),
      loadConfig(required("config")),
      values["dry-run"] ?? false,
    );
    console.log("verdict: " + result.verdict);
    return ["PASS", "DRY_RUN"].includes(result.verdict) ? 0 : 2;
  }
  if (command === "start") {
    const mode = values["linter-mode"];
    if (mode !== "required" && mode !== "skip")
      throw new Error("--linter-mode 必须为 required 或 skip");
    const base = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const final = await runInteractive(
      base,
      defaultWorkspace(values.workspace),
      mode,
    );
    return final.tasks.every((t: { verdict: string }) => t.verdict === "PASS")
      ? 0
      : 2;
  }
  throw new Error("未知命令：" + command);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  installCancellationHandlers();
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error("error: " + e.message);
      process.exitCode = 2;
    });
}
