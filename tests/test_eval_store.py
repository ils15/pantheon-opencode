"""Tests for eval_store.py — plugin_eval memory namespace helper.

RED → GREEN → REFACTOR. Covers the write path (store_eval) and the
read path (list_evals / get_latest_eval) used by the resources server.

Namespace: plugin_eval
Key format: eval:<name>:<date>
Metadata:   {"type": "eval", "score": N}
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

MODULE_PATH = "src.mcp.eval_store"


@pytest.fixture
def module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Import eval_store with the DB pointed at a temp dir."""
    mod = importlib.import_module(MODULE_PATH)
    db_path = tmp_path / "memory" / "memory.db"
    monkeypatch.setattr(mod, "_db_path", lambda: db_path)
    return mod


class TestStoreEval:
    def test_stores_entry_with_namespace_and_key(self, module) -> None:
        """store_eval writes to the plugin_eval namespace with eval:<name>:<date> key."""
        report = {"name": "my-skill", "score": 90, "checks": {}}
        result = module.store_eval("my-skill", report, 90)
        assert result["status"] == "stored"
        assert result["namespace"] == "plugin_eval"
        assert result["key"].startswith("eval:my-skill:")

    def test_metadata_has_type_and_score(self, module) -> None:
        """Metadata JSON carries type=eval and the numeric score."""
        module.store_eval("my-skill", {"score": 75}, 75)
        entries = module.list_evals()
        assert len(entries) == 1
        md = entries[0]["metadata"]
        assert md["type"] == "eval"
        assert md["score"] == 75

    def test_value_is_report_json(self, module) -> None:
        """The stored value is the JSON-serialized report."""
        report = {"name": "my-skill", "score": 88, "checks": {"yaml": {"pass": True}}}
        module.store_eval("my-skill", report, 88)
        entries = module.list_evals()
        assert json.loads(entries[0]["value"]) == report

    def test_duplicate_key_returns_error(self, module) -> None:
        """Storing the same name+date twice returns an error (unique ns+key)."""
        module.store_eval("my-skill", {"score": 90}, 90)
        result = module.store_eval("my-skill", {"score": 91}, 91)
        assert "error" in result

    def test_custom_date_key(self, module) -> None:
        """An explicit date is used in the key."""
        result = module.store_eval("my-skill", {"score": 90}, 90, when="2026-01-01")
        assert result["key"] == "eval:my-skill:2026-01-01"


class TestListEvals:
    def test_empty_namespace(self, module) -> None:
        """list_evals on an empty namespace returns []."""
        assert module.list_evals() == []

    def test_newest_first(self, module) -> None:
        """Entries are returned newest first."""
        module.store_eval("a", {"score": 1}, 1, when="2026-01-01")
        module.store_eval("b", {"score": 2}, 2, when="2026-01-02")
        entries = module.list_evals()
        assert [e["key"] for e in entries] == [
            "eval:b:2026-01-02",
            "eval:a:2026-01-01",
        ]

    def test_latest_per_plugin(self, module) -> None:
        """list_evals returns only the latest entry per plugin name."""
        module.store_eval("my-skill", {"score": 80}, 80, when="2026-01-01")
        module.store_eval("my-skill", {"score": 95}, 95, when="2026-01-02")
        module.store_eval("other", {"score": 70}, 70, when="2026-01-01")
        entries = module.list_evals()
        names = [e["name"] for e in entries]
        assert names == ["my-skill", "other"]
        by_name = {e["name"]: e for e in entries}
        assert by_name["my-skill"]["metadata"]["score"] == 95


class TestGetLatestEval:
    def test_returns_latest_for_name(self, module) -> None:
        """get_latest_eval returns the newest entry for a plugin."""
        module.store_eval("my-skill", {"score": 80}, 80, when="2026-01-01")
        module.store_eval("my-skill", {"score": 95}, 95, when="2026-01-02")
        entry = module.get_latest_eval("my-skill")
        assert entry is not None
        assert entry["metadata"]["score"] == 95

    def test_missing_name_returns_none(self, module) -> None:
        """get_latest_eval for an unknown plugin returns None."""
        assert module.get_latest_eval("ghost") is None

    def test_other_namespaces_ignored(self, module) -> None:
        """Entries outside plugin_eval are not returned."""
        module.store_eval("my-skill", {"score": 90}, 90)
        # Simulate a foreign namespace entry via raw SQL
        import sqlite3

        conn = sqlite3.connect(str(module._db_path()))
        conn.execute(
            "INSERT INTO memories (namespace, key, value, metadata, created_at, updated_at)"
            " VALUES ('council_decisions', 'council:x', '{}', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        )
        conn.commit()
        conn.close()
        assert module.get_latest_eval("x") is None
        assert len(module.list_evals()) == 1
