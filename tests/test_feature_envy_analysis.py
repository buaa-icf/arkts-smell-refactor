import unittest

from arkts_smell_refactor.analysis.feature_envy import (
    analyze_feature_envy,
    feature_envy_risks_and_constraints,
)
from arkts_smell_refactor.models import RefactorTask, SourceRange, Target
from arkts_smell_refactor.prompts import build_refactor_prompt, build_review_prompt


def task(message: str, symbol: str = "buildTimeline") -> RefactorTask:
    return RefactorTask(
        schema_version="1.0",
        task_id="feature-envy-0001-buildTimeline",
        source_project="demo",
        commit_hash="",
        workspace_root=".",
        project_root=".",
        smell_type="feature-envy",
        rule="@extrulesproject/feature-envy-check",
        severity="SUGGESTION",
        message=message,
        target=Target("demo/TimelineVM.ets", symbol, SourceRange(1, 20, 1)),
        raw={},
    )


class FeatureEnvyAnalysisTests(unittest.TestCase):
    def test_profiles_envied_business_data_and_preserves_accumulation(self):
        source = """
export class TimelineVM {
  transactionInfo: ITransactionInfo | undefined
  timeLineList: Item[] = []

  public buildTimeline(): void {
    if (this.transactionInfo && this.transactionInfo.status) {
      this.transactionInfo.status.forEach((item) => {
        this.timeLineList.push({ value: item.status })
      })
    }
  }
}
"""
        current_task = task(
            "Method 'buildTimeline' is feature-envious toward "
            "'ITransactionInfo|undefined' (ATFD=5, LDA=0.20, CPFD=1)."
        )
        declaration = {"visibility": "public", "exported": True}
        analysis = analyze_feature_envy(
            current_task,
            source,
            declaration=declaration,
            production_callers=[{"filePath": "demo/Home.ets"}],
        )
        self.assertTrue(analysis["located"])
        self.assertEqual("this.transactionInfo", analysis["receiver"])
        self.assertEqual("COLLECTION_PROCESSING", analysis["classification"])
        self.assertEqual("EXTRACT_MAPPER_OR_BUILDER", analysis["recommendedPattern"])
        self.assertIn("数组 push 的累加语义和对象身份", analysis["mustPreserve"])
        self.assertEqual(5, analysis["metrics"]["ATFD"])

        risks, constraints = feature_envy_risks_and_constraints(
            current_task, analysis, declaration, [{"filePath": "demo/Home.ets"}]
        )
        self.assertIn("ENVIED_TARGET_MOVE_RISK", {item["code"] for item in risks})
        self.assertNotIn("KEEP_COMPATIBILITY_ENTRY", {item["code"] for item in constraints})

    def test_sdk_target_recommends_helper_instead_of_move_method(self):
        source = """
class Painter {
  private draw(path: CanvasPath): void {
    path.moveTo(0, 0)
    path.lineTo(10, 10)
    path.close()
  }
}
"""
        current_task = task(
            "Method 'draw' is feature-envious toward 'CanvasPath' (ATFD=3, LDA=0.00, CPFD=1).",
            "draw",
        )
        analysis = analyze_feature_envy(
            current_task,
            source,
            declaration={"visibility": "private", "exported": False},
            production_callers=[],
        )
        self.assertEqual("path", analysis["receiver"])
        self.assertEqual("sdk-object", analysis["ownershipKind"])
        self.assertEqual("unsafe", analysis["moveFeasibility"])
        self.assertEqual("INTRODUCE_ADAPTER_OR_HELPER", analysis["recommendedPattern"])

    def test_prompts_include_feature_envy_profile(self):
        current_task = task("Method 'buildTimeline' is feature-envious toward 'Info'.")
        risk = {
            "risks": [],
            "recommendedConstraints": [],
            "featureEnvyAnalysis": {
                "reportedTarget": "Info",
                "receiver": "this.info",
                "targetType": "Info",
                "ownershipKind": "business-data",
                "classification": "DATA_TRANSFORMATION",
                "readCount": 4,
                "writeCount": 0,
                "accessedMembers": [{"name": "status", "count": 4, "writes": 0}],
                "receiverCandidates": [{"receiver": "this.info", "accessCount": 4}],
                "moveFeasibility": "uncertain",
                "moveReasons": ["未接入类型图"],
                "recommendedPattern": "EXTRACT_MAPPER_OR_BUILDER",
                "recommendedDestination": "owning-model-or-dedicated-builder",
                "recommendationReason": "读取数据并构造结果",
                "extractionRegion": {"startLine": 5, "endLine": 12},
                "mustPreserve": ["条件不满足时不执行的边界"],
                "executionContext": {
                    "suggestedScope": "inter-class",
                    "focusFiles": ["demo/TimelineVM.ets", "demo/Info.ets"],
                    "modificationBoundary": {
                        "defaultFiles": ["demo/TimelineVM.ets", "demo/Info.ets"],
                        "allowNewProductionHelper": True,
                        "expansionRule": "仅在类型导出直接要求时扩大范围",
                    },
                    "buildTarget": "timeline",
                },
            },
        }
        refactor_prompt = build_refactor_prompt(current_task, risk)
        review_prompt = build_review_prompt(current_task, risk)
        self.assertIn("Feature Envy 静态画像", refactor_prompt)
        self.assertIn("EXTRACT_MAPPER_OR_BUILDER", refactor_prompt)
        self.assertIn("建议范围：inter-class", refactor_prompt)
        self.assertIn("默认修改边界：demo/TimelineVM.ets，demo/Info.ets", refactor_prompt)
        self.assertIn("建议构建模块：timeline", refactor_prompt)
        self.assertIn("重构完成后允许第一次 `build_project`", refactor_prompt)
        self.assertIn("本次修改导致的编译错误", refactor_prompt)
        self.assertIn("依恋是否只是被搬到新的方法或工具类", review_prompt)


if __name__ == "__main__":
    unittest.main()
