from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ADAPTER_PATH = Path(__file__).parents[1] / "src/main/resources/bridge/ide_bridge.py"
spec = importlib.util.spec_from_file_location("ide_bridge", ADAPTER_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.event_patch = patch.object(bridge, "emit")
        self.event_patch.start()
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / "Example"
        self.root.mkdir()
        self.source = self.root / "entry/src/main/ets/Page.ets"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("class Page { update() { return 1; } }\n", encoding="utf-8")

    def tearDown(self):
        self.directory.cleanup()
        self.event_patch.stop()

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

    def test_utf8_wire_survives_windows_gbk_environment_and_chinese_paths(self):
        source = self.source.parent / "我的余额.ets"
        source.write_text("class Balance {}", encoding="utf-8")
        record = self.record(message="方法过长，请拆分")
        record["filePath"] = source.relative_to(self.root).as_posix()
        request = {"protocolVersion": 1, "requestId": "utf8-request", "method": "issues.import",
                   "projectRoot": str(self.root), "config": {"homecheck": "C:/项目/arkts异味检查工具"},
                   "params": {"records": record}}
        # Gson sends literal Chinese as UTF-8. ASCII-escaped json.dumps had hidden this failure.
        process = subprocess.run([sys.executable, str(ADAPTER_PATH)],
                                 input=json.dumps(request, ensure_ascii=False).encode("utf-8"), capture_output=True,
                                 env=dict(os.environ, PYTHONIOENCODING="gbk", PYTHONUTF8="0"))
        self.assertEqual(0, process.returncode, process.stderr.decode("utf-8"))
        response = json.loads(process.stdout.decode("utf-8"))
        self.assertEqual("utf8-request", response["requestId"])
        self.assertTrue(response["ok"])
        self.assertEqual(str(source), response["result"]["issues"][0]["absolutePath"])
        self.assertIn("方法过长，请拆分", process.stdout.decode("utf-8"))

    def backend_config(self):
        # Resolve relative to the repository rather than the installed plugin resource.
        backend = Path(__file__).resolve().parents[3] / "arkts-smell-refactor"
        if not (backend / "src/arkts_smell_refactor").is_dir():
            self.skipTest("configured development backend not found")
        tools = Path(self.directory.name) / "tools"
        (tools / "homecheck/node_modules/homecheck/lib").mkdir(parents=True)
        (tools / "homecheck/node_modules/homecheck/lib/run.js").write_text("", encoding="utf-8")
        (tools / "homecheck/extrulesproject-1.0.0.tgz").write_bytes(b"fixture")
        (tools / "homecheck/config").mkdir()
        bridge.write_json(tools / "homecheck/config/projectConfig.json", {})
        bridge.write_json(tools / "homecheck/config/ruleConfig.json", {})
        (tools / "studio/sdk/default/openharmony/ets").mkdir(parents=True)
        (self.root / "hvigor").mkdir(exist_ok=True)
        (self.root / "hvigor/hvigor-config.json5").write_text("{}", encoding="utf-8")
        (self.root / "build-profile.json5").write_text('{"modules":[{"name":"entry","srcPath":"./entry"}]}', encoding="utf-8")
        config = {"backend": str(backend), "homecheck": str(tools / "homecheck"), "studio": str(tools / "studio"),
                  "runs": str(Path(self.directory.name) / "runs"), "node": sys.executable, "deveco": sys.executable,
                  "hvigor": sys.executable, "ohpm": sys.executable, "linter": sys.executable, "linterMode": "required"}
        bridge.configure_environment(config)
        return config

    def prepare(self, config):
        issue = bridge.normalize_issues(self.record(), self.root)[0]
        run = bridge.create_run(config, self.root, "task.prepare")
        prepared = bridge.prepare_candidate({"issue": issue, "instructions": "keep public entry"}, config, self.root, run)
        return prepared

    def test_candidate_pipeline_uses_snapshot_and_retains_frozen_changes(self):
        config = self.backend_config()
        original = self.source.read_bytes()
        prepared = self.prepare(config)
        def fake_pipeline(task_dir, plan, **kwargs):
            task = bridge.read_json(task_dir / "task.json")
            stage = Path(task["project_root"])
            self.assertNotEqual(self.root, stage)
            self.assertTrue(stage.is_relative_to(Path(config["runs"])))
            target = stage / self.source.relative_to(self.root)
            target.write_text("class Page { update() { return this.value(); } value() { return 1; } }\n", encoding="utf-8")
            return {"verdict": "PASS", "steps": [], "repairAttempts": 0}
        run = bridge.create_run(config, self.root, "task.execute")
        with patch("arkts_smell_refactor.runner.execute_pipeline", side_effect=fake_pipeline):
            response = bridge.execute_candidate({"taskHandle": prepared["taskHandle"]}, config, self.root, run)
        self.assertEqual(original, self.source.read_bytes())
        candidate = response["candidate"]
        self.assertEqual("PASS", candidate["verdict"])
        self.assertEqual(1, len(candidate["changes"]))
        path = run / "content/after" / candidate["changes"][0]["relativePath"]
        self.assertEqual(candidate["changes"][0]["afterSha256"], bridge.hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(original, (run / "content/before" / candidate["changes"][0]["relativePath"]).read_bytes())

    def test_changed_configuration_prevents_agent_execution(self):
        config = self.backend_config(); prepared = self.prepare(config)
        (self.root / "build-profile.json5").write_text("user configuration update", encoding="utf-8")
        run = bridge.create_run(config, self.root, "task.execute")
        with patch("arkts_smell_refactor.runner.execute_pipeline") as pipeline:
            with self.assertRaises(bridge.BridgeError) as error:
                bridge.execute_candidate({"taskHandle": prepared["taskHandle"]}, config, self.root, run)
        self.assertEqual("BASELINE_CHANGED", error.exception.code)
        pipeline.assert_not_called()

    def test_candidate_rejects_deleted_production_file(self):
        config = self.backend_config(); prepared = self.prepare(config)
        def fake_pipeline(task_dir, plan, **kwargs):
            task = bridge.read_json(task_dir / "task.json")
            (Path(task["project_root"]) / self.source.relative_to(self.root)).unlink()
            return {"verdict": "PASS", "steps": []}
        run = bridge.create_run(config, self.root, "task.execute")
        with patch("arkts_smell_refactor.runner.execute_pipeline", side_effect=fake_pipeline):
            with self.assertRaises(bridge.BridgeError):
                bridge.execute_candidate({"taskHandle": prepared["taskHandle"]}, config, self.root, run)
        self.assertTrue(self.source.exists())

    def test_zero_exit_with_failed_detector_summary_is_not_zero_issues(self):
        config = self.backend_config()
        run = bridge.create_run(config, self.root, "scan.start")
        def failed_scan(command, cwd, log):
            bridge.write_json(run / "scan/summary.json", {"repositories": [{"sharedRun": {"success": False}}]})
            bridge.write_json(run / "scan/issuesReport.json", [])
            return 0
        with patch.object(bridge, "run_tool", side_effect=failed_scan):
            with self.assertRaises(bridge.BridgeError) as error:
                bridge.scan({"rules": ["@extrulesproject/long-method-check"]}, config, self.root, run)
        self.assertEqual("TOOL_UNAVAILABLE", error.exception.code)

    def scan_fixture(self, records):
        config = self.backend_config()
        run = bridge.create_run(config, self.root, "scan.start")
        other = self.source.parent / "Other.ets"
        other.write_text("class Other {}", encoding="utf-8")
        def successful_scan(command, cwd, log):
            self.assertEqual([self.source.relative_to(self.root).as_posix()],
                             bridge.read_json(run / "project.json")["checkFiles"])
            bridge.write_json(run / "scan/summary.json", {"repositories": [{"sharedRun": {"success": True},
                              "runs": [{"ruleName": rule, "success": True} for rule in bridge.RULES]}]})
            bridge.write_json(run / "scan/runs/Example/issuesReport.json", records)
            return 0
        with patch.object(bridge, "run_tool", side_effect=successful_scan):
            return bridge.scan({"scopePath": str(self.source)}, config, self.root, run)

    def test_selected_file_scan_reports_exact_scope_and_filters_other_files(self):
        other_record = self.record()
        other_record["filePath"] = "entry/src/main/ets/Other.ets"
        result = self.scan_fixture([self.record(), other_record])
        self.assertEqual(1, len(result["issues"]))
        self.assertEqual(str(self.source), result["scopePath"])
        self.assertEqual([str(self.source)], result["scannedFiles"])
        self.assertEqual(1, result["fileCount"])
        self.assertEqual(list(bridge.RULES), result["rules"])
        bridge.emit.assert_any_call("scan.started", {key: result[key] for key in ("scopePath", "scannedFiles", "fileCount", "rules")})

    def test_successful_scan_with_zero_findings_is_a_completed_scan(self):
        result = self.scan_fixture([])
        self.assertEqual([], result["issues"])
        self.assertEqual(1, result["fileCount"])
        self.assertEqual(str(self.source), result["scopePath"])

    def test_real_backend_orchestrates_controlled_tools_in_candidate_only(self):
        config = self.backend_config(); original = self.source.read_bytes(); prepared = self.prepare(config)
        script = Path(self.directory.name) / "fixture_tool.py"
        script.write_text("import sys,json\nfrom pathlib import Path\nphase=sys.argv[1]\n"
                          "if phase=='refactor':\n p=Path(sys.argv[2])/'entry/src/main/ets/Page.ets'\n p.write_text('class Page { update() { return 2; } }\\n',encoding='utf-8')\n"
                          "if phase=='review': print(json.dumps({'verdict':'PASS','issues':[]}))\n"
                          "else: print('controlled tool completed: '+phase)\n", encoding="utf-8")
        command = lambda phase: {"command": [sys.executable, str(script), phase, "{project_root}"], "timeoutSeconds": 10}
        plan = {"refactorAgent": command("refactor"), "gates": {key: command(key) for key in ("smell", "build", "test", "linter")},
                "reviewAgent": command("review"), "taskTimeoutSeconds": 60, "maxRepairAttempts": 0}
        run = bridge.create_run(config, self.root, "task.execute")
        with patch.object(bridge, "pipeline_config", return_value=plan):
            response = bridge.execute_candidate({"taskHandle": prepared["taskHandle"]}, config, self.root, run)
        self.assertEqual("PASS", response["result"]["verdict"])
        self.assertEqual({"refactor-agent", "smell", "build", "test", "linter", "review-agent"}, {step["name"] for step in response["result"]["steps"]})
        self.assertEqual(original, self.source.read_bytes())

    def test_changed_clone_partner_is_rejected_before_preparation(self):
        config = self.backend_config()
        other = self.source.parent / "Other.ets"; other.write_text("class Other {}", encoding="utf-8")
        issue = bridge.normalize_issues(self.record(rule="@extrulesproject/code-clone-fragment-check",
                message="Code Clone: Page.ets:1-2 is similar to Example/entry/src/main/ets/Other.ets:1-2."), self.root)[0]
        other.write_text("user changed the clone partner", encoding="utf-8")
        run = bridge.create_run(config, self.root, "task.prepare")
        with self.assertRaises(bridge.BridgeError) as error:
            bridge.prepare_candidate({"issue": issue}, config, self.root, run)
        self.assertEqual("BASELINE_CHANGED", error.exception.code)

    def test_imported_test_source_remains_read_only(self):
        test = self.root / "entry/src/test/Page.test.ets"; test.parent.mkdir(parents=True); test.write_text("test source", encoding="utf-8")
        record = self.record(); record["filePath"] = "entry/src/test/Page.test.ets"
        self.assertFalse(bridge.normalize_issues(record, self.root)[0]["supported"])

    def test_clone_partner_in_test_directory_is_read_only(self):
        test = self.root / "entry/src/test/Page.test.ets"; test.parent.mkdir(parents=True); test.write_text("test source", encoding="utf-8")
        record = self.record(rule="@extrulesproject/code-clone-fragment-check",
                message="Code Clone: Page.ets:1-2 is similar to Example/entry/src/test/Page.test.ets:1-2.")
        self.assertFalse(bridge.normalize_issues(record, self.root)[0]["supported"])

    def test_applied_validation_runs_only_gates_and_reuses_matching_review(self):
        config = self.backend_config(); prepared = self.prepare(config)
        def refactor(task_dir, plan, **kwargs):
            task = bridge.read_json(task_dir / "task.json")
            (Path(task["project_root"]) / self.source.relative_to(self.root)).write_text("class Page { update() { return 2; } }\n", encoding="utf-8")
            return {"verdict": "PASS", "steps": []}
        candidate_run = bridge.create_run(config, self.root, "task.execute")
        with patch("arkts_smell_refactor.runner.execute_pipeline", side_effect=refactor):
            candidate = bridge.execute_candidate({"taskHandle": prepared["taskHandle"]}, config, self.root, candidate_run)["candidate"]
        self.source.write_bytes((candidate_run / "content/after" / self.source.relative_to(self.root)).read_bytes())
        script = Path(self.directory.name) / "validation_tool.py"
        script.write_text("import sys\nassert sys.argv[1] != 'refactor'\nprint('controlled validation completed')\n", encoding="utf-8")
        plan = {"gates": {key: {"command": [sys.executable, str(script), key], "timeoutSeconds": 10} for key in ("smell", "build", "test", "linter")},
                "refactorAgent": {"command": [sys.executable, str(script), "refactor"]}}
        run = bridge.create_run(config, self.root, "task.validateApplied")
        with patch.object(bridge, "pipeline_config", return_value=plan), patch.object(bridge, "scan", return_value={"issues": []}):
            response = bridge.validate_applied({"candidateId": candidate["candidateId"]}, config, self.root, run)
        self.assertEqual("PASS", response["result"]["verdict"])
        self.assertEqual(str(candidate_run), response["result"]["reviewEvidenceFrom"])
        self.assertEqual([], response["issues"])


if __name__ == "__main__":
    unittest.main()
