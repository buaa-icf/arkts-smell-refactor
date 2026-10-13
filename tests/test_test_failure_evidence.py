import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.models import CommandResult
from arkts_smell_refactor.runner import _build_failure_report, _task_from_file
from arkts_smell_refactor.utils import write_json


class TestFailureEvidenceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.attempt = self.root / "test-attempts/current"
        self.attempt.mkdir(parents=True)
        self.manifest = {"plan": str(self.attempt / "plan.json"), "status": "FAIL", "jobs": []}
        self.task = {
            "schema_version": "1.0", "task_id": "clone", "source_project": "demo", "commit_hash": "",
            "workspace_root": str(self.root), "project_root": str(self.root), "smell_type": "code-clone",
            "rule": "rule", "severity": "", "message": "clone fragment",
            "target": {"file_path": "feature/Page.ets", "symbol": None, "range": {}, "related_targets": []}, "raw": {},
        }
        write_json(self.root / "task.json", self.task)
        write_json(self.root / "refactor-changes.json", {"changedProductionFiles": ["feature/Page.ets"]})
        self.log = self.root / "test.log"
        self.log.write_text("Page.ets compiled successfully; unrelated warning", encoding="utf-8")
        self.failed = CommandResult("test", "FAIL", command="python -m arkts_smell_refactor.gate hvigor --task auto-test",
                                    output_file=str(self.log))

    def job(self, *, suite="BusinessBehavior", status="FAIL", targeted=True, text=None, output="", attempt=None):
        folder = (attempt or self.attempt) / str(len(self.manifest["jobs"]))
        folder.mkdir(parents=True)
        log = folder / "hvigor.log"
        log.write_text(output, encoding="utf-8")
        artifacts = {}
        if text is not None:
            report = folder / "test_result.txt"
            report.write_text(text, encoding="utf-8")
            artifacts["test_result.txt"] = str(report)
        job = {"module": "phone", "kind": "instrument", "status": status, "expectedSuites": [suite],
               "selectionReason": "target-named-suite" if targeted else "module-fallback-all-available-kinds",
               "log": str(log), "artifacts": artifacts}
        self.manifest["jobs"].append(job)
        return job

    @staticmethod
    def case(suite="BusinessBehavior", details="assertion failed", result="Error"):
        return f"class={suite}\ntest=case\n{details}\nresult={result}\n"

    def report(self):
        write_json(self.root / "test-results.json", self.manifest)
        return _build_failure_report(self.root, _task_from_file(self.root / "task.json"), self.failed, 1)

    def test_target_named_suite_can_repair_clone_without_method_or_class_in_diagnostic(self):
        self.job(text=self.case())
        report = self.report()
        self.assertTrue(report["repairable"])
        self.assertEqual("RELATED_TEST_FAILURE", report["classification"])
        self.assertIn("class=BusinessBehavior", report["logTail"])
        self.assertNotIn("compiled successfully", report["logTail"])

    def test_passed_job_and_compile_warnings_cannot_attribute_an_unrelated_failure(self):
        self.job(status="PASS", text=self.case("PageTest", result="Success"), output="Page.ets compiled")
        self.job(suite="OtherTest", targeted=False, text=self.case("OtherTest"))
        report = self.report()
        self.assertFalse(report["repairable"])
        self.assertNotIn("PageTest", report["logTail"])
        self.assertNotIn("compiled", report["logTail"])

    def test_mixed_related_and_unrelated_failed_jobs_cannot_be_repaired(self):
        self.job(text=self.case())
        self.job(suite="OtherTest", targeted=False, text=self.case("OtherTest"))
        self.assertFalse(self.report()["repairable"])

    def test_unexpected_suite_is_not_attributed_just_because_job_is_targeted(self):
        self.job(text=self.case("UnrelatedTest"))
        self.assertFalse(self.report()["repairable"])

    def test_fallback_suite_can_be_attributed_by_changed_source_stack(self):
        self.job(suite="OtherTest", targeted=False, text=self.case("OtherTest", "at feature/Page.ets:45"))
        self.assertTrue(self.report()["repairable"])

    def test_missing_host_does_not_trigger_production_repair(self):
        self.job(text=self.case(details="Unable to find id: scenario_bar, error in beforeAll function"))
        report = self.report()
        self.assertFalse(report["repairable"])
        self.assertEqual("TEST_HOST_UNAVAILABLE", report["classification"])

    def test_compile_failure_uses_only_the_failed_job_log(self):
        self.job(status="PASS", output="Page.ets compiled successfully")
        job = self.job(targeted=False, output="Compiler error in Other.ets")
        self.assertFalse(self.report()["repairable"])
        Path(job["log"]).write_text("ArkTS Compiler Error: Page.ets:24 invalid type", encoding="utf-8")
        self.assertTrue(self.report()["repairable"])

    def test_previous_attempt_artifacts_are_not_reused(self):
        self.job(text=self.case("PageTest"), attempt=self.root / "test-attempts/old")
        report = self.report()
        self.assertFalse(report["repairable"])
        self.assertNotIn("PageTest", report["logTail"])

    def test_new_attempt_without_cases_does_not_fall_back_to_shared_stale_report(self):
        stale = self.root / "validation/phone/.test/default/intermediates/ohosTest/coverage_data/test_result.txt"
        stale.parent.mkdir(parents=True)
        stale.write_text(self.case("PageTest"), encoding="utf-8")
        write_json(self.root / "validation-workspace.json", {"path": str(self.root / "validation")})
        self.failed.command += " --module phone"
        self.job(output="Unrelated compiler failure")
        report = self.report()
        self.assertFalse(report["repairable"])
        self.assertNotIn("PageTest", report["logTail"])


if __name__ == "__main__":
    unittest.main()
