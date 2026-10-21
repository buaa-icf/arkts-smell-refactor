import { BridgeClient, BridgeError } from "./bridge.ts";
import { applyCandidate, candidateDiff, readTransaction, recoverApplication } from "./apply.ts";
import type { Transaction } from "./apply.ts";
import type { PluginConfig } from "./config.ts";
import type { Backend, BridgeEvent, Candidate, Environment, HistoryRecord, Issue, PipelineResult, Prepared, Step } from "./types.ts";

export interface WorkbenchState {
  busy: boolean;
  stopping: boolean;
  status: string;
  error?: string;
  issues: Issue[];
  selected: number;
  prepared?: Prepared;
  candidate?: Candidate;
  result?: PipelineResult;
  appliedResult?: PipelineResult;
  applyState?: Transaction["state"];
  steps: Step[];
  logs: string;
  runDirectory?: string;
  environment?: Environment;
  history: HistoryRecord[];
  instructions: string;
  diff: string;
}

export class Workbench {
  state: WorkbenchState = { busy: false, stopping: false, status: "就绪", issues: [], selected: 0,
    steps: [], logs: "", history: [], instructions: "", diff: "" };
  private listeners = new Set<(state: WorkbenchState) => void>();
  private abort?: AbortController;
  private pending?: Promise<void>;
  private disposed = false;
  constructor(readonly config: PluginConfig, private backend: Backend = new BridgeClient(config)) {}
  subscribe(listener: (state: WorkbenchState) => void): () => void {
    this.listeners.add(listener); listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  private update(patch: Partial<WorkbenchState>): void {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) for (const listener of this.listeners) listener(this.state);
  }
  get issue(): Issue | undefined { return this.state.issues[this.state.selected]; }
  select(index: number): void {
    if (this.state.busy || index === this.state.selected || !this.state.issues[index]) return;
    this.update({ selected: index, prepared: undefined, candidate: undefined, result: undefined,
      appliedResult: undefined, applyState: undefined, diff: "", steps: [], error: undefined });
  }
  setInstructions(instructions: string): void {
    if (this.state.busy) return;
    this.update({ instructions, prepared: undefined, candidate: undefined, result: undefined,
      applyState: undefined, appliedResult: undefined, diff: "" });
  }
  cancel(): void {
    if (!this.abort || this.state.stopping) return;
    this.update({ stopping: true, status: "正在停止进程树…" });
    this.abort.abort();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort?.abort();
    this.listeners.clear();
    // The host awaits disposal: keep it alive until children exit or a local write finishes.
    await this.pending;
  }

  private async operation(label: string, work: (signal: AbortSignal) => Promise<void>, cancellable = true): Promise<void> {
    if (this.disposed) throw new Error("工作台已关闭");
    if (this.state.busy) throw new Error("请等待当前操作完成");
    const abort = new AbortController();
    let finish = () => {};
    const pending = new Promise<void>((done) => { finish = done; });
    this.pending = pending;
    this.abort = cancellable ? abort : undefined;
    this.update({ busy: true, stopping: false, status: label, error: undefined });
    try {
      await work(abort.signal);
      if (!this.state.stopping) this.update({ status: `${label}：完成` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update({ status: error instanceof BridgeError && error.code === "CANCELLED" ? "已中止" : `${label}：失败`, error: message });
    } finally {
      this.abort = undefined;
      this.update({ busy: false, stopping: false });
      finish();
      if (this.pending === pending) this.pending = undefined;
    }
  }
  private event = (event: BridgeEvent): void => {
    if (event.event === "log.appended") this.update({ logs: (this.state.logs + String(event.data.text ?? "")).slice(-80_000) });
    if (event.event === "run.started") this.update({ runDirectory: String(event.data.runDirectory ?? "") });
    if (event.event === "workflow.changed" && !this.state.stopping) this.update({ status: String(event.data.status ?? "运行中") });
    if (event.event === "step.updated") {
      // Display legacy progress verbatim; the final result is the authority for machine verdicts.
      const name = String(event.data.stepId ?? "未知阶段");
      this.update({ steps: [...this.state.steps.filter((step) => step.name !== name), { name, status: String(event.data.status ?? "") }] });
    }
  };
  private resetEvidence(): void {
    this.update({ prepared: undefined, candidate: undefined, result: undefined, appliedResult: undefined,
      applyState: undefined, diff: "", steps: [], logs: "", runDirectory: undefined });
  }
  inspect(): Promise<void> {
    return this.operation("环境检查", async (signal) => {
      await this.backend.request("session.hello", {}, signal);
      this.update({ environment: await this.backend.request("environment.inspect", {}, signal) });
    });
  }
  importReport(input: { file: string } | { text: string }): Promise<void> {
    return this.operation("导入报告", async (signal) => {
      this.resetEvidence();
      const result = await this.backend.request("issues.import", input, signal);
      this.update({ issues: result.issues, selected: 0 });
    });
  }
  scan(scopePath: string): Promise<void> {
    return this.operation("异味检测", async (signal) => {
      this.resetEvidence();
      const result = await this.backend.request("scan.start", { scopePath }, signal, this.event);
      this.update({ issues: result.issues, selected: 0, runDirectory: result.runDirectory });
    });
  }
  prepare(): Promise<void> {
    return this.operation("风险分析", async (signal) => {
      const issue = this.issue;
      if (!issue?.supported) throw new Error("请选择支持重构的问题");
      this.resetEvidence();
      const prepared = await this.backend.request("task.prepare", { issue, instructions: this.state.instructions }, signal, this.event);
      this.update({ prepared, runDirectory: prepared.runDirectory });
    });
  }
  execute(): Promise<void> {
    return this.operation("生成候选", async (signal) => {
      const prepared = this.state.prepared;
      if (!prepared) throw new Error("请先准备任务并分析风险");
      this.update({ candidate: undefined, result: undefined, appliedResult: undefined, applyState: undefined, diff: "", steps: [], logs: "" });
      const result = await this.backend.request("task.execute", { taskHandle: prepared.taskHandle }, signal, this.event);
      this.update({ ...result, steps: result.result.steps ?? this.state.steps });
    });
  }
  validateCandidate(): Promise<void> {
    return this.operation("候选复检", async (signal) => {
      const candidateId = this.state.candidate?.candidateId;
      if (!candidateId || this.state.applyState === "APPLIED") throw new Error("请选择尚未应用的候选");
      this.update({ candidate: undefined, result: undefined, steps: [], logs: "", diff: "" });
      const result = await this.backend.request("task.validateCandidate", { candidateId }, signal, this.event);
      this.update({ ...result, steps: result.result.steps ?? [] });
    });
  }
  showDiff(name: string): Promise<void> {
    return this.operation("读取 Diff", async () => {
      if (!this.state.candidate) throw new Error("没有候选");
      this.update({ diff: await candidateDiff(this.config, this.state.candidate, name) });
    }, false);
  }
  apply(): Promise<void> {
    return this.operation("应用候选", async (signal) => {
      const candidateId = this.state.candidate?.candidateId;
      if (!candidateId) throw new Error("没有候选");
      const candidate = await this.backend.request("candidate.check", { candidateId }, signal);
      try {
        const transaction = await applyCandidate(this.config, candidate);
        this.update({ candidate, applyState: transaction.state, appliedResult: undefined });
      } catch (error) {
        const transaction = await readTransaction(this.config, candidate);
        this.update({ applyState: transaction?.state });
        throw error;
      }
    }, false);
  }
  validateApplied(): Promise<void> {
    return this.operation("应用后复检", async (signal) => {
      if (!this.state.candidate || this.state.applyState !== "APPLIED") throw new Error("请先应用候选");
      this.update({ appliedResult: undefined, logs: "", steps: [] });
      const result = await this.backend.request("task.validateApplied", { candidateId: this.state.candidate.candidateId }, signal, this.event);
      this.update({ appliedResult: result.result, steps: result.result.steps ?? [], runDirectory: result.runDirectory,
        ...(result.issues ? { issues: result.issues, selected: 0 } : {}) });
    });
  }
  history(): Promise<void> {
    return this.operation("加载历史", async (signal) => {
      this.update({ history: (await this.backend.request("history.list", {}, signal)).records });
    });
  }
  restore(candidateId: string): Promise<void> {
    return this.operation("恢复候选", async (signal) => {
      // describe works after apply as well; restore requires the original baseline.
      const candidate = await this.backend.request("candidate.describe", { candidateId }, signal);
      const transaction = await readTransaction(this.config, candidate);
      this.resetEvidence();
      if (transaction && transaction.state !== "ROLLED_BACK") {
        this.update({ candidate, result: candidate.result, applyState: transaction.state,
          runDirectory: candidate.runDirectory, steps: candidate.result.steps ?? [] });
      } else {
        const restored = await this.backend.request("candidate.restore", { candidateId }, signal);
        this.update({ ...restored, issues: [restored.prepared.issue], selected: 0,
          instructions: restored.prepared.instructions ?? "", runDirectory: candidate.runDirectory,
          steps: restored.result.steps ?? [] });
      }
    });
  }
  recover(): Promise<void> {
    return this.operation("恢复应用前内容", async () => {
      if (!this.state.candidate) throw new Error("请先从历史选择候选");
      const transaction = await recoverApplication(this.config, this.state.candidate);
      this.update({ applyState: transaction.state, appliedResult: undefined });
      if (transaction.conflicts.length) throw new Error(`保留用户修改，以下文件需处理：${transaction.conflicts.join("、")}`);
    }, false);
  }
}
