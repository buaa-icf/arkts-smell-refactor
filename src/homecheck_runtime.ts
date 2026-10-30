import path from "node:path";
import { createRequire } from "node:module";
import { isDir, isFile } from "./utils.js";
import { which } from "./process.js";
const require = createRequire(import.meta.url);
export function bundledHomecheck(): string | null {
  try {
    const root = path.dirname(
      require.resolve("@arkts-refactor/homecheck-runtime/package.json"),
    );
    return [
      "scan.cjs",
      "runtime-manifest.json",
      "config/projectConfig.json",
      "config/ruleConfig.json",
      "rules/lib/index.js",
      "node_modules/homecheck/lib/Main.js",
      "node_modules/arkanalyzer/lib/index.js",
      "node_modules/ohos-typescript/lib/typescript.js",
    ].every((file) => isFile(path.join(root, file)))
      ? root
      : null;
  } catch {
    return null;
  }
}
export function detectorSdkPaths(): {
  ohosSdkPath: string;
  hmsSdkPath: string;
} {
  const hvigor = which("hvigorw");
  const candidates = [
    process.env.DEVECO_SDK_HOME,
    ...(hvigor
      ? [
          path.resolve(hvigor, "../../sdk/default"),
          path.resolve(hvigor, "../../../../sdk/default"),
        ]
      : []),
  ].filter((p): p is string => !!p);
  const sdk = candidates
    .flatMap((p) => [p, path.join(p, "default")])
    .find((p) => isDir(path.join(p, "openharmony/ets")));
  return {
    ohosSdkPath: sdk ? path.join(sdk, "openharmony/ets") : "",
    hmsSdkPath:
      sdk && isDir(path.join(sdk, "hms/ets")) ? path.join(sdk, "hms/ets") : "",
  };
}
