"""Tests for the Pantheon Persistence MCP Server (src/mcp/mcp_persistence.py).

Tests cover the server name/instructions, the exact exposed six-tool set,
session checkpoint save/get behavior, and manual goal operations.

Checkpoint expiry, stale-revision handling, and session scoping are
correctness-critical for saved operational state.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.exceptions import ValidationError as FastMCPValidationError
from pydantic import ValidationError as PydanticValidationError

from tests.conftest import _json, _tool_input_schema, _tool_text

# Module path — canonical source lives in src/mcp/
MODULE_PATH = "src.mcp.mcp_persistence"
MCP_VALIDATION_ERRORS = (
    ToolError,
    FastMCPValidationError,
    PydanticValidationError,
)


def _text_from_tool(result: Any) -> str:
    """Extract text from FastMCP call_tool result.

    FastMCP returns a plain list of ContentBlocks for async tools and a
    ``(content_blocks, structured)`` tuple for sync tools with an output
    schema — handle both shapes.
    """
    return _tool_text(result)


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
        """Instructions should describe only the currently exposed tools."""
        assert server.instructions == (
            "Operational-state checkpoints through context_save/context_get and "
            "four manual session-scoped goal tools. Goal tools use OpenCode "
            "session metadata and do not trigger automatic continuation."
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
        expected = {
            "context_save",
            "context_get",
            "goal_create",
            "goal_get",
            "goal_update",
            "goal_done",
        }
        assert len(names) == len(expected)
        assert set(names) == expected

    async def test_tools_have_descriptions(self, server: FastMCP) -> None:
        """All tools should have meaningful descriptions."""
        tools = await server.list_tools()
        for t in tools:
            assert t.description and len(t.description) > 0


# =============================================================================
# Internal TTL validation for context checkpoint storage.


class TestTTLValidation:
    @pytest.mark.parametrize("ttl", [True, "1"])
    async def test_ttl_validator_rejects_non_integer_values(
        self, module: Any, ttl: object
    ) -> None:
        """The shared TTL validator rejects bools and strings explicitly."""
        with pytest.raises(ValueError, match="ttl"):
            module._validate_ttl(ttl)


# =============================================================================
# Context checkpoints
# =============================================================================


class TestContextCheckpoints:
    """Tests for the retained context_save/context_get tools."""

    async def test_context_save_get_roundtrip(self, server: FastMCP) -> None:
        """Save a checkpoint and read it back with the returned session_id."""
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "my-task",
                    "key": "phase:1",
                    "content": '{"a": 1}',
                    "session_id": "roundtrip-session",
                },
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
                "context_save",
                {
                    "slug": "s",
                    "key": "phase:2",
                    "content": "second",
                    "session_id": "latest-session",
                },
            )
        )
        sid = saved["session_id"]
        await server.call_tool(
            "context_save",
            {"slug": "s", "key": "phase:3", "content": "third", "session_id": sid},
        )
        latest = _json(
            await server.call_tool(
                "context_get", {"slug": "s", "key": "latest", "session_id": sid}
            )
        )
        assert latest == "third"

    async def test_session_id_is_required_for_context_save(
        self, server: FastMCP
    ) -> None:
        """Missing or blank IDs fail closed instead of creating a UUID namespace."""
        with pytest.raises(MCP_VALIDATION_ERRORS, match="session_id"):
            await server.call_tool(
                "context_save",
                {"slug": "required", "key": "phase:1", "content": "{}"},
            )
        with pytest.raises(MCP_VALIDATION_ERRORS, match="session_id"):
            await server.call_tool(
                "context_save",
                {
                    "slug": "required",
                    "key": "phase:1",
                    "content": "{}",
                    "session_id": " ",
                },
            )

    async def test_legacy_unqualified_read_requires_explicit_opt_in(
        self, server: FastMCP, module: Any
    ) -> None:
        """Legacy namespace reads never become an autonomy recovery fallback."""
        module._db("project").execute(
            "INSERT INTO kv_store (namespace, key, value) VALUES (?, ?, ?)",
            ("checkpoint:legacy-read", "latest", "legacy-value"),
        )
        assert (
            _json(await server.call_tool("context_get", {"slug": "legacy-read"}))
            is None
        )
        assert (
            _json(
                await server.call_tool(
                    "context_get", {"slug": "legacy-read", "legacy": True}
                )
            )
            == "legacy-value"
        )

    @pytest.mark.parametrize(
        ("slug", "key", "session_id"),
        [
            ("bad\nslug", "phase:1", "lookup-session"),
            ("lookup", "bad\nkey", "lookup-session"),
            ("lookup", "phase:1", " "),
        ],
    )
    async def test_context_get_invalid_identifiers_fail_closed(
        self,
        server: FastMCP,
        slug: str,
        key: str,
        session_id: str,
    ) -> None:
        """Invalid namespace components cannot return a stored checkpoint."""
        result = await server.call_tool(
            "context_get",
            {"slug": slug, "key": key, "session_id": session_id},
        )

        assert _json(result) is None

    async def test_context_sessions_and_scopes_are_isolated(
        self, server: FastMCP
    ) -> None:
        """Neither a wrong session nor a wrong database scope can recover data."""
        payload = '{"goal":{"objective":"project-only","status":"in_progress"}}'
        await server.call_tool(
            "context_save",
            {
                "slug": "scope-isolation",
                "key": "phase:1",
                "content": payload,
                "session_id": "project-session",
                "scope": "project",
            },
        )
        await server.call_tool(
            "context_save",
            {
                "slug": "scope-isolation",
                "key": "phase:1",
                "content": (
                    '{"goal":{"objective":"global-only","status":"in_progress"}}'
                ),
                "session_id": "global-session",
                "scope": "global",
            },
        )

        assert (
            _json(
                await server.call_tool(
                    "context_get",
                    {
                        "slug": "scope-isolation",
                        "session_id": "global-session",
                        "scope": "project",
                    },
                )
            )
            is None
        )
        assert (
            _json(
                await server.call_tool(
                    "context_get",
                    {
                        "slug": "scope-isolation",
                        "session_id": "project-session",
                        "scope": "global",
                    },
                )
            )
            is None
        )

    @pytest.mark.parametrize("ttl", [-1, 0, 1.5])
    async def test_context_save_rejects_invalid_ttl_types_and_minimum(
        self, server: FastMCP, ttl: object
    ) -> None:
        """context_save must reject non-positive and non-integer TTL values."""
        with pytest.raises(MCP_VALIDATION_ERRORS, match="ttl"):
            await server.call_tool(
                "context_save",
                {
                    "slug": "ttl",
                    "key": "phase:1",
                    "content": "{}",
                    "session_id": "ttl-session",
                    "ttl": ttl,
                },
            )

    async def test_context_save_rejects_ttl_above_maximum(
        self, server: FastMCP, module: Any
    ) -> None:
        """context_save must reject TTL values above the configured maximum."""
        with pytest.raises(ToolError, match="ttl"):
            await server.call_tool(
                "context_save",
                {
                    "slug": "ttl",
                    "key": "phase:1",
                    "content": "{}",
                    "session_id": "ttl-session",
                    "ttl": module.MAX_TTL + 1,
                },
            )

    async def test_context_save_is_atomic_for_checkpoint_and_latest(
        self, server: FastMCP, module: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A failed pointer write must not leave a phase without its pointer."""
        original = module._upsert_context_entry
        calls = 0

        def fail_pointer(*args: Any, **kwargs: Any) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise sqlite3.OperationalError("simulated pointer failure")
            original(*args, **kwargs)

        monkeypatch.setattr(module, "_upsert_context_entry", fail_pointer)
        with pytest.raises(ToolError, match="pointer failure"):
            await server.call_tool(
                "context_save",
                {
                    "slug": "atomic",
                    "key": "phase:1",
                    "content": '{"goal":{"objective":"atomic","status":"in_progress"}}',
                    "session_id": "atomic-session",
                },
            )

        assert (
            module._db("project")
            .execute(
                "SELECT COUNT(*) FROM kv_store WHERE "
                "namespace LIKE 'checkpoint:atomic:%'"
            )
            .fetchone()[0]
            == 0
        )

    async def test_context_save_rejects_stale_revision(self, server: FastMCP) -> None:
        """A caller with an older revision cannot overwrite a newer checkpoint."""
        first = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "revision",
                    "key": "phase:1",
                    "content": "new",
                    "session_id": "revision-session",
                    "revision": 20,
                },
            )
        )
        stale = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "revision",
                    "key": "phase:1",
                    "content": "old",
                    "session_id": "revision-session",
                    "revision": 19,
                },
            )
        )
        latest = _json(
            await server.call_tool(
                "context_get", {"slug": "revision", "session_id": "revision-session"}
            )
        )

        assert first["revision"] == 20
        assert stale["status"] == "stale"
        assert latest == "new"

    @pytest.mark.parametrize(
        "version",
        [1, 1.0, "1", "1.5.0-beta.2"],
        ids=["int", "json-float", "numeric-str", "semver-str"],
    )
    async def test_context_save_accepts_forward_compatible_version_metadata(
        self, server: FastMCP, version: object
    ) -> None:
        """Checkpoint ``version`` is opaque metadata; non-int labels must not fail.

        Regression: the shape validator required ``version`` to be a positive
        ``int``, so a valid checkpoint carrying a JSON float (``1.0``) or a
        semver string (``1.5.0-beta.2``) raised
        ``Error executing tool context_save: version must be a positive integer``.
        """
        payload = json.dumps(
            {
                "version": version,
                "goal": {"objective": "forward compatible", "status": "in_progress"},
                "phase": {"current": 1, "total": 2, "name": "beta"},
            }
        )
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "version-metadata",
                    "key": "phase:1",
                    "content": payload,
                    "session_id": "version-session",
                },
            )
        )
        assert saved["status"] == "stored"
        stored = _json(
            await server.call_tool(
                "context_get",
                {
                    "slug": "version-metadata",
                    "key": "phase:1",
                    "session_id": "version-session",
                },
            )
        )
        assert stored == payload

    async def test_context_save_accepts_checkpoint_without_version(
        self, server: FastMCP
    ) -> None:
        """A valid checkpoint that omits ``version`` must be stored verbatim."""
        payload = json.dumps(
            {
                "goal": {"objective": "no version", "status": "in_progress"},
                "phase": {"current": 1, "total": 1, "name": "solo"},
            }
        )
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "no-version",
                    "key": "phase:1",
                    "content": payload,
                    "session_id": "no-version-session",
                },
            )
        )
        assert saved["status"] == "stored"
        assert saved["revision"] >= 1

        stored = _json(
            await server.call_tool(
                "context_get",
                {
                    "slug": "no-version",
                    "key": "phase:1",
                    "session_id": "no-version-session",
                },
            )
        )
        assert stored == payload

    async def test_context_save_without_revision_autoincrements_and_uses_key_ttl(
        self, server: FastMCP
    ) -> None:
        """Omitted revision auto-increments per slug+key and TTL follows the key."""
        base = {
            "slug": "auto-revision",
            "key": "phase:1",
            "session_id": "auto-session",
        }
        first = _json(
            await server.call_tool("context_save", {**base, "content": "first"})
        )
        second = _json(
            await server.call_tool("context_save", {**base, "content": "second"})
        )
        heartbeat = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "auto-revision",
                    "key": "heartbeat",
                    "content": json.dumps({"status": "alive", "turn_count": 1}),
                    "session_id": "auto-session",
                },
            )
        )

        assert first["revision"] >= 1
        assert second["revision"] > first["revision"]
        assert first["ttl"] == 14400
        assert second["ttl"] == 14400
        assert heartbeat["ttl"] == 300

    async def test_context_saves_concurrent_same_session_keep_complete_latest(
        self, server: FastMCP
    ) -> None:
        """Concurrent writes are serialized and latest is one complete payload."""
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "concurrent",
                    "key": "seed",
                    "content": "seed",
                    "session_id": "concurrent-session",
                },
            )
        )
        sid = saved["session_id"]
        payloads = [
            json.dumps(
                {
                    "goal": {"objective": f"goal-{index}", "status": "in_progress"},
                    "phase": {"current": index},
                }
            )
            for index in range(3)
        ]

        await asyncio.gather(
            *(
                server.call_tool(
                    "context_save",
                    {
                        "slug": "concurrent",
                        "key": f"phase:{index}",
                        "content": payload,
                        "session_id": sid,
                    },
                )
                for index, payload in enumerate(payloads)
            )
        )

        latest = _json(
            await server.call_tool(
                "context_get", {"slug": "concurrent", "session_id": sid}
            )
        )
        assert latest in payloads

    async def test_context_saves_from_threads_are_serialized(
        self, server: FastMCP
    ) -> None:
        """Independent event loops can write without exposing partial latest data."""
        sid = "thread-session"

        def save(index: int) -> Any:
            return asyncio.run(
                server.call_tool(
                    "context_save",
                    {
                        "slug": "threaded",
                        "key": f"phase:{index}",
                        "content": json.dumps(
                            {
                                "goal": {
                                    "objective": f"thread-{index}",
                                    "status": "in_progress",
                                }
                            }
                        ),
                        "session_id": sid,
                    },
                )
            )

        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(save, range(4)))
        assert all(_json(result)["status"] == "stored" for result in results)
        latest = _json(
            await server.call_tool(
                "context_get", {"slug": "threaded", "session_id": sid}
            )
        )
        assert json.loads(latest)["goal"]["objective"].startswith("thread-")

    async def test_context_ttl_expiry(self, server: FastMCP, module) -> None:
        """An expired checkpoint must be unreachable (crash-recovery path)."""
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "s",
                    "key": "phase:1",
                    "content": "x",
                    "session_id": "ttl-session",
                },
            )
        )
        sid = saved["session_id"]
        ns = saved["namespace"]
        conn = module._db("project")
        conn.execute(
            "UPDATE kv_store SET expires_at = '2000-01-01T00:00:00+00:00' "
            "WHERE namespace = ?",
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
            "context_save",
            {
                "slug": "s",
                "key": "phase:1",
                "content": "x",
                "session_id": "isolation-session",
            },
        )
        result = await server.call_tool(
            "context_get",
            {"slug": "s", "key": "phase:1", "session_id": "other_session"},
        )
        assert _json(result) is None
        # Without session_id, the unscoped namespace has nothing
        result2 = await server.call_tool("context_get", {"slug": "s", "key": "phase:1"})
        assert _json(result2) is None


# =============================================================================
# Validation Reporting
# =============================================================================
# Regression cover for the fail-fast defect: validation stopped at the FIRST
# invalid field, so a caller discovered ``goal`` and ``phase`` in two
# consecutive failed calls. One call must now name every invalid field, with
# the argument path, the received type, and a minimal example.


# The two payloads from the reproduced session, verbatim.
REPRO_ATTEMPT_1 = json.dumps(
    {
        "goal": "Complete proposed frontend contrast/accessibility waves, ...",
        "phase": "finish-contrast-wave",
        "pending": ["a", "b"],
        "branch": "fix/remaining-contrast-failures",
        "agent": "aphrodite",
    }
)
REPRO_ATTEMPT_2 = json.dumps(
    {
        "goal": {"title": "...", "scope": "..."},
        "phase": 1,
        "turn_count": 1,
        "agent": "aphrodite",
        "summary": "...",
        "pending": ["a"],
        "branch": "fix/remaining-contrast-failures",
    }
)
REPRO_VALID = json.dumps(
    {
        "goal": {"objective": "ship contrast waves", "status": "active"},
        "phase": {"current": 1, "total": 3, "name": "contrast"},
        "turn_count": 1,
        "agent": "aphrodite",
    }
)


class TestValidationReporting:
    """Every invalid argument is reported in one call, with path and type."""

    async def _save(self, server: FastMCP, content: str, **overrides) -> str:
        """Call context_save expecting failure; return the error text."""
        args = {
            "slug": "validation",
            "key": "phase:1",
            "content": content,
            "session_id": "validation-session",
            **overrides,
        }
        with pytest.raises(ToolError) as excinfo:
            await server.call_tool("context_save", args)
        return str(excinfo.value)

    async def test_repro_attempt_1_reports_goal_and_phase_together(
        self, server: FastMCP
    ) -> None:
        """Attempt 1 (both sections as strings) must name both in one message."""
        message = await self._save(server, REPRO_ATTEMPT_1)

        assert "content.goal must be an object (got string)" in message
        assert "content.phase must be an object (got string)" in message
        # Both violations counted, not just the first.
        assert "2 invalid arguments" in message
        # One example block, minimal and correct for each reported field.
        assert "example:" in message
        assert message.count("example:") == 1
        assert 'content.goal={"objective"' in message
        assert 'content.phase={"current":1' in message

    async def test_repro_attempt_2_reports_only_phase_with_number(
        self, server: FastMCP
    ) -> None:
        """Attempt 2 (phase as the number 1) names phase only, got number."""
        message = await self._save(server, REPRO_ATTEMPT_2)

        assert "content.phase must be an object (got number)" in message
        # goal was a valid object: it must NOT be reported.
        assert "content.goal" not in message
        # No count header for a single violation, but the example still ships.
        assert "invalid arguments" not in message
        assert 'content.phase={"current":1' in message

    async def test_historical_message_substrings_survive(self, server: FastMCP) -> None:
        """Existing consumers matching the old wording must still match."""
        assert "goal must be an object" in await self._save(server, REPRO_ATTEMPT_1)
        assert "phase must be an object" in await self._save(server, REPRO_ATTEMPT_1)
        assert "ttl must be between 1 and 31536000 seconds" in await self._save(
            server, REPRO_ATTEMPT_1, ttl=0
        )

    async def test_repro_valid_payload_saves_and_reads_back(
        self, server: FastMCP
    ) -> None:
        """Proper objects save, and context_get returns the stored content."""
        result = await server.call_tool(
            "context_save",
            {
                "slug": "validation",
                "key": "phase:1",
                "content": REPRO_VALID,
                "session_id": "validation-session",
            },
        )
        assert _json(result)["status"] == "stored"

        stored = _json(
            await server.call_tool(
                "context_get",
                {
                    "slug": "validation",
                    "key": "phase:1",
                    "session_id": "validation-session",
                },
            )
        )
        assert json.loads(stored) == json.loads(REPRO_VALID)

    async def test_absent_goal_and_phase_are_accepted_not_reported(
        self, server: FastMCP
    ) -> None:
        """Absent sections are legal, not errors.

        ``goal``/``phase`` are OPTIONAL: the documented heartbeat checkpoint is
        ``{"status": "alive", "last_action": ..., "turn_count": N}`` with
        neither section (src/instructions/zeus-anti-stall.instructions.md).
        Requiring them would break that pattern and would make the read path
        fail closed on already-stored checkpoints, so absence is accepted and
        the wording stays reserved for present-but-wrongly-typed values.
        """
        without_goal = json.dumps(
            {"phase": {"current": 1}, "turn_count": 1, "summary": "..."}
        )
        without_phase = json.dumps(
            {"goal": {"objective": "..."}, "turn_count": 1, "summary": "..."}
        )
        for index, content in enumerate((without_goal, without_phase)):
            result = await server.call_tool(
                "context_save",
                {
                    "slug": "validation",
                    "key": f"optional:{index}",
                    "content": content,
                    "session_id": "validation-session",
                },
            )
            assert _json(result)["status"] == "stored", content

    async def test_required_wording_differs_from_object_wording(
        self, server: FastMCP
    ) -> None:
        """An absent required argument never reads like a wrong-typed section."""
        message = await self._save(server, REPRO_VALID, session_id="   ")
        assert "session_id is required and must be non-empty" in message
        # 'required' is distinct vocabulary from the object-shape complaint.
        assert "session_id must be an object" not in message

    async def test_all_argument_families_accumulate_in_one_call(
        self, server: FastMCP
    ) -> None:
        """content, ttl, revision, and scope violations all surface together."""
        message = await self._save(
            server,
            REPRO_ATTEMPT_1,
            ttl=0,
            revision=0,
            scope="bogus",
        )

        assert "content.goal must be an object (got string)" in message
        assert "content.phase must be an object (got string)" in message
        assert "ttl must be between 1 and 31536000 seconds (got 0)" in message
        assert "revision must be between 1 and" in message
        assert "scope must be 'global' or 'project'" in message
        # goal, phase, ttl, revision, scope.
        assert "5 invalid arguments" in message

    async def test_nested_violation_reports_the_full_path(
        self, server: FastMCP
    ) -> None:
        """A bad value inside a valid object is reported with its full path."""
        # 'x' * 5000 exceeds MAX_GOAL_OBJECTIVE_LENGTH (4096 bytes).
        content = json.dumps(
            {
                "goal": {"objective": "x" * 5000},
                "phase": {"current": -1},
            }
        )
        message = await self._save(server, content)

        assert "content.goal.objective exceeds its size limit" in message
        assert "content.phase.current must be a non-negative integer" in message
        assert "2 invalid arguments" in message

    async def test_tail_must_be_an_array(self, server: FastMCP) -> None:
        """A non-array tail is reported as an array violation, not a size one."""
        message = await self._save(server, json.dumps({"tail": "not-a-list"}))
        assert "content.tail must be an array (got string)" in message

    @pytest.mark.parametrize(
        ("in_flight", "message"),
        [
            ("not-an-array", "delegations.in_flight exceeds its size limit"),
            ([17], "delegations.in_flight entries must be objects"),
            (
                [{"alias": "x" * 257}],
                "content.delegations.in_flight.alias exceeds its size limit",
            ),
        ],
    )
    async def test_invalid_delegations_are_rejected_before_checkpoint_write(
        self, server: FastMCP, module: Any, in_flight: object, message: str
    ) -> None:
        """Malformed delegated-job metadata cannot enter saved checkpoints."""
        error = await self._save(
            server, json.dumps({"delegations": {"in_flight": in_flight}})
        )

        assert message in error
        row = (
            module._db("project")
            .execute(
                "SELECT 1 FROM kv_store WHERE namespace = ? AND key = ?",
                ("checkpoint:validation:validation-session", "phase:1"),
            )
            .fetchone()
        )
        assert row is None

    async def test_context_save_accepts_null_and_valid_delegation_queues(
        self, server: FastMCP
    ) -> None:
        """Optional/valid delegation metadata remains round-trippable."""
        queues = (
            None,
            [{"alias": "@hermes", "agent": "hermes", "task_id": "job-1"}],
        )
        for index, queue in enumerate(queues):
            content = json.dumps({"delegations": {"in_flight": queue}})
            saved = _json(
                await server.call_tool(
                    "context_save",
                    {
                        "slug": "delegation-roundtrip",
                        "key": f"phase:{index}",
                        "content": content,
                        "session_id": "delegation-session",
                    },
                )
            )
            assert saved["status"] == "stored"
            restored = await server.call_tool(
                "context_get",
                {
                    "slug": "delegation-roundtrip",
                    "key": f"phase:{index}",
                    "session_id": "delegation-session",
                },
            )
            assert _json(restored) == content

    async def test_context_save_content_byte_limit_is_actionable(
        self, server: FastMCP
    ) -> None:
        """The serialized-content limit accepts its boundary and explains overflow."""
        await server.call_tool(
            "context_save",
            {
                "slug": "validation",
                "key": "phase:1",
                "content": "x" * (64 * 1024),
                "session_id": "validation-session",
            },
        )

        message = await self._save(server, "x" * (64 * 1024 + 1))
        assert "content is 65,537 UTF-8 bytes; maximum is 65,536 bytes" in message
        assert "reduce content" in message.lower()
        assert "omit optional tail" in message

    async def test_tail_item_count_boundary_and_actionable_error(
        self, server: FastMCP
    ) -> None:
        """The 100-item boundary is accepted; the next item is named and bounded."""
        await server.call_tool(
            "context_save",
            {
                "slug": "validation",
                "key": "phase:1",
                "content": json.dumps({"tail": [""] * 100}),
                "session_id": "validation-session",
            },
        )

        message = await self._save(server, json.dumps({"tail": [""] * 101}))
        assert "content.tail has 101 items; maximum is 100" in message
        assert "remove tail entries or omit tail" in message

        separate_tail_message = await self._save(
            server, json.dumps([""] * 101), key="tail"
        )
        assert "content.tail has 101 items; maximum is 100" in separate_tail_message

    async def test_tail_line_byte_boundary_and_actionable_error(
        self, server: FastMCP
    ) -> None:
        """Each tail line accepts 4,096 UTF-8 bytes and rejects 4,097."""
        await server.call_tool(
            "context_save",
            {
                "slug": "validation",
                "key": "phase:1",
                "content": json.dumps({"tail": ["x" * 4096]}),
                "session_id": "validation-session",
            },
        )

        message = await self._save(server, json.dumps({"tail": ["x" * 4097]}))
        assert "content.tail entries are 4,097 UTF-8 bytes; maximum is 4,096" in message
        assert "remove or shorten tail entries, or omit tail" in message

        separate_tail_message = await self._save(
            server, json.dumps(["x" * 4097]), key="tail"
        )
        assert "content.tail entries are 4,097 UTF-8 bytes; maximum is 4,096" in (
            separate_tail_message
        )

    async def test_tail_line_utf8_limit_counts_multibyte_characters(
        self, server: FastMCP, module: Any
    ) -> None:
        """The 4,096-byte line limit measures UTF-8 bytes, not characters."""
        assert module.MAX_TAIL_LINE_LENGTH == 4096
        at_limit = "é" * 2048
        assert len(at_limit) == 2048
        assert len(at_limit.encode("utf-8")) == module.MAX_TAIL_LINE_LENGTH

        await server.call_tool(
            "context_save",
            {
                "slug": "validation",
                "key": "phase:utf8-boundary",
                "content": json.dumps({"tail": [at_limit]}),
                "session_id": "validation-session",
            },
        )

        over_limit = "é" * 2049
        assert len(over_limit) == 2049
        assert len(over_limit.encode("utf-8")) == 4098
        message = await self._save(server, json.dumps({"tail": [over_limit]}))
        assert "content.tail entries are 4,098 UTF-8 bytes; maximum is 4,096" in message
        assert "remove or shorten tail entries, or omit tail" in message

    async def test_tail_aggregate_byte_boundary(self, module) -> None:
        """Tail strings collectively accept 65,536 bytes and report exact overflow."""
        exact_limit = ["x" * 4096] * 16
        assert module._validate_tail(exact_limit) == exact_limit

        over_limit = [*exact_limit, "x"]
        with pytest.raises(ValueError) as excinfo:
            module._validate_tail(over_limit)
        message = str(excinfo.value)
        assert "tail contains 65,537 UTF-8 bytes across strings" in message
        assert "maximum is 65,536 bytes" in message
        assert "remove tail entries or omit tail" in message

    async def test_non_object_content_reports_received_type(
        self, server: FastMCP
    ) -> None:
        """A JSON array payload names the received type."""
        message = await self._save(server, json.dumps([1, 2, 3]))
        assert "structured context content must be a JSON object" in message
        assert "(got array)" in message
        # The path must not stutter against the message's own wording.
        assert "content structured content" not in message

    async def test_context_save_description_documents_section_shapes(
        self, server: FastMCP
    ) -> None:
        """The tool's own description teaches the required shapes up front."""
        tools = {t.name: t for t in await server.list_tools()}
        description = tools["context_save"].description or ""
        assert "must each be JSON OBJECTS" in description
        assert "'tail' must be a JSON ARRAY" in description
        assert "65,536 UTF-8 bytes" in description
        assert "at most 100 strings" in description
        assert "each at most 4,096 UTF-8 bytes" in description
        assert "omit optional tail" in description
        # 'phase' is disambiguated in one clause without renaming the field.
        assert "NOT a phase counter" in description
        assert "All sections are optional" in description

    async def test_context_content_schema_carries_shapes(self, server: FastMCP) -> None:
        """The declared input schema states goal/phase must be objects."""
        tools = {t.name: t for t in await server.list_tools()}
        content_schema = _tool_input_schema(tools["context_save"])["properties"][
            "content"
        ]
        description = content_schema.get("description", "")

        assert "'phase', 'delegations' and 'heartbeat' must be objects" in description
        assert "'tail' must be an array" in description
        assert "65,536 UTF-8 bytes" in description
        assert "at most 100 strings" in description
        assert "each at most 4,096 UTF-8 bytes" in description
        assert "not a counter" in description
        # The declared JSON type stays a string: content is a JSON string.
        assert content_schema["type"] == "string"


# =============================================================================
# Isolation
# =============================================================================


# =============================================================================
# Revision column (Wave 1b)
# =============================================================================
# `updated_at` used to double as the context monotonic revision: the write
# stored str(revision) into a column whose declared default is
# datetime('now'), so one column carried two incompatible formats. The
# revision now lives in a dedicated nullable `revision` column and
# `updated_at` is always a datetime. Readers still resolve the legacy layout
# so existing rows keep their monotonicity — there is deliberately NO backfill.


class TestRevisionColumn:
    """Revision is stored in its own column; legacy rows still resolve."""

    def test_schema_declares_a_dedicated_revision_column(self, module) -> None:
        """CREATE_SQL must declare `revision` separately from `updated_at`."""
        assert "revision INTEGER" in module.CREATE_SQL
        assert "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" in (
            module.CREATE_SQL
        )

    async def test_write_stores_revision_and_datetime_updated_at(
        self, server: FastMCP, module
    ) -> None:
        """A context write must not put a bare integer in updated_at."""
        await server.call_tool(
            "context_save",
            {
                "slug": "revcol",
                "key": "phase:1",
                "content": '{"a": 1}',
                "session_id": "revcol-session",
            },
        )
        conn = module._db("project")
        row = conn.execute(
            "SELECT revision, updated_at FROM kv_store WHERE key = 'phase:1'"
        ).fetchone()
        assert row is not None
        # updated_at is a datetime again, never a revision integer.
        assert isinstance(row[1], str) and not row[1].isdigit()
        assert row[1][:4].isdigit() and "-" in row[1]
        # The revision is an integer in its own column.
        assert isinstance(row[0], int) and row[0] > 0

    def test_legacy_row_with_revision_in_updated_at_still_resolves(
        self, module
    ) -> None:
        """A pre-migration row keeps its revision via the legacy fallback.

        This is the reason there is no backfill: an old row has revision IS
        NULL and the revision in updated_at. If a reader only consulted the
        new column it would restart the counter and could reissue a revision
        an existing row already used.
        """
        legacy_revision = 1755787200000000000
        assert module._row_revision((None, str(legacy_revision))) == legacy_revision
        # New layout: dedicated column wins.
        assert module._row_revision((42, "2026-08-21 12:00:00")) == 42
        # Neither column usable.
        assert module._row_revision((None, "2026-08-21 12:00:00")) == 0
        assert module._row_revision(None) == 0

    async def test_monotonic_across_a_legacy_row(self, server: FastMCP, module) -> None:
        """A save after a legacy row must exceed that row's revision."""
        await server.call_tool(
            "context_save",
            {
                "slug": "mono",
                "key": "phase:1",
                "content": '{"a": 1}',
                "session_id": "mono-session",
            },
        )
        conn = module._db("project")
        # Back-date the row into the legacy layout: revision NULL, revision
        # living in updated_at.
        legacy_revision = 1755787200000000000
        conn.execute(
            "UPDATE kv_store SET updated_at = ?, revision = NULL WHERE key = 'phase:1'",
            (str(legacy_revision),),
        )
        conn.commit()
        assert (
            module._current_context_revision(
                conn, "checkpoint:mono:mono-session", "phase:1"
            )
            == legacy_revision
        )
        nxt = module._next_context_revision(
            conn, "checkpoint:mono:mono-session", "phase:1"
        )
        assert nxt > legacy_revision

    def test_migration_is_additive_and_not_destructive(self, module) -> None:
        """The column is added with ALTER TABLE; no row is rewritten."""
        assert "ALTER TABLE kv_store ADD COLUMN" in module._ADD_REVISION_SQL
        # No UPDATE against existing rows anywhere in the migration.
        assert "UPDATE" not in module._ADD_REVISION_SQL.upper()
