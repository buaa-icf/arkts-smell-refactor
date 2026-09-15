import json
import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.analysis.code_clone import analyze_code_clone
from arkts_smell_refactor.dataset import load_dataset_tasks
from arkts_smell_refactor.prompts import build_refactor_prompt, build_repair_prompt, build_review_prompt
from arkts_smell_refactor.risk import analyze_risks


class CodeCloneAnalysisTests(unittest.TestCase):
    def _task(self, root: Path):
        dataset = root / "positive.json"
        dataset.write_text(json.dumps([{
            "filePath": "demo/src/main/ets/First.ets",
            "sourceProject": "demo",
            "commitHash": "",
            "messages": [{
                "line": 2,
                "column": 1,
                "severity": "SUGGESTION",
                "message": "Code Clone Type-2 (different classes): First.ets:2-8 is similar to demo/src/main/ets/Second.ets:2-8.",
                "rule": "@extrulesproject/code-clone-fragment-check",
                "rangeStart": 2,
                "rangeEnd": 8,
            }],
        }]), encoding="utf-8")
        return load_dataset_tasks(dataset, root)[0]

    def test_profiles_all_instances_and_preserves_ui_callback_differences(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "demo/src/main/ets/First.ets"
            second = root / "demo/src/main/ets/Second.ets"
            first.parent.mkdir(parents=True)
            first.write_text("""\n@Builder function firstCard() {
  Column() {
    Text('first').id('first-card')
      .onClick(() => { this.firstCount += 1 })
  }
}\n""", encoding="utf-8")
            second.write_text("""\n@Builder function secondCard() {
  Column() {
    Text('second').id('second-card')
      .onChange(() => { this.secondCount += 1 })
  }
}\n""", encoding="utf-8")
            task = self._task(root)
            analysis = analyze_code_clone(task, first.read_text(encoding="utf-8"))
            self.assertEqual(2, analysis["instanceCount"])
            self.assertEqual(2, analysis["resolvedInstanceCount"])
            self.assertEqual("TYPE_2_PARAMETERIZABLE", analysis["classification"])
            self.assertEqual("PARAMETERIZED_BUILDER_OR_HELPER", analysis["recommendedPattern"])
            self.assertTrue(any(item["kind"] == "ui-id" for item in analysis["variationDimensions"]))
            self.assertTrue(any(item["kind"] == "callback" for item in analysis["variationDimensions"]))
            self.assertTrue(any(item["kind"] == "state-write" for item in analysis["variationDimensions"]))

    def test_risk_and_prompts_expose_group_wide_clone_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "demo/src/main/ets/First.ets"
            second = root / "demo/src/main/ets/Second.ets"
            first.parent.mkdir(parents=True)
            first.write_text("\nText('one').id('one')\n", encoding="utf-8")
            second.write_text("\nText('two').id('two')\n", encoding="utf-8")
            task = self._task(root)
            report = analyze_risks(task)
            self.assertIn("codeCloneAnalysis", report)
            self.assertIn("CLONE_GROUP_INCOMPLETE", {item["code"] for item in report["risks"]})
            self.assertIn("ELIMINATE_WHOLE_CLONE_GROUP", {item["code"] for item in report["recommendedConstraints"]})
            refactor_prompt = build_refactor_prompt(task, report)
            review_prompt = build_review_prompt(task, report)
            self.assertIn("Code Clone 静态画像", refactor_prompt)
            self.assertIn("克隆组", refactor_prompt)
            self.assertIn("全部实例均被实质处理", review_prompt)

    def test_prompts_render_all_clone_paths_relative_to_project_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "demo/src/main/ets/First.ets"
            second = root / "demo/src/main/ets/Second.ets"
            first.parent.mkdir(parents=True)
            first.write_text("\nText('one')\n", encoding="utf-8")
            second.write_text("\nText('two')\n", encoding="utf-8")
            task = self._task(root)
            report = analyze_risks(task)

            refactor_prompt = build_refactor_prompt(task, report)
            review_prompt = build_review_prompt(task, report)
            repair_prompt = build_repair_prompt(task, report, {
                "stage": "smell",
                "issues": [{"category": "remaining-smell", "reason": task.message}],
            }, 1)

            for prompt in (refactor_prompt, review_prompt, repair_prompt):
                self.assertIn("src/main/ets/Second.ets:2-8", prompt)
                self.assertNotIn("demo/src/main/ets/Second.ets", prompt)

    def test_dataset_parses_counterpart_with_method_qualifier(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dataset = root / "positive.json"
            dataset.write_text(json.dumps([{
                "filePath": "demo/src/main/ets/First.ets", "sourceProject": "demo", "commitHash": "",
                "messages": [{"line": 1, "message": "Code Clone Type-2: First.ets > A.f():1-2 is similar to demo/src/main/ets/Second.ets > B.g():3-4.", "rule": "@extrulesproject/code-clone-fragment-check", "rangeStart": 1, "rangeEnd": 2}],
            }]), encoding="utf-8")
            task = load_dataset_tasks(dataset, root)[0]
            self.assertEqual("demo/src/main/ets/Second.ets", task.target.related_targets[0]["filePath"])
            self.assertEqual(3, task.target.related_targets[0]["range"]["startLine"])


if __name__ == "__main__":
    unittest.main()
