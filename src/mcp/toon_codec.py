#!/usr/bin/env python3
"""WS3 TOON codec (PR #94) — Token-Oriented Object Notation.

Minimal deterministic encoding for board signals, checkpoints and KV
payloads. Semantics identical to JSON; structurally smaller (no braces,
no per-key quotes, no commas); JSON fallback when the parser is
absent/fails.

Only the standard library (``json`` + ``re``) — prohibited: external
gateway, generative embedding.

Encoding rules (mirrored byte-for-byte by ``src/pantheon/toon-codec.ts``):

- Scalars: ``None``/``True``/``False`` → ``null``/``true``/``false``;
  numbers → shortest form; strings bare when unambiguous, else
  JSON-quoted (quotes/backslash/newline, leading/trailing space,
  ``null``/``true``/``false``/numeric lookalikes, ``{}``/``[]``).
- Dicts: one ``key: value`` line each; nested values on deeper indent
  (2 spaces); empty dict → ``{}``.
- Lists of scalars: ``- item`` lines; empty list → ``[]``.
- Lists of dicts with uniform keys: ``@table k1|k2`` header + ``v1|v2``
  rows (savings are per payload class — ~11% on content-dominated board
  records up to ~47% on large tabular checkpoints — see
  ``docs/ws3-token-opt-measurements.md`` for the reproducible table).
- Dict values never need quoting for ``:`` (split is on the FIRST colon);
  list items / top-level scalars that look like ``key: ...`` are quoted.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

TABLE_MARKER = "@table "

#: Default cap on nested-block depth accepted by ``toon_decode`` (DoS guard:
#: hostile deeply-nested input fails with ``ValueError``, never RecursionError).
TOON_MAX_DEPTH = 100

#: Default cap on input length accepted by ``toon_decode`` (DoS guard).
TOON_MAX_CHARS = 1_000_000

_BARE_KEY_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.@+~/-]*$")
_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?(?:\d+\.\d+|\d+\.\d*[eE][+-]?\d+|\d+[eE][+-]?\d+)$")
_KEYLIKE_RE = re.compile(
    r'^(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_][A-Za-z0-9_.@+~/\-]*)\s*:(?:\s+|$)'
)

_RESERVED_WORDS = frozenset({"null", "true", "false", "{}", "[]"})


def _looks_numeric(text: str) -> bool:
    return bool(_INT_RE.match(text) or _FLOAT_RE.match(text))


def _quote(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def _bare_value(text: str, *, in_table: bool = False) -> bool:
    """Whether a string value is unambiguous without quotes in VALUE position.

    In table cells (``in_table=True``) a bare ``|`` would split the row, so
    values containing ``|`` must be quoted.
    """
    if not text or text != text.strip():
        return False
    if text in _RESERVED_WORDS or _looks_numeric(text):
        return False
    if in_table and "|" in text:
        return False
    return not ('"' in text or "\\" in text or "\n" in text or "\r" in text)


def _encode_scalar(
    value: Any, *, item_position: bool = False, table_cell: bool = False
) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    text = str(value)
    if _bare_value(text, in_table=table_cell) and not (
        item_position and _KEYLIKE_RE.match(text)
    ):
        # "- key: ..." reads as a dict item — quote to keep the string.
        return text
    return _quote(text)


def _encode_key(key: str) -> str:
    if _BARE_KEY_RE.match(key):
        return key
    return _quote(key)


def _is_uniform_dict_list(value: Any) -> bool:
    if not isinstance(value, list) or not value:
        return False
    if not all(isinstance(item, dict) for item in value):
        return False
    first_keys = list(value[0].keys())
    if not first_keys:
        return False
    return all(list(item.keys()) == first_keys for item in value)


def _split_cells(line: str) -> list[str]:
    """Split a table row on ``|`` outside double quotes."""
    cells: list[str] = []
    current: list[str] = []
    in_quotes = False
    escaped = False
    for char in line:
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\" and in_quotes:
            current.append(char)
            escaped = True
        elif char == '"':
            current.append(char)
            in_quotes = not in_quotes
        elif char == "|" and not in_quotes:
            cells.append("".join(current))
            current = []
        else:
            current.append(char)
    cells.append("".join(current))
    return cells


def toon_encode(value: Any) -> str:
    """Encode ``value`` to a TOON string (deterministic, no spaces wasted)."""
    return "\n".join(_encode_value(value, 0))


def _encode_value(value: Any, indent: int) -> list[str]:
    pad = " " * indent
    if value is None or isinstance(value, (bool, int, float, str)):
        return [pad + _encode_scalar(value)]
    if isinstance(value, dict):
        return _encode_dict(value, pad, indent)
    if isinstance(value, list):
        return _encode_list(value, pad, indent)
    raise TypeError(f"TOON cannot encode {type(value).__name__}")


def _encode_dict(value: dict[Any, Any], pad: str, indent: int) -> list[str]:
    if not value:
        return [pad + "{}"]
    lines: list[str] = []
    for key, item in value.items():
        encoded_key = _encode_key(str(key))
        if item is None or isinstance(item, (bool, int, float, str)):
            lines.append(f"{pad}{encoded_key}: {_encode_scalar(item)}")
        elif isinstance(item, dict) and not item:
            lines.append(f"{pad}{encoded_key}: {{}}")
        elif isinstance(item, list) and not item:
            lines.append(f"{pad}{encoded_key}: []")
        else:
            lines.append(f"{pad}{encoded_key}:")
            lines.extend(_encode_value(item, indent + 2))
    return lines


def _encode_list(value: list[Any], pad: str, indent: int) -> list[str]:
    if not value:
        return [pad + "[]"]
    if _is_uniform_dict_list(value):
        return _encode_table(value, pad)
    lines: list[str] = []
    for item in value:
        lines.extend(_encode_item(item, indent))
    return lines


def _encode_table(value: list[Any], pad: str) -> list[str]:
    first = value[0]
    assert isinstance(first, dict)
    keys = list(first.keys())
    lines = [pad + TABLE_MARKER + "|".join(_encode_key(str(k)) for k in keys)]
    for item in value:
        assert isinstance(item, dict)
        cells = [
            _encode_scalar(item[k], item_position=True, table_cell=True) for k in keys
        ]
        lines.append(pad + "|".join(cells))
    return lines


def _encode_item(item: Any, indent: int) -> list[str]:
    pad = " " * indent
    if item is None or isinstance(item, (bool, int, float, str)):
        return [f"{pad}- {_encode_scalar(item, item_position=True)}"]
    if isinstance(item, dict) and not item:
        return [f"{pad}- {{}}"]
    if isinstance(item, list) and not item:
        return [f"{pad}- []"]
    sub = _encode_value(item, indent + 2)
    first = sub[0].strip()
    return [f"{pad}- {first}", *sub[1:]]


def _parse_scalar(token: str) -> Any:
    if token == "null":
        return None
    if token in {"true", "false"}:
        return token == "true"
    if token in {"{}", "[]"}:
        return {} if token == "{}" else []
    if _looks_numeric(token):
        return int(token) if _INT_RE.match(token) else float(token)
    if token.startswith('"'):
        return json.loads(token)
    return token


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _split_key_value(text: str) -> tuple[str, str]:
    """Split ``key: value`` on the FIRST colon (values may contain colons)."""
    if text.startswith('"'):
        try:
            key, end = json.JSONDecoder().raw_decode(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"TOON: line without ':' separator: {text!r}") from exc
        rest_text = text[end:].lstrip()
        if not rest_text.startswith(":"):
            raise ValueError(f"TOON: line without ':' separator: {text!r}")
        if not isinstance(key, str) or not key:
            raise ValueError(f"TOON: empty key in line: {text!r}")
        return key, rest_text[1:].strip()
    idx = text.find(":")
    if idx < 0:
        raise ValueError(f"TOON: line without ':' separator: {text!r}")
    raw_key = text[:idx].strip()
    if not raw_key:
        raise ValueError(f"TOON: empty key in line: {text!r}")
    key = raw_key
    rest = text[idx + 1 :].strip()
    return key, rest


def toon_decode(
    text: str, *, max_depth: int = TOON_MAX_DEPTH, max_chars: int = TOON_MAX_CHARS
) -> Any:
    """Decode a TOON string back to the identical value (raises ValueError).

    ``max_depth``/``max_chars`` are DoS guards: oversized inputs fail with a
    controlled ``ValueError`` instead of ``RecursionError``/memory blowup.
    """
    if len(text) > max_chars:
        raise ValueError(
            f"TOON: input too large ({len(text)} chars > max_chars={max_chars})"
        )
    lines = [line for line in text.split("\n") if line.strip() != ""]
    if not lines:
        raise ValueError("TOON: empty input")
    stripped = lines[0].strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"TOON: invalid JSON fallback: {exc}") from exc
    value, next_idx = _parse_block(lines, 0, 0, 0, max_depth)
    if next_idx != len(lines):
        raise ValueError(f"TOON: trailing content at line {next_idx + 1}")
    return value


def _parse_block(
    lines: list[str], idx: int, indent: int, depth: int, max_depth: int
) -> tuple[Any, int]:
    if depth > max_depth:
        raise ValueError(f"TOON: max_depth={max_depth} exceeded")
    stripped = lines[idx].strip()
    if stripped.startswith("@table "):
        return _parse_table(lines, idx, indent)
    if stripped.startswith("- ") or stripped == "-":
        return _parse_list(lines, idx, indent, depth, max_depth)
    return _parse_dict(lines, idx, indent, depth, max_depth)


def _parse_table(
    lines: list[str], idx: int, indent: int
) -> tuple[list[dict[str, Any]], int]:
    header = lines[idx].strip()[len(TABLE_MARKER) :]
    keys = [
        _parse_scalar(cell) if cell.startswith('"') else cell
        for cell in _split_cells(header)
    ]
    if not keys or any(not k for k in keys):
        raise ValueError(f"TOON: bad @table header at line {idx + 1}")
    rows: list[dict[str, Any]] = []
    idx += 1
    while idx < len(lines) and _indent_of(lines[idx]) == indent:
        row_stripped = lines[idx].strip()
        if row_stripped.startswith(("@table ", "- ")) or row_stripped == "-":
            break
        if ":" in row_stripped and _KEYLIKE_RE.match(row_stripped):
            break
        cells = _split_cells(row_stripped)
        if len(cells) != len(keys):
            raise ValueError(f"TOON: row width mismatch at line {idx + 1}")
        rows.append({k: _parse_scalar(c) for k, c in zip(keys, cells, strict=True)})
        idx += 1
    return rows, idx


def _parse_dict(
    lines: list[str], idx: int, indent: int, depth: int, max_depth: int
) -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {}
    while idx < len(lines):
        line = lines[idx]
        if line.strip() == "" or _indent_of(line) != indent:
            break
        stripped = line.strip()
        if stripped.startswith(("@table ", "- ")) or stripped == "-":
            break
        key, rest = _split_key_value(stripped)
        if rest == "":
            idx += 1
            if idx >= len(lines) or _indent_of(lines[idx]) <= indent:
                raise ValueError(f"TOON: missing nested block for key {key!r}")
            nested, idx = _parse_block(
                lines, idx, _indent_of(lines[idx]), depth + 1, max_depth
            )
            result[key] = nested
        else:
            result[key] = _parse_scalar(rest)
            idx += 1
    return result, idx


@dataclass
class _ListParseContext:
    """Shared cursor for ``- key: value`` list-item parsing (PLR0913)."""

    lines: list[str]
    indent: int
    depth: int
    max_depth: int


def _parse_list_continuation(
    ctx: _ListParseContext, idx: int, item: dict[str, Any]
) -> int:
    """Consume ``indent+`` continuation lines (``key: value``) of a dict item."""
    lines, indent, depth, max_depth = ctx.lines, ctx.indent, ctx.depth, ctx.max_depth
    while idx < len(lines) and _indent_of(lines[idx]) > indent:
        cont = lines[idx].strip()
        sub_key, sub_rest = _split_key_value(cont)
        if sub_rest == "":
            idx += 1
            if idx >= len(lines) or _indent_of(lines[idx]) <= _indent_of(
                lines[idx - 1]
            ):
                raise ValueError(f"TOON: missing nested block for key {sub_key!r}")
            nested, idx = _parse_block(
                lines, idx, _indent_of(lines[idx]), depth + 1, max_depth
            )
            item[sub_key] = nested
        else:
            item[sub_key] = _parse_scalar(sub_rest)
            idx += 1
    return idx


def _parse_list_dict_item(
    ctx: _ListParseContext, idx: int, rest: str
) -> tuple[dict[str, Any], int]:
    """Parse a ``- key: value`` dict item plus its continuation lines."""
    lines, indent, depth, max_depth = ctx.lines, ctx.indent, ctx.depth, ctx.max_depth
    key, sub_rest = _split_key_value(rest)
    item: dict[str, Any] = {}
    if sub_rest == "":
        idx += 1
        if idx >= len(lines) or _indent_of(lines[idx]) <= indent:
            raise ValueError(f"TOON: missing nested block for key {key!r}")
        nested, idx = _parse_block(
            lines, idx, _indent_of(lines[idx]), depth + 1, max_depth
        )
        item[key] = nested
    else:
        item[key] = _parse_scalar(sub_rest)
        idx += 1
    idx = _parse_list_continuation(ctx, idx, item)
    return item, idx


def _parse_list(
    lines: list[str], idx: int, indent: int, depth: int, max_depth: int
) -> tuple[list[Any], int]:
    items: list[Any] = []
    while idx < len(lines):
        line = lines[idx]
        if _indent_of(line) != indent:
            break
        stripped = line.strip()
        if not (stripped.startswith("- ") or stripped == "-"):
            break
        rest = stripped[1:].strip()
        if rest == "":
            idx += 1
            if idx >= len(lines) or _indent_of(lines[idx]) <= indent:
                raise ValueError(
                    f"TOON: missing nested block in list at line {idx + 1}"
                )
            nested, idx = _parse_block(
                lines, idx, _indent_of(lines[idx]), depth + 1, max_depth
            )
            items.append(nested)
            continue
        if _KEYLIKE_RE.match(rest):
            ctx = _ListParseContext(lines, indent, depth, max_depth)
            item, idx = _parse_list_dict_item(ctx, idx, rest)
            items.append(item)
        else:
            items.append(_parse_scalar(rest))
            idx += 1
    return items, idx


def toon_decode_auto(
    text: str, *, max_depth: int = TOON_MAX_DEPTH, max_chars: int = TOON_MAX_CHARS
) -> Any:
    """Decode TOON, falling back to JSON (mirrors "parser absent" mode).

    Raises ValueError with a consistent ``TOON:`` message when the input is
    neither valid TOON nor valid JSON (never leaks the raw JSON error).
    """
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"TOON: invalid JSON fallback: {exc}") from exc
    try:
        return toon_decode(text, max_depth=max_depth, max_chars=max_chars)
    except ValueError:
        pass
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"TOON: invalid input (neither TOON nor JSON): {stripped[:60]!r}"
        ) from exc


def _chars_to_tokens(chars: int) -> int:
    """Deterministic token estimate: ``ceil(chars / 4)`` (WS3 metering basis)."""
    if chars <= 0:
        return 0
    return -(-chars // 4)


def toon_size_report(value: Any) -> dict[str, Any]:
    """Compare JSON vs TOON sizes for ``value``.

    Reports BOTH chars and tokens: token ratios on tiny payloads suffer
    ceiling bias (``ceil`` rounds 161→41 vs 143→36), so the char columns are
    the honest basis and the token columns show what metering will debit.
    Per-class numbers: see ``docs/ws3-token-opt-measurements.md``.
    """
    compact_json = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    toon = toon_encode(value)
    ratio = len(toon) / len(compact_json) if compact_json else 1.0
    json_tokens = _chars_to_tokens(len(compact_json))
    toon_tokens = _chars_to_tokens(len(toon))
    token_ratio = toon_tokens / json_tokens if json_tokens else 1.0
    return {
        "json_chars": len(compact_json),
        "toon_chars": len(toon),
        "ratio": round(ratio, 4),
        "saved_pct": round((1.0 - ratio) * 100.0, 2),
        "json_tokens": json_tokens,
        "toon_tokens": toon_tokens,
        "token_ratio": round(token_ratio, 4),
        "token_saved_pct": round((1.0 - token_ratio) * 100.0, 2),
    }
