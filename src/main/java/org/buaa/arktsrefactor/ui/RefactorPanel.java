package org.buaa.arktsrefactor.ui;

import com.google.gson.*;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffManager;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.FileEditorManagerListener;
import com.intellij.openapi.fileEditor.FileEditorManagerEvent;
import com.intellij.openapi.options.ShowSettingsUtil;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.ui.components.*;
import com.intellij.ui.table.JBTable;
import org.buaa.arktsrefactor.model.Issue;
import org.buaa.arktsrefactor.service.ProjectSessionService;
import org.buaa.arktsrefactor.service.SourceNavigationService;
import org.buaa.arktsrefactor.service.FileTransaction;
import org.buaa.arktsrefactor.bridge.PythonBridgeClient;
import org.buaa.arktsrefactor.persistence.PluginSettings;

import javax.swing.*;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import javax.swing.table.AbstractTableModel;
import javax.swing.table.TableRowSorter;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.List;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;

public final class RefactorPanel extends JBPanel<RefactorPanel> implements Disposable {
    private final Project project;
    private final ProjectSessionService service;
    private final Runnable listener = this::render;
    private final IssueTableModel model = new IssueTableModel();
    private final JBTable table = new JBTable(model);
    private final TableRowSorter<IssueTableModel> sorter = new TableRowSorter<>(model);
    private final JBTextField search = new JBTextField();
    private final JBTextArea details = textArea();
    private final JBTextArea environment = textArea();
    private final JBTextArea environmentStatus = textArea();
    private final JProgressBar environmentProgress = new JProgressBar();
    private final JBTextArea logs = textArea();
    private final JBTextArea status = textArea();
    private final JProgressBar progress = new JProgressBar();
    private final JBTextArea scanTarget = textArea();
    private final JBTextArea scanMessage = textArea();
    private final Timer progressTimer = new Timer(1000, e -> updateProgress());
    private final JComboBox<String> scope = new JComboBox<>(new String[]{"当前文件", "选中目录", "当前工程"});
    private final Map<String, JCheckBoxMenuItem> rules = new LinkedHashMap<>();
    private final JTabbedPane tabs = new JTabbedPane();
    private final List<JButton> idleButtons = new ArrayList<>();
    private final JButton cancel = new JButton("取消");
    private final JCheckBox followLog = new JCheckBox("跟随日志", true);
    private List<Issue> renderedIssues = List.of();
    private final JBTextArea risk = textArea();
    private final JBTextArea validation = textArea();
    private final DefaultListModel<JsonObject> historyModel = new DefaultListModel<>();
    private final JBList<JsonObject> historyList = new JBList<>(historyModel);
    private JsonArray renderedHistory;
    private final JBTextArea instructions = new JBTextArea(3, 36);
    private final DefaultListModel<JsonObject> changes = new DefaultListModel<>();
    private final JBList<JsonObject> changeList = new JBList<>(changes);
    private JButton analyzeButton, generateButton, diffButton, applyButton, validateButton, undoButton, discardButton;
    private JButton openRunLogButton, restoreCandidateButton, inspectEnvironmentButton;
    private JsonObject renderedPrepared, renderedCandidate;
    private boolean panelDisposed;

    public RefactorPanel(Project project) {
        super(new BorderLayout(6, 6));
        this.project = project;
        this.service = ProjectSessionService.getInstance(project);
        setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
        JPanel top = new JPanel(new BorderLayout(4, 4));
        top.add(new JBLabel("工程：" + project.getName()), BorderLayout.NORTH);
        JPanel tools = new JPanel(new GridLayout(0, 3, 4, 4));
        tools.add(scope);
        tools.add(button("规则…", this::chooseRules));
        tools.add(button("开始检测", this::detect));
        tools.add(button("导入…", this::importFile));
        tools.add(button("粘贴 JSON", this::pasteJson));
        tools.add(button("环境检查", this::inspectEnvironment));
        JButton settings = new JButton("设置…");
        settings.addActionListener(e -> openSettings());
        tools.add(settings);
        cancel.addActionListener(e -> service.cancel()); tools.add(cancel);
        JButton viewLogs = new JButton("查看运行日志");
        viewLogs.addActionListener(e -> tabs.setSelectedIndex(tabs.indexOfTab("运行日志")));
        tools.add(viewLogs);
        top.add(tools, BorderLayout.CENTER);
        JPanel activity = new JPanel(new BorderLayout(4, 4));
        scanTarget.setRows(3); scanTarget.setOpaque(false); scanTarget.setWrapStyleWord(false);
        scanTarget.getAccessibleContext().setAccessibleName("实际检测目标");
        activity.add(scanTarget, BorderLayout.NORTH);
        progress.setStringPainted(true);
        progress.setPreferredSize(new Dimension(80, 22));
        progress.getAccessibleContext().setAccessibleName("后台任务进度与耗时");
        activity.add(progress, BorderLayout.SOUTH);
        top.add(activity, BorderLayout.SOUTH); add(top, BorderLayout.NORTH);
        scope.addActionListener(e -> updateTarget());
        project.getMessageBus().connect(this).subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, new FileEditorManagerListener() {
            @Override public void selectionChanged(FileEditorManagerEvent event) { updateTarget(); }
        });
        rules.put("@extrulesproject/feature-envy-check", new JCheckBoxMenuItem("特性依恋", true));
        rules.put("@extrulesproject/long-method-check", new JCheckBoxMenuItem("过长方法", true));
        rules.put("@extrulesproject/switch-statement-check", new JCheckBoxMenuItem("复杂分支", true));
        rules.put("@extrulesproject/code-clone-fragment-check", new JCheckBoxMenuItem("重复片段", true));

        JPanel results = new JPanel(new BorderLayout(4, 4));
        search.getEmptyText().setText("筛选文件、规则、方法或检测消息");
        search.getAccessibleContext().setAccessibleName("筛选检测结果");
        JPanel resultHeader = new JPanel(new BorderLayout(4, 4));
        scanMessage.setOpaque(false); scanMessage.setRows(2); scanMessage.setWrapStyleWord(false);
        resultHeader.add(scanMessage, BorderLayout.NORTH);
        resultHeader.add(search, BorderLayout.SOUTH);
        results.add(resultHeader, BorderLayout.NORTH);
        table.setRowSorter(sorter); table.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        table.setAutoResizeMode(JTable.AUTO_RESIZE_LAST_COLUMN);
        table.getEmptyText().setText("选择检测范围，或导入异味 JSON");
        table.getSelectionModel().addListSelectionListener(e -> { if (!e.getValueIsAdjusting()) showIssue(); });
        table.addMouseListener(new MouseAdapter() {
            @Override public void mouseClicked(MouseEvent e) { if (e.getClickCount() == 2) safe(() -> navigate()); }
        });
        JSplitPane split = new JSplitPane(JSplitPane.VERTICAL_SPLIT, new JBScrollPane(table), new JBScrollPane(details));
        split.setResizeWeight(.6); results.add(split, BorderLayout.CENTER);
        JPanel actions = new JPanel(new GridLayout(0, 2, 4, 4));
        actions.add(button("打开代码", this::navigate)); actions.add(button("关联片段…", this::related));
        analyzeButton = button("分析重构风险", this::analyze); actions.add(analyzeButton);
        results.add(actions, BorderLayout.SOUTH);
        tabs.addTab("检测结果", results);
        JPanel task = new JPanel(new BorderLayout(4, 4));
        JPanel input = new JPanel(new BorderLayout(4, 4));
        input.add(new JBLabel("业务说明（编辑后需重新分析）"), BorderLayout.NORTH);
        instructions.setLineWrap(true); instructions.setWrapStyleWord(true);
        instructions.getAccessibleContext().setAccessibleName("重构业务说明");
        input.add(new JBScrollPane(instructions), BorderLayout.CENTER);
        task.add(input, BorderLayout.NORTH); task.add(new JBScrollPane(risk), BorderLayout.CENTER);
        JPanel taskActions = new JPanel(new GridLayout(0, 1, 4, 4));
        generateButton = button("生成候选变更", service::generate); taskActions.add(generateButton);
        taskActions.add(new JBLabel("<html>在工程副本中生成和验证，完成后可预览并应用。</html>")); task.add(taskActions, BorderLayout.SOUTH);
        tabs.addTab("重构任务", task);

        changeList.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        changeList.setCellRenderer((list, value, index, selected, focus) -> {
            var renderer = new DefaultListCellRenderer();
            return renderer.getListCellRendererComponent(list, PythonBridgeClient.string(value, "changeType") + " · " +
                    PythonBridgeClient.string(value, "relativePath") + " (" + PythonBridgeClient.string(value, "size") + " B)", index, selected, focus);
        });
        changeList.addListSelectionListener(e -> { if (diffButton != null) diffButton.setEnabled(!service.state().busy && changeList.getSelectedValue() != null); });
        JPanel candidate = new JPanel(new BorderLayout(4, 4));
        JSplitPane preview = new JSplitPane(JSplitPane.VERTICAL_SPLIT, new JBScrollPane(changeList), new JBScrollPane(validation));
        preview.setResizeWeight(.4); candidate.add(preview, BorderLayout.CENTER);
        JPanel candidateActions = new JPanel(new GridLayout(0, 2, 4, 4));
        diffButton = button("查看 Diff", this::diff); candidateActions.add(diffButton);
        applyButton = button("应用全部变更", this::apply); candidateActions.add(applyButton);
        validateButton = button("重新验证候选", () -> {
            if (service.state().applied) service.validateApplied(); else service.validateCandidate();
        }); candidateActions.add(validateButton);
        undoButton = button("撤销最近应用", service::undo); candidateActions.add(undoButton);
        discardButton = button("放弃候选", service::discard); candidateActions.add(discardButton);
        candidate.add(candidateActions, BorderLayout.SOUTH); tabs.addTab("变更预览", candidate);
        historyList.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        historyList.setCellRenderer((list, value, index, selected, focus) -> new DefaultListCellRenderer().getListCellRendererComponent(list,
                PythonBridgeClient.string(value, "startedAt") + " · " + PythonBridgeClient.string(value, "method") + " · " +
                PythonBridgeClient.string(value, "state") + " " + PythonBridgeClient.string(value, "verdict") + " " + PythonBridgeClient.string(value, "applyState"), index, selected, focus));
        JPanel records = new JPanel(new BorderLayout()); records.add(new JBScrollPane(historyList), BorderLayout.CENTER);
        JPanel recordActions = new JPanel(new GridLayout(0, 2, 4, 4));
        recordActions.add(button("刷新记录", service::history)); recordActions.add(button("打开记录证据…", this::evidence));
        recordActions.add(button("导出运行摘要…", this::exportHistory));
        restoreCandidateButton = button("恢复候选", () -> {
            JsonObject record = historyList.getSelectedValue();
            if (record != null && record.has("candidateId")) service.restoreCandidate(PythonBridgeClient.string(record, "candidateId"));
        }); recordActions.add(restoreCandidateButton);
        historyList.addListSelectionListener(e -> controls());
        records.add(recordActions, BorderLayout.SOUTH); tabs.addTab("运行记录", records);
        JPanel environmentPanel = new JPanel(new BorderLayout(4, 4));
        JPanel environmentHeader = new JPanel(new BorderLayout(4, 4));
        environmentHeader.add(new JBLabel("<html>检查检测与重构所需工具的路径和可用状态。</html>"), BorderLayout.NORTH);
        environmentStatus.setRows(3); environmentStatus.setOpaque(false); environmentStatus.setWrapStyleWord(false);
        environmentHeader.add(environmentStatus, BorderLayout.CENTER);
        environmentProgress.setIndeterminate(true); environmentProgress.setPreferredSize(new Dimension(80, 10));
        environmentHeader.add(environmentProgress, BorderLayout.SOUTH);
        environmentPanel.add(environmentHeader, BorderLayout.NORTH);
        environmentPanel.add(new JBScrollPane(environment), BorderLayout.CENTER);
        JPanel environmentActions = new JPanel(new GridLayout(1, 2, 4, 4));
        inspectEnvironmentButton = new JButton("重新检查"); inspectEnvironmentButton.addActionListener(e -> safe(service::inspect));
        environmentActions.add(inspectEnvironmentButton);
        JButton environmentSettings = new JButton("打开设置…"); environmentSettings.addActionListener(e -> openSettings());
        environmentActions.add(environmentSettings);
        environmentPanel.add(environmentActions, BorderLayout.SOUTH);
        tabs.addTab("环境", environmentPanel);
        tabs.addChangeListener(e -> { if (tabs.getSelectedComponent() == environmentPanel) safe(service::ensureEnvironment); });
        JPanel logPanel = new JPanel(new BorderLayout()); logPanel.add(new JBScrollPane(logs), BorderLayout.CENTER);
        JPanel logActions = new JPanel(new GridLayout(1, 2, 4, 4)); logActions.add(followLog);
        openRunLogButton = button("打开本轮日志…", this::openRunLog); logActions.add(openRunLogButton);
        logPanel.add(logActions, BorderLayout.SOUTH); tabs.addTab("运行日志", logPanel);
        add(tabs, BorderLayout.CENTER);
        JPanel footer = new JPanel(new BorderLayout(4, 4));
        status.setRows(2); status.setOpaque(false); status.setWrapStyleWord(false);
        footer.add(status, BorderLayout.CENTER); add(footer, BorderLayout.SOUTH);
        search.getDocument().addDocumentListener(new DocumentListener() {
            private void filter() {
                String needle = search.getText().toLowerCase(java.util.Locale.ROOT);
                sorter.setRowFilter(needle.isBlank() ? null : new RowFilter<IssueTableModel, Integer>() {
                    @Override public boolean include(Entry<? extends IssueTableModel, ? extends Integer> entry) {
                        Issue issue = model.rows.get(entry.getIdentifier());
                        String text = issue.label() + " " + issue.path() + " " + issue.symbol() + " " + issue.message() + " " + issue.rule();
                        return text.toLowerCase(java.util.Locale.ROOT).contains(needle);
                    }
                });
                updateEmptyText();
            }
            @Override public void insertUpdate(DocumentEvent e) { filter(); }
            @Override public void removeUpdate(DocumentEvent e) { filter(); }
            @Override public void changedUpdate(DocumentEvent e) { filter(); }
        });
        instructions.getDocument().addDocumentListener(new DocumentListener() {
            @Override public void insertUpdate(DocumentEvent e) { controls(); }
            @Override public void removeUpdate(DocumentEvent e) { controls(); }
            @Override public void changedUpdate(DocumentEvent e) { controls(); }
        });
        service.subscribe(listener); render();
    }

    private JButton button(String text, Runnable action) {
        JButton button = new JButton(text); button.addActionListener(e -> safe(action)); idleButtons.add(button); return button;
    }

    private void safe(Runnable action) {
        try { action.run(); }
        catch (Exception error) { Messages.showErrorDialog(project, error.getMessage(), "ArkTS Refactor"); }
    }

    private static JBTextArea textArea() {
        JBTextArea area = new JBTextArea(); area.setEditable(false); area.setLineWrap(true); area.setWrapStyleWord(true);
        area.setBorder(BorderFactory.createEmptyBorder(6, 6, 6, 6)); return area;
    }

    private void chooseRules() {
        JPopupMenu menu = new JPopupMenu(); rules.values().forEach(menu::add); menu.show(this, 20, 60);
    }

    private void inspectEnvironment() {
        tabs.setSelectedIndex(tabs.indexOfTab("环境"));
        service.inspect();
    }

    private void openSettings() {
        ShowSettingsUtil.getInstance().showSettingsDialog(project, SettingsConfigurable.class);
    }

    private void detect() {
        JsonObject params = new JsonObject();
        JsonArray chosen = new JsonArray(); rules.forEach((id, item) -> { if (item.isSelected()) chosen.add(id); });
        if (chosen.isEmpty()) throw new IllegalArgumentException("请至少选择一条规则");
        params.add("rules", chosen);
        if (scope.getSelectedIndex() == 0) {
            var files = FileEditorManager.getInstance(project).getSelectedFiles();
            if (files.length == 0 || !List.of("ets", "ts").contains(files[0].getExtension())) throw new IllegalArgumentException("请打开一个 .ets 或 .ts 文件");
            params.addProperty("scopePath", files[0].getPath());
        } else if (scope.getSelectedIndex() == 1) {
            var folder = FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFolderDescriptor(), project, null);
            if (folder == null) return;
            params.addProperty("scopePath", folder.getPath());
        }
        if (!saveProjectDocuments()) return;
        service.scan(params);
    }

    private boolean saveProjectDocuments() {
        if (project.getBasePath() == null) return false;
        Path root = Path.of(project.getBasePath()).toAbsolutePath().normalize();
        var manager = FileDocumentManager.getInstance();
        List<com.intellij.openapi.editor.Document> documents = new ArrayList<>();
        for (var document : manager.getUnsavedDocuments()) {
            var file = manager.getFile(document);
            if (file != null && Path.of(file.getPath()).toAbsolutePath().normalize().startsWith(root)) documents.add(document);
        }
        if (documents.isEmpty()) return true;
        if (Messages.showYesNoDialog(project, "工程中有 " + documents.size() + " 个未保存文件。保存后继续读取磁盘内容？", "保存修改", "保存并继续", "返回编辑", Messages.getQuestionIcon()) != Messages.YES) return false;
        documents.forEach(manager::saveDocument);
        if (documents.stream().anyMatch(manager::isDocumentUnsaved)) throw new IllegalArgumentException("部分文件未成功保存，请先处理保存错误");
        return true;
    }

    private void importFile() {
        var file = FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFileDescriptor().withFileFilter(f -> "json".equalsIgnoreCase(f.getExtension())), project, null);
        if (file != null) service.importInput(file.getPath(), true);
    }

    private void pasteJson() {
        JTextArea area = new JTextArea(18, 60); area.setLineWrap(true);
        if (JOptionPane.showConfirmDialog(this, new JBScrollPane(area), "粘贴异味 JSON 对象或数组", JOptionPane.OK_CANCEL_OPTION, JOptionPane.PLAIN_MESSAGE) == JOptionPane.OK_OPTION)
            service.importInput(area.getText(), false);
    }

    private Issue selected() {
        int row = table.getSelectedRow();
        return row < 0 ? null : model.rows.get(table.convertRowIndexToModel(row));
    }

    private void showIssue() {
        Issue issue = selected();
        if (issue == null) { details.setText("选择一条异味查看检测证据。"); controls(); return; }
        StringBuilder text = new StringBuilder(issue.label()).append("  ·  ").append(issue.symbol()).append('\n')
                .append(issue.path()).append(':').append(issue.line()).append('\n').append(issue.message())
                .append("\n\n规则：").append(issue.rule()).append("\n状态：").append(issue.supported() ? "可分析重构风险" : "此规则或文件仅支持只读查看");
        for (JsonElement item : issue.data().getAsJsonArray("relatedTargets")) {
            text.append("\n关联片段：").append(item.getAsJsonObject().get("filePath").getAsString());
        }
        details.setText(text.toString()); details.setCaretPosition(0);
        controls();
    }

    private void analyze() {
        Issue issue = selected(); if (issue == null || !issue.supported() || !saveProjectDocuments()) return;
        service.prepare(issue, instructions.getText());
    }

    private void apply() {
        var candidate = service.state().candidate;
        if (candidate == null) return;
        int count = candidate.getAsJsonArray("changes").size();
        if (Messages.showYesNoDialog(project, "将完整应用 " + count + " 个文件变更，并重新验证当前工程。可通过 IDE Undo 撤销。", "应用候选变更", "应用全部变更", "返回预览", Messages.getQuestionIcon()) == Messages.YES)
            service.apply();
    }

    private void diff() {
        JsonObject selectedChange = changeList.getSelectedValue();
        JsonObject candidate = service.state().candidate;
        if (selectedChange == null || candidate == null) return;
        String name = PythonBridgeClient.string(selectedChange, "relativePath");
        Path run = Path.of(PythonBridgeClient.string(candidate, "runDirectory"));
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                Path allowedRun = Path.of(PluginSettings.getInstance().getState().runs).toRealPath();
                if (!run.toRealPath().startsWith(allowedRun)) throw new IllegalArgumentException("Diff 产物目录越界");
                Path afterPath = run.resolve("content/after").resolve(name).toRealPath();
                if (!afterPath.startsWith(run.resolve("content/after").toRealPath())) throw new IllegalArgumentException("Diff 文件路径越界");
                if (Files.size(afterPath) > 8L * 1024 * 1024) throw new IllegalArgumentException("此资源过大，请在证据文件中查看大小和哈希");
                byte[] after = Files.readAllBytes(afterPath);
                if (!FileTransaction.sha(after).equals(PythonBridgeClient.string(selectedChange, "afterSha256"))) throw new IllegalArgumentException("候选内容变化，请重新生成");
                byte[] before = null;
                if (!selectedChange.get("beforeSha256").isJsonNull()) {
                    Path beforePath = run.resolve("content/before").resolve(name).toRealPath();
                    if (!beforePath.startsWith(run.resolve("content/before").toRealPath())) throw new IllegalArgumentException("基线文件路径越界");
                    if (Files.size(beforePath) > 8L * 1024 * 1024) throw new IllegalArgumentException("基线资源过大，请在证据文件中查看大小和哈希");
                    before = Files.readAllBytes(beforePath);
                    if (!FileTransaction.sha(before).equals(selectedChange.get("beforeSha256").getAsString())) throw new IllegalArgumentException("基线内容变化");
                }
                byte[] frozenBefore = before;
                ApplicationManager.getApplication().invokeLater(() -> safe(() -> {
                    if (panelDisposed || project.isDisposed()) return;
                    try {
                        var factory = DiffContentFactory.getInstance(); var type = FileTypeManager.getInstance().getFileTypeByFileName(name);
                        DiffManager.getInstance().showDiff(project, new SimpleDiffRequest(name,
                                frozenBefore == null ? factory.createEmpty() : factory.createFromBytes(project, frozenBefore, type, name),
                                factory.createFromBytes(project, after, type, name), "生成时本地基线", "最终候选"));
                    } catch (Exception e) { throw new IllegalStateException(e.getMessage(), e); }
                }), ModalityState.any());
            } catch (Exception e) {
                ApplicationManager.getApplication().invokeLater(() -> { if (!panelDisposed && !project.isDisposed()) Messages.showErrorDialog(project, e.getMessage(), "无法打开 Diff"); }, ModalityState.any());
            }
        });
    }

    private void evidence() {
        String directory = historyList.getSelectedValue() == null ? service.state().runDirectory : PythonBridgeClient.string(historyList.getSelectedValue(), "runDirectory");
        if (directory.isBlank()) return;
        Path path = Path.of(directory);
        try { if (!path.toRealPath().startsWith(Path.of(PluginSettings.getInstance().getState().runs).toRealPath())) throw new IllegalArgumentException("证据目录越界"); }
        catch (java.io.IOException e) { throw new IllegalArgumentException("证据目录不存在", e); }
        var root = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path);
        if (root == null) return;
        var descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor().withRoots(root);
        var file = FileChooser.chooseFile(descriptor, project, root);
        if (file != null) FileEditorManager.getInstance(project).openFile(file, true);
    }

    private void openRunLog() {
        String directory = service.state().runDirectory;
        if (directory.isBlank()) return;
        try {
            Path root = Path.of(PluginSettings.getInstance().getState().runs).toRealPath();
            Path run = Path.of(directory).toRealPath();
            if (!run.startsWith(root)) throw new IllegalArgumentException("日志目录越界");
            boolean opened = false;
            List<Path> paths = new ArrayList<>();
            var result = service.state().result;
            if (result != null && result.has("steps")) for (JsonElement value : result.getAsJsonArray("steps")) {
                JsonObject step = value.getAsJsonObject();
                if (!List.of("FAIL", "BLOCKED", "INCOMPLETE").contains(PythonBridgeClient.string(step, "status"))) continue;
                String file = PythonBridgeClient.string(step, "logPath");
                if (file.isBlank()) file = PythonBridgeClient.string(step, "output_file");
                if (!file.isBlank()) paths.add(Path.of(file));
            }
            if (paths.isEmpty()) for (String name : new String[]{"backend/refactor-agent.log", "backend/smell.log", "backend/review-agent.log", "scan/HomeCheck.log", "scan.log"}) paths.add(run.resolve(name));
            for (Path path : paths.stream().distinct().toList()) {
                if (!Files.isRegularFile(path)) continue;
                if (!path.toRealPath().startsWith(run)) throw new IllegalArgumentException("日志文件通过链接离开本轮目录");
                var file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path);
                if (file != null) { FileEditorManager.getInstance(project).openFile(file, true); opened = true; }
            }
            if (!opened) throw new IllegalArgumentException("本轮尚未生成日志，请查看面板中的运行日志。");
        } catch (java.io.IOException e) { throw new IllegalArgumentException("无法读取本轮日志：" + e.getMessage(), e); }
    }

    private void exportHistory() {
        JsonObject selected = historyList.getSelectedValue();
        if (selected == null) throw new IllegalArgumentException("请先刷新并选择运行记录");
        var folder = FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFolderDescriptor(), project, null);
        if (folder == null) return;
        JsonObject record = selected.deepCopy();
        Path destination = Path.of(folder.getPath()).resolve("arkts-run-" + java.util.UUID.randomUUID() + ".json");
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                Files.writeString(destination, new GsonBuilder().setPrettyPrinting().create().toJson(record), java.nio.charset.StandardCharsets.UTF_8,
                        java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE);
                ApplicationManager.getApplication().invokeLater(() -> { if (!panelDisposed && !project.isDisposed()) Messages.showInfoMessage(project, "已导出：" + destination, "运行摘要"); }, ModalityState.any());
            } catch (Exception e) {
                ApplicationManager.getApplication().invokeLater(() -> { if (!panelDisposed && !project.isDisposed()) Messages.showErrorDialog(project, e.getMessage(), "导出失败"); }, ModalityState.any());
            }
        });
    }

    private void controls() {
        if (analyzeButton == null) return;
        var state = service.state(); Issue issue = selected();
        boolean instructionsMatch = state.prepared != null && instructions.getText().equals(PythonBridgeClient.string(state.prepared, "instructions"));
        analyzeButton.setEnabled(!state.busy && issue != null && issue.supported());
        generateButton.setEnabled(!state.busy && !state.applied && !state.stale && state.prepared != null && issue != null &&
                issue.id().equals(state.activeIssueId) && instructionsMatch);
        diffButton.setEnabled(!state.busy && changeList.getSelectedValue() != null);
        applyButton.setEnabled(!state.busy && !state.stale && !state.applied && instructionsMatch && state.candidate != null && "PASS".equals(PythonBridgeClient.string(state.candidate, "verdict")));
        applyButton.setToolTipText(state.candidate != null && !"PASS".equals(PythonBridgeClient.string(state.candidate, "verdict"))
                ? "候选副本验证尚未通过：" + PythonBridgeClient.string(state.result, "failureReason") : "将已通过验证的冻结候选应用到原工程");
        validateButton.setText(state.applied ? "重新验证原工程" : "重新验证候选");
        validateButton.setToolTipText(state.applied ? "验证已应用后的原工程" : "重试已有候选的门禁与评审；不重新运行重构 Agent");
        validateButton.setEnabled(!state.busy && !state.stale && state.candidate != null && instructionsMatch);
        JsonObject selectedRecord = historyList.getSelectedValue();
        restoreCandidateButton.setEnabled(!state.busy && selectedRecord != null && selectedRecord.has("hasCandidate") && selectedRecord.get("hasCandidate").getAsBoolean());
        undoButton.setEnabled(!state.busy && service.canUndo());
        discardButton.setEnabled(!state.busy && !state.applied && state.candidate != null);
        instructions.setEnabled(!state.busy);
    }

    private void navigate() { Issue issue = selected(); if (issue != null) SourceNavigationService.open(project, issue); }

    private void related() {
        Issue issue = selected(); if (issue == null) return;
        JsonArray related = issue.data().getAsJsonArray("relatedTargets");
        if (related.isEmpty()) { Messages.showInfoMessage(project, "当前问题没有关联片段。", "关联片段"); return; }
        JPopupMenu popup = new JPopupMenu();
        for (JsonElement element : related) {
            JsonObject target = element.getAsJsonObject(); JMenuItem item = new JMenuItem(target.get("filePath").getAsString());
            item.addActionListener(e -> safe(() -> SourceNavigationService.open(project, target.get("filePath").getAsString(), target.get("startLine").getAsInt())));
            popup.add(item);
        }
        popup.show(this, 20, getHeight() - 80);
    }

    private void render() {
        var state = service.state();
        status.setText(state.status); status.setToolTipText(state.status);
        updateTarget(); updateProgress();
        if (state.busy && !progressTimer.isRunning()) progressTimer.start();
        else if (!state.busy) progressTimer.stop();
        scanMessage.setText(state.scanMessage);
        idleButtons.forEach(button -> button.setEnabled(!state.busy)); cancel.setEnabled(state.busy);
        openRunLogButton.setEnabled(!state.busy && !state.runDirectory.isBlank());
        scope.setEnabled(!state.busy);
        if (renderedIssues != state.issues) {
            renderedIssues = state.issues; model.rows = state.issues; model.fireTableDataChanged();
            if (!state.issues.isEmpty() && table.getRowCount() > 0) table.setRowSelectionInterval(0, 0);
        }
        updateEmptyText();
        renderEnvironment();
        if (!logs.getText().equals(state.log)) {
            int caret = logs.getCaretPosition(); logs.setText(state.log);
            logs.setCaretPosition(followLog.isSelected() ? logs.getDocument().getLength() : Math.min(caret, logs.getDocument().getLength()));
        }
        if (renderedPrepared != state.prepared) {
            renderedPrepared = state.prepared;
            if (state.prepared != null && state.prepared.has("restored")) instructions.setText(PythonBridgeClient.string(state.prepared, "instructions"));
            if (state.risk != null) {
                risk.setText(riskText(state.risk)); risk.setCaretPosition(0); tabs.setSelectedIndex(1);
            } else risk.setText("选择问题并分析风险。静态建议会与实际候选变更分别显示。");
        }
        if (renderedCandidate != state.candidate) {
            renderedCandidate = state.candidate; changes.clear();
            if (state.candidate != null) {
                for (JsonElement entry : state.candidate.getAsJsonArray("changes")) changes.addElement(entry.getAsJsonObject());
                if (!changes.isEmpty()) changeList.setSelectedIndex(0);
                tabs.setSelectedIndex(2);
            }
        }
        StringBuilder summary = new StringBuilder();
        if (state.candidate != null) summary.append("候选副本验证：").append(PythonBridgeClient.string(state.candidate, "verdict"))
                .append("\n原工程状态：").append(state.applied ? "已应用" : "尚未应用").append(state.stale ? " / 内容已变化" : "").append('\n');
        if (state.candidate != null && !state.applied && !"PASS".equals(PythonBridgeClient.string(state.candidate, "verdict")))
            summary.append("应用条件：候选副本的必需门禁与评审通过。可先重新验证候选。\n");
        if (state.result != null) {
            summary.append("本轮结论：").append(PythonBridgeClient.string(state.result, "verdict")).append('\n');
            String reason = PythonBridgeClient.string(state.result, "failureReason");
            if (!reason.isBlank()) summary.append("失败原因：").append(reason).append('\n');
            if (state.result.has("validationPolicy")) summary.append("策略：").append(state.result.get("validationPolicy")).append('\n');
            if (state.result.has("steps")) for (JsonElement element : state.result.getAsJsonArray("steps")) {
                JsonObject step = element.getAsJsonObject(); summary.append(PythonBridgeClient.string(step, "name")).append("  ")
                        .append(PythonBridgeClient.string(step, "status")).append("  ").append(PythonBridgeClient.string(step, "reason")).append('\n');
            }
        }
        state.steps.forEach((name, value) -> summary.append(name).append(": ").append(value).append('\n'));
        if (!validation.getText().equals(summary.toString())) {
            validation.setText(summary.toString()); validation.setCaretPosition(0);
        }
        if (renderedHistory != state.history) {
            renderedHistory = state.history; historyModel.clear();
            for (JsonElement element : state.history) historyModel.addElement(element.getAsJsonObject());
            if (!historyModel.isEmpty()) historyList.setSelectedIndex(0);
        }
        controls();
    }

    private void renderEnvironment() {
        if (tabs.getSelectedIndex() == tabs.indexOfTab("环境")) service.ensureEnvironment();
        var state = service.state();
        environmentStatus.setText(state.environmentMessage + (state.environmentCheckedAt.isBlank() ? "" : "\n上次检查：" + state.environmentCheckedAt));
        environmentProgress.setVisible(state.environmentChecking);
        inspectEnvironmentButton.setEnabled(!state.environmentChecking);
        StringBuilder text = new StringBuilder();
        if (state.environment == null) {
            text.append("检查项目：Python、Node、HomeCheck、ArkTS SDK、重构后端、Agent CLI、Hvigor、ohpm 和 Linter。\n\n")
                    .append(state.environmentMessage).append("\n\n检查失败时可打开设置修正路径，再点击“重新检查”。");
        } else {
            text.append("异味检测：").append(state.environment.get("canDetect").getAsBoolean() ? "所需工具已找到" : "缺少所需工具")
                    .append("\n候选重构：").append(state.environment.get("canRefactor").getAsBoolean() ? "所需工具已找到" : "缺少所需工具").append("\n\n");
            for (JsonElement element : state.environment.getAsJsonArray("tools")) {
                JsonObject tool = element.getAsJsonObject();
                String name = switch (PythonBridgeClient.string(tool, "name")) {
                    case "deveco" -> "DevEco Code / Agent CLI";
                    case "hvigorw" -> "Hvigor";
                    case "ohpm" -> "ohpm";
                    case "codelinter" -> "Linter";
                    default -> PythonBridgeClient.string(tool, "name");
                };
                boolean required = !tool.has("required") || tool.get("required").getAsBoolean();
                text.append(tool.get("available").getAsBoolean() ? "✓ 已找到  " : "✕ 未找到  ").append(name)
                        .append(required ? "" : "（当前策略可跳过）").append('\n');
                String path = PythonBridgeClient.string(tool, "path");
                text.append("  ").append(path.isBlank() ? "未配置，自动发现也未找到" : path).append("\n\n");
            }
            text.append("此检查确认工具路径；Agent 登录、实际构建和设备测试状态由具体任务验证。");
        }
        if (!environment.getText().equals(text.toString())) {
            environment.setText(text.toString()); environment.setCaretPosition(0);
        }
    }

    private void updateTarget() {
        var state = service.state();
        String target = state.scanTarget;
        String label = "本次检测：";
        if (target.isBlank()) {
            if (scope.getSelectedIndex() == 0) {
                var files = FileEditorManager.getInstance(project).getSelectedFiles();
                target = files.length == 0 ? "请打开一个 .ets 或 .ts 文件" : files[0].getPath();
                label = "当前文件：";
            } else {
                target = scope.getSelectedIndex() == 1 ? "点击开始检测后选择目录" : project.getBasePath();
                label = "检测范围：";
            }
        }
        scanTarget.setText(label + target);
        scanTarget.setToolTipText(target);
    }

    private void updateProgress() {
        var state = service.state();
        progress.setVisible(state.busy);
        if (!state.busy) { progress.setIndeterminate(false); return; }
        progress.setIndeterminate(true);
        long seconds = Math.max(0, (System.nanoTime() - state.operationStartedNanos) / 1_000_000_000L);
        String text = state.activeMethod.equals("scan.start") ? "正在检测中" : "正在处理";
        progress.setString(text + " · 已用 " + String.format("%02d:%02d", seconds / 60, seconds % 60));
        progress.setToolTipText(state.status);
    }

    private void updateEmptyText() {
        var state = service.state();
        String text = state.busy && state.activeMethod.equals("scan.start") ? "正在检测中，请稍候…"
                : !state.issues.isEmpty() ? "当前筛选无匹配结果（本轮共 " + state.issues.size() + " 条）"
                : state.scanMessage.startsWith("检测失败") ? "检测失败；请查看上方错误和运行日志"
                : state.scanMessage;
        table.getEmptyText().setText(text);
    }

    private static String riskText(JsonObject report) {
        StringBuilder text = new StringBuilder("静态风险：").append(PythonBridgeClient.string(report, "riskLevel"));
        if (report.has("callers")) text.append("\n生产调用点：").append(PythonBridgeClient.string(report.getAsJsonObject("callers"), "production"));
        text.append("\n测试信息由独立测试计划和实际结果提供。\n\n风险证据：\n");
        if (report.has("risks")) for (JsonElement item : report.getAsJsonArray("risks")) {
            var value = item.getAsJsonObject(); text.append("• ").append(PythonBridgeClient.string(value, "level")).append(" ").append(PythonBridgeClient.string(value, "evidence")).append('\n');
        }
        text.append("\n必须保持的约束：\n");
        if (report.has("recommendedConstraints")) for (JsonElement item : report.getAsJsonArray("recommendedConstraints")) text.append("• ").append(PythonBridgeClient.string(item.getAsJsonObject(), "instruction")).append('\n');
        text.append("\n详细静态画像与局限：\n").append(new GsonBuilder().setPrettyPrinting().create().toJson(report));
        return text.toString();
    }

    @Override public void dispose() { panelDisposed = true; progressTimer.stop(); service.unsubscribe(listener); }

    private static final class IssueTableModel extends AbstractTableModel {
        private List<Issue> rows = List.of();
        private final String[] columns = {"规则", "文件", "行", "方法 / 片段", "级别"};
        @Override public int getRowCount() { return rows.size(); }
        @Override public int getColumnCount() { return columns.length; }
        @Override public String getColumnName(int column) { return columns[column]; }
        @Override public Object getValueAt(int row, int column) {
            Issue issue = rows.get(row);
            return switch (column) { case 0 -> issue.label(); case 1 -> issue.path(); case 2 -> issue.line(); case 3 -> issue.symbol().isBlank() ? ("code-clone".equals(issue.text("smellType")) ? "关联片段" : "未解析符号") : issue.symbol(); default -> issue.text("severity"); };
        }
        @Override public Class<?> getColumnClass(int column) { return column == 2 ? Integer.class : String.class; }
    }
}
