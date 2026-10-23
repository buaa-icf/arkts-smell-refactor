export function assertCompatible(api: unknown): void {
  const required = ["route.register", "route.navigate", "keymap.registerLayer", "mode.push", "lifecycle.onDispose",
    "ui.dialog.replace", "ui.dialog.clear", "ui.DialogPrompt", "ui.DialogConfirm"];
  const missing = required.filter((path) => {
    let current: unknown = api;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object") return true;
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current !== "function";
  });
  if (missing.length) throw new Error(`ArkTS TUI 需要支持原生 TUI 插件 API 的 DevEco Code / OpenCode 构建。缺少：${missing.join(", ")}。仅服务器插件 API 无法加载此界面。`);
}
