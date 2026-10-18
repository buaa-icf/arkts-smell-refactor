"""Real JSONL/HomeCheck smoke. Reports stay in build; an explicit target is never edited."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

workspace = Path(__file__).resolve().parents[1]
adapter_path = workspace / "src/main/resources/bridge/ide_bridge.py"
parser = argparse.ArgumentParser()
parser.add_argument("--project", type=Path)
parser.add_argument("--file", type=Path)
parser.add_argument("--runs", type=Path, help="Override run storage to reproduce the IDE cache location")
parser.add_argument("--adapter", type=Path, help="Exercise an extracted plugin adapter instead of the source resource")
args = parser.parse_args()
if args.adapter:
    adapter_path = args.adapter.resolve()
if bool(args.project) != bool(args.file):
    parser.error("--project and --file must be supplied together")
if args.file:
    root, source = args.project.resolve(), args.file.resolve()
    assert source.is_relative_to(root) and source.is_file(), "Target must exist inside the project"
else:
    root = workspace / "build/smoke-detection/Example"
    source = root / "entry/src/main/ets/LongMethod.ets"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("export class LongMethod {\n  calculate(): number {\n    let total = 0;\n" +
                      "    total += 1;\n" * 160 + "    return total;\n  }\n}\n", encoding="utf-8")
before = hashlib.sha256(source.read_bytes()).hexdigest()
config = {"node": "D:/tool/NodeJs/node.exe", "studio": "D:/tool/DevEco/DevEco Studio",
          "backend": str(workspace.parent.parent / "arkts-smell-refactor"),
          "homecheck": str(workspace.parent.parent / "arkts异味检查工具/homecheck-extrule"),
          "runs": str(args.runs.resolve() if args.runs else workspace / "build/smoke-detection/runs")}
params = {"scopePath": str(source)}
if not args.file:
    params["rules"] = ["@extrulesproject/long-method-check"]
request = {"protocolVersion": 1, "type": "request", "requestId": str(uuid.uuid4()),
           "method": "scan.start", "projectRoot": str(root), "config": config, "params": params}
print("Scanning: " + str(source), flush=True)
process = subprocess.run([sys.executable, "-X", "utf8", "-u", str(adapter_path)],
                         input=(json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"), capture_output=True,
                         env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1"), timeout=1250)
trace = workspace / "build/smoke-detection" / ("worker-" + request["requestId"] + ".jsonl")
trace.parent.mkdir(parents=True, exist_ok=True)
trace.write_bytes(process.stdout)
messages = [json.loads(line) for line in process.stdout.decode("utf-8").splitlines()]
responses = [message for message in messages if message.get("type") == "response"]
assert hashlib.sha256(source.read_bytes()).hexdigest() == before, "Detection changed the target"
assert len(responses) == 1 and responses[0]["requestId"] == request["requestId"], "Uncorrelated response: " + str(trace)
assert process.returncode == 0 and responses[0]["ok"], json.dumps(responses[0], ensure_ascii=False)
result = responses[0]["result"]
assert result["fileCount"] == 1 and result["scannedFiles"] == [str(source)], "Incorrect scan scope"
assert any(message.get("event") == "scan.started" for message in messages), "Missing scan progress"
if not args.file:
    assert result["issues"], "A 160-statement method should produce a real long-method finding"
print(json.dumps({"realHomeCheck": "PASS", "file": str(source), "issues": len(result["issues"]),
                  "rules": result["rules"], "report": result["reportPath"], "trace": str(trace),
                  "findings": [{key: issue.get(key) for key in ("rule", "symbol", "startLine", "message")} for issue in result["issues"]]}, ensure_ascii=False))
