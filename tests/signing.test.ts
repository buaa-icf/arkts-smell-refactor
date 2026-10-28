import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import {
  prepareSigning,
  profileMatches,
  profileContent,
  signingToolFailure,
} from "../src/signing.js";
import { hvigorGate } from "../src/gate.js";
import { runCommand, which } from "../src/process.js";
import { fixture } from "./helpers.js";
import { readJson, readJson5, writeJson, writeText } from "../src/utils.js";

function project(root: string) {
  const source = path.join(root, "source"),
    workspace = path.join(root, "copy"),
    taskDir = path.join(root, "task");
  const config = {
    app: {
      products: [
        { name: "default", runtimeOS: "OpenHarmony", signingConfig: "release" },
      ],
      signingConfigs: [] as any[],
    },
    modules: [],
  };
  writeJson(path.join(source, "build-profile.json5"), config);
  writeJson(path.join(workspace, "build-profile.json5"), config);
  writeJson(path.join(source, "AppScope/app.json5"), {
    app: { bundleName: "com.example.signing" },
  });
  return {
    source,
    workspace,
    taskDir,
    config,
    stage: "test" as const,
    materialRoots: [path.join(root, "local-materials")],
  };
}
test("Local Test 不因签名缺失而阻塞，只在副本删除签名引用", async (t) => {
  const p = project(fixture(t));
  p.config.app.signingConfigs.push({
    name: "bad",
    material: { storePassword: "secret-password" },
  });
  writeJson(path.join(p.source, "build-profile.json5"), p.config);
  const before = fs.readFileSync(path.join(p.source, "build-profile.json5"));
  const result = await prepareSigning({ ...p, required: false });
  assert.equal(result.ready, true);
  assert.equal(result.report.status, "NOT_REQUIRED");
  assert(
    !readJson5(path.join(p.workspace, "build-profile.json5")).app.products[0]
      .signingConfig,
  );
  assert.deepEqual(
    readJson5(path.join(p.workspace, "build-profile.json5")).app.signingConfigs,
    [],
  );
  assert.deepEqual(
    fs.readFileSync(path.join(p.source, "build-profile.json5")),
    before,
  );
  assert(
    !JSON.stringify(
      readJson(path.join(p.taskDir, "signing-report.json")),
    ).includes("secret-password"),
  );
  assert.equal(
    result.redact("password=secret-password"),
    "password=[REDACTED]",
  );
});
test("Instrument 没有材料必须 BLOCKED，禁止改源仓库或生成虚假签名", async (t) => {
  const p = project(fixture(t)),
    before = fs.readFileSync(path.join(p.source, "build-profile.json5"));
  const result = await prepareSigning({ ...p, required: true });
  assert.equal(result.ready, false);
  assert.equal(result.report.status, "BLOCKED");
  assert.match(result.report.reason, /NO_MATCHING/);
  assert.deepEqual(
    fs.readFileSync(path.join(p.source, "build-profile.json5")),
    before,
  );
  await assert.rejects(
    prepareSigning({ ...p, workspace: p.source, required: true }),
    /隔离验证副本/,
  );
});
test("Profile 检查应用ID、有效期和证书绑定，不把文件存在当可用", () => {
  const cert = rootCertificates
    .map((pem) => new X509Certificate(pem))
    .find(
      (c) =>
        Date.parse(c.validFrom) < Date.now() &&
        Date.parse(c.validTo) > Date.now(),
    )!;
  const seconds = Date.now() / 1000,
    profile = {
      type: "release",
      validity: { "not-before": seconds - 60, "not-after": seconds + 60 },
      "bundle-info": {
        "bundle-name": "com.test",
        "distribution-certificate": cert.toString(),
      },
    };
  assert.equal(profileMatches(profile, "com.test", cert), null);
  assert.equal(profileMatches(profile, "com.other", cert), "BUNDLE_MISMATCH");
  assert.equal(
    profileMatches(
      { ...profile, validity: { "not-before": 0, "not-after": 1 } },
      "com.test",
      cert,
    ),
    "PROFILE_EXPIRED_OR_INVALID",
  );
  assert.equal(
    profileMatches(
      {
        ...profile,
        "bundle-info": {
          "bundle-name": "com.test",
          "distribution-certificate": "invalid",
        },
      },
      "com.test",
      cert,
    ),
    "PROFILE_CERTIFICATE_INVALID",
  );
  assert.throws(() => profileContent(Buffer.from('{"bundle-info":{}}')));
  assert.throws(() => profileContent(Buffer.from([0x30, 0x80])));
});

async function signedFixture(t: TestContext) {
  const openssl = which("openssl");
  if (!openssl) {
    t.skip("OpenSSL unavailable: optional real CMS integration fixture");
    return null;
  }
  const root = fixture(t),
    p = project(root),
    key = path.join(root, "test.key"),
    cert = path.join(root, "test.cer"),
    profile = path.join(root, "test.p7b"),
    store = path.join(root, "test.p12"),
    json = path.join(root, "profile.json");
  const exec = async (args: string[]) => {
    const result = await runCommand([openssl, ...args], { cwd: root });
    assert.equal(
      result.code,
      0,
      "test OpenSSL command failed: " + result.output,
    );
  };
  const opensslConfig = path.join(root, "openssl.cnf");
  writeText(opensslConfig, "[req]\ndistinguished_name=dn\n[dn]\n");
  await exec([
    "req",
    "-config",
    opensslConfig,
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    key,
    "-out",
    cert,
    "-subj",
    "/CN=Refactor-Test-Only",
  ]);
  await exec([
    "pkcs12",
    "-export",
    "-inkey",
    key,
    "-in",
    cert,
    "-out",
    store,
    "-passout",
    "pass:fixture-secret",
  ]);
  const content = {
    type: "release",
    validity: {
      "not-before": Math.floor(Date.now() / 1000) - 60,
      "not-after": Math.floor(Date.now() / 1000) + 3600,
    },
    "bundle-info": {
      "bundle-name": "com.example.signing",
      "distribution-certificate": fs.readFileSync(cert, "utf8"),
    },
  };
  const sign = async () => {
    writeJson(json, content);
    await exec([
      "cms",
      "-sign",
      "-binary",
      "-in",
      json,
      "-signer",
      cert,
      "-inkey",
      key,
      "-outform",
      "DER",
      "-out",
      profile,
      "-nodetach",
    ]);
  };
  await sign();
  p.config.app.signingConfigs.push({
    name: "default",
    material: {
      certpath: cert,
      profile,
      storeFile: store,
      keyAlias: "1",
      keyPassword: "fixture-secret",
      storePassword: "fixture-secret",
      signAlg: "SHA256withRSA",
    },
  });
  writeJson(path.join(p.source, "build-profile.json5"), p.config);
  return { ...p, root, profile, cert, store, content, sign };
}
test("真实 CMS：修复 release/default 引用不一致；配置及密码仅进入验证副本", async (t) => {
  const p = await signedFixture(t);
  if (!p) return;
  const result = await prepareSigning({ ...p, required: true });
  assert.equal(result.ready, true, JSON.stringify(result.report));
  assert.equal(result.report.status, "PREPARED");
  assert.equal(result.report.verification, "NOT_RUN");
  assert.equal(
    readJson5(path.join(p.workspace, "build-profile.json5")).app.products[0]
      .signingConfig,
    "arktsRefactorAuto",
  );
  assert.equal(
    readJson5(path.join(p.source, "build-profile.json5")).app.products[0]
      .signingConfig,
    "release",
  );
  assert(!JSON.stringify(result.report).includes("fixture-secret"));
  assert.equal(
    profileContent(fs.readFileSync(p.profile))["bundle-info"]["bundle-name"],
    "com.example.signing",
  );
});
test("真实 CMS：过期、应用不匹配和未经授权的 debug 设备均拒绝自动接入", async (t) => {
  const p = await signedFixture(t);
  if (!p) return;
  p.content.validity["not-after"] = 1;
  await p.sign();
  let result = await prepareSigning({ ...p, required: true });
  assert.equal(
    result.report.candidates[0].reason,
    "PROFILE_EXPIRED_OR_INVALID",
  );
  p.content.validity["not-after"] = Math.floor(Date.now() / 1000) + 3600;
  p.content["bundle-info"]["bundle-name"] = "com.other";
  await p.sign();
  result = await prepareSigning({ ...p, required: true });
  assert.equal(result.report.candidates[0].reason, "BUNDLE_MISMATCH");
  const content: any = p.content;
  content["bundle-info"]["bundle-name"] = "com.example.signing";
  content.type = "debug";
  content["bundle-info"]["development-certificate"] =
    content["bundle-info"]["distribution-certificate"];
  content["debug-info"] = { "device-ids": [] };
  await p.sign();
  result = await prepareSigning({
    ...p,
    required: true,
    hdc: path.join(p.root, "missing-hdc"),
  });
  assert.equal(
    result.report.candidates[0].reason,
    "DEVICE_AUTHORIZATION_UNVERIFIED_OR_MISMATCH",
  );
});
test("真实 CMS：重定位本机同名材料；多个可用配置不猜选", async (t) => {
  const p = await signedFixture(t);
  if (!p) return;
  const material = p.config.app.signingConfigs[0].material;
  for (const key of ["certpath", "profile", "storeFile"])
    material[key] = "/foreign-machine/" + path.basename(material[key]);
  writeJson(path.join(p.source, "build-profile.json5"), p.config);
  let result = await prepareSigning({
    ...p,
    required: true,
    materialRoots: [p.root],
  });
  assert.equal(result.ready, true);
  p.config.app.signingConfigs.push({
    name: "another",
    material: { ...material, keyAlias: "different-key" },
  });
  writeJson(path.join(p.source, "build-profile.json5"), p.config);
  result = await prepareSigning({
    ...p,
    required: true,
    materialRoots: [p.root],
  });
  assert.equal(result.ready, false);
  assert.equal(result.report.reason, "MULTIPLE_MATCHING_SIGNING_CONFIGS");
});
test("真实构建入口：签名被跳过时 BLOCKED，编译错误仍为 FAIL；输出密码脱敏", async (t) => {
  const p = await signedFixture(t);
  if (!p) return;
  writeJson(path.join(p.taskDir, "task.json"), {
    raw: { testKind: "instrument-test" },
  });
  const fake = path.join(p.root, "hvigor.cjs"),
    launcher = path.join(
      p.root,
      process.platform === "win32" ? "hvigor.cmd" : "hvigor",
    );
  writeText(
    launcher,
    process.platform === "win32"
      ? `@"${process.execPath}" "${fake}" %*`
      : `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"`,
  );
  if (process.platform !== "win32") fs.chmodSync(launcher, 0o755);
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) =>
    logs.push(args.join(" ")),
  );
  writeText(fake, "console.log('fixture-secret; WARN: Will skip sign hap');");
  assert.equal(
    await hvigorGate(p.taskDir, p.source, launcher, undefined, "assembleHap"),
    3,
  );
  assert(!logs.join("\n").includes("fixture-secret"));
  writeText(fake, "console.log('ArkTS compilation failed');process.exit(1);");
  assert.equal(
    await hvigorGate(p.taskDir, p.source, launcher, undefined, "assembleHap"),
    1,
  );
  writeText(
    fake,
    "console.log('Finished :phone:default@SignHap... BUILD SUCCESSFUL');",
  );
  assert.equal(
    await hvigorGate(p.taskDir, p.source, launcher, undefined, "assembleHap"),
    0,
  );
  assert.match(
    readJson(path.join(p.taskDir, "signing-report.json")).verification,
    /INSTALLATION_NOT_VERIFIED/,
  );
});
test("签名工具错误和跳过签名可识别，不吞掉正常编译诊断", () => {
  assert(signingToolFailure("Failed :phone:default@SignHap"));
  assert(signingToolFailure("Will skip sign 'hap'. No signingConfigs profile"));
  assert(signingToolFailure("WARN: No signingConfig found for product default"));
  assert(!signingToolFailure("ArkTS ERROR File: Page.ets"));
});

test("真实 CMS：当前工程无配置时，仅复用工作区内相同应用和系统的配置", async (t) => {
  const p = await signedFixture(t);
  if (!p) return;
  const donor = path.join(p.root, "matching-donor");
  writeJson(path.join(donor, "build-profile.json5"), p.config);
  writeJson(path.join(donor, "AppScope/app.json5"), {
    app: { bundleName: "com.example.signing" },
  });
  p.config.app.signingConfigs = [];
  writeJson(path.join(p.source, "build-profile.json5"), p.config);
  let result = await prepareSigning({
    ...p,
    required: true,
    workspaceRoot: p.root,
  });
  // The donor's product must reference the signing entry (release vs default is not accepted for other apps).
  assert.equal(result.ready, false);
  const donorConfig = readJson5(path.join(donor, "build-profile.json5"));
  donorConfig.app.products[0].signingConfig = "default";
  writeJson(path.join(donor, "build-profile.json5"), donorConfig);
  result = await prepareSigning({
    ...p,
    required: true,
    workspaceRoot: p.root,
  });
  assert.equal(result.ready, true, JSON.stringify(result.report));
  assert.equal(result.report.selected.source, "matching-local-project");
  donorConfig.app.products[0].runtimeOS = "HarmonyOS";
  writeJson(path.join(donor, "build-profile.json5"), donorConfig);
  result = await prepareSigning({
    ...p,
    required: true,
    workspaceRoot: p.root,
  });
  assert.equal(result.ready, false);
});
