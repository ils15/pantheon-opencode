"""
Node harness wrapper for model-routing presets tests.

Runs tests/test_presets.mjs (T1-T32: resolver, validator, set-tier CLI,
picker, validate-routing, npm packaging, vision capability) as a
subprocess, mirroring the existing node subprocess test pattern.
"""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_presets_node_harness() -> None:
    result = subprocess.run(
        ["node", "tests/test_presets.mjs"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=360,
    )
    assert result.returncode == 0, (
        f"node tests/test_presets.mjs failed (exit {result.returncode}):\n"
        f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
    )
    assert "35 passed" in result.stdout, (
        f"expected 32 passing tests, got:\n{result.stdout}"
    )
