import path from "node:path";
import type { Json } from "./models.js";
import { readText, writeJson } from "./utils.js";
import { runCommand } from "./process.js";
import { validationHandoff, FINAL_CHECK_DESCRIPTION, FINAL_CHECK_INSTRUCTION } from "./validation_handoff.js";

export const POLICY_VERSION = "2026-11-06-cross-host-clone-evidence";
export const DISABLED_AGENT_TOOLS = ["webfetch", "websearch", "skill"];
export const INTERNAL_VALIDATION_TOOLS = ["build_project", "arkts_check"];
export const MAX_INTERNAL_VALIDATION_ATTEMPTS = 2;
export function internalValidationAllowed(role = "refactor", formatOnly = false): boolean {
  return !formatOnly && ["refactor", "repair"].includes(role);
}
export function disabledAgentTools(role = "refactor", formatOnly = false): string[] {
  return [...DISABLED_AGENT_TOOLS, ...(!internalValidationAllowed(role, formatOnly) ? INTERNAL_VALIDATION_TOOLS : [])];
}
export interface AgentOptions { model?: string; variant?: string }
export interface AgentSelection { refactor?: AgentOptions; review?: AgentOptions }
export function resolveAgentModel(model?: string): string | undefined {
  // Omitting -m lets DevEco resolve its own local model/provider configuration.
  return model?.trim() || undefined;
}
function object(value: unknown, name: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as Json;
}
export function resolveSelection(selection: AgentSelection = {}, env = process.env): AgentSelection {
  return Object.fromEntries((["refactor", "review"] as const).map(role => [role, {
    model: resolveAgentModel(selection[role]?.model ?? env[`ARKTS_${role.toUpperCase()}_MODEL`]),
    variant: selection[role]?.variant ?? (env[`ARKTS_${role.toUpperCase()}_VARIANT`] || undefined),
  }]));
}
export function agentEnvironment(
  original: NodeJS.ProcessEnv = process.env,
  options: AgentOptions & { cwd?: string; formatOnly?: boolean; role?: string } = {},
): NodeJS.ProcessEnv {
  const env = { ...original, DEVECO_DISABLE_EXTERNAL_SKILLS: "1" } as NodeJS.ProcessEnv;
  if (options.cwd) {
    env.GIT_CEILING_DIRECTORIES = path.dirname(path.resolve(options.cwd));
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
  }
  const config = object(JSON.parse(env.DEVECO_CONFIG_CONTENT?.trim() || "{}"), "DEVECO_CONFIG_CONTENT");
  // Provider/model/variant settings and disabled_providers belong to the user's
  // DevEco configuration. Do not inject provider-specific reasoning parameters.
  const disabledTools = disabledAgentTools(options.role, options.formatOnly),
    enabledTools = internalValidationAllowed(options.role, options.formatOnly) ? INTERNAL_VALIDATION_TOOLS : [];
  function restrict(settings: Json) {
    const permission = typeof settings.permission === "string" ? { "*": settings.permission } : object(settings.permission ?? {}, "permission");
    settings.permission = { ...permission, ...Object.fromEntries(enabledTools.map(t => [t, "allow"])), ...Object.fromEntries(disabledTools.map(t => [t, "deny"])) };
    settings.tools = { ...object(settings.tools ?? {}, "tools"), ...Object.fromEntries(enabledTools.map(t => [t, true])), ...Object.fromEntries(disabledTools.map(t => [t, false])) };
  }
  restrict(config);
  const agents = object(config.agent ?? {}, "agent");
  for (const settings of Object.values(agents)) if (settings && typeof settings === "object" && !Array.isArray(settings)) restrict(settings);
  if (options.formatOnly) config.agent = { ...agents, "arkts-review-format": {
    description: "Serialize the completed review only; no tools or new review.", mode: "primary",
    permission: { "*": "deny" }, tools: { "*": false },
  } };
  env.DEVECO_CONFIG_CONTENT = JSON.stringify(config);
  return env;
}
export async function runAgent(
  deveco: string, taskDir: string, cwd: string, promptFile: string,
  options: AgentOptions & { role: string; title?: string; formatOnly?: boolean; promptViaStdin?: boolean },
): Promise<number> {
  const model = resolveAgentModel(options.model), env = agentEnvironment(process.env, { ...options, model, cwd });
  const command = [deveco, "run"];
  if (model) command.push("-m", model);
  if (options.variant) command.push("--variant", options.variant);
  if (options.formatOnly) command.push("--agent", "arkts-review-format");
  command.push(options.role.startsWith("review") ? "严格执行输入中的只读评审任务，只输出要求的 JSON。" :
    "严格执行附件中的 ArkTS 重构任务，直接修改工作区内的生产代码。" + FINAL_CHECK_INSTRUCTION);
  if (!options.promptViaStdin) command.push("-f", path.resolve(promptFile));
  command.push("--dir", cwd, "--format", "json", "--auto");
  if (options.title) command.push("--title", options.title);
  writeJson(path.join(taskDir, `${options.role}-execution-policy.json`), {
    policyVersion: POLICY_VERSION, role: options.role, requestedModel: model ?? null, requestedVariant: options.variant ?? null,
    modelSource: model ? "explicit-override" : "deveco-local-config",
    requestedReasoningEffort: null,
    disabledTools: disabledAgentTools(options.role, options.formatOnly), disabledProviders: JSON.parse(env.DEVECO_CONFIG_CONTENT!).disabled_providers ?? [],
    validationOwner: internalValidationAllowed(options.role, options.formatOnly) ? "agent-and-platform" : "platform",
    internalValidation: {
      enabled: internalValidationAllowed(options.role, options.formatOnly),
      tools: internalValidationAllowed(options.role, options.formatOnly) ? INTERNAL_VALIDATION_TOOLS : [],
      maxAttempts: internalValidationAllowed(options.role, options.formatOnly) ? MAX_INTERNAL_VALIDATION_ATTEMPTS : 0,
      finalCheckDescription: internalValidationAllowed(options.role, options.formatOnly) ? FINAL_CHECK_DESCRIPTION : null,
    },
    providerSettingsVerified: false, formatOnly: !!options.formatOnly,
    externalSkillsDisabled: true, skillToolDisabled: true, gitCeilingDirectory: env.GIT_CEILING_DIRECTORIES,
    reviewPacketAttached: options.role === "review" && path.basename(promptFile) === "review-agent-prompt.md",
    promptTransport: options.promptViaStdin ? "stdin" : "file",
  });
  const observe = internalValidationAllowed(options.role, options.formatOnly) ? validationHandoff(path.resolve(cwd)) : null;
  const handoff = new AbortController();
  const result = await runCommand(command, {
    cwd, env, stream: true, input: options.promptViaStdin ? readText(promptFile) : undefined,
    signal: handoff.signal,
    onStdoutLine: observe ? line => {
      const check = observe(line);
      if (check) handoff.abort(check);
    } : undefined,
  });
  if (result.cancelled && handoff.signal.aborted && !result.error) {
    console.log(JSON.stringify({ type: "internal_validation_handoff", role: options.role, check: handoff.signal.reason }));
    return 0;
  }
  if (result.error) console.error(result.error);
  return result.code ?? 3;
}
