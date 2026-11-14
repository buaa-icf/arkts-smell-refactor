import fs from "node:fs";
import path from "node:path";

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined || process.platform !== "win32") return env[name];
  const key = Object.keys(env).find(key => key.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/** Resolve against the supplied environment without mutating the host process. */
function executable(command: string, env: NodeJS.ProcessEnv): string | null {
  const extensions = process.platform === "win32" && !path.extname(command)
    ? [...(environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""] : [""];
  const explicit = path.isAbsolute(command) || /[\\/]/.test(command);
  const directories = explicit ? [""] : (environmentValue(env, "PATH") ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) for (const extension of extensions) {
    const file = path.resolve(directory.replace(/^"|"$/g, ""), command + extension);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return fs.realpathSync(file);
    } catch { /* Try the next configured location. */ }
  }
  return null;
}

/** Prefer the configured SDK/Studio and selected Hvigor installation over unrelated PATH tools. */
export function resolveHdc(options: { hdc?: string; hvigor?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
  const env = options.env ?? process.env, sdkRoots: string[] = [];
  if (options.hdc !== undefined) return options.hdc.trim() ? executable(options.hdc, env) : null;
  const configuredSdk = environmentValue(env, "DEVECO_SDK_HOME"), studio = environmentValue(env, "DEVECO_HOME");
  if (configuredSdk && path.isAbsolute(configuredSdk)) sdkRoots.push(configuredSdk);
  if (studio && path.isAbsolute(studio)) sdkRoots.push(path.join(studio, "sdk"));
  if (options.hvigor) {
    const hvigor = executable(options.hvigor, env);
    if (hvigor) {
      // Studio: tools/hvigor/bin; standalone command-line tools: bin.
      let directory = path.dirname(hvigor);
      for (let depth = 0; depth < 4; depth++) {
        sdkRoots.push(path.join(directory, "sdk"));
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  }
  for (const sdk of new Set(sdkRoots.map(root => path.resolve(root)))) {
    for (const relative of ["default/openharmony/toolchains", "openharmony/toolchains",
      "default/harmonyos/toolchains", "harmonyos/toolchains", "toolchains"]) {
      const found = executable(path.join(sdk, relative, "hdc"), env);
      if (found) return found;
    }
  }
  return executable("hdc", env);
}

/** Share the selected HDC with both signature checks and Hvigor's device test process. */
export function deviceToolEnvironment(hvigor: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...env }, hdc = resolveHdc({ hvigor, env });
  if (hdc) {
    const directory = path.dirname(hdc);
    const equalPath = (value: string) => process.platform === "win32"
      ? value.toLowerCase() === directory.toLowerCase() : value === directory;
    if (process.platform === "win32")
      for (const key of Object.keys(result)) if (key.toUpperCase() === "PATH") delete result[key];
    result.PATH = [directory, ...(environmentValue(env, "PATH") ?? "").split(path.delimiter).filter(part =>
      part && !equalPath(path.resolve(part.replace(/^"|"$/g, ""))))].join(path.delimiter);
  }
  return result;
}
