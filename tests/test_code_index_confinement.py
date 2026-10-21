"""Security tests for project-scoped Memory code indexing."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from src.mcp import memory_mcp


@pytest.fixture(autouse=True)
def isolated_memory_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[None]:
    """Use a disposable SQLite database for all code-index writes."""
    db_path = tmp_path / "isolated-memory" / "memory.db"
    monkeypatch.setattr(memory_mcp, "DB_PATH", db_path)
    memory_mcp._reset_test_state()
    yield
    if memory_mcp._get_db.cache_info().currsize:
        memory_mcp._get_db().close()
    memory_mcp._get_db.cache_clear()


def _create_project(tmp_path: Path) -> Path:
    project = tmp_path / "synthetic-project"
    (project / "src").mkdir(parents=True)
    (project / "src" / "sample.py").write_text(
        "class SyntheticProjectOnly:\n    pass\n", encoding="utf-8"
    )
    return project


def _indexed_paths() -> list[str]:
    return [
        row[0]
        for row in memory_mcp._get_conn().execute(
            "SELECT path FROM code_files ORDER BY path"
        )
    ]


def test_code_index_accepts_project_src_and_default_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _create_project(tmp_path)
    other_cwd = tmp_path / "different-working-directory"
    (other_cwd / "src").mkdir(parents=True)
    (other_cwd / "src" / "cwd_only.py").write_text(
        "class UntrustedWorkingDirectoryOnly:\n    pass\n", encoding="utf-8"
    )
    monkeypatch.setenv("PANTHEON_PROJECT", str(project))
    monkeypatch.chdir(other_cwd)

    result = memory_mcp.code_index(path="src")

    assert result["indexed"] == 1
    assert _indexed_paths() == [str((project / "src" / "sample.py").resolve())]

    memory_mcp._get_conn().execute("DELETE FROM code_files")
    memory_mcp._get_conn().execute("DELETE FROM code_entities")
    memory_mcp._get_conn().commit()
    default_result = memory_mcp.code_index()
    assert default_result["indexed"] == 1
    assert _indexed_paths() == [str((project / "src" / "sample.py").resolve())]


@pytest.mark.parametrize("requested_path", ["../outside.py", "{outside}"])
def test_code_index_rejects_traversal_and_external_absolute_path(
    requested_path: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _create_project(tmp_path)
    outside = tmp_path / "outside.py"
    outside.write_text("class SyntheticOutsideOnly:\n    pass\n", encoding="utf-8")
    monkeypatch.setenv("PANTHEON_PROJECT", str(project))
    monkeypatch.chdir(project)
    path = requested_path.format(outside=outside)

    result = memory_mcp.code_index(path=path)

    assert "error" in result
    assert _indexed_paths() == []


def test_code_index_rejects_in_tree_symlink_escape(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _create_project(tmp_path)
    outside = tmp_path / "outside.py"
    outside.write_text("class SyntheticOutsideOnly:\n    pass\n", encoding="utf-8")
    outside_directory = tmp_path / "outside-directory"
    outside_directory.mkdir()
    (outside_directory / "hidden.py").write_text(
        "class SyntheticDirectoryOutsideOnly:\n    pass\n", encoding="utf-8"
    )
    link = project / "src" / "escaped.py"
    directory_link = project / "src" / "escaped-directory"
    try:
        link.symlink_to(outside)
        directory_link.symlink_to(outside_directory, target_is_directory=True)
    except (NotImplementedError, OSError) as exc:
        pytest.skip(f"symlinks unavailable: {exc}")
    monkeypatch.setenv("PANTHEON_PROJECT", str(project))
    monkeypatch.chdir(project)

    direct_result = memory_mcp.code_index(path="src/escaped.py")
    assert "error" in direct_result
    directory_result = memory_mcp.code_index(path="src/escaped-directory")
    assert "error" in directory_result
    assert _indexed_paths() == []

    directory_result = memory_mcp.code_index(path="src")
    assert directory_result["indexed"] == 1
    assert all(str(outside) not in item for item in _indexed_paths())


@pytest.mark.parametrize("binding", [None, "relative-project", "{missing}", "/"])
def test_code_index_fails_closed_without_valid_project_binding(
    binding: str | None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _create_project(tmp_path)
    if binding is None:
        monkeypatch.delenv("PANTHEON_PROJECT", raising=False)
    else:
        monkeypatch.setenv(
            "PANTHEON_PROJECT",
            binding.format(missing=tmp_path / "missing-project"),
        )

    def database_must_not_be_opened() -> sqlite3.Connection:
        raise AssertionError("code_index opened the shared Memory database")

    monkeypatch.setattr(memory_mcp, "_get_conn", database_must_not_be_opened)

    result = memory_mcp.code_index(path=str(project / "src"))

    assert "error" in result
