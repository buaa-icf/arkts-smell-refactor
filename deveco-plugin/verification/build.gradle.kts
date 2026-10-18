plugins { java }
repositories { mavenCentral() }
dependencies {
    testImplementation(platform("org.junit:junit-bom:6.0.0"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }
tasks.withType<JavaCompile>().configureEach { options.encoding = "UTF-8"; options.release.set(21) }
sourceSets {
    main {
        java.setSrcDirs(listOf("../src/main/java/org/buaa/arktsrefactor/service"))
        java.include("FileTransaction.java")
    }
    test { java.setSrcDirs(listOf("../src/test/java")) }
}
tasks.test { useJUnitPlatform() }
