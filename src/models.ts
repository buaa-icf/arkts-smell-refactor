import path from "node:path";
export type Json = Record<string, any>;
export type Status =
  "PASS" | "FAIL" | "BLOCKED" | "SKIPPED" | "INCOMPLETE" | "DRY_RUN";
export interface SourceRange {
  start_line: number | null;
  end_line: number | null;
  column: number | null;
}
export interface Target {
  file_path: string;
  symbol: string | null;
  range: SourceRange;
  related_targets: Json[];
}
export interface RefactorTask {
  schema_version: string;
  task_id: string;
  source_project: string;
  commit_hash: string;
  workspace_root: string;
  project_root: string;
  smell_type: string;
  rule: string;
  severity: string;
  message: string;
  target: Target;
  raw: Json;
}
export interface CommandResult {
  name: string;
  status: Status;
  command?: string | null;
  exit_code?: number | null;
  duration_seconds: number;
  output_file?: string | null;
  reason?: string | null;
}
export interface CommandSpec {
  command?: string | string[];
  cwd?: string;
  enabled?: boolean;
  reason?: string;
  timeoutSeconds?: number;
  blockedOutputRegex?: string;
  blockedOutputScope?: string;
  successOutputRegex?: string;
  maxEnvironmentRetries?: number;
  retryDelaySeconds?: number;
}
export interface Config {
  taskTimeoutSeconds?: number;
  linterMode?: "required" | "skip";
  maxRepairAttempts?: number;
  refactorAgent?: CommandSpec | null;
  repairAgent?: CommandSpec | null;
  reviewAgent?: CommandSpec | null;
  gates?: Record<string, CommandSpec>;
}
export const RULE_TYPES: Record<string, string> = {
  "@extrulesproject/feature-envy-check": "feature-envy",
  "@extrulesproject/long-method-check": "long-method",
  "@extrulesproject/switch-statement-check": "switch-statement",
  "@extrulesproject/code-clone-fragment-check": "code-clone",
  "formal/god-class": "god-class",
  "formal/directory-cycle": "cyclic-dependency",
};
export const targetPath = (task: RefactorTask) =>
  path.resolve(task.workspace_root, task.target.file_path);
export function taskFromJson(raw: Json): RefactorTask {
  const t = raw.target,
    r = t.range ?? t.source_range ?? {};
  return {
    schema_version: raw.schema_version ?? raw.schemaVersion ?? "1.0",
    task_id: raw.task_id ?? raw.taskId,
    source_project: raw.source_project ?? raw.sourceProject ?? "",
    commit_hash: raw.commit_hash ?? raw.commitHash ?? "",
    workspace_root: raw.workspace_root ?? raw.workspaceRoot,
    project_root: raw.project_root ?? raw.projectRoot,
    smell_type: raw.smell_type ?? raw.smellType ?? "",
    rule: raw.rule,
    severity: raw.severity ?? "",
    message: raw.message ?? "",
    target: {
      file_path: t.file_path ?? t.filePath,
      symbol: t.symbol ?? null,
      range: {
        start_line: r.start_line ?? r.startLine ?? null,
        end_line: r.end_line ?? r.endLine ?? null,
        column: r.column ?? null,
      },
      related_targets: t.related_targets ?? t.relatedTargets ?? [],
    },
    raw: raw.raw ?? {},
  };
}
