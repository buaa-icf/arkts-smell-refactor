import json
import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.review_output import final_review_text, format_retry_prompt, parse_review, preserves_review


class ReviewOutputTests(unittest.TestCase):
    def _read(self, events):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "review.log"
            path.write_text("\n".join(json.dumps(event) for event in events), encoding="utf-8")
            return final_review_text(path)

    def test_tool_evidence_is_never_a_verdict(self):
        self.assertEqual("", self._read([{"type": "tool_use", "part": {
            "state": {"output": '{"verdict":"PASS"}'},
        }}]))

    def test_invalid_final_answer_does_not_reuse_earlier_pass(self):
        output = self._read([{"type": "text", "part": {"type": "text", "text": value}} for value in (
            '{"verdict":"PASS"}', '{"verdict":"FAIL","summary":"invalid "quote""}',
        )])
        self.assertIsNone(parse_review(output))
        self.assertIn('"FAIL"', output)

    def test_quote_only_correction_preserves_verdict_and_evidence(self):
        for verdict in ("PASS", "FAIL", "UNCERTAIN"):
            good = json.dumps({"verdict": verdict, "summary": '复检"未命中"。',
                               "smellRemoved": True, "behaviorEquivalent": True,
                               "riskChecks": [], "issues": []}, ensure_ascii=False)
            bad = good.replace('\\"', '"')
            self.assertIsNotNone(format_retry_prompt(bad))
            self.assertTrue(preserves_review(bad, good))
            self.assertFalse(preserves_review(bad, good.replace("复检", "确认")))
            self.assertFalse(preserves_review(bad, good.replace(verdict, "UNKNOWN")))

    def test_format_retry_keeps_string_whitespace_and_rejects_duplicate_keys(self):
        good = json.dumps({"verdict": "FAIL", "summary": 'not equivalent: "x" and \'y\''})
        bad = good.replace('\\"', '"').replace("'", "\\'")
        self.assertTrue(preserves_review(bad, good))
        self.assertFalse(preserves_review(bad, good.replace("not equivalent", "notequivalent")))
        self.assertIsNone(parse_review('{"verdict":"FAIL","verdict":"PASS"}'))

    def test_valid_or_truncated_answer_does_not_request_format_retry(self):
        for text in ('{"verdict":"UNCERTAIN"}', '{"verdict":"PASS","summary":',
                     "looks like PASS", '{"summary":"not a verdict"}'):
            self.assertIsNone(format_retry_prompt(text))

    def test_format_retry_cannot_accept_inconsistent_pass(self):
        for extra in ({"behaviorEquivalent": False}, {"smellRemoved": False},
                      {"riskChecks": [{"status": "uncertain"}]},
                      {"issues": [{"severity": "blocking"}]}):
            good = json.dumps({"verdict": "PASS", "summary": 'review "done"',
                               "smellRemoved": True, "behaviorEquivalent": True,
                               "riskChecks": [], "issues": [], **extra})
            self.assertFalse(preserves_review(good.replace('\\"', '"'), good))


if __name__ == "__main__":
    unittest.main()
