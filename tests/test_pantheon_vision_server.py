"""Tests for the lightweight Pantheon Vision MCP server."""

from __future__ import annotations

import base64
import json
import sqlite3
from pathlib import Path
from typing import Any, ClassVar

import pytest

from src.mcp import pantheon_vision as vision

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _tool_text(result: Any) -> str:
    """Extract the text returned by FastMCP's call_tool helper."""
    blocks = getattr(result, "content", result)
    if isinstance(blocks, tuple):
        blocks = blocks[0]
    block = blocks[0]
    return block.text if hasattr(block, "text") else str(block)


class FakeResponse:
    """Small httpx response replacement used by gateway tests."""

    def __init__(self, status_code: int = 200, content: str = "A description") -> None:
        self.status_code = status_code
        self._content = content

    @property
    def text(self) -> str:
        """Body text surfaced by httpx responses (used for error detail logs)."""
        return self._content

    def json(self) -> dict[str, Any]:
        return {"choices": [{"message": {"content": self._content}}]}


class FakeClient:
    """Async client replacement that records the gateway request."""

    last_request: ClassVar[dict[str, Any]] = {}
    response = FakeResponse()

    def __init__(self, **_kwargs: Any) -> None:
        """Accept the production timeout configuration."""

    async def __aenter__(self) -> FakeClient:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def post(self, endpoint: str, **kwargs: Any) -> FakeResponse:
        type(self).last_request = {"endpoint": endpoint, **kwargs}
        return self.response


@pytest.fixture(autouse=True)
def clear_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep auth resolution deterministic for each test."""
    monkeypatch.delenv("PANTHEON_OPENCODE_API_KEY", raising=False)
    monkeypatch.delenv("OPENCODE_API_KEY", raising=False)
    monkeypatch.delenv("PANTHEON_VISION_MODEL", raising=False)
    # The default data dir honors XDG_DATA_HOME; clear it so the hermetic
    # `Path.home` fixture (tmp_path) is the only base picked up.
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.delenv("OPENCODE_DB", raising=False)
    FakeClient.last_request = {}
    FakeClient.response = FakeResponse()


@pytest.mark.asyncio
async def test_tools_are_registered() -> None:
    tools = await vision.mcp.list_tools()
    assert {tool.name for tool in tools} >= {
        "vision_describe",
        "vision_ocr",
        "vision_analyze",
    }


@pytest.mark.asyncio
async def test_data_uri_file_and_http_inputs_are_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image = tmp_path / "image.png"
    image.write_bytes(PNG_1X1)
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")

    for source in (
        image.as_uri(),
        "data:image/png;base64," + base64.b64encode(PNG_1X1).decode(),
        "https://example.test/image.png",
    ):
        result = await vision.mcp.call_tool(
            "vision_describe", {"path": source, "session_id": "ses_valid123"}
        )
        assert _tool_text(result) == "A description"


@pytest.mark.asyncio
async def test_invalid_missing_and_oversized_inputs_are_friendly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    missing = await vision.mcp.call_tool(
        "vision_describe", {"path": str(tmp_path / "missing.png")}
    )
    assert "not found" in _tool_text(missing).lower()

    invalid = await vision.mcp.call_tool(
        "vision_describe", {"path": "data:text/plain;base64,SGk="}
    )
    assert "unsupported" in _tool_text(invalid).lower()

    oversized = tmp_path / "large.png"
    with oversized.open("wb") as handle:
        handle.truncate(vision.MAX_IMAGE_BYTES + 1)
    result = await vision.mcp.call_tool("vision_describe", {"path": str(oversized)})
    assert "25" in _tool_text(result)


@pytest.mark.asyncio
async def test_env_auth_precedes_auth_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    auth_file = tmp_path / ".local" / "share" / "opencode" / "auth.json"
    auth_file.parent.mkdir(parents=True)
    auth_file.write_text(json.dumps({"opencode-go": {"key": "store-key"}}))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "env-key")
    assert vision._resolve_auth() == ("env-key", vision.GO_ENDPOINT)


@pytest.mark.asyncio
async def test_auth_store_fallback_and_gateway_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    auth_file = tmp_path / ".local" / "share" / "opencode" / "auth.json"
    auth_file.parent.mkdir(parents=True)
    auth_file.write_text(json.dumps({"opencode": {"key": "store-key"}}))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)

    result = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert _tool_text(result) == "A description"
    request = FakeClient.last_request
    assert request["endpoint"] == vision.OPENCODE_ENDPOINT
    assert request["headers"]["Authorization"] == "Bearer store-key"
    body = request["json"]
    assert body["model"] == "mimo-v2.5"
    assert "store-key" not in json.dumps(body)
    assert body["messages"][0]["content"][1]["image_url"]["url"].startswith("https://")


def test_is_zen_endpoint() -> None:
    assert vision._is_zen_endpoint(vision.GO_ENDPOINT)
    assert vision._is_zen_endpoint(vision.OPENCODE_ENDPOINT)
    assert not vision._is_zen_endpoint("https://evil.test/v1/chat/completions")


@pytest.mark.asyncio
async def test_session_header_sent_for_zen_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A session id reaches a Zen endpoint as ``x-opencode-session``."""
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)

    result = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "session-zen"},
    )
    assert _tool_text(result) == "A description"
    assert FakeClient.last_request["headers"][vision.SESSION_HEADER] == "session-zen"


@pytest.mark.asyncio
async def test_missing_session_fails_before_image_or_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Zen-bound MCP call without a session fails before image/network work."""
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    prepare_calls = 0

    async def unexpected_prepare(_path: str) -> vision.ImageInput:
        nonlocal prepare_calls
        prepare_calls += 1
        raise AssertionError("image preparation must not run without a valid session")

    monkeypatch.setattr(vision, "_prepare_input", unexpected_prepare)

    result = await vision.mcp.call_tool(
        "vision_describe", {"path": "https://example.test/photo.jpg"}
    )
    assert "valid OpenCode session" in _tool_text(result)
    assert prepare_calls == 0
    assert FakeClient.last_request == {}


@pytest.mark.asyncio
async def test_invalid_session_fails_before_any_gateway_tool_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Describe, OCR, and analyze reject invalid sessions before image prep/post."""
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    prepare_calls = 0

    async def unexpected_prepare(_path: str) -> vision.ImageInput:
        nonlocal prepare_calls
        prepare_calls += 1
        raise AssertionError("image preparation must not run without a valid session")

    monkeypatch.setattr(vision, "_prepare_input", unexpected_prepare)
    for tool_name in ("vision_describe", "vision_ocr", "vision_analyze"):
        result = await vision.mcp.call_tool(
            tool_name,
            {"path": "https://example.test/photo.jpg", "session_id": "not-a-session"},
        )
        assert "valid OpenCode session" in _tool_text(result)
    assert prepare_calls == 0
    assert FakeClient.last_request == {}


@pytest.mark.asyncio
async def test_session_header_absent_for_non_zen_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-Zen endpoint must never receive the session identity."""
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(
        vision,
        "_resolve_auth",
        lambda: ("test-key", "https://other.test/v1/chat/completions"),
    )

    await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_session-secret"},
    )
    assert vision.SESSION_HEADER not in FakeClient.last_request["headers"]


@pytest.mark.asyncio
async def test_session_id_is_never_logged(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A failing gateway logs status/model/detail — never the session id."""
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    FakeClient.response = FakeResponse(status_code=400, content="MissingSessionID")

    result = await vision.mcp.call_tool(
        "vision_describe",
        {
            "path": "https://example.test/photo.jpg",
            "session_id": "ses_session-do-not-log",
        },
    )
    assert "MissingSessionID" in _tool_text(result)
    assert "ses_session-do-not-log" not in capsys.readouterr().err


def test_validated_session_id_matches_host_session_contract() -> None:
    """Vision uses the host's starts-with-ses session id contract verbatim."""
    assert vision._validated_session_id("ses_abc123") == "ses_abc123"
    assert vision._validated_session_id("ses") == "ses"
    assert vision._validated_session_id("session-zen") == "session-zen"
    # Values rejected by the host's session guard are rejected here as well.
    for bad in [
        None,
        "",
        "   ",
        "bad\r\nX-Injected: 1",
        "bad\nX-Injected: 1",
        'quote"id',
        "has space",
        "with\tcontrol",
        "ctrl\x00null",
        "wrk_123",
        123,
    ]:
        assert vision._validated_session_id(bad) is None, f"accepted: {bad!r}"


@pytest.mark.asyncio
async def test_invalid_session_ids_never_reach_the_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Invalid host session ids fail before a request; valid ids are forwarded."""
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)

    for malicious in [
        "inj\r\nX-Injected: 1",
        'quote"id',
        "with space",
        "",
        "   ",
        "ctrl\x00null",
    ]:
        FakeClient.last_request = {}
        result = await vision.mcp.call_tool(
            "vision_describe",
            {"path": "https://example.test/photo.jpg", "session_id": malicious},
        )
        assert "valid OpenCode session" in _tool_text(result)
        assert FakeClient.last_request == {}, f"request sent for invalid {malicious!r}"

    # Positive control: a host-valid token still reaches the Zen header.
    FakeClient.last_request = {}
    await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert FakeClient.last_request["headers"][vision.SESSION_HEADER] == "ses_valid123"


@pytest.mark.asyncio
async def test_gateway_status_maps_to_actionable_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """400/403 gateway errors name the actionable cause."""
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)

    FakeClient.response = FakeResponse(status_code=400, content="MissingSessionID")
    missing = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert "HTTP 400" in _tool_text(missing)
    assert "MissingSessionID" in _tool_text(missing)

    FakeClient.response = FakeResponse(status_code=403, content="free tier")
    denied = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert "HTTP 403" in _tool_text(denied)
    assert "free-tier" in _tool_text(denied)


@pytest.mark.asyncio
async def test_empty_response_surfaces_finish_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A reasoning model cut off by max_tokens yields an actionable message."""

    class _EmptyLengthResponse:
        status_code = 200
        text = "{}"

        def json(self) -> dict[str, Any]:
            return {
                "choices": [{"message": {"content": None}, "finish_reason": "length"}]
            }

    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    FakeClient.response = _EmptyLengthResponse()

    result = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert "finish_reason: length" in _tool_text(result)


def _seed_credential_db(
    data_dir: Path, integration_id: str, key: str, active: int = 1
) -> None:
    """Create an OpenCode V2 credential store with one plaintext JSON value."""
    conn = sqlite3.connect(str(data_dir / "opencode.db"))
    conn.execute(
        "CREATE TABLE credential ("
        "id text PRIMARY KEY, integration_id text, label text NOT NULL, "
        "value text NOT NULL, connector_id text, method_id text, "
        "active integer, time_created integer NOT NULL, time_updated integer NOT NULL)"
    )
    conn.execute(
        "INSERT INTO credential "
        "(id, integration_id, label, value, active, time_created, time_updated) "
        "VALUES (?, ?, ?, ?, ?, 0, 0)",
        (
            "cred_test",
            integration_id,
            integration_id,
            json.dumps({"type": "key", "key": key}),
            active,
        ),
    )
    conn.commit()
    conn.close()


@pytest.mark.asyncio
async def test_env_auth_precedes_credential_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Env wins over the store, and the store must not be touched to prove it."""
    data_dir = tmp_path / ".local" / "share" / "opencode"
    data_dir.mkdir(parents=True)
    _seed_credential_db(data_dir, "opencode-go", "store-key")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "env-key")
    assert vision._resolve_auth() == ("env-key", vision.GO_ENDPOINT)


@pytest.mark.asyncio
async def test_credential_store_supplies_key_on_v2_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A V2 host with no auth.json resolves from the credential table.

    This is the bug: V2 moved credentials into opencode.db, so the old
    auth.json-only read silently resolved nothing on every V2 host.
    """
    data_dir = tmp_path / ".local" / "share" / "opencode"
    data_dir.mkdir(parents=True)
    _seed_credential_db(data_dir, "opencode-go", "v2-store-key")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    assert not (data_dir / "auth.json").exists(), "precondition: no V1 auth.json"
    assert vision._resolve_auth() == ("v2-store-key", vision.GO_ENDPOINT)


@pytest.mark.asyncio
async def test_credential_store_inactive_row_is_ignored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A deactivated credential must not authenticate anything."""
    data_dir = tmp_path / ".local" / "share" / "opencode"
    data_dir.mkdir(parents=True)
    _seed_credential_db(data_dir, "opencode-go", "stale-key", active=0)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert vision._resolve_auth() == (None, vision._endpoint_for_model(vision._model()))


@pytest.mark.asyncio
async def test_credential_store_falls_back_to_legacy_auth_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A V1 host with only auth.json still resolves, at the legacy endpoint."""
    data_dir = tmp_path / ".local" / "share" / "opencode"
    data_dir.mkdir(parents=True)
    (data_dir / "auth.json").write_text(json.dumps({"opencode": {"key": "v1-key"}}))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert vision._resolve_auth() == ("v1-key", vision.OPENCODE_ENDPOINT)


@pytest.mark.asyncio
async def test_credential_store_honors_opencode_db_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``OPENCODE_DB`` points at a relocated V2 store (e.g. a sandbox).

    The default XDG ``<data dir>/opencode.db`` is absent here, so a resolution
    proves the env-named file was read.
    """
    store_dir = tmp_path / "sandbox"
    store_dir.mkdir(parents=True)
    _seed_credential_db(store_dir, "opencode", "sandbox-key")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("OPENCODE_DB", str(store_dir / "opencode.db"))

    assert not (tmp_path / ".local" / "share" / "opencode" / "opencode.db").exists(), (
        "precondition: the default XDG db is absent"
    )
    assert vision._resolve_auth() == ("sandbox-key", vision.OPENCODE_ENDPOINT)


@pytest.mark.asyncio
async def test_credential_store_defaults_to_xdg_without_opencode_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no ``OPENCODE_DB`` the default ``<data dir>/opencode.db`` is read."""
    data_dir = tmp_path / ".local" / "share" / "opencode"
    data_dir.mkdir(parents=True)
    _seed_credential_db(data_dir, "opencode-go", "default-db-key")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("OPENCODE_DB", raising=False)

    assert vision._resolve_auth() == ("default-db-key", vision.GO_ENDPOINT)


@pytest.mark.asyncio
async def test_credential_store_honors_xdg_data_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``XDG_DATA_HOME`` relocates the default data dir (empty HOME is ignored)."""
    home = tmp_path / "home"
    xdg_data = tmp_path / "xdg-data"
    data_dir = xdg_data / "opencode"
    data_dir.mkdir(parents=True)
    _seed_credential_db(data_dir, "opencode-go", "xdg-data-db-key")
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("XDG_DATA_HOME", str(xdg_data))
    monkeypatch.delenv("OPENCODE_DB", raising=False)

    assert not (home / ".local" / "share" / "opencode" / "opencode.db").exists(), (
        "precondition: the HOME fallback db is absent"
    )
    assert vision._resolve_auth() == ("xdg-data-db-key", vision.GO_ENDPOINT)


def test_local_fallback_note_names_effective_credential_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The local-fallback guidance points at the EFFECTIVE db, not a hardcoded path."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    # Default: HOME-based data dir.
    assert str(tmp_path / ".local" / "share" / "opencode" / "opencode.db") in (
        vision._local_fallback_note()
    )

    # OPENCODE_DB (relocated store) must be reflected verbatim.
    relocated = tmp_path / "sandbox" / "opencode-v2.db"
    monkeypatch.setenv("OPENCODE_DB", str(relocated))
    note = vision._local_fallback_note()
    assert str(relocated) in note
    assert "~/.local/share/opencode/opencode.db" not in note

    # XDG_DATA_HOME is honored when OPENCODE_DB is absent.
    monkeypatch.delenv("OPENCODE_DB", raising=False)
    xdg_data = tmp_path / "xdg-data"
    monkeypatch.setenv("XDG_DATA_HOME", str(xdg_data))
    assert str(xdg_data / "opencode" / "opencode.db") in vision._local_fallback_note()


@pytest.mark.asyncio
async def test_local_fallback_text_carries_effective_db_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The degraded description embeds the effective db path (end-to-end)."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(vision, "_ocr_bytes", lambda _data: None)
    relocated = tmp_path / "sandbox" / "opencode-v2.db"
    monkeypatch.setenv("OPENCODE_DB", str(relocated))

    image = tmp_path / "image.png"
    image.write_bytes(PNG_1X1)
    result = await vision.mcp.call_tool("vision_describe", {"path": str(image)})
    text = _tool_text(result)
    assert "Imagem local" in text
    assert str(relocated) in text
    assert FakeClient.last_request == {}, "no gateway request in local mode"


@pytest.mark.asyncio
async def test_missing_credential_store_returns_none_and_logs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """The graceful resolve is silent; only the fatal gateway path logs.

    ``_resolve_auth`` is called by ``vision_describe``/``vision_ocr`` before
    they decide to degrade locally, so it must NOT spam stderr in local mode.
    The error (naming the sources tried) belongs to ``_gateway``, where a
    missing key is fatal. The module sets ``propagate = False`` with its own
    stderr handler, so the log is observed through capsys rather than caplog.
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert vision._resolve_auth() == (
        None,
        vision._endpoint_for_model(vision._model()),
    )
    assert "No OpenCode credential found" not in capsys.readouterr().err, (
        "graceful resolve must not log the missing-credential error"
    )

    # The fatal path logs the paths/env vars tried.
    result = await vision.mcp.call_tool(
        "vision_analyze",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    stderr = capsys.readouterr().err
    assert "No OpenCode credential found" in stderr
    assert "PANTHEON_OPENCODE_API_KEY" in stderr
    assert "opencode.db" in stderr
    assert "opencode auth login" in stderr
    assert "opencode auth login" in _tool_text(result), (
        "the fatal credential error names the actionable `opencode auth login`"
    )


@pytest.mark.asyncio
async def test_corrupt_credential_db_is_logged_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """A corrupt store degrades to None with a warning; it must not crash."""
    data_dir = tmp_path / ".local" / "share" / "opencode"
    data_dir.mkdir(parents=True)
    (data_dir / "opencode.db").write_bytes(b"not a sqlite database at all")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert vision._resolve_auth() == (
        None,
        vision._endpoint_for_model(vision._model()),
    )
    stderr = capsys.readouterr().err
    assert "Could not read the OpenCode credential store" in stderr


@pytest.mark.asyncio
async def test_missing_key_error_names_every_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The tool error tells the operator which sources were tried."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    result = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    message = _tool_text(result)
    assert "PANTHEON_OPENCODE_API_KEY" in message
    assert "OPENCODE_API_KEY" in message
    assert "opencode.db" in message
    assert "opencode auth login" in message


@pytest.mark.asyncio
async def test_describe_degrades_to_local_metadata_without_gateway(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No credential → deterministic local metadata, never a gateway call."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(vision, "_ocr_bytes", lambda _data: None)
    image = tmp_path / "image.png"
    image.write_bytes(PNG_1X1)

    result = await vision.mcp.call_tool("vision_describe", {"path": str(image)})
    text = _tool_text(result)
    assert "Imagem local" in text
    assert "1x1" in text
    assert "image/png" in text
    assert "Texto OCR: indisponível" in text
    assert FakeClient.last_request == {}, "no gateway request in local mode"


@pytest.mark.asyncio
async def test_local_fallback_includes_ocr_when_pytesseract_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A mocked pytesseract runner surfaces its text in the local block."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(vision, "_ocr_bytes", lambda _data: "Hello world")
    image = tmp_path / "image.png"
    image.write_bytes(PNG_1X1)

    result = await vision.mcp.call_tool("vision_describe", {"path": str(image)})
    text = _tool_text(result)
    assert "Hello world" in text
    assert "Texto OCR" in text


@pytest.mark.asyncio
async def test_local_fallback_never_invents_a_description(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A remote URL without a key yields declared metadata, not a description."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    result = await vision.mcp.call_tool(
        "vision_describe", {"path": "https://example.test/photo.jpg"}
    )
    text = _tool_text(result)
    assert "Imagem local" in text
    assert "image/jpeg" in text
    assert "PANTHEON_OPENCODE_API_KEY" in text
    assert FakeClient.last_request == {}


@pytest.mark.asyncio
async def test_local_fallback_error_when_input_is_invalid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unsupported input still fails clearly instead of degrading to metadata."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    result = await vision.mcp.call_tool(
        "vision_describe", {"path": "data:text/plain;base64,SGk="}
    )
    assert "unsupported" in _tool_text(result).lower()


@pytest.mark.asyncio
async def test_ocr_degrades_locally_without_gateway(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """vision_ocr also degrades to the local block when no key is configured."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(vision, "_ocr_bytes", lambda _data: "linha um")
    image = tmp_path / "image.png"
    image.write_bytes(PNG_1X1)

    result = await vision.mcp.call_tool("vision_ocr", {"path": str(image)})
    assert "linha um" in _tool_text(result)
    assert FakeClient.last_request == {}


@pytest.mark.asyncio
async def test_ocr_uses_ocr_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    result = await vision.mcp.call_tool(
        "vision_ocr",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert _tool_text(result) == "A description"
    prompt = FakeClient.last_request["json"]["messages"][0]["content"][0]["text"]
    assert "OCR" in prompt
    assert "formatação" in prompt


@pytest.mark.asyncio
async def test_analyze_returns_png_metadata_and_structured_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    image = tmp_path / "image.png"
    image.write_bytes(PNG_1X1)
    FakeClient.response = FakeResponse(
        content=json.dumps({"description": "one pixel", "ocr": "No text found."})
    )
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)

    result = await vision.mcp.call_tool(
        "vision_analyze", {"path": str(image), "session_id": "ses_valid123"}
    )
    payload = json.loads(_tool_text(result))
    assert payload["metadata"]["mime"] == "image/png"
    assert payload["metadata"]["size"] == len(PNG_1X1)
    assert payload["metadata"]["width"] == 1
    assert payload["metadata"]["height"] == 1
    assert payload["description"] == "one pixel"
    assert payload["ocr"] == "No text found."


@pytest.mark.asyncio
async def test_gateway_500_and_timeout_are_friendly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    FakeClient.response = FakeResponse(status_code=500)
    failed = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert "gateway" in _tool_text(failed).lower()

    class TimeoutClient(FakeClient):
        async def post(self, *_args: Any, **_kwargs: Any) -> FakeResponse:
            raise vision.httpx.TimeoutException("timed out")

    monkeypatch.setattr(vision.httpx, "AsyncClient", TimeoutClient)
    timed_out = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert "timed out" in _tool_text(timed_out).lower()


@pytest.mark.asyncio
async def test_key_never_appears_in_tool_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "super-secret-token"
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", secret)
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    FakeClient.response = FakeResponse(content=secret)
    result = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert secret not in _tool_text(result)


def test_strip_provider_prefix() -> None:
    assert vision._strip_provider_prefix("opencode-go/mimo-v2.5") == "mimo-v2.5"
    assert (
        vision._strip_provider_prefix("opencode/deepseek-v4-flash")
        == "deepseek-v4-flash"
    )
    assert vision._strip_provider_prefix("mimo-v2.5") == "mimo-v2.5"


@pytest.mark.asyncio
async def test_gateway_error_logs_sanitized_status_and_model(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = "super-secret-token"
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", secret)
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    FakeClient.response = FakeResponse(
        status_code=401,
        content=json.dumps({"error": "Model mimo-v2.5 is not supported"}),
    )
    result = await vision.mcp.call_tool(
        "vision_describe",
        {"path": "https://example.test/photo.jpg", "session_id": "ses_valid123"},
    )
    assert "gateway" in _tool_text(result).lower()
    stderr = capsys.readouterr().err
    assert "401" in stderr
    assert "mimo-v2.5" in stderr
    assert "not supported" in stderr
    assert secret not in stderr
    assert "data:image" not in stderr
