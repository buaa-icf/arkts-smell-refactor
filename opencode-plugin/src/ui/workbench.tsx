/** @jsxImportSource @opentui/solid */
import { For, Show, Switch, Match, createSignal, onCleanup } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Workbench } from "../controller.ts";

export type Tab = "risk" | "result" | "diff" | "logs" | "history" | "environment";
export const tabs: { id: Tab; label: string }[] = [
  { id: "risk", label: "1 问题/风险" }, { id: "result", label: "2 阶段/结论" },
  { id: "diff", label: "3 Diff" }, { id: "logs", label: "4 日志" },
  { id: "history", label: "5 历史" }, { id: "environment", label: "6 环境" },
];

export interface Actions {
  scan: () => void;
  importFile: () => void;
  paste: () => void;
  instructions: () => void;
  prepare: () => void;
  execute: () => void;
  diff: () => void;
  apply: () => void;
  validate: () => void;
  revalidate: () => void;
  history: () => void;
  environment: () => void;
  recover: () => void;
  cancel: () => void;
  back: () => void;
  restore: (id: string) => void;
}
const json = (value: unknown) => JSON.stringify(value, null, 2);

export function WorkbenchView(props: { api: TuiPluginApi; controller: Workbench; tab: () => Tab;
  setTab: (tab: Tab) => void; actions: Actions }) {
  const [state, setState] = createSignal(props.controller.state);
  onCleanup(props.controller.subscribe(setState));
  const popMode = props.api.mode.push("arkts.refactor");
  onCleanup(popMode);
  const size = useTerminalDimensions();
  const wide = () => size().width >= 110;
  const theme = () => props.api.theme.current;
  const issue = () => state().issues[state().selected];
  const visibleIssues = () => {
    const count = wide() ? Math.max(4, size().height - 16) : 2;
    const start = Math.max(0, state().selected - Math.floor(count / 2));
    return state().issues.slice(start, start + count).map((item, offset) => ({ item, index: start + offset }));
  };
  const buttons = [
    ["s 检测", props.actions.scan], ["i 导入", props.actions.importFile], ["o 粘贴", props.actions.paste],
    ["b 说明", props.actions.instructions], ["p 风险", props.actions.prepare], ["x 候选", props.actions.execute],
    ["d Diff", props.actions.diff], ["a 应用", props.actions.apply], ["v 复检", props.actions.validate],
    ["h 历史", props.actions.history], ["e 环境", props.actions.environment],
  ] as const;
  const buttonRows = () => wide() ? [buttons] : [buttons.slice(0, 6), buttons.slice(6)];
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme().background} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
        <text fg={theme().primary}>ArkTS Refactor · 异味重构工作台</text>
        <text fg={theme().textMuted} onMouseDown={props.actions.back}>Esc 返回</text>
      </box>
      <text fg={theme().textMuted} wrapMode="none" height={1} flexShrink={0}>工程 {props.controller.config.projectRoot}</text>
      <box flexDirection="column" marginTop={1} height={wide() ? 1 : 2} flexShrink={0}>
        <For each={buttonRows()}>{(row) => <box flexDirection="row" gap={2} height={1} flexShrink={0}>
          <For each={row}>{([title, run]) => <text fg={state().busy ? theme().textMuted : theme().accent} onMouseDown={run}>{title}</text>}</For>
        </box>}</For>
      </box>
      <text fg={state().error ? theme().error : theme().success} wrapMode="word" height={state().error ? 2 : 1} flexShrink={0}>
        {state().busy ? "● " : "○ "}{state().status}{state().error ? ` · ${state().error}` : ""}
      </text>
      <box flexDirection="row" gap={2} height={1} flexShrink={0}>
        <text fg={theme().text}>候选 {state().candidate?.verdict ?? "—"}</text>
        <text fg={theme().text}>应用 {state().applyState ?? "未应用"}</text>
        <text fg={theme().text}>复检 {state().appliedResult?.verdict ?? "待复检"}</text>
      </box>
      <box flexDirection={wide() ? "row" : "column"} flexGrow={1} flexBasis={0} minHeight={0} marginTop={1} gap={1}>
        <box width={wide() ? "32%" : "100%"} height={wide() ? "100%" : 5} flexShrink={0}
          border borderColor={theme().border} flexDirection="column" paddingLeft={1} paddingRight={1}>
          <text fg={theme().primary}>问题 {state().issues.length} · j/k 选择</text>
          <Show when={state().issues.length} fallback={<text fg={theme().textMuted}>检测工程或导入 JSON 报告开始。</text>}>
            <For each={visibleIssues()}>{({ item, index }) => (
              <text fg={index === state().selected ? theme().accent : theme().text}
                onMouseDown={() => props.controller.select(index)} wrapMode="none">
                {index === state().selected ? "› " : "  "}{index + 1}. {item.symbol ?? item.smellType}{item.supported ? "" : " [只读]"}
              </text>
            )}</For>
          </Show>
        </box>
        <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column" border borderColor={theme().border}>
          <box flexDirection="row" flexWrap="wrap" gap={2} paddingLeft={1}>
            <For each={tabs}>{(tab) => <text fg={props.tab() === tab.id ? theme().accent : theme().textMuted}
              onMouseDown={() => props.setTab(tab.id)}>{tab.label}</text>}</For>
          </box>
          <scrollbox flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} focused>
            <Switch>
              <Match when={props.tab() === "risk"}>
                <Show when={issue()} fallback={<text fg={theme().textMuted}>尚未选择问题。</text>}>{(selected) => <box flexDirection="column" gap={1}>
                  <text fg={theme().primary} wrapMode="char">{selected().filePath}:{selected().startLine}-{selected().endLine}</text>
                  <text fg={theme().textMuted}>{selected().rule}</text>
                  <text fg={theme().text} wrapMode="word">{selected().message}</text>
                  <text fg={theme().textMuted} wrapMode="word">业务说明：{state().instructions || "未填写（b）"}</text>
                  <Show when={state().prepared} fallback={<text fg={theme().warning}>按 p 冻结基线并分析风险。</text>}>{(prepared) => <>
                    <text fg={theme().warning}>风险等级 {prepared().risk.riskLevel ?? "未知"}</text>
                    <text fg={theme().text} wrapMode="word">{json(prepared().risk)}</text>
                  </>}</Show>
                </box>}</Show>
              </Match>
              <Match when={props.tab() === "result"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme().primary}>阶段轨迹</text>
                  <For each={state().steps}>{(step) => <text fg={step.status === "FAIL" || step.status === "BLOCKED" ? theme().error : theme().text}
                    wrapMode="word">{step.name} · {step.status}{step.reason ? ` · ${step.reason}` : ""}</text>}</For>
                  <Show when={state().result}><text fg={theme().text} wrapMode="word">{json(state().result)}</text></Show>
                  <Show when={state().appliedResult}><text fg={theme().text} wrapMode="word">应用后复检 {json(state().appliedResult)}</text></Show>
                  <text fg={theme().textMuted} wrapMode="char">证据：{state().runDirectory ?? "—"}</text>
                </box>
              </Match>
              <Match when={props.tab() === "diff"}>
                <box flexDirection="column" gap={1}>
                  <For each={state().candidate?.changes ?? []}>{(change) => <text fg={theme().accent}
                    onMouseDown={() => void props.controller.showDiff(change.relativePath)} wrapMode="char">
                    {change.changeType === "added" ? "+" : "~"} {change.relativePath} ({change.size} bytes)
                  </text>}</For>
                  <text fg={theme().text} wrapMode="char">{state().diff || "按 d 选择候选文件查看 Diff。"}</text>
                </box>
              </Match>
              <Match when={props.tab() === "logs"}>
                <text fg={theme().text} wrapMode="char">{state().logs || "日志将在运行时显示。此处保留最后 80,000 字符，完整日志位于证据目录。"}</text>
              </Match>
              <Match when={props.tab() === "history"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme().textMuted}>h 刷新 · 点击候选记录恢复 · r 恢复应用前内容</text>
                  <For each={state().history}>{(record) => <text fg={record.hasCandidate ? theme().accent : theme().textMuted}
                    wrapMode="char" onMouseDown={() => { if (record.candidateId) props.actions.restore(record.candidateId); }}>
                    {record.startedAt} · {record.method} · {record.verdict ?? record.state} · {record.applyState ?? ""}{"\n"}{record.runId}
                  </text>}</For>
                </box>
              </Match>
              <Match when={props.tab() === "environment"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme().textMuted}>e 刷新 · 修改插件 JSON 设置后重启宿主</text>
                  <text fg={theme().text}>Python {props.controller.config.python}</text>
                  <text fg={theme().text} wrapMode="char">后端 {props.controller.config.backend}</text>
                  <text fg={theme().text} wrapMode="char">证据 {props.controller.config.runs}</text>
                  <text fg={theme().text}>Code Linter {props.controller.config.linterMode}</text>
                  <For each={state().environment?.tools ?? []}>{(tool) => <text fg={tool.available ? theme().success : theme().warning} wrapMode="char">
                    {tool.available ? "✓" : "!"} {tool.name}{tool.required ? "" : "（可选）"} · {tool.path || "未找到"}
                  </text>}</For>
                </box>
              </Match>
            </Switch>
          </scrollbox>
        </box>
      </box>
      <box flexDirection="row" flexWrap="wrap" gap={2} height={2} flexShrink={0}>
        <text fg={theme().textMuted}>↑↓/PgUp/PgDn 滚动 · t 候选复检 · r 恢复</text>
        <text fg={theme().warning} onMouseDown={props.actions.cancel}>{state().busy ? "c 中止" : ""}</text>
      </box>
    </box>
  );
}
