/** @jsxImportSource @opentui/solid */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Show, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { TuiDialogAlertProps, TuiDialogPromptProps, TuiPluginApi, TuiPluginMeta, TuiRouteDefinition, TuiToast } from "@opencode-ai/plugin/tui";
import plugin from "../src/tui.tsx";
import { fixture } from "./helpers.ts";

for (const [width, height] of [[120, 36], [80, 24]] as const) {
  test(`native TUI ${width}x${height}: command entry, import, tabs, modal isolation, exit`, async () => {
    const f = await fixture();
    const [route, setRoute] = createSignal("home");
    const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>();
    const definitions = new Map<string, TuiRouteDefinition>();
    let prompt: TuiDialogPromptProps | undefined;
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
        DialogConfirm: () => <text>confirm</text>,
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
      screen.mockInput.pressKey("i");
      await screen.flush();
      assert.ok(prompt);
      assert.equal(api.ui.dialog.open, true);
      screen.mockInput.pressKey("5");
      await screen.flush();
      assert.doesNotMatch(screen.captureCharFrame(), /点击候选记录恢复/);
      const report = resolve(f.directory, "report.json");
      await writeFile(report, JSON.stringify(f.record));
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
      assert.match(screen.captureCharFrame(), /80,000/);
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
