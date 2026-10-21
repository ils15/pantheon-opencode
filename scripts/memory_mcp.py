#!/usr/bin/env python3
"""Compatibility entrypoint for the canonical Memory MCP server.

The installer copies ``src/mcp/memory_mcp.py`` into the installed scripts
directory. This source-tree entrypoint remains for ``install-mcp.mjs``'s local
fallback and delegates to that canonical implementation.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CANONICAL_MCP_DIR = Path(__file__).resolve().parents[1] / "src" / "mcp"
sys.path.insert(0, str(_CANONICAL_MCP_DIR))
try:
    import memory_mcp as _canonical_memory_mcp
finally:
    sys.path.remove(str(_CANONICAL_MCP_DIR))

mcp = _canonical_memory_mcp.mcp

if __name__ == "__main__":
    mcp.run()
