package org.buaa.arktsrefactor.ui;

import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory;
import com.intellij.openapi.options.Configurable;
import com.intellij.openapi.options.ConfigurationException;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBTextField;
import org.buaa.arktsrefactor.persistence.PluginSettings;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.*;
import java.util.LinkedHashMap;
import java.util.Map;

public final class SettingsConfigurable implements Configurable {
    private JPanel panel;
    private final Map<String, JBTextField> fields = new LinkedHashMap<>();
    private JComboBox<String> linterMode;

    @Override public String getDisplayName() { return "ArkTS Refactor"; }

    @Override public @Nullable JComponent createComponent() {
        panel = new JPanel(new GridBagLayout());
        fields.clear();
        row("backend", "重构后端目录", true);
        row("homecheck", "HomeCheck 目录", true);
        row("studio", "DevEco Studio 目录", true);
        row("node", "Node 可执行文件", false);
        row("deveco", "DevEco Code（留空自动发现）", false);
        row("hvigor", "Hvigor（留空自动发现）", false);
        row("ohpm", "ohpm（留空自动发现）", false);
        row("linter", "Linter（留空自动发现）", false);
        row("runs", "任务与候选目录（建议短路径）", true);
        linterMode = new JComboBox<>(new String[]{"required", "skip"});
        GridBagConstraints c = constraints(fields.size());
        panel.add(new JBLabel("Linter 门禁策略"), c);
        c.gridx = 1; panel.add(linterMode, c);
        c = constraints(fields.size() + 1); c.gridwidth = 3; c.weighty = 1; c.anchor = GridBagConstraints.NORTHWEST;
        panel.add(new JBLabel("<html>skip 会记录为显式豁免。候选通过后仍需预览并应用。<br>工具路径为空时从环境发现；更改配置后重新检查环境。</html>"), c);
        reset();
        return panel;
    }

    private void row(String key, String label, boolean directory) {
        int index = fields.size();
        JBTextField field = new JBTextField(36);
        field.getAccessibleContext().setAccessibleName(label);
        fields.put(key, field);
        GridBagConstraints c = constraints(index);
        panel.add(new JBLabel(label), c);
        c.gridx = 1; c.weightx = 1; c.fill = GridBagConstraints.HORIZONTAL; panel.add(field, c);
        JButton browse = new JButton("选择…");
        browse.addActionListener(e -> {
            var descriptor = directory ? FileChooserDescriptorFactory.createSingleFolderDescriptor()
                    : FileChooserDescriptorFactory.createSingleFileDescriptor();
            var file = FileChooser.chooseFile(descriptor, null, null);
            if (file != null) field.setText(file.getPath());
        });
        c.gridx = 2; c.weightx = 0; c.fill = GridBagConstraints.NONE; panel.add(browse, c);
    }

    private static GridBagConstraints constraints(int row) {
        GridBagConstraints c = new GridBagConstraints();
        c.gridy = row; c.anchor = GridBagConstraints.WEST; c.insets = new Insets(4, 6, 4, 6);
        return c;
    }

    private PluginSettings.Config read() {
        var config = PluginSettings.getInstance().getState().copy();
        for (var entry : fields.entrySet()) {
            try { PluginSettings.Config.class.getField(entry.getKey()).set(config, entry.getValue().getText().trim()); }
            catch (ReflectiveOperationException e) { throw new IllegalStateException(e); }
        }
        config.linterMode = (String) linterMode.getSelectedItem();
        return config;
    }

    @Override public boolean isModified() {
        if (panel == null) return false;
        var config = PluginSettings.getInstance().getState();
        for (var entry : fields.entrySet()) {
            try { if (!entry.getValue().getText().trim().equals(PluginSettings.Config.class.getField(entry.getKey()).get(config))) return true; }
            catch (ReflectiveOperationException e) { throw new IllegalStateException(e); }
        }
        return !config.linterMode.equals(linterMode.getSelectedItem());
    }

    @Override public void apply() throws ConfigurationException {
        var config = read();
        if (config.node.isBlank() || config.backend.isBlank() || config.runs.isBlank())
            throw new ConfigurationException("请配置 Node.js、TypeScript 后端目录和任务目录。");
        PluginSettings.getInstance().loadState(config);
    }

    @Override public void reset() {
        if (panel == null) return;
        var config = PluginSettings.getInstance().getState();
        fields.forEach((key, field) -> {
            try { field.setText((String) PluginSettings.Config.class.getField(key).get(config)); }
            catch (ReflectiveOperationException e) { throw new IllegalStateException(e); }
        });
        linterMode.setSelectedItem(config.linterMode);
    }

    @Override public void disposeUIResources() { panel = null; fields.clear(); linterMode = null; }
}
