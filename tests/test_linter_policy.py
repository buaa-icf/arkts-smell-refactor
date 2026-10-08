import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from arkts_smell_refactor.cli import build_parser
from arkts_smell_refactor.models import CommandResult, RefactorTask, Target
from arkts_smell_refactor.runner import execute_pipeline


class LinterPolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        task = RefactorTask(
            schema_version="1.0", task_id="test", source_project="demo", commit_hash="",
            workspace_root=str(self.root), project_root=str(self.root),
            smell_type="long-method", rule="rule", severity="WARNING", message="smell",
            target=Target("Page.ets", "build"), raw={},
        )
        (self.root / "task.json").write_text(json.dumps(task.to_dict()), encoding="utf-8")
        (self.root / "risk-report.json").write_text("{}", encoding="utf-8")
        self.config = {
            "refactorAgent": {"command": ["agent"]},
            "repairAgent": {"command": ["repair"]},
            "reviewAgent": {"command": ["review"]},
            "gates": {name: {"command": [name]} for name in (
                "smell", "build", "contract", "runtime", "test", "linter",
            )},
            "linterMode": "skip",
        }

    def _run(self, name, spec, context, cwd, task_dir, dry_run):
        if name.startswith("review-agent"):
            (task_dir / f"{name}.log").write_text('{"verdict":"PASS"}', encoding="utf-8")
        return CommandResult(name, "DRY_RUN" if dry_run else "PASS", exit_code=0)

    def test_explicit_skip_runs_review_without_linter_or_repairs_and_records_policy(self):
        with patch("arkts_smell_refactor.runner._run_spec", side_effect=self._run) as run:
            result = execute_pipeline(self.root, self.config)
        names = [call.args[0] for call in run.call_args_list]
        self.assertEqual(["refactor-agent", "smell", "build", "contract", "runtime", "test", "review-agent"], names)
        self.assertEqual("PASS", result["verdict"])
        self.assertEqual(0, result["repairAttempts"])
        self.assertEqual({"linterMode": "skip"}, result["validationPolicy"])
        linter = next(step for step in result["steps"] if step["name"] == "linter")
        self.assertEqual("SKIPPED", linter["status"])
        self.assertIn("linterMode=skip", linter["reason"])
        gates = json.loads((self.root / "gates.json").read_text(encoding="utf-8"))
        self.assertEqual(result["validationPolicy"], gates["validationPolicy"])

    def test_disabled_or_missing_linter_is_not_an_implicit_waiver(self):
        self.config.pop("linterMode")
        for spec in (None, {"enabled": False}):
            with self.subTest(spec=spec):
                self.config["gates"]["linter"] = spec
                with patch("arkts_smell_refactor.runner._run_spec", side_effect=self._run) as run:
                    result = execute_pipeline(self.root, self.config)
                self.assertEqual("INCOMPLETE", result["verdict"])
                self.assertEqual({"linterMode": "required"}, result["validationPolicy"])
                self.assertNotIn("review-agent", [call.args[0] for call in run.call_args_list])

    def test_skipping_linter_does_not_waive_other_gate_failures(self):
        self.config.pop("repairAgent")
        for failed_gate in ("smell", "build", "contract", "runtime", "test"):
            with self.subTest(gate=failed_gate):
                def fail_one(name, *args):
                    return CommandResult(name, "FAIL", exit_code=1) if name == failed_gate else self._run(name, *args)

                with patch("arkts_smell_refactor.runner._run_spec", side_effect=fail_one) as run:
                    result = execute_pipeline(self.root, self.config)
                self.assertEqual("FAIL", result["verdict"])
                self.assertNotIn("review-agent", [call.args[0] for call in run.call_args_list])

    def test_skipping_linter_does_not_waive_missing_test_gate(self):
        self.config["gates"].pop("test")
        with patch("arkts_smell_refactor.runner._run_spec", side_effect=self._run) as run:
            result = execute_pipeline(self.root, self.config)
        self.assertEqual("INCOMPLETE", result["verdict"])
        self.assertNotIn("review-agent", [call.args[0] for call in run.call_args_list])

    def test_semantic_failure_still_repairs_and_keeps_linter_skipped(self):
        def fail_first_review(name, *args):
            result = self._run(name, *args)
            if name == "review-agent":
                (self.root / "review-agent.log").write_text(json.dumps({
                    "verdict": "FAIL", "issues": [{"severity": "blocking", "reason": "guard changed"}],
                }), encoding="utf-8")
            return result

        with patch("arkts_smell_refactor.runner._run_spec", side_effect=fail_first_review) as run:
            result = execute_pipeline(self.root, self.config)
        self.assertEqual("PASS", result["verdict"])
        self.assertEqual(1, result["repairAttempts"])
        names = [call.args[0] for call in run.call_args_list]
        self.assertIn("review-agent-repair-1", names)
        self.assertIn("repair-agent-1", names)
        self.assertFalse(any(name.startswith("linter") for name in names))
        repair_prompt = (self.root / "repair-prompt-1.md").read_text(encoding="utf-8")
        self.assertIn("本轮 Linter 已明确跳过", repair_prompt)

    def test_required_linter_failure_still_triggers_repair(self):
        self.config["linterMode"] = "required"

        def fail_first_linter(name, *args):
            return CommandResult(name, "FAIL", exit_code=1) if name == "linter" else self._run(name, *args)

        with patch("arkts_smell_refactor.runner._run_spec", side_effect=fail_first_linter):
            result = execute_pipeline(self.root, self.config)
        self.assertEqual("PASS", result["verdict"])
        self.assertEqual(1, result["repairAttempts"])
        self.assertNotIn("本轮 Linter 已明确跳过", (self.root / "repair-prompt-1.md").read_text(encoding="utf-8"))

    def test_invalid_policy_fails_before_starting_agents(self):
        self.config["linterMode"] = "skpi"
        with patch("arkts_smell_refactor.runner._run_spec") as run:
            with self.assertRaisesRegex(ValueError, "linterMode"):
                execute_pipeline(self.root, self.config)
        run.assert_not_called()

    def test_cli_requires_explicit_skip(self):
        parser = build_parser()
        self.assertEqual("required", parser.parse_args(["start"]).linter_mode)
        self.assertEqual("skip", parser.parse_args(["start", "--linter-mode", "skip"]).linter_mode)


if __name__ == "__main__":
    unittest.main()
