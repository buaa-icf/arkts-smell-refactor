import type { Json } from "../models.js";
import { escapeRe, unique } from "../utils.js";
import { braceDepths } from "./god_class.js";
import { lineAt, mask, matching, splitParameters } from "./source.js";

export interface CloneMember {
  name: string;
  start: number;
  declarationLine: number;
  end: number;
  ui: boolean;
  parameters: string;
}
const REACTIVE =
  /^(?:State|Prop|Link|ObjectLink|Provide|Consume|StorageLink|StorageProp|Local|Param|Event|Provider|Consumer|Computed|Trace|Track)$/;
// ArkTS permits uninitialized @Link fields without a trailing semicolon.
const FIELD_DECLARATION =
  /^\s*((?:@\w+(?:\([^)]*\))?\s*)*)((?:(?:public|private|protected|static|readonly)\s+)*)([A-Za-z_$][\w$]*)[ \t]*[?!]?[ \t]*(?::[ \t]*([^=;\r\n]+))?[ \t]*(?:=|;|(?=\r?$))/gm;
const ASSIGN =
  /^\s*(?:(?:\*\*|&&|\|\||\?\?|>>>|>>|<<|[+\-*/%&|^])?=(?!=|>)|\+\+|--)/;
const MUTATOR =
  /^\s*\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)\s*\(/;

/** Bounded navigation evidence for a proven common host, not a dataflow proof. */
export function cloneReactiveEvidence(
  source: string,
  owner: string,
  open: number,
  close: number,
  instances: Json[],
  members: CloneMember[],
): Json | undefined {
  if (!members.every((member) => member.ui)) return undefined;
  const code = mask(source),
    body = code.slice(open, close + 1),
    depths = braceDepths(body);
  const ranges = instances.map((i) => ({ start: i.startLine, end: i.endLine }));
  const inClone = (line: number) =>
    ranges.some((r) => r.start <= line && line <= r.end);
  const memberAt = (line: number) =>
    members.find((m) => m.declarationLine <= line && line <= m.end)?.name ??
    null;
  const fields = [...body.matchAll(FIELD_DECLARATION)].flatMap((match) => {
    const declaration = match.index! + match[0].search(/\S/);
    if (depths[declaration] !== 1) return [];
    const decorators = [...match[1].matchAll(/@([\w$]+)/g)].map((m) => m[1]);
    const references = [
      ...body.matchAll(
        new RegExp(
          "\\bthis\\s*\\.\\s*" + escapeRe(match[3]) + "(?![\\w$])",
          "g",
        ),
      ),
    ];
    if (!references.some((ref) => inClone(lineAt(source, open + ref.index!))))
      return [];
    const writes: Json[] = [],
      readLines: number[] = [];
    for (const ref of references) {
      const index = ref.index!,
        line = lineAt(source, open + index),
        tail = body.slice(index + ref[0].length);
      const access = /^(?:\s*\[[^\]\n]*\]|\s*\.\s*[\w$]+)+/.exec(tail);
      let kind: string | undefined;
      if (
        ASSIGN.test(tail) ||
        /(?:\+\+|--)\s*$/.test(body.slice(Math.max(0, index - 8), index))
      )
        kind = "assignment-or-update";
      else if (MUTATOR.test(tail)) kind = "mutating-call-candidate";
      else if (
        access &&
        (ASSIGN.test(tail.slice(access[0].length)) ||
          /^\s*\(/.test(tail.slice(access[0].length)))
      )
        kind = "member-write-or-call-candidate";
      else readLines.push(line);
      if (kind)
        writes.push({
          line,
          kind,
          member: memberAt(line),
          inClone: inClone(line),
        });
    }
    const fieldOffset = match[0].search(
      new RegExp("\\b" + escapeRe(match[3]) + "\\s*[?!]?\\s*[:=;]"),
    );
    return [
      {
        name: match[3],
        declarationLine: lineAt(
          source,
          open + match.index! + Math.max(0, fieldOffset),
        ),
        decorators,
        reactive: decorators.some((d) => REACTIVE.test(d)),
        referenceCount: references.length,
        readLines: unique(readLines).slice(0, 8),
        writeCandidateCount: writes.length,
        writeCandidates: writes.slice(0, 8),
        truncated: writes.length > 8 || unique(readLines).length > 8,
      },
    ];
  });
  const dataSources: Json[] = [];
  for (const call of body.matchAll(/\b(?:ForEach|LazyForEach)\s*\(/g)) {
    const absolute = open + call.index!,
      line = lineAt(source, absolute);
    const instanceIndex = ranges.findIndex(
      (r) => r.start <= line && line <= r.end,
    );
    if (instanceIndex < 0) continue;
    const argumentStart = absolute + call[0].length,
      end = matching(code, argumentStart - 1, "(", ")");
    if (end < 0 || end > close) continue;
    // Locate the first argument delimiter in masked code, preserving offsets.
    let depth = 0,
      argumentEnd = end;
    for (let i = argumentStart; i < end; i++) {
      if ("([{<".includes(code[i])) depth++;
      else if (")]}>".includes(code[i])) depth--;
      else if (code[i] === "," && depth === 0) {
        argumentEnd = i;
        break;
      }
    }
    const expression = source.slice(argumentStart, argumentEnd).trim();
    if (!expression || expression.length > 160 || expression.includes("\n"))
      continue;
    const member = members[instanceIndex];
    const fieldName = /^this\s*\.\s*([\w$]+)$/.exec(
      code.slice(argumentStart, argumentEnd).trim(),
    )?.[1];
    const parameter = splitParameters(member.parameters).find(
      (p) => p.split(/[:=?]/)[0].trim() === expression,
    );
    const field = fields.find((f) => f.name === fieldName);
    dataSources.push({
      role: instances[instanceIndex].role,
      member: member.name,
      line,
      iterator: call[0].split(/\s*\(/)[0],
      expression,
      binding: fieldName
        ? "host-field"
        : parameter
          ? "member-parameter"
          : "expression",
      ...(field
        ? {
            field: field.name,
            declarationLine: field.declarationLine,
            decorators: field.decorators,
          }
        : {}),
      ...(parameter
        ? {
            parameter: parameter.trim(),
            declarationLine: member.declarationLine,
          }
        : {}),
    });
  }
  if (!fields.length && !dataSources.length) return undefined;
  const mixed =
    dataSources.some((d) => d.binding === "host-field") &&
    dataSources.some((d) => d.binding === "member-parameter");
  return {
    owner,
    scope: { startLine: lineAt(source, open), endLine: lineAt(source, close) },
    fields: fields.slice(0, 10),
    dataSources: dataSources.slice(0, 8),
    truncated: fields.length > 10 || dataSources.length > 8,
    limitations:
      "仅扫描该宿主内直接 this.field 引用；注释、字符串及模板插值不计入，未追踪别名、外部调用、框架更新或动态属性；未发现写入不代表状态不变或按值传参等价。",
    guidance: [
      ...(mixed
        ? [
            "数据源同时含宿主字段与成员形参：优先把 ForEach/LazyForEach 数据源读取和外层容器留在原入口，只抽取共同子项或事件实现；保留各入口原有 keyGenerator、UI ID 和状态读取时机。",
          ]
        : []),
      "宿主内直接读取的响应式字段优先在同宿主 Builder/回调中保留 this 读取；不为统一签名把它改成预先求值的普通参数，也不因本地无写入记录认定可安全传值。",
      "先按所列行号核对一个保留读取边界的方案；仅当该方案确实依赖外部写入、类型或调用关系时定向补查，不为证明状态永不改变而全库搜索。若剩余骨架仍构成克隆，再缩小共享边界或保留宿主读取，不能靠跳过复检声称完成。",
    ],
  };
}

export function cloneReactiveHints(evidence: Json): string[] {
  return [
    "响应式证据范围：" +
      evidence.owner +
      " L" +
      evidence.scope.startLine +
      "–" +
      evidence.scope.endLine +
      "；" +
      evidence.limitations,
    ...evidence.dataSources.map(
      (d: Json) =>
        "数据源 L" +
        d.line +
        " " +
        d.member +
        "：" +
        d.iterator +
        "(" +
        d.expression +
        ", ...)；" +
        (d.binding === "member-parameter"
          ? "成员形参 " + d.parameter
          : d.binding === "host-field"
            ? "宿主字段 " +
              d.expression +
              " " +
              (d.decorators ?? []).map((v: string) => "@" + v).join(" ")
            : "表达式，需核对求值时机") +
        (d.declarationLine ? "；声明 L" + d.declarationLine : ""),
    ),
    ...evidence.fields.map(
      (f: Json) =>
        "字段 " +
        f.name +
        " " +
        f.decorators.map((d: string) => "@" + d).join(" ") +
        " 声明 L" +
        f.declarationLine +
        "；直接引用 " +
        f.referenceCount +
        " 处；读取/传递线索 L" +
        (f.readLines.join(",") || "无") +
        "；疑似写入/调用 " +
        f.writeCandidateCount +
        " 处" +
        (f.writeCandidates.length
          ? "（" +
            f.writeCandidates
              .map((w: Json) => "L" + w.line + " " + w.kind)
              .join("；") +
            "）"
          : "（仅在上述词法范围未发现）") +
        (f.truncated ? "；位置仅列部分" : ""),
    ),
    ...(evidence.truncated
      ? ["字段/数据源条目仅列部分，不能视为完整清单。"]
      : []),
    ...evidence.guidance,
  ];
}
