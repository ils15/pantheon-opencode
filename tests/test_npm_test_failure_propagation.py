"""Regression tests for npm test exit-status propagation."""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent.parent


def _npm_script(name: str) -> str:
    package = json.loads((ROOT / "package.json").read_text())
    return package["scripts"][name]


def test_test_scripts_do_not_mask_failures() -> None:
    """The npm test entry points must preserve pytest's exit status."""
    assert "||" not in _npm_script("test")
    assert "||" not in _npm_script("test:ci")


def test_deliberately_failing_pytest_exits_nonzero(tmp_path: Path) -> None:
    """A failing pytest invocation modeled on npm test must fail the shell."""
    test_dir = tmp_path / "tests"
    test_dir.mkdir()
    (test_dir / "test_failure.py").write_text(
        "def test_expected_failure():\n    assert False\n"
    )

    command = _npm_script("test").replace("tests/", f"{test_dir}/", 1)
    result = subprocess.run(
        command,
        cwd=ROOT,
        shell=True,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0, result.stdout + result.stderr
