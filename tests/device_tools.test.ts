import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.js";
import { writeText } from "../src/utils.js";
import { deviceToolEnvironment, resolveHdc } from "../src/device_tools.js";
import { devecoEnvironment } from "../src/gate.js";

function tool(directory: string, name: string): string {
  const file = path.join(directory, name + (process.platform === "win32" ? ".cmd" : ""));
  writeText(file, process.platform === "win32" ? "@exit /b 0" : "#!/bin/sh\nexit 0");
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  return file;
}
const emptyEnv = { PATH: "", PATHEXT: ".EXE;.CMD;.BAT" };
const equalPath = (actual: string | null, expected: string) => {
  assert.ok(actual);
  assert.equal(path.relative(actual, expected), "");
};

test("Studio HDC is found beside the SDK without PATH or inherited tool configuration", t => {
  const studio = path.join(fixture(t), "DevEco Studio");
  const hvigor = tool(path.join(studio, "tools/hvigor/bin"), "hvigorw");
  const hdc = tool(path.join(studio, "sdk/default/openharmony/toolchains"), "hdc");
  equalPath(resolveHdc({ hvigor, env: emptyEnv }), hdc);
  assert.equal(fs.existsSync(path.resolve(hvigor, "../../sdk/default/openharmony/toolchains")), false);
  const environment = deviceToolEnvironment(hvigor, emptyEnv);
  assert.equal(environment.PATH, path.dirname(hdc));
  equalPath(resolveHdc({ env: environment }), hdc);
  assert.equal(emptyEnv.PATH, "");
});

test("SDK, Studio, standalone command-line layout and PATH are supported with deterministic precedence", t => {
  const base = fixture(t), sdk = path.join(base, "custom-sdk"), studio = path.join(base, "studio");
  const explicit = tool(path.join(sdk, "openharmony/toolchains"), "hdc");
  const studioHdc = tool(path.join(studio, "sdk/default/openharmony/toolchains"), "hdc");
  const commandLine = path.join(base, "command-line-tools");
  const hvigor = tool(path.join(commandLine, "bin"), "hvigorw");
  const standalone = tool(path.join(commandLine, "sdk/default/openharmony/toolchains"), "hdc");
  const pathHdc = tool(path.join(base, "path-tools"), "hdc");
  const env = { ...emptyEnv, PATH: path.dirname(pathHdc), DEVECO_HOME: studio, DEVECO_SDK_HOME: sdk };
  equalPath(resolveHdc({ hdc: "hdc", env }), pathHdc);
  assert.equal(resolveHdc({ hdc: path.join(base, "missing-hdc"), env }), null);
  equalPath(resolveHdc({ hvigor, env }), explicit);
  equalPath(resolveHdc({ hvigor, env: { ...env, DEVECO_SDK_HOME: undefined } }), studioHdc);
  equalPath(resolveHdc({ hvigor, env: { ...emptyEnv, PATH: path.dirname(pathHdc) } }), standalone);
  equalPath(resolveHdc({ env: { ...emptyEnv, PATH: path.dirname(pathHdc) } }), pathHdc);
  equalPath(resolveHdc({ env: { ...emptyEnv, DEVECO_SDK_HOME: path.join(sdk, "openharmony") } }), explicit);
  assert.equal(resolveHdc({ env: emptyEnv }), null);
});

test("build and device execution inherit the SDK-selected HDC instead of a conflicting PATH entry", t => {
  const studio = path.join(fixture(t), "studio");
  const hvigor = tool(path.join(studio, "tools/hvigor/bin"), "hvigorw");
  const hdc = tool(path.join(studio, "sdk/default/openharmony/toolchains"), "hdc");
  const wrong = tool(path.join(studio, "unrelated"), "hdc");
  const saved = { PATH: process.env.PATH, DEVECO_HOME: process.env.DEVECO_HOME, DEVECO_SDK_HOME: process.env.DEVECO_SDK_HOME };
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  process.env.PATH = path.dirname(wrong);
  delete process.env.DEVECO_HOME;
  delete process.env.DEVECO_SDK_HOME;
  const environment = devecoEnvironment(hvigor);
  assert.equal(environment.DEVECO_SDK_HOME, path.join(studio, "sdk"));
  assert.equal(environment.PATH?.split(path.delimiter)[0], path.dirname(hdc));
  equalPath(resolveHdc({ hvigor, env: environment }), hdc);
  assert.equal(process.env.PATH, path.dirname(wrong));
});

test("Windows Path casing preserves existing tools and is normalized for child processes", t => {
  const base = fixture(t), studio = path.join(base, "studio");
  const hdc = tool(path.join(studio, "sdk/default/openharmony/toolchains"), "hdc");
  const original = path.join(base, "original-tools");
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const env = { [pathKey]: original, DEVECO_HOME: studio, PathExt: ".CMD;.EXE;.BAT" };
  equalPath(resolveHdc({ env }), hdc);
  const child = deviceToolEnvironment("missing-hvigor", env);
  assert.deepEqual(child.PATH?.split(path.delimiter), [path.dirname(hdc), original]);
  assert.equal(Object.keys(child).filter(key => key.toUpperCase() === "PATH").length, 1);
  assert.equal(env[pathKey as keyof typeof env], original);
});
