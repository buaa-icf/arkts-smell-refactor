import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { Config, CommandSpec, Json, RefactorTask } from "./models.js";
import { targetPath } from "./models.js";
import { loadDatasetTasks, normalizeInput } from "./dataset.js";
import { findLinterConfig } from "./linter_profile.js";
import { buildRefactorPrompt, buildReviewPrompt } from "./prompts.js";
import { preparePublicContract } from "./public_contract.js";
import { analyzeRisks, reviewRisk } from "./risk.js";
import { prepareRuntimeSmoke } from "./runtime_smoke.js";
import { executePipeline } from "./runner.js";
import {
  isDir,
  isFile,
  now,
  parents,
  round,
  writeJson,
  writeText,
} from "./utils.js";
import { which } from "./process.js";
import { TEST_TOOL_BLOCKERS } from "./test_execution.js";
export async function readPastedJson(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<Json[]> {
  console.log(
    "请粘贴一条异味 JSON 对象或阳性数据集 JSON 数组。检测到完整 JSON 后会自动开始：",
  );
  const lines: string[] = [],
    reader = readline.createInterface({ input });
  return new Promise((resolve, reject) => {
    let settled = false;
    reader.on("line", (line) => {
      if (settled) return;
      lines.push(line);
      let data: unknown;
      try {
        data = JSON.parse(lines.join("\n").trim());
      } catch {
        return;
      }
      settled = true;
      reader.close();
      try {
        resolve(normalizeInput(data));
      } catch (e) {
        reject(e);
      }
    });
    reader.on("close", () => {
      if (settled) return;
      settled = true;
      try {
        if (!lines.length) throw new Error("没有收到 JSON 输入");
        resolve(normalizeInput(JSON.parse(lines.join("\n"))));
      } catch (e) {
        reject(e);
      }
    });
    reader.on("error", reject);
  });
}
export function discoverWorkspace(data: Json[], start: string): string {
  const projects = [
    ...new Set(data.map((r) => r.sourceProject).filter(Boolean)),
  ] as string[];
  for (const root of parents(start))
    for (const candidate of [root, path.join(root, "feature-envy_refactor")])
      if (
        projects.length &&
        projects.every((p) => isDir(path.join(candidate, p)))
      )
        return candidate;
  throw new Error(
    "无法定位 sourceProject 本地仓库；请先 configure --workspace 或用 --workspace 指定仓库总目录",
  );
}
export function findHomecheck(workspace: string): string | null {
  const override = process.env.ARKTS_REFACTOR_HOMECHECK;
  if (override) {
    const root = path.resolve(override);
    if (
      !isFile(path.join(root, "node_modules/homecheck/lib/run.js")) ||
      !isFile(path.join(root, "extrulesproject-1.0.0.tgz"))
    )
      throw new Error(
        "ARKTS_REFACTOR_HOMECHECK 指定的 HomeCheck 无效：" + root,
      );
    return root;
  }
  return (
    [
      path.join(workspace, "homecheck-extrule"),
      path.join(path.dirname(workspace), "homecheck-extrule"),
      path.join(process.cwd(), "homecheck-extrule"),
    ].find(
      (p) =>
        isFile(path.join(p, "node_modules/homecheck/lib/run.js")) &&
        isFile(path.join(p, "extrulesproject-1.0.0.tgz")),
    ) ?? null
  );
}
export function discoverTools(
  workspace: string,
): Record<string, string | null> {
  return {
    deveco: which("deveco"),
    hvigorw: which("hvigorw"),
    ohpm: which("ohpm"),
    codelinter: which("codelinter"),
    homecheck: findHomecheck(workspace),
  };
}
export function findHarmonyRoot(
  target: string,
  repository: string,
): string | null {
  return (
    parents(path.dirname(target), repository).find(
      (p) =>
        isFile(path.join(p, "hvigor/hvigor-config.json5")) &&
        isFile(path.join(p, "build-profile.json5")),
    ) ?? null
  );
}
export function autoConfig(
  task: RefactorTask,
  taskDir: string,
  tools: Record<string, string | null>,
  smoke: Json = {},
  contract: Json = {},
  mode: "required" | "skip" = "required",
): Config {
  const root = findHarmonyRoot(targetPath(task), task.project_root),
    gate = fileURLToPath(new URL("./gate.js", import.meta.url)),
    base = [process.execPath, gate],
    missing = (name: string): CommandSpec => ({
      enabled: false,
      reason: "未找到 " + name,
    });
  const network =
    "certificate verification|unable to verify[^\\r\\n]*certificate|self[- ]signed certificate|\\b(?:SSL|TLS)(?:Error\\b|_[A-Z0-9_]+\\b|\\b)|\\b(?:CERT_[A-Z0-9_]+|CERTIFICATE_VERIFY_FAILED)\\b|authentication failed|\\bunauthorized\\b(?![-_])|\\b(?:ECONNRESET|ENETUNREACH|ETIMEDOUT)\\b|network[^\\r\\n]*unavailable";
  const agentBlockers =
      "model service is currently overloaded|service.*overloaded|rate limit|temporarily unavailable|" +
      network,
    environment =
      network +
      "|Invalid project path|Permissions Error|\\bFailed[^\\r\\n]*@SignHap\\b|\\b(?:signing|signature)(?: verification)?(?: is)? (?:failed|failure|error|invalid|missing)\\b|\\b(?:invalid|missing) (?:signing|signature)\\b|Invalid storeFile value|device not found|no devices";
  const command = (kind: string, ...args: string[]) => [
    ...base,
    kind,
    "--task-dir",
    "{task_dir}",
    "--source-root",
    root ?? "",
    ...args,
  ];
  const agent = (repair = false): CommandSpec | null =>
    tools.deveco && root
      ? {
          command: command(
            "refactor",
            "--deveco",
            tools.deveco,
            ...(repair ? ["--prompt-file", "{repair_prompt_file}"] : []),
          ),
          cwd: "{task_dir}",
          blockedOutputRegex: agentBlockers,
          blockedOutputScope: "agent-errors",
          timeoutSeconds: 3600,
        }
      : null;
  const hvigor = (name: string) =>
    command(
      "hvigor",
      "--hvigorw",
      tools.hvigorw!,
      "--task",
      name,
      ...(tools.ohpm ? ["--ohpm", tools.ohpm] : []),
    );
  const linterConfig = findLinterConfig(targetPath(task), task.project_root),
    gates: Record<string, CommandSpec> = {
      smell:
        tools.homecheck && root
          ? {
              command: command("smell", "--homecheck-root", tools.homecheck),
              cwd: "{task_dir}",
              blockedOutputRegex: "SMELL_GATE_BLOCKED",
              timeoutSeconds: 1800,
            }
          : missing("HomeCheck 或 Harmony 工程根目录"),
      build:
        tools.hvigorw && root
          ? {
              command: hvigor("assembleHap"),
              cwd: "{task_dir}",
              blockedOutputRegex: environment + "|GATE_BLOCKED",
              timeoutSeconds: 3600,
            }
          : missing("hvigorw 或 Harmony 工程根目录"),
      test:
        tools.hvigorw && root
          ? {
              command: hvigor("auto-test"),
              cwd: "{task_dir}",
              blockedOutputRegex:
                environment +
                "|TEST_GATE_BLOCKED|GATE_BLOCKED|" +
                TEST_TOOL_BLOCKERS,
              timeoutSeconds: 3600,
            }
          : missing("hvigorw 或 Harmony 工程根目录"),
      linter:
        mode === "skip"
          ? { enabled: false, reason: "按 linterMode=skip 跳过" }
          : tools.codelinter && root
            ? {
                command: command(
                  "linter",
                  "--codelinter",
                  tools.codelinter,
                  ...(linterConfig ? ["--config", linterConfig] : []),
                ),
                cwd: "{task_dir}",
                blockedOutputRegex: "GATE_BLOCKED",
                timeoutSeconds: 1200,
              }
            : missing("codelinter 或 Harmony 工程根目录"),
    };
  if (contract.enabled && root)
    gates.contract = {
      command: [
        ...base,
        "public-contract",
        "--task-dir",
        "{task_dir}",
        "--source-root",
        task.project_root,
      ],
      cwd: "{task_dir}",
      blockedOutputRegex: "GATE_BLOCKED",
      timeoutSeconds: 300,
    };
  if (smoke.enabled && tools.hvigorw && root)
    gates.runtime = {
      command: command(
        "runtime-smoke",
        "--hvigorw",
        tools.hvigorw,
        ...(tools.ohpm ? ["--ohpm", tools.ohpm] : []),
      ),
      cwd: "{task_dir}",
      blockedOutputRegex:
        "RUNTIME_SMOKE_BASELINE_UNAVAILABLE|Invalid project path|Permissions Error|GATE_BLOCKED",
      timeoutSeconds: 3600,
    };
  return {
    taskTimeoutSeconds: 1200,
    linterMode: mode,
    refactorAgent: agent(),
    repairAgent: agent(true),
    maxRepairAttempts: 3,
    gates,
    reviewAgent: tools.deveco
      ? {
          command: [
            tools.deveco,
            "run",
            "严格执行附件中的只读评审任务，只输出要求的 JSON。",
            "-f",
            "{review_prompt_file}",
            "--dir",
            "{task_dir}",
            "--format",
            "json",
            "--dangerously-skip-permissions",
          ],
          cwd: "{task_dir}",
          blockedOutputRegex: agentBlockers,
          blockedOutputScope: "agent-errors",
          maxEnvironmentRetries: 2,
          retryDelaySeconds: 2,
          timeoutSeconds: 3600,
        }
      : null,
  };
}
export function prepareTask(
  task: RefactorTask,
  taskDir: string,
  mode: "required" | "skip" = "required",
): { risk: Json; smoke: Json; contract: Json } {
  fs.mkdirSync(taskDir, { recursive: true });
  const risk = analyzeRisks(task);
  writeJson(path.join(taskDir, "task.json"), task);
  writeJson(path.join(taskDir, "risk-report.json"), risk);
  writeJson(path.join(taskDir, "review-risk.json"), reviewRisk(risk));
  const smoke = prepareRuntimeSmoke(task, risk, taskDir),
    contract = preparePublicContract(task, taskDir);
  writeText(
    path.join(taskDir, "refactor-prompt.md"),
    buildRefactorPrompt(task, risk, mode),
  );
  writeText(
    path.join(taskDir, "review-prompt.md"),
    buildReviewPrompt(task, reviewRisk(risk)),
  );
  return { risk, smoke, contract };
}
export async function runInteractive(
  baseDir: string,
  workspaceHint?: string,
  mode: "required" | "skip" = "required",
): Promise<Json> {
  const data = await readPastedJson(),
    workspace = discoverWorkspace(data, workspaceHint ?? process.cwd());
  return runTasks(baseDir, workspace, data, undefined, mode);
}
export async function runTasks(
  baseDir: string,
  workspace: string,
  data: Json[],
  selectedTasks?: RefactorTask[],
  mode: "required" | "skip" = "required",
  dryRun = false,
  metadata: Json = {},
): Promise<Json> {
  const started = now(),
    d = new Date(),
    pad = (n: number) => String(n).padStart(2, "0"),
    name = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    runsRoot = path.join(baseDir, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  const session = fs.mkdtempSync(path.join(runsRoot, name + "-"));
  const input = path.join(session, "input.json");
  writeJson(input, data);
  const tools = dryRun ? {} : discoverTools(workspace),
    tasks = selectedTasks ?? loadDatasetTasks(input, workspace),
    summary: Json[] = [];
  writeJson(path.join(session, "manifest.json"), {
    ...metadata,
    workspace,
    dryRun,
    tools,
    total: tasks.length,
    tasks,
  });
  if (dryRun) {
    console.log(
      `预览：共 ${tasks.length} 条，不启动 Agent 或验证工具\n任务清单：${path.join(session, "manifest.json")}`,
    );
    return { sessionDir: session, workspace, dryRun: true, tasks };
  }
  const saveSummary = () => {
    const counts = Object.fromEntries(
      ["PASS", "FAIL", "BLOCKED", "INCOMPLETE"].map((v) => [
        v,
        summary.filter((t) => t.verdict === v).length,
      ]),
    );
    const final = {
      sessionDir: session,
      workspace,
      counts,
      total: tasks.length,
      completed: summary.length,
      remaining: tasks.length - summary.length,
      durationSeconds: round(now() - started),
      tasks: summary,
      validationPolicy: { linterMode: mode },
      ...metadata,
    };
    writeJson(path.join(session, "summary.json"), final);
    return final;
  };
  saveSummary();
  console.log(`已接收 ${tasks.length} 条异味\n本地仓库根目录：${workspace}`);
  console.log(
    "工具发现：" +
      Object.entries(tools)
        .map(([k, v]) => `${k}=${v ? "已找到" : "未找到"}`)
        .join("，"),
  );
  console.log("Linter 模式：" + mode);
  for (const [i, task] of tasks.entries()) {
    const taskStarted = now(),
      taskDir = path.join(session, task.task_id);
    try {
      const { risk, smoke, contract } = prepareTask(task, taskDir, mode);
      console.log(
        `\n[${i + 1}/${tasks.length}] ${task.target.symbol ?? task.target.file_path}\n  静态风险：${risk.riskLevel}；Refactor Agent 仅接收生产代码与重构规范`,
      );
      const config = autoConfig(task, taskDir, tools, smoke, contract, mode);
      writeJson(path.join(taskDir, "effective-config.json"), config);
      const result = await executePipeline(
        taskDir,
        config,
        false,
        (name, status) => console.log(`  ${name}: ${status}`),
        taskStarted,
      );
      console.log(
        `  最终结果：${result.verdict}；总耗时：${result.durationSeconds.toFixed(1)} 秒${result.timedOut ? "（已达到20分钟上限）" : ""}`,
      );
      summary.push({
        taskId: task.task_id,
        smellType: task.smell_type,
        testKind: task.raw.testKind ?? null,
        target: task.target.symbol ?? task.target.file_path,
        verdict: result.verdict,
        durationSeconds: result.durationSeconds,
        timedOut: result.timedOut,
        taskDir,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const result = {
        taskId: task.task_id,
        target: task.target.symbol ?? task.target.file_path,
        smellType: task.smell_type,
        testKind: task.raw.testKind ?? null,
        verdict: "BLOCKED",
        durationSeconds: round(now() - taskStarted),
        reason,
        taskDir,
      };
      writeJson(path.join(taskDir, "result.json"), result);
      summary.push(result);
      console.error(`  ${task.task_id}: BLOCKED；${reason}`);
    }
    saveSummary();
  }
  const final = saveSummary(),
    counts = final.counts;
  console.log(
    "\n完成：" +
      Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
  );
  console.log(
    `批次总耗时：${final.durationSeconds.toFixed(1)} 秒\n结果目录：${session}`,
  );
  return final;
}
