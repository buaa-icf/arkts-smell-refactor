from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


RULE_TYPES = {
    "@extrulesproject/feature-envy-check": "feature-envy",
    "@extrulesproject/long-method-check": "long-method",
    "@extrulesproject/switch-statement-check": "switch-statement",
    "@extrulesproject/code-clone-fragment-check": "code-clone",
}


@dataclass
class SourceRange:
    start_line: int | None = None
    end_line: int | None = None
    column: int | None = None


@dataclass
class Target:
    file_path: str
    symbol: str | None = None
    source_range: SourceRange = field(default_factory=SourceRange)
    related_targets: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class RefactorTask:
    schema_version: str
    task_id: str
    source_project: str
    commit_hash: str
    workspace_root: str
    project_root: str
    smell_type: str
    rule: str
    severity: str
    message: str
    target: Target
    raw: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        target = data["target"]
        target["range"] = target.pop("source_range")
        return data

    @property
    def target_path(self) -> Path:
        return Path(self.workspace_root) / Path(self.target.file_path)


@dataclass
class CommandResult:
    name: str
    status: str
    command: str | None = None
    exit_code: int | None = None
    duration_seconds: float = 0.0
    output_file: str | None = None
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

