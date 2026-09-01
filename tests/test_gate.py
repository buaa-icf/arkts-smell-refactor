import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.gate import (
    _changed_current_lines,
    _fresh_copy,
    _owner_at_line,
    _parse_linter_issues,
    _reported_symbol,
    _issue_touches_changed_symbol,
    _smell_changed_lines,
    _smell_scan_files,
    _symbol_matches,
    _sync_production_changes,
)


class GateTests(unittest.TestCase):
    def test_arkanalyzer_anonymous_method_belongs_to_outer_method(self):
        message = "Method '%AM2$initialiseUserInfoTextField' is feature-envious toward 'UserInfo'"
        reported = _reported_symbol(message)
        self.assertEqual("%AM2$initialiseUserInfoTextField", reported)
        self.assertTrue(_symbol_matches(reported, "initialiseUserInfoTextField"))
        self.assertFalse(_symbol_matches(reported, "initialiseEnumField"))

    def test_smell_scan_is_limited_to_target_and_changed_production_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            task_dir = root / "task"
            target = source / "pages/Page.ets"
            changed = source / "models/PageMapper.ets"
            unrelated = source / "pages/Other.ets"
            for path in (target, changed, unrelated):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("line\n", encoding="utf-8")
            task_dir.mkdir()
            (task_dir / "refactor-changes.json").write_text(
                '{"changedProductionFiles":["models/PageMapper.ets"]}', encoding="utf-8"
            )
            selected = _smell_scan_files(task_dir, source, target)
            self.assertEqual([target.resolve(), changed.resolve()], selected)

    def test_new_smell_file_treats_all_lines_as_changed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            task_dir = root / "task"
            added = source / "models/NewMapper.ets"
            added.parent.mkdir(parents=True)
            added.write_text("one\ntwo\n", encoding="utf-8")
            task_dir.mkdir()
            changed = _smell_changed_lines(task_dir, source, [added])
            self.assertEqual({1, 2}, changed["models/NewMapper.ets"])

    def test_stale_dataset_lines_do_not_match_an_unrelated_method(self):
        source = """class Page {
  build() {
    this.oldLongMethodBody()
  }

  refactoredTarget() {
    return Mapper.map(this.value)
  }
}
"""
        # HomeCheck reports build at its declaration, while only refactoredTarget changed.
        self.assertFalse(_issue_touches_changed_symbol(source, "build", 2, {6}))
        self.assertTrue(_issue_touches_changed_symbol(source, "refactoredTarget", 5, {6}))

    def test_smell_identity_distinguishes_same_method_name_by_owner(self):
        source = """class TotalCashMapper {
  static getTotalCash() {}
}
class OrderVM {
  getTotalCash() {}
}
"""
        self.assertEqual("TotalCashMapper", _owner_at_line(source, 2, "File"))
        self.assertEqual("OrderVM", _owner_at_line(source, 5, "File"))

    def test_refactor_workspace_physically_excludes_tests(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "mirror"
            main = source / "feature/src/main/ets/Foo.ets"
            local_test = source / "feature/src/test/Foo.test.ets"
            device_test = source / "feature/src/ohosTest/ets/Foo.test.ets"
            for path in (main, local_test, device_test):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("code", encoding="utf-8")
            _fresh_copy(source, mirror, exclude_tests=True)
            self.assertTrue((mirror / "feature/src/main/ets/Foo.ets").exists())
            self.assertFalse((mirror / "feature/src/test").exists())
            self.assertFalse((mirror / "feature/src/ohosTest").exists())

    def test_only_production_code_is_synchronized(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_file = source / "feature/src/main/ets/Foo.ets"
            mirror_file = mirror / "feature/src/main/ets/Foo.ets"
            source_file.parent.mkdir(parents=True)
            mirror_file.parent.mkdir(parents=True)
            source_file.write_text("before", encoding="utf-8")
            mirror_file.write_text("after", encoding="utf-8")
            self.assertEqual(0, _sync_production_changes(mirror, source))
            self.assertEqual("after", source_file.read_text(encoding="utf-8"))
            baseline = mirror.parent / "baseline-production/feature/src/main/ets/Foo.ets"
            self.assertEqual("before", baseline.read_text(encoding="utf-8"))

    def test_hvigor_generated_build_profile_does_not_reject_source_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_file = source / "feature/src/main/ets/Foo.ets"
            mirror_file = mirror / "feature/src/main/ets/Foo.ets"
            generated = mirror / "feature/BuildProfile.ets"
            source_file.parent.mkdir(parents=True)
            mirror_file.parent.mkdir(parents=True)
            generated.parent.mkdir(parents=True, exist_ok=True)
            source_file.write_text("before", encoding="utf-8")
            mirror_file.write_text("after", encoding="utf-8")
            generated.write_text("generated by hvigor", encoding="utf-8")

            self.assertEqual(0, _sync_production_changes(mirror, source))
            self.assertEqual("after", source_file.read_text(encoding="utf-8"))
            self.assertFalse((source / "feature/BuildProfile.ets").exists())

    def test_hvigor_generated_lock_file_does_not_reject_source_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_file = source / "feature/src/main/ets/Foo.ets"
            mirror_file = mirror / "feature/src/main/ets/Foo.ets"
            generated = mirror / "feature/oh-package-lock.json5"
            source_file.parent.mkdir(parents=True)
            mirror_file.parent.mkdir(parents=True)
            generated.parent.mkdir(parents=True, exist_ok=True)
            source_file.write_text("before", encoding="utf-8")
            mirror_file.write_text("after", encoding="utf-8")
            generated.write_text("generated by ohpm", encoding="utf-8")

            self.assertEqual(0, _sync_production_changes(mirror, source))
            self.assertEqual("after", source_file.read_text(encoding="utf-8"))
            self.assertFalse((source / "feature/oh-package-lock.json5").exists())

    def test_validation_files_are_discarded_without_losing_source_change(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_file = source / "feature/src/main/ets/Foo.ets"
            mirror_file = mirror / "feature/src/main/ets/Foo.ets"
            source_file.parent.mkdir(parents=True)
            mirror_file.parent.mkdir(parents=True)
            source_file.write_text("before", encoding="utf-8")
            mirror_file.write_text("after", encoding="utf-8")
            for name in ("local.properties", "hvigorw.bat", "package-lock.json", "pnpm-lock.yaml"):
                (mirror / name).write_text("temporary", encoding="utf-8")

            self.assertEqual(0, _sync_production_changes(mirror, source))
            self.assertEqual("after", source_file.read_text(encoding="utf-8"))
            changes = __import__("json").loads((mirror.parent / "refactor-changes.json").read_text(encoding="utf-8"))
            self.assertEqual(4, len(changes["discardedValidationFiles"]))
            self.assertEqual([], changes["rejectedFiles"])

    def test_real_configuration_change_rejects_all_source_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_file = source / "feature/src/main/ets/Foo.ets"
            mirror_file = mirror / "feature/src/main/ets/Foo.ets"
            config = mirror / "feature/build-profile.json5"
            source_file.parent.mkdir(parents=True)
            mirror_file.parent.mkdir(parents=True)
            config.parent.mkdir(parents=True, exist_ok=True)
            source_file.write_text("before", encoding="utf-8")
            mirror_file.write_text("after", encoding="utf-8")
            config.write_text("changed", encoding="utf-8")

            self.assertEqual(4, _sync_production_changes(mirror, source))
            self.assertEqual("before", source_file.read_text(encoding="utf-8"))

    def test_linter_output_is_structured(self):
        issues = _parse_linter_issues("12:3 error unexpected any @rule/no-any", "feature/Foo.ets")
        self.assertEqual(1, len(issues))
        self.assertEqual("feature/Foo.ets", issues[0]["filePath"])
        self.assertEqual(12, issues[0]["line"])
        self.assertEqual("@rule/no-any", issues[0]["rule"])

    def test_module_index_is_synchronized_as_production_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_file = source / "feature/Index.ets"
            mirror_file = mirror / "feature/Index.ets"
            source_file.parent.mkdir(parents=True)
            mirror_file.parent.mkdir(parents=True)
            source_file.write_text("export before", encoding="utf-8")
            mirror_file.write_text("export after", encoding="utf-8")

            self.assertEqual(0, _sync_production_changes(mirror, source))
            self.assertEqual("export after", source_file.read_text(encoding="utf-8"))

    def test_review_pack_includes_direct_relative_production_dependency(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_page = source / "feature/src/main/ets/pages/Page.ets"
            mirror_page = mirror / "feature/src/main/ets/pages/Page.ets"
            dependency = source / "feature/src/main/ets/viewModels/PageVM.ets"
            source_page.parent.mkdir(parents=True)
            mirror_page.parent.mkdir(parents=True)
            dependency.parent.mkdir(parents=True)
            source_page.write_text("export class Page {}", encoding="utf-8")
            mirror_page.write_text(
                "import { PageVM } from '../viewModels/PageVM'\nexport class Page { vm: PageVM }",
                encoding="utf-8",
            )
            dependency.write_text("export class PageVM { copy(): void {} }", encoding="utf-8")

            self.assertEqual(0, _sync_production_changes(mirror, source))
            packed = mirror.parent / "review-context-production/feature/src/main/ets/viewModels/PageVM.ets"
            self.assertTrue(packed.exists())
            self.assertIn("copy", packed.read_text(encoding="utf-8"))

    def test_test_build_cache_is_excluded_from_refactor_workspace(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "mirror"
            main = source / "module/src/main/ets/Foo.ets"
            cache = source / "module/.test/default/cache/compiler.msgpack"
            for path in (main, cache):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("data", encoding="utf-8")
            _fresh_copy(source, mirror, exclude_tests=True)
            self.assertTrue((mirror / "module/src/main/ets/Foo.ets").exists())
            self.assertFalse((mirror / "module/.test").exists())

    def test_changed_line_detection_ignores_preexisting_linter_lines(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            before = root / "before.ets"
            after = root / "after.ets"
            before.write_text("old warning\nkeep\nbefore\n", encoding="utf-8")
            after.write_text("old warning\nkeep\nafter\n", encoding="utf-8")
            self.assertNotIn(1, _changed_current_lines(before, after))
            self.assertIn(3, _changed_current_lines(before, after))


if __name__ == "__main__":
    unittest.main()
