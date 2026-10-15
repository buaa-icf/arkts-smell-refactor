plugins {
    id("java")
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "org.buaa"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        local(providers.gradleProperty("devecoStudioPath").orElse("D:/tool/DevEco/DevEco Studio").get())
    }
    testImplementation(platform("org.junit:junit-bom:6.0.0"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
}

sourceSets.main { java.exclude("org/buaa/Main.java") }

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
}

intellijPlatform {
    instrumentCode.set(false)
    buildSearchableOptions.set(false)
    pluginConfiguration {
        ideaVersion {
            sinceBuild.set("243")
            untilBuild.set("243.*")
        }
    }
}

// Huawei's SDK omits the Core plugin descriptor required by the platform test launcher.
// Run filesystem transaction tests in an ordinary Java project; production compiles against DS.
val verifyTransactions = tasks.register<Exec>("verifyTransactions") {
    group = "verification"
    description = "Runs byte-preserving apply/undo tests without bootstrapping the IDE."
    val windows = System.getProperty("os.name").startsWith("Windows")
    val executable = File(gradle.gradleHomeDir, "bin/" + if (windows) "gradle.bat" else "gradle")
    val arguments = mutableListOf("--no-daemon", "--gradle-user-home", gradle.gradleUserHomeDir.absolutePath,
        "-p", layout.projectDirectory.dir("verification").asFile.absolutePath, "test")
    if (gradle.startParameter.isOffline) arguments.add("--offline")
    commandLine(if (windows) listOf("cmd", "/d", "/c", executable.absolutePath) + arguments else listOf(executable.absolutePath) + arguments)
    environment("JAVA_HOME", System.getProperty("java.home"))
}

tasks.test {
    setDependsOn(listOf(verifyTransactions))
    classpath = files()
    testClassesDirs = files()
}
