"""Execute the selected tests and require fresh evidence of actual Hypium cases."""
from __future__ import annotations

import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from .utils import write_json


TEST_TOOL_BLOCKERS = (
    r"Connect server failed|\[Empty\]|no (?:available |connected )?devices?\b|device not found|"
    r"device[^\r\n]*(?:offline|not connected)|\bFailed[^\r\n]*@SignHap\b|"
    r"Invalid storeFile value|(?:hap/hsp|hap|hsp) package is signed"
)


def _result_evidence(path: Path, expected_suites: list[str]) -> dict[str, Any]:
    if not path.is_file():
        return {"status": "BLOCKED", "reason": "missing fresh test_result.txt"}
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    matches = re.findall(r"Tests run:\s*(\d+),\s*Failure:\s*(\d+),\s*Error:\s*(\d+),\s*Pass:\s*(\d+)", text)
    successes: dict[str, int] = {}
    current_suite = ""
    failed_case = False
    for line in text.splitlines():
        if line.startswith("class="):
            current_suite = line.removeprefix("class=").strip()
        elif line.startswith("result="):
            result = line.removeprefix("result=").strip()
            if result == "Success":
                successes[current_suite] = successes.get(current_suite, 0) + 1
            elif result.lower() not in {"ignore", "ignored", "skip", "skipped"}:
                failed_case = True
    summary = dict(zip(("tests", "failures", "errors", "passed"), map(int, matches[-1]))) if matches else None
    evidence: dict[str, Any] = {"summary": summary, "suitePassCounts": successes}
    if failed_case or (summary and (summary["failures"] or summary["errors"])):
        return evidence | {"status": "FAIL", "reason": "Hypium test cases failed"}
    if not summary or summary["tests"] <= 0 or summary["passed"] != summary["tests"]:
        return evidence | {"status": "BLOCKED", "reason": "missing, empty or incomplete Hypium summary"}
    missing = [name for name in expected_suites if not successes.get(name)]
    if missing:
        return evidence | {"status": "BLOCKED", "reason": "expected suites did not execute: " + ", ".join(missing)}
    if sum(successes.values()) != summary["passed"]:
        return evidence | {"status": "BLOCKED", "reason": "case results do not match Hypium summary"}
    return evidence | {"status": "PASS", "reason": "fresh Hypium cases passed"}


def run_test_plan(
    task_dir: Path, workspace: Path, plan: dict[str, Any], launcher: list[str], env: dict[str, str],
) -> int:
    if not plan.get("jobs"):
        print("TEST_GATE_BLOCKED: empty test plan", flush=True)
        write_json(task_dir / "test-results.json", {"status": "BLOCKED", "reason": "empty test plan", "jobs": []})
        return 3
    attempt = task_dir / "test-attempts" / str(time.time_ns())
    attempt.mkdir(parents=True)
    write_json(attempt / "plan.json", plan)
    results: dict[str, Any] = {"schemaVersion": "1.0", "plan": str(attempt / "plan.json"), "status": "RUNNING", "jobs": []}
    write_json(task_dir / "test-results.json", results)
    for index, job in enumerate(plan["jobs"], 1):
        evidence_dir = attempt / f"{index:02d}-{job['kind']}"
        evidence_dir.mkdir()
        variant = "ohosTest" if job["kind"] == "instrument" else "test"
        artifacts = workspace / job["modulePath"] / ".test/default/intermediates" / variant / "coverage_data"
        # Only remove generated evidence inside our validation copy. A previous
        # repair attempt or suite must never supply the next invocation's PASS.
        if not artifacts.resolve().is_relative_to(workspace.resolve()):
            raise ValueError("Test artifacts escape validation workspace")
        for name in ("test_result.txt", "coverage.log", "js_coverage.json"):
            (artifacts / name).unlink(missing_ok=True)
        selector = job["module"] + ("@ohosTest" if job["kind"] == "instrument" else "")
        command = [*launcher, "--no-daemon", job["task"], "-p", f"module={selector}", "-p", "coverage=true"]
        if job["scope"]:
            command.extend(["-p", f"scope={job['scope']}"])
        if job["kind"] == "instrument":
            command.extend(["-p", "ohos-debug-asan=true"])
        print(f"TEST_SELECTION kind={job['kind']} module={selector} scope={job['scope'] or '*'} reason={job['reason']}", flush=True)
        started = time.monotonic()
        try:
            completed = subprocess.run(command, cwd=workspace, env=env, capture_output=True,
                                       text=True, encoding="utf-8", errors="replace")
            output = (completed.stdout or "") + (completed.stderr or "")
            exit_code = completed.returncode
            evidence = _result_evidence(artifacts / "test_result.txt", job["expectedSuites"])
            if exit_code != 0:
                evidence["status"] = "BLOCKED" if re.search(TEST_TOOL_BLOCKERS, output, re.IGNORECASE) else "FAIL"
                evidence["reason"] = f"Hvigor exited with code {exit_code}; " + evidence["reason"]
        except OSError as error:
            output, exit_code = str(error), None
            evidence = {"status": "BLOCKED", "reason": "cannot launch Hvigor: " + str(error)}
        log = evidence_dir / "hvigor.log"
        log.write_text(output, encoding="utf-8")
        print(output, end="" if output.endswith("\n") else "\n", flush=True)
        copied = {}
        for name in ("test_result.txt", "coverage.log"):
            artifact = artifacts / name
            if artifact.is_file():
                saved = evidence_dir / name
                shutil.copy2(artifact, saved)
                copied[name] = str(saved)
                if evidence["status"] != "PASS":
                    # Preserve device assertion/stack diagnostics for the repair classifier.
                    print(saved.read_text(encoding="utf-8", errors="replace")[-12000:], flush=True)
        result = job | evidence | {
            "selectionReason": job["reason"],
            "command": command, "exitCode": exit_code, "durationSeconds": round(time.monotonic() - started, 3),
            "log": str(log), "artifacts": copied,
        }
        results["jobs"].append(result)
        failed = evidence["status"] != "PASS"
        results["status"] = evidence["status"] if failed else ("PASS" if index == len(plan["jobs"]) else "RUNNING")
        results["pendingJobs"] = plan["jobs"][index:]
        write_json(attempt / "results.json", results)
        write_json(task_dir / "test-results.json", results)
        print(f"TEST_RESULT kind={job['kind']} module={selector} status={evidence['status']} {evidence['reason']}", flush=True)
        if failed:
            if evidence["status"] == "BLOCKED":
                print("TEST_GATE_BLOCKED: " + evidence["reason"], flush=True)
            return 3 if evidence["status"] == "BLOCKED" else 1
    return 0
