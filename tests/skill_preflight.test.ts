import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture } from "./helpers.js";
import { writeJson, writeText } from "../src/utils.js";
import {
  hasReviewCredentials,
  inspectSkillEnvironment,
} from "../src/skill_preflight.js";
import { loadConfig } from "../src/client/config.js";

test("listing a configured review model without credentials does not satisfy preflight", (t) => {
  const base = fixture(t),
    config = path.join(base, ".config/deveco/deveco.jsonc");
  writeText(
    config,
    '{ // model registration is not authentication\n "provider": {"zhipu-coding": {"models": {"glm-5": {}}}} }',
  );
  assert.equal(hasReviewCredentials("zhipu-coding", {}, base), false);
});

test("credential probe recognizes matching provider API or OAuth records without returning their contents", (t) => {
  const base = fixture(t),
    auth = path.join(base, "data/deveco/auth.json"),
    env = { XDG_DATA_HOME: path.join(base, "data") };
  writeJson(auth, {
    "zhipu-coding": { type: "api", key: "test-secret-not-a-real-key" },
  });
  assert.equal(hasReviewCredentials("zhipu-coding", env, base), true);
  assert.equal(hasReviewCredentials("openai", env, base), false);
  writeJson(auth, {
    openai: { type: "oauth", refresh: "test-refresh", access: "" },
  });
  assert.equal(hasReviewCredentials("openai", env, base), true);
  writeJson(auth, { openai: { type: "api", key: "" } });
  assert.equal(hasReviewCredentials("openai", env, base), false);
});

test("provider key placeholders require their environment variables to exist and respect config overrides", (t) => {
  const base = fixture(t),
    config = path.join(base, ".config/deveco/deveco.jsonc");
  writeJson(config, {
    provider: { custom: { options: { apiKey: "{env:TEST_REVIEW_KEY}" } } },
  });
  assert.equal(hasReviewCredentials("custom", {}, base), false);
  assert.equal(
    hasReviewCredentials("custom", { TEST_REVIEW_KEY: "test-key" }, base),
    true,
  );
  assert.equal(
    hasReviewCredentials(
      "custom",
      {
        TEST_REVIEW_KEY: "test-key",
        DEVECO_CONFIG_CONTENT:
          '{"provider":{"custom":{"options":{"apiKey":""}}}}',
      },
      base,
    ),
    false,
  );
  writeText(config, "malformed private config");
  assert.equal(hasReviewCredentials("custom", {}, base), false);
});

test("relative file credentials resolve beside the effective custom config, including user-home references", (t) => {
  const base = fixture(t),
    custom = path.join(base, "custom/deveco.jsonc");
  writeJson(custom, {
    provider: { custom: { options: { apiKey: "{file:secret.txt}" } } },
  });
  writeText(
    path.join(base, ".config/deveco/secret.txt"),
    "wrong-directory-key",
  );
  assert.equal(
    hasReviewCredentials("custom", { DEVECO_CONFIG: custom }, base),
    false,
  );
  writeText(path.join(base, "custom/secret.txt"), "test-file-key");
  assert.equal(
    hasReviewCredentials("custom", { DEVECO_CONFIG: custom }, base),
    true,
  );
  writeJson(custom, {
    provider: { custom: { options: { apiKey: "{file:~/home-key.txt}" } } },
  });
  writeText(path.join(base, "home-key.txt"), "test-home-key");
  assert.equal(
    hasReviewCredentials("custom", { DEVECO_CONFIG: custom }, base),
    true,
  );
});

test("preflight names missing tools and rejects reviewer config without leaking JSON credential text", async (t) => {
  const base = fixture(t),
    original = process.env.DEVECO_CONFIG_CONTENT,
    originalPath = process.env.PATH;
  t.after(() => {
    if (original === undefined) delete process.env.DEVECO_CONFIG_CONTENT;
    else process.env.DEVECO_CONFIG_CONTENT = original;
  });
  process.env.DEVECO_CONFIG_CONTENT =
    '{"private-api-key":"test-secret-never-print", invalid }';
  const config = await loadConfig({
    projectRoot: base,
    backend: base,
    runs: path.resolve(base, "../absent-preflight-runs"),
    studio: path.join(base, "missing-sdk"),
    deveco: path.join(base, "missing-cli"),
    hvigor: path.join(base, "missing-hvigor"),
    ohpm: path.join(base, "missing-ohpm"),
    linter: path.join(base, "missing-linter"),
    node: process.execPath,
  });
  const result = await inspectSkillEnvironment(config);
  assert.equal(result.stop, true);
  assert.ok(result.missing.some((item) => item.name === "ArkTS SDK"));
  assert.ok(result.missing.some((item) => item.name === "审查模型配置"));
  assert.ok(!JSON.stringify(result).includes("test-secret-never-print"));
  assert.equal(process.env.PATH, originalPath);
});
