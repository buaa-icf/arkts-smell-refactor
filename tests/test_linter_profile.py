import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from arkts_smell_refactor.automatic import _auto_config
from arkts_smell_refactor.linter_profile import find_linter_config, project_linter_guidance
from arkts_smell_refactor.models import RefactorTask, Target
from arkts_smell_refactor.prompts import build_refactor_prompt, build_repair_prompt


class LinterProfileTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        self.repository = self.workspace / "demo"
        self.app = self.repository / "BusinessTemplate" / "OfficeAttendance"
        self.target = self.app / "entry" / "src" / "main" / "ets" / "Page.ets"
        self.target.parent.mkdir(parents=True)
        self.target.write_text("struct Page {}", encoding="utf-8")
        (self.app / "hvigor").mkdir()
        (self.app / "hvigor" / "hvigor-config.json5").write_text("{}", encoding="utf-8")
        (self.app / "build-profile.json5").write_text("{}", encoding="utf-8")
        self.config = self.app / "code-linter.json5"
        self.task = RefactorTask(
            schema_version="1.0", task_id="T", source_project="demo", commit_hash="",
            workspace_root=str(self.workspace), project_root=str(self.repository),
            smell_type="long-method", rule="test-rule", severity="WARNING", message="smell",
            target=Target(self.target.relative_to(self.workspace).as_posix(), "build"), raw={},
        )

    def guidance(self):
        return project_linter_guidance(self.target, self.repository, "required")

    def test_json5_excerpt_preserves_nested_options_and_ignores_comments(self):
        self.config.write_text('''{
          files: ['**/*.ets'],
          ruleSet: ['plugin:@hw-stylistic/recommended'],
          rules: {
            // Fake example: '@typescript-eslint/semi': 'off'
            '@typescript-eslint/semi': 'error',
            '@typescript-eslint/comma-dangle': ['error', 'always-multiline',],
            '@typescript-eslint/explicit-member-accessibility': ['error', {
              accessibility: 'explicit', overrides: {properties: 'off'},
            }],
            '@typescript-eslint/naming-convention': ['error', {
              selector: 'memberLike', modifiers: ['private'], leadingUnderscore: 'require',
              filter: {regex: "https://example.test/[*]", match: false},
            }],
            /* '@typescript-eslint/quotes': ['error', 'double'] */
            '@typescript-eslint/quotes': ['warn', 'single'],
            '@security/no-commented-code': 'warn',
          },
        }''', encoding="utf-8-sig")
        prompt = self.guidance()
        for expected in (
            "BusinessTemplate/OfficeAttendance/code-linter.json5", "always-multiline",
            "properties : 'off'", "leadingUnderscore : 'require'",
            '"https://example.test/[*]"',
        ):
            self.assertIn(expected, prompt)
        self.assertIn("@typescript-eslint/quotes: [ 'warn' , 'single' ]", prompt)
        self.assertNotIn("Fake example", prompt)
        self.assertNotIn("'double'", prompt)
        self.assertNotIn("@security/no-commented-code", prompt)
        self.assertIn("ruleSet 继承规则及未写出的默认选项未展开", prompt)

    def test_disabled_rules_and_conditional_overrides_are_not_lost(self):
        self.config.write_text('''{
          files: ['**/*.ets'], ignore: ['**/Generated.ets'],
          rules: {"@typescript-eslint/semi": 0, quotes: 'off'},
          overrides: [{files: ['**/Helper.ets'], rules: {quotes: ['error', 'double']}}],
        }''', encoding="utf-8")
        prompt = self.guidance()
        self.assertIn("@typescript-eslint/semi: 0", prompt)
        self.assertIn("quotes: 'off'", prompt)
        self.assertIn("**/Generated.ets", prompt)
        self.assertIn("**/Helper.ets", prompt)
        self.assertIn("'double'", prompt)

    def test_nested_app_config_is_shared_by_both_prompts_and_gate(self):
        (self.repository / "code-linter.json5").write_text(
            '{rules: {quotes: ["error", "double"]}}', encoding="utf-8"
        )
        self.config.write_text('{rules: {quotes: ["error", "single"]}}', encoding="utf-8")
        for prompt in (
            build_refactor_prompt(self.task, {}),
            build_repair_prompt(self.task, {}, {"stage": "linter"}, 1),
        ):
            self.assertIn('quotes: [ "error" , "single" ]', prompt)
            self.assertNotIn('"double"', prompt)
        config = _auto_config(self.task, self.workspace / "task", {}, {
            "deveco": "deveco", "hvigorw": "hvigorw", "ohpm": None,
            "homecheck": None, "codelinter": "codelinter",
        })
        command = config["gates"]["linter"]["command"]
        self.assertEqual(self.config.resolve(), Path(command[command.index("--config") + 1]))

    def test_skip_does_not_discover_or_read_configuration(self):
        with patch("arkts_smell_refactor.linter_profile.find_linter_config") as discover:
            initial = build_refactor_prompt(self.task, {}, linter_mode="skip")
            repair = build_repair_prompt(self.task, {}, {}, 1, linter_mode="skip")
        discover.assert_not_called()
        for prompt in (initial, repair):
            self.assertNotIn("项目 Linter 风格摘要", prompt)
            self.assertIn("本轮 Linter 已明确跳过", prompt)

    def test_unreadable_or_unsupported_config_does_not_disable_linter(self):
        for content in ("{rules: {semi: ['error'}", "{ /* unfinished"):
            with self.subTest(content=content):
                self.config.write_text(content, encoding="utf-8")
                self.assertIn("平台未能提取风格摘要", self.guidance())
        self.config.write_text("{}", encoding="utf-8")
        with patch.object(Path, "read_text", side_effect=PermissionError):
            self.assertIn("不据此推断任何规则已关闭", self.guidance())

    def test_discovery_does_not_use_parent_or_sibling_project_config(self):
        (self.workspace / "code-linter.json5").write_text("{}", encoding="utf-8")
        sibling = self.repository / "OtherApp"
        sibling.mkdir()
        (sibling / "code-linter.json5").write_text("{}", encoding="utf-8")
        self.assertIsNone(find_linter_config(self.target, self.repository))
        self.assertEqual("", self.guidance())


if __name__ == "__main__":
    unittest.main()
