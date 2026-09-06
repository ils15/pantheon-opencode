#!/usr/bin/env python3
"""
Checkpoint Session Manager for Auto-Continue V2.

Structured persistence for session checkpoints, heartbeat tracking, and
session metadata for long autonomous deepwork sessions.

Usage:
    python checkpoint_session.py <command> <slug> [options]

Commands:
    init    — Initialize session files (session.json + heartbeat.json)
    save    — Save checkpoint and update heartbeat
    status  — Show current session status
    resume  — Read latest checkpoint for resume
    list    — List all checkpoints for slug
    health  — Validate session consistency
    archive — Move session to archive/
    cleanup — Clean orphaned sessions and temp files (--dry-run for preview)
"""

from __future__ import annotations

import hashlib
import json
import sys
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCHEMA_VERSION = 2
DEEPDIR = Path(".pantheon/deepwork")
ARCHIVEDIR = DEEPDIR / "archive"
STALE_THRESHOLD = timedelta(hours=24)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def get_slug_dir(slug: str) -> Path:
    """Return the deepwork directory path for a given slug."""
    return DEEPDIR / slug


def get_checkpoints(slug_dir: Path) -> list[tuple[int, Path]]:
    """Return sorted list of (number, path) for all checkpoint files.

    Only files matching checkpoint-N.json where *N* is a positive
    integer are considered.  Dotfiles and non-numeric suffixes are
    ignored.
    """
    checkpoints: list[tuple[int, Path]] = []
    for f in slug_dir.glob("checkpoint-*.json"):
        stem = f.stem  # e.g. "checkpoint-3"
        parts = stem.split("-", 1)
        if len(parts) != 2:  # noqa: PLR2004
            continue
        try:
            n = int(parts[1])
        except (ValueError, IndexError):
            continue
        checkpoints.append((n, f))
    checkpoints.sort(key=lambda x: x[0])
    return checkpoints


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_init(slug: str) -> None:
    """Create session.json and heartbeat.json for *slug*."""
    sdir = get_slug_dir(slug)
    sdir.mkdir(parents=True, exist_ok=True)

    now = datetime.now(UTC).isoformat()

    session = {
        "task_id": slug,
        "mode": "deepwork",
        "start_time": now,
        "last_activity": now,
        "status": "in_progress",
        "gate_history": [],
        "stop_reason": None,
        "stopped_at": None,
    }
    _write_json(sdir / "session.json", session)

    heartbeat = {
        "slug": slug,
        "last_action": now,
        "turn_count": 0,
        "current_phase": 0,
        "status": "alive",
        "next_action": "initialized",
    }
    _write_json(sdir / "heartbeat.json", heartbeat)

    print(f"Session initialized for {slug}")


def cmd_save(slug: str) -> None:
    """Save a checkpoint and update heartbeat / session metadata."""
    sdir = get_slug_dir(slug)
    if not sdir.exists():
        print(f"No session found for {slug}")
        return

    now = datetime.now(UTC).isoformat()

    # Read existing STATUS.md for context hash
    context_hash = _compute_context_hash(sdir)

    # Load or create session metadata
    session_file = sdir / "session.json"
    if session_file.exists():
        session = _read_json(session_file)
    else:
        session = {
            "task_id": slug,
            "mode": "deepwork",
            "start_time": now,
            "last_activity": now,
            "status": "in_progress",
            "gate_history": [],
            "stop_reason": None,
            "stopped_at": None,
        }

    turn_count = session.get("turn_count", 0) + 1
    current_phase = session.get("current_phase", 0)

    # Update session
    session["last_activity"] = now
    session["turn_count"] = turn_count
    _write_json(session_file, session)

    # Update heartbeat
    heartbeat = {
        "slug": slug,
        "last_action": now,
        "turn_count": turn_count,
        "current_phase": current_phase,
        "status": "alive",
        "next_action": "checkpoint saved",
    }
    _write_json(sdir / "heartbeat.json", heartbeat)

    # Determine next checkpoint number
    checkpoints = get_checkpoints(sdir)
    n = (checkpoints[-1][0] + 1) if checkpoints else 1

    # Build checkpoint
    checkpoint = {
        "slug": slug,
        "phase": current_phase,
        "turn_count": turn_count,
        "timestamp": now,
        "context_hash": context_hash,
        "version": SCHEMA_VERSION,
    }
    _write_json(sdir / f"checkpoint-{n}.json", checkpoint)

    print(f"Checkpoint {n} saved for {slug}")


def cmd_status(slug: str) -> None:
    """Print human-readable session status."""
    sdir = get_slug_dir(slug)
    if not sdir.exists():
        print(f"No session found for {slug}")
        return

    print(f"=== Session: {slug} ===\n")

    session_file = sdir / "session.json"
    if session_file.exists():
        session = _read_json(session_file)
        print(f"Status:        {session.get('status', 'unknown')}")
        print(f"Started:       {session.get('start_time', 'unknown')}")
        print(f"Last Activity: {session.get('last_activity', 'unknown')}")
        gates = session.get("gate_history", [])
        print(f"Gates Passed:  {len(gates)}")
        print(f"Turn Count:    {session.get('turn_count', 0)}")
        print(f"Phase:         {session.get('current_phase', 0)}")
    else:
        print("No session.json found")

    hb_file = sdir / "heartbeat.json"
    if hb_file.exists():
        hb = _read_json(hb_file)
        print(f"Agent Status:  {hb.get('status', 'unknown')}")
        print(f"Next Action:   {hb.get('next_action', 'unknown')}")

    checkpoints = get_checkpoints(sdir)
    print(f"\nCheckpoints:   {len(checkpoints)}")
    for n, _ in checkpoints[-5:]:  # show last 5
        print(f"  checkpoint-{n}.json")


def cmd_resume(slug: str) -> None:
    """Print the latest checkpoint as JSON (for programmatic consumption)."""
    sdir = get_slug_dir(slug)
    checkpoints = get_checkpoints(sdir)
    if not checkpoints:
        print(f"No checkpoints found for {slug}")
        return

    _, path = checkpoints[-1]
    cp = _read_json(path)
    print(json.dumps(cp, indent=2))


def cmd_list(slug: str) -> None:
    """List all checkpoints for *slug*."""
    sdir = get_slug_dir(slug)
    checkpoints = get_checkpoints(sdir)
    if not checkpoints:
        print(f"No checkpoints found for {slug}")
        return

    print(f"Checkpoints for {slug}:")
    for n, path in checkpoints:
        cp = _read_json(path)
        ts = cp.get("timestamp", "unknown")
        phase = cp.get("phase", "?")
        turns = cp.get("turn_count", "?")
        print(f"  [{n}] phase={phase} turns={turns} @ {ts}")


def cmd_health(slug: str) -> None:
    """Validate session consistency."""
    sdir = get_slug_dir(slug)
    issues = []

    if not sdir.exists():
        print(f"❌ Session not found: {slug}")
        return

    session: dict = {}
    hb: dict = {}

    # Check session.json
    session_file = sdir / "session.json"
    if not session_file.exists():
        issues.append("Missing session.json")
    else:
        try:
            session = _read_json(session_file)
            required = ["task_id", "status", "start_time", "last_activity"]
            for field in required:
                if field not in session:
                    issues.append(f"session.json missing field: {field}")
        except (json.JSONDecodeError, ValueError):
            issues.append("session.json is corrupted (invalid JSON)")

    # Check heartbeat.json
    hb_file = sdir / "heartbeat.json"
    if not hb_file.exists():
        issues.append("Missing heartbeat.json")
    else:
        try:
            hb = _read_json(hb_file)
            if hb.get("status") == "stalled":
                issues.append("Session is marked as STALLED")
        except (json.JSONDecodeError, ValueError):
            issues.append("heartbeat.json is corrupted (invalid JSON)")

    # Check checkpoint integrity
    checkpoints = get_checkpoints(sdir)
    if checkpoints:
        for n, path in checkpoints:
            try:
                cp = _read_json(path)
                if cp.get("version", 1) > SCHEMA_VERSION:
                    issues.append(f"checkpoint-{n}.json has newer schema version")
                if "slug" not in cp or "timestamp" not in cp:
                    issues.append(f"checkpoint-{n}.json missing required fields")
            except (json.JSONDecodeError, ValueError):
                issues.append(f"checkpoint-{n}.json is corrupted")

        # Check sequential numbering
        numbers = [n for n, _ in checkpoints]
        expected = list(range(numbers[0], numbers[-1] + 1))
        if numbers != expected:
            missing = set(expected) - set(numbers)
            issues.append(f"Missing checkpoints: {sorted(missing)}")

    # Check for stale activity
    if session_file.exists() and hb_file.exists() and session:
        try:
            last_action = session.get("last_activity", "")
            if last_action:
                last_time = datetime.fromisoformat(last_action)
                if datetime.now(UTC) - last_time > STALE_THRESHOLD:
                    issues.append(f"No activity for > {STALE_THRESHOLD.total_seconds() / 3600:.0f}h (stale)")
        except (ValueError, TypeError):
            issues.append("Could not parse last_activity timestamp")

    # Report
    if not issues:
        print(f"✅ Session '{slug}' is healthy")
        print(f"   Checkpoints: {len(checkpoints)}, Status: {session.get('status', 'unknown')}")
    else:
        print(f"⚠️  Session '{slug}' has {len(issues)} issue(s):")
        for issue in issues:
            print(f"   - {issue}")


def cmd_archive(slug: str) -> None:
    """Move session from deepwork/<slug>/ to deepwork/archive/<slug>/."""
    sdir = get_slug_dir(slug)
    if not sdir.exists():
        print(f"Session not found: {slug}")
        return

    archive_dir = ARCHIVEDIR / slug
    if archive_dir.exists():
        print(f"Session '{slug}' already exists in archive. Remove it first or use a different slug.")
        return

    archive_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(sdir), str(archive_dir))
    print(f"📦 Session '{slug}' archived to .pantheon/deepwork/archive/{slug}/")


def cmd_cleanup(dry_run: bool = False) -> None:
    """Clean orphaned sessions and temp files.

    Scans deepwork/ for:
    - Empty directories (no session.json)
    - Sessions with stale heartbeats (> 24h no activity)
    - Temp files (.tmp left from atomic writes)
    """
    if not DEEPDIR.exists():
        print("No deepwork directory found.")
        return

    now = datetime.now(UTC)
    removed_dirs = 0
    removed_files = 0

    for item in sorted(DEEPDIR.iterdir()):
        if not item.is_dir() or item.name == "archive" or item.name.startswith("."):
            continue

        session_file = item / "session.json"
        hb_file = item / "heartbeat.json"

        # Check if it's an orphan (no session.json)
        if not session_file.exists():
            if dry_run:
                print(f"  [dry-run] Would remove orphan directory: {item.name}/")
            else:
                shutil.rmtree(item)
                removed_dirs += 1
                print(f"  Removed orphan directory: {item.name}/")
            continue

        # Check for stale sessions
        if hb_file.exists():
            try:
                hb = _read_json(hb_file)
                last_action = hb.get("last_action", "")
                if last_action:
                    last_time = datetime.fromisoformat(last_action)
                    if now - last_time > STALE_THRESHOLD:
                        if dry_run:
                            print(f"  [dry-run] Would flag stale session: {item.name}/ (last action: {last_action})")
                        else:
                            print(f"  ⏸️  Session '{item.name}' stale since {last_action}")
            except (ValueError, json.JSONDecodeError):
                pass

        # Clean temp files
        for tmp_file in item.glob("*.tmp"):
            if dry_run:
                print(f"  [dry-run] Would remove temp file: {tmp_file.name}")
            else:
                tmp_file.unlink()
                removed_files += 1
                print(f"  Removed temp file: {item.name}/{tmp_file.name}")

    if not dry_run:
        total = removed_dirs + removed_files
        if total == 0:
            print("✅ Nothing to clean.")
        else:
            print(f"✅ Cleaned {removed_dirs} dir(s) and {removed_files} file(s).")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _write_json(path: Path, data: dict) -> None:
    """Atomically write *data* to *path* as JSON."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    tmp.replace(path)


def _read_json(path: Path) -> dict:
    """Read and return JSON content from *path*."""
    return json.loads(path.read_text(encoding="utf-8"))


def _compute_context_hash(sdir: Path) -> str:
    """Return a short SHA-256 hex digest of STATUS.md (if it exists)."""
    status_file = sdir / "STATUS.md"
    if status_file.exists():
        return hashlib.sha256(status_file.read_bytes()).hexdigest()[:8]
    return ""


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

COMMANDS = {
    "init": cmd_init,
    "save": cmd_save,
    "status": cmd_status,
    "resume": cmd_resume,
    "list": cmd_list,
    "health": cmd_health,
    "archive": cmd_archive,
    "cleanup": cmd_cleanup,
}


def main(argv: list[str] | None = None) -> None:
    """Parse CLI arguments and dispatch the requested command."""
    if argv is None:
        argv = sys.argv[1:]

    if len(argv) < 1:
        print(
            "Usage: python checkpoint_session.py <command> [slug] [options]\n"
            f"Commands: {', '.join(sorted(COMMANDS))}\n"
            "Note: 'cleanup' does not require a slug (use --dry-run for preview).",
            file=sys.stderr,
        )
        sys.exit(1)

    command = argv[0]

    # Special handling for cleanup (no slug required)
    if command == "cleanup":
        dry_run = "--dry-run" in argv[1:]
        cmd_cleanup(dry_run=dry_run)
        return

    # All other commands require a slug
    if len(argv) < 2:  # noqa: PLR2004
        print(f"Usage: python checkpoint_session.py {command} <slug>", file=sys.stderr)
        sys.exit(1)

    slug = argv[1]

    if command not in COMMANDS:
        print(
            f"Unknown command: {command!r}. Available: {', '.join(sorted(COMMANDS))}",
            file=sys.stderr,
        )
        sys.exit(1)

    COMMANDS[command](slug)


if __name__ == "__main__":
    main()
