package org.buaa.arktsrefactor.action;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.wm.ToolWindowManager;
import org.jetbrains.annotations.NotNull;

public final class OpenPanelAction extends DumbAwareAction {
    @Override public @NotNull ActionUpdateThread getActionUpdateThread() { return ActionUpdateThread.BGT; }
    @Override public void update(@NotNull AnActionEvent event) { event.getPresentation().setEnabled(event.getProject() != null); }
    @Override public void actionPerformed(@NotNull AnActionEvent event) {
        if (event.getProject() == null) return;
        var window = ToolWindowManager.getInstance(event.getProject()).getToolWindow("ArkTS Refactor");
        if (window != null) window.activate(null);
    }
}
