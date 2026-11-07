import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { which } from "./process.js";
import { isFile, parents, readJson, readText, within } from "./utils.js";

export interface DevecoCli {
  entry: string;
  implementation: string;
  version: string;
  devecoPackage: string;
}
const PACKAGES = ["@deveco-test/deveco-code", "@deveco/deveco-code"];

/** Resolve ONLY from the selected DevEco Code installation, never a project or devecocli PATH entry. */
export function bundledDevecoCli(deveco: string | null): DevecoCli | null {
  if (!deveco) return null;
  const launcher = which(deveco);
  if (!launcher) return null;
  try {
    const real = fs.realpathSync(launcher),
      candidates: string[] = [];
    // Unix npm bin links resolve inside the package; Windows npm shims name it.
    for (const dir of parents(path.dirname(real))) {
      const meta = path.join(dir, "package.json");
      if (isFile(meta) && PACKAGES.includes(readJson(meta).name)) {
        candidates.push(meta);
        break;
      }
    }
    if (
      fs.statSync(real).size < 65536 &&
      /(?:\.(?:cmd|bat|ps1)|[/\\]deveco)$/i.test(real)
    ) {
      const shim = readText(real).replaceAll("\\", "/");
      for (const name of PACKAGES)
        if (shim.includes("node_modules/" + name + "/"))
          candidates.push(
            path.join(path.dirname(real), "node_modules", name, "package.json"),
          );
    }
    for (const meta of candidates) {
      if (!isFile(meta)) continue;
      const require = createRequire(meta),
        cliMeta = require.resolve("@deveco/deveco-cli/package.json"),
        pkg = readJson(cliMeta),
        bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.devecocli;
      const installationModules = path.resolve(path.dirname(meta), "../..");
      if (
        !within(cliMeta, installationModules) ||
        pkg.name !== "@deveco/deveco-cli" ||
        typeof bin !== "string"
      )
        continue;
      const entry = path.resolve(path.dirname(cliMeta), bin);
      if (!within(entry, path.dirname(cliMeta)) || !isFile(entry)) continue;
      const implementation = createRequire(entry).resolve(
        ((process.platform as string) === "openharmony"
          ? "@deveco/deveco-cli-openharmony-arm64"
          : "@deveco/deveco-cli-common") + "/dist/cli.js",
      );
      if (
        !within(implementation, installationModules) ||
        !isFile(implementation)
      )
        continue;
      return {
        entry,
        implementation,
        version: String(pkg.version),
        devecoPackage: readJson(meta).name,
      };
    }
  } catch {
    /* Missing/incomplete official optional dependency is a blocked environment. */
  }
  return null;
}
