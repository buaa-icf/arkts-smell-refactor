import path from "node:path";
import type { Json } from "./models.js";
import { isFile, readJson, within } from "./utils.js";
import { parseHypiumCases } from "./test_execution.js";
import { saveTestResults } from "./test_progress.js";
import { runCommand } from "./process.js";

function caseErrorLocation(details: string): string {
  const lines = details.replaceAll("\\", "/").split(/\r?\n/);
  const testFrames = lines.slice(1).flatMap((line) => {
    const location =
      /\b(src\/(?:ohosTest|test)\/[^)\r\n]+?:\d+:\d+)\)?\s*$/i.exec(line);
    return location ? [location[1]] : [];
  });
  return [lines[0], ...testFrames].join("\n");
}

/** A changing or ambiguous device makes two onDeviceTest results incomparable. */
export async function singleTestDevice(
  hdc: string | undefined,
  cwd: string,
): Promise<string | null> {
  if (!hdc || !isFile(hdc)) return null;
  const list = await runCommand([hdc, "list", "targets"], {
    cwd,
    timeoutSeconds: 10,
  });
  const target = list.output.trim();
  return list.code === 0 && /^[\w.:-]+$/.test(target) ? target : null;
}

export function compareTestOutcomes(
  candidate: Json,
  baseline: Json,
  baselineRoot: string,
): string {
  if (candidate.classification === "TEST_SOURCE_COMPILE_FAILURE") {
    if (baseline.status === "PASS") return "INTRODUCED_TEST_FAILURE";
    if (
      baseline.classification === candidate.classification &&
      candidate.diagnostics?.length &&
      candidate.diagnostics.every((c: Json) =>
        baseline.diagnostics?.some(
          (b: Json) =>
            b.message === c.message &&
            b.file === c.file &&
            b.line === c.line &&
            b.column === c.column,
        ),
      )
    )
      return "BASELINE_TEST_FAILURE";
    return "TEST_BASELINE_INCONCLUSIVE";
  }
  const artifact = baseline.artifacts?.["test_result.txt"];
  if (
    !artifact ||
    !within(artifact, baselineRoot) ||
    !isFile(artifact) ||
    !candidate.failedCases?.length
  )
    return "TEST_BASELINE_INCONCLUSIVE";
  const before = parseHypiumCases(artifact);
  const matches = candidate.failedCases.map((c: Json) =>
    before.filter((b) => b.suite === c.suite && b.name === c.name),
  );
  if (
    baseline.status === "PASS" &&
    matches.every(
      (group: Json[]) => group.length === 1 && group[0].result === "Success",
    )
  )
    return "INTRODUCED_TEST_FAILURE";
  if (
    baseline.status === "FAIL" &&
    matches.every((group: Json[], i: number) => {
      const c = candidate.failedCases[i];
      return (
        group.length === 1 &&
        group[0].result === c.result &&
        caseErrorLocation(group[0].details) === caseErrorLocation(c.details)
      );
    })
  )
    return "BASELINE_TEST_FAILURE";
  return "TEST_BASELINE_INCONCLUSIVE";
}

/** Preserve the candidate's own case report, even when the same failure predates the edit. */
export async function compareFailedTestJob(
  taskDir: string,
  plan: Json,
  replay: (directory: string, job: Json) => Promise<void>,
  redact: (text: string) => string,
): Promise<number> {
  const results = readJson(path.join(taskDir, "test-results.json"));
  const failed = results.jobs.at(-1);
  if (
    !failed ||
    failed.status !== "FAIL" ||
    (!failed.failedCases?.length &&
      failed.classification !== "TEST_SOURCE_COMPILE_FAILURE")
  )
    return 1;
  const original = plan.jobs.find(
    (j: Json) =>
      j.module === failed.module &&
      j.kind === failed.kind &&
      j.scope === failed.scope,
  );
  const directory = path.join(path.dirname(results.plan), "baseline");
  if (!original || !within(directory, path.join(taskDir, "test-attempts")))
    return 1;
  failed.baselineComparison = {
    classification: "TEST_BASELINE_PENDING",
    directory,
  };
  results.status = "RUNNING";
  saveTestResults(taskDir, results);
  try {
    await replay(directory, original);
    const manifest = path.join(directory, "test-results.json");
    const baseline = readJson(manifest).jobs[0];
    const classification = baseline
      ? compareTestOutcomes(failed, baseline, directory)
      : "TEST_BASELINE_INCONCLUSIVE";
    failed.baselineComparison = {
      classification,
      manifest,
      status: baseline?.status,
    };
  } catch (error) {
    failed.baselineComparison = {
      classification: "TEST_BASELINE_UNAVAILABLE",
      reason: redact(String(error)),
    };
  }
  const classification = failed.baselineComparison.classification;
  results.classification = classification;
  results.status =
    classification === "BASELINE_TEST_FAILURE" ? "BLOCKED" : "FAIL";
  results.reason = results.status === "BLOCKED" ? "原始基线复现同一测试失败" : failed.reason;
  saveTestResults(taskDir, results);
  console.log("TEST_BASELINE " + classification);
  if (results.status === "BLOCKED")
    console.error("TEST_GATE_BLOCKED: 原始基线复现同一测试失败");
  return results.status === "BLOCKED" ? 3 : 1;
}
