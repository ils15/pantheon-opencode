#!/usr/bin/env python3
"""Pantheon path resolution — global install + project root detection.

Provides two functions used by all MCP servers and utility scripts:

    pantheon_home() -> Path
        Pantheon global installation directory.
        Priority: $PANTHEON_HOME → $XDG_CONFIG_HOME/opencode → ~/.config/opencode

    pantheon_project() -> Path | None
        Current Pantheon project root.
        Priority: $PANTHEON_PROJECT → os.getcwd() → None (resources disabled)

Usage:
    from _pantheon_paths import pantheon_home, pantheon_project
"""

from __future__ import annotations

import os
from pathlib import Path


def pantheon_home() -> Path:
    """Return the Pantheon global installation directory.

    Resolution priority:
    1. $PANTHEON_HOME env var (explicit user override)
    2. $XDG_CONFIG_HOME/opencode (XDG Base Directory spec)
    3. ~/.config/opencode (POSIX default)

    Returns:
        Absolute Path to the Pantheon global config directory.
    """
    env = os.environ.get("PANTHEON_HOME")
    if env:
        return Path(env).expanduser().absolute()

    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg).expanduser().absolute() / "opencode"

    return Path.home() / ".config" / "opencode"


def pantheon_project() -> Path | None:
    """Return the Pantheon project root directory.

    Resolution priority:
    1. $PANTHEON_PROJECT env var (explicit override)
    2. The validated logical ``$PWD`` supplied by the launcher
    3. Current working directory (set by MCP client's cwd in opencode.json)

    Returns:
        Absolute Path to the project root, or None if neither is available
        (project-scoped resources like deepwork/memory-bank are unavailable).
    """
    env = os.environ.get("PANTHEON_PROJECT")
    if env:
        return Path(env).expanduser().absolute()

    logical_cwd = os.environ.get("PWD")
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = ""
    if logical_cwd and _is_valid_logical_cwd(logical_cwd, cwd):
        return Path(logical_cwd).expanduser().absolute()
    if cwd:
        return Path(cwd).absolute()

    return None


def _is_valid_logical_cwd(logical_cwd: str, physical_cwd: str) -> bool:
    """Validate a launcher-provided logical cwd without resolving its result.

    ``PWD`` is trusted only when it is an existing directory naming the same
    inode as the process cwd.  This preserves symlink spelling while rejecting
    forged or stale environment values.
    """
    logical = Path(logical_cwd).expanduser()
    if not logical.is_absolute() or not logical.is_dir():
        return False
    try:
        return os.path.samefile(logical, physical_cwd)
    except (OSError, ValueError):
        return False


def has_symlink_component(path: Path) -> bool:
    """Return whether any existing lexical component of ``path`` is a symlink.

    The lexical path is intentionally inspected before ``resolve()`` so a
    symlink cannot be hidden by resolving to an otherwise trusted directory.
    Missing trailing components are allowed; this keeps normal project paths
    usable while still checking every existing ancestor.
    """
    current = Path(path.anchor) if path.is_absolute() else Path.cwd()
    for component in path.parts[1:] if path.is_absolute() else path.parts:
        if component in {"", "."}:
            continue
        current /= component
        if current.is_symlink():
            return True
    return False
