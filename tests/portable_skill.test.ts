import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fixture } from "./helpers.js";
import { writeJson, writeText } from "../src/utils.js";
import {
  runPortableSkill,
  findProject,
  discoverStudio,
} from "../src/portable_skill.js";
import type { PluginConfig } from "../src/client/config.js";
import type { PreflightResult } from "../src/skill_preflight.js";

const pass: PreflightResult = { verdict: "PASS", stop: false, missing: [] };
function project(base: string, name: string) {
  const root = path.join(base, name);
  writeJson(path.join(root, "build-profile.json5"), {});
  writeJson(path.join(root, "hvigor/hvigor-config.json5"), {});
  writeText(
    path.join(root, "entry/src/main/ets/Page.ets"),
    "export class Page {}\n",
  );
  return fs.realpathSync(root);
}

test("portable invocation discovers each current project and strips legacy project/backend bindings", async (t) => {
  const base = fixture(t),
    first = project(base, "项目 A"),
    second = project(base, "Project B");
  const settings = path.join(base, "legacy.json"),
    seen: PluginConfig[] = [];
  writeJson(settings, {
    projectRoot: "D:/old/BookRead",
    backend: "D:/old/repository",
    runs: "D:/old/runs",
    studio: "D:/Tools/Studio",
    node: "old-node",
  });
  for (const root of [first, second]) {
    const output: string[] = [];
    assert.equal(
      await runPortableSkill(["doctor"], {
        runtimeRoot: base,
        directory: path.join(root, "entry/src/main/ets"),
        settingsFile: settings,
        stdout: (line) => output.push(line),
        inspect: async (config) => {
          seen.push(config);
          return pass;
        },
      }),
      0,
    );
    assert.equal(JSON.parse(output[0]).projectRoot, root);
  }
  assert.deepEqual(
    seen.map((c) => c.projectRoot),
    [first, second],
  );
  assert.equal(seen[0].backend, base);
  assert.equal(seen[0].node, process.execPath);
  assert.equal(seen[0].studio, "D:/Tools/Studio");
  assert.notEqual(seen[0].runs, seen[1].runs);
  assert.equal(findProject(base), undefined);
});

test("missing dependency stops scan before bridge execution and names the required configuration", async (t) => {
  const base = fixture(t),
    root = project(base, "Project");
  const output: string[] = [];
  let backendCalls = 0;
  const code = await runPortableSkill(["scan", "--scope", "."], {
    runtimeRoot: base,
    directory: root,
    stdout: (line) => output.push(line),
    inspect: async () => ({
      verdict: "BLOCKED",
      stop: true,
      missing: [
        {
          name: "ArkTS SDK",
          reason: "not installed",
          action: "设置 DEVECO_HOME",
        },
      ],
    }),
    backend: () => {
      backendCalls++;
      throw new Error("must not start");
    },
  });
  assert.equal(code, 3);
  assert.equal(backendCalls, 0);
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).result.missing[0].name, "ArkTS SDK");
  assert.equal(JSON.parse(output[0]).result.stop, true);
});

test("history remains available without model/SDK preflight, using the explicit project", async (t) => {
  const base = fixture(t),
    root = project(base, "Project"),
    output: string[] = [];
  let inspections = 0;
  const code = await runPortableSkill(
    ["history", "--project", root, "--runs", path.join(base, "runs")],
    {
      runtimeRoot: base,
      directory: base,
      stdout: (line) => output.push(line),
      inspect: async () => {
        inspections++;
        throw new Error("unavailable SDK");
      },
      backend: (config) => ({
        request: async () => {
          assert.equal(config.projectRoot, root);
          return { records: [] } as never;
        },
      }),
    },
  );
  assert.equal(code, 0);
  assert.equal(inspections, 0);
  assert.deepEqual(JSON.parse(output[0]).result, { records: [] });
});

test("doctor blocks outside a Harmony project and emits actionable configuration errors", async (t) => {
  const base = fixture(t);
  for (const args of [
    ["doctor"],
    ["doctor", "--config", "missing.json"],
    ["doctor", "--backend", "other"],
  ]) {
    const output: string[] = [];
    const code = await runPortableSkill(args, {
      runtimeRoot: base,
      directory: base,
      inspect: async () => pass,
      stdout: (line) => output.push(line),
    });
    assert.equal(code, 3);
    const result = JSON.parse(output[0]).result;
    assert.equal(result.stop, true);
    assert.ok(result.missing[0].action);
  }
});

test("SDK location is inferred from installed build tools or DEVECO_SDK_HOME without binding a project", (t) => {
  const base = fixture(t),
    installation = path.join(base, "command-line-tools");
  fs.mkdirSync(path.join(installation, "sdk/default/openharmony/ets"), {
    recursive: true,
  });
  const hvigor = path.join(installation, "bin/hvigorw.cmd");
  writeText(hvigor, "fixture");
  assert.equal(discoverStudio({ hvigor }, {}), installation);
  assert.equal(
    discoverStudio({}, { DEVECO_SDK_HOME: path.join(installation, "sdk") }),
    installation,
  );
  assert.equal(
    discoverStudio({ studio: "explicit-missing" }, {}),
    "explicit-missing",
  );
});
