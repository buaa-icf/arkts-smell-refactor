# 内置 HomeCheck npm 包维护

普通用户只需要在 refactor 根目录执行 `npm ci`、`npm run build`。本目录不是另一套需要用户配置的 HomeCheck 仓库；发布制品为 `vendor/arkts-refactor-homecheck-runtime-1.0.0.tgz`，需要随 Git 提交，不能只提交 `node_modules`。

本包固定 HomeCheck 0.9.9-rc.26、ArkAnalyzer 1.0.92、ohos-typescript 4.9.5-r4、graceful-fs 4.2.11，并以 npm bundledDependencies 带入完整运行依赖。既有 HomeCheck/ArkAnalyzer 补丁以已应用的 JS 和补丁文件一起保存；自定义规则从 `lib/` 构建结果冻结。包不包含 CLOC、测试数据集、SDK、本机项目配置、签名或账号资料，不启用 C++ 原生分析器。

## 维护者更新制品

1. 在可信的 HomeCheck 扩展规则仓库安装依赖、应用补丁并执行 `npm run build`，确认工作区版本是准备发布的版本。
2. 修改本目录 package.json 的发布版本；如升级扫描依赖，也显式修改固定依赖版本。正式发布后不要在相同版本下替换制品。
3. 在 refactor 根目录执行：

```sh
npm run package:homecheck -- --source /path/to/homecheck-extrule
```

该命令仅供维护者，普通运行不需要这个源仓库。它复制已构建的规则和已应用补丁的运行依赖，校验关键补丁存在，解析依赖闭包并执行离线 npm pack，不修改来源仓库。它会保留一个被 Git 忽略的唯一暂存目录以便审计，不自动删除来源或用户目录。

4. 更新 refactor package.json 中的本地制品依赖，再执行 `npm install` 更新锁文件；离线更新已在本机安装过的其他依赖时可用 `--offline`。制品版本、package.json 和 package-lock.json 必须一起提交。
5. 执行 `npm test`。需要验证无工作区 HomeCheck、无 npm/CLOC 的实际扫描，以及从单个 tgz 新安装依赖后的扫描。macOS/Linux 的实际运行仍需在相应环境验证，不把 Windows 测试当跨平台实测。

`runtime-manifest.json` 保存规则、适配器、依赖内容指纹及版本；源码版权头、第三方许可证和补丁保留在制品中。扫描期间固定加载包内规则，不执行 npm install，也不接受外部 ruleSet 包路径。

底层维护接口（正常 refactor 会自动生成参数）：

```sh
node node_modules/@arkts-refactor/homecheck-runtime/scan.cjs --project-config project.json --rule-config rules.json --summary output/summary.json
```

project.json 中的 `projectPath` 为工程根目录，`checkFiles` 为明确的 `.ets/.ts` 文件列表。扫描不修改源文件；摘要的 success 只表示检测成功，不表示没有异味。复检是否通过仍由 refactor 根据目标符号和本任务变更范围判断。
