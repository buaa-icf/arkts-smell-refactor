"""Exact lexical evidence for copying long static string segments without retyping."""
from __future__ import annotations

import hashlib
import json
import re


_TOKENS = re.compile(r'''//[^\r\n]*|/\*[\s\S]*?\*/|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*`''')
_COMMENTS = re.compile(r"//[^\r\n]*|/\*[\s\S]*?\*/")


def long_literal_segments(text: str, start_line: int | None, end_line: int | None) -> list[dict]:
    """Fingerprint literal token sequences, not decoded values or arbitrary code.

    Equal fingerprints mean identical string tokens joined only with '+'. A
    different fingerprint proves nothing about value equality. Templates and
    dynamic operands are deliberately not folded/evaluated.
    """
    groups: list[list[re.Match]] = []
    for match in _TOKENS.finditer(text):
        token = match.group()
        if token.startswith(("//", "/*")):
            continue
        if token.startswith("`"):
            groups.append([])
            continue
        gap = text[groups[-1][-1].end():match.start()] if groups and groups[-1] else ""
        if groups and groups[-1] and _COMMENTS.sub("", gap).strip() == "+":
            groups[-1].append(match)
        else:
            groups.append([match])
    result = []
    for group in groups:
        if not group:
            continue
        tokens = [match.group() for match in group]
        size = sum(len(token) for token in tokens)
        if size < 200:
            continue
        first, last = group[0].start(), group[-1].end()
        begin_line = text.count("\n", 0, first) + 1
        finish_line = text.count("\n", 0, last) + 1
        if (end_line and begin_line > end_line) or (start_line and finish_line < start_line):
            continue
        encoded = json.dumps(tokens, ensure_ascii=True, separators=(",", ":"))
        result.append({
            "startLine": begin_line, "startColumn": first - text.rfind("\n", 0, first),
            "endLine": finish_line, "endColumnExclusive": last - text.rfind("\n", 0, last),
            "literalCount": len(tokens), "literalTokenChars": size,
            "tokenSha256": hashlib.sha256(encoded.encode("ascii")).hexdigest(),
            "preview": tokens[0][:64],
        })
    return result


def shared_literal_groups(instances: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for index, instance in enumerate(instances):
        for segment in instance.get("longLiteralSegments", []):
            groups.setdefault(segment["tokenSha256"], []).append({
                "instance": index, "filePath": instance["filePath"],
                "startLine": segment["startLine"], "endLine": segment["endLine"],
            })
    return [{"tokenSha256": digest, "occurrences": entries} for digest, entries in groups.items()
            if len({entry["instance"] for entry in entries}) > 1]
