import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { within } from "./config.ts";
import type { PluginConfig } from "./config.ts";
import type { Backend, BridgeEvent, BridgeMethods } from "./types.ts";

const MAX_LINE = 8 * 1024 * 1024;
export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BridgeError"; }
}

/** UTF-8 decoding happens before line assembly; never decode individual pipe buffers. */
export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  constructor(private receive: (value: unknown) => void) {}
  push(chunk: Buffer): void { this.consume(this.decoder.write(chunk)); }
  end(): void {
    this.consume(this.decoder.end());
    if (this.pending.trim()) this.line(this.pending);
    this.pending = "";
  }
  private consume(text: string): void {
    this.pending += text;
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
    if (Buffer.byteLength(this.pending) > MAX_LINE) throw new BridgeError("PROTOCOL_ERROR", "桥接消息超过 8 MiB");
  }
  private line(line: string): void {
    if (Buffer.byteLength(line) > MAX_LINE) throw new BridgeError("PROTOCOL_ERROR", "桥接消息超过 8 MiB");
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new BridgeError("PROTOCOL_ERROR", "桥接 stdout 出现非法 JSON"); }
    this.receive(value);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function resultShape(method: keyof BridgeMethods, value: unknown): boolean {
  if (!object(value)) return false;
  if (method === "session.hello") return value.protocolVersion === 1 && Array.isArray(value.supportedRules);
  if (method === "environment.inspect") return Array.isArray(value.tools) && typeof value.canDetect === "boolean";
  if (method === "history.list") return Array.isArray(value.records);
  if (method === "issues.import" || method === "scan.start") return Array.isArray(value.issues);
  if (method === "task.prepare") return typeof value.taskHandle === "string" && object(value.risk);
  if (method.startsWith("candidate.") && method !== "candidate.restore") return typeof value.candidateId === "string" && Array.isArray(value.changes);
  if (method === "candidate.restore") return object(value.candidate) && object(value.prepared) && object(value.result);
  return object(value.result) && typeof value.result.verdict === "string" &&
    (method === "task.validateApplied" || object(value.candidate));
}

export class BridgeClient implements Backend {
  constructor(readonly config: PluginConfig) {}

  async request<M extends keyof BridgeMethods>(method: M, params: Record<string, unknown> = {}, signal?: AbortSignal,
    onEvent?: (event: BridgeEvent) => void): Promise<BridgeMethods[M]> {
    if (signal?.aborted) throw new BridgeError("CANCELLED", "操作已中止");
    await access(this.config.bridgePath);
    const project = await realpath(this.config.projectRoot);
    // Resolve the nearest existing ancestor so a runs symlink cannot bypass containment.
    const { canonicalPath } = await import("./paths.ts");
    if (within(project, await canonicalPath(this.config.runs))) throw new Error("runs 实际路径必须位于工程之外");
    const requestId = randomUUID();
    const request = JSON.stringify({ protocolVersion: 1, type: "request", requestId, method,
      projectRoot: project, config: this.config, params });
    if (Buffer.byteLength(request) > MAX_LINE) throw new Error("请求超过 8 MiB");

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.node, [this.config.bridgePath], {
        cwd: this.config.backend, shell: false, windowsHide: true, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"], env: process.env,
      });
      let failure: Error | undefined;
      let response: Record<string, unknown> | undefined;
      let stderr = "";
      let sequence = 0;
      let stopping = false;
      const stop = (error: Error) => {
        failure ??= error;
        if (stopping || !child.pid) return;
        stopping = true;
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill());
          killer.on("close", (code) => { if (code !== 0) child.kill(); });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const abort = () => stop(new BridgeError("CANCELLED", "操作已中止；运行证据已保留"));
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => stop(new BridgeError("TIMEOUT", "后端操作超时，已停止进程树")), this.config.timeoutMs);
      const parser = new JsonLines((value) => {
        if (!object(value) || value.protocolVersion !== 1) throw new BridgeError("PROTOCOL_ERROR", "桥接协议版本不匹配");
        if (value.type === "event") {
          if (!Number.isSafeInteger(value.seq) || Number(value.seq) !== sequence + 1 ||
              typeof value.event !== "string" || !object(value.data)) {
            throw new BridgeError("PROTOCOL_ERROR", "桥接事件格式或序号无效");
          }
          sequence = Number(value.seq);
          onEvent?.(value as unknown as BridgeEvent);
        } else if (value.type === "response") {
          if (value.requestId !== requestId || response || typeof value.ok !== "boolean") {
            throw new BridgeError("PROTOCOL_ERROR", "桥接响应关联无效");
          }
          response = value;
        } else throw new BridgeError("PROTOCOL_ERROR", "未知桥接消息类型");
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        try { parser.push(chunk); } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-12_000); });
      child.stdin.on("error", (error) => { failure ??= error; });
      child.on("error", (error) => { failure ??= error; });
      child.on("close", (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        try {
          if (!failure) parser.end();
          if (failure) throw failure;
          if (!response) throw new BridgeError("PROCESS_EXITED", `后端退出 (${code})，未返回响应。${stderr}`);
          if (response.ok === false) {
            const error = object(response.error) ? response.error : {};
            throw new BridgeError(String(error.code ?? "BACKEND_ERROR"), String(error.message ?? "后端操作失败"));
          }
          if (code !== 0) throw new BridgeError("PROCESS_EXITED", `后端异常退出 (${code})。${stderr}`);
          if (!resultShape(method, response.result)) throw new BridgeError("PROTOCOL_ERROR", "桥接结果缺少必要字段");
          resolve(response.result as BridgeMethods[M]);
        } catch (error) { reject(error); }
      });
      child.stdin.end(request + "\n", "utf8");
      if (signal?.aborted) abort();
    });
  }
}
