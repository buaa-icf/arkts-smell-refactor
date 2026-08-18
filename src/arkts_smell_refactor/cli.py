from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .dataset import load_dataset_tasks
from .prompts import build_refactor_prompt, build_review_prompt
from .risk import analyze_risks
from .runner import execute_pipeline, load_config
from .utils import write_json, write_text


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="arkts-refactor", description="ArkTS 异味重构增强与验证工具")
    sub = parser.add_subparsers(dest="command", required=True)

    configure = sub.add_parser("configure", help="保存本机默认工作区，以后启动时无需重复输入路径")
    configure.add_argument("--workspace", required=True, type=Path, help="包含 sourceProject 目录的工作区根目录")

    doctor = sub.add_parser("doctor", help="检查默认工作区和外部工具是否可被当前终端识别")
    doctor.add_argument("--workspace", type=Path, help="临时覆盖默认工作区")

    prepare = sub.add_parser("prepare", help="从阳性数据集生成任务、风险报告和 Prompt")
    prepare.add_argument("--dataset", required=True, type=Path, help="阳性数据集 JSON")
    prepare.add_argument("--workspace", required=True, type=Path, help="包含 sourceProject 目录的工作区根目录")
    prepare.add_argument("--output", required=True, type=Path, help="任务输出目录")
    prepare.add_argument("--index", type=int, help="只准备展开后的第 N 个异味（从 1 开始）")

    run = sub.add_parser("run", help="执行重构 Agent 和五层验证")
    run.add_argument("--task-dir", required=True, type=Path)
    run.add_argument("--config", required=True, type=Path)
    run.add_argument("--dry-run", action="store_true", help="只渲染命令，不执行外部程序")

    start = sub.add_parser("start", help="启动交互模式，粘贴阳性数据集 JSON 后全自动执行")
    start.add_argument("--workspace", type=Path, help="可选；通常会根据 sourceProject 自动定位")
    return parser


def user_config_path() -> Path:
    if sys.platform == "win32" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "arkts-smell-refactor" / "config.json"
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return config_home / "arkts-smell-refactor" / "config.json"


def configure(args: argparse.Namespace) -> int:
    workspace = args.workspace.expanduser().resolve()
    if not workspace.is_dir():
        raise ValueError(f"工作区目录不存在：{workspace}")
    path = user_config_path()
    write_json(path, {"workspace": str(workspace)})
    print(f"已保存默认工作区：{workspace}")
    print(f"配置文件：{path}")
    return 0


def default_workspace(explicit: Path | None) -> Path | None:
    if explicit:
        return explicit.expanduser().resolve()
    environment = os.environ.get("ARKTS_REFACTOR_WORKSPACE")
    if environment:
        return Path(environment).expanduser().resolve()
    path = user_config_path()
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("workspace"):
            return Path(data["workspace"]).expanduser().resolve()
    return None


def doctor(args: argparse.Namespace) -> int:
    from .automatic import _discover_tools

    workspace = default_workspace(args.workspace)
    print(f"Python：{sys.executable}")
    print(f"用户配置：{user_config_path()}")
    if not workspace:
        print("工作区：未配置（请运行 arkts-refactor configure --workspace <目录>）")
        return 2
    print(f"工作区：{workspace}（{'存在' if workspace.is_dir() else '不存在'}）")
    tools = _discover_tools(workspace)
    for name, command in tools.items():
        print(f"{name}：{command or '未找到'}")
    missing = [name for name, command in tools.items() if not command]
    if not workspace.is_dir() or missing:
        print("检查结果：BLOCKED；缺少：" + "、".join(missing) if missing else "检查结果：BLOCKED；工作区不存在")
        return 2
    print("检查结果：PASS")
    return 0


def prepare(args: argparse.Namespace) -> int:
    tasks = load_dataset_tasks(args.dataset.resolve(), args.workspace.resolve(), args.index)
    args.output.mkdir(parents=True, exist_ok=True)
    index: list[dict[str, str]] = []
    for task in tasks:
        task_dir = args.output / task.task_id
        task_dir.mkdir(parents=True, exist_ok=True)
        risk = analyze_risks(task)
        write_json(task_dir / "task.json", task.to_dict())
        write_json(task_dir / "risk-report.json", risk)
        write_text(task_dir / "refactor-prompt.md", build_refactor_prompt(task, risk))
        write_text(task_dir / "review-prompt.md", build_review_prompt(task, risk))
        index.append({"taskId": task.task_id, "taskDir": str(task_dir.resolve())})
        print(f"prepared: {task.task_id}")
    write_json(args.output / "index.json", index)
    print(f"共生成 {len(tasks)} 个任务：{args.output.resolve()}")
    return 0


def run(args: argparse.Namespace) -> int:
    result = execute_pipeline(args.task_dir.resolve(), load_config(args.config.resolve()), args.dry_run)
    print(f"verdict: {result['verdict']}")
    return 0 if result["verdict"] in {"PASS", "DRY_RUN"} else 2


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "configure":
            return configure(args)
        if args.command == "doctor":
            return doctor(args)
        if args.command == "prepare":
            return prepare(args)
        if args.command == "run":
            return run(args)
        from .automatic import run_interactive
        run_interactive(Path(__file__).resolve().parents[2], default_workspace(args.workspace))
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
