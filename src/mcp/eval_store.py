#!/usr/bin/env python3
"""Plugin eval certification storage — ``plugin_eval`` memory namespace.

Thin stdlib-only wrapper around the memory SQLite DB (same schema as
``src/mcp/memory_mcp_server.py``) for plugin-eval certification results.

Namespace: ``plugin_eval``
Key format: ``eval:<name>:<date>``  (e.g. ``eval:tdd-with-agents:2026-08-21``)
Metadata:   ``{"type": "eval", "score": N}``

Follows the ``council_decisions`` namespace pattern (same shape, different
namespace). Write path is used by the eval scripts (``eval-static.py``);
read path is used by the resources server (``pantheon://eval`` resources).

Deliberately dependency-free (stdlib only) so it can be loaded from
``.pantheon/code-mode/`` scripts via importlib without sys.path games.
The memory DB path resolution mirrors ``_pantheon_paths.pantheon_home()``
(canonical source) — kept inline to avoid the import.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import date
from pathlib import Path
from typing import Any

NAMESPACE = "plugin_eval"

# Minimal schema — matches memory_mcp_server.SCHEMA_SQL for the memories
# table (vec/FTS tables are initialized by the memory MCP server on first
# run; eval entries remain readable via list/recall regardless).
_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL DEFAULT 'default',
    key TEXT,
    value TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_ns_key
    ON memories(namespace, key);
"""


# ── Path resolution ───────────────────────────────────────────────────────────


def _db_path() -> Path:
    """Return the memory SQLite DB path (mirrors pantheon_home())."""
    env = os.environ.get("PANTHEON_HOME")
    if env:
        return Path(env).expanduser().resolve() / "memory" / "memory.db"
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg).expanduser().resolve() / "opencode" / "memory" / "memory.db"
    return Path.home() / ".config" / "opencode" / "memory" / "memory.db"


def _connect() -> sqlite3.Connection:
    """Open (creating if needed) the memory DB with row access."""
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(_SCHEMA_SQL)
    return conn


def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _parse_metadata(raw: str) -> dict[str, Any]:
    """Parse the metadata JSON field, defaulting to {} on failure."""
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {}


def _entry_from_row(row: sqlite3.Row) -> dict[str, Any]:
    """Convert a memory row to a plain dict with parsed metadata."""
    entry = dict(row)
    entry["metadata"] = _parse_metadata(entry.get("metadata", "{}"))
    return entry


# ── Write path (eval scripts) ─────────────────────────────────────────────────


def store_eval(
    name: str,
    report: dict[str, Any],
    score: int,
    when: str | None = None,
) -> dict[str, Any]:
    """Store an eval certification result in the ``plugin_eval`` namespace.

    Args:
        name: Plugin/skill/agent name (used in the key).
        report: The eval report dict (JSON-serialized as the value).
        score: Numeric certification score (0-100), stored in metadata.
        when: Optional ISO date for the key (default: today).

    Returns:
        Dict with id, namespace, key, status — or {"error": ...} on
        duplicate key / failure.
    """
    key = f"eval:{name}:{when or date.today().isoformat()}"
    value = json.dumps(report, ensure_ascii=False)
    metadata = json.dumps({"type": "eval", "score": int(score)})
    now = _now_iso()

    conn = _connect()
    try:
        cur = conn.execute(
            """INSERT INTO memories (namespace, key, value, metadata,
             created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [NAMESPACE, key, value, metadata, now, now],
        )
        conn.commit()
        return {
            "id": cur.lastrowid,
            "namespace": NAMESPACE,
            "key": key,
            "status": "stored",
        }
    except sqlite3.IntegrityError:
        conn.rollback()
        return {"error": f"Duplicate key or constraint violation: {key}"}
    except Exception as e:
        conn.rollback()
        return {"error": f"Failed to store eval: {e}"}
    finally:
        conn.close()


# ── Read path (resources server) ──────────────────────────────────────────────


def list_evals(limit: int = 100) -> list[dict[str, Any]]:
    """List the latest eval entry per plugin, newest eval date first.

    Returns a list of entry dicts (id, namespace, key, value, metadata,
    created_at) with an extra ``name`` field parsed from the key. Only the
    most recent entry per plugin name is returned, ordered by the eval
    date embedded in the key (``eval:<name>:<date>``) descending.

    Args:
        limit: Maximum entries (default 100).

    Returns:
        List of entry dicts, newest eval date first. Empty if none exist.
    """
    limit = max(1, min(500, int(limit)))
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT id, namespace, key, value, metadata, created_at
               FROM memories WHERE namespace = ? ORDER BY id DESC""",
            [NAMESPACE],
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()

    # Latest entry per plugin name, keyed by the eval date in the key.
    latest: dict[str, tuple[str, dict[str, Any]]] = {}
    for row in rows:
        entry = _entry_from_row(row)
        name, when = _name_and_date(entry.get("key", ""))
        if name is None:
            continue
        if name not in latest or when > latest[name][0]:
            entry["name"] = name
            latest[name] = (when, entry)

    ordered = sorted(latest.values(), key=lambda t: t[0], reverse=True)
    return [entry for _, entry in ordered[:limit]]


def get_latest_eval(name: str) -> dict[str, Any] | None:
    """Return the latest eval entry for a plugin name, or None.

    Args:
        name: Plugin/skill/agent name.

    Returns:
        Entry dict (with parsed metadata and ``name``) or None.
    """
    conn = _connect()
    try:
        # Exact prefix match via substr (NOT LIKE): plugin names may contain
        # '_' or '%', which would act as wildcards under LIKE semantics.
        prefix = f"eval:{name}:"
        rows = conn.execute(
            """SELECT id, namespace, key, value, metadata, created_at
               FROM memories
               WHERE namespace = ? AND substr(key, 1, length(?)) = ?
               ORDER BY created_at DESC, id DESC LIMIT 1""",
            [NAMESPACE, prefix, prefix],
        ).fetchall()
    except sqlite3.Error:
        return None
    finally:
        conn.close()

    if not rows:
        return None
    entry = _entry_from_row(rows[0])
    entry["name"] = name
    return entry


def _name_and_date(key: str) -> tuple[str | None, str]:
    """Split an ``eval:<name>:<date>`` key into (name, date)."""
    if not key.startswith("eval:"):
        return None, ""
    parts = key.split(":")
    if len(parts) < 3:
        return None, ""
    return ":".join(parts[1:-1]) or None, parts[-1]
