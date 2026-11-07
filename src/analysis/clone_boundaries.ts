import type { Json } from "../models.js";
import { lineAt, mask, matching, stateWrites } from "./source.js";

interface Region {
  name: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}
const MAX_CONTEXT_LINES = 100;
const MAX_CONTEXT_CHARS = 6000;
function bounded(source: string, start: number, end: number): boolean {
  return end >= start && end - start <= MAX_CONTEXT_CHARS &&
    lineAt(source, end) - lineAt(source, start) < MAX_CONTEXT_LINES;
}

/** Smallest complete ArkUI node + modifier chain containing the reported lines.
 * Lexical navigation evidence only; it does not change the detector's range. */
export function cloneUiContext(source: string, startLine: number | null, endLine: number | null): Region | null {
  if (!startLine || !endLine || endLine < startLine) return null;
  const code = mask(source), candidates: Region[] = [];
  for (const match of code.matchAll(/\b([A-Z][\w$]*)\s*\(/g)) {
    if (/[\w$.]/.test(code[match.index! - 1] ?? "")) continue;
    const open = match.index! + match[0].lastIndexOf("("), close = matching(code, open, "(", ")");
    if (close < 0) continue;
    let end = close, next = close + 1;
    while (/\s/.test(code[next] ?? "") && next < code.length) next++;
    if (code[next] === "{") {
      end = matching(code, next);
      if (end < 0) continue;
    }
    // Include trailing .onClick/.id/... even when they extend beyond the report.
    while (end < code.length) {
      const modifier = /^\s*\.[A-Za-z_$][\w$]*\s*\(/.exec(code.slice(end + 1));
      if (!modifier) break;
      const callOpen = end + 1 + modifier[0].lastIndexOf("("), callEnd = matching(code, callOpen, "(", ")");
      if (callEnd < 0) { end = -1; break; }
      end = callEnd;
    }
    if (!bounded(source, match.index!, end)) continue;
    const first = lineAt(code, match.index!), last = lineAt(code, end);
    if (first <= startLine && endLine <= last)
      candidates.push({ name: match[1], start: match.index!, end, startLine: first, endLine: last });
  }
  return candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
}

interface ConfigurationCall extends Region {
  event: string;
  eventStartLine: number;
  eventEndLine: number;
  shape: string;
  writes: string[];
  reads: string[];
  callbacks: string[];
}
/** Find object-configuration calls with inline callbacks, inside event handlers.
 * Never infer helper extraction from mere membership in build(). */
function configurationCalls(source: string, ownerStart: number, ownerEnd: number): ConfigurationCall[] {
  const code = mask(source), calls = new Map<number, ConfigurationCall>();
  for (const event of code.slice(ownerStart, ownerEnd + 1).matchAll(/\.((?:on)[A-Z][\w$]*)\s*\(/g)) {
    const eventStart = ownerStart + event.index!, eventOpen = eventStart + event[0].lastIndexOf("("),
      eventEnd = matching(code, eventOpen, "(", ")");
    if (eventEnd < 0 || eventEnd > ownerEnd || !bounded(source, eventStart, eventEnd)) continue;
    const eventCode = code.slice(eventOpen + 1, eventEnd);
    if (!/^\s*(?:\([^)]*\)|[\w$]+)\s*=>\s*\{/.test(eventCode) || /\b(?:await|async)\b/.test(eventCode)) continue;
    for (const call of eventCode.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(\s*\{/g)) {
      const start = eventOpen + 1 + call.index!, open = start + call[0].indexOf("("), end = matching(code, open, "(", ")");
      if (end < 0 || end >= eventEnd || !bounded(source, start, end)) continue;
      const body = code.slice(start, end + 1), writes = stateWrites(body),
        callbacks = [...body.matchAll(/\b(on[A-Z][\w$]*)\s*:\s*\([^)]*\)\s*=>\s*\{/g)].map(m => m[1]);
      if (!callbacks.length || !writes.length || /\b(?:await|async)\b/.test(body)) continue;
      const reads = [...new Set([...body.matchAll(/\bthis\.([\w$]+)/g)].map(m => m[1]))].filter(name => !writes.includes(name));
      // Equality here is only shape equality. Strings are masked, writes may differ.
      const shape = body.replace(/\bthis\.[\w$]+(?=\s*(?:[+\-*/%]?=(?!=)|\+\+|--))/g, "this.WRITE").replace(/\s+/g, "");
      calls.set(start, { name: call[1], start, end, startLine: lineAt(code, start), endLine: lineAt(code, end),
        event: event[1], eventStartLine: lineAt(code, eventStart), eventEndLine: lineAt(code, eventEnd), shape, writes, reads, callbacks });
    }
  }
  return [...calls.values()];
}

export function cloneEventEvidence(source: string, instances: Json[], ownerStart: number, ownerEnd: number): Json | null {
  const contexts = instances.map(i => cloneUiContext(source, i.startLine, i.endLine));
  if (contexts.some(c => !c || c.start < ownerStart || c.end > ownerEnd)) return null;
  const calls = configurationCalls(source, ownerStart, ownerEnd), groups: Json[] = [];
  for (const candidate of calls) {
    if (groups.some(g => g.shape === candidate.shape)) continue;
    const matchingCalls = calls.filter(c => c.shape === candidate.shape && c.name === candidate.name);
    // Every known instance must include a complete occurrence; don't pick a
    // coincidentally similar call elsewhere in the host as its explanation.
    if (!contexts.every(c => matchingCalls.some(call => c!.start <= call.start && call.end <= c!.end))) continue;
    const selected = matchingCalls.filter(call => contexts.some(c => c!.start <= call.start && call.end <= c!.end));
    if (new Set(selected.map(c => c.start)).size < 2) continue;
    const first = selected[0], ordered = [...selected, ...matchingCalls.filter(c => !selected.includes(c))];
    groups.push({ shape: candidate.shape, callee: first.name,
      exemplar: { startLine: first.startLine, endLine: first.endLine, source: source.slice(first.start, first.end + 1) },
      occurrenceCount: matchingCalls.length,
      omittedOccurrences: Math.max(0, matchingCalls.length - 8),
      occurrences: ordered.slice(0, 8).map(c => ({ startLine: c.startLine, endLine: c.endLine,
        event: c.event, eventStartLine: c.eventStartLine, eventEndLine: c.eventEndLine,
        callbackNames: c.callbacks, stateWrites: c.writes, thisReferencesExcludingWrites: c.reads,
        reported: selected.some(s => s.start === c.start) })),
    });
    if (groups.length === 2) break;
  }
  if (!groups.length) return null;
  groups.forEach(g => delete g.shape);
  return { scope: "同一宿主内同步事件回调的词法候选；字符串被掩码，形态一致不代表配置值或行为等价；未追踪别名和外部调用。",
    contexts: contexts.map(c => ({ node: c!.name, startLine: c!.startLine, endLine: c!.endLine })), groups };
}

export function cloneEventHints(evidence: Json): string[] {
  const hints = [String(evidence.scope),
    "报告片段横跨 UI 与事件逻辑时，优先核对下列普通成员 helper 候选：保留原 UI 节点、Text(this.field) 读取与修饰符，将完整公共配置调用抽取，差异回调保留原闭包和字段写入；this 读取仍在原事件触发时发生。只有 UI 骨架本身需要共享时再考虑成员 @Builder。",
    "已列出完整调用和同宿主位置；核对配置值、回调参数/返回、this 与副作用顺序后采用一个最小方案。不为预估 100 token 窗口反复设计整个页面；残留异味由实际复检确认。",
  ];
  for (const group of evidence.groups) {
    hints.push(`${group.callee} 完整调用 L${group.exemplar.startLine}–${group.exemplar.endLine}；同形候选共 ${group.occurrenceCount} 处：` +
      group.occurrences.map((c: Json) => `L${c.startLine}–${c.endLine}（${c.reported ? "报告关联" : "同宿主补充线索"}，${c.event} L${c.eventStartLine}–${c.eventEndLine}；${c.callbackNames.join("/")} 写 this.${c.stateWrites.join("/this.")}；其他 this 引用 ${c.thisReferencesExcludingWrites.join(", ")}）`).join("；"));
    if (group.omittedOccurrences) hints.push(`此调用另有 ${group.omittedOccurrences} 处候选未展示，按需在同宿主内核对。`);
    hints.push(`首个完整调用原文（作为核对证据，其余实例差异需保留）：\n${group.exemplar.source}`);
  }
  return hints;
}
