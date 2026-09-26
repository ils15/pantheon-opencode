"""Tests for the Pantheon Memory MCP Server.

Tests cover:
- Server name and instructions
- FTS5 query construction: stopword drop, no prefix star under 4 chars
- memory_store: store values, verify responses
- memory_search: FTS5 BM25 search with namespace filter
- memory_recall: exact recall by key
- memory_forget: delete by ID or key
- memory_list: chronological listing
- memory_stats: database statistics
- Vector removal: no vector path, no embedding deps, FTS5 still serves search
- Error handling: empty inputs, non-existent entries
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
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

    # No importorskip here: the server is stdlib+FTS5 only. A skip guard keyed
    # on an optional embedding backend would silently skip the whole suite if
    # that backend were ever removed from the environment again.
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
# Validation Reporting
# =============================================================================
# Regression cover for memory_store's ``metadata`` contract: it is a JSON object
# encoded as a STRING, and passing the object itself used to surface as
# pydantic's bare "Input should be a valid string" — no path, no received type,
# no example.


class TestMemoryStoreValidationReporting:
    """metadata's shape is documented, actionable, and accumulated."""

    async def test_metadata_object_reports_type_and_example(
        self, server: FastMCP
    ) -> None:
        """A metadata object names the received type and shows a correct example."""
        with pytest.raises(Exception) as excinfo:
            await server.call_tool(
                "memory_store",
                {
                    "value": "remember this",
                    "namespace": "validation",
                    "metadata": {"type": "decision", "score": 0.9},
                },
            )
        message = str(excinfo.value)

        assert "metadata must be a JSON object encoded as a string" in message
        assert "(got object)" in message
        assert "json.dumps it first" in message
        assert """metadata='{"type": "decision", "score": 0.9}'""" in message

    async def test_metadata_object_and_another_bad_argument_report_both(
        self, server: FastMCP
    ) -> None:
        """metadata-as-object plus a second invalid argument reports both."""
        with pytest.raises(Exception) as excinfo:
            await server.call_tool(
                "memory_store",
                {
                    "value": "remember this",
                    "namespace": "validation",
                    "key": {"not": "a string"},
                    "metadata": {"type": "decision"},
                },
            )
        message = str(excinfo.value)

        assert "2 validation errors" in message
        assert "key" in message
        assert "metadata must be a JSON object encoded as a string" in message

    async def test_empty_value_and_invalid_metadata_report_both(
        self, server: FastMCP
    ) -> None:
        """Two in-body violations surface together instead of one per call."""
        result = await server.call_tool(
            "memory_store",
            {"value": "", "namespace": "validation", "metadata": "{not json"},
        )
        data = json.loads(_text_from_tool(result))
        message = data["error"]

        assert "2 invalid arguments" in message
        assert "value is required and must be a non-empty string" in message
        assert "metadata must be a JSON object encoded as a valid JSON string" in message
        assert "got invalid JSON" in message
        assert message.count("example:") == 1

    async def test_invalid_metadata_is_not_labelled_a_store_failure(
        self, server: FastMCP
    ) -> None:
        """A metadata parse error is a validation error, not 'Failed to store'."""
        result = await server.call_tool(
            "memory_store",
            {
                "value": "remember this",
                "namespace": "validation",
                "metadata": "{not json",
            },
        )
        data = json.loads(_text_from_tool(result))

        assert "metadata must be a JSON object encoded as a valid JSON string" in (
            data["error"]
        )
        assert "Failed to store memory" not in data["error"]

    async def test_metadata_string_still_stores(self, server: FastMCP) -> None:
        """The documented string form is unaffected by the stricter message."""
        result = await server.call_tool(
            "memory_store",
            {
                "value": "remember this",
                "namespace": "validation",
                "key": "as-string",
                "metadata": '{"importance": 0.9}',
            },
        )
        data = json.loads(_text_from_tool(result))
        assert data["status"] == "stored"
        assert "error" not in data

    async def test_metadata_schema_and_description_document_the_string_shape(
        self, server: FastMCP
    ) -> None:
        """The declared input schema teaches the string-encoded shape."""
        tools = {t.name: t for t in await server.list_tools()}
        store = tools["memory_store"]

        schema_description = store.inputSchema["properties"]["metadata"]["description"]
        assert "encoded as a STRING" in schema_description
        assert "not an object" in schema_description
        assert "JSON object encoded as a STRING" in (store.description or "")


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

    async def test_instructions_do_not_advertise_removed_vector_stack(
        self, server: FastMCP
    ) -> None:
        """The instruction string is the model's only signal on retrieval mode.

        It previously read "Lightweight semantic memory with sqlite-vec +
        fastembed" — wrong while the vector path existed under a degraded
        default, and left wrong by the removal. It must now state lexical-only
        retrieval and name no embedding backend.
        """
        instructions = (server.instructions or "").lower()
        assert "fts5" in instructions
        assert "lexical" in instructions
        for banned in ("sqlite-vec", "sqlite_vec", "fastembed", "semantic"):
            assert banned not in instructions, (
                f"instructions still advertise {banned!r} after vector removal"
            )


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

    async def test_score_hits_freshness_multiplier(self, module) -> None:
        """_score_hits applies the freshness multiplier when decay_days is set."""
        now = time.time()
        new_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        old_iso = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 90 * 86400)
        )
        hits = [(1, 2.0), (2, 1.5)]
        ranked = module._score_hits(hits, 10)
        ranked_decayed = module._score_hits(
            hits,
            10,
            created_at_map={1: new_iso, 2: old_iso},
            decay_days=30,
        )
        # Without decay: BM25 order is preserved, scores untouched.
        assert [doc_id for doc_id, _ in ranked] == [1, 2]
        assert ranked[0][1] == pytest.approx(2.0)
        assert ranked[1][1] == pytest.approx(1.5)
        # With decay: the 90-day-old entry is penalized, the fresh one
        # (age 0 → freshness 1.0) is not — and it now outranks the old one.
        assert ranked_decayed[0][0] == 1
        assert ranked_decayed[1][0] == 2
        assert ranked_decayed[0][1] == pytest.approx(ranked[0][1], rel=1e-6)
        assert ranked_decayed[1][1] < ranked[1][1]

    async def test_score_hits_breaks_ties_deterministically(self, module) -> None:
        """Equal BM25 scores rank by ascending id, not by input order."""
        assert module._score_hits([(7, 1.0), (3, 1.0)], 10) == [
            (3, 1.0),
            (7, 1.0),
        ]

    async def test_score_hits_truncates_to_top_k(self, module) -> None:
        """Only top_k results survive scoring."""
        hits = [(i, float(10 - i)) for i in range(1, 6)]
        assert len(module._score_hits(hits, 2)) == 2

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
        assert data["db_size_bytes"] > 0
        # The vector table is gone, so its count must not be reported.
        assert "vector_entries" not in data


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

# =============================================================================
# FTS Query Construction (Step A — prefix-pollution fix)
# =============================================================================
# The production query used to be
#     " OR ".join(f'"{word}"*' for word in query.split())
# i.e. prefix-match every token, stopwords included. Measured on the live store
# (1,553 memories) that OR-ed in terms like "the"/"is"/"how" whose prefixes
# match most of the corpus: a query for purge/threshold/checkpoint pulled 1,001
# candidate documents. These tests pin both corrections.


class TestBuildFtsQuery:
    """_build_fts_query drops stopwords and stops prefixing short terms."""

    def test_stopwords_are_not_or_joined(self, module) -> None:
        """Function words are removed instead of widening the candidate pool."""
        expr = module._build_fts_query("what is the purge threshold for the namespace")
        for stopword in ('"what"', '"is"', '"the"', '"for"'):
            assert stopword not in expr, f"{stopword} still OR-ed in: {expr}"
        assert expr == '"purge"* OR "threshold"* OR "namespace"*'

    def test_short_terms_match_exactly_without_a_star(self, module) -> None:
        """A prefix on a 3-character token matches a large slice of the corpus.

        "com"* alone matched 1,235 of 1,550 documents, so no term under
        _MIN_PREFIX_LEN may be prefix-matched. "in" is a stopword and is
        dropped outright, so the non-stopword short terms are used here.
        """
        expr = module._build_fts_query("TS config Py db")
        assert expr == '"TS" OR "config"* OR "Py" OR "db"'
        for term in ('"TS"', '"Py"', '"db"'):
            assert f"{term}*" not in expr

    def test_four_character_boundary_is_inclusive_for_prefixing(
        self, module
    ) -> None:
        """Four characters is the shortest prefix-matched length."""
        assert module._MIN_PREFIX_LEN == 4
        assert module._build_fts_query("config") == '"config"*'
        assert module._build_fts_query("conf") == '"conf"*'
        assert module._build_fts_query("con") == '"con"'

    def test_all_stopword_query_falls_back_to_exact_match(self, module) -> None:
        """A stopword-only query degrades to a literal lookup, not to nothing.

        Returning "" would silently produce zero results for a query the old
        implementation answered.
        """
        expr = module._build_fts_query("the and of")
        assert expr == '"the" OR "and" OR "of"'
        assert all("*" not in term for term in expr.split(" OR "))

    def test_empty_and_whitespace_only_input(self, module) -> None:
        """No tokens means no expression; memory_search returns [] before use."""
        assert module._build_fts_query("") == ""
        assert module._build_fts_query("   \t\n ") == ""

    def test_stopword_filter_is_case_insensitive(self, module) -> None:
        """Query casing must not smuggle a stopword back into the OR-join."""
        expr = module._build_fts_query("The purge THE threshold")
        assert '"The"' not in expr and '"THE"' not in expr
        assert expr == '"purge"* OR "threshold"*'

    def test_content_terms_are_preserved_in_order(self, module) -> None:
        """Filtering must not drop or reorder real terms."""
        assert (
            module._build_fts_query("remove vector store from memory server")
            == '"remove"* OR "vector"* OR "store"* OR "memory"* OR "server"*'
        )


# =============================================================================
# Vector Removal
# =============================================================================
# The vector path (sqlite-vec + fastembed + RRF fusion) was deleted outright —
# no feature flag, no fallback. These tests exist so the deletion cannot be
# silently reverted: a reintroduced symbol fails here, not in production.


class TestVectorRemoval:
    """The module exposes exactly one code path: FTS5."""

    REMOVED_SYMBOLS = (
        "sqlite_vec",
        "TextEmbedding",
        "_embed",
        "_embeddings_enabled",
        "_get_embedder",
        "_rrf_fuse",
        "_RRF_CONST",
        "_EMBED_DISABLED",
        "VEC_SCHEMA_SQL",
        "EMBED_CACHE",
    )

    @pytest.mark.parametrize("symbol", REMOVED_SYMBOLS)
    def test_removed_symbol_is_absent(self, module, symbol) -> None:
        """None of the deleted vector symbols survive on the module."""
        assert not hasattr(module, symbol), (
            f"{symbol} still present: the vector path was removed, not flagged"
        )

    def test_schema_has_no_vector_table(self, module) -> None:
        """The vec0 virtual table is neither defined nor created."""
        assert "vec_memories" not in module.SCHEMA_SQL
        assert "vec0" not in module.SCHEMA_SQL
        conn = module._get_conn()
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE name LIKE 'vec_%'"
            )
        }
        assert tables == set(), f"vector tables present in a fresh DB: {tables}"

    def test_flag_is_gone_from_the_environment_surface(
        self, module, monkeypatch
    ) -> None:
        """PANTHEON_MEMORY_EMBED no longer has any code path that reads it.

        The flag only ever appeared in this test file — never in a config or
        script — which is why removing it is the correct disposition. Setting
        it to a hostile value must change nothing.
        """
        source = Path(module.__file__).read_text(encoding="utf-8")
        assert "PANTHEON_MEMORY_EMBED" not in source
        for hostile in ("off", "0", "false", "no", "on"):
            monkeypatch.setenv("PANTHEON_MEMORY_EMBED", hostile)
            assert module._build_fts_query("purge threshold") == (
                '"purge"* OR "threshold"*'
            )

    def test_requirements_pin_no_embedding_backend(self) -> None:
        """The MCP requirements must not pull the removed stack back in.

        Only the requirement lines are checked — the file's comment records
        that the removal happened, and naming the packages there is the point.
        """
        reqs = (
            Path(__file__).resolve().parent.parent
            / "src"
            / "mcp"
            / "requirements-mcp.txt"
        ).read_text(encoding="utf-8")
        pins = [
            line.strip()
            for line in reqs.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        assert pins, "requirements file is empty"
        for banned in ("sqlite-vec", "sqlite_vec", "fastembed"):
            assert not any(
                banned in pin for pin in pins
            ), f"{banned} is still pinned: {pins}"

    def test_shipped_scripts_copy_also_has_no_vector_path(self) -> None:
        """The scripts/ copy ships standalone and must agree on the removal."""
        copy = (
            Path(__file__).resolve().parent.parent / "scripts" / "memory_mcp_server.py"
        ).read_text(encoding="utf-8")
        for banned in (
            "import sqlite_vec",
            "from fastembed",
            "vec_memories",
            "_rrf_fuse",
            "PANTHEON_MEMORY_EMBED",
            "VEC_SCHEMA_SQL",
        ):
            assert banned not in copy, f"scripts/ copy still references {banned!r}"

    async def test_stats_omits_vector_count(self, server: FastMCP) -> None:
        """memory_stats must not report a table that no longer exists."""
        result = await server.call_tool("memory_stats", {})
        data = json.loads(_text_from_tool(result))
        assert "vector_entries" not in data
        assert data["total_entries"] >= 0

    def test_server_serves_store_search_forget_without_embedding_backends(
        self, tmp_path
    ) -> None:
        """A full store -> search -> forget cycle works with fastembed blocked.

        Blocks the backend outright and sets the retired flag to a hostile
        value, so the subprocess proves both that the import is gone and that
        no environment variable can reintroduce a second code path.
        """
        repo_root = Path(__file__).resolve().parent.parent
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            str(p)
            for p in (repo_root, repo_root / "src" / "mcp", repo_root / "scripts")
        )
        env["PANTHEON_MEMORY_EMBED"] = "on"
        script = textwrap.dedent(
            """\
            import asyncio
            import json
            import sys
            import tempfile

            # The retired backend is still installed in this environment, so
            # block it to prove the server never reaches for it.
            sys.modules["fastembed"] = None
            sys.modules["sqlite_vec"] = None

            import src.mcp.memory_mcp_server as m

            m._set_memory_dir(tempfile.mkdtemp())

            for gone in (
                "sqlite_vec",
                "TextEmbedding",
                "_embed",
                "_embeddings_enabled",
                "_rrf_fuse",
                "VEC_SCHEMA_SQL",
            ):
                assert not hasattr(m, gone), f"{gone} still present"

            def parsed(result):
                return json.loads(result[0][0].text)

            def as_list(data):
                # FastMCP collapses a single-element list result into an object
                return [data] if isinstance(data, dict) else data

            async def main() -> None:
                tools = await m.mcp.list_tools()
                names = [t.name for t in tools]
                assert "memory_search" in names, f"tools missing: {names}"

                store = await m.mcp.call_tool(
                    "memory_store",
                    {"value": "Python is a programming language.", "key": "py"},
                )
                data = parsed(store)
                assert data["status"] == "stored", data
                entry_id = data["id"]

                await m.mcp.call_tool(
                    "memory_store",
                    {"value": "FastAPI is a web framework for Python.", "key": "fastapi"},
                )

                hits = await m.mcp.call_tool(
                    "memory_search", {"query": "Python programming", "top_k": 3}
                )
                results = as_list(parsed(hits))
                assert results, "FTS search must work with no embedding backend"
                assert any("Python" in r["value"] for r in results)
                assert all("score" in r for r in results)
                # BM25 scores come back ranked, highest first.
                scores = [r["score"] for r in results]
                assert scores == sorted(scores, reverse=True), scores

                stats = parsed(await m.mcp.call_tool("memory_stats", {}))
                assert "vector_entries" not in stats

                forget = await m.mcp.call_tool("memory_forget", {"id": entry_id})
                assert parsed(forget)["deleted"] is True

            asyncio.run(main())
            print("VECTOR_REMOVED_OK")
            """
        )
        run = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            env=env,
            timeout=300,
            check=False,
        )
        assert run.returncode == 0, run.stderr
        assert "VECTOR_REMOVED_OK" in run.stdout
