import type { Json, RefactorTask } from "../models.js";
import { symbolRegion } from "./source.js";
import { escapeRe } from "../utils.js";
export function analyzeFeatureEnvy(
  task: RefactorTask,
  source: string,
  declaration: Json = {},
  callers: Json[] = [],
  reactive: string[] = [],
): Json {
  const region = symbolRegion(source, task.target.symbol),
    text = region.text;
  const types: Record<string, string> = {};
  for (const m of source.matchAll(
    /\b(?:let|const|var|private|public|protected)?\s*([A-Za-z_$][\w$]*)\s*:\s*([^=;,)]+)/g,
  ))
    types[m[1]] = m[2].trim();
  for (const m of source.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)/g,
  ))
    types[m[1]] = m[2];
  const accesses: Record<string, Record<string, number>> = {},
    writes: Record<string, Record<string, number>> = {};
  for (const m of text.matchAll(
    /\b(this\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\??\.([A-Za-z_$][\w$]*)/g,
  )) {
    if (
      m[1] === "this" ||
      [
        "Math",
        "JSON",
        "Array",
        "Object",
        "String",
        "Number",
        "console",
      ].includes(m[1]) ||
      ["length", "toString"].includes(m[2])
    )
      continue;
    const counter = (accesses[m[1]] ??= {});
    counter[m[2]] = (counter[m[2]] ?? 0) + 1;
  }
  for (const m of text.matchAll(
    /\b(this\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\??\.([A-Za-z_$][\w$]*)\s*(?:[+\-*/%]?=|\+\+|--)/g,
  )) {
    const c = (writes[m[1]] ??= {});
    c[m[2]] = (c[m[2]] ?? 0) + 1;
  }
  const total = (obj: Record<string, number> = {}) =>
    Object.values(obj).reduce((a, b) => a + b, 0);
  const reported =
    /(?:feature-envious toward|highly coupled to)\s+['"]([^'"]+)['"]/i.exec(
      task.message,
    )?.[1] ?? null;
  const ranked = Object.keys(accesses).sort(
    (a, b) => total(accesses[b]) - total(accesses[a]),
  );
  const receiver =
    ranked.find(
      (r) =>
        reported &&
        (reported
          .split("|")
          .some((t) =>
            (types[r.split(".").at(-1)!] ?? "")
              .toLowerCase()
              .includes(t.trim().toLowerCase()),
          ) ||
          reported.toLowerCase().includes(r.split(".").at(-1)!.toLowerCase()) ||
          r.toLowerCase().includes(reported.toLowerCase())),
    ) ??
    ranked[0] ??
    null;
  const type =
      types[receiver?.split(".").at(-1) ?? ""] ?? reported ?? "unknown",
    value = [reported, type, receiver].join(" ").toLowerCase();
  const ownership = [
    "appstorage",
    "localstorage",
    "persiststorage",
    "storagev2",
  ].some((t) => value.includes(t))
    ? "global-state"
    : [
          "canvas",
          "pixelmap",
          "image",
          "path",
          "drawing",
          "render",
          "context2d",
          "want",
          "router",
          "http",
          "https",
        ].some((t) => value.includes(t))
      ? "sdk-object"
      : /service|repository|http/.test(value)
        ? "service-object"
        : "business-data";
  const a = accesses[receiver ?? ""] ?? {},
    w = writes[receiver ?? ""] ?? {};
  const classification =
    ownership === "global-state"
      ? "GLOBAL_STORAGE_ACCESS"
      : ownership === "sdk-object"
        ? "SDK_ORCHESTRATION"
        : Object.keys(w).length
          ? "STATE_MUTATION"
          : /\.(?:map|forEach|filter|reduce|sort)\s*\(/.test(text)
            ? "COLLECTION_PROCESSING"
            : Object.keys(a).length
              ? "DATA_TRANSFORMATION"
              : "DELEGATION_ORCHESTRATION";
  const feasibility = ["sdk-object", "global-state"].includes(ownership)
    ? "unsafe"
    : "uncertain";
  const reasons =
    ownership === "sdk-object"
      ? ["被依恋对象属于 SDK/框架类型，不能直接加入业务方法"]
      : ownership === "global-state"
        ? ["被依恋对象是全局状态容器，直接 Move Method 会扩大耦合"]
        : /\||interface/i.test(reported ?? type)
          ? ["被依恋类型是联合类型或接口，需要确认真实实现和依赖方向"]
          : [
              "尚未接入跨文件 ArkTS 类型与依赖图，不能自动证明 Move Method 安全",
            ];
  const recommendation =
    ownership === "sdk-object"
      ? [
          "INTRODUCE_ADAPTER_OR_HELPER",
          "dedicated-production-helper",
          "SDK 类型不可修改，适合由专用生产 Helper 封装调用序列",
        ]
      : ownership === "global-state"
        ? [
            "INTRODUCE_DELEGATE",
            "state-service-or-owning-model",
            "全局状态访问应集中到明确的数据归属服务，而不是移动到存储容器",
          ]
        : ["DATA_TRANSFORMATION", "COLLECTION_PROCESSING"].includes(
              classification,
            )
          ? [
              "EXTRACT_MAPPER_OR_BUILDER",
              "owning-model-or-dedicated-builder",
              "逻辑主要读取外部数据并构造结果，适合 Mapper/Builder",
            ]
          : [
              "INTRODUCE_DELEGATE",
              "owning-model-or-dedicated-helper",
              callers.length ||
              declaration.visibility === "public" ||
              declaration.exported
                ? "存在外部调用契约，保留稳定入口后委托更安全"
                : "类型归属仍需确认，先采用最小委托",
            ];
  const preserve: string[] = [];
  if (/\.push\s*\(/.test(text)) preserve.push("数组 push 的累加语义和对象身份");
  if (/\bif\s*\(/.test(text)) preserve.push("条件不满足时不执行的边界");
  if (/\bawait\b/.test(text))
    preserve.push("await 位置、异常传播和异步副作用顺序");
  const used = reactive.filter((n) =>
    new RegExp(`\\bthis\\.${escapeRe(n)}\\b`).test(text),
  );
  if (used.length)
    preserve.push("响应式状态实时读取：" + used.sort().join(", "));
  const indexes = text
    .split("\n")
    .map((line, i) => (receiver && line.includes(receiver) ? i : -1))
    .filter((i) => i >= 0);
  return {
    located: region.located,
    evidenceSource: region.located ? "target-symbol" : "target-file",
    reportedTarget: reported,
    receiver,
    targetType: type,
    ownershipKind: ownership,
    classification,
    metrics: Object.fromEntries(
      [...task.message.matchAll(/\b(ATFD|LDA|CPFD)\s*=\s*([0-9.]+)/gi)].map(
        (m) => [m[1].toUpperCase(), +m[2]],
      ),
    ),
    readCount: total(a),
    writeCount: total(w),
    accessedMembers: Object.entries(a)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, writes: w[name] ?? 0 })),
    receiverCandidates: ranked.slice(0, 8).map((r) => ({
      receiver: r,
      accessCount: total(accesses[r]),
      type: types[r.split(".").at(-1)!] ?? null,
    })),
    moveFeasibility: feasibility,
    moveReasons: reasons,
    recommendedPattern: recommendation[0],
    recommendedDestination: recommendation[1],
    recommendationReason: recommendation[2],
    extractionRegion: indexes.length
      ? {
          startLine: region.startLine + Math.min(...indexes),
          endLine: region.startLine + Math.max(...indexes),
        }
      : null,
    mustPreserve: preserve,
    limitations: [
      "成员访问和写入采用词法级近似，别名、解构、泛型和跨文件类型关系可能无法完整识别",
      "职责归属建议必须由 Refactor Agent 结合实际依赖方向确认",
    ],
  };
}
export function featureEnvyConstraints(
  task: RefactorTask,
  a: Json,
): [Json[], Json[]] {
  const risks: Json[] = [],
    constraints: Json[] = [];
  if (a.moveFeasibility !== "safe")
    risks.push({
      code: "ENVIED_TARGET_MOVE_RISK",
      level: a.moveFeasibility === "unsafe" ? "high" : "medium",
      evidence: a.moveReasons.join("; "),
      affectedFiles: [task.target.file_path],
    });
  if (a.writeCount) {
    risks.push({
      code: "ENVIED_STATE_WRITE",
      level: "high",
      evidence: `目标方法会写入被依恋对象的 ${a.writeCount} 个成员访问`,
      affectedFiles: [task.target.file_path],
    });
    constraints.push({
      code: "PRESERVE_ENVIED_OBJECT_IDENTITY",
      reason: "跨对象写入提取后容易变成创建新对象或替换引用",
      instruction: "保持被依恋对象的身份、字段写入次数、写入顺序和条件边界",
    });
  }
  if (a.mustPreserve.length)
    constraints.push({
      code: "PRESERVE_EXTRACTION_SEMANTICS",
      reason: "目标方法包含移动或提取时容易改变的行为边界",
      instruction: "逐项保持：" + a.mustPreserve.join("；"),
    });
  return [risks, constraints];
}
