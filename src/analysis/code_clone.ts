import path from "node:path";
import crypto from "node:crypto";
import { diffArrays, diffChars } from "diff";
import type { RefactorTask, Json } from "../models.js";
import { isFile, readText, slash, unique } from "../utils.js";
import { CLONE_DETECTOR_RULES } from "./detector_rules.js";
import { longLiteralSegments, sharedLiteralGroups } from "./literals.js";
import { lineAt, mask, matching, rangeText } from "./source.js";
import { METHOD, braceDepths } from "./god_class.js";
import { cloneReactiveEvidence, type CloneMember } from "./clone_reactivity.js";
const STRING_LITERAL =
  /^(?:"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*`)$/;
const STRINGS = /(['"])(?:\\.|(?!\1)[^\\\r\n])*\1|`(?:\\.|[^`])*`/g;
const digest = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
/**
 * Whole-file `.id(...)` call sites, keeping the full argument expression.
 * Report ranges can end before a chained `.id()` modifier, so this is
 * preservation evidence for the file rather than an edit scope.
 */
export function uiIdEvidence(text: string): Json[] {
  const masked = mask(text),
    evidence: Json[] = [];
  for (const match of masked.matchAll(/\.id\s*\(/g)) {
    const start = match.index! + match[0].length;
    let depth = 1,
      end = start;
    while (end < masked.length && depth) {
      if (masked[end] === "(") depth++;
      else if (masked[end] === ")") depth--;
      end++;
    }
    if (depth) continue;
    evidence.push({
      line: lineAt(text, match.index!),
      expression: text.slice(start, end - 1).trim(),
    });
  }
  return evidence;
}
/** Literals containing private-use or format characters must not be retyped. */
export function sensitiveLiteralEvidence(text: string): Json[] {
  return [...text.matchAll(STRINGS)]
    .filter((match) => /[\p{Co}\p{Cf}]/u.test(match[0]))
    .map((match) => ({ line: lineAt(text, match.index!), literal: match[0] }));
}
function instance(
  file: string,
  start: number | null,
  end: number | null,
  source: string,
  role: string,
  resolved: boolean,
): Json {
  const fragment = resolved ? rangeText(source, start, end) : "",
    code = mask(fragment),
    shape = code
      .replace(/\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g, "NUM")
      .replace(/\b[A-Za-z_$][\w$]*\b/g, "ID")
      .replace(/\s+/g, "");
  const matches = (re: RegExp, text = code) =>
    unique([...text.matchAll(re)].map((m) => m[1])).sort();
  const maskedLines = mask(source).split("\n"),
    fragmentIds = uiIdEvidence(fragment);
  return {
    role,
    filePath: file,
    startLine: start,
    endLine: end,
    resolved,
    lineCount: fragment ? fragment.trimEnd().split("\n").length : 0,
    rawFingerprint: digest(fragment),
    shapeFingerprint: digest(shape),
    _shape: shape,
    uiIds: unique(
      fragmentIds
        .map((item) => String(item.expression))
        .filter((expression) => STRING_LITERAL.test(expression))
        .map((expression) => expression.slice(1, -1)),
    ).sort(),
    // Report ranges can end before a chained .id() modifier. Include the
    // whole file's call sites as preservation evidence, not an edit scope.
    uiIdEvidence: resolved ? uiIdEvidence(source) : [],
    sensitiveLiteralEvidence: resolved ? sensitiveLiteralEvidence(source) : [],
    longLiteralSegments: resolved
      ? longLiteralSegments(source, start, end)
      : [],
    thisReferences: matches(/\bthis\.([A-Za-z_$][\w$]*)/g),
    stateWrites: matches(
      /\bthis\.([A-Za-z_$][\w$]*)\s*(?:[+\-*/%]?=|\+\+|--)/g,
    ),
    callbacks: matches(/\.((?:on|aboutTo)[A-Z][A-Za-z0-9_$]*)\s*\(/g),
    hasAsyncWork: /\bawait\b/.test(code),
    hasNavigation:
      /\b(?:router|navigator)\.[A-Za-z_$][\w$]*|\b(?:pushUrl|replaceUrl|back)\s*\(/.test(
        code,
      ),
    stringLiterals: unique(
      [
        ...fragment.matchAll(
          /(['"])(?:\\.|(?!\1)[^\\\r\n])*\1|`(?:\\.|[^`])*`/g,
        ),
      ].map((m) => m[0].slice(1, -1).slice(0, 120)),
    ).sort(),
    entryPointHints: source
      .split("\n")
      .flatMap((line, i) =>
        /\bexport\b|\bstatic\s+(?:(?:readonly|get|set)\s+)*[A-Za-z_$][\w$]*|@(?:Entry|ComponentV2|Component|CustomDialog|Builder|LocalBuilder)\b|\bCustomDialogController\s*\(/.test(
          maskedLines[i] ?? "",
        )
          ? [{ line: i + 1, declaration: line.trim().slice(0, 160) }]
          : [],
      ),
  };
}
/** Compare trimmed source lines for navigation only. Keep both original coordinates. */
function alignedLines(lines: string[], first: Json, other: Json): string[] {
  const extract = (instance: Json) =>
    lines.slice(instance.startLine - 1, instance.endLine).map(line => line.trim());
  const changes = diffArrays(extract(first), extract(other), { maxEditLength: 300 }) ?? [];
  let left = first.startLine, right = other.startLine;
  const shared: { count: number; hint: string }[] = [], differences: string[] = [], changedBlocks: string[] = [];
  for (const [index, part] of changes.entries()) {
    if (!part.added && !part.removed && part.count >= 2 && part.value.some(line => /\w/.test(line))) {
      shared.push({ count: part.count, hint: '连续相同行（忽略行首尾空白）L' + left + '–' + (left + part.count - 1) +
        ' ↔ L' + right + '–' + (right + part.count - 1) });
    }
    const next = changes[index + 1];
    if (part.removed && part.count === 1 && next?.added && next.count === 1 &&
        part.value[0].length <= 140 && next.value[0].length <= 140) {
      differences.push('差异行 L' + left + ' ' + part.value[0] + ' ↔ L' + right + ' ' + next.value[0]);
    } else if (part.removed && next?.added) {
      changedBlocks.push('差异块 L' + left + '–' + (left + part.count - 1) + ' ↔ L' + right + '–' +
        (right + next.count - 1) + '，分别从 ' + part.value[0].slice(0, 80) + ' / ' + next.value[0].slice(0, 80) + ' 开始');
    }
    if (!part.added) left += part.count;
    if (!part.removed) right += part.count;
  }
  return [...shared.sort((a, b) => b.count - a.count).slice(0, 2).map(s => s.hint), ...[...differences, ...changedBlocks].slice(0, 4)];
}

function sameHostExtraction(source: string, instances: Json[]): { hints: string[]; reactive?: Json } | null {
  const code = mask(source), lines = source.split(/\r?\n/);
  if (instances.some(i => !Number.isInteger(i.startLine) || !Number.isInteger(i.endLine) ||
    i.startLine < 1 || i.endLine < i.startLine || i.endLine > lines.length)) return null;
  for (const owner of code.matchAll(/\b(class|struct)\s+([\w$]+)(?:\s+[^{};]+)?\s*\{/g)) {
    const open = owner.index! + owner[0].length - 1, close = matching(code, open);
    if (close < 0) continue;
    const first = lineAt(code, open), last = lineAt(code, close);
    if (!instances.every(i => first <= i.startLine && i.endLine <= last)) continue;
    const body = code.slice(open, close + 1);
    if (/\b(?:class|struct)\s+[\w$]+/.test(body)) continue;
    const depths = braceDepths(body);
    const members: CloneMember[] = [];
    for (const method of body.matchAll(METHOD)) {
      const brace = method.index! + method[0].length - 1;
      if (depths[brace] !== 1) continue;
      const end = matching(body, brace);
      if (end < 0) continue;
      const declaration = method.index! + method[0].search(/\S/);
      const declarationLine = lineAt(code, open + declaration);
      let start = declarationLine;
      // Detector ranges may start on a blank line or the member decorator.
      // Extend ownership only. Never alter the fragment used for comparison.
      while (start > first + 1) {
        const previous = lines[start - 2].trim();
        if (previous && !/^@[\w$]+(?:\([^()\r\n]*\))?$/.test(previous)) break;
        start--;
      }
      members.push({ name: method[2], start, declarationLine, end: lineAt(code, open + end), parameters: method[3],
        ui: owner[1] === 'struct' && (method[2] === 'build' || /@(?:Local)?Builder\s*$/.test(body.slice(0, declaration))) });
    }
    const located = instances.map(i => members.filter(m =>
      m.start <= i.startLine && m.declarationLine <= i.endLine && i.endLine <= m.end));
    // Ambiguous/incomplete ownership keeps the existing generic recommendation.
    if (located.some(matches => matches.length !== 1)) continue;
    const [head, ...others] = instances;
    return { hints: [
      owner[1] + ' ' + owner[2] + ' 内的成员：' + located.map(([m], index) =>
        m.name + '（实例 L' + instances[index].startLine + '–' + instances[index].endLine + '）').join('；'),
      located.every(([m]) => m.ui)
        ? '先在当前宿主内提取成员 @Builder，沿用原 this、响应式读取与事件时机。'
        : '先检查是否可提取当前类内的方法，保留调用点的静态/实例上下文、副作用与控制流。',
      '在源码中确认完整表达式和链式修饰符边界，仅参数化已核实的差异。以下为部分行级线索。',
      ...others.slice(0, 3).flatMap(other => alignedLines(lines, head, other)),
    ], reactive: cloneReactiveEvidence(source, owner[1] + ' ' + owner[2], open, close, instances, located.map(([member]) => member)) };
  }
  return null;
}

export function analyzeCodeClone(task: RefactorTask, source: string): Json {
  const instances = [
    instance(
      task.target.file_path,
      task.target.range.start_line,
      task.target.range.end_line,
      source,
      "target",
      true,
    ),
  ];
  for (const related of task.target.related_targets) {
    const file = slash(related.filePath ?? "");
    let candidate = path.resolve(task.workspace_root, file);
    if (
      !isFile(candidate) &&
      task.source_project &&
      !file.startsWith(task.source_project + "/")
    )
      candidate = path.resolve(task.workspace_root, task.source_project, file);
    const ok = isFile(candidate);
    instances.push(
      instance(
        file,
        related.range?.startLine ?? null,
        related.range?.endLine ?? null,
        ok ? readText(candidate) : "",
        "related",
        ok,
      ),
    );
  }
  const available = instances.filter((i) => i.resolved),
    sameFile = unique(instances.map((i) => i.filePath)).length === 1;
  const similarity =
    available.length < 2
      ? null
      : Math.round(
          Math.min(
            ...available.slice(1).map((i) => {
              const a: string = available[0]._shape,
                b: string = i._shape;
              const equal = diffChars(a, b)
                .filter((p) => !p.added && !p.removed)
                .reduce((n, p) => n + p.value.length, 0);
              return a.length + b.length
                ? (2 * equal) / (a.length + b.length)
                : 1;
            }),
          ) * 1000,
        ) / 1000;
  let result: string[];
  if (available.length !== instances.length)
    result = [
      "COUNTERPART_UNRESOLVED",
      "CONFIRM_COUNTERPART_BEFORE_EXTRACTION",
      "对照片段不完整；先补齐证据，不能把局部修改误判为完整克隆消除。",
    ];
  else if (available.length < 2)
    result = [
      "SINGLE_INSTANCE",
      "LOCAL_EXTRACTION_AFTER_CONFIRMATION",
      "检测消息没有可解析对照片段，无法自动确定共享边界。",
    ];
  else if (unique(available.map((i) => i.rawFingerprint)).length === 1)
    result = [
      "EXACT",
      sameFile
        ? "EXTRACT_PRIVATE_BUILDER_OR_METHOD"
        : "EXTRACT_SHARED_COMPONENT_OR_HELPER",
      "所有片段文本相同；可抽取共同实现，但仍须保持每处调用的上下文与生命周期。",
    ];
  else if (unique(available.map((i) => i._shape)).length === 1)
    result = [
      "TYPE_2_PARAMETERIZABLE",
      "PARAMETERIZED_BUILDER_OR_HELPER",
      "控制结构相同而标识符、字面量或回调存在差异；应把差异显式参数化。",
    ];
  else if (similarity! >= 0.6)
    result = [
      "STRUCTURAL_VARIANT",
      "EXTRACT_COMMON_SKELETON_WITH_EXPLICIT_CALLBACKS",
      "片段有共同骨架但并非完全同形；只抽取可证明等价的骨架，保留各自控制流。",
    ];
  else
    result = [
      "DIVERGENT_OR_STALE",
      "DO_NOT_FORCE_MERGE",
      "当前代码的词法骨架相似度较低；先确认检测基线与当前源码，再决定是否进行最小局部重构。",
    ];
  const dimensions =
    available.length < 2
      ? []
      : [
          ["ui-id", "uiIds"],
          ["callback", "callbacks"],
          ["this-reference", "thisReferences"],
          ["state-write", "stateWrites"],
          ["string-literal", "stringLiterals"],
          ["async-work", "hasAsyncWork"],
          ["navigation", "hasNavigation"],
        ]
          .filter(
            ([, field]) =>
              unique(available.map((i) => JSON.stringify(i[field]))).length > 1,
          )
          .map(([kind, field]) => ({
            kind,
            instances: available.map((i) => ({
              filePath: i.filePath,
              range: `${i.startLine}-${i.endLine}`,
              value: i[field],
            })),
          }));
  const preserve = [
    "原文件导出与类/组件/Builder 入口、构造方式、公共签名及 ClassName.instance 等静态访问方式",
    "各实例独立状态、对象身份及原有初始化/清理时机",
    "所有实例的调用位置、条件边界和片段执行次数",
  ];
  for (const [field, text] of [
    ["uiIds", "每个实例各自的 .id(...) 字面值和生成时机"],
    ["callbacks", "每个实例的事件回调、闭包捕获和 this 绑定"],
    ["stateWrites", "每个实例 this 状态写入的字段、次数和顺序"],
    ["hasAsyncWork", "await 位置、异常传播和异步副作用顺序"],
    ["hasNavigation", "原有导航触发条件；不得为共用组件新增整行点击或导航"],
  ])
    if (
      instances.some((i) =>
        Array.isArray(i[field]) ? i[field].length : i[field],
      )
    )
      preserve.push(text);
  if (dimensions.length) preserve.push("静态画像列出的每一项实例差异");
  if (available.length !== instances.length)
    preserve.push("缺失对照片段定位完成前不得声称完整克隆组已消除");
  const key = instances
    .map((i) => `${i.filePath}:${i.startLine}-${i.endLine}`)
    .sort()
    .join("|");
  const localProfile = sameFile && available.length === instances.length && instances.length >= 2 &&
    result[0] !== "DIVERGENT_OR_STALE" ? sameHostExtraction(source, instances) : null;
  const localHints = localProfile?.hints ?? [];
  instances.forEach((i) => delete i._shape);
  return {
    groupId: "clone-" + digest(key).slice(0, 12),
    detectorRules: CLONE_DETECTOR_RULES,
    detectorCloneKind:
      /Code\s+Clone\s+(Type-\d+)/i.exec(task.message)?.[1].toUpperCase() ??
      null,
    detectorContext:
      /Code\s+Clone\s+Type-\d+\s*\(([^)]+)\)/i.exec(task.message)?.[1] ?? null,
    instanceCount: instances.length,
    resolvedInstanceCount: available.length,
    instances,
    sharedLiteralGroups: sharedLiteralGroups(instances),
    ...(localProfile?.reactive ? { reactiveExtraction: localProfile.reactive } : {}),
    classification: result[0],
    similarity,
    variationDimensions: dimensions,
    recommendedPattern: result[1],
    recommendationReason: result[2],
    refactoringPolicy: {
      ...(localHints.length ? { sameHostExtraction: localHints } : {}),
      preferredApproach: sameFile
        ? "同文件优先局部抽取：同一 class/struct 内提取私有方法或成员 @Builder；不同所属类型或顶层 Builder 保留各自入口并委托文件内共享实现。"
        : "跨文件优先保留各原类/组件及其入口，用组合或委托共用内部 Helper；确认类型、状态所有权和生命周期再考虑共享基类或组件。",
      constraints: [
        "保留原文件路径下具名/默认导出、类名、组件/Builder 名、构造方式、公共成员签名、可见性和读写能力；直接文件导入同样属于契约。测试不可见或修改了生产调用方，不是删除旧入口的依据。",
        "保留 ClassName.instance 等静态方法/字段/getter/setter 调用形式；不得以导出常量或共享类替换原类；保留每个实例独立状态、对象身份、惰性初始化和清理时机，不合并单例或提前初始化。",
        "保留 @Entry 页面、路由、宿主根节点、组件/Builder 调用入口和各实例 UI ID。保持状态所属组件、this 和生命周期；依赖宿主的 Builder 调用与 CustomDialogController 构造优先留在原组件。",
        "原入口可变为薄委托；若外壳仍被判克隆，继续抽取内部共同逻辑并保留差异，不删除入口、不只改名换行、不放宽规则。不能同时兼容与消除时明确报告冲突。",
      ],
    },
    modificationBoundary: {
      requiredFiles: unique(instances.map((i) => i.filePath)),
      crossFile: !sameFile,
      rule: "必须同轮处理所有已解析片段；不得留下等价克隆。",
    },
    mustPreserve: preserve,
    postConditions: [
      "逐项对照原文件导出、类/组件/Builder、构造方式和静态访问；旧调用形式继续有效。",
      "逐实例保留 UI ID、文案、资源、回调、状态读写和副作用顺序。",
      "修改和新增生产文件复检；若仍报告该克隆组，按剩余实例定向修复，不只改名、换行或移动原样代码。",    ],
    limitations: [
      "词法画像不能证明跨文件类型、生命周期、闭包和资源引用行为等价",
      "检测消息只提供直接对照片段；额外实例需纳入下一轮",
      "入口线索不是完整 API 清单，未发现调用方不代表入口可删除",
    ],
  };
}
export function codeCloneConstraints(
  task: RefactorTask,
  a: Json,
): [Json[], Json[]] {
  const affectedFiles = a.modificationBoundary.requiredFiles,
    risks: Json[] = [],
    constraints: Json[] = [];
  const add = (code: string, level: string, evidence: string) =>
    risks.push({ code, level, evidence, affectedFiles });
  add(
    "CLONE_GROUP_INCOMPLETE",
    "high",
    `${a.groupId} 含 ${a.instanceCount} 个已知片段；仅重构首个片段通常无法通过 HomeCheck。`,
  );
  constraints.push(
    {
      code: "ELIMINATE_WHOLE_CLONE_GROUP",
      reason: "残留实例可能继续命中",
      instruction: "同轮处理全部已知实例，保留各自差异",
    },
    {
      code: "PRESERVE_CLONE_VARIATIONS",
      reason: "字面量、ID、回调和状态差异常是业务语义",
      instruction: "把差异显式作为参数、回调或配置传入，不用统一默认值抹平差异",
    },
    {
      code: "PRESERVE_CLONE_ENTRYPOINTS",
      reason: "直接文件导入与静态入口属于契约",
      instruction: "保留原文件路径、原入口与调用形式，只抽取内部共同实现",
    },
  );
  if (a.instances.some((i: Json) => i.entryPointHints.length))
    add(
      "CLONE_ENTRYPOINT_CHANGE",
      "high",
      "生产文件包含导出、静态入口或 ArkUI 宿主线索",
    );
  if (a.resolvedInstanceCount < a.instanceCount) {
    add("CLONE_COUNTERPART_UNRESOLVED", "high", "至少一个对照片段未解析");
    constraints.push({
      code: "CONFIRM_COUNTERPART_BEFORE_EXTRACTION",
      reason: "缺少对照片段",
      instruction: "先定位缺失片段，确认前不得声称完整消除",
    });
  }
  if (a.instances.some((i: Json) => i.uiIds.length)) {
    add(
      "UI_SELECTOR_CHANGE",
      "high",
      "克隆组包含 .id(...)，UI 查询依赖原选择器",
    );
    constraints.push({
      code: "PRESERVE_PER_INSTANCE_UI_ID",
      reason: "抽取可能错误统一 ID",
      instruction: "逐实例保留 .id 值与生成时机，作为显式输入而非新默认值",
    });
  }
  if (
    a.instances.some((i: Json) => i.callbacks.length || i.stateWrites.length)
  ) {
    add(
      "CLONE_CALLBACK_OR_STATE_VARIATION",
      "high",
      "克隆组含事件回调或状态写入",
    );
    constraints.push({
      code: "PRESERVE_CALLBACK_AND_STATE_ORDER",
      reason: "闭包、this 与顺序易变化",
      instruction:
        "保留回调、状态写入次数、await 和副作用顺序；不新增导航或状态重置",
    });
  }
  if (a.modificationBoundary.crossFile) {
    add("CROSS_FILE_CLONE_EXTRACTION", "medium", "跨文件共享需要保持依赖方向");
    constraints.push({
      code: "MINIMIZE_SHARED_HELPER_SCOPE",
      reason: "共享实现可能扩大依赖",
      instruction: "优先现有中立层；不能证明安全时保留入口，仅抽取可验证骨架",
    });
  }
  return [risks, constraints];
}
