"""Plugin-owned adapter. One JSONL request per process; backend source stays untouched."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

RULES = {
    "@extrulesproject/feature-envy-check": "feature-envy",
    "@extrulesproject/long-method-check": "long-method",
    "@extrulesproject/switch-statement-check": "switch-statement",
    "@extrulesproject/code-clone-fragment-check": "code-clone",
}
IGNORED = {".git", ".idea", ".hvigor", ".cache", ".test", "build", "coverage",
           "oh_modules", "node_modules", "report", "reports", ".preview", ".gradle"}
OUTPUT = sys.stdout
OUTPUT_LOCK = threading.Lock()
SEQUENCE = 0


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def emit(event: str, data: dict):
    global SEQUENCE
    with OUTPUT_LOCK:
        SEQUENCE += 1
        OUTPUT.write(json.dumps({"protocolVersion": 1, "type": "event", "seq": SEQUENCE,
                                 "event": event, "data": data}, ensure_ascii=False) + "\n")
        OUTPUT.flush()


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def contained(root: Path, target: Path) -> Path:
    resolved = target.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise BridgeError("PATH_OUTSIDE_ROOT", f"路径不在工程范围内：{target}")
    return resolved


def source_files(root: Path, tests: bool = False):
    for directory, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = [d for d in directories if d not in IGNORED and (tests or d not in {"test", "ohosTest"})]
        for filename in filenames:
            path = Path(directory) / filename
            if path.suffix.lower() in {".ets", ".ts"}:
                yield contained(root, path)


def file_in_project(root: Path, file_path: str) -> Path:
    normalized = file_path.replace("\\", "/")
    path = Path(normalized)
    if ".." in path.parts:
        raise BridgeError("PATH_OUTSIDE_ROOT", "报告路径不允许包含 ..")
    if path.is_absolute():
        return contained(root, path)
    options = [root / path]
    parts = path.parts
    if parts and parts[0] == root.name:
        options.append(root.joinpath(*parts[1:]))
    matches = [contained(root, p) for p in options if p.is_file()]
    if not matches:
        # Reports can carry a repository prefix above the currently opened subproject.
        suffix_matches = [p for p in source_files(root) if normalized.endswith(p.relative_to(root).as_posix())]
        if len(suffix_matches) == 1:
            return suffix_matches[0]
        raise BridgeError("INVALID_INPUT", f"无法将报告文件映射到当前工程：{file_path}")
    return matches[0]


def normalize_issues(records, root: Path):
    if isinstance(records, dict):
        records = [records]
    if not isinstance(records, list):
        raise BridgeError("INVALID_INPUT", "顶层必须是异味对象或 JSON 数组")
    result = []
    for index, record in enumerate(records):
        if not isinstance(record, dict) or not isinstance(record.get("messages"), list) or not record.get("filePath"):
            raise BridgeError("INVALID_INPUT", f"第 {index + 1} 条缺少 filePath/messages[]")
        path = file_in_project(root, str(record["filePath"]))
        for message in record["messages"]:
            if not isinstance(message, dict) or not isinstance(message.get("message"), str) or not isinstance(message.get("rule"), str):
                raise BridgeError("INVALID_INPUT", f"第 {index + 1} 条的 message/rule 必须为字符串")
            line = message.get("rangeStart", message.get("line", 1))
            end = message.get("rangeEnd", line)
            if not isinstance(line, int) or not isinstance(end, int):
                raise BridgeError("INVALID_INPUT", f"第 {index + 1} 条的行号必须为整数")
            symbol_match = re.search(r"(?:Method|method) '([^']+)'", message["message"])
            related = []
            for match in re.finditer(r"similar to\s+(.+?\.(?:ets|ts))(?:\s*>\s*[^:]+)?:(\d+)-(\d+)", message["message"], re.I):
                related_path = file_in_project(root, match.group(1))
                related.append({"filePath": str(related_path), "startLine": int(match.group(2)), "endLine": int(match.group(3))})
            result.append({"issueId": str(uuid.uuid4()), "filePath": path.relative_to(root).as_posix(),
                           "absolutePath": str(path), "rule": message["rule"],
                           "smellType": RULES.get(message["rule"], "unsupported"),
                           "severity": str(message.get("severity", "")), "message": message["message"],
                           "symbol": symbol_match.group(1) if symbol_match else None,
                           "startLine": max(1, line), "endLine": max(1, end), "relatedTargets": related,
                           "sourceSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                           "rawMessage": message, "commitHash": str(record.get("commitHash", "")),
                           "supported": message["rule"] in RULES})
    return result


def configure_environment(config: dict):
    extra_paths = []
    for name in ("node", "deveco", "hvigor", "ohpm", "linter"):
        value = config.get(name, "")
        if value and Path(value).is_file():
            extra_paths.append(str(Path(value).parent))
    studio = Path(config.get("studio", ""))
    if studio.is_dir():
        for item in ("tools/node", "tools/hvigor/bin", "tools/ohpm/bin"):
            if (studio / item).is_dir():
                extra_paths.append(str(studio / item))
        os.environ["DEVECO_HOME"] = str(studio)
    os.environ["PATH"] = os.pathsep.join(extra_paths + [os.environ.get("PATH", "")])
    os.environ["PYTHONIOENCODING"] = "utf-8"
    backend_src = Path(config.get("backend", "")) / "src"
    if backend_src.is_dir():
        sys.path.insert(0, str(backend_src))
        os.environ["PYTHONPATH"] = str(backend_src) + os.pathsep + os.environ.get("PYTHONPATH", "")


def discover_tools(config: dict):
    names = {"deveco": "deveco", "hvigorw": "hvigorw", "ohpm": "ohpm", "codelinter": "codelinter"}
    keys = {"hvigorw": "hvigor", "codelinter": "linter"}
    tools = {name: config.get(keys.get(name, name)) or shutil.which(command) for name, command in names.items()}
    tools["homecheck"] = config.get("homecheck") or None
    return tools


def inspect_environment(config: dict):
    homecheck = Path(config.get("homecheck", ""))
    studio = Path(config.get("studio", ""))
    backend = Path(config.get("backend", ""))
    node = config.get("node") or shutil.which("node")
    tools = discover_tools(config)
    rows = [{"name": "Python", "path": sys.executable, "available": sys.version_info >= (3, 10)},
            {"name": "重构后端", "path": str(backend), "available": (backend / "src/arkts_smell_refactor/runner.py").is_file()},
            {"name": "Node", "path": node or "", "available": bool(node and (Path(node).is_file() or shutil.which(node)))},
            {"name": "HomeCheck", "path": str(homecheck), "available": (homecheck / "node_modules/homecheck/lib/run.js").is_file() and (homecheck / "extrulesproject-1.0.0.tgz").is_file()},
            {"name": "ArkTS SDK", "path": str(studio / "sdk/default/openharmony/ets"), "available": (studio / "sdk/default/openharmony/ets").is_dir()}]
    for name, value in tools.items():
        if name != "homecheck":
            rows.append({"name": name, "path": value or "", "available": bool(value and Path(value).is_file())})
    detection = all(row["available"] for row in rows if row["name"] in {"Python", "Node", "HomeCheck", "ArkTS SDK"})
    candidate = detection and all(row["available"] for row in rows if row["name"] in {"重构后端", "deveco", "hvigorw", "ohpm"})
    if config.get("linterMode", "required") == "required":
        candidate = candidate and bool(tools["codelinter"])
    return {"tools": rows, "canDetect": detection, "canRefactor": candidate,
            "pythonVersion": sys.version.split()[0], "supportedRules": list(RULES)}


def create_run(config: dict, root: Path, method: str):
    run_root = Path(config["runs"]).expanduser().resolve()
    if run_root.is_relative_to(root.resolve()):
        raise BridgeError("INVALID_INPUT", "任务目录必须位于业务工程之外，避免扫描或复制任务自身")
    run = run_root / str(uuid.uuid4())
    run.mkdir(parents=True, exist_ok=False)
    write_json(run / "session.json", {"runId": run.name, "projectRoot": str(root), "method": method,
                                       "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "state": "RUNNING"})
    emit("run.started", {"runId": run.name, "runDirectory": str(run)})
    return run


def run_tool(command: list[str], cwd: Path, log: Path, timeout: int = 1200):
    log.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    scratch = log.parent / "temp"
    scratch.mkdir(exist_ok=True)
    env.update({name: str(scratch) for name in ("TEMP", "TMP", "TMPDIR")})
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding="utf-8", errors="replace", env=env)
    timed_out = threading.Event()

    def stop():
        if process.poll() is None:
            timed_out.set()
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
            else:
                process.kill()

    timer = threading.Timer(timeout, stop)
    timer.start()
    try:
        with log.open("w", encoding="utf-8") as sink:
            for line in process.stdout:
                sink.write(line); sink.flush()
                emit("log.appended", {"text": line[:8000]})
        exit_code = process.wait()
        if timed_out.is_set():
            raise BridgeError("TOOL_UNAVAILABLE", f"工具运行超时：{timeout} 秒")
        return exit_code
    finally:
        timer.cancel()


def scan(params: dict, config: dict, root: Path, run: Path):
    selected = params.get("files", [])
    scope = contained(root, Path(params.get("scopePath") or root))
    files = [file_in_project(root, p) for p in selected] if selected else list(source_files(scope))
    if scope.is_file() and not selected:
        files = [scope] if scope.suffix.lower() in {".ets", ".ts"} else []
    if not files:
        raise BridgeError("INVALID_INPUT", "检测范围内没有生产 .ets/.ts 文件")
    rules = params.get("rules") or list(RULES)
    if any(rule not in RULES for rule in rules):
        raise BridgeError("UNSUPPORTED_RULE", "扫描规则不受支持")
    homecheck = Path(config["homecheck"]).resolve()
    if not inspect_environment(config)["canDetect"]:
        raise BridgeError("TOOL_UNAVAILABLE", "检测环境不完整，请检查 Node、HomeCheck 和 ArkTS SDK")
    project_config = read_json(homecheck / "config/projectConfig.json")
    sdk = Path(config["studio"]) / "sdk/default"
    output = run / "scan"
    project_config.update({"projectName": root.name, "projectPath": str(root.parent),
                           "repos": [f"{root.name}={root}"], "checkFiles": [p.relative_to(root).as_posix() for p in files],
                           "datasetDir": "", "ohosSdkPath": str(sdk / "openharmony/ets"),
                           "hmsSdkPath": str(sdk / "hms/ets"), "fix": "false", "reportDir": str(output), "logPath": str(output / "HomeCheck.log")})
    rule_config = read_json(homecheck / "config/ruleConfig.json")
    rule_config["extRuleSet"] = [{"ruleSetName": "extrulesproject", "packagePath": str(homecheck / "extrulesproject-1.0.0.tgz"),
                                  "extRules": {rule: 2 for rule in rules}}]
    write_json(run / "project.json", project_config); write_json(run / "rules.json", rule_config)
    emit("workflow.changed", {"status": f"检测 {len(files)} 个文件"})
    command = [config.get("node") or "node", str(homecheck / "scripts/gitcodeArktsPerfTest.js"),
               "--f1=false", "--dashboard=false", f"--baseProjectConfig={run / 'project.json'}",
               f"--baseRuleConfig={run / 'rules.json'}", f"--outputDir={output}",
               "--includeRules=" + ",".join(RULES[rule] if RULES[rule] != "code-clone" else "code-clone-fragment" for rule in rules)]
    if run_tool(command, homecheck, run / "scan.log") != 0:
        raise BridgeError("TOOL_UNAVAILABLE", "HomeCheck 扫描失败，请查看本轮日志")
    reports = list((output / "runs").glob("*/issuesReport.json"))
    report = reports[0] if len(reports) == 1 else output / "issuesReport.json"
    if not report.is_file():
        raise BridgeError("ARTIFACT_UNAVAILABLE", "本轮未生成唯一有效的 issuesReport.json")
    issues = normalize_issues(read_json(report), root)
    allowed_files = {str(path) for path in files}
    issues = [issue for issue in issues if issue["absolutePath"] in allowed_files]
    return {"issues": issues, "runDirectory": str(run), "reportPath": str(report)}


def dispatch(method: str, params: dict, config: dict, root: Path, run: Path | None):
    if method == "session.hello":
        return {"protocolVersion": 1, "adapterVersion": "0.1.0", "transport": "one-request-per-process", "supportedRules": list(RULES)}
    if method == "environment.inspect":
        return inspect_environment(config)
    if method == "issues.import":
        records = params.get("records")
        if params.get("text") is not None:
            records = json.loads(params["text"])
        if params.get("file"):
            path = Path(params["file"])
            if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
                raise BridgeError("INVALID_INPUT", "导入文件不存在或超过 8 MiB")
            records = read_json(path)
        return {"issues": normalize_issues(records, root)}
    if method == "scan.start":
        return scan(params, config, root, run)
    raise BridgeError("INVALID_REQUEST", f"未实现的方法：{method}")


def main():
    request = None
    run = None
    try:
        line = sys.stdin.readline(8 * 1024 * 1024 + 1)
        if len(line) > 8 * 1024 * 1024:
            raise BridgeError("INVALID_REQUEST", "请求超过 8 MiB")
        request = json.loads(line)
        if request.get("protocolVersion") != 1:
            raise BridgeError("UNSUPPORTED_PROTOCOL", "仅支持协议版本 1")
        config = request["config"]
        configure_environment(config)
        root = Path(request["projectRoot"]).resolve()
        if not root.is_dir():
            raise BridgeError("INVALID_INPUT", "当前工程目录不存在")
        method = request["method"]
        if method not in {"session.hello", "environment.inspect", "issues.import"}:
            run = create_run(config, root, method)
        result = dispatch(method, request.get("params", {}), config, root, run)
        if run:
            session = read_json(run / "session.json"); session["state"] = "SUCCEEDED"
            write_json(run / "session.json", session); write_json(run / "response.json", result)
        response = {"protocolVersion": 1, "type": "response", "requestId": request.get("requestId"), "ok": True, "result": result}
        OUTPUT.write(json.dumps(response, ensure_ascii=False) + "\n"); OUTPUT.flush()
        return 0
    except Exception as error:
        code = error.code if isinstance(error, BridgeError) else "INTERNAL_ERROR"
        if run:
            session = read_json(run / "session.json"); session.update(state="FAILED", error=str(error))
            write_json(run / "session.json", session)
        response = {"protocolVersion": 1, "type": "response", "requestId": (request or {}).get("requestId"),
                    "ok": False, "error": {"code": code, "message": str(error)}}
        OUTPUT.write(json.dumps(response, ensure_ascii=False) + "\n"); OUTPUT.flush()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
