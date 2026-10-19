"use strict";
// Uses the exact worker and wire format shipped in the plugin. No Agent is started.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2)
    options[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  if (!options.config || !options.project || !options.file)
    throw Error(
      "Usage: node tools/smoke_detect.cjs --config <settings.json> --project <root> --file <file>",
    );
  const config = JSON.parse(
    fs.readFileSync(path.resolve(options.config), "utf8"),
  );
  const root = path.resolve(options.project),
    target = path.resolve(options.file);
  const { snapshot, same } = await import(
    require("node:url").pathToFileURL(
      path.resolve(config.backend, "dist/ide/common.js"),
    ).href
  );
  const before = snapshot(root),
    request = {
      protocolVersion: 1,
      type: "request",
      requestId: crypto.randomUUID(),
      method: "scan.start",
      projectRoot: root,
      config,
      params: { scopePath: target },
    };
  const child = spawnSync(
    config.node || process.execPath,
    [path.resolve(__dirname, "../src/main/resources/bridge/ide_bridge.cjs")],
    {
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: 1230000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (!same(before, snapshot(root)))
    throw Error("Original project changed during detection");
  const output = path.resolve(
    __dirname,
    "../build/smoke-detection",
    `worker-${request.requestId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, child.stdout || "", "utf8");
  const messages = (child.stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  const response = messages.findLast((m) => m.type === "response");
  if (
    !response ||
    response.requestId !== request.requestId ||
    !response.ok ||
    child.status !== 0
  )
    throw Error(
      JSON.stringify(
        response?.error || {
          message: child.error?.message || child.stderr || "Missing response",
        },
      ),
    );
  if (
    response.result.fileCount !== 1 ||
    response.result.scannedFiles[0] !== fs.realpathSync(target)
  )
    throw Error("Scan scope mismatch");
  console.log(
    JSON.stringify(
      {
        issues: response.result.issues.length,
        runDirectory: response.result.runDirectory,
        wireLog: output,
        originalUnchanged: true,
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
