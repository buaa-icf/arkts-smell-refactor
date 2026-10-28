import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Json } from "./models.js";
import { taskFromJson, targetPath } from "./models.js";
import {
  copyTree,
  escapeRe,
  isDir,
  isFile,
  readJson,
  readText,
  relative,
  removeGenerated,
  stamp,
  within,
  writeJson,
  writeText,
} from "./utils.js";
import { installCancellationHandlers, runCommand, which } from "./process.js";
import {
  changedCurrentLines,
  freshCopy,
  syncProductionChanges,
} from "./workspace.js";
import { buildTestPlan } from "./test_plan.js";
import { resultEvidence, runTestPlan } from "./test_execution.js";
import {
  comparePublicContract,
  snapshotPublicContract,
} from "./public_contract.js";
import {
  renderRuntimeSmokeList,
  renderRuntimeSmokeTest,
} from "./runtime_smoke.js";
import { smellGate } from "./smell.js";
import {
  prepareSigning,
  saveSigningReport,
  signingToolFailure,
} from "./signing.js";
export function normalizeAgentPromptPaths(
  prompt: string,
  raw: Json,
  source: string,
): string {
  const prefixes = [source.replaceAll("\\", "/")];
  for (const key of ["workspace_root", "project_root"])
    if (raw[key] && within(source, raw[key])) {
      const r = relative(source, raw[key]);
      if (r) prefixes.push(r);
    }
  for (const p of prefixes.sort((a, b) => b.length - a.length))
    prompt = prompt.replace(
      new RegExp(
        `(?<![\\w./\\\\:-])${escapeRe(p).replaceAll("/", "[\\\\/]")}[\\\\/]`,
        "g",
      ),
      "",
    );
  return prompt;
}
export async function refactorGate(
  taskDir: string,
  source: string,
  deveco: string,
  promptFile?: string,
  model?: string,
): Promise<number> {
  const raw = readJson(path.join(taskDir, "task.json")),
    task = taskFromJson(raw),
    workspace = path.join(
      taskDir,
      promptFile
        ? "refactor-workspace-" +
            path.basename(promptFile, path.extname(promptFile))
        : "refactor-workspace",
    );
  if (!within(targetPath(task), source)) {
    console.error("目标文件不在 Harmony 工程内");
    return 3;
  }
  freshCopy(source, workspace, true);
  const prompt = normalizeAgentPromptPaths(
    readText(promptFile ?? path.join(taskDir, "refactor-prompt.md")),
    raw,
    source,
  );
  writeText(path.join(taskDir, "refactor-agent-prompt.md"), prompt);
  // DevEco attachments must live within --dir; the audit copy remains in taskDir.
  const attachment = path.join(
    workspace,
    ".arkts-refactor-prompt-" + stamp() + ".md",
  );
  writeText(attachment, prompt);
  const command = [
    deveco,
    "run",
    ...(model ? ["-m", model] : []),
    "严格执行附件中的 ArkTS 重构任务，直接修改工作区内的生产代码。",
    "-f",
    attachment,
    "--dir",
    workspace,
    "--format",
    "json",
    "--title",
    task.task_id,
    "--dangerously-skip-permissions",
  ];
  try {
    const result = await runCommand(command, { cwd: workspace, stream: true });
    if (result.error) {
      console.error(result.error);
      return 3;
    }
    if (result.code !== 0) return result.code ?? 3;
  } finally {
    fs.rmSync(attachment, { force: true });
  }
  return syncProductionChanges(workspace, source);
}
export function hvigorLauncher(hvigor: string): string[] {
  if (path.extname(hvigor).toLowerCase() !== ".js") return [hvigor];
  const root = path.resolve(hvigor, "../../../.."),
    bundled = path.join(root, "tools/node/bin/node");
  return [
    isFile(bundled) ? bundled : (which("node") ?? process.execPath),
    hvigor,
  ];
}
export function devecoEnvironment(hvigor: string): NodeJS.ProcessEnv {
  const env = { ...process.env },
    root = path.resolve(hvigor, "../../../.."),
    sdk = path.join(root, "sdk"),
    java = path.join(root, "jbr/Contents/Home");
  if (isDir(sdk)) env.DEVECO_SDK_HOME = sdk;
  if (isDir(java)) {
    env.JAVA_HOME = java;
    env.PATH = path.join(java, "bin") + path.delimiter + (env.PATH ?? "");
  }
  return env;
}
export async function hvigorGate(
  taskDir: string,
  source: string,
  hvigor: string,
  ohpm: string | undefined,
  taskName: string,
  module?: string,
): Promise<number> {
  let plan: Json | null = null;
  if (["auto-test", "test", "onDeviceTest"].includes(taskName)) {
    writeJson(path.join(taskDir, "test-results.json"), {
      status: "RUNNING",
      jobs: [],
    });
    try {
      plan = buildTestPlan(taskDir, source, taskName, module);
      writeJson(path.join(taskDir, "test-plan.json"), plan);
    } catch (e) {
      console.error(
        "TEST_GATE_BLOCKED: cannot determine test plan: " + String(e),
      );
      writeJson(path.join(taskDir, "test-results.json"), {
        status: "BLOCKED",
        reason: String(e),
        jobs: [],
      });
      return 3;
    }
  }
  const toolRoot = path.resolve(fileURLToPath(import.meta.url), "../.."),
    short = crypto.createHash("sha1").update(taskDir).digest("hex").slice(0, 8),
    workspace = path.join(toolRoot, "v", short);
  ensureValidationModuleScope(path.dirname(workspace));
  writeJson(path.join(taskDir, "validation-workspace.json"), {
    path: workspace,
    sourceRoot: source,
  });
  if (!isDir(workspace)) freshCopy(source, workspace, false);
  else copyTree(source, workspace, false);
  const rawTask = isFile(path.join(taskDir, "task.json"))
    ? readJson(path.join(taskDir, "task.json"))
    : {};
  const signingOptions = {
    taskDir,
    source,
    workspace,
    stage: plan ? ("test" as const) : ("build" as const),
    required: plan
      ? plan.jobs.some((job: Json) => job.kind === "instrument")
      : rawTask.raw?.testKind === "instrument-test",
    workspaceRoot: rawTask.workspace_root ?? rawTask.workspaceRoot,
    hdc: [
      path.resolve(hvigor, "../../sdk/default/openharmony/toolchains/hdc.exe"),
      path.resolve(hvigor, "../../sdk/default/openharmony/toolchains/hdc"),
    ].find(isFile),
  };
  const signing = await prepareSigning(signingOptions);
  console.log(
    `SIGNING_PREPARATION status=${signing.report.status} required=${signingOptions.required}`,
  );
  if (!signing.ready) {
    console.error("SIGNING_GATE_BLOCKED: " + signing.report.reason);
    if (plan)
      writeJson(path.join(taskDir, "test-results.json"), {
        status: "BLOCKED",
        classification: "SIGNING_UNAVAILABLE",
        reason: signing.report.reason,
        jobs: [],
      });
    return 3;
  }
  const marker = path.join(workspace, ".arkts-refactor-ohpm-installed");
  if (ohpm && !isFile(marker)) {
    const install = await runCommand([ohpm, "install"], {
      cwd: workspace,
    });
    console.log(signing.redact(install.output));
    if (install.code !== 0) return install.code ?? 3;
    writeText(marker, "ok");
  }
  if (plan) {
    const code = await runTestPlan(
      taskDir,
      workspace,
      plan,
      hvigorLauncher(hvigor),
      devecoEnvironment(hvigor),
      signing.redact,
    );
    signing.report.verification =
      signingOptions.required && code === 0
        ? "DEVICE_TEST_EXECUTION_CONFIRMED"
        : "NOT_CONFIRMED";
    signing.report.executionStatus =
      code === 0 ? "PASS" : code === 3 ? "BLOCKED" : "FAIL";
    saveSigningReport(signingOptions, signing.report);
    return code;
  }
  const result = await runCommand(
    [...hvigorLauncher(hvigor), taskName, "--no-daemon"],
    { cwd: workspace, env: devecoEnvironment(hvigor) },
  );
  console.log(signing.redact(result.output));
  if (
    signingOptions.required &&
    (signingToolFailure(result.output) ||
      (result.code === 0 && !/@SignHap\b/.test(result.output)))
  ) {
    signing.report.status = "BLOCKED";
    signing.report.verification = "SIGNING_FAILED_OR_NOT_CONFIRMED";
    saveSigningReport(signingOptions, signing.report);
    console.error(
      "SIGNING_GATE_BLOCKED: 实际签名失败、被跳过或没有签名完成证据",
    );
    return 3;
  }
  signing.report.verification =
    signingOptions.required && result.code === 0
      ? "BUILD_SIGNING_COMPLETED_INSTALLATION_NOT_VERIFIED"
      : "NOT_REQUIRED_OR_NOT_CONFIRMED";
  saveSigningReport(signingOptions, signing.report);
  if (
    /ERR_REQUIRE_ESM/.test(result.output) &&
    /hvigorfile\.js/.test(result.output)
  ) {
    console.error(
      "BUILD_GATE_BLOCKED: Hvigor 构建脚本模块环境冲突，不能归因于生产代码重构",
    );
    return 3;
  }
  return result.code ?? 3;
}
export function ensureValidationModuleScope(storageRoot: string): void {
  // This boundary belongs to the tool, not to any copied/source Harmony project.
  // Preserve project-level package.json files, which take precedence over it.
  writeJson(path.join(storageRoot, "package.json"), {
    private: true,
    type: "commonjs",
  });
}
export function parseLinterIssues(output: string, fallback: string): Json[] {
  return [
    ...output.matchAll(
      /^\s*(?:(.*?\.(?:ets|ts))[:(])?(\d+)[,:](\d+)\)?\s+(error|warn|warning|suggestion)\s+(.*)$/gim,
    ),
  ].map((m) => {
    const detail = m[5].trim(),
      rule = /\s+(@\S+)\s*$/.exec(detail);
    return {
      filePath: (m[1] ?? fallback).trim(),
      line: +m[2],
      column: +m[3],
      severity: m[4].toLowerCase().replace("warning", "warn"),
      rule: rule?.[1] ?? "",
      message: rule ? detail.slice(0, rule.index).trimEnd() : detail,
    };
  });
}
export async function linterGate(
  taskDir: string,
  source: string,
  codelinter: string,
  config?: string,
): Promise<number> {
  const changes =
      readJson(path.join(taskDir, "refactor-changes.json"))
        .changedProductionFiles ?? [],
    introduced: Json[] = [];
  for (const r of changes) {
    const current = path.resolve(source, r);
    if (!within(current, source)) throw new Error("Linter 文件越界");
    if (!isFile(current)) continue;
    const command = [
        codelinter,
        current,
        ...(config ? ["-c", config] : []),
        "-e",
        "error,warn,suggestion",
      ],
      result = await runCommand(command, { cwd: source, stream: true });
    if (result.error || (result.code !== 0 && result.code !== 1))
      return result.code ?? 3;
    const baseline = path.join(taskDir, "baseline-production", r),
      lines = changedCurrentLines(baseline, current);
    introduced.push(
      ...parseLinterIssues(result.output, r).filter(
        (i) => !isFile(baseline) || lines.has(i.line),
      ),
    );
  }
  writeJson(path.join(taskDir, "linter-after.json"), introduced);
  if (introduced.length) {
    console.error(
      "本次变更新增或触及 Linter 缺陷：" +
        introduced.map((i) => `${i.filePath}:${i.line}`).join(", "),
    );
    return 1;
  }
  console.log("本次变更范围未引入 Linter 缺陷");
  return 0;
}
export function publicContractGate(taskDir: string, source: string): number {
  const planFile = path.join(taskDir, "public-contract-plan.json"),
    before = path.join(taskDir, "public-contract-before.json");
  if (!isFile(planFile) || !isFile(before)) return 0;
  const plan = readJson(planFile);
  if (!plan.enabled) return 0;
  const current = snapshotPublicContract(
    taskFromJson(readJson(path.join(taskDir, "task.json"))),
    source,
    plan,
  );
  writeJson(path.join(taskDir, "public-contract-current.json"), current);
  const result = comparePublicContract(readJson(before), current);
  writeJson(path.join(taskDir, "public-contract-results.json"), result);
  console.log(
    result.passed ? "Public contract passed" : "Public contract regression",
  );
  return result.passed ? 0 : 1;
}
async function runRuntimeCopy(
  taskDir: string,
  source: string,
  plan: Json,
  hvigor: string,
  ohpm: string | undefined,
  label: string,
): Promise<Json> {
  const workspace = path.join(
    os.tmpdir(),
    "arkts-smell-refactor-runtime",
    crypto
      .createHash("sha1")
      .update(taskDir + label)
      .digest("hex")
      .slice(0, 8),
  );
  freshCopy(source, workspace, false);
  const signing = await prepareSigning({
    taskDir: path.join(taskDir, "runtime-smoke-" + label),
    source,
    workspace,
    required: false,
    stage: "test",
  });
  const tests = path.resolve(workspace, plan.modulePath, "src/test");
  if (!within(tests, workspace))
    throw new Error("Runtime tests escape workspace");
  if (isDir(tests)) removeGenerated(tests, workspace);
  writeText(
    path.join(tests, "PublicRuntimeSmoke.test.ets"),
    renderRuntimeSmokeTest(plan),
  );
  writeText(path.join(tests, "List.test.ets"), renderRuntimeSmokeList());
  writeText(
    path.join(taskDir, "runtime-smoke-generated/PublicRuntimeSmoke.test.ets"),
    renderRuntimeSmokeTest(plan),
  );
  writeText(
    path.join(taskDir, "runtime-smoke-generated/List.test.ets"),
    renderRuntimeSmokeList(),
  );
  if (ohpm) {
    const install = await runCommand([ohpm, "install"], { cwd: workspace });
    const log = path.join(taskDir, `runtime-smoke-${label}-install.log`);
    writeText(log, signing.redact(install.output));
    if (install.code !== 0)
      return {
        passed: false,
        phase: "dependency-install",
        exitCode: install.code,
        log,
        summary: null,
      };
  }
  const run = await runCommand(
      [
        ...hvigorLauncher(hvigor),
        "test",
        "-p",
        `module=${plan.module}`,
        "-p",
        "coverage=false",
        "--no-daemon",
      ],
      { cwd: workspace, env: devecoEnvironment(hvigor) },
    ),
    log = path.join(taskDir, `runtime-smoke-${label}.log`);
  writeText(log, signing.redact(run.output));
  const evidence = resultEvidence(
    path.join(
      tests,
      "../../.test/default/intermediates/test/coverage_data/test_result.txt",
    ),
    ["PublicRuntimeSmokeTest"],
  );
  return {
    passed: run.code === 0 && evidence.status === "PASS",
    phase: evidence.summary ? "runtime" : "compile-or-run",
    exitCode: run.code,
    log,
    summary: evidence.summary ?? null,
  };
}
export async function runtimeSmokeGate(
  taskDir: string,
  source: string,
  hvigor: string,
  ohpm?: string,
): Promise<number> {
  const planPath = path.join(taskDir, "runtime-smoke-plan.json");
  if (!isFile(planPath)) return 0;
  const plan = readJson(planPath);
  if (!plan.enabled) return 0;
  const baseline = path.join(taskDir, "runtime-smoke-baseline");
  if (!isDir(baseline)) {
    console.error("RUNTIME_SMOKE_BASELINE_UNAVAILABLE: missing baseline");
    return 3;
  }
  const beforeFile = path.join(taskDir, "runtime-smoke-baseline-result.json"),
    before = isFile(beforeFile)
      ? readJson(beforeFile)
      : await runRuntimeCopy(taskDir, baseline, plan, hvigor, ohpm, "baseline");
  writeJson(beforeFile, before);
  if (!before.passed) {
    writeJson(path.join(taskDir, "runtime-smoke-results.json"), {
      schemaVersion: "1.0",
      enabled: true,
      baseline: before,
      current: null,
      passed: null,
      classification: "BASELINE_UNAVAILABLE",
    });
    console.error("RUNTIME_SMOKE_BASELINE_UNAVAILABLE: baseline did not pass");
    return 3;
  }
  const current = await runRuntimeCopy(
    taskDir,
    source,
    plan,
    hvigor,
    ohpm,
    "current",
  );
  writeJson(path.join(taskDir, "runtime-smoke-results.json"), {
    schemaVersion: "1.0",
    enabled: true,
    baseline: before,
    current,
    passed: current.passed,
    classification: current.passed
      ? "PASS"
      : "INTRODUCED_RUNTIME_INITIALIZATION_FAILURE",
  });
  return current.passed ? 0 : 1;
}
export async function gateMain(args: string[]): Promise<number> {
  const command = args[0],
    options: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined)
      throw new Error("无效门禁参数");
    options[args[i].slice(2)] = args[i + 1];
  }
  const required = (key: string) => {
      if (!options[key]) throw new Error("缺少 --" + key);
      return options[key];
    },
    taskDir = path.resolve(required("task-dir"));
  if (command === "smell")
    return smellGate(
      taskDir,
      path.resolve(required("homecheck-root")),
      options["source-root"] ? path.resolve(options["source-root"]) : undefined,
    );
  const source = path.resolve(required("source-root"));
  if (command === "refactor")
    return refactorGate(
      taskDir,
      source,
      required("deveco"),
      options["prompt-file"],
      options.model,
    );
  if (command === "hvigor")
    return hvigorGate(
      taskDir,
      source,
      required("hvigorw"),
      options.ohpm,
      required("task"),
      options.module,
    );
  if (command === "linter")
    return linterGate(taskDir, source, required("codelinter"), options.config);
  if (command === "runtime-smoke")
    return runtimeSmokeGate(taskDir, source, required("hvigorw"), options.ohpm);
  if (command === "public-contract") return publicContractGate(taskDir, source);
  throw new Error("未知门禁：" + command);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  installCancellationHandlers();
  gateMain(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error("GATE_BLOCKED: " + e.message);
      process.exitCode = 3;
    });
}
