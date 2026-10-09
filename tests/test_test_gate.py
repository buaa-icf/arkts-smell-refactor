import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from arkts_smell_refactor.test_execution import _result_evidence, run_test_plan
from arkts_smell_refactor.test_plan import build_test_plan
from arkts_smell_refactor.utils import write_json


class TestGateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / "app"
        self.source.mkdir()
        self.task_dir = self.root / "task"
        self.task_dir.mkdir()
        self.modules = {"featureName": "features/feature_dir", "host": "products/phone"}
        (self.source / "build-profile.json5").write_text("""{
            // Directory names need not equal Hvigor module names.
            modules: [{ name: 'featureName', srcPath: './features/feature_dir',
                        targets: [{name:'default', applyToProducts:['default']}], },
                      { name: 'host', srcPath: './products/phone' },],
        }""", encoding="utf-8")
        self.target = self.source / "features/feature_dir/src/main/ets/Page.ets"
        self.target.parent.mkdir(parents=True)
        self.target.write_text("export class Page {}", encoding="utf-8")
        self.task = {"workspace_root": str(self.root), "target": {
            "file_path": self.target.relative_to(self.root).as_posix(), "related_targets": [],
        }}
        write_json(self.task_dir / "task.json", self.task)

    def suite(self, kind, name="Page", module="featureName", suite_name=None, register=True):
        directory = "src/test" if kind == "local" else "src/ohosTest/ets/test"
        file = self.source / self.modules[module] / directory / (name + ".test.ets")
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(f"// describe('CommentedOut', () => {{}})\n"
                        f"export default function test() {{ describe('{suite_name or name + 'Test'}', () => {{}}); }}", encoding="utf-8")
        if register:
            entry = file.with_name("List.test.ets")
            text = entry.read_text(encoding="utf-8") if entry.exists() else "export default function testsuite() {\n}\n"
            text = f"import run{name} from './{name}.test';\n" + text
            entry.write_text(text.replace("\n}", f"\n  run{name}();\n}}", 1), encoding="utf-8")
        return file

    def plan(self):
        return build_test_plan(self.task_dir, self.source)

    def test_ui_suite_wins_over_unrelated_local_placeholder(self):
        self.suite("local", "LocalUnit")
        self.suite("instrument")
        jobs = self.plan()["jobs"]
        self.assertEqual([("instrument", "featureName", "PageTest")],
                         [(j["kind"], j["module"], j["scope"]) for j in jobs])
        self.assertEqual(["PageTest"], jobs[0]["expectedSuites"])

    def test_local_only_target(self):
        self.suite("local")
        self.suite("instrument", "Ability")
        self.assertEqual(["local"], [j["kind"] for j in self.plan()["jobs"]])

    def test_both_related_kinds_are_required(self):
        self.suite("local")
        self.suite("instrument")
        self.assertEqual(["local", "instrument"], [j["kind"] for j in self.plan()["jobs"]])

    def test_dormant_local_target_does_not_block_registered_instrument(self):
        self.suite("local", "LocalUnit")
        self.suite("local", register=False)
        self.suite("instrument")
        plan = self.plan()
        self.assertEqual([("instrument", "PageTest")], [(j["kind"], j["scope"]) for j in plan["jobs"]])
        def run(command, **kwargs):
            self.assertIn("onDeviceTest", command)
            self.result_file(plan["jobs"][0], self.success())
            return subprocess.CompletedProcess(command, 0, "", "")
        code, run = self.execute(plan, run)
        self.assertEqual(0, code)
        self.assertEqual(1, run.call_count)

    def test_module_fallback_does_not_expect_unregistered_suites(self):
        self.suite("local", "LocalUnit")
        self.suite("local", "Unused", register=False)
        job = self.plan()["jobs"][0]
        self.assertIsNone(job["scope"])
        self.assertEqual(["LocalUnitTest"], job["expectedSuites"])

    def test_entry_follows_aliases_multiline_exports_and_nested_registration(self):
        file = self.suite("instrument", register=False)
        folder = file.parent
        (folder / "List.test.ets").write_text(
            "import { register as run } from './registration';\nexport default function testsuite() { run(); }", encoding="utf-8")
        (folder / "registration.ets").write_text(
            "export {\n default as register\n} from './nested';", encoding="utf-8")
        (folder / "nested.ets").write_text(
            "import renamed from './Page.test.ets';\nimport './registration';\n"
            "export default function register() { renamed(); }", encoding="utf-8")
        self.assertEqual(["PageTest"], self.plan()["jobs"][0]["expectedSuites"])

    def test_comment_string_and_type_imports_do_not_register_local_suite(self):
        file = self.suite("local", "LocalUnit")
        self.suite("local", register=False)
        self.suite("instrument")
        entry = file.with_name("List.test.ets")
        text = entry.read_text(encoding="utf-8")
        text += "\n// import Page from './Page.test';\nconst hint = `import Page from './Page.test';`;\n"
        text += "import type { Page } from './Page.test';\n"
        entry.write_text(text, encoding="utf-8")
        self.assertEqual(["instrument"], [j["kind"] for j in self.plan()["jobs"]])

    def test_unknown_registration_does_not_silently_drop_local_kind(self):
        for registration in (None, "export default function testsuite() { import(suitePath); }",
                             "import run from './missing'; export default function testsuite() { run(); }"):
            with self.subTest(registration=registration):
                file = self.suite("local", register=False)
                entry = file.with_name("List.test.ets")
                if registration is None:
                    entry.unlink(missing_ok=True)
                else:
                    entry.write_text(registration, encoding="utf-8")
                self.suite("instrument")
                self.assertEqual(["local", "instrument"], [j["kind"] for j in self.plan()["jobs"]])

    def test_ui_test_in_a_different_host_module_is_discovered(self):
        self.suite("local", "LocalUnit")
        self.suite("instrument", module="host")
        jobs = self.plan()["jobs"]
        self.assertEqual(1, len(jobs))
        self.assertEqual("host", jobs[0]["module"])
        self.assertEqual("products/phone", jobs[0]["modulePath"])

    def test_ambiguous_target_runs_both_kinds_without_scope(self):
        self.suite("local", "Behavior")
        self.suite("instrument", "UIBehavior")
        jobs = self.plan()["jobs"]
        self.assertEqual(["local", "instrument"], [j["kind"] for j in jobs])
        self.assertTrue(all(j["scope"] is None for j in jobs))

    def test_clone_counterpart_and_new_changed_module_are_included(self):
        self.suite("instrument")
        self.suite("local", "Other", module="host")
        self.task["target"]["related_targets"] = [{"filePath": "app/products/phone/src/main/ets/Other.ets"}]
        write_json(self.task_dir / "task.json", self.task)
        jobs = self.plan()["jobs"]
        self.assertEqual({"PageTest", "OtherTest"}, {j["scope"] for j in jobs})
        self.task["target"]["related_targets"] = []
        write_json(self.task_dir / "task.json", self.task)
        write_json(self.task_dir / "refactor-changes.json", {"changedProductionFiles": ["products/phone/src/main/ets/Helper.ets"]})
        jobs = self.plan()["jobs"]
        self.assertIsNone(next(j for j in jobs if j["module"] == "host")["scope"])

    def test_same_module_extracted_helper_does_not_hide_original_test(self):
        self.suite("instrument")
        write_json(self.task_dir / "refactor-changes.json", {"changedProductionFiles": ["features/feature_dir/src/main/ets/Helper.ets"]})
        self.assertEqual("PageTest", self.plan()["jobs"][0]["scope"])

    def test_external_clone_target_blocks_instead_of_being_ignored(self):
        self.suite("instrument")
        self.task["target"]["related_targets"] = [{"filePath": "other-app/entry/src/main/Other.ets"}]
        write_json(self.task_dir / "task.json", self.task)
        with self.assertRaises(ValueError):
            self.plan()

    def test_missing_tests_block(self):
        with self.assertRaisesRegex(ValueError, "No runnable test"):
            self.plan()

    def test_dynamic_suite_name_falls_back_to_both_kinds(self):
        file = self.suite("instrument")
        file.write_text("describe(suiteName, () => {});", encoding="utf-8")
        self.suite("local", "LocalUnit")
        self.assertEqual([None, None], [j["scope"] for j in self.plan()["jobs"]])

    def test_explicit_device_task_uses_requested_module(self):
        self.suite("instrument", module="host")
        plan = build_test_plan(self.task_dir, self.source, "onDeviceTest", "host@ohosTest")
        self.assertEqual(["host"], [j["module"] for j in plan["jobs"]])

    def test_explicit_project_test_runs_modules_that_have_requested_kind(self):
        self.suite("local")
        self.suite("instrument", module="host")
        plan = build_test_plan(self.task_dir, self.source, "test")
        self.assertEqual(["featureName"], [j["module"] for j in plan["jobs"]])

    def test_empty_plan_is_blocked_without_invoking_hvigor(self):
        code, run = self.execute({"jobs": []}, lambda cmd, **kw: None)
        self.assertEqual(3, code)
        run.assert_not_called()

    def result_file(self, job, text):
        variant = "test" if job["kind"] == "local" else "ohosTest"
        file = self.source / job["modulePath"] / f".test/default/intermediates/{variant}/coverage_data/test_result.txt"
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")
        return file

    @staticmethod
    def success(suite="PageTest"):
        return f"class={suite}\ntest=case\nresult=Success\nTests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\n"

    def execute(self, plan, callback):
        with redirect_stdout(io.StringIO()), patch("arkts_smell_refactor.test_execution.subprocess.run", side_effect=callback) as run:
            code = run_test_plan(self.task_dir, self.source, plan, ["hvigorw"], {})
        return code, run

    def test_commands_execute_both_kinds_and_keep_separate_fresh_evidence(self):
        self.suite("local")
        self.suite("instrument")
        plan = self.plan()
        def run(command, **kwargs):
            kind = "instrument" if "onDeviceTest" in command else "local"
            job = next(j for j in plan["jobs"] if j["kind"] == kind)
            self.result_file(job, self.success())
            self.assertIn("module=featureName@ohosTest" if kind == "instrument" else "module=featureName", command)
            self.assertIn("scope=PageTest", command)
            return subprocess.CompletedProcess(command, 0, "BUILD SUCCESSFUL", "")
        code, run = self.execute(plan, run)
        self.assertEqual(0, code)
        self.assertEqual(2, run.call_count)
        result = json.loads((self.task_dir / "test-results.json").read_text())
        self.assertEqual("PASS", result["status"])
        self.assertTrue(all(Path(j["artifacts"]["test_result.txt"]).is_file() for j in result["jobs"]))

    def test_stale_result_or_compile_only_cannot_pass(self):
        self.suite("instrument")
        plan = self.plan()
        self.result_file(plan["jobs"][0], self.success())
        code, _ = self.execute(plan, lambda command, **kw: subprocess.CompletedProcess(command, 0, "SignHap SUCCESS", ""))
        self.assertEqual(3, code)
        result = json.loads((self.task_dir / "test-results.json").read_text())
        self.assertEqual("BLOCKED", result["status"])

    def test_assertion_failure_is_fail_even_when_hvigor_returns_zero(self):
        self.suite("local")
        plan = self.plan()
        def run(command, **kwargs):
            self.result_file(plan["jobs"][0], "class=PageTest\ntest=case\nresult=Fail\nTests run: 1, Failure: 1, Error: 0, Pass: 0")
            return subprocess.CompletedProcess(command, 0, "", "")
        code, _ = self.execute(plan, run)
        self.assertEqual(1, code)

    def test_zero_cases_unregistered_suite_or_incomplete_result_are_blocked(self):
        file = self.root / "test_result.txt"
        for text in ("Tests run: 0, Failure: 0, Error: 0, Pass: 0", self.success("OtherTest"),
                     "class=PageTest\ntest=case\nresult=Success", "Tests run: 1, Failure: 0, Error: 0, Pass: 1"):
            with self.subTest(text=text):
                file.write_text(text, encoding="utf-8")
                self.assertEqual("BLOCKED", _result_evidence(file, ["PageTest"])["status"])

    def test_nonzero_exit_is_not_hidden_by_passing_cases(self):
        self.suite("local")
        plan = self.plan()
        def run(command, **kwargs):
            self.result_file(plan["jobs"][0], self.success())
            return subprocess.CompletedProcess(command, 1, "coverage generation failed", "")
        code, _ = self.execute(plan, run)
        self.assertEqual(1, code)

    def test_device_and_missing_signed_package_errors_block(self):
        self.suite("instrument")
        plan = self.plan()
        for output in ("Connect server failed", "no connected device", "Check whether the hap/hsp package is signed."):
            with self.subTest(output=output):
                code, _ = self.execute(plan, lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, output, ""))
                self.assertEqual(3, code)
                result = json.loads((self.task_dir / "test-results.json").read_text())
                self.assertEqual("BLOCKED", result["status"])

    def test_failed_local_test_stops_device_job_and_records_pending_job(self):
        self.suite("local")
        self.suite("instrument")
        code, run = self.execute(self.plan(), lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "Compiler error in Page.ets", ""))
        self.assertEqual(1, code)
        self.assertEqual(1, run.call_count)
        result = json.loads((self.task_dir / "test-results.json").read_text())
        self.assertEqual("instrument", result["pendingJobs"][0]["kind"])


if __name__ == "__main__":
    unittest.main()
