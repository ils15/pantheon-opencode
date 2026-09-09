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
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

# (scripts/ copy, src/mcp/ canonical copy) that must be byte-identical.
REQUIRED_BYTE_IDENTICAL_PAIRS = [
    ("scripts/_pantheon_paths.py", "src/mcp/_pantheon_paths.py"),
    ("scripts/mcp_resources_server.py", "src/mcp/mcp_resources_server.py"),
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
