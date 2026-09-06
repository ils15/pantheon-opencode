#!/usr/bin/env python3
"""compress-inline.py — Pantheon inline context compression.

Called by agents via execute_code_script('compress-inline.py') during
active sessions. Replaces third-party magic-compact plugin with a
Pantheon-native solution.

Modes:
  score    --text "<text>"                          → Score text, output priority JSON
  compress --text "<text>" [--files "<files>"]      → Scrub + score + 3-line summary
  stats    --text "<text>"                           → Token/line/char estimates
  batch    --files "file1,file2"                     → Read & compress multiple files

Optional (all modes):
  --from-agent <name>  Source agent for downstream relevance scoring
  --to-agent   <name>  Target agent for downstream relevance scoring
  --blocker            Hint that entry was a blocker
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

# Security scrubbing — delegated to canonical scripts/scrub_secrets.py (imported above).
_scripts_dir = Path(__file__).resolve().parents[2] / "scripts"
_spec = importlib.util.spec_from_file_location(
    "scrub_secrets", _scripts_dir / "scrub-secrets.py"
)
_scrub_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_scrub_mod)
scrub = _scrub_mod.scrub


# ---------------------------------------------------------------------------
# Priority scoring engine (fully deterministic — no LLM)
# ---------------------------------------------------------------------------

# Each entry: (name, compiled_pattern, impact, risk, novelty)
# Names and values from .opencode/skills/context-compression/SKILL.md
KeywordEntry = tuple[str, re.Pattern, float, float, float]

KEYWORD_MAP: list[KeywordEntry] = [
    # schema/migration
    ("schema", re.compile(r"schema", re.IGNORECASE), 1.0, 1.0, 0.6),
    ("migration", re.compile(r"migration", re.IGNORECASE), 1.0, 1.0, 0.4),
    ("new table", re.compile(r"new\s+table", re.IGNORECASE), 1.0, 0.8, 0.9),
    ("new column", re.compile(r"new\s+column", re.IGNORECASE), 0.7, 0.8, 0.6),
    # auth/security
    ("auth", re.compile(r"auth", re.IGNORECASE), 1.0, 1.0, 0.5),
    ("login", re.compile(r"login", re.IGNORECASE), 1.0, 1.0, 0.4),
    ("permission", re.compile(r"permission", re.IGNORECASE), 0.8, 1.0, 0.5),
    ("role", re.compile(r"role", re.IGNORECASE), 0.8, 0.8, 0.4),
    ("JWT", re.compile(r"JWT", re.IGNORECASE), 0.8, 1.0, 0.4),
    ("OAuth", re.compile(r"OAuth", re.IGNORECASE), 0.8, 1.0, 0.5),
    ("password", re.compile(r"password", re.IGNORECASE), 0.7, 1.0, 0.3),
    ("encrypt", re.compile(r"encrypt", re.IGNORECASE), 0.7, 1.0, 0.5),
    ("token", re.compile(r"token", re.IGNORECASE), 0.7, 0.8, 0.3),
    ("security", re.compile(r"security", re.IGNORECASE), 0.8, 1.0, 0.4),
    # database
    ("index", re.compile(r"index", re.IGNORECASE), 0.5, 0.6, 0.3),
    ("foreign key", re.compile(r"foreign\s+key", re.IGNORECASE), 0.8, 0.9, 0.5),
    ("constraint", re.compile(r"constraint", re.IGNORECASE), 0.6, 0.7, 0.3),
    # api
    ("endpoint", re.compile(r"endpoint", re.IGNORECASE), 0.9, 0.6, 0.5),
    ("route", re.compile(r"route", re.IGNORECASE), 0.8, 0.5, 0.4),
    ("API", re.compile(r"\bAPI\b", re.IGNORECASE), 0.8, 0.5, 0.4),
    # architecture
    ("service", re.compile(r"service", re.IGNORECASE), 0.7, 0.4, 0.4),
    # structure
    ("new file", re.compile(r"new\s+file", re.IGNORECASE), 0.6, 0.3, 0.8),
    # code-quality
    ("refactor", re.compile(r"refactor", re.IGNORECASE), 0.5, 0.7, 0.6),
    ("rename", re.compile(r"rename", re.IGNORECASE), 0.4, 0.6, 0.3),
    ("delete", re.compile(r"delete", re.IGNORECASE), 0.5, 0.7, 0.2),
    ("deprecat", re.compile(r"deprecat", re.IGNORECASE), 0.4, 0.4, 0.3),
    # infrastructure
    ("config", re.compile(r"config", re.IGNORECASE), 0.5, 0.6, 0.3),
    ("Docker", re.compile(r"Docker", re.IGNORECASE), 0.7, 0.6, 0.3),
    ("deploy", re.compile(r"deploy", re.IGNORECASE), 0.8, 0.8, 0.2),
    # style
    ("CSS", re.compile(r"\bCSS\b", re.IGNORECASE), 0.2, 0.1, 0.2),
    ("style", re.compile(r"style", re.IGNORECASE), 0.2, 0.1, 0.2),
    # trivial
    ("typo", re.compile(r"typo", re.IGNORECASE), 0.0, 0.0, 0.0),
    ("comment", re.compile(r"comment", re.IGNORECASE), 0.1, 0.0, 0.0),
    # documentation
    ("README", re.compile(r"README", re.IGNORECASE), 0.2, 0.0, 0.1),
    ("docstring", re.compile(r"docstring", re.IGNORECASE), 0.2, 0.0, 0.1),
]

WEIGHTS: dict[str, float] = {
    "impact": 0.30,
    "risk": 0.25,
    "novelty": 0.20,
    "blockers": 0.15,
    "downstream": 0.10,
}

# Agent-pair downstream relevance table
# From .opencode/skills/context-compression/SKILL.md lines 110-118
AGENT_PAIR_TABLE: dict[tuple[str, str], float] = {
    ("hermes", "hermes"): 1.0,
    ("hermes", "aphrodite"): 0.9,
    ("hermes", "demeter"): 0.8,
    ("hermes", "themis"): 0.7,
    ("hermes", "mnemosyne"): 0.3,
    ("hermes", "hephaestus"): 0.6,
    ("hermes", "prometheus"): 0.5,
    ("aphrodite", "hermes"): 0.9,
    ("aphrodite", "aphrodite"): 1.0,
    ("aphrodite", "demeter"): 0.3,
    ("aphrodite", "themis"): 0.7,
    ("aphrodite", "mnemosyne"): 0.3,
    ("aphrodite", "hephaestus"): 0.5,
    ("aphrodite", "prometheus"): 0.3,
    ("demeter", "hermes"): 0.9,
    ("demeter", "aphrodite"): 0.3,
    ("demeter", "demeter"): 1.0,
    ("demeter", "themis"): 0.7,
    ("demeter", "mnemosyne"): 0.3,
    ("demeter", "hephaestus"): 0.6,
    ("demeter", "prometheus"): 0.6,
    ("themis", "hermes"): 0.8,
    ("themis", "aphrodite"): 0.8,
    ("themis", "demeter"): 0.8,
    ("themis", "themis"): 1.0,
    ("themis", "mnemosyne"): 0.5,
    ("themis", "hephaestus"): 0.8,
    ("themis", "prometheus"): 0.8,
    ("hephaestus", "hermes"): 0.6,
    ("hephaestus", "aphrodite"): 0.5,
    ("hephaestus", "demeter"): 0.6,
    ("hephaestus", "themis"): 0.7,
    ("hephaestus", "mnemosyne"): 0.3,
    ("hephaestus", "hephaestus"): 1.0,
    ("hephaestus", "prometheus"): 0.4,
    ("prometheus", "hermes"): 0.6,
    ("prometheus", "aphrodite"): 0.4,
    ("prometheus", "demeter"): 0.6,
    ("prometheus", "themis"): 0.7,
    ("prometheus", "mnemosyne"): 0.3,
    ("prometheus", "hephaestus"): 0.4,
    ("prometheus", "prometheus"): 1.0,
    ("mnemosyne", "hermes"): 0.3,
    ("mnemosyne", "aphrodite"): 0.3,
    ("mnemosyne", "demeter"): 0.3,
    ("mnemosyne", "themis"): 0.5,
    ("mnemosyne", "mnemosyne"): 1.0,
    ("mnemosyne", "hephaestus"): 0.3,
    ("mnemosyne", "prometheus"): 0.3,
}

BLOCKER_KEYWORDS: list[re.Pattern] = [
    re.compile(r"blocked", re.IGNORECASE),
    re.compile(r"unblocked", re.IGNORECASE),
    re.compile(r"blocker", re.IGNORECASE),
    re.compile(r"depend", re.IGNORECASE),
    re.compile(r"dependency", re.IGNORECASE),
]


def compute_score(
    text: str,
    from_agent: str | None = None,
    to_agent: str | None = None,
    files_changed: int = 0,
    blocker_hint: bool = False,
) -> dict[str, Any]:
    """Score *text* across 5 deterministic dimensions.

    Returns dict with:
        score, band, impact, risk, novelty, blockers, downstream, keywords_found
    """
    impact_scores: list[float] = []
    risk_scores: list[float] = []
    novelty_scores: list[float] = []
    keywords_found: list[str] = []

    for name, pattern, imp, rsk, nov in KEYWORD_MAP:
        if pattern.search(text):
            impact_scores.append(imp)
            risk_scores.append(rsk)
            novelty_scores.append(nov)
            keywords_found.append(name)

    impact = max(impact_scores) if impact_scores else 0.0
    risk = max(risk_scores) if risk_scores else 0.0
    novelty = max(novelty_scores) if novelty_scores else 0.0

    # Novelty bonus for file count (overrides keyword score)
    if files_changed >= 10:
        novelty = max(novelty, 1.0)
    elif files_changed >= 5:
        novelty = max(novelty, 0.8)

    # Blockers dimension — detect in text or use explicit hint
    blockers: float = 0.0
    for bp in BLOCKER_KEYWORDS:
        if bp.search(text):
            # unblocked/unblocks = positive blocker resolution
            if re.search(r"unblock", text, re.IGNORECASE):
                blockers = max(blockers, 0.8)
            else:
                blockers = max(blockers, 0.5)
    if blocker_hint:
        blockers = max(blockers, 0.8)

    # Downstream relevance
    downstream: float = 0.5  # default when agent pair unknown
    if from_agent and to_agent:
        key = (from_agent.lower().strip(), to_agent.lower().strip())
        downstream = AGENT_PAIR_TABLE.get(key, 0.5)

    score = (
        impact * WEIGHTS["impact"]
        + risk * WEIGHTS["risk"]
        + novelty * WEIGHTS["novelty"]
        + blockers * WEIGHTS["blockers"]
        + downstream * WEIGHTS["downstream"]
    )

    # Priority band (from SKILL.md line 125-131)
    if score >= 0.75:
        band = "CRITICAL"
    elif score >= 0.50:
        band = "HIGH"
    elif score >= 0.25:
        band = "MEDIUM"
    else:
        band = "LOW"

    return {
        "score": round(score, 2),
        "band": band,
        "impact": impact,
        "risk": risk,
        "novelty": novelty,
        "blockers": blockers,
        "downstream": downstream,
        "keywords_found": keywords_found,
    }


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


def compute_stats(text: str) -> dict[str, int]:
    """Compute token estimate (len/4), line count, char count."""
    return {
        "tokens": max(1, len(text) // 4),
        "lines": len(text.splitlines()),
        "chars": len(text),
    }


# ---------------------------------------------------------------------------
# Compression
# ---------------------------------------------------------------------------


def compress(
    text: str,
    files: str = "",
    from_agent: str | None = None,
    to_agent: str | None = None,
) -> str:
    """Scrub + score + compress into ≤3 line summary."""
    scrubbed = scrub(text)[0]

    file_count = len([f for f in files.split(",") if f.strip()]) if files else 0
    result = compute_score(
        scrubbed,
        from_agent=from_agent,
        to_agent=to_agent,
        files_changed=file_count,
    )

    # Summary = first meaningful line of scrubbed text, ≤80 chars
    lines = [l.strip() for l in scrubbed.splitlines() if l.strip()]
    summary: str = ""
    if lines:
        summary = lines[0][:80]
        if len(lines[0]) > 80:
            summary += "…"

    output_parts = [f"- What changed: {summary}", f"- Priority: {result['band']} (score: {result['score']:.2f})"]
    if files:
        output_parts.append(f"- Files: {files}")

    return "\n".join(output_parts)


# ---------------------------------------------------------------------------
# Batch processing
# ---------------------------------------------------------------------------


def process_batch(
    file_paths: list[str],
    from_agent: str | None = None,
    to_agent: str | None = None,
) -> str:
    """Read multiple files, scrub + score + compress each."""
    parts: list[str] = []
    for fpath in file_paths:
        fpath = fpath.strip()
        if not fpath:
            continue
        try:
            with open(fpath, encoding="utf-8") as fh:
                content = fh.read()
        except (OSError, IOError) as exc:
            parts.append(f"- {fpath}: ERROR — {exc}")
            continue

        scrubbed = scrub(content)[0]
        result = compute_score(
            scrubbed,
            from_agent=from_agent,
            to_agent=to_agent,
            files_changed=1,
        )

        # Summary: first meaningful line
        content_lines = [l.strip() for l in scrubbed.splitlines() if l.strip()]
        summary = "(empty)"
        if content_lines:
            summary = content_lines[0][:80]
            if len(content_lines[0]) > 80:
                summary += "…"

        base = os.path.basename(fpath)
        parts.append(f"### {base}")
        parts.append(f"- What changed: {summary}")
        parts.append(f"- Priority: {result['band']} (score: {result['score']:.2f})")
        parts.append("")

    return "\n".join(parts).rstrip()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pantheon inline compression — score, compress, or stat text.",
    )
    parser.add_argument("mode", choices=["score", "compress", "stats", "batch"], help="Operation mode")
    parser.add_argument("--text", type=str, default="", help="Input text to process")
    parser.add_argument(
        "--files",
        type=str,
        default="",
        help="Comma-separated file paths (batch mode, or for file count in scoring)",
    )
    parser.add_argument("--from-agent", type=str, default=None, help="Source agent for downstream relevance")
    parser.add_argument("--to-agent", type=str, default=None, help="Target agent for downstream relevance")
    parser.add_argument("--blocker", action="store_true", default=False, help="Hint that entry was a blocker")

    args = parser.parse_args()

    # -----------------------------------------------------------------------
    # batch mode
    # -----------------------------------------------------------------------
    if args.mode == "batch":
        if not args.files:
            print("Error: --files is required for batch mode", file=sys.stderr)
            sys.exit(1)
        file_list = [f.strip() for f in args.files.split(",") if f.strip()]
        output = process_batch(file_list, from_agent=args.from_agent, to_agent=args.to_agent)
        print(output)
        return

    # -----------------------------------------------------------------------
    # Empty input guard
    # -----------------------------------------------------------------------
    text = args.text
    if not text:
        if args.mode == "score":
            print(
                json.dumps(
                    {
                        "score": 0.0,
                        "band": "LOW",
                        "impact": 0.0,
                        "risk": 0.0,
                        "novelty": 0.0,
                        "blockers": 0.0,
                        "downstream": 0.5,
                        "keywords_found": [],
                    }
                )
            )
        elif args.mode == "compress":
            print("- What changed: (empty)")
            print("- Priority: LOW (score: 0.00)")
        elif args.mode == "stats":
            print(json.dumps({"tokens": 0, "lines": 0, "chars": 0}))
        return

    # -----------------------------------------------------------------------
    # score mode
    # -----------------------------------------------------------------------
    if args.mode == "score":
        file_count = len([f for f in args.files.split(",") if f.strip()]) if args.files else 0
        result = compute_score(
            text,
            from_agent=args.from_agent,
            to_agent=args.to_agent,
            files_changed=file_count,
            blocker_hint=args.blocker,
        )
        print(json.dumps(result))
        return

    # -----------------------------------------------------------------------
    # compress mode
    # -----------------------------------------------------------------------
    if args.mode == "compress":
        output = compress(
            text,
            files=args.files,
            from_agent=args.from_agent,
            to_agent=args.to_agent,
        )
        print(output)
        return

    # -----------------------------------------------------------------------
    # stats mode
    # -----------------------------------------------------------------------
    if args.mode == "stats":
        stats = compute_stats(text)
        print(json.dumps(stats))
        return


if __name__ == "__main__":
    main()
