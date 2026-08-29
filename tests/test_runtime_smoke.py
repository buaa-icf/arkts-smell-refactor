import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from arkts_smell_refactor.gate import runtime_smoke_gate
from arkts_smell_refactor.models import RefactorTask, SourceRange, Target
from arkts_smell_refactor.runtime_smoke import build_runtime_smoke_plan, prepare_runtime_smoke, render_runtime_smoke_test


class RuntimeSmokeTests(unittest.TestCase):
    def _task(self, root: Path) -> RefactorTask:
        return RefactorTask(
            schema_version="1.0", task_id="T", source_project="Demo", commit_hash="",
            workspace_root=str(root), project_root=str(root), smell_type="god-class", rule="formal/god-class",
            severity="WARNING", message="smell",
            target=Target("common/src/main/ets/Service.ets", "Service", SourceRange()), raw={},
        )

    def test_planner_is_risk_triggered_and_contains_no_business_assertion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); current = self._task(root); target = current.target_path
            target.parent.mkdir(parents=True); target.write_text(
                "export class Service {\n"
                "  constructor() { getContext().resourceManager; }\n"
                "  public getTotalCount(): number { return 0; }\n"
                "}", encoding="utf-8",
            )
            risk = {"godClassAnalysis": {"methods": [
                {"name": "constructor", "requiredParameterCount": 0, "visibility": "public", "static": False, "riskSignals": ["runtime-context"]},
                {"name": "getTotalCount", "requiredParameterCount": 0, "visibility": "public", "static": False, "riskSignals": []},
            ]}}
            plan = build_runtime_smoke_plan(current, risk)
            self.assertTrue(plan["enabled"]); self.assertEqual([], plan["businessExpectedValues"])
            rendered = render_runtime_smoke_test(plan)
            self.assertIn("new Service()", rendered); self.assertNotIn("assertEqual", rendered)

    def test_gate_only_fails_when_baseline_passes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "current").mkdir(); (root / "runtime-smoke-baseline").mkdir()
            (root / "runtime-smoke-plan.json").write_text(json.dumps({"enabled": True}), encoding="utf-8")
            with patch("arkts_smell_refactor.gate._run_runtime_smoke_copy", side_effect=[{"passed": True}, {"passed": False}]):
                status = runtime_smoke_gate(root, root / "current", Path("hvigorw.js"), None)
            self.assertEqual(1, status)
            result = json.loads((root / "runtime-smoke-results.json").read_text())
            self.assertEqual("INTRODUCED_RUNTIME_INITIALIZATION_FAILURE", result["classification"])

    def test_prepared_baseline_physically_excludes_tests(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); current = self._task(root); target = current.target_path
            target.parent.mkdir(parents=True); target.write_text(
                "export class Service { constructor() { getContext().resourceManager; } }", encoding="utf-8",
            )
            local_test = root / "common/src/test/Secret.test.ets"
            local_test.parent.mkdir(parents=True); local_test.write_text("hidden", encoding="utf-8")
            risk = {"godClassAnalysis": {"methods": [{
                "name": "constructor", "requiredParameterCount": 0, "visibility": "public",
                "static": False, "riskSignals": ["runtime-context"],
            }]}}
            task_dir = root / "task"; task_dir.mkdir()
            plan = prepare_runtime_smoke(current, risk, task_dir)
            self.assertTrue(plan["enabled"])
            self.assertFalse((task_dir / "runtime-smoke-baseline/common/src/test").exists())


if __name__ == "__main__":
    unittest.main()
