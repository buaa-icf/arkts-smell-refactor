package org.buaa.arktsrefactor.ui;

import com.intellij.openapi.options.ShowSettingsUtil;
import com.intellij.openapi.project.Project;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBPanel;

import javax.swing.*;
import java.awt.*;

public final class RefactorPanel extends JBPanel<RefactorPanel> {
    public RefactorPanel(Project project) {
        super(new BorderLayout(8, 8));
        setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
        JPanel header = new JPanel(new BorderLayout());
        header.add(new JBLabel("工程：" + project.getName()), BorderLayout.CENTER);
        JButton settings = new JButton("配置环境…");
        settings.addActionListener(e -> ShowSettingsUtil.getInstance().showSettingsDialog(project, SettingsConfigurable.class));
        header.add(settings, BorderLayout.EAST);
        add(header, BorderLayout.NORTH);
        add(new JBLabel("<html><h3>ArkTS Refactor</h3>检测异味 → 分析风险 → 生成候选 → 预览并应用<br><br>从配置环境开始，连接本机 HomeCheck 和重构后端。</html>"), BorderLayout.CENTER);
    }
}
