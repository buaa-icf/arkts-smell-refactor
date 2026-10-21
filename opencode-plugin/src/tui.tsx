/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js";
import { resolve } from "node:path";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiRouteCurrent } from "@opencode-ai/plugin/tui";
import { assertCompatible } from "./compatibility.ts";
import { loadConfig } from "./config.ts";
import type { PluginConfig } from "./config.ts";
import { Workbench } from "./controller.ts";
import { WorkbenchView, tabs } from "./ui/workbench.tsx";
import type { Actions, Tab } from "./ui/workbench.tsx";

const ROUTE = "arkts.refactor";
function registerOpenCommand(api: TuiPluginApi, run: () => void): void {
  api.keymap.registerLayer({ commands: [{ name: "arkts.open", title: "ArkTS 异味重构工作台", category: "ArkTS",
    namespace: "palette", slashName: "arkts", run }] });
}

const tui: TuiPlugin = async (api, options) => {
  assertCompatible(api);
  let config: PluginConfig;
  try {
    config = await loadConfig(options, api.state.path.directory);
  } catch (error) {
    const message = `${error instanceof Error ? error.message : String(error)}\n\n修复设置后请退出并重新启动 DevEco Code。`;
    registerOpenCommand(api, () => api.ui.dialog.replace(() => <api.ui.DialogAlert
      title="ArkTS 配置加载失败" message={message} onConfirm={() => api.ui.dialog.clear()} />));
    api.ui.toast({ variant: "error", title: "ArkTS 配置加载失败", message: "输入 /arkts 查看设置文件和具体错误。", duration: 10_000 });
    return;
  }
  const controller = new Workbench(config);
  const [tab, setTab] = createSignal<Tab>("risk");
  let previous: TuiRouteCurrent = { name: "home" };
  const run = (task: () => Promise<void>) => {
    if (controller.state.busy || api.ui.dialog.open) return;
    void task().catch((error: unknown) => api.ui.toast({ variant: "error", message: String(error) }));
  };
  const prompt = (title: string, value: string, confirm: (value: string) => void, placeholder?: string) => {
    if (controller.state.busy || api.ui.dialog.open) return;
    api.ui.dialog.replace(() => <api.ui.DialogPrompt title={title} value={value} placeholder={placeholder}
      onConfirm={(input) => { api.ui.dialog.clear(); confirm(input); }} onCancel={() => api.ui.dialog.clear()} />);
  };
  const confirm = (title: string, message: string, task: () => Promise<void>) => {
    if (controller.state.busy || api.ui.dialog.open) return;
    api.ui.dialog.replace(() => <api.ui.DialogConfirm title={title} message={message}
      onConfirm={() => { api.ui.dialog.clear(); run(task); }} onCancel={() => api.ui.dialog.clear()} />);
  };
  const actions: Actions = {
    scan: () => prompt("异味检测范围", config.projectRoot, (value) => {
      setTab("logs"); run(() => controller.scan(resolve(config.projectRoot, value)));
    }, "工程内文件或目录"),
    importFile: () => prompt("导入异味 JSON 文件", "", (value) => {
      if (value.trim()) { setTab("risk"); run(() => controller.importReport({ file: resolve(config.projectRoot, value.trim()) })); }
    }),
    paste: () => prompt("粘贴异味 JSON 对象或数组", "", (text) => { setTab("risk"); run(() => controller.importReport({ text })); }),
    instructions: () => prompt("业务说明（修改后需重新分析风险）", controller.state.instructions,
      (value) => controller.setInstructions(value)),
    prepare: () => { setTab("risk"); run(() => controller.prepare()); },
    execute: () => { setTab("result"); run(() => controller.execute()); },
    diff: () => {
      setTab("diff");
      if (controller.state.busy || api.ui.dialog.open) return;
      const changes = controller.state.candidate?.changes ?? [];
      if (!changes.length) { api.ui.toast({ variant: "info", message: "尚无候选变更" }); return; }
      api.ui.dialog.replace(() => <api.ui.DialogSelect title="选择 Diff 文件"
        options={changes.map((change) => ({ title: change.relativePath, value: change.relativePath, description: change.changeType }))}
        onSelect={(option) => { api.ui.dialog.clear(); run(() => controller.showDiff(option.value)); }} />);
    },
    apply: () => {
      const candidate = controller.state.candidate;
      if (!candidate || candidate.verdict !== "PASS" || controller.state.applyState === "APPLIED") {
        api.ui.toast({ variant: "warning", message: "请选择尚未应用的 PASS 候选" }); return;
      }
      confirm("应用已验证候选", `将写入 ${candidate.changes.length} 个文件：\n${candidate.originalRoot}\n\n应用后请按 v 执行复检。`, () => controller.apply());
    },
    validate: () => { setTab("result"); run(() => controller.validateApplied()); },
    revalidate: () => { setTab("result"); run(() => controller.validateCandidate()); },
    history: () => { setTab("history"); run(() => controller.history()); },
    environment: () => { setTab("environment"); run(() => controller.inspect()); },
    recover: () => confirm("恢复应用前内容", "将按冻结基线恢复当前候选写入的内容。后续用户修改会保留并报告冲突。", () => controller.recover()),
    cancel: () => { if (!api.ui.dialog.open) controller.cancel(); },
    back: () => {
      if (api.ui.dialog.open) { api.ui.dialog.clear(); return; }
      api.route.navigate(previous.name, "params" in previous ? previous.params : undefined);
    },
    restore: (id) => run(() => controller.restore(id)),
  };
  const open = () => {
    if (api.route.current.name !== ROUTE) previous = api.route.current;
    api.ui.dialog.clear();
    api.route.navigate(ROUTE);
  };
  registerOpenCommand(api, open);
  const bindings: { key: string; cmd: () => void; desc: string }[] = [
    { key: "escape", cmd: actions.back, desc: "返回宿主" },
    ...Object.entries({ s: actions.scan, i: actions.importFile, o: actions.paste, b: actions.instructions,
      p: actions.prepare, x: actions.execute, d: actions.diff, a: actions.apply, v: actions.validate,
      t: actions.revalidate, h: actions.history, e: actions.environment, c: actions.cancel, r: actions.recover })
      .map(([key, action]) => ({ key, cmd: () => { if (!api.ui.dialog.open) action(); }, desc: key })),
    ...tabs.map((value, index) => ({ key: String(index + 1), cmd: () => { if (!api.ui.dialog.open) setTab(value.id); }, desc: value.label })),
    { key: "j", cmd: () => { if (!api.ui.dialog.open) controller.select(controller.state.selected + 1); }, desc: "下一个问题" },
    { key: "k", cmd: () => { if (!api.ui.dialog.open) controller.select(controller.state.selected - 1); }, desc: "上一个问题" },
  ];
  api.keymap.registerLayer({ mode: ROUTE, bindings });
  const unregister = api.route.register([{ name: ROUTE,
    render: () => <WorkbenchView api={api} controller={controller} tab={tab} setTab={setTab} actions={actions} /> }]);
  api.lifecycle.onDispose(async () => {
    await controller.dispose();
    if (api.route.current.name === ROUTE) api.route.navigate("home");
    unregister();
  });
};

export default { id: "arkts.refactor", tui } satisfies TuiPluginModule;
