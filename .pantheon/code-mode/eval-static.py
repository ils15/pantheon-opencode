#!/usr/bin/env python3
# ---
# description: Static structural certification for a skill/agent directory
# timeout: 30
# ---
"""eval-static.py — static structural checks for Pantheon skills/agents.

Runs deterministic, LLM-free structural checks against a skill or agent
directory and prints a JSON report to stdout:

  frontmatter      — SKILL.md (or agent *.md) exists with name + description
  referenced_files — files referenced in frontmatter or markdown links exist
  secrets          — no obvious secrets (API keys, tokens, private keys)
  file_size        — every file is under MAX_FILE_SIZE (100 KiB)
  yaml             — YAML frontmatter parses

Usage:
    python eval-static.py <path-to-skill-or-agent-dir>

Output (stdout):
    {"name": ..., "checks": [{"check", "pass", "detail"}, ...], "score": 0-100}

Exit codes:
    0 — all checks passed
    1 — one or more checks failed
    2 — usage error (missing/invalid path)

Stdlib only. Paths are self-resolved (expanduser + resolve); nothing is
hardcoded. The frontmatter parser supports the flat YAML subset used by
skill manifests (scalars, flow lists, block lists) and raises on anything
it cannot parse so malformed frontmatter is flagged rather than ignored.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

MAX_FILE_SIZE = 100 * 1024  # every file must be < 100 KB

# High-confidence credential shapes. Keep in sync with scripts/secret-scan.mjs.
SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("openai_key", re.compile(r"\b(sk|pk|rk)-[A-Za-z0-9]{20,}\b")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_pat", re.compile(r"\bghp_[A-Za-z0-9]{36}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    (
        "credential_assignment",
        re.compile(
            r"\b(?:api[_-]?key|secret|pass" + r"word|token)\s*[:=]\s*['\"]?[A-Za-z0-9_\-./+]{12,}",
            re.IGNORECASE,
        ),
    ),
]

# Frontmatter keys whose values may reference local files.
_REFERENCE_KEYS = ("scripts", "files", "location", "reference", "references")

# Markdown link targets that are NOT local file references.
_EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "#", "data:")

_FM_RE = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)
_KEY_RE = re.compile(r"^([A-Za-z_][\w-]*):\s*(.*)$")
_CLOSERS = {"[": "]", "{": "}"}


# ── Minimal YAML-subset frontmatter parser (stdlib) ──────────────────────────


def _scalar(raw: str) -> str:
    """Return a scalar value with optional surrounding quotes stripped."""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        return raw[1:-1]
    return raw


def parse_yaml_subset(text: str) -> dict[str, Any]:
    """Parse the flat YAML subset used by skill frontmatter.

    Supports ``key: scalar``, ``key: [a, b]`` flow lists and block lists
    (``key:`` followed by ``- item`` lines). Raises ValueError on anything
    it cannot parse (e.g. unbalanced brackets), so callers can flag
    malformed frontmatter instead of silently ignoring it.
    """
    data: dict[str, Any] = {}
    pending_list: str | None = None
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("-"):
            if pending_list is None:
                raise ValueError(f"line {lineno}: list item outside a mapping key")
            data[pending_list].append(_scalar(stripped[1:]))
            continue
        match = _KEY_RE.match(line)
        if not match:
            raise ValueError(f"line {lineno}: unparsable line: {stripped!r}")
        key, raw_value = match.group(1), match.group(2).strip()
        pending_list = None
        if not raw_value:
            data[key] = []
            pending_list = key  # promoted to a real list if "- item" follows
            continue
        if raw_value[0] in _CLOSERS:
            closer = _CLOSERS[raw_value[0]]
            if not raw_value.endswith(closer):
                raise ValueError(f"line {lineno}: unbalanced {raw_value[0]!r} in {key!r}")
            inner = raw_value[1:-1].strip()
            data[key] = [_scalar(v) for v in inner.split(",")] if inner else []
            continue
        data[key] = _scalar(raw_value)
    return data


def frontmatter_text(content: str) -> str | None:
    """Extract the raw frontmatter body from markdown content, or None."""
    match = _FM_RE.match(content)
    return match.group(1) if match else None


def parse_frontmatter(filepath: Path) -> dict[str, Any]:
    """Parse frontmatter into a dict; {} when absent or unparsable."""
    text = frontmatter_text(filepath.read_text(encoding="utf-8", errors="replace"))
    if text is None:
        return {}
    try:
        return parse_yaml_subset(text)
    except ValueError:
        return {}


# ── Path helpers ──────────────────────────────────────────────────────────────


def find_manifest(dir_path: Path) -> Path | None:
    """Return the primary manifest file for a skill/agent directory.

    Prefers ``SKILL.md``; otherwise the first ``*.md`` file that is not
    ``README.md`` (agent files). Returns None if no manifest exists.
    """
    skill = dir_path / "SKILL.md"
    if skill.is_file():
        return skill
    for f in sorted(dir_path.iterdir()):
        if f.is_file() and f.suffix == ".md" and f.stem.lower() != "readme":
            return f
    return None


def _iter_files(dir_path: Path) -> list[Path]:
    """Return all regular files under dir_path (recursive, sorted)."""
    return sorted(p for p in dir_path.rglob("*") if p.is_file())


# ── Checks ────────────────────────────────────────────────────────────────────


def check_frontmatter(dir_path: Path) -> tuple[bool, str]:
    """Check (a): manifest exists with required name + description."""
    manifest = find_manifest(dir_path)
    if manifest is None:
        return False, "No SKILL.md or agent .md manifest found"
    fm = parse_frontmatter(manifest)
    missing = [k for k in ("name", "description") if not fm.get(k)]
    if missing:
        return False, f"{manifest.name} missing frontmatter: {', '.join(missing)}"
    return True, f"{manifest.name} has name + description"


def _frontmatter_references(fm: dict[str, Any]) -> list[str]:
    """Collect file-path-looking values from frontmatter reference keys."""
    refs: list[str] = []
    for key in _REFERENCE_KEYS:
        value = fm.get(key)
        if isinstance(value, str):
            refs.append(value)
        elif isinstance(value, list):
            refs.extend(v for v in value if isinstance(v, str))
    return [r for r in refs if r and not r.startswith(("http://", "https://", "#"))]


def _markdown_references(manifest: Path) -> list[str]:
    """Collect relative markdown link targets from the manifest body."""
    content = manifest.read_text(encoding="utf-8", errors="replace")
    refs: list[str] = []
    for target in re.findall(r"\]\(([^)]+)\)", content):
        target = target.strip()
        if not target or target.startswith(_EXTERNAL_PREFIXES):
            continue
        # Strip optional anchor suffix (path#section)
        refs.append(target.split("#", 1)[0])
    return refs


def check_referenced_files(dir_path: Path) -> tuple[bool, str]:
    """Check (b): referenced scripts/files exist relative to the dir."""
    manifest = find_manifest(dir_path)
    refs = _frontmatter_references(parse_frontmatter(manifest)) if manifest else []
    if manifest is not None:
        refs.extend(_markdown_references(manifest))

    missing = [r for r in refs if r and not (dir_path / r).exists()]
    if missing:
        return False, f"Missing referenced files: {', '.join(sorted(set(missing)))}"
    if refs:
        return True, f"All {len(refs)} referenced files exist"
    return True, "No local file references found"


def check_secrets(dir_path: Path) -> tuple[bool, str]:
    """Check (c): no obvious secrets (API keys, tokens, private keys)."""
    hits: list[str] = []
    for f in _iter_files(dir_path):
        try:
            content = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for name, pattern in SECRET_PATTERNS:
            if pattern.search(content):
                hits.append(f"{f.name} ({name})")
    if hits:
        return False, f"Potential secrets: {', '.join(sorted(set(hits)))}"
    return True, "No secrets detected"


def check_file_sizes(dir_path: Path) -> tuple[bool, str]:
    """Check (d): every file is under MAX_FILE_SIZE."""
    oversized = [f for f in _iter_files(dir_path) if f.stat().st_size > MAX_FILE_SIZE]
    if oversized:
        biggest = max(oversized, key=lambda f: f.stat().st_size)
        return False, f"Oversized file: {biggest.name} ({biggest.stat().st_size} bytes)"
    return True, f"All files under {MAX_FILE_SIZE} bytes"


def check_yaml(dir_path: Path) -> tuple[bool, str]:
    """Check (e): YAML frontmatter parses."""
    manifest = find_manifest(dir_path)
    if manifest is None:
        return True, "No manifest to parse"
    text = frontmatter_text(manifest.read_text(encoding="utf-8", errors="replace"))
    if text is None:
        return True, "No frontmatter to parse"
    try:
        parse_yaml_subset(text)
    except ValueError as exc:
        return False, f"Frontmatter does not parse: {exc}"
    return True, "Frontmatter parses"


_CHECK_FUNCS: tuple[tuple[str, Any], ...] = (
    ("frontmatter", check_frontmatter),
    ("referenced_files", check_referenced_files),
    ("secrets", check_secrets),
    ("file_size", check_file_sizes),
    ("yaml", check_yaml),
)


# ── Report ────────────────────────────────────────────────────────────────────


def run_eval(dir_path: Path) -> dict[str, Any]:
    """Run all checks and build the certification report dict."""
    results = [(name, fn(dir_path)) for name, fn in _CHECK_FUNCS]
    checks = [
        {"check": name, "pass": ok, "detail": detail}
        for name, (ok, detail) in results
    ]
    passed = sum(1 for _, (ok, _) in results if ok)
    total = len(results)

    manifest = find_manifest(dir_path)
    fm = parse_frontmatter(manifest) if manifest else {}
    return {
        "name": str(fm.get("name") or dir_path.name),
        "checks": checks,
        "score": round(passed / total * 100) if total else 0,
    }


# ── CLI ───────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint: eval a skill/agent dir, print JSON, set exit code."""
    argv = sys.argv[1:] if argv is None else argv

    parser = argparse.ArgumentParser(
        prog="eval-static.py",
        description="Static structural certification for a skill/agent directory.",
    )
    parser.add_argument("path", nargs="?", help="Path to the skill or agent directory")
    args = parser.parse_args(argv)

    if not args.path:
        print("Usage: python eval-static.py <skill-or-agent-dir>", file=sys.stderr)
        return 2

    dir_path = Path(args.path).expanduser().resolve()
    if not dir_path.exists():
        print(f"Error: path not found: {args.path}", file=sys.stderr)
        return 2
    if not dir_path.is_dir():
        print(f"Error: not a directory: {args.path}", file=sys.stderr)
        return 2

    report = run_eval(dir_path)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if all(c["pass"] for c in report["checks"]) else 1


if __name__ == "__main__":
    sys.exit(main())
