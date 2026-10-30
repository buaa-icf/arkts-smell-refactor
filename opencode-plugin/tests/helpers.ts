import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { sha256 } from "../src/apply.ts";
import type { Candidate } from "../src/types.ts";

export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function fixture() {
  const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.artifacts/fixtures");
  await mkdir(artifactRoot, { recursive: true });
  const directory = resolve(artifactRoot, `arkts-tui-test-${randomUUID()}`);
  await mkdir(directory);
  const projectRoot = resolve(directory, "示例 Project");
  await mkdir(projectRoot);
  const config = await loadConfig({ projectRoot, backend: backendRoot, runs: resolve(directory, "runs"),
    node: process.env.ARKTS_TEST_NODE ?? "node", timeoutMs: 15_000 });
  const name = "entry/src/main/ets/Page.ets";
  await mkdir(dirname(resolve(projectRoot, name)), { recursive: true });
  const before = Buffer.from("class Page { update() { return 1; } }\n");
  const after = Buffer.from("class Page { update() { return this.value(); } private value() { return 1; } }\n");
  await writeFile(resolve(projectRoot, name), before);
  await writeFile(resolve(projectRoot, "build-profile.json5"), "{}");
  await mkdir(resolve(projectRoot, "hvigor"));
  await writeFile(resolve(projectRoot, "hvigor/hvigor-config.json5"), "{}");
  const candidateId = randomUUID();
  const runDirectory = resolve(config.runs, candidateId);
  for (const [phase, data] of [["before", before], ["after", after]] as const) {
    await mkdir(dirname(resolve(runDirectory, "content", phase, name)), { recursive: true });
    await writeFile(resolve(runDirectory, "content", phase, name), data);
  }
  const candidate: Candidate = { candidateId, taskHandle: randomUUID(), originalRoot: projectRoot,
    runDirectory, verdict: "PASS", configDigest: "test", baselineFiles: { [name]: sha256(before) },
    afterFiles: { [name]: sha256(after) }, changes: [{ relativePath: name, beforeSha256: sha256(before),
      afterSha256: sha256(after), size: after.length, changeType: "modified", kind: "source" }],
    result: { verdict: "PASS", steps: [{ name: "build", status: "PASS" }] } };
  const record = { filePath: name, sourceProject: "示例 Project", messages: [{
    rule: "@extrulesproject/long-method-check", line: 1, rangeStart: 1, rangeEnd: 1,
    message: "Method 'update' is too long", severity: "SUGGESTION",
  }] };
  return { directory, config, projectRoot, name, before, after, candidate, record };
}
