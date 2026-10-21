export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "INCOMPLETE" | "DRY_RUN";
export interface Issue {
  issueId: string;
  filePath: string;
  absolutePath: string;
  rule: string;
  smellType: string;
  message: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  supported: boolean;
  sourceSha256: string;
  rawMessage: Record<string, unknown>;
  relatedTargets: Record<string, unknown>[];
  commitHash: string;
}
export interface Risk {
  riskLevel?: string;
  risks?: unknown[];
  recommendedConstraints?: unknown[];
  [key: string]: unknown;
}
export interface Prepared {
  taskHandle: string;
  taskId: string;
  originalRoot: string;
  baselineFiles: Record<string, string>;
  risk: Risk;
  issue: Issue;
  instructions: string;
  runDirectory: string;
}
export interface Step {
  name: string;
  status: string;
  reason?: string;
  duration_seconds?: number;
}
export interface PipelineResult {
  verdict: Verdict;
  steps?: Step[];
  failureReason?: string;
  reason?: string;
  [key: string]: unknown;
}
export interface Change {
  relativePath: string;
  changeType: "added" | "modified";
  kind: "source" | "resource";
  beforeSha256: string | null;
  afterSha256: string;
  size: number;
}
export interface Candidate {
  candidateId: string;
  taskHandle: string;
  originalRoot: string;
  runDirectory: string;
  verdict: Verdict;
  configDigest: string;
  baselineFiles: Record<string, string>;
  afterFiles: Record<string, string>;
  changes: Change[];
  result: PipelineResult;
}
export interface Environment {
  tools: { name: string; path: string; available: boolean; required: boolean }[];
  canDetect: boolean;
  canRefactor: boolean;
}
export interface HistoryRecord {
  runId: string;
  method: string;
  startedAt: string;
  state: string;
  verdict?: Verdict;
  hasCandidate: boolean;
  candidateId?: string;
  runDirectory: string;
  applyState?: string;
}
export interface BridgeEvent {
  protocolVersion: 1;
  type: "event";
  seq: number;
  event: string;
  data: Record<string, unknown>;
}
export interface BridgeMethods {
  "session.hello": { protocolVersion: number; adapterVersion: string; transport: string; supportedRules: string[] };
  "environment.inspect": Environment;
  "issues.import": { issues: Issue[] };
  "scan.start": { issues: Issue[]; runDirectory: string };
  "task.prepare": Prepared;
  "task.execute": { candidate: Candidate; result: PipelineResult; runDirectory: string };
  "task.validateCandidate": BridgeMethods["task.execute"];
  "task.validateApplied": { result: PipelineResult; issues?: Issue[]; runDirectory: string };
  "candidate.restore": { candidate: Candidate; prepared: Prepared; result: PipelineResult };
  "candidate.check": Candidate;
  "candidate.describe": Candidate;
  "history.list": { records: HistoryRecord[] };
}
export interface Backend {
  request<M extends keyof BridgeMethods>(method: M, params?: Record<string, unknown>, signal?: AbortSignal,
    onEvent?: (event: BridgeEvent) => void): Promise<BridgeMethods[M]>;
}
