"""Gate (a): detect desync between scripts/ and src/mcp/ shared Python files.

The installer (scripts/install/opencode.mjs) always copies MCP server scripts
from the canonical ``src/mcp/`` directory. Historical copies in ``scripts/``
must stay byte-identical; drift between the two locations previously
propagated bugs (e.g. missing ``import uuid`` in mcp_persistence_server.py).

The memory MCP server is the exception: the standalone ``scripts/`` copy keeps
the lightweight memory contract, while ``src/mcp/`` also exposes codemap tools.
Those copies are checked for their respective contracts instead of being
treated as a synchronization pair.
"""

import filecmp
import importlib
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

# (scripts/ copy, src/mcp/ canonical copy) that must be byte-identical.
REQUIRED_BYTE_IDENTICAL_PAIRS = [
    ("scripts/_pantheon_paths.py", "src/mcp/_pantheon_paths.py"),
    ("scripts/mcp_resources_server.py", "src/mcp/mcp_resources_server.py"),
    ("scripts/code_mode_server.py", "src/mcp/code_mode_server.py"),
]

# Keep this pair in the byte-identical gate when both copies exist. Some
# distributions do not ship the persistence server in both locations.
OPTIONAL_BYTE_IDENTICAL_PAIRS = [
    ("scripts/mcp_persistence_server.py", "src/mcp/mcp_persistence_server.py"),
]

BYTE_IDENTICAL_PAIRS = REQUIRED_BYTE_IDENTICAL_PAIRS + [
    pair
    for pair in OPTIONAL_BYTE_IDENTICAL_PAIRS
    if all((REPO_ROOT / path).is_file() for path in pair)
]

INTENTIONALLY_DIVERGENT_PAIRS = [
    ("scripts/memory_mcp_server.py", "src/mcp/memory_mcp_server.py"),
]

MEMORY_SCRIPT_CONTRACT_MARKERS = (
    "def _set_memory_dir(path: str | Path) -> None:",
    "def memory_store(",
    "def memory_search(",
    "def memory_recall(",
    "def memory_forget(",
    "def memory_list(",
    "def memory_stats(",
)

MEMORY_SOURCE_CONTRACT_MARKERS = (
    "import contextlib",
    "import mcp_codemap_module as _codemap",
    "# ── Codemap Tools",
    "def code_index(",
    "def code_query(",
    "def code_neighbors(",
)


@pytest.mark.parametrize(
    ("scripts_path", "canonical_path"),
    BYTE_IDENTICAL_PAIRS,
    ids=[pair[0].split("/")[-1] for pair in BYTE_IDENTICAL_PAIRS],
)
def test_byte_identical_mcp_pairs(
    scripts_path: str,
    canonical_path: str,
) -> None:
    scripts_file = REPO_ROOT / scripts_path
    canonical_file = REPO_ROOT / canonical_path

    assert scripts_file.is_file(), f"missing file: {scripts_path}"
    assert canonical_file.is_file(), f"missing canonical file: {canonical_path}"

    assert filecmp.cmp(scripts_file, canonical_file, shallow=False), (
        f"DESYNC detected: {scripts_path} differs from canonical {canonical_path}. "
        f"Copy {canonical_path} over {scripts_path} (the installer always ships "
        f"the src/mcp/ version)."
    )


@pytest.mark.parametrize(
    ("scripts_path", "canonical_path"),
    INTENTIONALLY_DIVERGENT_PAIRS,
    ids=[pair[0].split("/")[-1] for pair in INTENTIONALLY_DIVERGENT_PAIRS],
)
def test_memory_mcp_copies_keep_distinct_contracts(
    scripts_path: str,
    canonical_path: str,
) -> None:
    scripts_file = REPO_ROOT / scripts_path
    canonical_file = REPO_ROOT / canonical_path

    assert scripts_file.is_file(), f"missing file: {scripts_path}"
    assert canonical_file.is_file(), f"missing canonical file: {canonical_path}"

    scripts_text = scripts_file.read_text(encoding="utf-8")
    canonical_text = canonical_file.read_text(encoding="utf-8")

    missing_script_markers = [
        marker
        for marker in MEMORY_SCRIPT_CONTRACT_MARKERS
        if marker not in scripts_text
    ]
    missing_source_markers = [
        marker
        for marker in MEMORY_SOURCE_CONTRACT_MARKERS
        if marker not in canonical_text
    ]

    assert not missing_script_markers, (
        f"{scripts_path} is missing its memory-server contract markers: "
        f"{missing_script_markers}"
    )
    assert not missing_source_markers, (
        f"{canonical_path} is missing its codemap contract markers: "
        f"{missing_source_markers}"
    )
    assert "def code_index(" not in scripts_text, (
        f"{scripts_path} unexpectedly contains the src-only codemap contract"
    )
    assert scripts_text != canonical_text, (
        "memory MCP copies are intentionally divergent: the src/mcp copy must "
        "retain its codemap contract without being copied into scripts/"
    )


# ---------------------------------------------------------------------------
# Runtime import resolution — conftest.py puts scripts/ FIRST on sys.path, so
# top-level imports execute the shipped runtime copies. These tests pin that
# ordering: a sys.path regression must fail loudly via __file__.
# ---------------------------------------------------------------------------


@pytest.fixture
def scripts_resources_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> types.ModuleType:
    """Import the scripts/ resources copy under a hermetic environment."""
    home = tmp_path / "pantheon-home"
    project = tmp_path / "project"
    home.mkdir()
    project.mkdir()
    monkeypatch.setenv("PANTHEON_HOME", str(home))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.setenv("PANTHEON_PROJECT", str(project))
    monkeypatch.chdir(project)
    mod = importlib.import_module("mcp_resources_server")
    importlib.reload(mod)
    return mod


def test_runtime_copy_resolves_to_scripts_dir(
    scripts_resources_copy: types.ModuleType,
) -> None:
    assert Path(scripts_resources_copy.__file__).resolve() == (
        REPO_ROOT / "scripts" / "mcp_resources_server.py"
    ).resolve()


def test_runtime_copy_globals_come_from_hermetic_env(
    scripts_resources_copy: types.ModuleType, tmp_path: Path
) -> None:
    assert tmp_path / "pantheon-home" == scripts_resources_copy._PANTHEON_HOME
    assert tmp_path / "project" == scripts_resources_copy._PANTHEON_PROJECT


def test_runtime_copy_imports_standalone(tmp_path: Path) -> None:
    """A fresh interpreter must import the copy like the launcher does."""
    home = tmp_path / "home"
    project = tmp_path / "project"
    home.mkdir()
    project.mkdir()
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in {"PANTHEON_HOME", "XDG_CONFIG_HOME", "PANTHEON_PROJECT", "PWD"}
    }
    env["PANTHEON_HOME"] = str(home)
    env["PANTHEON_PROJECT"] = str(project)
    env["PYTHONPATH"] = os.pathsep.join([str(REPO_ROOT / "scripts"), str(REPO_ROOT / "src" / "mcp")])
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "import mcp_resources_server as m; "
            "print(m._PANTHEON_HOME); print(m._PANTHEON_PROJECT)",
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(project),
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.splitlines()
    assert Path(lines[0]) == home
    assert Path(lines[1]) == project
