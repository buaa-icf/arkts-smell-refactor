import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PluginConfig {
  projectRoot: string;
  backend: string;
  bridgePath: string;
  python: string;
  runs: string;
  homecheck: string;
  studio: string;
  node: string;
  deveco: string;
  hvigor: string;
  ohpm: string;
  linter: string;
  linterMode: "required" | "skip";
  timeoutMs: number;
}
export function within(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export async function loadConfig(options: Record<string, unknown> = {}, directory = process.cwd()): Promise<PluginConfig> {
  let file: Record<string, unknown> = {};
  if (options.configFile !== undefined) {
    if (typeof options.configFile !== "string") throw new Error("configFile 必须为路径字符串");
    const configPath = resolve(directory, options.configFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const hint = error instanceof SyntaxError
        ? '\nWindows 路径的反斜杠必须转义：请使用 D:/path/to/project，或 D:\\\\path\\\\to\\\\project。'
        : '\n请确认设置文件存在且可以读取。';
      throw new Error(`无法加载 ArkTS 设置文件：${configPath}\n${reason}${hint}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("插件设置必须为 JSON 对象");
    file = parsed as Record<string, unknown>;
  }
  const input = { ...file, ...options };
  const path = (name: string, fallback: string) => {
    const value = input[name] ?? fallback;
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须为非空字符串`);
    return resolve(directory, value);
  };
  const backend = path("backend", resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const projectRoot = path("projectRoot", directory);
  const id = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  const config: PluginConfig = {
    projectRoot, backend,
    bridgePath: path("bridgePath", resolve(backend, "deveco-plugin/src/main/resources/bridge/ide_bridge.py")),
    runs: path("runs", resolve(tmpdir(), "arkts-refactor-tui", id, "runs")),
    python: "python", homecheck: "", studio: "", node: "", deveco: "", hvigor: "", ohpm: "", linter: "",
    linterMode: "required", timeoutMs: 7_200_000,
  };
  for (const name of ["python", "homecheck", "studio", "node", "deveco", "hvigor", "ohpm", "linter"] as const) {
    const value = input[name] ?? config[name];
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`${name} 必须为有效字符串`);
    config[name] = value;
  }
  if (!config.python.trim()) throw new Error("python 不能为空");
  if (input.linterMode !== undefined && input.linterMode !== "required" && input.linterMode !== "skip") {
    throw new Error("linterMode 必须为 required 或 skip");
  }
  config.linterMode = input.linterMode === "skip" ? "skip" : "required";
  if (input.timeoutMs !== undefined) {
    if (typeof input.timeoutMs !== "number" || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100) {
      throw new Error("timeoutMs 必须是至少 100 的整数");
    }
    config.timeoutMs = input.timeoutMs;
  }
  if (within(projectRoot, config.runs)) throw new Error("runs 必须位于业务工程之外");
  return config;
}
