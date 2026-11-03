import path from "node:path";
import type { Json } from "./models.js";
import { within } from "./utils.js";
import { productionKind } from "./workspace.js";

// The agent sets this description only after editing and source self-review.
export const FINAL_CHECK_DESCRIPTION = "ARKTS_FINAL_CHECK";

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
  let edited = false, toolsInStep = 0, candidate: "build" | "check" | null = null;
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
        toolsInStep = 0;
        candidate = null;
      }
      return null;
    }
    if (session !== event.sessionID || step !== part.messageID) return null;
    if (event.type === "tool_use") {
      toolsInStep++;
      const state = part.state;
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
      if (edited && state.input.description === FINAL_CHECK_DESCRIPTION && state.metadata?.exit === 0 &&
          Array.isArray(events) && events.length === 1 && events[0]?.command === command &&
          events[0].exitCode === 0 && (command === "build" || events[0].subcommand === "arkts")) candidate = command;
      // An unsuccessful check can be retried after a new edit.
      edited = false;
    }
    if (event.type === "step_finish") {
      step = undefined;
      return toolsInStep === 1 && part.reason === "tool-calls" ? candidate : null;
    }
    return null;
  };
}
