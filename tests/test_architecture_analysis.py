import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.analysis.cyclic_dependency import analyze_cyclic_dependency
from arkts_smell_refactor.analysis.god_class import analyze_god_class
from arkts_smell_refactor.models import RefactorTask, SourceRange, Target
from arkts_smell_refactor.risk import analyze_risks


def task(root: Path, smell_type: str) -> RefactorTask:
    if smell_type == "god-class":
        target, symbol, rule, context = "common/src/main/ets/Service.ets", "Service", "formal/god-class", {}
    else:
        target, symbol, rule = "common/src/main/ets/apis/Api.ets", None, "formal/directory-cycle"
        context = {"module": "common", "modulePath": "common", "baselineCycles": [["apis", "models", "apis"]]}
    return RefactorTask(
        schema_version="1.0", task_id="T", source_project="Demo", commit_hash="",
        workspace_root=str(root), project_root=str(root), smell_type=smell_type, rule=rule,
        severity="WARNING", message="smell", target=Target(target, symbol, SourceRange()),
        raw={"analysisContext": context},
    )


class ArchitectureAnalysisTests(unittest.TestCase):
    def test_god_class_profiles_state_and_context(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); path = root / "common/src/main/ets/Service.ets"
            path.parent.mkdir(parents=True); path.write_text(
                "export class Service {\n"
                "  public static items: string[] = []\n"
                "  constructor() { getContext().resourceManager; }\n"
                "  public getTotalCount(): number { return Service.items.length; }\n"
                "}\n", encoding="utf-8",
            )
            current = task(root, "god-class")
            analysis = analyze_god_class(current, path.read_text(), root)
            self.assertEqual(["items"], analysis["mutableStaticFields"])
            constructor = next(item for item in analysis["methods"] if item["name"] == "constructor")
            self.assertIn("runtime-context", constructor["riskSignals"])
            report = analyze_risks(current)
            self.assertIn("godClassAnalysis", report)

    def test_cycle_profiles_declared_edges(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); ets = root / "common/src/main/ets"
            api, model = ets / "apis/Api.ets", ets / "models/Model.ets"
            api.parent.mkdir(parents=True); model.parent.mkdir(parents=True)
            api.write_text("import { Model } from '../models/Model'", encoding="utf-8")
            model.write_text("import { Api } from '../apis/Api'", encoding="utf-8")
            analysis = analyze_cyclic_dependency(task(root, "cyclic-dependency"), root)
            self.assertEqual(2, len(analysis["cycleEdges"]))
            self.assertTrue(all(edge["evidence"] for edge in analysis["cycleEdges"]))


if __name__ == "__main__":
    unittest.main()
