from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ADAPTER_PATH = Path(__file__).parents[1] / "src/main/resources/bridge/ide_bridge.py"
spec = importlib.util.spec_from_file_location("ide_bridge", ADAPTER_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / "Example"
        self.root.mkdir()
        self.source = self.root / "entry/src/main/ets/Page.ets"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("class Page { update() { return 1; } }\n", encoding="utf-8")

    def tearDown(self):
        self.directory.cleanup()

    def record(self, **message):
        return {"filePath": "Example/entry/src/main/ets/Page.ets", "messages": [{
            "rule": "@extrulesproject/long-method-check", "line": 1,
            "message": "Method 'update' is too long", **message}]}

    def test_single_object_and_multiple_messages_have_distinct_ids(self):
        record = self.record()
        record["messages"].append(dict(record["messages"][0]))
        issues = bridge.normalize_issues(record, self.root)
        self.assertEqual(2, len(issues))
        self.assertNotEqual(issues[0]["issueId"], issues[1]["issueId"])
        self.assertEqual(str(self.source), issues[0]["absolutePath"])
        self.assertEqual("update", issues[0]["symbol"])

    def test_clone_with_no_symbol_keeps_related_target(self):
        other = self.source.parent / "Other.ets"
        other.write_text("class Other {}", encoding="utf-8")
        issue = bridge.normalize_issues(self.record(rule="@extrulesproject/code-clone-fragment-check",
                message="Code Clone: Page.ets:1-2 is similar to Example/entry/src/main/ets/Other.ets:1-2."), self.root)[0]
        self.assertIsNone(issue["symbol"])
        self.assertEqual(str(other), issue["relatedTargets"][0]["filePath"])

    def test_path_traversal_is_rejected(self):
        record = self.record()
        record["filePath"] = "../Example/entry/src/main/ets/Page.ets"
        with self.assertRaises(bridge.BridgeError) as failure:
            bridge.normalize_issues(record, self.root)
        self.assertEqual("PATH_OUTSIDE_ROOT", failure.exception.code)

    def test_unknown_rule_is_read_only(self):
        issue = bridge.normalize_issues(self.record(rule="formal/god-class"), self.root)[0]
        self.assertFalse(issue["supported"])

    def test_invalid_and_empty_reports_are_distinct(self):
        self.assertEqual([], bridge.normalize_issues([], self.root))
        with self.assertRaises(bridge.BridgeError):
            bridge.normalize_issues({"filePath": "Page.ets"}, self.root)

    def test_run_directory_inside_source_is_rejected(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.create_run({"runs": str(self.root / "runs")}, self.root, "scan.start")

    def test_jsonl_worker_returns_correlated_response(self):
        request = {"protocolVersion": 1, "requestId": "test-request", "method": "issues.import",
                   "projectRoot": str(self.root), "config": {}, "params": {"records": self.record()}}
        process = subprocess.run([sys.executable, str(ADAPTER_PATH)], input=json.dumps(request),
                                 capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(0, process.returncode, process.stderr)
        response = json.loads(process.stdout)
        self.assertEqual("test-request", response["requestId"])
        self.assertTrue(response["ok"])
        self.assertEqual(1, len(response["result"]["issues"]))

    def test_protocol_mismatch_is_a_structured_error(self):
        process = subprocess.run([sys.executable, str(ADAPTER_PATH)], input='{"protocolVersion": 2}',
                                 capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(2, process.returncode)
        self.assertEqual("UNSUPPORTED_PROTOCOL", json.loads(process.stdout)["error"]["code"])


if __name__ == "__main__":
    unittest.main()
