import fs from "node:fs";
import path from "node:path";
import type { Json } from "./models.js";
import { hash, isFile, readText, within } from "./utils.js";
import {
  builderStateRisks,
  BUILDER_STATE_SCOPE,
} from "./analysis/builder_state.js";

/** Recompute from this round's snapshots, never consume a previous round's report. */
export function collectReactiveEvidence(
  taskDir: string,
  changes: string[],
): Json {
  const issues: Json[] = [];
  for (const file of [...new Set(changes)]) {
    if (!/\.(ets|ts)$/.test(file)) continue;
    const beforeRoot = path.resolve(taskDir, "baseline-production"),
      afterRoot = path.resolve(taskDir, "current-production");
    const before = path.resolve(beforeRoot, file),
      after = path.resolve(afterRoot, file);
    if (
      ![
        [before, beforeRoot],
        [after, afterRoot],
      ].every(
        ([p, root]) =>
          within(p, root) &&
          isFile(p) &&
          within(fs.realpathSync(p), fs.realpathSync(root)),
      )
    )
      continue;
    for (const issue of builderStateRisks(readText(before), readText(after)))
      issues.push({
        ...issue,
        filePath: file,
        baselineSha256: hash(before),
        currentSha256: hash(after),
      });
  }
  return {
    scope: BUILDER_STATE_SCOPE,
    issues: issues.slice(0, 20),
    omitted: Math.max(0, issues.length - 20),
  };
}
