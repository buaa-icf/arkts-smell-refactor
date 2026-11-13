import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, type PluginConfig } from "./client/config.js";
import { runSkill, type SkillOptions } from "./skill.js";
import {
  inspectSkillEnvironment,
  type PreflightResult,
  type MissingDependency,
} from "./skill_preflight.js";
import { which } from "./process.js";

const portableKeys = [
  "studio",
  "deveco",
  "hvigor",
  "ohpm",
  "linter",
  "linterMode",
  "timeoutMs",
];
const offlineCommands = new Set([
  "import",
  "history",
  "diff",
  "restore",
  "rollback",
  "apply",
]);

export function findProject(start: string): string | undefined {
  for (let current = resolve(start); ; current = dirname(current)) {
    if (
      existsSync(resolve(current, "build-profile.json5")) &&
      existsSync(resolve(current, "hvigor/hvigor-config.json5"))
    )
      return realpathSync(current);
    if (dirname(current) === current) return undefined;
  }
}

export function discoverStudio(
  settings: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (settings.studio !== undefined && typeof settings.studio !== "string")
    throw new Error("studio 必须为路径字符串。");
  if (settings.studio) return settings.studio as string;
  if (env.DEVECO_HOME) return env.DEVECO_HOME;
  const candidates = [
    env.DEVECO_SDK_HOME,
    ...["hvigor", "ohpm", "linter"].map((name, index) =>
      which(
        typeof settings[name] === "string" && settings[name]
          ? (settings[name] as string)
          : ["hvigorw", "ohpm", "codelinter"][index],
      ),
    ),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (
      let directory = resolve(candidate), level = 0;
      level < 5;
      level++, directory = dirname(directory)
    ) {
      if (existsSync(resolve(directory, "sdk/default/openharmony/ets")))
        return directory;
      if (dirname(directory) === directory) break;
    }
  }
  return "";
}

function readSettings(file?: string): Record<string, unknown> {
  if (!file) return {};
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new Error(`工具设置不是有效 JSON：${file}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("工具设置必须是 JSON 对象。");
  // Historical TUI settings can be reused for tools without retaining a project/backend binding.
  return Object.fromEntries(
    portableKeys
      .filter((key) => settings[key] !== undefined)
      .map((key) => [key, settings[key]]),
  );
}

export interface PortableSkillOptions extends SkillOptions {
  runtimeRoot: string;
  settingsFile?: string;
  inspect?: (config: PluginConfig) => Promise<PreflightResult>;
}

/** Installed entrypoint: portable runtime, project inferred at invocation, fail before running agents. */
export async function runPortableSkill(
  args: string[],
  io: PortableSkillOptions,
): Promise<number> {
  const stdout =
    io.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) {
    stdout(
      "ArkTS Skill (standalone)\nRun inside a HarmonyOS project, or pass --project <path>.\nOptional --config <tool-settings.json>. doctor must PASS before starting a workflow.\n",
    );
    return runSkill(["--help"], {
      ...io,
      stdout: (line) =>
        stdout(
          line
            .replace(
              "node dist/skill.js <command> --config <settings.json>",
              "node <skill>/scripts/run.mjs <command>",
            )
            .replace(" --backend <path>", ""),
        ),
    });
  }
  const directory = resolve(io.directory ?? process.cwd());
  let projectRoot: string | undefined;
  const blocked = (
    missing: MissingDependency[],
    extra: Partial<PreflightResult> = {},
  ) => {
    stdout(
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        command: args[0],
        projectRoot,
        result: { ...extra, verdict: "BLOCKED", stop: true, missing },
      }),
    );
    return 3;
  };
  try {
    const forwarded = [args[0]],
      flags: Record<string, string> = {};
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i],
        value = args[i + 1];
      if (
        !key.startsWith("--") ||
        !value ||
        value.startsWith("--") ||
        key in flags
      )
        throw new Error(`参数无效、重复或缺值：${key}`);
      flags[key] = value;
      if (key === "--backend")
        throw new Error("独立 Skill 使用包内后端，不接受 --backend。");
      if (!["--config", "--project", "--runs"].includes(key))
        forwarded.push(key, value);
    }
    projectRoot = findProject(
      flags["--project"]
        ? realpathSync(resolve(directory, flags["--project"]))
        : directory,
    );
    const settings = {
      ...readSettings(io.settingsFile),
      ...readSettings(
        flags["--config"] ? resolve(directory, flags["--config"]) : undefined,
      ),
    };
    const config = await loadConfig(
      {
        ...settings,
        studio: discoverStudio(settings),
        node: process.execPath,
        backend: resolve(io.runtimeRoot),
        projectRoot: projectRoot ?? directory,
        ...(flags["--runs"]
          ? { runs: resolve(directory, flags["--runs"]) }
          : {}),
      },
      directory,
    );
    const projectMissing: MissingDependency[] =
      !projectRoot || !findProject(projectRoot)
        ? [
            {
              name: "HarmonyOS 工程",
              reason:
                "未发现 build-profile.json5 与 hvigor/hvigor-config.json5。",
              action: "在目标工程目录运行，或传入 --project <工程目录>。",
            },
          ]
        : [];
    if (args[0] === "doctor" || !offlineCommands.has(args[0])) {
      const result = await (io.inspect ?? inspectSkillEnvironment)(config);
      if (projectMissing.length || result.stop)
        return blocked([...projectMissing, ...result.missing], result);
      if (args[0] === "doctor") {
        stdout(
          JSON.stringify({
            schemaVersion: 1,
            ok: true,
            command: "doctor",
            projectRoot,
            result,
          }),
        );
        return 0;
      }
    } else if (projectMissing.length) return blocked(projectMissing);
    return await runSkill(forwarded, { ...io, directory, config });
  } catch (error) {
    return blocked([
      {
        name: "Skill 配置",
        reason: (error as Error).message,
        action: "检查安装目录、工具设置及传入路径，然后重新运行 doctor。",
      },
    ]);
  }
}
