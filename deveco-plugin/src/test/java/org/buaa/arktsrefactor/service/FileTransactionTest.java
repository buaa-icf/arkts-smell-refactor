package org.buaa.arktsrefactor.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class FileTransactionTest {
    @TempDir Path temporary;
    private static final String PAGE = "entry/src/main/ets/Page.ets";
    private static final String HELPER = "entry/src/main/ets/Helper.ets";
    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    private Path root(byte[] before) throws IOException {
        Path root = temporary.resolve("project");
        Files.createDirectories(root.resolve(PAGE).getParent()); Files.write(root.resolve(PAGE), before);
        return root;
    }

    private FileTransaction transaction(Path root, byte[] before) throws IOException {
        return new FileTransaction(root, temporary.resolve("run/apply-transaction.json"), List.of(
                new FileTransaction.Change(PAGE, before, bytes("class Page { helper() {} }\r\n")),
                new FileTransaction.Change(HELPER, null, bytes("export class Helper {}\n"))), FileTransaction.snapshot(root));
    }

    @Test void applyUndoAndRedoPreserveOriginalBytesAndAddedState() throws Exception {
        byte[] before = {(byte) 0xef, (byte) 0xbb, (byte) 0xbf, 'A', '\r', '\n'};
        Path root = root(before); FileTransaction tx = transaction(root, before);
        tx.apply(); assertTrue(Files.exists(root.resolve(HELPER))); assertTrue(tx.isApplied());
        tx.undo(); assertArrayEquals(before, Files.readAllBytes(root.resolve(PAGE)));
        assertFalse(Files.exists(root.resolve(HELPER))); assertFalse(tx.isApplied());
        tx.apply(); assertTrue(tx.isApplied()); assertTrue(Files.exists(root.resolve(HELPER)));
    }

    @Test void unrelatedConfigurationChangeInvalidatesTheWholeCandidate() throws Exception {
        byte[] before = bytes("class Page {}\n"); Path root = root(before); FileTransaction tx = transaction(root, before);
        Files.writeString(root.resolve("build-profile.json5"), "user update");
        assertThrows(IOException.class, tx::apply);
        assertArrayEquals(before, Files.readAllBytes(root.resolve(PAGE))); assertFalse(Files.exists(root.resolve(HELPER)));
    }

    @Test void secondWriteFailureRollsBackAllCompletedFiles() throws Exception {
        byte[] before = bytes("class Page {}\n"); Path root = root(before); FileTransaction tx = transaction(root, before);
        AtomicInteger count = new AtomicInteger();
        assertThrows(IOException.class, () -> tx.apply((path, content) -> {
            if (count.incrementAndGet() == 2) throw new IOException("simulated write failure");
            Files.createDirectories(path.getParent()); Files.write(path, content);
        }));
        assertArrayEquals(before, Files.readAllBytes(root.resolve(PAGE)));
        assertFalse(Files.exists(root.resolve(HELPER))); assertFalse(tx.isApplied());
    }

    @Test void undoRefusesToOverwriteLaterUserEdits() throws Exception {
        byte[] before = bytes("class Page {}\n"); Path root = root(before); FileTransaction tx = transaction(root, before);
        tx.apply(); Files.writeString(root.resolve(PAGE), "user edit after apply");
        assertThrows(IOException.class, tx::undo);
        assertEquals("user edit after apply", Files.readString(root.resolve(PAGE)));
        assertTrue(Files.exists(root.resolve(HELPER)));
    }

    @Test void traversalAndTestModificationAreRejected() throws Exception {
        Path root = root(bytes("original"));
        for (String path : List.of("../outside.ets", "entry/src/test/Page.test.ets", "build-profile.json5")) {
            assertThrows(IOException.class, () -> new FileTransaction(root, temporary.resolve("journal.json"),
                    List.of(new FileTransaction.Change(path, null, bytes("new"))), FileTransaction.snapshot(root)));
        }
    }

    @Test void newFileCollisionPreservesTheUserFile() throws Exception {
        byte[] before = bytes("class Page {}\n"); Path root = root(before); FileTransaction tx = transaction(root, before);
        Files.writeString(root.resolve(HELPER), "user helper");
        assertThrows(IOException.class, tx::apply);
        assertEquals("user helper", Files.readString(root.resolve(HELPER)));
        assertArrayEquals(before, Files.readAllBytes(root.resolve(PAGE)));
    }

    @Test void binaryResourceUndoRestoresExactContent() throws Exception {
        Path root = root(bytes("source")); String name = "entry/src/main/resources/rawfile/image.bin";
        byte[] before = {0, (byte) 255, 10, 13}; byte[] after = {9, 0, (byte) 128, 1, 2};
        Files.createDirectories(root.resolve(name).getParent()); Files.write(root.resolve(name), before);
        FileTransaction tx = new FileTransaction(root, temporary.resolve("run/resources.json"),
                List.of(new FileTransaction.Change(name, before, after)), FileTransaction.snapshot(root));
        tx.apply(); assertArrayEquals(after, Files.readAllBytes(root.resolve(name)));
        tx.undo(); assertArrayEquals(before, Files.readAllBytes(root.resolve(name)));
    }
}
