"""Tests for code-mode script metadata (YAML frontmatter), JSON output mode,
per-script timeout override, and allowed_args validation.

Covers:
- _parse_frontmatter: valid / invalid / missing / shebang-first
- _script_timeout: frontmatter override vs 30s default
- _validate_args: allowlist enforcement (deny unknown, allow listed)
- execute_code_script json_output=True: structured dict with stdout/stderr/
  exit_code/duration_ms/metadata
- timeout override: a script with `timeout: 2` is killed at ~2s
- metadata exposed via the pantheon://code-mode/scripts/{name} resource
"""
from __future__ import annotations

import importlib
import json
import time
from pathlib import Path
from typing import Any

import pytest

MODULE_PATH = "src.mcp.code_mode_server"
ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / ".pantheon" / "code-mode"


def _text_from_tool(result: Any) -> str:
    """Extract text from FastMCP call_tool result (list or tuple shape)."""
    content_blocks = result[0] if isinstance(result, tuple) else result
    if content_blocks and len(content_blocks) > 0:
        block = content_blocks[0]
        if hasattr(block, "text"):
            return block.text
        return str(block)
    return ""


def _json(result: Any) -> Any:
    """Parse the JSON payload returned by a tool call."""
    text = _text_from_tool(result)
    return json.loads(text) if text else None


# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture(scope="session")
def module():
    """Import and return the server module."""
    mod = importlib.import_module(MODULE_PATH)
    importlib.reload(mod)
    return mod


@pytest.fixture
def server(module):
    """Return the FastMCP server instance."""
    return module.mcp


def _write_script(name: str, content: str) -> Path:
    """Write a temp script into the code-mode dir; caller removes it."""
    path = SCRIPTS_DIR / name
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)
    return path


# Script bodies
VALID_FM = """#!/usr/bin/env python3
# ---
# description: Echoes its argv for frontmatter tests
# timeout: 5
# allowed_args:
#   - alpha
#   - beta
# ---
import sys
print('ARGV:' + ' '.join(sys.argv[1:]))
"""

INVALID_FM = """#!/usr/bin/env python3
# ---
# description: [unclosed
# timeout: not-a-number
# ---
print('ran')
"""

NO_FM = """#!/usr/bin/env python3
print('no-frontmatter')
"""

TIMEOUT_FM = """#!/usr/bin/env python3
# ---
# timeout: 2
# ---
import time
time.sleep(30)
print('should-not-print')
"""

# Bash script that spawns a child process (sleep) — verifies process-group kill.
TIMEOUT_KILLPG_FM = """#!/usr/bin/env bash
# ---
# timeout: 2
# ---
sleep 30
echo "should-not-print"
"""


# =============================================================================
# Frontmatter parsing
# =============================================================================


class TestParseFrontmatter:
    """Tests for _parse_frontmatter."""

    async def test_valid_frontmatter(self, module) -> None:
        """Valid comment-style frontmatter parses to a metadata dict."""
        path = _write_script("fm_valid.py", VALID_FM)
        try:
            meta = module._parse_frontmatter(path)
            assert meta["description"] == "Echoes its argv for frontmatter tests"
            assert meta["timeout"] == 5
            assert meta["allowed_args"] == ["alpha", "beta"]
        finally:
            path.unlink(missing_ok=True)

    async def test_invalid_yaml_fails_open(self, module) -> None:
        """Malformed YAML frontmatter must return {} (never block execution)."""
        path = _write_script("fm_invalid.py", INVALID_FM)
        try:
            assert module._parse_frontmatter(path) == {}
        finally:
            path.unlink(missing_ok=True)

    async def test_missing_frontmatter(self, module) -> None:
        """Scripts without frontmatter return {}."""
        path = _write_script("fm_missing.py", NO_FM)
        try:
            assert module._parse_frontmatter(path) == {}
        finally:
            path.unlink(missing_ok=True)

    async def test_shebang_first_then_frontmatter(self, module) -> None:
        """Frontmatter after the shebang line is parsed (shebang stays line 1)."""
        path = _write_script("fm_shebang.py", VALID_FM)
        try:
            meta = module._parse_frontmatter(path)
            assert meta["timeout"] == 5
        finally:
            path.unlink(missing_ok=True)

    async def test_unclosed_frontmatter_fails_open(self, module) -> None:
        """A block without a closing delimiter returns {}."""
        content = "#!/usr/bin/env python3\n# ---\n# timeout: 3\nprint('x')\n"
        path = _write_script("fm_unclosed.py", content)
        try:
            assert module._parse_frontmatter(path) == {}
        finally:
            path.unlink(missing_ok=True)


# =============================================================================
# Timeout override
# =============================================================================


class TestScriptTimeout:
    """Tests for _script_timeout."""

    async def test_frontmatter_timeout_override(self, module) -> None:
        """Frontmatter timeout must override the 30s default."""
        path = _write_script("fm_timeout_meta.py", VALID_FM)
        try:
            assert module._script_timeout(path) == 5
        finally:
            path.unlink(missing_ok=True)

    async def test_default_timeout_when_missing(self, module) -> None:
        """No frontmatter timeout → 30s default."""
        path = _write_script("fm_default_timeout.py", NO_FM)
        try:
            assert module._script_timeout(path) == module.SCRIPT_TIMEOUT == 30
        finally:
            path.unlink(missing_ok=True)

    async def test_script_with_timeout_2_killed_at_2s(self, server) -> None:
        """A script with `timeout: 2` must be killed at ~2s, not 30s."""
        path = _write_script("fm_kill.py", TIMEOUT_FM)
        try:
            started = time.monotonic()
            result = await server.call_tool(
                "execute_code_script",
                {"script_name": "fm_kill.py", "json_output": True},
            )
            elapsed = time.monotonic() - started
            data = _json(result)
            assert data["timed_out"] is True
            assert data["exit_code"] == -1
            assert 1.5 <= elapsed < 10, f"killed at {elapsed:.1f}s, expected ~2s"
            assert data["timeout_s"] == 2
        finally:
            path.unlink(missing_ok=True)

    async def test_bash_sleep_killed_via_process_group(self, server) -> None:
        """Bash script spawning `sleep 30` must be killed via process group.

        Before the killpg fix, `proc.kill()` only killed the bash process,
        leaving `sleep 30` alive. With `start_new_session=True` +
        `os.killpg(SIGKILL)`, the entire process group is terminated.
        """
        path = _write_script("fm_killpg.sh", TIMEOUT_KILLPG_FM)
        try:
            started = time.monotonic()
            result = await server.call_tool(
                "execute_code_script",
                {"script_name": "fm_killpg.sh", "json_output": True},
            )
            elapsed = time.monotonic() - started
            data = _json(result)
            assert data["timed_out"] is True
            assert data["exit_code"] == -1
            assert data["duration_ms"] < 3000, (
                f"duration_ms={data['duration_ms']}ms, expected <3000ms; "
                f"killpg may not have killed the child process group"
            )
            assert 1.0 <= elapsed < 10, f"killed at {elapsed:.1f}s, expected ~2s"
            assert data["timeout_s"] == 2
        finally:
            path.unlink(missing_ok=True)


# =============================================================================
# JSON output mode
# =============================================================================


class TestJsonOutput:
    """Tests for json_output=True structured results."""

    async def test_json_output_structure(self, server) -> None:
        """json_output=True returns a structured dict with all fields."""
        path = _write_script("fm_json.py", VALID_FM)
        try:
            result = await server.call_tool(
                "execute_code_script",
                {"script_name": "fm_json.py", "args": ["alpha"], "json_output": True},
            )
            data = _json(result)
            assert data["stdout"].strip() == "ARGV:alpha"
            assert data["stderr"] == ""
            assert data["exit_code"] == 0
            assert data["timed_out"] is False
            assert data["duration_ms"] >= 0
            assert data["metadata"]["description"] == "Echoes its argv for frontmatter tests"
            assert data["metadata"]["timeout"] == 5
        finally:
            path.unlink(missing_ok=True)

    async def test_plain_text_mode_unchanged(self, server) -> None:
        """Default (json_output=False) keeps the plain-text summary."""
        path = _write_script("fm_plain.py", NO_FM)
        try:
            result = await server.call_tool(
                "execute_code_script", {"script_name": "fm_plain.py"}
            )
            text = _text_from_tool(result)
            assert "no-frontmatter" in text
            assert "exit code: 0" in text
        finally:
            path.unlink(missing_ok=True)


# =============================================================================
# allowed_args validation
# =============================================================================


class TestAllowedArgs:
    """Tests for allowed_args allowlist enforcement."""

    async def test_denied_arg_rejected(self, server) -> None:
        """An arg outside the allowlist must be rejected without executing."""
        path = _write_script("fm_args.py", VALID_FM)
        try:
            result = await server.call_tool(
                "execute_code_script",
                {"script_name": "fm_args.py", "args": ["gamma"]},
            )
            text = _text_from_tool(result)
            assert "not allowed" in text
            assert "gamma" in text
            assert "alpha" in text  # lists the allowed args
        finally:
            path.unlink(missing_ok=True)

    async def test_allowed_arg_executes(self, server) -> None:
        """Args inside the allowlist execute normally."""
        path = _write_script("fm_args_ok.py", VALID_FM)
        try:
            result = await server.call_tool(
                "execute_code_script",
                {"script_name": "fm_args_ok.py", "args": ["beta"]},
            )
            text = _text_from_tool(result)
            assert "ARGV:beta" in text
            assert "exit code: 0" in text
        finally:
            path.unlink(missing_ok=True)

    async def test_no_allowlist_no_restriction(self, server) -> None:
        """Scripts without allowed_args accept any args."""
        path = _write_script("fm_no_allow.py", NO_FM)
        try:
            result = await server.call_tool(
                "execute_code_script",
                {"script_name": "fm_no_allow.py", "args": ["anything", "--x"]},
            )
            text = _text_from_tool(result)
            assert "exit code: 0" in text
        finally:
            path.unlink(missing_ok=True)


# =============================================================================
# Resource metadata
# =============================================================================


class TestResourceMetadata:
    """Tests for metadata exposure via the script content resource."""

    async def test_resource_includes_metadata(self, server) -> None:
        """Reading a script with frontmatter returns metadata + source."""
        path = _write_script("fm_resource.py", VALID_FM)
        try:
            result = await server.read_resource("pantheon://code-mode/scripts/fm_resource.py")
            contents = result[0] if isinstance(result, tuple) else result
            text = contents[0].content if hasattr(contents[0], "content") else str(contents[0])
            assert "# metadata" in text
            assert "timeout: 5" in text
            assert "description: Echoes its argv for frontmatter tests" in text
            assert "#!/usr/bin/env python3" in text  # source preserved
        finally:
            path.unlink(missing_ok=True)

    async def test_resource_without_metadata_returns_source(self, server) -> None:
        """Scripts without frontmatter return the raw source unchanged."""
        path = _write_script("fm_resource_plain.py", NO_FM)
        try:
            result = await server.read_resource(
                "pantheon://code-mode/scripts/fm_resource_plain.py"
            )
            contents = result[0] if isinstance(result, tuple) else result
            text = contents[0].content if hasattr(contents[0], "content") else str(contents[0])
            assert text == NO_FM
        finally:
            path.unlink(missing_ok=True)
