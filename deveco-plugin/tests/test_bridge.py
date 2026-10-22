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
        # The standalone Gradle plugin lives directly inside the Python backend repository.
        backend = Path(__file__).resolve().parents[2]
        self.assertTrue((backend / "src/arkts_smell_refactor/runner.py").is_file(),
                        "Bridge tests require the parent repository's backend sources")
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

    def prepare(self, config, scan_scope=None):
        issue = bridge.normalize_issues(self.record(), self.root)[0]
        run = bridge.create_run(config, self.root, "task.prepare")
        prepared = bridge.prepare_candidate({"issue": issue, "instructions": "keep public entry",
                    **({"scanScope": scan_scope} if scan_scope is not None else {})}, config, self.root, run)
        return prepared

    def test_environment_required_linter_must_actually_exist(self):
        config = self.backend_config()
        config["linter"] = str(Path(self.directory.name) / "missing-linter.exe")
        result = bridge.inspect_environment(config)
        self.assertTrue(result["canDetect"])
        self.assertFalse(result["canRefactor"])
        linter = next(row for row in result["tools"] if row["name"] == "codelinter")
        self.assertTrue(linter["required"])
        self.assertFalse(linter["available"])

    def test_environment_skip_policy_marks_linter_optional(self):
        config = self.backend_config()
        config["linter"] = str(Path(self.directory.name) / "missing-linter.exe")
        config["linterMode"] = "skip"
        result = bridge.inspect_environment(config)
        self.assertTrue(result["canRefactor"])
        self.assertFalse(next(row for row in result["tools"] if row["name"] == "codelinter")["required"])

    def test_environment_requires_homecheck_configuration_files(self):
        config = self.backend_config()
        (Path(config["homecheck"]) / "config/projectConfig.json").unlink()
        result = bridge.inspect_environment(config)
        self.assertFalse(result["canDetect"])
        self.assertFalse(result["canRefactor"])
        self.assertFalse(next(row for row in result["tools"] if row["name"] == "HomeCheck")["available"])

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
        self.assertEqual({"scopePath": str(self.source)}, candidate["scanScope"])
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
        def failed_scan(command, cwd, log, **kwargs):
            bridge.write_json(run / "scan/summary.json", {"runner": "direct-homecheck", "success": False})
            bridge.write_json(run / "scan/issuesReport.json", [])
            return 0
        with patch.object(bridge, "run_tool", side_effect=failed_scan):
            with self.assertRaises(bridge.BridgeError) as error:
                bridge.scan({"rules": ["@extrulesproject/long-method-check"]}, config, self.root, run)
        self.assertEqual("TOOL_UNAVAILABLE", error.exception.code)

    def scan_fixture(self, records, change_evidence=None):
        config = self.backend_config()
        run = bridge.create_run(config, self.root, "scan.start")
        other = self.source.parent / "Other.ets"
        other.write_text("class Other {}", encoding="utf-8")
        def successful_scan(command, cwd, log, **kwargs):
            self.assertEqual("homecheck_scan.cjs", Path(command[1]).name)
            self.assertNotIn("gitcodeArktsPerfTest.js", " ".join(command))
            self.assertEqual([self.source.relative_to(self.root).as_posix()],
                             bridge.read_json(run / "project.json")["checkFiles"])
            self.assertEqual(str(self.root) + os.sep, bridge.read_json(run / "project.json")["projectPath"])
            self.assertEqual({"checkPath": [{"filePath": str(self.source), "fixKey": []}]}, bridge.read_json(run / "check-paths.json"))
            bridge.write_json(run / "scan/summary.json", {"runner": "direct-homecheck", "success": True,
                              "requestedRules": list(bridge.RULES), "loadedRules": list(bridge.RULES)})
            bridge.write_json(run / "scan/issuesReport.json", records)
            (run / "scan/HomeCheck.log").write_text("[INFO] [HomeCheck] - [CheckEntry] File count: 1\n"
                                                   "[INFO] [HomeCheck] - [Main] Checking completed.\n", encoding="utf-8")
            if change_evidence:
                change_evidence(run)
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

    def test_swallowed_checker_exception_is_not_a_successful_empty_scan(self):
        def errors(run):
            with (run / "scan/HomeCheck.log").open("a", encoding="utf-8") as stream:
                stream.write("[ERROR] [HomeCheck] - [CheckEntry] Error running file check: fixture failure\n")
        with self.assertRaises(bridge.BridgeError) as failure:
            self.scan_fixture([], errors)
        self.assertIn("fixture failure", str(failure.exception))
        self.assertIn("HomeCheck.log", failure.exception.details["logPath"])
        self.assertIn("fixture failure", failure.exception.details["diagnostic"])

    def test_unloaded_selected_rule_cannot_pass_with_zero_findings(self):
        def missing_rule(run):
            summary = bridge.read_json(run / "scan/summary.json")
            summary["loadedRules"].pop()
            bridge.write_json(run / "scan/summary.json", summary)
        with self.assertRaisesRegex(bridge.BridgeError, "没有加载全部选中规则"):
            self.scan_fixture([], missing_rule)

    def test_partial_file_filter_cannot_pass_as_a_complete_scan(self):
        def filtered(run):
            (run / "scan/HomeCheck.log").write_text("[INFO] [HomeCheck] - [CheckEntry] File count: 0\n"
                                                   "[INFO] [HomeCheck] - [Main] Checking completed.\n", encoding="utf-8")
        with self.assertRaisesRegex(bridge.BridgeError, "实际文件数与请求不一致"):
            self.scan_fixture([], filtered)

    def test_missing_completion_marker_is_not_a_successful_scan(self):
        def unfinished(run):
            (run / "scan/HomeCheck.log").write_text("[INFO] [HomeCheck] - [CheckEntry] File count: 1\n", encoding="utf-8")
        with self.assertRaisesRegex(bridge.BridgeError, "未完成检测"):
            self.scan_fixture([], unfinished)

    def test_ignore_patterns_are_scoped_to_source_even_under_build_parent(self):
        root = self.root / "build/Project"
        absolute = (self.root / "excluded/**").as_posix()
        config = {"ignore": ["**/build/**/*", absolute], "overrides": [{"excluded": ["**/test/**/*"]}]}
        scoped = bridge.scope_rule_ignores(config, root)
        self.assertEqual(root.as_posix() + "/**/build/**/*", scoped["ignore"][0])
        self.assertEqual(absolute, scoped["ignore"][1])
        self.assertEqual(root.as_posix() + "/**/test/**/*", scoped["overrides"][0]["excluded"][0])
        self.assertEqual("**/build/**/*", config["ignore"][0])

    def test_direct_runner_checks_success_and_registration_without_benchmark_tools(self):
        node = Path("D:/tool/NodeJs/node.exe")
        if not node.is_file():
            self.skipTest("development Node not installed")
        config = self.backend_config()
        homecheck = Path(config["homecheck"])
        lib = homecheck / "node_modules/homecheck/lib"
        registry = lib / "utils/common/CheckerIndex.js"
        registry.parent.mkdir(parents=True)
        registry.write_text("exports.file2CheckRuleMap=new Map([['@extrulesproject/long-method-check',{}]]);"
                            "exports.project2CheckRuleMap=new Map();", encoding="utf-8")
        main = lib / "Main.js"
        main.write_text("exports.main=async()=>true;", encoding="utf-8")
        rules = homecheck / "rules.json"
        bridge.write_json(rules, {"extRuleSet": [{"extRules": {"@extrulesproject/long-method-check": 2}}]})
        summary = homecheck / "summary.json"
        command = [str(node), str(ADAPTER_PATH.with_name("homecheck_scan.cjs").resolve()),
                   str(homecheck), str(homecheck / "project.json"), str(rules), str(summary)]
        result = subprocess.run(command, cwd=homecheck, capture_output=True)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(bridge.read_json(summary)["success"])
        registry.write_text("exports.file2CheckRuleMap=new Map();exports.project2CheckRuleMap=new Map();", encoding="utf-8")
        result = subprocess.run(command, cwd=homecheck, capture_output=True)
        self.assertNotEqual(0, result.returncode)
        self.assertFalse(bridge.read_json(summary)["success"])
        self.assertIn("did not load selected rules", bridge.read_json(summary)["error"])
        main.write_text("exports.main=async()=>false;", encoding="utf-8")
        result = subprocess.run(command, cwd=homecheck, capture_output=True)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("did not complete successfully", bridge.read_json(summary)["error"])

    def test_tool_streams_stdout_and_detector_file_log(self):
        log = Path(self.directory.name) / "HomeCheck.log"
        script = Path(self.directory.name) / "log_fixture.py"
        script.write_text("from pathlib import Path\nimport sys\nprint('stdout event',flush=True)\n"
                          "Path(sys.argv[1]).write_text('检测日志：正在分析\\n',encoding='utf-8')\n", encoding="utf-8")
        exit_code = bridge.run_tool([sys.executable, "-X", "utf8", str(script), str(log)],
                                    self.root, Path(self.directory.name) / "scan.log", follow_log=log)
        self.assertEqual(0, exit_code)
        events = "".join(call.args[1]["text"] for call in bridge.emit.call_args_list if call.args[0] == "log.appended")
        self.assertIn("stdout event", events)
        self.assertIn("检测日志：正在分析", events)

    def agent_gate_fixture(self):
        config = self.backend_config()
        prepared = self.prepare(config)
        task_dir = Path(prepared["runDirectory"]) / "backend"
        stage = Path(bridge.read_json(task_dir / "task.json")["project_root"])
        return task_dir, stage, self.source.relative_to(self.root)

    def test_refactor_and_repair_attachments_stay_inside_agent_workspace(self):
        task_dir, stage, relative = self.agent_gate_fixture()
        original = self.source.read_bytes()
        test_file = stage / "entry/src/test/Hidden.test.ets"
        test_file.parent.mkdir(parents=True)
        test_file.write_text("private test", encoding="utf-8")
        repair = task_dir / "repair-prompt-1.md"
        repair.write_text("修复上一轮的生产代码", encoding="utf-8")
        for prompt_file in (None, repair):
            with self.subTest(repair=prompt_file is not None):
                def fake_cli(command, cwd):
                    workspace = Path(command[command.index("--dir") + 1]).resolve()
                    attachment = Path(command[command.index("-f") + 1]).resolve()
                    self.assertEqual(workspace, Path(cwd).resolve())
                    self.assertTrue(attachment.is_relative_to(workspace))
                    self.assertTrue(attachment.is_file())
                    self.assertFalse((workspace / test_file.relative_to(stage)).exists())
                    if prompt_file:
                        self.assertIn("修复上一轮", attachment.read_text(encoding="utf-8"))
                    (workspace / relative).write_text("class Page { update() { return 2; } }\n", encoding="utf-8")
                    return subprocess.CompletedProcess(command, 0)
                with patch.object(bridge.subprocess, "run", side_effect=fake_cli):
                    code = bridge.refactor_agent_gate(task_dir, stage, Path(sys.executable), prompt_file)
                # A repair must make a new change rather than reusing the first result.
                if prompt_file is None:
                    self.assertEqual(0, code)
                    (stage / relative).write_text("class Page { update() { return 1; } }\n", encoding="utf-8")
                else:
                    self.assertEqual(0, code)
                self.assertEqual(original, self.source.read_bytes())
                self.assertEqual([], list(task_dir.glob("refactor-workspace*/.arkts-refactor-*.md")))
        self.assertTrue((task_dir / "refactor-agent-prompt.md").is_file())

    def test_failed_or_unstartable_agent_cleans_attachment_without_syncing(self):
        task_dir, stage, relative = self.agent_gate_fixture()
        for raises in (False, True):
            with self.subTest(raises=raises):
                before = (stage / relative).read_bytes()
                def fake_cli(command, cwd):
                    (Path(cwd) / relative).write_text("unsuccessful agent edit", encoding="utf-8")
                    if raises:
                        raise OSError("fixture CLI launch failure")
                    return subprocess.CompletedProcess(command, 7)
                with patch.object(bridge.subprocess, "run", side_effect=fake_cli):
                    if raises:
                        with self.assertRaises(OSError):
                            bridge.refactor_agent_gate(task_dir, stage, Path(sys.executable))
                    else:
                        self.assertEqual(7, bridge.refactor_agent_gate(task_dir, stage, Path(sys.executable)))
                self.assertEqual(before, (stage / relative).read_bytes())
                self.assertEqual([], list(task_dir.glob("refactor-workspace*/.arkts-refactor-*.md")))

    def test_agent_production_deletion_remains_rejected(self):
        task_dir, stage, relative = self.agent_gate_fixture()
        before = (stage / relative).read_bytes()
        def fake_cli(command, cwd):
            (Path(cwd) / relative).unlink()
            return subprocess.CompletedProcess(command, 0)
        with patch.object(bridge.subprocess, "run", side_effect=fake_cli):
            self.assertEqual(4, bridge.refactor_agent_gate(task_dir, stage, Path(sys.executable)))
        self.assertEqual(before, (stage / relative).read_bytes())

    def test_failed_agent_has_readable_reason_and_controlled_log_path(self):
        task_dir = Path(self.directory.name) / "backend"
        task_dir.mkdir()
        log = task_dir / "refactor-agent.log"
        log.write_text("error: File attachment path is outside the allowed roots: C:/run/backend/prompt.md\n", encoding="utf-8")
        result = {"steps": [{"name": "refactor-agent", "status": "FAIL", "reason": None,
                             "exit_code": 1, "output_file": str(log)}]}
        bridge.summarize_failure(task_dir, result)
        self.assertIn("提示词附件", result["failureReason"])
        self.assertEqual(str(log), result["steps"][0]["logPath"])
        result["verdict"] = "PASS"
        result.pop("failureReason")
        bridge.summarize_failure(task_dir, result)
        self.assertNotIn("failureReason", result)
        result = {"steps": [{"name": "refactor-agent", "status": "FAIL", "output_file": str(self.source)}]}
        bridge.summarize_failure(task_dir, result)
        self.assertNotIn("logPath", result["steps"][0])

    def test_smell_gate_validates_candidate_without_applying_to_original(self):
        task_dir, stage, relative = self.agent_gate_fixture()
        original = self.source.read_bytes()
        response = {"issues": [], "reportPath": "controlled-report", "scannedFiles": [str(stage / relative)]}
        with patch.object(bridge, "scan", return_value=response) as detector:
            self.assertEqual(0, bridge.smell_candidate_gate(task_dir, stage, {}))
        self.assertEqual(stage, detector.call_args.args[2])
        self.assertEqual([str(stage / relative)], detector.call_args.args[0]["files"])
        self.assertEqual(original, self.source.read_bytes())
        self.assertEqual([], bridge.read_json(task_dir / "smell-after.json"))

    def test_remaining_smell_fails_and_tool_failure_blocks_without_stale_findings(self):
        task_dir, stage, relative = self.agent_gate_fixture()
        issue = bridge.normalize_issues(self.record(), stage)[0]
        response = {"issues": [issue], "reportPath": "controlled-report", "scannedFiles": [str(stage / relative)]}
        with patch.object(bridge, "scan", return_value=response):
            self.assertEqual(1, bridge.smell_candidate_gate(task_dir, stage, {}))
        self.assertEqual(1, len(bridge.read_json(task_dir / "smell-after.json")))
        with patch.object(bridge, "scan", side_effect=bridge.BridgeError("TOOL_UNAVAILABLE", "fixture detector unavailable")):
            self.assertEqual(3, bridge.smell_candidate_gate(task_dir, stage, {}))
        self.assertFalse((task_dir / "smell-after.json").exists())

    def make_frozen_candidate(self, verdict="BLOCKED", scan_scope=None, config=None):
        config = config or self.backend_config(); prepared = self.prepare(config, scan_scope)
        def fake_pipeline(task_dir, plan, **kwargs):
            task = bridge.read_json(task_dir / "task.json")
            (Path(task["project_root"]) / self.source.relative_to(self.root)).write_text("class Page { update() { return 2; } }\n", encoding="utf-8")
            return {"verdict": verdict, "steps": []}
        run = bridge.create_run(config, self.root, "task.execute")
        with patch("arkts_smell_refactor.runner.execute_pipeline", side_effect=fake_pipeline):
            candidate = bridge.execute_candidate({"taskHandle": prepared["taskHandle"]}, config, self.root, run)["candidate"]
        return config, candidate, run

    def test_blocked_candidate_restores_and_revalidates_without_refactoring(self):
        config, candidate, candidate_run = self.make_frozen_candidate()
        original = self.source.read_bytes()
        prepared_path = Path(config["runs"]) / candidate["taskHandle"] / "prepared.json"
        legacy = bridge.read_json(prepared_path); legacy.pop("instructions")
        bridge.write_json(prepared_path, legacy)
        restored = bridge.dispatch("candidate.restore", {"candidateId": candidate["candidateId"]}, config, self.root, None)
        self.assertEqual("BLOCKED", restored["candidate"]["verdict"])
        self.assertEqual("keep public entry", restored["prepared"]["instructions"])
        script = Path(self.directory.name) / "candidate_validation.py"
        script.write_text("import sys,json\nassert sys.argv[1] not in ('refactor','repair')\n"
                          "print(json.dumps({'verdict':'PASS','issues':[]}) if sys.argv[1]=='review' else 'validated')\n", encoding="utf-8")
        spec = lambda phase: {"command": [sys.executable, str(script), phase], "timeoutSeconds": 10}
        plan = {"refactorAgent": spec("refactor"), "repairAgent": spec("repair"), "maxRepairAttempts": 3,
                "gates": {key: spec(key) for key in ("smell", "build", "test", "linter")}, "reviewAgent": spec("review")}
        run = bridge.create_run(config, self.root, "task.validateCandidate")
        with patch.object(bridge, "pipeline_config", return_value=plan):
            response = bridge.validate_candidate({"candidateId": candidate["candidateId"]}, config, self.root, run)
        self.assertEqual("PASS", response["candidate"]["verdict"])
        self.assertEqual(candidate["candidateId"], response["candidate"]["revalidatedFrom"])
        self.assertEqual("BLOCKED", bridge.read_json(candidate_run / "candidate.json")["verdict"])
        self.assertEqual("PASS", next(step["status"] for step in response["result"]["steps"] if step["name"] == "review-agent"))
        self.assertEqual("SKIPPED", response["result"]["steps"][0]["status"])
        self.assertEqual(original, self.source.read_bytes())
        checked = bridge.dispatch("candidate.check", {"candidateId": response["candidate"]["candidateId"]}, config, self.root, None)
        self.assertEqual("PASS", checked["verdict"])

    def test_restore_rejects_changed_original_and_tampered_frozen_bytes(self):
        config, candidate, run = self.make_frozen_candidate()
        original = self.source.read_bytes()
        self.source.write_text("user edit", encoding="utf-8")
        with self.assertRaisesRegex(bridge.BridgeError, "原工程已变化"):
            bridge.load_candidate_for_validation(candidate["candidateId"], config, self.root)
        self.source.write_bytes(original)
        (run / "content/after" / candidate["changes"][0]["relativePath"]).write_text("tampered", encoding="utf-8")
        with self.assertRaisesRegex(bridge.BridgeError, "冻结候选内容已变化"):
            bridge.load_candidate_for_validation(candidate["candidateId"], config, self.root)

    def test_revalidation_cannot_promote_blocked_gates_to_applicable_candidate(self):
        config, candidate, previous = self.make_frozen_candidate()
        run = bridge.create_run(config, self.root, "task.validateCandidate")
        def blocked(task_dir, plan, **kwargs):
            self.assertNotIn("refactorAgent", plan)
            self.assertNotIn("repairAgent", plan)
            return {"verdict": "BLOCKED", "steps": [{"name": "smell", "status": "BLOCKED", "reason": "scanner unavailable"}]}
        with patch("arkts_smell_refactor.runner.execute_pipeline", side_effect=blocked):
            result = bridge.validate_candidate({"candidateId": candidate["candidateId"]}, config, self.root, run)
        self.assertEqual("BLOCKED", result["candidate"]["verdict"])
        with self.assertRaises(bridge.BridgeError):
            bridge.dispatch("candidate.check", {"candidateId": result["candidate"]["candidateId"]}, config, self.root, None)

    def test_clone_without_symbol_still_fails_and_scans_related_file(self):
        task_dir, stage, relative = self.agent_gate_fixture()
        other = stage / relative.parent / "Other.ets"
        other.write_text("class Other {}", encoding="utf-8")
        task = bridge.read_json(task_dir / "task.json")
        task["rule"] = "@extrulesproject/code-clone-fragment-check"
        task["target"]["symbol"] = None
        task["target"]["related_targets"] = [{"filePath": "Example/entry/src/main/ets/Other.ets"}]
        bridge.write_json(task_dir / "task.json", task)
        record = self.record(rule=task["rule"], message="Code Clone: Page.ets:1-2 is similar to Example/entry/src/main/ets/Other.ets:1-2.")
        response = {"issues": bridge.normalize_issues(record, stage), "reportPath": "controlled-report", "scannedFiles": [str(stage / relative), str(other)]}
        with patch.object(bridge, "scan", return_value=response) as detector:
            self.assertEqual(1, bridge.smell_candidate_gate(task_dir, stage, {}))
        self.assertIn(str(other), detector.call_args.args[0]["files"])

    def test_smell_moved_to_new_method_does_not_pass_target_recheck(self):
        task_dir, stage, relative = self.agent_gate_fixture()
        (stage / relative).write_text("class Page {\n  update() { return this.newMethod(); }\n  newMethod() { return 1; }\n}\n", encoding="utf-8")
        record = self.record(message="Method 'newMethod' is too long", line=3)
        response = {"issues": bridge.normalize_issues(record, stage), "reportPath": "controlled-report", "scannedFiles": [str(stage / relative)]}
        with patch.object(bridge, "scan", return_value=response):
            self.assertEqual(1, bridge.smell_candidate_gate(task_dir, stage, {}))
        self.assertIn("newMethod", bridge.read_json(task_dir / "smell-after.json")[0]["message"])

    def test_smell_diagnostic_separates_tool_failure_from_remaining_smell(self):
        task_dir = Path(self.directory.name) / "backend"
        task_dir.mkdir()
        log = task_dir / "smell.log"
        log.write_text("cloc-2.10.exe: creation of private cache subdirectory failed\nSMELL_GATE_BLOCKED: scan unavailable", encoding="utf-8")
        blocked = {"verdict": "BLOCKED", "steps": [{"name": "smell", "status": "BLOCKED", "reason": "generic tool blocker", "output_file": str(log)}]}
        bridge.summarize_failure(task_dir, blocked)
        self.assertIn("CLOC", blocked["failureReason"])
        bridge.write_json(task_dir / "smell-after.json", [{"message": "Method 'applyNormalAttribute' is feature-envious"}])
        log.write_text("remaining smell", encoding="utf-8")
        failed = {"verdict": "FAIL", "steps": [{"name": "smell", "status": "FAIL", "output_file": str(log)}]}
        bridge.summarize_failure(task_dir, failed)
        self.assertIn("applyNormalAttribute", failed["failureReason"])

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

    def test_applied_issue_refresh_retains_file_directory_and_report_scopes(self):
        from arkts_smell_refactor.models import CommandResult
        initial = self.source.read_bytes()
        unrelated = self.root / "feature/other/src/main/ets/Other.ets"
        unrelated.parent.mkdir(parents=True)
        unrelated.write_text("class Other {}", encoding="utf-8")
        scopes = [
            {"scopePath": str(self.source)},
            {"scopePath": str(self.source.parent), "rules": ["@extrulesproject/long-method-check"]},
            {"scopePath": str(self.root)},
            {"scopePath": str(self.root), "files": [str(self.source)]},
        ]
        config = self.backend_config()
        for scope in scopes:
            with self.subTest(scope=scope):
                self.source.write_bytes(initial)
                config, candidate, candidate_run = self.make_frozen_candidate("PASS", scope, config)
                self.assertEqual(scope, candidate["scanScope"])
                self.assertEqual(scope, bridge.read_json(Path(config["runs"]) / candidate["taskHandle"] / "prepared.json")["scanScope"])
                self.source.write_bytes((candidate_run / "content/after" / self.source.relative_to(self.root)).read_bytes())
                run = bridge.create_run(config, self.root, "task.validateApplied")
                steps = [CommandResult(name, "PASS") for name in ("smell", "build", "contract", "test", "linter")]
                with patch.object(bridge, "pipeline_config", return_value={}), \
                     patch("arkts_smell_refactor.runner._run_gates_fail_fast", return_value=steps) as gates, \
                     patch.object(bridge, "scan", return_value={"issues": []}) as detector:
                    response = bridge.validate_applied({"candidateId": candidate["candidateId"]}, config, self.root, run)
                self.assertEqual("PASS", response["result"]["verdict"])
                self.assertEqual(scope, response["scanScope"])
                self.assertEqual(scope, detector.call_args.args[0])
                self.assertEqual(self.root, detector.call_args.args[2])
                # Engineering gates still use the complete staged project.
                self.assertTrue(Path(gates.call_args.args[1].project_root).is_dir())
                self.assertTrue((Path(gates.call_args.args[1].project_root) / unrelated.relative_to(self.root)).is_file())

    def test_legacy_applied_candidate_uses_task_files_instead_of_project_root(self):
        from arkts_smell_refactor.models import CommandResult
        config, candidate, candidate_run = self.make_frozen_candidate("PASS")
        candidate.pop("scanScope")
        bridge.write_json(candidate_run / "candidate.json", candidate)
        prepared_path = Path(config["runs"]) / candidate["taskHandle"] / "prepared.json"
        prepared = bridge.read_json(prepared_path)
        prepared.pop("scanScope")
        bridge.write_json(prepared_path, prepared)
        self.source.write_bytes((candidate_run / "content/after" / self.source.relative_to(self.root)).read_bytes())
        run = bridge.create_run(config, self.root, "task.validateApplied")
        with patch.object(bridge, "pipeline_config", return_value={}), \
             patch("arkts_smell_refactor.runner._run_gates_fail_fast", return_value=[CommandResult("smell", "PASS")]), \
             patch.object(bridge, "scan", return_value={"issues": []}) as detector:
            response = bridge.validate_applied({"candidateId": candidate["candidateId"]}, config, self.root, run)
        self.assertEqual({"scopePath": str(self.source)}, detector.call_args.args[0])
        self.assertEqual({"scopePath": str(self.source)}, response["scanScope"])

    def test_scan_scope_rejects_outside_paths_and_missing_legacy_targets(self):
        outside = Path(self.directory.name) / "Outside.ets"
        outside.write_text("class Outside {}", encoding="utf-8")
        for scope in ({"scopePath": str(outside)}, {"scopePath": str(self.root), "files": [str(outside)]},
                      {"scopePath": str(self.root), "files": []}, {"scopePath": str(self.root), "rules": ["custom/rule"]}):
            with self.subTest(scope=scope), self.assertRaises(bridge.BridgeError):
                bridge.normalize_scan_scope(scope, self.root)
        with self.assertRaisesRegex(bridge.BridgeError, "缺少异味检测范围"):
            bridge.prepared_scan_scope({}, self.root)


if __name__ == "__main__":
    unittest.main()
