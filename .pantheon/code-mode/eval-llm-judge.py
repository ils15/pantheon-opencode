#!/usr/bin/env python3
# ---
# description: LLM judge for skill/agent quality — scores 4 dimensions (0-100) via an OpenAI-compatible endpoint
# timeout: 120
# ---
"""LLM judge layer of the plugin-eval certification pipeline.

Scores a skill/agent directory on 4 dimensions (correctness, maintainability,
security, practicality), each 0-100, via ONE structured prompt to an
OpenAI-compatible chat endpoint. Emits a single JSON document on stdout:

    {name, dimensions: {correctness, maintainability, security, practicality},
     overall, notes: {<dimension>: <justification>}}

Without explicit opt-in it emits a structured skipped result; missing credentials
or failed calls exit 2 with a clear message.

Env vars:
  OPENAI_API_KEY    required bearer token
  OPENAI_BASE_URL   optional endpoint base (default https://api.openai.com/v1)
  EVAL_JUDGE_MODEL  optional model id (default gpt-4o-mini)

Stdlib only (urllib.request) — no third-party dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_BASE_URL = "https://api.openai.com/v1"
REQUEST_TIMEOUT = 90.0
MAX_CONTENT_CHARS = 12_000
MAX_SUPPORTING_CHARS = 8_000
MAX_SUPPORTING_FILES = 6
DIMENSIONS = ("correctness", "maintainability", "security", "practicality")

JUDGE_PROMPT = """You are a rigorous quality auditor for AI agent skills and agent definitions used in an agentic coding framework. You decide whether a skill or agent definition is production-quality or AI slop.

Apply an explicit ANTI-SLOP bias: flag overengineering, unnecessary abstractions, persona proliferation (multiple fake personas/characters), unverifiable claims, hype language, and instructions that sound impressive but are not actionable.

Score the content on 4 dimensions, each 0-100:
1. correctness — instructions are accurate and internally consistent; no contradictions; no broken references (files, commands, or agents that do not exist or are misnamed).
2. maintainability — clear structure, single responsibility, no overengineering, YAGNI-respecting, easy to update.
3. security — no secrets or credentials; no prompt-injection vectors; no dangerous instructions (e.g. rm -rf, curl | bash, disabling safety checks).
4. practicality — solves a real problem, actionable, not AI slop or hype; a human would actually use it.

Return ONLY a JSON object with this exact shape:
{"correctness": <int 0-100>, "maintainability": <int 0-100>, "security": <int 0-100>, "practicality": <int 0-100>, "notes": {"correctness": "<1-2 sentences>", "maintainability": "<1-2 sentences>", "security": "<1-2 sentences>", "practicality": "<1-2 sentences>"}}

Content to evaluate:
--- BEGIN CONTENT ---
{content}
--- END CONTENT ---
"""

_NAME_RE = re.compile(r"^name:\s*[\"']?([^\"'\n]+?)[\"']?\s*$", re.MULTILINE)


class JudgeError(Exception):
    """Expected, user-facing judge failure."""


def _frontmatter_name(text: str) -> str | None:
    """Extract the frontmatter `name` value, or None when absent."""
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    match = _NAME_RE.search(text[3:end])
    return match.group(1).strip() if match else None


def _discover_doc(path: Path) -> Path:
    """Return the primary doc (SKILL.md or agent .md) for a path."""
    if path.is_file():
        return path
    skill = path / "SKILL.md"
    if skill.is_file():
        return skill
    candidates = sorted(path.glob("*.md"))
    for candidate in candidates:
        try:
            text = candidate.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if text.startswith("---") and text.find("\n---", 3) != -1:
            return candidate
    if candidates:
        return candidates[0]
    raise JudgeError(f"No SKILL.md or .md file found in {path}")


def _supporting_files(doc: Path) -> list[Path]:
    """Script files next to the doc or in its scripts/ subdir (capped)."""
    roots = [doc.parent]
    scripts_dir = doc.parent / "scripts"
    if scripts_dir.is_dir():
        roots.append(scripts_dir)
    found: list[Path] = []
    for root in roots:
        for pattern in ("*.py", "*.sh", "*.js", "*.ts", "*.mjs"):
            found.extend(sorted(root.glob(pattern)))
    return [p for p in found if p.is_file() and p != doc][:MAX_SUPPORTING_FILES]


def _load_content(doc: Path) -> tuple[str, str]:
    """Return (name, content) with the doc plus small supporting files."""
    try:
        text = doc.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise JudgeError(f"Cannot read {doc}: {exc}") from exc
    name = _frontmatter_name(text) or doc.stem
    parts = [f"# {name}\n", text[:MAX_CONTENT_CHARS]]
    if len(text) > MAX_CONTENT_CHARS:
        parts.append(f"\n[... truncated {len(text) - MAX_CONTENT_CHARS} chars ...]")
    support: list[str] = []
    total = 0
    for sibling in _supporting_files(doc):
        try:
            data = sibling.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        chunk = f"\n--- supporting file: {sibling.name} ---\n{data[:2000]}"
        if total + len(chunk) > MAX_SUPPORTING_CHARS:
            break
        support.append(chunk)
        total += len(chunk)
    if support:
        parts.append("\n".join(support))
    return name, "".join(parts)


def _call_llm(prompt: str, allow_external_llm: bool = False) -> str:
    """Send one chat completion request via urllib; return the assistant text."""
    if not allow_external_llm:
        raise JudgeError("External LLM calls require --allow-external-llm or PANTHEON_ALLOW_EXTERNAL_LLM=1")
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise JudgeError(
            "No LLM available: set OPENAI_API_KEY "
            "(optionally OPENAI_BASE_URL and EVAL_JUDGE_MODEL)."
        )
    base_url = os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    parsed_url = urlparse(base_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise JudgeError("OPENAI_BASE_URL must use an http or https URL")
    endpoint = base_url + "/chat/completions"
    model = os.getenv("EVAL_JUDGE_MODEL") or DEFAULT_MODEL
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:200].replace(key, "[redacted]")
        raise JudgeError(f"LLM endpoint returned HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise JudgeError(f"LLM request failed: {reason}") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise JudgeError(f"LLM returned invalid JSON payload: {exc}") from exc
    choices = payload.get("choices") if isinstance(payload, dict) else None
    message = choices[0].get("message") if choices else None
    text = message.get("content") if isinstance(message, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise JudgeError("LLM returned an empty response.")
    return text.replace(key, "[redacted]")


def _parse_json_object(value: str) -> dict[str, Any] | None:
    """Parse strict JSON and the fenced JSON commonly returned by models."""
    candidates = [value.strip()]
    if candidates[0].startswith("```") and candidates[0].endswith("```"):
        candidates.append(candidates[0].split("\n", 1)[-1][:-3].strip())
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _parse_scores(text: str) -> dict[str, Any]:
    """Validate the LLM JSON into the report's dimensions/overall/notes."""
    parsed = _parse_json_object(text)
    if parsed is None:
        raise JudgeError("LLM did not return valid JSON.")
    dimensions: dict[str, int] = {}
    for dim in DIMENSIONS:
        raw = parsed.get(dim)
        try:
            value = int(raw)
        except (TypeError, ValueError) as exc:
            raise JudgeError(f"LLM returned non-integer score for {dim}: {raw!r}") from exc
        if not 0 <= value <= 100:
            raise JudgeError(f"LLM returned out-of-range score for {dim}: {value}")
        dimensions[dim] = value
    raw_notes = parsed.get("notes")
    notes = (
        {dim: str(raw_notes.get(dim, "")) for dim in DIMENSIONS}
        if isinstance(raw_notes, dict)
        else {dim: "" for dim in DIMENSIONS}
    )
    overall = round(sum(dimensions.values()) / len(dimensions), 1)
    return {"dimensions": dimensions, "overall": overall, "notes": notes}


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: `python eval-llm-judge.py <skill-or-agent-dir>`."""
    parser = argparse.ArgumentParser(
        description="LLM judge for skill/agent quality (plugin-eval layer 2)."
    )
    parser.add_argument("path", help="Path to a skill/agent directory or doc file")
    parser.add_argument("--allow-external-llm", action="store_true", help="Permit sending content to the configured LLM endpoint")
    args = parser.parse_args(argv)
    allow_external_llm = args.allow_external_llm or os.getenv("PANTHEON_ALLOW_EXTERNAL_LLM") == "1"
    try:
        doc = _discover_doc(Path(args.path))
        name, content = _load_content(doc)
        if not allow_external_llm:
            print(json.dumps({"name": name, "skipped": True, "reason": "external LLM calls not opted in"}, ensure_ascii=False, indent=2))
            return 0
        raw = _call_llm(JUDGE_PROMPT.replace("{content}", content), allow_external_llm=True)
        result = _parse_scores(raw)
    except JudgeError as exc:
        print(f"eval-llm-judge: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"name": name, **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
