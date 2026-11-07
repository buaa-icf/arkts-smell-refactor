import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Json } from "./models.js";
import { taskFromJson, targetPath } from "./models.js";
import {
  copyTree,
  copyFile,
  escapeRe,
  isDir,
  isFile,
  readJson,
  readJson5,
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
import { buildTestPlan, freezeTestPlan } from "./test_plan.js";
import { resultEvidence, runTestPlan } from "./test_execution.js";
import { writeTestState } from "./test_progress.js";
import {
  comparePublicContract,
  snapshotPublicContract,
} from "./public_contract.js";
import {
  renderRuntimeSmokeList,
  renderRuntimeSmokeTest,
} from "./runtime_smoke.js";
import { smellGate } from "./smell.js";
import { runAgent } from "./agent_runtime.js";
import { prepareReviewPrompt } from "./review_packet.js";
import { prepareRepairContext } from "./repair_context.js";
import { bundledDevecoCli } from "./deveco_cli.js";
import { parseDevecoLintReport } from "./linter_report.js";
import { moduleBuildPlan, restoreBuildBaseline } from "./build_validation.js";
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
  variant?: string,
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
  freezeTestPlan(taskDir, source);
  freshCopy(source, workspace, true);
  const basePrompt = normalizeAgentPromptPaths(
    readText(promptFile ?? path.join(taskDir, "refactor-prompt.md")),
    raw,
    source,
  );
  const evidence = promptFile ? prepareRepairContext(taskDir, workspace, path.basename(promptFile, path.extname(promptFile))) : null;
  // DevEco attachments must live within --dir; the audit copy remains in taskDir.
  const attachment = path.join(
    workspace,
    ".arkts-refactor-prompt-" + stamp() + ".md",
  );
  try {
    const prompt = basePrompt + (evidence?.prompt ?? "");
    writeText(path.join(taskDir, promptFile ? path.basename(promptFile, path.extname(promptFile)) + "-agent-prompt.md" : "refactor-agent-prompt.md"), prompt);
    writeText(attachment, prompt);
    const code = await runAgent(deveco, taskDir, workspace, attachment, { role: promptFile ? "repair" : "refactor", model, variant, title: task.task_id });
    if (code !== 0) return code;
  } finally {
    fs.rmSync(attachment, { force: true });
    evidence?.dispose();
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

export function validationWorkspace(taskDir: string, source: string): string {
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
  return workspace;
}

export async function devecoBuildGate(
  taskDir: string,
  source: string,
  deveco: string,
): Promise<number> {
  const evidenceFile = path.join(taskDir, "build-evidence.json"),
    runId = stamp();
  writeJson(evidenceFile, { engine: "devecocli", status: "RUNNING", runId });
  writeJson(path.join(taskDir, "build-baseline-evidence.json"), {
    status: "NOT_RUN",
    runId,
  });
  const blocked = (reason: string, extra: Json = {}) => {
    console.error("BUILD_GATE_BLOCKED: " + reason);
    writeJson(evidenceFile, {
      engine: "devecocli",
      runId,
      status: "BLOCKED",
      reason,
      ...extra,
    });
    return 3;
  };
  if (Number(process.versions.node.split(".")[0]) < 22)
    return blocked("官方 DevEco CLI 构建要求 Node.js 22 或更高版本");
  const cli = bundledDevecoCli(deveco);
  if (!cli)
    return blocked(
      "当前 DevEco Code 的官方 CLI/平台实现包缺失；使用 Node 22+ 修复该 DevEco Code 安装并包含 optional 依赖，不回退搜索 hvigorw PATH",
    );
  let scope: Json;
  try {
    const manifest = isFile(path.join(taskDir, "refactor-changes.json"))
      ? readJson(path.join(taskDir, "refactor-changes.json"))
      : {};
    scope = moduleBuildPlan(source, [
      ...(manifest.changedProductionFiles ?? []),
      ...(manifest.changedProductionResources ?? []).map((r: string | Json) =>
        typeof r === "string" ? r : r.filePath,
      ),
    ]);
  } catch (e) {
    return blocked("无法读取构建 profile：" + String(e));
  }
  const workspace = validationWorkspace(taskDir, source),
    raw = isFile(path.join(taskDir, "task.json"))
      ? readJson(path.join(taskDir, "task.json"))
      : {},
    signingOptions = {
      taskDir,
      source,
      workspace,
      stage: "build" as const,
      required: raw.raw?.testKind === "instrument-test",
      workspaceRoot: raw.workspace_root ?? raw.workspaceRoot,
    },
    signing = await prepareSigning(signingOptions);
  console.log(
    `SIGNING_PREPARATION status=${signing.report.status} required=${signingOptions.required}`,
  );
  if (!signing.ready) return blocked(signing.report.reason);
  const command = [process.execPath, cli.entry, ...scope.args];
  console.log(
    `BUILD_ENGINE devecocli version=${cli.version}; cwd=${workspace}`,
  );
  const run = await runCommand(command, { cwd: workspace });
  writeText(
    path.join(taskDir, "devecocli-build.log"),
    signing.redact(run.output),
  );
  console.log(signing.redact(run.output));
  const output = run.output.replace(/\x1b\[[0-9;]*m/g, ""),
    completed = /Build completed successfully/i.test(output),
    evidence = {
      engine: "devecocli",
      runId,
      cliVersion: cli.version,
      devecoPackage: cli.devecoPackage,
      command,
      workspace,
      product: scope.product,
      modules: scope.modules,
      scope: scope.scope,
      exitCode: run.code,
      completionEvidence: completed,
    };
  if (run.error || run.timedOut || run.cancelled)
    return blocked(run.error ?? "官方 CLI 执行被中断或超时", evidence);
  if (
    signingOptions.required &&
    (signingToolFailure(output) ||
      (run.code === 0 && !/@SignHap\b/.test(output)))
  ) {
    signing.report.verification = "SIGNING_FAILED_OR_NOT_CONFIRMED";
    signing.report.status = "BLOCKED";
    saveSigningReport(signingOptions, signing.report);
    return blocked("实际签名失败、被跳过或没有签名完成证据", evidence);
  }
  if (
    run.code !== 0 &&
    /implementation package.*not installed|DevEco (?:Studio|CLI).*not found|(?:SDK|Java|JDK|toolchain).*(?:not found|not installed|missing|invalid)|ERR_REQUIRE_ESM|not a valid DevEco|No DevEco|No supported.*(?:Studio|tool)|Could not (?:find|detect).*DevEco/i.test(
      output,
    )
  )
    return blocked("官方 CLI/SDK/构建环境不可用，详见 build.log", evidence);
  if (run.code === 0 && !completed)
    return blocked(
      "CLI 退出码为 0，但缺少 Build completed successfully，不能认定构建完成",
      evidence,
    );
  const passed = run.code === 0 && completed;
  signing.report.verification =
    passed && signingOptions.required
      ? "BUILD_SIGNING_COMPLETED_INSTALLATION_NOT_VERIFIED"
      : "NOT_REQUIRED_OR_NOT_CONFIRMED";
  saveSigningReport(signingOptions, signing.report);
  if (!passed) {
    const baselineEvidenceFile = path.join(
      taskDir,
      "build-baseline-evidence.json",
    );
    writeJson(evidenceFile, {
      ...evidence,
      status: "RUNNING_BASELINE",
      classification: "BUILD_ATTRIBUTION_PENDING",
    });
    writeJson(baselineEvidenceFile, { status: "RUNNING", scope, runId });
    try {
      const metadata = path.join(taskDir, "build-baseline-validation"),
        baselineWorkspace = validationWorkspace(metadata, source),
        restoration = restoreBuildBaseline(taskDir, source, baselineWorkspace),
        baselineSigning = await prepareSigning({
          ...signingOptions,
          taskDir: metadata,
          workspace: baselineWorkspace,
        });
      if (!baselineSigning.ready)
        throw new Error("基线签名环境不可用：" + baselineSigning.report.reason);
      console.log(
        "BUILD_BASELINE: 当前构建失败，正在用相同模块参数验证重构前基线",
      );
      const before = await runCommand(command, { cwd: baselineWorkspace });
      const baselineLog = path.join(taskDir, `build-baseline-${runId}.log`);
      writeText(baselineLog, baselineSigning.redact(before.output));
      writeText(
        path.join(taskDir, "build-baseline.log"),
        baselineSigning.redact(before.output),
      );
      const baselinePass =
          before.code === 0 &&
          /Build completed successfully/i.test(before.output),
        baseline = {
          status: baselinePass ? "PASS" : "FAIL",
          runId,
          log: baselineLog,
          workspace: baselineWorkspace,
          command,
          exitCode: before.code,
          completionEvidence: baselinePass,
          ...restoration,
        };
      writeJson(baselineEvidenceFile, baseline);
      if (
        before.error ||
        before.timedOut ||
        before.cancelled ||
        (before.code === 0 && !baselinePass)
      )
        throw new Error(before.error ?? "基线没有有效的构建完成证据");
      if (!baselinePass)
        return blocked(
          "重构前基线也无法构建，不能归因于本次重构，不进入代码修复 Loop",
          { ...evidence, classification: "BASELINE_BUILD_FAILURE", baseline },
        );
      writeJson(evidenceFile, {
        ...evidence,
        status: "FAIL",
        classification: "INTRODUCED_BUILD_FAILURE",
        baseline,
      });
      return 1;
    } catch (e) {
      const reason = String(e);
      writeJson(baselineEvidenceFile, {
        status: "UNAVAILABLE",
        reason,
        scope,
        runId,
      });
      return blocked(
        "无法可靠验证重构前构建基线，不进入代码修复 Loop：" + reason,
        { ...evidence, classification: "BUILD_BASELINE_UNAVAILABLE" },
      );
    }
  }
  writeJson(evidenceFile, { ...evidence, status: passed ? "PASS" : "FAIL" });
  if (passed)
    writeText(
      path.join(workspace, ".arkts-refactor-ohpm-installed"),
      "installed by official devecocli build",
    );
  return passed ? 0 : run.code || 1;
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
    writeTestState(path.join(taskDir, "test-results.json"), {
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
      writeTestState(path.join(taskDir, "test-results.json"), {
        status: "BLOCKED",
        reason: String(e),
        jobs: [],
      });
      return 3;
    }
  }
  const workspace = validationWorkspace(taskDir, source);
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
      writeTestState(path.join(taskDir, "test-results.json"), {
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
  deveco: string,
  config?: string,
): Promise<number> {
  const changes: string[] =
      readJson(path.join(taskDir, "refactor-changes.json"))
        .changedProductionFiles ?? [],
    introduced: Json[] = [],
    evidence: Json[] = [];
  writeJson(path.join(taskDir, "linter-after.json"), []);
  const finish = (code: number, reason?: string) => {
    writeJson(path.join(taskDir, "linter-evidence.json"), {
      engine: "devecocli check lint",
      status: code === 0 ? "PASS" : code === 1 ? "FAIL" : "BLOCKED",
      reason,
      files: evidence,
    });
    if (code === 3) console.error("LINTER_GATE_BLOCKED: " + reason);
    return code;
  };
  const cli = bundledDevecoCli(deveco);
  if (!cli || Number(process.versions.node.split(".")[0]) < 22)
    return finish(
      3,
      "需要 Node 22+ 及当前 DevEco Code 自带的完整官方 CLI；不搜索独立 codelinter PATH",
    );
  // Build and lint execute in parallel. Never share their mutable SDK/project caches.
  const workspace = validationWorkspace(
    path.join(taskDir, "linter-validation"),
    source,
  );
  let copiedConfig: string | undefined;
  if (config) {
    if (!isFile(config)) return finish(3, "Linter 配置文件不存在");
    copiedConfig = within(config, source)
      ? path.join(workspace, relative(config, source))
      : path.join(workspace, ".arkts-refactor-linter-config.json5");
    if (!within(config, source)) copyFile(config, copiedConfig);
  }
  let configOrigin = config ? "project-config" : "project-default";
  if (!copiedConfig) {
    copiedConfig = path.join(workspace, "code-linter.json5");
    if (!isFile(path.join(source, "code-linter.json5"))) {
      const template = path.resolve(
        path.dirname(cli.implementation),
        "../templates/application/code-linter.json5",
      );
      if (!isFile(template))
        return finish(3, "项目没有 Linter 配置，当前官方 CLI 也缺少默认模板");
      const defaults = readJson5(template);
      defaults.files = [...new Set([...(defaults.files ?? []), "**/*.ts"])];
      writeJson(copiedConfig, defaults);
      configOrigin = "official-cli-template-in-validation-copy";
    }
  }
  for (const r of changes) {
    const current = path.resolve(source, r),
      target = path.resolve(workspace, r);
    if (!within(current, source) || !within(target, workspace))
      return finish(3, "Linter 文件越界");
    if (!/\.(ets|ts)$/i.test(r)) continue;
    if (!isFile(current) || !isFile(target))
      return finish(3, "变更源码文件不存在：" + r);
    const report = path.join(taskDir, "linter-reports", stamp(), "report.json"),
      command = [
        process.execPath,
        cli.entry,
        "check",
        "lint",
        target,
        ...(copiedConfig ? ["--config-path", copiedConfig] : []),
        "--format",
        "json",
        "--output-path",
        report,
      ],
      result = await runCommand(command, { cwd: workspace });
    console.log(result.output);
    const entry: Json = {
      file: r,
      command,
      report,
      exitCode: result.code,
      cliVersion: cli.version,
      configOrigin,
    };
    evidence.push(entry);
    writeText(path.join(path.dirname(report), "command.log"), result.output);
    if (
      result.error ||
      result.timedOut ||
      result.cancelled ||
      ![0, 1].includes(result.code ?? -1)
    )
      return finish(
        3,
        result.error ?? "官方 Linter 进程未正常完成，详见本轮日志",
      );
    if (!isFile(report))
      return finish(3, "未生成本轮官方 Linter JSON 报告，不能视为无缺陷");
    let parsed: Json[];
    try {
      const raw = readJson(report);
      parsed = parseDevecoLintReport(raw, workspace);
      entry.summary = raw.summary;
    } catch (e) {
      return finish(3, "无效的本轮 Linter 报告：" + String(e));
    }
    const baseline = path.join(taskDir, "baseline-production", r),
      lines = changedCurrentLines(baseline, current);
    const scoped = parsed.filter(
      (issue) =>
        path.resolve(issue.filePath) === target &&
        (!isFile(baseline) || lines.has(issue.line)),
    );
    introduced.push(...scoped.map((issue) => ({ ...issue, filePath: r })));
    entry.introducedIssues = scoped.length;
  }
  writeJson(path.join(taskDir, "linter-after.json"), introduced);
  if (introduced.length) {
    console.error(
      "本次变更新增或触及 Linter 缺陷：" +
        introduced.map((i) => `${i.filePath}:${i.line}`).join(", "),
    );
    return finish(1);
  }
  console.log("本次变更范围未引入 Linter 缺陷");
  return finish(0);
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
    if (args[i] === "--format-only") { options["format-only"] = "true"; i--; continue; }
    if (!args[i].startsWith("--") || args[i + 1] === undefined)
      throw new Error("无效门禁参数");
    options[args[i].slice(2)] = args[i + 1];
  }
  const required = (key: string) => {
      if (!options[key]) throw new Error("缺少 --" + key);
      return options[key];
    },
    taskDir = path.resolve(required("task-dir"));
  if (command === "review") {
    const formatOnly = options["format-only"] === "true";
    let prompt = path.resolve(required("prompt-file"));
    if (!formatOnly) {
      try { prompt = prepareReviewPrompt(taskDir, prompt); }
      catch (error) {
        console.log(JSON.stringify({ type: "error", error: { name: "ReviewPacketError", data: { message: `REVIEW_PACKET_BLOCKED: ${String(error)}` } } }));
        return 3;
      }
    }
    return runAgent(required("deveco"), taskDir, taskDir, prompt, {
      role: formatOnly ? "review-format" : "review", model: options.model, variant: options.variant,
      formatOnly, promptViaStdin: !formatOnly,
    });
  }
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
      options.variant,
    );
  if (command === "build")
    return devecoBuildGate(taskDir, source, required("deveco"));
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
    return linterGate(taskDir, source, required("deveco"), options.config);
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
