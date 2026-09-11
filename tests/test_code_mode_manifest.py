"""RED tests for B3-08 — explicit code-mode installation mode + manifest/hash.

Contract (mirrors the nine-code NativeTaskStatus contract from B3-05):
  OK, UNSUPPORTED, UNAVAILABLE, INVALID_INPUT, INVALID_STATE, CONFLICT,
  CORRUPT_DATA, TIMEOUT, ESCALATE

Rules under test:
- No script executes without an explicit opt-in: it must be listed in
  ``.pantheon/code-mode/manifest.json`` with a matching SHA-256.
- Missing manifest            -> INVALID_STATE (nothing runs by default)
- Script not in the manifest  -> CONFLICT (not approved)
- Hash mismatch               -> CORRUPT_DATA
- Malformed manifest          -> CORRUPT_DATA
- Valid approved script       -> OK

All execution tests run against a hermetic temporary scripts directory so
they never mutate the shipped manifest.
"""

from __future__ import annotations

import hashlib
import importlib
import json
from pathlib import Path

import pytest

MODULE_PATH = "src.mcp.code_mode_server"

ECHO_BODY = "#!/usr/bin/env python3\nprint('MANIFEST_MARKER')\n"


def _write_script(scripts_dir: Path, name: str, content: str = ECHO_BODY) -> Path:
    """Write an executable script into *scripts_dir*."""
    path = scripts_dir / name
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)
    return path


@pytest.fixture(scope="session")
def module():
    mod = importlib.import_module(MODULE_PATH)
    importlib.reload(mod)
    return mod


@pytest.fixture
def scripts_env(module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Hermetic code-mode dir wired as the module's SCRIPTS_DIR."""
    scripts_dir = tmp_path / "code-mode"
    scripts_dir.mkdir()
    monkeypatch.setattr(module, "SCRIPTS_DIR", scripts_dir)
    return scripts_dir


async def _exec(module, name: str, *, json_output: bool = False):
    return await module.execute_code_script(name, json_output=json_output)


def _payload(result) -> dict:
    """Normalise a tool result (FastMCP call_tool tuple or plain dict)."""
    if isinstance(result, tuple):
        blocks = result[0]
        text = blocks[0].text if blocks and hasattr(blocks[0], "text") else ""
    elif isinstance(result, dict):
        return result
    else:
        text = str(result)
    return json.loads(text)


# =============================================================================
# Contract
# =============================================================================


class TestContract:
    """The module exposes the shared nine-code status contract."""

    def test_contract_statuses_defined(self, module) -> None:
        expected = {
            "OK",
            "UNSUPPORTED",
            "UNAVAILABLE",
            "INVALID_INPUT",
            "INVALID_STATE",
            "CONFLICT",
            "CORRUPT_DATA",
            "TIMEOUT",
            "ESCALATE",
        }
        assert set(module.CONTRACT_STATUSES) == expected

    def test_manifest_filename_constant(self, module) -> None:
        assert module.MANIFEST_FILENAME == "manifest.json"


# =============================================================================
# Missing / malformed manifest (fail-closed)
# =============================================================================


class TestManifestFailClosed:
    """Absent or corrupt manifests never execute anything."""

    async def test_missing_manifest_returns_invalid_state(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        assert not (scripts_env / "manifest.json").exists()

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "INVALID_STATE"
        assert "manifest" in result["error"].lower()
        assert "MARKER" not in json.dumps(result)

    async def test_missing_manifest_blocks_even_valid_scripts(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "checkpoint_session.py")
        result = await _exec(module, "checkpoint_session.py", json_output=True)
        assert result["status"] == "INVALID_STATE"

    async def test_malformed_manifest_returns_corrupt_data(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        (scripts_env / "manifest.json").write_text("{not json", encoding="utf-8")

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "CORRUPT_DATA"
        assert "malformed" in result["error"].lower()

    async def test_manifest_missing_scripts_key_returns_corrupt_data(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        (scripts_env / "manifest.json").write_text(
            json.dumps({"version": 1}), encoding="utf-8"
        )

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "CORRUPT_DATA"

    async def test_manifest_scripts_wrong_type_returns_corrupt_data(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        (scripts_env / "manifest.json").write_text(
            json.dumps({"version": 1, "scripts": ["hello.py"]}), encoding="utf-8"
        )

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "CORRUPT_DATA"

    async def test_manifest_bad_hash_shape_returns_corrupt_data(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        (scripts_env / "manifest.json").write_text(
            json.dumps({"version": 1, "scripts": {"hello.py": "not-a-sha"}}),
            encoding="utf-8",
        )

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "CORRUPT_DATA"

    async def test_manifest_unsupported_version_returns_corrupt_data(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        digest = hashlib.sha256(scripts_env.joinpath("hello.py").read_bytes()).hexdigest()
        (scripts_env / "manifest.json").write_text(
            json.dumps({"version": 2, "scripts": {"hello.py": digest}}),
            encoding="utf-8",
        )

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "CORRUPT_DATA"
        assert "version must be 1" in result["error"]

    async def test_manifest_top_level_not_object_returns_corrupt_data(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        (scripts_env / "manifest.json").write_text("[]", encoding="utf-8")

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "CORRUPT_DATA"


# =============================================================================
# Approval gate
# =============================================================================


class TestApprovalGate:
    """Only manifest-listed scripts with a matching hash may run."""

    async def test_approved_script_executes_ok(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        status, _ = module._approve_script("hello.py")
        assert status == "OK"

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "OK"
        assert "MANIFEST_MARKER" in result["stdout"]
        assert result["exit_code"] == 0

    async def test_unapproved_script_blocked_with_conflict(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "approved.py")
        _write_script(scripts_env, "rogue.py", "#!/usr/bin/env python3\nprint('ROGUE')\n")
        module._approve_script("approved.py")

        result = await _exec(module, "rogue.py", json_output=True)
        assert result["status"] == "CONFLICT"
        assert "not approved" in result["error"].lower()
        assert "ROGUE" not in json.dumps(result)

    async def test_hash_mismatch_blocked_with_corrupt_data(
        self, module, scripts_env: Path
    ) -> None:
        path = _write_script(scripts_env, "hello.py")
        module._approve_script("hello.py")
        path.write_text("#!/usr/bin/env python3\nprint('TAMPERED')\n", encoding="utf-8")

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "CORRUPT_DATA"
        assert "hash mismatch" in result["error"].lower()
        assert "TAMPERED" not in json.dumps(result)

    async def test_reapprove_after_edit_executes(
        self, module, scripts_env: Path
    ) -> None:
        path = _write_script(scripts_env, "hello.py")
        module._approve_script("hello.py")
        path.write_text("#!/usr/bin/env python3\nprint('UPDATED')\n", encoding="utf-8")
        module._approve_script("hello.py")

        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "OK"
        assert "UPDATED" in result["stdout"]

    async def test_plain_text_error_carries_status_prefix(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        result = await _exec(module, "hello.py")
        assert "[INVALID_STATE]" in result

    async def test_traversal_name_still_blocked(
        self, module, scripts_env: Path
    ) -> None:
        result = await _exec(module, "../../etc/passwd", json_output=True)
        assert result["status"] == "INVALID_INPUT"


# =============================================================================
# Manifest generation / approval
# =============================================================================


class TestApproveAndGenerate:
    """approve_code_script and _generate_manifest write verifiable hashes."""

    async def test_approve_writes_sha256_manifest(
        self, module, scripts_env: Path
    ) -> None:
        content = ECHO_BODY
        _write_script(scripts_env, "hello.py", content)
        status, message = module._approve_script("hello.py")
        assert status == "OK"
        assert "sha-256" in message.lower()

        manifest = json.loads((scripts_env / "manifest.json").read_text("utf-8"))
        assert manifest["version"] == 1
        expected = hashlib.sha256(content.encode("utf-8")).hexdigest()
        assert manifest["scripts"]["hello.py"] == expected

    def test_approve_unknown_script_is_invalid_input(
        self, module, scripts_env: Path
    ) -> None:
        status, _ = module._approve_script("ghost.py")
        assert status == "INVALID_INPUT"

    def test_approve_bad_extension_is_invalid_input(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "evil.js", "console.log('x')\n")
        status, _ = module._approve_script("evil.js")
        assert status == "INVALID_INPUT"

    def test_approve_traversal_is_invalid_input(
        self, module, scripts_env: Path
    ) -> None:
        status, _ = module._approve_script("../../etc/passwd")
        assert status == "INVALID_INPUT"

    def test_generate_manifest_approves_all_scripts(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "a.py")
        _write_script(scripts_env, "b.sh", "#!/usr/bin/env bash\necho hi\n")
        count = module._generate_manifest(scripts_env)
        assert count == 2
        manifest = json.loads((scripts_env / "manifest.json").read_text("utf-8"))
        assert set(manifest["scripts"]) == {"a.py", "b.sh"}

    async def test_generate_manifest_result_executes(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        module._generate_manifest(scripts_env)
        result = await _exec(module, "hello.py", json_output=True)
        assert result["status"] == "OK"
        assert "MANIFEST_MARKER" in result["stdout"]

    def test_sha256_file_matches_hashlib(self, module, scripts_env: Path) -> None:
        path = _write_script(scripts_env, "hello.py", "payload-bytes")
        expected = hashlib.sha256(b"payload-bytes").hexdigest()
        assert module._sha256_file(path) == expected


# =============================================================================
# approve_code_script MCP tool
# =============================================================================


class TestApproveTool:
    async def test_tool_registered(self, module) -> None:
        tools = await module.mcp.list_tools()
        assert "approve_code_script" in [t.name for t in tools]

    async def test_tool_approves_and_returns_json(
        self, module, scripts_env: Path
    ) -> None:
        _write_script(scripts_env, "hello.py")
        result = await module.mcp.call_tool(
            "approve_code_script", {"script_name": "hello.py", "json_output": True}
        )
        payload = _payload(result)
        assert payload["status"] == "OK"
        assert (scripts_env / "manifest.json").exists()

    async def test_tool_on_missing_script_returns_invalid_input(
        self, module, scripts_env: Path
    ) -> None:
        result = await module.mcp.call_tool(
            "approve_code_script", {"script_name": "ghost.py", "json_output": True}
        )
        payload = _payload(result)
        assert payload["status"] == "INVALID_INPUT"


# =============================================================================
# Shipped manifest sanity
# =============================================================================


class TestShippedManifest:
    """The repository ships a manifest covering its bundled scripts."""

    def test_repo_ships_manifest(self) -> None:
        manifest_path = (
            Path(__file__).resolve().parent.parent
            / ".pantheon"
            / "code-mode"
            / "manifest.json"
        )
        assert manifest_path.is_file()
        data = json.loads(manifest_path.read_text("utf-8"))
        assert data["version"] == 1
        assert "example-sync.sh" in data["scripts"]
        digest = data["scripts"]["example-sync.sh"]
        assert len(digest) == 64

    async def test_shipped_script_executes(self, module) -> None:
        result = await module.execute_code_script("example-sync.sh", json_output=True)
        assert result["status"] == "OK"
        assert result["exit_code"] == 0
