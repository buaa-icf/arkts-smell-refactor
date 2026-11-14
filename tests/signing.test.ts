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

test("真实 CMS：开发证书不在 .cer 首位时仍匹配，并拒绝确实缺失的证书", async (t) => {
  const p = await signedFixture(t);
  if (!p) return;
  const leaf = fs.readFileSync(p.cert, "utf8"), fingerprint = new X509Certificate(leaf).fingerprint256;
  const unrelated = rootCertificates.filter(pem => {
    const cert = new X509Certificate(pem), now = Date.now();
    return cert.fingerprint256 !== fingerprint && Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);
  }).slice(0, 2);
  assert.equal(unrelated.length, 2);
  assert.equal(profileMatches(p.content, "com.example.signing", new X509Certificate(leaf).raw), null);
  const originalConfig = fs.readFileSync(path.join(p.source, "build-profile.json5"));
  for (const bundle of [unrelated[0] + "\n" + unrelated[1] + "\n" + leaf, leaf + "\n" + unrelated.join("\n")]) {
    fs.writeFileSync(p.cert, bundle);
    assert.equal(profileMatches(p.content, "com.example.signing", Buffer.from(bundle)), null);
    const result = await prepareSigning({ ...p, required: true });
    assert.equal(result.ready, true, JSON.stringify(result.report));
    assert.equal(result.report.candidates[0].certificateFingerprint, fingerprint);
    assert.deepEqual(fs.readFileSync(path.join(p.source, "build-profile.json5")), originalConfig);
  }
  const wrongBundle = unrelated.join("\n");
  fs.writeFileSync(p.cert, wrongBundle);
  assert.equal(profileMatches(p.content, "com.example.signing", Buffer.from(wrongBundle)), "PROFILE_CERTIFICATE_MISMATCH");
  const rejected = await prepareSigning({ ...p, required: true });
  assert.equal(rejected.ready, false);
  assert.equal(rejected.report.candidates[0].reason, "PROFILE_CERTIFICATE_MISMATCH");
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
    "PROFILE_DEVICE_AUTHORIZATION_INVALID",
  );
  assert.equal(result.report.reasonCode, "PROFILE_DEVICE_AUTHORIZATION_INVALID");
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
  assert.equal(result.report.reasonCode, "MULTIPLE_MATCHING_SIGNING_CONFIGS");
  assert.match(result.report.reason, /明确指定签名配置/);
});

function fakeHdc(root: string) {
  const script = path.join(root, "hdc-fixture.cjs"),
    launcher = path.join(root, process.platform === "win32" ? "hdc-fixture.cmd" : "hdc-fixture");
  writeText(launcher, process.platform === "win32"
    ? `@"${process.execPath}" "${script}" %*`
    : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"`);
  if (process.platform !== "win32") fs.chmodSync(launcher, 0o755);
  const configure = (mode: string) => writeText(script, `
    const mode=${JSON.stringify(mode)}, args=process.argv.slice(2);
    if(mode==='expected-port' && process.env.HDC_SERVER_PORT!=='19540') process.exit(9);
    if(args[0]==='list') {
      if(mode==='empty') console.log('[Empty]');
      else if(mode==='list-failed') { console.error('fixture-secret private-list-output'); process.exit(4); }
      else if(mode==='too-many') console.log(Array.from({length:9},(_,i)=>'private-target-'+i).join('\\n'));
      else if(mode==='list-timeout') setTimeout(()=>{},30000);
      else console.log(mode==='multiple'?'private-target-a\\nprivate-target-b':'private-target-a');
    } else {
      if(mode==='udid-failed') { console.error('fixture-secret private-udid-output'); process.exit(5); }
      else if(mode==='malformed-udid') console.log('unavailable');
      else console.log((mode==='mismatch'||args[1]==='private-target-b'?'B':'A').repeat(64));
    }
  `);
  return { launcher, configure };
}

async function debugFixture(t: TestContext) {
  const p = await signedFixture(t);
  if (!p) return null;
  const content: any = p.content;
  content.type = "debug";
  content["bundle-info"]["development-certificate"] = content["bundle-info"]["distribution-certificate"];
  content["debug-info"] = { "device-id-type": "udid", "device-ids": ["A".repeat(64)] };
  await p.sign();
  return p;
}

test("真实 CMS debug：正确设备可用，设备失败有精确原因且不泄露设备标识", async t => {
  const p = await debugFixture(t);
  if (!p) return;
  const hdc = fakeHdc(p.root), before = fs.readFileSync(path.join(p.source, "build-profile.json5"));
  for (const [mode, reason] of [
    ["authorized", null], ["empty", "NO_CONNECTED_DEVICE"], ["list-failed", "HDC_LIST_FAILED"],
    ["too-many", "TOO_MANY_DEVICES"], ["udid-failed", "DEVICE_UDID_UNAVAILABLE"],
    ["malformed-udid", "DEVICE_UDID_UNAVAILABLE"], ["mismatch", "DEVICE_NOT_AUTHORIZED"],
    ["multiple", "DEVICE_NOT_AUTHORIZED"],
  ] as const) {
    hdc.configure(mode);
    const result = await prepareSigning({ ...p, required: true, hdc: hdc.launcher });
    assert.equal(result.ready, reason === null, mode + ": " + JSON.stringify(result.report));
    assert.equal(result.report.verification, "NOT_RUN");
    if (reason) {
      assert.equal(result.report.reasonCode, reason, mode);
      assert.equal(result.report.deviceCheck.reasonCode, reason, mode);
      assert.equal(result.report.candidates[0].reason, reason, mode);
      assert.match(result.report.reason, new RegExp(reason));
      assert.ok(result.report.action.length > 10);
      assert.equal(result.report.reason.includes("NO_MATCHING_LOCAL_SIGNING_CONFIG"), false);
    } else {
      assert.equal(result.report.deviceCheck.status, "AUTHORIZED");
      assert.equal(result.report.deviceCheck.connectedCount, 1);
      assert.equal(result.report.deviceCheck.hdc, hdc.launcher);
      assert.equal(result.report.candidates[0].profileIntegrity, "CMS_SIGNATURE_VERIFIED_CHAIN_DEFERRED");
    }
    const report = JSON.stringify(result.report);
    for (const secret of ["fixture-secret", "private-target", "private-list-output", "private-udid-output", "A".repeat(64), "B".repeat(64)])
      assert.equal(report.includes(secret), false, mode + " leaked " + secret);
    assert.deepEqual(fs.readFileSync(path.join(p.source, "build-profile.json5")), before);
  }
});

test("真实 CMS debug：显式 hdc 不可用时不改签名或静默回退，空授权列表单独诊断", async t => {
  const p = await debugFixture(t);
  if (!p) return;
  const result = await prepareSigning({ ...p, required: true, hdc: path.join(p.root, "missing-hdc") });
  assert.equal(result.ready, false);
  assert.equal(result.report.reasonCode, "HDC_UNAVAILABLE");
  assert.equal(result.report.candidates[0].reason, "HDC_UNAVAILABLE");
  assert.equal(result.report.deviceCheck.reasonCode, "HDC_UNAVAILABLE");
  assert.match(result.report.action, /无需因此重新生成/);
  const hdc = fakeHdc(p.root); hdc.configure("authorized");
  (p.content as any)["debug-info"]["device-ids"] = [];
  await p.sign();
  const invalid = await prepareSigning({ ...p, required: true, hdc: hdc.launcher });
  assert.equal(invalid.report.reasonCode, "PROFILE_DEVICE_AUTHORIZATION_INVALID");
  assert.equal(invalid.report.deviceCheck.status, "NOT_RUN");
});

test("真实 CMS debug：多个已连接设备必须全部获授权，设备匹配不等同实际测试通过", async t => {
  const p = await debugFixture(t);
  if (!p) return;
  (p.content as any)["debug-info"]["device-ids"].push("b".repeat(64));
  await p.sign();
  const hdc = fakeHdc(p.root); hdc.configure("multiple");
  const result = await prepareSigning({ ...p, required: true, hdc: hdc.launcher });
  assert.equal(result.ready, true, JSON.stringify(result.report));
  assert.equal(result.report.deviceCheck.status, "AUTHORIZED");
  assert.equal(result.report.deviceCheck.connectedCount, 2);
  assert.equal(result.report.verification, "NOT_RUN");
});

test("设备前置探测使用调用方传入的 HDC 环境", async t => {
  const p = await debugFixture(t);
  if (!p) return;
  const hdc = fakeHdc(p.root); hdc.configure("expected-port");
  const result = await prepareSigning({ ...p, required: true, hdc: hdc.launcher,
    env: { ...process.env, HDC_SERVER_PORT: "19540" } });
  assert.equal(result.ready, true, JSON.stringify(result.report));
  assert.equal(result.report.deviceCheck.status, "AUTHORIZED");
});

test("真实 Studio 目录入口：SDK hdc 同时用于 debug 签名检查与 Hvigor 执行环境", async t => {
  const p = await debugFixture(t);
  if (!p) return;
  const openssl = which("openssl")!;
  const studio = path.join(p.root, "DevEco Studio"), toolchains = path.join(studio, "sdk/default/openharmony/toolchains");
  const environment = Object.fromEntries(["PATH", "DEVECO_HOME", "DEVECO_SDK_HOME"].map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(environment))
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  const launcher = (directory: string, name: string, executable: string, script?: string) => {
    const file = path.join(directory, process.platform === "win32" ? name + ".cmd" : name);
    writeText(file, process.platform === "win32"
      ? `@"${executable}" ${script ? `"${script}" ` : ""}%*`
      : `#!/bin/sh\nexec '${executable}' ${script ? `'${script}' ` : ""}"$@"`);
    if (process.platform !== "win32") fs.chmodSync(file, 0o755);
    return file;
  };
  // Keep OpenSSL available while removing every ambient HDC location from PATH.
  const isolatedBin = path.join(p.root, "isolated-bin");
  launcher(isolatedBin, "openssl", openssl);
  process.env.PATH = isolatedBin;
  delete process.env.DEVECO_HOME; delete process.env.DEVECO_SDK_HOME;
  assert.equal(which("hdc"), null);
  const hdc = fakeHdc(p.root); hdc.configure("authorized");
  const sdkHdc = launcher(toolchains, "hdc", process.execPath, path.join(p.root, "hdc-fixture.cjs"));
  const hvigorScript = path.join(p.root, "hvigor-sdk-env.cjs");
  writeText(hvigorScript, `const path=require('node:path');
    if(path.resolve(process.env.PATH.split(path.delimiter)[0])!==${JSON.stringify(toolchains)}) throw Error('wrong HDC toolchain');
    console.log('Finished :phone:default@SignHap... BUILD SUCCESSFUL');`);
  const hvigor = launcher(path.join(studio, "tools/hvigor/bin"), "hvigorw", process.execPath, hvigorScript);
  writeJson(path.join(p.taskDir, "task.json"), { raw: { testKind: "instrument-test" } });
  const original = fs.readFileSync(path.join(p.source, "build-profile.json5"));
  assert.equal(await hvigorGate(p.taskDir, p.source, hvigor, undefined, "assembleHap"), 0);
  const report = readJson(path.join(p.taskDir, "signing-report-build.json"));
  assert.equal(report.status, "PREPARED");
  assert.equal(report.deviceCheck.status, "AUTHORIZED");
  const canonical = (file: string) => process.platform === "win32"
    ? fs.realpathSync(file).toLowerCase() : fs.realpathSync(file);
  assert.equal(canonical(report.deviceCheck.hdc), canonical(sdkHdc));
  assert.deepEqual(fs.readFileSync(path.join(p.source, "build-profile.json5")), original);
});

test("真实 CMS debug：设备枚举超时保留精确诊断，不归咎于签名缺失", { timeout: 25_000 }, async t => {
  const p = await debugFixture(t);
  if (!p) return;
  const hdc = fakeHdc(p.root); hdc.configure("list-timeout");
  const result = await prepareSigning({ ...p, required: true, hdc: hdc.launcher });
  assert.equal(result.ready, false);
  assert.equal(result.report.reasonCode, "HDC_LIST_TIMEOUT");
  assert.equal(result.report.deviceCheck.reasonCode, "HDC_LIST_TIMEOUT");
  assert.equal(result.report.candidates[0].reason, "HDC_LIST_TIMEOUT");
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
