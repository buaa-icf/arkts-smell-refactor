/** Passive preload: observe the official CLI's actual Hvigor launches, not its private APIs. */
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const directory = process.env.ARKTS_BUILD_TOOLCHAIN_CAPTURE;
if (directory) {
  const record = (
    command: string,
    args: readonly string[] = [],
    options: any = {},
  ) => {
    const script = args.find((a) => /(?:^|[/\\])hvigorw\.js$/i.test(a));
    if (!script) return;
    const env = options.env ?? process.env;
    const get = (name: string): string | undefined => {
      if (env[name] !== undefined) return env[name];
      const key = Object.keys(env).find((k) => k.toUpperCase() === name);
      return key ? env[key] : undefined;
    };
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
    record(
      args[0],
      Array.isArray(args[1]) ? args[1] : [],
      Array.isArray(args[1]) ? args[2] : args[1],
    );
    return (spawn as any)(...args);
  } as typeof spawn;
  const spawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function (...args: any[]) {
    record(
      args[0],
      Array.isArray(args[1]) ? args[1] : [],
      Array.isArray(args[1]) ? args[2] : args[1],
    );
    return (spawnSync as any)(...args);
  } as typeof spawnSync;
  syncBuiltinESMExports();
}
