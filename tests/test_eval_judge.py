# noqa: N999
"""Tests for eval-llm-judge.py (LLM judge layer of the plugin-eval pipeline).

The HTTP call is mocked at urllib.request.urlopen — no network access.
Covers: graceful no-key failure, successful scoring shape, fenced-JSON
tolerance, HTTP error handling, and out-of-range score rejection.
"""

from __future__ import annotations

import importlib.util
import io
import json
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

SCRIPT_PATH = (
    Path(__file__).resolve().parent.parent / ".pantheon" / "code-mode" / "eval-llm-judge.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("eval_llm_judge", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MOD = _load_module()

VALID_SCORES = {
    "correctness": 82,
    "maintainability": 74,
    "security": 95,
    "practicality": 66,
    "notes": {"correctness": "ok", "maintainability": "fine", "security": "clean", "practicality": "meh"},
}


class _FakeResponse:
    """Minimal context-manager stand-in for urllib's HTTP response."""

    def __init__(self, content: str) -> None:
        self._payload = json.dumps(
            {"choices": [{"message": {"role": "assistant", "content": content}}]}
        ).encode("utf-8")

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def read(self) -> bytes:
        return self._payload


def _fake_response(content: str) -> _FakeResponse:
    return _FakeResponse(content)


@pytest.fixture()
def skill_dir(tmp_path: Path) -> Path:
    skill = tmp_path / "my-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: my-skill\ndescription: A test skill\n---\n# Steps\nDo the thing.\n",
        encoding="utf-8",
    )
    return skill


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch):
    for var in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "EVAL_JUDGE_MODEL"):
        monkeypatch.delenv(var, raising=False)


def test_no_api_key_exits_2(skill_dir: Path, capsys: pytest.CaptureFixture[str]):
    """Without OPENAI_API_KEY the judge fails gracefully with exit code 2."""
    exit_code = MOD.main([str(skill_dir)])
    assert exit_code == 2
    assert "OPENAI_API_KEY" in capsys.readouterr().err


def test_successful_judgement_shape(
    skill_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    """A valid LLM reply yields the spec'd JSON shape and one structured POST."""
    captured: dict[str, Any] = {}

    def fake_urlopen(request, timeout):  # noqa: ANN001, ARG001
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data.decode("utf-8"))
        return _fake_response(json.dumps(VALID_SCORES))

    monkeypatch.setattr(MOD.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("EVAL_JUDGE_MODEL", "judge-x")

    exit_code = MOD.main([str(skill_dir)])
    out = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert out["name"] == "my-skill"
    assert out["dimensions"] == {
        "correctness": 82,
        "maintainability": 74,
        "security": 95,
        "practicality": 66,
    }
    assert out["overall"] == round((82 + 74 + 95 + 66) / 4, 1)
    assert set(out["notes"]) == set(MOD.DIMENSIONS)
    # One call, correct endpoint/model, anti-slop bias present in the prompt.
    assert captured["url"] == "https://api.openai.com/v1/chat/completions"
    assert len(captured["body"]["messages"]) == 1
    assert captured["body"]["model"] == "judge-x"
    assert "ANTI-SLOP" in captured["body"]["messages"][0]["content"]


def test_openai_base_url_override(
    skill_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    """OPENAI_BASE_URL redirects the endpoint; default model applies otherwise."""
    seen_urls: list[str] = []

    def fake_urlopen(request, timeout):  # noqa: ANN001, ARG001
        seen_urls.append(request.full_url)
        return _fake_response(json.dumps(VALID_SCORES))

    monkeypatch.setattr(MOD.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:8000/v1/")

    exit_code = MOD.main([str(skill_dir)])
    assert exit_code == 0
    assert seen_urls == ["http://localhost:8000/v1/chat/completions"]
    assert json.loads(capsys.readouterr().out)["overall"] == 79.2


def test_fenced_json_accepted(skill_dir: Path, monkeypatch: pytest.MonkeyPatch):
    """Models that wrap JSON in code fences are still parsed."""
    fenced = "```json\n" + json.dumps(VALID_SCORES) + "\n```"

    def fake_urlopen(request, timeout):  # noqa: ANN001, ARG001
        return _fake_response(fenced)

    monkeypatch.setattr(MOD.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    assert MOD.main([str(skill_dir)]) == 0


def test_http_error_exits_2(skill_dir: Path, monkeypatch: pytest.MonkeyPatch):
    """An HTTP error from the endpoint surfaces as a clean exit-2 message."""
    def fake_urlopen(request, timeout):  # noqa: ANN001, ARG001
        raise urllib.error.HTTPError(
            request.full_url, 503, "unavailable", None, io.BytesIO(b"down")
        )

    monkeypatch.setattr(MOD.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    assert MOD.main([str(skill_dir)]) == 2


def test_out_of_range_score_exits_2(skill_dir: Path, monkeypatch: pytest.MonkeyPatch):
    """Scores outside 0-100 are rejected instead of trusted."""
    bad = {**VALID_SCORES, "security": 150}

    def fake_urlopen(request, timeout):  # noqa: ANN001, ARG001
        return _fake_response(json.dumps(bad))

    monkeypatch.setattr(MOD.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    assert MOD.main([str(skill_dir)]) == 2
