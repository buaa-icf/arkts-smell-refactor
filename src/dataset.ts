import path from "node:path";
import { RULE_TYPES, type Json, type RefactorTask } from "./models.js";
import { readJson, walk, slash, slug } from "./utils.js";
export function normalizeInput(data: unknown): Json[] {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const item = data as Json;
    if (!item.filePath || !Array.isArray(item.messages))
      throw new Error("单条 JSON 对象必须包含 filePath 和 messages 数组");
    return [item];
  }
  if (
    Array.isArray(data) &&
    data.every((x) => x && typeof x === "object" && !Array.isArray(x))
  )
    return data;
  throw new Error(
    "请输入一条异味 JSON 对象 {...} 或阳性数据集 JSON 数组 [{...}]",
  );
}
export function parseSymbol(message: string): string | null {
  return (
    /(?:Method|method|Function)\s+['"]([^'"]+)['"]/i.exec(message)?.[1] ??
    /God Class\s+['"]?([A-Za-z_$][\w$]*)/i.exec(message)?.[1] ??
    null
  );
}
export function relatedTargets(message: string): Json[] {
  return [
    ...message.matchAll(
      /similar to\s+(.+?\.(?:ets|ts))(?:\s*>\s*[^:]+)?:(\d+)-(\d+)/gi,
    ),
  ].map((m) => ({
    filePath: slash(m[1]),
    range: { startLine: +m[2], endLine: +m[3] },
  }));
}
const identity = (f: string, rule: string, message: string) =>
  JSON.stringify([slash(f), rule, message]);
export function loadDatasetTasks(
  file: string,
  workspace: string,
  onlyIndex?: number,
): RefactorTask[] {
  const data: unknown = readJson(file);
  if (!Array.isArray(data)) throw new Error("阳性数据集顶层必须是 JSON 数组");
  const parentKind = path.basename(path.dirname(file)),
    datasetKind = ["local-test", "instrument-test"].includes(parentKind)
      ? parentKind
      : null;
  const kinds = new Map<string, string | null>();
  if (!datasetKind)
    for (const kind of ["local-test", "instrument-test"])
      for (const p of walk(
        path.join(workspace, "arkts-code-smell/dataset/positive", kind),
      )) {
        if (path.extname(p) !== ".json") continue;
        const records = readJson(p) as unknown;
        if (!Array.isArray(records)) continue;
        for (const r of records)
          if (r && Array.isArray(r.messages))
            for (const m of r.messages) {
              const key = identity(
                r.filePath ?? "",
                m.rule ?? "",
                m.message ?? "",
              );
              kinds.set(
                key,
                kinds.has(key) && kinds.get(key) !== kind ? null : kind,
              );
            }
      }
  const result: RefactorTask[] = [];
  let ordinal = 0;
  for (const [ri, r] of data.entries()) {
    if (!r || !Array.isArray(r.messages) || !r.filePath)
      throw new Error(`第 ${ri + 1} 条不是 filePath + messages[] 格式`);
    const f = slash(String(r.filePath)),
      project = String(r.sourceProject ?? "");
    for (const [mi, m] of r.messages.entries()) {
      ordinal++;
      if (onlyIndex !== undefined && ordinal !== onlyIndex) continue;
      if (!m || typeof m !== "object") throw new Error("messages 中必须是对象");
      const rule = String(m.rule ?? ""),
        message = String(m.message ?? ""),
        symbol = parseSymbol(message),
        smell = RULE_TYPES[rule] ?? slug(rule.replace("@extrulesproject/", ""));
      const kind =
        m.testKind ??
        r.testKind ??
        datasetKind ??
        kinds.get(identity(f, rule, message));
      if (kind != null && !["local-test", "instrument-test"].includes(kind))
        throw new Error("testKind 必须为 local-test 或 instrument-test");
      const int = (v: unknown) =>
        v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v));
      result.push({
        schema_version: "1.0",
        task_id: `${smell}-${String(ordinal).padStart(4, "0")}-${slug(symbol ?? path.basename(f, path.extname(f)))}`,
        source_project: project,
        commit_hash: r.commitHash ?? "",
        workspace_root: path.resolve(workspace),
        project_root: path.resolve(workspace, project),
        smell_type: smell,
        rule,
        severity: m.severity ?? "",
        message,
        target: {
          file_path: f,
          symbol,
          range: {
            start_line: int(m.rangeStart ?? m.line),
            end_line: int(m.rangeEnd ?? m.line),
            column: int(m.column),
          },
          related_targets: relatedTargets(message),
        },
        raw: {
          recordIndex: ri,
          messageIndex: mi,
          ...(kind ? { testKind: kind } : {}),
          ...(r.analysisContext ? { analysisContext: r.analysisContext } : {}),
          ...m,
        },
      });
    }
  }
  if (onlyIndex !== undefined && !result.length)
    throw new Error(`数据集中不存在展开后的第 ${onlyIndex} 个异味`);
  return result;
}
