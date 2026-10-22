import type { Json, RefactorTask } from "../models.js";
import {
  controls,
  lineAt,
  mask,
  matching,
  stateWrites,
  symbolRegion,
} from "./source.js";
import { unique } from "../utils.js";
interface Case {
  label: string;
  body: string;
  isDefault: boolean;
}
function parseCases(
  source: string,
  code: string,
  start: number,
  end: number,
): Case[] {
  const labels: {
    start: number;
    body: number;
    label: string;
    isDefault: boolean;
  }[] = [];
  let depth = 1;
  for (let i = start + 1; i < end; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") depth--;
    else if (depth === 1) {
      const m = /^(case|default)\b/.exec(code.slice(i));
      if (!m || (i && /[\w$]/.test(code[i - 1]))) continue;
      let p = 0,
        b = 0;
      for (let j = i + m[0].length; j < end; j++) {
        const c = code[j];
        if (c === "(") p++;
        else if (c === ")") p--;
        else if (c === "[") b++;
        else if (c === "]") b--;
        else if (!p && !b && c === ":") {
          labels.push({
            start: i,
            body: j + 1,
            label:
              m[1] === "default"
                ? "default"
                : source.slice(i + m[0].length, j).trim(),
            isDefault: m[1] === "default",
          });
          i = j;
          break;
        } else if (!p && !b && "{}".includes(c)) break;
      }
    }
  }
  return labels.map((x, i) => ({
    label: x.label,
    body: source.slice(x.body, labels[i + 1]?.start ?? end).trim(),
    isDefault: x.isDefault,
  }));
}
function terminal(body: string): string | null {
  let value = mask(body).trim();
  if (value.startsWith("{") && matching(value, 0) === value.length - 1)
    value = value.slice(1, -1).trim();
  let depth = 0,
    last: RegExpMatchArray | null = null;
  for (const m of value.matchAll(/[{}]|\b(?:break|return|throw|continue)\b/g)) {
    if (m[0] === "{") depth++;
    else if (m[0] === "}") depth--;
    else if (!depth) last = m;
  }
  return last &&
    (["return", "throw"].includes(last[0]) ||
      /^;?$/.test(value.slice(last.index! + last[0].length).trim()))
    ? last[0]
    : null;
}
function grouped(cases: Case[]): string[][] {
  const result: string[][] = [];
  let pending: string[] = [];
  for (const c of cases) {
    if (!mask(c.body).trim()) pending.push(c.label);
    else if (pending.length) {
      result.push([...pending, c.label]);
      pending = [];
    }
  }
  if (pending.length) result.push(pending);
  return result;
}
function fallthrough(cases: Case[]): string[] {
  return cases
    .slice(0, -1)
    .filter((c) => mask(c.body).trim() && !terminal(c.body))
    .map((c) => c.label);
}
function recommend(cases: Case[]): [string, string] {
  if (fallthrough(cases).length)
    return [
      "extract-method-or-strategy",
      "存在执行语句后继续落入下一 case 的 fall-through，直接查表会改变执行序列",
    ];
  const normalized = cases
    .filter((c) => c.body.trim())
    .map((c) => {
      let s = mask(c.body, false).trim();
      if (s.startsWith("{") && matching(mask(s), 0) === s.length - 1)
        s = s.slice(1, -1).trim();
      return s.replace(/\b(?:break|continue)\s*;?\s*$/, "").trim();
    });
  if (
    normalized.length &&
    normalized.every((s) => /^return\s+[^;]+;?$/s.test(s))
  )
    return [
      "value-map",
      "各分支直接返回一个值，适合 Map<K, V> 并显式保留 fallback",
    ];
  const assignments = normalized.map((s) =>
    /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*.+;?$/s.exec(s),
  );
  if (
    assignments.length &&
    assignments.every(Boolean) &&
    unique(assignments.map((m) => m![1])).length === 1
  )
    return ["value-map", "各分支给同一目标赋值，适合 Map<K, V> 后统一赋值"];
  if (grouped(cases).length && unique(normalized).length <= 2)
    return [
      "set-or-value-map",
      "多个标签共享少量行为，适合 Set<K> 分组或 Map<K, V>",
    ];
  if (
    normalized.length &&
    normalized.every(
      (s) =>
        !/\b(?:if|switch|for|while|try|catch)\b/.test(s) &&
        s.split(";").filter((x) => x.trim()).length <= 2,
    )
  )
    return [
      "handler-map",
      "各分支是独立动作，适合具名函数类型的 Map<K, Handler>",
    ];
  return [
    "extract-method-or-strategy",
    "分支包含复合状态变化或嵌套控制流，优先提取具名方法/策略，避免巨型内联 handler Map",
  ];
}
export function analyzeSwitch(task: RefactorTask, source: string): Json {
  const countMatch = /Switch statement with (\d+) cases/i.exec(task.message),
    ifMatch = /Long if-else chain with (\d+) branches/i.exec(task.message),
    reported = countMatch ? +countMatch[1] : ifMatch ? +ifMatch[1] : null;
  const region = symbolRegion(source, task.target.symbol),
    code = mask(region.text),
    evidence = region.located ? "target-symbol" : "target-file";
  if (ifMatch) {
    const first = /\bif\s*\(/.exec(code),
      eq = [
        ...region.text.matchAll(
          /(?:\bif|\belse\s+if)\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*={2,3}\s*([^\)]+)\)/g,
        ),
      ],
      same = eq.length && unique(eq.map((m) => m[1])).length === 1,
      valueMap =
        same &&
        [...code.matchAll(/\{\s*return\s+[^;{}]+;?\s*\}/g)].length >= eq.length;
    return {
      conditionalType: "if-else-chain",
      located: !!first,
      evidenceSource: first ? evidence : "detector-message",
      startLine: first
        ? region.startLine + lineAt(region.text, first.index) - 1
        : null,
      reportedBranchCount: reported,
      branchCount: first
        ? 1 + [...code.matchAll(/\belse\s+if\s*\(/g)].length
        : reported,
      selector: same ? eq[0][1] : null,
      hasFinalElse: /\belse\s*\{/.test(code),
      controlFlow: controls(region.text),
      stateWrites: stateWrites(region.text),
      hasAsyncWork: /\bawait\b/.test(code),
      recommendedPattern: valueMap ? "value-map" : "extract-method-or-strategy",
      recommendationReason: valueMap
        ? "各条件比较同一选择值并直接返回，适合 Map<K, V>"
        : "条件并非单纯的同键值映射，优先提取谓词或策略，保留短路求值顺序",
      limitations: [
        "if/else 链分析为词法级近似；必须保留条件求值、短路和最终 else 行为",
      ],
    };
  }
  const switches: Json[] = [];
  for (const m of code.matchAll(/\bswitch\s*\(/g)) {
    const paren = code.indexOf("(", m.index),
      cp = matching(code, paren, "(", ")"),
      brace = cp < 0 ? -1 : code.indexOf("{", cp),
      end = brace < 0 ? -1 : matching(code, brace);
    if (end < 0) continue;
    switches.push({
      startOffset: m.index,
      endOffset: end,
      startLine: region.startLine + lineAt(region.text, m.index) - 1,
      endLine: region.startLine + lineAt(region.text, end) - 1,
      discriminant: region.text.slice(paren + 1, cp).trim(),
      text: region.text.slice(m.index, end + 1),
      cases: parseCases(region.text, code, brace, end),
    });
  }
  const messageCases = [
    ...(
      task.message.match(/Case line counts:\s*(.*?)(?:\.\s*$|$)/i)?.[1] ?? ""
    ).matchAll(/(?:^|;\s*)(.*?)\s+\((\d+)\s+lines?\)/g),
  ].map((m) => ({ label: m[1].trim(), lines: +m[2] }));
  if (!switches.length)
    return {
      conditionalType: "switch",
      located: false,
      evidenceSource: "detector-message",
      reportedBranchCount: reported,
      caseLabels: messageCases.map((c) => c.label),
      caseLineCounts: messageCases,
      recommendedPattern:
        messageCases.length &&
        Math.max(...messageCases.map((c) => c.lines)) <= 3
          ? "value-map-or-handler-map"
          : "extract-method-or-strategy",
      limitations: [
        "未能在目标方法或文件中定位完整 switch；建议按检测消息中的标签人工核对",
      ],
    };
  const expected = messageCases.length || reported,
    top = switches.filter(
      (s) =>
        !switches.some(
          (o) =>
            o !== s &&
            o.startOffset < s.startOffset &&
            o.endOffset > s.endOffset,
        ),
    ),
    line = task.target.range.start_line;
  const exact = switches.filter(
    (s) => expected != null && s.cases.length === expected,
  );
  const selected =
    expected != null &&
    top.length > 1 &&
    top.reduce((n, s) => n + s.cases.length, 0) === expected
      ? top
      : [
          (exact.length ? exact : switches).sort(
            (a, b) =>
              (expected == null
                ? 0
                : Math.abs(a.cases.length - expected) -
                  Math.abs(b.cases.length - expected)) ||
              (line
                ? Math.abs(a.startLine - line) - Math.abs(b.startLine - line)
                : 0),
          )[0],
        ];
  const cases = selected.flatMap((s) => s.cases) as Case[],
    recommendations = selected.map((s) => recommend(s.cases)),
    selectedText = selected.map((s) => s.text).join("\n"),
    defaults = cases.filter((c) => c.isDefault);
  return {
    conditionalType: "switch",
    located: true,
    evidenceSource: evidence,
    startLine: Math.min(...selected.map((s) => s.startLine)),
    endLine: Math.max(...selected.map((s) => s.endLine)),
    switchCount: selected.length,
    switches: selected.map((s, i) => ({
      startLine: s.startLine,
      endLine: s.endLine,
      discriminant: s.discriminant,
      branchCount: s.cases.length,
      recommendedPattern: recommendations[i][0],
    })),
    discriminant: selected.length === 1 ? selected[0].discriminant : null,
    discriminants: selected.map((s) => s.discriminant),
    reportedBranchCount: reported,
    messageCaseCount: messageCases.length || null,
    branchCount: cases.length,
    branchCountMismatch: reported !== null && cases.length !== reported,
    caseLabels: cases.map((c) => c.label),
    caseLineCounts: messageCases.length
      ? messageCases
      : cases.map((c) => ({
          label: c.label,
          lines: Math.max(1, c.body.split("\n").length + 1),
        })),
    hasDefault: !!defaults.length,
    defaultCount: defaults.length,
    switchesWithoutDefault: selected.length - defaults.length,
    defaultBehavior: defaults.map(
      (c) =>
        mask(c.body, false).trim().replace(/\s+/g, " ").slice(0, 240) ||
        "empty",
    ),
    groupedCaseLabels: selected.flatMap((s) => grouped(s.cases)),
    executableFallthrough: selected.flatMap((s) => fallthrough(s.cases)),
    controlFlow: controls(selectedText),
    stateWrites: stateWrites(selectedText),
    hasAsyncWork: /\bawait\b/.test(mask(selectedText)),
    hasNestedConditional: cases.some((c) =>
      /\b(?:if|switch)\s*\(/.test(mask(c.body)),
    ),
    recommendedPattern:
      unique(recommendations.map((r) => r[0])).length === 1
        ? recommendations[0][0]
        : "mixed-strategies",
    recommendationReason: unique(recommendations.map((r) => r[1])).join("; "),
    limitations: [
      "分析为词法级近似；重构前仍需核对类型、重载、闭包捕获和 ArkUI 生命周期",
    ],
  };
}
