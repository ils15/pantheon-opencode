#!/usr/bin/env python3
"""Pantheon Persistence MCP Server.

Key-Value store with FTS5 full-text search, TTL-based expiration,
and namespace isolation. Uses SQLite with zero external dependencies.

Usage:
    python scripts/mcp_persistence_server.py
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from _pantheon_paths import pantheon_home, pantheon_project
from mcp.server.fastmcp import FastMCP

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
    conn.commit()

    return conn


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

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
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
if args.project_db:
    _project_db_instance = _init_db(Path(args.project_db))
else:
    _proj = pantheon_project()
    if _proj:
        _project_db_instance = _init_db(
            _proj / ".pantheon" / "persistence" / "project.db"
        )
_project_db = _project_db_instance


# ── Tools ───────────────────────────────────────────────────────────────────────


@mcp.tool(
    name="kv_store",
    description="Store a key-value pair in a namespace with optional TTL (seconds). "
    "INSERT OR REPLACE on duplicate (namespace, key).",
)
async def kv_store(
    namespace: str,
    key: str,
    value: str,
    ttl: int | None = None,
    scope: str = "project",
) -> dict:
    """Store a value under namespace+key with optional TTL.

    Args:
        namespace: Logical grouping for keys.
        key: Unique key within the namespace.
        value: String value to store.
        ttl: Time-to-live in seconds (None = forever).
        scope: 'project' (default) or 'global'.

    Returns:
        Status dict with namespace and key.
    """
    conn = _db(scope)
    expires_at: str | None = None
    if ttl is not None:
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat()

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
        "AND (expires_at IS NULL OR expires_at > datetime('now')) "
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

    total = conn.execute("SELECT COUNT(*) FROM kv_store WHERE deleted_at IS NULL").fetchone()[0]
    expired = conn.execute(
        "SELECT COUNT(*) FROM kv_store "
        "WHERE expires_at IS NOT NULL AND expires_at < datetime('now') "
        "AND deleted_at IS NULL"
    ).fetchone()[0]

    ns_rows = conn.execute(
        "SELECT namespace, COUNT(*) as cnt, "
        "SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < datetime('now') THEN 1 ELSE 0 END) as expired_count "
        "FROM kv_store WHERE deleted_at IS NULL GROUP BY namespace ORDER BY cnt DESC"
    ).fetchall()

    namespaces = {
        r[0]: {"count": r[1], "expired": r[2]}
        for r in ns_rows
    }

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
        "AND (expires_at IS NULL OR expires_at > datetime('now')) "
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
        "AND (kv_store.expires_at IS NULL OR kv_store.expires_at > datetime('now'))"
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
        "AND expires_at < datetime('now') "
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
        "AND expires_at < datetime('now') "
        "AND deleted_at IS NULL",
    )
    conn.commit()

    # Write deletelog
    db_path = _resolve_db_path(scope)
    if db_path:
        _write_deletelog(db_path, count, expired_keys)

    return {"purged": count, "dry_run": False}



def _opportunistic_auto_purge(conn: sqlite3.Connection, namespace: str, threshold: int = 500) -> None:
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
        "AND expires_at < datetime('now') AND deleted_at IS NULL",
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
# tool call history, and reasoning chains. All entries use namespace
# "checkpoint:{slug}" with auto-TTL of 4 hours (session duration).

DEFAULT_CONTEXT_TTL: int = 14400  # 4 hours


@mcp.tool(
    name="context_save",
    description="Save a context checkpoint for a session/phase. "
    "Stores structured JSON in persistence KV with auto-TTL of 4h.",
)
async def context_save(
    slug: str,
    key: str,
    content: str,
    session_id: str | None = None,
    ttl: int | None = None,
    scope: str = "project",
) -> dict:
    """Save a context checkpoint with session-level isolation.

    If session_id is provided, namespace becomes "checkpoint:{slug}:{session_id}"
    preventing cross-session reads. If omitted, a random UUID is auto-generated
    and returned so the caller can pass it to subsequent calls.

    Args:
        slug: Session identifier (e.g. "auth-refactor").
        key: Checkpoint key (e.g. "phase:3", "latest", "heartbeat").
        content: JSON-serializable string or any text content.
        session_id: Unique session ID for namespace isolation (auto-generated if None).
        ttl: TTL in seconds (default 4h / 14400). None = session duration.
        scope: 'project' (default) or 'global'.

    Returns:
        Status dict with namespace, key, and session_id for subsequent calls.
    """
    actual_session = session_id or uuid.uuid4().hex[:12]
    ns = f"checkpoint:{slug}:{actual_session}"
    actual_ttl = ttl if ttl is not None else DEFAULT_CONTEXT_TTL

    conn = _db(scope)
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=actual_ttl)).isoformat()

    conn.execute(
        "INSERT INTO kv_store (namespace, key, value, expires_at, "
        "created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
        "ON CONFLICT(namespace, key) DO UPDATE SET "
        "  value = excluded.value, "
        "  expires_at = excluded.expires_at, "
        "  updated_at = datetime('now')",
        (ns, key, content, expires_at),
    )
    conn.commit()

    # Also always update "latest" pointer
    if key != "latest":
        # Use a larger TTL for "latest" to outlive individual phase entries
        conn.execute(
            "INSERT INTO kv_store (namespace, key, value, expires_at, "
            "created_at, updated_at) VALUES (?, 'latest', ?, ?, datetime('now'), datetime('now'))"
            "ON CONFLICT(namespace, key) DO UPDATE SET "
            "  value = excluded.value, "
            "  expires_at = excluded.expires_at, "
            "  updated_at = datetime('now')",
            (ns, content, expires_at),
        )
        conn.commit()

    return {"status": "stored", "namespace": ns, "key": key, "session_id": actual_session, "ttl": actual_ttl}


@mcp.tool(
    name="context_get",
    description="Retrieve a context checkpoint by session slug and key. "
    "Returns the raw content string or null if expired/not found.",
)
async def context_get(
    slug: str,
    key: str = "latest",
    session_id: str | None = None,
    scope: str = "project",
) -> str | None:
    """Get a context checkpoint with session isolation.

    Args:
        slug: Session identifier.
        key: Checkpoint key (default "latest").
        session_id: Required for isolation. If None, searches without session scope.
        scope: 'project' (default) or 'global'.

    Returns:
        Content string or None if not found/expired.
    """
    conn = _db(scope)
    ns = f"checkpoint:{slug}:{session_id}" if session_id else f"checkpoint:{slug}"
    row = conn.execute(
        "SELECT value FROM kv_store "
        "WHERE namespace = ? AND key = ? "
        "AND (expires_at IS NULL OR expires_at > datetime('now')) "
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
    scope: str = "project",
) -> list[dict]:
    """List all checkpoints for a session.

    Args:
        slug: Session identifier.
        session_id: Optional. If provided, narrows to specific session.
        scope: 'project' (default) or 'global'.

    Returns:
        List of dicts with key, created_at, expires_at.
    """
    conn = _db(scope)
    ns = f"checkpoint:{slug}:{session_id}" if session_id else f"checkpoint:{slug}"
    rows = conn.execute(
        "SELECT key, created_at, expires_at FROM kv_store "
        "WHERE namespace = ? "
        "AND (expires_at IS NULL OR expires_at > datetime('now')) "
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
    scope: str = "project",
) -> dict:
    """Return storage statistics for a session's context.

    Args:
        slug: Session identifier.
        session_id: Optional. If provided, narrows to specific session.
        scope: 'project' (default) or 'global'.

    Returns:
        Dict with entry_count, total_bytes, ttl_remaining.
    """
    conn = _db(scope)
    ns = f"checkpoint:{slug}:{session_id}" if session_id else f"checkpoint:{slug}"

    count = conn.execute(
        "SELECT COUNT(*) FROM kv_store "
        "WHERE namespace = ? AND deleted_at IS NULL",
        (ns,),
    ).fetchone()[0]

    expired = conn.execute(
        "SELECT COUNT(*) FROM kv_store "
        "WHERE namespace = ? AND expires_at < datetime('now') "
        "AND deleted_at IS NULL",
        (ns,),
    ).fetchone()[0]

    size = conn.execute(
        "SELECT COALESCE(SUM(LENGTH(value)), 0) FROM kv_store "
        "WHERE namespace = ? AND deleted_at IS NULL",
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
            now = datetime.now(timezone.utc)
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

def _resolve_db_path(scope: str) -> Path | None:
    """Resolve the database file path for a given scope."""
    if scope == "global":
        return _global_root / "global.db"
    if _project_db_instance:
        # Find the project root from the project DB path
        proj_root = pantheon_project()
        if proj_root:
            return proj_root / ".pantheon" / "persistence" / "project.db"
    return None


# ── Main Entrypoint ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
