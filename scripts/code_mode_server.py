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
import hashlib
import json
import logging
import os
import shutil
import signal
import stat
import sys
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

# ── Common status contract ────────────────────────────────────────────────────
# Mirrors the nine-code `NativeTaskStatus` contract introduced in B3-05. Every
# code-mode result is labelled with one of these statuses so callers can apply
# the same retry/skip/escalate strategy across the whole platform.
CONTRACT_STATUSES: frozenset[str] = frozenset(
    {
        "OK",
        "UNSUPPORTED",
        "UNAVAILABLE",
        "INVALID_INPUT",
        "INVALID_STATE",
        "CONFLICT",
        "CORRUPT_DATA",
        "TIMEOUT",
        "ESCALATE",
    }
)

# Explicit installation mode: a script only runs when it is listed in this
# manifest with a matching SHA-256. No manifest → nothing executes.
MANIFEST_FILENAME: str = "manifest.json"
MANIFEST_VERSION: int = 1
_SHA256_HEX_LEN: int = 64

# ── Env Allowlist ──────────────────────────────────────────────────────────────
# Only these variables are passed to script subprocesses.  Everything else
# (secrets, cloud credentials, etc.) is stripped to limit blast radius.
_CODE_MODE_ENV_ALLOWLIST: frozenset[str] = frozenset(
    {
        "PATH",
        "HOME",
        "LANG",
        "PANTHEON_HOME",
        "PANTHEON_PROJECT",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "EVAL_JUDGE_MODEL",
        "SHELL",
        "USER",
    }
)

# Optional extra vars that callers may opt-in to pass through.  Populate
# this set at startup if needed (e.g. ``CODE_MODE_EXTRA_ENV.add("MY_VAR")``).
CODE_MODE_EXTRA_ENV: set[str] = set()

# Safe defaults when the host env is completely empty.
_SAFE_DEFAULTS: dict[str, str] = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/tmp",
}

_log = logging.getLogger(__name__)


def _build_script_env(
    host_env: dict[str, str] | None = None,
) -> dict[str, str]:
    """Construct a minimal env dict for script subprocesses.

    Only allowlisted vars (plus any in ``CODE_MODE_EXTRA_ENV``) are
    forwarded from *host_env* (defaults to ``os.environ``).  Missing
    allowlisted vars receive safe defaults from ``_SAFE_DEFAULTS``.

    Returns a **new** dict — the input is never mutated.
    """
    if host_env is None:
        host_env = dict(os.environ)

    allowed = _CODE_MODE_ENV_ALLOWLIST | CODE_MODE_EXTRA_ENV
    env: dict[str, str] = {}

    for key in allowed:
        if key in host_env:
            env[key] = host_env[key]
        elif key in _SAFE_DEFAULTS:
            env[key] = _SAFE_DEFAULTS[key]

    # Always ensure PATH is present even if allowlist + defaults both miss it.
    if "PATH" not in env:
        env["PATH"] = _SAFE_DEFAULTS.get("PATH", "/usr/local/bin:/usr/bin:/bin")

    return env


def _prlimit_prefix(
    prlimit_path: str | None,
    timeout_s: int = SCRIPT_TIMEOUT,
) -> list[str] | None:
    """Return a ``prlimit`` command prefix to wrap a subprocess, or *None*.

    On Linux with ``prlimit`` available the prefix adds:
      --nproc=512  --as=1073741824  --cpu=<timeout_s + 5>

    On non-Linux or when *prlimit_path* is falsy, returns *None* (fail-open).
    """
    if not prlimit_path:
        return None

    cpu_limit = timeout_s + 5
    return [
        prlimit_path,
        "--nproc=512",
        "--as=1073741824",  # 1 GiB in bytes
        f"--cpu={cpu_limit}",
        "--",
    ]


def _detect_prlimit() -> str | None:
    """Return the path to ``prlimit`` if available, else *None*."""
    if sys.platform != "linux":
        return None
    return shutil.which("prlimit")


# ── Scripts Directory Resolution ─────────────────────────────────────────────
# Priority:
# 1. /.opencode/.pantheon/code-mode/  (project install)
# 2. /.pantheon/code-mode/            (legacy fallback)
# 3. /.pantheon/code-mode/               (global fallback)
# 4. .pantheon/code-mode/ shipped inside the installed package (tarball
#    fallback — package.json `files` includes .pantheon/code-mode/**)


def _is_within(path: Path, root: Path) -> bool:
    """Return whether a resolved *path* is contained by a resolved *root*."""
    try:
        return os.path.commonpath((str(root), str(path))) == str(root)
    except (OSError, ValueError):
        return False


def _has_usable_scripts(scripts_dir: Path) -> bool:
    """Return whether *scripts_dir* contains an executable code-mode target.

    A directory is only a valid resolver candidate when it contains a regular
    ``.py`` or ``.sh`` file that can pass the same direct-child and path
    containment rules used by script execution.  This prevents an empty
    project overlay (or a directory containing only metadata) from masking a
    lower-priority installation.
    """
    try:
        if scripts_dir.is_symlink():
            return False
        resolved_dir = scripts_dir.resolve(strict=True)
        if not resolved_dir.is_dir():
            return False
        for script_path in scripts_dir.iterdir():
            if script_path.name.startswith("."):
                continue
            if script_path.suffix.lower() not in ALLOWED_EXTENSIONS:
                continue
            try:
                resolved_script = script_path.resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            if (
                resolved_script.is_file()
                and resolved_script.parent == resolved_dir
                and _is_within(resolved_script, resolved_dir)
            ):
                return True
    except (OSError, RuntimeError):
        return False
    return False


def _packaged_scripts_dir() -> Path | None:
    """Return the code-mode dir shipped inside the installed package, if any.

    Walks up from this file looking for a `.pantheon/code-mode/` directory
    (e.g. `<pkg>/.pantheon/code-mode` when installed from the tarball).
    Returns None when no packaged copy exists.
    """
    try:
        here = Path(__file__).resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    for parent in [here.parent, *here.parents]:
        try:
            candidate = parent / ".pantheon" / "code-mode"
        except Exception:
            continue
        if _has_usable_scripts(candidate):
            return candidate
    return None


def _resolve_scripts_dir(candidates: list[Path]) -> Path | None:
    """Select the first usable candidate, then try the packaged fallback."""
    for candidate in candidates:
        if _has_usable_scripts(candidate):
            return candidate
    return _packaged_scripts_dir()


_PANTHEON_HOME: Path = pantheon_home()
_SCRIPTS_DIR_CANDIDATES: list[Path] = []
_proj = pantheon_project()
if _proj is not None:
    _SCRIPTS_DIR_CANDIDATES.append(_proj / ".opencode" / ".pantheon" / "code-mode")
    _SCRIPTS_DIR_CANDIDATES.append(_proj / ".pantheon" / "code-mode")
_SCRIPTS_DIR_CANDIDATES.append(_PANTHEON_HOME / ".pantheon" / "code-mode")

SCRIPTS_DIR: Path = _resolve_scripts_dir(_SCRIPTS_DIR_CANDIDATES) or (
    _PANTHEON_HOME / ".pantheon" / "code-mode"
)

# ── FastMCP App ───────────────────────────────────────────────────────────────
mcp = FastMCP(
    "Pantheon Code Mode",
    instructions="Confined script execution for Pantheon orchestration. "
    "Scripts live in .pantheon/code-mode/ and must be .sh or .py files.",
)

# ── Helpers ───────────────────────────────────────────────────────────────────


def _validate_script_name(script_name: str, scripts_dir: Path | None = None) -> Path:
    """Validate a script name and return its resolved path.

    Args:
        script_name: Bare file name of a script in the code-mode directory.
        scripts_dir: Directory to resolve against. Defaults to ``SCRIPTS_DIR``.

    Raises:
        ValueError: If the name is invalid, traverses paths, or has a
            disallowed extension.
    """
    scripts_dir = scripts_dir or SCRIPTS_DIR

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

    if scripts_dir.is_symlink():
        raise ValueError(f"Invalid script name: '{script_name}'")

    try:
        scripts_root = scripts_dir.resolve(strict=True)
        script_path = (scripts_dir / name).resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError):
        raise ValueError(f"Script '{script_name}' not found") from None

    if (
        not _is_within(script_path, scripts_root)
        or script_path.parent != scripts_root
        or not script_path.is_file()
    ):
        raise ValueError(f"Invalid script name: '{script_name}'")

    return script_path


# ── Installation Mode: Manifest + SHA-256 ─────────────────────────────────────
# The manifest is the explicit opt-in. A script is executable only when its
# bare name is present in `manifest.json` AND the SHA-256 of the on-disk file
# matches the recorded digest. Any deviation fails closed with a contract
# status instead of executing.


class ManifestError(Exception):
    """Raised when the code-mode manifest cannot authorise execution."""

    def __init__(self, status: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _manifest_path(scripts_dir: Path | None = None) -> Path:
    """Return the manifest path for *scripts_dir* (defaults to SCRIPTS_DIR)."""
    return (scripts_dir or SCRIPTS_DIR) / MANIFEST_FILENAME


def _sha256_file(path: Path) -> str:
    """Return the hex SHA-256 digest of *path* (streamed, binary-safe)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_manifest(scripts_dir: Path | None = None) -> dict[str, str]:
    """Load and validate the manifest, returning ``{script_name: sha256}``.

    Raises:
        ManifestError: With ``INVALID_STATE`` when the manifest is absent (no
            explicit opt-in), or ``CORRUPT_DATA`` when it is unreadable or
            malformed.
    """
    manifest_file = _manifest_path(scripts_dir)
    if not manifest_file.is_file():
        raise ManifestError(
            "INVALID_STATE",
            f"Code-mode manifest not found at {manifest_file}. No script executes "
            "without explicit opt-in — run approve_code_script first.",
        )

    try:
        raw = manifest_file.read_text(encoding="utf-8")
    except OSError as exc:
        raise ManifestError(
            "CORRUPT_DATA", f"Code-mode manifest unreadable: {exc}"
        ) from None

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        raise ManifestError(
            "CORRUPT_DATA",
            f"Code-mode manifest is malformed JSON: {manifest_file}",
        ) from None

    if not isinstance(data, dict):
        raise ManifestError(
            "CORRUPT_DATA", "Code-mode manifest must be a JSON object."
        )

    scripts = data.get("scripts")
    if not isinstance(scripts, dict):
        raise ManifestError(
            "CORRUPT_DATA",
            "Code-mode manifest is malformed: missing 'scripts' object.",
        )

    approved: dict[str, str] = {}
    for name, digest in scripts.items():
        if (
            not isinstance(name, str)
            or not isinstance(digest, str)
            or len(digest) != _SHA256_HEX_LEN
        ):
            raise ManifestError(
                "CORRUPT_DATA",
                f"Code-mode manifest entry for '{name}' is malformed "
                "(expected a 64-character SHA-256 hex digest).",
            )
        approved[name] = digest.lower()
    return approved


def _verify_approved(script_path: Path, scripts_dir: Path | None = None) -> None:
    """Authorise *script_path* against the manifest.

    Raises:
        ManifestError: ``CONFLICT`` when the script is not listed and
            ``CORRUPT_DATA`` when its hash does not match the recorded digest.
    """
    approved = _load_manifest(scripts_dir)
    name = script_path.name
    if name not in approved:
        raise ManifestError(
            "CONFLICT",
            f"Script '{name}' is not approved in the code-mode manifest. "
            "Run approve_code_script to opt in.",
        )
    actual = _sha256_file(script_path)
    if actual != approved[name]:
        raise ManifestError(
            "CORRUPT_DATA",
            f"Script '{name}' hash mismatch (expected {approved[name]}, got "
            f"{actual}). Re-approve the script after verifying the change.",
        )


def _approve_script(
    script_name: str, scripts_dir: Path | None = None
) -> tuple[str, str]:
    """Add or refresh *script_name* in the manifest with its SHA-256.

    Returns:
        A ``(status, message)`` tuple; the status is a contract code and is
        ``OK`` on success.
    """
    target_dir = scripts_dir or SCRIPTS_DIR
    try:
        script_path = _validate_script_name(script_name, target_dir)
    except ValueError as exc:
        return "INVALID_INPUT", str(exc)

    try:
        approved = _load_manifest(target_dir)
    except ManifestError as exc:
        if exc.status == "INVALID_STATE":
            approved = {}
        else:
            return exc.status, exc.message

    approved[script_path.name] = _sha256_file(script_path)
    payload = {
        "version": MANIFEST_VERSION,
        "scripts": dict(sorted(approved.items())),
    }
    try:
        _manifest_path(target_dir).write_text(
            json.dumps(payload, indent=2) + "\n", encoding="utf-8"
        )
    except OSError as exc:
        return "UNAVAILABLE", f"Failed to write code-mode manifest: {exc}"

    digest = approved[script_path.name]
    return "OK", f"Approved '{script_path.name}' with SHA-256 {digest}"


def _generate_manifest(scripts_dir: Path | None = None) -> int:
    """Write a manifest covering every valid script in *scripts_dir*.

    Used by the installer to (re)seed the explicit opt-in for bundled scripts.

    Returns:
        The number of scripts recorded.
    """
    target_dir = scripts_dir or SCRIPTS_DIR
    try:
        resolved_dir = target_dir.resolve(strict=True)
    except (OSError, RuntimeError):
        return 0

    approved: dict[str, str] = {}
    if resolved_dir.is_dir() and not resolved_dir.is_symlink():
        for candidate in sorted(resolved_dir.iterdir()):
            if candidate.name.startswith("."):
                continue
            if candidate.suffix.lower() not in ALLOWED_EXTENSIONS:
                continue
            try:
                resolved = candidate.resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            if (
                resolved.is_file()
                and resolved.parent == resolved_dir
                and _is_within(resolved, resolved_dir)
            ):
                approved[candidate.name] = _sha256_file(resolved)

    payload = {
        "version": MANIFEST_VERSION,
        "scripts": dict(sorted(approved.items())),
    }
    try:
        _manifest_path(target_dir).write_text(
            json.dumps(payload, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        return 0
    return len(approved)


def _contract_result(
    status: str, message: str, json_output: bool
) -> str | dict[str, Any]:
    """Build a contract-labelled error result (text or structured JSON)."""
    if json_output:
        return {"status": status, "error": message}
    return f"[{status}] {message}"



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
        body_lines.append(
            stripped[1:].lstrip() if stripped.startswith("# ") else stripped[1:]
        )
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
    status: str = "OK",
) -> str | dict[str, Any]:
    """Build the tool result in plain-text or structured JSON form."""
    if json_output:
        return {
            "status": status,
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
    description=(
        "Content of a code-mode script by name, with parsed frontmatter metadata"
    ),
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
        return _contract_result("INVALID_INPUT", str(e), json_output)

    metadata = _parse_frontmatter(script_path)
    denied = _validate_args(script_path, args)
    if denied is not None:
        return _contract_result("INVALID_INPUT", denied, json_output)

    try:
        _verify_approved(script_path)
    except ManifestError as e:
        return _contract_result(e.status, e.message, json_output)

    timeout_s = _script_timeout(script_path)

    # Ensure script is executable
    if not os.access(script_path, os.X_OK):
        with suppress(OSError):
            mode = script_path.stat().st_mode
            script_path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    script_dir = script_path.parent
    started = time.monotonic()

    # ── Build sanitized env & optional prlimit prefix ────────────────────
    env_dict = _build_script_env()
    prlimit = _prlimit_prefix(_detect_prlimit(), timeout_s)

    # Command: optionally wrapped with prlimit for resource limits.
    if prlimit is not None:
        cmd = [*prlimit, str(script_path), *args]
    else:
        cmd = [str(script_path), *args]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(script_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env_dict,
            start_new_session=True,
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
            # Kill the entire process group so child processes don't survive.
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, OSError):
                proc.kill()  # fallback: kill main process only
            await proc.wait()
            duration_ms = int((time.monotonic() - started) * 1000)
            return _build_result(
                "",
                "",
                -1,
                timed_out=True,
                duration_ms=duration_ms,
                metadata=metadata,
                json_output=json_output,
                timeout_s=timeout_s,
                status="TIMEOUT",
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
            status="UNAVAILABLE",
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
            status="UNAVAILABLE",
        )


@mcp.tool(
    name="approve_code_script",
    description="Approve a .sh/.py script for execution by adding it to the "
    "code-mode manifest with its SHA-256. Execution is opt-in: only approved "
    "scripts with a matching hash run. Set json_output=true for structured JSON.",
)
async def approve_code_script(
    script_name: str,
    json_output: bool = False,
) -> str | dict[str, Any]:
    """Approve (or re-approve) a code-mode script.

    Args:
        script_name: Name of the script in the code-mode directory.
        json_output: When True, return ``{"status", "message"}`` instead of a
            ``[STATUS] message`` string.

    Returns:
        A contract-labelled result. ``OK`` on success, ``INVALID_INPUT`` when
        the script name is invalid, or ``CORRUPT_DATA``/``UNAVAILABLE`` when
        the manifest cannot be read or written.
    """
    status, message = _approve_script(script_name)
    if json_output:
        return {"status": status, "message": message}
    return f"[{status}] {message}"


# ── Main Entrypoint ───────────────────────────────────────────────────────────


def _cli() -> int:
    """Handle CLI subcommands used by the installer; fall back to serving MCP."""
    argv = sys.argv[1:]
    if "--generate-manifest" in argv:
        scripts_dir: Path | None = None
        if "--scripts-dir" in argv:
            index = argv.index("--scripts-dir")
            if index + 1 < len(argv):
                scripts_dir = Path(argv[index + 1])
        count = _generate_manifest(scripts_dir)
        print(f"code-mode manifest: {count} script(s) approved")
        return 0
    mcp.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())

