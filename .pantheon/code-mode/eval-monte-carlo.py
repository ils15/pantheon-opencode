#!/usr/bin/env python3
# ---
# description: Monte Carlo reliability scoring for skills/agents — simulates N runs of the core workflow (plugin-eval layer 3)
# timeout: 120
# ---
"""Monte Carlo reliability layer of the plugin-eval certification pipeline (PR 3).

Simulates N runs of a skill/agent's core workflow. Each run re-verifies the
frontmatter, a seeded random subset of referenced files/commands, and (when
present) the skill's test/verify command. Reliability = passes / runs * 100.

For agents, additionally verifies that `skills:` and `@agent` references point
at real skills/agents and that the YAML frontmatter is valid.

Emits a single JSON document on stdout:
    {runs, passes, reliability (0-100), failures: [{run, reasons}, ...], ...}

Exit codes: 0 = reliability >= 75, 1 = reliability < 75, 2 = usage/IO error.
The declared test command executes once per invocation and its result is
reused across runs (it is deterministic; re-running it N times only burns time).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shlex
import signal
import subprocess
import sys
from datetime import date
from importlib import import_module
from pathlib import Path
from typing import Any, cast

DEFAULT_RUNS = 20
DEFAULT_SEED = 42
TEST_TIMEOUT = 15.0
RELIABILITY_THRESHOLD = 75.0
SAFE_COMMAND_PREFIXES = (
    "pytest",
    "python -m pytest",
    "npm test",
    "npm run test",
    "npm run verify",
    "bash",
    "python",
    "python3",
    "./",
)
KNOWN_AGENTS = frozenset(
    {
        "athena",
        "apollo",
        "hermes",
        "aphrodite",
        "demeter",
        "themis",
        "prometheus",
        "hephaestus",
        "nyx",
        "gaia",
        "iris",
        "mnemosyne",
        "talos",
        "zeus",
    }
)
FILE_REF_RE = re.compile(r"`([\w./-]+\.(?:py|sh|js|ts|mjs|md|json|yml|yaml|toml))`")
COMMAND_STARTS = (
    "python",
    "python3",
    "bash",
    "npm",
    "node",
    "npx",
    "pytest",
    "uv",
    "./",
)
SUPPORTED_COMMANDS = frozenset(
    {"python", "python3", "bash", "npm", "node", "npx", "pytest", "uv"}
)
SHELL_OPERATORS = (";", "&&", "||", "|", ">", "<", "`", "$(")
TEST_SECTION_RE = re.compile(r"^##+\s+(?:Verification|Testing|Test)\b.*$", re.MULTILINE)


def _coerce(value: str) -> Any:
    """Coerce a scalar string into bool/int/float when possible."""
    lowered = value.lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    if lowered in ("null", "none", "~"):
        return None
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


def _minimal_yaml(block: str) -> dict[str, Any]:
    """Tiny YAML-subset parser for flat frontmatter (key: value, lists)."""
    data: dict[str, Any] = {}
    current_key: str | None = None
    for raw in block.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.lstrip().startswith("- "):
            item = line.split("- ", 1)[1].strip().strip('"').strip("'")
            if current_key is not None:
                data.setdefault(current_key, []).append(item)
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        current_key = key.strip()
        value = value.strip()
        if not value:
            data[current_key] = []
        else:
            data[current_key] = _coerce(value.strip('"').strip("'"))
    return data


def _parse_frontmatter(text: str) -> dict[str, Any] | None:
    """Parse a YAML frontmatter block; return None when absent or invalid."""
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    block = text[3:end]
    try:
        yaml = import_module("yaml")
        data = yaml.safe_load(block)
        return data if isinstance(data, dict) else None
    except ImportError:
        return _minimal_yaml(block)
    except Exception:
        return None


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
        if _parse_frontmatter(text) is not None:
            return candidate
    if candidates:
        return candidates[0]
    raise ValueError(f"No SKILL.md or .md file found in {path}")


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        return [value]
    return []


def _extract_references(doc: Path, text: str, is_agent: bool) -> dict[str, list[str]]:
    """Extract file refs, commands, agent mentions, and (agents) skill refs."""
    refs: dict[str, list[str]] = {
        "files": [],
        "commands": [],
        "agents": [],
        "skills": [],
    }
    for match in FILE_REF_RE.finditer(text):
        ref = match.group(1)
        if ref not in refs["files"]:
            refs["files"].append(ref)
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith(COMMAND_STARTS) or stripped.startswith(("#", "//")):
            continue
        cmd = stripped.split("&&")[0].strip()
        if cmd and cmd not in refs["commands"]:
            refs["commands"].append(cmd)
    for mention in re.findall(r"@([a-z][a-z0-9-]*)", text):
        if mention not in refs["agents"]:
            refs["agents"].append(mention)
    if is_agent:
        frontmatter = _parse_frontmatter(text) or {}
        refs["skills"] = [str(s) for s in _as_list(frontmatter.get("skills"))]
    return refs


def _find_test_command(doc: Path, text: str) -> str | None:
    """Return a test/verify command from frontmatter or a Verification section."""
    frontmatter = _parse_frontmatter(text) or {}
    for key in ("test", "test_command", "verify_command", "check_command"):
        value = frontmatter.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for match in TEST_SECTION_RE.finditer(text):
        section = text[match.end() :].split("\n##", 1)[0]
        for line in section.splitlines():
            stripped = line.strip()
            if stripped.startswith(SAFE_COMMAND_PREFIXES) and not stripped.startswith(
                ("#", "//")
            ):
                return stripped.split("&&")[0].strip()
    return None


def _check_frontmatter(doc: Path, is_agent: bool) -> tuple[bool, str]:
    """Validate the doc's YAML frontmatter and required keys."""
    try:
        text = doc.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return False, f"cannot read {doc.name}: {exc}"
    frontmatter = _parse_frontmatter(text)
    if frontmatter is None:
        return False, "frontmatter missing or invalid YAML"
    required = ("name", "description", "mode") if is_agent else ("name", "description")
    missing = [key for key in required if key not in frontmatter]
    if missing:
        return False, f"frontmatter missing keys: {', '.join(missing)}"
    return True, ""


def _resolve_file(ref: str, base: Path, repo_root: Path) -> Path | None:
    """Resolve a file reference against the doc dir, repo root, or CWD."""
    candidate = Path(ref)
    if candidate.is_absolute():
        return candidate if candidate.exists() else None
    for root in (base, repo_root, Path.cwd()):
        resolved = root / ref
        if resolved.exists():
            return resolved
    return None


def _check_file(ref: str, base: Path, repo_root: Path) -> tuple[bool, str]:
    """Verify a referenced file exists (and is executable for shell scripts)."""
    resolved = _resolve_file(ref, base, repo_root)
    if resolved is None:
        return False, f"missing file: {ref}"
    if resolved.suffix == ".sh" and not os.access(resolved, os.X_OK):
        return False, f"not executable: {ref}"
    return True, ""


def _check_command(cmd: str, base: Path, repo_root: Path) -> tuple[bool, str]:
    """Verify a command's file argument exists (module-only commands pass)."""
    for token in cmd.split()[1:]:
        if "/" in token or token.endswith((".py", ".sh", ".js", ".mjs")):
            if _resolve_file(token, base, repo_root) is None:
                return False, f"command references missing file: {token}"
            break
    return True, ""


def _parse_test_command(cmd: str) -> tuple[list[str] | None, str | None]:
    """Parse and validate an allowlisted command without invoking a shell."""
    if any(operator in cmd for operator in SHELL_OPERATORS):
        return None, f"unsafe test command skipped: shell operator in {cmd}"
    try:
        argv = shlex.split(cmd)
    except ValueError as exc:
        return None, f"unsafe test command skipped: invalid command syntax: {exc}"
    if not argv:
        return None, "unsafe test command skipped: empty command"
    executable = Path(argv[0]).name if argv[0].startswith("./") else argv[0]
    if executable not in SUPPORTED_COMMANDS and not argv[0].startswith("./"):
        return None, f"unsafe test command skipped: unsupported command: {argv[0]}"
    return argv, None


def _execute_test_command(argv: list[str], cmd: str, base: Path) -> tuple[bool, str]:
    """Execute a previously validated command and return its result."""
    try:
        proc = subprocess.Popen(
            argv,
            cwd=base,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            _stdout, _stderr = proc.communicate(timeout=TEST_TIMEOUT)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            return False, f"test command timed out: {cmd}"
    except subprocess.TimeoutExpired:
        return False, f"test command timed out: {cmd}"
    except OSError as exc:
        return False, f"test command failed to start: {exc}"
    if proc.returncode != 0:
        return False, f"test command exited {proc.returncode}: {cmd}"
    return True, ""


def _run_test_command(cmd: str, base: Path) -> tuple[bool, str]:
    """Run an allowlisted command without invoking a shell."""
    argv, error = _parse_test_command(cmd)
    if error is not None:
        return False, error
    return _execute_test_command(argv, cmd, base)


class _SimulationState:
    """Inputs and cached state shared by each simulated run."""

    def __init__(self, **values: object) -> None:
        self.doc = cast(Path, values["doc"])
        self.is_agent = cast(bool, values["is_agent"])
        self.refs = cast(dict[str, list[str]], values["refs"])
        self.test_cmd = cast(str | None, values["test_cmd"])
        self.test_result = cast(tuple[bool, str] | None, values["test_result"])
        self.repo_root = cast(Path, values["repo_root"])
        self.skills_dirs = cast(list[Path], values["skills_dirs"])
        self.agents_dir = cast(Path, values["agents_dir"])


def _sampled_items(rng: random.Random, items: list[str]) -> list[str]:
    """Return the seeded random subset used by one simulated run."""
    if not items:
        return []
    count = rng.randint(max(1, len(items) // 2), len(items))
    return rng.sample(items, count)


def _file_failures(rng: random.Random, state: _SimulationState) -> list[str]:
    """Check the sampled file references for one simulated run."""
    failures: list[str] = []
    for ref in _sampled_items(rng, state.refs["files"]):
        ok, reason = _check_file(ref, state.doc.parent, state.repo_root)
        if not ok:
            failures.append(reason)
    return failures


def _command_failures(rng: random.Random, state: _SimulationState) -> list[str]:
    """Check the sampled command references for one simulated run."""
    failures: list[str] = []
    for cmd in _sampled_items(rng, state.refs["commands"]):
        ok, reason = _check_command(cmd, state.doc.parent, state.repo_root)
        if not ok:
            failures.append(reason)
    return failures


def _agent_failures(state: _SimulationState) -> list[str]:
    """Check referenced agent definitions for one simulated run."""
    return [
        f"unknown agent reference: @{agent}"
        for agent in state.refs["agents"]
        if agent in KNOWN_AGENTS and not (state.agents_dir / f"{agent}.md").exists()
    ]


def _skill_failures(state: _SimulationState) -> list[str]:
    """Check referenced skill definitions for one simulated run."""
    return [
        f"unknown skill reference: {skill}"
        for skill in state.refs["skills"]
        if not any(
            (directory / skill / "SKILL.md").exists() for directory in state.skills_dirs
        )
    ]


def _test_failures(state: _SimulationState) -> list[str]:
    """Run the declared test command once and reuse its result."""
    if not state.test_cmd:
        return []
    if state.test_result is None:
        state.test_result = _run_test_command(state.test_cmd, state.doc.parent)
    return [state.test_result[1]] if not state.test_result[0] else []


def _simulate(
    rng: random.Random, state: _SimulationState
) -> tuple[list[str], tuple[bool, str] | None]:
    """Run one simulated execution; return (failure reasons, cached test result)."""
    failures: list[str] = []
    ok, reason = _check_frontmatter(state.doc, state.is_agent)
    if not ok:
        failures.append(reason)
    failures.extend(_file_failures(rng, state))
    failures.extend(_command_failures(rng, state))
    failures.extend(_agent_failures(state))
    failures.extend(_skill_failures(state))
    failures.extend(_test_failures(state))
    return failures, state.test_result


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: `python eval-monte-carlo.py <path> [--runs N]`."""
    parser = argparse.ArgumentParser(
        description="Monte Carlo reliability scoring (plugin-eval layer 3)."
    )
    parser.add_argument("path", help="Path to a skill/agent directory or doc file")
    parser.add_argument(
        "--runs", type=int, default=DEFAULT_RUNS, help="Simulated runs (default 20)"
    )
    parser.add_argument(
        "--seed", type=int, default=DEFAULT_SEED, help="RNG seed (default 42)"
    )
    args = parser.parse_args(argv)
    if args.runs < 1:
        print("eval-monte-carlo: --runs must be >= 1", file=sys.stderr)
        return 2
    repo_root = Path(__file__).resolve().parent.parent.parent
    agents_dir = repo_root / "src" / "agents"
    skills_dirs = [
        repo_root / ".opencode" / "skills",
        Path.home() / ".config" / "opencode" / "skills",
    ]
    try:
        doc = _discover_doc(Path(args.path))
    except ValueError as exc:
        print(f"eval-monte-carlo: {exc}", file=sys.stderr)
        return 2
    text = doc.read_text(encoding="utf-8", errors="replace")
    frontmatter = _parse_frontmatter(text) or {}
    is_agent = "mode" in frontmatter
    refs = _extract_references(doc, text, is_agent)
    test_cmd = _find_test_command(doc, text)
    rng = random.Random(args.seed)
    failures_list: list[dict[str, Any]] = []
    state = _SimulationState(
        doc=doc,
        is_agent=is_agent,
        refs=refs,
        test_cmd=test_cmd,
        test_result=None,
        repo_root=repo_root,
        skills_dirs=skills_dirs,
        agents_dir=agents_dir,
    )
    passes = 0
    for run in range(1, args.runs + 1):
        failures, _ = _simulate(rng, state)
        if failures:
            failures_list.append({"run": run, "reasons": failures})
        else:
            passes += 1
    reliability = round(100.0 * passes / args.runs, 1)
    report = {
        "name": frontmatter.get("name") or doc.stem,
        "date": date.today().isoformat(),
        "runs": args.runs,
        "passes": passes,
        "reliability": reliability,
        "seed": args.seed,
        "kind": "agent" if is_agent else "skill",
        "test_command": test_cmd,
        "failures": failures_list,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if reliability >= RELIABILITY_THRESHOLD else 1


if __name__ == "__main__":
    sys.exit(main())
