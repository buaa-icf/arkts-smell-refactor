// Read-only recheck of a frozen candidate. No refactor, repair or review Agent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BridgeContext,
  configureEnvironment,
  copyProject,
  snapshot,
  same,
} from "../../dist/ide/common.js";
import { loadCandidateForValidation } from "../../dist/ide/candidates.js";
import { smellCandidateGate } from "../../dist/ide/scan.js";
import { readJson, writeJson, writeText, readText } from "../../dist/utils.js";
async function main() {
  const index = process.argv.indexOf("--candidate-run");
  if (index < 0 || !process.argv[index + 1])
    throw Error(
      "Usage: node tools/smoke_candidate_gate.mjs --candidate-run <absolute-run>",
    );
  const candidateRun = path.resolve(process.argv[index + 1]),
    config = readJson(path.join(candidateRun, "backend/bridge-settings.json"));
  const root = readJson(path.join(candidateRun, "session.json")).projectRoot;
  configureEnvironment(config);
  const scanner = fileURLToPath(
    new URL("../src/main/resources/bridge/homecheck_scan.cjs", import.meta.url),
  );
  const ctx = new BridgeContext(config, root, scanner);
  const [, candidate, preparedRun] = loadCandidateForValidation(
    ctx,
    path.basename(candidateRun),
  );
  const before = snapshot(candidate.originalRoot),
    run = ctx.createRun("smoke.candidateSmell"),
    stage = path.join(run, "staging", path.basename(candidate.originalRoot));
  copyProject(path.join(preparedRun, "baseline"), stage);
  for (const item of candidate.changes) {
    const dest = path.join(stage, item.relativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(
      path.join(candidateRun, "content/after", item.relativePath),
      dest,
    );
  }
  if (!same(snapshot(stage), candidate.afterFiles))
    throw Error("Frozen candidate differs from manifest");
  const oldPrefix = path.join(candidateRun, "staging"),
    newPrefix = path.dirname(stage),
    taskDir = path.join(run, "backend");
  fs.mkdirSync(taskDir, { recursive: true });
  for (const e of fs.readdirSync(path.join(candidateRun, "backend"), {
    withFileTypes: true,
  }))
    if (e.isFile() && /\.(json|md)$/.test(e.name)) {
      const value = readText(path.join(candidateRun, "backend", e.name))
        .replaceAll(
          JSON.stringify(oldPrefix).slice(1, -1),
          JSON.stringify(newPrefix).slice(1, -1),
        )
        .replaceAll(oldPrefix, newPrefix)
        .replaceAll(
          oldPrefix.replaceAll("\\", "/"),
          newPrefix.replaceAll("\\", "/"),
        );
      writeText(path.join(taskDir, e.name), value);
    }
  copyProject(
    path.join(candidateRun, "backend/baseline-production"),
    path.join(taskDir, "baseline-production"),
  );
  const exit = await smellCandidateGate(
    new BridgeContext(config, stage, scanner),
    taskDir,
    stage,
  );
  if (
    !same(snapshot(root), before) ||
    !same(snapshot(stage), candidate.afterFiles)
  )
    throw Error("Scan changed source files");
  const session = readJson(path.join(run, "session.json"));
  writeJson(path.join(run, "session.json"), {
    ...session,
    state: exit === 0 ? "SUCCEEDED" : "FAILED",
    smellGateExit: exit,
  });
  console.log(
    JSON.stringify({
      smellGateExit: exit,
      runDirectory: run,
      originalUnchanged: true,
    }),
  );
  process.exitCode = exit;
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 3;
});
