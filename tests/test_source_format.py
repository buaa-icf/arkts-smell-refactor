import json
import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.source_format import preserve_source_format
from arkts_smell_refactor.gate import _sync_production_changes


class SourceFormatTests(unittest.TestCase):
    def test_sync_preserves_bom_crlf_and_literal_bytes_with_original_baseline(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, mirror = root / "source", root / "task/refactor-workspace"
            relative = Path("entry/src/main/ets/Foo.ets")
            for directory in (source, mirror):
                (directory / relative).parent.mkdir(parents=True)
            before = b"\xef\xbb\xbf" + "const title = 'raw\ue74d';\r\nconst x = 1;\r\n".encode("utf-8")
            edited = "const title = 'raw\ue74d';\nconst x = 2;\n".encode("utf-8")
            (source / relative).write_bytes(before)
            (mirror / relative).write_bytes(edited)
            self.assertEqual(0, _sync_production_changes(mirror, source))
            self.assertEqual(before.replace(b"x = 1", b"x = 2"), (source / relative).read_bytes())
            self.assertEqual(before, (mirror.parent / "baseline-production" / relative).read_bytes())
            self.assertEqual(edited, (mirror / relative).read_bytes())
            self.assertEqual([relative.as_posix()], json.loads((mirror.parent / "refactor-changes.json").read_text(encoding="utf-8"))["sourceFormatsPreserved"])

    def test_lf_and_no_bom_follow_original(self):
        self.assertEqual(b"a\nb\n", preserve_source_format(b"a\n", b"\xef\xbb\xbfa\r\nb\r\n"))

    def test_mixed_template_and_continuation_newlines_are_not_rewritten(self):
        for before, edited in ((b"a\r\nb\n", b"x\n"),
                               (b"const x = `a\r\nb`;\r\n", b"const x = `a\nb`;\n"),
                               (b"'a\\\r\nb'\r\n", b"'a\\\nb'\n")):
            self.assertEqual(edited, preserve_source_format(before, edited))

    def test_non_utf8_payload_is_not_transcoded(self):
        self.assertEqual(b"new\xff\n", preserve_source_format(b"old\xff\r\n", b"new\xff\n"))
