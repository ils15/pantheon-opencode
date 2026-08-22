#!/usr/bin/env python3
"""Pantheon Code Mode MCP Server.

Provides a confined execution environment for orchestration scripts
via MCP tools and resources.

Usage:
    python scripts/code_mode_server.py

Or via MCP client (stdio transport):
    pantheon-code-mode:
        command: python
        args: ["scripts/code_mode_server.py"]
"""

from __future__ import annotations

import asyncio
import os
import stat
import time
from contextlib import suppress
from pathlib import Path
from typing import Any

import yaml

from _pantheon_paths import pantheon_home, pantheon_project
from mcp.server.fastmcp import FastMCP

# ── Constants ─────────────────────────────────────────────────────────────────
ALLOWED_EXTENSIONS: frozenset[str] = frozenset({".sh", ".py"})
SCRIPT_TIMEOUT: int = 30
# Hard ceiling for frontmatter `timeout:` overrides — no script may pin the
# executor for longer than 5 minutes.
MAX_SCRIPT_TIMEOUT: int = 300

# ── Scripts Directory Resolution ─────────────────────────────────────────────
# Priority:
# 1. /.opencode/.pantheon/code-mode/  (project install)
# 2. /.pantheon/code-mode/            (legacy fallback)
# 3. /.pantheon/code-mode/               (global fallback)
_PANTHEON_HOME: Path = pantheon_home()
_SCRIPTS_DIR_CANDIDATES: list[Path] = []
_proj = pantheon_project()
if _proj is not None:
    _SCRIPTS_DIR_CANDIDATES.append(_proj / ".opencode" / ".pantheon" / "code-mode")
    _SCRIPTS_DIR_CANDIDATES.append(_proj / ".pantheon" / "code-mode")
_SCRIPTS_DIR_CANDIDATES.append(_PANTHEON_HOME / ".pantheon" / "code-mode")

SCRIPTS_DIR: Path = _PANTHEON_HOME / ".pantheon" / "code-mode"  # default
for _candidate in _SCRIPTS_DIR_CANDIDATES:
    if _candidate.is_dir():
        SCRIPTS_DIR = _candidate
        break

# ── FastMCP App ───────────────────────────────────────────────────────────────
mcp = FastMCP(
    "Pantheon Code Mode",
    instructions="Confined script execution for Pantheon orchestration. "
    "Scripts live in .pantheon/code-mode/ and must be .sh or .py files.",
)

# ── Helpers ───────────────────────────────────────────────────────────────────


def _validate_script_name(script_name: str) -> Path:
    """Validate a script name and return its resolved path.

    Raises ValueError if the name is invalid, traverses paths, or
    has a disallowed extension.
    """
    if not script_name:
        raise ValueError("Script name cannot be empty")

    name = script_name.strip()
    if name.startswith("."):
        raise ValueError(f"Invalid script name: '{script_name}'")
    if "/" in name or "\\" in name:
        raise ValueError(f"Invalid script name: '{script_name}'")

    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise ValueError(f"Extension '{ext}' not allowed. Allowed: {allowed}")

    script_path = (SCRIPTS_DIR / name).resolve()
    if not str(script_path).startswith(str(SCRIPTS_DIR.resolve())):
        raise ValueError(f"Invalid script name: '{script_name}'")
    if not script_path.exists():
        raise ValueError(f"Script '{script_name}' not found")

    return script_path


def _format_output(
    stdout: str,
    stderr: str,
    exit_code: int,
    timed_out: bool = False,
    timeout_s: int = SCRIPT_TIMEOUT,
) -> str:
    """Format script execution output into a readable string."""
    parts: list[str] = []
    if timed_out:
        parts.append(f"[TIMEOUT] Script exceeded {timeout_s}s limit")
    if stdout:
        parts.append(stdout)
    if stderr:
        parts.append(f"[stderr]\n{stderr}")
    parts.append(f"--- exit code: {exit_code}")
    return "\n".join(parts)


# ── Script Metadata (YAML frontmatter) ────────────────────────────────────────
# Optional comment-style frontmatter at the top of a script (after an optional
# shebang). Comment lines keep the script a valid executable in both bash and
# python while carrying metadata:
#
#     #!/usr/bin/env python3
#     # ---
#     # description: Runs the checkpoint save
#     # timeout: 5
#     # allowed_args:
#     #   - compress
#     #   - --text
#     # ---
#
# Supported keys: description (str), timeout (int seconds, overrides the 30s
# default), allowed_args (list of allowed CLI args — validated on execute).


def _parse_frontmatter(script_path: Path) -> dict[str, Any]:
    """Parse comment-style YAML frontmatter from a script.

    Returns an empty dict when the script has no frontmatter or the block is
    malformed (fail-open — never blocks execution).
    """
    try:
        text = script_path.read_text(encoding="utf-8")
    except OSError:
        return {}
    lines = text.splitlines()

    # Locate the opening delimiter: a comment line that is exactly "# ---".
    # Only scan the header region (before the first non-comment code line).
    start: int | None = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "# ---":
            start = i
            break
        if i > 0 and stripped and not stripped.startswith("#"):
            break
    if start is None:
        return {}

    body_lines: list[str] = []
    for j in range(start + 1, len(lines)):
        stripped = lines[j].strip()
        if stripped == "# ---":
            break
        if not stripped.startswith("#"):
            return {}  # non-comment line inside the block → not frontmatter
        body_lines.append(stripped[1:].lstrip() if stripped.startswith("# ") else stripped[1:])
    else:
        return {}  # no closing delimiter

    try:
        data = yaml.safe_load("\n".join(body_lines))
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


def _script_timeout(script_path: Path) -> int:
    """Per-script timeout override from frontmatter, capped at MAX_SCRIPT_TIMEOUT.

    Honors any positive integer `timeout:` from the script frontmatter, but
    never returns more than 300s (5 min) regardless of what frontmatter asks.
    """
    timeout = _parse_frontmatter(script_path).get("timeout")
    if isinstance(timeout, int) and timeout > 0:
        return min(timeout, MAX_SCRIPT_TIMEOUT)
    return SCRIPT_TIMEOUT


def _validate_args(script_path: Path, args: list[str]) -> str | None:
    """Validate args against the frontmatter ``allowed_args`` allowlist.

    Returns an error message when a passed arg is not allowed, else None.
    A missing or malformed allowlist fails open (no restriction).
    """
    allowed = _parse_frontmatter(script_path).get("allowed_args")
    if allowed is None:
        return None
    if not isinstance(allowed, list) or not all(isinstance(a, str) for a in allowed):
        return None
    denied = [a for a in args if a not in allowed]
    if denied:
        return (
            f"Argument(s) {denied} not allowed for script '{script_path.name}'. "
            f"Allowed: {allowed}"
        )
    return None


def _build_result(
    stdout: str,
    stderr: str,
    exit_code: int,
    timed_out: bool,
    duration_ms: int,
    metadata: dict[str, Any],
    json_output: bool,
    timeout_s: int,
) -> str | dict[str, Any]:
    """Build the tool result in plain-text or structured JSON form."""
    if json_output:
        return {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "duration_ms": duration_ms,
            "timeout_s": timeout_s,
            "metadata": metadata,
        }
    return _format_output(stdout, stderr, exit_code, timed_out, timeout_s)


# ── Static Resources ──────────────────────────────────────────────────────────


@mcp.resource(
    "pantheon://code-mode/scripts",
    description="List of available code-mode scripts",
)
async def list_code_mode_scripts() -> str:
    """Return a list of available scripts in the code-mode directory."""
    if not SCRIPTS_DIR.is_dir():
        return "Code mode directory not found."

    scripts: list[str] = []
    for f in sorted(SCRIPTS_DIR.iterdir()):
        if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS:
            scripts.append(f"- {f.name}")

    return "\n".join(scripts) if scripts else "No scripts found."


# ── Template Resources ────────────────────────────────────────────────────────


@mcp.resource(
    "pantheon://code-mode/scripts/{script_name}",
    description="Content of a code-mode script by name, with parsed frontmatter metadata",
)
async def get_code_mode_script(script_name: str) -> str:
    """Return the source content of a code-mode script plus its metadata."""
    try:
        script_path = _validate_script_name(script_name)
    except ValueError as e:
        return str(e)
    metadata = _parse_frontmatter(script_path)
    source = script_path.read_text(encoding="utf-8")
    if not metadata:
        return source
    meta_lines = "\n".join(f"{k}: {v}" for k, v in sorted(metadata.items()))
    return f"# metadata\n{meta_lines}\n\n{source}"


# ── Tools ─────────────────────────────────────────────────────────────────────


@mcp.tool(
    name="execute_code_script",
    description="Run a .sh/.py script from .pantheon/code-mode/ with optional args. "
    "30s default timeout (override via YAML frontmatter `timeout`). "
    "Set json_output=true for structured JSON output.",
)
async def execute_code_script(
    script_name: str,
    args: list[str] | None = None,
    json_output: bool = False,
) -> str | dict[str, Any]:
    """Execute a code-mode script with confinement and timeout.

    Args:
        script_name: Name of the script in the code-mode directory.
        args: Optional CLI arguments forwarded to the subprocess (e.g.
            ``["compress", "--text", "..."]``). Defaults to no args.
        json_output: When True, return a structured dict with stdout, stderr,
            exit_code, duration_ms, timed_out and frontmatter metadata
            instead of the plain-text summary.

    Returns:
        Plain-text summary (default) or structured dict (json_output=True).
    """
    args = args or []
    try:
        script_path = _validate_script_name(script_name)
    except ValueError as e:
        return str(e)

    metadata = _parse_frontmatter(script_path)
    denied = _validate_args(script_path, args)
    if denied is not None:
        return denied

    timeout_s = _script_timeout(script_path)

    # Ensure script is executable
    if not os.access(script_path, os.X_OK):
        with suppress(OSError):
            mode = script_path.stat().st_mode
            script_path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    script_dir = script_path.parent
    started = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            str(script_path),
            *args,
            cwd=str(script_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_s
            )
            duration_ms = int((time.monotonic() - started) * 1000)
            return _build_result(
                stdout.decode("utf-8", errors="replace"),
                stderr.decode("utf-8", errors="replace"),
                proc.returncode or 0,
                timed_out=False,
                duration_ms=duration_ms,
                metadata=metadata,
                json_output=json_output,
                timeout_s=timeout_s,
            )
        except TimeoutError:
            proc.kill()
            await proc.wait()
            duration_ms = int((time.monotonic() - started) * 1000)
            return _build_result(
                "", "", -1, timed_out=True, duration_ms=duration_ms,
                metadata=metadata, json_output=json_output, timeout_s=timeout_s,
            )
    except FileNotFoundError:
        return _build_result(
            "",
            f"Script '{script_name}' not found or interpreter missing.",
            -1,
            timed_out=False,
            duration_ms=0,
            metadata=metadata,
            json_output=json_output,
            timeout_s=timeout_s,
        )
    except OSError as e:
        return _build_result(
            "",
            f"Failed to execute script: {e}",
            -1,
            timed_out=False,
            duration_ms=0,
            metadata=metadata,
            json_output=json_output,
            timeout_s=timeout_s,
        )


# ── Main Entrypoint ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
