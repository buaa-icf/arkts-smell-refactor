// Maintainer-only, offline packaging from a built HomeCheck rules checkout.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import spawn from "cross-spawn";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceArg = process.argv.indexOf("--source");
if (sourceArg < 0 || !process.argv[sourceArg + 1])
  throw Error(
    "Usage: npm run package:homecheck -- --source <built homecheck-extrule>",
  );
const source = path.resolve(process.argv[sourceArg + 1]),
  template = path.join(root, "tools/homecheck-runtime");
const stage = fs.mkdtempSync(path.join(root, ".test-tmp-homecheck-package-"));
const packageDir = path.join(stage, "package");
fs.cpSync(template, packageDir, { recursive: true });
const pkg = JSON.parse(
  fs.readFileSync(path.join(template, "package.json"), "utf8"),
);
const sourceRequire = createRequire(path.join(source, "package.json"));
const installed = new Map(),
  manifest = [];
function resolveMeta(name, resolver) {
  try {
    return resolver.resolve(name + "/package.json");
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let dir = path.dirname(resolver.resolve(name));
    while (path.dirname(dir) !== dir) {
      const file = path.join(dir, "package.json");
      if (
        fs.existsSync(file) &&
        JSON.parse(fs.readFileSync(file, "utf8")).name === name
      )
        return file;
      dir = path.dirname(dir);
    }
    throw Error("Cannot resolve package metadata: " + name);
  }
}
function copyDependency(name, resolver, parent = packageDir) {
  const meta = resolveMeta(name, resolver),
    src = path.dirname(meta),
    data = JSON.parse(fs.readFileSync(meta, "utf8"));
  if (installed.get(name)?.version === data.version) return;
  const dest = path.join(
    installed.has(name) ? parent : packageDir,
    "node_modules",
    name,
  );
  if (fs.existsSync(path.join(dest, "package.json"))) {
    if (
      JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"))
        .version !== data.version
    )
      throw Error("Dependency collision: " + name);
    return;
  }
  if (!installed.has(name))
    installed.set(name, { version: data.version, dest });
  const directModules = path.join(src, "node_modules");
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: (file) =>
      file !== directModules && path.basename(file) !== "node_modules",
  });
  manifest.push({
    name,
    version: data.version,
    license: data.license || "SEE LICENSE IN PACKAGE",
    path: path.relative(packageDir, dest).replaceAll("\\", "/"),
  });
  const local = createRequire(meta);
  for (const dependency of Object.keys(data.dependencies || {}))
    copyDependency(dependency, local, dest);
}
for (const [name, version] of Object.entries(pkg.dependencies)) {
  const resolver =
    name === "ohos-typescript"
      ? createRequire(sourceRequire.resolve("arkanalyzer"))
      : sourceRequire;
  const actual = JSON.parse(
    fs.readFileSync(resolveMeta(name, resolver), "utf8"),
  ).version;
  if (actual !== version)
    throw Error(`Expected ${name}@${version}, found ${actual}`);
  copyDependency(name, resolver);
}
// ArkAnalyzer ships ohos-typescript under lib/node_modules; retain it there.
const parser = path.join(
  packageDir,
  "node_modules/ohos-typescript/package.json",
);
if (!fs.existsSync(parser)) throw Error("Bundled ArkTS parser is missing");
fs.cpSync(path.join(source, "lib"), path.join(packageDir, "rules/lib"), {
  recursive: true,
});
fs.cpSync(path.join(source, "docs"), path.join(packageDir, "rules/docs"), {
  recursive: true,
});
for (const name of ["fsConcurrencyLimit", "outOfScopeIssueFilter"])
  fs.copyFileSync(
    path.join(source, "scripts", name + ".js"),
    path.join(packageDir, name + ".cjs"),
  );
fs.cpSync(path.join(source, "patches"), path.join(packageDir, "patches"), {
  recursive: true,
});
fs.mkdirSync(path.join(packageDir, "config"), { recursive: true });
fs.writeFileSync(
  path.join(packageDir, "config/projectConfig.json"),
  JSON.stringify(
    {
      sdkVersion: 20,
      ohosSdkPath: "",
      hmsSdkPath: "",
      product: "default",
      sdksThirdParty: [],
      fix: "false",
    },
    null,
    2,
  ),
);
const rules = JSON.parse(
  fs.readFileSync(path.join(source, "config/ruleConfig.json"), "utf8"),
);
rules.extRuleSet = [];
rules.rules = {};
rules.ruleSet = [];
fs.writeFileSync(
  path.join(packageDir, "config/ruleConfig.json"),
  JSON.stringify(rules, null, 2),
);
// Installed code must include the existing detector and logger patches.
for (const [file, marker] of [
  ["homecheck/lib/Index.js", "AdviceChecker"],
  ["homecheck/lib/model/Defects.js", "this.methodName = methodName"],
  ["arkanalyzer/lib/utils/logger.js", "type: 'file',"],
]) {
  if (
    !fs
      .readFileSync(path.join(packageDir, "node_modules", file), "utf8")
      .includes(marker)
  )
    throw Error("Required patch missing: " + file);
}
const digest = (dir) => {
  const hash = crypto.createHash("sha256");
  function visit(current) {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        hash.update(path.relative(dir, file).replaceAll("\\", "/"));
        hash.update(fs.readFileSync(file));
      }
    }
  }
  visit(dir);
  return hash.digest("hex");
};
const versions = {
  homecheck: pkg.dependencies.homecheck,
  arkanalyzer: pkg.dependencies.arkanalyzer,
  arktsParser: JSON.parse(fs.readFileSync(parser, "utf8")).version,
};
for (const dir of ["node_modules/arkanalyzer", "rules"])
  fs.copyFileSync(
    path.join(packageDir, "node_modules/homecheck/LICENSE"),
    path.join(packageDir, dir, "LICENSE"),
  );
fs.writeFileSync(
  path.join(packageDir, "runtime-manifest.json"),
  JSON.stringify(
    {
      schemaVersion: "1.0",
      runtimeVersion: pkg.version,
      ...versions,
      rulesSha256: digest(path.join(packageDir, "rules/lib")),
      dependenciesSha256: digest(path.join(packageDir, "node_modules")),
      adapterHashes: Object.fromEntries(
        ["scan.cjs", "fsConcurrencyLimit.cjs", "outOfScopeIssueFilter.cjs"].map(
          (name) => [
            name,
            crypto
              .createHash("sha256")
              .update(fs.readFileSync(path.join(packageDir, name)))
              .digest("hex"),
          ],
        ),
      ),
      dependencies: manifest.sort((a, b) => a.path.localeCompare(b.path)),
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(packageDir, "THIRD_PARTY_NOTICES.md"),
  "# Third-party notices\n\nThis package redistributes patched HomeCheck and ArkAnalyzer and compiled custom rules. Original copyright and license notices are retained alongside their files; patches are included in patches/.\n\n" +
    manifest.map((m) => `- ${m.name}@${m.version}: ${m.license}`).join("\n") +
    "\n- ohos-typescript@" +
    versions.arktsParser +
    ": Apache-2.0 (bundled by ArkAnalyzer).\n",
);
// Verify module loading without any source checkout in the resolution path.
const probe = spawnSync(
  process.execPath,
  [
    "-e",
    "require('homecheck');require('./rules/lib/index.js');console.log('runtime dependencies complete')",
  ],
  { cwd: packageDir, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
);
if (probe.status !== 0) throw Error(probe.stderr);
fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
const packed = spawn.sync(
  "npm",
  [
    "pack",
    "--offline",
    "--ignore-scripts",
    "--json",
    "--cache",
    path.join(stage, "npm-cache"),
    "--pack-destination",
    path.join(root, "vendor"),
  ],
  { cwd: packageDir, encoding: "utf8" },
);
if (packed.status !== 0) throw Error(packed.stderr || "npm pack failed");
const result = JSON.parse(packed.stdout)[0];
console.log(
  JSON.stringify(
    {
      file: path.join("vendor", result.filename),
      size: result.size,
      integrity: result.integrity,
      versions,
      stagingDirectory: stage,
    },
    null,
    2,
  ),
);
