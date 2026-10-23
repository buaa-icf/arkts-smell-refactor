# DevEco Code TUI 插件文档

本目录统一保存 `opencode-plugin/` 的设计、协议、开发和验收文档。

1. [技术设计](technical-design.md)：宿主扩展调查、架构、交互、数据流和实现边界。
2. [使用与验证](usage-and-validation.md)：安装、配置、快捷键、测试和已知限制（随实现补充）。
3. [SearchPage.ets 回滚调查](rollback-investigation-20261021.md)：实际运行证据、诊断边界和修复说明。
4. [TypeScript 后端集成](typescript-backend-integration.md)：main 合并、Node 连接适配、范围修复移植和验证。
5. [PR 文案](pr-description.md)：面向 main 的功能说明、集成范围和验证结果。

开发顺序：2026-10-18 先编写技术设计，再实现 TypeScript 插件，最后记录实际验证结果。
