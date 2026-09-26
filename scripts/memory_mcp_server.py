#!/usr/bin/env python3
"""Pantheon Memory MCP Server — lightweight, zero heavy deps.

Search is FTS5 (BM25) only. The vector pipeline (sqlite-vec + fastembed,
~50MB of wheels and ~185MB RSS) was removed outright: the prefix-matched OR
query it fused against returned a candidate pool so polluted that the vector
half was compensating for a query bug rather than adding recall. See
``_build_fts_query`` for the query form that replaced it.

Recall is therefore purely lexical. A query that shares no token with a
stored document will not retrieve it; there is no embedding to fall back on.

Tools:
    memory_store   — Store a value (auto-indexed into FTS5 by trigger)
    memory_search  — FTS5 BM25 keyword search with optional freshness decay
    memory_recall  — Exact recall by key
    memory_forget  — Delete by ID or key
    memory_list    — Chronological listing
    memory_stats   — DB statistics

Usage:
    python scripts/memory_mcp_server.py
"""

from __future__ import annotations

import functools
import json
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from _pantheon_paths import pantheon_home
from mcp.server.fastmcp import FastMCP
from pydantic import BeforeValidator, Field

# ── Paths ─────────────────────────────────────────────────────────────────────

DB_PATH = pantheon_home() / "memory" / "memory.db"


_BYTE_UNIT = 1024

def _set_memory_dir(path: str | Path) -> None:
    """Override the memory db path for testing."""
    global DB_PATH  # noqa: PLW0603
    DB_PATH = Path(path) / "memory.db"
    _reset_test_state()


def _reset_test_state() -> None:
    """Reset cached state for test isolation."""
    _get_db.cache_clear()


SCHEMA_SQL = """
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

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    namespace, key, value, metadata,
    content='memories', content_rowid='id',
    tokenize='porter unicode61'
);

-- FTS sync: INSERT
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, namespace, key, value, metadata)
    VALUES (new.id, new.namespace, new.key, new.value, new.metadata);
END;

-- FTS sync: DELETE
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, namespace, key, value, metadata)
    VALUES ('delete', old.id, old.namespace, old.key, old.value, old.metadata);
END;

-- FTS sync: UPDATE
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, namespace, key, value, metadata)
    VALUES ('delete', old.id, old.namespace, old.key, old.value, old.metadata);
    INSERT INTO memories_fts(rowid, namespace, key, value, metadata)
    VALUES (new.id, new.namespace, new.key, new.value, new.metadata);
END;
"""

# ── FastMCP App ───────────────────────────────────────────────────────────────

mcp = FastMCP(
    "pantheon-memory",
    instructions=(
        "Lightweight memory with FTS5 (SQLite BM25) keyword search across "
        "namespaces. Lexical retrieval only — there is no embedding or vector "
        "index, so a query must share a token with the stored text to match."
    ),
)


# ── Database ──────────────────────────────────────────────────────────────────


@functools.cache
def _get_db() -> sqlite3.Connection:
    """Get or create the SQLite connection singleton.

    Creates DB directory, applies WAL/performance pragmas and runs schema init.
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA_SQL)
    return conn


def _get_conn() -> sqlite3.Connection:
    """Alias for _get_db — shorthand for tool use."""
    return _get_db()


# ── FTS Query Building ────────────────────────────────────────────────────────

# Function words carry no retrieval signal but prefix-match a large slice of
# the corpus, so OR-ing them in dilutes BM25 ranking with noise instead of
# narrowing the candidate pool. The list is deliberately limited to English
# function words and auxiliaries — no domain vocabulary.
_STOPWORDS = frozenset(
    """
    a about above after again against all am an and any are as at be because
    been before being below between both but by can cannot could did do does
    doing done down during each few for from further had has have having he her
    here hers him his how i if in into is it its itself just me more most my no
    nor not now of off on once only or other our ours out over own same she
    should so some such than that the their theirs them then there these they
    this those through to too under until up very was we were what when where
    which while who whom why will with would you your yours
    """.split()
)

# A prefix query on a token this short is broader than the token itself
# ("in*" matches ingest/input/install/...), so short terms match exactly.
_MIN_PREFIX_LEN = 4


def _build_fts_query(query: str) -> str:
    """Build an FTS5 ``MATCH`` expression from free-text search input.

    Replaces the previous ``" OR ".join(f'"{w}"*' for w in query.split())``
    form, which prefix-matched *every* token, stopwords included. Measured on
    the live store (1,553 memories) that form OR-ed in terms like ``the``,
    ``is`` and ``how`` whose prefixes match most of the corpus, so a query for
    ``purge threshold checkpoint`` pulled 1,001 documents as candidates and
    1,524 of them were noise. Two corrections:

    - Stopwords are dropped rather than OR-ed in.
    - Tokens shorter than ``_MIN_PREFIX_LEN`` characters match exactly instead
      of by prefix, which removes the 3-character prefix blowups (``"com"*``
      alone matched 1,235 of 1,550 documents).

    Tokens surviving both filters are still prefix-matched, so a query term
    retrieves documents containing a longer word that starts with it. If every
    token is a stopword the unfiltered tokens are matched exactly, so an
    all-stopword query degrades to a literal lookup rather than to no results.

    Args:
        query: Raw, user-supplied search text.

    Returns:
        An FTS5 expression (terms joined with ``OR``), or ``""`` for an empty
        query.
    """
    words = [word for word in query.split() if word]
    if not words:
        return ""
    content = [word for word in words if word.lower() not in _STOPWORDS]
    if not content:
        content = words
    return " OR ".join(
        f'"{word}"*' if len(word) >= _MIN_PREFIX_LEN else f'"{word}"' for word in content
    )


# ── Helpers ───────────────────────────────────────────────────────────────────


def _dict_from_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    """Convert a sqlite3.Row to a plain dict, or return None."""
    if row is None:
        return None
    return dict(row)


def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _parse_metadata(row: dict[str, Any]) -> dict[str, Any]:
    """Parse the metadata JSON field of a memory row."""
    try:
        row["metadata"] = json.loads(row["metadata"])
    except (json.JSONDecodeError, TypeError):
        row["metadata"] = {}
    return row


# ── Ranking ───────────────────────────────────────────────────────────────────


def _parse_iso_ts(value: str) -> float:
    """Parse an ISO 8601 UTC timestamp to epoch seconds.

    Handles both aware ISO strings (``2026-08-21T10:00:00Z`` /
    ``...+00:00``) and legacy naive rows from ``DEFAULT (datetime('now'))``
    (``YYYY-MM-DD HH:MM:SS``, space separator, no TZ). Naive timestamps are
    assumed UTC — SQLite's ``datetime('now')`` is UTC, so interpreting them
    in the local timezone would skew freshness decay.
    """
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def _fetch_created_at_map(
    db: sqlite3.Connection, ids: list[int]
) -> dict[int, str]:
    """Fetch created_at timestamps for the given memory IDs.

    Args:
        db: Active SQLite connection.
        ids: Memory row IDs to look up.

    Returns:
        Mapping of id -> created_at ISO string. Empty on failure.
    """
    created_at_map: dict[int, str] = {}
    if not ids:
        return created_at_map
    try:
        placeholders = ",".join("?" * len(ids))
        rows = db.execute(
            f"SELECT id, created_at FROM memories "
            f"WHERE id IN ({placeholders})",
            ids,
        ).fetchall()
        created_at_map = {r["id"]: r["created_at"] for r in rows}
    except Exception:
        created_at_map = {}
    return created_at_map


def _score_hits(
    hits: list[tuple[int, float]],
    top_k: int,
    created_at_map: dict[int, str] | None = None,
    decay_days: float | None = None,
) -> list[tuple[int, float]]:
    """Rank FTS5 hits by BM25 relevance, optionally freshness-decayed.

    This replaces the vector+BM25 Reciprocal Rank Fusion: with a single ranked
    list there is nothing left to fuse, so each hit keeps its own BM25 score
    instead of a rank-derived one.

    Args:
        hits: ``(id, bm25)`` pairs from FTS5, most relevant first. ``bm25`` is
            ``-rank`` (FTS5 reports ``rank`` negated, lower = better).
        top_k: Maximum number of results to return.
        created_at_map: Optional mapping of doc_id -> created_at ISO string,
            used to compute freshness when ``decay_days`` is set.
        decay_days: Optional freshness half-life in days. When set, each score
            is multiplied by ``2^(-days_since_created/decay_days)`` so older
            entries rank lower. Default None = no decay.

    Returns:
        List of ``(id, score)`` tuples sorted by descending score, ties broken
        by ascending id so ranking is deterministic.
    """
    scores: dict[int, float] = {doc_id: bm25 for doc_id, bm25 in hits}

    if decay_days is not None and decay_days > 0 and created_at_map:
        now = time.time()
        for doc_id in list(scores):
            created = created_at_map.get(doc_id)
            if not created:
                continue
            try:
                days = max(0.0, (now - _parse_iso_ts(created)) / 86400.0)
            except (ValueError, TypeError):
                continue
            scores[doc_id] *= 2.0 ** (-days / decay_days)

    ranked = sorted(scores.items(), key=lambda x: (-x[1], x[0]))
    return ranked[:top_k]


# ── Tools ─────────────────────────────────────────────────────────────────────

# ── Argument Validation ─────────────────────────────────────────────────────────
# One call must surface EVERY invalid argument. ``metadata`` is a JSON object
# encoded as a STRING, and the natural mistake is to pass the object itself,
# which used to surface as pydantic's bare "Input should be a valid string" —
# no path, no received type, no example. The validator below names all three,
# and pydantic still accumulates it alongside every other invalid argument in
# the same call.

METADATA_EXAMPLE: str = """metadata='{"type": "decision", "score": 0.9}'"""


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


def _metadata_must_be_json_string(value: Any) -> Any:
    """Accept only a JSON object encoded as a string, with an actionable error.

    Runs before pydantic's own ``str`` check so the failure names the received
    type and a correct example instead of leaking a raw type error.
    """
    if isinstance(value, str):
        return value
    raise ValueError(
        "metadata must be a JSON object encoded as a string "
        f"(got {_json_type_name(value)}). json.dumps it first. "
        f"Example: {METADATA_EXAMPLE}"
    )


def _collect_store_violations(value: str, metadata: str) -> tuple[list[str], list[str]]:
    """Collect every in-body ``memory_store`` violation, plus any examples.

    Returns ``(violations, examples)`` so the caller reports all of them in one
    message instead of returning on the first problem it happens to notice.
    """
    violations: list[str] = []
    examples: list[str] = []
    if not value or not value.strip():
        violations.append("value is required and must be a non-empty string")
    if metadata and metadata != "{}":
        try:
            json.loads(metadata)
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            violations.append(
                "metadata must be a JSON object encoded as a valid JSON string "
                f"(got invalid JSON: {exc})"
            )
            examples.append(METADATA_EXAMPLE)
    return violations, examples


def _format_store_violations(violations: list[str], examples: list[str]) -> str:
    """Render stored-error text: one line per violation, then one example block."""
    lines = [f"memory_store: {violation}" for violation in violations]
    if len(violations) > 1:
        lines.insert(0, f"memory_store: {len(violations)} invalid arguments")
    deduped = list(dict.fromkeys(examples))
    if deduped:
        lines.append("example: " + "  ".join(deduped))
    return "\n".join(lines)




@mcp.tool(
    description="Store a memory entry. The FTS5 index is updated automatically "
    "by database trigger. Returns the entry ID and status. "
    "metadata is a JSON object encoded as a STRING (not an object) and value "
    "must be non-empty; every invalid argument is reported together in one "
    f"message. Example: {METADATA_EXAMPLE}",
)
def memory_store(
    value: str = "",
    namespace: str = "default",
    key: str | None = None,
    metadata: Annotated[
        str,
        BeforeValidator(_metadata_must_be_json_string),
        Field(
            default="{}",
            description="JSON object encoded as a STRING, not an object. "
            "Example: '{\"type\": \"decision\", \"score\": 0.9}'.",
        ),
    ] = "{}",
) -> dict[str, Any]:
    """Store a value and index it for FTS5 keyword search.

    Args:
        value: Text content to store (required, non-empty).
        namespace: Namespace for isolation (default: "default").
        key: Optional unique key within namespace.
        metadata: Optional JSON object encoded as a string.

    Returns:
        Dict with id, namespace, key, status.
    """
    violations, examples = _collect_store_violations(value, metadata)
    if violations:
        return {"error": _format_store_violations(violations, examples)}

    value = value.strip()
    db = _get_conn()
    now = _now_iso()

    metadata_str = metadata if metadata else "{}"

    try:
        cur = db.execute(
            """INSERT INTO memories (namespace, key, value, metadata,
             created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [namespace, key, value, metadata_str, now, now],
        )
        entry_id = cur.lastrowid
        db.commit()
    except sqlite3.IntegrityError as e:
        db.rollback()
        return {"error": f"Duplicate key or constraint violation: {e}"}
    except Exception as e:
        db.rollback()
        return {"error": f"Failed to store memory: {e}"}

    return {"id": entry_id, "namespace": namespace, "key": key, "status": "stored"}


@mcp.tool(
    description="Lexical keyword search across memories using SQLite FTS5 "
    "BM25 ranking. Stopwords are ignored and terms of 4+ characters are "
    "prefix-matched, so a query must share a token with the stored text — "
    "there is no semantic/vector retrieval. Optional decay_days applies a "
    "freshness half-life (2^(-days/decay_days)) so recent entries rank "
    "higher; default None keeps the raw BM25 order.",
)
def memory_search(
    query: str,
    namespace: str | None = None,
    top_k: int = 5,
    decay_days: float | None = None,
) -> list[dict[str, Any]]:
    """Search memories with FTS5 BM25.

    Args:
        query: Search query text.
        namespace: Optional namespace filter.
        top_k: Maximum results (default 5, max 50).
        decay_days: Optional freshness half-life in days. When set, BM25
            scores are multiplied by ``2^(-days_since_created/decay_days)``
            so older entries rank lower. Default None = no decay.

    Returns:
        List of memory entries with a ``score`` (BM25, higher is better,
        freshness-decayed when ``decay_days`` is set) and parsed metadata.
    """
    if not query or not query.strip():
        return []

    top_k = max(1, min(50, int(top_k)))
    db = _get_conn()
    fts_query = _build_fts_query(query)
    if not fts_query:
        return []

    try:
        params: list[Any] = [fts_query]
        namespace_clause = ""
        if namespace:
            namespace_clause = " AND namespace = ?"
            params.append(namespace)
        # Over-fetch 2x: freshness decay can promote a candidate that BM25
        # ranked outside top_k, and ranking happens after the fetch.
        params.append(top_k * 2)
        # ``rank`` is BM25 negated by FTS5 (lower = better), so -rank is the
        # relevance score. It is selected explicitly so the value is available
        # for scoring rather than only for ordering.
        rows = db.execute(
            f"""SELECT rowid, -rank AS bm25 FROM memories_fts
                WHERE memories_fts MATCH ?{namespace_clause}
                ORDER BY rank LIMIT ?""",
            params,
        ).fetchall()
        hits = [(r["rowid"], r["bm25"]) for r in rows]
    except Exception:
        return []

    if not hits:
        return []

    candidate_ids = [doc_id for doc_id, _ in hits]
    created_at_map = (
        _fetch_created_at_map(db, candidate_ids)
        if decay_days is not None and decay_days > 0
        else {}
    )
    ranked = _score_hits(hits, top_k, created_at_map, decay_days)

    if not ranked:
        return []

    # 5. Fetch full entries
    id_list = [doc_id for doc_id, _ in ranked]
    score_map = {doc_id: score for doc_id, score in ranked}

    try:
        placeholders = ",".join("?" * len(id_list))
        rows = db.execute(
            f"""SELECT id, namespace, key, value, metadata, created_at
                FROM memories WHERE id IN ({placeholders})""",
            id_list,
        ).fetchall()
    except Exception:
        return []

    # Preserve ranking order
    row_map = {r["id"]: r for r in rows}
    results: list[dict[str, Any]] = []
    for doc_id in id_list:
        row = row_map.get(doc_id)
        if row is None:
            continue
        entry = dict(row)
        entry = _parse_metadata(entry)
        entry["score"] = round(score_map.get(doc_id, 0.0), 4)
        results.append(entry)

    return results


@mcp.tool(
    description="Recall a specific memory entry by its key within a namespace. "
    "Returns the full entry including parsed metadata.",
)
def memory_recall(
    key: str,
    namespace: str = "default",
) -> dict[str, Any] | None:
    """Exact-match lookup by namespace + key.

    Args:
        key: The unique key of the entry.
        namespace: Namespace scope (default: "default").

    Returns:
        The memory entry dict, or None if not found.
    """
    if not key or not key.strip():
        return None

    db = _get_conn()
    row = db.execute(
        "SELECT id, namespace, key, value, metadata, created_at, updated_at "
        "FROM memories WHERE namespace = ? AND key = ?",
        [namespace, key.strip()],
    ).fetchone()

    if row is None:
        return None

    entry = _dict_from_row(row)
    return _parse_metadata(entry)


@mcp.tool(
    description="Delete a memory entry by ID or by key. "
    "The FTS5 index entry is removed automatically by trigger.",
)
def memory_forget(
    id: int | None = None,
    key: str | None = None,
    namespace: str = "default",
) -> dict[str, Any]:
    """Delete a memory entry and its FTS5 index entry.

    Provide either ``id`` (exact rowid) or ``key`` (within namespace)
    to identify the entry. The FTS sync trigger handles index cleanup.

    Args:
        id: Exact row ID of the entry to delete.
        key: Key of the entry to delete (requires namespace).
        namespace: Namespace scope when using key (default: "default").

    Returns:
        Dict with deleted status and entry identifier.
    """
    if id is not None:
        identifier = id
        col = "id"
        params: list[Any] = [id]
    elif key and key.strip():
        identifier = key
        col = "key"
        params = [key.strip(), namespace]
        sql = "DELETE FROM memories WHERE key = ? AND namespace = ?"
    else:
        return {"error": "Provide either id or key"}

    db = _get_conn()
    try:
        if col == "id":
            cur = db.execute("DELETE FROM memories WHERE id = ?", [id])
        else:
            cur = db.execute(sql, params)
        db.commit()

        if cur.rowcount == 0:
            return {"deleted": False, "error": "Entry not found"}

        return {"deleted": True, col: identifier, "namespace": namespace}
    except Exception as e:
        db.rollback()
        return {"error": f"Failed to delete: {e}"}


@mcp.tool(
    description="List memory entries chronologically with optional "
    "namespace and key-prefix filters.",
)
def memory_list(
    namespace: str | None = None,
    prefix: str = "",
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List memory entries, newest first.

    Args:
        namespace: Optional namespace filter.
        prefix: Optional key prefix filter.
        limit: Maximum entries (default 50, max 500).

    Returns:
        List of memory entries sorted by created_at descending.
    """
    limit = max(1, min(500, int(limit)))
    db = _get_conn()

    conditions: list[str] = []
    params: list[Any] = []

    if namespace:
        conditions.append("namespace = ?")
        params.append(namespace)

    if prefix:
        conditions.append("key LIKE ?")
        params.append(f"{prefix}%")

    where = " AND ".join(conditions) if conditions else "1"

    try:
        rows = db.execute(
            f"SELECT id, namespace, key, value, metadata, created_at "
            f"FROM memories WHERE {where} ORDER BY created_at DESC LIMIT ?",
            [*params, limit],
        ).fetchall()
    except Exception as e:
        return [{"error": f"List failed: {e}"}]

    results = []
    for row in rows:
        entry = _dict_from_row(row)
        results.append(_parse_metadata(entry))

    return results


@mcp.tool(
    description="Memory database statistics: total entries, per-namespace "
    "breakdown, and file size on disk.",
)
def memory_stats() -> dict[str, Any]:
    """Return aggregate statistics about the memory database.

    Includes total count, namespace breakdown, and file size on disk.

    Returns:
        Dict with count, namespaces, and storage info.
    """
    db = _get_conn()

    stats: dict[str, Any] = {"status": "ok"}

    try:
        stats["total_entries"] = db.execute(
            "SELECT COUNT(*) AS c FROM memories"
        ).fetchone()["c"]
    except Exception:
        stats["total_entries"] = 0

    try:
        ns_rows = db.execute(
            "SELECT namespace, COUNT(*) AS c FROM memories GROUP BY namespace "
            "ORDER BY c DESC"
        ).fetchall()
        stats["namespaces"] = [
            {"namespace": r["namespace"], "count": r["c"]} for r in ns_rows
        ]
    except Exception:
        stats["namespaces"] = []

    try:
        db_size = DB_PATH.stat().st_size if DB_PATH.exists() else 0
        stats["db_size_bytes"] = db_size
        for unit in ("B", "KB", "MB", "GB"):
            if db_size < _BYTE_UNIT:
                stats["db_size_human"] = f"{db_size:.2f} {unit}"
                break
            db_size /= 1024.0
        else:
            stats["db_size_human"] = f"{db_size:.2f} TB"
    except Exception:
        stats["db_size_bytes"] = 0
        stats["db_size_human"] = "unknown"

    return stats


# ── Main Entrypoint ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
