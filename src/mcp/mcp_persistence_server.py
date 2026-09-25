#!/usr/bin/env python3
"""Pantheon Persistence MCP Server.

Key-Value store with FTS5 full-text search, TTL-based expiration,
and namespace isolation. Uses SQLite with zero external dependencies.

Usage:
    python scripts/mcp_persistence_server.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

from _pantheon_paths import pantheon_home, pantheon_project
from mcp.server.fastmcp import FastMCP
from pydantic import Field

# ── Schema ──────────────────────────────────────────────────────────────────────

CREATE_SQL: str = """
CREATE TABLE IF NOT EXISTS kv_store (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TEXT,        -- ISO 8601, NULL = forever
    deleted_at TEXT,        -- NULL = active, set on TTL purge
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    revision INTEGER,        -- context monotonic revision; NULL = legacy row
    UNIQUE(namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_kv_namespace_expires
ON kv_store(namespace, expires_at);

CREATE VIRTUAL TABLE IF NOT EXISTS kv_store_fts USING fts5(
    namespace, key, value,
    content='kv_store', content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS kv_store_ai AFTER INSERT ON kv_store BEGIN
    INSERT INTO kv_store_fts(rowid, namespace, key, value)
    VALUES (new.id, new.namespace, new.key, new.value);
END;

CREATE TRIGGER IF NOT EXISTS kv_store_ad AFTER DELETE ON kv_store BEGIN
    INSERT INTO kv_store_fts(kv_store_fts, rowid, namespace, key, value)
    VALUES('delete', old.id, old.namespace, old.key, old.value);
END;

CREATE TRIGGER IF NOT EXISTS kv_store_softdelete_ad
AFTER UPDATE OF deleted_at ON kv_store
WHEN new.deleted_at IS NOT NULL AND old.deleted_at IS NULL
BEGIN
    INSERT INTO kv_store_fts(kv_store_fts, rowid)
    VALUES('delete', old.id);
END;

CREATE TRIGGER IF NOT EXISTS kv_store_au AFTER UPDATE ON kv_store BEGIN
    INSERT INTO kv_store_fts(kv_store_fts, rowid, namespace, key, value)
    VALUES('delete', old.id, old.namespace, old.key, old.value);
    INSERT INTO kv_store_fts(rowid, namespace, key, value)
    VALUES (new.id, new.namespace, new.key, new.value);
END;
"""

# ── FastMCP App ────────────────────────────────────────────────────────────────

mcp = FastMCP(
    "pantheon-persistence",
    instructions="Key-Value store with FTS5 full-text search, "
    "TTL-based expiration, and namespace isolation.",
)

# ── Database Initialization ─────────────────────────────────────────────────────

_global_db: sqlite3.Connection | None = None
_project_db: sqlite3.Connection | None = None
_DELETELOG_MAX_BYTES: int = 1_048_576  # 1 MB
_DELETELOG_KEEP: int = 3


def _init_db(db_path: Path) -> sqlite3.Connection:
    """Initialize a SQLite database with WAL mode and schema."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    # ── FTS5 Availability Check ──────────────────────────────────────────
    # Check BEFORE schema creation. kv_search uses FTS5, which isn't on all systems.
    row = conn.execute("PRAGMA compile_options").fetchall()
    if not any("ENABLE_FTS5" in r[0] for r in row):
        print(
            "WARNING: SQLite FTS5 not available. kv_search will fail.", file=sys.stderr
        )
        import re as _re  # noqa: PLC0415

        _no_fts = _re.sub(
            r"CREATE VIRTUAL TABLE IF NOT EXISTS kv_store_fts.*?;",
            "",
            CREATE_SQL,
            flags=_re.DOTALL,
        )
        conn.executescript(_no_fts)
    else:
        conn.executescript(CREATE_SQL)
    _ensure_revision_column(conn)
    conn.commit()

    return conn


# `revision` was added after `kv_store` shipped, so an existing database has the
# column only if it is added here. ADD COLUMN is additive and non-destructive:
# pre-existing rows get NULL, which every reader treats as "no revision yet"
# and resolves through the legacy `updated_at` path. No backfill is performed
# on purpose — the live store holds both formats and rewriting them in place
# would be unrecoverable if the mapping were ever wrong.
_ADD_REVISION_SQL: str = (
    "ALTER TABLE kv_store ADD COLUMN revision INTEGER"
)


def _ensure_revision_column(conn: sqlite3.Connection) -> None:
    """Add the dedicated ``revision`` column if this database predates it."""
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(kv_store)")}
    except sqlite3.Error:
        return
    if "revision" in columns:
        return
    try:
        conn.execute(_ADD_REVISION_SQL)
    except sqlite3.OperationalError:
        # Raced with another process applying the same additive migration.
        pass


def _db(scope: str) -> sqlite3.Connection:
    """Resolve the connection for the given scope."""
    if scope == "global":
        if _global_db is None:
            raise RuntimeError("Global database not initialized")
        return _global_db
    if scope == "project":
        if _project_db is None:
            raise ValueError(
                "Project database not available. "
                "Set PANTHEON_PROJECT or use scope='global'"
            )
        return _project_db
    raise ValueError(f"Unknown scope: {scope!r}. Expected 'global' or 'project'.")


# ── Deletelog ────────────────────────────────────────────────────────────────────


def _rotate_deletelog(log_path: Path) -> None:
    """Rotate deletelog at 1MB, keep last 3 rotated files."""
    if not log_path.exists() or log_path.stat().st_size < _DELETELOG_MAX_BYTES:
        return

    # Shift existing rotated files: .3 → remove, .2 → .3, .1 → .2
    for i in range(_DELETELOG_KEEP, 0, -1):
        older = log_path.with_suffix(f".deletelog.{i}")
        if older.exists():
            if i == _DELETELOG_KEEP:
                older.unlink()
            else:
                older.rename(log_path.with_suffix(f".deletelog.{i + 1}"))

    # Rename current log to .1
    log_path.rename(log_path.with_suffix(".deletelog.1"))


def _write_deletelog(db_path: Path, count: int, keys: list[str]) -> None:
    """Append a TTL purge entry to the deletelog."""
    log_path = db_path.with_name(db_path.name + ".deletelog")
    _rotate_deletelog(log_path)

    timestamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    keys_str = ",".join(keys)
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] PURGED={count} KEYS=[{keys_str}]\n")


# ── Resolve scope and init databases ────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--global-db", default=None)
parser.add_argument("--project-db", default=None)
args = parser.parse_args()

_global_root = (
    Path(args.global_db) if args.global_db else pantheon_home() / "persistence"
)
_global_db = _init_db(_global_root / "global.db")

_project_db_instance = None
_project_db_path: Path | None = None
if args.project_db:
    _project_db_path = Path(args.project_db)
    _project_db_instance = _init_db(_project_db_path)
else:
    _proj = pantheon_project()
    if _proj:
        _project_db_path = _proj / ".pantheon" / "persistence" / "project.db"
        _project_db_instance = _init_db(_project_db_path)
_project_db = _project_db_instance


# ── Tools ───────────────────────────────────────────────────────────────────────


@mcp.tool(
    name="kv_store",
    description="Store a key-value pair in a namespace with optional TTL (seconds). "
    "INSERT OR REPLACE on duplicate (namespace, key). "
    "ttl must be an integer between 1 and 31536000, or null/omitted. "
    "All invalid arguments are reported together in one message.",
)
async def kv_store(
    namespace: str,
    key: str,
    value: str,
    ttl: int | None = None,
    scope: str = "project",
) -> dict:
    """Store a value under namespace+key with optional TTL.

    Validates every argument before writing so a caller with both a bad ttl
    and a bad scope sees both violations in one message.

    Args:
        namespace: Logical grouping for keys.
        key: Unique key within the namespace.
        value: String value to store.
        ttl: Time-to-live in seconds (None = forever).
        scope: 'project' (default) or 'global'.

    Returns:
        Status dict with namespace and key.
    """
    errors = _ArgErrors("kv_store")
    try:
        validated_ttl = _validate_ttl(ttl)
    except ValueError as exc:
        errors.report(str(exc), repr(ttl))
        errors.example(TTL_EXAMPLE)
        validated_ttl = None
    _collect_scope_error(errors, scope)
    errors.raise_if_any()

    conn = _db(scope)
    expires_at: str | None = None
    if validated_ttl is not None:
        expires_at = (datetime.now(UTC) + timedelta(seconds=validated_ttl)).isoformat()

    conn.execute(
        "INSERT INTO kv_store (namespace, key, value, expires_at, "
        "created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
        "ON CONFLICT(namespace, key) DO UPDATE SET "
        "  value = excluded.value, "
        "  expires_at = excluded.expires_at, "
        "  updated_at = datetime('now')",
        (namespace, key, value, expires_at),
    )
    conn.commit()

    # Opportunistic auto-purge: if namespace has >500 entries, purge expired
    _opportunistic_auto_purge(conn, namespace)

    return {"status": "stored", "namespace": namespace, "key": key}


@mcp.tool(
    name="kv_get",
    description="Retrieve a value by namespace and key. "
    "Returns None if not found or expired.",
)
async def kv_get(
    namespace: str,
    key: str,
    scope: str = "project",
) -> str | None:
    """Get a value by namespace and key.

    Args:
        namespace: Logical grouping for keys.
        key: Unique key within the namespace.
        scope: 'project' (default) or 'global'.

    Returns:
        Value string or None if not found/expired.
    """
    conn = _db(scope)
    row = conn.execute(
        "SELECT value FROM kv_store "
        "WHERE namespace = ? AND key = ? "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')) "
        "AND deleted_at IS NULL",
        (namespace, key),
    ).fetchone()
    return str(row[0]) if row else None


@mcp.tool(
    name="kv_stats",
    description="Return storage statistics: total entries, expired count, per-namespace breakdown, DB file size.",
)
async def kv_stats(
    scope: str = "project",
) -> dict:
    """Return storage statistics for the given scope.

    Args:
        scope: 'project' (default) or 'global'.

    Returns:
        Dict with total_entries, expired_entries, namespaces breakdown, db_size_bytes.
    """
    conn = _db(scope)

    total = conn.execute(
        "SELECT COUNT(*) FROM kv_store WHERE deleted_at IS NULL"
    ).fetchone()[0]
    expired = conn.execute(
        "SELECT COUNT(*) FROM kv_store "
        "WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday('now') "
        "AND deleted_at IS NULL"
    ).fetchone()[0]

    ns_rows = conn.execute(
        "SELECT namespace, COUNT(*) as cnt, "
        "SUM(CASE WHEN expires_at IS NOT NULL AND julianday(expires_at) < julianday('now') THEN 1 ELSE 0 END) as expired_count "
        "FROM kv_store WHERE deleted_at IS NULL GROUP BY namespace ORDER BY cnt DESC"
    ).fetchall()

    namespaces = {r[0]: {"count": r[1], "expired": r[2]} for r in ns_rows}

    db_path = _resolve_db_path(scope)
    db_size = db_path.stat().st_size if db_path and db_path.exists() else 0

    return {
        "scope": scope,
        "total_entries": total,
        "expired_entries": expired,
        "namespaces": namespaces,
        "db_size_bytes": db_size,
    }


@mcp.tool(
    name="kv_delete",
    description="Delete a key-value pair by namespace and key. "
    "FTS trigger cascades automatically.",
)
async def kv_delete(
    namespace: str,
    key: str,
    scope: str = "project",
) -> dict:
    """Delete a key-value pair.

    Args:
        namespace: Logical grouping for keys.
        key: Unique key within the namespace.
        scope: 'project' (default) or 'global'.

    Returns:
        Status dict indicating deletion outcome.
    """
    conn = _db(scope)
    cursor = conn.execute(
        "DELETE FROM kv_store WHERE namespace = ? AND key = ?",
        (namespace, key),
    )
    conn.commit()
    if cursor.rowcount > 0:
        return {"status": "deleted"}
    return {"status": "not_found"}


@mcp.tool(
    name="kv_list",
    description="List keys in a namespace with optional prefix filter. "
    "Returns up to 'limit' entries (default 100).",
)
async def kv_list(
    namespace: str,
    prefix: str = "",
    scope: str = "project",
    limit: int = 100,
) -> list[dict]:
    """List keys in a namespace, filtered by prefix.

    Args:
        namespace: Logical grouping for keys.
        prefix: Optional key prefix filter.
        scope: 'project' (default) or 'global'.
        limit: Maximum number of results (default 100).

    Returns:
        List of dicts with key, value, created_at, expires_at.
    """
    conn = _db(scope)
    rows = conn.execute(
        "SELECT key, value, created_at, expires_at FROM kv_store "
        "WHERE namespace = ? AND key LIKE ? "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')) "
        "AND deleted_at IS NULL "
        "ORDER BY key LIMIT ?",
        (namespace, f"{prefix}%", limit),
    ).fetchall()
    return [
        {
            "key": r[0],
            "value": r[1],
            "created_at": r[2],
            "expires_at": r[3],
        }
        for r in rows
    ]


@mcp.tool(
    name="kv_search",
    description="Full-text search across keys and values using FTS5. "
    "Optionally filter by namespace.",
)
async def kv_search(
    query: str,
    namespace: str | None = None,
    scope: str = "project",
    limit: int = 20,
) -> list[dict]:
    """Full-text search across keys and values.

    Args:
        query: Free-text search terms (max 10 terms quoted).
        namespace: Optional namespace filter.
        scope: 'project' (default) or 'global'.
        limit: Maximum number of results (default 20).

    Returns:
        List of dicts with namespace, key, value, created_at, score.
    """
    conn = _db(scope)

    # Sanitize: extract up to 10 word tokens, wrap each in quotes
    terms = re.findall(r"\w+", query)[:10]
    terms = [re.escape(t) for t in terms]
    if not terms:
        return []
    fts_query = " OR ".join(f'"{t}"' for t in terms)

    sql: str = (
        "SELECT kv_store.namespace, kv_store.key, kv_store.value, kv_store.created_at, "
        "BM25(kv_store_fts) AS score "
        "FROM kv_store_fts "
        "JOIN kv_store ON kv_store_fts.rowid = kv_store.id "
        "WHERE kv_store_fts MATCH ? "
        "AND kv_store.deleted_at IS NULL "
        "AND (kv_store.expires_at IS NULL OR julianday(kv_store.expires_at) > julianday('now'))"
    )
    params: list[str | int] = [fts_query]

    if namespace is not None:
        sql += " AND kv_store.namespace = ?"
        params.append(namespace)

    sql += " ORDER BY score LIMIT ?"
    params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    return [
        {
            "namespace": r[0],
            "key": r[1],
            "value": r[2],
            "created_at": r[3],
            "score": round(float(r[4]), 4),
        }
        for r in rows
    ]


@mcp.tool(
    name="purge_expired",
    description="Purge expired TTL entries. Optionally dry-run to see count "
    "without deleting. Logs purged keys to deletelog.",
)
async def purge_expired(
    scope: str = "project",
    dry_run: bool = False,
) -> dict:
    """Purge expired TTL entries from the database.

    Args:
        scope: 'project' (default) or 'global'.
        dry_run: If True, only report count without purging.

    Returns:
        Dict with purged count and dry_run flag.
    """
    conn = _db(scope)

    # Find expired entries first
    expired = conn.execute(
        "SELECT key FROM kv_store "
        "WHERE expires_at IS NOT NULL "
        "AND julianday(expires_at) < julianday('now') "
        "AND deleted_at IS NULL",
    ).fetchall()
    expired_keys = [r[0] for r in expired]
    count = len(expired_keys)

    if dry_run:
        return {"purged": count, "dry_run": True}

    if count == 0:
        return {"purged": 0, "dry_run": False}

    # Mark as deleted (soft delete)
    conn.execute(
        "UPDATE kv_store SET deleted_at = datetime('now') "
        "WHERE expires_at IS NOT NULL "
        "AND julianday(expires_at) < julianday('now') "
        "AND deleted_at IS NULL",
    )
    conn.commit()

    # Write deletelog
    db_path = _resolve_db_path(scope)
    if db_path:
        _write_deletelog(db_path, count, expired_keys)

    return {"purged": count, "dry_run": False}


def _opportunistic_auto_purge(
    conn: sqlite3.Connection, namespace: str, threshold: int = 500
) -> None:
    """Lightweight auto-purge: if namespace exceeds threshold, soft-delete expired entries."""
    count = conn.execute(
        "SELECT COUNT(*) FROM kv_store WHERE namespace = ? AND deleted_at IS NULL",
        (namespace,),
    ).fetchone()[0]
    if count <= threshold:
        return

    conn.execute(
        "UPDATE kv_store SET deleted_at = datetime('now') "
        "WHERE namespace = ? AND expires_at IS NOT NULL "
        "AND datetime(expires_at) < datetime('now') AND deleted_at IS NULL",
        (namespace,),
    )
    conn.commit()


@mcp.tool(
    name="kv_delete_namespace",
    description="Delete all entries in a namespace. Optionally limit to entries older than N days.",
)
async def kv_delete_namespace(
    namespace: str,
    scope: str = "project",
    older_than_days: int | None = None,
) -> dict:
    """Delete all entries in a namespace, optionally old entries only.

    Args:
        namespace: Namespace to clear.
        scope: 'project' (default) or 'global'.
        older_than_days: If set, only delete entries older than this many days.

    Returns:
        Dict with deleted count.
    """
    conn = _db(scope)

    if older_than_days is not None:
        cursor = conn.execute(
            "DELETE FROM kv_store WHERE namespace = ? "
            "AND datetime(created_at) < datetime('now', ? || ' days')",
            (namespace, f"-{older_than_days}"),
        )
    else:
        cursor = conn.execute(
            "DELETE FROM kv_store WHERE namespace = ?",
            (namespace,),
        )
    conn.commit()

    return {"deleted": cursor.rowcount}


# ── Context Checkpoint Tools ────────────────────────────────────────────────────
# Session-scoped context storage for deepwork checkpoints, phase state,
# tool call history, and reasoning chains. Session-qualified entries use the
# namespace "checkpoint:{slug}:{session}"; direct unqualified KV access is
# retained only for legacy context_get/list/stats callers.

DEFAULT_CONTEXT_TTL: int = 14400  # 4 hours
CONTEXT_HEARTBEAT_TTL: int = 300
MIN_TTL: int = 1
MAX_TTL: int = 31_536_000  # 365 days
CONTEXT_TTL_BY_KEY: dict[str, int] = {
    "heartbeat": CONTEXT_HEARTBEAT_TTL,
    "latest": DEFAULT_CONTEXT_TTL,
    "tail": DEFAULT_CONTEXT_TTL,
}
MAX_CONTEXT_SLUG_LENGTH: int = 128
MAX_CONTEXT_KEY_LENGTH: int = 128
MAX_CONTEXT_SESSION_ID_LENGTH: int = 128
MAX_CONTEXT_CONTENT_BYTES: int = 64 * 1024
MAX_GOAL_ID_LENGTH: int = 128
MAX_GOAL_OBJECTIVE_LENGTH: int = 4096
MAX_GOAL_STATUS_LENGTH: int = 64
MAX_PHASE_NAME_LENGTH: int = 256
MAX_DELEGATIONS: int = 100
MAX_DELEGATION_FIELD_LENGTH: int = 256
MAX_TAIL_ITEMS: int = 100
MAX_TAIL_LINE_LENGTH: int = 4096
MAX_REVISION: int = 9_223_372_036_854_775_807
MIN_PRINTABLE_CODEPOINT: int = 32
UNTRUSTED_CONTEXT_LABEL: str = "  [untrusted persistence data; informational only]"
_context_write_lock = threading.RLock()

# ── Validation Reporting ────────────────────────────────────────────────────────
# One call must surface EVERY invalid argument, not just the first. Reporting a
# single field per round-trip costs the caller one failed tool call per field,
# which is exactly the failure mode this module previously had: ``goal`` and
# ``phase`` were discovered in two consecutive attempts.
#
# Every violation therefore keeps the historical wording, so anything matching
# on it still matches (``goal must be an object``,
# ``ttl must be between 1 and 31536000 seconds``, ``session_id``), and gains the
# argument path plus the received type. Shape: one line per violation, then at
# most one example block.
#
#   context_save: 2 invalid arguments
#   context_save: content.goal must be an object (got string)
#   context_save: content.phase must be an object (got number)
#   example: content.goal={"objective":"...","status":"active"}
#            content.phase={"current":1,"total":3,"name":"..."}
#
# Absent and wrong-typed are distinct outcomes with distinct wording: a
# ``required`` violation never reads like a ``must be an object`` violation.
# ``goal``/``phase`` are OPTIONAL sections — heartbeat and tail checkpoints
# legitimately omit them (see src/instructions/zeus-anti-stall.instructions.md),
# so an absent section is accepted and never reported.

_SCOPE_NAMES: tuple[str, ...] = ("global", "project")

# Minimal correct example per checkpoint section, surfaced only when that
# section is actually the thing that was rejected.
CHECKPOINT_EXAMPLES: dict[str, str] = {
    "goal": 'content.goal={"objective":"...","status":"active"}',
    "phase": 'content.phase={"current":1,"total":3,"name":"..."}',
    "delegations": (
        'content.delegations={"in_flight":[{"alias":"@hermes","agent":"hermes"}]}'
    ),
    "heartbeat": 'content.heartbeat={"status":"alive","turn_count":1}',
    "tail": 'content.tail=["phase:1 done"]',
}

TTL_EXAMPLE: str = "ttl=3600"
REVISION_EXAMPLE: str = "revision=1"
SCOPE_EXAMPLE: str = 'scope="project"'
SESSION_ID_EXAMPLE: str = 'session_id="ses_abc123"'


def _json_type_name(value: object) -> str:
    """Name a value's JSON type for error messages (ints read as ``number``)."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


class _ArgErrors:
    """Accumulate argument violations so a single call reports all of them."""

    def __init__(self, tool: str) -> None:
        self._tool = tool
        self._violations: list[str] = []
        self._examples: list[str] = []

    def __bool__(self) -> bool:
        return bool(self._violations)

    def add(self, path: str, message: str, got: str | None = None) -> None:
        """Record one violation, optionally suffixing the received type/value."""
        suffix = f" (got {got})" if got is not None else ""
        self._violations.append(f"{path} {message}{suffix}")

    def report(self, message: str, got: str | None = None) -> None:
        """Record a validator message that already names its own argument.

        ``_validate_ttl`` raises ``ttl must be between 1 and 31536000 seconds``,
        so the field name is part of the message and must not be prepended
        again.
        """
        suffix = f" (got {got})" if got is not None else ""
        self._violations.append(f"{message}{suffix}")

    def reroot(self, prefix: str, message: str) -> None:
        """Re-root a self-qualified message under a container path.

        ``goal.objective exceeds its size limit`` becomes
        ``content.goal.objective exceeds its size limit``.
        """
        field, _, rest = message.partition(" ")
        self._violations.append(f"{prefix}.{field} {rest}".rstrip())

    def shape(
        self, path: str, expected: str, value: object, example: str | None = None
    ) -> None:
        """Record a type violation: ``<path> must be <expected> (got <type>)``."""
        self.add(path, f"must be {expected}", _json_type_name(value))
        self.example(example)

    def example(self, example: str | None) -> None:
        """Attach a minimal correct example for the field just recorded."""
        if example:
            self._examples.append(example)

    def message(self) -> str:
        """Render one line per violation plus at most one example block."""
        lines = [f"{self._tool}: {violation}" for violation in self._violations]
        examples = list(dict.fromkeys(self._examples))
        if examples:
            lines.append("example: " + "  ".join(examples))
        if len(self._violations) == 1:
            return "\n".join(lines)
        return f"{self._tool}: {len(self._violations)} invalid arguments\n" + "\n".join(
            lines
        )

    def raise_if_any(self) -> None:
        """Raise once, with every collected violation, if anything was invalid."""
        if self._violations:
            raise ValueError(self.message())


def _normalize_session_id(session_id: str | None) -> str | None:
    """Return a non-empty session ID, or ``None`` for an absent ID."""
    if session_id is None:
        return None
    normalized = session_id.strip()
    return normalized or None


def _validate_identifier(value: str, name: str, limit: int) -> str:
    """Validate a namespace component without rewriting caller data."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    if len(value) > limit:
        raise ValueError(f"{name} exceeds the {limit}-character limit")
    if any(ord(char) < MIN_PRINTABLE_CODEPOINT for char in value):
        raise ValueError(f"{name} contains a control character")
    return value


def _context_namespace(
    slug: str,
    session_id: str | None,
    *,
    legacy: bool = False,
) -> str | None:
    """Build a context namespace with explicit legacy opt-in only."""
    try:
        valid_slug = _validate_identifier(slug, "slug", MAX_CONTEXT_SLUG_LENGTH)
    except ValueError:
        return None
    if session_id is None:
        if legacy:
            return f"checkpoint:{valid_slug}"
        return None
    normalized = _normalize_session_id(session_id)
    if normalized is None:
        return None
    try:
        valid_session = _validate_identifier(
            normalized, "session_id", MAX_CONTEXT_SESSION_ID_LENGTH
        )
    except ValueError:
        return None
    return f"checkpoint:{valid_slug}:{valid_session}"


def _validate_ttl(ttl: object) -> int | None:
    """Validate an optional TTL before it reaches ``datetime.timedelta``."""
    if ttl is None:
        return None
    if isinstance(ttl, bool) or not isinstance(ttl, int):
        raise ValueError("ttl must be an integer or null")
    if ttl < MIN_TTL or ttl > MAX_TTL:
        raise ValueError(f"ttl must be between {MIN_TTL} and {MAX_TTL} seconds")
    return ttl


def _context_ttl(key: str, ttl: int | None) -> int:
    """Return a validated TTL or the explicit policy for a checkpoint key."""
    validated_ttl = _validate_ttl(ttl)
    return (
        validated_ttl
        if validated_ttl is not None
        else CONTEXT_TTL_BY_KEY.get(key, DEFAULT_CONTEXT_TTL)
    )


def _validate_revision(revision: int | None) -> int | None:
    """Validate an optional caller revision used for stale-write rejection."""
    if revision is None:
        return None
    if isinstance(revision, bool) or not isinstance(revision, int):
        raise ValueError("revision must be an integer")
    if revision < 1 or revision > MAX_REVISION:
        raise ValueError(f"revision must be between 1 and {MAX_REVISION}")
    return revision


def _should_update_latest(key: str) -> bool:
    """Keep operational metadata from clobbering the recovery checkpoint."""
    return key not in {"heartbeat", "tail"}


def _validate_bounded_text(value: object, field: str, limit: int) -> None:
    """Validate a string field without changing its contents."""
    if not isinstance(value, str) or len(value.encode()) > limit:
        raise ValueError(f"{field} exceeds its size limit")


def _validate_goal(goal: object) -> None:
    """Validate the bounded goal section of a checkpoint."""
    if not isinstance(goal, dict):
        raise ValueError("goal must be an object")
    for field, limit in (
        ("id", MAX_GOAL_ID_LENGTH),
        ("objective", MAX_GOAL_OBJECTIVE_LENGTH),
        ("status", MAX_GOAL_STATUS_LENGTH),
    ):
        value = goal.get(field)
        if value is not None:
            _validate_bounded_text(value, f"goal.{field}", limit)


def _validate_phase(phase: object) -> None:
    """Validate the bounded phase section of a checkpoint."""
    if not isinstance(phase, dict):
        raise ValueError("phase must be an object")
    for field in ("current", "total"):
        value = phase.get(field)
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int) or value < 0
        ):
            raise ValueError(f"phase.{field} must be a non-negative integer")
    name = phase.get("name")
    if name is not None:
        _validate_bounded_text(name, "phase.name", MAX_PHASE_NAME_LENGTH)


def _validate_delegations(delegations: object) -> None:
    """Validate bounded in-flight delegation records."""
    if not isinstance(delegations, dict):
        raise ValueError("delegations must be an object")
    in_flight = delegations.get("in_flight")
    if in_flight is None:
        return
    if not isinstance(in_flight, list) or len(in_flight) > MAX_DELEGATIONS:
        raise ValueError("delegations.in_flight exceeds its size limit")
    for job in in_flight:
        if not isinstance(job, dict):
            raise ValueError("delegations.in_flight entries must be objects")
        for field in ("alias", "agent", "task_id"):
            value = job.get(field)
            if value is not None:
                _validate_bounded_text(
                    value, f"delegations.in_flight.{field}", MAX_DELEGATION_FIELD_LENGTH
                )


def _validate_tail(tail: object, payload_bytes: int | None = None) -> list[str]:
    """Validate bounded serialized tail lines."""
    if not isinstance(tail, list) or len(tail) > MAX_TAIL_ITEMS:
        raise ValueError("tail exceeds its size limit")
    for line in tail:
        if not isinstance(line, str) or len(line.encode()) > MAX_TAIL_LINE_LENGTH:
            raise ValueError("tail entries exceed their size limit")
    if payload_bytes is not None and payload_bytes > MAX_CONTEXT_CONTENT_BYTES:
        raise ValueError("tail payload exceeds its size limit")
    if sum(len(line.encode()) for line in tail) > MAX_CONTEXT_CONTENT_BYTES:
        raise ValueError("tail payload exceeds its size limit")
    return tail


def _validate_heartbeat(heartbeat: object) -> None:
    """Validate bounded heartbeat metadata."""
    if not isinstance(heartbeat, dict):
        raise ValueError("heartbeat must be an object")
    status = heartbeat.get("status")
    if status is not None:
        _validate_bounded_text(status, "heartbeat.status", MAX_GOAL_STATUS_LENGTH)
    turn_count = heartbeat.get("turn_count")
    if turn_count is not None and (
        isinstance(turn_count, bool)
        or not isinstance(turn_count, int)
        or turn_count < 0
    ):
        raise ValueError("heartbeat.turn_count must be a non-negative integer")


def _validate_version_metadata(version: object) -> None:
    """Validate optional checkpoint ``version`` metadata leniently.

    ``version`` is opaque application metadata (rehydrate does not consume it),
    not a persistence requirement. It may be a positive integer, a JSON float
    such as ``1.0``, or a version label like ``"1.5.0-beta.2"``. Absent/null
    versions and any non-empty string remain valid, preserving existing integer
    checkpoints while allowing forward-compatible labels. Only bools, empty
    strings, non-finite/zero/negative numbers, and structured values are
    rejected.
    """
    if version is None:
        return
    if isinstance(version, bool):
        raise ValueError("version must be a positive integer or version label")
    if isinstance(version, (int, float)):
        if not 1 <= version < float("inf"):
            raise ValueError("version must be a positive integer or version label")
        return
    if not isinstance(version, str) or not version.strip():
        raise ValueError("version must be a positive integer or version label")


# (field, validator, python type, wording) in report order. ``tail`` is the one
# array section; the rest are objects. ``None`` sections are OPTIONAL and are
# never reported — heartbeat checkpoints omit goal/phase by design.
CHECKPOINT_SECTIONS: tuple[tuple[str, Callable[[object], object], type, str], ...] = (
    ("goal", _validate_goal, dict, "an object"),
    ("phase", _validate_phase, dict, "an object"),
    ("delegations", _validate_delegations, dict, "an object"),
    ("tail", _validate_tail, list, "an array"),
    ("heartbeat", _validate_heartbeat, dict, "an object"),
)


def _validate_checkpoint_shape(checkpoint: dict) -> None:
    """Validate bounded structured checkpoint fields without sanitizing them.

    Fail-fast on purpose: the read path needs only a yes/no verdict.
    ``context_save`` uses ``_collect_checkpoint_errors`` so a single call
    reports every invalid section instead of only the first.
    """
    _validate_version_metadata(checkpoint.get("version"))
    for field, validator, _expected_type, _wording in CHECKPOINT_SECTIONS:
        value = checkpoint.get(field)
        if value is not None:
            validator(value)


def _collect_checkpoint_errors(errors: _ArgErrors, parsed: dict, prefix: str) -> None:
    """Accumulate every invalid section of one parsed checkpoint object."""
    try:
        _validate_version_metadata(parsed.get("version"))
    except ValueError as exc:
        errors.reroot(prefix, str(exc))

    for field, validator, expected_type, wording in CHECKPOINT_SECTIONS:
        value = parsed.get(field)
        if value is None:
            continue
        if not isinstance(value, expected_type):
            errors.shape(
                f"{prefix}.{field}", wording, value, CHECKPOINT_EXAMPLES.get(field)
            )
            continue
        try:
            validator(value)
        except ValueError as exc:
            errors.reroot(prefix, str(exc))


def _collect_context_content_errors(
    errors: _ArgErrors, content: str, key: str, prefix: str = "content"
) -> None:
    """Bound context content and accumulate every structured-field violation."""
    if not isinstance(content, str):
        errors.shape(prefix, "a string", content)
        return
    if len(content.encode()) > MAX_CONTEXT_CONTENT_BYTES:
        errors.add(prefix, f"exceeds the {MAX_CONTEXT_CONTENT_BYTES}-byte limit")
        return
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError, ValueError):
        # Raw text remains a compatibility format, but rehydrate never treats
        # it as a checkpoint. It is still bounded above.
        return
    if isinstance(parsed, list) and key == "tail":
        if len(parsed) > MAX_TAIL_ITEMS or any(
            not isinstance(line, str) or len(line.encode()) > MAX_TAIL_LINE_LENGTH
            for line in parsed
        ):
            errors.add(f"{prefix}.tail", "exceeds its size limit")
        return
    if not isinstance(parsed, dict):
        # The message already names 'content': do not prepend the path again.
        errors.report(
            "structured context content must be a JSON object",
            _json_type_name(parsed),
        )
        return
    _collect_checkpoint_errors(errors, parsed, prefix)


def _collect_identifier(
    errors: _ArgErrors, value: str, name: str, limit: int
) -> str | None:
    """Validate one namespace component, recording the violation and continuing."""
    try:
        return _validate_identifier(value, name, limit)
    except ValueError as exc:
        errors.report(str(exc))
        return None


def _collect_scope_error(errors: _ArgErrors, scope: str) -> None:
    """Record an unknown scope name; DB resolution stays ``_db``'s job."""
    if scope not in _SCOPE_NAMES:
        errors.add(
            "scope",
            "must be 'global' or 'project'",
            repr(scope),
        )
        errors.example(SCOPE_EXAMPLE)


def _safe_untrusted_text(value: object) -> str:
    """Escape control/markup delimiters while preserving untrusted content."""
    text = str(value)
    return (
        text.replace("<", r"\u003c")
        .replace(">", r"\u003e")
        .replace("\r", r"\r")
        .replace("\n", r"\n")
        .replace("\x00", r"\u0000")
    )


def _stored_revision(raw: object) -> int:
    """Parse a context revision; legacy datetime values are revision zero."""
    try:
        revision = int(str(raw))
    except (TypeError, ValueError):
        return 0
    return revision if 0 <= revision <= MAX_REVISION else 0


def _row_revision(row: object) -> int:
    """Resolve a row's context revision, tolerating the legacy layout.

    Rows written before the dedicated ``revision`` column existed carry the
    revision in ``updated_at`` and have ``revision IS NULL``. Reading the new
    column first and falling back keeps monotonicity intact across the
    transition: a writer that only looked at the new column would restart the
    counter at 1 and could hand out a revision an older row already used.
    """
    if row is None:
        return 0
    try:
        dedicated, legacy = row[0], row[1]
    except (IndexError, TypeError):
        return 0
    if dedicated is not None:
        return _stored_revision(dedicated)
    return _stored_revision(legacy)


_REVISION_SELECT = "SELECT revision, updated_at FROM kv_store WHERE namespace = ?"


def _current_context_revision(
    conn: sqlite3.Connection, namespace: str, key: str
) -> int:
    """Read the persisted revision for one context entry."""
    row = conn.execute(
        f"{_REVISION_SELECT} AND key = ?", (namespace, key)
    ).fetchone()
    return _row_revision(row) if row else 0


def _next_context_revision(
    conn: sqlite3.Connection, namespace: str, key: str, latest_key: str | None = None
) -> int:
    """Choose a persisted monotonic revision while the write lock is held."""
    if latest_key is None:
        rows = conn.execute(
            f"{_REVISION_SELECT} AND key = ?",
            (namespace, key),
        ).fetchall()
    else:
        rows = conn.execute(
            f"{_REVISION_SELECT} AND key IN (?, ?)",
            (namespace, key, latest_key),
        ).fetchall()
    current = max((_row_revision(row) for row in rows), default=0)
    return min(MAX_REVISION, max(time.time_ns(), current + 1))


def _upsert_context_entry(
    conn: sqlite3.Connection,
    namespace: str,
    key: str,
    content: str,
    expires_at: str,
    revision: int,
) -> None:
    """Upsert one context row inside the caller's transaction."""
    conn.execute(
        "INSERT INTO kv_store (namespace, key, value, expires_at, "
        "created_at, updated_at, revision) "
        "VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?)"
        "ON CONFLICT(namespace, key) DO UPDATE SET "
        "  value = excluded.value, "
        "  expires_at = excluded.expires_at, "
        "  updated_at = excluded.updated_at, "
        "  revision = excluded.revision",
        (namespace, key, content, expires_at, revision),
    )


@mcp.tool(
    name="context_save",
    description="Save a context checkpoint for a session/phase. "
    "Stores structured JSON in persistence KV with a key-specific TTL. "
    "content is a JSON STRING; when it parses to an object, 'goal', 'phase', "
    "'delegations' and 'heartbeat' must each be JSON OBJECTS and 'tail' must "
    "be a JSON ARRAY. 'phase' is an object {current,total,name} — NOT a phase "
    "counter (pass phase.number for that). All sections are optional, so a "
    "heartbeat checkpoint may omit goal/phase. "
    "Example: content='{\"goal\": {\"objective\": \"...\"}, \"phase\": "
    "{\"current\": 1, \"total\": 3, \"name\": \"...\"}}'. "
    "All invalid arguments are reported together in one message.",
)
async def context_save(
    slug: str,
    key: str,
    content: Annotated[
        str,
        Field(
            description=(
                "JSON checkpoint string. When it parses to an object, 'goal', "
                "'phase', 'delegations' and 'heartbeat' must be objects and "
                "'tail' must be an array; all are optional. 'phase' is an "
                "object {current,total,name}, not a counter. Example: "
                '\'{"goal": {"objective": "..."}, "phase": {"current": 1}}\''
            )
        ),
    ],
    session_id: str,
    ttl: int | None = None,
    scope: str = "project",
    revision: int | None = None,
) -> dict:
    """Save a context checkpoint with session-level isolation.

    Namespace is always "checkpoint:{slug}:{session_id}", preventing
    cross-session reads. The session_id must be supplied by the autonomy
    caller; this function never generates one.

    Every argument is validated before any write, and all violations are
    reported in a single error so the caller fixes them in one round-trip.

    Args:
        slug: Session identifier (e.g. "auth-refactor").
        key: Checkpoint key (e.g. "phase:3", "latest", "heartbeat").
        content: JSON-serializable string or any text content.
        session_id: Required unique session ID for namespace isolation.
        ttl: TTL in seconds (defaults to the key-specific context policy).
        scope: 'project' (default) or 'global'.
        revision: Optional monotonic revision. Older/equal revisions are no-ops.

    Returns:
        Status dict with namespace, key, and session_id for subsequent calls.
    """
    errors = _ArgErrors("context_save")
    valid_slug = _collect_identifier(errors, slug, "slug", MAX_CONTEXT_SLUG_LENGTH)
    valid_key = _collect_identifier(errors, key, "key", MAX_CONTEXT_KEY_LENGTH)
    actual_session = _normalize_session_id(session_id)
    if actual_session is None:
        errors.add("session_id", "is required and must be non-empty")
        errors.example(SESSION_ID_EXAMPLE)
        valid_session = None
    else:
        valid_session = _collect_identifier(
            errors, actual_session, "session_id", MAX_CONTEXT_SESSION_ID_LENGTH
        )
    _collect_context_content_errors(errors, content, valid_key or key)
    try:
        requested_revision = _validate_revision(revision)
    except ValueError as exc:
        errors.report(str(exc), repr(revision))
        errors.example(REVISION_EXAMPLE)
        requested_revision = None
    _collect_scope_error(errors, scope)
    try:
        requested_ttl = _validate_ttl(ttl)
    except ValueError as exc:
        errors.report(str(exc), repr(ttl))
        errors.example(TTL_EXAMPLE)
        requested_ttl = None
    errors.raise_if_any()

    ns = f"checkpoint:{valid_slug}:{valid_session}"
    actual_ttl = _context_ttl(valid_key, requested_ttl)

    conn = _db(scope)
    expires_at = (datetime.now(UTC) + timedelta(seconds=actual_ttl)).isoformat()

    # BEGIN IMMEDIATE serializes writers in this process and across SQLite
    # connections. The checkpoint and raw-content latest pointer commit as one
    # unit; a crash or failed second write therefore cannot expose half a save.
    with _context_write_lock:
        try:
            conn.execute("BEGIN IMMEDIATE")
            latest_key = "latest" if _should_update_latest(valid_key) else None
            actual_revision = requested_revision or _next_context_revision(
                conn, ns, valid_key, latest_key
            )
            current_revision = _current_context_revision(conn, ns, valid_key)
            if actual_revision <= current_revision:
                conn.rollback()
                return {
                    "status": "stale",
                    "namespace": ns,
                    "key": valid_key,
                    "session_id": valid_session,
                    "ttl": actual_ttl,
                    "revision": current_revision,
                }
            _upsert_context_entry(
                conn, ns, valid_key, content, expires_at, actual_revision
            )
            if latest_key is not None and actual_revision > _current_context_revision(
                conn, ns, latest_key
            ):
                _upsert_context_entry(
                    conn, ns, latest_key, content, expires_at, actual_revision
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    return {
        "status": "stored",
        "namespace": ns,
        "key": valid_key,
        "session_id": valid_session,
        "ttl": actual_ttl,
        "revision": actual_revision,
    }


@mcp.tool(
    name="context_get",
    description="Retrieve a context checkpoint by session slug and key. "
    "Returns the raw content string or null if expired/not found.",
)
async def context_get(
    slug: str,
    key: str = "latest",
    session_id: str | None = None,
    legacy: bool = False,
    scope: str = "project",
) -> str | None:
    """Get a context checkpoint with session isolation.

    Args:
        slug: Session identifier.
        key: Checkpoint key (default "latest").
        session_id: Required for session-scoped reads.
        legacy: Explicitly opt into the unqualified legacy namespace when no
            session_id is available.
        scope: 'project' (default) or 'global'.

    Returns:
        Content string or None if not found/expired.
    """
    conn = _db(scope)
    try:
        _validate_identifier(key, "key", MAX_CONTEXT_KEY_LENGTH)
    except ValueError:
        return None
    ns = _context_namespace(slug, session_id, legacy=legacy)
    if ns is None:
        return None
    row = conn.execute(
        "SELECT value FROM kv_store "
        "WHERE namespace = ? AND key = ? "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')) "
        "AND deleted_at IS NULL",
        (ns, key),
    ).fetchone()
    return row[0] if row else None


@mcp.tool(
    name="context_list",
    description="List all context checkpoints for a session slug. "
    "Returns keys, timestamps, and TTL info.",
)
async def context_list(
    slug: str,
    session_id: str | None = None,
    legacy: bool = False,
    scope: str = "project",
) -> list[dict]:
    """List all checkpoints for a session.

    Args:
        slug: Session identifier.
        session_id: Required for session-scoped reads.
        legacy: Explicitly opt into the unqualified legacy namespace when no
            session_id is available.
        scope: 'project' (default) or 'global'.

    Returns:
        List of dicts with key, created_at, expires_at.
    """
    conn = _db(scope)
    ns = _context_namespace(slug, session_id, legacy=legacy)
    if ns is None:
        return []
    rows = conn.execute(
        "SELECT key, created_at, expires_at FROM kv_store "
        "WHERE namespace = ? "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')) "
        "AND deleted_at IS NULL "
        "ORDER BY created_at DESC LIMIT 50",
        (ns,),
    ).fetchall()
    return [
        {
            "key": r[0],
            "created_at": r[1],
            "expires_at": r[2],
        }
        for r in rows
    ]


@mcp.tool(
    name="context_stats",
    description="Return session context statistics: "
    "checkpoint count, TTL remaining, total size per slug.",
)
async def context_stats(
    slug: str,
    session_id: str | None = None,
    legacy: bool = False,
    scope: str = "project",
) -> dict:
    """Return storage statistics for a session's context.

    Args:
        slug: Session identifier.
        session_id: Required for session-scoped reads.
        legacy: Explicitly opt into the unqualified legacy namespace when no
            session_id is available.
        scope: 'project' (default) or 'global'.

    Returns:
        Dict with entry_count, total_bytes, ttl_remaining.
    """
    conn = _db(scope)
    ns = _context_namespace(slug, session_id, legacy=legacy)
    if ns is None:
        return {
            "slug": slug,
            "namespace": None,
            "entry_count": 0,
            "expired_entries": 0,
            "total_bytes": 0,
            "ttl_remaining_seconds": None,
        }

    count = conn.execute(
        "SELECT COUNT(*) FROM kv_store "
        "WHERE namespace = ? AND deleted_at IS NULL "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))",
        (ns,),
    ).fetchone()[0]

    expired = conn.execute(
        "SELECT COUNT(*) FROM kv_store "
        "WHERE namespace = ? AND expires_at IS NOT NULL "
        "AND julianday(expires_at) <= julianday('now') "
        "AND deleted_at IS NULL",
        (ns,),
    ).fetchone()[0]

    size = conn.execute(
        "SELECT COALESCE(SUM(LENGTH(value)), 0) FROM kv_store "
        "WHERE namespace = ? AND deleted_at IS NULL "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))",
        (ns,),
    ).fetchone()[0]

    # Check TTL of latest entry
    remaining: int | None = None
    row = conn.execute(
        "SELECT expires_at FROM kv_store "
        "WHERE namespace = ? AND key = 'latest' AND deleted_at IS NULL",
        (ns,),
    ).fetchone()
    if row and row[0]:
        try:
            exp = datetime.fromisoformat(row[0])
            now = datetime.now(UTC)
            remaining = max(0, int((exp - now).total_seconds()))
        except (ValueError, TypeError):
            pass

    return {
        "slug": slug,
        "namespace": ns,
        "entry_count": count,
        "expired_entries": expired,
        "total_bytes": size,
        "ttl_remaining_seconds": remaining,
    }


# ── Post-Compaction Injector (WS2 PR #94) ─────────────────────────────────────
# Deterministic rehydration after a native compaction event: a long session
# reads ``latest`` + serialized ``tail`` from
# ``checkpoint:<slug>:<session_id>`` and
# rebuilds its critical context (active goal, in-flight delegations,
# current phase) WITHOUT any LLM call or generative embedding.
#
# Checkpoint JSON convention (written by Zeus via context_save):
#   {"version": 1,
#    "goal": {"id": ..., "objective": ..., "status": ...},
#    "phase": {"current": ..., "total": ..., "name": ...},
#    "delegations": {"in_flight": [{"alias": ..., "agent": ..., "task_id": ...}]},
#    "tail": ["phase:1 ...", ...],   # serialized last-N phase digests
#    "heartbeat": {...}}
# ``tail`` may also live under a separate ``tail`` key (JSON array).
#
# Guarantees: required session_id, kill-switch PANTHEON_COMPACTION=off,
# TTL-respecting reads, no sibling fallback, conditional heartbeat TTL refresh,
# and idempotent recovery (no checkpoint rows are added or duplicated).

COMPACTION_KILL_SWITCH_ENV: str = "PANTHEON_COMPACTION"
SESSION_END_SUMMARY_ENV: str = "PANTHEON_SESSION_END_SUMMARY"
REHYDRATE_TAIL_CAP: int = 10
SUMMARY_TAIL_CAP: int = 5


def _compaction_disabled() -> bool:
    """True when the PANTHEON_COMPACTION kill-switch is off."""
    return os.environ.get(COMPACTION_KILL_SWITCH_ENV, "").lower() == "off"


def _read_checkpoint_value(
    conn: sqlite3.Connection, namespace: str, key: str
) -> str | None:
    """Read one unexpired, non-deleted checkpoint value (None when absent)."""
    row = conn.execute(
        "SELECT value FROM kv_store "
        "WHERE namespace = ? AND key = ? "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')) "
        "AND deleted_at IS NULL",
        (namespace, key),
    ).fetchone()
    return row[0] if row else None


def _parse_checkpoint(content: str) -> dict | None:
    """Parse and validate one checkpoint; invalid JSON fails closed."""
    if len(content.encode()) > MAX_CONTEXT_CONTENT_BYTES:
        return None
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        _validate_checkpoint_shape(data)
    except ValueError:
        return None
    return data


def _checkpoint_tail(checkpoint: dict, tail_raw: str | None) -> list[str]:
    """Tail lines from embedded ``tail`` with fallback to the ``tail`` key."""
    tail = checkpoint.get("tail")
    if isinstance(tail, list):
        try:
            lines = _validate_tail(tail)
        except ValueError:
            return []
    elif isinstance(tail_raw, str):
        if len(tail_raw.encode()) > MAX_CONTEXT_CONTENT_BYTES:
            return []
        try:
            parsed = json.loads(tail_raw)
            lines = _validate_tail(parsed, payload_bytes=len(tail_raw.encode()))
        except (json.JSONDecodeError, TypeError, ValueError):
            return []
    else:
        lines = []
    return [line for line in lines if line.strip()][:REHYDRATE_TAIL_CAP]


def _mission_block(checkpoint: dict) -> str | None:
    """<mission_context> for a non-done goal (done goals stay buried)."""
    goal = checkpoint.get("goal")
    if not isinstance(goal, dict):
        return None
    status = str(goal.get("status", ""))
    objective = str(goal.get("objective", "")).strip()
    if status == "done" or not objective:
        return None
    gid = str(goal.get("id", "goal")).strip() or "goal"
    return (
        f"<mission_context>\n{UNTRUSTED_CONTEXT_LABEL}\n"
        f"  [{_safe_untrusted_text(gid)}] {_safe_untrusted_text(objective)}"
        f" — {_safe_untrusted_text(status)}"
    )


def _phase_block(checkpoint: dict) -> str | None:
    """<phase_context> for the current phase (omitted when unknown)."""
    phase = checkpoint.get("phase")
    if not isinstance(phase, dict) or phase.get("current") is None:
        return None
    total = phase.get("total")
    current = phase.get("current")
    span = f"{current}/{total}" if total is not None else str(current)
    name = str(phase.get("name", "")).strip()
    line = f"  phase {_safe_untrusted_text(span)}"
    if name:
        line += f" — {_safe_untrusted_text(name)}"
    return f"<phase_context>\n{UNTRUSTED_CONTEXT_LABEL}\n{line}"


def _delegation_block(checkpoint: dict) -> str | None:
    """<delegation_context> for in-flight delegations (never capped)."""
    delegations = checkpoint.get("delegations")
    if not isinstance(delegations, dict):
        return None
    in_flight = delegations.get("in_flight")
    if not isinstance(in_flight, list):
        return None
    lines = []
    for job in in_flight:
        if not isinstance(job, dict):
            continue
        alias = str(job.get("alias") or job.get("task_id") or "?").strip()
        agent = str(job.get("agent", "?")).strip()
        task_id = str(job.get("task_id", "")).strip()
        detail = (
            f" — {_safe_untrusted_text(task_id)}"
            if task_id and task_id != alias
            else ""
        )
        lines.append(
            f"  [{_safe_untrusted_text(alias)}] {_safe_untrusted_text(agent)}"
            f"{detail} [in-flight]"
        )
    if not lines:
        return None
    return "<delegation_context>\n" + UNTRUSTED_CONTEXT_LABEL + "\n" + "\n".join(lines)


def _tail_block(checkpoint: dict) -> str | None:
    """<tail_context> for the serialized tail (already capped on load)."""
    tail_lines = checkpoint.get("_tail_raw")
    try:
        validated_lines = _validate_tail(tail_lines)
    except ValueError:
        return None
    if not validated_lines:
        return None
    quoted = "\n".join(f"  - {_safe_untrusted_text(line)}" for line in validated_lines)
    return f"<tail_context>\n{UNTRUSTED_CONTEXT_LABEL}\n{quoted}"


def build_rehydration_blocks(checkpoint: dict) -> list[str] | None:
    """Build deterministic rehydration blocks from a checkpoint dict.

    Pure string templating — no LLM, no embeddings. Mirrors the
    ``<mission_context>`` convention of the compaction-context builder: only a
    non-done goal is re-emitted. Returns None when nothing critical remains.
    """
    if not isinstance(checkpoint, dict) or not checkpoint:
        return None
    blocks = [
        block
        for block in (
            _mission_block(checkpoint),
            _phase_block(checkpoint),
            _delegation_block(checkpoint),
            _tail_block(checkpoint),
        )
        if block is not None
    ]
    return blocks if blocks else None


def build_session_end_summary(checkpoint: dict) -> str | None:
    """Build the Tier 2 session-end summary deterministically (no LLM).

    Fires automatically at session end — no Themis approval gate. Returns
    None when the checkpoint carries nothing worth compressing.
    """
    if not isinstance(checkpoint, dict) or not checkpoint:
        return None
    parts: list[str] = []

    goal = checkpoint.get("goal")
    if isinstance(goal, dict):
        objective = str(goal.get("objective", "")).strip()
        if objective:
            parts.append(
                f"Goal: {_safe_untrusted_text(objective)} "
                f"({_safe_untrusted_text(goal.get('status', '?'))})"
            )

    phase = checkpoint.get("phase")
    if isinstance(phase, dict) and phase.get("current") is not None:
        total = phase.get("total")
        span = (
            f"{phase.get('current')}/{total}"
            if total is not None
            else phase.get("current")
        )
        name = str(phase.get("name", "")).strip()
        parts.append(
            f"Phase: {_safe_untrusted_text(span)}"
            + (f" {_safe_untrusted_text(name)}" if name else "")
        )

    delegations = checkpoint.get("delegations")
    if isinstance(delegations, dict):
        in_flight = delegations.get("in_flight")
        if isinstance(in_flight, list):
            aliases = [
                _safe_untrusted_text(str(job.get("alias") or job.get("task_id") or "?"))
                for job in in_flight
                if isinstance(job, dict)
            ]
            if aliases:
                parts.append(f"In-flight: {', '.join(aliases)}")

    tail_raw = checkpoint.get("_tail_raw")
    if isinstance(tail_raw, list) and tail_raw:
        kept = [_safe_untrusted_text(str(line)) for line in tail_raw[:SUMMARY_TAIL_CAP]]
        parts.append("Tail: " + " | ".join(kept))

    if not parts:
        return None
    return "# Session summary (Tier 2 auto — no approval gate)\n" + "\n".join(
        f"- {part}" for part in parts
    )


def _load_checkpoint_for_rehydrate(
    conn: sqlite3.Connection, namespace: str
) -> dict | None:
    """Load exactly ``latest``; expired, malformed, or empty data fails closed."""
    tail_raw = _read_checkpoint_value(conn, namespace, "tail")
    raw = _read_checkpoint_value(conn, namespace, "latest")
    if raw is None:
        return None
    checkpoint = _parse_checkpoint(raw)
    if checkpoint is None:
        return None
    checkpoint["_tail_raw"] = _checkpoint_tail(checkpoint, tail_raw)
    return checkpoint if build_rehydration_blocks(checkpoint) is not None else None


def _refresh_heartbeat_ttl(conn: sqlite3.Connection, namespace: str) -> None:
    """Extend an unexpired heartbeat TTL; never shorten, never resurrect."""
    row = conn.execute(
        "SELECT expires_at FROM kv_store "
        "WHERE namespace = ? AND key = 'heartbeat' "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')) "
        "AND deleted_at IS NULL",
        (namespace,),
    ).fetchone()
    if not row or not row[0]:
        return
    try:
        current_exp = datetime.fromisoformat(row[0])
    except (ValueError, TypeError):
        return
    now = datetime.now(UTC)
    if current_exp.tzinfo is None:
        current_exp = current_exp.replace(tzinfo=UTC)
    fresh_exp = now + timedelta(seconds=CONTEXT_HEARTBEAT_TTL)
    if fresh_exp <= current_exp:
        return
    revision = _next_context_revision(conn, namespace, "heartbeat")
    cursor = conn.execute(
        "UPDATE kv_store SET expires_at = ?, updated_at = ? "
        "WHERE namespace = ? AND key = 'heartbeat' AND expires_at = ? "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')) "
        "AND deleted_at IS NULL",
        (fresh_exp.isoformat(), str(revision), namespace, row[0]),
    )
    if cursor.rowcount:
        conn.commit()


@mcp.tool(
    name="context_rehydrate",
    description="Rehydrate critical context after native compaction. "
    "Reads 'latest' + serialized 'tail' from a session-qualified checkpoint "
    "namespace and rebuilds "
    "goal/phase/delegation blocks deterministically (no LLM). Refreshes the "
    "heartbeat TTL. Requires session_id and honors PANTHEON_COMPACTION=off.",
)
async def context_rehydrate(
    slug: str,
    session_id: str,
    scope: str = "project",
) -> list[str] | None:
    """Rehydrate one known session; missing IDs fail closed."""
    if _compaction_disabled():
        return None
    normalized_session = _normalize_session_id(session_id)
    errors = _ArgErrors("context_rehydrate")
    valid_slug = _collect_identifier(
        errors, slug, "slug", MAX_CONTEXT_SLUG_LENGTH
    )
    if normalized_session is None:
        errors.add("session_id", "is required and must be non-empty")
        errors.example(SESSION_ID_EXAMPLE)
        valid_session = None
    else:
        valid_session = _collect_identifier(
            errors, normalized_session, "session_id", MAX_CONTEXT_SESSION_ID_LENGTH
        )
    _collect_scope_error(errors, scope)
    errors.raise_if_any()
    conn = _db(scope)
    namespace = f"checkpoint:{valid_slug}:{valid_session}"
    checkpoint = _load_checkpoint_for_rehydrate(conn, namespace)
    if checkpoint is None:
        return None
    blocks = build_rehydration_blocks(checkpoint)
    if blocks is None:
        return None
    _refresh_heartbeat_ttl(conn, namespace)
    return blocks


@mcp.tool(
    name="context_session_summary",
    description="Tier 2 session-end summary without Themis approval. "
    "Compresses the checkpoint (goal, phase, in-flight, tail) into a "
    "memory-bank-ready summary deterministically (no LLM). "
    "Requires session_id. Opt-out via PANTHEON_SESSION_END_SUMMARY=off.",
)
async def context_session_summary(
    slug: str,
    session_id: str,
    scope: str = "project",
) -> str | None:
    """Summarize one known session; missing IDs fail closed."""
    if os.environ.get(SESSION_END_SUMMARY_ENV, "").lower() == "off":
        return None
    normalized_session = _normalize_session_id(session_id)
    errors = _ArgErrors("context_session_summary")
    valid_slug = _collect_identifier(
        errors, slug, "slug", MAX_CONTEXT_SLUG_LENGTH
    )
    if normalized_session is None:
        errors.add("session_id", "is required and must be non-empty")
        errors.example(SESSION_ID_EXAMPLE)
        valid_session = None
    else:
        valid_session = _collect_identifier(
            errors, normalized_session, "session_id", MAX_CONTEXT_SESSION_ID_LENGTH
        )
    _collect_scope_error(errors, scope)
    errors.raise_if_any()
    conn = _db(scope)
    namespace = f"checkpoint:{valid_slug}:{valid_session}"
    checkpoint = _load_checkpoint_for_rehydrate(conn, namespace)
    if checkpoint is None:
        return None
    return build_session_end_summary(checkpoint)


def _resolve_db_path(scope: str) -> Path | None:
    """Resolve the database file path for a given scope.

    Returns the actual path used at init (honoring an explicit
    ``--project-db``), so deletelog writes and db_size stats land next to
    the real database file.
    """
    if scope == "global":
        return _global_root / "global.db"
    return _project_db_path


# ── Main Entrypoint ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
