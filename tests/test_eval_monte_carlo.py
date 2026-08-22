"""Security tests for Monte Carlo command execution."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parent.parent / ".pantheon" / "code-mode" / "eval-monte-carlo.py"
spec = importlib.util.spec_from_file_location("eval_monte_carlo", SCRIPT_PATH)
assert spec is not None and spec.loader is not None
MOD = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MOD)


@pytest.mark.parametrize("command", ["python -c 'print(1);'", "python -c 'print(1)' && touch pwned", "python -c 'print(1)' | cat", "python -c 'print(1)' $(touch pwned)"])
def test_shell_injection_is_rejected(command: str, tmp_path: Path) -> None:
    ok, reason = MOD._run_test_command(command, tmp_path)
    assert not ok
    assert "unsafe" in reason
    assert not (tmp_path / "pwned").exists()


def test_safe_command_executes_without_shell(tmp_path: Path) -> None:
    ok, reason = MOD._run_test_command("python3 -c 'print(1)'", tmp_path)
    assert ok, reason


def test_unsupported_command_is_rejected(tmp_path: Path) -> None:
    ok, reason = MOD._run_test_command("curl https://example.test", tmp_path)
    assert not ok
    assert "unsupported command" in reason


def test_timeout_kills_process_group(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(MOD, "TEST_TIMEOUT", 0.05)
    ok, reason = MOD._run_test_command("""python3 -c 'exec(\"import time\\ntime.sleep(10)\")'""", tmp_path)
    assert not ok
    assert "timed out" in reason
