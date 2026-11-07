import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validationHandoff, FINAL_CHECK_DESCRIPTION } from "../src/validation_handoff.js";
import { runAgent } from "../src/agent_runtime.js";
import { readText, writeText } from "../src/utils.js";
import { refactorGate } from "../src/gate.js";
import { fixture, makeProject } from "./helpers.js";

const cwd = path.resolve("demo");
const page = "feature/src/main/ets/My Page.ets";
function event(type: string, messageID: string, fields = {}, sessionID = "session") {
  return JSON.stringify({ type, sessionID, part: { messageID, sessionID, ...fields } });
}
const edit = [
  event("step_start", "edit"),
  event("tool_use", "edit", { tool: "edit", state: { status: "completed", input: { filePath: page } } }),
  event("step_finish", "edit", { reason: "tool-calls" }),
];
const start = event("step_start", "check");
const finish = event("step_finish", "check", { reason: "tool-calls" });
function check(command = 'devecocli check arkts "' + page + '"', exit = 0, description = FINAL_CHECK_DESCRIPTION) {
  const cli = command === "devecocli build" ? { command: "build" } : { command: "check", subcommand: "arkts" };
  return { tool: "bash", state: { status: "completed", input: { command, description },
    metadata: { exit, devecoCliEvents: [{ ...cli, exitCode: exit }] } } };
}
const tool = (data: object) => event("tool_use", "check", data);

test("未标记的成功检查保留编辑状态，后续显式收尾仍需真实成功证据", () => {
  for (const final of [check(), check("devecocli build")]) {
    const observe = validationHandoff(cwd);
    assert([...edit, start, tool(check(undefined, 0, "Run ArkTS check")), finish].map(observe).every(x => x === null));
    assert.deepEqual([start, tool(final), finish].map(observe).filter(Boolean),
      [final.state.input.command === "devecocli build" ? "build" : "check"]);
  }
  const observe = validationHandoff(cwd);
  [...edit, start, tool(check(undefined, 0, "Run ArkTS check")), finish].forEach(observe);
  assert([start, tool(check("devecocli build", 1)), finish,
    start, tool(check("devecocli build")), finish].map(observe).every(x => x === null));
});

test("补充编辑后文件检查必须覆盖所有改动，旧成功检查不能替代新验证", () => {
  const observe = validationHandoff(cwd);
  [...edit, start, tool(check(undefined, 0, "Run ArkTS check")), finish].forEach(observe);
  [edit[0], event("tool_use", "edit", {tool:"edit",state:{status:"completed",input:{filePath:"feature/src/main/ets/Other.ets"}}}), edit[2]].forEach(observe);
  assert([start, tool(check()), finish].map(observe).every(x => x === null));
  assert.equal([start, tool(check("devecocli build")), finish].map(observe).at(-1), "build");
});
test("一次成功验证可伴随已完成的只读查询，写入、未知工具和重复验证仍拒绝收尾", () => {
  const inspect = (name: string, status = "completed") => tool({tool: name, state: {status}});
  for (const name of ["glob", "grep", "read"]) {
    for (const step of [[inspect(name), tool(check())], [tool(check()), inspect(name)]]) {
      assert.equal([...edit, start, ...step, finish].map(validationHandoff(cwd)).at(-1), "check");
    }
  }
  for (const extra of [inspect("glob", "error"), inspect("read", "running"), inspect("edit"),
    inspect("bash"), inspect("unknown"), tool(check())]) {
    for (const step of [[extra, tool(check())], [tool(check()), extra]]) {
      assert.equal([...edit, start, ...step, finish].map(validationHandoff(cwd)).at(-1), null);
    }
  }
});
test("收尾只接受本会话的单独、显式验证，且必须有真实 CLI 成功元数据", () => {
  const observe = () => validationHandoff(cwd);
  for (const lines of [
    [start, tool(check()), finish],
    [...edit, start, tool(check(undefined, 0, "普通检查")), finish],
    [...edit, start, tool(check("devecocli check arkts ../other.ts")), finish],
    [...edit, start, tool(check("devecocli check arkts Unchanged.ets")), finish],
    [...edit, start, tool(check("devecocli check arkts Page.ets && echo PASS")), finish],
    [...edit, start, tool(check()), tool({ tool: "read" }), finish],
    [...edit, start, tool(check()), event("step_finish", "check", { reason: "length" })],
    [...edit, start, tool(check()), event("step_finish", "check", { reason: "tool-calls" }, "other")],
    [...edit, start, tool({ ...check(), state: { ...check().state, metadata: { exit: 0 }, output: "No errors found" } }), finish],
    [...edit, start, tool(check()), JSON.stringify({ type: "error" }), finish],
  ]) assert(lines.map(observe()).every(result => result === null));
  assert.equal([...edit, start, tool(check()), finish].map(observe()).at(-1), "check");
});
test("代码检查失败后继续修复，仅在新编辑后的独立复验成功时收尾", () => {
  const observe = validationHandoff(cwd);
  assert([...edit, start, tool(check(undefined, 1)), finish].map(observe).every(result => result === null));
  const retry = [start, tool(check("devecocli build")), finish];
  assert(retry.map(observe).every(result => result === null));
  assert.deepEqual([...edit, ...retry].map(observe).filter(Boolean), ["build"]);
});
test("Agent 入口消费 stdout 的完整 JSON 行，成功交回且保留其他退出原因", async t => {
  const root = fixture(t), prompt = path.join(root, "prompt.md");
  writeText(prompt, "test");
  const lines = [...edit, start, tool(check()), finish].join("\r\n") + "\r\n";
  // Stand in for 'deveco run': node resolves the script named 'run' in cwd.
  const firstHalf = lines.slice(0, -12), secondHalf = lines.slice(-12);
  for (const [role, stream, expected] of [
    ["refactor", "stdout", 0], ["repair", "stdout", 0], ["refactor", "stderr", 17], ["review", "stdout", 17],
  ] as const) {
    writeText(path.join(root, "run"), [
      "if (process.argv.some(a => a.includes('首次内部验证就使用 description=ARKTS_FINAL_CHECK')) !== " + (role !== "review") + ") process.exit(91);",
      "process." + stream + ".write(" + JSON.stringify(firstHalf) + ");",
      "setTimeout(() => process." + stream + ".write(" + JSON.stringify(secondHalf) + "), 10);",
      "setTimeout(() => process.exit(17), " + (expected === 0 ? 2000 : 50) + ");",
    ].join("\n"));
    assert.equal(await runAgent(process.execPath, root, root, prompt, { role }), expected);
  }
});
test("提前收尾仍执行生产改动同步，无实际改动仍失败", async t => {
  const root = fixture(t), project = makeProject(root);
  writeText(path.join(project.taskDir, "refactor-prompt.md"), "test");
  const file = path.relative(project.source, project.target);
  const events = [edit[0], event("tool_use", "edit", {
    tool: "write", state: { status: "completed", input: { filePath: file } },
  }), edit[2], start, tool(check("devecocli build")), finish];
  for (const change of [false, true]) {
    const content = "export class Page { work() { return 2; } }";
    writeText(path.join(project.source, "run"), [
      "(async () => {",
      change ? "const fs = await import('node:fs'); fs.writeFileSync(" + JSON.stringify(file) + "," + JSON.stringify(content) + ");" : "",
      "process.stdout.write(" + JSON.stringify(events.join("\n") + "\n") + ");",
      "setTimeout(() => process.exit(17), 2000);",
      "})();",
    ].join("\n"));
    assert.equal(await refactorGate(project.taskDir, project.source, process.execPath), change ? 0 : 5);
    if (change) assert.equal(readText(project.target).trim(), content);
  }
});
