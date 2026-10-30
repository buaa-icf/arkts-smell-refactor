import unittest

from arkts_smell_refactor.analysis.literals import long_literal_segments, shared_literal_groups


class LiteralAnalysisTests(unittest.TestCase):
    def test_comments_and_indentation_do_not_change_exact_token_fingerprint(self):
        first = "'" + "协议" * 110 + "'"
        second = "'end\\n\ue74d'"
        a = "Text(" + first + " +\n  " + second + ").id('content')"
        b = "// 'ignored'\nText(" + first + " /* explain 'ignored' */ +\n    " + second + ")"
        left = long_literal_segments(a, 1, 3)[0]
        right = long_literal_segments(b, 1, 4)[0]
        self.assertEqual(left["tokenSha256"], right["tokenSha256"])
        self.assertEqual(2, left["literalCount"])
        lines = a.splitlines()
        self.assertEqual("'", lines[left["startLine"] - 1][left["startColumn"] - 1])
        self.assertEqual(")", lines[left["endLine"] - 1][left["endColumnExclusive"] - 1])
        groups = shared_literal_groups([{"filePath": "A.ets", "longLiteralSegments": [left]},
                                        {"filePath": "B.ets", "longLiteralSegments": [right]}])
        self.assertEqual(1, len(groups))

    def test_templates_comments_and_dynamic_operands_are_not_folded(self):
        token = "'" + "x" * 220 + "'"
        self.assertEqual([], long_literal_segments("/* " + token + " */\n`" + "x" * 220 + "${value}`", 1, 9))
        segments = long_literal_segments(token + " + value + " + token, 1, 1)
        self.assertEqual([1, 1], [segment["literalCount"] for segment in segments])
        self.assertEqual([], shared_literal_groups([{"filePath": "A", "longLiteralSegments": segments}]))

    def test_private_use_character_and_source_escape_spelling_are_not_normalized(self):
        prefix = "'" + "x" * 220
        raw = long_literal_segments(prefix + "\ue74d'", 1, 1)[0]
        escaped = long_literal_segments(prefix + r"\ue74d'", 1, 1)[0]
        removed = long_literal_segments(prefix + "'", 1, 1)[0]
        self.assertEqual(3, len({x["tokenSha256"] for x in (raw, escaped, removed)}))

    def test_segments_outside_reported_range_are_excluded(self):
        self.assertEqual([], long_literal_segments("Text('" + "x" * 220 + "')\nnext()", 2, 3))
