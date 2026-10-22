import fs from "node:fs";
import path from "node:path";
import type { Json } from "./models.js";
import {
  copyFile,
  isFile,
  now,
  readText,
  round,
  stamp,
  within,
  writeJson,
  writeText,
} from "./utils.js";
import { runCommand } from "./process.js";
export const TEST_TOOL_BLOCKERS =
  "Connect server failed|\\[Empty\\]|no (?:available |connected )?devices?\\b|device not found|device[^\\r\\n]*(?:offline|not connected)|\\bFailed[^\\r\\n]*@SignHap\\b|Invalid storeFile value|(?:hap/hsp|hap|hsp) package is signed";
export function testToolBlocker(output: string): Json | null {
  if (
    /INSTALL_FAILED_NO_MATCHING_ABIS|install parse native so failed|Abi type supported by the device does not match/i.test(
      output,
    )
  )
    return {
      classification: "DEVICE_ABI_MISMATCH",
      reason: "设备与测试包的原生库 ABI 不匹配，安装失败，测试未执行",
    };
  const match = new RegExp(TEST_TOOL_BLOCKERS, "i").exec(output);
  return match
    ? {
        classification: "TEST_TOOL_UNAVAILABLE",
        reason: "测试设备或签名环境不可用：" + match[0],
      }
    : null;
}
export interface HypiumCase {
  suite: string;
  name: string;
  result: string;
  details: string;
}
export function parseHypiumCases(file: string): HypiumCase[] {
  const cases: HypiumCase[] = [];
  let suite = "",
    name = "",
    details: string[] = [];
  for (const line of readText(file).split(/\r?\n/)) {
    if (line.startsWith("class=")) suite = line.slice(6).trim();
    else if (line.startsWith("test=")) {
      name = line.slice(5).trim();
      details = [];
    } else if (line.startsWith("result=") && name) {
      cases.push({
        suite,
        name,
        result: line.slice(7).trim(),
        details: details.join("\n"),
      });
      name = "";
    } else if (name) details.push(line);
  }
  return cases;
}
export const failedHypiumCases = (cases: HypiumCase[]) =>
  cases.filter(
    (c) =>
      !["success", "ignore", "ignored", "skip", "skipped"].includes(
        c.result.toLowerCase(),
      ),
  );
export const hostUnavailable = (details: string) =>
  /(?:component not found|unable to find id)\s*:\s*[^\r\n]+/i.test(details) &&
  /error in beforeAll function/i.test(details);
export function resultEvidence(file: string, expected: string[]): Json {
  if (!isFile(file))
    return { status: "BLOCKED", reason: "missing fresh test_result.txt" };
  const text = readText(file),
    m = [
      ...text.matchAll(
        /Tests run:\s*(\d+),\s*Failure:\s*(\d+),\s*Error:\s*(\d+),\s*Pass:\s*(\d+)/g,
      ),
    ].at(-1),
    summary = m
      ? { tests: +m[1], failures: +m[2], errors: +m[3], passed: +m[4] }
      : null,
    successes: Record<string, number> = {},
    cases = parseHypiumCases(file),
    failures = failedHypiumCases(cases);
  for (const c of cases)
    if (c.result === "Success")
      successes[c.suite] = (successes[c.suite] ?? 0) + 1;
  const evidence = {
    summary,
    suitePassCounts: successes,
    failedCases: failures,
  };
  if (
    failures.length &&
    summary?.tests === failures.length &&
    summary.passed === 0 &&
    failures.every((c) => hostUnavailable(c.details))
  )
    return {
      ...evidence,
      status: "BLOCKED",
      classification: "TEST_HOST_UNAVAILABLE",
      reason:
        "test host unavailable in beforeAll; production assertions did not execute",
    };
  if (failures.length || (summary && (summary.failures || summary.errors)))
    return { ...evidence, status: "FAIL", reason: "Hypium test cases failed" };
  if (!summary || summary.tests <= 0 || summary.passed !== summary.tests)
    return {
      ...evidence,
      status: "BLOCKED",
      reason: "missing, empty or incomplete Hypium summary",
    };
  const missing = expected.filter((s) => !successes[s]);
  if (missing.length)
    return {
      ...evidence,
      status: "BLOCKED",
      reason: "expected suites did not execute: " + missing.join(", "),
    };
  if (Object.values(successes).reduce((a, b) => a + b, 0) !== summary.passed)
    return {
      ...evidence,
      status: "BLOCKED",
      reason: "case results do not match Hypium summary",
    };
  return { ...evidence, status: "PASS", reason: "fresh Hypium cases passed" };
}
export async function runTestPlan(
  taskDir: string,
  workspace: string,
  plan: Json,
  launcher: string[],
  env = process.env,
): Promise<number> {
  if (!plan.jobs?.length) {
    writeJson(path.join(taskDir, "test-results.json"), {
      status: "BLOCKED",
      reason: "empty test plan",
      jobs: [],
    });
    console.error("TEST_GATE_BLOCKED: empty test plan");
    return 3;
  }
  const attempt = path.join(taskDir, "test-attempts", stamp());
  writeJson(path.join(attempt, "plan.json"), plan);
  const results: Json = {
    schemaVersion: "1.0",
    plan: path.join(attempt, "plan.json"),
    status: "RUNNING",
    jobs: [],
  };
  writeJson(path.join(taskDir, "test-results.json"), results);
  for (const module of plan.additionalModulesWithoutBusinessTests ?? [])
    console.log(
      `TEST_COVERAGE_NOTE module=${module} only SDK template tests found; no independent business suite; target tests remain required`,
    );
  for (const [i, job] of (plan.jobs as Json[]).entries()) {
    const evidenceDir = path.join(
        attempt,
        `${String(i + 1).padStart(2, "0")}-${job.kind}`,
      ),
      artifacts = path.resolve(
        workspace,
        job.modulePath,
        ".test/default/intermediates",
        job.kind === "instrument" ? "ohosTest" : "test",
        "coverage_data",
      );
    if (!within(artifacts, workspace))
      throw new Error("Test artifacts escape validation workspace");
    for (const name of ["test_result.txt", "coverage.log", "js_coverage.json"])
      fs.rmSync(path.join(artifacts, name), { force: true });
    const selector =
        job.module + (job.kind === "instrument" ? "@ohosTest" : ""),
      command = [
        ...launcher,
        "--no-daemon",
        job.task,
        "-p",
        `module=${selector}`,
        "-p",
        "coverage=true",
      ];
    if (job.scope) command.push("-p", `scope=${job.scope}`);
    if (job.kind === "instrument") command.push("-p", "ohos-debug-asan=true");
    console.log(
      `TEST_SELECTION kind=${job.kind} module=${selector} scope=${job.scope ?? "*"} reason=${job.reason}`,
    );
    const started = now(),
      run = await runCommand(command, { cwd: workspace, env });
    let evidence = resultEvidence(
      path.join(artifacts, "test_result.txt"),
      job.expectedSuites,
    );
    if (run.error)
      evidence = {
        status: "BLOCKED",
        reason: "cannot launch Hvigor: " + run.error,
      };
    else if (run.code !== 0) {
      // Fresh assertion failures take precedence over error-like text printed by a test.
      const blocker = evidence.failedCases?.length
        ? null
        : testToolBlocker(run.output);
      evidence = {
        ...evidence,
        status:
          blocker || evidence.classification === "TEST_HOST_UNAVAILABLE"
            ? "BLOCKED"
            : "FAIL",
        ...(blocker ?? {}),
        reason: `Hvigor exited with code ${run.code}; ${blocker?.reason ?? evidence.reason}`,
      };
    }
    if (job.kind === "instrument" && evidence.status === "PASS") {
      const log = path.join(artifacts, "coverage.log"),
        text = isFile(log) ? readText(log) : "";
      if (
        !text.includes("OHOS_REPORT_RESULT:") ||
        !text.includes("TestFinished-ResultCode: 0")
      )
        evidence = {
          ...evidence,
          status: "BLOCKED",
          reason: "missing fresh device execution completion evidence",
        };
    }
    const log = path.join(evidenceDir, "hvigor.log");
    writeText(log, run.output);
    process.stdout.write(run.output);
    const copied: Json = {};
    for (const name of ["test_result.txt", "coverage.log"])
      if (isFile(path.join(artifacts, name))) {
        const saved = path.join(evidenceDir, name);
        copyFile(path.join(artifacts, name), saved);
        copied[name] = saved;
        if (evidence.status !== "PASS")
          console.log(readText(saved).slice(-12000));
      }
    results.jobs.push({
      ...job,
      ...evidence,
      selectionReason: job.reason,
      command,
      exitCode: run.code,
      durationSeconds: round(now() - started),
      log,
      artifacts: copied,
    });
    results.status =
      evidence.status !== "PASS"
        ? evidence.status
        : i === plan.jobs.length - 1
          ? "PASS"
          : "RUNNING";
    results.pendingJobs = plan.jobs.slice(i + 1);
    writeJson(path.join(attempt, "results.json"), results);
    writeJson(path.join(taskDir, "test-results.json"), results);
    console.log(
      `TEST_RESULT kind=${job.kind} module=${selector} status=${evidence.status} ${evidence.reason}`,
    );
    if (evidence.status !== "PASS") {
      if (evidence.status === "BLOCKED")
        console.error("TEST_GATE_BLOCKED: " + evidence.reason);
      return evidence.status === "BLOCKED" ? 3 : 1;
    }
  }
  return 0;
}
