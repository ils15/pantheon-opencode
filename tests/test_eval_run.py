"""Tests for eval-run.py — plugin-eval orchestrator.

Loads the script from .pantheon/code-mode/ via importlib (same pattern as
test_eval_static.py). Focus: layer scripts that exit non-zero after printing
a valid report JSON (below-threshold signal) must still contribute their
score to the overall report instead of being discarded as errors.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = ROOT / ".pantheon" / "code-mode" / "eval-run.py"

_RELIABILITY_BELOW = 60.0
_RELIABILITY_ABOVE = 90.0
_STATIC_SCORE = 70
_MONTE_RELIABILITY = 65.0
_EXPECTED_LAYERS = 2
_EXPECTED_OVERALL = 67.5
_CERTIFY_SCORE = 80.0

_get_module_cache = None


def _get_module():
    """Load and cache the eval-run module."""
    global _get_module_cache  # noqa: PLW0603
    if _get_module_cache is not None:
        return _get_module_cache
    spec = importlib.util.spec_from_file_location("eval_run", str(SCRIPT_PATH))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    _get_module_cache = mod
    return mod


@pytest.fixture
def mod():
    """Return the eval-run module."""
    return _get_module()


def _write_layer(path: Path, body: str) -> Path:
    """Write a fake layer script that runs under the current interpreter."""
    path.write_text(body, encoding="utf-8")
    return path


class TestRunLayerBelowThreshold:
    """_run_layer must parse stdout JSON even when the script exits non-zero."""

    def test_nonzero_exit_with_valid_json(self, mod, tmp_path: Path) -> None:
        script = _write_layer(
            tmp_path / "layer.py",
            "import json\nprint(json.dumps({'reliability': 60.0}))\n"
            "raise SystemExit(1)\n",
        )
        result = mod._run_layer(script, "target")
        assert result.get("error") is None
        assert result["reliability"] == _RELIABILITY_BELOW
        assert result["below_threshold"] is True

    def test_zero_exit_has_no_marker(self, mod, tmp_path: Path) -> None:
        script = _write_layer(
            tmp_path / "layer.py",
            "import json\nprint(json.dumps({'reliability': 90.0}))\n",
        )
        result = mod._run_layer(script, "target")
        assert result["reliability"] == _RELIABILITY_ABOVE
        assert "below_threshold" not in result

    def test_nonzero_exit_with_invalid_json_is_error(self, mod, tmp_path: Path) -> None:
        script = _write_layer(
            tmp_path / "layer.py",
            "print('not json')\nimport sys\nsys.stderr.write('boom')\n"
            "raise SystemExit(1)\n",
        )
        result = mod._run_layer(script, "target")
        assert "error" in result
        assert "boom" in result["error"]

    def test_nonzero_exit_empty_stdout_reports_exit_code(
        self, mod, tmp_path: Path
    ) -> None:
        script = _write_layer(tmp_path / "layer.py", "raise SystemExit(3)\n")
        result = mod._run_layer(script, "target")
        assert "error" in result
        assert "exited 3" in result["error"]

    def test_zero_exit_with_invalid_json_is_error(self, mod, tmp_path: Path) -> None:
        script = _write_layer(tmp_path / "layer.py", "print('not json')\n")
        result = mod._run_layer(script, "target")
        assert "error" in result
        assert "invalid JSON" in result["error"]

    def test_timeout_is_error(self, mod, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        script = _write_layer(tmp_path / "layer.py", "import time\ntime.sleep(30)\n")
        monkeypatch.setattr(mod, "LAYER_TIMEOUT", 1.0)
        result = mod._run_layer(script, "target")
        assert "timed out" in result.get("error", "")


class TestMainAggregation:
    """main() must count below-threshold scores toward the overall verdict."""

    @pytest.fixture
    def wired_mod(self, mod, tmp_path: Path):
        """Point all layer scripts at fakes inside tmp_path."""

        def wire(static_body: str | None, monte_body: str | None) -> None:
            if static_body is not None:
                mod.STATIC_SCRIPT = _write_layer(tmp_path / "static.py", static_body)
            else:
                mod.STATIC_SCRIPT = tmp_path / "missing-static.py"
            mod.JUDGE_SCRIPT = tmp_path / "missing-judge.py"
            if monte_body is not None:
                mod.MONTE_SCRIPT = _write_layer(tmp_path / "monte.py", monte_body)
            else:
                mod.MONTE_SCRIPT = tmp_path / "missing-monte.py"

        return wire

    def test_below_threshold_scores_counted(self, mod, wired_mod, tmp_path: Path, capsys) -> None:
        target = tmp_path / "my-skill"
        target.mkdir()
        (target / "SKILL.md").write_text(
            "---\nname: my-skill\ndescription: d\n---\n# t\n", encoding="utf-8"
        )
        wired_mod(
            static_body=(
                "import json\nprint(json.dumps({'score': 70}))\nraise SystemExit(1)\n"
            ),
            monte_body=(
                "import json\nprint(json.dumps({'reliability': 65.0}))\n"
                "raise SystemExit(1)\n"
            ),
        )
        rc = mod.main([str(target), "--skip-llm"])
        assert rc == 0
        report = json.loads(capsys.readouterr().out)
        # (70 + 65) / 2 = 67.5 → needs_work; both layers scored despite exit 1.
        assert report["layers_scored"] == _EXPECTED_LAYERS
        assert report["overall_score"] == _EXPECTED_OVERALL
        assert report["verdict"] == "needs_work"
        assert report["monte_carlo"]["below_threshold"] is True
        assert report["static"]["below_threshold"] is True

    def test_error_layer_excluded_from_score(self, mod, wired_mod, tmp_path: Path, capsys) -> None:
        target = tmp_path / "my-skill"
        target.mkdir()
        (target / "SKILL.md").write_text(
            "---\nname: my-skill\ndescription: d\n---\n# t\n", encoding="utf-8"
        )
        wired_mod(
            static_body="import json\nprint(json.dumps({'score': 80}))\n",
            monte_body=None,
        )
        rc = mod.main([str(target), "--skip-llm"])
        assert rc == 0
        report = json.loads(capsys.readouterr().out)
        assert report["layers_scored"] == 1
        assert report["overall_score"] == _CERTIFY_SCORE
        assert report["verdict"] == "certified"
