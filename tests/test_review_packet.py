import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from arkts_smell_refactor.gate import main as gate_main
from arkts_smell_refactor.review_packet import prepare_review_prompt
from arkts_smell_refactor.utils import read_json, write_json, write_text


class ReviewPacketTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.relative = "src/Page.ets"
        self.prompt = self.root / "review-prompt.md"
        write_text(self.prompt, "独立检查所有语义风险，证据不足须 UNCERTAIN。")
        write_json(self.root / "refactor-changes.json", {"changedProductionFiles": [self.relative]})
        write_json(self.root / "review-risk.json", {"riskLevel": "high", "risks": [
            {"code": "UI_SELECTOR_CHANGE", "evidence": "逐一代入参数核对 ID"},
        ]})
        write_json(self.root / "review-context.json", {"productionDependencies": ["src/Helper.ets"]})
        write_text(self.root / "review-context-production/src/Helper.ets", "export function helper() {}")
        self.gates = {"attempt": 0, "validationPolicy": {"linterMode": "required"}, "gates": [
            {"name": name, "status": "PASS", "exit_code": 0, "command": "not-needed-build-command"}
            for name in ("smell", "build", "contract", "test", "linter")
        ]}
        write_json(self.root / "gates.json", self.gates)
        for name, data in {
            "smell-after.json": [], "linter-after.json": [],
            "public-contract-results.json": {"passed": True},
            "test-results.json": {"status": "PASS", "jobs": [
                {"status": "PASS", "summary": {"tests": 5, "passed": 5}, "testFiles": ["forbidden.test.ets"]},
            ]},
        }.items():
            write_json(self.root / name, data)
        write_text(self.root / "review-diff.patch", "--- baseline/src/Page.ets\n+++ current/src/Page.ets\n-old\n+new")
        self.before = b"\xef\xbb\xbf// common\r\nold\r\n// end\r\n"
        self.after = "// common\nnew('\ue001中文')\n// end\n".encode("utf-8")
        for folder, raw in (("baseline-production", self.before), ("current-production", self.after)):
            path = self.root / folder / self.relative
            path.parent.mkdir(parents=True)
            path.write_bytes(raw)

    def prepare(self):
        prompt = prepare_review_prompt(self.root, self.prompt).read_text(encoding="utf-8")
        return read_json(self.root / "review-packet.json"), prompt

    def test_complete_packet_preserves_source_risks_and_gate_evidence(self):
        manifest, prompt = self.prepare()
        change = manifest["changedFiles"][0]
        self.assertTrue(change["before"]["inline"])
        self.assertTrue(change["after"]["inline"])
        self.assertEqual(3, change["after"]["lines"])
        self.assertEqual(hashlib.sha256(self.before).hexdigest(), change["before"]["sha256"])
        self.assertEqual({"identicalPrefixLines": 1, "identicalSuffixLines": 1}, change["textComparison"])
        self.assertFalse(change["byteIdentical"])
        self.assertIn("2: new('\ue001中文')", prompt)
        self.assertIn("UI_SELECTOR_CHANGE", prompt)
        self.assertIn('"passed": 5', prompt)
        self.assertIn("--- baseline/src/Page.ets", prompt)
        self.assertEqual([{"path": "review-context-production/src/Helper.ets", "exists": True, "inline": False}],
                         manifest["dependencies"])
        self.assertNotIn("forbidden.test.ets", prompt)
        self.assertNotIn("not-needed-build-command", prompt)
        self.assertEqual(self.before, (self.root / "baseline-production" / self.relative).read_bytes())
        self.assertEqual(self.after, (self.root / "current-production" / self.relative).read_bytes())

    def test_limits_defer_whole_evidence_without_silent_truncation(self):
        with patch("arkts_smell_refactor.review_packet.MAX_INLINE_SOURCE_CHARS", 1), patch(
            "arkts_smell_refactor.review_packet.MAX_INLINE_DIFF_CHARS", 1
        ), patch("arkts_smell_refactor.review_packet.MAX_INLINE_JSON_CHARS", 1):
            manifest, prompt = self.prepare()
        self.assertFalse(manifest["changedFiles"][0]["before"]["inline"])
        self.assertFalse(manifest["changedFiles"][0]["after"]["inline"])
        self.assertFalse(manifest["diff"]["inline"])
        self.assertEqual(0, manifest["inlineSourceChars"])
        self.assertNotIn("2: new", prompt)
        self.assertNotIn("--- baseline/src/Page.ets", prompt)
        self.assertIn("未截断", prompt)
        self.assertIn("baseline-production/src/Page.ets", prompt)
        self.assertTrue(all(not item["inline"] for item in manifest["evidence"]))

    def test_unicode_separators_and_markdown_inside_source_are_data(self):
        text = 'const s = "中文\u2028\u0085```";\n'
        (self.root / "current-production" / self.relative).write_text(text, encoding="utf-8")
        manifest, prompt = self.prepare()
        self.assertEqual(1, manifest["changedFiles"][0]["after"]["lines"])
        self.assertIn('1: const s = "中文\u2028\u0085```";', prompt)
        self.assertIn('````\n1: const s', prompt)

    def test_regenerated_after_repair_and_does_not_reuse_skipped_gate_results(self):
        self.prepare()
        write_text(self.root / "current-production" / self.relative, "repaired")
        self.gates["attempt"] = 1
        self.gates["validationPolicy"]["linterMode"] = "skip"
        for row in self.gates["gates"]:
            if row["name"] == "linter":
                row["status"] = "SKIPPED"
            row["name"] += "-repair-1"
        write_json(self.root / "gates.json", self.gates)
        write_json(self.root / "linter-after.json", ["STALE-LINTER-DIAGNOSTIC"])
        manifest, prompt = self.prepare()
        self.assertEqual(1, manifest["gateAttempt"])
        self.assertIn("1: repaired", prompt)
        self.assertNotIn("2: new", prompt)
        self.assertNotIn("STALE-LINTER-DIAGNOSTIC", prompt)
        details = {item["path"]: item for item in manifest["evidence"]}
        self.assertFalse(details["linter-after.json"]["inline"])
        self.assertTrue(details["test-results.json"]["inline"])

    def test_addition_deletion_and_binary_resource_remain_explicit(self):
        (self.root / "baseline-production" / self.relative).unlink()
        deleted = "src/Removed.ets"
        write_text(self.root / "baseline-production" / deleted, "removed")
        resource = "resources/icon.bin"
        path = self.root / "current-production" / resource
        path.parent.mkdir(parents=True)
        path.write_bytes(b"\xff\x00\x80")
        write_json(self.root / "refactor-changes.json", {
            "changedProductionFiles": [self.relative, deleted], "changedProductionResources": [resource],
        })
        manifest, prompt = self.prepare()
        added, removed, binary = manifest["changedFiles"]
        self.assertFalse(added["before"]["exists"])
        self.assertFalse(removed["after"]["exists"])
        self.assertTrue(binary["after"]["exists"])
        self.assertFalse(binary["after"]["inline"])
        self.assertNotIn("textComparison", binary)
        self.assertIn("非 UTF-8", prompt)

    def test_missing_dependency_and_optional_details_are_not_success_evidence(self):
        (self.root / "review-context-production/src/Helper.ets").unlink()
        (self.root / "smell-after.json").unlink()
        manifest, prompt = self.prepare()
        self.assertFalse(manifest["dependencies"][0]["exists"])
        self.assertIn("依赖缺失或证据不足仍须 UNCERTAIN", prompt)
        detail = next(item for item in manifest["evidence"] if item["path"] == "smell-after.json")
        self.assertFalse(detail["inline"])

    def test_paths_cannot_escape_snapshots(self):
        for relative in ("../outside.ets", "src/../../outside.ets", "C:/outside.ets", "/outside.ets"):
            with self.subTest(relative=relative):
                write_json(self.root / "refactor-changes.json", {"changedProductionFiles": [relative]})
                with self.assertRaises(ValueError):
                    self.prepare()
        write_json(self.root / "refactor-changes.json", {"changedProductionFiles": [self.relative]})
        write_json(self.root / "review-context.json", {"productionDependencies": ["../outside.ets"]})
        with self.assertRaises(ValueError):
            self.prepare()

    def test_malformed_required_evidence_blocks_before_starting_model(self):
        # Even if a prior attachment exists, it must not be used after failure.
        self.prepare()
        (self.root / "gates.json").write_text("invalid-json", encoding="utf-8")
        output = io.StringIO()
        with patch("arkts_smell_refactor.gate.run_agent") as run, redirect_stdout(output):
            result = gate_main(["review", "--task-dir", str(self.root), "--deveco", "deveco",
                                "--prompt-file", str(self.prompt)])
        self.assertEqual(3, result)
        run.assert_not_called()
        self.assertIn("REVIEW_PACKET_BLOCKED", json.loads(output.getvalue())["error"]["data"]["message"])

    def test_format_only_does_not_attach_sources_or_start_another_semantic_review(self):
        (self.root / "gates.json").unlink()
        with patch("arkts_smell_refactor.gate.run_agent", return_value=0) as run:
            result = gate_main(["review", "--task-dir", str(self.root), "--deveco", "deveco",
                                "--prompt-file", str(self.prompt), "--format-only"])
        self.assertEqual(0, result)
        self.assertEqual(self.prompt.resolve(), run.call_args.args[3])
        self.assertEqual("review-format", run.call_args.kwargs["role"])
        self.assertTrue(run.call_args.kwargs["format_only"])
        self.assertFalse(run.call_args.kwargs["prompt_via_stdin"])
        self.assertFalse((self.root / "review-agent-prompt.md").exists())
