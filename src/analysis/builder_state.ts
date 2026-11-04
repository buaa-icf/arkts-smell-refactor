import type { Json } from "../models.js";
import { escapeRe } from "../utils.js";
import { braceDepths } from "./god_class.js";
import {
  callArguments,
  lineAt,
  mask,
  matching,
  splitParameters,
} from "./source.js";

export const BUILDER_STATE_SCOPE =
  "仅核对同名 struct 中新增的 this.Builder(this.field) 直接传递：原字段带响应式装饰器，原 UI 成员直接读取，当前 @Builder 以 string/number/boolean 形参读取。未分析别名、引用传递、闭包及框架完整语义；命中是风险证据，不单独判 FAIL，未命中也不证明等价。";
type Member = {
  name: string;
  params: string[];
  start: number;
  open: number;
  end: number;
  builder: boolean;
  ui: boolean;
};
function hosts(source: string) {
  const code = mask(source),
    result = [];
  for (const host of code.matchAll(/\bstruct\s+([\w$]+)\s*\{/g)) {
    const open = host.index! + host[0].length - 1,
      end = matching(code, open);
    if (end < 0) continue;
    const body = code.slice(open, end + 1),
      depths = braceDepths(body),
      members: Member[] = [];
    for (const m of body.matchAll(/\b([\w$]+)\s*\(/g)) {
      if (depths[m.index!] !== 1 || /[.\w$]/.test(body[m.index! - 1] ?? ""))
        continue;
      const argsOpen = open + m.index! + m[0].lastIndexOf("("),
        argsEnd = matching(code, argsOpen, "(", ")");
      if (argsEnd < 0) continue;
      const tail = /^\s*(?::[^{};=]+)?\s*\{/.exec(code.slice(argsEnd + 1));
      if (!tail) continue;
      const brace = argsEnd + 1 + tail[0].lastIndexOf("{"),
        close = matching(code, brace);
      if (close < 0 || close > end) continue;
      const prefix = body.slice(0, m.index!),
        builder = /@Builder\s*(?:(?:public|private|protected)\s+)?$/.test(
          prefix,
        );
      members.push({
        name: m[1],
        params: splitParameters(source.slice(argsOpen + 1, argsEnd)),
        start: open + m.index!,
        open: brace,
        end: close,
        builder,
        ui: builder || m[1] === "build" || /@LocalBuilder\s*$/.test(prefix),
      });
    }
    const fields = [
      ...body.matchAll(
        /((?:@\w+(?:\([^)]*\))?\s*)+)(?:(?:public|private|protected|readonly)\s+)*([\w$]+)\s*[!?]?\s*:\s*(string|number|boolean)\b/g,
      ),
    ]
      .filter(
        (m) =>
          depths[m.index!] === 1 &&
          /@(?:State|Prop|Link|StorageLink|StorageProp|Local|Param|Provide|Consume|Provider|Consumer)\b/.test(
            m[1],
          ),
      )
      .map((m) => ({
        name: m[2],
        type: m[3],
        decorators: [...m[1].matchAll(/@(\w+)/g)].map((d) => d[1]),
        line: lineAt(source, open + m.index!),
      }));
    result.push({ name: host[1], open, end, members, fields });
  }
  return result;
}

function valueCalls(source: string, host: ReturnType<typeof hosts>[number]) {
  const code = mask(source),
    result = [];
  for (const member of host.members.filter((m) => m.ui)) {
    const body = code.slice(member.open + 1, member.end);
    for (const m of body.matchAll(/\bthis\s*\.\s*([\w$]+)\s*\(/g)) {
      const start = member.open + 1 + m.index!,
        open = start + m[0].lastIndexOf("("),
        end = matching(code, open, "(", ")");
      if (end < 0 || end > member.end) continue;
      const builder = host.members.find((b) => b.builder && b.name === m[1]);
      if (!builder) continue;
      const positionalArgs = callArguments(source, open, end);
      for (const [index, arg] of positionalArgs.entries()) {
        const field = /^this\s*\.\s*([\w$]+)$/.exec(arg)?.[1];
        const parameter = /^\s*([\w$]+)\s*:\s*(string|number|boolean)\s*$/.exec(
          builder.params[index] ?? "",
        );
        if (!field || !parameter) continue;
        const use = new RegExp(
          `(?<![\\w$.])${escapeRe(parameter[1])}(?![\\w$])`,
        ).exec(code.slice(builder.open + 1, builder.end));
        if (!use) continue;
        result.push({
          key: [builder.name, index, field].join(":"),
          field,
          builder: builder.name,
          parameter: parameter[1],
          parameterType: parameter[2],
          callLine: lineAt(source, start),
          builderLine: lineAt(source, builder.start),
          parameterReadLine: lineAt(source, builder.open + 1 + use.index),
        });
      }
    }
  }
  return result;
}

export function builderStateRisks(before: string, after: string): Json[] {
  const oldHosts = hosts(before),
    code = mask(before),
    result: Json[] = [];
  for (const host of hosts(after)) {
    const originals = oldHosts.filter((h) => h.name === host.name);
    if (originals.length !== 1) continue;
    const original = originals[0],
      prior = new Set(valueCalls(before, original).map((c) => c.key));
    for (const call of valueCalls(after, host)) {
      if (prior.has(call.key)) continue;
      const field = original.fields.find((f) => f.name === call.field);
      if (!field || !host.fields.some((f) => f.name === field.name)) continue;
      const reads = original.members
        .filter((m) => m.ui)
        .flatMap((member) =>
          [
            ...code
              .slice(member.open + 1, member.end)
              .matchAll(
                new RegExp(
                  `\\bthis\\s*\\.\\s*${escapeRe(field.name)}(?![\\w$])`,
                  "g",
                ),
              ),
          ]
            .filter(
              (m) =>
                !/^\s*(?:[+*/%-]?=(?!=|>)|\+\+|--)/.test(
                  code.slice(member.open + 1 + m.index! + m[0].length),
                ),
            )
            .map((m) => lineAt(before, member.open + 1 + m.index!)),
        );
      if (!reads.length) continue;
      result.push({
        category: "reactive-builder-value-capture",
        owner: host.name,
        decorators: field.decorators,
        baselineDeclarationLine: field.line,
        baselineReadLines: [...new Set(reads)].slice(0, 8),
        ...call,
        line: call.callLine,
        reason: `响应式风险线索，非独立失败结论：原 ${host.name}.${field.name}（${field.decorators.map((d) => "@" + d).join(" ")}）在 UI 内 L${[...new Set(reads)].slice(0, 8).join(",")} 直接读取；当前 L${call.callLine} 将 this.${field.name} 传给 ${call.builder} 的普通 ${call.parameterType} 形参 ${call.parameter}，Builder 在 L${call.parameterReadLine} 读取该值，需核对状态变化后的刷新。`,
        requiredFix:
          "结合本轮失败断言核对响应式读取。优先传递静态分支标识，在同宿主 Builder 内按分支直接读取 this 字段；保留 UI ID、事件和条件，不把框架检查通过当作状态刷新等价证明。",
      });
    }
  }
  return result;
}
