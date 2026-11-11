import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Json } from "./models.js";
import { isDir, isFile, readJson } from "./utils.js";

export function captureEnvironment(directory: string): NodeJS.ProcessEnv {
  fs.mkdirSync(directory, { recursive: true });
  const hook = pathToFileURL(
    fileURLToPath(new URL("./build_toolchain_capture.js", import.meta.url)),
  ).href;
  return {
    ...process.env,
    ARKTS_BUILD_TOOLCHAIN_CAPTURE: directory,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${hook}`]
      .filter(Boolean)
      .join(" "),
  };
}

function executable(name: string, search: string): string | undefined {
  if (path.isAbsolute(name)) return isFile(name) ? name : undefined;
  return search
    .split(path.delimiter)
    .map((dir) => path.join(dir.replace(/^"|"$/g, ""), name))
    .find(isFile);
}

export function capturedToolchain(directory: string, workspace: string): Json {
  const rows = fs
    .readdirSync(directory)
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJson(path.join(directory, n)))
    .filter((r) => path.resolve(r.cwd) === path.resolve(workspace));
  if (!rows.length)
    throw new Error(
      "官方 CLI 未产生可确认的 Hvigor/SDK 环境证据，不能另找 PATH 工具代替",
    );
  const signatures = new Set(
    rows.map((r) => JSON.stringify([r.node, r.hvigor, r.sdk, r.env])),
  );
  if (signatures.size !== 1)
    throw new Error(
      "本次 CLI 构建使用了多套 Hvigor/SDK 环境，不能猜测测试环境",
    );
  const r = rows[0],
    node = executable(r.node, r.env.PATH ?? "");
  const javaName = process.platform === "win32" ? "java.exe" : "java";
  const java =
    executable(javaName, r.env.PATH ?? "") ??
    (r.env.JAVA_HOME
      ? executable(javaName, path.join(r.env.JAVA_HOME, "bin"))
      : undefined);
  if (!node || !java || !isFile(r.hvigor) || !isDir(r.sdk))
    throw new Error("CLI 实际构建环境的 Node/Hvigor/Java/SDK 路径无效");
  const hdc = [
    path.join(
      r.sdk,
      "default/openharmony/toolchains",
      process.platform === "win32" ? "hdc.exe" : "hdc",
    ),
    path.join(
      r.sdk,
      "openharmony/toolchains",
      process.platform === "win32" ? "hdc.exe" : "hdc",
    ),
  ].find(isFile);
  return {
    node,
    hvigor: r.hvigor,
    sdk: r.sdk,
    java,
    hdc: hdc ?? null,
    env: r.env,
    evidenceSource: "official-cli-hvigor-launch",
  };
}

export function successfulBuildToolchain(
  taskDir: string,
  source: string,
  workspace: string,
  cliEntry: string,
): Json {
  const evidence = readJson(path.join(taskDir, "build-evidence.json"));
  if (
    evidence.status !== "PASS" ||
    !evidence.runId ||
    !evidence.completionEvidence ||
    evidence.exitCode !== 0 ||
    evidence.sourceRoot !== path.resolve(source) ||
    evidence.workspace !== path.resolve(workspace) ||
    evidence.cliEntry !== cliEntry ||
    evidence.toolchain?.status !== "CONFIRMED"
  )
    throw new Error(
      "缺少当前工程、本轮成功构建的工具环境证据，请先执行 build 门禁",
    );
  const toolchain = evidence.toolchain;
  if (
    !toolchain.env ||
    toolchain.env.DEVECO_SDK_HOME !== toolchain.sdk ||
    typeof toolchain.env.PATH !== "string" ||
    Object.entries(toolchain.env).some(
      ([key, value]) =>
        ![
          "PATH",
          "JAVA_HOME",
          "DEVECO_SDK_HOME",
          "NODE_HOME",
          "OHPM_HOME",
        ].includes(key) || typeof value !== "string",
    )
  )
    throw new Error("成功构建的工具环境记录不完整或不一致，请重新构建");
  if (
    ![toolchain.node, toolchain.hvigor, toolchain.java].every(
      (p) => typeof p === "string" && isFile(p),
    ) ||
    !isDir(toolchain.sdk)
  )
    throw new Error("成功构建使用的工具环境已失效，请重新构建");
  return {
    ...toolchain,
    buildRunId: evidence.runId,
    product: evidence.product,
  };
}

export function toolchainEnvironment(toolchain: Json): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Windows environment names are case-insensitive; remove Path/PATH duplicates.
  for (const key of Object.keys(env))
    if (
      Object.keys(toolchain.env).some(
        (k) => k.toUpperCase() === key.toUpperCase(),
      )
    )
      delete env[key];
  return { ...env, ...toolchain.env };
}
