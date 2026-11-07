import path from "node:path";
import type { Json } from "./models.js";
import { within } from "./utils.js";
import { productionKind } from "./workspace.js";

// The agent sets this description only after editing and source self-review.
export const FINAL_CHECK_DESCRIPTION = "ARKTS_FINAL_CHECK";
export const FINAL_CHECK_INSTRUCTION = `完成全部生产编辑和源码自查后，首次内部验证就使用 description=${FINAL_CHECK_DESCRIPTION}，在当前隔离工程根目录单独执行 devecocli check arkts <全部改动源码路径> 或 devecocli build 二选一。首次成功即交回，不按“先 check 再 build”串行验证；只有本轮代码错误经修复后才复验。`;

function validationCommand(input: Json, cwd: string, edits: Set<string>): "build" | "check" | null {
  if (typeof input.command !== "string" ||
      (input.workdir !== undefined && (typeof input.workdir !== "string" || path.relative(cwd, path.resolve(cwd, input.workdir)) !== ""))) return null;
  const command = input.command.trim();
  if (command === "devecocli build") return "build";
  // Only a standalone check of named source files. Options, shell expressions
  // and compound commands use the normal agent completion path.
  const prefix = "devecocli check arkts ";
  if (!command.startsWith(prefix)) return null;
  // Sticky matching consumes every argument and its separator; an unmatched
  // quote, pipe, switch, or a suffix glued to a quoted path fails closed.
  const argument = /(?:"([^"]+)"|'([^']+)'|([^\s'"]+))(?: +|$)/uy;
  const remaining = new Set(edits);
  argument.lastIndex = prefix.length;
  while (argument.lastIndex < command.length) {
    const match = argument.exec(command);
    if (!match) return null;
    const file = match[1] ?? match[2] ?? match[3];
    if (!/^(?:[A-Za-z]:[\\/])?[\w./\\ \p{L}-]+\.(?:ets|ts)$/iu.test(file) ||
        file.startsWith("-") || !within(path.resolve(cwd, file), cwd)) return null;
    remaining.delete(path.resolve(cwd, file));
  }
  return remaining.size ? null : "check";
}

/** Observe DevEco's own stdout JSONL. Tool output text is never an exit status. */
export function validationHandoff(cwd: string) {
  let session: string | undefined, step: string | undefined;
  let edited = false, nonReadOnlyTools = 0, candidate: "build" | "check" | null = null;
  const edits = new Set<string>();
  return (line: string): "build" | "check" | null => {
    let event: Json;
    try { event = JSON.parse(line); } catch { return null; }
    const part = event?.part;
    if (event?.type === "error") {
      // Let the real child exit and surface provider/runtime failures.
      session = "";
      return null;
    }
    if (!part || typeof event.sessionID !== "string" || !event.sessionID ||
        part.sessionID !== event.sessionID || typeof part.messageID !== "string") return null;
    if (event.type === "step_start") {
      session ??= event.sessionID;
      if (session === event.sessionID) {
        step = part.messageID;
        nonReadOnlyTools = 0;
        candidate = null;
      }
      return null;
    }
    if (session !== event.sessionID || step !== part.messageID) return null;
    if (event.type === "tool_use") {
      const state = part.state;
      // Only completed, built-in read-only queries may accompany the check.
      if (state?.status === "completed" && ["glob", "grep", "read"].includes(part.tool)) return null;
      nonReadOnlyTools++;
      if (state?.status !== "completed") return null;
      if (["write", "edit"].includes(part.tool) && typeof state.input?.filePath === "string") {
        const file = path.resolve(cwd, state.input.filePath);
        if (within(file, cwd) && productionKind(path.relative(cwd, file)) === "source") {
          edits.add(file);
          edited = true;
        }
      }
      if (part.tool !== "bash" || !state.input) return null;
      const command = validationCommand(state.input, cwd, edits);
      if (!command) return null;
      const events = state.metadata?.devecoCliEvents;
      const succeeded = state.metadata?.exit === 0 && Array.isArray(events) && events.length === 1 &&
        events[0]?.command === command && events[0].exitCode === 0 &&
        (command === "build" || events[0].subcommand === "arkts");
      if (edited && state.input.description === FINAL_CHECK_DESCRIPTION && succeeded) candidate = command;
      // A successful unmarked check does not erase the production edits. A
      // later explicit final check must still be eligible for handoff.
      // Failed/unverified checks require another edit before a retry can hand off.
      if (!succeeded) edited = false;
    }
    if (event.type === "step_finish") {
      step = undefined;
      return nonReadOnlyTools === 1 && part.reason === "tool-calls" ? candidate : null;
    }
    return null;
  };
}
