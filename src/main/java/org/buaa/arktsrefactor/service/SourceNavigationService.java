package org.buaa.arktsrefactor.service;

import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import org.buaa.arktsrefactor.model.Issue;

import java.nio.file.Path;

public final class SourceNavigationService {
    private SourceNavigationService() { }
    public static void open(Project project, Issue issue) { open(project, issue.absolutePath(), issue.line()); }
    public static void open(Project project, String path, int line) {
        if (project.getBasePath() == null) return;
        Path root = Path.of(project.getBasePath()).toAbsolutePath().normalize();
        Path file = Path.of(path).toAbsolutePath().normalize();
        if (!file.startsWith(root)) throw new IllegalArgumentException("文件不在当前工程范围内");
        var virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(file);
        if (virtualFile == null) throw new IllegalArgumentException("文件不存在：" + path);
        new OpenFileDescriptor(project, virtualFile, Math.max(0, line - 1), 0).navigate(true);
    }
}
