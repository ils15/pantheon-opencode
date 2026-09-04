"""Tests for the Pantheon Persistence MCP Server (src/mcp/mcp_persistence_server.py).

Tests cover:
- Server name and instructions
- kv_store/kv_get: round-trip, upsert, TTL expiry (real-time + forced)
- kv_list: prefix filter and limit
- kv_search: FTS5 full-text search with namespace filter
- kv_delete: by key
- kv_delete_namespace: full clear + older_than_days
- purge_expired: dry_run, real purge, deletelog
- context_save/context_get/list/stats: TTL semantics, latest pointer,
  session isolation
- namespace + scope isolation

These are correctness-critical: TTL expiry + checkpoint recovery is the
crash-recovery path (Zeus anti-stall / pre-compaction checkpoints).
"""
from __future__ import annotations

import importlib
import json
import sys
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from mcp.server.fastmcp import FastMCP

# Module path — canonical source lives in src/mcp/
MODULE_PATH = "src.mcp.mcp_persistence_server"


def _text_from_tool(result: Any) -> str:
    """Extract text from FastMCP call_tool result.

    FastMCP returns a plain list of ContentBlocks for async tools and a
    ``(content_blocks, structured)`` tuple for sync tools with an output
    schema — handle both shapes.
    """
    content_blocks = result[0] if isinstance(result, tuple) else result
    if content_blocks and len(content_blocks) > 0:
        block = content_blocks[0]
        if hasattr(block, "text"):
            return block.text
        return str(block)
    return ""


def _json(result: Any) -> Any:
    """Parse the payload returned by a tool call.

    FastMCP returns ``(content_blocks, structured)`` tuples for tools with an
    output schema (str/list returns) and plain content-block lists for dict
    returns. Prefer the structured payload when present; fall back to parsing
    the JSON text.
    """
    if isinstance(result, tuple):
        _, structured = result
        if isinstance(structured, dict) and "result" in structured:
            return structured["result"]
        return structured
    text = _text_from_tool(result)
    return json.loads(text) if text else None


# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture(scope="session")
def temp_persistence_dir() -> str:
    """Create a temporary directory for SQLite storage."""
    with tempfile.TemporaryDirectory(prefix="pantheon_persistence_test_") as tmpdir:
        yield tmpdir


@pytest.fixture
def module(temp_persistence_dir: str):
    """Import the server module with a fresh temp DB per test.

    The module runs argparse + DB init at import time, so we patch sys.argv
    with --global-db/--project-db pointing into a fresh per-test directory
    and reload. Each test gets an isolated database.
    """
    test_dir = Path(temp_persistence_dir) / f"db_{time.time_ns()}"
    test_dir.mkdir(parents=True, exist_ok=True)
    argv = [
        "pytest",
        "--global-db",
        str(test_dir / "global.db"),
        "--project-db",
        str(test_dir / "project.db"),
    ]
    with patch.object(sys, "argv", argv):
        mod = importlib.import_module(MODULE_PATH)
        importlib.reload(mod)
    return mod


@pytest.fixture
def server(module) -> FastMCP:
    """Return the FastMCP server instance."""
    return module.mcp


def _force_expiry(module, namespace: str, key: str) -> None:
    """Deterministically expire an entry by backdating expires_at in SQL."""
    conn = module._db("project")
    conn.execute(
        "UPDATE kv_store SET expires_at = '2000-01-01T00:00:00+00:00' "
        "WHERE namespace = ? AND key = ?",
        (namespace, key),
    )
    conn.commit()


def _force_old_created(module, namespace: str, key: str) -> None:
    """Backdate created_at so older_than_days filters match."""
    conn = module._db("project")
    conn.execute(
        "UPDATE kv_store SET created_at = '2000-01-01 00:00:00' "
        "WHERE namespace = ? AND key = ?",
        (namespace, key),
    )
    conn.commit()


# =============================================================================
# Server Lifecycle
# =============================================================================


class TestServerLifecycle:
    """Tests for server configuration."""

    async def test_server_name(self, server: FastMCP) -> None:
        """Server should have a descriptive name."""
        assert "pantheon" in server.name.lower()
        assert "persistence" in server.name.lower()

    async def test_server_instructions(self, server: FastMCP) -> None:
        """Server should have instructions set."""
        assert server.instructions is not None
        assert len(server.instructions) > 0
        assert "key-value" in server.instructions.lower()


# =============================================================================
# Tools
# =============================================================================


class TestTools:
    """Tests for tool registration."""

    async def test_all_tools_registered(self, server: FastMCP) -> None:
        """All expected tools should be registered."""
        tools = await server.list_tools()
        names = [t.name for t in tools]
        expected = [
            "kv_store",
            "kv_get",
            "kv_stats",
            "kv_delete",
            "kv_list",
            "kv_search",
            "purge_expired",
            "kv_delete_namespace",
            "context_save",
            "context_get",
            "context_list",
            "context_stats",
        ]
        for name in expected:
            assert name in names, f"Missing tool: {name}"

    async def test_tools_have_descriptions(self, server: FastMCP) -> None:
        """All tools should have meaningful descriptions."""
        tools = await server.list_tools()
        for t in tools:
            assert t.description and len(t.description) > 0


# =============================================================================
# kv_store / kv_get
# =============================================================================


class TestKVStoreGet:
    """Tests for kv_store and kv_get."""

    async def test_store_and_get_roundtrip(self, server: FastMCP) -> None:
        """Store a value and read it back."""
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "k1", "value": "v1"}
        )
        result = await server.call_tool("kv_get", {"namespace": "ns", "key": "k1"})
        assert _json(result) == "v1"

    async def test_get_missing_returns_null(self, server: FastMCP) -> None:
        """Missing key should return null."""
        result = await server.call_tool(
            "kv_get", {"namespace": "ns", "key": "ghost"}
        )
        assert _json(result) is None

    async def test_upsert_overwrites(self, server: FastMCP) -> None:
        """Storing the same namespace+key replaces the value."""
        await server.call_tool("kv_store", {"namespace": "ns", "key": "k", "value": "old"})
        await server.call_tool("kv_store", {"namespace": "ns", "key": "k", "value": "new"})
        result = await server.call_tool("kv_get", {"namespace": "ns", "key": "k"})
        assert _json(result) == "new"

    async def test_no_ttl_persists(self, server: FastMCP) -> None:
        """Entries without TTL never expire."""
        await server.call_tool("kv_store", {"namespace": "ns", "key": "k", "value": "v"})
        _force_expiry  # noqa: B018 — placeholder guard; no TTL set
        result = await server.call_tool("kv_get", {"namespace": "ns", "key": "k"})
        assert _json(result) == "v"

    async def test_ttl_expiry_real_time(self, server: FastMCP) -> None:
        """A 1s TTL entry must be gone after ~1.2s (crash-recovery path)."""
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "k", "value": "v", "ttl": 1}
        )
        # Immediately readable
        assert _json(await server.call_tool("kv_get", {"namespace": "ns", "key": "k"})) == "v"
        time.sleep(1.2)
        result = await server.call_tool("kv_get", {"namespace": "ns", "key": "k"})
        assert _json(result) is None, "TTL entry must expire after the TTL elapses"

    async def test_ttl_expiry_forced(self, server: FastMCP, module) -> None:
        """Backdating expires_at must make kv_get return None."""
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "k", "value": "v", "ttl": 3600}
        )
        _force_expiry(module, "ns", "k")
        result = await server.call_tool("kv_get", {"namespace": "ns", "key": "k"})
        assert _json(result) is None


# =============================================================================
# kv_list
# =============================================================================


class TestKVList:
    """Tests for kv_list."""

    async def test_list_with_prefix(self, server: FastMCP) -> None:
        """Prefix filter should narrow results by key prefix."""
        await server.call_tool("kv_store", {"namespace": "ns", "key": "alpha_1", "value": "a"})
        await server.call_tool("kv_store", {"namespace": "ns", "key": "alpha_2", "value": "b"})
        await server.call_tool("kv_store", {"namespace": "ns", "key": "beta_1", "value": "c"})
        result = await server.call_tool("kv_list", {"namespace": "ns", "prefix": "alpha"})
        data = _json(result)
        assert isinstance(data, list)
        assert len(data) == 2
        for r in data:
            assert r["key"].startswith("alpha")

    async def test_list_excludes_expired(self, server: FastMCP, module) -> None:
        """Expired entries must not appear in kv_list."""
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "fresh", "value": "a", "ttl": 3600}
        )
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "stale", "value": "b", "ttl": 3600}
        )
        _force_expiry(module, "ns", "stale")
        result = await server.call_tool("kv_list", {"namespace": "ns"})
        keys = [r["key"] for r in _json(result)]
        assert "fresh" in keys
        assert "stale" not in keys


# =============================================================================
# kv_search (FTS5)
# =============================================================================


class TestKVSearch:
    """Tests for kv_search."""

    async def test_search_finds_value(self, server: FastMCP) -> None:
        """FTS5 search should find entries by value content."""
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "doc", "value": "the quick brown fox"}
        )
        result = await server.call_tool("kv_search", {"query": "brown fox"})
        data = _json(result)
        assert isinstance(data, list)
        assert len(data) > 0
        assert data[0]["key"] == "doc"
        assert "score" in data[0]

    async def test_search_namespace_filter(self, server: FastMCP) -> None:
        """Namespace filter should narrow search results."""
        await server.call_tool(
            "kv_store", {"namespace": "ns1", "key": "a", "value": "shared token content"}
        )
        await server.call_tool(
            "kv_store", {"namespace": "ns2", "key": "b", "value": "shared token content"}
        )
        result = await server.call_tool(
            "kv_search", {"query": "shared token", "namespace": "ns1"}
        )
        data = _json(result)
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["namespace"] == "ns1"

    async def test_search_empty_query(self, server: FastMCP) -> None:
        """Empty query should return an empty list."""
        result = await server.call_tool("kv_search", {"query": ""})
        assert _json(result) == []

    async def test_search_excludes_expired(self, server: FastMCP, module) -> None:
        """Expired entries must not appear in search results."""
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "fresh", "value": "unique term alpha", "ttl": 3600}
        )
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "stale", "value": "unique term beta", "ttl": 3600}
        )
        _force_expiry(module, "ns", "stale")
        result = await server.call_tool("kv_search", {"query": "unique term"})
        keys = [r["key"] for r in _json(result)]
        assert "fresh" in keys
        assert "stale" not in keys


# =============================================================================
# kv_delete
# =============================================================================


class TestKVDelete:
    """Tests for kv_delete."""

    async def test_delete_existing(self, server: FastMCP) -> None:
        """Deleting an existing key should report deleted."""
        await server.call_tool("kv_store", {"namespace": "ns", "key": "k", "value": "v"})
        result = await server.call_tool("kv_delete", {"namespace": "ns", "key": "k"})
        assert _json(result) == {"status": "deleted"}
        assert _json(await server.call_tool("kv_get", {"namespace": "ns", "key": "k"})) is None

    async def test_delete_missing(self, server: FastMCP) -> None:
        """Deleting a missing key should report not_found."""
        result = await server.call_tool("kv_delete", {"namespace": "ns", "key": "ghost"})
        assert _json(result) == {"status": "not_found"}


# =============================================================================
# kv_delete_namespace
# =============================================================================


class TestKVDeleteNamespace:
    """Tests for kv_delete_namespace."""

    async def test_delete_all_in_namespace(self, server: FastMCP) -> None:
        """Clearing a namespace should remove all its entries only."""
        await server.call_tool("kv_store", {"namespace": "ns", "key": "a", "value": "1"})
        await server.call_tool("kv_store", {"namespace": "ns", "key": "b", "value": "2"})
        await server.call_tool("kv_store", {"namespace": "other", "key": "c", "value": "3"})
        result = await server.call_tool("kv_delete_namespace", {"namespace": "ns"})
        assert _json(result) == {"deleted": 2}
        assert _json(await server.call_tool("kv_get", {"namespace": "ns", "key": "a"})) is None
        # Other namespace untouched
        assert _json(await server.call_tool("kv_get", {"namespace": "other", "key": "c"})) == "3"

    async def test_delete_older_than_days(self, server: FastMCP, module) -> None:
        """older_than_days should only delete entries older than N days."""
        await server.call_tool("kv_store", {"namespace": "ns", "key": "old", "value": "1"})
        await server.call_tool("kv_store", {"namespace": "ns", "key": "new", "value": "2"})
        _force_old_created(module, "ns", "old")
        result = await server.call_tool(
            "kv_delete_namespace", {"namespace": "ns", "older_than_days": 30}
        )
        assert _json(result) == {"deleted": 1}
        assert _json(await server.call_tool("kv_get", {"namespace": "ns", "key": "old"})) is None
        assert _json(await server.call_tool("kv_get", {"namespace": "ns", "key": "new"})) == "2"


# =============================================================================
# purge_expired
# =============================================================================


class TestPurgeExpired:
    """Tests for purge_expired."""

    async def test_dry_run_reports_without_purging(self, server: FastMCP, module) -> None:
        """dry_run should report the count but leave entries un-purged."""
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "k", "value": "v", "ttl": 3600}
        )
        _force_expiry(module, "ns", "k")
        result = await server.call_tool("purge_expired", {"dry_run": True})
        data = _json(result)
        assert data["dry_run"] is True
        assert data["purged"] == 1
        # Still in the DB — nothing was soft-deleted
        conn = module._db("project")
        row = conn.execute(
            "SELECT deleted_at FROM kv_store WHERE namespace = 'ns' AND key = 'k'"
        ).fetchone()
        assert row is not None and row[0] is None, "dry_run must not soft-delete"

    async def test_purge_soft_deletes_and_writes_deletelog(
        self, server: FastMCP, module
    ) -> None:
        """Purge should soft-delete expired entries and log them to the deletelog."""
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "k1", "value": "v1", "ttl": 3600}
        )
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "k2", "value": "v2", "ttl": 3600}
        )
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "keep", "value": "v3", "ttl": 3600}
        )
        _force_expiry(module, "ns", "k1")
        _force_expiry(module, "ns", "k2")

        result = await server.call_tool("purge_expired", {})
        assert _json(result) == {"purged": 2, "dry_run": False}

        # Soft-deleted: kv_get returns None, but the row still exists (deleted_at set)
        assert _json(await server.call_tool("kv_get", {"namespace": "ns", "key": "k1"})) is None
        conn = module._db("project")
        row = conn.execute(
            "SELECT deleted_at FROM kv_store WHERE namespace = 'ns' AND key = 'k1'"
        ).fetchone()
        assert row is not None and row[0] is not None, "purge must soft-delete (deleted_at set)"

        # Deletelog written next to the actual project DB (not the repo's)
        db_path = module._resolve_db_path("project")
        assert db_path is not None
        log_path = Path(str(db_path) + ".deletelog")
        assert log_path.exists(), f"deletelog missing at {log_path}"
        content = log_path.read_text(encoding="utf-8")
        assert "PURGED=2" in content
        assert "k1" in content and "k2" in content

    async def test_purge_nothing(self, server: FastMCP) -> None:
        """No expired entries → purged 0, no deletelog."""
        await server.call_tool("kv_store", {"namespace": "ns", "key": "k", "value": "v"})
        result = await server.call_tool("purge_expired", {})
        assert _json(result) == {"purged": 0, "dry_run": False}

    async def test_auto_purge_same_day_expiry(self, server: FastMCP, module) -> None:
        """_opportunistic_auto_purge must catch same-day expiry.

        expires_at uses the ISO 'T' separator while datetime('now') is
        space-separated, so a naive ``expires_at < datetime('now')`` compares
        'T' (0x54) > ' ' (0x20) at position 10 and treats a stale same-day
        row as still valid. All comparisons must go through datetime().
        """
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "k", "value": "v", "ttl": 3600}
        )
        # Backdate to 1s ago but keep today's date + ISO 'T' separator.
        stale = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        conn = module._db("project")
        conn.execute(
            "UPDATE kv_store SET expires_at = ? WHERE namespace = ? AND key = ?",
            (stale, "ns", "k"),
        )
        conn.commit()

        # threshold=0 forces the auto-purge UPDATE regardless of namespace size.
        module._opportunistic_auto_purge(conn, "ns", threshold=0)

        row = conn.execute(
            "SELECT deleted_at FROM kv_store WHERE namespace = 'ns' AND key = 'k'"
        ).fetchone()
        assert row is not None and row[0] is not None, (
            "same-day expired row must be soft-deleted by auto-purge"
        )
        assert _json(await server.call_tool("kv_get", {"namespace": "ns", "key": "k"})) is None


# =============================================================================
# Context checkpoints
# =============================================================================


class TestContextCheckpoints:
    """Tests for context_save/context_get/context_list/context_stats."""

    async def test_context_save_get_roundtrip(self, server: FastMCP) -> None:
        """Save a checkpoint and read it back with the returned session_id."""
        saved = _json(
            await server.call_tool(
                "context_save", {"slug": "my-task", "key": "phase:1", "content": '{"a": 1}'}
            )
        )
        assert saved["status"] == "stored"
        assert "session_id" in saved
        assert saved["namespace"].startswith("checkpoint:my-task:")
        result = await server.call_tool(
            "context_get",
            {"slug": "my-task", "key": "phase:1", "session_id": saved["session_id"]},
        )
        assert _json(result) == '{"a": 1}'

    async def test_context_latest_pointer(self, server: FastMCP) -> None:
        """Saving a checkpoint must update the 'latest' pointer."""
        saved = _json(
            await server.call_tool(
                "context_save", {"slug": "s", "key": "phase:2", "content": "second"}
            )
        )
        sid = saved["session_id"]
        await server.call_tool(
            "context_save", {"slug": "s", "key": "phase:3", "content": "third", "session_id": sid}
        )
        latest = _json(
            await server.call_tool("context_get", {"slug": "s", "key": "latest", "session_id": sid})
        )
        assert latest == "third"

    async def test_context_list(self, server: FastMCP) -> None:
        """context_list should return keys with timestamps."""
        saved = _json(
            await server.call_tool("context_save", {"slug": "s", "key": "phase:1", "content": "a"})
        )
        sid = saved["session_id"]
        await server.call_tool(
            "context_save", {"slug": "s", "key": "phase:2", "content": "b", "session_id": sid}
        )
        result = await server.call_tool("context_list", {"slug": "s", "session_id": sid})
        data = _json(result)
        keys = {r["key"] for r in data}
        assert "phase:1" in keys
        assert "phase:2" in keys
        assert "latest" in keys
        for r in data:
            assert "created_at" in r and "expires_at" in r

    async def test_context_stats(self, server: FastMCP) -> None:
        """context_stats should report entry count and TTL remaining."""
        saved = _json(
            await server.call_tool("context_save", {"slug": "s", "key": "phase:1", "content": "hello"})
        )
        sid = saved["session_id"]
        result = await server.call_tool("context_stats", {"slug": "s", "session_id": sid})
        data = _json(result)
        assert data["slug"] == "s"
        assert data["entry_count"] >= 2  # phase:1 + latest
        assert data["total_bytes"] >= 5
        assert data["ttl_remaining_seconds"] is not None
        assert data["ttl_remaining_seconds"] > 0

    async def test_context_ttl_expiry(self, server: FastMCP, module) -> None:
        """An expired checkpoint must be unreachable (crash-recovery path)."""
        saved = _json(
            await server.call_tool(
                "context_save", {"slug": "s", "key": "phase:1", "content": "x"}
            )
        )
        sid = saved["session_id"]
        ns = saved["namespace"]
        conn = module._db("project")
        conn.execute(
            "UPDATE kv_store SET expires_at = '2000-01-01T00:00:00+00:00' WHERE namespace = ?",
            (ns,),
        )
        conn.commit()
        result = await server.call_tool(
            "context_get", {"slug": "s", "key": "phase:1", "session_id": sid}
        )
        assert _json(result) is None

    async def test_context_session_isolation(self, server: FastMCP) -> None:
        """A different session_id must not see another session's checkpoints."""
        await server.call_tool(
            "context_save", {"slug": "s", "key": "phase:1", "content": "x"}
        )
        result = await server.call_tool(
            "context_get", {"slug": "s", "key": "phase:1", "session_id": "other_session"}
        )
        assert _json(result) is None
        # Without session_id, the unscoped namespace has nothing
        result2 = await server.call_tool("context_get", {"slug": "s", "key": "phase:1"})
        assert _json(result2) is None


# =============================================================================
# Isolation
# =============================================================================


class TestIsolation:
    """Tests for namespace and scope isolation."""

    async def test_namespaces_isolated(self, server: FastMCP) -> None:
        """Same key in different namespaces must not collide."""
        await server.call_tool("kv_store", {"namespace": "ns_a", "key": "k", "value": "A"})
        await server.call_tool("kv_store", {"namespace": "ns_b", "key": "k", "value": "B"})
        assert _json(await server.call_tool("kv_get", {"namespace": "ns_a", "key": "k"})) == "A"
        assert _json(await server.call_tool("kv_get", {"namespace": "ns_b", "key": "k"})) == "B"

    async def test_global_scope_isolated_from_project(self, server: FastMCP) -> None:
        """Global scope must be a separate database from project scope."""
        await server.call_tool("kv_store", {"namespace": "ns", "key": "k", "value": "project"})
        await server.call_tool(
            "kv_store", {"namespace": "ns", "key": "k", "value": "global", "scope": "global"}
        )
        assert _json(await server.call_tool("kv_get", {"namespace": "ns", "key": "k"})) == "project"
        assert (
            _json(
                await server.call_tool(
                    "kv_get", {"namespace": "ns", "key": "k", "scope": "global"}
                )
            )
            == "global"
        )

    async def test_kv_stats_reports_entries(self, server: FastMCP) -> None:
        """kv_stats should reflect stored entries and DB size."""
        await server.call_tool("kv_store", {"namespace": "ns", "key": "a", "value": "1"})
        await server.call_tool("kv_store", {"namespace": "ns", "key": "b", "value": "2"})
        result = await server.call_tool("kv_stats", {})
        data = _json(result)
        assert data["total_entries"] == 2
        assert data["namespaces"]["ns"]["count"] == 2
        assert data["db_size_bytes"] > 0
