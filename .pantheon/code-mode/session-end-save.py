#!/usr/bin/env python3
"""Session-end save — exports Vector DB entries to timestamped backup."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

# Bootstrap: resolve PANTHEON_HOME before _pantheon_paths is available
_home_env = os.environ.get("PANTHEON_HOME")
if _home_env:
    _BOOT_HOME = Path(_home_env).expanduser().resolve()
else:
    _xdg = os.environ.get("XDG_CONFIG_HOME")
    _BOOT_HOME = (
        Path(_xdg).expanduser().resolve() / "opencode"
        if _xdg
        else Path.home() / ".config" / "opencode"
    )
sys.path.insert(0, str(_BOOT_HOME / "scripts"))

from _pantheon_paths import pantheon_home, pantheon_project
_PROJECT = pantheon_project()
if _PROJECT is None:
    print("ERROR: PANTHEON_PROJECT not set and CWD unavailable")
    sys.exit(1)
PROJECT_ROOT: Path = _PROJECT
OUTPUT_DIR: Path = PROJECT_ROOT / ".pantheon" / "memory-bank" / ".tmp"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Session-end memory save")
    parser.add_argument("--dry-run", action="store_true", help="Preview without saving")
    parser.add_argument("--agent", default="unknown", help="Agent name triggering save")
    return parser.parse_args()


def detect_agent(args_agent: str) -> str:
    """Return agent name: CLI arg first, then env/fallback."""
    if args_agent and args_agent != "unknown":
        return args_agent
    # Fall back to env var
    from_env = sys.argv[0]
    for candidate in ("zeus", "hermes", "aphrodite", "demeter",
                       "themis", "apollo", "athena", "talos",
                       "prometheus", "hephaestus", "iris",
                       "nyx", "gaia", "mnemosyne"):
        if candidate in from_env.lower():
            return candidate
    return "unknown"


def try_export_memory() -> list[dict] | None:
    """Try to export entries from pantheon-memory via MCP.

    Tries three strategies:
    1. Import memory_mcp_server module and call export directly
    2. If ChromaDB unavailable, create placeholder (no crash)

    Returns list of dicts with keys: content, importance, category, session_id
    Returns None if absolutely unavailable (MCP down, no data).
    Client-side filtering by importance >= 0.4.
    """
    # Strategy 1: Try direct module import
    sys.path.insert(0, str(pantheon_home() / "scripts"))
    try:
        import vector_memory.index as vmi
        # Use memory_sessions-like approach via ChromaDB
        import chromadb
        db_path = pantheon_home() / "memory" / "chroma_db"
        if db_path.exists():
            client = chromadb.PersistentClient(str(db_path))
            collection = client.get_or_create_collection("pantheon_memory")
            results = collection.get()
            if results["ids"]:
                entries = []
                for i, doc_id in enumerate(results["ids"]):
                    meta = results["metadatas"][i] if results["metadatas"] else {}
                    doc = results["documents"][i] if results["documents"] else ""
                    entries.append({
                        "id": doc_id,
                        "content": doc[:200] if doc else "",
                        "importance": meta.get("importance", 0.5),
                        "category": meta.get("category", "memory"),
                        "session_id": meta.get("session_id", ""),
                        "agent": meta.get("agent", "unknown"),
                    })
                # Client-side filter by importance >= 0.4
                filtered = [e for e in entries if e["importance"] >= 0.4]
                if filtered:
                    return filtered
                # If we have entries but all below threshold, don't return None
                # (means MCP is working, just no high-importance entries yet)
                return []
    except ImportError:
        pass
    except Exception as e:
        print(f"  (MCP export note: {e})")
        pass

    # Strategy 2: MCP unavailable — return None (caller handles placeholder)
    return None


def write_session_save(entries: list[dict], agent: str, dry_run: bool = False) -> Path | None:
    """Write session save file. Returns path if written, None if dry-run."""
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    filename = f"session-save-{timestamp}.md"
    filepath = OUTPUT_DIR / filename

    if dry_run:
        print(f"[dry-run] Would save to: {filepath}")
        print(f"[dry-run] Entries: {len(entries)} from agent '{agent}'")
        return None

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    lines = [
        f"# Session Save — {timestamp}",
        f"**Agent:** {agent}",
        f"**Entries:** {len(entries)}",
        "",
        "## Entries",
    ]

    if not entries:
        lines.append("*(No entries with importance >= 0.4)*")
    else:
        for entry in entries:
            content = entry.get("content", "—")
            importance = entry.get("importance", 0)
            category = entry.get("category", "memory")
            lines.append(f"- [{importance:.1f}] ({category}) {content[:200]}")

    filepath.write_text("\n".join(lines) + "\n")
    print(f"  Saved {len(entries)} entries to {filepath}")
    return filepath


def update_deepwork_status(entries_count: int, agent: str) -> None:
    """Append save record to active deepwork STATUS.md if found."""
    deepwork_dir = PROJECT_ROOT / ".pantheon" / "deepwork"
    if not deepwork_dir.exists():
        return
    for status_file in sorted(deepwork_dir.glob("*/STATUS.md")):
        timestamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M")
        line = f"- {timestamp}: Session save — {entries_count} entries (agent: {agent})"
        with open(status_file, "a") as f:
            f.write(f"{line}\n")
        print(f"   Updated {status_file}")


def main() -> None:
    args = parse_args()
    agent = detect_agent(args.agent)

    print(f"Running session-end save (agent: {agent})")

    if args.dry_run:
        print("  --dry-run mode — no files will be written")

    entries = try_export_memory()

    if entries is None:
        print("  pantheon-memory unavailable. Writing placeholder.")
        entries = []

    path = write_session_save(entries, agent, dry_run=args.dry_run)

    if path and not args.dry_run:
        update_deepwork_status(len(entries), agent)

    print()
    print(f"  Agent:     {agent}")
    print(f"  Entries:   {len(entries)}")
    print(f"  Dry-run:   {args.dry_run}")
    print("Session-end save complete.")


if __name__ == "__main__":
    main()
