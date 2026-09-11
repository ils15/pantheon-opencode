"""Project-first code-mode path resolution tests."""

from __future__ import annotations

import hashlib
import importlib
import json
from pathlib import Path


MODULE_PATH = "src.mcp.code_mode_server"


def _reload(monkeypatch, project: Path | None, home: Path, cwd: Path):
    cwd.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(cwd)
    monkeypatch.setenv("PANTHEON_HOME", str(home))
    if project is None:
        monkeypatch.delenv("PANTHEON_PROJECT", raising=False)
    else:
        monkeypatch.setenv("PANTHEON_PROJECT", str(project))
    module = importlib.import_module(MODULE_PATH)
    return importlib.reload(module)


def _script(directory: Path, name: str = "run.py") -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    script = directory / name
    script.write_text("print('ok')\n", encoding="utf-8")
    script.chmod(0o755)
    return script


def _manifest(directory: Path, script: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(script.read_bytes()).hexdigest()
    (directory / "manifest.json").write_text(
        json.dumps({"version": 1, "scripts": {script.name: digest}}),
        encoding="utf-8",
    )


def test_resolves_project_dir_when_project_manifest_present(tmp_path, monkeypatch):
    project = tmp_path / "project"
    target = project / ".pantheon" / "code-mode"
    script = _script(target)
    _manifest(target, script)
    module = _reload(monkeypatch, project, tmp_path / "home", tmp_path)
    assert module.SCRIPTS_DIR == target


def test_resolves_project_opencode_dir_before_project_root_dir(tmp_path, monkeypatch):
    project = tmp_path / "project"
    preferred = project / ".opencode" / ".pantheon" / "code-mode"
    _script(preferred)
    _manifest(preferred, preferred / "run.py")
    _script(project / ".pantheon" / "code-mode")
    module = _reload(monkeypatch, project, tmp_path / "home", tmp_path)
    assert module.SCRIPTS_DIR == preferred


def test_falls_back_to_global_when_project_context_is_unavailable(tmp_path, monkeypatch):
    home = tmp_path / "home"
    global_dir = home / ".pantheon" / "code-mode"
    script = _script(global_dir)
    _manifest(global_dir, script)
    module = _reload(monkeypatch, None, home, tmp_path)
    assert module._resolve_code_mode_dir() == global_dir


def test_does_not_fall_back_to_global_after_project_dir_is_selected(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project_dir = project / ".pantheon" / "code-mode"
    _script(project_dir)
    global_dir = tmp_path / "home" / ".pantheon" / "code-mode"
    global_script = _script(global_dir)
    _manifest(global_dir, global_script)
    module = _reload(monkeypatch, project, tmp_path / "home", tmp_path)
    assert module.SCRIPTS_DIR == project_dir
    assert module._manifest_path().parent == project_dir


def test_project_wins_when_project_and_global_dirs_exist(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project_script = _script(project / ".pantheon" / "code-mode")
    _manifest(project_script.parent, project_script)
    global_script = _script(tmp_path / "home" / ".pantheon" / "code-mode")
    _manifest(global_script.parent, global_script)
    module = _reload(monkeypatch, project, tmp_path / "home", tmp_path)
    assert module.SCRIPTS_DIR == project_script.parent


def test_pantheon_project_env_overrides_cwd(tmp_path, monkeypatch):
    project = tmp_path / "explicit"
    script = _script(project / ".pantheon" / "code-mode")
    _manifest(script.parent, script)
    module = _reload(monkeypatch, project, tmp_path / "home", tmp_path / "other")
    assert module.SCRIPTS_DIR == script.parent


def test_approve_script_uses_project_manifest_when_both_exist(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project_dir = project / ".pantheon" / "code-mode"
    _script(project_dir, "new.py")
    global_dir = tmp_path / "home" / ".pantheon" / "code-mode"
    global_script = _script(global_dir, "old.py")
    _manifest(global_dir, global_script)
    module = _reload(monkeypatch, project, tmp_path / "home", tmp_path)
    status, _ = module._approve_script("new.py")
    assert status == "OK"
    assert (project_dir / "manifest.json").exists()
    assert "new.py" in (project_dir / "manifest.json").read_text()
    assert "new.py" not in (global_dir / "manifest.json").read_text()
