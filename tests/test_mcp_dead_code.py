"""Gate: every shipped ``src/mcp/*.py`` module must have a real consumer.

Issue #162 — ``src/mcp/toon_codec.py`` was published by the ``src/mcp/*.py``
glob in ``package.json`` ``files`` (and therefore landed in the npm tarball)
while nothing in the package ever imported it: no static import, no
``importlib`` string, no entry in ``scripts/install/opencode.mjs``, and no
reference in ``pyproject.toml`` or ``CHANGELOG.md``. 489 lines of dead code
shipped to every consumer.

This gate prevents the class of regression: a module added under ``src/mcp/``
may only ship when it is reachable from the runtime — either imported by
another shipped ``src/mcp/`` module, or registered as a runnable MCP server
by the installer. Anything else must be added to ``ALLOWED_UNREFERENCED``
below with a comment explaining why it ships.

Reachability is decided from the actual wiring, not from filenames:

* ``scripts/install/opencode.mjs`` is the authority on which ``src/mcp/*.py``
  files become runnable MCP servers; it lists each server explicitly
  (``mcpScripts`` / ``canonicalMcpScripts``).
* Server entrypoints import their collaborators (e.g.
  ``mcp_resources_server`` imports ``eval_store``), which transitively covers
  library modules. ``_pantheon_paths`` is imported by every server too.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MCP_DIR = REPO_ROOT / "src" / "mcp"
INSTALLER = REPO_ROOT / "scripts" / "install" / "opencode.mjs"
PACKAGE_JSON = REPO_ROOT / "package.json"

# Modules that ship despite not being reachable from the runtime graph.
# Each entry must explain why the module is published.
ALLOWED_UNREFERENCED: dict[str, str] = {
    # "some_module.py": "why it ships despite no runtime consumer",
}


def _shipped_mcp_modules() -> set[str]:
    """Resolve the ``src/mcp/*.py`` files the npm tarball actually ships.

    The ``files`` allow-list is evaluated with glob expansion and honouring
    ``!`` negations, mirroring how npm selects what goes into the tarball.
    """
    assert PACKAGE_JSON.is_file(), "package.json missing — cannot resolve files"
    globs: list[str] = json.loads(PACKAGE_JSON.read_text())["files"]

    shipped: set[str] = set()
    for pattern in globs:
        if not (pattern.startswith("src/mcp/") and pattern.endswith(".py")):
            continue
        name = pattern.rsplit("/", 1)[-1]
        if pattern.startswith("!"):
            # A negation removes a previously matched file.
            shipped.discard(name)
        elif "*" in name:
            shipped.update(p.name for p in MCP_DIR.glob(name))
        else:
            shipped.add(name)
    return shipped


def _installed_servers(shipped: set[str]) -> set[str]:
    """Parse the installer's explicit MCP server list (wiring authority)."""
    assert INSTALLER.is_file(), "installer missing — cannot resolve runtime wiring"
    text = INSTALLER.read_text()
    # The installer names every runnable server literally in mcpScripts;
    # only names that actually ship count as runtime entrypoints.
    return set(re.findall(r"'([a-z0-9_-]+\.py)'", text)) & shipped


def _module_imports(module: Path, shipped: set[str]) -> set[str]:
    """Local names a module imports from its own directory (bare imports)."""
    try:
        tree = ast.parse(module.read_text())
    except SyntaxError:
        return set()

    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            # MCP servers run with their own directory on sys.path, so a
            # relative-free ``from eval_store import ...`` resolves there.
            # ``from m import *`` (module is None) is not a local import.
            names.add(node.module.split(".")[0])
    return names & shipped


def _reachable_modules() -> set[str]:
    """Transitive closure of installer-registered servers and their imports."""
    shipped = _shipped_mcp_modules()
    imports_by_module = {
        name: _module_imports(MCP_DIR / name, shipped) for name in shipped
    }

    # Seed the graph with the servers the installer actually runs.
    reachable: set[str] = set()
    frontier = _installed_servers(shipped)
    while frontier:
        current = frontier.pop()
        if current in reachable:
            continue
        reachable.add(current)
        frontier |= imports_by_module.get(current, set()) - reachable
    return reachable


_SHIPPED = _shipped_mcp_modules()
_REACHABLE = _reachable_modules()


def test_shipped_mcp_modules_are_reachable_from_the_runtime() -> None:
    """Every published ``src/mcp/*.py`` must be imported by or run as live code."""
    dead = sorted(_SHIPPED - _REACHABLE - set(ALLOWED_UNREFERENCED))
    assert not dead, (
        "src/mcp/ modules ship in the npm tarball but nothing in the package "
        "imports or runs them — dead code (issue #162). Either wire them into "
        "the runtime or drop them from the published files. Offenders: "
        f"{dead}. If a module is intentionally shipped unreferenced, add it "
        "to ALLOWED_UNREFERENCED in tests/test_mcp_dead_code.py with a reason."
    )


def test_allowlist_only_covers_modules_that_actually_ship() -> None:
    """Stale allowlist entries would silently re-allow dead code."""
    stale = sorted(set(ALLOWED_UNREFERENCED) - _SHIPPED)
    assert not stale, (
        "ALLOWED_UNREFERENCED references modules that no longer ship: "
        f"{stale} — remove them so the exemption cannot outlive the module."
    )
