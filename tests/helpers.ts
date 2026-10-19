import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import type { RefactorTask, CommandSpec, Config } from "../src/models.js";
import { writeJson, writeText } from "../src/utils.js";
export function fixture(t: TestContext): string {
  const base = path.resolve(".test-tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "ts-"));
  t.after(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  );
  return root;
}
export function task(
  root: string,
  smell = "feature-envy",
  file = "entry/src/main/ets/Page.ets",
  symbol: string | null = "work",
): RefactorTask {
  return {
    schema_version: "1.0",
    task_id: "T",
    source_project: "demo",
    commit_hash: "",
    workspace_root: root,
    project_root: root,
    smell_type: smell,
    rule:
      smell === "god-class"
        ? "formal/god-class"
        : smell === "cyclic-dependency"
          ? "formal/directory-cycle"
          : `@extrulesproject/${smell}-check`,
    severity: "SUGGESTION",
    message: `Method '${symbol}' is feature-envious toward 'Info' (ATFD=5, LDA=0.00, CPFD=1).`,
    target: {
      file_path: file,
      symbol,
      range: { start_line: 1, end_line: 30, column: 1 },
      related_targets: [],
    },
    raw: {},
  };
}
export function setupTask(root: string): string {
  const dir = path.join(root, "task");
  writeJson(path.join(dir, "task.json"), task(root));
  writeJson(path.join(dir, "risk-report.json"), {});
  return dir;
}
export const spec = (
  script = "",
  more: Partial<CommandSpec> = {},
): CommandSpec => ({ command: [process.execPath, "-e", script], ...more });
export function goodConfig(): Config {
  return {
    refactorAgent: spec(),
    gates: Object.fromEntries(
      ["smell", "build", "test", "linter"].map((n) => [n, spec()]),
    ),
    reviewAgent: spec(
      'console.log(JSON.stringify({verdict:"PASS",issues:[]}))',
    ),
    repairAgent: spec(),
    taskTimeoutSeconds: 30,
    maxRepairAttempts: 3,
  };
}
export function makeProject(root: string): {
  source: string;
  taskDir: string;
  target: string;
} {
  const source = path.join(root, "app"),
    taskDir = path.join(root, "task"),
    target = path.join(source, "feature/src/main/ets/Page.ets");
  writeText(target, "export class Page {\n  work() { return 1; }\n}");
  writeText(
    path.join(source, "build-profile.json5"),
    "{modules:[{name:'featureName',srcPath:'feature'},{name:'host',srcPath:'products/phone'}]}",
  );
  writeJson(path.join(taskDir, "task.json"), {
    ...task(root),
    project_root: source,
    source_project: "app",
    target: {
      ...task(root).target,
      file_path: "app/feature/src/main/ets/Page.ets",
    },
  });
  writeJson(path.join(taskDir, "risk-report.json"), {});
  return { source, taskDir, target };
}
export function suite(
  source: string,
  kind: "local" | "instrument",
  name = "Page",
  module = "feature",
  register = true,
): string {
  const dir = path.join(
      source,
      module,
      kind === "local" ? "src/test" : "src/ohosTest/ets/test",
    ),
    file = path.join(dir, `${name}.test.ets`);
  writeText(
    file,
    `// describe('CommentedOut', () => {})\nexport default function run() { describe('${name}Test', () => {}); }`,
  );
  if (register) {
    const entry = path.join(dir, "List.test.ets"),
      old = fs.existsSync(entry) ? fs.readFileSync(entry, "utf8") : "";
    writeText(
      entry,
      `import run${name} from './${name}.test';\n${old}\nrun${name}();`,
    );
  }
  return file;
}
export const success = (name = "PageTest") =>
  `class=${name}\ntest=case\nresult=Success\nTests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\n`;
