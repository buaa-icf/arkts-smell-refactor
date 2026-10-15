package org.buaa.arktsrefactor.service;

import com.google.gson.*;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindowManager;
import org.buaa.arktsrefactor.bridge.PythonBridgeClient;
import org.buaa.arktsrefactor.model.Issue;
import org.buaa.arktsrefactor.persistence.PluginSettings;

import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

@Service(Service.Level.PROJECT)
public final class ProjectSessionService implements Disposable {
    public static final class ViewState {
        public List<Issue> issues = List.of();
        public JsonObject environment;
        public JsonObject risk;
        public JsonObject candidate;
        public JsonObject prepared;
        public JsonObject result;
        public final Map<String, String> steps = new LinkedHashMap<>();
        public String activeIssueId = "";
        public String runDirectory = "";
        public String status = "请选择检测范围，或导入异味 JSON。";
        public String log = "";
        public boolean busy;
        public boolean applied;
    }

    private final Project project;
    private final ViewState state = new ViewState();
    private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    private final PythonBridgeClient bridge = new PythonBridgeClient();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "arkts-refactor-worker"); thread.setDaemon(true); return thread;
    });
    private volatile boolean disposed;

    public ProjectSessionService(Project project) { this.project = project; }
    public static ProjectSessionService getInstance(Project project) { return project.getService(ProjectSessionService.class); }
    public ViewState state() { return state; }
    public void subscribe(Runnable listener) { listeners.add(listener); }
    public void unsubscribe(Runnable listener) { listeners.remove(listener); }

    public void inspect() {
        run("environment.inspect", new JsonObject(), "正在检查环境…", result -> {
            state.environment = result;
            state.status = result.get("canRefactor").getAsBoolean() ? "检测与重构工具已找到。" : "环境检查完成；请查看缺失项。";
        });
    }

    public void scan(JsonObject params) {
        run("scan.start", params, "正在检测…", result -> {
            replaceIssues(result.getAsJsonArray("issues"));
            state.status = "检测成功：" + state.issues.size() + " 条异味。";
        });
    }

    public void importIssues(JsonElement records) {
        JsonObject params = new JsonObject(); params.add("records", records);
        run("issues.import", params, "正在导入…", result -> {
            replaceIssues(result.getAsJsonArray("issues"));
            state.status = "导入成功：" + state.issues.size() + " 条异味。";
        });
    }

    public void importInput(String value, boolean file) {
        JsonObject params = new JsonObject(); params.addProperty(file ? "file" : "text", value);
        run("issues.import", params, "正在导入…", result -> {
            replaceIssues(result.getAsJsonArray("issues"));
            state.status = "导入成功：" + state.issues.size() + " 条异味。";
        });
    }

    private void replaceIssues(JsonArray issues) {
        List<Issue> items = new ArrayList<>();
        for (JsonElement issue : issues) items.add(new Issue(issue.getAsJsonObject()));
        state.issues = List.copyOf(items);
        state.prepared = null; state.candidate = null; state.risk = null; state.result = null;
        state.activeIssueId = ""; state.applied = false;
    }

    public void run(String method, JsonObject params, String status, Consumer<JsonObject> success) {
        if (state.busy || disposed) return;
        var config = PluginSettings.getInstance().getState().copy();
        String root = project.getBasePath();
        if (root == null) { state.status = "当前工程没有本地根目录。"; changed(); return; }
        bridge.beginOperation();
        state.busy = true; state.status = status; state.steps.clear(); state.log = "";
        changed();
        worker.submit(() -> {
            try {
                JsonObject result = bridge.call(method, params, root, config, this::event);
                ui(() -> { success.accept(result); state.busy = false; changed(); });
            } catch (Exception error) {
                ui(() -> { state.busy = false; state.status = error instanceof CancellationException ? "已取消。" + (state.applied ? "已应用的代码保留。" : "当前工程未应用候选修改。") : "操作未完成：" + error.getMessage(); changed(); });
            }
        });
    }

    private void event(JsonObject event) {
        ui(() -> {
            JsonObject data = event.has("data") ? event.getAsJsonObject("data") : new JsonObject();
            switch (PythonBridgeClient.string(event, "event")) {
                case "run.started" -> state.runDirectory = PythonBridgeClient.string(data, "runDirectory");
                case "workflow.changed" -> state.status = PythonBridgeClient.string(data, "status");
                case "step.updated" -> state.steps.put(PythonBridgeClient.string(data, "stepId"), PythonBridgeClient.string(data, "status"));
                case "log.appended" -> {
                    state.log += PythonBridgeClient.string(data, "text");
                    if (state.log.length() > 100_000) state.log = state.log.substring(state.log.length() - 100_000);
                }
                default -> { }
            }
            changed();
        });
    }

    public void cancel() {
        if (!state.busy) return;
        state.status = "正在停止本次任务进程…"; changed(); bridge.cancel();
    }

    public void changed() { listeners.forEach(Runnable::run); }

    private void ui(Runnable task) {
        if (disposed || project.isDisposed()) return;
        var manager = ToolWindowManager.getInstance(project);
        if (manager.getToolWindow("ArkTS Refactor") != null) manager.invokeLater(() -> { if (!disposed && !project.isDisposed()) task.run(); });
        else ApplicationManager.getApplication().invokeLater(() -> { if (!disposed && !project.isDisposed()) task.run(); }, ModalityState.any());
    }

    @Override public void dispose() {
        disposed = true; bridge.cancel(); worker.shutdownNow(); listeners.clear();
    }
}
