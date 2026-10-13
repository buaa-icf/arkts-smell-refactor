import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from arkts_smell_refactor.models import CommandResult
from arkts_smell_refactor.runner import execute_pipeline
from arkts_smell_refactor.utils import write_json


class PipelineIntegrationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        write_json(self.root / "task.json", {
            "schema_version": "1.0", "task_id": "clone", "source_project": "demo", "commit_hash": "",
            "workspace_root": str(self.root), "project_root": str(self.root), "smell_type": "code-clone",
            "rule": "rule", "severity": "", "message": "clone fragment",
            "target": {"file_path": "Page.ets", "symbol": None, "range": {}, "related_targets": []}, "raw": {},
        })
        write_json(self.root / "risk-report.json", {})
        self.config = {
            "refactorAgent": {"command": ["agent"]}, "repairAgent": {"command": ["repair"]},
            "reviewAgent": {"command": ["review"], "retryDelaySeconds": 0, "maxEnvironmentRetries": 1},
            "linterMode": "skip", "taskTimeoutSeconds": 1200,
            "gates": {name: {"command": [name]} for name in ("smell", "build", "contract", "runtime", "test", "linter")},
        }

    def pass_step(self, name):
        if name.startswith("review-agent"):
            (self.root / (name + ".log")).write_text(json.dumps({"verdict": "PASS"}), encoding="utf-8")
        return CommandResult(name, "PASS", exit_code=0)

    def test_parallel_gates_finish_before_runtime_and_test_with_linter_skipped(self):
        barrier = threading.Barrier(3)
        completed = set()
        def run(name, *args, **kwargs):
            self.assertNotEqual("linter", name)
            if name in {"smell", "build", "contract"}:
                barrier.wait(timeout=3)
                completed.add(name)
            if name in {"runtime", "test", "review-agent"}:
                self.assertEqual({"smell", "build", "contract"}, completed)
            return self.pass_step(name)
        with patch("arkts_smell_refactor.runner._run_spec", side_effect=run):
            result = execute_pipeline(self.root, self.config)
        self.assertEqual("PASS", result["verdict"])
        self.assertEqual({"linterMode": "skip"}, result["validationPolicy"])
        self.assertEqual(1200, result["timeoutSeconds"])
        self.assertFalse(result["timedOut"])

    def test_parallel_environment_blocker_prevents_repair_of_simultaneous_defect(self):
        barrier = threading.Barrier(2)
        def run(name, *args, **kwargs):
            self.assertNotIn(name, {"test", "runtime", "repair-agent-1", "review-agent"})
            if name in {"smell", "build"}:
                barrier.wait(timeout=3)
                return CommandResult(name, "FAIL" if name == "smell" else "BLOCKED")
            return self.pass_step(name)
        with patch("arkts_smell_refactor.runner._run_spec", side_effect=run):
            result = execute_pipeline(self.root, self.config)
        self.assertEqual(0, result["repairAttempts"])
        self.assertFalse((self.root / "failure-report-1.json").exists())

    def test_repair_and_review_retry_share_the_original_task_deadline(self):
        deadlines = []
        def run(name, *args, **kwargs):
            deadlines.append(kwargs["task_deadline"])
            self.assertFalse(name.startswith("linter"))
            if name == "smell":
                return CommandResult(name, "FAIL", exit_code=1)
            if name == "review-agent-repair-1":
                return CommandResult(name, "BLOCKED", exit_code=1)
            return self.pass_step(name)
        with patch("arkts_smell_refactor.runner._run_spec", side_effect=run):
            result = execute_pipeline(self.root, self.config)
        self.assertEqual("PASS", result["verdict"])
        self.assertEqual(1, result["repairAttempts"])
        self.assertEqual(1, result["reviewRetries"])
        self.assertEqual(1, len(set(deadlines)))
        self.assertIsNotNone(deadlines[0])


if __name__ == "__main__":
    unittest.main()
