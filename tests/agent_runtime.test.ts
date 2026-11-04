import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Json } from "../src/models.js";
import {
  DEFAULT_AGENT_MODEL,
  DISABLED_AGENT_TOOLS,
  INTERNAL_VALIDATION_TOOLS,
  MAX_INTERNAL_VALIDATION_ATTEMPTS,
  POLICY_VERSION,
  agentEnvironment,
  resolveAgentModel,
  resolveSelection,
} from "../src/agent_runtime.js";
import { fixture } from "./helpers.js";
const config = (env: NodeJS.ProcessEnv): Json =>
  JSON.parse(String(env.DEVECO_CONFIG_CONTENT));
test("模型固定为 Coding Plan 并拒绝 DevEco 自带提供者", () => {
  assert.equal(resolveAgentModel(undefined), DEFAULT_AGENT_MODEL);
  assert.equal(resolveAgentModel("  zhipu-coding/glm-5 "), DEFAULT_AGENT_MODEL);
  assert.throws(() => resolveAgentModel("deveco/GLM-5.3"), /禁止使用/);
  assert.throws(() => resolveAgentModel("DEVECO/GLM-5.3"), /禁止使用/);
});
test("显式配置优先于环境变量，档位可清空", () => {
  const env = {
    ARKTS_REFACTOR_MODEL: "zhipu-coding/glm-5",
    ARKTS_REFACTOR_VARIANT: "low",
    ARKTS_REVIEW_MODEL: "zhipu-coding/glm-5",
    ARKTS_REVIEW_VARIANT: "high",
  };
  const selection = resolveSelection({ refactor: { variant: "max" } }, env as NodeJS.ProcessEnv);
  assert.deepEqual(selection.refactor, { model: DEFAULT_AGENT_MODEL, variant: "max" });
  assert.deepEqual(selection.review, { model: DEFAULT_AGENT_MODEL, variant: "high" });
  assert.equal(POLICY_VERSION, "2026-11-05-ui-attribution-reactivity");
});
test("档位映射为服务端 reasoning_effort，且不覆盖其他设置", () => {
  const env = agentEnvironment(
    {
      DEVECO_CONFIG_CONTENT: JSON.stringify({
        provider: {
          "zhipu-coding": {
            models: {
              "glm-5": { variants: { high: { disabled: true, other: 1 } } },
            },
          },
        },
      }),
    } as NodeJS.ProcessEnv,
    { model: DEFAULT_AGENT_MODEL, variant: "high" },
  );
  const settings = config(env).provider["zhipu-coding"].models["glm-5"].variants.high;
  assert.equal(settings.reasoningEffort, "high");
  assert.equal(settings.disabled, undefined);
  assert.equal(settings.other, 1);
  assert.equal(env.DEVECO_DISABLE_EXTERNAL_SKILLS, "1");
});
test("未选档位时不写入 reasoning_effort", () => {
  const env = agentEnvironment({} as NodeJS.ProcessEnv, {
    model: DEFAULT_AGENT_MODEL
  });
  assert.equal(config(env).provider, undefined);
  assert.throws(
    () => agentEnvironment({} as NodeJS.ProcessEnv, { model: DEFAULT_AGENT_MODEL, variant: "mid" }),
    /low\/high\/max/,
  );
});
test("禁用提供者、工具与内置技能入口", () => {
  const env = agentEnvironment(
    {
      DEVECO_CONFIG_CONTENT: JSON.stringify({
        disabled_providers: ["other"],
        permission: "allow",
        tools: { read: true },
        agent: { "custom-agent": { permission: { read: "allow" }, tools: { read: true } } },
      }),
    } as NodeJS.ProcessEnv,
    { model: DEFAULT_AGENT_MODEL },
  );
  const data = config(env);
  assert.deepEqual(data.disabled_providers, ["other", "deveco"]);
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
    model: DEFAULT_AGENT_MODEL,
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
