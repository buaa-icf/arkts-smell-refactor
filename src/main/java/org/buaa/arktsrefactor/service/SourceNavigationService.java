package org.buaa.arktsrefactor.service;

import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import org.buaa.arktsrefactor.model.Issue;

import java.nio.file.Path;
import java.util.regex.Pattern;

public final class SourceNavigationService {
    private SourceNavigationService() { }
    public static void open(Project project, Issue issue) {
        var virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(issue.absolutePath()));
        int line = issue.line();
        if (virtualFile != null && !issue.symbol().isBlank()) {
            var document = FileDocumentManager.getInstance().getDocument(virtualFile);
            if (document != null) {
                String name = issue.symbol().substring(issue.symbol().lastIndexOf('.') + 1);
                Pattern declaration = Pattern.compile("(?m)^[\\t ]*(?:(?:export|public|private|protected|static|async|override|function)\\s+)*" + Pattern.quote(name) + "\\s*\\(");
                int hint = line;
                line = ReadAction.compute(() -> {
                    var matches = declaration.matcher(document.getText()); int closest = hint, distance = Integer.MAX_VALUE;
                    while (matches.find()) {
                        int candidate = document.getLineNumber(matches.start()) + 1;
                        if (Math.abs(candidate - hint) < distance) { closest = candidate; distance = Math.abs(candidate - hint); }
                    }
                    return closest;
                });
            }
        }
        open(project, issue.absolutePath(), line);
    }
    public static void open(Project project, String path, int line) {
        if (project.getBasePath() == null) return;
        Path root = Path.of(project.getBasePath()).toAbsolutePath().normalize();
        Path file = Path.of(path).toAbsolutePath().normalize();
        if (!file.startsWith(root)) throw new IllegalArgumentException("文件不在当前工程范围内");
        try { if (!file.toRealPath().startsWith(root.toRealPath())) throw new IllegalArgumentException("文件通过链接离开当前工程"); }
        catch (java.io.IOException e) { throw new IllegalArgumentException("文件不存在或不可读：" + path, e); }
        var virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(file);
        if (virtualFile == null) throw new IllegalArgumentException("文件不存在：" + path);
        var document = FileDocumentManager.getInstance().getDocument(virtualFile);
        int maximum = document == null ? Math.max(0, line - 1) : Math.max(0, document.getLineCount() - 1);
        new OpenFileDescriptor(project, virtualFile, Math.min(maximum, Math.max(0, line - 1)), 0).navigate(true);
    }
}
