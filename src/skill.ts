#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient, BridgeError } from "./client/bridge.js";
import { loadConfig, within, type PluginConfig } from "./client/config.js";
import { canonicalPath, safePath } from "./client/paths.js";
import {
  applyCandidate,
  candidateDiff,
  readTransaction,
  recoverApplication,
} from "./client/apply.js";
import type {
  Backend,
  BridgeEvent,
  BridgeMethods,
  Issue,
  ScanScope,
} from "./client/types.js";

const commands: Record<string, string[]> = {
  doctor: [],
  scan: ["scope"],
  import: ["file"],
  prepare: ["from", "issue", "instructions-file"],
  execute: ["task"],
  diff: ["candidate", "file"],
  "validate-candidate": ["candidate"],
  apply: ["candidate", "confirm"],
  "validate-applied": ["candidate"],
  history: [],
  restore: ["candidate"],
  rollback: ["candidate", "confirm"],
};
const globalOptions = ["config", "project", "backend", "runs"];
const help = `ArkTS conversation adapter
Usage: node dist/skill.js <command> --config <settings.json> [options]
  doctor
  scan --scope <file-or-directory>
  import --file <report.json>
  prepare --from <responseFile> --issue <issueId> [--instructions-file <text>]
  execute --task <taskHandle>
  diff --candidate <candidateId> [--file <relativePath>]
  validate-candidate --candidate <candidateId>
  apply --candidate <candidateId> --confirm <candidateId>
  validate-applied --candidate <candidateId>
  history
  restore --candidate <candidateId>
  rollback --candidate <candidateId> --confirm <candidateId>
Global overrides: --project <path> --backend <path> --runs <path>
Paths resolve against the current working directory. Keep settings identical between steps.
stdout: one JSON response; stderr: progress events. Exit 2: operation error;
exit 3: completed operation with non-PASS validation or recovery conflict.
--confirm records a conversation choice; it does not itself prove user consent.
`;

function invalid(message: string): never {
  throw new BridgeError("INVALID_INPUT", message);
}
function parse(args: string[]) {
  const [command, ...rest] = args;
  if (!Object.hasOwn(commands, command ?? ""))
    invalid("未知命令；使用 --help 查看命令");
  const options: Record<string, string> = {};
  const allowed = new Set([...globalOptions, ...commands[command]]);
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].startsWith("--") ? rest[i].slice(2) : "";
    const value = rest[i + 1];
    if (
      !allowed.has(name) ||
      Object.hasOwn(options, name) ||
      !value ||
      value.startsWith("--")
    ) {
      invalid(`参数无效、重复或缺值：${rest[i]}`);
    }
    options[name] = value;
  }
  return { command, options };
}

interface Receipt {
  schemaVersion: 1;
  ok: true;
  command: string;
  projectRoot: string;
  responseFile: string;
  scanScope?: ScanScope;
  result: unknown;
}
export interface SkillOptions {
  directory?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  backend?: (config: PluginConfig) => Backend;
}

/** A process-independent conversation step; all refactoring evidence stays in the shared backend. */
export async function runSkill(
  args: string[],
  io: SkillOptions = {},
): Promise<number> {
  const stdout = io.stdout ?? ((line) => process.stdout.write(line + "\n"));
  const stderr = io.stderr ?? ((line) => process.stderr.write(line + "\n"));
  if (
    args.length === 0 ||
    (args.length === 1 && ["help", "--help", "-h"].includes(args[0]))
  ) {
    stdout(help);
    return 0;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const { command, options } = parse(args);
    const directory = resolve(io.directory ?? process.cwd());
    const required = (key: string) => options[key] || invalid(`缺少 --${key}`);
    const candidateId = () => required("candidate");
    // Command arguments must never enter config: the backend fingerprints every config field.
    const settings: Record<string, unknown> = {};
    for (const [flag, key] of [
      ["config", "configFile"],
      ["project", "projectRoot"],
      ["backend", "backend"],
      ["runs", "runs"],
    ]) {
      if (options[flag]) settings[key] = options[flag];
    }
    const config = await loadConfig(settings, directory);
    const projectRoot = await realpath(config.projectRoot);
    if (within(projectRoot, await canonicalPath(config.runs)))
      invalid("runs 实际路径必须位于业务工程之外");
    if (
      ["apply", "rollback"].includes(command) &&
      required("confirm") !== candidateId()
    ) {
      invalid("--confirm 必须与已在对话中选择的 candidateId 一致");
    }
    const backend = io.backend?.(config) ?? new BridgeClient(config);
    const onEvent = (event: BridgeEvent) => {
      // Full logs are already persisted by the backend; keep conversation progress bounded.
      if (event.event !== "log.appended") stderr(JSON.stringify(event));
    };
    const request = <M extends keyof BridgeMethods>(
      method: M,
      params: Record<string, unknown> = {},
    ) => backend.request(method, params, abort.signal, onEvent);
    let result: unknown;
    let scanScope: ScanScope | undefined;
    switch (command) {
      case "doctor":
        result = {
          hello: await request("session.hello"),
          environment: await request("environment.inspect"),
        };
        break;
      case "scan": {
        const scanned = await request("scan.start", {
          scopePath: resolve(directory, required("scope")),
        });
        scanScope = {
          scopePath: scanned.scopePath,
          ...(scanned.rules ? { rules: scanned.rules } : {}),
        };
        result = scanned;
        break;
      }
      case "import": {
        const imported = await request("issues.import", {
          file: resolve(directory, required("file")),
        });
        const files = [
          ...new Set(
            imported.issues.flatMap((issue) => [
              issue.absolutePath,
              ...issue.relatedTargets
                .map((target) => String(target.filePath ?? ""))
                .filter(Boolean),
            ]),
          ),
        ];
        scanScope = { scopePath: projectRoot, files };
        result = imported;
        break;
      }
      case "prepare": {
        const source = resolve(directory, required("from"));
        const sourcePath = await safePath(
          config.runs,
          relative(config.runs, source).replaceAll("\\", "/"),
        );
        const receipt = JSON.parse(
          (await readFile(sourcePath, "utf8")).replace(/^\uFEFF/, ""),
        ) as Receipt;
        if (
          receipt.schemaVersion !== 1 ||
          receipt.ok !== true ||
          !["scan", "import"].includes(receipt.command) ||
          receipt.projectRoot !== projectRoot ||
          !receipt.scanScope
        ) {
          invalid("--from 必须是当前工程此前 scan/import 返回的 responseFile");
        }
        const issues = (receipt.result as { issues?: Issue[] })?.issues;
        const issueId = required("issue");
        if (!Array.isArray(issues)) invalid("检测结果缺少 issues");
        const matches = issues.filter((issue) => issue.issueId === issueId);
        if (matches.length !== 1 || !matches[0].supported)
          invalid("请选择唯一且支持重构的 issueId");
        const instructions = options["instructions-file"]
          ? (
              await readFile(
                resolve(directory, options["instructions-file"]),
                "utf8",
              )
            ).replace(/^\uFEFF/, "")
          : "";
        scanScope = receipt.scanScope;
        result = await request("task.prepare", {
          issue: matches[0],
          scanScope,
          instructions,
        });
        break;
      }
      case "execute":
        result = await request("task.execute", {
          taskHandle: required("task"),
        });
        break;
      case "validate-candidate": {
        const id = candidateId();
        const candidate = await request("candidate.describe", {
          candidateId: id,
        });
        const transaction = await readTransaction(config, candidate);
        if (transaction && transaction.state !== "ROLLED_BACK")
          invalid("候选存在应用事务，请先查看应用后结果或回滚");
        result = await request("task.validateCandidate", { candidateId: id });
        break;
      }
      case "diff": {
        const candidate = await request("candidate.describe", {
          candidateId: candidateId(),
        });
        const names = options.file
          ? [options.file]
          : candidate.changes.map((change) => change.relativePath);
        const diffs = [];
        for (const name of names)
          diffs.push({
            file: name,
            diff: await candidateDiff(config, candidate, name),
          });
        result = {
          candidateId: candidate.candidateId,
          verdict: candidate.verdict,
          diffs,
        };
        break;
      }
      case "apply": {
        const candidate = await request("candidate.check", {
          candidateId: candidateId(),
        });
        result = {
          candidateId: candidate.candidateId,
          transaction: await applyCandidate(config, candidate),
        };
        break;
      }
      case "validate-applied": {
        const id = candidateId();
        const candidate = await request("candidate.describe", {
          candidateId: id,
        });
        if ((await readTransaction(config, candidate))?.state !== "APPLIED")
          invalid("请先完成候选应用");
        result = await request("task.validateApplied", { candidateId: id });
        break;
      }
      case "history":
        result = await request("history.list");
        break;
      case "restore": {
        const id = candidateId();
        const candidate = await request("candidate.describe", {
          candidateId: id,
        });
        const transaction = await readTransaction(config, candidate);
        result =
          transaction && transaction.state !== "ROLLED_BACK"
            ? { candidate, result: candidate.result, transaction }
            : {
                ...(await request("candidate.restore", { candidateId: id })),
                transaction,
              };
        break;
      }
      case "rollback": {
        const candidate = await request("candidate.describe", {
          candidateId: candidateId(),
        });
        result = {
          candidateId: candidate.candidateId,
          transaction: await recoverApplication(config, candidate),
        };
        break;
      }
    }
    await mkdir(config.runs, { recursive: true });
    const receiptDirectory = await safePath(config.runs, "skill-results");
    await mkdir(receiptDirectory, { recursive: true });
    const responseFile = await safePath(
      config.runs,
      `skill-results/${randomUUID()}.json`,
    );
    const receipt: Receipt = {
      schemaVersion: 1,
      ok: true,
      command,
      projectRoot,
      responseFile,
      ...(scanScope ? { scanScope } : {}),
      result,
    };
    await writeFile(responseFile, JSON.stringify(receipt, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    stdout(JSON.stringify(receipt));
    const status = result as {
      result?: { verdict?: string };
      transaction?: { state?: string };
    };
    return (status.result?.verdict && status.result.verdict !== "PASS") ||
      status.transaction?.state === "CONFLICT"
      ? 3
      : 0;
  } catch (error) {
    stdout(
      JSON.stringify({
        ok: false,
        command: args[0],
        error: {
          code: error instanceof BridgeError ? error.code : "OPERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
    return 2;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSkill(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
