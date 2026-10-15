package org.buaa.arktsrefactor.bridge;

import com.google.gson.*;
import com.intellij.openapi.application.PathManager;
import org.buaa.arktsrefactor.persistence.PluginSettings;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/** A disposable worker per operation isolates Python state and gives cancellation a process boundary. */
public final class PythonBridgeClient {
    private static final Gson JSON = new Gson();
    private volatile Process active;
    private final AtomicBoolean cancelled = new AtomicBoolean();

    public JsonObject call(String method, JsonObject params, String projectRoot,
                           PluginSettings.Config config, Consumer<JsonObject> events) throws Exception {
        Path script = extractAdapter();
        JsonObject request = new JsonObject();
        request.addProperty("protocolVersion", 1); request.addProperty("type", "request");
        request.addProperty("requestId", UUID.randomUUID().toString());
        request.addProperty("method", method); request.addProperty("projectRoot", projectRoot);
        request.add("params", params); request.add("config", JSON.toJsonTree(config));
        Process process = new ProcessBuilder(config.python, "-u", script.toString())
                .directory(script.getParent().toFile()).start();
        active = process;
        if (cancelled.get()) terminate(process);
        Thread errors = Thread.ofVirtual().start(() -> {
            try (var reader = process.errorReader(StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    JsonObject event = new JsonObject(); event.addProperty("type", "event"); event.addProperty("event", "log.appended");
                    JsonObject data = new JsonObject(); data.addProperty("text", "[诊断] " + line + "\n"); event.add("data", data);
                    events.accept(event);
                }
            } catch (IOException ignored) { /* Closing a cancelled worker closes its pipes. */ }
        });
        JsonObject response = null;
        try {
            try (var input = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
                input.write(JSON.toJson(request)); input.write('\n'); input.flush();
            }
            try (var output = process.inputReader(StandardCharsets.UTF_8)) {
                String line;
                while ((line = output.readLine()) != null) {
                    if (line.length() > 16 * 1024 * 1024) throw new IOException("后端输出超过协议大小限制");
                    JsonObject item;
                    try { item = JsonParser.parseString(line).getAsJsonObject(); }
                    catch (RuntimeException e) { throw new IOException("后端输出不是合法 JSONL：" + line.substring(0, Math.min(180, line.length())), e); }
                    if (!item.has("protocolVersion") || item.get("protocolVersion").getAsInt() != 1) throw new IOException("后端协议版本不匹配");
                    if ("response".equals(string(item, "type"))) {
                        if (!string(item, "requestId").equals(string(request, "requestId"))) throw new IOException("后端响应不属于当前请求");
                        response = item;
                    } else events.accept(item);
                }
            }
            int exit = process.waitFor();
            errors.join(2000);
            if (cancelled.get()) throw new CancellationException("操作已取消");
            if (response == null) throw new IOException("后端进程结束，未返回结果（exit " + exit + "）");
            if (!response.get("ok").getAsBoolean()) {
                JsonObject error = response.getAsJsonObject("error");
                throw new IOException(string(error, "code") + "：" + string(error, "message"));
            }
            if (exit != 0) throw new IOException("后端异常退出：" + exit);
            return response.getAsJsonObject("result");
        } catch (Exception error) {
            if (cancelled.get()) throw new CancellationException("操作已取消");
            throw error;
        } finally {
            if (process.isAlive()) terminate(process);
            active = null;
        }
    }

    public void cancel() {
        cancelled.set(true);
        Process process = active;
        if (process != null) Thread.ofVirtual().start(() -> terminate(process));
    }

    public void beginOperation() { cancelled.set(false); }

    private static void terminate(Process process) {
        if (!process.isAlive()) return;
        try {
            if (System.getProperty("os.name").startsWith("Windows")) {
                Process killer = new ProcessBuilder("taskkill", "/PID", Long.toString(process.pid()), "/T", "/F")
                        .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();
                killer.waitFor();
            } else process.descendants().forEach(ProcessHandle::destroyForcibly);
        } catch (Exception ignored) { /* Direct kill below also handles an already stopped process. */ }
        process.destroyForcibly();
    }

    private static Path extractAdapter() throws Exception {
        byte[] bytes;
        try (InputStream stream = PythonBridgeClient.class.getResourceAsStream("/bridge/ide_bridge.py")) {
            if (stream == null) throw new IOException("插件缺少 Python 适配器资源");
            bytes = stream.readAllBytes();
        }
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        Path directory = Path.of(PathManager.getSystemPath(), "arkts-refactor", "bridge", digest.substring(0, 16));
        Files.createDirectories(directory);
        Path script = directory.resolve("ide_bridge.py");
        if (!Files.exists(script) || !MessageDigest.isEqual(bytes, Files.readAllBytes(script))) {
            Path temporary = Files.createTempFile(directory, "adapter-", ".tmp");
            try {
                Files.write(temporary, bytes);
                try { Files.move(temporary, script, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
                catch (AtomicMoveNotSupportedException e) { Files.move(temporary, script, StandardCopyOption.REPLACE_EXISTING); }
            } finally { Files.deleteIfExists(temporary); }
        }
        return script;
    }

    public static String string(JsonObject value, String key) {
        return value != null && value.has(key) && !value.get(key).isJsonNull() ? value.get(key).getAsString() : "";
    }
}
