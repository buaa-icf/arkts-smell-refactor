import fs from "node:fs";
import path from "node:path";
import type { Json, RefactorTask } from "../models.js";
import {
  isDir,
  isFile,
  sourceFiles,
  readText,
  within,
  relative,
  unique,
} from "../utils.js";
export function analyzeCyclicDependency(task: RefactorTask): Json {
  const c = task.raw.analysisContext ?? {},
    modulePath = c.modulePath ?? "",
    root = path.join(task.project_root, modulePath),
    ets = path.join(root, "src/main/ets"),
    edges = new Map<string, Json[]>();
  const dirs = isDir(ets)
    ? fs
        .readdirSync(ets, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, path: path.join(ets, d.name) }))
    : [];
  for (const dir of dirs)
    for (const file of sourceFiles(dir.path))
      readText(file)
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(
            /(?:import\s+.*?\s+from\s+|import\s+)['"]([^'"]+)['"]/g,
          )) {
            if (!m[1].startsWith(".")) continue;
            const base = path.resolve(path.dirname(file), m[1]);
            const target =
                [
                  base,
                  base + ".ets",
                  path.join(base, "Index.ets"),
                  path.join(base, "index.ets"),
                ].find(isFile) ?? base,
              owner = dirs.find(
                (d) => d.name !== dir.name && within(target, d.path),
              );
            if (owner) {
              const key = JSON.stringify([dir.name, owner.name]);
              edges.set(key, [
                ...(edges.get(key) ?? []),
                {
                  filePath: relative(file, task.project_root),
                  line: i + 1,
                  importPath: m[1],
                },
              ]);
            }
          }
        });
  const cycleEdges = (c.baselineCycles ?? []).flatMap((cycle: string[]) =>
    cycle.slice(0, -1).map((from, i) => ({
      from,
      to: cycle[i + 1],
      evidence: edges.get(JSON.stringify([from, cycle[i + 1]])) ?? [],
    })),
  );
  return {
    module: c.module,
    modulePath,
    baselineCycles: c.baselineCycles ?? [],
    cycleEdges,
    publicEntryFiles: [
      path.join(root, "Index.ets"),
      path.join(ets, "Index.ets"),
    ]
      .filter(isFile)
      .map((p) => relative(p, task.project_root)),
    candidateHint:
      "Name the smallest ownership-correct cut for every cycle: neutral-layer types, symbol movement, or dependency inversion. Preserve exports with re-exports or delegates.",
    analysisLimitations: [
      "Directory-level lexical graph of relative imports",
      "Package aliases, dynamic loading and re-export chains need additional validation",
    ],
  };
}
export function cyclicConstraints(a: Json): [Json[], Json[]] {
  const risks = [
    {
      code: "CYCLIC_DEPENDENCY_MULTI_FILE",
      level: "high",
      evidence: `${a.baselineCycles.length} cycle(s), ${a.cycleEdges.length} cycle edge(s)`,
      affectedFiles: unique(
        a.cycleEdges.flatMap((e: Json) =>
          e.evidence.map((r: Json) => r.filePath),
        ),
      ),
    },
  ];
  if (a.cycleEdges.some((e: Json) => !e.evidence.length))
    risks.push({
      code: "CYCLE_EDGE_EVIDENCE_INCOMPLETE",
      level: "medium",
      evidence: "Some declared edges were not located",
      affectedFiles: a.publicEntryFiles,
    });
  return [
    risks,
    [
      {
        code: "BREAK_EVERY_BASELINE_CYCLE",
        reason: "One cut may leave another cycle",
        instruction:
          "Name a cut edge for every declared cycle and rescan the complete module for residual/new cycles",
      },
      {
        code: "PRESERVE_DEPENDENCY_OWNERSHIP",
        reason: "Mechanical moves can reverse dependencies",
        instruction:
          "Use real ownership; do not copy implementation or mutable state",
      },
      {
        code: "PRESERVE_PUBLIC_EXPORTS",
        reason: "External consumers may be invisible",
        instruction: "Preserve entries, export names, signatures and semantics",
      },
    ],
  ];
}
