"""Tests for the lightweight Pantheon Vision MCP server."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, ClassVar

import pytest

from src.mcp import pantheon_vision_server as vision

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _tool_text(result: tuple[list[Any], dict[str, Any]]) -> str:
    """Extract the text returned by FastMCP's call_tool helper."""
    blocks, _ = result
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
        result = await vision.mcp.call_tool("vision_describe", {"path": source})
        assert _tool_text(result) == "A description"


@pytest.mark.asyncio
async def test_invalid_missing_and_oversized_inputs_are_friendly(
    tmp_path: Path,
) -> None:
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
        "vision_describe", {"path": "https://example.test/photo.jpg"}
    )
    assert _tool_text(result) == "A description"
    request = FakeClient.last_request
    assert request["endpoint"] == vision.OPENCODE_ENDPOINT
    assert request["headers"]["Authorization"] == "Bearer store-key"
    body = request["json"]
    assert body["model"] == "mimo-v2.5"
    assert "store-key" not in json.dumps(body)
    assert body["messages"][0]["content"][1]["image_url"]["url"].startswith("https://")


def _seed_credential_db(
    data_dir: Path, integration_id: str, key: str, active: int = 1
) -> None:
    """Create an OpenCode V2 credential store with one plaintext JSON value."""
    import sqlite3

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
async def test_missing_credential_store_returns_none_and_logs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """No source at all is an explicit None plus an error log, not a silent 401.

    The module sets ``propagate = False`` with its own stderr handler, so the
    log is observed through capsys rather than caplog.
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert vision._resolve_auth() == (
        None,
        vision._endpoint_for_model(vision._model()),
    )
    stderr = capsys.readouterr().err
    assert "No OpenCode credential found" in stderr
    assert "PANTHEON_OPENCODE_API_KEY" in stderr
    assert "opencode.db" in stderr


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
        "vision_describe", {"path": "https://example.test/photo.jpg"}
    )
    message = _tool_text(result)
    assert "PANTHEON_OPENCODE_API_KEY" in message
    assert "OPENCODE_API_KEY" in message
    assert "opencode.db" in message


@pytest.mark.asyncio
async def test_ocr_uses_ocr_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PANTHEON_OPENCODE_API_KEY", "test-key")
    monkeypatch.setattr(vision.httpx, "AsyncClient", FakeClient)
    result = await vision.mcp.call_tool(
        "vision_ocr", {"path": "https://example.test/photo.jpg"}
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

    result = await vision.mcp.call_tool("vision_analyze", {"path": str(image)})
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
        "vision_describe", {"path": "https://example.test/photo.jpg"}
    )
    assert "gateway" in _tool_text(failed).lower()

    class TimeoutClient(FakeClient):
        async def post(self, *_args: Any, **_kwargs: Any) -> FakeResponse:
            raise vision.httpx.TimeoutException("timed out")

    monkeypatch.setattr(vision.httpx, "AsyncClient", TimeoutClient)
    timed_out = await vision.mcp.call_tool(
        "vision_describe", {"path": "https://example.test/photo.jpg"}
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
        "vision_describe", {"path": "https://example.test/photo.jpg"}
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
        "vision_describe", {"path": "https://example.test/photo.jpg"}
    )
    assert "gateway" in _tool_text(result).lower()
    stderr = capsys.readouterr().err
    assert "401" in stderr
    assert "mimo-v2.5" in stderr
    assert "not supported" in stderr
    assert secret not in stderr
    assert "data:image" not in stderr
