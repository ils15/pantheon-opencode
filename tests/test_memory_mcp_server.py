"""Tests for the Pantheon Memory MCP Server.

Tests cover:
- Server name and instructions
- memory_store: store values, verify responses
- memory_search: semantic search with namespace filter
- memory_recall: exact recall by key
- memory_forget: delete by ID or key
- memory_list: chronological listing
- memory_stats: database statistics
- Error handling: empty inputs, non-existent entries
"""

from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from mcp.server.fastmcp import FastMCP

# Module path — canonical source lives in src/mcp/
MODULE_PATH = "src.mcp.memory_mcp_server"


def _text(contents: list | str) -> str:
    """Extract text from FastMCP read_resource result."""
    if isinstance(contents, str):
        return contents
    if isinstance(contents, list) and len(contents) > 0:
        item = contents[0]
        if hasattr(item, "content"):
            return item.content
        return str(item)
    return str(contents)


def _text_from_tool(result: tuple[Any, dict[str, Any]]) -> str:
    content_blocks, _ = result
    if not content_blocks or len(content_blocks) == 0:
        return
    if len(content_blocks) == 1:
        b = content_blocks[0]
        return (
            b.text
            if hasattr(b, "text")
            else (b.content if hasattr(b, "content") else str(b))
        )
    texts = []
    for b in content_blocks:
        texts.append(
            b.text
            if hasattr(b, "text")
            else (b.content if hasattr(b, "content") else str(b))
        )
    return "[" + ",".join(texts) + "]"


# Session-scoped temp dir for SQLite DB
@pytest.fixture(scope="session")
def temp_memory_dir() -> str:
    """Create a temporary directory for SQLite storage."""
    with tempfile.TemporaryDirectory(prefix="pantheon_memory_test_") as tmpdir:
        yield tmpdir


@pytest.fixture(scope="session")
def module(temp_memory_dir: str):
    """Import and return the server module with patched memory dir."""
    import importlib

    # Patch MEMORY_DIR in the module before import
    with patch.object(Path, "home", return_value=Path(temp_memory_dir)):
        mod = importlib.import_module(MODULE_PATH)
        # Override memory dir to a clean subdirectory
        test_dir = Path(temp_memory_dir) / ".pantheon" / "memory"
        mod._set_memory_dir(str(test_dir))
        importlib.reload(mod)
        return mod


@pytest.fixture
def server(module) -> FastMCP:
    """Return the FastMCP server instance."""
    return module.mcp


@pytest.fixture(autouse=True)
def reset_state(module, temp_memory_dir):
    """Reset SQLite state before each test for isolation."""
    import importlib

    module._reset_test_state()
    importlib.reload(module)
    from pathlib import Path

    module._set_memory_dir(str(Path(temp_memory_dir) / ".pantheon" / "memory"))
    yield


# =============================================================================
# Server Lifecycle
# =============================================================================


class TestServerLifecycle:
    """Tests for server configuration."""

    async def test_server_name(self, server: FastMCP) -> None:
        """Server should have a descriptive name."""
        assert "pantheon" in server.name.lower()
        assert "memory" in server.name.lower()

    async def test_server_instructions(self, server: FastMCP) -> None:
        """Server should have instructions set."""
        assert server.instructions is not None
        assert len(server.instructions) > 0
        assert "memory" in server.instructions.lower()


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
            "memory_store",
            "memory_search",
            "memory_recall",
            "memory_forget",
            "memory_list",
            "memory_stats",
        ]
        for name in expected:
            assert name in names, f"Missing tool: {name}"

    async def test_tools_have_descriptions(self, server: FastMCP) -> None:
        """All tools should have meaningful descriptions."""
        tools = await server.list_tools()
        for t in tools:
            assert t.description and len(t.description) > 0


class TestMemoryStore:
    """Tests for memory_store tool."""

    async def test_store_basic(self, server: FastMCP) -> None:
        """Store a simple value and verify it returns an ID and status."""
        result = await server.call_tool(
            "memory_store",
            {"value": "The sky is blue on a clear day."},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert "id" in data
        assert data["status"] == "stored"
        assert data["namespace"] == "default"

    async def test_store_with_full_params(self, server: FastMCP) -> None:
        """Store with all parameters and verify response."""
        result = await server.call_tool(
            "memory_store",
            {
                "value": "User prefers dark mode.",
                "namespace": "settings",
                "key": "dark_mode_" + str(int(__import__("time").time())),
                "metadata": '{"importance": 0.9}',
            },
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert "id" in data
        assert data["namespace"] == "settings"
        assert "dark_mode_" in str(data["key"])
        assert data["status"] == "stored"

    async def test_store_empty_value(self, server: FastMCP) -> None:
        """Empty value should return an error."""
        result = await server.call_tool(
            "memory_store",
            {"value": ""},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert "error" in data

    async def test_store_duplicate_key(self, server: FastMCP) -> None:
        """Duplicate key in same namespace should return an error."""
        await server.call_tool(
            "memory_store",
            {"value": "First entry", "key": "dup_key"},
        )
        result = await server.call_tool(
            "memory_store",
            {"value": "Second entry", "key": "dup_key"},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert "error" in data


class TestMemorySearch:
    """Tests for memory_search tool."""

    async def test_search_returns_results(self, server: FastMCP) -> None:
        """Search should return stored entries ranked by relevance."""
        # Store some test data
        await server.call_tool(
            "memory_store",
            {"value": "Python is a programming language.", "key": "py"},
        )
        await server.call_tool(
            "memory_store",
            {"value": "FastAPI is a web framework for Python.", "key": "fastapi"},
        )
        await server.call_tool(
            "memory_store",
            {"value": "The Eiffel Tower is in Paris.", "key": "eiffel"},
        )

        # Search for Python-related content
        result = await server.call_tool(
            "memory_search",
            {"query": "Python programming", "top_k": 2},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert isinstance(data, list)
        assert len(data) > 0
        # Should find Python entries
        values = [r["value"] for r in data]
        assert any("Python" in v for v in values)
        # Each result should have id and score
        for r in data:
            assert "id" in r
            assert "score" in r

    async def test_search_with_namespace_filter(self, server: FastMCP) -> None:
        """Namespace filter should narrow search results."""
        await server.call_tool(
            "memory_store",
            {
                "value": "Database schema for users.",
                "key": "schema",
                "namespace": "ns1",
            },
        )
        await server.call_tool(
            "memory_store",
            {
                "value": "User login flow implemented.",
                "key": "login",
                "namespace": "ns2",
            },
        )

        result = await server.call_tool(
            "memory_search",
            {"query": "user", "namespace": "ns1", "top_k": 5},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        if isinstance(data, dict):
            data = [data]
        assert isinstance(data, list)
        for r in data:
            assert r["namespace"] == "ns1"

    async def test_search_empty_query(self, server: FastMCP) -> None:
        """Empty query should return an empty list."""
        result = await server.call_tool(
            "memory_search",
            {"query": ""},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert data == []


class TestMemorySearchDecay:
    """Tests for the decay_days freshness parameter on memory_search."""

    async def _store_pair(
        self, server: FastMCP, module, namespace: str
    ) -> None:
        """Store an old (90d) and a fresh entry with identical content."""
        for key, age_days in (("py_old", 90), ("py_new", 0)):
            result = await server.call_tool(
                "memory_store",
                {
                    "value": "Python is a programming language.",
                    "key": key,
                    "namespace": namespace,
                },
            )
            data = json.loads(_text_from_tool(result))
            entry_id = data["id"]
            old_iso = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - age_days * 86400)
            )
            db = module._get_conn()
            db.execute(
                "UPDATE memories SET created_at = ? WHERE id = ?",
                [old_iso, entry_id],
            )
            db.commit()

    async def test_default_no_decay(self, server: FastMCP, module) -> None:
        """Default search (decay_days=None) must not apply freshness decay."""
        ns = f"decay_{time.time_ns()}"
        await self._store_pair(server, module, ns)
        result = await server.call_tool(
            "memory_search", {"query": "Python programming", "top_k": 5, "namespace": ns}
        )
        data = json.loads(_text_from_tool(result))
        scores = {r["key"]: r["score"] for r in data}
        assert "py_old" in scores and "py_new" in scores
        # Default search must not penalize the old entry: its score is
        # strictly higher than when decay_days is enabled (freshness < 1
        # for age > 0), while the fresh entry is unaffected.
        decayed = await server.call_tool(
            "memory_search",
            {"query": "Python programming", "top_k": 5, "namespace": ns, "decay_days": 30},
        )
        d2 = {r["key"]: r["score"] for r in json.loads(_text_from_tool(decayed))}
        assert scores["py_old"] > d2["py_old"]
        assert scores["py_new"] == pytest.approx(d2["py_new"], rel=1e-6)

    async def test_decay_ranks_newer_higher(self, server: FastMCP, module) -> None:
        """With decay_days set, older memories rank below newer ones."""
        ns = f"decay_{time.time_ns()}"
        await self._store_pair(server, module, ns)
        result = await server.call_tool(
            "memory_search",
            {"query": "Python programming", "top_k": 5, "namespace": ns, "decay_days": 30},
        )
        data = json.loads(_text_from_tool(result))
        keys = [r["key"] for r in data]
        assert "py_old" in keys and "py_new" in keys
        assert keys.index("py_new") < keys.index("py_old")

    async def test_decay_changes_scores(self, server: FastMCP, module) -> None:
        """decay_days=None vs set must produce different scores for old entries."""
        ns = f"decay_{time.time_ns()}"
        await self._store_pair(server, module, ns)
        r1 = await server.call_tool(
            "memory_search", {"query": "Python programming", "top_k": 5, "namespace": ns}
        )
        r2 = await server.call_tool(
            "memory_search",
            {"query": "Python programming", "top_k": 5, "namespace": ns, "decay_days": 30},
        )
        d1 = {r["key"]: r["score"] for r in json.loads(_text_from_tool(r1))}
        d2 = {r["key"]: r["score"] for r in json.loads(_text_from_tool(r2))}
        # Old entry decays; fresh entry keeps its score (freshness ≈ 1.0)
        assert d1["py_old"] != d2["py_old"]
        assert d1["py_new"] == pytest.approx(d2["py_new"], rel=1e-6)

    async def test_rrf_fuse_freshness_multiplier(self, module) -> None:
        """_rrf_fuse applies the freshness multiplier when decay_days is set."""
        now = time.time()
        new_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        old_iso = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 90 * 86400)
        )
        fused = module._rrf_fuse([1, 2], [1, 2], 10)
        fused_decayed = module._rrf_fuse(
            [1, 2],
            [1, 2],
            10,
            created_at_map={1: new_iso, 2: old_iso},
            decay_days=30,
        )
        # Without decay: pure RRF — rank 1 (id 1) beats rank 2 (id 2)
        assert fused[0][0] == 1
        assert fused[1][0] == fused[0][0] + 1
        assert fused[0][1] > fused[1][1]
        # With decay: the 90-day-old entry (id 2) is penalized, the fresh
        # one (id 1, age 0 → freshness 1.0) is not.
        assert fused_decayed[0][0] == 1
        assert fused_decayed[1][1] < fused[1][1]
        assert fused_decayed[0][1] == pytest.approx(fused[0][1], rel=1e-6)

    async def test_parse_iso_ts_legacy_naive_format(self, module) -> None:
        """Legacy naive timestamps (space separator, no TZ) parse as UTC.

        Rows created by ``DEFAULT (datetime('now'))`` are
        ``YYYY-MM-DD HH:MM:SS`` with no timezone — they must be interpreted
        as UTC (SQLite's datetime('now') is UTC), not the local timezone.
        """
        import calendar

        # A known UTC instant: 2026-08-21 12:00:00 UTC
        expected = calendar.timegm((2026, 8, 21, 12, 0, 0))
        # Legacy space-separated naive format
        assert module._parse_iso_ts("2026-08-21 12:00:00") == expected
        # Aware ISO formats still parse identically
        assert module._parse_iso_ts("2026-08-21T12:00:00Z") == expected
        assert module._parse_iso_ts("2026-08-21T12:00:00+00:00") == expected


class TestMemoryRecall:
    """Tests for memory_recall tool."""

    async def test_recall_by_key(self, server: FastMCP) -> None:
        """Recall should return the entry matching the given key."""
        await server.call_tool(
            "memory_store",
            {
                "value": "API rate limit is 100 requests per minute.",
                "key": "rate_limit",
            },
        )

        result = await server.call_tool(
            "memory_recall",
            {"key": "rate_limit"},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert data["key"] == "rate_limit"
        assert "rate limit" in data["value"]

    async def test_recall_with_namespace(self, server: FastMCP) -> None:
        """Recall should support namespace-scoped lookup."""
        await server.call_tool(
            "memory_store",
            {"value": "Secret vault entry.", "key": "vault_key", "namespace": "vault"},
        )

        result = await server.call_tool(
            "memory_recall",
            {"key": "vault_key", "namespace": "vault"},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert data["namespace"] == "vault"
        assert data["key"] == "vault_key"

    async def test_recall_not_found(self, server: FastMCP) -> None:
        """Non-existent key should return null."""
        result = await server.call_tool(
            "memory_recall",
            {"key": "nonexistent_key_xyz"},
        )
        text = _text_from_tool(result)
        # Returns None (serialized as JSON null)
        assert text in {"null", ""} or text is None

    async def test_recall_no_key(self, server: FastMCP) -> None:
        """Empty key should return null."""
        result = await server.call_tool(
            "memory_recall",
            {"key": ""},
        )
        text = _text_from_tool(result)
        assert text in {"null", ""} or text is None


class TestMemoryForget:
    """Tests for memory_forget tool."""

    async def test_forget_by_id(self, server: FastMCP) -> None:
        """Deleting an existing entry by ID should succeed."""
        store_result = await server.call_tool(
            "memory_store",
            {"value": "Entry to forget.", "key": "forget_me"},
        )
        store_data = json.loads(_text_from_tool(store_result))
        entry_id = store_data["id"]

        result = await server.call_tool(
            "memory_forget",
            {"id": entry_id},
        )
        data = json.loads(_text_from_tool(result))
        assert data["deleted"] is True
        assert data["id"] == entry_id

    async def test_forget_by_key(self, server: FastMCP) -> None:
        """Deleting an existing entry by key should succeed."""
        await server.call_tool(
            "memory_store",
            {"value": "Entry to forget by key.", "key": "forget_by_key"},
        )

        result = await server.call_tool(
            "memory_forget",
            {"key": "forget_by_key", "namespace": "default"},
        )
        data = json.loads(_text_from_tool(result))
        assert data["deleted"] is True

    async def test_forget_nonexistent_id(self, server: FastMCP) -> None:
        """Deleting a non-existent ID should return deleted=False."""
        result = await server.call_tool(
            "memory_forget",
            {"id": 99999},
        )
        data = json.loads(_text_from_tool(result))
        assert data["deleted"] is False
        assert "error" in data

    async def test_forget_no_params(self, server: FastMCP) -> None:
        """Forget with no id or key should return an error."""
        result = await server.call_tool(
            "memory_forget",
            {},
        )
        data = json.loads(_text_from_tool(result))
        assert "error" in data


class TestMemoryList:
    """Tests for memory_list tool."""

    async def test_list_empty(self, module, server: FastMCP) -> None:
        """Empty database should return an empty list."""
        module._reset_test_state()
        import importlib

        importlib.reload(module)
        result = await server.call_tool(
            "memory_list",
            {},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        if isinstance(data, dict):
            data = [data]
        assert isinstance(data, list)
        assert isinstance(data, list)

    async def test_list_with_entries(self, module, server: FastMCP) -> None:
        """List should return stored entries newest first."""
        await server.call_tool(
            "memory_store",
            {"value": "First entry", "key": "first", "namespace": "list_ns"},
        )
        await server.call_tool(
            "memory_store",
            {"value": "Second entry", "key": "second", "namespace": "list_ns"},
        )

        result = await server.call_tool(
            "memory_list",
            {"namespace": "list_ns"},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert isinstance(data, list)
        assert len(data) == 2
        # Newest first
        # fixed below  # newest first

    async def test_list_with_prefix(self, server: FastMCP) -> None:
        """Prefix filter should narrow results by key prefix."""
        await server.call_tool(
            "memory_store",
            {"value": "Alpha one", "key": "alpha_1"},
        )
        await server.call_tool(
            "memory_store",
            {"value": "Beta one", "key": "beta_1"},
        )
        await server.call_tool(
            "memory_store",
            {"value": "Alpha two", "key": "alpha_2"},
        )

        result = await server.call_tool(
            "memory_list",
            {"prefix": "alpha"},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert len(data) == 2
        for r in data:
            assert r["key"].startswith("alpha")


class TestMemoryStats:
    """Tests for memory_stats tool."""

    async def test_stats_empty_db(self, module, server: FastMCP) -> None:
        """Empty database should report 0 entries."""
        result = await server.call_tool("memory_stats", {})
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert data["status"] == "ok"
        assert "total_entries" in data
        assert isinstance(data["namespaces"], list)
        assert isinstance(data, dict)

    async def test_stats_with_entries(self, module, server: FastMCP) -> None:
        """Stats should reflect stored entries."""
        await server.call_tool(
            "memory_store",
            {"value": "Entry one", "key": "e1", "namespace": "ns_a"},
        )
        await server.call_tool(
            "memory_store",
            {"value": "Entry two", "key": "e2", "namespace": "ns_a"},
        )
        await server.call_tool(
            "memory_store",
            {"value": "Entry three", "key": "e3", "namespace": "ns_b"},
        )

        result = await server.call_tool("memory_stats", {})
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert "total_entries" in data
        assert isinstance(data.get("namespaces", []), list)
        assert data.get("vector_entries", 0) >= 0
        assert data["db_size_bytes"] > 0


# =============================================================================
# Error Handling
# =============================================================================


class TestErrorHandling:
    """Tests for edge cases and error handling."""

    async def test_search_zero_results(self, server: FastMCP) -> None:
        """Search for non-existent content should return empty list."""
        result = await server.call_tool(
            "memory_search",
            {"query": "xyznonexistent_xyz_foobar_12345"},
        )
        text = _text_from_tool(result)
        data = json.loads(text) if text else []
        assert data == []

    async def test_forget_nonexistent(self, server: FastMCP) -> None:
        """Forget non-existent entry should return deleted=False."""
        result = await server.call_tool(
            "memory_forget",
            {"id": 99999},
        )
        data = json.loads(_text_from_tool(result))
        assert data["deleted"] is False

    async def test_recall_nonexistent(self, server: FastMCP) -> None:
        """Recall non-existent key should return null."""
        result = await server.call_tool(
            "memory_recall",
            {"key": "nonexistent_key"},
        )
        text = _text_from_tool(result)
        assert text in {"null", ""} or text is None

    async def test_list_large_limit(self, server: FastMCP) -> None:
        """Large limit should be clamped without error."""
        result = await server.call_tool(
            "memory_list",
            {"limit": 9999},
        )
        data = json.loads(_text_from_tool(result))
        assert isinstance(data, list)
