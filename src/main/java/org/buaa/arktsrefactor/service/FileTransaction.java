package org.buaa.arktsrefactor.service;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;

/** Byte-preserving transaction shared by the IDE apply action and its Undo action. */
public final class FileTransaction {
    public record Change(String relativePath, byte[] before, byte[] after) {
        public Change { before = before == null ? null : before.clone(); after = after.clone(); }
        @Override public byte[] before() { return before == null ? null : before.clone(); }
        @Override public byte[] after() { return after.clone(); }
    }
    @FunctionalInterface interface Writer { void write(Path path, byte[] bytes) throws IOException; }
    private static final Set<String> IGNORED = Set.of(".git", ".idea", ".hvigor", ".cache", ".test", "build", "coverage",
            "oh_modules", "node_modules", "report", "reports", ".preview", ".gradle");
    private final Path root;
    private final Path journal;
    private final List<Change> changes;
    private final Map<String, String> baseline;
    private boolean applied;

    public FileTransaction(Path root, Path journal, List<Change> changes, Map<String, String> baseline) throws IOException {
        this.root = root.toRealPath(); this.journal = journal.toAbsolutePath().normalize();
        this.changes = List.copyOf(changes); this.baseline = Map.copyOf(baseline);
        Set<String> unique = new HashSet<>();
        for (Change change : changes) {
            checkedPath(change.relativePath());
            if (!allowed(change.relativePath()) || !unique.add(change.relativePath().toLowerCase(Locale.ROOT)))
                throw new IOException("非法或重复的生产变更：" + change.relativePath());
        }
        if (changes.isEmpty()) throw new IOException("没有可应用的变更");
    }

    public List<Change> changes() { return changes; }
    public Path root() { return root; }
    public boolean isApplied() { return applied; }

    public void apply() throws IOException { apply(FileTransaction::writeAtomic); }

    public void verifyBaseline() throws IOException {
        if (!snapshot(root).equals(baseline)) throw new IOException("工程基线已变化，请重新检测和生成候选");
    }

    /** The IDE verifies the full graph on its worker; the write action rechecks all affected files. */
    public void applyWithVerifiedBaseline() throws IOException {
        if (applied) throw new IOException("本次变更已经应用");
        transition(true, FileTransaction::writeAtomic);
        applied = true;
    }

    void apply(Writer writer) throws IOException {
        if (applied) throw new IOException("本次变更已经应用");
        verifyBaseline();
        transition(true, writer);
        applied = true;
    }

    public void undo() throws IOException {
        if (!applied) throw new IOException("本次变更尚未应用或已经撤销");
        transition(false, FileTransaction::writeAtomic);
        applied = false;
    }

    private void transition(boolean forward, Writer writer) throws IOException {
        // Validate every target before modifying any file, including new-file conflicts.
        for (Change change : changes) verify(checkedPath(change.relativePath()), forward ? change.before : change.after);
        List<Change> written = new ArrayList<>();
        journal(forward ? "APPLYING" : "ROLLING_BACK", written);
        try {
            for (Change change : changes) {
                Path path = checkedPath(change.relativePath());
                verify(path, forward ? change.before : change.after);
                written.add(change);
                journal(forward ? "APPLYING" : "ROLLING_BACK", written);
                writer.write(path, forward ? change.after : change.before);
            }
            journal(forward ? "APPLIED" : "ROLLED_BACK", written);
        } catch (IOException error) {
            IOException rollbackError = null;
            for (int index = written.size() - 1; index >= 0; index--) {
                Change change = written.get(index);
                byte[] old = forward ? change.before : change.after;
                byte[] attempted = forward ? change.after : change.before;
                try {
                    Path path = checkedPath(change.relativePath());
                    if (matches(path, old)) continue;
                    verify(path, attempted); // Never overwrite an external edit during recovery.
                    writeAtomic(path, old);
                } catch (IOException recovery) { rollbackError = recovery; error.addSuppressed(recovery); }
            }
            journal(rollbackError == null ? (forward ? "NOT_APPLIED" : "APPLIED") : "CONFLICT", written);
            if (rollbackError != null) throw new IOException("写入失败，回滚存在冲突；请查看事务记录", error);
            throw error;
        }
    }

    private Path checkedPath(String relative) throws IOException {
        Path suffix = Path.of(relative.replace('/', java.io.File.separatorChar));
        if (suffix.isAbsolute() || suffix.toString().isBlank() || suffix.normalize().startsWith(".."))
            throw new IOException("非法相对路径：" + relative);
        Path target = root.resolve(suffix).normalize();
        if (!target.startsWith(root) || target.equals(root)) throw new IOException("路径超出工程：" + relative);
        Path existing = target;
        while (!Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) existing = existing.getParent();
        if (Files.isSymbolicLink(existing) || !existing.toRealPath().startsWith(root)) throw new IOException("路径通过链接离开工程：" + relative);
        return target;
    }

    public static boolean allowed(String relative) {
        String path = "/" + relative.replace('\\', '/').toLowerCase(Locale.ROOT);
        List<String> parts = Arrays.asList(path.split("/"));
        if (parts.contains("..") || parts.contains("test") || parts.contains("ohostest") || parts.contains("appscope")) return false;
        return path.contains("/src/main/resources/") ||
                (path.contains("/src/main/") && (path.endsWith(".ets") || path.endsWith(".ts"))) ||
                (path.endsWith("/index.ets") && parts.size() >= 3);
    }

    public static Map<String, String> snapshot(Path root) throws IOException {
        Map<String, String> result = new TreeMap<>();
        Path actual = root.toRealPath();
        Files.walkFileTree(actual, new SimpleFileVisitor<>() {
            @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                if (!dir.equals(actual) && IGNORED.contains(dir.getFileName().toString())) return FileVisitResult.SKIP_SUBTREE;
                if (!dir.toRealPath().startsWith(actual)) throw new IOException("工程包含越界目录：" + dir);
                return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                if (attrs.isSymbolicLink() || !file.toRealPath().startsWith(actual)) throw new IOException("工程包含链接：" + file);
                result.put(actual.relativize(file).toString().replace('\\', '/'), shaFile(file));
                return FileVisitResult.CONTINUE;
            }
        });
        return result;
    }

    public static String sha(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    public static String shaFile(Path file) throws IOException {
        try (var stream = Files.newInputStream(file)) {
            MessageDigest digest;
            try { digest = MessageDigest.getInstance("SHA-256"); }
            catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
            byte[] buffer = new byte[1024 * 1024]; int length;
            while ((length = stream.read(buffer)) >= 0) { if (length > 0) digest.update(buffer, 0, length); }
            return HexFormat.of().formatHex(digest.digest());
        }
    }

    private static boolean matches(Path path, byte[] expected) throws IOException {
        return expected == null ? !Files.exists(path, LinkOption.NOFOLLOW_LINKS) :
                Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && MessageDigest.isEqual(Files.readAllBytes(path), expected);
    }

    private static void verify(Path path, byte[] expected) throws IOException {
        if (!matches(path, expected)) throw new IOException("文件内容或新增状态发生冲突：" + path);
    }

    private static void writeAtomic(Path path, byte[] bytes) throws IOException {
        if (bytes == null) { Files.deleteIfExists(path); return; }
        Files.createDirectories(path.getParent());
        Path temporary = Files.createTempFile(path.getParent(), ".arkts-refactor-", ".tmp");
        try {
            Files.write(temporary, bytes);
            try { Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException e) { Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(temporary); }
    }

    private void journal(String state, List<Change> written) throws IOException {
        String paths = String.join(",", written.stream().map(change -> quote(change.relativePath())).toList());
        byte[] bytes = ("{\"state\":" + quote(state) + ",\"root\":" + quote(root.toString()) + ",\"written\":[" + paths + "]}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        writeAtomic(journal, bytes);
    }

    private static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
}
