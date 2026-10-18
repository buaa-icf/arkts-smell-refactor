package org.buaa.arktsrefactor.action;

import com.google.gson.JsonObject;
import com.intellij.openapi.actionSystem.*;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.wm.ToolWindowManager;
import org.buaa.arktsrefactor.service.ProjectSessionService;
import org.jetbrains.annotations.NotNull;

public final class DetectSmellsAction extends DumbAwareAction {
    @Override public @NotNull ActionUpdateThread getActionUpdateThread() { return ActionUpdateThread.BGT; }
    @Override public void update(@NotNull AnActionEvent event) {
        var file = event.getData(CommonDataKeys.VIRTUAL_FILE);
        event.getPresentation().setEnabledAndVisible(event.getProject() != null && file != null &&
                (file.isDirectory() || "ets".equals(file.getExtension()) || "ts".equals(file.getExtension())));
    }
    @Override public void actionPerformed(@NotNull AnActionEvent event) {
        var project = event.getProject(); var file = event.getData(CommonDataKeys.VIRTUAL_FILE);
        if (project == null || file == null) return;
        var service = ProjectSessionService.getInstance(project);
        if (service.state().busy) { Messages.showInfoMessage(project, "请等待或取消当前任务。", "ArkTS Refactor"); return; }
        var manager = FileDocumentManager.getInstance();
        var document = manager.getCachedDocument(file);
        if (document != null && manager.isDocumentUnsaved(document)) {
            if (Messages.showYesNoDialog(project, "当前文件未保存，保存后开始检测？", "ArkTS Refactor", Messages.getQuestionIcon()) != Messages.YES) return;
            manager.saveDocument(document);
            if (manager.isDocumentUnsaved(document)) return;
        }
        var window = ToolWindowManager.getInstance(project).getToolWindow("ArkTS Refactor");
        if (window != null) window.activate(null);
        JsonObject params = new JsonObject(); params.addProperty("scopePath", file.getPath()); service.scan(params);
    }
}
