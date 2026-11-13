import { inspectEnvironment, configureEnvironment } from "./ide/common.js";
import type { PluginConfig } from "./client/config.js";
import type { Environment } from "./client/types.js";
import { agentEnvironment, resolveAgentModel } from "./agent_runtime.js";
import { runCommand, which } from "./process.js";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import JSON5 from "json5";

export interface MissingDependency {
  name: string;
  reason: string;
  action: string;
}
export interface PreflightResult {
  verdict: "PASS" | "BLOCKED";
  stop: boolean;
  missing: MissingDependency[];
  environment?: Environment;
  reviewModel?: string;
}

const actions: Record<string, string> = {
  Node: "安装 Node.js 20.19 或更新版本，并确保 node 可执行。",
  重构后端: "从完整 Skill 发行包重新安装；不要只复制 SKILL.md。",
  HomeCheck: "从完整 Skill 发行包重新安装内置 HomeCheck 及其依赖。",
  "ArkTS SDK":
    "安装 DevEco Studio 的 ArkTS SDK，并设置 DEVECO_HOME 或 --config 中的 studio。",
  deveco:
    "安装并配置 DevEco Code CLI，将 deveco 加入 PATH，或在 --config 中设置 deveco。",
  hvigorw:
    "安装 DevEco Studio 的 Hvigor；设置 DEVECO_HOME 或 --config 中的 hvigor。",
  ohpm: "安装 OHPM；设置 DEVECO_HOME 或 --config 中的 ohpm。",
  codelinter:
    "将 codelinter 加入 PATH，或在 --config 中设置 linter；仅在明确选择跳过时设置 linterMode: skip。",
};

/** Inspect credential presence without serializing credentials or performing a model request. */
export function hasReviewCredentials(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
  cwd = process.cwd(),
): boolean {
  const configured = (value: unknown, base: string): boolean => {
    if (typeof value !== "string" || !value.trim()) return false;
    const envRef = /^\{env:([^}]+)\}$/.exec(value.trim());
    if (envRef) return !!env[envRef[1]]?.trim();
    const fileRef = /^\{file:([^}]+)\}$/.exec(value.trim());
    if (fileRef) {
      const filename = fileRef[1].startsWith("~/")
        ? path.join(userHome, fileRef[1].slice(2))
        : path.resolve(base, fileRef[1]);
      try {
        return !!fs.readFileSync(filename, "utf8").trim();
      } catch {
        return false;
      }
    }
    return !value.includes("{env:") && !value.includes("{file:");
  };
  const read = (file: string): any => {
    try {
      return JSON5.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return {};
    }
  };
  const data = path.join(
    env.XDG_DATA_HOME || path.join(userHome, ".local/share"),
    "deveco",
  );
  const auth = read(path.join(data, "auth.json"))[provider];
  if (auth?.type === "api" && configured(auth.key, data)) return true;
  if (
    auth?.type === "oauth" &&
    (configured(auth.access, data) || configured(auth.refresh, data))
  )
    return true;
  const configDir = path.join(
    env.XDG_CONFIG_HOME || path.join(userHome, ".config"),
    "deveco",
  );
  const dirs = [
    configDir,
    ...(env.DEVECO_CONFIG_DIR ? [env.DEVECO_CONFIG_DIR] : []),
  ];
  const files = dirs.flatMap((dir) =>
    ["config.json", "deveco.json", "deveco.jsonc"].map((file) =>
      path.join(dir, file),
    ),
  );
  if (env.DEVECO_CONFIG) files.push(env.DEVECO_CONFIG);
  let apiKey: unknown,
    keyBase = configDir;
  for (const file of files) {
    const candidate = read(file)?.provider?.[provider]?.options;
    if (candidate && Object.hasOwn(candidate, "apiKey")) {
      apiKey = candidate.apiKey;
      keyBase = path.dirname(file);
    }
  }
  try {
    const inline = JSON.parse(env.DEVECO_CONFIG_CONTENT || "{}")?.provider?.[
      provider
    ]?.options;
    if (inline && Object.hasOwn(inline, "apiKey")) {
      apiKey = inline.apiKey;
      keyBase = cwd;
    }
  } catch {
    return false;
  }
  if (configured(apiKey, keyBase)) return true;
  const variables: Record<string, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    google: ["GOOGLE_GENERATIVE_AI_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    "zhipuai-coding-plan": ["ZHIPU_API_KEY"],
    "zai-coding-plan": ["ZHIPU_API_KEY"],
    zhipuai: ["ZHIPU_API_KEY"],
    zai: ["ZHIPU_API_KEY"],
  };
  return (variables[provider] ?? []).some((key) => !!env[key]?.trim());
}

/** Local checks only. Listing configured models does not invoke a paid model request. */
export async function inspectSkillEnvironment(
  config: PluginConfig,
): Promise<PreflightResult> {
  const saved = {
    PATH: process.env.PATH,
    DEVECO_HOME: process.env.DEVECO_HOME,
    DEVECO_SDK_HOME: process.env.DEVECO_SDK_HOME,
  };
  try {
    configureEnvironment(config);
    const environment = inspectEnvironment(config) as Environment;
    const missing: MissingDependency[] = environment.tools
      .filter((t) => t.required && !t.available)
      .map((t) => ({
        name: t.name,
        reason: t.path ? `不可用：${t.path}` : "未发现可用配置或命令。",
        action: actions[t.name] ?? "配置该工具后重新运行 doctor。",
      }));
    let reviewModel: string | undefined,
      reviewEnv: NodeJS.ProcessEnv | undefined;
    try {
      reviewModel = resolveAgentModel(process.env.ARKTS_REVIEW_MODEL);
      // JSON.parse diagnostics can contain credential text, so use a fixed error here.
      try {
        JSON.parse(process.env.DEVECO_CONFIG_CONTENT?.trim() || "{}");
      } catch {
        throw new Error(
          "DEVECO_CONFIG_CONTENT 不是有效 JSON；不能使用 JSON5 注释或尾随逗号。",
        );
      }
      reviewEnv = agentEnvironment(process.env, {
        role: "review",
        model: reviewModel,
        variant: process.env.ARKTS_REVIEW_VARIANT || undefined,
      });
    } catch (error) {
      missing.push({
        name: "审查模型配置",
        reason: String((error as Error).message),
        action:
          "检查 ARKTS_REVIEW_MODEL、ARKTS_REVIEW_VARIANT 和 DEVECO_CONFIG_CONTENT，修正后重新运行 doctor。",
      });
    }
    const deveco = which(config.deveco || "deveco");
    if (deveco && reviewModel && reviewEnv) {
      const provider = reviewModel.split("/")[0];
      if (!hasReviewCredentials(provider, reviewEnv, homedir(), config.backend))
        missing.push({
          name: "审查模型凭据",
          reason: `未能确认 ${provider} 的用户级认证、provider.options.apiKey 或已支持的环境变量配置。`,
          action: `运行 deveco auth login 配置 ${provider}，或在用户级 DevEco provider.options.apiKey 中提供有效凭据；可用 {env:变量名} 引用环境变量。`,
        });
      if (missing.length)
        return {
          verdict: "BLOCKED",
          stop: true,
          missing,
          environment,
          reviewModel,
        };
      const probe = await runCommand([deveco, "--pure", "models", provider], {
        cwd: config.backend,
        timeoutSeconds: 20,
        env: { ...reviewEnv, NO_COLOR: "1" },
      });
      const lines = probe.output
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .map((s) => s.trim());
      if (probe.code !== 0 || probe.timedOut || !lines.includes(reviewModel)) {
        missing.push({
          name: "审查模型",
          reason: probe.timedOut
            ? "DevEco 模型配置检查超时。"
            : `DevEco 未能列出已配置模型 ${reviewModel}。`,
          action: `使用 deveco auth login 或用户级 provider 配置启用 ${provider}，确保 deveco --pure models ${provider} 包含 ${reviewModel}；或设置 ARKTS_REVIEW_MODEL。`,
        });
      }
    }
    return {
      verdict: missing.length ? "BLOCKED" : "PASS",
      stop: !!missing.length,
      missing,
      environment,
      reviewModel,
    };
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
