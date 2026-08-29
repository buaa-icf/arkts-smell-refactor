import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.models import RefactorTask, SourceRange, Target
from arkts_smell_refactor.public_contract import compare_public_contract, prepare_public_contract, snapshot_public_contract


class PublicContractTests(unittest.TestCase):
    def test_detects_removed_export_and_public_member(self):
        before = {"exports": {
            "Service": {"contract": {"members": {
                "method:getValue": {"kind": "method", "static": False, "parameters": [], "returnType": "number"},
            }}},
            "Legacy": {"contract": None},
        }}
        current = {"exports": {"Service": {"contract": {"members": {}}}}}
        result = compare_public_contract(before, current)
        self.assertFalse(result["passed"])
        self.assertEqual(["Legacy"], result["removedExports"])
        self.assertEqual("removed", result["changedMembers"][0]["change"])

    def test_allows_additive_public_members(self):
        before = {"exports": {"Service": {"contract": {"members": {}}}}}
        current = {"exports": {"Service": {"contract": {"members": {
            "method:newMethod": {"kind": "method", "static": False, "parameters": [], "returnType": "void"},
        }}}}}
        self.assertTrue(compare_public_contract(before, current)["passed"])

    def test_snapshot_tracks_module_export_and_signature(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); module = root / "common"; source = module / "src/main/ets/Service.ets"
            source.parent.mkdir(parents=True); source.write_text(
                "export class Service {\n  public getValue(input: string): number { return 1 }\n}",
                encoding="utf-8",
            )
            (module / "Index.ets").write_text("export { Service } from './src/main/ets/Service'", encoding="utf-8")
            task = RefactorTask(
                schema_version="1.0", task_id="T", source_project="Demo", commit_hash="",
                workspace_root=str(root), project_root=str(root), smell_type="god-class", rule="formal/god-class",
                severity="WARNING", message="smell", target=Target("common/src/main/ets/Service.ets", "Service", SourceRange()), raw={},
            )
            task_dir = root / "task"; task_dir.mkdir()
            plan = prepare_public_contract(task, task_dir)
            snapshot = snapshot_public_contract(task, root, plan)
            signature = snapshot["exports"]["Service"]["contract"]["members"]["method:getValue"]
            self.assertEqual("number", signature["returnType"])
            self.assertEqual("string", signature["parameters"][0]["type"])


if __name__ == "__main__":
    unittest.main()
