"""Store hygiene for the Memory MCP: entry cap, TTL, and size accounting.

Covers the write-side bound (rejected, never truncated), the aggregate numbers
``memory_stats`` reports, per-entry expiry as seen by search vs. recall, the
explicit expired-row purge, and opening a database created before the
``expires_at`` column existed.
"""

from __future__ import annotations

import importlib
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastmcp import FastMCP

MODULE_PATH = "src.mcp.memory_mcp"

CAP_ENV = "PANTHEON_MEMORY_MAX_ENTRY_BYTES"

# Pre-TTL schema, verbatim from the version that shipped before ``expires_at``.
OLD_SCHEMA_SQL = """
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL DEFAULT 'default',
    key TEXT,
    value TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_memories_ns_key ON memories(namespace, key);

CREATE VIRTUAL TABLE memories_fts USING fts5(
    namespace, key, value, metadata,
    content='memories', content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, namespace, key, value, metadata)
    VALUES (new.id, new.namespace, new.key, new.value, new.metadata);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, namespace, key, value, metadata)
    VALUES ('delete', old.id, old.namespace, old.key, old.value, old.metadata);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, namespace, key, value, metadata)
    VALUES ('delete', old.id, old.namespace, old.key, old.value, old.metadata);
    INSERT INTO memories_fts(rowid, namespace, key, value, metadata)
    VALUES (new.id, new.namespace, new.key, new.value, new.metadata);
END;
"""

ONE_ENTRY = 1
TWO_ENTRIES = 2
ONE_KIB = 1024


def _text_from_tool(result: Any) -> str:
    blocks = getattr(result, "content", result)
    if isinstance(blocks, tuple):
        blocks = blocks[0]
    if not blocks:
        return ""
    return blocks[0].text if hasattr(blocks[0], "text") else str(blocks)


def _payload(result: Any) -> Any:
    """Parse the JSON payload a memory tool returned.

    Tools returning ``None`` (``memory_recall`` on a miss) carry no text, so an
    empty payload means "no value", not "empty list".
    """
    text = _text_from_tool(result)
    return json.loads(text) if text else None


def _list_payload(result: Any) -> list[Any]:
    """Parse a list-returning tool payload; no results serializes as no text."""
    return _payload(result) or []


@pytest.fixture
def module(tmp_path: Path):
    """Import the memory MCP module bound to a fresh temporary database."""
    mod = importlib.import_module(MODULE_PATH)
    mod._set_memory_dir(str(tmp_path / "memory"))
    mod._reset_test_state()
    return mod


@pytest.fixture
def server(module) -> FastMCP:
    return module.mcp


@pytest.fixture
def cap_env(monkeypatch):
    """Set the entry cap for the duration of a test."""

    def _set(cap: int) -> int:
        monkeypatch.setenv(CAP_ENV, str(cap))
        return cap

    return _set


class TestEntryCap:
    """An over-cap entry is rejected with an actionable message."""

    async def test_over_cap_names_actual_size_cap_and_env_var(
        self, server: FastMCP, module, cap_env
    ) -> None:
        cap = cap_env(200)
        value = "x" * 500
        actual = module._entry_size_bytes(value, "default", "big", "{}")

        data = _payload(
            await server.call_tool("memory_store", {"value": value, "key": "big"})
        )

        error = data["error"]
        assert error.startswith("memory_store: ")
        assert f"{actual:,} UTF-8 bytes" in error
        assert f"{cap:,} bytes" in error
        assert f"{CAP_ENV}={actual:,}" in error
        assert "rejected, never truncated" in error

    async def test_over_cap_entry_is_not_stored_or_truncated(
        self, server: FastMCP, module, cap_env
    ) -> None:
        cap_env(200)
        value = "oversized-" * 50

        await server.call_tool("memory_store", {"value": value, "key": "big"})

        assert (
            _payload(await server.call_tool("memory_stats", {}))["total_entries"] == 0
        )
        assert _payload(await server.call_tool("memory_recall", {"key": "big"})) is None

    async def test_exactly_at_cap_is_accepted(
        self, server: FastMCP, module, cap_env
    ) -> None:
        namespace, key, metadata = "default", "edge", "{}"
        overhead = module._entry_size_bytes("", namespace, key, metadata)
        cap = cap_env(overhead + 100)
        value = "y" * 100
        assert module._entry_size_bytes(value, namespace, key, metadata) == cap

        data = _payload(
            await server.call_tool("memory_store", {"value": value, "key": key})
        )

        assert data["status"] == "stored"
        recalled = _payload(await server.call_tool("memory_recall", {"key": key}))
        assert recalled["value"] == value

    async def test_default_cap_matches_persistence_checkpoint_bound(
        self, server: FastMCP, module
    ) -> None:
        stats = _payload(await server.call_tool("memory_stats", {}))
        assert stats["max_entry_bytes"] == module.DEFAULT_MAX_ENTRY_BYTES
        assert stats["max_entry_bytes"] == 64 * ONE_KIB

    def test_invalid_override_falls_back_to_default(self, module, monkeypatch):
        monkeypatch.setenv(CAP_ENV, "not-a-number")
        assert module._max_entry_bytes() == module.DEFAULT_MAX_ENTRY_BYTES
        monkeypatch.setenv(CAP_ENV, "0")
        assert module._max_entry_bytes() == module.DEFAULT_MAX_ENTRY_BYTES

    async def test_invalid_ttl_is_reported_without_storing(
        self, server: FastMCP
    ) -> None:
        data = _payload(
            await server.call_tool(
                "memory_store", {"value": "ephemeral", "ttl_seconds": 0}
            )
        )
        assert "ttl_seconds must be between 1 and" in data["error"]
        assert (
            _payload(await server.call_tool("memory_stats", {}))["total_entries"] == 0
        )


class TestStatsAccounting:
    """memory_stats surfaces payload size so an operator can act on it."""

    async def test_size_numbers_and_largest_entries(
        self, server: FastMCP, module, cap_env
    ) -> None:
        cap = cap_env(400)
        small_value = "small memory entry"
        large_value = " ".join(["large memory entry"] * 6)
        await server.call_tool("memory_store", {"value": small_value, "key": "small"})
        await server.call_tool("memory_store", {"value": large_value, "key": "large"})

        stats = _payload(await server.call_tool("memory_stats", {}))

        expected_total = module._entry_size_bytes(
            small_value, "default", "small", "{}"
        ) + module._entry_size_bytes(large_value, "default", "large", "{}")
        assert stats["total_entries"] == TWO_ENTRIES
        assert stats["total_bytes"] == expected_total
        assert stats["max_entry_bytes"] == cap
        assert stats["warning_threshold_bytes"] == cap // 2
        assert stats["oversized_entries"] == 0
        assert stats["largest_entries"][0] == {
            "namespace": "default",
            "key": "large",
            "bytes": module._entry_size_bytes(large_value, "default", "large", "{}"),
        }
        assert [e["key"] for e in stats["largest_entries"]] == ["large", "small"]

    async def test_entries_over_warning_threshold_are_counted(
        self, server: FastMCP, module, cap_env
    ) -> None:
        cap_env(400)
        # Warning threshold is half the cap (200 bytes); this entry is between
        # the threshold and the cap, so it is accepted but flagged.
        await server.call_tool("memory_store", {"value": "z" * 250, "key": "warn"})

        stats = _payload(await server.call_tool("memory_stats", {}))

        assert stats["oversized_entries"] == ONE_ENTRY
        assert (
            stats["warning_threshold_bytes"]
            < stats["total_bytes"]
            < stats["max_entry_bytes"]
        )

    async def test_existing_fields_are_stable(self, server: FastMCP) -> None:
        stats = _payload(await server.call_tool("memory_stats", {}))
        for field in ("status", "total_entries", "namespaces", "db_size_bytes"):
            assert field in stats
        assert stats["status"] == "ok"


class TestExpiry:
    """Expiry hides an entry from search; removal stays explicit."""

    async def _store_expired(self, server: FastMCP, module, key: str) -> None:
        stored = _payload(
            await server.call_tool(
                "memory_store",
                {
                    "value": f"expiring release checklist {key}",
                    "key": key,
                    "ttl_seconds": 3600,
                },
            )
        )
        assert stored["expires_at"] is not None
        module._get_conn().execute(
            "UPDATE memories SET expires_at = ? WHERE id = ?",
            ["2000-01-01T00:00:00Z", stored["id"]],
        )
        module._get_conn().commit()

    async def test_expired_entry_is_excluded_from_search(
        self, server: FastMCP, module
    ) -> None:
        await self._store_expired(server, module, "gone")

        keys = [
            r["key"]
            for r in _list_payload(
                await server.call_tool("memory_search", {"query": "release checklist"})
            )
        ]
        assert "gone" not in keys

    async def test_expired_entry_is_returned_by_exact_recall(
        self, server: FastMCP, module
    ) -> None:
        await self._store_expired(server, module, "gone")

        recalled = _payload(await server.call_tool("memory_recall", {"key": "gone"}))
        assert recalled["key"] == "gone"
        assert recalled["expires_at"] == "2000-01-01T00:00:00Z"

    async def test_search_can_include_expired_explicitly(
        self, server: FastMCP, module
    ) -> None:
        await self._store_expired(server, module, "gone")

        keys = [
            r["key"]
            for r in _list_payload(
                await server.call_tool(
                    "memory_search",
                    {"query": "release checklist", "include_expired": True},
                )
            )
        ]
        assert keys == ["gone"]

    async def test_reads_do_not_delete_expired_rows(
        self, server: FastMCP, module
    ) -> None:
        await self._store_expired(server, module, "gone")

        await server.call_tool("memory_search", {"query": "release checklist"})
        await server.call_tool("memory_recall", {"key": "gone"})

        assert (
            _payload(await server.call_tool("memory_stats", {}))["total_entries"]
            == ONE_ENTRY
        )

    async def test_purge_removes_only_expired_entries(
        self, server: FastMCP, module
    ) -> None:
        await self._store_expired(server, module, "gone")
        await server.call_tool(
            "memory_store", {"value": "keeps release checklist", "key": "kept"}
        )

        purged = _payload(
            await server.call_tool("memory_forget", {"expired_only": True})
        )

        assert purged == {"deleted": True, "purged": 1, "expired_only": True}
        assert (
            _payload(await server.call_tool("memory_recall", {"key": "kept"}))["key"]
            == "kept"
        )
        gone = _payload(await server.call_tool("memory_recall", {"key": "gone"}))
        assert gone is None

    async def test_purge_is_idempotent(self, server: FastMCP, module) -> None:
        await self._store_expired(server, module, "gone")

        await server.call_tool("memory_forget", {"expired_only": True})
        second = _payload(
            await server.call_tool("memory_forget", {"expired_only": True})
        )

        assert second == {"deleted": False, "purged": 0, "expired_only": True}

    async def test_purge_rejects_being_combined_with_a_target(
        self, server: FastMCP
    ) -> None:
        data = _payload(
            await server.call_tool(
                "memory_forget", {"expired_only": True, "key": "anything"}
            )
        )
        assert "cannot be combined" in data["error"]

    async def test_entry_without_ttl_never_expires(
        self, server: FastMCP, module
    ) -> None:
        stored = _payload(
            await server.call_tool(
                "memory_store", {"value": "durable release checklist", "key": "keep"}
            )
        )
        assert stored["expires_at"] is None

        keys = [
            r["key"]
            for r in _list_payload(
                await server.call_tool(
                    "memory_search", {"query": "durable release checklist"}
                )
            )
        ]
        assert keys == ["keep"]


class TestLegacyDatabase:
    """A pre-TTL database opens without a migration step from the user."""

    def _make_old_db(self, directory: Path) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        db_path = directory / "memory.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(OLD_SCHEMA_SQL)
        conn.execute(
            "INSERT INTO memories (namespace, key, value) VALUES (?, ?, ?)",
            ["legacy", "old-key", "legacy release checklist entry"],
        )
        conn.commit()
        conn.close()
        return db_path

    def test_old_schema_is_migrated_in_place(self, tmp_path: Path, module) -> None:
        db_path = self._make_old_db(tmp_path / "memory")
        module._set_memory_dir(str(tmp_path / "memory"))
        module._reset_test_state()

        conn = module._get_conn()

        columns = {row[1] for row in conn.execute("PRAGMA table_info(memories)")}
        assert "expires_at" in columns
        row = conn.execute(
            "SELECT value, expires_at FROM memories WHERE key = 'old-key'"
        ).fetchone()
        assert row["value"] == "legacy release checklist entry"
        assert row["expires_at"] is None
        assert db_path.exists()

    def test_second_open_is_a_no_op(self, tmp_path: Path, module) -> None:
        self._make_old_db(tmp_path / "memory")
        module._set_memory_dir(str(tmp_path / "memory"))
        module._reset_test_state()
        module._get_conn()

        module._reset_test_state()
        conn = module._get_conn()

        assert module._ensure_entry_lifecycle_schema(conn) is False

    async def test_legacy_rows_stay_searchable(self, tmp_path: Path, module) -> None:
        self._make_old_db(tmp_path / "memory")
        module._set_memory_dir(str(tmp_path / "memory"))
        module._reset_test_state()
        server = module.mcp

        keys = [
            r["key"]
            for r in _list_payload(
                await server.call_tool(
                    "memory_search", {"query": "legacy release checklist"}
                )
            )
        ]

        assert keys == ["old-key"]
        stats = _payload(await server.call_tool("memory_stats", {}))
        assert stats["total_entries"] == ONE_ENTRY
        assert stats["largest_entries"][0]["key"] == "old-key"
