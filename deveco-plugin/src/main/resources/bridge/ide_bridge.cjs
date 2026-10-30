"use strict";

// Minimal bootstrap: resolve the user's compiled TypeScript backend before loading it.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
let request,
  bytes = 0;
const chunks = [];
function failure(code, message) {
  process.stdout.write(
    JSON.stringify({
      protocolVersion: 1,
      type: "response",
      requestId: request?.requestId ?? null,
      ok: false,
      error: { code, message, details: {} },
    }) + "\n",
  );
  process.exitCode = 2;
}
process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes <= 8 * 1024 * 1024) chunks.push(chunk);
});
process.stdin.on("end", async () => {
  try {
    if (bytes > 8 * 1024 * 1024)
      return failure("INVALID_REQUEST", "请求超过 8 MiB");
    request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!request || typeof request !== "object" || Array.isArray(request))
      return failure("INVALID_REQUEST", "请求必须为 JSON 对象");
    if (request.protocolVersion !== 1)
      return failure("UNSUPPORTED_PROTOCOL", "仅支持协议版本 1");
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 20 || (major === 20 && minor < 19))
      return failure("TOOL_UNAVAILABLE", "需要 Node.js >= 20.19");
    const backend = request.config?.backend;
    if (typeof backend !== "string" || !backend)
      return failure(
        "TOOL_UNAVAILABLE",
        "请在插件设置中配置 TypeScript 后端目录",
      );
    const entry = path.resolve(backend, "dist/ide_bridge.js");
    if (!fs.existsSync(entry))
      return failure(
        "TOOL_UNAVAILABLE",
        "找不到 dist/ide_bridge.js，请在后端目录执行 npm install 和 npm run build",
      );
    const worker = await import(pathToFileURL(entry).href);
    const cancellation = await import(
      pathToFileURL(path.resolve(backend, "dist/process.js")).href
    );
    cancellation.installCancellationHandlers();
    process.exitCode = await worker.serveRequest(request, {
      scanner: path.join(__dirname, "homecheck_scan.cjs"),
    });
  } catch (error) {
    failure(
      error instanceof SyntaxError ? "INVALID_REQUEST" : "TOOL_UNAVAILABLE",
      error.message,
    );
  }
});
