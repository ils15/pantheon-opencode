"""Gate (a): detect desync between scripts/ and src/mcp/ shared Python files.

The installer (scripts/install/opencode.mjs) always copies MCP server scripts
from the canonical ``src/mcp/`` directory. Historical copies in ``scripts/``
must stay byte-identical; drift between the two locations previously
propagated bugs (e.g. missing ``import uuid`` in mcp_persistence_server.py).
"""

import filecmp
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

# (scripts/ copy, src/mcp/ canonical copy)
SYNC_PAIRS = [
    ("scripts/_pantheon_paths.py", "src/mcp/_pantheon_paths.py"),
    ("scripts/mcp_resources_server.py", "src/mcp/mcp_resources_server.py"),
]


@pytest.mark.parametrize(
    ("scripts_path", "canonical_path"),
    SYNC_PAIRS,
    ids=[pair[0].split("/")[-1] for pair in SYNC_PAIRS],
)
def test_scripts_and_src_mcp_in_sync(scripts_path: str, canonical_path: str) -> None:
    scripts_file = REPO_ROOT / scripts_path
    canonical_file = REPO_ROOT / canonical_path

    assert scripts_file.is_file(), f"missing file: {scripts_path}"
    assert canonical_file.is_file(), f"missing canonical file: {canonical_path}"

    assert filecmp.cmp(scripts_file, canonical_file, shallow=False), (
        f"DESYNC detected: {scripts_path} differs from canonical {canonical_path}. "
        f"Copy {canonical_path} over {scripts_path} (the installer always ships "
        f"the src/mcp/ version)."
    )
