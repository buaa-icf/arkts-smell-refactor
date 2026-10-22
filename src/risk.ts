import path from "node:path";
import type { RefactorTask, Json } from "./models.js";
import { targetPath } from "./models.js";
import {
  sourceFiles,
  readText,
  isFile,
  isTest,
  relative,
  escapeRe,
  unique,
  parents,
} from "./utils.js";
import { ownerAtLine, rangeText } from "./analysis/source.js";
import {
  analyzeFeatureEnvy,
  featureEnvyConstraints,
} from "./analysis/feature_envy.js";
import { analyzeSwitch } from "./analysis/switch_statement.js";
import {
  analyzeCodeClone,
  codeCloneConstraints,
} from "./analysis/code_clone.js";
import { analyzeGodClass, godClassConstraints } from "./analysis/god_class.js";
import {
  analyzeCyclicDependency,
  cyclicConstraints,
} from "./analysis/cyclic_dependency.js";
export function reactiveNames(source: string): string[] {
  const lines = source.split("\n"),
    names: string[] = [];
  lines.forEach((line, i) => {
    if (
      /@(?:State|Prop|Link|ObjectLink|Provide|Consume|StorageLink|StorageProp|Observed|Track)\b/.test(
        line,
      )
    ) {
      const m =
        /(?:@\w+(?:\([^)]*\))?\s*)+(?:public\s+|private\s+|protected\s+)?([A-Za-z_$][\w$]*)\s*[:=]/.exec(
          line + " " + (lines[i + 1] ?? ""),
        );
      if (m) names.push(m[1]);
    }
  });
  return unique(names);
}
export function findCallers(
  task: RefactorTask,
  source: string,
  owner: string,
): Json[] {
  if (!task.target.symbol) return [];
  const short = escapeRe(task.target.symbol.split(".").at(-1)!),
    results: Json[] = [];
  const call = new RegExp(`\\b(?:([A-Za-z_$][\\w$]*)\\.)?${short}\\s*\\(`),
    declaration = new RegExp(
      `\\b${short}\\s*\\([^)]*\\)\\s*(?::[^\\{]+)?\\s*\\{`,
    ),
    signature = new RegExp(
      `^\\s*${short}\\s*\\([^)]*\\)\\s*\\??\\s*:\\s*[^=]+[,;]?\\s*$`,
    );
  for (const file of sourceFiles(task.project_root)) {
    if (isTest(file)) continue;
    const text = file === targetPath(task) ? source : readText(file);
    text.split("\n").forEach((line, i) => {
      const m = call.exec(line);
      if (
        !m ||
        declaration.test(line) ||
        signature.test(line) ||
        (file !== targetPath(task) && m[1] !== owner)
      )
        return;
      results.push({
        filePath: relative(file, task.workspace_root),
        line: i + 1,
        kind: "production",
        expression: line.trim().slice(0, 300),
        owner,
      });
    });
  }
  return results;
}
function typeDefinition(task: RefactorTask, type: string): string | null {
  const names = unique(
      (type.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []).filter(
        (n) =>
          ![
            "undefined",
            "null",
            "unknown",
            "Object",
            "string",
            "number",
            "boolean",
          ].includes(n),
      ),
    ),
    source = readText(targetPath(task));
  for (const name of names) {
    const m = new RegExp(
      `import\\s*\\{[^}]*\\b${escapeRe(name)}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`,
    ).exec(source);
    if (m?.[1].startsWith(".")) {
      const base = path.resolve(path.dirname(targetPath(task)), m[1]),
        found = [
          base,
          base + ".ets",
          base + ".ts",
          path.join(base, "Index.ets"),
          path.join(base, "index.ets"),
        ].find(isFile);
      if (found) return relative(found, task.workspace_root);
    }
  }
  for (const file of sourceFiles(task.project_root))
    if (
      !isTest(file) &&
      file !== targetPath(task) &&
      names.some(
        (n) =>
          path.basename(file, path.extname(file)).toLowerCase() ===
          n.toLowerCase(),
      )
    )
      if (
        names.some((n) =>
          new RegExp(
            `\\b(?:class|interface|struct|type)\\s+${escapeRe(n)}\\b`,
          ).test(readText(file)),
        )
      )
        return relative(file, task.workspace_root);
  return null;
}
export function analyzeRisks(task: RefactorTask): Json {
  const file = targetPath(task);
  if (!isFile(file)) throw new Error(`目标文件不存在：${file}`);
  const source = readText(file),
    risks: Json[] = [],
    constraints: Json[] = [];
  let analysis: Json | null = null,
    key = "";
  const add = (
    code: string,
    level: string,
    evidence: string,
    affected = [task.target.file_path],
  ) =>
    risks.push({
      code,
      level,
      evidence,
      affectedFiles: unique(affected).sort(),
    });
  const constrain = (code: string, reason: string, instruction: string) =>
    constraints.push({ code, reason, instruction });
  if (
    task.smell_type === "god-class" ||
    task.smell_type === "cyclic-dependency"
  ) {
    analysis =
      task.smell_type === "god-class"
        ? analyzeGodClass(task, source)
        : analyzeCyclicDependency(task);
    key =
      task.smell_type === "god-class"
        ? "godClassAnalysis"
        : "cyclicDependencyAnalysis";
    const [r, c] =
      task.smell_type === "god-class"
        ? godClassConstraints(analysis, task.target.file_path)
        : cyclicConstraints(analysis);
    risks.push(...r);
    constraints.push(...c);
    return {
      schemaVersion: "1.2",
      taskId: task.task_id,
      riskLevel: risks.some((r) => r.level === "high")
        ? "high"
        : risks.length
          ? "medium"
          : "low",
      target: { filePath: task.target.file_path, symbol: task.target.symbol },
      callers: {
        total: analysis.externalCallers?.length ?? 0,
        production: analysis.externalCallers?.length ?? 0,
        test: 0,
        items: analysis.externalCallers ?? [],
      },
      risks,
      recommendedConstraints: constraints,
      [key]: analysis,
      analysisLimitations: analysis.analysisLimitations ?? [],
    };
  }
  const symbol = task.target.symbol,
    m = symbol
      ? new RegExp(
          `((?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?)\\b${escapeRe(symbol.split(".").at(-1)!)}\\s*\\(`,
        ).exec(source)
      : null,
    prefix = m?.[1] ?? "";
  const declaration = {
    visibility: !symbol
      ? "unknown"
      : prefix.includes("private")
        ? "private"
        : prefix.includes("protected")
          ? "protected"
          : "public",
    exported:
      !!symbol &&
      /\bexport\s+(?:default\s+)?(?:class|function|const|let|var)/.test(source),
  };
  const owner = ownerAtLine(
      source,
      m
        ? source.slice(0, m.index).split("\n").length + 1
        : source.split("\n").length + 1,
      path.basename(file, path.extname(file)),
    ),
    callers = findCallers(task, source, owner),
    reactive = reactiveNames(source),
    region = rangeText(
      source,
      task.target.range.start_line,
      task.target.range.end_line,
    ),
    reads = reactive
      .filter((n) => new RegExp(`\\bthis\\.${escapeRe(n)}\\b`).test(region))
      .sort();
  if (declaration.visibility === "public" || declaration.exported) {
    add(
      "PUBLIC_API_CHANGE",
      callers.length ? "high" : "medium",
      "目标符号可被其他文件使用",
      callers.map((c) => c.filePath),
    );
    constrain(
      "PRESERVE_PUBLIC_CONTRACT",
      "目标符号对外可见",
      "除非专项分析明确证明可以安全移动，否则保持名称、参数、返回值、可见性和所属类型",
    );
  }
  if (callers.length) {
    add(
      "CALL_SITE_BREAK",
      callers.length >= 5 ? "high" : "medium",
      `发现 ${callers.length} 个静态调用点`,
      callers.map((c) => c.filePath),
    );
    if (declaration.visibility !== "public" && !declaration.exported)
      constrain(
        "PRESERVE_PRODUCTION_CALLERS",
        "存在生产调用点",
        "保持现有生产调用方式有效；优先保留兼容入口，不要求修改调用方",
      );
  }
  if (reads.length) {
    add(
      "REACTIVE_STATE",
      "high",
      "目标范围读取 ArkUI 响应式状态：" + reads.join(", "),
    );
    constrain(
      "PRESERVE_REACTIVE_READ",
      "普通值参数可能截断状态刷新链",
      "抽取 Builder/组件后必须保持对响应式状态的实时读取",
    );
  }
  if (task.smell_type === "feature-envy") {
    analysis = analyzeFeatureEnvy(task, source, declaration, callers, reactive);
    key = "featureEnvyAnalysis";
    const [r, c] = featureEnvyConstraints(task, analysis);
    risks.push(...r);
    constraints.push(...c);
    const definition = typeDefinition(task, analysis.targetType),
      defaults = unique([
        task.target.file_path,
        ...(definition ? [definition] : []),
      ]);
    const moduleFile = parents(path.dirname(file))
        .flatMap((p) => [
          path.join(p, "src/main/module.json5"),
          path.join(p, "oh-package.json5"),
        ])
        .find(isFile),
      buildTarget = moduleFile
        ? (/['"]name['"]\s*:\s*['"]([^'"]+)/.exec(readText(moduleFile))?.[1] ??
          null)
        : null;
    analysis.executionContext = {
      suggestedScope:
        analysis.recommendedDestination === "target-class"
          ? "intra-class"
          : "inter-class",
      focusFiles: unique([...defaults, ...callers.map((c) => c.filePath)]),
      modificationBoundary: {
        defaultFiles: defaults,
        allowNewProductionHelper: /helper|builder/.test(
          analysis.recommendedDestination,
        ),
        expansionRule:
          "仅当类型导出、依赖方向或编译错误直接要求时扩大范围，并保持改动最小",
      },
      buildTarget,
    };
  } else if (task.smell_type === "code-clone") {
    analysis = analyzeCodeClone(task, source);
    key = "codeCloneAnalysis";
    const [r, c] = codeCloneConstraints(task, analysis);
    risks.push(...r);
    constraints.push(...c);
  } else if (task.smell_type === "long-method") {
    if (region.includes("@Builder") || region.includes("build()"))
      add("UI_STRUCTURE_CHANGE", "high", "目标可能包含 ArkUI Builder/组件树");
    constrain(
      "NO_NEW_CLONE",
      "长方法拆分可能复制相同 UI 片段",
      "拆分后复检修改区域是否产生代码克隆",
    );
  } else if (task.smell_type === "switch-statement") {
    analysis = analyzeSwitch(task, source);
    key = "switchStatementAnalysis";
    const a = analysis;
    if ((a.controlFlow ?? []).some((t: string) => t !== "break"))
      add(
        "CONTROL_FLOW_CHANGE",
        "high",
        "条件分支含非局部控制流：" +
          a.controlFlow.filter((t: string) => t !== "break").join(", "),
      );
    if (a.switchCount > 1) {
      add(
        "MULTIPLE_SWITCH_SCOPE",
        "high",
        `任务包含 ${a.switchCount} 个 switch`,
      );
      constrain(
        "PRESERVE_SWITCH_PARTITIONS",
        "switch 位于不同控制流上下文",
        "逐个消除画像中的 switch，保持 selector、外层条件、迭代对象与执行次数，不无条件合并",
      );
    }
    if (a.branchCountMismatch) {
      add(
        "DETECTOR_COUNT_MISMATCH",
        "medium",
        `消息 ${a.reportedBranchCount} 分支，源码 ${a.branchCount}`,
      );
      constrain(
        "TRUST_SOURCE_LABELS",
        "源码与检测器计数冲突",
        "按当前源码及完整 case 标签逐项重构，不按消息头删减分支",
      );
    }
    if (a.executableFallthrough?.length) {
      add(
        "EXECUTABLE_FALLTHROUGH",
        "high",
        "执行后落入下一分支：" + a.executableFallthrough.join(", "),
      );
      constrain(
        "PRESERVE_FALLTHROUGH_SEQUENCE",
        "fall-through 不是独立行为",
        "保持执行序列，不直接改为独立 Map 项",
      );
    }
    if (a.groupedCaseLabels?.length)
      constrain(
        "PRESERVE_GROUPED_CASES",
        "空 case 标签共享后续行为",
        "每个分组标签继续解析到相同值或处理器",
      );
    if (a.hasAsyncWork) {
      add("ASYNC_HANDLER_CHANGE", "high", "分支包含 await");
      constrain(
        "PRESERVE_ASYNC_CONTRACT",
        "抽取可能改变完成和异常时机",
        "保持 await、Promise 返回、异常传播和副作用顺序",
      );
    }
    if (a.stateWrites?.length) {
      add(
        "BRANCH_STATE_WRITE",
        "high",
        "分支写 this 状态：" + a.stateWrites.join(", "),
      );
      constrain(
        "PRESERVE_HANDLER_CONTEXT",
        "函数表可能丢失 this 或改变捕获时机",
        "保留 this、参数、状态写入次数和顺序，优先具名方法",
      );
    }
    if (a.conditionalType === "if-else-chain")
      constrain(
        "PRESERVE_CONDITION_EVALUATION",
        "条件具有短路和副作用",
        "保持从左到右求值和最终 else；仅同键纯等值比较可直接改为 Map",
      );
    constrain(
      "PRESERVE_FALLBACK",
      "查表可能改变缺失/default 行为",
      "精确保留未匹配输入行为，不新增默认值、异常、日志或重置",
    );
    constrain(
      "SAFE_TABLE_LOOKUP",
      "对象键会字符串化，|| 会误判合法值",
      "枚举/数字/对象键优先 Map，Map.has 区分缺失；不使用 value || fallback",
    );
  }
  return {
    schemaVersion: "1.1",
    taskId: task.task_id,
    riskLevel: risks.some((r) => r.level === "high")
      ? "high"
      : risks.length
        ? "medium"
        : "low",
    target: { filePath: task.target.file_path, symbol, owner, ...declaration },
    callers: {
      total: callers.length,
      production: callers.length,
      test: 0,
      items: callers,
    },
    risks,
    recommendedConstraints: constraints,
    ...(analysis ? { [key]: analysis } : {}),
    analysisLimitations: [
      "文本级调用扫描可能遗漏反射、字符串注册及跨语言调用",
      "public/export 与职责判断为保守词法近似，尚未接入跨文件类型解析",
    ],
  };
}
export function reviewRisk(risk: Json): Json {
  const { callers, ...rest } = risk;
  return {
    ...rest,
    risks: (risk.risks ?? []).filter(
      (r: Json) =>
        !["CALL_SITE_BREAK", "TEST_REFERENCE_BREAK", "TEST_CALLERS"].includes(
          r.code,
        ),
    ),
    recommendedConstraints: (risk.recommendedConstraints ?? []).filter(
      (c: Json) => c.code !== "KEEP_COMPATIBILITY_ENTRY",
    ),
  };
}
