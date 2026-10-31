// Explicit file arguments work on both Node 20 and Node 22, without shell globs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "dist-tests/tests");
const files = fs.readdirSync(directory)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(directory, name));
if (!files.length) throw new Error("No compiled tests found; run npm test to compile them first.");
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
