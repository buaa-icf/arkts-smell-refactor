import unittest
from unittest.mock import patch

from arkts_smell_refactor.models import RefactorTask, SourceRange, Target
from arkts_smell_refactor.prompts import build_refactor_prompt, build_review_prompt
from arkts_smell_refactor.risk import analyze_risks
from arkts_smell_refactor.switch_analysis import analyze_switch_statement


def task(message: str, symbol: str = "format") -> RefactorTask:
    return RefactorTask(
        schema_version="1.0",
        task_id="switch-statement-0001-format",
        source_project="demo",
        commit_hash="",
        workspace_root=".",
        project_root=".",
        smell_type="switch-statement",
        rule="@extrulesproject/switch-statement-check",
        severity="SUGGESTION",
        message=message,
        target=Target("demo/Foo.ets", symbol, SourceRange(2, 2, 4)),
        raw={},
    )


class SwitchAnalysisTests(unittest.TestCase):
    def test_locates_symbol_when_detector_line_is_cfg_relative(self):
        source = """
export class Formatter {
  other(value: number): string {
    switch (value) { case 0: return 'unused'; default: return 'other'; }
  }

  public format(value: number): string {
    switch (value) {
      case 0: return 'zero';
      case 1: return 'one';
      case 2: return 'two';
      case 3: return 'three';
      case 4: return 'four';
      default: return 'unknown';
    }
  }
}
"""
        message = (
            "Switch statement with 6 cases detected in method 'format'. Consider using strategy. "
            "Case line counts: 0 (1 line); 1 (1 line); 2 (1 line); 3 (1 line); "
            "4 (1 line); default (1 line)."
        )
        analysis = analyze_switch_statement(task(message), source)
        self.assertTrue(analysis["located"])
        self.assertEqual("value", analysis["discriminant"])
        self.assertEqual(6, analysis["branchCount"])
        self.assertEqual("value-map", analysis["recommendedPattern"])
        self.assertTrue(analysis["hasDefault"])
        self.assertGreater(analysis["startLine"], 2)

    def test_distinguishes_grouped_labels_from_executable_fallthrough(self):
        source = """
class Controller {
  format(value: number): void {
    switch (value) {
      case 1:
      case 2:
        this.mode = value;
        break;
      case 3:
        this.prepare();
      case 4:
        this.commit();
        break;
      default:
        break;
    }
  }
}
"""
        message = "Switch statement with 5 cases detected in method 'format'."
        analysis = analyze_switch_statement(task(message), source)
        self.assertEqual([["1", "2"]], analysis["groupedCaseLabels"])
        self.assertEqual(["3"], analysis["executableFallthrough"])
        self.assertEqual(["mode"], analysis["stateWrites"])
        self.assertEqual("extract-method-or-strategy", analysis["recommendedPattern"])

    def test_return_expression_and_braced_break_are_terminal(self):
        source = """
class Formatter {
  format(value: number): string {
    switch (value) {
      case 1:
        return this.currentValue;
      case 2: {
        this.track();
        break;
      }
      default:
        return this.fallback();
    }
    return 'done';
  }
}
"""
        analysis = analyze_switch_statement(
            task("Switch statement with 3 cases detected in method 'format'."), source
        )
        self.assertEqual([], analysis["executableFallthrough"])

    def test_locates_exported_arrow_function(self):
        source = """
export const format = (value: number): string => {
  switch (value) {
    case 1: return 'one';
    default: return 'other';
  }
}
"""
        analysis = analyze_switch_statement(
            task("Switch statement with 2 cases detected in method 'format'."), source
        )
        self.assertTrue(analysis["located"])
        self.assertEqual("target-symbol", analysis["evidenceSource"])
        self.assertEqual("value", analysis["discriminant"])

    def test_analyzes_long_if_else_chain_reported_by_same_rule(self):
        source = """
class Formatter {
  format(value: string): string {
    if (value === 'a') { return 'A'; }
    else if (value === 'b') { return 'B'; }
    else if (value === 'c') { return 'C'; }
    else { return 'unknown'; }
  }
}
"""
        message = "Long if-else chain with 3 branches detected in method 'format'."
        analysis = analyze_switch_statement(task(message), source)
        self.assertEqual("if-else-chain", analysis["conditionalType"])
        self.assertEqual("value", analysis["selector"])
        self.assertEqual("value-map", analysis["recommendedPattern"])
        self.assertTrue(analysis["hasFinalElse"])

    def test_aggregates_multiple_switches_counted_as_one_detector_finding(self):
        source = """
class Formatter {
  format(value: number, kind: number): string {
    if (kind === 1) {
      switch (value) {
        case 1: return 'one';
        case 2: return 'two';
        default: return 'other';
      }
    }
    switch (kind) {
      case 2: return 'kind-two';
      default: return 'kind-other';
    }
  }
}
"""
        message = (
            "Switch statement with 5 cases detected in method 'format'. Case line counts: "
            "1 (1 line); 2 (1 line); default (1 line); 2 (1 line); default (1 line)."
        )
        analysis = analyze_switch_statement(task(message), source)
        self.assertEqual(2, analysis["switchCount"])
        self.assertEqual(5, analysis["branchCount"])
        self.assertEqual(["value", "kind"], analysis["discriminants"])
        self.assertEqual("value-map", analysis["recommendedPattern"])

    def test_prompts_expose_switch_specific_evidence(self):
        analysis = {
            "conditionalType": "switch",
            "located": True,
            "evidenceSource": "target-symbol",
            "discriminant": "status",
            "branchCount": 6,
            "hasDefault": True,
            "caseLabels": ["READY", "default"],
            "groupedCaseLabels": [["READY", "ACTIVE"]],
            "executableFallthrough": [],
            "controlFlow": ["return"],
            "stateWrites": [],
            "hasAsyncWork": False,
            "recommendedPattern": "value-map",
            "recommendationReason": "各分支直接返回一个值",
        }
        risk = {"risks": [], "recommendedConstraints": [], "switchStatementAnalysis": analysis}
        refactor_prompt = build_refactor_prompt(task("Switch statement with 6 cases detected in method 'format'."), risk)
        review_prompt = build_review_prompt(task("Switch statement with 6 cases detected in method 'format'."), risk)
        self.assertIn("selector：status", refactor_prompt)
        self.assertIn("建议形态：value-map", refactor_prompt)
        self.assertIn("可执行 fall-through", review_prompt)
        self.assertIn("Map/Set 的键语义", review_prompt)

    def test_risk_report_adds_switch_specific_constraints(self):
        source = """
class Controller {
  format(value: number): void {
    switch (value) {
      case 1:
        this.prepare();
      case 2:
        this.mode = value;
        break;
      default:
        break;
    }
  }
}
"""
        with patch("arkts_smell_refactor.risk._read", return_value=source), patch(
            "arkts_smell_refactor.risk._find_callers", return_value=[]
        ):
            report = analyze_risks(task(
                "Switch statement with 2 cases detected in method 'format'. "
                "Case line counts: 1 (2 lines); 2 (2 lines); default (1 line)."
            ))
        risk_codes = {item["code"] for item in report["risks"]}
        constraint_codes = {item["code"] for item in report["recommendedConstraints"]}
        self.assertEqual("1.1", report["schemaVersion"])
        self.assertIn("switchStatementAnalysis", report)
        self.assertIn("EXECUTABLE_FALLTHROUGH", risk_codes)
        self.assertIn("BRANCH_STATE_WRITE", risk_codes)
        self.assertIn("DETECTOR_COUNT_MISMATCH", risk_codes)
        self.assertIn("PRESERVE_FALLTHROUGH_SEQUENCE", constraint_codes)
        self.assertIn("SAFE_TABLE_LOOKUP", constraint_codes)


if __name__ == "__main__":
    unittest.main()
