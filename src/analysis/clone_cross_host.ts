import { lineAt, mask, matching } from "./source.js";
import path from "node:path";

export interface CrossHostCloneInput {
  filePath: string;
  /** Resolved path supplied by the caller; display keeps the report's path. */
  identityPath?: string;
  source: string;
  startLine: number | null;
  endLine: number | null;
  resolved: boolean;
}
interface LocatedFact { name: string; startLine: number; endLine: number }
interface SignatureFact extends LocatedFact { signature: string }
export interface CrossHostCloneEvidence {
  kind: "cross-host";
  hosts: {
    filePath: string;
    reportStartLine: number;
    reportEndLine: number;
    hostReportStartLine: number;
    hostReportEndLine: number;
    host: LocatedFact & { kind: "class" | "struct"; decorators: string[] };
    controllers: (LocatedFact & { captures: string[] })[];
    uiRoots: LocatedFact[];
    lifecycle: LocatedFact[];
    memberTypes: (SignatureFact & { type: string; decorators: string[]; static: boolean })[];
    staticEntries: SignatureFact[];
  }[];
  limitations: string[];
}

interface Owner {
  name: string;
  kind: "class" | "struct";
  start: number;
  open: number;
  end: number;
  decorators: string[];
}
interface Member {
  name: string;
  start: number;
  end: number;
  body: number | null;
  type: string;
  signature: string;
  decorators: string[];
  static: boolean;
}
const MAX_INPUTS = 8;
const MAX_SOURCE = 400_000;
const MAX_FACTS = 12;
const LIFECYCLE = /^(?:aboutToAppear|aboutToDisappear|onPageShow|onPageHide|onBackPress|onWillAppear|onDidAppear|onWillDisappear|onDidDisappear)$/;
const UI_LIFECYCLE = /^(?:onReady|onShown|onHidden|onWillAppear|onWillDisappear|onWillShow|onWillHide|onBackPressed)$/;
const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const decorators = (value: string) => [...value.matchAll(/@([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
const refs = (code: string) => [...new Set([...code.matchAll(/\bthis\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]))];
const overlaps = (a: number, b: number, c: number, d: number) => a <= d && c <= b;

function supportedReturnType(type: string): boolean {
  // This scanner intentionally accepts only named/simple composite return
  // types. In `make(): { value: string }` or `Promise<{ value: string }>`,
  // the first brace belongs to the type, not to the method body.
  if (!/^[A-Za-z_$][\w$.\s|&<>,\[\]]*$/.test(type) ||
    !/[\w$\]>]$/.test(type) || /\b(?:extends|infer|keyof|typeof)\b/.test(type)) return false;
  const stack: string[] = [];
  for (const c of type) {
    if (c === "<" || c === "[") stack.push(c);
    else if (c === ">" || c === "]") {
      if (stack.pop() !== (c === ">" ? "<" : "[")) return false;
    }
  }
  return stack.length === 0;
}

function decoratedStart(code: string, declaration: number): number {
  let start = code.lastIndexOf("\n", declaration - 1) + 1;
  // Only adjacent, simple decorator lines are accepted; unsupported decorators
  // do not cause the locator to absorb an unrelated preceding declaration.
  for (let count = 0; start > 0 && count < 8; count++) {
    const prior = code.lastIndexOf("\n", start - 2) + 1;
    if (!/^\s*@\w+(?:\([^\n]*\))?\s*$/.test(code.slice(prior, start))) break;
    start = prior;
  }
  return start;
}

function owners(code: string): Owner[] {
  const result: Owner[] = [];
  for (const m of code.matchAll(/\b(class|struct)\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+[\w$.]+\s*)?(?:implements\s+[\w$.,\s]+)?\{/g)) {
    const open = m.index! + m[0].lastIndexOf("{");
    const end = matching(code, open);
    if (end < 0) continue;
    const start = decoratedStart(code, m.index!);
    result.push({ name: m[2], kind: m[1] as Owner["kind"], start, open, end,
      decorators: decorators(code.slice(start, open)) });
    if (result.length > 100) return [];
  }
  return result;
}

/** A bounded lexical declaration scan. Unknown signatures are omitted, never
 * interpreted as proof that a field is untyped or that a method is independent. */
function members(source: string, code: string, owner: Owner): Member[] {
  const depth = new Uint16Array(owner.end - owner.open + 1);
  let nesting = 0;
  for (let i = owner.open; i <= owner.end; i++) {
    depth[i - owner.open] = nesting;
    if (code[i] === "{") nesting++;
    else if (code[i] === "}") nesting--;
  }
  const result: Member[] = [];
  const body = code.slice(owner.open + 1, owner.end);
  const pattern = /^[ \t]*((?:@[\w$]+(?:\([^\n]*?\))?[ \t\r\n]*)*)((?:(?:public|private|protected|static|readonly|async|override|abstract)\s+)*)(?:(get|set)\s+)?([A-Za-z_$][\w$]*)[ \t]*([?!]?[ \t]*:|\()/gm;
  for (const m of body.matchAll(pattern)) {
    const start = owner.open + 1 + m.index!;
    const token = start + m[0].search(/\S/);
    if (depth[token - owner.open] !== 1) continue;
    const tail = start + m[0].length;
    let end: number, type = "", bodyStart: number | null = null, signatureEnd: number;
    if (m[5] === "(") {
      const close = matching(code, tail - 1, "(", ")");
      if (close < 0 || close - start > 2000) continue;
      let at = close + 1;
      while (/\s/.test(code[at] ?? "") && at < owner.end) at++;
      if (code[at] === ":") {
        const typeStart = ++at;
        while (at < owner.end && at - typeStart < 500 && !/[{;\n]/.test(code[at])) at++;
        type = compact(source.slice(typeStart, at));
        if (!supportedReturnType(type)) continue;
      }
      while (/\s/.test(code[at] ?? "") && at < owner.end) at++;
      if (code[at] !== "{" || at - start > 2500) continue;
      bodyStart = at;
      end = matching(code, at);
      if (end < 0 || end >= owner.end) continue;
      signatureEnd = at;
    } else {
      // Balance type syntax so callback arrows and object types do not get
      // mistaken for the assignment introducing a field initializer.
      let at = tail, parens = 0, brackets = 0, braces = 0;
      for (; at < owner.end && at - tail < 1000; at++) {
        const c = code[at];
        if (!parens && !brackets && !braces && (/[;\n\r]/.test(c) || (c === "=" && code[at + 1] !== ">"))) break;
        if (c === "(") parens++;
        else if (c === ")") parens--;
        else if (c === "[") brackets++;
        else if (c === "]") brackets--;
        else if (c === "{") braces++;
        else if (c === "}") braces--;
        if (parens < 0 || brackets < 0 || braces < 0) break;
      }
      if (parens || brackets || braces || at - tail >= 1000) continue;
      type = compact(source.slice(tail, at));
      if (!type) continue;
      signatureEnd = at;
      end = at;
    }
    const signature = compact(source.slice(start, signatureEnd));
    // Omitting an oversized signature is safer than emitting a truncated type.
    if (signature.length > 360) continue;
    result.push({ name: m[4], start, end, body: bodyStart, type, signature,
      decorators: decorators(m[1]), static: /\bstatic\b/.test(m[2]) });
    if (result.length > 200) break;
  }
  return result;
}

export function analyzeCrossHostClone(inputs: CrossHostCloneInput[]): CrossHostCloneEvidence | null {
  if (inputs.length < 2 || inputs.length > MAX_INPUTS) return null;
  const profiles: CrossHostCloneEvidence["hosts"] = [];
  const identities = new Set<string>();
  for (const input of inputs) {
    const { source, startLine, endLine } = input;
    if (!input.resolved || !startLine || !endLine || startLine < 1 || endLine < startLine ||
      !Number.isInteger(startLine) || !Number.isInteger(endLine) || source.length > MAX_SOURCE) return null;
    const lines = source.split("\n");
    if (endLine > lines.length) return null;
    const reportStart = lines.slice(0, startLine - 1).reduce((n, line) => n + line.length + 1, 0);
    const reportEnd = reportStart + lines.slice(startLine - 1, endLine).join("\n").length;
    const code = mask(source);
    const candidates = owners(code);
    // Detection ranges can begin with imports, constants or a public Builder.
    // Profile the sole intersecting owner, retaining the original report range.
    const located = candidates.filter(o => overlaps(lineAt(source, o.start), lineAt(source, o.end), startLine, endLine));
    if (located.length !== 1) return null;
    const owner = located[0];
    if (owner.name.length > 120 || input.filePath.length > 1024) return null;
    if (candidates.some(o => o !== owner && o.start > owner.open && o.end < owner.end)) return null;
    const fact = (name: string, start: number, end: number): LocatedFact => ({ name,
      startLine: lineAt(source, start), endLine: lineAt(source, end) });
    const declarations = members(source, code, owner);
    const controllers: CrossHostCloneEvidence["hosts"][number]["controllers"] = [];
    const ownCode = code.slice(owner.open + 1, owner.end);
    for (const m of ownCode.matchAll(/\bnew\s+(CustomDialogController)\s*\(/g)) {
      const start = owner.open + 1 + m.index!;
      const end = matching(code, start + m[0].lastIndexOf("("), "(", ")");
      if (end < 0 || end > owner.end) continue;
      controllers.push({ ...fact(m[1], start, end), captures: refs(code.slice(start, end + 1)).slice(0, MAX_FACTS) });
      if (controllers.length >= 6) break;
    }
    const uiRoots: LocatedFact[] = [], lifecycle: LocatedFact[] = [];
    const contextParts = [code.slice(Math.max(reportStart, owner.open + 1), Math.min(reportEnd, owner.end))];
    for (const method of declarations.filter(m => m.body !== null && LIFECYCLE.test(m.name))) {
      lifecycle.push(fact(method.name, method.start, method.end));
      contextParts.push(code.slice(method.start, method.end + 1));
    }
    if (owner.kind === "struct") {
      for (const m of ownCode.matchAll(/\b(NavDestination|Navigation)\s*\(/g)) {
        const start = owner.open + 1 + m.index!;
        if (code[start - 1] === ".") continue;
        const method = declarations.find(d => d.name === "build" && d.body !== null && d.start <= start && d.end >= start);
        if (!method) continue;
        let end = matching(code, start + m[0].lastIndexOf("("), "(", ")");
        if (end < 0) continue;
        let next = end + 1;
        while (/\s/.test(code[next] ?? "") && next < method.end) next++;
        if (code[next] !== "{") continue;
        end = matching(code, next);
        if (end < 0 || end > method.end) continue;
        const events: LocatedFact[] = [];
        for (let count = 0; count < 50; count++) {
          const modifier = /^\s*\.([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(end + 1, method.end));
          if (!modifier) break;
          const begin = end + 1;
          const callOpen = begin + modifier[0].lastIndexOf("(");
          const close = matching(code, callOpen, "(", ")");
          if (close < 0 || close > method.end) break;
          if (UI_LIFECYCLE.test(modifier[1])) events.push(fact(modifier[1], begin + modifier[0].indexOf("."), close));
          end = close;
        }
        if (!overlaps(start, end, reportStart, reportEnd)) continue;
        uiRoots.push(fact(m[1], start, end));
        lifecycle.push(...events);
        contextParts.push(code.slice(start, end + 1));
        if (uiRoots.length >= 6) break;
      }
    }
    const referenced = new Set(refs(contextParts.join("\n")));
    const memberTypes = declarations.filter(m => referenced.has(m.name) || overlaps(m.start, m.end, reportStart, reportEnd))
      .filter(m => m.type || m.body !== null).slice(0, MAX_FACTS)
      .map(m => ({ ...fact(m.name, m.start, m.end), type: m.type,
        signature: m.signature, decorators: m.decorators, static: m.static }));
    const staticEntries = declarations.filter(m => m.static).slice(0, 6)
      .map(m => ({ ...fact(m.name, m.start, m.end), signature: m.signature }));
    profiles.push({ filePath: input.filePath, reportStartLine: startLine, reportEndLine: endLine,
      hostReportStartLine: Math.max(startLine, lineAt(source, owner.start)),
      hostReportEndLine: Math.min(endLine, lineAt(source, owner.end)),
      host: { ...fact(owner.name, owner.start, owner.end), kind: owner.kind, decorators: owner.decorators },
      controllers, uiRoots, lifecycle: lifecycle.slice(0, MAX_FACTS), memberTypes, staticEntries });
    const identity = path.posix.normalize((input.identityPath ?? input.filePath).replace(/\\/g, "/"));
    const canonical = process.platform === "win32" || /^[A-Za-z]:\//.test(identity) ? identity.toLowerCase() : identity;
    identities.add(`${canonical}#${owner.open}`);
  }
  if (identities.size < 2) return null;
  return { kind: "cross-host", hosts: profiles,
    limitations: ["有界词法证据；未执行类型解析或框架语义证明，未列出的成员不代表不存在。对象、函数及其他复杂返回类型的成员签名保守省略；正则与模板插值不作语义解析。", "位置来自重构前源代码；报告之外的宿主上下文只用于判断归属，不扩大要求修改的范围。"] };
}

export function crossHostCloneHints(evidence: CrossHostCloneEvidence): string[] {
  const hints = ["克隆实例属于不同宿主；根据下列实际声明与生命周期边界选择共享范围，保留各宿主原有公开入口和独立状态。"];
  const location = (file: string, value: LocatedFact) => `${file}:${value.startLine}-${value.endLine} ${value.name}`;
  for (const profile of evidence.hosts) {
    const { filePath, host } = profile;
    hints.push(`宿主 ${location(filePath, host)}（${host.kind}${host.decorators.length ? "；" + host.decorators.map(d => "@" + d).join(" ") : ""}），报告 ${profile.reportStartLine}-${profile.reportEndLine} 行；该宿主与报告相交 ${profile.hostReportStartLine}-${profile.hostReportEndLine} 行。`);
    if (profile.controllers.length) hints.push(`框架控制器构造：${profile.controllers.map(c => `${location(filePath, c)}${c.captures.length ? "，捕获 this." + c.captures.join("/this.") : ""}`).join("；")}。这些调用可能依赖组件创建上下文；优先保留原宿主构造及 builder 绑定，再评估可共享的普通逻辑或具名配置类型，不能仅按文本相似度移动构造。`);
    if (profile.uiRoots.length) hints.push(`报告所在路由容器：${profile.uiRoots.map(r => location(filePath, r)).join("；")}。抽取内部 UI 时保留容器及其完整 modifier 链的宿主归属，避免把路由根与生命周期一起移入新的共享子组件。`);
    if (profile.lifecycle.length) hints.push(`宿主生命周期：${profile.lifecycle.map(l => location(filePath, l)).join("；")}。保持初始化、清理和状态读取的原时序与接收者。`);
    if (profile.memberTypes.length) hints.push(`相关显式声明/签名：${profile.memberTypes.map(m => `${location(filePath, m)} ${m.signature}`).join("；")}。共享参数、返回值和回调需接纳这些原类型及可选值；新建对象字面量应有可见的具名类型或原 API 的明确上下文类型，不能因抽取丢失类型约束。`);
    if (profile.staticEntries.length) hints.push(`静态入口/状态：${profile.staticEntries.map(s => `${location(filePath, s)} ${s.signature}`).join("；")}。共享实现时保留入口与各宿主静态实例的独立性。`);
  }
  return [...hints, ...evidence.limitations];
}
