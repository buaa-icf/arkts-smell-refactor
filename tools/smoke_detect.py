"""Real HomeCheck integration smoke; writes only under the project's build directory."""
import importlib.util
import json
from pathlib import Path

workspace = Path(__file__).resolve().parents[1]
adapter_path = workspace / "src/main/resources/bridge/ide_bridge.py"
spec = importlib.util.spec_from_file_location("adapter", adapter_path)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

root = workspace / "build/smoke-detection/Example"
source = root / "entry/src/main/ets/LongMethod.ets"
source.parent.mkdir(parents=True, exist_ok=True)
source.write_text("export class LongMethod {\n  calculate(): number {\n    let total = 0;\n" +
                  "    total += 1;\n" * 160 + "    return total;\n  }\n}\n", encoding="utf-8")
config = {"node": "D:/tool/NodeJs/node.exe", "studio": "D:/tool/DevEco/DevEco Studio",
          "backend": str(workspace.parent.parent / "arkts-smell-refactor"),
          "homecheck": str(workspace.parent.parent / "arkts异味检查工具/homecheck-extrule"),
          "runs": str(workspace / "build/smoke-detection/runs")}
adapter.configure_environment(config)
run = adapter.create_run(config, root, "scan.start")
result = adapter.scan({"rules": ["@extrulesproject/long-method-check"]}, config, root, run)
assert result["issues"], "A 160-statement method should produce a real long-method finding"
assert source.read_text(encoding="utf-8").count("total += 1") == 160
print(json.dumps({"realHomeCheck": "PASS", "issues": len(result["issues"]), "report": result["reportPath"]}, ensure_ascii=False))
