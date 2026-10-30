import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import type { Json } from "./models.js";
import { runCommand, which } from "./process.js";
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
const activeCertificate = (cert: X509Certificate, time: number) =>
  Date.parse(cert.validFrom) <= time && time <= Date.parse(cert.validTo);
export function profileMatches(
  profile: Json,
  bundle: string,
  cert: X509Certificate,
  time = Date.now(),
): string | null {
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
}
export interface SigningPreparation {
  ready: boolean;
  report: Json;
  redact: (text: string) => string;
}
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
  const deviceUdids = async (): Promise<string[] | null> => {
    if (devices !== undefined) return devices;
    const hdc = options.hdc ?? which("hdc");
    if (!hdc) return (devices = null);
    const listed = await runCommand([hdc, "list", "targets"], {
      cwd: source,
      timeoutSeconds: 15,
    });
    const targets =
      listed.code === 0
        ? listed.output
            .trim()
            .split(/\r?\n/)
            .filter((s) => /^[\w.:-]+$/.test(s))
        : [];
    if (!targets.length || targets.length > 8) return (devices = null);
    const result: string[] = [];
    for (const target of targets) {
      const read = await runCommand(
        [hdc, "-t", target, "shell", "bm", "get", "-u"],
        { cwd: source, timeoutSeconds: 15 },
      );
      const udid =
        read.code === 0
          ? /(?:^|\s)([a-fA-F0-9]{32,128})(?:\s|$)/.exec(read.output)?.[1]
          : null;
      if (!udid) return (devices = null);
      result.push(udid);
    }
    return (devices = result);
  };
  const candidates: {
    name: string;
    material: Json;
    origin: string;
    cert: string;
    profile: string;
    store: string;
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
          cert = new X509Certificate(fs.readFileSync(certFile));
        const content = profileContent(bytes);
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
          const allowed = content["debug-info"]?.["device-ids"],
            current = await deviceUdids();
          if (
            !Array.isArray(allowed) ||
            (content["debug-info"]?.["device-id-type"] &&
              String(content["debug-info"]["device-id-type"]).toLowerCase() !==
                "udid") ||
            !current ||
            current.some(
              (udid) =>
                !allowed.some(
                  (id) =>
                    typeof id === "string" &&
                    id.toLowerCase() === udid.toLowerCase(),
                ),
            )
          ) {
            audit.reason = "DEVICE_AUTHORIZATION_UNVERIFIED_OR_MISMATCH";
            continue;
          }
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
  if (!selected)
    return finish(
      false,
      "BLOCKED",
      unique.length
        ? "MULTIPLE_MATCHING_SIGNING_CONFIGS"
        : "NO_MATCHING_LOCAL_SIGNING_CONFIG；请在 DevEco 中为该应用/设备完成签名授权",
    );
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
