package org.buaa.arktsrefactor.persistence;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.components.PersistentStateComponent;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.components.State;
import com.intellij.openapi.components.Storage;
import com.intellij.util.messages.Topic;
import org.jetbrains.annotations.NotNull;

import java.nio.file.Files;
import java.nio.file.Path;

@Service(Service.Level.APP)
@State(name = "ArktsRefactorSettings", storages = @Storage("arkts-refactor.xml"))
public final class PluginSettings implements PersistentStateComponent<PluginSettings.Config> {
    public static final Topic<Runnable> SETTINGS_CHANGED = Topic.create("ArkTS Refactor settings changed", Runnable.class);
    public static final class Config {
        public String backend = Path.of(System.getProperty("user.home"), "Desktop", "group_project", "arkts-smell-refactor").toString();
        public String homecheck = ""; // Legacy setting; backend uses its bundled npm scanner.
        public String studio = defaultPath("D:/tool/DevEco/DevEco Studio", "");
        public String node = defaultPath("D:/tool/NodeJs/node.exe", "node");
        public String deveco = "";
        public String hvigor = "";
        public String ohpm = "";
        public String linter = "";
        public String runs = Path.of(PathManager.getSystemPath(), "arkts-refactor", "runs").toString();
        public String linterMode = "required";

        private static String defaultPath(String preferred, String fallback) {
            return Files.exists(Path.of(preferred)) ? preferred : fallback;
        }

        public Config copy() {
            Config c = new Config();
            c.backend = backend; c.homecheck = homecheck; c.studio = studio;
            c.node = node; c.deveco = deveco; c.hvigor = hvigor; c.ohpm = ohpm;
            c.linter = linter; c.runs = runs; c.linterMode = linterMode;
            return c;
        }
    }

    private Config config = new Config();

    public static PluginSettings getInstance() {
        return ApplicationManager.getApplication().getService(PluginSettings.class);
    }

    @Override public @NotNull Config getState() { return config; }
    @Override public void loadState(@NotNull Config state) {
        config = state;
        ApplicationManager.getApplication().getMessageBus().syncPublisher(SETTINGS_CHANGED).run();
    }
}
