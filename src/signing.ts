import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import type { Json } from "./models.js";
import { runCommand, which } from "./process.js";
import { resolveHdc } from "./device_tools.js";
import { isFile, readJson5, walk, within, writeJson } from "./utils.js";

// Profile content is CMS SignedData. This bounded DER reader extracts only its
// encapsulated content; it does NOT establish signer trust or device permission.
export function profileContent(bytes: Buffer): Json {
  const tlv = (offset: number): { tag: number; start: number; end: number } => {
    if (offset + 2 > bytes.length) throw Error("invalid DER");
    const tag = bytes[offset++];
    let length = bytes[offset++];
    if (length & 128) {
      const count = length & 127;
      if (!count || count > 4 || offset + count > bytes.length)
        throw Error("invalid DER length");
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
    }
    if (offset + length > bytes.length) throw Error("truncated DER");
    return { tag, start: offset, end: offset + length };
  };
  const children = (node: ReturnType<typeof tlv>) => {
    const result: ReturnType<typeof tlv>[] = [];
    for (let at = node.start; at < node.end;) {
      const child = tlv(at);
      if (child.end > node.end) throw Error("invalid DER child");
      result.push(child);
      at = child.end;
    }
    return result;
  };
  const root = tlv(0),
    ci = children(root);
  if (
    root.tag !== 0x30 ||
    root.end !== bytes.length ||
    ci[0]?.tag !== 6 ||
    bytes.subarray(ci[0].start, ci[0].end).toString("hex") !==
      "2a864886f70d010702" ||
    ci[1]?.tag !== 0xa0
  )
    throw Error("profile is not CMS SignedData");
  const signed = children(ci[1])[0];
  if (signed?.tag !== 0x30) throw Error("invalid SignedData");
  const encapsulated = children(signed)[2];
  if (encapsulated?.tag !== 0x30) throw Error("missing profile content");
  const content = children(encapsulated);
  if (
    content[0]?.tag !== 6 ||
    bytes.subarray(content[0].start, content[0].end).toString("hex") !==
      "2a864886f70d010701" ||
    content[1]?.tag !== 0xa0
  )
    throw Error("invalid profile content type");
  const octets = children(content[1]);
  if (octets.length !== 1 || octets[0].tag !== 4)
    throw Error("unsupported profile encoding");
  return JSON.parse(
    bytes.subarray(octets[0].start, octets[0].end).toString("utf8"),
  );
}

function materialFiles(roots: string[]): string[] {
  // Only DevEco's known credential directories, not the entire home directory.
  const files: string[] = [];
  for (const root of roots) {
    const visit = (dir: string, depth: number) => {
      if (depth > 3 || !fs.existsSync(dir)) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const file = path.join(dir, item.name);
        if (item.isDirectory()) visit(file, depth + 1);
        else if (item.isFile() && /\.(cer|pem|p7b|p12|jks)$/i.test(item.name))
          files.push(file);
      }
    };
    visit(root, 0);
  }
  return files;
}
function resolveMaterial(
  value: unknown,
  source: string,
  localFiles: string[],
): string | null {
  if (typeof value !== "string" || !value) return null;
  const original = path.resolve(source, value);
  if (isFile(original)) return original;
  const name = path.posix.basename(value.replaceAll("\\", "/"));
  const matches = localFiles.filter((file) => path.basename(file) === name);
  return matches.length === 1 ? matches[0] : null;
}
const certificate = (input: string | Buffer) =>
  new X509Certificate(
    typeof input === "string" && !input.includes("-----BEGIN")
      ? Buffer.from(input.replace(/\s/g, ""), "base64")
      : input,
  );
function certificateForProfile(bytes: Buffer, profile: Json): X509Certificate {
  const blocks = bytes.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g),
    chain = blocks?.length ? blocks.map(certificate) : [certificate(bytes)],
    info = profile["bundle-info"],
    embedded = profile.type === "debug" ? info?.["development-certificate"]
      : profile.type === "release" ? info?.["distribution-certificate"] : null;
  // DevEco .cer files can contain root/intermediate/developer certificates in
  // any order. Select the profile's exact certificate; profileMatches below
  // still checks application identity, validity and mismatched/invalid profiles.
  if (embedded) {
    try {
      const fingerprint = certificate(embedded).fingerprint256;
      return chain.find(cert => cert.fingerprint256 === fingerprint) ?? chain[0];
    } catch { /* preserve profileMatches' invalid-profile diagnosis */ }
  }
  return chain[0];
}
const activeCertificate = (cert: X509Certificate, time: number) =>
  Date.parse(cert.validFrom) <= time && time <= Date.parse(cert.validTo);
export function profileMatches(
  profile: Json,
  bundle: string,
  cert: X509Certificate | Buffer,
  time = Date.now(),
): string | null {
  if (Buffer.isBuffer(cert)) cert = certificateForProfile(cert, profile);
  const info = profile["bundle-info"],
    validity = profile.validity;
  if (info?.["bundle-name"] !== bundle) return "BUNDLE_MISMATCH";
  if (
    !Number.isFinite(validity?.["not-before"]) ||
    !Number.isFinite(validity?.["not-after"]) ||
    time / 1000 < validity["not-before"] ||
    time / 1000 > validity["not-after"]
  )
    return "PROFILE_EXPIRED_OR_INVALID";
  if (!activeCertificate(cert, time)) return "CERTIFICATE_EXPIRED";
  const pem =
    profile.type === "debug"
      ? info["development-certificate"]
      : profile.type === "release"
        ? info["distribution-certificate"]
        : null;
  try {
    if (!pem || certificate(pem).fingerprint256 !== cert.fingerprint256)
      return "PROFILE_CERTIFICATE_MISMATCH";
  } catch {
    return "PROFILE_CERTIFICATE_INVALID";
  }
  return null;
}
export interface SigningOptions {
  taskDir: string;
  source: string;
  workspace: string;
  required: boolean;
  stage: "build" | "test";
  workspaceRoot?: string;
  materialRoots?: string[];
  hdc?: string;
  env?: NodeJS.ProcessEnv;
}
export interface SigningPreparation {
  ready: boolean;
  report: Json;
  redact: (text: string) => string;
}
const signingActions: Record<string, string> = {
  HDC_UNAVAILABLE: "未找到可用 hdc；请检查本次 DevEco Studio/SDK 工具路径或 PATH。已有签名无需因此重新生成。",
  HDC_LIST_FAILED: "hdc list targets 执行失败；请检查 HDC 工具、服务和设备连接。",
  HDC_LIST_TIMEOUT: "读取设备列表超时；请检查 HDC 服务和设备连接后重试。",
  NO_CONNECTED_DEVICE: "hdc 未列出可用设备；请连接并授权调试设备，确认本次 SDK 的 hdc list targets 能列出目标。",
  TOO_MANY_DEVICES: "连接设备超过安全探测上限 8 台；请减少连接设备后重试。",
  DEVICE_UDID_UNAVAILABLE: "无法读取已连接设备的 UDID；请检查调试授权及 hdc shell bm get -u 是否可用。",
  DEVICE_UDID_TIMEOUT: "读取设备 UDID 超时；请检查设备调试连接后重试。",
  DEVICE_PROBE_CANCELLED: "设备探测已中止；确认环境就绪后重新发起验收。",
  DEVICE_NOT_AUTHORIZED: "已连接设备未全部包含在当前 Profile 授权中；请核对目标设备及 Profile，或断开本次不使用的设备。",
  PROFILE_DEVICE_AUTHORIZATION_INVALID: "当前 debug Profile 的设备授权列表为空或格式无效；请在 DevEco 中核对该 Profile 的设备授权。",
  PROFILE_EXPIRED_OR_INVALID: "Profile 已过期或有效期无效；请更新对应应用的 Profile。",
  CERTIFICATE_EXPIRED: "签名证书已过期或尚未生效；请核对证书有效期。",
  BUNDLE_MISMATCH: "签名 Profile 的应用标识与当前工程不同；请使用该应用的 Profile。",
  PROFILE_CERTIFICATE_MISMATCH: "Profile 与本机配置的证书不匹配；请核对签名材料对应关系。",
  PROFILE_CERTIFICATE_INVALID: "Profile 内的证书无法解析；请检查签名材料。",
  PROFILE_SIGNATURE_INVALID: "Profile 的 CMS 签名校验失败；请检查签名材料是否完整。",
  MATERIAL_FILES_MISSING_OR_AMBIGUOUS: "签名配置已存在，但材料文件缺失或同名材料无法唯一定位；请检查证书、Profile 和密钥库路径。",
  MATERIAL_UNREADABLE_OR_INVALID: "签名材料无法读取或解析；请检查本机签名文件及权限。",
  KEY_CONFIGURATION_MISSING: "签名配置缺少密钥别名、算法或密码字段；请核对签名配置。",
  RUNTIME_MISMATCH: "签名配置与当前产品系统或配置引用不匹配；请核对产品及签名引用。",
  MULTIPLE_MATCHING_SIGNING_CONFIGS: "发现多个可用签名配置，无法确定本次使用项；请为当前产品明确指定签名配置。",
  NO_MATCHING_LOCAL_SIGNING_CONFIG: "未找到可检查的本地签名配置；请为当前应用配置签名材料。",
};
export function saveSigningReport(
  options: Pick<SigningOptions, "taskDir" | "stage">,
  report: Json,
): void {
  writeJson(
    path.join(options.taskDir, `signing-report-${options.stage}.json`),
    report,
  );
  writeJson(path.join(options.taskDir, "signing-report.json"), report);
}
export async function prepareSigning(
  options: SigningOptions,
): Promise<SigningPreparation> {
  const { source, workspace, required } = options;
  if (within(workspace, source) || within(source, workspace))
    throw Error("签名配置只能写入隔离验证副本");
  const report: Json = {
    schemaVersion: "1.0",
    stage: options.stage,
    required,
    status: "CHECKING",
    changes: [],
    candidates: [],
    verification: "NOT_RUN",
    sourceModified: false,
    deviceCheck: { status: "NOT_RUN" },
  };
  const secrets = new Set<string>();
  const redact = (text: string) => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length))
      if (secret) text = text.split(secret).join("[REDACTED]");
    return text;
  };
  const finish = (ready: boolean, status: string, reason: string) => {
    Object.assign(report, { status, reason });
    saveSigningReport(options, report);
    return { ready, report, redact };
  };
  const blocked = (reasonCode: string, reasons: string[] = [reasonCode]) => {
    const action = [...new Set(reasons.map(code => signingActions[code] ?? "请查看 signing-report-test.json 中的具体拒绝原因。"))].join(" ");
    Object.assign(report, { reasonCode, action });
    const detail = reasonCode === "SIGNING_CANDIDATES_REJECTED" ? `（${reasons.join("、")}）` : "";
    return finish(false, "BLOCKED", `${reasonCode}${detail}；${action}`);
  };
  const profileFile = path.join(source, "build-profile.json5");
  let config: Json;
  try {
    config = readJson5(profileFile);
  } catch {
    return finish(
      !required,
      required ? "BLOCKED" : "NOT_REQUIRED",
      "BUILD_PROFILE_UNREADABLE",
    );
  }
  const products = config.app?.products;
  for (const entry of config.app?.signingConfigs ?? []) {
    if (typeof entry.material?.keyPassword === "string")
      secrets.add(entry.material.keyPassword);
    if (typeof entry.material?.storePassword === "string")
      secrets.add(entry.material.storePassword);
  }
  if (!required) {
    // Compilation/local tests do not prove installation; never block them on credentials.
    for (const product of products ?? [])
      if (product.signingConfig) {
        delete product.signingConfig;
        report.changes.push("DISABLE_UNUSED_SIGNING_IN_COPY");
      }
    if (config.app?.signingConfigs?.length) {
      config.app.signingConfigs = [];
      report.changes.push("REMOVE_UNUSED_SIGNING_MATERIAL_FROM_COPY");
    }
    if (report.changes.length)
      writeJson(path.join(workspace, "build-profile.json5"), config);
    return finish(
      true,
      "NOT_REQUIRED",
      "编译/Local Test 不要求签名，仅在副本中禁用签名引用",
    );
  }
  const product =
    products?.find((p: Json) => p.name === "default") ??
    (products?.length === 1 ? products[0] : null);
  const runtime = product?.runtimeOS;
  let bundle: string;
  try {
    bundle = readJson5(path.join(source, "AppScope/app.json5")).app?.bundleName;
  } catch {
    return finish(false, "BLOCKED", "APP_IDENTITY_UNAVAILABLE");
  }
  if (!bundle || !product || !["OpenHarmony", "HarmonyOS"].includes(runtime))
    return finish(false, "BLOCKED", "PRODUCT_OR_RUNTIME_AMBIGUOUS");
  report.bundleName = bundle;
  report.runtimeOS = runtime;
  report.product = product.name;
  let files: string[] | undefined;
  const resolveFile = (value: unknown, root: string) =>
    resolveMaterial(value, root, []) ??
    resolveMaterial(
      value,
      root,
      (files ??= materialFiles(
        options.materialRoots ?? [path.join(os.homedir(), ".ohos/config")],
      )),
    );
  const openssl = which("openssl");
  let devices: string[] | null | undefined;
  let deviceProbe: Json | undefined;
  const deviceUdids = async (): Promise<string[] | null> => {
    if (devices !== undefined) {
      report.deviceCheck = { ...deviceProbe };
      return devices;
    }
    const hdc = resolveHdc({ hdc: options.hdc, env: options.env });
    const failure = (reasonCode: string, extra: Json = {}) => {
      deviceProbe = { status: "BLOCKED", reasonCode, action: signingActions[reasonCode],
        ...(hdc ? { hdc } : {}), ...extra };
      report.deviceCheck = { ...deviceProbe };
      return (devices = null);
    };
    if (!hdc) return failure("HDC_UNAVAILABLE");
    const listed = await runCommand([hdc, "list", "targets"], {
      cwd: source,
      env: options.env,
      timeoutSeconds: 15,
    });
    if (listed.cancelled) return failure("DEVICE_PROBE_CANCELLED");
    if (listed.timedOut) return failure("HDC_LIST_TIMEOUT");
    if (listed.code !== 0 || listed.error || /(?:^|\n)\s*\[Fail\]/i.test(listed.output))
      return failure("HDC_LIST_FAILED", { exitCode: listed.code });
    const targets = [...new Set(listed.output.trim().split(/\r?\n/).map(line => line.trim())
      .filter(line => /^[\w.:-]+$/.test(line)))];
    for (const target of targets) secrets.add(target);
    if (!targets.length) return failure("NO_CONNECTED_DEVICE", { connectedCount: 0 });
    if (targets.length > 8) return failure("TOO_MANY_DEVICES", { connectedCount: targets.length });
    const result: string[] = [];
    for (const target of targets) {
      const read = await runCommand(
        [hdc, "-t", target, "shell", "bm", "get", "-u"],
        { cwd: source, env: options.env, timeoutSeconds: 15 },
      );
      if (read.cancelled) return failure("DEVICE_PROBE_CANCELLED", { connectedCount: targets.length });
      if (read.timedOut) return failure("DEVICE_UDID_TIMEOUT", { connectedCount: targets.length });
      const udid =
        read.code === 0
          ? /(?:^|\s)([a-fA-F0-9]{32,128})(?:\s|$)/.exec(read.output)?.[1]
          : null;
      if (!udid) return failure("DEVICE_UDID_UNAVAILABLE", { connectedCount: targets.length, exitCode: read.code });
      secrets.add(udid);
      result.push(udid);
    }
    deviceProbe = { status: "IDENTIFIED", hdc, connectedCount: targets.length };
    report.deviceCheck = { ...deviceProbe };
    return (devices = result);
  };
  const candidates: {
    name: string;
    material: Json;
    origin: string;
    cert: string;
    profile: string;
    store: string;
    deviceCheck: Json;
  }[] = [];
  function* localSources(): Generator<string> {
    yield source;
    // Do not repeatedly traverse other repositories when this project is usable.
    if (
      candidates.length ||
      !options.workspaceRoot ||
      !within(source, options.workspaceRoot)
    )
      return;
    const ignore = new Set([
      ".git",
      ".hvigor",
      ".test",
      "node_modules",
      "oh_modules",
      "build",
      "runs",
      "v",
      ".test-tmp",
    ]);
    for (const file of walk(options.workspaceRoot, ignore))
      if (
        path.basename(file) === "build-profile.json5" &&
        path.dirname(file) !== source
      ) {
        const root = path.dirname(file);
        try {
          if (
            readJson5(path.join(root, "AppScope/app.json5")).app?.bundleName ===
            bundle
          )
            yield root;
        } catch {
          /* unrelated/non-project file */
        }
      }
  }
  for (const root of localSources()) {
    let donor: Json;
    try {
      donor = readJson5(path.join(root, "build-profile.json5"));
    } catch {
      continue;
    }
    const configs = donor.app?.signingConfigs;
    if (!Array.isArray(configs)) continue;
    for (const entry of configs) {
      const material = entry.material ?? {};
      for (const field of ["keyPassword", "storePassword"])
        if (typeof material[field] === "string") secrets.add(material[field]);
      const audit: Json = {
        source: root === source ? "current-project" : "matching-local-project",
        name: entry.name,
        status: "REJECTED",
      };
      report.candidates.push(audit);
      if (
        !donor.app?.products?.some(
          (p: Json) =>
            p.runtimeOS === runtime &&
            (p.signingConfig === entry.name || root === source),
        )
      ) {
        audit.reason = "RUNTIME_MISMATCH";
        continue;
      }
      const certFile = resolveFile(material.certpath, root),
        p7b = resolveFile(material.profile, root),
        store = resolveFile(material.storeFile, root);
      if (!certFile || !p7b || !store) {
        audit.reason = "MATERIAL_FILES_MISSING_OR_AMBIGUOUS";
        continue;
      }
      if (
        !["keyAlias", "signAlg"].every(
          (k) => typeof material[k] === "string" && material[k].length,
        ) ||
        !["keyPassword", "storePassword"].every(
          (k) => typeof material[k] === "string",
        )
      ) {
        audit.reason = "KEY_CONFIGURATION_MISSING";
        continue;
      }
      try {
        const stat = fs.statSync(p7b);
        if (stat.size > 2 * 1024 * 1024) throw Error("PROFILE_TOO_LARGE");
        const bytes = fs.readFileSync(p7b),
          content = profileContent(bytes),
          cert = certificateForProfile(fs.readFileSync(certFile), content);
        const rejection = profileMatches(content, bundle, cert);
        if (rejection) {
          audit.reason = rejection;
          continue;
        }
        if (openssl) {
          const checked = await runCommand(
            [
              openssl,
              "cms",
              "-verify",
              "-noverify",
              "-inform",
              "DER",
              "-in",
              p7b,
            ],
            { cwd: root, timeoutSeconds: 15 },
          );
          if (checked.code !== 0) {
            audit.reason = "PROFILE_SIGNATURE_INVALID";
            continue;
          }
          audit.profileIntegrity = "CMS_SIGNATURE_VERIFIED_CHAIN_DEFERRED";
        } else audit.profileIntegrity = "DEFERRED_TO_TOOLCHAIN_AND_DEVICE";
        if (content.type === "debug") {
          const allowed = content["debug-info"]?.["device-ids"];
          if (
            !Array.isArray(allowed) || !allowed.length ||
            allowed.some(id => typeof id !== "string" || !id.trim()) ||
            (content["debug-info"]?.["device-id-type"] &&
              String(content["debug-info"]["device-id-type"]).toLowerCase() !==
                "udid")
          ) {
            audit.reason = "PROFILE_DEVICE_AUTHORIZATION_INVALID";
            continue;
          }
          const current = await deviceUdids();
          if (!current) {
            audit.reason = report.deviceCheck.reasonCode;
            continue;
          }
          if (current.some(
              (udid) =>
                !allowed.some(
                  (id) =>
                    typeof id === "string" &&
                    id.toLowerCase() === udid.toLowerCase(),
                ),
            )) {
            audit.reason = "DEVICE_NOT_AUTHORIZED";
            report.deviceCheck = { ...report.deviceCheck, status: "BLOCKED", reasonCode: audit.reason,
              action: signingActions[audit.reason] };
            continue;
          }
          report.deviceCheck = { ...report.deviceCheck, status: "AUTHORIZED" };
        }
        audit.status = "MATCHED";
        audit.certificateFingerprint = cert.fingerprint256;
        audit.reason = "静态匹配，不代表实际签名或安装成功";
        candidates.push({
          name: entry.name,
          material: {
            ...material,
            certpath: certFile,
            profile: p7b,
            storeFile: store,
          },
          origin: root,
          cert: cert.fingerprint256,
          profile: p7b,
          store,
          deviceCheck: content.type === "debug" ? { ...report.deviceCheck } : { status: "NOT_REQUIRED" },
        });
      } catch {
        audit.reason = "MATERIAL_UNREADABLE_OR_INVALID";
      }
    }
  }
  const current = candidates.filter(
    (c) => c.origin === source && c.name === product.signingConfig,
  );
  const unique = [
    ...new Map(
      candidates.map((c) => [
        JSON.stringify([
          c.cert,
          c.profile,
          c.store,
          c.material.keyAlias,
          c.material.storePassword,
          c.material.keyPassword,
        ]),
        c,
      ]),
    ).values(),
  ];
  const selected =
    current.length === 1 ? current[0] : unique.length === 1 ? unique[0] : null;
  if (!selected) {
    if (unique.length) return blocked("MULTIPLE_MATCHING_SIGNING_CONFIGS");
    const reasons = [...new Set<string>(report.candidates.map((candidate: Json) => candidate.reason).filter(Boolean))];
    report.rejectionReasons = reasons;
    if (!reasons.length) return blocked("NO_MATCHING_LOCAL_SIGNING_CONFIG");
    return blocked(reasons.length === 1 ? reasons[0] : "SIGNING_CANDIDATES_REJECTED", reasons);
  }
  report.deviceCheck = selected.deviceCheck;
  const name = "arktsRefactorAuto";
  config.app.signingConfigs = [
    ...(config.app.signingConfigs ?? []).filter((c: Json) => c.name !== name),
    { name, material: selected.material },
  ];
  product.signingConfig = name;
  writeJson(path.join(workspace, "build-profile.json5"), config);
  report.changes.push("SET_MATCHED_SIGNING_IN_VALIDATION_COPY");
  report.selected = {
    name: selected.name,
    source:
      selected.origin === source ? "current-project" : "matching-local-project",
    certificateFingerprint: selected.cert,
  };
  return finish(
    true,
    "PREPARED",
    "静态签名准备完成，仍需实际签名及设备安装验证",
  );
}

export function signingToolFailure(text: string): boolean {
  return /Failed[^\r\n]*@SignHap|Invalid storeFile value|(?:signing|signature)(?: verification)?(?: is)? (?:failed|failure|error|invalid|missing)|skip sign ['"]?hap|No signingConfigs?\b|(?:incorrect|invalid) (?:key|store|keystore) password|failed to sign/i.test(
    text,
  );
}
