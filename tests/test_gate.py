import tempfile
import unittest
from pathlib import Path

import json
from types import SimpleNamespace
from unittest.mock import patch

from arkts_smell_refactor.gate import (
    _changed_current_lines,
    _fresh_copy,
    _hvigor_test_results,
    _issue_touches_changed_symbol,
    _owner_at_line,
    _parse_linter_issues,
    _reported_symbol,
    _smell_changed_lines,
    _smell_scan_files,
    _symbol_matches,
    _sync_production_changes,
    hvigor_gate,
    refactor_gate,
)


class GateTests(unittest.TestCase):
    def test_hvigor_test_requires_nonzero_result_and_uses_device_module(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            (source / "entry/src/main").mkdir(parents=True)
            task_dir = root / "runs/session/task"
            task_dir.mkdir(parents=True)

            def run_with_result(command, cwd, env):
                kind = "ohosTest" if "onDeviceTest" in command else "test"
                result = Path(cwd) / "entry/.test/default/intermediates" / kind / "coverage_data/test_result.txt"
                result.parent.mkdir(parents=True, exist_ok=True)
                result.write_text("result=Success\nTests run: 2, Failure: 0, Error: 0, Pass: 2\n", encoding="utf-8")
                if kind == "ohosTest":
                    result.with_name("coverage.log").write_text(
                        "OHOS_REPORT_RESULT: stream=Tests run: 2, Failure: 0, Error: 0, Pass: 2\n"
                        "TestFinished-ResultCode: 0\n", encoding="utf-8")
                return SimpleNamespace(returncode=0)

            with patch("arkts_smell_refactor.gate.subprocess.run", side_effect=run_with_result) as run:
                self.assertEqual(0, hvigor_gate(task_dir, source, Path("hvigorw"), None, "onDeviceTest", "entry"))
                self.assertIn("module=entry@ohosTest", run.call_args.args[0])
                validation = root / "v"
                copy = next(validation.iterdir())
                dependency = copy / "oh_modules/entry/.test/default/intermediates/ohosTest/coverage_data/test_result.txt"
                dependency.parent.mkdir(parents=True)
                dependency.write_text("Tests run: 2, Failure: 0, Error: 0, Pass: 2", encoding="utf-8")
                self.assertEqual(1, len(_hvigor_test_results(copy, "ohosTest", "entry")))
                self.assertEqual(0, hvigor_gate(task_dir, source, Path("hvigorw"), None, "test", "entry"))
                self.assertIn("module=entry", run.call_args.args[0])

            def no_result(command, cwd, env):
                return SimpleNamespace(returncode=0)

            with patch("arkts_smell_refactor.gate.subprocess.run", side_effect=no_result):
                self.assertEqual(3, hvigor_gate(task_dir, source, Path("hvigorw"), None, "test", "entry"))

            def zero_result(command, cwd, env):
                result = Path(cwd) / "entry/.test/default/intermediates/test/coverage_data/test_result.txt"
                result.parent.mkdir(parents=True, exist_ok=True)
                result.write_text("Tests run: 0, Failure: 0, Error: 0, Pass: 0\n", encoding="utf-8")
                return SimpleNamespace(returncode=0)

            with patch("arkts_smell_refactor.gate.subprocess.run", side_effect=zero_result):
                self.assertEqual(3, hvigor_gate(task_dir, source, Path("hvigorw"), None, "test", "entry"))

            def failed_device_result(command, cwd, env):
                result = Path(cwd) / "entry/.test/default/intermediates/ohosTest/coverage_data/test_result.txt"
                result.parent.mkdir(parents=True, exist_ok=True)
                result.write_text("result=Error\nTests run: 2, Failure: 0, Error: 1, Pass: 1\n", encoding="utf-8")
                return SimpleNamespace(returncode=0)

            with patch("arkts_smell_refactor.gate.subprocess.run", side_effect=failed_device_result):
                self.assertEqual(1, hvigor_gate(task_dir, source, Path("hvigorw"), None, "onDeviceTest", "entry"))

    def test_hvigor_attributes_device_cases_to_target_instead_of_whole_module(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            tests = source / "scenes/entry/src/ohosTest/ets/test"
            tests.mkdir(parents=True)
            (tests / "CarouseCutToolBar.test.ets").write_text(
                "describe('CarouseCutToolBarTest', () => {"
                "it('get_crop_ratio_free_returns_0', 0, () => {});"
                "it('get_crop_ratio_fixed_returns_1', 0, () => {}); });",
                encoding="utf-8",
            )
            (tests / "StickerToolBar.test.ets").write_text(
                "describe('StickerToolBarInstrumentTest', () => {"
                "it('sticker_host', 0, () => {}); });", encoding="utf-8",
            )
            task_dir = root / "runs/session/task"
            task_dir.mkdir(parents=True)
            (task_dir / "task.json").write_text(json.dumps({
                "target": {"file_path": "scenes/entry/src/main/ets/components/CarouseCutToolBar.ets",
                           "symbol": "getCropRatio"},
            }), encoding="utf-8")

            def run_with_unrelated_failure(command, cwd, env):
                coverage = Path(cwd) / "scenes/entry/.test/default/intermediates/ohosTest/coverage_data"
                coverage.mkdir(parents=True, exist_ok=True)
                (coverage / "test_result.txt").write_text(
                    "class=CarouseCutToolBarTest\n"
                    "test=get_crop_ratio_free_returns_0\nresult=Success\n"
                    "test=get_crop_ratio_fixed_returns_1\nresult=Success\n"
                    "class=StickerToolBarInstrumentTest\n"
                    "test=sticker_host\nresult=Error\n"
                    "Tests run: 3, Failure: 0, Error: 1, Pass: 2\n", encoding="utf-8",
                )
                (coverage / "coverage.log").write_text(
                    "OHOS_REPORT_RESULT: stream=Tests run: 3, Failure: 0, Error: 1, Pass: 2\n"
                    "TestFinished-ResultCode: 0\n", encoding="utf-8",
                )
                return SimpleNamespace(returncode=1)

            with patch("arkts_smell_refactor.gate.subprocess.run", side_effect=run_with_unrelated_failure):
                self.assertEqual(0, hvigor_gate(task_dir, source, Path("hvigorw"), None, "onDeviceTest", "entry"))
            attribution = json.loads((task_dir / "test-attribution.json").read_text(encoding="utf-8"))
            self.assertEqual(2, len(attribution["targetCases"]))
            self.assertEqual(1, len(attribution["unrelatedFailures"]))

    def test_target_device_cases_missing_test_host_are_blocked(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            tests = source / "entry/src/ohosTest/ets/test"
            tests.mkdir(parents=True)
            (tests / "AvatarUpload.test.ets").write_text(
                "describe('CropCheckImageAdaptTest', () => {"
                "it('check_image_adapt_s1', 0, () => {}); });", encoding="utf-8",
            )
            task_dir = root / "runs/session/task"
            task_dir.mkdir(parents=True)
            (task_dir / "task.json").write_text(json.dumps({
                "target": {"file_path": "entry/src/main/ets/AvatarUpload.ets",
                           "symbol": "checkImageAdapt"},
            }), encoding="utf-8")

            def run_with_missing_host(command, cwd, env):
                result = Path(cwd) / "entry/.test/default/intermediates/ohosTest/coverage_data/test_result.txt"
                result.parent.mkdir(parents=True, exist_ok=True)
                result.write_text(
                    "class=CropCheckImageAdaptTest\n"
                    "test=check_image_adapt_s1\n"
                    "Component not found: crop_test_host_anchor, error in beforeAll function\n"
                    "result=Error\n"
                    "Tests run: 1, Failure: 0, Error: 1, Pass: 0\n", encoding="utf-8",
                )
                return SimpleNamespace(returncode=1)

            with patch("arkts_smell_refactor.gate.subprocess.run", side_effect=run_with_missing_host):
                self.assertEqual(3, hvigor_gate(task_dir, source, Path("hvigorw"), None, "onDeviceTest", "entry"))
            attribution = json.loads((task_dir / "test-attribution.json").read_text(encoding="utf-8"))
            self.assertEqual("Error", attribution["targetCases"][0]["result"])

    def test_hvigor_requires_target_case_evidence_when_task_is_known(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            (source / "entry/src/main").mkdir(parents=True)
            task_dir = root / "runs/session/task"
            task_dir.mkdir(parents=True)
            (task_dir / "task.json").write_text(json.dumps({
                "target": {"file_path": "entry/src/main/ets/Foo.ets", "symbol": "work"},
            }), encoding="utf-8")

            def run_without_target(command, cwd, env):
                result = Path(cwd) / "entry/.test/default/intermediates/test/coverage_data/test_result.txt"
                result.parent.mkdir(parents=True)
                result.write_text(
                    "class=OtherTest\ntest=other_case\nresult=Success\n"
                    "Tests run: 1, Failure: 0, Error: 0, Pass: 1\n", encoding="utf-8",
                )
                return SimpleNamespace(returncode=0)

            with patch("arkts_smell_refactor.gate.subprocess.run", side_effect=run_without_target):
                self.assertEqual(3, hvigor_gate(task_dir, source, Path("hvigorw"), None, "test", "entry"))

    def test_other_suite_failure_referencing_target_source_is_not_ignored(self):
        from arkts_smell_refactor.gate import _parse_hypium_cases, _target_test_cases
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            module_root = root / "scenes/entry"
            tests = module_root / "src/ohosTest/ets/test"
            tests.mkdir(parents=True)
            (tests / "CarouseCutToolBar.test.ets").write_text(
                "describe('CarouseCutToolBarTest', () => {"
                "it('get_crop_ratio_ok', 0, () => {}); });", encoding="utf-8",
            )
            (tests / "Other.test.ets").write_text(
                "describe('OtherTest', () => {it('indirect', 0, () => {}); });", encoding="utf-8",
            )
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "task.json").write_text(json.dumps({
                "target": {"file_path": "scenes/entry/src/main/ets/CarouseCutToolBar.ets",
                           "symbol": "getCropRatio"},
            }), encoding="utf-8")
            result = root / "test_result.txt"
            result.write_text(
                "class=CarouseCutToolBarTest\ntest=get_crop_ratio_ok\nresult=Success\n"
                "class=OtherTest\ntest=indirect\n"
                "at CarouseCutToolBar.ets:165\nresult=Error\n", encoding="utf-8",
            )
            cases = _parse_hypium_cases(result)
            self.assertEqual({0, 1}, _target_test_cases(task_dir, module_root, "ohosTest", cases))

    def test_refactor_prompt_is_attached_and_model_is_configurable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            task_dir = root / "task"
            target = source / "feature/src/main/ets/Foo.ets"

            target.parent.mkdir(parents=True)
            target.write_text("export class Foo {}", encoding="utf-8")
            task_dir.mkdir()

            (task_dir / "task.json").write_text(
                json.dumps({
                    "task_id": "T",
                    "workspace_root": str(source),
                    "target": {
                        "file_path": "feature/src/main/ets/Foo.ets"
                    }
                }),
                encoding="utf-8",
            )
            long_prompt = "full prompt\n" + ("x" * 16_000)
            (task_dir / "refactor-prompt.md").write_text(
                long_prompt,
                encoding="utf-8",
            )

            with patch(
                "arkts_smell_refactor.gate.subprocess.run"
            ) as run, patch(
                "arkts_smell_refactor.gate._sync_production_changes",
                return_value=0,
            ):
                run.return_value.returncode = 0
                self.assertEqual(
                    0,
                    refactor_gate(
                        task_dir,
                        source,
                        Path("deveco"),
                        model="provider/model",
                    ),
                )

            command = run.call_args.args[0]
            self.assertIn("provider/model", command)
            self.assertNotIn(long_prompt, command)
            prompt_argument = Path(command[command.index("-f") + 1])
            self.assertEqual(
                (task_dir / "refactor-agent-prompt.md").resolve(),
                prompt_argument,
            )
            self.assertEqual(
                long_prompt,
                prompt_argument.read_text(encoding="utf-8"),
            )

    def test_arkanalyzer_anonymous_method_belongs_to_outer_method(self):
        message = "Method '%AM2$initialiseUserInfoTextField' is feature-envious toward 'UserInfo'"
        reported = _reported_symbol(message)
        self.assertEqual("%AM2$initialiseUserInfoTextField", reported)
        self.assertTrue(
            _symbol_matches(reported, "initialiseUserInfoTextField")
        )
        self.assertFalse(
            _symbol_matches(reported, "initialiseEnumField")
        )

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
                '{"changedProductionFiles":["models/PageMapper.ets"]}',
                encoding="utf-8",
            )

            selected = _smell_scan_files(task_dir, source, target)
            self.assertEqual(
                [target.resolve(), changed.resolve()],
                selected,
            )

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
            self.assertEqual(
                {1, 2},
                changed["models/NewMapper.ets"],
            )

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
        # HomeCheck reports build at its declaration, while only
        # refactoredTarget changed.
        self.assertFalse(
            _issue_touches_changed_symbol(source, "build", 2, {6})
        )
        self.assertTrue(
            _issue_touches_changed_symbol(
                source,
                "refactoredTarget",
                5,
                {6},
            )
        )

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

    def test_production_resources_are_allowed_transactionally_for_all_smells(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_file = source / "feature/src/main/ets/Foo.ets"
            mirror_file = mirror / "feature/src/main/ets/Foo.ets"
            resource = mirror / "common/src/main/resources/base/media/icon.png"
            source_file.parent.mkdir(parents=True)
            mirror_file.parent.mkdir(parents=True)
            resource.parent.mkdir(parents=True)
            source_file.write_text("before", encoding="utf-8")
            mirror_file.write_text("after", encoding="utf-8")
            resource.write_bytes(b"png-data")
            self.assertEqual(0, _sync_production_changes(mirror, source))
            self.assertEqual(b"png-data", (source / "common/src/main/resources/base/media/icon.png").read_bytes())
            changes = __import__("json").loads((mirror.parent / "refactor-changes.json").read_text(encoding="utf-8"))
            self.assertEqual(["common/src/main/resources/base/media/icon.png"], changes["changedProductionResources"])
            self.assertEqual(64, len(changes["productionResourceManifest"][0]["sha256"]))

    def test_rejected_attempt_does_not_pollute_committed_change_list(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace-repair-1"
            source_file = source / "feature/src/main/ets/Foo.ets"
            mirror_file = mirror / "feature/src/main/ets/Foo.ets"
            forbidden = mirror / "build-profile.json5"
            source_file.parent.mkdir(parents=True)
            mirror_file.parent.mkdir(parents=True)
            source_file.write_text("before", encoding="utf-8")
            mirror_file.write_text("after", encoding="utf-8")
            forbidden.write_text("forbidden", encoding="utf-8")
            (mirror.parent / "refactor-changes.json").write_text(
                '{"changedProductionFiles":["previous.ets"]}', encoding="utf-8"
            )

            self.assertEqual(4, _sync_production_changes(mirror, source))
            committed = __import__("json").loads((mirror.parent / "refactor-changes.json").read_text(encoding="utf-8"))
            self.assertEqual(["previous.ets"], committed["changedProductionFiles"])
            attempt = __import__("json").loads(
                (mirror.parent / "agent-change-attempt-refactor-workspace-repair-1.json").read_text(encoding="utf-8")
            )
            self.assertEqual(["build-profile.json5"], attempt["rejectedFiles"])

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

    def test_review_pack_includes_transitive_relative_production_dependency(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_page = source / "feature/src/main/ets/pages/Page.ets"
            mirror_page = mirror / "feature/src/main/ets/pages/Page.ets"
            view_model = source / "feature/src/main/ets/viewModels/PageVM.ets"
            mapper = source / "feature/src/main/ets/types/PageMapper.ets"
            for path in (source_page, mirror_page, view_model, mapper):
                path.parent.mkdir(parents=True, exist_ok=True)
            source_page.write_text("export class Page {}", encoding="utf-8")
            mirror_page.write_text(
                "import { PageVM } from '../viewModels/PageVM'\nexport class Page { vm: PageVM }",
                encoding="utf-8",
            )
            view_model.write_text(
                "import { PageMapper } from '../types/PageMapper'\n"
                "export class PageVM { copy(): void { PageMapper.copy() } }",
                encoding="utf-8",
            )
            mapper.write_text("export class PageMapper { static copy(): void {} }", encoding="utf-8")

            self.assertEqual(0, _sync_production_changes(mirror, source))
            context = mirror.parent / "review-context-production/feature/src/main/ets"
            self.assertTrue((context / "viewModels/PageVM.ets").exists())
            self.assertTrue((context / "types/PageMapper.ets").exists())
            manifest = json.loads((mirror.parent / "review-context.json").read_text(encoding="utf-8"))
            self.assertIn("feature/src/main/ets/types/PageMapper.ets", manifest["productionDependencies"])

    def test_review_pack_resolves_local_harmony_package_alias_and_reexport(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            mirror = root / "task/refactor-workspace"
            source_page = source / "feature/book_person/src/main/ets/AccountCard.ets"
            mirror_page = mirror / "feature/book_person/src/main/ets/AccountCard.ets"
            feature_package = source / "feature/book_person/oh-package.json5"
            common_package = source / "commons/common/oh-package.json5"
            common_index = source / "commons/common/Index.ets"
            utility = source / "commons/common/src/main/ets/utils/UserInfoUtil.ets"
            for path in (source_page, mirror_page, feature_package, common_package, common_index, utility):
                path.parent.mkdir(parents=True, exist_ok=True)
            source_page.write_text("export class AccountCard {}", encoding="utf-8")
            mirror_page.write_text(
                "import { UserInfoUtil } from 'common'\n"
                "export class AccountCard { update(): void { UserInfoUtil.updateBookCoins(1) } }",
                encoding="utf-8",
            )
            feature_package.write_text(
                '{"name":"book_person","main":"Index.ets","dependencies":'
                '{"common":"file:../../commons/common"}}', encoding="utf-8",
            )
            common_package.write_text(
                '{"name":"common","main":"Index.ets"}', encoding="utf-8",
            )
            common_index.write_text(
                "export { UserInfoUtil } from './src/main/ets/utils/UserInfoUtil'",
                encoding="utf-8",
            )
            utility.write_text(
                "export class UserInfoUtil { static updateBookCoins(amount: number): void {} }",
                encoding="utf-8",
            )

            self.assertEqual(0, _sync_production_changes(mirror, source))
            context = mirror.parent / "review-context-production/commons/common"
            self.assertTrue((context / "Index.ets").exists())
            self.assertTrue((context / "src/main/ets/utils/UserInfoUtil.ets").exists())
            manifest = json.loads((mirror.parent / "review-context.json").read_text(encoding="utf-8"))
            self.assertIn(
                "commons/common/src/main/ets/utils/UserInfoUtil.ets",
                manifest["productionDependencies"],
            )

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
