import crypto from "node:crypto";
import type { Json } from "../models.js";
/**
 * Exact lexical evidence for copying long static string segments without
 * retyping. Equal fingerprints mean identical string tokens joined only with
 * `+`; a different fingerprint proves nothing about value equality. Templates
 * and dynamic operands are deliberately not folded or evaluated.
 */
const TOKENS =
  /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*`/g;
const COMMENTS = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
const MIN_SEGMENT_CHARS = 200;
interface Token {
  text: string;
  start: number;
  end: number;
}
/** Deterministic ASCII JSON so equal token sequences always digest equally. */
function asciiJson(tokens: string[]): string {
  const quote = (value: string): string => {
    let out = '"';
    for (const char of value) {
      const code = char.codePointAt(0)!;
      if (char === '"') out += '\\"';
      else if (char === "\\") out += "\\\\";
      else if (char === "\n") out += "\\n";
      else if (char === "\r") out += "\\r";
      else if (char === "\t") out += "\\t";
      else if (char === "\b") out += "\\b";
      else if (char === "\f") out += "\\f";
      else if (code < 0x20 || code > 0x7e) {
        if (code <= 0xffff) out += "\\u" + code.toString(16).padStart(4, "0");
        else {
          const offset = code - 0x10000;
          out +=
            "\\u" +
            (0xd800 + (offset >> 10)).toString(16).padStart(4, "0") +
            "\\u" +
            (0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, "0");
        }
      } else out += char;
    }
    return out + '"';
  };
  return "[" + tokens.map(quote).join(",") + "]";
}
const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;
export function longLiteralSegments(
  text: string,
  startLine: number | null,
  endLine: number | null,
): Json[] {
  const groups: Token[][] = [];
  for (const match of text.matchAll(TOKENS)) {
    const token = match[0],
      start = match.index!,
      end = start + token.length;
    if (token.startsWith("//") || token.startsWith("/*")) continue;
    if (token.startsWith("`")) {
      groups.push([]);
      continue;
    }
    const last = groups.at(-1),
      gap = last?.length ? text.slice(last.at(-1)!.end, start) : "";
    if (last?.length && gap.replace(COMMENTS, "").trim() === "+")
      last.push({ text: token, start, end });
    else groups.push([{ text: token, start, end }]);
  }
  const result: Json[] = [];
  for (const group of groups) {
    if (!group.length) continue;
    const tokens = group.map((t) => t.text),
      size = tokens.reduce((n, t) => n + t.length, 0);
    if (size < MIN_SEGMENT_CHARS) continue;
    const first = group[0].start,
      last = group.at(-1)!.end,
      beginLine = lineOf(text, first),
      finishLine = lineOf(text, last);
    if ((endLine && beginLine > endLine) || (startLine && finishLine < startLine))
      continue;
    result.push({
      startLine: beginLine,
      startColumn: first - text.lastIndexOf("\n", first - 1),
      endLine: finishLine,
      endColumnExclusive: last - text.lastIndexOf("\n", last - 1),
      literalCount: tokens.length,
      literalTokenChars: size,
      tokenSha256: crypto
        .createHash("sha256")
        .update(asciiJson(tokens), "ascii")
        .digest("hex"),
      preview: tokens[0].slice(0, 64),
    });
  }
  return result;
}
export function sharedLiteralGroups(instances: Json[]): Json[] {
  const groups = new Map<string, Json[]>();
  instances.forEach((instance, index) => {
    for (const segment of (instance.longLiteralSegments ?? []) as Json[])
      groups.set(segment.tokenSha256, [
        ...(groups.get(segment.tokenSha256) ?? []),
        {
          instance: index,
          filePath: instance.filePath,
          startLine: segment.startLine,
          endLine: segment.endLine,
        },
      ]);
  });
  return [...groups]
    .filter(
      ([, occurrences]) => new Set(occurrences.map((o) => o.instance)).size > 1,
    )
    .map(([tokenSha256, occurrences]) => ({ tokenSha256, occurrences }));
}
