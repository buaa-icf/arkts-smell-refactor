import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const repository = path.resolve(".");
const packager = path.join(repository, "scripts/package-skill.mjs");
function node(
  script: string,
  args: string[],
  cwd: string,
  env = process.env,
  timeout = 30_000,
) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}
function write(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

test(
  "standalone Skill package runs offline outside its repository and selects two projects at invocation",
  { timeout: 120_000 },
  (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "arkts-skill-package-"));
    t.after(() => {
      const actual = fs.realpathSync.native(base);
      assert.equal(path.dirname(actual), fs.realpathSync.native(os.tmpdir()));
      fs.rmSync(actual, { recursive: true, force: true, maxRetries: 3 });
    });
    assert.equal(base.startsWith(repository + path.sep), false);
    const output = path.join(base, "构建 & Output/arkts-smell-refactor");
    const packaged = node(
      packager,
      ["--output", output],
      base,
      process.env,
      90_000,
    );
    assert.equal(packaged.status, 0, packaged.stderr + packaged.stdout);
    const summary = JSON.parse(packaged.stdout);
    assert.equal(summary.directory, output);
    assert.ok(fs.statSync(summary.archive).size > 1_000_000);
    assert.ok(fs.statSync(summary.zipArchive).size > 1_000_000);
    assert.match(summary.zipSha256, /^[a-f0-9]{64}$/);
    assert.match(summary.sourceDigest, /^[a-f0-9]{64}$/);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(output, "package-manifest.json"), "utf8"),
    );
    assert.equal(manifest.sourceDigest, summary.sourceDigest);
    assert.ok(
      manifest.dependencies.some(
        (item: { name: string }) =>
          item.name === "@arkts-refactor/homecheck-runtime",
      ),
    );
    assert.ok(
      manifest.dependencies.some(
        (item: { name: string }) => item.name === "path-key",
      ),
    );
    for (const name of ["typescript", "tsx", "prettier", "@types/node"])
      assert.equal(
        fs.existsSync(path.join(output, "runtime/node_modules", name)),
        false,
        `${name} is not a runtime dependency`,
      );
    for (const name of Object.keys(manifest.files)) {
      assert.equal(
        name.split("/").some((part) => [".git", ".bin"].includes(part)),
        false,
      );
      const bytes = fs.readFileSync(path.join(output, name));
      assert.equal(
        bytes.includes(Buffer.from(repository)),
        false,
        `repository path leaked into ${name}`,
      );
      assert.equal(
        bytes.includes(Buffer.from(repository.replaceAll("\\", "/"))),
        false,
        `repository path leaked into ${name}`,
      );
    }
    const archive = spawnSync("tar", ["-tzf", summary.archive], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(archive.status, 0, archive.stderr);
    assert.ok(
      archive.stdout.includes(
        "arkts-smell-refactor/runtime/dist/portable_skill.js",
      ),
    );
    assert.ok(
      archive.stdout.includes("arkts-smell-refactor/scripts/install.mjs"),
    );

    const unpacked = path.join(base, "ZIP 解压目录");
    const extraction =
      process.platform === "win32"
        ? spawnSync(
            path.join(
              process.env.SystemRoot || "C:\\Windows",
              "System32/WindowsPowerShell/v1.0/powershell.exe",
            ),
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:ARKTS_TEST_ARCHIVE, $env:ARKTS_TEST_DESTINATION)",
            ],
            {
              env: {
                ...process.env,
                ARKTS_TEST_ARCHIVE: summary.zipArchive,
                ARKTS_TEST_DESTINATION: unpacked,
              },
              encoding: "utf8",
              windowsHide: true,
            },
          )
        : spawnSync("unzip", ["-q", summary.zipArchive, "-d", unpacked], {
            encoding: "utf8",
            windowsHide: true,
          });
    assert.ifError(extraction.error);
    assert.equal(extraction.status, 0, extraction.stderr);
    const delivered = path.join(base, "用户收到的独立目录");
    fs.renameSync(path.join(unpacked, "arkts-smell-refactor"), delivered);
    for (const name of [
      "install.bat",
      "INSTALL.txt",
      "scripts/install-windows.mjs",
    ])
      assert.ok(
        fs.statSync(path.join(delivered, name)).isFile(),
        `${name} must ship in the ZIP`,
      );
    const batch = fs.readFileSync(path.join(delivered, "install.bat"), "utf8");
    assert.ok(batch.includes("\r\n"));
    assert.doesNotMatch(
      batch,
      /(?<!\r)\n|\r(?!\n)/,
      "Windows batch files must use CRLF even when built on another platform",
    );
    assert.equal(
      fs.readFileSync(path.join(delivered, "scripts/run.mjs"), "utf8"),
      fs.readFileSync(path.join(output, "scripts/run.mjs"), "utf8"),
    );
    const userConfig = path.join(base, "用户 配置");
    const emptyPath = path.join(base, "empty-bin");
    fs.mkdirSync(emptyPath);
    const env = {
      ...process.env,
      PATH: emptyPath,
      NODE_PATH: "",
      NODE_OPTIONS: "",
      XDG_CONFIG_HOME: userConfig,
      XDG_DATA_HOME: path.join(base, "user-data"),
      LOCALAPPDATA: path.join(base, "local-data"),
      DEVECO_HOME: path.join(base, "missing-studio"),
      DEVECO_SDK_HOME: "",
    };
    const installed = node(
      path.join(delivered, "scripts/install.mjs"),
      [],
      base,
      env,
    );
    assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    const skill = JSON.parse(installed.stdout).skillDirectory;
    const launcher = path.join(skill, "scripts/run.mjs");
    const installation = JSON.parse(
      fs.readFileSync(path.join(skill, "installation.json"), "utf8"),
    );
    assert.deepEqual(installation, {
      schemaVersion: 2,
      runtime: "runtime",
      settingsFile: "settings.json",
    });
    fs.renameSync(
      delivered,
      path.join(base, "delivery-no-longer-at-original-path"),
    );
    const runs = path.join(base, "shared-runs");
    for (const name of ["示例一 Project", "Second Project"]) {
      const project = path.join(base, name);
      const target = "entry/src/main/ets/Page.ets";
      write(
        path.join(project, target),
        "export class Page { update() { return 1; } }\n",
      );
      write(
        path.join(project, "build-profile.json5"),
        "{modules:[{name:'entry',srcPath:'entry'}]}",
      );
      write(path.join(project, "hvigor/hvigor-config.json5"), "{}");
      write(
        path.join(project, "report.json"),
        JSON.stringify({
          filePath: target,
          messages: [
            {
              line: 1,
              rule: "@extrulesproject/long-method-check",
              message: "Method 'update' is too long",
            },
          ],
        }),
      );
      const doctor = node(launcher, ["doctor", "--runs", runs], project, env);
      assert.equal(doctor.status, 3, doctor.stderr + doctor.stdout);
      const health = JSON.parse(doctor.stdout);
      assert.equal(
        health.projectRoot.toLowerCase(),
        fs.realpathSync.native(project).toLowerCase(),
      );
      assert.equal(health.result.verdict, "BLOCKED");
      assert.ok(
        health.result.missing.some(
          (item: { name: string }) => item.name === "deveco",
        ),
      );
      assert.ok(
        health.result.environment.tools.find(
          (item: { name: string }) => item.name === "HomeCheck",
        ).available,
      );
      const imported = node(
        launcher,
        ["import", "--file", "report.json", "--runs", runs],
        project,
        env,
      );
      assert.equal(imported.status, 0, imported.stderr + imported.stdout);
      const evidence = JSON.parse(imported.stdout);
      assert.equal(
        evidence.projectRoot.toLowerCase(),
        fs.realpathSync.native(project).toLowerCase(),
      );
      assert.equal(evidence.result.issues.length, 1);
      assert.ok(fs.existsSync(evidence.responseFile));
      const history = node(
        launcher,
        ["history", "--runs", runs],
        path.join(project, "entry"),
        env,
      );
      assert.equal(history.status, 0, history.stderr + history.stdout);
      assert.equal(
        JSON.parse(history.stdout).projectRoot.toLowerCase(),
        fs.realpathSync.native(project).toLowerCase(),
      );
      assert.deepEqual(JSON.parse(history.stdout).result.records, []);
      assert.equal(fs.existsSync(path.join(project, ".deveco")), false);
    }
  },
);

test("Skill packager rejects unsafe output and malformed options before building", () => {
  for (const args of [
    ["--output", repository],
    ["--output", path.join(repository, "src/release")],
    ["--unknown"],
    ["--output"],
  ]) {
    const result = node(packager, args, repository);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /输出目录|参数无效/);
  }
});

test("Skill packager preserves an existing ZIP unless force is explicit", (t) => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "arkts-skill-existing-zip-"),
  );
  t.after(() => {
    const actual = fs.realpathSync.native(base);
    assert.equal(path.dirname(actual), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  const output = path.join(base, "arkts-smell-refactor");
  write(output + ".zip", "existing delivery");
  const result = node(packager, ["--output", output], base);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /制品已存在/);
  assert.equal(fs.readFileSync(output + ".zip", "utf8"), "existing delivery");
  assert.equal(fs.existsSync(output), false);
});
