"""Test for execute_code_script arg forwarding (Task 1).

Verifies that CLI args passed to execute_code_script are forwarded to the
underlying subprocess (so scripts like compress-inline.py that require
`mode` + `--text` args actually receive them instead of argparse exiting 2).
"""

from __future__ import annotations

import hashlib
import importlib
import json
from pathlib import Path

import pytest

MODULE_PATH = "src.mcp.code_mode_server"

# A tiny script that echoes its forwarded argv so the test can assert the
# args actually reached the subprocess.
ECHO_SCRIPT = (
    "#!/usr/bin/env python3\nimport sys\nprint('ARGV:' + ' '.join(sys.argv[1:]))\n"
)


@pytest.fixture
def module():
    mod = importlib.import_module(MODULE_PATH)
    importlib.reload(mod)
    return mod


@pytest.fixture
def echo_script(module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    """Hermetic code-mode dir with an approved echo script."""
    scripts_dir = tmp_path / "code-mode"
    scripts_dir.mkdir()
    monkeypatch.setattr(module, "SCRIPTS_DIR", scripts_dir)
    script_path = scripts_dir / "echo_args_test.py"
    script_path.write_text(ECHO_SCRIPT, encoding="utf-8")
    script_path.chmod(0o755)
    digest = hashlib.sha256(script_path.read_bytes()).hexdigest()
    (scripts_dir / "manifest.json").write_text(
        json.dumps({"version": 1, "scripts": {script_path.name: digest}}),
        encoding="utf-8",
    )
    return script_path.name


class TestExecuteCodeScriptArgs:
    """Args supplied to execute_code_script must reach the subprocess."""

    async def test_args_forwarded_to_subprocess(self, module, echo_script) -> None:
        """Forwarded args should appear in the script's echoed argv output."""
        result = await module.execute_code_script(echo_script, ["alpha", "beta"])
        assert "ARGV:alpha beta" in result
        assert "exit code: 0" in result

    async def test_no_args_still_works(self, module, echo_script) -> None:
        """Calling without args should still execute and echo an empty argv."""
        result = await module.execute_code_script(echo_script, [])
        assert "ARGV:" in result
        assert "exit code: 0" in result
