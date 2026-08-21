import json
import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.runner import _extract_review_json, execute_pipeline


class RunnerTests(unittest.TestCase):
    def test_dry_run_renders_all_steps(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0",
                "task_id": "feature-envy-0001-work",
                "source_project": "demo",
                "commit_hash": "abc",
                "workspace_root": temp,
                "project_root": temp,
                "smell_type": "feature-envy",
                "rule": "@extrulesproject/feature-envy-check",
                "severity": "SUGGESTION",
                "message": "Method 'work' is feature-envious.",
                "target": {"file_path": "demo/Foo.ets", "symbol": "work", "range": {"start_line": 1, "end_line": 2, "column": 1}, "related_targets": []},
                "raw": {},
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            config = {
                "refactorAgent": {"command": ["agent", "{prompt_file}"]},
                "gates": {name: {"command": [name, "{target_file}"]} for name in ("smell", "build", "test", "linter")},
                "reviewAgent": {"command": ["review", "{review_prompt_file}"]},
            }
            result = execute_pipeline(task_dir, config, dry_run=True)
            self.assertEqual("DRY_RUN", result["verdict"])
            self.assertEqual(6, len(result["steps"]))
            self.assertTrue(all(item["status"] == "DRY_RUN" for item in result["steps"]))

    def test_extracts_last_review_verdict_from_noisy_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            log = root / "review-agent.log"
            output = root / "review.json"
            log.write_text(
                'event {"type":"message"}\n评审完成\n'
                '{"verdict":"FAIL","summary":"接口断裂","issues":[]}\n',
                encoding="utf-8",
            )
            review = _extract_review_json(log, output)
            self.assertEqual("FAIL", review["verdict"])
            self.assertTrue(output.exists())

    def test_success_output_can_override_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0", "task_id": "x", "source_project": "demo",
                "commit_hash": "", "workspace_root": temp, "project_root": temp,
                "smell_type": "feature-envy", "rule": "rule", "severity": "",
                "message": "message",
                "target": {"file_path": "Foo.ets", "symbol": "work", "range": {}, "related_targets": []},
                "raw": {}
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            command = [
                __import__('sys').executable, "-c",
                "print('No defects found in your code.'); raise SystemExit(1)"
            ]
            config = {"gates": {"linter": {"command": command, "successOutputRegex": "No defects found in your code\\."}}}
            result = execute_pipeline(task_dir, config)
            linter = next(item for item in result["steps"] if item["name"] == "linter")
            self.assertEqual("PASS", linter["status"])

    def test_signing_failure_is_blocked_instead_of_refactor_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0", "task_id": "x", "source_project": "demo",
                "commit_hash": "", "workspace_root": temp, "project_root": temp,
                "smell_type": "feature-envy", "rule": "rule", "severity": "",
                "message": "message",
                "target": {"file_path": "Foo.ets", "symbol": "work", "range": {}, "related_targets": []},
                "raw": {}
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            command = [
                __import__('sys').executable, "-c",
                "print('Failed :entry:default@SignHap: Invalid storeFile value'); raise SystemExit(1)"
            ]
            config = {"gates": {"build": {
                "command": command,
                "blockedOutputRegex": "SignHap|Invalid storeFile value"
            }}}
            result = execute_pipeline(task_dir, config)
            build = next(item for item in result["steps"] if item["name"] == "build")
            self.assertEqual("BLOCKED", build["status"])

    def test_refactor_blocker_skips_meaningless_downstream_gates(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0", "task_id": "x", "source_project": "demo",
                "commit_hash": "", "workspace_root": temp, "project_root": temp,
                "smell_type": "feature-envy", "rule": "rule", "severity": "",
                "message": "message",
                "target": {"file_path": "Foo.ets", "symbol": "work", "range": {}, "related_targets": []},
                "raw": {}
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            command = [__import__('sys').executable, "-c", "print('model service is currently overloaded'); raise SystemExit(1)"]
            config = {
                "refactorAgent": {"command": command, "blockedOutputRegex": "model service is currently overloaded"},
                "gates": {name: {"command": ["must-not-run"]} for name in ("smell", "build", "test", "linter")},
                "reviewAgent": {"command": ["must-not-run"]},
            }
            result = execute_pipeline(task_dir, config)
            self.assertEqual("BLOCKED", result["verdict"])
            self.assertEqual("BLOCKED", result["steps"][0]["status"])
            self.assertTrue(all(step["status"] == "SKIPPED" for step in result["steps"][1:]))

    def test_timeout_returns_blocked_without_hanging(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0", "task_id": "timeout", "source_project": "demo",
                "commit_hash": "", "workspace_root": temp, "project_root": temp,
                "smell_type": "feature-envy", "rule": "rule", "severity": "",
                "message": "message",
                "target": {"file_path": "Foo.ets", "symbol": "work", "range": {}, "related_targets": []},
                "raw": {}
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            command = [__import__('sys').executable, "-c", "import time; time.sleep(10)"]
            result = execute_pipeline(task_dir, {"refactorAgent": {"command": command, "timeoutSeconds": 1}})
            self.assertEqual("BLOCKED", result["steps"][0]["status"])
            self.assertIn("超过 1 秒", result["steps"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
