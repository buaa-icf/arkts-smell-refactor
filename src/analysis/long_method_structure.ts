import type { Json, RefactorTask } from "../models.js";
import { escapeRe } from "../utils.js";
import { braceDepths } from "./god_class.js";
import { controls, lineAt, mask, matching, splitParameters } from "./source.js";

type Member = {
  name: string;
  start: number;
  open: number;
  end: number;
  argsOpen: number;
  argsEnd: number;
  builder: boolean;
};
type Host = {
  name: string;
  kind: string;
  open: number;
  end: number;
  uiDecorator: string | null;
};
type Node = {
  name: string;
  start: number;
  end: number;
  parent: string;
  count: number;
};
const short = (s: string, limit = 180) =>
  s.length <= limit ? s : s.slice(0, limit) + "…";
const countLines = (s: string) =>
  mask(s, false)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^[{}]$/.test(l.trim())).length;

/** Bounded lexical evidence, never an ArkTS parser or an extraction safety proof. */
export function longMethodStructure(task: RefactorTask, source: string): Json {
  const unavailable = (reason: string) => ({ status: "unresolved", reason });
  if (!source || source.length > 500_000)
    return unavailable("源码缺失或超过 500000 字符，只使用原报告定位。");
  const symbol = task.target.symbol?.split(".").at(-1) ?? "";
  const anonymous = /^%AM\d+\$/.test(symbol),
    name = symbol.replace(/^%AM\d+\$/, "");
  if (!/^[\w$]+$/.test(name))
    return unavailable("未识别具名方法；不猜测抽取边界。");
  const code = mask(source),
    depths = braceDepths(code),
    hosts: Host[] = [],
    members: Member[] = [];
  // The shared masker does not tokenize RegExp literals. Fail closed rather than
  // interpreting their braces/parentheses as method or component boundaries.
  if (/(?:[=(,:!&|?;{}]|\breturn|^|\n)\s*\/(?![/*=])/m.test(code))
    return unavailable(
      "可能含正则字面量，当前词法边界分析不支持；使用原范围与源码核对。",
    );
  for (const m of code.matchAll(
    /\b(class|struct)\s+([\w$]+)(?:\s+extends\s+[\w$.<>]+)?\s*\{/g,
  )) {
    const open = m.index! + m[0].length - 1,
      end = matching(code, open);
    const decorator =
      /@(Component(?:V2)?|CustomDialog)(?:\s*\([^()]*\))?\s*(?:@\w+(?:\([^()]*\))?\s*)*(?:export\s+)?$/.exec(
        code.slice(0, m.index!),
      );
    if (end >= 0)
      hosts.push({
        kind: m[1],
        name: m[2],
        open,
        end,
        uiDecorator: decorator ? "@" + decorator[1] : null,
      });
  }
  const ownerOf = (offset: number) =>
    hosts
      .filter((h) => h.open < offset && offset < h.end)
      .sort((a, b) => b.open - a.open)[0];
  // Only declarations at file/host depth. Balanced parameters support callback and object types.
  for (const m of code.matchAll(
    /^[ \t]*(?:(?:export|default|public|private|protected|static|async|override)\s+)*(?:function\s+)?([\w$]+)\s*\(/gm,
  )) {
    const start = m.index! + m[0].search(/\S/),
      owner = ownerOf(start);
    if (depths[start] !== (owner ? depths[owner.open] + 1 : 0)) continue;
    const argsOpen = m.index! + m[0].lastIndexOf("("),
      argsEnd = matching(code, argsOpen, "(", ")");
    if (argsEnd < 0) continue;
    // Complex return type literals / generic method declarations deliberately fall back.
    const tail = /^\s*(?::\s*[\w$][\w$.<>[\], |?]*)?\s*\{/.exec(
      code.slice(argsEnd + 1),
    );
    if (!tail) continue;
    const open = argsEnd + 1 + tail[0].lastIndexOf("{"),
      end = matching(code, open);
    if (end < 0 || (owner && end >= owner.end)) continue;
    const builder = /@(?:LocalBuilder|Builder)\s*$/.test(code.slice(0, start));
    members.push({ name: m[1], start, open, end, argsOpen, argsEnd, builder });
  }
  const { start_line: start, end_line: end } = task.target.range;
  const located = members.filter(
    (m) =>
      m.name === name &&
      (!start ||
        !end ||
        (lineAt(source, m.start) <= end && lineAt(source, m.end) >= start)),
  );
  if (located.length !== 1) {
    const rangeMembers = members.filter(
      (m) =>
        start &&
        end &&
        lineAt(source, m.start) <= start + 1 &&
        lineAt(source, m.end) >= end,
    );
    const hint =
      rangeMembers.length === 1
        ? `报告范围目前落在 ${rangeMembers[0].name} L${lineAt(source, rangeMembers[0].start)}–${lineAt(source, rangeMembers[0].end)}，需核对旧报告与当前源码。`
        : "";
    return unavailable(
      "符号与报告范围不能唯一定位受支持的方法声明；按原源码核对，不选择第一个同名方法。" +
        hint,
    );
  }
  const member = located[0],
    owner = ownerOf(member.start);
  const target = {
    name,
    owner: owner?.name ?? null,
    startLine: lineAt(source, member.start),
    endLine: lineAt(source, member.end),
  };
  if (anonymous)
    return {
      status: "enclosing-only",
      target,
      reason:
        "%AM 编号的匿名回调身份无法由词法分析确认；这里只定位外围成员，不生成外围成员的抽取候选。保持循环回调参数、key、索引和容器位置。",
    };
  if (member.end - member.start > 30_000)
    return unavailable("目标超过 30000 字符，不生成可能不完整的结构建议。");
  const text = source.slice(member.start, member.end + 1),
    body = code.slice(member.open + 1, member.end);
  const params = splitParameters(
    source.slice(member.argsOpen + 1, member.argsEnd),
  );
  const bindings = [
    ...new Set([
      ...params.flatMap((p) => /^\s*([\w$]+)\s*[?:]/.exec(p)?.[1] ?? []),
      ...[...body.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)].map((m) => m[1]),
    ]),
  ];
  const ui =
    member.builder ||
    (name === "build" &&
      owner?.kind === "struct" &&
      Boolean(owner.uiDecorator));
  const nodes: Node[] = [];
  // Traverse component child bodies only. Calls (including ForEach/event callbacks),
  // unknown blocks and object literals stay intact; never propose their nested fragments.
  const walk = (from: number, to: number, parent: string, level = 0) => {
    if (level > 30) return;
    for (let p = from; p < to;) {
      if (/\s/.test(code[p])) {
        p++;
        continue;
      }
      const head = /^[A-Z][\w$]*\s*\(/.exec(code.slice(p, to));
      if (
        head &&
        /^[ \t]*$/.test(code.slice(code.lastIndexOf("\n", p - 1) + 1, p))
      ) {
        const argsOpen = p + head[0].lastIndexOf("("),
          argsEnd = matching(code, argsOpen, "(", ")");
        if (argsEnd < 0 || argsEnd >= to) break;
        let last = argsEnd,
          q = argsEnd + 1,
          childOpen = -1,
          childEnd = -1;
        while (/\s/.test(code[q] ?? "") && q < to) q++;
        if (code[q] === "{") {
          childOpen = q;
          childEnd = matching(code, q);
          if (childEnd < 0 || childEnd >= to) break;
          last = childEnd;
          q = childEnd + 1;
        }
        let complete = true;
        while (q < to) {
          while (/\s/.test(code[q] ?? "") && q < to) q++;
          if (code[q] !== ".") break;
          const modifier = /^\.\s*[\w$]+\s*\(/.exec(code.slice(q, to));
          if (!modifier) {
            complete = false;
            break;
          }
          const close = matching(
            code,
            q + modifier[0].lastIndexOf("("),
            "(",
            ")",
          );
          if (close < 0 || close >= to) {
            complete = false;
            break;
          }
          last = close;
          q = close + 1;
        }
        if (!complete) {
          p = q + 1;
          continue;
        }
        if (code[last + 1] === ";") last++;
        const lineEnd = code.indexOf("\n", last + 1);
        const trailing = code.slice(
          last + 1,
          Math.min(to, lineEnd < 0 ? to : lineEnd),
        );
        if (!/^\s*}*\s*$/.test(trailing)) {
          p = last + 1;
          continue;
        }
        const nodeName = head[0].split(/\s*\(/)[0];
        const count = countLines(source.slice(p, last + 1));
        // Keep layout-specific item roots in their original parent. Their descendants
        // are also excluded here rather than guessing what ArkUI may move safely.
        const fixedItem =
          /^(?:GridItem|ListItem|ListItemGroup|TabContent|SwiperItem)$/.test(
            nodeName,
          );
        if (!fixedItem) {
          nodes.push({ name: nodeName, start: p, end: last, parent, count });
          if (childOpen >= 0)
            walk(childOpen + 1, childEnd, nodeName, level + 1);
        }
        p = last + 1;
      } else if ("({[".includes(code[p])) {
        const close = matching(
          code,
          p,
          code[p],
          { "(": ")", "{": "}", "[": "]" }[code[p]]!,
        );
        if (close < 0) break;
        p = close + 1;
      } else p++;
    }
  };
  if (ui) walk(member.open + 1, member.end, name);
  const selected: Node[] = [];
  const targetCount = countLines(text);
  // These are UI-only candidates. Leave room below the default soft limit of 80,
  // or a lower reported Max; prefer a coherent larger subtree over many tiny helpers.
  const candidateLimit = Math.min(
    65,
    Number(/Max:\s*(\d+)/i.exec(task.message)?.[1] ?? 80) - 8,
  );
  for (const node of nodes
    .filter(
      (n) =>
        n.count >= 8 && n.count <= candidateLimit && n.count < targetCount - 3,
    )
    .sort((a, b) => b.count - a.count || a.start - b.start)) {
    if (selected.every((n) => node.end < n.start || node.start > n.end))
      selected.push(node);
    if (selected.length === 6) break;
  }
  const refs = new Map<
    string,
    { expression: string; root: string; lines: number[] }
  >();
  for (const m of body.matchAll(
    /\bthis\s*(?:\?\.|\.)\s*([\w$]+)(?:\s*(?:\?\.|\.)\s*[\w$]+)*/g,
  )) {
    // Member calls have their own signature evidence below; nested calls still
    // carry useful state-object evidence, without claiming to be plain reads.
    if (
      /^\s*\(/.test(body.slice(m.index! + m[0].length)) &&
      !/[.?]\s*[\w$]+\s*[.?]/.test(m[0])
    )
      continue;
    const expression = m[0].replace(/\s+/g, ""),
      item = refs.get(expression) ?? { expression, root: m[1], lines: [] };
    const line = lineAt(source, member.open + 1 + m.index!);
    if (item.lines.length < 3 && !item.lines.includes(line))
      item.lines.push(line);
    refs.set(expression, item);
  }
  const fields = new Map<string, Json>();
  if (owner) {
    const hostBody = code.slice(owner.open + 1, owner.end);
    for (const m of hostBody.matchAll(
      /^[ \t]*((?:@\w+(?:\([^)]*\))?\s*)*)(?:(?:public|private|protected|readonly|static)\s+)*([\w$]+)[!?]?[ \t]*(?::[ \t]*([^=;\r\n]+))?[ \t]*(?:=|;|(?=\r?$))/gm,
    )) {
      const offset = owner.open + 1 + m.index! + m[0].search(/\S/);
      if (depths[offset] === depths[owner.open] + 1)
        fields.set(m[2], {
          line: lineAt(source, offset),
          decorators: [...m[1].matchAll(/@(\w+)/g)].map((d) => d[1]),
          type: short(m[3]?.trim() ?? "未显式声明", 120),
        });
    }
  }
  const accesses = [...refs.values()].sort(
    (a, b) =>
      Number(b.expression.split(".").length > 2) -
      Number(a.expression.split(".").length > 2),
  );
  const calls = new Set(
    [...body.matchAll(/\bthis\s*\.\s*([\w$]+)\s*\(/g)].map((m) => m[1]),
  );
  const helpers = owner
    ? members.filter(
        (m) => m !== member && calls.has(m.name) && ownerOf(m.start) === owner,
      )
    : [];
  return {
    status: "located",
    target,
    uiEvidence: member.builder
      ? "@Builder/@LocalBuilder"
      : ui
        ? `${owner!.uiDecorator} struct build`
        : "未确认 UI 分类",
    estimatedSourceLines: targetCount,
    parameters: params.slice(0, 8).map((p) => short(p, 200)),
    parametersTruncated: params.length > 8,
    controlFlow: controls(text),
    candidates: selected
      .sort((a, b) => a.start - b.start)
      .map((n) => ({
        node: n.name,
        parent: n.parent,
        startLine: lineAt(source, n.start),
        endLine: lineAt(source, n.end),
        estimatedSourceLines: n.count,
        bindingNames: bindings
          .filter((b) =>
            new RegExp(`\\b${escapeRe(b)}\\b`).test(
              code.slice(n.start, n.end + 1),
            ),
          )
          .slice(0, 8),
      })),
    stateAccesses: accesses
      .slice(0, 12)
      .map((r) => ({ ...r, declaration: fields.get(r.root) ?? null })),
    stateAccessesTruncated: accesses.length > 12,
    calledMembers: helpers
      .slice(0, 6)
      .map((m) => ({
        name: m.name,
        startLine: lineAt(source, m.start),
        endLine: lineAt(source, m.end),
        signature: short(source.slice(m.start, m.open).trim(), 240),
      })),
    calledMembersTruncated: helpers.length > 6,
    limitations:
      "词法预分析，只读当前文件；计数是近似值。候选只覆盖完整组件调用/子树及修饰符链，不进入回调、未知控制块或布局专属 Item；不证明可抽取或等价。绑定列表不分析作用域/别名，模板插值、动态属性及外部 @Observed/@Trace 类型关系未解析；缺少记录不证明不响应式。",
  };
}

export function longMethodStructureHints(evidence: Json): string[] {
  if (evidence.status !== "located") return [evidence.reason];
  const t = evidence.target;
  return [
    `定位：${t.owner ?? "文件顶层"}.${t.name} L${t.startLine}–${t.endLine}；UI 线索：${evidence.uiEvidence}；近似源码计数 ${evidence.estimatedSourceLines}，最终以 HomeCheck 为准。`,
    `原形参：${evidence.parameters.join("；") || "无"}${evidence.parametersTruncated ? "（仅列部分）" : ""}。保留 union、undefined 和可选性，不凭调用样例收窄类型。`,
    `控制流词法线索（含内部回调）：${evidence.controlFlow.join(", ") || "无"}；抽取前核对 return/break/continue 的作用域、await 顺序及 try/catch/finally 边界。`,
    ...evidence.candidates.map(
      (n: Json) =>
        `完整子树候选 L${n.startLine}–${n.endLine}：${n.parent} 内 ${n.node}，含修饰符链，约 ${n.estimatedSourceLines} 行；引用的局部绑定线索：${n.bindingNames.join(", ") || "未识别"}。`,
    ),
    ...(evidence.candidates.length
      ? [
          "候选互不重叠，按职责选足够的一组即可，不要求全部抽取；保留外层布局、循环、条件和 UI ID，勿只截取子树主体而遗漏修饰符。新 helper 加上签名/包装后也需复检，不能靠压缩源码行数达标。",
        ]
      : []),
    ...evidence.stateAccesses.map(
      (r: Json) =>
        `宿主访问 ${short(r.expression)} L${r.lines.join(",")}；${r.declaration ? `根字段声明 L${r.declaration.line} ${r.declaration.decorators.map((d: string) => "@" + d).join(" ")} ${r.declaration.type}` : "未解析根字段声明"}。`,
    ),
    ...(evidence.stateAccessesTruncated
      ? ["宿主访问仅列前 12 项，不是完整清单。"]
      : []),
    ...(evidence.stateAccesses.length
      ? [
          evidence.uiEvidence !== "未确认 UI 分类"
            ? "同宿主 Builder 优先保留上述 this 访问（包括嵌套属性、取反、比较和条件表达式）在原执行阶段的读取；不要预先计算成 selected/value 等普通参数。需区分选项时传静态标识，在 Builder 内读现场状态；事件内原本延迟执行的读取仍留在事件内，不因字段未标装饰器或无写入记录认定可安全传值。"
            : "普通逻辑优先抽取同宿主私有方法，保持 this 归属、属性访问及回调/异步操作的执行时机；不要把运行中会变化的成员值提前缓存到参数。",
        ]
      : []),
    ...evidence.calledMembers.map(
      (m: Json) =>
        `已调用的同宿主成员 L${m.startLine}–${m.endLine}：${m.signature}；仅为类型/调用线索，不扩大修改范围。`,
    ),
    ...(evidence.calledMembersTruncated ? ["同宿主成员签名仅列部分。"] : []),
    evidence.limitations,
  ];
}
