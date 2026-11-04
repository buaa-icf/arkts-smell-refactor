import path from "node:path";
import type { Json } from "./models.js";
import {
  callArguments,
  lineAt,
  mask,
  matching,
  splitParameters,
} from "./analysis/source.js";
import { braceDepths } from "./analysis/god_class.js";
import {
  escapeRe,
  hash,
  isFile,
  isTest,
  readJson,
  readText,
  relative,
  sourceFiles,
  within,
} from "./utils.js";

// Deliberately support only static, unescaped IDs. Dynamic IDs and unresolved
// helpers cannot establish attribution. This evidence never narrows test selection.
const literal = (s: string) => /^\s*(['"])([^'"\\\r\n]+)\1\s*$/.exec(s)?.[2];
function calls(text: string, pattern: RegExp) {
  const code = mask(text),
    result = [];
  for (const m of code.matchAll(pattern)) {
    const open = m.index! + m[0].lastIndexOf("("),
      end = matching(code, open, "(", ")");
    if (end < 0) continue;
    result.push({ start: m.index!, end, args: callArguments(text, open, end) });
  }
  return result;
}

export function productionUiIds(text: string): { id: string; line: number }[] {
  return calls(text, /\.\s*id\s*\(/g).flatMap((c) => {
    const id = c.args.length === 1 ? literal(c.args[0]) : undefined;
    return id ? [{ id, line: lineAt(text, c.start) }] : [];
  });
}

/** Case-local selectors only: hooks and other cases cannot lend their IDs. */
export function uiTestCases(text: string): Json[] {
  const code = mask(text),
    visible = mask(text, false),
    depths = braceDepths(code);
  const imports = [
    ...visible.matchAll(
      /\bimport\s*\{([^}]+)\}\s*from\s*['"](?:@kit\.TestKit|@ohos\.uitest)['"]/gi,
    ),
  ].filter((m) => code.startsWith("import", m.index!));
  let bindingCode = code;
  for (const m of imports)
    bindingCode =
      bindingCode.slice(0, m.index!) +
      " ".repeat(m[0].length) +
      bindingCode.slice(m.index! + m[0].length);
  const selectors = imports
    .flatMap((m) =>
      m[1].split(",").flatMap((n) => {
        const b = /^\s*ON(?:\s+as\s+([\w$]+))?\s*$/.exec(n);
        return b ? [b[1] ?? "ON"] : [];
      }),
    )
    .filter(
      (selector) =>
        !new RegExp(
          `\\b(?:let|const|var|function)\\s+${escapeRe(selector)}\\b|[,(]\\s*${escapeRe(selector)}\\s*[:,)]|\\b${escapeRe(selector)}\\s*=(?!=|>)`,
        ).test(bindingCode),
    );
  const helpers: { name: string; index: number }[] = [];
  for (const fn of code.matchAll(/\bfunction\s+([\w$]+)\s*\(/g)) {
    if (depths[fn.index!] !== 0) continue;
    const open = fn.index! + fn[0].lastIndexOf("("),
      end = matching(code, open, "(", ")");
    if (end < 0) continue;
    const tail = /^\s*(?::[^{};=]+)?\s*\{/.exec(code.slice(end + 1));
    if (!tail) continue;
    const brace = end + 1 + tail[0].lastIndexOf("{"),
      close = matching(code, brace);
    if (close < 0) continue;
    const params = splitParameters(code.slice(open + 1, end)).map(
      (p) => /^([\w$]+)\s*:/.exec(p)?.[1],
    );
    const body = code.slice(brace + 1, close);
    // Only a direct waitForComponent(ON.id(parameter), ...) forwarding helper.
    // Reject nested scopes, rebinding and destructuring rather than guessing flow.
    if (/\b(?:function|class)\b|=>/.test(body)) continue;
    for (const selector of selectors) {
      if (params.includes(selector)) continue;
      const match = new RegExp(
        `\\b[\\w$]+\\s*\\.\\s*waitForComponent\\s*\\(\\s*${escapeRe(selector)}\\s*\\.\\s*id\\s*\\(\\s*([\\w$]+)\\s*\\)`,
      ).exec(body);
      const index = match ? params.indexOf(match[1]) : -1;
      if (index < 0) continue;
      const name = escapeRe(match![1]);
      if (
        new RegExp(
          `\\b(?:let|const|var)\\s+${name}\\b|\\b${name}\\s*(?:[+*/%-]?=(?!=|>)|\\+\\+|--)|[{}\\[\\]]\\s*=`,
        ).test(body)
      )
        continue;
      helpers.push({ name: fn[1], index });
    }
  }
  const suites = calls(text, /(?<![\w$.])describe\s*\(/g).flatMap((c) => {
    const name = literal(c.args[0]);
    return name ? [{ ...c, name }] : [];
  });
  const result: Json[] = [];
  for (const c of calls(text, /(?<![\w$.])it\s*\(/g)) {
    const caseName = literal(c.args[0]),
      owners = suites.filter((s) => s.start < c.start && c.end < s.end);
    if (!caseName || owners.length !== 1) continue;
    const suite = owners[0],
      body = text.slice(c.start, c.end + 1),
      ids: Json[] = [];
    const bodyCode = mask(body),
      nested =
        /\bfunction\b/.test(bodyCode) ||
        [...bodyCode.matchAll(/=>/g)].length !== 1;
    if (nested) {
      result.push({
        suite: suite.name,
        caseName,
        line: lineAt(text, c.start),
        selectors: [],
      });
      continue;
    }
    for (const selector of selectors) {
      for (const call of calls(
        body,
        new RegExp(
          `\\b[\\w$]+\\s*\\.\\s*(?:waitForComponent|findComponent|findComponents|assertComponentExist)\\s*\\(\\s*${escapeRe(selector)}\\s*\\.\\s*id\\s*\\(`,
          "g",
        ),
      )) {
        const id = literal(call.args[0]);
        if (id && call.args.length === 1)
          ids.push({
            id,
            line: lineAt(text, c.start + call.start),
            via: selector + ".id",
          });
      }
    }
    for (const helper of helpers) {
      const name = escapeRe(helper.name);
      if (
        helpers.filter((h) => h.name === helper.name).length !== 1 ||
        new RegExp(
          `\\b(?:let|const|var)\\s+${name}\\b|[,(]\\s*${name}\\s*[:,)]|\\b${name}\\s*=(?!=|>)`,
        ).test(code)
      )
        continue;
      // No second declaration (including unsupported overloads) may shadow it.
      if (
        [...code.matchAll(new RegExp(`\\bfunction\\s+${name}\\s*\\(`, "g"))]
          .length !== 1
      )
        continue;
      for (const call of calls(
        body,
        new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g"),
      )) {
        const id = literal(call.args[helper.index] ?? "");
        if (id)
          ids.push({
            id,
            line: lineAt(text, c.start + call.start),
            via: helper.name,
          });
      }
    }
    result.push({
      suite: suite.name,
      caseName,
      line: lineAt(text, c.start),
      selectors: ids,
    });
  }
  return result;
}

export function freezeUiCaseEvidence(
  root: string,
  task: Json,
  jobs: Json[],
): Json[] {
  const base = task.workspace_root ?? task.workspaceRoot;
  const targetFiles = new Set([
    path.resolve(base, task.target.file_path ?? task.target.filePath),
    ...(task.target.related_targets ?? task.target.relatedTargets ?? []).map(
      (r: Json) => path.resolve(base, r.filePath),
    ),
  ]);
  const evidence: Json[] = [];
  if (!jobs.some((j) => j.kind === "instrument")) return evidence;
  // Index once across the application: another module may render a reused ID.
  const owners = new Map<string, { file: string; line: number }[]>();
  for (const file of sourceFiles(root).filter((f) => !isTest(f))) {
    for (const item of productionUiIds(readText(file))) {
      const entries = owners.get(item.id) ?? [];
      entries.push({ file, line: item.line });
      owners.set(item.id, entries);
    }
  }
  for (const job of jobs.filter((j) => j.kind === "instrument")) {
    const moduleRoot = path.resolve(root, job.modulePath);
    if (!within(moduleRoot, root)) continue;
    const cases = job.testFiles.flatMap((file: string) => {
      const absolute = path.resolve(root, file);
      return within(absolute, root) && isFile(absolute)
        ? uiTestCases(readText(absolute)).map((c) => ({ ...c, file }))
        : [];
    });
    for (const c of cases) {
      if (
        !job.expectedSuites.includes(c.suite) ||
        cases.filter(
          (other: Json) =>
            other.suite === c.suite && other.caseName === c.caseName,
        ).length !== 1
      )
        continue;
      for (const selector of c.selectors) {
        const locations = owners.get(selector.id) ?? [];
        // Reused IDs (even within one file) cannot identify a unique component.
        if (locations.length !== 1 || !targetFiles.has(locations[0].file))
          continue;
        const location = locations[0];
        evidence.push({
          evidence: "original-ui-id",
          module: job.module,
          kind: job.kind,
          file: c.file,
          suite: c.suite,
          caseName: c.caseName,
          uiId: selector.id,
          testLine: selector.line,
          via: selector.via,
          productionFile: relative(location.file, root),
          productionLine: location.line,
          productionSha256: hash(location.file),
        });
      }
    }
  }
  return evidence;
}

/** Use only pre-agent evidence bound to this task, job, unchanged test and case. */
export function frozenUiFailureEvidence(
  taskDir: string,
  job: Json,
  c: Json,
  changes: string[],
): Json[] {
  const file = path.join(taskDir, "baseline-test-plan.json");
  if (!isFile(file)) return [];
  const frozen = readJson(file);
  if (frozen.taskSha256 !== hash(path.join(taskDir, "task.json"))) return [];
  return (frozen.uiCaseEvidence ?? []).filter((e: Json) => {
    const test = path.resolve(frozen.sourceRoot, e.file);
    return (
      e.evidence === "original-ui-id" &&
      e.module === job.module &&
      e.kind === job.kind &&
      e.suite === c.suite &&
      e.caseName === c.name &&
      (job.testFiles ?? []).includes(e.file) &&
      (job.expectedSuites ?? []).includes(e.suite) &&
      changes.some((f) => f.replaceAll("\\", "/") === e.productionFile) &&
      within(test, frozen.sourceRoot) &&
      isFile(test) &&
      hash(test) === frozen.testHashes?.[e.file]
    );
  });
}
