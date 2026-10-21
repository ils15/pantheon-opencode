"""Detect shipped MCP copies that drift from their canonical sources."""

import asyncio
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
    ("scripts/mcp_resources.py", "src/mcp/mcp_resources.py"),
    ("scripts/code_mode.py", "src/mcp/code_mode.py"),
]

# Keep this pair in the byte-identical gate when both copies exist. Some
# distributions do not ship the persistence server in both locations.
OPTIONAL_BYTE_IDENTICAL_PAIRS = [
    ("scripts/mcp_persistence.py", "src/mcp/mcp_persistence.py"),
]

BYTE_IDENTICAL_PAIRS = REQUIRED_BYTE_IDENTICAL_PAIRS + [
    pair
    for pair in OPTIONAL_BYTE_IDENTICAL_PAIRS
    if all((REPO_ROOT / path).is_file() for path in pair)
]

MCP_SERVER_PATHS = (
    "src/mcp/mcp_persistence.py",
    "src/mcp/mcp_resources.py",
    "src/mcp/code_mode.py",
    "src/mcp/memory_mcp.py",
    "src/mcp/pantheon_vision.py",
    "scripts/mcp_persistence.py",
    "scripts/mcp_resources.py",
    "scripts/code_mode.py",
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


def test_memory_mcp_script_shim_exposes_canonical_tool_list() -> None:
    """The scripts entrypoint delegates to the complete canonical server."""
    script_path = REPO_ROOT / "scripts/memory_mcp.py"
    spec = importlib.util.spec_from_file_location("shipped_memory_mcp", script_path)
    assert spec is not None and spec.loader is not None
    shipped = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shipped)

    canonical = importlib.import_module("src.mcp.memory_mcp")
    shipped_tools = asyncio.run(shipped.mcp.list_tools())
    canonical_tools = asyncio.run(canonical.mcp.list_tools())

    assert {tool.name for tool in shipped_tools} == {
        tool.name for tool in canonical_tools
    }


@pytest.mark.parametrize("server_path", MCP_SERVER_PATHS)
def test_mcp_servers_use_standalone_fastmcp_api(server_path: str) -> None:
    server_file = REPO_ROOT / server_path
    server_text = server_file.read_text(encoding="utf-8")

    fastmcp_imports = [
        line
        for line in server_text.splitlines()
        if line.startswith("from fastmcp import ")
    ]
    assert any("FastMCP" in line for line in fastmcp_imports), (
        f"{server_path} must import FastMCP from the standalone fastmcp package"
    )
    assert "mcp.server.fastmcp" not in server_text, (
        f"{server_path} still imports the removed MCP v1 FastMCP module"
    )


def test_mcp_requirement_manifests_pin_the_coordinated_major_versions() -> None:
    expected = {"mcp": "2.2.0", "fastmcp": "4.0.10"}
    manifests = (
        REPO_ROOT / "src/mcp/requirements-mcp.txt",
        REPO_ROOT / "src/mcp/requirements-vision.txt",
    )

    for manifest in manifests:
        pins = {}
        for raw_line in manifest.read_text(encoding="utf-8").splitlines():
            line = raw_line.partition("#")[0].strip()
            if "==" in line:
                name, version = line.split("==", maxsplit=1)
                pins[name.lower()] = version
        assert {name: pins.get(name) for name in expected} == expected, (
            f"{manifest.relative_to(REPO_ROOT)} must pin the coordinated MCP majors"
        )


def test_shared_runtime_manifest_includes_vision_httpx_dependency() -> None:
    shared_manifest = REPO_ROOT / "src/mcp/requirements-mcp.txt"
    vision_manifest = REPO_ROOT / "src/mcp/requirements-vision.txt"

    def pinned_version(manifest: Path, package: str) -> str | None:
        for raw_line in manifest.read_text(encoding="utf-8").splitlines():
            line = raw_line.partition("#")[0].strip()
            name, separator, version = line.partition("==")
            if separator and name.lower() == package:
                return version
        return None

    assert pinned_version(shared_manifest, "httpx") == "0.28.1", (
        "setupVenv installs requirements-mcp.txt into the shared runtime, "
        "which must include the vision server's httpx dependency"
    )
    assert pinned_version(vision_manifest, "httpx") == "0.28.1", (
        "the vision dependency manifest and shared runtime must use the same httpx pin"
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
    mod = importlib.import_module("mcp_resources")
    importlib.reload(mod)
    return mod


def test_runtime_copy_resolves_to_scripts_dir(
    scripts_resources_copy: types.ModuleType,
) -> None:
    assert (
        Path(scripts_resources_copy.__file__).resolve()
        == (REPO_ROOT / "scripts" / "mcp_resources.py").resolve()
    )


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
    env["PYTHONPATH"] = os.pathsep.join(
        [str(REPO_ROOT / "scripts"), str(REPO_ROOT / "src" / "mcp")]
    )
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "import mcp_resources as m; "
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
