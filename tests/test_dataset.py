import json
import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.dataset import load_dataset_tasks
from arkts_smell_refactor.automatic import _normalize_pasted_data


class DatasetTests(unittest.TestCase):
    def test_accepts_single_pasted_record(self):
        record = {"filePath": "demo/Foo.ets", "messages": []}
        self.assertEqual([record], _normalize_pasted_data(record))

    def test_expands_each_message_to_task(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dataset = root / "positive.json"
            dataset.write_text(
                json.dumps(
                    [
                        {
                            "filePath": "demo/src/main/ets/Foo.ets",
                            "sourceProject": "demo",
                            "commitHash": "abc",
                            "messages": [
                                {
                                    "line": 10,
                                    "column": 3,
                                    "severity": "SUGGESTION",
                                    "message": "Method 'work' is too long.",
                                    "rule": "@extrulesproject/long-method-check",
                                    "rangeStart": 10,
                                    "rangeEnd": 30,
                                },
                                {
                                    "line": 15,
                                    "column": 4,
                                    "severity": "SUGGESTION",
                                    "message": "Switch statement with 6 cases detected in method 'work'.",
                                    "rule": "@extrulesproject/switch-statement-check",
                                    "rangeStart": 15,
                                    "rangeEnd": 25,
                                },
                            ],
                        }
                    ]
                ),
                encoding="utf-8",
            )
            tasks = load_dataset_tasks(dataset, root)
            self.assertEqual(2, len(tasks))
            self.assertEqual("long-method", tasks[0].smell_type)
            self.assertEqual("work", tasks[0].target.symbol)
            self.assertEqual("switch-statement", tasks[1].smell_type)

    def test_test_kind_comes_from_dataset_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            instrument = root / "instrument-test"
            instrument.mkdir()
            dataset = instrument / "feature-envy.json"
            dataset.write_text(json.dumps([{
                "filePath": "demo/src/main/ets/Foo.ets", "sourceProject": "demo",
                "messages": [{"rule": "@extrulesproject/feature-envy-check", "message": "Method 'foo' is feature-envious."}],
            }]), encoding="utf-8")
            self.assertEqual("instrument-test", load_dataset_tasks(dataset, root)[0].raw["testKind"])

    def test_pasted_input_uses_dataset_catalog(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            catalog = root / "arkts-code-smell/dataset/positive/local-test"
            catalog.mkdir(parents=True)
            record = {"filePath": "demo/src/main/ets/Foo.ets", "sourceProject": "demo", "messages": [
                {"rule": "@extrulesproject/long-method-check", "message": "Method 'foo' is too long."}
            ]}
            (catalog / "long-method.json").write_text(json.dumps([record]), encoding="utf-8")
            pasted = root / "runs/input.json"
            pasted.parent.mkdir()
            pasted.write_text(json.dumps([record]), encoding="utf-8")
            self.assertEqual("local-test", load_dataset_tasks(pasted, root)[0].raw["testKind"])

    def test_rejects_cleanarch_shape(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dataset = root / "data-clumps.json"
            dataset.write_text('[{"path":"A.constructor","NOPAR":8}]', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "第一版暂不支持"):
                load_dataset_tasks(dataset, root)


if __name__ == "__main__":
    unittest.main()
