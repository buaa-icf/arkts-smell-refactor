"""Plugin-owned adapter. One JSONL request per process; backend source stays untouched."""
from __future__ import annotations

import contextlib
import codecs
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
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
    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


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


def hash_file(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


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
                related.append({"filePath": str(related_path), "reportedPath": match.group(1), "startLine": int(match.group(2)), "endLine": int(match.group(3)), "sourceSha256": hash_file(related_path)})
            result.append({"issueId": str(uuid.uuid4()), "filePath": path.relative_to(root).as_posix(),
                           "absolutePath": str(path), "rule": message["rule"],
                           "smellType": RULES.get(message["rule"], "unsupported"),
                           "severity": str(message.get("severity", "")), "message": message["message"],
                           "symbol": symbol_match.group(1) if symbol_match else None,
                           "startLine": max(1, line), "endLine": max(1, end), "relatedTargets": related,
                           "sourceSha256": hash_file(path),
                           "rawMessage": message, "commitHash": str(record.get("commitHash", "")),
                           "supported": message["rule"] in RULES and allowed_production(path.relative_to(root).as_posix()) and
                                        all(allowed_production(Path(item["filePath"]).relative_to(root).as_posix()) for item in related)})
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


def run_tool(command: list[str], cwd: Path, log: Path, timeout: int = 1200, follow_log: Path | None = None):
    log.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    scratch = log.parent / "temp"
    scratch.mkdir(exist_ok=True)
    env.update({name: str(scratch) for name in ("TEMP", "TMP", "TMPDIR")})
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding="utf-8", errors="replace", env=env)
    timed_out = threading.Event()
    stopped = threading.Event()

    def follow():
        offset = 0
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            finished = stopped.is_set()
            try:
                if follow_log.is_file():
                    with follow_log.open("rb") as stream:
                        stream.seek(offset)
                        while block := stream.read(8000):
                            offset += len(block)
                            text = decoder.decode(block)
                            if text:
                                emit("log.appended", {"text": text})
            except OSError:
                pass  # A not-yet-created or rotating log must not stop the detector.
            if finished:
                remaining = decoder.decode(b"", final=True)
                if remaining:
                    emit("log.appended", {"text": remaining})
                return
            stopped.wait(0.2)

    follower = threading.Thread(target=follow, daemon=True) if follow_log else None
    if follower:
        follower.start()

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
        process.stdout.close()
        stopped.set()
        if follower:
            follower.join(timeout=2)


def scope_rule_ignores(config: dict, root: Path):
    scoped = dict(config)
    for key in ("ignore", "excluded"):
        if isinstance(config.get(key), list):
            scoped[key] = [str(pattern) if Path(pattern).is_absolute() else
                           root.as_posix().rstrip("/") + "/" + str(pattern).replace("\\", "/").lstrip("/")
                           for pattern in config[key]]
    if isinstance(config.get("overrides"), list):
        scoped["overrides"] = [scope_rule_ignores(item, root) for item in config["overrides"]]
    return scoped


def log_tail(path: Path, limit: int = 8000):
    if not path.is_file():
        return ""
    with path.open("rb") as stream:
        stream.seek(max(0, path.stat().st_size - limit))
        return stream.read(limit).decode("utf-8", errors="replace")


def scan_failure(run: Path, reason: str, exit_code: int | None = None):
    logs = [run / "scan.log", run / "scan/HomeCheck.log"]
    diagnostic = "\n".join(f"[{path.name}]\n{log_tail(path)}" for path in logs if path.is_file())
    emit("log.appended", {"text": "\n" + reason + "\n" + diagnostic + "\n"})
    errors = [line for line in diagnostic.splitlines() if "[ERROR]" in line or re.search(r"\b(?:Error|error):", line)]
    cause = errors[0].split(" - ", 1)[-1] if errors else ""
    message = reason + ("：" + cause[:300] if cause else "")
    return BridgeError("TOOL_UNAVAILABLE", message, {"runDirectory": str(run), "logPath": str(logs[-1] if logs[-1].is_file() else logs[0]),
                       "exitCode": exit_code, "diagnostic": diagnostic})


def scan(params: dict, config: dict, root: Path, run: Path):
    selected = params.get("files", [])
    scope = contained(root, Path(params.get("scopePath") or root))
    files = [file_in_project(root, p) for p in selected] if selected else list(source_files(scope))
    if scope.is_file() and not selected:
        files = [scope] if scope.suffix.lower() in {".ets", ".ts"} else []
    files = [path for path in files if not any(part.lower() in {"test", "ohostest"} for part in path.relative_to(root).parts)]
    if not files:
        raise BridgeError("INVALID_INPUT", "检测范围内没有生产 .ets/.ts 文件")
    rules = params.get("rules") or list(RULES)
    if any(rule not in RULES for rule in rules):
        raise BridgeError("UNSUPPORTED_RULE", "扫描规则不受支持")
    scan_scope = {"scopePath": str(scope), "scannedFiles": [str(path) for path in files],
                  "fileCount": len(files), "rules": rules}
    emit("scan.started", scan_scope)
    homecheck = Path(config["homecheck"]).resolve()
    if not inspect_environment(config)["canDetect"]:
        raise BridgeError("TOOL_UNAVAILABLE", "检测环境不完整，请检查 Node、HomeCheck 和 ArkTS SDK")
    project_config = read_json(homecheck / "config/projectConfig.json")
    sdk = Path(config["studio"]) / "sdk/default"
    output = run / "scan"
    project_config.update({"projectName": root.name, "projectPath": str(root) + os.sep,
                           "repos": [f"{root.name}={root}"], "checkFiles": [p.relative_to(root).as_posix() for p in files],
                           "datasetDir": "", "ohosSdkPath": str(sdk / "openharmony/ets"),
                           "hmsSdkPath": str(sdk / "hms/ets"), "fix": "false", "reportDir": str(output), "logPath": str(output / "HomeCheck.log"),
                           "homecheck_log_level": "info", "arkCheckPath": str(homecheck / "node_modules/homecheck"),
                           "npmInstallDir": str(homecheck), "checkPath": str(run / "check-paths.json")})
    write_json(run / "check-paths.json", {"checkPath": [{"filePath": str(path), "fixKey": []} for path in files]})
    rule_config = scope_rule_ignores(read_json(homecheck / "config/ruleConfig.json"), root)
    rule_config["extRuleSet"] = [{"ruleSetName": "extrulesproject", "packagePath": str(homecheck / "extrulesproject-1.0.0.tgz"),
                                  "extRules": {rule: 2 for rule in rules}}]
    write_json(run / "project.json", project_config); write_json(run / "rules.json", rule_config)
    emit("workflow.changed", {"status": f"正在运行 HomeCheck：{len(files)} 个文件，{len(rules)} 条规则…"})
    command = [config.get("node") or "node", str(Path(__file__).with_name("homecheck_scan.cjs")),
               str(homecheck), str(run / "project.json"), str(run / "rules.json"), str(output / "summary.json")]
    try:
        exit_code = run_tool(command, homecheck, run / "scan.log", follow_log=output / "HomeCheck.log")
    except (OSError, BridgeError) as error:
        raise scan_failure(run, f"无法完成 HomeCheck 扫描：{error}") from error
    if exit_code != 0:
        raise scan_failure(run, f"HomeCheck 扫描失败（exit {exit_code}）", exit_code)
    emit("workflow.changed", {"status": "正在核对执行摘要并读取检测结果…"})
    summary_path = output / "summary.json"
    if not summary_path.is_file():
        raise BridgeError("ARTIFACT_UNAVAILABLE", "扫描器未生成本轮执行摘要")
    summary = read_json(summary_path)
    if summary.get("runner") != "direct-homecheck" or summary.get("success") is not True:
        raise scan_failure(run, "HomeCheck 实际扫描未成功，空报告不能视为零异味")
    if set(rules) != set(summary.get("requestedRules", [])) or not set(rules).issubset(summary.get("loadedRules", [])):
        raise scan_failure(run, "HomeCheck 没有加载全部选中规则")
    detector_log = output / "HomeCheck.log"
    # HomeCheck can swallow checker exceptions and still exit 0/write an empty report.
    completed, failed, actual_count = False, False, None
    if detector_log.is_file():
        with detector_log.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                failed |= bool(re.search(r"\[ERROR\].*\[HomeCheck\]", line))
                completed |= "[Main] Checking completed." in line
                count = re.search(r"\[CheckEntry\] File count: (\d+)", line)
                if count:
                    actual_count = int(count.group(1))
    if failed or not completed:
        raise scan_failure(run, "HomeCheck 未完成检测或规则执行出错")
    if actual_count != len(files):
        raise scan_failure(run, "HomeCheck 实际文件数与请求不一致，部分目标可能被忽略")
    report = output / "issuesReport.json"
    if not report.is_file():
        raise BridgeError("ARTIFACT_UNAVAILABLE", "本轮未生成唯一有效的 issuesReport.json")
    issues = normalize_issues(read_json(report), root)
    allowed_files = {str(path) for path in files}
    issues = [issue for issue in issues if issue["absolutePath"] in allowed_files]
    return {"issues": issues, "runDirectory": str(run), "reportPath": str(report), **scan_scope}


def dispatch(method: str, params: dict, config: dict, root: Path, run: Path | None):
    if method == "session.hello":
        return {"protocolVersion": 1, "adapterVersion": "0.1.4", "transport": "one-request-per-process", "supportedRules": list(RULES)}
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
    if method == "task.prepare":
        return prepare_candidate(params, config, root, run)
    if method == "task.execute":
        return execute_candidate(params, config, root, run)
    if method == "task.validateApplied":
        return validate_applied(params, config, root, run)
    if method == "task.validateCandidate":
        return validate_candidate(params, config, root, run)
    if method == "candidate.restore":
        candidate_run, candidate, prepared_run, prepared = load_candidate_for_validation(params["candidateId"], config, root)
        summarize_failure(candidate_run / "backend", candidate.get("result", {}))
        restored = dict(prepared)
        restored["restored"] = True
        if "instructions" not in restored:
            prompt = (prepared_run / "backend/refactor-prompt.md").read_text(encoding="utf-8")
            marker = "\n\n用户业务说明（不得改变平台约束和门禁）：\n"
            restored["instructions"] = prompt.split(marker, 1)[1] if marker in prompt else ""
        return {"candidate": candidate, "prepared": restored, "result": candidate.get("result", {}), "runDirectory": str(candidate_run)}
    if method in {"candidate.check", "candidate.describe"}:
        candidate_run, candidate = load_run(params["candidateId"], config, root, "candidate.json")
        if method == "candidate.check":
            if candidate["verdict"] != "PASS" or snapshot(Path(candidate["originalRoot"])) != candidate["baselineFiles"] or configuration_digest(config) != candidate["configDigest"]:
                raise BridgeError("BASELINE_CHANGED", "工程、工具配置或验证结论不满足应用条件")
            for item in candidate["changes"]:
                for phase in ("before", "after"):
                    expected = item.get(phase + "Sha256")
                    if expected is not None:
                        path = contained(candidate_run, candidate_run / "content" / phase / item["relativePath"])
                        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                            raise BridgeError("CANDIDATE_CHANGED", "冻结候选内容已变化")
        return candidate
    if method == "history.list":
        records = []
        run_root = Path(config["runs"]).resolve()
        for path in run_root.glob("*/session.json"):
            try:
                item = read_json(path)
                if item.get("projectRoot") == str(root):
                    if item.get("state") == "RUNNING":
                        item["state"] = "INTERRUPTED"
                    item["runDirectory"] = str(path.parent)
                    item["hasCandidate"] = (path.parent / "candidate.json").is_file()
                    if item["hasCandidate"]:
                        item["candidateId"] = path.parent.name
                    transaction = path.parent / "apply-transaction.json"
                    if transaction.is_file():
                        item["applyState"] = read_json(transaction).get("state", "UNKNOWN")
                    records.append(item)
            except (OSError, ValueError):
                continue
        records.sort(key=lambda x: x.get("startedAt", ""), reverse=True)
        return {"records": records[:200]}
    raise BridgeError("INVALID_REQUEST", f"未实现的方法：{method}")


def snapshot(root: Path):
    result = {}
    for directory, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = sorted(d for d in directories if d not in IGNORED)
        for name in directories + filenames:
            path = Path(directory) / name
            if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
                raise BridgeError("PATH_OUTSIDE_ROOT", f"候选工程不支持符号链接或 junction：{path}")
            contained(root, path)
        for name in sorted(filenames):
            path = Path(directory) / name
            result[path.relative_to(root).as_posix()] = hash_file(path)
    return result


def copy_project(source: Path, destination: Path):
    # Validate links before shutil can dereference them into the snapshot.
    snapshot(source)
    shutil.copytree(source, destination, ignore=lambda directory, names: [name for name in names if name in IGNORED])


def allowed_production(relative: str):
    path = Path(relative)
    normalized = "/" + path.as_posix().lower()
    if any(part in {"test", "ohostest", "appscope"} for part in normalized.split("/")):
        return False
    return ("/src/main/resources/" in normalized or
            ("/src/main/" in normalized and path.suffix.lower() in {".ets", ".ts"}) or
            (path.name.lower() == "index.ets" and len(path.parts) >= 2))


def harmony_root(target: Path, root: Path):
    for parent in target.parents:
        if not parent.is_relative_to(root):
            break
        if (parent / "build-profile.json5").is_file() and (parent / "hvigor/hvigor-config.json5").is_file():
            return parent
    raise BridgeError("INVALID_INPUT", "目标不属于可构建的 Harmony 工程（缺少 build-profile.json5 或 hvigor 配置）")


def configuration_digest(config: dict):
    data = dict(config)
    data["pythonRuntime"] = sys.version
    backend = Path(config.get("backend", "")) / "src/arkts_smell_refactor"
    data["backendSources"] = {p.relative_to(backend).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                              for p in backend.rglob("*.py") if p.is_file()}
    package = Path(config.get("homecheck", "")) / "extrulesproject-1.0.0.tgz"
    data["rulePackage"] = hashlib.sha256(package.read_bytes()).hexdigest() if package.is_file() else None
    data["tools"] = {}
    for name, value in discover_tools(config).items():
        path = Path(value) if value else None
        data["tools"][name] = {"path": value, "size": path.stat().st_size, "mtime": path.stat().st_mtime_ns} if path and path.is_file() else value
    sdk = Path(config.get("studio", "")) / "sdk/default/openharmony/ets"
    data["sdkMetadata"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sdk.glob("*.json") if p.is_file()}
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def load_run(identifier: str, config: dict, root: Path, manifest: str):
    try:
        uuid.UUID(identifier)
    except (ValueError, TypeError):
        raise BridgeError("INVALID_REQUEST", "任务标识必须为 UUID")
    run_root = Path(config["runs"]).resolve()
    run = contained(run_root, run_root / identifier)
    data = read_json(run / manifest)
    if not Path(data["originalRoot"]).resolve().is_relative_to(root):
        raise BridgeError("PATH_OUTSIDE_ROOT", "任务不属于当前工程")
    return run, data


def prepare_candidate(params: dict, config: dict, root: Path, run: Path):
    from arkts_smell_refactor.dataset import load_dataset_tasks
    from arkts_smell_refactor.risk import analyze_risks
    from arkts_smell_refactor.prompts import build_refactor_prompt, build_review_prompt
    from arkts_smell_refactor.public_contract import prepare_public_contract
    from arkts_smell_refactor.runtime_smoke import prepare_runtime_smoke
    from arkts_smell_refactor.automatic import _review_risk

    issue = params["issue"]
    if issue.get("rule") not in RULES:
        raise BridgeError("UNSUPPORTED_RULE", "首版重构仅开放四条已联调规则")
    target = contained(root, Path(issue["absolutePath"]))
    if hash_file(target) != issue.get("sourceSha256"):
        raise BridgeError("BASELINE_CHANGED", "检测后目标代码已变化，请重新检测")
    original = harmony_root(target, root)
    if not allowed_production(target.relative_to(original).as_posix()):
        raise BridgeError("INVALID_INPUT", "目标不属于允许重构的生产源码")
    related = issue.get("relatedTargets", [])
    for entry in related:
        related_path = contained(root, Path(entry["filePath"]))
        if not related_path.is_relative_to(original) or not allowed_production(related_path.relative_to(original).as_posix()):
            raise BridgeError("INVALID_INPUT", "关联片段必须是同工程内允许重构的生产源码")
        if hash_file(related_path) != entry.get("sourceSha256"):
            raise BridgeError("BASELINE_CHANGED", "检测后关联片段已变化，请重新检测")
        if harmony_root(related_path, root) != original:
            raise BridgeError("INVALID_INPUT", "首版不支持跨 Harmony 工程的关联重构")
    baseline = snapshot(original)
    emit("workflow.changed", {"status": "冻结工程基线并分析风险…"})
    saved = run / "baseline"
    copy_project(original, saved)
    if snapshot(saved) != baseline or snapshot(original) != baseline:
        raise BridgeError("BASELINE_CHANGED", "工程在创建快照时发生变化")
    stage = run / "staging" / original.name
    copy_project(saved, stage)
    relative = target.relative_to(original).as_posix()
    message = dict(issue["rawMessage"])
    text = str(message["message"])
    for entry in related:
        replacement = f"{original.name}/{Path(entry['filePath']).relative_to(original).as_posix()}"
        text = text.replace(entry.get("reportedPath", entry["filePath"]), replacement)
    text = text.replace(str(original), str(stage)).replace(original.as_posix(), stage.as_posix())
    message["message"] = text
    record = {"filePath": f"{original.name}/{relative}", "sourceProject": original.name,
              "commitHash": issue.get("commitHash", ""), "messages": [message]}
    write_json(run / "input.json", [record])
    task = load_dataset_tasks(run / "input.json", stage.parent)[0]
    task.target.related_targets = [{"filePath": f"{original.name}/{Path(item['filePath']).relative_to(original).as_posix()}",
                                   "range": {"startLine": item["startLine"], "endLine": item["endLine"]}} for item in related]
    task_dir = run / "backend"
    risk = analyze_risks(task)
    write_json(task_dir / "task.json", task.to_dict()); write_json(task_dir / "risk-report.json", risk)
    write_json(task_dir / "review-risk.json", _review_risk(risk))
    prepare_runtime_smoke(task, risk, task_dir); prepare_public_contract(task, task_dir)
    prompt = build_refactor_prompt(task, risk, linter_mode=config.get("linterMode", "required"))
    if params.get("instructions", "").strip():
        prompt += "\n\n用户业务说明（不得改变平台约束和门禁）：\n" + params["instructions"][:8000]
    (task_dir / "refactor-prompt.md").write_text(prompt, encoding="utf-8")
    review = build_review_prompt(task, risk) + "\n只使用平台提供的生产基线、当前快照、依赖与 Diff；不得访问原始工程或测试。\n"
    (task_dir / "review-prompt.md").write_text(review, encoding="utf-8")
    data = {"taskHandle": run.name, "taskId": task.task_id, "originalRoot": str(original),
            "targetRelativePath": relative, "issue": issue, "baselineFiles": baseline,
            "configDigest": configuration_digest(config), "risk": risk, "runDirectory": str(run), "instructions": params.get("instructions", "")}
    write_json(run / "prepared.json", data)
    return data


def pipeline_config(task_dir: Path, config: dict):
    from arkts_smell_refactor.automatic import _auto_config
    from arkts_smell_refactor.runner import _task_from_file
    task = _task_from_file(task_dir / "task.json")
    risk = read_json(task_dir / "risk-report.json")
    result = _auto_config(task, task_dir, risk, discover_tools(config),
                          read_json(task_dir / "runtime-smoke-plan.json"), read_json(task_dir / "public-contract-plan.json"),
                          linter_mode=config.get("linterMode", "required"))
    settings = task_dir / "bridge-settings.json"
    write_json(settings, config)
    adapter = str(Path(__file__).resolve())
    for key in ("refactorAgent", "repairAgent"):
        if result.get(key):
            command = [sys.executable, adapter, "--gate", "refactor", "--task-dir", str(task_dir),
                       "--settings", str(settings), "--source-root", task.project_root]
            if key == "repairAgent":
                command += ["--prompt-file", "{repair_prompt_file}"]
            result[key]["command"] = command
    if discover_tools(config).get("homecheck"):
        result["gates"]["smell"]["command"] = [sys.executable, adapter, "--gate", "smell", "--task-dir", str(task_dir),
                                                 "--settings", str(settings), "--source-root", task.project_root]
    return result


class EventLogWriter:
    def write(self, value):
        if value.strip():
            emit("log.appended", {"text": value[:8000]})
        return len(value)

    def flush(self):
        pass


def pipeline_progress(name, status):
    emit("step.updated", {"stepId": name, "status": status})
    emit("workflow.changed", {"status": f"{name}: {status}"})


def run_pipeline_logged(task_dir: Path, plan: dict):
    import arkts_smell_refactor.runner as runner
    original_writer = runner.write_text
    def write_log(path, text):
        original_writer(path, text)
        if Path(path).suffix == ".log":
            emit("log.appended", {"text": f"\n[{Path(path).name}]\n"})
            for offset in range(0, len(text), 8000):
                emit("log.appended", {"text": text[offset:offset + 8000]})
    runner.write_text = write_log
    try:
        with contextlib.redirect_stdout(EventLogWriter()):
            return runner.execute_pipeline(task_dir, plan, progress=pipeline_progress)
    finally:
        runner.write_text = original_writer


def summarize_failure(task_dir: Path, result: dict):
    """Attach bounded, readable diagnostics; full logs remain in the controlled task directory."""
    for step in result.get("steps", []):
        if step.get("status") not in {"FAIL", "BLOCKED", "INCOMPLETE"}:
            continue
        reason = step.get("reason") or ""
        if str(step.get("name", "")).startswith("smell") and step.get("status") == "FAIL":
            try:
                findings = read_json(task_dir / "smell-after.json")
                if findings:
                    reason = f"候选仍有 {len(findings)} 条目标或变更异味：" + str(findings[0].get("message", ""))[:350]
            except (OSError, ValueError, AttributeError, IndexError):
                pass
        output_file = step.get("output_file")
        if output_file:
            try:
                output = contained(task_dir, Path(output_file))
                text = log_tail(output, 12000)
                if "File attachment path is outside the allowed roots:" in text:
                    reason = "Agent 无法读取工作区允许范围之外的提示词附件。"
                elif "cloc" in text.lower() and "creation of private cache subdirectory" in text:
                    reason = "CLOC 临时缓存创建失败，候选异味复检未完成。"
                elif "SMELL_GATE_BLOCKED:" in text:
                    reason = text.rsplit("SMELL_GATE_BLOCKED:", 1)[-1].splitlines()[0].strip()[:500]
                elif not reason:
                    for line in text.splitlines():
                        match = re.match(r"\s*(?:error:|Error:)\s*(.+)", line)
                        if match and not re.match(r"\d+\s*\|", match.group(1)):
                            reason = match.group(1)[:500]
                            break
                if not reason:
                    reason = f"进程退出码 {step.get('exit_code')}；请查看 {output.name}。"
                step["logPath"] = str(output)
            except (BridgeError, OSError):
                pass
        if reason:
            step["reason"] = reason
            if result.get("verdict") != "PASS":
                result["failureReason"] = f"{step.get('name', '任务')}：{reason}"


def refactor_agent_gate(task_dir: Path, source: Path, deveco: Path, prompt_file: Path | None = None):
    """Keep CLI attachments inside its production mirror; reuse the backend's copy/sync policy."""
    import arkts_smell_refactor.gate as gate
    task = read_json(task_dir / "task.json")
    contained(source, Path(task["workspace_root"]) / task["target"]["file_path"])
    workspace = task_dir / ("refactor-workspace" if prompt_file is None else f"refactor-workspace-{prompt_file.stem}")
    gate._fresh_copy(source, workspace, exclude_tests=True)
    prompt = (prompt_file or (task_dir / "refactor-prompt.md")).read_text(encoding="utf-8")
    prompt = gate._normalize_agent_prompt_paths(prompt, task, source)
    (task_dir / "refactor-agent-prompt.md").write_text(prompt, encoding="utf-8")
    # The CLI validates -f against --dir, even when its execution permissions are skipped.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=".arkts-refactor-", suffix=".md",
                                     dir=workspace, delete=False) as stream:
        stream.write(prompt)
        attachment = Path(stream.name)
    command = [str(deveco), "run", "严格执行附件中的 ArkTS 重构任务，直接修改工作区内的生产代码。",
               "-f", str(attachment.resolve()), "--dir", str(workspace), "--format", "json",
               "--title", str(task.get("task_id", task.get("taskId", "refactor"))), "--dangerously-skip-permissions"]
    try:
        completed = subprocess.run(command, cwd=workspace)
    finally:
        attachment.unlink(missing_ok=True)
    if completed.returncode != 0:
        return completed.returncode
    before, after = snapshot(source), snapshot(workspace)
    deleted = [name for name in before if allowed_production(name) and name not in after]
    if deleted:
        print("Refactor Agent 删除了生产文件，拒绝同步：" + ", ".join(deleted), file=sys.stderr)
        return 4
    return gate._sync_production_changes(workspace, source)


def smell_candidate_gate(task_dir: Path, source: Path, config: dict):
    """Validate the candidate copy, using the same direct detector as initial scanning."""
    import arkts_smell_refactor.gate as gate
    (task_dir / "smell-after.json").unlink(missing_ok=True)
    try:
        task = read_json(task_dir / "task.json")
        target = task["target"]
        rule = task["rule"]
        target_source = contained(source, Path(task["workspace_root"]) / target["file_path"])
        files = gate._smell_scan_files(task_dir, source, target_source)
        related = target.get("related_targets", target.get("relatedTargets", []))
        for item in related:
            path = contained(source, Path(task["workspace_root"]) / item.get("filePath", item.get("file_path", "")))
            if path.is_file() and path not in files:
                files.append(path)
        scan_run = task_dir / "smell-scans" / str(uuid.uuid4())
        scan_run.mkdir(parents=True)
        response = scan({"scopePath": str(source), "files": [str(path) for path in files], "rules": [rule]}, config, source, scan_run)
        risk = read_json(task_dir / "risk-report.json") if (task_dir / "risk-report.json").is_file() else {}
        owner = risk.get("target", {}).get("owner")
        target_text = target_source.read_text(encoding="utf-8", errors="replace")
        changed_lines = gate._smell_changed_lines(task_dir, source, files)
        remaining = []
        for issue in response["issues"]:
            if issue["rule"] != rule:
                continue
            path = Path(issue["absolutePath"])
            message = issue["rawMessage"]
            line = int(message.get("line", message.get("rangeStart", 1)))
            reported = gate._reported_symbol(message["message"])
            same_target = path == target_source and gate._symbol_matches(reported, target.get("symbol"))
            if same_target and owner:
                same_target = gate._owner_at_line(target_text, line, target_source.stem) == owner
            relative = path.relative_to(source).as_posix()
            changed_symbol = gate._issue_touches_changed_symbol(path.read_text(encoding="utf-8", errors="replace"), reported, line,
                                                               changed_lines.get(relative, set()))
            if same_target or changed_symbol or rule == "@extrulesproject/code-clone-fragment-check":
                remaining.append({**message, "filePath": issue["filePath"]})
        write_json(task_dir / "smell-after.json", remaining)
        write_json(task_dir / "smell-evidence.json", {"sourceRoot": str(source), "reportPath": response["reportPath"],
                   "scannedFiles": response["scannedFiles"], "remaining": len(remaining)})
        if remaining:
            print(f"目标或变更方法仍有异味：{len(remaining)} 条", file=sys.stderr)
            return 1
        print("候选副本异味复检通过；原工程无需预先应用修改。")
        return 0
    except (BridgeError, OSError, ValueError, KeyError) as error:
        print(f"SMELL_GATE_BLOCKED: 候选副本检测未完成：{error}", file=sys.stderr, flush=True)
        return 3


def execute_candidate(params: dict, config: dict, root: Path, run: Path):
    prepared_run, prepared = load_run(params["taskHandle"], config, root, "prepared.json")
    original = Path(prepared["originalRoot"])
    if snapshot(original) != prepared["baselineFiles"] or configuration_digest(config) != prepared["configDigest"]:
        raise BridgeError("BASELINE_CHANGED", "准备后工程或工具配置变化，请重新分析")
    if not inspect_environment(config)["canRefactor"]:
        raise BridgeError("TOOL_UNAVAILABLE", "重构环境不完整，请先检查环境")
    stage = run / "staging" / original.name
    copy_project(prepared_run / "baseline", stage)
    task_dir = run / "backend"
    shutil.copytree(prepared_run / "backend", task_dir)
    old_prefix = str(prepared_run / "staging")
    for path in task_dir.iterdir():
        if path.suffix in {".json", ".md"}:
            text = path.read_text(encoding="utf-8")
            # JSON stores escaped Windows paths; replace both encodings.
            text = text.replace(json.dumps(old_prefix)[1:-1], json.dumps(str(stage.parent))[1:-1]).replace(old_prefix, str(stage.parent))
            path.write_text(text, encoding="utf-8")
    result = run_pipeline_logged(task_dir, pipeline_config(task_dir, config))
    return freeze_candidate(run, stage, original, prepared_run, prepared, config, result, prepared["configDigest"])


def freeze_candidate(run: Path, stage: Path, original: Path, prepared_run: Path, prepared: dict, config: dict, result: dict, digest: str):
    task_dir = run / "backend"
    if configuration_digest(config) != digest:
        raise BridgeError("BASELINE_CHANGED", "验证期间工具或配置发生变化，请重新验证")
    summarize_failure(task_dir, result)
    before, after = prepared["baselineFiles"], snapshot(stage)
    deleted = set(before) - set(after)
    changed = [name for name, digest in after.items() if before.get(name) != digest]
    if deleted or any(not allowed_production(name) for name in changed):
        raise BridgeError("INVALID_INPUT", "候选包含删除、重命名或非生产文件修改，整项拒绝应用")
    if snapshot(original) != before:
        raise BridgeError("BASELINE_CHANGED", "生成期间原始工程已变化，候选失效")
    entries = []
    for name in changed:
        frozen_after = run / "content/after" / name
        frozen_after.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(stage / name, frozen_after)
        frozen_before = run / "content/before" / name
        if name in before:
            frozen_before.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(prepared_run / "baseline" / name, frozen_before)
        entries.append({"relativePath": name, "kind": "resource" if "/src/main/resources/" in "/" + name else "source",
                        "changeType": "modified" if name in before else "added", "beforeSha256": before.get(name),
                        "afterSha256": after[name], "size": frozen_after.stat().st_size})
    if not entries and result["verdict"] == "PASS":
        result["verdict"] = "FAIL"
        result["reason"] = "候选没有最终生产修改"
        result["failureReason"] = result["reason"]
    write_json(task_dir / "result.json", result)
    manifest = {"candidateId": run.name, "taskHandle": prepared_run.name, "taskId": prepared["taskId"],
                "originalRoot": str(original), "baselineFiles": before, "afterFiles": after,
                "configDigest": digest, "changes": entries,
                "verdict": result["verdict"], "runDirectory": str(run), "result": result}
    write_json(run / "candidate.json", manifest)
    return {"candidate": manifest, "result": result, "runDirectory": str(run)}


def load_candidate_for_validation(identifier: str, config: dict, root: Path):
    candidate_run, candidate = load_run(identifier, config, root, "candidate.json")
    original = Path(candidate["originalRoot"])
    if snapshot(original) != candidate["baselineFiles"]:
        raise BridgeError("BASELINE_CHANGED", "原工程已变化或候选已应用，请重新检测；不能复用旧候选")
    prepared_run, prepared = load_run(candidate["taskHandle"], config, root, "prepared.json")
    if Path(prepared["originalRoot"]) != original or prepared["baselineFiles"] != candidate["baselineFiles"] or snapshot(prepared_run / "baseline") != candidate["baselineFiles"]:
        raise BridgeError("CANDIDATE_CHANGED", "冻结基线已变化，不能恢复候选")
    if not candidate["changes"]:
        raise BridgeError("INVALID_INPUT", "此记录没有生产代码候选变更，请重新生成")
    seen = set()
    for item in candidate["changes"]:
        name = item["relativePath"]
        if name.casefold() in seen or not allowed_production(name) or ".." in Path(name).parts or Path(name).is_absolute():
            raise BridgeError("CANDIDATE_CHANGED", "候选文件路径不符合生产变更要求")
        seen.add(name.casefold())
        for phase, manifest in (("before", candidate["baselineFiles"]), ("after", candidate["afterFiles"])):
            expected = item.get(phase + "Sha256")
            if expected != manifest.get(name):
                raise BridgeError("CANDIDATE_CHANGED", "候选内容哈希与清单不一致")
            if expected is not None:
                file = contained(candidate_run, candidate_run / "content" / phase / name)
                if hash_file(file) != expected:
                    raise BridgeError("CANDIDATE_CHANGED", "冻结候选内容已变化")
    return candidate_run, candidate, prepared_run, prepared


def validate_candidate(params: dict, config: dict, root: Path, run: Path):
    candidate_run, candidate, prepared_run, prepared = load_candidate_for_validation(params["candidateId"], config, root)
    original = Path(candidate["originalRoot"])
    digest = configuration_digest(config)
    stage = run / "staging" / original.name
    copy_project(prepared_run / "baseline", stage)
    for item in candidate["changes"]:
        target = contained(stage, stage / item["relativePath"])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate_run / "content/after" / item["relativePath"], target)
    if snapshot(stage) != candidate["afterFiles"]:
        raise BridgeError("CANDIDATE_CHANGED", "重建后的候选与冻结清单不同")
    task_dir = run / "backend"
    task_dir.mkdir()
    old_prefix, new_prefix = str(candidate_run / "staging"), str(stage.parent)
    for path in (candidate_run / "backend").iterdir():
        if path.is_file() and path.suffix in {".json", ".md"}:
            text = path.read_text(encoding="utf-8")
            text = text.replace(json.dumps(old_prefix)[1:-1], json.dumps(new_prefix)[1:-1]).replace(old_prefix, new_prefix)
            (task_dir / path.name).write_text(text, encoding="utf-8")
    for item in candidate["changes"]:
        if item.get("beforeSha256") is not None:
            baseline = task_dir / "baseline-production" / item["relativePath"]
            baseline.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate_run / "content/before" / item["relativePath"], baseline)
    write_json(task_dir / "refactor-changes.json", {
        "changedProductionFiles": [item["relativePath"] for item in candidate["changes"] if item["kind"] == "source"],
        "changedProductionResources": [item["relativePath"] for item in candidate["changes"] if item["kind"] == "resource"]})
    plan = pipeline_config(task_dir, config)
    plan.pop("refactorAgent", None); plan.pop("repairAgent", None); plan["maxRepairAttempts"] = 0
    emit("workflow.changed", {"status": "正在重新验证冻结候选：执行门禁与评审…"})
    result = run_pipeline_logged(task_dir, plan)
    result["refactorEvidenceFrom"] = str(candidate_run)
    for step in result.get("steps", []):
        if step.get("name") == "refactor-agent" and step.get("status") == "SKIPPED":
            step["reason"] = "使用已有冻结候选，本次不重新执行重构 Agent"
    # Validation and review are read-only with respect to the frozen production candidate.
    if snapshot(stage) != candidate["afterFiles"]:
        raise BridgeError("CANDIDATE_CHANGED", "验证期间候选源码发生变化，不能采用本轮结果")
    response = freeze_candidate(run, stage, original, prepared_run, prepared, config, result, digest)
    response["candidate"]["revalidatedFrom"] = candidate["candidateId"]
    write_json(run / "candidate.json", response["candidate"])
    return response


def validate_applied(params: dict, config: dict, root: Path, run: Path):
    from arkts_smell_refactor.runner import _task_from_file, _context, _run_gates_fail_fast, _final_result
    from arkts_smell_refactor.models import CommandResult
    candidate_run, candidate = load_run(params["candidateId"], config, root, "candidate.json")
    original = Path(candidate["originalRoot"])
    if candidate["verdict"] != "PASS" or snapshot(original) != candidate["afterFiles"] or configuration_digest(config) != candidate["configDigest"]:
        raise BridgeError("BASELINE_CHANGED", "应用内容或配置与已验证候选不同，请重新检测")
    stage = run / "staging" / original.name
    copy_project(original, stage)
    task_dir = run / "backend"
    shutil.copytree(candidate_run / "backend", task_dir)
    old_prefix = str(candidate_run / "staging")
    for path in task_dir.iterdir():
        if path.suffix in {".json", ".md"}:
            text = path.read_text(encoding="utf-8")
            text = text.replace(json.dumps(old_prefix)[1:-1], json.dumps(str(stage.parent))[1:-1]).replace(old_prefix, str(stage.parent))
            path.write_text(text, encoding="utf-8")
    task = _task_from_file(task_dir / "task.json")
    plan = pipeline_config(task_dir, config)
    with contextlib.redirect_stdout(EventLogWriter()):
        steps = _run_gates_fail_fast(task_dir, task, plan, _context(task_dir, task), False, pipeline_progress, "")
    required = [step for step in steps if not (step.name == "linter" and config.get("linterMode") == "skip" and step.status == "SKIPPED")]
    required.append(CommandResult("review-agent", "PASS", reason="复用完全相同源码、依赖、策略的候选 PASS 评审"))
    result = _final_result(task.task_id, required, False)
    summarize_failure(task_dir, result)
    result["validationPolicy"] = {"linterMode": config.get("linterMode", "required")}
    result["reviewEvidenceFrom"] = str(candidate_run)
    write_json(task_dir / "result.json", result)
    response = {"result": result, "runDirectory": str(run)}
    if result["verdict"] == "PASS":
        if snapshot(original) != candidate["afterFiles"]:
            raise BridgeError("BASELINE_CHANGED", "工程在验证时变化，结果已失效")
        refreshed = scan({"scopePath": str(original)}, config, root, run)
        response["issues"] = refreshed["issues"]
    return response


def gate_main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--gate", required=True, choices=("refactor", "smell"))
    parser.add_argument("--task-dir", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--prompt-file", type=Path)
    args = parser.parse_args()
    config = read_json(args.settings)
    configure_environment(config)
    import arkts_smell_refactor.gate as gate
    source = args.source_root.resolve()
    run_root = Path(config["runs"]).resolve()
    contained(run_root, source); contained(run_root, args.task_dir)
    if args.gate == "smell":
        return smell_candidate_gate(args.task_dir, source, config)
    return refactor_agent_gate(args.task_dir, source, Path(discover_tools(config)["deveco"]), args.prompt_file)


def main():
    request = None
    run = None
    try:
        line = sys.stdin.readline(8 * 1024 * 1024 + 1)
        if len(line) > 8 * 1024 * 1024:
            raise BridgeError("INVALID_REQUEST", "请求超过 8 MiB")
        value = json.loads(line)
        if not isinstance(value, dict):
            raise BridgeError("INVALID_REQUEST", "请求必须为 JSON 对象")
        request = value
        if request.get("protocolVersion") != 1:
            raise BridgeError("UNSUPPORTED_PROTOCOL", "仅支持协议版本 1")
        config = request["config"]
        configure_environment(config)
        root = Path(request["projectRoot"]).resolve()
        if not root.is_dir():
            raise BridgeError("INVALID_INPUT", "当前工程目录不存在")
        method = request["method"]
        if method not in {"session.hello", "environment.inspect", "issues.import", "history.list", "candidate.check", "candidate.describe", "candidate.restore"}:
            run = create_run(config, root, method)
        result = dispatch(method, request.get("params", {}), config, root, run)
        if run:
            session = read_json(run / "session.json"); session["state"] = "SUCCEEDED"
            if isinstance(result.get("result"), dict):
                session["verdict"] = result["result"].get("verdict")
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
                    "ok": False, "error": {"code": code, "message": str(error),
                                             "details": error.details if isinstance(error, BridgeError) else {}}}
        OUTPUT.write(json.dumps(response, ensure_ascii=False) + "\n"); OUTPUT.flush()
        return 2


if __name__ == "__main__":
    # Windows pipes otherwise inherit the locale codec (often GBK). The Java peer uses UTF-8.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    raise SystemExit(gate_main() if "--gate" in sys.argv else main())
