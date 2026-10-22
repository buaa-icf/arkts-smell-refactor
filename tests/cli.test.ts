import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { readPastedJson } from "../src/automatic.js";
import { runCommand } from "../src/process.js";
import { fixture, goodConfig } from "./helpers.js";
import { readJson, writeJson, writeText } from "../src/utils.js";
const cli = path.resolve("dist/cli.js");
test("交互粘贴完整对象自动结束，无需 EOF", async () => {
  const input = new PassThrough(),
    pending = readPastedJson(input);
  input.write('{\n"filePath":"demo/Page.ets",\n"messages":[]\n}\n');
  const data = await pending;
  assert.equal(data.length, 1);
  input.end();
});
test("不完整 JSON 在 EOF 时明确报错", async () => {
  const input = new PassThrough(),
    pending = readPastedJson(input);
  input.end("{");
  await assert.rejects(pending);
});
test("CLI 帮助不要求 Python 或全局命令安装", async (t) => {
  const result = await runCommand([process.execPath, cli, "--help"], {
    cwd: fixture(t),
  });
  assert.equal(result.code, 0);
  assert(result.output.includes("TypeScript / Node.js"));
});
test("CLI 配置保存到指定用户目录，不污染真实用户设置", async (t) => {
  const root = fixture(t),
    env = {
      ...process.env,
      APPDATA: path.join(root, "用户配置"),
      XDG_CONFIG_HOME: path.join(root, "用户配置"),
    },
    result = await runCommand(
      [process.execPath, cli, "configure", "--workspace", root],
      { cwd: root, env },
    );
  assert.equal(result.code, 0);
  assert.equal(
    readJson(path.join(root, "用户配置/arkts-smell-refactor/config.json"))
      .workspace,
    root,
  );
});
test("CLI prepare 和 run --dry-run 完整衔接，输出兼容任务 JSON", async (t) => {
  const root = fixture(t),
    target = path.join(root, "demo/entry/src/main/ets/Page.ets"),
    input = path.join(root, "input.json"),
    output = path.join(root, "prepared");
  writeText(target, "export class Page {\n work() { return 1; }\n}");
  writeJson(input, [
    {
      sourceProject: "demo",
      filePath: "demo/entry/src/main/ets/Page.ets",
      messages: [
        {
          line: 2,
          rule: "@extrulesproject/long-method-check",
          message: "Method 'work' is too long",
        },
      ],
    },
  ]);
  const prepared = await runCommand(
    [
      process.execPath,
      cli,
      "prepare",
      "--dataset",
      input,
      "--workspace",
      root,
      "--output",
      output,
    ],
    { cwd: root },
  );
  assert.equal(prepared.code, 0, prepared.output);
  const dir = readJson(path.join(output, "index.json"))[0].taskDir;
  assert(readJson(path.join(dir, "task.json")).target.range);
  const config = path.join(root, "config.json");
  writeJson(config, goodConfig());
  const dry = await runCommand(
    [
      process.execPath,
      cli,
      "run",
      "--task-dir",
      dir,
      "--config",
      config,
      "--dry-run",
    ],
    { cwd: root },
  );
  assert.equal(dry.code, 0, dry.output);
  assert.equal(readJson(path.join(dir, "result.json")).verdict, "DRY_RUN");
});
