package org.buaa.arktsrefactor.service;

import com.google.gson.*;
import com.intellij.openapi.application.WriteAction;
import com.intellij.openapi.command.CommandProcessor;
import com.intellij.openapi.command.undo.GlobalUndoableAction;
import com.intellij.openapi.command.undo.UndoManager;
import com.intellij.openapi.command.undo.UnexpectedUndoException;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import org.buaa.arktsrefactor.bridge.NodeBridgeClient;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

public final class ApplyTransactionService {
    private final FileTransaction transaction;
    private final String title;
    private Runnable stateChanged = () -> { };

    private ApplyTransactionService(FileTransaction transaction, String candidateId) {
        this.transaction = transaction; this.title = "ArkTS 重构 " + candidateId.substring(0, 8);
    }

    /** Reads and verifies all frozen content on the worker before entering the IDE write action. */
    public static ApplyTransactionService prepare(JsonObject candidate, Path ideRoot, Path runs) throws IOException {
        if (!"PASS".equals(NodeBridgeClient.string(candidate, "verdict"))) throw new IOException("候选未通过全部必需验证");
        String id = NodeBridgeClient.string(candidate, "candidateId");
        UUID.fromString(id);
        Path run = runs.toRealPath().resolve(id).toRealPath();
        if (!run.startsWith(runs.toRealPath())) throw new IOException("候选产物目录越界");
        Path original = Path.of(NodeBridgeClient.string(candidate, "originalRoot")).toRealPath();
        if (!original.startsWith(ideRoot.toRealPath())) throw new IOException("候选不属于当前工程");
        List<FileTransaction.Change> changes = new ArrayList<>();
        long retainedSize = 0;
        for (JsonElement element : candidate.getAsJsonArray("changes")) {
            JsonObject item = element.getAsJsonObject(); String name = NodeBridgeClient.string(item, "relativePath");
            Path suffix = Path.of(name).normalize();
            if (suffix.isAbsolute() || suffix.startsWith("..")) throw new IOException("候选文件路径越界");
            Path afterFile = run.resolve("content/after").resolve(suffix).toRealPath();
            if (!afterFile.startsWith(run.resolve("content/after").toRealPath())) throw new IOException("候选内容通过链接越界");
            retainedSize += Files.size(afterFile);
            if (Files.size(afterFile) > 32L * 1024 * 1024 || retainedSize > 64L * 1024 * 1024) throw new IOException("变更内容过大，无法安全保留 Undo 数据；请缩小任务范围");
            byte[] after = Files.readAllBytes(afterFile);
            if (!FileTransaction.sha(after).equals(NodeBridgeClient.string(item, "afterSha256"))) throw new IOException("候选内容已变化：" + name);
            byte[] before = null;
            if (item.has("beforeSha256") && !item.get("beforeSha256").isJsonNull()) {
                Path beforeFile = run.resolve("content/before").resolve(suffix).toRealPath();
                if (!beforeFile.startsWith(run.resolve("content/before").toRealPath())) throw new IOException("基线内容路径越界");
                retainedSize += Files.size(beforeFile);
                if (Files.size(beforeFile) > 32L * 1024 * 1024 || retainedSize > 64L * 1024 * 1024) throw new IOException("变更内容过大，无法安全保留 Undo 数据；请缩小任务范围");
                before = Files.readAllBytes(beforeFile);
                if (!FileTransaction.sha(before).equals(item.get("beforeSha256").getAsString())) throw new IOException("基线内容已变化：" + name);
            }
            changes.add(new FileTransaction.Change(name, before, after));
        }
        Map<String, String> baseline = new LinkedHashMap<>();
        candidate.getAsJsonObject("baselineFiles").entrySet().forEach(entry -> baseline.put(entry.getKey(), entry.getValue().getAsString()));
        FileTransaction transaction = new FileTransaction(original, run.resolve("apply-transaction.json"), changes, baseline);
        transaction.verifyBaseline();
        return new ApplyTransactionService(transaction, id);
    }

    public void apply(Project project, Runnable stateChanged) {
        this.stateChanged = stateChanged;
        CommandProcessor.getInstance().executeCommand(project, () -> WriteAction.run(() -> {
            ensureSaved();
            try { transaction.applyWithVerifiedBaseline(); refresh(); }
            catch (IOException e) { throw new IllegalStateException(e.getMessage(), e); }
            VirtualFile[] files = transaction.changes().stream()
                    .map(change -> LocalFileSystem.getInstance().findFileByNioFile(transaction.root().resolve(change.relativePath())))
                    .filter(Objects::nonNull).toArray(VirtualFile[]::new);
            registerUndo(project, files, false);
            stateChanged.run();
        }), title, null);
    }

    public void undo(Project project) {
        CommandProcessor.getInstance().executeCommand(project, () -> WriteAction.run(() -> {
            ensureSaved();
            VirtualFile[] files = transaction.changes().stream()
                    .map(change -> LocalFileSystem.getInstance().findFileByNioFile(transaction.root().resolve(change.relativePath())))
                    .filter(Objects::nonNull).toArray(VirtualFile[]::new);
            try { transaction.undo(); refresh(); }
            catch (IOException e) { throw new IllegalStateException(e.getMessage(), e); }
            registerUndo(project, files, true);
            stateChanged.run();
        }), "撤销 " + title, null);
    }

    private void registerUndo(Project project, VirtualFile[] files, boolean undoForward) {
        UndoManager.getInstance(project).undoableActionPerformed(new GlobalUndoableAction(files) {
            @Override public void undo() throws UnexpectedUndoException { change(undoForward); }
            @Override public void redo() throws UnexpectedUndoException { change(!undoForward); }
            private void change(boolean forward) throws UnexpectedUndoException {
                try {
                    ensureSaved();
                    if (forward) transaction.applyWithVerifiedBaseline(); else transaction.undo();
                    refresh(); stateChanged.run();
                } catch (IOException | RuntimeException e) { throw new UnexpectedUndoException(e.getMessage()); }
            }
        });
    }

    public boolean isApplied() { return transaction.isApplied(); }

    private void ensureSaved() {
        var manager = FileDocumentManager.getInstance();
        for (var document : manager.getUnsavedDocuments()) {
            var file = manager.getFile(document);
            if (file != null && Path.of(file.getPath()).toAbsolutePath().normalize().startsWith(transaction.root()))
                throw new IllegalStateException("工程存在未保存编辑，候选不能覆盖它；请重新保存、检测和生成。");
        }
    }

    private void refresh() {
        var fs = LocalFileSystem.getInstance();
        for (var change : transaction.changes()) {
            var parent = fs.refreshAndFindFileByNioFile(transaction.root().resolve(change.relativePath()).getParent());
            if (parent != null) parent.refresh(false, true);
            var file = fs.refreshAndFindFileByNioFile(transaction.root().resolve(change.relativePath()));
            if (file != null) FileDocumentManager.getInstance().reloadFiles(file);
        }
    }
}
