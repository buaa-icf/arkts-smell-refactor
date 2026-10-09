import json
import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.models import CommandResult
from arkts_smell_refactor.runner import _build_agent_failure_report, _build_failure_report, _extract_review_json, _task_from_file, execute_pipeline


class RunnerTests(unittest.TestCase):
    def _task(self, temp):
        return {
            "schema_version": "1.0", "task_id": "x", "source_project": "demo",
            "commit_hash": "", "workspace_root": temp, "project_root": temp,
            "smell_type": "feature-envy", "rule": "rule", "severity": "",
            "message": "message",
            "target": {"file_path": "Foo.ets", "symbol": "work", "range": {}, "related_targets": []},
            "raw": {},
        }

    def test_dry_run_renders_all_steps(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0",
                "task_id": "feature-envy-0001-work",
                "source_project": "demo",
                "commit_hash": "abc",
                "workspace_root": temp,
                "project_root": temp,
                "smell_type": "feature-envy",
                "rule": "@extrulesproject/feature-envy-check",
                "severity": "SUGGESTION",
                "message": "Method 'work' is feature-envious.",
                "target": {"file_path": "demo/Foo.ets", "symbol": "work", "range": {"start_line": 1, "end_line": 2, "column": 1}, "related_targets": []},
                "raw": {},
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            config = {
                "refactorAgent": {"command": ["agent", "{prompt_file}"]},
                "gates": {name: {"command": [name, "{target_file}"]} for name in ("smell", "build", "test", "linter")},
                "reviewAgent": {"command": ["review", "{review_prompt_file}"]},
            }
            result = execute_pipeline(task_dir, config, dry_run=True)
            self.assertEqual("DRY_RUN", result["verdict"])
            self.assertEqual(6, len(result["steps"]))
            self.assertTrue(all(item["status"] == "DRY_RUN" for item in result["steps"]))

    def test_extracts_last_review_verdict_from_noisy_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            log = root / "review-agent.log"
            output = root / "review.json"
            log.write_text(
                'event {"type":"message"}\n评审完成\n'
                '{"verdict":"FAIL","summary":"接口断裂","issues":[]}\n',
                encoding="utf-8",
            )
            review = _extract_review_json(log, output)
            self.assertEqual("FAIL", review["verdict"])
            self.assertTrue(output.exists())

    def test_extracts_review_verdict_from_jsonl_text_event(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            log = root / "review-agent.log"
            output = root / "review.json"
            event = {
                "type": "text",
                "timestamp": 123456789,
                "part": {
                    "type": "text",
                    "text": json.dumps({
                        "verdict": "PASS",
                        "summary": "行为等价",
                        "issues": [],
                    }, ensure_ascii=False),
                },
            }
            log.write_text(json.dumps(event, ensure_ascii=False) + "\n", encoding="utf-8")
            review = _extract_review_json(log, output)
            self.assertEqual("PASS", review["verdict"])
            self.assertTrue(output.exists())

    def test_extracts_multiline_review_json(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            log = root / "review-agent.log"
            output = root / "review.json"
            log.write_text("review complete\n" + json.dumps({
                "verdict": "PASS", "summary": "equivalent", "issues": [],
            }, indent=2), encoding="utf-8")
            self.assertEqual("PASS", _extract_review_json(log, output)["verdict"])

    def test_missing_or_invalid_review_verdict_is_blocked_without_repair(self):
        for output in (
            "", "review finished", '{"verdict":', '{"summary":"no verdict"}',
            '{"verdict":"UNKNOWN"}', '{"verdict":"UNCERTAIN"}',
            '{"verdict":"PASS"}\n{"verdict":"UNKNOWN"}',
        ):
            with self.subTest(output=output), tempfile.TemporaryDirectory() as temp:
                task_dir = Path(temp)
                (task_dir / "task.json").write_text(json.dumps(self._task(temp)), encoding="utf-8")
                # A previous run's verdict must not fill in for missing current evidence.
                (task_dir / "review.json").write_text('{"verdict":"PASS"}', encoding="utf-8")
                python = __import__('sys').executable
                config = {
                    "refactorAgent": {"command": [python, "-c", "raise SystemExit(0)"]},
                    "gates": {name: {"command": [python, "-c", "raise SystemExit(0)"]}
                              for name in ("smell", "build", "test", "linter")},
                    "reviewAgent": {"command": [python, "-c", f"print({output!r})"]},
                    "repairAgent": {"command": ["must-not-run"]},
                }
                result = execute_pipeline(task_dir, config)
                self.assertEqual("BLOCKED", result["verdict"])
                self.assertEqual("BLOCKED", result["steps"][-1]["status"])
                self.assertEqual(0, result["repairAttempts"])

    def test_semantic_review_failure_still_enters_repair(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            (task_dir / "task.json").write_text(json.dumps(self._task(temp)), encoding="utf-8")
            (task_dir / "risk-report.json").write_text("{}", encoding="utf-8")
            python = __import__('sys').executable
            config = {
                "refactorAgent": {"command": [python, "-c", "raise SystemExit(0)"]},
                "gates": {name: {"command": [python, "-c", "raise SystemExit(0)"]}
                          for name in ("smell", "build", "test", "linter")},
                "reviewAgent": {"command": [python, "-c",
                    "import json; from pathlib import Path; "
                    "print(json.dumps(dict(verdict='PASS' if Path('repaired').exists() else 'FAIL', "
                    "summary='guard changed', issues=[])))"]},
                "repairAgent": {"command": [python, "-c",
                    "from pathlib import Path; Path('repaired').write_text('ok')"]},
            }
            result = execute_pipeline(task_dir, config)
            self.assertEqual("PASS", result["verdict"])
            self.assertEqual(1, result["repairAttempts"])
            report = json.loads((task_dir / "failure-report-1.json").read_text(encoding="utf-8"))
            self.assertEqual("SEMANTIC_REVIEW_FAILURE", report["classification"])

    def test_success_output_can_override_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0", "task_id": "x", "source_project": "demo",
                "commit_hash": "", "workspace_root": temp, "project_root": temp,
                "smell_type": "feature-envy", "rule": "rule", "severity": "",
                "message": "message",
                "target": {"file_path": "Foo.ets", "symbol": "work", "range": {}, "related_targets": []},
                "raw": {}
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            command = [
                __import__('sys').executable, "-c",
                "print('No defects found in your code.'); raise SystemExit(1)"
            ]
            config = {"gates": {"linter": {"command": command, "successOutputRegex": "No defects found in your code\\."}}}
            result = execute_pipeline(task_dir, config)
            linter = next(item for item in result["steps"] if item["name"] == "linter")
            self.assertEqual("PASS", linter["status"])

    def test_signing_failure_is_blocked_instead_of_refactor_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0", "task_id": "x", "source_project": "demo",
                "commit_hash": "", "workspace_root": temp, "project_root": temp,
                "smell_type": "feature-envy", "rule": "rule", "severity": "",
                "message": "message",
                "target": {"file_path": "Foo.ets", "symbol": "work", "range": {}, "related_targets": []},
                "raw": {}
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            command = [
                __import__('sys').executable, "-c",
                "print('Failed :entry:default@SignHap: Invalid storeFile value'); raise SystemExit(1)"
            ]
            config = {"gates": {"build": {
                "command": command,
                "blockedOutputRegex": "SignHap|Invalid storeFile value"
            }}}
            result = execute_pipeline(task_dir, config)
            build = next(item for item in result["steps"] if item["name"] == "build")
            self.assertEqual("BLOCKED", build["status"])

    def test_refactor_blocker_skips_meaningless_downstream_gates(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0", "task_id": "x", "source_project": "demo",
                "commit_hash": "", "workspace_root": temp, "project_root": temp,
                "smell_type": "feature-envy", "rule": "rule", "severity": "",
                "message": "message",
                "target": {"file_path": "Foo.ets", "symbol": "work", "range": {}, "related_targets": []},
                "raw": {}
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            command = [__import__('sys').executable, "-c", "print('model service is currently overloaded'); raise SystemExit(1)"]
            config = {
                "refactorAgent": {"command": command, "blockedOutputRegex": "model service is currently overloaded"},
                "gates": {name: {"command": ["must-not-run"]} for name in ("smell", "build", "test", "linter")},
                "reviewAgent": {"command": ["must-not-run"]},
            }
            result = execute_pipeline(task_dir, config)
            self.assertEqual("BLOCKED", result["verdict"])
            self.assertEqual("BLOCKED", result["steps"][0]["status"])
            self.assertTrue(all(step["status"] == "SKIPPED" for step in result["steps"][1:]))

    def test_timeout_returns_blocked_without_hanging(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task = {
                "schema_version": "1.0", "task_id": "timeout", "source_project": "demo",
                "commit_hash": "", "workspace_root": temp, "project_root": temp,
                "smell_type": "feature-envy", "rule": "rule", "severity": "",
                "message": "message",
                "target": {"file_path": "Foo.ets", "symbol": "work", "range": {}, "related_targets": []},
                "raw": {}
            }
            (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
            command = [__import__('sys').executable, "-c", "import time; time.sleep(10)"]
            result = execute_pipeline(task_dir, {"refactorAgent": {"command": command, "timeoutSeconds": 1}})
            self.assertEqual("BLOCKED", result["steps"][0]["status"])
            self.assertIn("超过 1 秒", result["steps"][0]["reason"])

    def test_fail_fast_repairs_smell_then_restarts_all_gates(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            (task_dir / "task.json").write_text(json.dumps(self._task(temp)), encoding="utf-8")
            (task_dir / "risk-report.json").write_text('{"risks":[],"recommendedConstraints":[]}', encoding="utf-8")
            marker = task_dir / "repaired"
            python = __import__('sys').executable
            smell_code = f"from pathlib import Path; raise SystemExit(0 if Path(r'{marker}').exists() else 1)"
            repair_code = f"from pathlib import Path; Path(r'{marker}').write_text('ok')"
            review_json = json.dumps({"verdict": "PASS", "smellRemoved": True, "behaviorEquivalent": True, "issues": []})
            config = {
                "maxRepairAttempts": 3,
                "repairAgent": {"command": [python, "-c", repair_code]},
                "gates": {
                    "smell": {"command": [python, "-c", smell_code]},
                    "build": {"command": [python, "-c", "raise SystemExit(0)"]},
                    "test": {"command": [python, "-c", "raise SystemExit(0)"]},
                    "linter": {"command": [python, "-c", "raise SystemExit(0)"]},
                },
                "reviewAgent": {"command": [python, "-c", f"print({review_json!r})"]},
            }
            result = execute_pipeline(task_dir, config)
            self.assertEqual("PASS", result["verdict"])
            self.assertEqual(1, result["repairAttempts"])
            initial = {step["name"]: step for step in result["steps"]}
            self.assertEqual("FAIL", initial["smell"]["status"])
            self.assertIn(initial["build"]["status"], {"PASS", "SKIPPED"})
            self.assertEqual("PASS", initial["smell-repair-1"]["status"])
            self.assertEqual("PASS", initial["review-agent-repair-1"]["status"])

    def test_parallel_gate_failure_cancels_slow_siblings_and_enters_repair(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            (task_dir / "task.json").write_text(json.dumps(self._task(temp)), encoding="utf-8")
            (task_dir / "risk-report.json").write_text('{"risks":[],"recommendedConstraints":[]}', encoding="utf-8")
            marker = task_dir / "repaired"
            python = __import__('sys').executable
            smell = f"from pathlib import Path; raise SystemExit(0 if Path(r'{marker}').exists() else 1)"
            slow = (
                "import time; from pathlib import Path; "
                f"time.sleep(0 if Path(r'{marker}').exists() else 8)"
            )
            repair = f"from pathlib import Path; Path(r'{marker}').write_text('ok')"
            config = {
                "repairAgent": {"command": [python, "-c", repair]},
                "maxRepairAttempts": 1,
                "gates": {
                    "smell": {"command": [python, "-c", smell]},
                    "build": {"command": [python, "-c", slow]},
                    "test": {"command": [python, "-c", "raise SystemExit(0)"]},
                    "linter": {"command": [python, "-c", slow]},
                },
            }
            started = __import__('time').monotonic()
            result = execute_pipeline(task_dir, config)
            elapsed = __import__('time').monotonic() - started
            initial = {step["name"]: step for step in result["steps"]}
            self.assertLess(elapsed, 5)
            self.assertEqual("FAIL", initial["smell"]["status"])
            self.assertEqual("SKIPPED", initial["build"]["status"])
            self.assertEqual("SKIPPED", initial["linter"]["status"])
            self.assertEqual("SMELL_REMAINS_OR_MOVED", json.loads(
                (task_dir / "failure-report-1.json").read_text(encoding="utf-8")
            )["classification"])

    def test_linter_failure_in_parallel_group_has_repair_analysis(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            (task_dir / "task.json").write_text(json.dumps(self._task(temp)), encoding="utf-8")
            (task_dir / "risk-report.json").write_text('{"risks":[],"recommendedConstraints":[]}', encoding="utf-8")
            marker = task_dir / "repaired"
            python = __import__('sys').executable
            linter = f"from pathlib import Path; raise SystemExit(0 if Path(r'{marker}').exists() else 1)"
            repair = f"from pathlib import Path; Path(r'{marker}').write_text('ok')"
            config = {
                "repairAgent": {"command": [python, "-c", repair]},
                "maxRepairAttempts": 1,
                "gates": {
                    "smell": {"command": [python, "-c", "raise SystemExit(0)"]},
                    "build": {"command": [python, "-c", "raise SystemExit(0)"]},
                    "test": {"command": [python, "-c", "raise SystemExit(0)"]},
                    "linter": {"command": [python, "-c", linter]},
                },
                "reviewAgent": {"command": [
                    python, "-c", "print('{\"verdict\":\"PASS\",\"issues\":[]}')",
                ]},
            }
            result = execute_pipeline(task_dir, config)
            self.assertEqual("PASS", result["verdict"])
            report = json.loads((task_dir / "failure-report-1.json").read_text(encoding="utf-8"))
            self.assertEqual("linter", report["stage"])
            self.assertEqual("INTRODUCED_LINTER_FAILURE", report["classification"])

    def test_total_task_timeout_stops_current_process_and_records_wall_time(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            (task_dir / "task.json").write_text(json.dumps(self._task(temp)), encoding="utf-8")
            python = __import__('sys').executable
            result = execute_pipeline(task_dir, {
                "taskTimeoutSeconds": 0.5,
                "refactorAgent": {"command": [python, "-c", "import time; time.sleep(8)"], "timeoutSeconds": 20},
            })
            self.assertEqual("BLOCKED", result["verdict"])
            self.assertTrue(result["timedOut"])
            self.assertEqual(0.5, result["timeoutSeconds"])
            self.assertLess(result["durationSeconds"], 4)
            self.assertIn("总执行时间超过限制", result["steps"][0]["reason"])

    def test_runtime_failure_is_repairable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "task.json").write_text(
                json.dumps(self._task(temp)),
                encoding="utf-8",
            )
            (root / "refactor-changes.json").write_text(
                '{"changedProductionFiles":["Foo.ets"]}',
                encoding="utf-8",
            )
            log = root / "runtime.log"
            log.write_text(
                "resourceManager is undefined at Foo.ets",
                encoding="utf-8",
            )
            (root / "runtime-smoke-results.json").write_text(
                json.dumps({
                    "current": {
                        "log": str(log),
                    }
                }),
                encoding="utf-8",
            )

            from arkts_smell_refactor.runner import (
                _build_failure_report,
                _task_from_file,
            )
            from arkts_smell_refactor.models import CommandResult

            failure = _build_failure_report(
                root,
                _task_from_file(root / "task.json"),
                CommandResult("runtime", "FAIL"),
                1,
            )
            self.assertTrue(failure["repairable"])
            self.assertEqual(
                "INTRODUCED_RUNTIME_INITIALIZATION_FAILURE",
                failure["classification"],
            )

    def test_contract_failure_is_repairable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "task.json").write_text(
                json.dumps(self._task(temp)),
                encoding="utf-8",
            )
            (root / "refactor-changes.json").write_text(
                '{"changedProductionFiles":["Foo.ets"]}',
                encoding="utf-8",
            )
            (root / "public-contract-results.json").write_text(
                json.dumps({
                    "passed": False,
                    "removedExports": ["Foo"],
                    "changedMembers": [],
                }),
                encoding="utf-8",
            )

            from arkts_smell_refactor.runner import (
                _build_failure_report,
                _task_from_file,
            )
            from arkts_smell_refactor.models import CommandResult

            failure = _build_failure_report(
                root,
                _task_from_file(root / "task.json"),
                CommandResult("contract", "FAIL"),
                1,
            )
            self.assertTrue(failure["repairable"])
            self.assertEqual(
                "PUBLIC_CONTRACT_BREAK",
                failure["classification"],
            )
            from arkts_smell_refactor.prompts import build_repair_prompt
            prompt = build_repair_prompt(_task_from_file(root / "task.json"), {}, failure, 1)
            self.assertIn('"removedExports": [', prompt)
            self.assertIn('"Foo"', prompt)

    def test_runtime_gate_does_not_replace_missing_core_gate_for_review(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "task.json").write_text(
                json.dumps(self._task(temp)),
                encoding="utf-8",
            )
            python = __import__("sys").executable
            config = {
                "gates": {
                    "smell": {
                        "command": [
                            python,
                            "-c",
                            "raise SystemExit(0)",
                        ]
                    },
                    "build": {
                        "command": [
                            python,
                            "-c",
                            "raise SystemExit(0)",
                        ]
                    },
                    "runtime": {
                        "command": [
                            python,
                            "-c",
                            "raise SystemExit(0)",
                        ]
                    },
                },
                "reviewAgent": {
                    "command": ["must-not-run"]
                },
            }

            result = execute_pipeline(root, config)
            review = next(
                item
                for item in result["steps"]
                if item["name"] == "review-agent"
            )
            self.assertEqual("SKIPPED", review["status"])

    def test_optional_gates_and_review_retry_complete_together(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "task.json").write_text(
                json.dumps(self._task(temp)),
                encoding="utf-8",
            )
            python = __import__("sys").executable
            marker = root / "review-retried"
            review_code = (
                "import json, sys; from pathlib import Path; "
                f"marker = Path(r'{marker}'); first = not marker.exists(); marker.touch(); "
                "print('unknown certificate verification error' if first else "
                "json.dumps(dict(verdict='PASS', issues=[]))); sys.exit(1 if first else 0)"
            )
            config = {
                "gates": {
                    name: {"command": [python, "-c", "raise SystemExit(0)"]}
                    for name in ("smell", "build", "contract", "runtime", "test", "linter")
                },
                "reviewAgent": {
                    "command": [python, "-c", review_code],
                    "blockedOutputRegex": "certificate verification",
                    "maxEnvironmentRetries": 1,
                    "retryDelaySeconds": 0,
                },
            }

            result = execute_pipeline(root, config)
            statuses = {item["name"]: item["status"] for item in result["steps"]}
            self.assertEqual("PASS", result["verdict"])
            self.assertEqual(1, result["reviewRetries"])
            self.assertTrue(all(statuses[name] == "PASS" for name in (
                "smell", "build", "contract", "runtime", "test", "linter",
                "review-agent-retry-1",
            )))
            self.assertEqual("BLOCKED", statuses["review-agent"])

    def test_review_failure_report_uses_current_repair_round(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            (task_dir / "task.json").write_text(
                json.dumps(self._task(temp)),
                encoding="utf-8",
            )
            (task_dir / "review.json").write_text(
                '{"summary":"stale","issues":[]}',
                encoding="utf-8",
            )
            (task_dir / "review-repair-3.json").write_text(
                '{"summary":"current","issues":'
                '[{"reason":"guard changed"}]}',
                encoding="utf-8",
            )

            task = _task_from_file(task_dir / "task.json")
            for suffix in ("-repair-3", "-retry-1", "-repair-3-retry-1"):
                with self.subTest(suffix=suffix):
                    (task_dir / f"review{suffix}.json").write_text(
                        '{"summary":"current","issues":[{"reason":"guard changed"}]}', encoding="utf-8"
                    )
                    report = _build_failure_report(task_dir, task, CommandResult("review-agent" + suffix, "FAIL"), 4)
                    self.assertEqual("SEMANTIC_REVIEW_FAILURE", report["classification"])
                    self.assertTrue(report["repairable"])
                    self.assertEqual("current", report["summary"])
                    self.assertEqual("guard changed", report["issues"][0]["reason"])

    def test_smell_failure_points_to_new_helper_not_original_target(self):
        from arkts_smell_refactor.prompts import build_repair_prompt

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            task_dir = root / "task"
            task_dir.mkdir()
            task_data = self._task(temp)
            task_data["target"]["file_path"] = "demo/pages/UserDetail.ets"
            (task_dir / "task.json").write_text(json.dumps(task_data), encoding="utf-8")
            (task_dir / "refactor-changes.json").write_text(json.dumps({
                "changedProductionFiles": ["model/UserEnumDisplayValues.ets", "pages/UserDetail.ets"],
            }), encoding="utf-8")
            helper = root / "demo/model/UserEnumDisplayValues.ets"
            (task_dir / "smell-after.json").write_text(json.dumps([
                {"filePath": str(helper), "line": 23,
                 "message": "Method 'fromUserInfo' is feature-envious", "rule": "rule"},
                {"filePath": str(root / "demo/pages/UserDetail.ets"), "line": 42,
                 "message": "Method 'work' is feature-envious", "rule": "rule"},
            ]), encoding="utf-8")

            task = _task_from_file(task_dir / "task.json")
            report = _build_failure_report(task_dir, task, CommandResult("smell", "FAIL"), 1)
            self.assertEqual(
                ["model/UserEnumDisplayValues.ets", "pages/UserDetail.ets"],
                [issue["filePath"] for issue in report["issues"]],
            )
            prompt = build_repair_prompt(task, {}, report, 1)
            self.assertIn("model/UserEnumDisplayValues.ets:23", prompt)
            self.assertIn("pages/UserDetail.ets:42", prompt)
            self.assertNotIn("pages/UserDetail.ets:23", prompt)

    def test_unattributed_test_failure_is_not_repairable(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            (task_dir / "task.json").write_text(
                json.dumps(self._task(temp)),
                encoding="utf-8",
            )
            (task_dir / "refactor-changes.json").write_text(
                '{"changedProductionFiles":'
                '["pages/EditNamePage.ets"]}',
                encoding="utf-8",
            )
            log = task_dir / "test.log"
            log.write_text(
                "EditPhonePageVM.test.ets: "
                "'vm.userInfo' is possibly undefined",
                encoding="utf-8",
            )

            task = _task_from_file(task_dir / "task.json")
            failed = CommandResult(
                "test",
                "FAIL",
                output_file=str(log),
            )
            report = _build_failure_report(
                task_dir,
                task,
                failed,
                1,
            )
            self.assertFalse(report["repairable"])
            self.assertEqual(
                "UNATTRIBUTED_TEST_FAILURE",
                report["classification"],
            )

    def test_instrument_failure_ignores_successful_target_and_unrelated_build_warnings(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            task_dir = root / "task"
            task_dir.mkdir()
            task_data = self._task(temp)
            task_data["target"]["symbol"] = "getCropRatio"
            (task_dir / "task.json").write_text(json.dumps(task_data), encoding="utf-8")
            (task_dir / "refactor-changes.json").write_text(json.dumps({
                "changedProductionFiles": ["components/CarouseCutToolBar.ets"],
            }), encoding="utf-8")
            workspace = root / "validation"
            result = workspace / "picture_beautification/.test/default/intermediates/ohosTest/coverage_data/test_result.txt"
            result.parent.mkdir(parents=True)
            result.write_text(
                "class=CarouseCutToolBarTest\n"
                "test=get_crop_ratio_free_returns_0\nresult=Success\n"
                "class=StickerToolBarInstrumentTest\n"
                "test=build_renders_search_grid\n"
                "Unable to find id: sticker_toolbar_test_host, error in beforeAll function\n"
                "at StickerToolBar.test.ets:19\nresult=Error\n", encoding="utf-8",
            )
            (task_dir / "validation-workspace.json").write_text(
                json.dumps({"path": str(workspace)}), encoding="utf-8",
            )
            log = task_dir / "test.log"
            log.write_text(
                "WARN File: components/CarouseCutToolBar.ets:167 getCropRatio\n"
                "TEST_CASE_FAILURE: 1/2 passed, 1 failed\n", encoding="utf-8",
            )
            report = _build_failure_report(
                task_dir, _task_from_file(task_dir / "task.json"),
                CommandResult("test", "FAIL", command="gate hvigor --module picture_beautification", output_file=str(log)), 1,
            )
            self.assertEqual("UNATTRIBUTED_TEST_FAILURE", report["classification"])
            self.assertFalse(report["repairable"])
            self.assertIn("StickerToolBar.test.ets", report["logTail"])
            self.assertNotIn("CarouseCutToolBar.ets", report["logTail"])

    def test_instrument_failure_in_changed_component_remains_repairable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "task.json").write_text(json.dumps(self._task(temp)), encoding="utf-8")
            (task_dir / "refactor-changes.json").write_text(
                '{"changedProductionFiles":["components/CarouseCutToolBar.ets"]}', encoding="utf-8",
            )
            workspace = root / "validation"
            result = workspace / "picture_beautification/.test/default/intermediates/ohosTest/coverage_data/test_result.txt"
            result.parent.mkdir(parents=True)
            result.write_text(
                "class=CarouseCutToolBarTest\n"
                "test=get_crop_ratio_free_returns_0\n"
                "Error in get_crop_ratio_free_returns_0, expected 0 but got 1\n"
                "result=Error\n", encoding="utf-8",
            )
            (task_dir / "validation-workspace.json").write_text(
                json.dumps({"path": str(workspace)}), encoding="utf-8",
            )
            report = _build_failure_report(
                task_dir, _task_from_file(task_dir / "task.json"),
                CommandResult("test", "FAIL", command="gate hvigor --module picture_beautification"), 1,
            )
            self.assertEqual("RELATED_TEST_FAILURE", report["classification"])
            self.assertTrue(report["repairable"])

    def test_target_instrument_host_missing_in_before_all_is_not_repairable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "task.json").write_text(json.dumps(self._task(temp)), encoding="utf-8")
            (task_dir / "refactor-changes.json").write_text(json.dumps({
                "changedProductionFiles": ["pages/AvatarUpload.ets"],
            }), encoding="utf-8")
            workspace = root / "validation"
            result = workspace / "phone/.test/default/intermediates/ohosTest/coverage_data/test_result.txt"
            result.parent.mkdir(parents=True)
            result.write_text(
                "class=CropCheckImageAdaptTest\n"
                "test=S1_image_exactly_fills_frame_keeps_identity_state\n"
                "Error in S1_image_exactly_fills_frame_keeps_identity_state, "
                "Component not found: crop_test_host_anchor, error in beforeAll function\n"
                "at findById phone_test (AvatarUpload.test.ets:14:11)\nresult=Error\n",
                encoding="utf-8",
            )
            (task_dir / "validation-workspace.json").write_text(
                json.dumps({"path": str(workspace)}), encoding="utf-8",
            )
            report = _build_failure_report(
                task_dir, _task_from_file(task_dir / "task.json"),
                CommandResult("test", "FAIL", command="gate hvigor --module phone"), 1,
            )
            self.assertEqual("TEST_HOST_UNAVAILABLE", report["classification"])
            self.assertFalse(report["repairable"])
            self.assertIn("beforeAll", report["summary"])

    def test_mixed_instrument_failures_do_not_send_unrelated_case_to_repair_agent(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "task.json").write_text(json.dumps(self._task(temp)), encoding="utf-8")
            (task_dir / "refactor-changes.json").write_text(
                '{"changedProductionFiles":["components/CarouseCutToolBar.ets"]}', encoding="utf-8",
            )
            workspace = root / "validation"
            result = workspace / "picture_beautification/.test/default/intermediates/ohosTest/coverage_data/test_result.txt"
            result.parent.mkdir(parents=True)
            result.write_text(
                "class=CarouseCutToolBarTest\ntest=target_case\nresult=Failure\n"
                "class=StickerToolBarInstrumentTest\ntest=unrelated_case\nresult=Error\n",
                encoding="utf-8",
            )
            (task_dir / "validation-workspace.json").write_text(
                json.dumps({"path": str(workspace)}), encoding="utf-8",
            )
            report = _build_failure_report(
                task_dir, _task_from_file(task_dir / "task.json"),
                CommandResult("test", "FAIL", command="gate hvigor --module picture_beautification"), 1,
            )
            self.assertEqual("UNATTRIBUTED_TEST_FAILURE", report["classification"])
            self.assertFalse(report["repairable"])

    def test_changed_class_name_in_test_diagnostic_is_repairable_without_target_symbol(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            task_data = self._task(temp)
            task_data["target"]["symbol"] = None
            (task_dir / "task.json").write_text(json.dumps(task_data), encoding="utf-8")
            (task_dir / "refactor-changes.json").write_text(json.dumps({
                "changedProductionFiles": [
                    "features/business_mine/src/main/ets/viewModels/EditNamePageVM.ets",
                ],
            }), encoding="utf-8")
            log = task_dir / "test.log"
            log.write_text(
                "Property 'nickname' does not exist on type 'EditNamePageVM'. "
                "At File: features/business_mine/src/test/EditNamePageVM.test.ets:43:10",
                encoding="utf-8",
            )

            report = _build_failure_report(
                task_dir,
                _task_from_file(task_dir / "task.json"),
                CommandResult("test", "FAIL", output_file=str(log)),
                1,
            )
            self.assertIs(report["repairable"], True)
            self.assertEqual("RELATED_TEST_FAILURE", report["classification"])
    def test_agent_boundary_failure_has_its_own_repair_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            task_dir = Path(temp)
            (
                task_dir
                / "agent-change-attempt-refactor-workspace-repair-1.json"
            ).write_text(
                json.dumps({
                    "candidateProductionFiles": [
                        "src/main/ets/Foo.ets"
                    ],
                    "candidateProductionResources": [],
                    "rejectedFiles": [
                        "build-profile.json5"
                    ],
                }),
                encoding="utf-8",
            )

            failed = CommandResult(
                "repair-agent-1",
                "FAIL",
                exit_code=4,
            )
            report = _build_agent_failure_report(
                task_dir,
                failed,
                2,
            )
            self.assertEqual(
                "MODIFICATION_BOUNDARY_VIOLATION",
                report["classification"],
            )
            self.assertTrue(report["repairable"])
            self.assertEqual(
                "build-profile.json5",
                report["issues"][0]["filePath"],
            )

if __name__ == "__main__":
    unittest.main()
