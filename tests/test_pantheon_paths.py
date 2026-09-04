"""Tests for preserving project paths until resource safety checks."""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from src.mcp._pantheon_paths import (
    has_symlink_component,
    pantheon_home,
    pantheon_project,
)


@pytest.mark.parametrize("source", ["env", "cwd"])
def test_symlinked_project_path_is_kept_for_safety_checks(
    tmp_path: Path, source: str
) -> None:
    """Project resolution must not erase the root symlink identity."""
    target = tmp_path / "project"
    linked = tmp_path / "project-link"
    target.mkdir()
    linked.symlink_to(target, target_is_directory=True)

    if source == "env":
        with patch.dict(os.environ, {"PANTHEON_PROJECT": str(linked)}):
            result = pantheon_project()
    else:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("src.mcp._pantheon_paths.os.getcwd", return_value=str(linked)),
        ):
            result = pantheon_project()

    assert result == linked.absolute()
    assert result.is_symlink()


def test_real_symlinked_cwd_and_pwd_preserve_logical_project_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real launcher-like cwd must retain its symlink spelling."""
    target = tmp_path / "project"
    linked = tmp_path / "project-link"
    target.mkdir()
    linked.symlink_to(target, target_is_directory=True)

    monkeypatch.chdir(linked)
    monkeypatch.setenv("PWD", str(linked))

    result = pantheon_project()

    assert Path.cwd() == target.absolute()
    assert result == linked.absolute()
    assert result.is_symlink()


def test_symlinked_pantheon_home_is_kept_for_safety_checks(tmp_path: Path) -> None:
    """Global resource safety checks must still see a PANTHEON_HOME symlink."""
    target = tmp_path / "home"
    linked = tmp_path / "home-link"
    target.mkdir()
    linked.symlink_to(target, target_is_directory=True)

    with patch.dict(os.environ, {"PANTHEON_HOME": str(linked)}):
        result = pantheon_home()

    assert result == linked.absolute()
    assert result.is_symlink()


def test_symlinked_project_ancestor_is_detectable_without_rejecting_normal_paths(
    tmp_path: Path,
) -> None:
    """Safety checks inspect ancestors while ordinary paths remain trusted."""
    real_parent = tmp_path / "real-parent"
    normal = real_parent / "project"
    normal.mkdir(parents=True)
    linked_parent = tmp_path / "linked-parent"
    linked_parent.symlink_to(real_parent, target_is_directory=True)

    assert has_symlink_component(linked_parent / "project")
    assert not has_symlink_component(normal)


def test_pantheon_home_uses_xdg_config_directory(tmp_path: Path) -> None:
    """XDG remains the normal fallback when no explicit home is set."""
    with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(tmp_path)}, clear=True):
        assert pantheon_home() == tmp_path / "opencode"


def test_pantheon_home_uses_default_config_directory() -> None:
    """The POSIX config directory remains the final fallback."""
    with patch.dict(os.environ, {}, clear=True):
        assert pantheon_home() == Path.home() / ".config" / "opencode"


def test_pantheon_project_returns_none_without_a_working_directory() -> None:
    """Project-scoped resources are disabled when cwd is unavailable."""
    with (
        patch.dict(os.environ, {}, clear=True),
        patch("src.mcp._pantheon_paths.os.getcwd", return_value=""),
    ):
        assert pantheon_project() is None
