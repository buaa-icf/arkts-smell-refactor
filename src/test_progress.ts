import fs from "node:fs";
import path from "node:path";
import type { Json } from "./models.js";
import { escapeRe, isFile, readJson, readText, within } from "./utils.js";

export type TestPhase =
  | "preparing-test"
  | "awaiting-install"
  | "awaiting-test-result"
  | "collecting-results";
export const TEST_PHASE_TIMEOUTS: Record<TestPhase, number> = {
  "preparing-test": 300,
  "awaiting-install": 90,
  "awaiting-test-result": 300,
  "collecting-results": 60,
};
const ENV_TIMEOUTS: Record<TestPhase, string> = {
  "preparing-test": "ARKTS_TEST_PREPARE_TIMEOUT_SECONDS",
  "awaiting-install": "ARKTS_TEST_INSTALL_TIMEOUT_SECONDS",
  "awaiting-test-result": "ARKTS_TEST_EXECUTION_TIMEOUT_SECONDS",
  "collecting-results": "ARKTS_TEST_COLLECT_TIMEOUT_SECONDS",
};
export function testPhaseTimeouts(
  env: NodeJS.ProcessEnv,
): Record<TestPhase, number> {
  const timeouts = { ...TEST_PHASE_TIMEOUTS };
  for (const phase of Object.keys(timeouts) as TestPhase[]) {
    const value = env[ENV_TIMEOUTS[phase]];
    if (value === undefined) continue;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error(ENV_TIMEOUTS[phase] + " must be a positive number");
    timeouts[phase] = seconds;
  }
  return timeouts;
}

/** Replace whole JSON documents so a killed child cannot leave half a manifest. */
export function writeTestState(file: string, value: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".pending";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, file);
}
export function saveTestResults(taskDir: string, results: Json): void {
  if (
    typeof results.plan === "string" &&
    within(results.plan, path.join(taskDir, "test-attempts"))
  )
    writeTestState(
      path.join(path.dirname(results.plan), "results.json"),
      results,
    );
  writeTestState(path.join(taskDir, "test-results.json"), results);
}

/** Phase clocks measure elapsed time, rather than restarting on noisy output. */
export function monitorTestJob(
  job: Json,
  evidenceDir: string,
  artifacts: string,
  timeouts: Record<TestPhase, number>,
  redact: (text: string) => string,
  saveManifest: () => void,
) {
  const controller = new AbortController();
  const phases = Object.keys(TEST_PHASE_TIMEOUTS) as TestPhase[];
  const signed = new RegExp(
    "^> hvigor (?:Finished|UP-TO-DATE) :" +
      escapeRe(job.module) +
      ":ohosTest@SignHap\\b",
  );
  let phase: TestPhase = "preparing-test";
  let timer: NodeJS.Timeout;
  const versions = new Map<string, string>();
  job.phase = phase;
  job.phaseHistory = [];
  job.artifacts = {};
  const saveProgress = () => writeTestState(job.progressFile, job);
  const guarded = (action: () => void) => {
    try {
      action();
    } catch (error) {
      if (controller.signal.aborted) return;
      job.classification = "TEST_MONITOR_ERROR";
      job.reason =
        "Cannot preserve live test evidence: " + redact(String(error));
      controller.abort(job.reason);
    }
  };
  const arm = () => {
    job.phaseStartedAt = new Date().toISOString();
    job.phaseTimeoutSeconds = timeouts[phase];
    job.phaseHistory.push({
      phase,
      startedAt: job.phaseStartedAt,
      timeoutSeconds: timeouts[phase],
      evidence: job.phaseEvidence,
    });
    console.log(
      "TEST_PHASE time=" +
        job.phaseStartedAt +
        " phase=" +
        phase +
        " timeoutSeconds=" +
        timeouts[phase],
    );
    saveProgress();
    saveManifest();
    timer = setTimeout(() => {
      const reason =
        "测试阶段 " +
        phase +
        " 超过 " +
        timeouts[phase] +
        " 秒，未收到下一阶段完成证据";
      Object.assign(job, {
        timeoutPhase: phase,
        classification: "TEST_PHASE_TIMEOUT",
        reason,
      });
      guarded(() => {
        saveProgress();
        saveManifest();
      });
      controller.abort(reason);
    }, timeouts[phase] * 1000);
  };
  const advance = (next: TestPhase, evidence: string) => {
    if (
      controller.signal.aborted ||
      phases.indexOf(next) <= phases.indexOf(phase)
    )
      return;
    clearTimeout(timer);
    phase = next;
    Object.assign(job, { phase, phaseEvidence: evidence });
    arm();
  };
  const onLine = (line: string) =>
    guarded(() => {
      const safe = redact(line);
      fs.appendFileSync(job.log, safe + "\n", "utf8");
      process.stdout.write(safe + "\n");
      job.lastOutputAt = new Date().toISOString();
      const plain = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
      if (job.kind !== "instrument") return;
      if (signed.test(plain))
        advance("awaiting-install", "ohosTest@SignHap completed");
      if (/^> hvigor Finished install haps\b/.test(plain))
        advance(
          "awaiting-test-result",
          "Hvigor reported Finished install haps",
        );
    });
  const capture = () => {
    for (const name of ["test_result.txt", "coverage.log"]) {
      const source = path.join(artifacts, name);
      if (!isFile(source)) continue;
      let stat: fs.Stats, text: string;
      try {
        stat = fs.statSync(source);
        const version = stat.mtimeMs + ":" + stat.size;
        if (versions.get(name) === version) continue;
        text = readText(source);
      } catch (error) {
        // Hvigor may replace an artifact while it is being sampled.
        if (
          ["ENOENT", "EBUSY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          continue;
        throw error;
      }
      const version = stat.mtimeMs + ":" + stat.size;
      const saved = path.join(evidenceDir, name);
      fs.writeFileSync(saved + ".pending", redact(text), "utf8");
      fs.renameSync(saved + ".pending", saved);
      versions.set(name, version);
      job.artifacts[name] = saved;
      job.lastArtifactAt = new Date().toISOString();
      if (
        /TestFinished-ResultCode:\s*-?\d+/.test(text) ||
        (job.kind === "local" && /Tests run:\s*\d+,\s*Failure:/.test(text))
      )
        advance(
          "collecting-results",
          name + " contains execution completion marker",
        );
      else if (/OHOS_REPORT_(?:STATUS|SUM):|^test=/m.test(text))
        advance("awaiting-test-result", name + " contains test runner output");
    }
    saveProgress();
  };
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(job.log, "", "utf8");
  arm();
  const polling = setInterval(() => guarded(capture), 500);
  return {
    signal: controller.signal,
    onLine,
    stop() {
      clearInterval(polling);
      guarded(capture);
      clearTimeout(timer);
    },
  };
}

/** The outer runner calls this after the child tree is gone, including Windows
 * taskkill /F, where the gate process cannot flush a finally block. */
export function interruptTestResults(
  taskDir: string,
  reason: string,
  classification: string,
): void {
  const file = path.join(taskDir, "test-results.json");
  const results = isFile(file)
    ? readJson(file)
    : { status: "RUNNING", jobs: [] };
  if (results.status !== "RUNNING") return;
  const endedAt = new Date().toISOString();
  for (const job of results.jobs ?? []) {
    if (job.status !== "RUNNING") continue;
    if (
      typeof job.progressFile === "string" &&
      within(job.progressFile, path.join(taskDir, "test-attempts")) &&
      isFile(job.progressFile)
    )
      Object.assign(job, readJson(job.progressFile));
    if (job.status !== "RUNNING") continue;
    Object.assign(job, { status: "BLOCKED", reason, classification, endedAt });
    if (job.startedAt)
      job.durationSeconds =
        (Date.parse(endedAt) - Date.parse(job.startedAt)) / 1000;
    if (
      typeof job.progressFile === "string" &&
      within(job.progressFile, path.join(taskDir, "test-attempts"))
    )
      writeTestState(job.progressFile, job);
  }
  Object.assign(results, {
    status: "BLOCKED",
    reason,
    classification,
    endedAt,
  });
  saveTestResults(taskDir, results);
}
