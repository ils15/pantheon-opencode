"""Plugin-eval pipeline tests: store, static checks, LLM judge, orchestrator, Monte Carlo.

Consolidated from the former ``test_eval_{store,static,judge,run,monte_carlo}.py``
modules. Only real behavioural contracts are asserted here:

* ``eval_store`` persistence semantics (namespace, key shape, uniqueness, ordering);
* ``eval-static.py`` structural/secret/file-size checks and exit codes;
* ``eval-llm-judge.py`` explicit opt-in, endpoint handling and reply parsing;
* ``eval-run.py`` below-threshold aggregation and layer error handling;
* ``eval-monte-carlo.py`` shell-injection guard around test commands.
"""

from __future__ import annotations

import importlib
import importlib.util
import io
import json
import sqlite3
import subprocess
import sys
import urllib.error
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent
CODE_MODE = ROOT / ".pantheon" / "code-mode"


# --------------------------------------------------------------------------- #
# Module loaders                                                              #
# --------------------------------------------------------------------------- #


def _load_script(filename: str) -> Any:
    """Load a ``.pantheon/code-mode`` script as an importable module."""
    path = CODE_MODE / filename
    spec = importlib.util.spec_from_file_location(filename.removesuffix(".py"), path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def static_mod() -> Any:
    """Return the eval-static module."""
    return _load_script("eval-static.py")


@pytest.fixture(scope="module")
def judge_mod() -> Any:
    """Return the eval-llm-judge module."""
    return _load_script("eval-llm-judge.py")


@pytest.fixture(scope="module")
def run_mod() -> Any:
    """Return the eval-run module."""
    return _load_script("eval-run.py")


@pytest.fixture(scope="module")
def monte_mod() -> Any:
    """Return the eval-monte-carlo module."""
    return _load_script("eval-monte-carlo.py")


# --------------------------------------------------------------------------- #
# eval_store.py                                                               #
# --------------------------------------------------------------------------- #


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Import eval_store with the DB pointed at a temp dir."""
    module = importlib.import_module("src.mcp.eval_store")
    db_path = tmp_path / "memory" / "memory.db"
    monkeypatch.setattr(module, "_db_path", lambda: db_path)
    return module


def test_store_writes_namespace_and_key(store: Any) -> None:
    """store_eval writes to the plugin_eval namespace with eval:<name>:<date> key."""
    result = store.store_eval("my-skill", {"name": "my-skill", "score": 90}, 90)
    assert result["status"] == "stored"
    assert result["namespace"] == "plugin_eval"
    assert result["key"].startswith("eval:my-skill:")


def test_store_metadata_has_type_and_score(store: Any) -> None:
    """Metadata JSON carries type=eval and the numeric score."""
    store.store_eval("my-skill", {"score": 75}, 75)
    entries = store.list_evals()
    assert len(entries) == 1
    assert entries[0]["metadata"]["type"] == "eval"
    assert entries[0]["metadata"]["score"] == 75


def test_store_value_is_report_json(store: Any) -> None:
    """The stored value is the JSON-serialized report."""
    report = {"name": "my-skill", "score": 88, "checks": {"yaml": {"pass": True}}}
    store.store_eval("my-skill", report, 88)
    assert json.loads(store.list_evals()[0]["value"]) == report


def test_store_duplicate_key_returns_error(store: Any) -> None:
    """Storing the same name+date twice returns an error (unique ns+key)."""
    store.store_eval("my-skill", {"score": 90}, 90)
    assert "error" in store.store_eval("my-skill", {"score": 91}, 91)


def test_store_custom_date_key(store: Any) -> None:
    """An explicit date is used in the key."""
    result = store.store_eval("my-skill", {"score": 90}, 90, when="2026-01-01")
    assert result["key"] == "eval:my-skill:2026-01-01"


def test_list_evals_empty_namespace(store: Any) -> None:
    """list_evals on an empty namespace returns []."""
    assert store.list_evals() == []


def test_list_evals_newest_first(store: Any) -> None:
    """Entries are returned newest first."""
    store.store_eval("a", {"score": 1}, 1, when="2026-01-01")
    store.store_eval("b", {"score": 2}, 2, when="2026-01-02")
    keys = [e["key"] for e in store.list_evals()]
    assert keys == ["eval:b:2026-01-02", "eval:a:2026-01-01"]


def test_list_evals_latest_per_plugin(store: Any) -> None:
    """list_evals returns only the latest entry per plugin name."""
    store.store_eval("my-skill", {"score": 80}, 80, when="2026-01-01")
    store.store_eval("my-skill", {"score": 95}, 95, when="2026-01-02")
    store.store_eval("other", {"score": 70}, 70, when="2026-01-01")
    entries = store.list_evals()
    assert [e["name"] for e in entries] == ["my-skill", "other"]
    by_name = {e["name"]: e for e in entries}
    assert by_name["my-skill"]["metadata"]["score"] == 95


def test_get_latest_eval_returns_newest(store: Any) -> None:
    """get_latest_eval returns the newest entry for a plugin."""
    store.store_eval("my-skill", {"score": 80}, 80, when="2026-01-01")
    store.store_eval("my-skill", {"score": 95}, 95, when="2026-01-02")
    entry = store.get_latest_eval("my-skill")
    assert entry is not None
    assert entry["metadata"]["score"] == 95


def test_get_latest_eval_missing_returns_none(store: Any) -> None:
    """get_latest_eval for an unknown plugin returns None."""
    assert store.get_latest_eval("ghost") is None


def test_get_latest_eval_ignores_other_namespaces(store: Any) -> None:
    """Entries outside plugin_eval are not returned."""
    store.store_eval("my-skill", {"score": 90}, 90)
    conn = sqlite3.connect(str(store._db_path()))
    conn.execute(
        "INSERT INTO memories (namespace, key, value, metadata, created_at, updated_at)"
        " VALUES ('council_decisions', 'council:x', '{}', '{}',"
        " '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
    )
    conn.commit()
    conn.close()
    assert store.get_latest_eval("x") is None
    assert len(store.list_evals()) == 1


# --------------------------------------------------------------------------- #
# eval-static.py                                                              #
# --------------------------------------------------------------------------- #

_OPENAI_KEY = "sk-" + "abcdefghijklmnopqrstuvwxyz123456"
_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"
_PEM_BEGIN = "-----BEGIN " + "RSA PRIVATE KEY-----"
_PEM_END = "-----END " + "RSA PRIVATE KEY-----"
_PASSWORD = "pass" + "word = 'hunter2secretvalue'"


def _write_skill(
    directory: Path,
    fm: str = "name: my-skill\ndescription: A test skill",
    body: str = "# My Skill\n",
) -> None:
    """Write a SKILL.md with the given frontmatter/body into directory."""
    (directory / "SKILL.md").write_text(f"---\n{fm}\n---\n\n{body}", encoding="utf-8")


@pytest.fixture
def skill_dir(tmp_path: Path) -> Path:
    """A minimal valid skill directory."""
    directory = tmp_path / "my-skill"
    directory.mkdir()
    _write_skill(directory)
    return directory


def test_static_valid_skill_cli_exit_zero(tmp_path: Path) -> None:
    """Valid dir → exit 0, JSON on stdout with spec shape and score 100."""
    directory = tmp_path / "cli-skill"
    directory.mkdir()
    _write_skill(directory, body="See [guide](guide.md).\n")
    (directory / "guide.md").write_text("# g\n", encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, str(CODE_MODE / "eval-static.py"), str(directory)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["name"] == "my-skill"  # frontmatter name wins over dir name
    assert report["score"] == 100
    assert {c["check"] for c in report["checks"]} == {
        "frontmatter",
        "referenced_files",
        "secrets",
        "file_size",
        "yaml",
    }
    assert all(c["pass"] is True and c["detail"] for c in report["checks"])


def test_static_frontmatter_check(static_mod: Any, tmp_path: Path) -> None:
    """Missing manifest/name/description fail; agent .md files are accepted."""
    cases = [
        ("no-manifest", lambda d: None),
        ("missing-name", lambda d: _write_skill(d, fm="description: only")),
        ("missing-desc", lambda d: _write_skill(d, fm="name: only")),
        ("empty-name", lambda d: _write_skill(d, fm='name: ""\ndescription: x')),
    ]
    for label, setup in cases:
        directory = tmp_path / label
        directory.mkdir()
        setup(directory)
        ok, detail = static_mod.check_frontmatter(directory)
        assert ok is False, label
        assert detail, label

    agent = tmp_path / "agent-dir"
    agent.mkdir()
    (agent / "hermes.md").write_text(
        "---\nname: hermes\ndescription: Backend specialist\n---\n", encoding="utf-8"
    )
    ok, detail = static_mod.check_frontmatter(agent)
    assert ok is True
    assert "hermes.md" in detail


def test_static_referenced_files_check(static_mod: Any, skill_dir: Path) -> None:
    """Existing refs pass; missing frontmatter/markdown refs fail with name."""
    (skill_dir / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    (skill_dir / "guide.md").write_text("# g\n", encoding="utf-8")
    _write_skill(
        skill_dir,
        fm="name: my-skill\ndescription: d\nscripts:\n  - run.sh",
        body="See [guide](guide.md), [ext](https://example.com/x), [a](#sec).\n",
    )
    assert static_mod.check_referenced_files(skill_dir)[0] is True

    _write_skill(
        skill_dir, fm="name: my-skill\ndescription: d\nscripts:\n  - missing.py"
    )
    ok, detail = static_mod.check_referenced_files(skill_dir)
    assert ok is False
    assert "missing.py" in detail

    _write_skill(skill_dir, body="See [ghost](ghost.md).\n")
    ok, detail = static_mod.check_referenced_files(skill_dir)
    assert ok is False
    assert "ghost.md" in detail


def test_static_secrets_check(static_mod: Any, skill_dir: Path) -> None:
    """Clean dirs pass; API keys, AWS ids, PEM blocks, passwords fail."""
    assert static_mod.check_secrets(skill_dir)[0] is True

    payloads = {
        "SKILL.md": f"key: {_OPENAI_KEY}",
        "cfg.yaml": f"aws_key: {_AWS_KEY}",
        "k.pem": f"{_PEM_BEGIN}\nMIIEow\n{_PEM_END}",
        "note.md": _PASSWORD,
    }
    for fname, content in payloads.items():
        target = skill_dir / fname
        original = target.read_text(encoding="utf-8") if target.exists() else ""
        target.write_text(f"{original}\n{content}", encoding="utf-8")
        ok, detail = static_mod.check_secrets(skill_dir)
        assert ok is False, fname
        assert "secret" in detail.lower(), fname
        target.write_text(original, encoding="utf-8")

    assert static_mod.check_secrets(skill_dir)[0] is True


def test_static_file_size_check(static_mod: Any, skill_dir: Path) -> None:
    """Files under the cap pass; an oversized file fails naming the file."""
    assert static_mod.check_file_sizes(skill_dir)[0] is True

    big = skill_dir / "huge.bin"
    big.write_bytes(b"x" * (static_mod.MAX_FILE_SIZE + 1))
    ok, detail = static_mod.check_file_sizes(skill_dir)
    assert ok is False
    assert "huge.bin" in detail

    big.unlink()
    assert static_mod.check_file_sizes(skill_dir)[0] is True


def test_static_yaml_check(static_mod: Any, skill_dir: Path) -> None:
    """Valid frontmatter parses; broken YAML fails; no frontmatter passes."""
    assert static_mod.check_yaml(skill_dir)[0] is True

    (skill_dir / "SKILL.md").write_text(
        "---\nname: [unclosed\ndescription: x\n---\n", encoding="utf-8"
    )
    ok, detail = static_mod.check_yaml(skill_dir)
    assert ok is False
    assert detail

    (skill_dir / "SKILL.md").write_text("# Just a heading\n", encoding="utf-8")
    assert static_mod.check_yaml(skill_dir)[0] is True


def test_static_run_eval_report_shape_and_score(
    static_mod: Any, skill_dir: Path
) -> None:
    """run_eval returns {name, checks[], score}; failures lower the score."""
    report = static_mod.run_eval(skill_dir)
    assert report["name"] == "my-skill"
    assert report["score"] == 100
    assert len(report["checks"]) == 5

    (skill_dir / "SKILL.md").write_text(
        "---\ndescription: no name\n---\n", encoding="utf-8"
    )
    report = static_mod.run_eval(skill_dir)
    assert report["score"] == 80  # 4 of 5 checks pass
    by_name = {c["check"]: c for c in report["checks"]}
    assert by_name["frontmatter"]["pass"] is False


def test_static_main_exit_codes(static_mod: Any, skill_dir: Path, capsys) -> None:
    """Exit 2 usage errors; exit 1 failing eval still prints JSON."""
    assert static_mod.main([]) == 2
    assert "usage" in capsys.readouterr().err.lower()

    assert static_mod.main(["/nonexistent/path/xyz"]) == 2
    assert "not found" in capsys.readouterr().err.lower()

    assert static_mod.main([str(skill_dir / "SKILL.md")]) == 2
    assert "not a directory" in capsys.readouterr().err.lower()

    (skill_dir / "SKILL.md").write_text(
        "---\ndescription: no name\n---\n", encoding="utf-8"
    )
    code = static_mod.main([str(skill_dir)])
    assert code == 1
    assert json.loads(capsys.readouterr().out)["score"] < 100


# --------------------------------------------------------------------------- #
# eval-llm-judge.py                                                           #
# --------------------------------------------------------------------------- #

_VALID_SCORES = {
    "correctness": 82,
    "maintainability": 74,
    "security": 95,
    "practicality": 66,
    "notes": {
        "correctness": "ok",
        "maintainability": "fine",
        "security": "clean",
        "practicality": "meh",
    },
}


class _FakeResponse:
    """Minimal context-manager stand-in for urllib's HTTP response."""

    def __init__(self, content: str) -> None:
        self._payload = json.dumps(
            {"choices": [{"message": {"role": "assistant", "content": content}}]}
        ).encode("utf-8")

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def read(self) -> bytes:
        return self._payload


def _fake_response(content: str) -> _FakeResponse:
    return _FakeResponse(content)


@pytest.fixture
def judge_skill_dir(tmp_path: Path) -> Path:
    """A minimal skill dir for the judge to evaluate."""
    skill = tmp_path / "my-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: my-skill\ndescription: A test skill\n---\n# Steps\nDo the thing.\n",
        encoding="utf-8",
    )
    return skill


@pytest.fixture(autouse=True)
def _clean_judge_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in (
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "EVAL_JUDGE_MODEL",
        "PANTHEON_ALLOW_EXTERNAL_LLM",
    ):
        monkeypatch.delenv(var, raising=False)


def test_judge_no_opt_in_is_structured_skip_without_network(
    judge_mod: Any, judge_skill_dir: Path, capsys
) -> None:
    """Without explicit opt-in, content is never sent and the result is non-error."""
    assert judge_mod.main([str(judge_skill_dir)]) == 0
    assert json.loads(capsys.readouterr().out)["skipped"] is True


def test_judge_opt_in_without_api_key_exits_2(
    judge_mod: Any, judge_skill_dir: Path, capsys
) -> None:
    """Opt-in without credentials remains a clear configuration error."""
    assert judge_mod.main([str(judge_skill_dir), "--allow-external-llm"]) == 2
    assert "OPENAI_API_KEY" in capsys.readouterr().err


def test_judge_successful_judgement_shape(
    judge_mod: Any,
    judge_skill_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys,
) -> None:
    """A valid LLM reply yields the spec'd JSON shape and one structured POST."""
    captured: dict[str, Any] = {}

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data.decode("utf-8"))
        return _fake_response(json.dumps(_VALID_SCORES))

    monkeypatch.setattr(judge_mod.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("EVAL_JUDGE_MODEL", "judge-x")
    monkeypatch.setenv("PANTHEON_ALLOW_EXTERNAL_LLM", "1")

    exit_code = judge_mod.main([str(judge_skill_dir)])
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
    assert set(out["notes"]) == set(judge_mod.DIMENSIONS)
    # One call, correct endpoint/model, anti-slop bias present in the prompt.
    assert captured["url"] == "https://api.openai.com/v1/chat/completions"
    assert len(captured["body"]["messages"]) == 1
    assert captured["body"]["model"] == "judge-x"
    assert "ANTI-SLOP" in captured["body"]["messages"][0]["content"]


def test_judge_base_url_override(
    judge_mod: Any,
    judge_skill_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys,
) -> None:
    """OPENAI_BASE_URL redirects the endpoint; default model applies otherwise."""
    seen_urls: list[str] = []

    def fake_urlopen(request, timeout):
        seen_urls.append(request.full_url)
        return _fake_response(json.dumps(_VALID_SCORES))

    monkeypatch.setattr(judge_mod.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:8000/v1/")
    monkeypatch.setenv("PANTHEON_ALLOW_EXTERNAL_LLM", "1")

    assert judge_mod.main([str(judge_skill_dir)]) == 0
    assert seen_urls == ["http://localhost:8000/v1/chat/completions"]
    assert json.loads(capsys.readouterr().out)["overall"] == 79.2


def test_judge_invalid_endpoint_is_rejected(
    judge_mod: Any,
    judge_skill_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys,
) -> None:
    """Non-http(s) endpoints are refused before any request is made."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OPENAI_BASE_URL", "file:///tmp/not-http")
    assert judge_mod.main([str(judge_skill_dir), "--allow-external-llm"]) == 2
    assert "http or https" in capsys.readouterr().err


def test_judge_request_timeout_is_reported(
    judge_mod: Any,
    judge_skill_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys,
) -> None:
    """A timeout surfaces as a clean exit-2 message using the configured timeout."""

    def timeout_urlopen(request, timeout):
        assert timeout == judge_mod.REQUEST_TIMEOUT
        raise TimeoutError("slow endpoint")

    monkeypatch.setattr(judge_mod.urllib.request, "urlopen", timeout_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    assert judge_mod.main([str(judge_skill_dir), "--allow-external-llm"]) == 2
    assert "LLM request failed" in capsys.readouterr().err


def test_judge_fenced_json_accepted(
    judge_mod: Any, judge_skill_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Models that wrap JSON in code fences are still parsed."""
    fenced = "```json\n" + json.dumps(_VALID_SCORES) + "\n```"

    def fake_urlopen(request, timeout):
        return _fake_response(fenced)

    monkeypatch.setattr(judge_mod.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("PANTHEON_ALLOW_EXTERNAL_LLM", "1")

    assert judge_mod.main([str(judge_skill_dir)]) == 0


def test_judge_http_error_exits_2(
    judge_mod: Any, judge_skill_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An HTTP error from the endpoint surfaces as a clean exit-2 message."""

    def fake_urlopen(request, timeout):
        raise urllib.error.HTTPError(
            request.full_url, 503, "unavailable", None, io.BytesIO(b"down")
        )

    monkeypatch.setattr(judge_mod.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("PANTHEON_ALLOW_EXTERNAL_LLM", "1")

    assert judge_mod.main([str(judge_skill_dir)]) == 2


def test_judge_out_of_range_score_exits_2(
    judge_mod: Any, judge_skill_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Scores outside 0-100 are rejected instead of trusted."""
    bad = {**_VALID_SCORES, "security": 150}

    def fake_urlopen(request, timeout):
        return _fake_response(json.dumps(bad))

    monkeypatch.setattr(judge_mod.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("PANTHEON_ALLOW_EXTERNAL_LLM", "1")

    assert judge_mod.main([str(judge_skill_dir)]) == 2


# --------------------------------------------------------------------------- #
# eval-run.py                                                                 #
# --------------------------------------------------------------------------- #

_RELIABILITY_BELOW = 60.0
_RELIABILITY_ABOVE = 90.0
_STATIC_SCORE = 70
_MONTE_RELIABILITY = 65.0
_EXPECTED_LAYERS = 2
_EXPECTED_OVERALL = 67.5
_CERTIFY_SCORE = 80.0


def _write_layer(path: Path, body: str) -> Path:
    """Write a fake layer script that runs under the current interpreter."""
    path.write_text(body, encoding="utf-8")
    return path


def test_run_layer_nonzero_exit_with_valid_json(run_mod: Any, tmp_path: Path) -> None:
    """_run_layer must parse stdout JSON even when the script exits non-zero."""
    script = _write_layer(
        tmp_path / "layer.py",
        "import json\nprint(json.dumps({'reliability': 60.0}))\nraise SystemExit(1)\n",
    )
    result = run_mod._run_layer(script, "target")
    assert result.get("error") is None
    assert result["reliability"] == _RELIABILITY_BELOW
    assert result["below_threshold"] is True


def test_run_layer_zero_exit_has_no_marker(run_mod: Any, tmp_path: Path) -> None:
    """A compliant layer is not marked below_threshold."""
    script = _write_layer(
        tmp_path / "layer.py",
        "import json\nprint(json.dumps({'reliability': 90.0}))\n",
    )
    result = run_mod._run_layer(script, "target")
    assert result["reliability"] == _RELIABILITY_ABOVE
    assert "below_threshold" not in result


def test_run_layer_nonzero_exit_with_invalid_json_is_error(
    run_mod: Any, tmp_path: Path
) -> None:
    """A non-zero exit with unparsable stdout is an error carrying stderr."""
    script = _write_layer(
        tmp_path / "layer.py",
        "print('not json')\nimport sys\nsys.stderr.write('boom')\nraise SystemExit(1)\n",
    )
    result = run_mod._run_layer(script, "target")
    assert "error" in result
    assert "boom" in result["error"]


def test_run_layer_nonzero_exit_empty_stdout_reports_exit_code(
    run_mod: Any, tmp_path: Path
) -> None:
    """A non-zero exit with empty stdout reports the exit code."""
    script = _write_layer(tmp_path / "layer.py", "raise SystemExit(3)\n")
    result = run_mod._run_layer(script, "target")
    assert "error" in result
    assert "exited 3" in result["error"]


def test_run_layer_zero_exit_with_invalid_json_is_error(
    run_mod: Any, tmp_path: Path
) -> None:
    """Zero exit with unparsable stdout is still an error."""
    script = _write_layer(tmp_path / "layer.py", "print('not json')\n")
    result = run_mod._run_layer(script, "target")
    assert "error" in result
    assert "invalid JSON" in result["error"]


def test_run_layer_timeout_is_error(
    run_mod: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A layer exceeding LAYER_TIMEOUT is reported as a timeout."""
    script = _write_layer(tmp_path / "layer.py", "import time\ntime.sleep(30)\n")
    monkeypatch.setattr(run_mod, "LAYER_TIMEOUT", 1.0)
    result = run_mod._run_layer(script, "target")
    assert "timed out" in result.get("error", "")


@pytest.fixture
def wired_layers(run_mod: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point all layer scripts at fakes inside tmp_path."""

    def wire(static_body: str | None, monte_body: str | None) -> None:
        if static_body is not None:
            monkeypatch.setattr(
                run_mod,
                "STATIC_SCRIPT",
                _write_layer(tmp_path / "static.py", static_body),
            )
        else:
            monkeypatch.setattr(
                run_mod, "STATIC_SCRIPT", tmp_path / "missing-static.py"
            )
        monkeypatch.setattr(run_mod, "JUDGE_SCRIPT", tmp_path / "missing-judge.py")
        if monte_body is not None:
            monkeypatch.setattr(
                run_mod, "MONTE_SCRIPT", _write_layer(tmp_path / "monte.py", monte_body)
            )
        else:
            monkeypatch.setattr(run_mod, "MONTE_SCRIPT", tmp_path / "missing-monte.py")

    return wire


def test_run_below_threshold_scores_counted(
    run_mod: Any, wired_layers, tmp_path: Path, capsys
) -> None:
    """main() must count below-threshold scores toward the overall verdict."""
    target = tmp_path / "my-skill"
    target.mkdir()
    (target / "SKILL.md").write_text(
        "---\nname: my-skill\ndescription: d\n---\n# t\n", encoding="utf-8"
    )
    wired_layers(
        static_body="import json\nprint(json.dumps({'score': 70}))\nraise SystemExit(1)\n",
        monte_body="import json\nprint(json.dumps({'reliability': 65.0}))\nraise SystemExit(1)\n",
    )
    assert run_mod.main([str(target), "--skip-llm"]) == 0
    report = json.loads(capsys.readouterr().out)
    # (70 + 65) / 2 = 67.5 → needs_work; both layers scored despite exit 1.
    assert report["layers_scored"] == _EXPECTED_LAYERS
    assert report["overall_score"] == _EXPECTED_OVERALL
    assert report["verdict"] == "needs_work"
    assert report["monte_carlo"]["below_threshold"] is True
    assert report["static"]["below_threshold"] is True


def test_run_error_layer_excluded_from_score(
    run_mod: Any, wired_layers, tmp_path: Path, capsys
) -> None:
    """A layer that errors is excluded from the aggregate score."""
    target = tmp_path / "my-skill"
    target.mkdir()
    (target / "SKILL.md").write_text(
        "---\nname: my-skill\ndescription: d\n---\n# t\n", encoding="utf-8"
    )
    wired_layers(
        static_body="import json\nprint(json.dumps({'score': 80}))\n",
        monte_body=None,
    )
    assert run_mod.main([str(target), "--skip-llm"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["layers_scored"] == 1
    assert report["overall_score"] == _CERTIFY_SCORE
    assert report["verdict"] == "certified"


# --------------------------------------------------------------------------- #
# eval-monte-carlo.py                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "command",
    [
        "python -c 'print(1);'",
        "python -c 'print(1)' && touch pwned",
        "python -c 'print(1)' | cat",
        "python -c 'print(1)' $(touch pwned)",
    ],
)
def test_monte_shell_injection_is_rejected(
    monte_mod: Any, command: str, tmp_path: Path
) -> None:
    """Shell metacharacters are rejected without executing anything."""
    ok, reason = monte_mod._run_test_command(command, tmp_path)
    assert not ok
    assert "unsafe" in reason
    assert not (tmp_path / "pwned").exists()


def test_monte_safe_command_executes_without_shell(
    monte_mod: Any, tmp_path: Path
) -> None:
    """A plain interpreter invocation runs successfully."""
    ok, reason = monte_mod._run_test_command("python3 -c 'print(1)'", tmp_path)
    assert ok, reason


def test_monte_unsupported_command_is_rejected(monte_mod: Any, tmp_path: Path) -> None:
    """Commands outside the allow-list are refused."""
    ok, reason = monte_mod._run_test_command("curl https://example.test", tmp_path)
    assert not ok
    assert "unsupported command" in reason


def test_monte_timeout_kills_process_group(
    monte_mod: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A test command exceeding TEST_TIMEOUT is killed and reported."""
    monkeypatch.setattr(monte_mod, "TEST_TIMEOUT", 0.05)
    ok, reason = monte_mod._run_test_command(
        """python3 -c 'exec("import time\\ntime.sleep(10)")'""", tmp_path
    )
    assert not ok
    assert "timed out" in reason
