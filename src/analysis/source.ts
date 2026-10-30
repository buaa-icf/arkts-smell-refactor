import { escapeRe } from "../utils.js";
/** Preserve offsets and line breaks while masking comments and optionally strings. */
export function mask(source: string, strings = true): string {
  const chars = source.split("");
  let state = "code";
  for (let i = 0; i < chars.length; i++) {
    const c = source[i],
      n = source[i + 1];
    if (state === "code") {
      if (c === "/" && (n === "/" || n === "*")) {
        state = n === "/" ? "line" : "block";
        chars[i] = chars[++i] = " ";
      } else if ("'\"`".includes(c)) {
        state = c;
        if (strings) chars[i] = " ";
      }
    } else if (state === "line") {
      if (c === "\n") state = "code";
      else chars[i] = " ";
    } else if (state === "block") {
      if (c === "*" && n === "/") {
        chars[i] = chars[++i] = " ";
        state = "code";
      } else if (c !== "\n" && c !== "\r") chars[i] = " ";
    } else {
      if (strings && c !== "\n" && c !== "\r") chars[i] = " ";
      if (c === "\\") {
        i++;
        if (strings && source[i] !== "\n" && i < chars.length) chars[i] = " ";
      } else if (c === state) state = "code";
    }
  }
  return chars.join("");
}
export function matching(
  source: string,
  start: number,
  open = "{",
  close = "}",
): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i;
  }
  return -1;
}
export const lineAt = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;
export function symbolRegion(
  source: string,
  symbol: string | null,
): {
  text: string;
  startLine: number;
  start: number;
  end: number;
  located: boolean;
} {
  if (symbol) {
    const name = escapeRe(
        symbol
          .split(".")
          .at(-1)!
          .replace(/^%AM\d+\$/, ""),
      ),
      code = mask(source);
    const patterns = [
      new RegExp(
        `^[ \\t]*(?:(?:export|public|private|protected|static|async|override)\\s+)*(?:function\\s+)?${name}(?:\\s*<[^>{}]+>)?\\s*\\(`,
        "m",
      ),
      new RegExp(
        `^[ \\t]*(?:(?:export|public|private|protected|static|readonly)\\s+)*(?:(?:const|let|var)\\s+)?${name}\\s*=\\s*(?:async\\s*)?\\(`,
        "m",
      ),
    ];
    for (const re of patterns) {
      const m = re.exec(code);
      if (!m) continue;
      const brace = code.indexOf("{", m.index + m[0].length),
        end = brace < 0 ? -1 : matching(code, brace);
      if (end >= 0)
        return {
          text: source.slice(m.index, end + 1),
          startLine: lineAt(source, m.index),
          start: m.index,
          end,
          located: true,
        };
    }
  }
  return {
    text: source,
    startLine: 1,
    start: 0,
    end: source.length - 1,
    located: false,
  };
}
export function ownerAtLine(
  source: string,
  line: number,
  fallback: string,
): string {
  return (
    [
      ...source
        .split("\n")
        .slice(0, Math.max(0, line - 1))
        .join("\n")
        .matchAll(/\b(?:class|struct)\s+([A-Za-z_$][\w$]*)/g),
    ].at(-1)?.[1] ?? fallback
  );
}
export function rangeText(
  source: string,
  start?: number | null,
  end?: number | null,
): string {
  return start
    ? source
        .split(/\r?\n/)
        .slice(Math.max(0, start - 1), end ?? start)
        .join("\n")
    : source;
}
export const stateWrites = (s: string) =>
  [
    ...new Set(
      [
        ...mask(s).matchAll(
          /\bthis\.([A-Za-z_$][\w$]*)\s*(?:\+\+|--|[+\-*/%]?=(?!=))/g,
        ),
      ].map((m) => m[1]),
    ),
  ].sort();
export const controls = (s: string) =>
  ["break", "return", "throw", "continue", "await"].filter((t) =>
    new RegExp(`\\b${t}\\b`).test(mask(s)),
  );
export function splitParameters(params: string): string[] {
  const rows: string[] = [];
  let start = 0,
    depth = 0;
  for (let i = 0; i < params.length; i++) {
    if ("<([{".includes(params[i])) depth++;
    else if (">)]}".includes(params[i]) && depth) depth--;
    else if (params[i] === "," && depth === 0) {
      if (params.slice(start, i).trim())
        rows.push(params.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (params.slice(start).trim()) rows.push(params.slice(start).trim());
  return rows;
}
