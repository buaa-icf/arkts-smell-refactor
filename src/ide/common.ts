import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Json } from "../models.js";
import {
  hash,
  isDir,
  isFile,
  readJson,
  relative,
  slash,
  within,
  writeJson,
} from "../utils.js";
import { which } from "../process.js";

export const RULES: Record<string, string> = {
  "@extrulesproject/feature-envy-check": "feature-envy",
  "@extrulesproject/long-method-check": "long-method",
  "@extrulesproject/switch-statement-check": "switch-statement",
  "@extrulesproject/code-clone-fragment-check": "code-clone",
};
export const IGNORED = new Set([
  ".git",
  ".idea",
  ".hvigor",
  ".cache",
  ".test",
  "build",
  "coverage",
  "oh_modules",
  "node_modules",
  "report",
  "reports",
  ".preview",
  ".gradle",
]);
export const ADAPTER_VERSION = "0.2.0";
export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Json = {},
  ) {
    super(message);
  }
}
export interface BridgeConfig extends Json {
  backend?: string;
  node?: string;
  studio?: string;
  homecheck?: string;
  runs?: string;
  deveco?: string;
  hvigor?: string;
  ohpm?: string;
  linter?: string;
}
export function validatePolicy(config: Json): void {
  if (
    config.linterMode !== undefined &&
    !["required", "skip"].includes(config.linterMode)
  )
    throw new BridgeError(
      "INVALID_INPUT",
      "linterMode 必须为 required 或 skip",
    );
}
export function safePath(root: string, target: string): string {
  const resolved = path.resolve(target),
    base = fs.realpathSync(root);
  if (!within(resolved, base))
    throw new BridgeError("PATH_OUTSIDE_ROOT", "路径不在工程范围内：" + target);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (!within(fs.realpathSync(existing), base))
    throw new BridgeError("PATH_OUTSIDE_ROOT", "路径通过链接越界：" + target);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}
export function projectFiles(root: string, tests = false): string[] {
  const result: string[] = [];
  if (!isDir(root)) return result;
  function visit(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        IGNORED.has(entry.name) ||
        (!tests && ["test", "ohosTest"].includes(entry.name))
      )
        continue;
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new BridgeError(
          "PATH_OUTSIDE_ROOT",
          "不支持符号链接或 junction：" + p,
        );
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile() && /\.(ets|ts)$/i.test(entry.name))
        result.push(safePath(root, p));
    }
  }
  visit(root);
  return result;
}
export function fileInProject(root: string, reported: string): string {
  const normalized = slash(reported);
  if (normalized.split("/").includes(".."))
    throw new BridgeError("PATH_OUTSIDE_ROOT", "报告路径不允许包含 ..");
  if (path.isAbsolute(normalized)) {
    const found = safePath(root, normalized);
    if (!isFile(found))
      throw new BridgeError("INVALID_INPUT", "目标文件不存在");
    return found;
  }
  const options = [path.resolve(root, normalized)];
  if (normalized.startsWith(path.basename(root) + "/"))
    options.push(
      path.resolve(root, normalized.slice(path.basename(root).length + 1)),
    );
  for (const p of options) if (isFile(p)) return safePath(root, p);
  const matches = projectFiles(root).filter((p) =>
    normalized.endsWith(relative(p, root)),
  );
  if (matches.length === 1) return matches[0];
  throw new BridgeError(
    "INVALID_INPUT",
    "无法将报告文件映射到当前工程：" + reported,
  );
}
export function allowedProduction(name: string): boolean {
  const p = slash(name),
    parts = p.toLowerCase().split("/");
  if (
    !p ||
    path.isAbsolute(p) ||
    parts.includes("..") ||
    parts.some((s) => ["test", "ohostest", "appscope"].includes(s))
  )
    return false;
  return (
    ("/" + p.toLowerCase()).includes("/src/main/resources/") ||
    (/\.(ets|ts)$/i.test(p) &&
      ("/" + p.toLowerCase()).includes("/src/main/")) ||
    (path.basename(p).toLowerCase() === "index.ets" && parts.length >= 2)
  );
}
export function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string): void {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new BridgeError(
          "PATH_OUTSIDE_ROOT",
          "候选工程不支持符号链接或 junction：" + p,
        );
      safePath(root, p);
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile()) result[relative(p, root)] = hash(p);
    }
  }
  visit(root);
  return result;
}
export function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}
export function stable(value: any): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stable(value[k]))
      .join(",") +
    "}"
  );
}
export function copyProject(source: string, destination: string): void {
  const files = snapshot(source);
  if (within(destination, source) || within(source, destination))
    throw new BridgeError("INVALID_INPUT", "快照来源和目标不能相互嵌套");
  fs.mkdirSync(destination, { recursive: true });
  function copyDirectories(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      if (entry.isDirectory()) {
        const sourceDir = path.join(dir, entry.name);
        fs.mkdirSync(path.join(destination, relative(sourceDir, source)), {
          recursive: true,
        });
        copyDirectories(sourceDir);
      }
    }
  }
  copyDirectories(source);
  for (const name of Object.keys(files)) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, name), target);
  }
}
export function discoverTools(
  config: BridgeConfig,
): Record<string, string | null> {
  const resolve = (value: string | undefined, fallback: string) =>
    value ? (which(value) ?? value) : which(fallback);
  return {
    deveco: resolve(config.deveco, "deveco"),
    hvigorw: resolve(config.hvigor, "hvigorw"),
    ohpm: resolve(config.ohpm, "ohpm"),
    codelinter: resolve(config.linter, "codelinter"),
    homecheck: config.homecheck ?? null,
  };
}
export function configureEnvironment(config: BridgeConfig): void {
  const additions = ["node", "deveco", "hvigor", "ohpm", "linter"].flatMap(
    (k) =>
      typeof config[k] === "string" && isFile(config[k])
        ? [path.dirname(config[k])]
        : [],
  );
  if (config.studio && isDir(config.studio)) {
    for (const suffix of ["tools/node", "tools/hvigor/bin", "tools/ohpm/bin"])
      if (isDir(path.join(config.studio, suffix)))
        additions.push(path.join(config.studio, suffix));
    process.env.DEVECO_HOME = config.studio;
    process.env.DEVECO_SDK_HOME = path.join(config.studio, "sdk");
  }
  process.env.PATH = [...additions, process.env.PATH ?? ""].join(
    path.delimiter,
  );
}
export function inspectEnvironment(config: BridgeConfig): Json {
  validatePolicy(config);
  const tools = discoverTools(config),
    homecheck = config.homecheck ?? "",
    studio = config.studio ?? "",
    backend = config.backend ?? "";
  const rows: Json[] = [
    {
      name: "Node",
      path: config.node ?? process.execPath,
      available:
        (Number(process.versions.node.split(".")[0]) > 20 ||
          (Number(process.versions.node.split(".")[0]) === 20 &&
            Number(process.versions.node.split(".")[1]) >= 19)) &&
        !!which(config.node ?? process.execPath),
    },
    {
      name: "重构后端",
      path: backend,
      available:
        isFile(path.join(backend, "dist/ide_bridge.js")) &&
        isFile(path.join(backend, "dist/runner.js")) &&
        isDir(path.join(backend, "node_modules")),
    },
    {
      name: "HomeCheck",
      path: homecheck,
      available: [
        "node_modules/homecheck/lib/run.js",
        "extrulesproject-1.0.0.tgz",
        "config/projectConfig.json",
        "config/ruleConfig.json",
      ].every((p) => isFile(path.join(homecheck, p))),
    },
    {
      name: "ArkTS SDK",
      path: path.join(studio, "sdk/default/openharmony/ets"),
      available:
        !!studio && isDir(path.join(studio, "sdk/default/openharmony/ets")),
    },
    ...Object.entries(tools)
      .filter(([n]) => n !== "homecheck")
      .map(([name, value]) => ({
        name,
        path: value ?? "",
        available: !!value && !!which(value),
      })),
  ];
  rows.forEach((row) => {
    row.required = row.name !== "codelinter" || config.linterMode !== "skip";
  });
  return {
    tools: rows,
    canDetect: rows
      .filter((r) => ["Node", "HomeCheck", "ArkTS SDK"].includes(r.name))
      .every((r) => r.available),
    canRefactor: rows.filter((r) => r.required).every((r) => r.available),
    nodeVersion: process.versions.node,
    supportedRules: Object.keys(RULES),
  };
}
export class BridgeContext {
  private seq = 0;
  constructor(
    public config: BridgeConfig,
    public root: string,
    public scanner: string,
    private output: (event: Json) => void = (event) =>
      process.stdout.write(JSON.stringify(event) + "\n"),
  ) {}
  emit(event: string, data: Json): void {
    this.output({
      protocolVersion: 1,
      type: "event",
      seq: ++this.seq,
      event,
      data,
    });
  }
  log(text: string): void {
    for (let i = 0; i < text.length; i += 8000)
      this.emit("log.appended", { text: text.slice(i, i + 8000) });
  }
  createRun(method: string): string {
    if (!this.config.runs)
      throw new BridgeError("INVALID_INPUT", "请配置任务目录");
    const base = path.resolve(this.config.runs);
    if (within(base, this.root))
      throw new BridgeError("INVALID_INPUT", "任务目录必须位于业务工程之外");
    fs.mkdirSync(base, { recursive: true });
    const run = path.join(base, crypto.randomUUID());
    fs.mkdirSync(run);
    writeJson(path.join(run, "session.json"), {
      runId: path.basename(run),
      projectRoot: this.root,
      method,
      startedAt: new Date().toISOString(),
      state: "RUNNING",
    });
    this.emit("run.started", { runId: path.basename(run), runDirectory: run });
    return run;
  }
}
export function configurationDigest(ctx: BridgeContext): string {
  const config: BridgeConfig = {
    ...ctx.config,
    linterMode: ctx.config.linterMode ?? "required",
  };
  delete config.python;
  const backend = path.resolve(config.backend ?? "."),
    files: Json = {};
  for (const dir of ["src", "dist"]) {
    const root = path.join(backend, dir);
    if (isDir(root))
      for (const file of projectFiles(root, true))
        files[dir + "/" + relative(file, root)] = hash(file);
  }
  // Compiled .js modules are part of the executable backend, not only its source .ts.
  function jsFiles(dir: string): void {
    if (!isDir(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) jsFiles(p);
      else if (e.isFile() && /\.(js|cjs)$/.test(e.name))
        files[relative(p, backend)] = hash(p);
    }
  }
  jsFiles(path.join(backend, "dist"));
  const pkg = path.join(config.homecheck ?? "", "extrulesproject-1.0.0.tgz"),
    sdk = path.join(config.studio ?? "", "sdk/default/openharmony/ets"),
    metadata: Json = {};
  if (isDir(sdk))
    for (const name of fs.readdirSync(sdk))
      if (name.endsWith(".json") && isFile(path.join(sdk, name)))
        metadata[name] = hash(path.join(sdk, name));
  const tools = Object.fromEntries(
    Object.entries(discoverTools(config)).map(([name, p]) => {
      const stat = p && isFile(p) ? fs.statSync(p) : null;
      return [
        name,
        stat ? { path: p, size: stat.size, mtime: stat.mtimeMs } : p,
      ];
    }),
  );
  return crypto
    .createHash("sha256")
    .update(
      stable({
        config,
        adapter: ADAPTER_VERSION,
        runtime: process.version,
        backendSources: files,
        scanner: isFile(ctx.scanner) ? hash(ctx.scanner) : null,
        rulePackage: isFile(pkg) ? hash(pkg) : null,
        tools,
        sdkMetadata: metadata,
      }),
    )
    .digest("hex");
}
export function loadRun(
  ctx: BridgeContext,
  id: string,
  manifest: string,
): [string, Json] {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new BridgeError("INVALID_REQUEST", "任务标识必须为 UUID");
  if (!ctx.config.runs || !isDir(ctx.config.runs))
    throw new BridgeError("ARTIFACT_UNAVAILABLE", "任务目录不存在");
  const run = safePath(ctx.config.runs, path.resolve(ctx.config.runs, id));
  if (!isDir(run))
    throw new BridgeError("ARTIFACT_UNAVAILABLE", "任务目录不存在");
  const file = safePath(run, path.join(run, manifest));
  if (!isFile(file))
    throw new BridgeError(
      "ARTIFACT_UNAVAILABLE",
      "找不到任务记录：" + manifest,
    );
  const data = readJson(file);
  safePath(ctx.root, data.originalRoot);
  return [run, data];
}
