"""Directory-cycle evidence for ArkTS cyclic-dependency tasks."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..models import RefactorTask
from ..utils import normalized_relative


IMPORT_RE = re.compile(r"(?:import\s+.*?\s+from\s+|import\s+)['\"]([^'\"]+)['\"]")


def analyze_cyclic_dependency(task: RefactorTask, project_root: Path) -> dict[str, Any]:
    context = task.raw.get("analysisContext", {})
    module_path = str(context.get("modulePath", ""))
    module_root = project_root / module_path
    ets_root = module_root / "src" / "main" / "ets"
    expected = context.get("baselineCycles", [])
    edges = _edge_evidence(ets_root, project_root) if ets_root.is_dir() else []
    cycle_edges = []
    for cycle in expected:
        for index in range(len(cycle) - 1):
            source, target = cycle[index], cycle[index + 1]
            evidence = [
                item for edge in edges
                if edge["from"] == source and edge["to"] == target
                for item in edge["evidence"]
            ]
            cycle_edges.append({"from": source, "to": target, "evidence": evidence})
    entries = [
        normalized_relative(candidate, project_root)
        for candidate in (module_root / "Index.ets", ets_root / "Index.ets")
        if candidate.is_file()
    ]
    return {
        "module": context.get("module"), "modulePath": module_path,
        "baselineCycles": expected, "cycleEdges": cycle_edges,
        "publicEntryFiles": entries,
        "candidateHint": (
            "For each cycle, consider the smallest ownership-correct cut: move a shared type to a neutral layer, "
            "move a symbol to its real owner, or invert one dependency. Preserve public exports with re-exports or delegates. "
            "These are candidates, not a fixed plan."
        ),
        "analysisLimitations": [
            "The graph uses directory-level lexical analysis of relative imports",
            "Package aliases, dynamic loading and re-export chains require additional validation",
        ],
    }


def risks_and_constraints(analysis: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    missing = [edge for edge in analysis.get("cycleEdges", []) if not edge["evidence"]]
    risks = [{
        "code": "CYCLIC_DEPENDENCY_MULTI_FILE", "level": "high",
        "evidence": f"{len(analysis.get('baselineCycles', []))} cycle(s), {len(analysis.get('cycleEdges', []))} cycle edge(s)",
        "affectedFiles": sorted({item["filePath"] for edge in analysis.get("cycleEdges", []) for item in edge["evidence"]}),
    }]
    if missing:
        risks.append({
            "code": "CYCLE_EDGE_EVIDENCE_INCOMPLETE", "level": "medium",
            "evidence": "Some declared cycle edges were not located by lexical scanning",
            "affectedFiles": analysis.get("publicEntryFiles", []),
        })
    constraints = [
        {
            "code": "BREAK_EVERY_BASELINE_CYCLE", "reason": "Fixing one edge may leave another cycle",
            "instruction": "Name the cut edge for every declared cycle and rescan the complete module for residual or new cycles",
        },
        {
            "code": "PRESERVE_DEPENDENCY_OWNERSHIP", "reason": "Mechanical moves can create wrong owners or reverse dependencies",
            "instruction": "Choose neutral-layer extraction, symbol movement or dependency inversion based on the real owner; do not copy implementation or mutable state",
        },
        {
            "code": "PRESERVE_PUBLIC_EXPORTS", "reason": "Repository callers do not represent every external consumer",
            "instruction": "Preserve public module entries, export names, signatures and semantics when moving symbols",
        },
    ]
    return risks, constraints


def _edge_evidence(ets_root: Path, project_root: Path) -> list[dict[str, Any]]:
    directories = {path.name: path.resolve() for path in ets_root.iterdir() if path.is_dir()}
    edges: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for source_name, source_dir in directories.items():
        for path in source_dir.rglob("*.ets"):
            for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                for match in IMPORT_RE.finditer(line):
                    target = _resolve_import(path, match.group(1))
                    if not target: continue
                    for target_name, target_dir in directories.items():
                        if target_name == source_name: continue
                        try: target.relative_to(target_dir)
                        except ValueError: continue
                        edges.setdefault((source_name, target_name), []).append({
                            "filePath": normalized_relative(path, project_root),
                            "line": number, "importPath": match.group(1),
                        })
                        break
    return [{"from": source, "to": target, "evidence": evidence} for (source, target), evidence in sorted(edges.items())]


def _resolve_import(source: Path, import_path: str) -> Path | None:
    if not import_path.startswith("."): return None
    base = (source.parent / import_path).resolve()
    for candidate in (base, base.with_suffix(".ets"), base / "Index.ets", base / "index.ets"):
        if candidate.exists(): return candidate.resolve()
    return base
