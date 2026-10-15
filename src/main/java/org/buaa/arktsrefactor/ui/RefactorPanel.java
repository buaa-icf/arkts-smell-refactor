package org.buaa.arktsrefactor.ui;

import com.google.gson.*;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.options.ShowSettingsUtil;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.ui.components.*;
import com.intellij.ui.table.JBTable;
import org.buaa.arktsrefactor.model.Issue;
import org.buaa.arktsrefactor.service.ProjectSessionService;
import org.buaa.arktsrefactor.service.SourceNavigationService;

import javax.swing.*;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import javax.swing.table.AbstractTableModel;
import javax.swing.table.TableRowSorter;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.nio.file.Path;
import java.util.List;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

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
    private final JBTextArea logs = textArea();
    private final JBLabel status = new JBLabel();
    private final JProgressBar progress = new JProgressBar();
    private final JComboBox<String> scope = new JComboBox<>(new String[]{"当前文件", "选中目录", "当前工程"});
    private final Map<String, JCheckBoxMenuItem> rules = new LinkedHashMap<>();
    private final JTabbedPane tabs = new JTabbedPane();
    private final List<JButton> idleButtons = new ArrayList<>();
    private final JButton cancel = new JButton("取消");
    private final JCheckBox followLog = new JCheckBox("跟随日志", true);
    private List<Issue> renderedIssues = List.of();

    public RefactorPanel(Project project) {
        super(new BorderLayout(6, 6));
        this.project = project;
        this.service = ProjectSessionService.getInstance(project);
        setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
        JPanel top = new JPanel(new BorderLayout(4, 4));
        top.add(new JBLabel("工程：" + project.getName()), BorderLayout.NORTH);
        JPanel tools = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
        tools.add(scope);
        tools.add(button("规则…", this::chooseRules));
        tools.add(button("开始检测", this::detect));
        tools.add(button("导入…", this::importFile));
        tools.add(button("粘贴 JSON", this::pasteJson));
        tools.add(button("环境检查", service::inspect));
        JButton settings = new JButton("设置…");
        settings.addActionListener(e -> ShowSettingsUtil.getInstance().showSettingsDialog(project, SettingsConfigurable.class));
        tools.add(settings);
        cancel.addActionListener(e -> service.cancel()); tools.add(cancel);
        top.add(tools, BorderLayout.CENTER); add(top, BorderLayout.NORTH);
        rules.put("@extrulesproject/feature-envy-check", new JCheckBoxMenuItem("特性依恋", true));
        rules.put("@extrulesproject/long-method-check", new JCheckBoxMenuItem("过长方法", true));
        rules.put("@extrulesproject/switch-statement-check", new JCheckBoxMenuItem("复杂分支", true));
        rules.put("@extrulesproject/code-clone-fragment-check", new JCheckBoxMenuItem("重复片段", true));

        JPanel results = new JPanel(new BorderLayout(4, 4));
        search.getEmptyText().setText("筛选文件、规则、方法或检测消息");
        search.getAccessibleContext().setAccessibleName("筛选检测结果");
        results.add(search, BorderLayout.NORTH);
        table.setRowSorter(sorter); table.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        table.setAutoResizeMode(JTable.AUTO_RESIZE_LAST_COLUMN);
        table.getEmptyText().setText("选择检测范围，或导入异味 JSON");
        table.getSelectionModel().addListSelectionListener(e -> { if (!e.getValueIsAdjusting()) showIssue(); });
        table.addMouseListener(new MouseAdapter() {
            @Override public void mouseClicked(MouseEvent e) { if (e.getClickCount() == 2) safe(() -> navigate()); }
        });
        JSplitPane split = new JSplitPane(JSplitPane.VERTICAL_SPLIT, new JBScrollPane(table), new JBScrollPane(details));
        split.setResizeWeight(.6); results.add(split, BorderLayout.CENTER);
        JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
        actions.add(button("打开代码", this::navigate)); actions.add(button("关联片段…", this::related));
        results.add(actions, BorderLayout.SOUTH);
        tabs.addTab("检测结果", results);
        tabs.addTab("环境", new JBScrollPane(environment));
        JPanel logPanel = new JPanel(new BorderLayout()); logPanel.add(new JBScrollPane(logs), BorderLayout.CENTER);
        logPanel.add(followLog, BorderLayout.SOUTH); tabs.addTab("运行日志", logPanel);
        add(tabs, BorderLayout.CENTER);
        JPanel footer = new JPanel(new BorderLayout(4, 4));
        progress.setPreferredSize(new Dimension(80, 5)); footer.add(progress, BorderLayout.NORTH);
        footer.add(status, BorderLayout.CENTER); add(footer, BorderLayout.SOUTH);
        search.getDocument().addDocumentListener(new DocumentListener() {
            private void filter() { sorter.setRowFilter(search.getText().isBlank() ? null : RowFilter.regexFilter("(?i)" + Pattern.quote(search.getText()))); }
            @Override public void insertUpdate(DocumentEvent e) { filter(); }
            @Override public void removeUpdate(DocumentEvent e) { filter(); }
            @Override public void changedUpdate(DocumentEvent e) { filter(); }
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
        if (issue == null) { details.setText("选择一条异味查看检测证据。"); return; }
        StringBuilder text = new StringBuilder(issue.label()).append("  ·  ").append(issue.symbol()).append('\n')
                .append(issue.path()).append(':').append(issue.line()).append('\n').append(issue.message())
                .append("\n\n规则：").append(issue.rule()).append("\n状态：").append(issue.supported() ? "可分析重构风险" : "此规则仅支持只读查看");
        for (JsonElement item : issue.data().getAsJsonArray("relatedTargets")) {
            text.append("\n关联片段：").append(item.getAsJsonObject().get("filePath").getAsString());
        }
        details.setText(text.toString()); details.setCaretPosition(0);
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
        progress.setIndeterminate(state.busy); progress.setVisible(state.busy);
        idleButtons.forEach(button -> button.setEnabled(!state.busy)); cancel.setEnabled(state.busy);
        scope.setEnabled(!state.busy);
        if (renderedIssues != state.issues) {
            renderedIssues = state.issues; model.rows = state.issues; model.fireTableDataChanged();
            table.getEmptyText().setText(state.issues.isEmpty() ? state.status : "");
            if (!state.issues.isEmpty() && table.getRowCount() > 0) table.setRowSelectionInterval(0, 0);
        }
        if (state.environment != null) {
            StringBuilder text = new StringBuilder();
            for (JsonElement element : state.environment.getAsJsonArray("tools")) {
                JsonObject tool = element.getAsJsonObject(); text.append(tool.get("available").getAsBoolean() ? "✓ " : "✕ ")
                        .append(tool.get("name").getAsString()).append("\n  ").append(tool.get("path").getAsString()).append("\n\n");
            }
            text.append("检测可用：").append(state.environment.get("canDetect")).append("\n重构可用：").append(state.environment.get("canRefactor"));
            environment.setText(text.toString());
        }
        if (!logs.getText().equals(state.log)) {
            int caret = logs.getCaretPosition(); logs.setText(state.log);
            logs.setCaretPosition(followLog.isSelected() ? logs.getDocument().getLength() : Math.min(caret, logs.getDocument().getLength()));
        }
    }

    @Override public void dispose() { service.unsubscribe(listener); }

    private static final class IssueTableModel extends AbstractTableModel {
        private List<Issue> rows = List.of();
        private final String[] columns = {"规则", "文件", "行", "方法 / 片段", "级别"};
        @Override public int getRowCount() { return rows.size(); }
        @Override public int getColumnCount() { return columns.length; }
        @Override public String getColumnName(int column) { return columns[column]; }
        @Override public Object getValueAt(int row, int column) {
            Issue issue = rows.get(row);
            return switch (column) { case 0 -> issue.label(); case 1 -> issue.path(); case 2 -> issue.line(); case 3 -> issue.symbol().isBlank() ? "关联片段" : issue.symbol(); default -> issue.text("severity"); };
        }
        @Override public Class<?> getColumnClass(int column) { return column == 2 ? Integer.class : String.class; }
    }
}
