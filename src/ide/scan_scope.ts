import path from "node:path";
import type { Json } from "../models.js";
import { isDir, isFile, relative } from "../utils.js";
import {
  BridgeContext,
  BridgeError,
  RULES,
  allowedProduction,
  fileInProject,
  loadRun,
  safePath,
} from "./common.js";

export interface ScanScope {
  scopePath: string;
  files?: string[];
  rules?: string[];
}

export function normalizeScanScope(
  ctx: BridgeContext,
  value: unknown,
): ScanScope {
  const input = value as Json;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.scopePath !== "string" ||
    !input.scopePath.trim()
  )
    throw new BridgeError(
      "INVALID_INPUT",
      "异味检测范围缺少有效 scopePath，请重新检测",
    );
  const scope = safePath(ctx.root, path.resolve(input.scopePath));
  if (!isDir(scope) && !(isFile(scope) && /\.(ets|ts)$/i.test(scope)))
    throw new BridgeError(
      "INVALID_INPUT",
      "异味检测范围不存在或不是生产源码，请重新检测",
    );
  const result: ScanScope = { scopePath: scope };
  if ("files" in input) {
    if (
      !Array.isArray(input.files) ||
      !input.files.length ||
      input.files.some((file: unknown) => typeof file !== "string" || !file)
    )
      throw new BridgeError("INVALID_INPUT", "异味检测文件集无效，请重新检测");
    const files: string[] = input.files.map((file: string) =>
      fileInProject(ctx.root, file),
    );
    if (files.some((file) => !allowedProduction(relative(file, ctx.root))))
      throw new BridgeError(
        "INVALID_INPUT",
        "异味检测文件集包含非生产源码，请重新检测",
      );
    result.files = [...new Set(files)];
  }
  if ("rules" in input) {
    if (
      !Array.isArray(input.rules) ||
      !input.rules.length ||
      input.rules.some(
        (rule: unknown) =>
          typeof rule !== "string" || !Object.hasOwn(RULES, rule),
      )
    )
      throw new BridgeError("UNSUPPORTED_RULE", "异味检测范围包含无效规则");
    result.rules = [...new Set<string>(input.rules)];
  }
  return result;
}

export function preparedScanScope(
  ctx: BridgeContext,
  prepared: Json,
): ScanScope {
  if (prepared.scanScope !== undefined)
    return normalizeScanScope(ctx, prepared.scanScope);
  const issue = prepared.issue ?? {};
  const files = [
    issue.absolutePath,
    ...(issue.relatedTargets ?? []).map((item: Json) => item.filePath),
  ];
  if (files.some((file) => typeof file !== "string" || !file))
    throw new BridgeError(
      "INVALID_INPUT",
      "旧记录缺少异味检测范围，请重新检测",
    );
  return normalizeScanScope(
    ctx,
    files.length === 1
      ? { scopePath: files[0] }
      : { scopePath: ctx.root, files },
  );
}

export function candidateScanScope(
  ctx: BridgeContext,
  candidate: Json,
): ScanScope {
  if (candidate.scanScope !== undefined)
    return normalizeScanScope(ctx, candidate.scanScope);
  const [, prepared] = loadRun(ctx, candidate.taskHandle, "prepared.json");
  return preparedScanScope(ctx, prepared);
}
