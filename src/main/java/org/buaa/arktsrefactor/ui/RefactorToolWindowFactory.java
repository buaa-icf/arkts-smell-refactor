package org.buaa.arktsrefactor.ui;

import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.ContentFactory;
import org.jetbrains.annotations.NotNull;

public final class RefactorToolWindowFactory implements ToolWindowFactory, DumbAware {
    @Override public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow window) {
        RefactorPanel panel = new RefactorPanel(project);
        var content = ContentFactory.getInstance().createContent(panel, "", false);
        window.getContentManager().addContent(content);
    }
}
