import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "./models.js";
import { isDir, isFile, readJson, writeJson } from "./utils.js";
import { installCancellationHandlers } from "./process.js";
import {
  BridgeContext,
  BridgeError,
  ADAPTER_VERSION,
  RULES,
  configureEnvironment,
  inspectEnvironment,
  loadRun,
  safePath,
  validatePolicy,
} from "./ide/common.js";
import { normalizeIssues, scan, smellCandidateGate } from "./ide/scan.js";
import {
  checkCandidate,
  executeCandidate,
  loadCandidateForValidation,
  prepareCandidate,
  summarizeFailure,
  validateApplied,
  validateCandidate,
} from "./ide/candidates.js";
export { BridgeError, BridgeContext } from "./ide/common.js";

export async function dispatch(
  ctx: BridgeContext,
  method: string,
  params: Json,
  run?: string,
): Promise<Json> {
  switch (method) {
    case "session.hello":
      return {
        protocolVersion: 1,
        adapterVersion: ADAPTER_VERSION,
        backendLanguage: "typescript",
        nodeVersion: process.versions.node,
        transport: "one-request-per-process",
        supportedRules: Object.keys(RULES),
      };
    case "environment.inspect":
      return inspectEnvironment(ctx.config);
    case "issues.import": {
      let records = params.records;
      if (params.text !== undefined) {
        try {
          records = JSON.parse(params.text);
        } catch {
          throw new BridgeError("INVALID_INPUT", "导入文本不是合法 JSON");
        }
      }
      if (params.file) {
        if (
          !isFile(params.file) ||
          fs.statSync(params.file).size > 8 * 1024 * 1024
        )
          throw new BridgeError("INVALID_INPUT", "导入文件不存在或超过 8 MiB");
        records = readJson(params.file);
      }
      return { issues: normalizeIssues(records, ctx.root) };
    }
    case "scan.start":
      return scan(ctx, params, run!);
    case "task.prepare":
      return prepareCandidate(ctx, params, run!);
    case "task.execute":
      return executeCandidate(ctx, params, run!);
    case "task.validateCandidate":
      return validateCandidate(ctx, params, run!);
    case "task.validateApplied": {
      const result = await validateApplied(ctx, params, run!);
      if (result.result.verdict === "PASS") {
        const refreshed = await scan(ctx, result.scanScope, run!);
        result.issues = refreshed.issues;
      }
      return result;
    }
    case "candidate.restore": {
      const [candidateRun, candidate, , prepared] = loadCandidateForValidation(
        ctx,
        params.candidateId,
      );
      summarizeFailure(
        path.join(candidateRun, "backend"),
        candidate.result ?? {},
      );
      return {
        candidate,
        prepared: { ...prepared, restored: true },
        result: candidate.result ?? {},
        runDirectory: candidateRun,
      };
    }
    case "candidate.check":
      return checkCandidate(ctx, params.candidateId);
    case "candidate.describe":
      return loadRun(ctx, params.candidateId, "candidate.json")[1];
    case "history.list": {
      const records: Json[] = [],
        base = ctx.config.runs;
      if (base && isDir(base))
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const dir = path.join(base, entry.name),
            file = path.join(dir, "session.json");
          if (!isFile(file)) continue;
          try {
            safePath(base, dir);
            const data = readJson(file);
            if (data.projectRoot !== ctx.root) continue;
            if (data.state === "RUNNING") data.state = "INTERRUPTED";
            data.runDirectory = dir;
            data.hasCandidate = isFile(path.join(dir, "candidate.json"));
            if (data.hasCandidate) data.candidateId = entry.name;
            if (isFile(path.join(dir, "apply-transaction.json")))
              data.applyState =
                readJson(path.join(dir, "apply-transaction.json")).state ??
                "UNKNOWN";
            records.push(data);
          } catch {}
        }
      records.sort((a, b) =>
        String(b.startedAt).localeCompare(String(a.startedAt)),
      );
      return { records: records.slice(0, 200) };
    }
    default:
      throw new BridgeError("INVALID_REQUEST", "未实现的方法：" + method);
  }
}
export async function serveRequest(
  request: Json,
  options: { scanner: string; output?: (message: Json) => void },
): Promise<number> {
  const output =
    options.output ??
    ((message) => process.stdout.write(JSON.stringify(message) + "\n"));
  let run: string | undefined;
  try {
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new BridgeError("INVALID_REQUEST", "请求必须为 JSON 对象");
    if (request.protocolVersion !== 1)
      throw new BridgeError("UNSUPPORTED_PROTOCOL", "仅支持协议版本 1");
    if (request.type !== undefined && request.type !== "request")
      throw new BridgeError("INVALID_REQUEST", "请求 type 必须为 request");
    if (typeof request.requestId !== "string" || !request.requestId)
      throw new BridgeError("INVALID_REQUEST", "缺少 requestId");
    if (
      typeof request.method !== "string" ||
      !request.config ||
      typeof request.config !== "object"
    )
      throw new BridgeError("INVALID_REQUEST", "缺少 method/config");
    validatePolicy(request.config);
    configureEnvironment(request.config);
    const root = path.resolve(request.projectRoot ?? "");
    if (!isDir(root))
      throw new BridgeError("INVALID_INPUT", "当前工程目录不存在");
    const ctx = new BridgeContext(
        request.config,
        fs.realpathSync(root),
        options.scanner,
        output,
      ),
      queries = [
        "session.hello",
        "environment.inspect",
        "issues.import",
        "history.list",
        "candidate.check",
        "candidate.describe",
        "candidate.restore",
      ];
    if (!queries.includes(request.method)) run = ctx.createRun(request.method);
    const result = await dispatch(
      ctx,
      request.method,
      request.params ?? {},
      run,
    );
    if (run) {
      const session = readJson(path.join(run, "session.json"));
      session.state = "SUCCEEDED";
      if (result.result) session.verdict = result.result.verdict;
      writeJson(path.join(run, "session.json"), session);
      writeJson(path.join(run, "response.json"), result);
    }
    output({
      protocolVersion: 1,
      type: "response",
      requestId: request.requestId,
      ok: true,
      result,
    });
    return 0;
  } catch (error) {
    const e = error as Error;
    if (run && isFile(path.join(run, "session.json"))) {
      const session = readJson(path.join(run, "session.json"));
      writeJson(path.join(run, "session.json"), {
        ...session,
        state: "FAILED",
        error: e.message,
      });
    }
    output({
      protocolVersion: 1,
      type: "response",
      requestId: request?.requestId ?? null,
      ok: false,
      error: {
        code: error instanceof BridgeError ? error.code : "INTERNAL_ERROR",
        message: e.message ?? String(error),
        details: error instanceof BridgeError ? error.details : {},
      },
    });
    return 2;
  }
}
export async function bridgeGateMain(args: string[]): Promise<number> {
  const options: Json = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined)
      throw new BridgeError("INVALID_REQUEST", "无效 gate 参数");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (
    options.gate !== "smell" ||
    !options.settings ||
    !options["source-root"] ||
    !options["task-dir"]
  )
    throw new BridgeError("INVALID_REQUEST", "缺少 smell gate 参数");
  const config = readJson(options.settings);
  validatePolicy(config);
  configureEnvironment(config);
  if (!config.runs || !isDir(config.runs))
    throw new BridgeError("PATH_OUTSIDE_ROOT", "插件 gate 只允许使用任务副本");
  const source = safePath(config.runs, options["source-root"]),
    taskDir = safePath(config.runs, options["task-dir"]);
  return smellCandidateGate(
    new BridgeContext(config, source, options.scanner),
    taskDir,
    source,
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  installCancellationHandlers();
  if (process.argv.includes("--gate"))
    bridgeGateMain(process.argv.slice(2))
      .then((code) => {
        process.exitCode = code;
      })
      .catch((e) => {
        console.error("SMELL_GATE_BLOCKED: " + e.message);
        process.exitCode = 3;
      });
}
