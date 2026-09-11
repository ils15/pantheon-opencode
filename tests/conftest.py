# Pytest configuration
import importlib
import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
for p in [PROJECT_ROOT, PROJECT_ROOT / "src" / "mcp", PROJECT_ROOT / "scripts"]:
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

PERSISTENCE_MODULE_PATH = "src.mcp.mcp_persistence_server"

_CODE_MODE_MANIFEST = PROJECT_ROOT / ".pantheon" / "code-mode" / "manifest.json"


@pytest.fixture(autouse=True)
def _restore_code_mode_manifest():
    """Restore the shipped code-mode manifest after each test.

    B3-08 makes script execution opt-in via a SHA-256 manifest. Tests that
    exercise the approve path write to that file; this guard keeps the
    tracked manifest pristine and avoids cross-test leakage.
    """
    original = (
        _CODE_MODE_MANIFEST.read_text(encoding="utf-8")
        if _CODE_MODE_MANIFEST.is_file()
        else None
    )
    try:
        yield
    finally:
        current = (
            _CODE_MODE_MANIFEST.read_text(encoding="utf-8")
            if _CODE_MODE_MANIFEST.is_file()
            else None
        )
        if current != original:
            if original is None:
                _CODE_MODE_MANIFEST.unlink(missing_ok=True)
            else:
                _CODE_MODE_MANIFEST.write_text(original, encoding="utf-8")


# ── Shared persistence-server fixtures (used by persistence + injector tests) ─


def _json(result: Any) -> Any:
    """Parse the payload returned by a persistence tool call.

    FastMCP returns ``(content_blocks, structured)`` tuples for tools with an
    output schema (str/list returns) and plain content-block lists for dict
    returns. Prefer the structured payload when present; fall back to parsing
    the JSON text.
    """
    if isinstance(result, tuple):
        _, structured = result
        if isinstance(structured, dict) and "result" in structured:
            return structured["result"]
        return structured
    block = result[0] if result else None
    text = getattr(block, "text", None) or str(block)
    return json.loads(text) if text else None


@pytest.fixture(scope="session")
def temp_persistence_dir() -> str:
    """Create a temporary directory for SQLite storage."""
    with tempfile.TemporaryDirectory(prefix="pantheon_persistence_test_") as tmpdir:
        yield tmpdir


@pytest.fixture
def module(temp_persistence_dir: str):
    """Import the server module with a fresh temp DB per test.

    The module runs argparse + DB init at import time, so we patch sys.argv
    with --global-db/--project-db pointing into a fresh per-test directory
    and reload. Each test gets an isolated database.
    """
    test_dir = Path(temp_persistence_dir) / f"db_{time.time_ns()}"
    test_dir.mkdir(parents=True, exist_ok=True)
    argv = [
        "pytest",
        "--global-db",
        str(test_dir / "global.db"),
        "--project-db",
        str(test_dir / "project.db"),
    ]
    with patch.object(sys, "argv", argv):
        mod = importlib.import_module(PERSISTENCE_MODULE_PATH)
        importlib.reload(mod)
    return mod


@pytest.fixture
def server(module):
    """Return the FastMCP server instance."""
    return module.mcp
