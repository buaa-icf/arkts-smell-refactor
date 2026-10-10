import json
import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.automatic import _review_risk
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

    def test_prompts_bound_exploration_and_edit_before_verify(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "demo/src/main/ets/First.ets"
            second = root / "demo/src/main/ets/Second.ets"
            first.parent.mkdir(parents=True)
            first.write_text("\nText('one').id('one')\n", encoding="utf-8")
            second.write_text("\nText('two').id('two')\n", encoding="utf-8")
            task = self._task(root)
            report = analyze_risks(task)

            refactor_prompt = build_refactor_prompt(task, report)
            repair_prompt = build_repair_prompt(task, report, {
                "stage": "build",
                "classification": "INTRODUCED_BUILD_FAILURE",
                "summary": "build 未通过",
                "issues": [],
                "changedProductionFiles": ["demo/src/main/ets/First.ets"],
            }, 1)

            # Use the profile as a starting point, not a substitute for source evidence.
            self.assertIn("优先采用静态画像给出的“建议形态”", refactor_prompt)
            self.assertNotIn("不要机械套用同一种手法", refactor_prompt)
            for prompt in (refactor_prompt, repair_prompt):
                self.assertIn("探索范围：优先读取已知文件（src/main/ets/First.ets、src/main/ets/Second.ets）", prompt)
                self.assertIn("信息足够后立即编辑", prompt)
                self.assertNotIn("合计不超过 6 次", prompt)
                self.assertIn("读取直接相关生产文件", prompt)
                self.assertIn("`arkts_check`", prompt)
                self.assertIn("两者每轮合计最多 2 次", prompt)
                self.assertIn("第一次通过即停止内部验证", prompt)
                self.assertIn("任一次验证若失败于 SDK", prompt)
                self.assertNotIn("{exploration_scope}", prompt)
                self.assertIn("@Require", prompt)
                self.assertIn("export *", prompt)
                # No time or execution budget may be added: a budget previously made the agent fail outright.
                for forbidden in ("分钟", "时间预算", "超时后", "wall-clock", "wall clock"):
                    self.assertNotIn(forbidden, prompt)
            # A3: edit every instance before running any verification.
            self.assertIn("先完成全部实例的编辑，再执行验证", refactor_prompt)
            self.assertIn("先完成本轮修复涉及的全部编辑，再执行验证", repair_prompt)
            self.assertIn("画像是词法线索", refactor_prompt)
            self.assertIn("实例未解析或与当前源码不符时先定向补齐", refactor_prompt)

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

    def test_entry_hints_cover_whole_production_file_and_ignore_non_code(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "demo/src/main/ets/First.ets"
            first.parent.mkdir(parents=True)
            source = "\n".join([
                "export class FirstVM {",
                "  modify(): void {",
                "    // export class CommentOnly {}",
                "    const note = 'export class StringOnly {}';",
                "    /* static get fakeInstance(): FirstVM {} */",
                "    console.info(note);",
                "  }",
                "",
                "  static get instance(): FirstVM { return new FirstVM(); }",
                "}",
                "export { FirstVM as OriginalVM };",
                "export default FirstVM;",
            ])
            first.write_text(source, encoding="utf-8")
            analysis = analyze_code_clone(self._task(root), source)
            hints = analysis["instances"][0]["entryPointHints"]
            self.assertEqual([1, 9, 11, 12], [hint["line"] for hint in hints])
            self.assertIn("static get instance", hints[1]["declaration"])
            # Missing counterparts must not acquire invented entry evidence or lose the compatibility policy.
            self.assertFalse(analysis["instances"][1]["resolved"])
            self.assertEqual([], analysis["instances"][1]["entryPointHints"])
            self.assertEqual("CONFIRM_COUNTERPART_BEFORE_EXTRACTION", analysis["recommendedPattern"])
            self.assertTrue(analysis["refactoringPolicy"]["constraints"])

    def test_entry_policy_survives_repair_and_review_after_original_exports_are_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "demo/src/main/ets/First.ets"
            second = first.with_name("Second.ets")
            first.parent.mkdir(parents=True)
            for path, name in ((first, "FirstVM"), (second, "SecondVM")):
                path.write_text(
                    f"export class {name} {{\n"
                    f"  static get instance(): {name} {{ return new {name}(); }}\n"
                    "  modify(): void { console.info('save'); }\n}\n",
                    encoding="utf-8",
                )
            task = self._task(root)
            report = analyze_risks(task)
            self.assertIn("CLONE_ENTRYPOINT_CHANGE", {item["code"] for item in report["risks"]})
            self.assertIn("PRESERVE_CLONE_ENTRYPOINTS", {item["code"] for item in report["recommendedConstraints"]})
            policy = report["codeCloneAnalysis"]["refactoringPolicy"]
            self.assertIn("跨文件", policy["preferredApproach"])
            initial = build_refactor_prompt(task, report)
            # Model the previous failure: a refactor replaced both original classes with a shared export.
            for path in (first, second):
                path.write_text("export { SharedVM } from './SharedVM';\n", encoding="utf-8")
            prompts = [initial, build_review_prompt(task, _review_risk(report))]
            for stage in ("smell", "test"):
                prompts.append(build_repair_prompt(task, report, {
                    "stage": stage, "summary": "validation failed", "issues": [],
                }, 1))
            for prompt in prompts:
                self.assertIn("export class FirstVM", prompt)
                self.assertIn("export class SecondVM", prompt)
                self.assertIn("static get instance", prompt)
                self.assertNotIn("demo/src/main/ets/", prompt)
                self.assertIn(policy["preferredApproach"], prompt)
                for constraint in policy["constraints"]:
                    self.assertIn(constraint, prompt)
                for condition in report["codeCloneAnalysis"]["postConditions"]:
                    self.assertIn(condition, prompt)

    def test_same_file_ui_profile_uses_local_extraction_and_deduplicates_entry_hints(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "demo/src/main/ets/First.ets"
            first.parent.mkdir(parents=True)
            first.write_text(
                "@Entry\n@ComponentV2\nexport struct Page {\n"
                "  @Builder first() { Text('first').id('first') }\n"
                "  @Builder second() { Text('second').id('second') }\n"
                "  build() { Column() { this.first(); this.second(); } }\n}\n",
                encoding="utf-8",
            )
            task = self._task(root)
            task.target.related_targets[0]["filePath"] = task.target.file_path
            report = analyze_risks(task)
            policy = report["codeCloneAnalysis"]["refactoringPolicy"]
            self.assertIn("同文件", policy["preferredApproach"])
            self.assertIn("成员 @Builder", policy["preferredApproach"])
            prompt = build_refactor_prompt(task, report)
            self.assertEqual(1, prompt.count("- 原入口线索 src/main/ets/First.ets"))
            self.assertIn("1: @Entry", prompt)
            self.assertIn("CustomDialogController", prompt)
            # The policy belongs to Code Clone, not the common prompt for other smells.
            task.smell_type = "long-method"
            other_report = analyze_risks(task)
            self.assertNotIn("codeCloneAnalysis", other_report)
            self.assertNotIn("入口与抽取约束", build_refactor_prompt(task, other_report))


if __name__ == "__main__":
    unittest.main()
