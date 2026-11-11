import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import type { Json } from "../src/models.js";
import {
  DISABLED_AGENT_TOOLS,
  INTERNAL_VALIDATION_TOOLS,
  MAX_INTERNAL_VALIDATION_ATTEMPTS,
  POLICY_VERSION,
  agentEnvironment,
  resolveAgentModel,
  resolveSelection,
  runAgent,
} from "../src/agent_runtime.js";
import { fixture } from "./helpers.js";
import { readJson, writeText } from "../src/utils.js";
const config = (env: NodeJS.ProcessEnv): Json =>
  JSON.parse(String(env.DEVECO_CONFIG_CONTENT));
test("默认不指定模型，允许本机 DevEco 自带提供者与其他显式模型", () => {
  assert.equal(resolveAgentModel(undefined), undefined);
  assert.equal(resolveAgentModel("  "), undefined);
  assert.equal(resolveAgentModel("  provider/model "), "provider/model");
  assert.equal(resolveAgentModel("deveco/GLM-5.3"), "deveco/GLM-5.3");
  assert.equal(resolveSelection({}, {}).refactor!.model, undefined);
  assert.equal(resolveSelection({}, {}).review!.model, undefined);
});
test("显式配置优先于环境变量，档位可清空", () => {
  const env = {
    ARKTS_REFACTOR_MODEL: "provider/model",
    ARKTS_REFACTOR_VARIANT: "low",
    ARKTS_REVIEW_MODEL: "provider/model",
    ARKTS_REVIEW_VARIANT: "high",
  };
  const selection = resolveSelection({ refactor: { variant: "max" } }, env as NodeJS.ProcessEnv);
  assert.deepEqual(selection.refactor, { model: "provider/model", variant: "max" });
  assert.deepEqual(selection.review, { model: "provider/model", variant: "high" });
  assert.equal(resolveSelection({ refactor: { model: "deveco/custom" } }, env).refactor!.model, "deveco/custom");
  assert.equal(POLICY_VERSION, "2026-11-06-cross-host-clone-evidence");
});
test("沿用本机模型、provider、档位设置，不注入厂商专属参数", () => {
  const original = {
    model: "deveco/local-model",
    disabled_providers: ["other"],
    provider: { custom: { models: { model: { variants: { balanced: { reasoningEffort: "medium", other: 1 } } } } } },
  };
  const env = agentEnvironment(
    {
      DEVECO_CONFIG_CONTENT: JSON.stringify(original),
    } as NodeJS.ProcessEnv,
    { variant: "balanced" },
  );
  assert.equal(config(env).model, original.model);
  assert.deepEqual(config(env).provider, original.provider);
  assert.deepEqual(config(env).disabled_providers, original.disabled_providers);
  assert.equal(env.DEVECO_DISABLE_EXTERNAL_SKILLS, "1");
});
test("未选档位时不写入 reasoning_effort", () => {
  const env = agentEnvironment({} as NodeJS.ProcessEnv);
  assert.equal(config(env).provider, undefined);
  assert.equal(config(env).disabled_providers, undefined);
});
test("保留本机提供者配置，仅约束任务工具与内置技能入口", () => {
  const env = agentEnvironment(
    {
      DEVECO_CONFIG_CONTENT: JSON.stringify({
        disabled_providers: ["other"],
        permission: "allow",
        tools: { read: true },
        agent: { "custom-agent": { permission: { read: "allow" }, tools: { read: true } } },
      }),
    } as NodeJS.ProcessEnv,
    {},
  );
  const data = config(env);
  assert.deepEqual(data.disabled_providers, ["other"]);
  assert.equal(data.permission["*"], "allow");
  assert.equal(data.tools.read, true);
  for (const tool of DISABLED_AGENT_TOOLS) {
    assert.equal(data.permission[tool], "deny");
    assert.equal(data.tools[tool], false);
  }
  const agent = data.agent["custom-agent"];
  assert.equal(agent.permission.read, "allow");
  assert.equal(agent.permission.skill, "deny");
  assert.equal(agent.tools.skill, false);
  assert(DISABLED_AGENT_TOOLS.includes("skill"));
  assert(!DISABLED_AGENT_TOOLS.includes("build_project"));
});

test("重构与返修恢复内部构建/ArkTS 检查，评审继续禁止", () => {
  const original = { DEVECO_CONFIG_CONTENT: JSON.stringify({
    permission: { build_project: "deny", arkts_check: "deny" },
    tools: { build_project: false, arkts_check: false, read: true },
    agent: { custom: { permission: { build_project: "deny" }, tools: { build_project: false } } },
  }) } as NodeJS.ProcessEnv;
  for (const role of ["refactor", "repair", "review", "review-format"]) {
    const allowed = role === "refactor" || role === "repair";
    const data = config(agentEnvironment(original, { role }));
    for (const tool of INTERNAL_VALIDATION_TOOLS) {
      assert.equal(data.tools[tool], allowed, `${role}: ${tool}`);
      assert.equal(data.permission[tool], allowed ? "allow" : "deny");
      assert.equal(data.agent.custom.tools[tool], allowed);
      assert.equal(data.agent.custom.permission[tool], allowed ? "allow" : "deny");
    }
    assert.equal(data.tools.read, true);
    assert.equal(data.tools.skill, false);
    assert.equal(data.tools.websearch, false);
  }
  assert.equal(MAX_INTERNAL_VALIDATION_ATTEMPTS, 2);
  const format = config(agentEnvironment(original, { role: "refactor", formatOnly: true }));
  assert.equal(format.tools.build_project, false);
  assert.deepEqual(format.agent["arkts-review-format"].tools, { "*": false });
});
test("隔离副本设置 Git 上界，仅格式修复使用全禁工具的独立 agent", (t) => {
  const root = fixture(t),
    cwd = path.join(root, "app/work/task");
  const env = agentEnvironment({ GIT_DIR: path.join(root, ".git") } as NodeJS.ProcessEnv, {
    cwd,
    formatOnly: true,
  });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_CEILING_DIRECTORIES, path.dirname(path.resolve(cwd)));
  const data = config(env);
  assert.deepEqual(Object.keys(data.agent), ["arkts-review-format"]);
  assert.deepEqual(data.agent["arkts-review-format"].tools, { "*": false });
  assert.equal(data.agent["arkts-review-format"].permission["*"], "deny");
});

test("重构、返修、评审与格式修复实际命令默认不传模型，显式覆盖仍生效", async (t) => {
  const root = fixture(t), capture = path.join(root, "capture.json");
  const script = path.join(root, "fake-deveco.cjs"), launcher = path.join(root, process.platform === "win32" ? "deveco.cmd" : "deveco");
  writeText(script, `require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),config:JSON.parse(process.env.DEVECO_CONFIG_CONTENT)}));`);
  writeText(launcher, process.platform === "win32" ? `@"${process.execPath}" "${script}" %*` : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"`);
  if (process.platform !== "win32") fs.chmodSync(launcher, 0o755);
  const prompt = path.join(root, "prompt.md");
  writeText(prompt, "task");
  const old = process.env.DEVECO_CONFIG_CONTENT;
  try {
    process.env.DEVECO_CONFIG_CONTENT = JSON.stringify({ model: "deveco/my-local-model", provider: { local: { setting: true } } });
    for (const role of ["refactor", "repair", "review", "review-format"]) {
      assert.equal(await runAgent(launcher, root, root, prompt, { role, formatOnly: role === "review-format" }), 0);
      const result = readJson(capture);
      assert(!result.args.includes("-m"));
      assert(!result.args.includes("--variant"));
      assert.equal(result.config.model, "deveco/my-local-model");
      assert.deepEqual(result.config.provider, { local: { setting: true } });
      assert.equal(result.config.disabled_providers, undefined);
      const policy = readJson(path.join(root, `${role}-execution-policy.json`));
      assert.equal(policy.requestedModel, null);
      assert.equal(policy.modelSource, "deveco-local-config");
    }
    assert.equal(await runAgent(launcher, root, root, prompt, { role: "refactor", model: "deveco/explicit", variant: "balanced" }), 0);
    const selected = readJson(capture).args;
    assert.equal(selected[selected.indexOf("-m") + 1], "deveco/explicit");
    assert.equal(selected[selected.indexOf("--variant") + 1], "balanced");
  } finally {
    if (old === undefined) delete process.env.DEVECO_CONFIG_CONTENT; else process.env.DEVECO_CONFIG_CONTENT = old;
  }
});
