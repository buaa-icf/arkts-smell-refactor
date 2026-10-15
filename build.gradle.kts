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

tasks.test {
    useJUnitPlatform()
}
