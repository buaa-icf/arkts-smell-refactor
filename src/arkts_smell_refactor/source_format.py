"""Keep routine UTF-8 source formatting out of the agent's reasoning loop."""
from __future__ import annotations


def preserve_source_format(original: bytes, edited: bytes) -> bytes:
    bom = b"\xef\xbb\xbf"
    try:
        before = original.decode("utf-8-sig")
        after = edited.decode("utf-8-sig")
    except UnicodeError:
        return edited
    # Never rewrite mixed line endings or lexical constructs whose raw newline
    # bytes could matter. They remain the responsibility of the original edit.
    plain = before.replace("\r\n", "")
    uniform_crlf = "\r\n" in before and "\n" not in plain and "\r" not in plain
    uniform_lf = "\n" in before and "\r" not in before
    sensitive = any(token in before or token in after for token in ("`", "\\\n", "\\\r\n"))
    if not sensitive and (uniform_crlf or uniform_lf) and "\r" not in after.replace("\r\n", ""):
        after = after.replace("\r\n", "\n")
        if uniform_crlf:
            after = after.replace("\n", "\r\n")
    return (bom if original.startswith(bom) else b"") + after.encode("utf-8")
