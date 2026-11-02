import path from "node:path";
import fs from "node:fs";
import type { Json } from "./models.js";
import { escapeRe, hash, isFile, isTest, readText, within } from "./utils.js";
import { lineAt, mask, matching } from "./analysis/source.js";
import { firstSource, resolveDependency } from "./workspace.js";

function testDependency(
  file: string,
  specifier: string,
  root: string,
): string | null {
  const found = specifier.startsWith(".")
    ? firstSource(path.resolve(path.dirname(file), specifier))
    : resolveDependency(file, specifier, root);
  return found &&
    within(found, root) &&
    within(fs.realpathSync(found), fs.realpathSync(root))
    ? found
    : null;
}

/** A pre-refactor identity, never inferred from the agent's renamed implementation. */
export function sourceInterface(
  file: string,
  symbol: string | null,
  line = 1,
): Json | null {
  if (!isFile(file)) return null;
  const text = readText(file),
    code = mask(text),
    method = symbol
      ?.split(".")
      .at(-1)
      ?.replace(/^%AM\d+\$/, ""),
    requestedOwner = symbol?.includes(".") ? symbol.split(".").at(-2) : null,
    owners = [...code.matchAll(/\b(?:class|struct)\s+([\w$]+)[^{]*\{/g)].map(
      (m) => ({
        name: m[1],
        start: code.indexOf("{", m.index!),
        end: matching(code, code.indexOf("{", m.index!)),
      }),
    ),
    regions: Json[] = [];
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (method && m[1] !== method) continue;
    if (["if", "for", "while", "switch", "catch", "with"].includes(m[1]))
      continue;
    if (/[.\w$]/.test(code[m.index! - 1] ?? " ")) continue;
    const open = code.indexOf("(", m.index!),
      close = matching(code, open, "(", ")");
    if (close < 0) continue;
    const tail = /^\s*(?::\s*[^;={}]+)?\s*\{/.exec(code.slice(close + 1));
    if (!tail) continue;
    const brace = close + 1 + tail[0].lastIndexOf("{"),
      end = matching(code, brace);
    if (end < 0) continue;
    const owner =
      owners
        .filter((o) => o.start < m.index! && o.end >= end)
        .sort((a, b) => b.start - a.start)[0]?.name ?? null;
    if (requestedOwner && owner !== requestedOwner) continue;
    regions.push({
      file: path.resolve(file),
      owner,
      method: m[1],
      signature: text.slice(open, close + 1),
      startLine: lineAt(text, m.index!),
      endLine: lineAt(text, end),
      sourceSha256: hash(file),
    });
  }
  const enclosing = regions.filter(
    (r) => r.startLine <= line && r.endLine >= line,
  );
  return enclosing.length === 1
    ? enclosing[0]
    : regions.length === 1
      ? regions[0]
      : null;
}

function suites(
  text: string,
): { name: string; start: number; end: number; code: string }[] {
  const visible = mask(text, false),
    code = mask(text),
    result = [];
  for (const m of visible.matchAll(
    /\bdescribe\s*\(\s*['"]([^'"\r\n]+)['"]\s*,/g,
  )) {
    const open = code.indexOf("(", m.index!),
      end = matching(code, open, "(", ")");
    if (end >= 0)
      result.push({
        name: m[1],
        start: m.index!,
        end: end + 1,
        code: code.slice(m.index!, end + 1),
      });
  }
  return result;
}

type Binding = { local: string; exported: string; file: string };
function imports(file: string, root: string): Binding[] {
  const result: Binding[] = [],
    text = mask(readText(file), false);
  for (const m of text.matchAll(
    /\bimport\s+(?!type\b)([^;'"`]+?)\s+from\s*['"]([^'"\r\n]+)['"]/g,
  )) {
    const dependency = testDependency(file, m[2], root);
    if (!dependency) continue;
    const names = /\{([^}]+)\}/.exec(m[1]);
    if (names)
      for (const entry of names[1].split(",")) {
        const n = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(entry);
        if (n)
          result.push({
            local: n[2] ?? n[1],
            exported: n[1],
            file: dependency,
          });
      }
    const primary = /^\s*([\w$]+)(?:\s*,|\s*$)/.exec(m[1]);
    if (primary)
      result.push({ local: primary[1], exported: "default", file: dependency });
  }
  return result;
}

/** Hash test-local helper dependencies, but never freeze mutable production code. */
export function testSupportFiles(files: string[], root: string): string[] {
  const seen = new Set<string>(),
    pending = [...files];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const binding of imports(file, root))
      if (isTest(binding.file)) pending.push(binding.file);
  }
  return [...seen];
}

function resolvesTo(
  binding: Binding,
  target: Json,
  root: string,
  seen = new Set<string>(),
): boolean {
  const key = binding.file + "#" + binding.exported;
  if (seen.has(key) || seen.size >= 80) return false;
  seen.add(key);
  if (path.resolve(binding.file) === target.file) {
    if (binding.exported === "default")
      return new RegExp(
        `\\bexport\\s+default\\s+(?:(?:class|function)\\s+)?${escapeRe(target.owner ?? target.method)}\\b`,
      ).test(mask(readText(binding.file)));
    return binding.exported === (target.owner ?? target.method);
  }
  const text = mask(readText(binding.file), false);
  for (const m of text.matchAll(
    /\bexport\s+(\*|\{[^}]+\})\s+from\s*['"]([^'"\r\n]+)['"]/g,
  )) {
    const dependency = testDependency(binding.file, m[2], root);
    if (!dependency) continue;
    if (m[1] === "*") {
      if (resolvesTo({ ...binding, file: dependency }, target, root, seen))
        return true;
    } else
      for (const entry of m[1].slice(1, -1).split(",")) {
        const n = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(entry);
        if (
          n &&
          (n[2] ?? n[1]) === binding.exported &&
          resolvesTo(
            { local: binding.local, exported: n[1], file: dependency },
            target,
            root,
            seen,
          )
        )
          return true;
      }
  }
  return false;
}

function directReference(
  code: string,
  bindings: Binding[],
  target: Json,
  root: string,
): boolean {
  for (const binding of bindings.filter((b) => resolvesTo(b, target, root))) {
    const name = escapeRe(binding.local),
      method = escapeRe(target.method);
    if (!target.owner && new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(code))
      return true;
    if (!target.owner) continue;
    if (new RegExp(`\\b${name}\\s*\\.\\s*${method}\\s*\\(`).test(code))
      return true;
    const receivers = new Set<string>();
    for (const re of [
      new RegExp(`\\b([\\w$]+)\\s*[!?]?\\s*:\\s*${name}\\b`, "g"),
      new RegExp(`\\b([\\w$]+)\\s*=\\s*new\\s+${name}\\s*\\(`, "g"),
    ])
      for (const m of code.matchAll(re)) receivers.add(m[1]);
    for (const receiver of receivers)
      if (
        new RegExp(
          `\\b${escapeRe(receiver)}\\s*!?\\s*(?:\\?\\.|\\.)\\s*${method}\\s*\\(`,
        ).test(code)
      )
        return true;
    if (
      new RegExp(
        `\\bnew\\s+${name}\\s*\\([^;{}]*?\\)\\s*\\.\\s*${method}\\s*\\(`,
      ).test(code)
    )
      return true;
  }
  return false;
}

function localHelpers(
  code: string,
): { name: string; start: number; end: number; code: string }[] {
  const result = [];
  for (const m of code.matchAll(/\bfunction\s+([\w$]+)\s*\(/g)) {
    const open = code.indexOf("(", m.index!),
      close = matching(code, open, "(", ")");
    if (close < 0) continue;
    const tail = /^\s*(?::[^;={}]+)?\s*\{/.exec(code.slice(close + 1));
    if (!tail) continue;
    const brace = close + 1 + tail[0].lastIndexOf("{"),
      end = matching(code, brace);
    if (end >= 0)
      result.push({
        name: m[1],
        start: m.index!,
        end: end + 1,
        code: code.slice(m.index!, end + 1),
      });
  }
  return result;
}

/** Positive, import/type-backed evidence. Absence of a match is NOT proof of no coverage. */
export function interfaceTestMatches(
  files: string[],
  target: Json,
  root: string,
): Json[] {
  const result: Json[] = [];
  for (const file of files) {
    const text = readText(file),
      regions = suites(text),
      all = mask(text),
      helpers = localHelpers(all);
    let shared = all;
    for (const region of [...regions, ...helpers].sort(
      (a, b) => b.start - a.start,
    ))
      shared =
        shared.slice(0, region.start) +
        shared.slice(region.start, region.end).replace(/[^\r\n]/g, " ") +
        shared.slice(region.end);
    const bindings = imports(file, root);
    for (const region of regions) {
      let reachable = shared + "\n" + region.code;
      const used = new Set<string>();
      for (let round = 0; round < 12; round++) {
        const newly = helpers.filter(
          (h) =>
            !used.has(h.name) &&
            new RegExp(`\\b${escapeRe(h.name)}\\s*\\(`).test(reachable),
        );
        if (!newly.length) break;
        for (const h of newly) {
          used.add(h.name);
          reachable += "\n" + h.code;
        }
      }
      let evidence: string | null = directReference(
        reachable,
        bindings,
        target,
        root,
      )
        ? "import-and-receiver-call"
        : null;
      const seen = new Set<string>(),
        pending = bindings.filter((b) =>
          new RegExp(`\\b${escapeRe(b.local)}\\s*\\(`).test(reachable),
        );
      while (!evidence && pending.length && seen.size < 40) {
        const helper = pending.pop()!;
        const key = helper.file + "#" + helper.exported;
        if (seen.has(key) || !within(helper.file, root)) continue;
        seen.add(key);
        const allHelperCode = mask(readText(helper.file)),
          definitions = localHelpers(allHelperCode),
          exported =
            helper.exported === "default"
              ? /\bexport\s+default\s+function\s+([\w$]+)/.exec(
                  allHelperCode,
                )?.[1]
              : helper.exported,
          entry = definitions.find((d) => d.name === exported);
        if (!entry) continue; // An unresolved dynamic/class helper is not positive evidence.
        let helperCode = allHelperCode;
        for (const d of [...definitions].sort((a, b) => b.start - a.start))
          helperCode =
            helperCode.slice(0, d.start) +
            helperCode.slice(d.start, d.end).replace(/[^\r\n]/g, " ") +
            helperCode.slice(d.end);
        helperCode += "\n" + entry.code;
        const reached = new Set([entry.name]);
        for (let round = 0; round < 12; round++) {
          const next = definitions.filter(
            (d) =>
              !reached.has(d.name) &&
              new RegExp(`\\b${escapeRe(d.name)}\\s*\\(`).test(helperCode),
          );
          if (!next.length) break;
          for (const d of next) {
            reached.add(d.name);
            helperCode += "\n" + d.code;
          }
        }
        const helperBindings = imports(helper.file, root);
        if (directReference(helperCode, helperBindings, target, root))
          evidence = "imported-helper-call";
        else
          pending.push(
            ...helperBindings.filter((b) =>
              new RegExp(`\\b${escapeRe(b.local)}\\s*\\(`).test(helperCode),
            ),
          );
      }
      if (evidence) result.push({ file, suite: region.name, evidence, target });
    }
  }
  return result;
}
