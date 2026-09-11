"""Tests for the post-compaction injector (WS2 PR #94).

RED phase: ``context_rehydrate`` / ``context_session_summary`` do not exist
yet on the persistence server, so every test here FAILS before the
implementation and PASSES after.

Scenario: a long session (active goal, in-flight delegations, current
phase, heartbeat, serialized tail) goes through a mocked native compaction
event. The injector must rehydrate the critical context deterministically
(no LLM, no generative embeddings) from ``latest`` + ``tail`` in the
``checkpoint:<slug>`` namespace, refresh the heartbeat TTL, and stay
idempotent (double rehydration never duplicates).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from mcp.server.fastmcp import FastMCP

from tests.conftest import _json

MODULE_PATH = "src.mcp.mcp_persistence_server"


def _long_session_checkpoint() -> str:
    """Critical context of a simulated long session (goal + flight + phase)."""
    return json.dumps(
        {
            "version": 1,
            "goal": {
                "id": "goal-1",
                "objective": "Implement delegate token compaction",
                "status": "in_progress",
            },
            "phase": {"current": 3, "total": 5, "name": "injector"},
            "delegations": {
                "in_flight": [
                    {"alias": "apo-1", "agent": "apollo", "task_id": "task-1"},
                    {"alias": "her-2", "agent": "hermes", "task_id": "task-2"},
                ]
            },
            "tail": [
                "phase:1 hermes auth router complete",
                "phase:2 demeter refresh_tokens migration complete",
            ],
            "heartbeat": {"status": "alive", "turn_count": 42},
        }
    )


async def _seed_long_session(
    server: FastMCP, slug: str = "delegate-token-compaction"
) -> str:
    """Seed heartbeat + phases + latest; return the isolated session_id."""
    sid = f"{slug}-session"
    await server.call_tool(
        "context_save",
        {
            "slug": slug,
            "key": "heartbeat",
            "content": '{"status": "alive"}',
            "session_id": sid,
        },
    )
    for key in ("phase:1", "phase:2", "phase:3"):
        await server.call_tool(
            "context_save",
            {"slug": slug, "key": key, "content": key, "session_id": sid},
        )
    await server.call_tool(
        "context_save",
        {
            "slug": slug,
            "key": "latest",
            "content": _long_session_checkpoint(),
            "session_id": sid,
        },
    )
    return sid


def _mock_native_compaction() -> None:
    """Mock the native compaction event: the live view is wiped.

    Checkpoints in ``checkpoint:<slug>`` survive (SQLite outlives the
    context window); only the in-memory transcript is gone. Nothing to do
    here besides marking the boundary — the injector must rebuild from
    ``latest`` + ``tail``.
    """


class TestPostCompactionInjector:
    """Long session survives compaction via deterministic rehydration."""

    async def test_long_session_preserved_via_rehydration(
        self, server: FastMCP
    ) -> None:
        slug = "delegate-token-compaction"
        sid = await _seed_long_session(server, slug)
        _mock_native_compaction()  # live context wiped; checkpoints survive

        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": slug, "session_id": sid}
            )
        )

        assert isinstance(blocks, list) and len(blocks) > 0
        joined = "\n".join(blocks)
        # Active goal survives (session-goal convention + state, no new MCP).
        assert "Implement delegate token compaction" in joined
        assert "<mission_context>" in joined
        # In-flight delegations survive.
        assert "apo-1" in joined and "her-2" in joined
        # Current phase survives.
        assert "phase" in joined.lower() and "3" in joined
        # Serialized tail survives.
        assert "phase:1" in joined

    async def test_rehydration_is_idempotent(self, server: FastMCP) -> None:
        sid = await _seed_long_session(server)
        _mock_native_compaction()

        first = _json(
            await server.call_tool(
                "context_rehydrate",
                {"slug": "delegate-token-compaction", "session_id": sid},
            )
        )
        count_before = len(
            _json(
                await server.call_tool(
                    "context_list",
                    {"slug": "delegate-token-compaction", "session_id": sid},
                )
            )
        )
        second = _json(
            await server.call_tool(
                "context_rehydrate",
                {"slug": "delegate-token-compaction", "session_id": sid},
            )
        )

        assert first == second, "double rehydration must not duplicate content"
        count_after = len(
            _json(
                await server.call_tool(
                    "context_list",
                    {"slug": "delegate-token-compaction", "session_id": sid},
                )
            )
        )
        assert count_after == count_before, "rehydration must not add checkpoint rows"

    async def test_rehydration_refreshes_heartbeat_ttl(
        self, server: FastMCP, module
    ) -> None:
        sid = await _seed_long_session(server)
        _mock_native_compaction()
        ns = f"checkpoint:delegate-token-compaction:{sid}"
        conn = module._db("project")
        before = conn.execute(
            "SELECT expires_at FROM kv_store WHERE namespace = ? AND key = 'heartbeat'",
            (ns,),
        ).fetchone()[0]

        await server.call_tool(
            "context_rehydrate",
            {"slug": "delegate-token-compaction", "session_id": sid},
        )

        after = conn.execute(
            "SELECT expires_at FROM kv_store WHERE namespace = ? AND key = 'heartbeat'",
            (ns,),
        ).fetchone()[0]
        assert after >= before, "heartbeat TTL must be refreshed, never shortened"

    async def test_expired_checkpoint_rehydrates_to_none(
        self, server: FastMCP, module
    ) -> None:
        sid = await _seed_long_session(server)
        ns = f"checkpoint:delegate-token-compaction:{sid}"
        conn = module._db("project")
        conn.execute(
            "UPDATE kv_store SET expires_at = '2000-01-01T00:00:00+00:00' "
            "WHERE namespace = ? AND key = 'latest'",
            (ns,),
        )
        conn.commit()
        _mock_native_compaction()

        blocks = _json(
            await server.call_tool(
                "context_rehydrate",
                {"slug": "delegate-token-compaction", "session_id": sid},
            )
        )
        assert blocks is None, "expired TTL must respect expiry (fail-closed read)"

    async def test_kill_switch_disables_injector(
        self, server: FastMCP, monkeypatch
    ) -> None:
        sid = await _seed_long_session(server)
        _mock_native_compaction()
        monkeypatch.setenv("PANTHEON_COMPACTION", "off")

        blocks = _json(
            await server.call_tool(
                "context_rehydrate",
                {"slug": "delegate-token-compaction", "session_id": sid},
            )
        )
        assert blocks is None, "PANTHEON_COMPACTION=off must disable the injector"

    async def test_done_goal_is_omitted(self, server: FastMCP) -> None:
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "done-goal",
                    "key": "heartbeat",
                    "content": "{}",
                    "session_id": "done-goal-session",
                },
            )
        )
        sid = saved["session_id"]
        payload = json.loads(_long_session_checkpoint())
        payload["goal"]["status"] = "done"
        await server.call_tool(
            "context_save",
            {
                "slug": "done-goal",
                "key": "latest",
                "content": json.dumps(payload),
                "session_id": sid,
            },
        )
        _mock_native_compaction()

        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "done-goal", "session_id": sid}
            )
        )
        assert blocks is not None
        assert "<mission_context>" not in "\n".join(blocks)


class TestSessionEndSummaryTier2:
    """Tier 2 fires automatically at session end (opt-out, no Themis gate)."""

    async def test_session_end_summary_without_approval(self, server: FastMCP) -> None:
        sid = await _seed_long_session(server)
        summary = _json(
            await server.call_tool(
                "context_session_summary",
                {"slug": "delegate-token-compaction", "session_id": sid},
            )
        )
        assert isinstance(summary, str) and len(summary) > 0
        assert "Implement delegate token compaction" in summary
        assert "phase:1" in summary  # tail compressed into the summary

    async def test_session_end_summary_opt_out(
        self, server: FastMCP, monkeypatch
    ) -> None:
        sid = await _seed_long_session(server)
        monkeypatch.setenv("PANTHEON_SESSION_END_SUMMARY", "off")
        summary = _json(
            await server.call_tool(
                "context_session_summary",
                {"slug": "delegate-token-compaction", "session_id": sid},
            )
        )
        assert summary is None, "opt-out must disable Tier 2 auto-summary"


class TestInjectorEdgeCases:
    """Defensive branches: corrupt payloads, tail-key fallback, no heartbeat."""

    async def test_unparsable_latest_rehydrates_to_none(self, server: FastMCP) -> None:
        sid = "corrupt-session"
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "corrupt",
                    "key": "heartbeat",
                    "content": "{}",
                    "session_id": sid,
                },
            )
        )
        assert saved["session_id"] == sid
        await server.call_tool(
            "context_save",
            {
                "slug": "corrupt",
                "key": "phase:1",
                "content": _long_session_checkpoint(),
                "session_id": sid,
            },
        )
        await server.call_tool(
            "context_save",
            {
                "slug": "corrupt",
                "key": "latest",
                "content": "not-json{{{",
                "session_id": sid,
            },
        )
        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "corrupt", "session_id": sid}
            )
        )
        assert blocks is None

    async def test_non_dict_latest_rehydrates_to_none(self, server: FastMCP) -> None:
        sid = "list-shape-session"
        await server.call_tool(
            "context_save",
            {
                "slug": "list-shape",
                "key": "heartbeat",
                "content": "{}",
                "session_id": sid,
            },
        )
        await server.call_tool(
            "kv_store",
            {
                "namespace": f"checkpoint:list-shape:{sid}",
                "key": "latest",
                "value": '["not", "a", "dict"]',
            },
        )
        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "list-shape", "session_id": sid}
            )
        )
        assert blocks is None

    async def test_tail_key_fallback_when_not_embedded(self, server: FastMCP) -> None:
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "tail-key",
                    "key": "heartbeat",
                    "content": "{}",
                    "session_id": "tail-key-session",
                },
            )
        )
        sid = saved["session_id"]
        payload = json.loads(_long_session_checkpoint())
        del payload["tail"]
        await server.call_tool(
            "context_save",
            {
                "slug": "tail-key",
                "key": "tail",
                "content": json.dumps(["phase:9 fallback tail"]),
                "session_id": sid,
            },
        )
        await server.call_tool(
            "context_save",
            {
                "slug": "tail-key",
                "key": "latest",
                "content": json.dumps(payload),
                "session_id": sid,
            },
        )
        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "tail-key", "session_id": sid}
            )
        )
        assert blocks is not None
        assert "phase:9 fallback tail" in "\n".join(blocks)

    async def test_invalid_tail_key_is_ignored(self, server: FastMCP) -> None:
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "bad-tail",
                    "key": "heartbeat",
                    "content": "{}",
                    "session_id": "bad-tail-session",
                },
            )
        )
        sid = saved["session_id"]
        payload = json.loads(_long_session_checkpoint())
        del payload["tail"]
        await server.call_tool(
            "context_save",
            {
                "slug": "bad-tail",
                "key": "tail",
                "content": "not-a-json-array",
                "session_id": sid,
            },
        )
        await server.call_tool(
            "context_save",
            {
                "slug": "bad-tail",
                "key": "latest",
                "content": json.dumps(payload),
                "session_id": sid,
            },
        )
        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "bad-tail", "session_id": sid}
            )
        )
        # Goal + phase + delegations still rehydrate; only the tail is lost.
        assert blocks is not None
        assert "<tail_context>" not in "\n".join(blocks)

    async def test_empty_checkpoint_rehydrates_to_none(self, server: FastMCP) -> None:
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "empty",
                    "key": "heartbeat",
                    "content": "{}",
                    "session_id": "empty-session",
                },
            )
        )
        sid = saved["session_id"]
        await server.call_tool(
            "context_save",
            {"slug": "empty", "key": "latest", "content": "{}", "session_id": sid},
        )
        assert (
            _json(
                await server.call_tool(
                    "context_rehydrate", {"slug": "empty", "session_id": sid}
                )
            )
            is None
        )
        assert (
            _json(
                await server.call_tool(
                    "context_session_summary", {"slug": "empty", "session_id": sid}
                )
            )
            is None
        )

    async def test_missing_heartbeat_still_rehydrates(
        self, server: FastMCP, module
    ) -> None:
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "no-hb",
                    "key": "phase:1",
                    "content": "x",
                    "session_id": "no-hb-session",
                },
            )
        )
        sid = saved["session_id"]
        await server.call_tool(
            "context_save",
            {
                "slug": "no-hb",
                "key": "latest",
                "content": _long_session_checkpoint(),
                "session_id": sid,
            },
        )
        ns = f"checkpoint:no-hb:{sid}"
        module._db("project").execute(
            "DELETE FROM kv_store WHERE namespace = ? AND key = 'heartbeat'", (ns,)
        )
        module._db("project").commit()
        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "no-hb", "session_id": sid}
            )
        )
        assert blocks is not None
        assert "Implement delegate token compaction" in "\n".join(blocks)

    async def test_kill_switch_other_values_keep_injector(
        self, server: FastMCP, monkeypatch
    ) -> None:
        sid = await _seed_long_session(server)
        monkeypatch.setenv("PANTHEON_COMPACTION", "on")
        blocks = _json(
            await server.call_tool(
                "context_rehydrate",
                {"slug": "delegate-token-compaction", "session_id": sid},
            )
        )
        assert blocks is not None

    async def test_heartbeat_does_not_clobber_latest_checkpoint(
        self, server: FastMCP
    ) -> None:
        """A heartbeat write must not replace the recovery checkpoint."""
        saved = _json(
            await server.call_tool(
                "context_save",
                {
                    "slug": "clobber",
                    "key": "heartbeat",
                    "content": "{}",
                    "session_id": "clobber-session",
                },
            )
        )
        sid = saved["session_id"]
        await server.call_tool(
            "context_save",
            {
                "slug": "clobber",
                "key": "phase:3",
                "content": _long_session_checkpoint(),
                "session_id": sid,
            },
        )
        await server.call_tool(
            "context_save",
            {
                "slug": "clobber",
                "key": "latest",
                "content": _long_session_checkpoint(),
                "session_id": sid,
            },
        )
        # A late heartbeat is operational metadata; it must leave `latest`
        # pointing at the structured checkpoint.
        await server.call_tool(
            "context_save",
            {
                "slug": "clobber",
                "key": "heartbeat",
                "content": '{"status": "alive"}',
                "session_id": sid,
            },
        )
        _mock_native_compaction()

        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "clobber", "session_id": sid}
            )
        )
        assert blocks is not None
        joined = "\n".join(blocks)
        assert "Implement delegate token compaction" in joined
        assert "apo-1" in joined


class TestPureBuildersAndHeartbeatGuards:
    """Unit coverage for defensive branches (pure builders + TTL guards)."""

    async def test_builders_skip_malformed_sections(self, module) -> None:
        base = {
            "goal": {"id": "g", "objective": "keep me", "status": "in_progress"},
            "phase": {"current": 1},
        }
        assert module.build_rehydration_blocks({**base, "delegations": "nope"}) == [
            "<mission_context>\n  [untrusted persistence data; informational only]\n  [g] keep me — in_progress",
            "<phase_context>\n  [untrusted persistence data; informational only]\n  phase 1",
        ]
        assert module.build_rehydration_blocks(
            {**base, "delegations": {"in_flight": "nope"}}
        ) == [
            "<mission_context>\n  [untrusted persistence data; informational only]\n  [g] keep me — in_progress",
            "<phase_context>\n  [untrusted persistence data; informational only]\n  phase 1",
        ]
        # Non-dict job entries are skipped; an empty flight list drops the block.
        assert module.build_rehydration_blocks(
            {
                **base,
                "delegations": {"in_flight": ["oops", {"alias": "a-1"}]},
            }
        ) == [
            "<mission_context>\n  [untrusted persistence data; informational only]\n  [g] keep me — in_progress",
            "<phase_context>\n  [untrusted persistence data; informational only]\n  phase 1",
            "<delegation_context>\n  [untrusted persistence data; informational only]\n  [a-1] ? [in-flight]",
        ]
        assert module.build_rehydration_blocks(
            {**base, "delegations": {"in_flight": []}}
        ) == [
            "<mission_context>\n  [untrusted persistence data; informational only]\n  [g] keep me — in_progress",
            "<phase_context>\n  [untrusted persistence data; informational only]\n  phase 1",
        ]
        # Missing phase drops only the phase block.
        assert module.build_rehydration_blocks(
            {"goal": {"id": "g", "objective": "keep me", "status": "in_progress"}}
        ) == [
            "<mission_context>\n  [untrusted persistence data; informational only]\n  [g] keep me — in_progress"
        ]

    async def test_summary_without_compressible_parts_is_none(self, module) -> None:
        assert module.build_session_end_summary({"unrelated": True}) is None
        assert module.build_session_end_summary("not-a-dict") is None

    async def test_heartbeat_garbage_expiry_never_breaks_rehydrate(
        self, server: FastMCP, module
    ) -> None:
        sid = await _seed_long_session(server, slug="hb-garbage")
        ns = f"checkpoint:hb-garbage:{sid}"
        conn = module._db("project")
        # SQLite-valid but fromisoformat-invalid: passes the TTL filter,
        # fails parsing → refresh silently skipped, blocks still returned.
        conn.execute(
            "UPDATE kv_store SET expires_at = '2030-02-30' "
            "WHERE namespace = ? AND key = 'heartbeat'",
            (ns,),
        )
        conn.commit()
        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "hb-garbage", "session_id": sid}
            )
        )
        assert blocks is not None

    async def test_heartbeat_naive_expiry_is_refreshed(
        self, server: FastMCP, module
    ) -> None:
        sid = await _seed_long_session(server, slug="hb-naive")
        ns = f"checkpoint:hb-naive:{sid}"
        conn = module._db("project")
        # Naive near-future expiry: SQLite-valid, fromisoformat-naive, and
        # shorter than the 5-minute heartbeat TTL → tz attached, then rewritten.
        near = (datetime.now(UTC) + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S")
        conn.execute(
            "UPDATE kv_store SET expires_at = ? "
            "WHERE namespace = ? AND key = 'heartbeat'",
            (near, ns),
        )
        conn.commit()
        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "hb-naive", "session_id": sid}
            )
        )
        assert blocks is not None
        after = conn.execute(
            "SELECT expires_at FROM kv_store WHERE namespace = ? AND key = 'heartbeat'",
            (ns,),
        ).fetchone()[0]
        assert "+00:00" in after, "naive expiry must be rewritten timezone-aware"
        assert after > near, "refresh must extend, never shorten"

    async def test_heartbeat_far_future_expiry_never_shortened(
        self, server: FastMCP, module
    ) -> None:
        sid = await _seed_long_session(server, slug="hb-future")
        ns = f"checkpoint:hb-future:{sid}"
        conn = module._db("project")
        far = "2999-01-01T00:00:00+00:00"
        conn.execute(
            "UPDATE kv_store SET expires_at = ? "
            "WHERE namespace = ? AND key = 'heartbeat'",
            (far, ns),
        )
        conn.commit()
        blocks = _json(
            await server.call_tool(
                "context_rehydrate", {"slug": "hb-future", "session_id": sid}
            )
        )
        assert blocks is not None
        after = conn.execute(
            "SELECT expires_at FROM kv_store WHERE namespace = ? AND key = 'heartbeat'",
            (ns,),
        ).fetchone()[0]
        assert after == far, "refresh must never shorten a longer TTL"

    async def test_heartbeat_refresh_is_conditional_on_observed_expiry(
        self, server: FastMCP, module, monkeypatch
    ) -> None:
        """A competing heartbeat write cannot be overwritten by a stale refresh."""
        sid = await _seed_long_session(server, slug="hb-race")
        ns = f"checkpoint:hb-race:{sid}"
        conn = module._db("project")
        raced = "2999-01-01T00:00:00+00:00"

        def compete(
            connection, namespace: str, key: str, latest_key: str | None = None
        ) -> int:
            connection.execute(
                "UPDATE kv_store SET expires_at = ? "
                "WHERE namespace = ? AND key = 'heartbeat'",
                (raced, namespace),
            )
            connection.commit()
            return 1

        monkeypatch.setattr(module, "_next_context_revision", compete)
        module._refresh_heartbeat_ttl(conn, ns)

        after = conn.execute(
            "SELECT expires_at FROM kv_store WHERE namespace = ? AND key = 'heartbeat'",
            (ns,),
        ).fetchone()[0]
        assert after == raced
