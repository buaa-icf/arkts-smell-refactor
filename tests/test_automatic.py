import json
import sys
import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.automatic import _auto_config
from arkts_smell_refactor.models import RefactorTask, Target
from arkts_smell_refactor.runner import _context, _run_spec, execute_pipeline


class AutomaticConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "hvigor").mkdir()
        (self.root / "hvigor/hvigor-config.json5").write_text("{}", encoding="utf-8")
        (self.root / "build-profile.json5").write_text("{}", encoding="utf-8")
        self.target = "entry/src/main/ets/ScheduleForm.ets"
        target_path = self.root / self.target
        target_path.parent.mkdir(parents=True)
        target_path.write_text("struct ScheduleForm {}", encoding="utf-8")
        self.task = RefactorTask(
            schema_version="1.0", task_id="long-method-0001-build", source_project="demo",
            commit_hash="", workspace_root=str(self.root), project_root=str(self.root),
            smell_type="long-method", rule="@extrulesproject/long-method-check",
            severity="SUGGESTION", message="Method 'build' is too long.",
            target=Target(self.target, "build"), raw={},
        )
        self.task_dir = self.root / "task"
        self.task_dir.mkdir()
        (self.task_dir / "task.json").write_text(json.dumps(self.task.to_dict()), encoding="utf-8")
        (self.task_dir / "risk-report.json").write_text("{}", encoding="utf-8")
        (self.task_dir / "refactor-changes.json").write_text(
            json.dumps({"changedProductionFiles": [self.target]}), encoding="utf-8"
        )
        self.config = _auto_config(self.task, self.task_dir, {}, {
            "deveco": "deveco", "hvigorw": "hvigorw", "ohpm": None,
            "homecheck": str(self.root / "homecheck"), "codelinter": "codelinter",
        })
        self.config["reviewAgent"]["retryDelaySeconds"] = 0

    def _output_spec(self, spec, output, exit_code=1):
        return spec | {"command": [
            sys.executable, "-c", f"print({output!r}); raise SystemExit({exit_code})",
        ]}

    def _run_output(self, name, spec, output, exit_code=1):
        return _run_spec(
            name, self._output_spec(spec, output, exit_code), _context(self.task_dir, self.task),
            str(self.root), self.task_dir, False,
        )

    def test_compile_errors_with_process_libs_are_failures(self):
        diagnostics = (
            "No overload matches this call.\n"
            "Argument of type 'string | undefined' is not assignable to parameter of type "
            "'string | number | Date'. At File: entry/src/main/ets/ScheduleForm.ets:419:44",
            "Argument of type 'string | undefined' is not assignable to parameter of type "
            "'string'. At File: entry/src/main/ets/GoodDetailPage.ets:383:28",
        )
        for stage in ("build", "test"):
            for diagnostic in diagnostics:
                with self.subTest(stage=stage, diagnostic=diagnostic):
                    result = self._run_output(stage, self.config["gates"][stage],
                        "> hvigor Finished :common:default@ProcessLibs... after 7 ms\n"
                        "> hvigor ERROR: ArkTS Compiler Error\nError Message: " + diagnostic +
                        "\nCOMPILE RESULT:FAIL {ERROR:3 WARN:54}\n> hvigor ERROR: BUILD FAILED")
                    self.assertEqual("FAIL", result.status)

    def test_successful_signing_and_type_signatures_are_not_blockers(self):
        output = (
            "> hvigor Finished :entry:default@SignHap... after 10 ms\n"
            "ArkTS Compiler Error: Call signature is incompatible in ScheduleForm.ets"
        )
        result = self._run_output("build", self.config["gates"]["build"], output)
        self.assertEqual("FAIL", result.status)

    def test_environment_errors_remain_blocked_with_match_evidence(self):
        for output in (
            "SSL handshake failed", "TLS connection failed", "SSL_ERROR_SYSCALL",
            "CERT_HAS_EXPIRED", "unknown certificate verification error",
            "Failed :entry:default@SignHap: Invalid storeFile value", "device not found",
        ):
            with self.subTest(output=output):
                result = self._run_output("build", self.config["gates"]["build"], output)
                self.assertEqual("BLOCKED", result.status)
                self.assertIn("匹配：", result.reason)
                self.assertTrue(any(word in result.reason for word in output.split()))

    def test_all_agents_classify_certificate_errors_as_blocked(self):
        output = json.dumps({"type": "error", "error": {
            "name": "UnknownError", "data": {"message": "unknown certificate verification error"},
        }})
        for name in ("refactorAgent", "repairAgent", "reviewAgent"):
            with self.subTest(agent=name):
                result = self._run_output(name, self.config[name], output)
                self.assertEqual("BLOCKED", result.status)
                self.assertIn("certificate verification", result.reason)

    def test_review_certificate_failure_does_not_start_code_repair(self):
        config = self.config
        config["refactorAgent"] = self._output_spec(config["refactorAgent"], "", 0)
        config["repairAgent"]["command"] = ["must-not-run"]
        for name, spec in config["gates"].items():
            config["gates"][name] = self._output_spec(spec, "", 0)
        config["reviewAgent"] = self._output_spec(
            config["reviewAgent"], "UnknownError: unknown certificate verification error"
        )
        result = execute_pipeline(self.task_dir, config)
        self.assertEqual("BLOCKED", result["verdict"])
        self.assertEqual(0, result["repairAttempts"])
        self.assertEqual(2, result["reviewRetries"])
        self.assertEqual("BLOCKED", result["steps"][-1]["status"])
        self.assertTrue(all(step["status"] == "PASS" for step in result["steps"][:5]))
        self.assertEqual(3, sum(step["name"].startswith("review-agent") for step in result["steps"]))
        self.assertFalse((self.task_dir / "failure-report-1.json").exists())
        self.assertFalse(any(step["name"].startswith("repair-agent") for step in result["steps"]))

    def test_review_certificate_retry_recovers_to_pass(self):
        config = self.config
        config["refactorAgent"] = self._output_spec(config["refactorAgent"], "", 0)
        config["repairAgent"]["command"] = ["must-not-run"]
        for name, spec in config["gates"].items():
            config["gates"][name] = self._output_spec(spec, "", 0)
        config["reviewAgent"]["command"] = [sys.executable, "-c",
            "import json; from pathlib import Path; "
            "marker = Path('review-retried'); first = not marker.exists(); marker.touch(); "
            "print('unknown certificate verification error' if first else "
            "json.dumps(dict(verdict='PASS', issues=[]))); raise SystemExit(1 if first else 0)"]
        result = execute_pipeline(self.task_dir, config)
        self.assertEqual("PASS", result["verdict"])
        self.assertEqual(0, result["repairAttempts"])
        self.assertEqual(1, result["reviewRetries"])
        self.assertTrue((self.task_dir / "review-agent.log").exists())
        self.assertTrue((self.task_dir / "review-agent-retry-1.log").exists())
        self.assertTrue((self.task_dir / "review-retry-1.json").exists())
        self.assertFalse((self.task_dir / "failure-report-1.json").exists())

    def test_attributed_compile_failure_enters_repair_and_restarts_gates(self):
        config = self.config
        for name in ("refactorAgent", "repairAgent"):
            config[name] = self._output_spec(config[name], "", 0)
        config["reviewAgent"] = self._output_spec(
            config["reviewAgent"], json.dumps({"verdict": "PASS", "issues": []}), 0
        )
        for name, spec in config["gates"].items():
            config["gates"][name] = self._output_spec(spec, "", 0)
        config["gates"]["build"]["command"] = [sys.executable, "-c",
            "from pathlib import Path; "
            "print('Finished :entry:default@ProcessLibs\\nArkTS Compiler Error: "
            "ScheduleForm.ets:419:44: string | undefined is not assignable'); "
            "raise SystemExit(0 if Path('repaired').exists() else 1)"]
        config["repairAgent"]["command"] = [sys.executable, "-c",
            "import sys; from pathlib import Path; "
            "prompt = Path(sys.argv[1]).read_text(encoding='utf-8'); "
            "assert 'ScheduleForm.ets:419:44: string | undefined is not assignable' in prompt; "
            "Path('repaired').write_text('ok')", "{repair_prompt_file}"]
        result = execute_pipeline(self.task_dir, config)
        steps = {item["name"]: item["status"] for item in result["steps"]}
        self.assertEqual("PASS", result["verdict"])
        self.assertEqual(1, result["repairAttempts"])
        self.assertEqual("FAIL", steps["build"])
        self.assertTrue(all(steps[name] == "SKIPPED" for name in ("test", "linter", "review-agent")))
        self.assertTrue(all(steps[name + "-repair-1"] == "PASS"
                            for name in ("smell", "build", "test", "linter", "review-agent")))
        report = json.loads((self.task_dir / "failure-report-1.json").read_text(encoding="utf-8"))
        self.assertTrue(report["repairable"])
        self.assertEqual("INTRODUCED_BUILD_FAILURE", report["classification"])


if __name__ == "__main__":
    unittest.main()
