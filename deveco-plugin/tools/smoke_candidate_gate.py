"""Recheck a real frozen candidate without rerunning an Agent or applying production changes."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import uuid

workspace = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--candidate-run", type=Path, required=True)
parser.add_argument("--adapter", type=Path, default=workspace / "src/main/resources/bridge/ide_bridge.py")
args = parser.parse_args()
spec = importlib.util.spec_from_file_location("candidate_adapter", args.adapter.resolve())
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
candidate_run = args.candidate_run.resolve()
config = bridge.read_json(candidate_run / "backend/bridge-settings.json")
project = Path(bridge.read_json(candidate_run / "session.json")["projectRoot"])
_, candidate, _, _ = bridge.load_candidate_for_validation(candidate_run.name, config, project)
original = Path(candidate["originalRoot"])
before = bridge.snapshot(original)
run = workspace / "build/smoke-candidate-gate" / str(uuid.uuid4())
stage = run / "staging" / original.name
source_stage = candidate_run / "staging" / original.name
assert bridge.snapshot(source_stage) == candidate["afterFiles"], "Stored stage no longer matches frozen candidate"
bridge.copy_project(source_stage, stage)
task_dir = run / "backend"
task_dir.mkdir()
old_prefix, new_prefix = str(candidate_run / "staging"), str(stage.parent)
for path in (candidate_run / "backend").iterdir():
    if path.is_file() and path.suffix in {".json", ".md"}:
        value = path.read_text(encoding="utf-8")
        value = value.replace(json.dumps(old_prefix)[1:-1], json.dumps(new_prefix)[1:-1]).replace(old_prefix, new_prefix)
        (task_dir / path.name).write_text(value, encoding="utf-8")
if (candidate_run / "backend/baseline-production").is_dir():
    shutil.copytree(candidate_run / "backend/baseline-production", task_dir / "baseline-production")
with (run / "events.jsonl").open("w", encoding="utf-8") as log:
    def event(name, data):
        log.write(json.dumps({"event": name, "data": data}, ensure_ascii=False) + "\n")
        log.flush()
        if name == "workflow.changed":
            print(data["status"], flush=True)
    bridge.emit = event
    exit_code = bridge.smell_candidate_gate(task_dir, stage, config)
assert bridge.snapshot(original) == before, "Original project changed during gate recheck"
assert bridge.snapshot(stage) == candidate["afterFiles"], "Gate changed frozen production content"
print(json.dumps({"smellGateExit": exit_code, "candidateId": candidate_run.name,
                  "runDirectory": str(run), "remaining": bridge.read_json(task_dir / "smell-after.json")
                  if (task_dir / "smell-after.json").exists() else None}, ensure_ascii=False))
raise SystemExit(exit_code)
