import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.analysis.long_method import analyze_long_method
from arkts_smell_refactor.models import RefactorTask, SourceRange, Target
from arkts_smell_refactor.prompts import build_refactor_prompt, build_repair_prompt, build_review_prompt
from arkts_smell_refactor.risk import analyze_risks


class LongMethodAnalysisTests(unittest.TestCase):
    def test_detector_rules_reach_initial_repair_and_review_prompts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "Page.ets").write_text("struct Page {\n  build() {\n    Column() {}\n  }\n}", encoding="utf-8")
            task = RefactorTask(
                schema_version="1.0", task_id="T", source_project="demo", commit_hash="",
                workspace_root=temp, project_root=temp, smell_type="long-method",
                rule="@extrulesproject/long-method-check", severity="WARNING",
                message="Method 'build' is too long. Consider refactoring. (Current: 90 lines, Max: 80)",
                target=Target("Page.ets", "build", SourceRange(2, 4)), raw={},
            )
            risk = analyze_risks(task)
            profile = risk["longMethodAnalysis"]
            self.assertEqual(90, profile["reportedLineCount"])
            self.assertEqual(80, profile["reportedMax"])
            for prompt in (
                build_refactor_prompt(task, risk),
                build_repair_prompt(task, risk, {"stage": "smell"}, 1),
                build_review_prompt(task, risk),
                build_refactor_prompt(task, {}),
            ):
                self.assertIn("Long Method 检测规则", prompt)
                self.assertIn("UI 超过 80 行即使只报 warning", prompt)
                self.assertIn("不能把完整长方法搬给 helper", prompt)
                self.assertIn("最终以本轮 HomeCheck 为准", prompt)
            task.message = "custom finding with no line count"
            unknown = analyze_long_method(task, "")
            self.assertIsNone(unknown["reportedMax"])
            self.assertFalse(unknown["sourceAvailable"])
