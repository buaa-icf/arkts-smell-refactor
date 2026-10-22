/** @jsxImportSource @opentui/solid */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Show, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { TuiDialogAlertProps, TuiDialogConfirmProps, TuiDialogPromptProps, TuiPluginApi, TuiPluginMeta, TuiRouteDefinition, TuiToast } from "@opencode-ai/plugin/tui";
import plugin from "../src/tui.tsx";
import { Workbench } from "../src/controller.ts";
import { applyCandidate, readTransaction } from "../src/apply.ts";
import { WorkbenchView } from "../src/ui/workbench.tsx";
import type { Actions, Tab } from "../src/ui/workbench.tsx";
import type { Backend, Issue } from "../src/types.ts";
import { fixture } from "./helpers.ts";

for (const [width, height] of [[120, 36], [80, 24]] as const) {
  test(`native TUI ${width}x${height}: command entry, import, tabs, modal isolation, exit`, async () => {
    const f = await fixture();
    const [route, setRoute] = createSignal("home");
    const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>();
    const definitions = new Map<string, TuiRouteDefinition>();
    let prompt: TuiDialogPromptProps | undefined;
    let confirmation: TuiDialogConfirmProps | undefined;
    let activeMode = "base";
    const disposers: (() => void | Promise<void>)[] = [];
    const screen = await testRender(() => <box width="100%" height="100%" flexDirection="column">
      <Show when={dialog()}>{(render) => render()()}</Show>
      <Show when={route() === "arkts.refactor"} fallback={<text>Host home</text>}>
        {definitions.get("arkts.refactor")?.render({})}
      </Show>
    </box>, { width, height });
    const keymap = createDefaultOpenTuiKeymap(screen.renderer);
    keymap.registerLayerFields({ mode: (mode, context) => context.activeWhen(() => activeMode === mode) });
    const color = RGBA.fromHex("#dddddd");
    const tokens = ["primary", "secondary", "accent", "error", "warning", "success", "info", "text", "textMuted", "background", "border"];
    const api = {
      app: { version: "test" }, keymap,
      state: { path: { directory: f.projectRoot } },
      route: {
        get current() { return { name: route() }; },
        navigate: (name: string) => { setRoute(name); },
        register: (routes: TuiRouteDefinition[]) => {
          for (const definition of routes) definitions.set(definition.name, definition);
          return () => { for (const definition of routes) definitions.delete(definition.name); };
        },
      },
      mode: { current: () => activeMode, push: (mode: string) => { const before = activeMode; activeMode = mode; return () => { activeMode = before; }; } },
      lifecycle: { signal: new AbortController().signal, onDispose: (fn: () => void) => { disposers.push(fn); return () => {}; } },
      theme: { current: Object.fromEntries(tokens.map((token) => [token, token === "background" ? RGBA.fromHex("#111111") : color])) },
      ui: {
        DialogPrompt: (props: TuiDialogPromptProps) => { prompt = props; return <text>{props.title}</text>; },
        DialogConfirm: (props: TuiDialogConfirmProps) => { confirmation = props; return <text>{props.title}</text>; },
        dialog: {
          get open() { return !!dialog(); },
          replace: (render: () => JSX.Element) => { setDialog(() => render); },
          clear: () => { setDialog(undefined); },
        },
        toast: () => {},
      },
    } as unknown as TuiPluginApi;
    try {
      const settings = resolve(f.directory, "settings.valid.json");
      await writeFile(settings, JSON.stringify(f.config));
      await plugin.tui(api, { configFile: settings }, {} as TuiPluginMeta);
      assert.ok(keymap.getCommands({ visibility: "registered" }).some((command) => command.name === "arkts.open"));
      keymap.dispatchCommand("arkts.open");
      await screen.flush();
      assert.equal(activeMode, "arkts.refactor");
      let frame = screen.captureCharFrame();
      assert.match(frame, /异味重构工作台/);
      assert.match(frame, /检测工程或导入/);
      assert.match(frame, /开始：检测或导入/);
      screen.mockInput.pressKey("i");
      await screen.flush();
      assert.ok(prompt);
      assert.equal(api.ui.dialog.open, true);
      screen.mockInput.pressKey("5");
      await screen.flush();
      assert.doesNotMatch(screen.captureCharFrame(), /点击候选记录恢复/);
      const report = resolve(f.directory, "report.json");
      const second = { ...f.record, messages: [{ ...f.record.messages[0]!, rule: "@extrulesproject/feature-envy-check",
        message: "Method 'labelBaseStyle' is feature-envious toward 'CommonMethod'" }] };
      await writeFile(report, JSON.stringify([f.record, second]));
      prompt!.onConfirm?.(report);
      // waitForFrame exits when the renderer is idle, even if backend I/O is pending.
      for (let attempt = 0; attempt < 150; attempt++) {
        await new Promise((done) => setTimeout(done, 20));
        await screen.flush();
        if (screen.captureCharFrame().includes("update")) break;
      }
      frame = screen.captureCharFrame();
      assert.match(frame, /update/);
      assert.match(frame, /Page.ets/);
      await mkdir(resolve(".artifacts"), { recursive: true });
      await writeFile(resolve(`.artifacts/workbench-${width}x${height}.txt`), frame);
      screen.mockInput.pressKey("4"); await screen.flush();
      assert.match(screen.captureCharFrame(), /导入报告 DONE/);
      screen.mockInput.pressKey("j"); await screen.flush();
      assert.match(screen.captureCharFrame(), /方法：labelBaseStyle/);
      assert.match(screen.captureCharFrame(), /Feature Envy/);
      assert.match(screen.captureCharFrame(), /下一步：分析风险/);
      screen.mockInput.pressKey("2"); await screen.flush();
      assert.match(screen.captureCharFrame(), /异味检测范围/);
      // The selected method has no candidate. r must discover the durable application independently.
      await writeFile(resolve(f.candidate.runDirectory, "candidate.json"), JSON.stringify(f.candidate));
      await writeFile(resolve(f.candidate.runDirectory, "session.json"), JSON.stringify({ runId: f.candidate.candidateId,
        projectRoot: f.projectRoot, method: "task.execute", state: "SUCCEEDED", startedAt: "2026-10-21T17:11:48+0800" }));
      await applyCandidate(f.config, f.candidate);
      screen.mockInput.pressKey("r");
      for (let attempt = 0; attempt < 150 && !confirmation; attempt++) {
        await new Promise((done) => setTimeout(done, 20)); await screen.flush();
      }
      assert.equal(confirmation?.title, "恢复应用前内容");
      assert.ok(confirmation?.message?.includes(f.candidate.candidateId));
      assert.ok(confirmation?.message?.includes(f.name));
      confirmation?.onConfirm?.();
      for (let attempt = 0; attempt < 150; attempt++) {
        await new Promise((done) => setTimeout(done, 20)); await screen.flush();
        if (screen.captureCharFrame().includes("恢复应用前内容：完成")) break;
      }
      assert.equal((await readTransaction(f.config, f.candidate))?.state, "ROLLED_BACK");
      screen.mockInput.pressEscape();
      await new Promise((done) => setTimeout(done, 50));
      await screen.flush();
      assert.equal(route(), "home");
      assert.equal(activeMode, "base");
    } finally {
      for (const dispose of disposers.reverse()) await dispose();
      screen.renderer.destroy();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

for (const [width, height] of [[120, 36], [80, 24]] as const) {
  test(`navigation ${width}x${height} stays fixed above long logs and explains detected methods`, async () => {
    const f = await fixture();
    const backend: Backend = { request: async (method) => {
      if (method === "task.prepare") return { taskHandle: "test", taskId: "test", originalRoot: f.projectRoot,
        baselineFiles: f.candidate.baselineFiles, risk: { riskLevel: "medium" }, issue: controller.issue,
        instructions: "", runDirectory: f.candidate.runDirectory } as never;
      if (method === "task.execute") return { candidate: f.candidate, result: f.candidate.result,
        runDirectory: f.candidate.runDirectory } as never;
      if (method === "task.validateApplied") return { result: { verdict: "PASS" }, runDirectory: f.candidate.runDirectory } as never;
      if (method === "candidate.check" || method === "candidate.describe") return f.candidate as never;
      throw new Error(`Unexpected request ${method}`);
    } };
    const controller = new Workbench(f.config, backend);
    const [tab, setTab] = createSignal<Tab>("logs");
    const noop = () => {};
    const methods = [
      { symbol: "build", smellType: "long-method", line: 90 },
      { symbol: "labelBaseStyle", smellType: "feature-envy", line: 333 },
    ];
    controller.state = { ...controller.state, status: "异味检测：完成", issues: methods.map((method, index): Issue => ({
      issueId: String(index), filePath: "feature/book_home/src/main/ets/views/SearchPage.ets", absolutePath: f.projectRoot,
      rule: method.smellType, smellType: method.smellType, symbol: method.symbol, message: "detected smell",
      startLine: method.line, endLine: method.line, supported: true, sourceSha256: "test", rawMessage: {}, relatedTargets: [], commitHash: "",
    })), logs: "up to date in 24s\n" + Array.from({ length: 160 }, (_, index) => `LOG_${index} ${"streamed content ".repeat(5)}`).join("\n") };
    const color = RGBA.fromHex("#dddddd");
    const tokens = ["primary", "accent", "error", "warning", "success", "text", "textMuted", "background", "border"];
    const api = { mode: { push: () => noop }, theme: {
      current: Object.fromEntries(tokens.map((token) => [token, token === "background" ? RGBA.fromHex("#111111") : color])),
    } } as unknown as TuiPluginApi;
    const actions: Actions = {
      scan: noop, importFile: noop, paste: noop, instructions: noop, prepare: noop, execute: noop, diff: noop,
      apply: noop, validate: noop, revalidate: noop, history: noop, environment: noop, recover: noop, cancel: noop, back: noop, restore: noop,
      selectIssue: (index) => { controller.select(index); setTab("risk"); },
    };
    const screen = await testRender(() => <WorkbenchView api={api} controller={controller} tab={tab} setTab={setTab} actions={actions} />,
      { width, height });
    try {
      await screen.flush();
      const navigation = screen.renderer.root.findDescendantById("arkts-navigation") as Renderable;
      const content = screen.renderer.root.findDescendantById("arkts-content") as ScrollBoxRenderable;
      assert.ok(navigation && content);
      assert.ok(navigation.height >= 1);
      assert.ok(content.y >= navigation.y + navigation.height, "content must start below the fixed navigation");
      const navigationFrame = () => screen.captureCharFrame().split("\n").slice(navigation.y, navigation.y + navigation.height).join("\n");
      const beforeScroll = navigationFrame();
      assert.match(beforeScroll, /1 问题\/风险/);
      assert.match(beforeScroll, /6 环境/);
      assert.match(screen.captureCharFrame(), /检测到的异味方法/);
      assert.match(screen.captureCharFrame(), /长方法/);
      const hint = screen.renderer.root.findDescendantById("arkts-guidance") as Renderable;
      assert.ok(hint.y + hint.height <= content.y + content.height, "guidance must fit within the main panels");
      assert.match(screen.captureCharFrame(), /下一步：分析风险/);
      content.scrollTo(content.scrollHeight);
      await screen.flush();
      assert.ok(content.scrollTop > 0);
      assert.equal(navigationFrame(), beforeScroll, "scrolling logs must not paint over navigation");
      assert.match(screen.captureCharFrame(), /LOG_159/);
      await mkdir(resolve(".artifacts"), { recursive: true });
      await writeFile(resolve(`.artifacts/navigation-${width}x${height}.txt`), screen.captureCharFrame());
      if (width >= 110) {
        const method = screen.renderer.root.findDescendantById("arkts-issue-1") as Renderable;
        await screen.mockMouse.click(method.x + 3, method.y);
        await screen.flush();
        assert.equal(controller.state.selected, 1);
        assert.equal(tab(), "risk");
        assert.match(screen.captureCharFrame(), /方法：labelBaseStyle/);
        assert.match(screen.captureCharFrame(), /Feature Envy/);
        await writeFile(resolve(".artifacts/method-details-120x36.txt"), screen.captureCharFrame());
      }
      await controller.prepare(); await screen.flush();
      assert.match(screen.captureCharFrame(), /下一步：生成候选/);
      await controller.execute(); await screen.flush();
      assert.match(screen.captureCharFrame(), /下一步：审阅并应用/);
      await controller.apply(); await screen.flush();
      assert.match(screen.captureCharFrame(), /下一步：应用后复检/);
      await controller.validateApplied(); await screen.flush();
      assert.match(screen.captureCharFrame(), /复检通过/);
      await controller.recover(f.candidate.candidateId); await screen.flush();
      assert.match(screen.captureCharFrame(), /已恢复应用前内容/);
    } finally {
      await controller.dispose();
      screen.renderer.destroy();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

for (const failure of ["invalid-json", "missing-file"] as const) {
  test(`configuration ${failure} preserves /arkts and shows an actionable error`, async () => {
    const f = await fixture();
    const settings = resolve(f.directory, `settings.${failure}.json`);
    const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>();
    const notifications: TuiToast[] = [];
    let alert: TuiDialogAlertProps | undefined;
    const screen = await testRender(() => <box width="100%" height="100%" flexDirection="column">
      <Show when={dialog()}>{(render) => render()()}</Show>
    </box>, { width: 100, height: 30 });
    const keymap = createDefaultOpenTuiKeymap(screen.renderer);
    const api = {
      keymap,
      state: { path: { directory: f.projectRoot } },
      route: { register: () => () => {}, navigate: () => {} },
      mode: { push: () => () => {} },
      lifecycle: { onDispose: () => () => {} },
      ui: {
        DialogPrompt: () => null,
        DialogConfirm: () => null,
        DialogAlert: (props: TuiDialogAlertProps) => {
          alert = props;
          return <box flexDirection="column"><text>{props.title}</text><text wrapMode="char">{props.message}</text></box>;
        },
        dialog: { replace: (render: () => JSX.Element) => setDialog(() => render), clear: () => setDialog(undefined) },
        toast: (value: TuiToast) => { notifications.push(value); },
      },
    } as unknown as TuiPluginApi;
    try {
      if (failure === "invalid-json") await writeFile(settings, String.raw`{"projectRoot":"D:\arktsProgram\BookRead"}`);
      await plugin.tui(api, { configFile: settings }, {} as TuiPluginMeta);
      const command = keymap.getCommands({ visibility: "registered" }).find((entry) => entry.name === "arkts.open");
      assert.ok(command, "/arkts must stay registered when configuration fails");
      assert.equal(notifications[0]?.variant, "error");
      assert.match(notifications[0]?.message ?? "", /\/arkts/);
      keymap.dispatchCommand("arkts.open");
      await screen.flush();
      assert.equal(alert?.title, "ArkTS 配置加载失败");
      assert.ok(alert?.message.includes(settings));
      assert.match(screen.captureCharFrame(), /ArkTS 配置加载失败/);
      assert.match(alert?.message ?? "", failure === "invalid-json" ? /反斜杠必须转义/ : /文件存在且可以读取/);
      assert.match(alert?.message ?? "", /重新启动/);
      alert?.onConfirm?.();
      assert.equal(dialog(), undefined);
    } finally {
      screen.renderer.destroy();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}
