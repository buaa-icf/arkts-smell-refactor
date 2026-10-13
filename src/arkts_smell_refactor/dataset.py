from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .models import RULE_TYPES, RefactorTask, SourceRange, Target
from .utils import read_json, slug


SYMBOL_PATTERNS = [
    re.compile(r"Method '([^']+)'"),
    re.compile(r"method '([^']+)'", re.IGNORECASE),
    re.compile(r"God Class\s+['\"]?([A-Za-z_$][\w$]*)", re.IGNORECASE),
]
CLONE_RE = re.compile(
    r"similar to\s+(.+?\.(?:ets|ts))(?:\s*>\s*[^:]+)?:(\d+)-(\d+)", re.IGNORECASE
)


def _symbol(message: str) -> str | None:
    for pattern in SYMBOL_PATTERNS:
        match = pattern.search(message)
        if match:
            return match.group(1)
    return None


def _related_targets(message: str) -> list[dict[str, Any]]:
    related: list[dict[str, Any]] = []
    for match in CLONE_RE.finditer(message):
        related.append(
            {
                "filePath": match.group(1).replace("\\", "/"),
                "range": {
                    "startLine": int(match.group(2)),
                    "endLine": int(match.group(3)),
                },
            }
        )
    return related


def _test_identity(file_path: str, rule: str, message: str) -> tuple[str, str, str]:
    return (file_path.replace("\\", "/"), rule, message)


def _test_kind_catalog(workspace_root: Path) -> dict[tuple[str, str, str], str | None]:
    catalog: dict[tuple[str, str, str], str | None] = {}
    positive = workspace_root / "arkts-code-smell" / "dataset" / "positive"
    for kind in ("local-test", "instrument-test"):
        for path in (positive / kind).glob("*.json"):
            records = read_json(path)
            if not isinstance(records, list):
                continue
            for record in records:
                if not isinstance(record, dict):
                    continue
                for message in record.get("messages", []):
                    key = _test_identity(str(record.get("filePath", "")), str(message.get("rule", "")), str(message.get("message", "")))
                    if key in catalog and catalog[key] != kind:
                        catalog[key] = None
                    else:
                        catalog[key] = kind
    return catalog


def load_dataset_tasks(
    dataset_path: Path,
    workspace_root: Path,
    only_index: int | None = None,
) -> list[RefactorTask]:
    data = read_json(dataset_path)
    if not isinstance(data, list):
        raise ValueError("阳性数据集顶层必须是 JSON 数组")

    dataset_kind = dataset_path.parent.name if dataset_path.parent.name in {"local-test", "instrument-test"} else None
    test_kinds = {} if dataset_kind else _test_kind_catalog(workspace_root)

    tasks: list[RefactorTask] = []
    ordinal = 0
    for record_index, record in enumerate(data):
        if not isinstance(record, dict) or not isinstance(record.get("messages"), list):
            raise ValueError(
                f"第 {record_index + 1} 条不是 filePath + messages[] 格式；"
                "第一版暂不支持 Data Clumps/CleanArch 特殊格式"
            )
        file_path = str(record.get("filePath", "")).replace("\\", "/")
        source_project = str(record.get("sourceProject", ""))
        commit_hash = str(record.get("commitHash", ""))
        if not file_path:
            raise ValueError(f"第 {record_index + 1} 条缺少 filePath")

        for message_index, message in enumerate(record["messages"]):
            ordinal += 1
            if only_index is not None and ordinal != only_index:
                continue
            rule = str(message.get("rule", ""))
            test_kind = message.get("testKind", record.get("testKind", dataset_kind))
            if test_kind is None:
                test_kind = test_kinds.get(_test_identity(file_path, rule, str(message.get("message", ""))))
            if test_kind is not None and test_kind not in {"local-test", "instrument-test"}:
                raise ValueError(f"第 {record_index + 1} 条的 testKind 必须是 local-test 或 instrument-test")
            smell_type = RULE_TYPES.get(rule, slug(rule.replace("@extrulesproject/", "")))
            symbol = _symbol(str(message.get("message", "")))
            task_id = f"{smell_type}-{ordinal:04d}-{slug(symbol or Path(file_path).stem)}"
            project_root = workspace_root / source_project if source_project else workspace_root
            tasks.append(
                RefactorTask(
                    schema_version="1.0",
                    task_id=task_id,
                    source_project=source_project,
                    commit_hash=commit_hash,
                    workspace_root=str(workspace_root.resolve()),
                    project_root=str(project_root.resolve()),
                    smell_type=smell_type,
                    rule=rule,
                    severity=str(message.get("severity", "")),
                    message=str(message.get("message", "")),
                    target=Target(
                        file_path=file_path,
                        symbol=symbol,
                        source_range=SourceRange(
                            start_line=_int_or_none(message.get("rangeStart", message.get("line"))),
                            end_line=_int_or_none(message.get("rangeEnd", message.get("line"))),
                            column=_int_or_none(message.get("column")),
                        ),
                        related_targets=_related_targets(str(message.get("message", ""))),
                    ),
                    raw={
                        "recordIndex": record_index, "messageIndex": message_index,
                        **({"testKind": test_kind} if test_kind else {}),
                        **({"analysisContext": record["analysisContext"]} if isinstance(record.get("analysisContext"), dict) else {}),
                        **message,
                    },
                )
            )
    if only_index is not None and not tasks:
        raise ValueError(f"数据集中不存在展开后的第 {only_index} 个异味")
    return tasks


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
