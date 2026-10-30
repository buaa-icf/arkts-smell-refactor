import path from "node:path";
import type { Json, RefactorTask } from "../models.js";
import { targetPath } from "../models.js";
import {
  sourceFiles,
  readText,
  escapeRe,
  isTest,
  relative,
  unique,
} from "../utils.js";
import { mask, matching, splitParameters } from "./source.js";
export function classBlock(source: string, name: string): string {
  const m = new RegExp(
    `\\b(?:export\\s+)?(?:default\\s+)?(?:class|struct)\\s+${escapeRe(name)}\\b`,
  ).exec(mask(source));
  if (!m) return "";
  const start = mask(source).indexOf("{", m.index + m[0].length),
    end = start < 0 ? -1 : matching(mask(source), start);
  return end < 0 ? "" : source.slice(m.index, end + 1);
}
export function braceDepths(source: string): number[] {
  let d = 0;
  return [...mask(source)].map((c) => {
    const before = d;
    if (c === "{") d++;
    else if (c === "}") d = Math.max(0, d - 1);
    return before;
  });
}
export const METHOD =
  /^\s*((?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*)([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^={\n]+))?\s*\{/gm;
export const FIELD =
  /^\s*((?:@\w+(?:\([^)]*\))?\s*)*)((?:(?:public|private|protected|static|readonly)\s+)*)([A-Za-z_$][\w$]*)\s*[?!]?\s*(?::\s*([^=;\n]+))?\s*(?:=|;)/gm;
export function analyzeGodClass(task: RefactorTask, source: string): Json {
  const name =
      task.target.symbol ??
      path.basename(task.target.file_path, path.extname(task.target.file_path)),
    block = classBlock(source, name),
    depths = braceDepths(block);
  const visibility = (s: string) =>
    s.includes("private")
      ? "private"
      : s.includes("protected")
        ? "protected"
        : "public";
  const fields = [...block.matchAll(FIELD)]
    .filter((m) => depths[m.index!] === 1)
    .map((m) => ({
      name: m[3],
      type: (m[4] ?? "unknown").trim(),
      visibility: visibility(m[2]),
      static: m[2].includes("static"),
      readonly: m[2].includes("readonly"),
      decorators: [...m[1].matchAll(/@(\w+)/g)].map((x) => x[1]),
    }));
  const methods = [...block.matchAll(METHOD)]
    .filter((m) => depths[m.index!] === 1)
    .map((m) => {
      const start = block.indexOf("{", m.index! + m[0].length - 1),
        end = matching(mask(block), start),
        body = block.slice(start, end + 1),
        params = splitParameters(m[3]);
      const reads = fields
          .filter((f) =>
            new RegExp(
              `(?:this|${escapeRe(name)})\\.${escapeRe(f.name)}\\b`,
            ).test(body),
          )
          .map((f) => f.name),
        writes = fields
          .filter((f) =>
            new RegExp(
              `(?:this|${escapeRe(name)})\\.${escapeRe(f.name)}\\s*(?:=|\\+=|-=|\\+\\+|--)`,
            ).test(body),
          )
          .map((f) => f.name);
      const signals = [
        ["async", /\b(?:await|Promise)\b/],
        [
          "runtime-context",
          /\b(?:getContext|resourceManager|AppStorage|preferences\.)/,
        ],
        ["callback", /\b(?:callback|on[A-Z]\w*)\s*\(/],
      ]
        .filter(([, re]) => (re as RegExp).test(body))
        .map(([s]) => s as string);
      if (writes.length) signals.push("state-write");
      return {
        name: m[2],
        parameterCount: params.length,
        requiredParameterCount: params.filter(
          (p) => !p.includes("=") && !p.split(":")[0].includes("?"),
        ).length,
        returnType: (m[4] ?? "unknown").trim(),
        visibility: visibility(m[1]),
        static: m[1].includes("static"),
        async: m[1].includes("async") || signals.includes("async"),
        readsFields: reads,
        writesFields: writes,
        riskSignals: signals,
      };
    });
  const groups = new Map<string, string[]>();
  for (const m of methods) {
    const key = JSON.stringify(
      unique([...m.readsFields, ...m.writesFields]).sort(),
    );
    if (key !== "[]") groups.set(key, [...(groups.get(key) ?? []), m.name]);
  }
  const external: Json[] = [];
  if (methods.length) {
    const re = new RegExp(
      `\\b${escapeRe(name)}\\.(${methods.map((m) => escapeRe(m.name)).join("|")})\\s*\\(`,
    );
    for (const p of sourceFiles(task.project_root))
      if (p !== targetPath(task) && !isTest(p))
        readText(p)
          .split("\n")
          .forEach((line, i) => {
            const m = re.exec(line);
            if (m)
              external.push({
                filePath: relative(p, task.workspace_root),
                line: i + 1,
                method: m[1],
              });
          });
  }
  return {
    targetClass: name,
    classLocated: !!block,
    lineCount: block ? block.split("\n").length : 0,
    fieldCount: fields.length,
    methodCount: methods.length,
    fields,
    methods,
    mutableStaticFields: fields
      .filter((f) => f.static && !f.readonly)
      .map((f) => f.name),
    externalCallers: external,
    responsibilityCandidates: [...groups]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([key, names]) => ({
        sharedFields: JSON.parse(key),
        methods: names,
      })),
    highRiskMethods: methods
      .filter(
        (m) =>
          m.riskSignals.length ||
          /init|reset|clear|delete|remove|update|set|load|save|create|complete|destroy|dispose|login|logout/i.test(
            m.name,
          ),
      )
      .map((m) => ({ name: m.name, signals: m.riskSignals })),
    candidateHint:
      "Use field reads/writes and business actions as evidence; assign one owner to each mutable state group and preserve the public facade when compatibility is uncertain.",
    analysisLimitations: [
      "Lexical analysis may miss dynamic and cross-language calls",
      "Responsibility candidates do not decide final class boundaries",
    ],
  };
}
export function godClassConstraints(a: Json, file: string): [Json[], Json[]] {
  const risks: Json[] = [],
    constraints: Json[] = [
      {
        code: "NO_GOD_CLASS_TRANSFER",
        reason: "Mechanical extraction may move the smell",
        instruction:
          "Each extracted class needs one coherent responsibility; do not create another large Helper",
      },
    ];
  if (a.mutableStaticFields.length) {
    risks.push({
      code: "GOD_CLASS_SHARED_MUTABLE_STATE",
      level: "high",
      evidence: "Mutable static state: " + a.mutableStaticFields.join(", "),
      affectedFiles: [file],
    });
    constraints.push({
      code: "ASSIGN_SINGLE_STATE_OWNER",
      reason: "Copies diverge",
      instruction:
        "Assign one real state owner; compatibility entries delegate to that same state",
    });
  }
  if (a.highRiskMethods.length) {
    risks.push({
      code: "GOD_CLASS_SIDE_EFFECT_FLOW",
      level: "high",
      evidence: a.highRiskMethods.map((m: Json) => m.name).join(", "),
      affectedFiles: [file],
    });
    constraints.push({
      code: "PRESERVE_SIDE_EFFECT_FLOW",
      reason: "Context and side effects may change",
      instruction:
        "Preserve initialization, cleanup, context, callbacks, async work, state writes and data reconstruction",
    });
  }
  if (a.externalCallers.length)
    constraints.push({
      code: "PRESERVE_GOD_CLASS_ENTRY_POINTS",
      reason: "External production callers exist",
      instruction:
        "Preserve class, method and field contracts unless migration is explicitly justified",
    });
  return [risks, constraints];
}
