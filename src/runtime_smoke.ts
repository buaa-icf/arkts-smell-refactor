import path from "node:path";
import type { Json, RefactorTask } from "./models.js";
import { targetPath } from "./models.js";
import {
  copyTree,
  escapeRe,
  isFile,
  readText,
  relative,
  within,
  writeJson,
} from "./utils.js";
import { moduleInfo } from "./public_contract.js";
export function buildRuntimeSmokePlan(task: RefactorTask, risk: Json): Json {
  const base = {
      schemaVersion: "1.0",
      kind: "ordinary-construction",
      enabled: false,
      taskId: task.task_id,
      hiddenTestsUsed: false,
    },
    analysis = risk.godClassAnalysis;
  const disabled = (reason: string) => ({ ...base, reason });
  if (task.smell_type !== "god-class" || !analysis || !task.target.symbol)
    return disabled(
      "ordinary-construction smoke currently supports explicit God Class targets",
    );
  const source = readText(targetPath(task)),
    signals = [...source.matchAll(/\b(?:getContext|resourceManager)\b/g)];
  if (!signals.length) return disabled("no getContext/resourceManager risk");
  const ctor = analysis.methods.find((m: Json) => m.name === "constructor");
  if (ctor && ctor.requiredParameterCount !== 0)
    return disabled(
      "constructor requires arguments; planner does not invent inputs",
    );
  const module = moduleInfo(task);
  if (!module.module || !module.modulePath)
    return disabled("module/modulePath is required");
  const index = path.join(task.project_root, module.modulePath, "Index.ets"),
    name = task.target.symbol;
  let publicImport: string, publicSurface: string;
  if (
    isFile(index) &&
    new RegExp(`\\b${escapeRe(name)}\\b`).test(readText(index))
  ) {
    publicImport = "../../Index";
    publicSurface = "module-index";
  } else if (
    new RegExp(`\\bexport\\s+class\\s+${escapeRe(name)}\\b`).test(source)
  ) {
    publicImport =
      "../" +
      relative(
        targetPath(task),
        path.join(task.project_root, module.modulePath),
      )
        .replace(/\.(ets|ts)$/, "")
        .replace(/^src\//, "");
    publicSurface = "exported-target-file";
  } else return disabled("target class is not publicly importable");
  const candidates = analysis.methods
    .filter(
      (m: Json) =>
        m.name !== "constructor" &&
        !m.static &&
        m.visibility === "public" &&
        m.requiredParameterCount === 0 &&
        !m.riskSignals.length &&
        !/^(?:add|clear|create|delete|destroy|dispose|init|load|login|logout|remove|reset|save|set|update)/i.test(
          m.name,
        ) &&
        /^(?:calculate|cal|get|has|is|list|read|size)/i.test(m.name),
    )
    .map((m: Json) => m.name as string)
    .sort();
  return {
    ...base,
    enabled: true,
    reason: "zero-argument construction plus context access risk",
    triggerCodes: ["OBJECT_INITIALIZATION", "RUNTIME_CONTEXT_ACCESS"],
    evidence: signals.slice(0, 8).map((m) => ({
      filePath: task.target.file_path,
      line: source.slice(0, m.index).split("\n").length,
      signal: m[0],
    })),
    ...module,
    publicImport,
    publicSurface,
    targetClass: name,
    constructorKind: ctor ? "explicit-zero-argument" : "implicit-default",
    probeMethod:
      ["getTotalCount", "size", "getCount", "isEmpty"].find((n) =>
        candidates.includes(n),
      ) ??
      candidates[0] ??
      null,
    assertionScope: "construction-and-direct-throw-only",
    businessExpectedValues: [],
  };
}
export function prepareRuntimeSmoke(
  task: RefactorTask,
  risk: Json,
  taskDir: string,
): Json {
  const plan = buildRuntimeSmokePlan(task, risk);
  writeJson(path.join(taskDir, "runtime-smoke-plan.json"), plan);
  if (plan.enabled)
    copyTree(
      task.project_root,
      path.join(taskDir, "runtime-smoke-baseline"),
      true,
    );
  return plan;
}
export function renderRuntimeSmokeTest(plan: Json): string {
  return `import { describe, expect, it } from '@ohos/hypium';\nimport { ${plan.targetClass} } from '${plan.publicImport}';\n\nexport default function PublicRuntimeSmokeTest() {\n  describe('PublicRuntimeSmokeTest', () => {\n    it('constructs the public target without an immediate runtime error', 0, () => {\n      const instance: ${plan.targetClass} = new ${plan.targetClass}();\n${plan.probeMethod ? `      instance.${plan.probeMethod}();\n` : ""}      expect(instance !== undefined).assertTrue();\n    });\n  });\n}\n`;
}
export const renderRuntimeSmokeList = () =>
  "import publicRuntimeSmokeTest from './PublicRuntimeSmoke.test';\nexport default function testsuite() { publicRuntimeSmokeTest(); }\n";
