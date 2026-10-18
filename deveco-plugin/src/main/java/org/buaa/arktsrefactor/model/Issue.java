package org.buaa.arktsrefactor.model;

import com.google.gson.JsonObject;
import org.buaa.arktsrefactor.bridge.PythonBridgeClient;

public record Issue(JsonObject data) {
    public String id() { return text("issueId"); }
    public String path() { return text("filePath"); }
    public String absolutePath() { return text("absolutePath"); }
    public String rule() { return text("rule"); }
    public String symbol() { return text("symbol"); }
    public String message() { return text("message"); }
    public int line() { return data.get("startLine").getAsInt(); }
    public boolean supported() { return data.has("supported") && data.get("supported").getAsBoolean(); }
    public String text(String key) { return PythonBridgeClient.string(data, key); }
    public String label() {
        return switch (text("smellType")) {
            case "feature-envy" -> "特性依恋";
            case "long-method" -> "过长方法";
            case "switch-statement" -> "复杂分支";
            case "code-clone" -> "重复片段";
            default -> rule();
        };
    }
}
