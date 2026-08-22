# noqa: N999
"""Tests for eval-static.py — static structural checks for skill/agent dirs.

Loads the script from .pantheon/code-mode/ via importlib (same pattern as
test-checkpoint-session.py). Secret-looking fixtures are built from
concatenated parts so repo secret scanners do not flag test data.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = ROOT / ".pantheon" / "code-mode" / "eval-static.py"

_OPENAI_KEY = "sk-" + "abcdefghijklmnopqrstuvwxyz123456"
_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"
_PEM_BEGIN = "-----BEGIN " + "RSA PRIVATE KEY-----"
_PEM_END = "-----END " + "RSA PRIVATE KEY-----"
_PASSWORD = "pass" + "word = 'hunter2secretvalue'"


def _get_module():
    """Load and cache the eval-static module."""
    if _get_module.cache is not None:
        return _get_module.cache
    spec = importlib.util.spec_from_file_location("eval_static", str(SCRIPT_PATH))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    _get_module.cache = mod
    return mod


_get_module.cache = None


@pytest.fixture
def mod():
    """Return the eval-static module."""
    return _get_module()


def _write_skill(d: Path, fm: str = "name: my-skill\ndescription: A test skill",
                 body: str = "# My Skill\n") -> None:
    """Write a SKILL.md with the given frontmatter/body into d."""
    (d / "SKILL.md").write_text(f"---\n{fm}\n---\n\n{body}", encoding="utf-8")


@pytest.fixture
def skill_dir(tmp_path: Path) -> Path:
    """A minimal valid skill directory."""
    d = tmp_path / "my-skill"
    d.mkdir()
    _write_skill(d)
    return d


def test_valid_skill_cli_exit_zero(tmp_path: Path) -> None:
    """Valid dir → exit 0, JSON on stdout with spec shape and score 100."""
    d = tmp_path / "cli-skill"
    d.mkdir()
    _write_skill(d, body="See [guide](guide.md).\n")
    (d / "guide.md").write_text("# g\n", encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), str(d)], capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["name"] == "my-skill"  # frontmatter name wins over dir name
    assert report["score"] == 100
    assert isinstance(report["checks"], list)
    assert {c["check"] for c in report["checks"]} == {
        "frontmatter", "referenced_files", "secrets", "file_size", "yaml",
    }
    assert all(c["pass"] is True and c["detail"] for c in report["checks"])


def test_frontmatter_check(mod, tmp_path: Path) -> None:
    """Missing manifest/name/description fail; agent .md files are accepted."""
    cases = [
        ("no-manifest", lambda d: None),
        ("missing-name", lambda d: _write_skill(d, fm="description: only")),
        ("missing-desc", lambda d: _write_skill(d, fm="name: only")),
        ("empty-name", lambda d: _write_skill(d, fm='name: ""\ndescription: x')),
    ]
    for label, setup in cases:
        d = tmp_path / label
        d.mkdir()
        setup(d)
        ok, detail = mod.check_frontmatter(d)
        assert ok is False, label
        assert detail, label

    agent = tmp_path / "agent-dir"
    agent.mkdir()
    (agent / "hermes.md").write_text(
        "---\nname: hermes\ndescription: Backend specialist\n---\n", encoding="utf-8"
    )
    ok, detail = mod.check_frontmatter(agent)
    assert ok is True
    assert "hermes.md" in detail


def test_referenced_files_check(mod, skill_dir: Path) -> None:
    """Existing refs pass; missing frontmatter/markdown refs fail with name."""
    (skill_dir / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    (skill_dir / "guide.md").write_text("# g\n", encoding="utf-8")
    _write_skill(
        skill_dir,
        fm="name: my-skill\ndescription: d\nscripts:\n  - run.sh",
        body="See [guide](guide.md), [ext](https://example.com/x), [a](#sec).\n",
    )
    ok, _ = mod.check_referenced_files(skill_dir)
    assert ok is True

    _write_skill(skill_dir, fm="name: my-skill\ndescription: d\nscripts:\n  - missing.py")
    ok, detail = mod.check_referenced_files(skill_dir)
    assert ok is False
    assert "missing.py" in detail

    _write_skill(skill_dir, body="See [ghost](ghost.md).\n")
    ok, detail = mod.check_referenced_files(skill_dir)
    assert ok is False
    assert "ghost.md" in detail


def test_secrets_check(mod, skill_dir: Path) -> None:
    """Clean dirs pass; API keys, AWS ids, PEM blocks, passwords fail."""
    ok, _ = mod.check_secrets(skill_dir)
    assert ok is True

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
        ok, detail = mod.check_secrets(skill_dir)
        assert ok is False, fname
        assert "secret" in detail.lower(), fname
        target.write_text(original, encoding="utf-8")

    ok, _ = mod.check_secrets(skill_dir)
    assert ok is True


def test_file_size_check(mod, skill_dir: Path) -> None:
    """Files under 100KB pass; an oversized file fails naming the file."""
    ok, _ = mod.check_file_sizes(skill_dir)
    assert ok is True

    big = skill_dir / "huge.bin"
    big.write_bytes(b"x" * (mod.MAX_FILE_SIZE + 1))
    ok, detail = mod.check_file_sizes(skill_dir)
    assert ok is False
    assert "huge.bin" in detail

    big.unlink()
    ok, _ = mod.check_file_sizes(skill_dir)
    assert ok is True


def test_yaml_check(mod, skill_dir: Path) -> None:
    """Valid frontmatter parses; broken YAML fails; no frontmatter passes."""
    ok, _ = mod.check_yaml(skill_dir)
    assert ok is True

    (skill_dir / "SKILL.md").write_text(
        "---\nname: [unclosed\ndescription: x\n---\n", encoding="utf-8"
    )
    ok, detail = mod.check_yaml(skill_dir)
    assert ok is False
    assert detail

    (skill_dir / "SKILL.md").write_text("# Just a heading\n", encoding="utf-8")
    ok, detail = mod.check_yaml(skill_dir)
    assert ok is True


def test_run_eval_report_shape_and_score(mod, skill_dir: Path) -> None:
    """run_eval returns {name, checks[], score}; failures lower the score."""
    report = mod.run_eval(skill_dir)
    assert report["name"] == "my-skill"
    assert report["score"] == 100
    assert len(report["checks"]) == 5

    (skill_dir / "SKILL.md").write_text("---\ndescription: no name\n---\n", encoding="utf-8")
    report = mod.run_eval(skill_dir)
    assert report["score"] == 80  # 4 of 5 checks pass
    by_name = {c["check"]: c for c in report["checks"]}
    assert by_name["frontmatter"]["pass"] is False


def test_main_exit_codes(mod, skill_dir: Path, capsys) -> None:
    """Exit 2 usage errors; exit 1 failing eval still prints JSON."""
    assert mod.main([]) == 2
    assert "usage" in capsys.readouterr().err.lower()

    assert mod.main(["/nonexistent/path/xyz"]) == 2
    assert "not found" in capsys.readouterr().err.lower()

    assert mod.main([str(skill_dir / "SKILL.md")]) == 2
    assert "not a directory" in capsys.readouterr().err.lower()

    (skill_dir / "SKILL.md").write_text("---\ndescription: no name\n---\n", encoding="utf-8")
    code = mod.main([str(skill_dir)])
    out = capsys.readouterr().out
    assert code == 1
    assert json.loads(out)["score"] < 100
