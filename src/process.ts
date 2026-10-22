import spawn from "cross-spawn";
import { spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  stream?: boolean;
  onOutput?: (text: string) => void;
}
export interface ProcessOutput {
  code: number | null;
  output: string;
  error?: string;
  cancelled: boolean;
  timedOut: boolean;
}
const activeChildren = new Set<ChildProcess>();
export function installCancellationHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      for (const child of activeChildren) terminateTree(child);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
}
export function which(command: string): string | null {
  const extensions =
    process.platform === "win32" && !path.extname(command)
      ? [
          ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean),
          "",
        ]
      : [""];
  const explicit =
    path.isAbsolute(command) || command.includes("/") || command.includes("\\");
  const directories = explicit
    ? [""]
    : (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of directories)
    for (const ext of extensions) {
      const p = path.resolve(dir.replace(/^"|"$/g, ""), command + ext);
      try {
        if (fs.statSync(p).isFile()) {
          fs.accessSync(
            p,
            process.platform === "win32"
              ? fs.constants.F_OK
              : fs.constants.X_OK,
          );
          return p;
        }
      } catch {}
    }
  return null;
}
export function terminateTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    try {
      child.kill("SIGKILL");
    } catch {}
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}
export async function runCommand(
  command: string[] | string,
  options: ProcessOptions,
): Promise<ProcessOutput> {
  if (options.signal?.aborted)
    return { code: null, output: "", cancelled: true, timedOut: false };
  return new Promise((resolve) => {
    let output = "",
      error: string | undefined,
      cancelled = false,
      timedOut = false,
      settled = false;
    const child = Array.isArray(command)
      ? spawn(command[0], command.slice(1), {
          cwd: options.cwd,
          env: options.env ?? process.env,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(command, [], {
          cwd: options.cwd,
          env: options.env ?? process.env,
          windowsHide: true,
          detached: process.platform !== "win32",
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
    activeChildren.add(child);
    // StringDecoder avoids splitting a multi-byte Chinese character between chunks.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const collectText = (text: string) => {
      output += text;
      if (options.stream) process.stdout.write(text);
      options.onOutput?.(text);
    };
    child.stdout?.on("data", collectText);
    child.stderr?.on("data", collectText);
    let hardStop: NodeJS.Timeout | undefined;
    const kill = () => {
      terminateTree(child);
      hardStop ??= setTimeout(() => finish(null), 3000);
    };
    const abort = () => {
      cancelled = true;
      kill();
    };
    const timer =
      options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(
            () => {
              timedOut = true;
              kill();
            },
            Math.max(0, options.timeoutSeconds) * 1000,
          );
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      if (timer) clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      options.signal?.removeEventListener("abort", abort);
      if (cancelled || timedOut) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({ code, output, error, cancelled, timedOut });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (e) => {
      error = e.message;
      finish(null);
    });
    child.on("close", finish);
  });
}
export const displayCommand = (command: string[] | string) =>
  typeof command === "string"
    ? command
    : command
        .map((s) => (/[\s"&|<>^]/.test(s) ? JSON.stringify(s) : s))
        .join(" ");
