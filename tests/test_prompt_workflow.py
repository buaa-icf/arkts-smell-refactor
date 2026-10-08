import unittest
from pathlib import Path

from arkts_smell_refactor.models import RefactorTask, SourceRange, Target
from arkts_smell_refactor.prompts import build_refactor_prompt, build_repair_prompt


def task(smell_type="code-clone"):
    root = Path.cwd() / "prompt-fixture"
    return RefactorTask(
        schema_version="1.0", task_id="T", source_project="demo", commit_hash="",
        workspace_root=str(root), project_root=str(root / "demo"),
        smell_type=smell_type, rule="test-rule", severity="WARNING", message="smell",
        target=Target("demo/src/First.ets", "build", SourceRange(10, 100)), raw={},
    )


def exploration_line(prompt):
    return next(line for line in prompt.splitlines() if line.startswith("- 探索范围："))


class PromptWorkflowTests(unittest.TestCase):
    def test_repair_prioritizes_new_helper_and_failure_files_without_log_tail(self):
        current = task()
        risk = {"codeCloneAnalysis": {
            "modificationBoundary": {"requiredFiles": ["demo/src/First.ets"]},
        }}
        failure = {
            "stage": "linter",
            "issues": [{"filePath": "demo/src/Helper.ets", "line": 17}],
            "changedProductionFiles": [
                "demo/src/Helper.ets", "src/Helper.ets", "demo/Index.ets",
            ],
        }
        scope = exploration_line(build_repair_prompt(current, risk, failure, 1))
        self.assertIn("（src/Helper.ets、Index.ets、src/First.ets）", scope)
        self.assertNotIn("demo/", scope)
        self.assertIn("原画像行号可能已漂移", scope)

    def test_missing_profile_still_includes_detector_counterpart(self):
        current = task()
        current.target.related_targets = [{"filePath": "demo/src/Second.ets"}]
        prompt = build_refactor_prompt(current, {})
        self.assertIn("（src/First.ets、src/Second.ets）", exploration_line(prompt))
        self.assertIn("画像缺失、未解析或建议不适用时", prompt)
        self.assertIn("定向查找并读取直接相关生产文件", prompt)

    def test_architecture_profiles_keep_related_production_context(self):
        profiles = {
            "cyclic-dependency": {"cyclicDependencyAnalysis": {
                "publicEntryFiles": ["demo/Index.ets"],
                "cycleEdges": [{"from": "apis", "to": "models", "evidence": [
                    {"filePath": "demo/src/Model.ets", "line": 1},
                ]}],
            }},
            "god-class": {"godClassAnalysis": {
                "externalCallers": [{"filePath": "demo/src/Caller.ets", "line": 2}],
            }},
            "feature-envy": {"featureEnvyAnalysis": {
                "executionContext": {"focusFiles": ["demo/src/Model.ets"]},
            }},
        }
        for smell_type, risk in profiles.items():
            with self.subTest(smell_type=smell_type):
                scope = exploration_line(build_refactor_prompt(task(smell_type), risk))
                expected = "src/Caller.ets" if smell_type == "god-class" else "src/Model.ets"
                self.assertIn(expected, scope)
                if smell_type == "cyclic-dependency":
                    self.assertIn("Index.ets", scope)
                self.assertNotIn("只读静态画像列出的文件", scope)

    def test_long_method_preserves_key_semantics_in_refactor_and_linter_repair(self):
        current = task("long-method")
        initial = build_refactor_prompt(current, {})
        repair = build_repair_prompt(current, {}, {
            "stage": "linter", "issues": [{"reason": "foreach-args-check"}],
        }, 1)
        self.assertIn("优先在原 class/struct 内按职责提取", initial)
        for prompt in (initial, repair):
            self.assertIn("包括原来未提供的情况", prompt)
            self.assertIn("擅自新增 index-only key", prompt)
            self.assertIn("已有私有方法的前导下划线", prompt)
            self.assertIn("不为提取先清理原有空白行", prompt)
            self.assertIn("不反复猜测空白行数量", prompt)
            self.assertIn("第一次通过即停止内部验证", prompt)
            self.assertIn("不得到原仓库、历史 runs 或快照中搜索或复制实现", prompt)

    def test_linter_skip_is_explicit_in_initial_prompt(self):
        self.assertIn("本轮 Linter 已明确跳过", build_refactor_prompt(task(), {}, linter_mode="skip"))
        self.assertNotIn("本轮 Linter 已明确跳过", build_refactor_prompt(task(), {}))


if __name__ == "__main__":
    unittest.main()
