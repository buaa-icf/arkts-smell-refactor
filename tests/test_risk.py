import json
import tempfile
import unittest
from pathlib import Path

from arkts_smell_refactor.dataset import load_dataset_tasks
from arkts_smell_refactor.risk import analyze_risks


class RiskTests(unittest.TestCase):
    def test_finds_production_and_test_callers(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "demo"
            target = project / "src/main/ets/model/User.ets"
            production = project / "src/main/ets/pages/Home.ets"
            test = project / "src/test/User.test.ets"
            target.parent.mkdir(parents=True)
            production.parent.mkdir(parents=True)
            test.parent.mkdir(parents=True)
            target.write_text("export class UserInfo { public static convert(v: number): number { return v; } }", encoding="utf-8")
            production.write_text("const value = UserInfo.convert(1);", encoding="utf-8")
            test.write_text("expect(UserInfo.convert(1)).assertEqual(1);", encoding="utf-8")
            dataset = root / "positive.json"
            dataset.write_text(
                json.dumps(
                    [
                        {
                            "filePath": "demo/src/main/ets/model/User.ets",
                            "sourceProject": "demo",
                            "commitHash": "abc",
                            "messages": [
                                {
                                    "line": 1,
                                    "column": 1,
                                    "severity": "SUGGESTION",
                                    "message": "Method 'convert' is feature-envious toward 'Other'.",
                                    "rule": "@extrulesproject/feature-envy-check",
                                    "rangeStart": 1,
                                    "rangeEnd": 1,
                                }
                            ],
                        }
                    ]
                ),
                encoding="utf-8",
            )
            risk = analyze_risks(load_dataset_tasks(dataset, root)[0])
            self.assertEqual(1, risk["callers"]["total"])
            self.assertEqual(1, risk["callers"]["production"])
            self.assertEqual(0, risk["callers"]["test"])
            self.assertNotIn("TEST_REFERENCE_BREAK", {item["code"] for item in risk["risks"]})

    def test_does_not_mix_same_named_methods_from_other_class(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "demo"
            target = project / "src/main/ets/AccountCard.ets"
            other = project / "src/main/ets/RechargePage.ets"
            own_test = project / "src/test/AccountCard.test.ets"
            other_test = project / "src/test/RechargePage.test.ets"
            for path in (target, other, own_test, other_test):
                path.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("export struct AccountCard { update(v: number) {} }", encoding="utf-8")
            other.write_text("export struct RechargePage { update(v: number) { this.update(v); } }", encoding="utf-8")
            own_test.write_text("card.update(1);", encoding="utf-8")
            other_test.write_text("page.update(1);", encoding="utf-8")
            dataset = root / "positive.json"
            dataset.write_text(json.dumps([{"filePath":"demo/src/main/ets/AccountCard.ets","sourceProject":"demo","commitHash":"","messages":[{"line":1,"message":"Method 'update' is feature-envious toward 'Other'.","rule":"@extrulesproject/feature-envy-check","rangeStart":1,"rangeEnd":1}]}]), encoding="utf-8")
            risk = analyze_risks(load_dataset_tasks(dataset, root)[0])
            paths = {item["filePath"] for item in risk["callers"]["items"]}
            self.assertNotIn("demo/src/test/AccountCard.test.ets", paths)
            self.assertNotIn("demo/src/test/RechargePage.test.ets", paths)
            self.assertNotIn("demo/src/main/ets/RechargePage.ets", paths)


if __name__ == "__main__":
    unittest.main()
