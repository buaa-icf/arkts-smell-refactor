package org.buaa.arktsrefactor.service;

import com.google.gson.*;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.event.DocumentEvent;
import com.intellij.openapi.editor.event.DocumentListener;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import org.buaa.arktsrefactor.bridge.PythonBridgeClient;
import org.buaa.arktsrefactor.model.Issue;
import org.buaa.arktsrefactor.persistence.PluginSettings;

import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import java.util.function.Function;
import java.nio.file.Path;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;

@Service(Service.Level.PROJECT)
public final class ProjectSessionService implements Disposable {
    public static final class ViewState {
        public List<Issue> issues = List.of();
        public JsonObject environment;
        public boolean environmentChecking;
        public String environmentMessage = "尚未检查；进入此页将自动检查工具路径。";
        public String environmentCheckedAt = "";
        public JsonObject risk;
        public JsonObject candidate;
        public JsonObject prepared;
        public JsonObject result;
        public JsonArray history = new JsonArray();
        public final Map<String, String> steps = new LinkedHashMap<>();
        public String activeIssueId = "";
        public String runDirectory = "";
        public String status = "请选择检测范围，或导入异味 JSON。";
        public String log = "";
        public String activeMethod = "";
        public long operationStartedNanos;
        public String scanTarget = "";
        public String scanMessage = "尚未检测；请选择范围后点击“开始检测”。";
        public boolean busy;
        public boolean applied;
        public boolean stale;
        public boolean applying;
    }

    private final Project project;
    private final ViewState state = new ViewState();
    private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    private final PythonBridgeClient bridge = new PythonBridgeClient();
    private final PythonBridgeClient environmentBridge = new PythonBridgeClient();
    private String environmentAttemptKey = "";
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "arkts-refactor-worker"); thread.setDaemon(true); return thread;
    });
    private volatile boolean disposed;
    private final AtomicBoolean renderQueued = new AtomicBoolean();
    private ApplyTransactionService application;

    public ProjectSessionService(Project project) {
        this.project = project;
        EditorFactory.getInstance().getEventMulticaster().addDocumentListener(new DocumentListener() {
            @Override public void documentChanged(DocumentEvent event) {
                var file = FileDocumentManager.getInstance().getFile(event.getDocument());
                if (file != null) markStale(file.getPath());
            }
        }, this);
        project.getMessageBus().connect(this).subscribe(VirtualFileManager.VFS_CHANGES, new BulkFileListener() {
            @Override public void after(List<? extends VFileEvent> events) { events.forEach(event -> markStale(event.getPath())); }
        });
        ApplicationManager.getApplication().getMessageBus().connect(this).subscribe(PluginSettings.SETTINGS_CHANGED, () -> ui(() -> {
            environmentAttemptKey = ""; state.environment = null; state.environmentCheckedAt = "";
            state.environmentMessage = "工具设置已变化，进入环境页后重新检查。";
            changed();
        }));
    }

    private void markStale(String path) {
        if (state.prepared == null || state.applying || project.getBasePath() == null) return;
        JsonObject prepared = state.prepared;
        Path root = Path.of(PythonBridgeClient.string(prepared, "originalRoot")).toAbsolutePath().normalize();
        Path file = Path.of(path).toAbsolutePath().normalize();
        if (!file.startsWith(root)) return;
        String relative = root.relativize(file).toString().replace('\\', '/');
        if (java.util.Arrays.stream(relative.split("/")).anyMatch(part -> List.of(".git", ".idea", ".hvigor", ".test", "build", "coverage", "oh_modules", "node_modules", ".preview").contains(part))) return;
        boolean wasApplied = state.applied;
        var virtualFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByNioFile(file);
        var document = virtualFile == null ? null : FileDocumentManager.getInstance().getCachedDocument(virtualFile);
        if (document != null && FileDocumentManager.getInstance().isDocumentUnsaved(document)) {
            ui(() -> invalidate(prepared, wasApplied));
            return;
        }
        JsonObject expected = wasApplied && state.candidate != null ? state.candidate.getAsJsonObject("afterFiles") : prepared.getAsJsonObject("baselineFiles");
        String expectedHash = expected.has(relative) ? expected.get(relative).getAsString() : null;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                if (Files.isDirectory(file)) return;
                String currentHash = Files.isRegularFile(file) ? FileTransaction.shaFile(file) : null;
                if (!Objects.equals(expectedHash, currentHash)) ui(() -> invalidate(prepared, wasApplied));
            } catch (Exception e) { ui(() -> invalidate(prepared, wasApplied)); }
        });
    }

    private void invalidate(JsonObject prepared, boolean wasApplied) {
        if (state.prepared != prepared || state.applying || state.applied != wasApplied) return;
        state.stale = true;
        if (!state.busy) state.status = "工程内容已变化；请重新检测和分析，旧候选及验证已失效。";
        changed();
    }
    public static ProjectSessionService getInstance(Project project) { return project.getService(ProjectSessionService.class); }
    public ViewState state() { return state; }
    public void subscribe(Runnable listener) { listeners.add(listener); }
    public void unsubscribe(Runnable listener) { listeners.remove(listener); }

    public void ensureEnvironment() {
        String key = new Gson().toJson(PluginSettings.getInstance().getState());
        if (!key.equals(environmentAttemptKey)) inspect();
    }

    public void inspect() {
        if (disposed || state.environmentChecking) return;
        var config = PluginSettings.getInstance().getState().copy();
        String key = new Gson().toJson(config);
        environmentAttemptKey = key;
        String root = project.getBasePath();
        if (root == null) {
            state.environmentMessage = "环境检查未完成：当前工程没有本地根目录。"; changed(); return;
        }
        state.environmentChecking = true;
        state.environmentMessage = state.busy ? "等待当前任务结束后检查环境…" : "正在检查工具路径…";
        environmentBridge.beginOperation();
        changed();
        worker.submit(() -> {
            try {
                ui(() -> { state.environmentMessage = "正在检查工具路径…"; changed(); });
                JsonObject result = environmentBridge.call("environment.inspect", new JsonObject(), root, config, event -> { });
                ui(() -> {
                    state.environmentChecking = false;
                    if (!key.equals(new Gson().toJson(PluginSettings.getInstance().getState()))) {
                        environmentAttemptKey = ""; state.environmentMessage = "检查期间工具设置发生变化，将按新设置重新检查。";
                    } else {
                        environmentAttemptKey = key;
                        state.environment = result;
                        state.environmentCheckedAt = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
                        state.environmentMessage = "工具路径检查完成；缺失项可通过“打开设置”修正。";
                    }
                    changed();
                });
            } catch (Exception error) {
                ui(() -> {
                    state.environmentChecking = false; state.environment = null; state.environmentCheckedAt = "";
                    state.environmentMessage = "环境检查失败：" + error.getMessage() + "\n请检查 Python 和工具设置后重试。";
                    changed();
                });
            }
        });
    }

    public void scan(JsonObject params) {
        if (state.busy || disposed) return;
        state.scanTarget = params.has("scopePath") ? PythonBridgeClient.string(params, "scopePath") : Objects.toString(project.getBasePath(), "");
        state.scanMessage = "正在检测，请稍候…";
        run("scan.start", params, "正在检测…", result -> {
            replaceIssues(result.getAsJsonArray("issues"));
            state.scanTarget = PythonBridgeClient.string(result, "scopePath");
            int files = result.get("fileCount").getAsInt();
            int rules = result.getAsJsonArray("rules").size();
            state.scanMessage = "检测完成：" + files + " 个文件，" + rules + " 条规则，" + state.issues.size() + " 条异味。";
            state.status = state.scanMessage;
        });
    }

    public void importIssues(JsonElement records) {
        JsonObject params = new JsonObject(); params.add("records", records);
        run("issues.import", params, "正在导入…", result -> {
            replaceIssues(result.getAsJsonArray("issues"));
            state.status = "导入成功：" + state.issues.size() + " 条异味。";
            state.scanMessage = state.status; state.scanTarget = "";
        });
    }

    public void importInput(String value, boolean file) {
        JsonObject params = new JsonObject(); params.addProperty(file ? "file" : "text", value);
        run("issues.import", params, "正在导入…", result -> {
            replaceIssues(result.getAsJsonArray("issues"));
            state.status = "导入成功：" + state.issues.size() + " 条异味。";
            state.scanMessage = state.status; state.scanTarget = "";
        });
    }

    public void prepare(Issue issue, String instructions) {
        if (instructions.length() > 8000) throw new IllegalArgumentException("业务说明最多 8000 个字符，请精简后重新分析");
        JsonObject params = new JsonObject(); params.add("issue", issue.data()); params.addProperty("instructions", instructions);
        run("task.prepare", params, "正在冻结基线与分析风险…", result -> {
            state.activeIssueId = issue.id(); state.prepared = result; state.prepared.addProperty("instructions", instructions);
            state.risk = result.getAsJsonObject("risk"); state.candidate = null; state.result = null; state.applied = false;
            state.stale = false;
            state.status = "风险分析完成；生成候选将在工程副本中执行。";
        });
    }

    public void generate() {
        if (state.prepared == null) return;
        JsonObject params = new JsonObject(); params.addProperty("taskHandle", PythonBridgeClient.string(state.prepared, "taskHandle"));
        state.candidate = null; state.result = null;
        run("task.execute", params, "正在生成并验证候选…", this::candidateResult);
    }

    private void candidateResult(JsonObject response) {
        state.candidate = response.getAsJsonObject("candidate"); state.result = response.getAsJsonObject("result");
        String verdict = PythonBridgeClient.string(state.result, "verdict");
        String reason = PythonBridgeClient.string(state.result, "failureReason");
        state.status = "候选副本验证：" + verdict + (reason.isBlank() ? "" : "；" + reason) +
                (verdict.equals("BLOCKED") ? "。修复环境后可重新验证候选。" : "。") + "原工程状态：尚未应用。";
    }

    public void validateCandidate() {
        if (state.candidate == null || state.applied || state.stale) return;
        JsonObject params = new JsonObject(); params.addProperty("candidateId", PythonBridgeClient.string(state.candidate, "candidateId"));
        run("task.validateCandidate", params, "正在重新验证候选副本…", this::candidateResult);
    }

    public void restoreCandidate(String identifier) {
        JsonObject params = new JsonObject(); params.addProperty("candidateId", identifier);
        run("candidate.restore", params, "正在恢复冻结候选…", response -> {
            state.prepared = response.getAsJsonObject("prepared"); state.risk = state.prepared.getAsJsonObject("risk");
            Issue issue = new Issue(state.prepared.getAsJsonObject("issue"));
            state.issues = List.of(issue); state.activeIssueId = issue.id();
            state.scanTarget = issue.absolutePath(); state.scanMessage = "已恢复候选对应的异味；候选验证通过后可应用。";
            state.applied = false; state.stale = false;
            state.runDirectory = PythonBridgeClient.string(response, "runDirectory");
            candidateResult(response);
            state.status = "已恢复候选，可查看 Diff 或点击“重新验证候选”。原工程状态：尚未应用。";
        });
    }

    public void apply() {
        if (state.candidate == null) return;
        JsonObject params = new JsonObject(); params.addProperty("candidateId", PythonBridgeClient.string(state.candidate, "candidateId"));
        runPrepared("candidate.check", params, "正在核对基线与候选内容…", candidate -> {
            ApplyTransactionService prepared;
            try {
                prepared = ApplyTransactionService.prepare(candidate, Path.of(project.getBasePath()), Path.of(PluginSettings.getInstance().getState().runs));
            } catch (Exception e) { throw new IllegalStateException(e.getMessage(), e); }
            return () -> {
                if (state.stale) throw new IllegalStateException("核对期间工程已变化，请重新检测和生成候选。");
                state.applying = true;
                try {
                    prepared.apply(project, () -> {
                        state.applied = prepared.isApplied();
                        state.result = null;
                        state.stale = !state.applied;
                        state.status = state.applied ? "已应用；请验证当前工程。" : "本次应用已撤销；旧验证结果不再代表当前源码。";
                        changed();
                    });
                    application = prepared;
                    ui(this::validateApplied);
                } finally { state.applying = false; }
            };
        });
    }

    public void validateApplied() {
        if (!state.applied || state.candidate == null) return;
        JsonObject params = new JsonObject(); params.addProperty("candidateId", PythonBridgeClient.string(state.candidate, "candidateId"));
        run("task.validateApplied", params, "正在验证当前工程并复检…", result -> {
            state.result = result.getAsJsonObject("result");
            if (result.has("issues")) {
                List<Issue> issues = new ArrayList<>();
                for (JsonElement issue : result.getAsJsonArray("issues")) issues.add(new Issue(issue.getAsJsonObject()));
                state.issues = List.copyOf(issues);
            }
            state.status = "本轮工程验证：" + PythonBridgeClient.string(state.result, "verdict") + (state.stale ? "；当前编辑内容已变化，结果过期。" : "；已应用的代码保留。");
        });
    }

    public void undo() {
        if (application == null) return;
        state.applying = true;
        try { application.undo(project); }
        finally { state.applying = false; changed(); }
    }

    public boolean canUndo() { return application != null && application.isApplied(); }

    public void discard() {
        if (state.busy || state.applied) return;
        state.candidate = null; state.result = null;
        state.status = "已放弃候选；当前工程未修改。"; changed();
    }

    public void history() {
        run("history.list", new JsonObject(), "正在读取运行记录…", result -> {
            state.history = result.getAsJsonArray("records"); state.status = "运行记录：" + state.history.size() + " 项。";
        });
    }

    private void replaceIssues(JsonArray issues) {
        List<Issue> items = new ArrayList<>();
        for (JsonElement issue : issues) items.add(new Issue(issue.getAsJsonObject()));
        state.issues = List.copyOf(items);
        state.prepared = null; state.candidate = null; state.risk = null; state.result = null;
        state.activeIssueId = ""; state.applied = false;
        state.stale = false;
    }

    public void run(String method, JsonObject params, String status, Consumer<JsonObject> success) {
        runPrepared(method, params, status, result -> () -> success.accept(result));
    }

    private void runPrepared(String method, JsonObject params, String status, Function<JsonObject, Runnable> decode) {
        if (state.busy || disposed) return;
        var config = PluginSettings.getInstance().getState().copy();
        String root = project.getBasePath();
        if (root == null) { state.status = "当前工程没有本地根目录。"; changed(); return; }
        bridge.beginOperation();
        state.busy = true; state.activeMethod = method; state.operationStartedNanos = System.nanoTime();
        state.status = status; state.steps.clear(); state.log = "";
        state.runDirectory = "";
        changed();
        worker.submit(() -> {
            AtomicReference<String> run = new AtomicReference<>("");
            try {
                JsonObject result = bridge.call(method, params, root, config, event -> {
                    if ("run.started".equals(PythonBridgeClient.string(event, "event"))) run.set(PythonBridgeClient.string(event.getAsJsonObject("data"), "runDirectory"));
                    event(event);
                });
                Runnable completion = decode.apply(result);
                ui(() -> {
                    try {
                        if (method.equals("candidate.check") && !new Gson().toJson(config).equals(new Gson().toJson(PluginSettings.getInstance().getState())))
                            throw new IllegalStateException("应用前工具设置发生变化，请重新分析。");
                        completion.run();
                    }
                    catch (Exception e) {
                        state.status = "操作未完成：" + e.getMessage();
                        if (method.equals("scan.start")) state.scanMessage = "检测失败：" + e.getMessage();
                    }
                    finally { state.busy = false; changed(); }
                });
            } catch (Exception error) {
                if (error instanceof CancellationException && !run.get().isBlank()) {
                    try {
                        Path directory = Path.of(run.get()).toRealPath();
                        if (directory.startsWith(Path.of(config.runs).toRealPath())) {
                            Path file = directory.resolve("session.json");
                            JsonObject record = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
                            record.addProperty("state", disposed ? "INTERRUPTED" : "CANCELLED"); record.addProperty("stopReason", disposed ? "IDE_CLOSED" : "USER_CANCELLED");
                            Path temporary = directory.resolve("session-stop.tmp");
                            Files.writeString(temporary, record.toString(), StandardCharsets.UTF_8);
                            Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
                        }
                    } catch (Exception ignored) { /* Existing RUNNING records recover as INTERRUPTED. */ }
                }
                ui(() -> {
                    state.busy = false;
                    state.status = error instanceof CancellationException ? "已取消。" + (state.applied ? "已应用的代码保留。" : "当前工程未应用候选修改。") : "操作未完成：" + error.getMessage();
                    if (method.equals("scan.start")) state.scanMessage = error instanceof CancellationException
                            ? "检测已取消；本轮没有返回检测结果。" : "检测失败：" + error.getMessage() + "；请查看运行日志。";
                    state.log += "\n" + state.status + "\n";
                    changed();
                });
            }
        });
    }

    private void event(JsonObject event) {
        ui(() -> {
            JsonObject data = event.has("data") ? event.getAsJsonObject("data") : new JsonObject();
            switch (PythonBridgeClient.string(event, "event")) {
                case "run.started" -> state.runDirectory = PythonBridgeClient.string(data, "runDirectory");
                case "scan.started" -> {
                    if (state.activeMethod.equals("scan.start")) {
                        state.scanTarget = PythonBridgeClient.string(data, "scopePath");
                        state.scanMessage = "正在检测：" + data.get("fileCount").getAsInt() + " 个文件，" + data.getAsJsonArray("rules").size() + " 条规则…";
                    }
                }
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

    public void changed() {
        if (renderQueued.compareAndSet(false, true)) ui(() -> {
            renderQueued.set(false); listeners.forEach(Runnable::run);
        });
    }

    private void ui(Runnable task) {
        if (disposed || project.isDisposed()) return;
        var manager = ToolWindowManager.getInstance(project);
        if (manager.getToolWindow("ArkTS Refactor") != null) manager.invokeLater(() -> { if (!disposed && !project.isDisposed()) task.run(); });
        else ApplicationManager.getApplication().invokeLater(() -> { if (!disposed && !project.isDisposed()) task.run(); }, ModalityState.any());
    }

    @Override public void dispose() {
        disposed = true; bridge.cancel(); environmentBridge.cancel(); worker.shutdownNow(); listeners.clear();
    }
}
