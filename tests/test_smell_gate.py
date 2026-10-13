import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from arkts_smell_refactor.gate import smell_gate
from arkts_smell_refactor.utils import read_json, write_json


class SmellGateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.task_dir = root / "task"
        self.source = root / "app"
        self.target = self.source / "entry/src/main/ets/Page.ets"
        self.target.parent.mkdir(parents=True)
        self.target.write_text("class Page {\n  run() { return 1; }\n}\n", encoding="utf-8")
        self.homecheck = root / "homecheck"
        (self.homecheck / "scripts").mkdir(parents=True)
        (self.homecheck / "scripts/gitcodeArktsPerfTest.js").write_text("", encoding="utf-8")
        write_json(self.homecheck / "config/projectConfig.json", {})
        write_json(self.homecheck / "config/ruleConfig.json", {})
        self.rule = "@extrulesproject/long-method-check"
        write_json(self.task_dir / "task.json", {
            "project_root": str(self.source), "workspace_root": str(root), "source_project": "app",
            "rule": self.rule, "target": {"file_path": "app/entry/src/main/ets/Page.ets", "symbol": "run"},
        })

    def execute(self, callback):
        stderr = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(io.StringIO()), patch(
            "arkts_smell_refactor.gate.shutil.which", return_value="npm"
        ), patch("arkts_smell_refactor.gate.subprocess.run", side_effect=callback):
            code = smell_gate(self.task_dir, self.homecheck, self.source)
        return code, stderr.getvalue()

    def report(self, command, data):
        directory = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--outputDir=")))
        path = directory / "runs/app/issuesReport.json"
        write_json(path, data)
        return path

    def test_scan_gets_private_temp_without_mutating_parent_environment(self):
        before = {name: os.environ.get(name) for name in ("TEMP", "TMP", "TMPDIR")}
        def scan(command, **kwargs):
            for name in before:
                scratch = Path(kwargs["env"][name])
                self.assertTrue(scratch.is_dir())
                self.assertTrue(scratch.is_relative_to(self.task_dir))
            self.report(command, [])
            return subprocess.CompletedProcess(command, 0)
        self.assertEqual((0, ""), self.execute(scan))
        self.assertEqual(before, {name: os.environ.get(name) for name in before})
        self.assertEqual([], read_json(self.task_dir / "smell-after.json"))

    def test_cloc_permission_error_blocks_and_discards_previous_findings(self):
        write_json(self.task_dir / "smell-after.json", [{"message": "stale finding"}])
        code, output = self.execute(lambda command, **kwargs: subprocess.CompletedProcess(command, 13))
        self.assertEqual(3, code)
        self.assertIn("SMELL_GATE_BLOCKED", output)
        self.assertIn("13", output)
        self.assertFalse((self.task_dir / "smell-after.json").exists())

    def test_missing_fresh_report_cannot_reuse_previous_clean_report(self):
        write_json(self.task_dir / "homecheck-report/runs/app/issuesReport.json", [])
        write_json(self.task_dir / "smell-after.json", [])
        code, output = self.execute(lambda command, **kwargs: subprocess.CompletedProcess(command, 0))
        self.assertEqual(3, code)
        self.assertIn("SMELL_GATE_BLOCKED", output)
        self.assertFalse((self.task_dir / "smell-after.json").exists())

    def test_real_remaining_smell_still_fails_with_repair_evidence(self):
        message = {"rule": self.rule, "message": "Method 'run' is too long", "line": 2}
        def scan(command, **kwargs):
            self.report(command, [{"filePath": str(self.target), "messages": [message]}])
            return subprocess.CompletedProcess(command, 0)
        code, output = self.execute(scan)
        self.assertEqual(1, code)
        self.assertNotIn("SMELL_GATE_BLOCKED", output)
        self.assertEqual(message["message"], read_json(self.task_dir / "smell-after.json")[0]["message"])

    def test_malformed_or_wrong_shape_report_blocks(self):
        for data in ({"error": "scan failed"}, [None], [{"filePath": "Page.ets", "messages": ["bad"]}], "not-json"):
            with self.subTest(data=data):
                def scan(command, **kwargs):
                    file = self.report(command, data)
                    if data == "not-json":
                        file.write_text("not-json", encoding="utf-8")
                    return subprocess.CompletedProcess(command, 0)
                code, output = self.execute(scan)
                self.assertEqual(3, code)
                self.assertIn("SMELL_GATE_BLOCKED", output)

    def test_unavailable_tool_is_blocked(self):
        def scan(command, **kwargs):
            raise PermissionError("Access denied")
        code, output = self.execute(scan)
        self.assertEqual(3, code)
        self.assertIn("SMELL_GATE_BLOCKED", output)


if __name__ == "__main__":
    unittest.main()
