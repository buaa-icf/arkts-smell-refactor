import type { Json } from "../models.js";
import { lineAt } from "./source.js";

// Regex-looking spans are skipped conservatively, including division/regex
// ambiguities. This bounded lexical report is not a complete JS/ArkTS parser.
const TOKENS = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*`|\/(?![/*])(?:\\[^\r\n]|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*/g;
export const SHORT_LITERAL_SCOPE = "单/双引号静态短字符串 token 的解码值词法对照（最多 160 字符）；忽略注释，不求值模板或拼接，正则/除法歧义保守跳过，证据可能不完整。值仍存在不证明调用位置、次数、条件或整个重构等价。";
export const asciiLiteral = (value: string): string =>
  JSON.stringify(value).replace(/[^\x20-\x7e]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** Decode only standard quoted-string escapes. No eval, octal, or normalization. */
function decode(token: string): string | null {
  let result = "";
  const body = token.slice(1, -1), simple: Record<string, string> = {
    b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "/": "/", "'": "'", '"': '"',
  };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { result += body[i]; continue; }
    const next = body[++i];
    if (next in simple) { result += simple[next]; continue; }
    if (next === "\n") continue;
    if (next === "\r") { if (body[i + 1] === "\n") i++; continue; }
    if (next === "0" && !/\d/.test(body[i + 1] ?? "")) { result += "\0"; continue; }
    const tail = body.slice(i + 1);
    const escaped = next === "u" ? /^(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/.exec(tail)
      : next === "x" ? /^([0-9a-fA-F]{2})/.exec(tail) : null;
    if (!escaped) return null;
    const value = parseInt(escaped[1] ?? escaped[2], 16);
    if (value > 0x10ffff) return null;
    result += String.fromCodePoint(value);
    i += escaped[0].length;
  }
  return result;
}

export interface ShortLiteral {
  line: number;
  column: number;
  value: string;
  escapedValue: string;
}
export function shortLiterals(source: string): ShortLiteral[] {
  const result: ShortLiteral[] = [];
  for (const match of source.matchAll(TOKENS)) {
    if (!['"', "'"].includes(match[0][0])) continue;
    const lineStart = source.lastIndexOf("\n", match.index! - 1) + 1;
    const value = decode(match[0]);
    if (value === null || value.length > 160 || !/[^\x00-\x7f]/.test(value)) continue;
    result.push({ line: lineAt(source, match.index!), column: match.index! - lineStart + 1, value, escapedValue: asciiLiteral(value) });
  }
  return result;
}

export function scopedShortLiterals(source: string, startLine: number, endLine: number): Json {
  const entries = shortLiterals(source).filter(l => startLine <= l.line && l.line <= endLine);
  return { startLine, endLine, count: entries.length, omitted: Math.max(0, entries.length - 12),
    entries: entries.slice(0, 12).map(({ line, column, escapedValue }) => ({ line, column, escapedValue })) };
}

/** Presence comparison tolerates deduplication and equivalent Unicode escapes.
 * Missing/new values are review evidence, never an automatic verdict or repair. */
export function compareShortLiterals(before: string, after: string): Json {
  const grouped = (source: string) => {
    const values = new Map<string, ShortLiteral[]>();
    for (const literal of shortLiterals(source)) values.set(literal.value, [...(values.get(literal.value) ?? []), literal]);
    return values;
  };
  const left = grouped(before), right = grouped(after),
    missing = [...left.keys()].filter(v => !right.has(v)), added = [...right.keys()].filter(v => !left.has(v));
  const describe = (value: string, map: Map<string, ShortLiteral[]>) => ({ escapedValue: asciiLiteral(value),
    locations: map.get(value)!.slice(0, 4).map(l => ({ line: l.line, column: l.column })), occurrences: map.get(value)!.length });
  const possibleReplacements: Json[] = [];
  for (const value of missing.slice(0, 12)) {
    const a = [...value], candidates = added.map(v => {
      const b = [...v];
      if (a.length !== b.length || a.length < 3) return null;
      const differences = a.flatMap((c, i) => c === b[i] ? [] : [{ codePointIndex: i,
        before: "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"),
        after: "U+" + b[i].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0") }]);
      return differences.length > 0 && differences.length <= 2 && differences.length < a.length / 2 ? { value: v, differences } : null;
    }).filter(c => c !== null);
    if (candidates.length === 1) possibleReplacements.push({ before: asciiLiteral(value), after: asciiLiteral(candidates[0]!.value),
      differences: candidates[0]!.differences, note: "形近候选，需按原/当前调用点确认对应关系" });
  }
  return { scope: SHORT_LITERAL_SCOPE, baselineUniqueValues: left.size, currentUniqueValues: right.size,
    missingValueCount: missing.length, newValueCount: added.length,
    missingValues: missing.slice(0, 12).map(v => describe(v, left)), newValues: added.slice(0, 12).map(v => describe(v, right)),
    omittedMissing: Math.max(0, missing.length - 12), omittedNew: Math.max(0, added.length - 12), possibleReplacements };
}
