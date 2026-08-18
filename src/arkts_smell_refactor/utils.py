from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text.rstrip() + "\n")


def slug(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")
    return normalized[:80] or "task"


def iter_source_files(root: Path) -> Iterable[Path]:
    ignored = {".git", "build", "node_modules", "oh_modules", ".hvigor", ".test"}
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".ets", ".ts"}:
            continue
        if any(part in ignored for part in path.parts):
            continue
        yield path


def normalized_relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()

