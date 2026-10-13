import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from arkts_smell_refactor.utils import iter_source_files


class SourceWalkTests(unittest.TestCase):
    def test_preserves_source_selection_without_entering_ignored_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ignored = {".git", "build", "node_modules", "oh_modules", ".hvigor", ".test"}
            included = {
                "module/src/main/ets/Page.ets", "module/src/main/ets/helper.TS",
                "module/src/test/Page.test.ets", "module/src/ohosTest/Page.test.ets",
                "module/mybuild/Keep.ts", "root.ts",
            }
            excluded = {"module/src/main/resources/data.json"}
            excluded.update(f"module/{name}/nested/generated.ets" for name in ignored)
            for relative in included | excluded:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("source", encoding="utf-8")
            # A directory ending in .ets is not itself a source file.
            (root / "empty.ets").mkdir()
            expected = {
                path for path in root.rglob("*")
                if path.is_file() and path.suffix.lower() in {".ets", ".ts"}
                and not any(part in ignored for part in path.parts)
            }
            scandir = os.scandir
            visited = []

            def check_directory(path):
                current = Path(path)
                visited.append(current)
                self.assertFalse(any(part in ignored for part in current.relative_to(root).parts))
                return scandir(path)

            with patch("arkts_smell_refactor.utils.os.scandir", side_effect=check_directory):
                actual = set(iter_source_files(root))
            self.assertTrue(visited)
            self.assertEqual(expected, actual)
            self.assertEqual(included, {path.relative_to(root).as_posix() for path in actual})

    def test_ignored_root_is_not_traversed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "build"
            root.mkdir()
            (root / "generated.ets").write_text("source", encoding="utf-8")
            with patch("arkts_smell_refactor.utils.os.scandir") as scan:
                self.assertEqual([], list(iter_source_files(root)))
            scan.assert_not_called()

    def test_missing_root_returns_no_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual([], list(iter_source_files(Path(temp) / "missing")))


if __name__ == "__main__":
    unittest.main()
