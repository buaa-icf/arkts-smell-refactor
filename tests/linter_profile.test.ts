import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { projectLinterGuidance } from "../src/linter_profile.js";
import { writeJson, writeText } from "../src/utils.js";
import { fixture } from "./helpers.js";
const withCodelinter = (home: string): (() => void) => {
  const previous = process.env.PATH,
    bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  writeText(path.join(bin, "codelinter.cmd"), "@echo off");
  process.env.PATH = [bin, previous ?? ""].join(path.delimiter);
  return () => {
    process.env.PATH = previous;
  };
};
test("skip 模式与缺失配置都不注入摘要", (t) => {
  const root = fixture(t),
    target = path.join(root, "entry/src/main/ets/Page.ets");
  writeText(target, "export class Page {}");
  assert.equal(projectLinterGuidance(target, root, "skip"), "");
  assert.equal(projectLinterGuidance(target, root, "required"), "");
});
test("显式风格规则摘要包含 off 语义与具体生成检查", (t) => {
  const root = fixture(t),
    target = path.join(root, "entry/src/main/ets/Page.ets");
  writeText(target, "export class Page {}");
  writeText(
    path.join(root, "code-linter.json5"),
    `{
  files: ["**/*.ets"],
  ignore: ["**/build/**"],
  rules: {
    "@extrulesproject/semi": ["error", "always"],
    "@extrulesproject/naming-convention": ["error", {
      selector: "memberLike",
      modifiers: ["private"],
      leadingUnderscore: "require",
    }],
    "@extrulesproject/quotes": "off",
    "@extrulesproject/no-any": "error",
  },
}`,
  );
  const guidance = projectLinterGuidance(target, root);
  assert.match(guidance, /项目 Linter 风格摘要/);
  assert.match(guidance, /off\/0 表示该项关闭/);
  assert.match(guidance, /生成与交回前检查/);
  assert.match(guidance, /semi 已启用/);
  assert.match(guidance, /必须有前导下划线/);
  assert.doesNotMatch(guidance, /no-any/, "非风格规则不进入摘要");
  assert.match(guidance, /files: /);
});
test("off 的显式规则不产生生成检查", (t) => {
  const root = fixture(t),
    target = path.join(root, "entry/src/main/ets/Page.ets");
  writeText(target, "export class Page {}");
  writeText(
    path.join(root, "code-linter.json5"),
    `{ rules: { "@extrulesproject/semi": ["error", "never"] } }`,
  );
  const guidance = projectLinterGuidance(target, root);
  assert.match(guidance, /semi=never/);
  assert.doesNotMatch(guidance, /semi 已启用/);
});
test("ruleSet 继承项从本机目录展开并附来源", (t) => {
  const root = fixture(t),
    target = path.join(root, "entry/src/main/ets/Page.ets");
  writeText(target, "export class Page {}");
  const restore = withCodelinter(path.join(fixture(t), "toolchain"));
  try {
    const home = path.dirname(path.dirname(path.resolve(process.env.PATH!.split(path.delimiter)[0], "codelinter.cmd")));
    writeJson(path.join(home, "codelinter/linter/arkts", "ruleSet.json"), {
      "arkts-strict": {
        "@extrulesproject/avoid-overusing-custom-component-check": ["error"],
        "@extrulesproject/semi": ["error", "always"],
      },
    });
    writeText(
      path.join(root, "code-linter.json5"),
      `{ ruleSet: ["arkts-strict"], rules: { "@extrulesproject/semi": ["error", "never"] } }`,
    );
    const guidance = projectLinterGuidance(target, root);
    assert.match(guidance, /继承 @extrulesproject\/avoid-overusing-custom-component-check/);
    assert.match(guidance, /继承来源：arkts-strict ← arkts\/ruleSet\.json/);
    assert.match(guidance, /优先提取 @Builder/);
    assert.match(guidance, /semi=never/, "显式配置优先于继承项");
    assert.doesNotMatch(guidance, /继承 @extrulesproject\/semi/, "被显式覆盖的继承项不重复列出");
  } finally {
    restore();
  }
});
test("存在条件 overrides 时不猜生效选择器", (t) => {
  const root = fixture(t),
    target = path.join(root, "entry/src/main/ets/Page.ets");
  writeText(target, "export class Page {}");
  writeText(
    path.join(root, "code-linter.json5"),
    `{
  rules: { "@extrulesproject/semi": ["error", "always"] },
  overrides: [{ files: ["**/*.ets"], rules: { "@extrulesproject/semi": "off" } }],
}`,
  );
  const guidance = projectLinterGuidance(target, root);
  assert.match(guidance, /overrides/);
  assert.doesNotMatch(guidance, /生成与交回前检查/);
});
