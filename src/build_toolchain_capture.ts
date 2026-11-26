/** Passive preload: observe the official CLI's actual Hvigor launches, not its private APIs. */
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const directory = process.env.ARKTS_BUILD_TOOLCHAIN_CAPTURE;
if (directory) {
  const observeLaunch = (call: any[]) => {
    const [command, args, options = {}] = call;
    if (!Array.isArray(args)) return;
    const script = args.find((a) => /(?:^|[/\\])hvigorw\.js$/i.test(a));
    if (!script) return;
    const env = options.env ?? process.env;
    const get = (name: string): string | undefined => {
      if (env[name] !== undefined) return env[name];
      const key = Object.keys(env).find((k) => k.toUpperCase() === name);
      return key ? env[key] : undefined;
    };
    // Capture the launch in the CLI. Its ESM preload must not enter Hvigor's
    // daemon or workers. Preserve the caller's other Node options.
    const childEnv = { ...env };
    delete childEnv.ARKTS_BUILD_TOOLCHAIN_CAPTURE;
    const key = Object.keys(childEnv).find(k => k.toUpperCase() === "NODE_OPTIONS");
    if (key) {
      const preload = "--import=" + import.meta.url;
      const remaining = String(childEnv[key]).split(" ").filter(token => token !== preload).join(" ").trim();
      if (remaining) childEnv[key] = remaining;
      else delete childEnv[key];
    }
    call[2] = { ...options, env: childEnv };
    if (!get("DEVECO_SDK_HOME")) return;
    const cwd = String(options.cwd ?? process.cwd());
    // No command arguments, credentials, or full environment are persisted.
    fs.writeFileSync(
      path.join(directory, `${process.pid}-${randomUUID()}.json`),
      JSON.stringify({
        node: command,
        hvigor: path.resolve(cwd, script),
        sdk: get("DEVECO_SDK_HOME"),
        cwd,
        env: Object.fromEntries(
          [
            "PATH",
            "JAVA_HOME",
            "DEVECO_SDK_HOME",
            "NODE_HOME",
            "OHPM_HOME",
          ].flatMap((key) => (get(key) ? [[key, get(key)]] : [])),
        ),
      }),
      { flag: "wx" },
    );
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = function (...args: any[]) {
    observeLaunch(args);
    return (spawn as any)(...args);
  } as typeof spawn;
  const spawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function (...args: any[]) {
    observeLaunch(args);
    return (spawnSync as any)(...args);
  } as typeof spawnSync;
  syncBuiltinESMExports();
}
