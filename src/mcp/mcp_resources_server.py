#!/usr/bin/env python3
"""Pantheon MCP Resources Server.

Provides MCP resources for the Pantheon agent framework:
- Static resources: agents list, skills list, routing.yml
- Template resources: agent by name, skill by name, deepwork
  plans/status, memory-bank files

Usage:
    python scripts/mcp_resources_server.py
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from _pantheon_paths import pantheon_home, pantheon_project
from eval_store import get_latest_eval, list_evals
from mcp.server.fastmcp import FastMCP

# ── Path Resolution ──────────────────────────────────────────────────────────
_PANTHEON_HOME: Path = pantheon_home()
_PANTHEON_PROJECT: Path | None = pantheon_project()


def _within(path: Path, parent: Path) -> bool:
    """Return whether ``path`` is contained by ``parent`` after resolution."""
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _safe_root(root: Path, parent: Path) -> Path | None:
    """Resolve a resource root, rejecting symlinks that leave its layout."""
    if not root.exists() or not root.is_dir():
        return None
    resolved = root.resolve()
    return resolved if _within(resolved, parent.resolve()) else None


def _resource_root(name: str) -> Path | None:
    """Choose a project-local root before the global installation root.

    A present but unsafe project root is ignored rather than followed; this
    preserves the global fallback while preventing symlink escapes.
    """
    candidates: list[tuple[Path, Path]] = []
    if _PANTHEON_PROJECT is not None:
        if name in {"agents", "skills"}:
            local = _PANTHEON_PROJECT / ".opencode"
            candidates.append((local / name, local))
        elif name in {"deepwork", "memory-bank"}:
            local = _PANTHEON_PROJECT / ".pantheon"
            candidates.append((local / name, local))
    candidates.append((_PANTHEON_HOME / name, _PANTHEON_HOME))
    for root, parent in candidates:
        safe = _safe_root(root, parent)
        if safe is not None:
            return safe
    return None


def _resource_roots(name: str) -> list[Path]:
    """Return safe resource roots in local-first precedence order."""
    roots: list[Path] = []
    if _PANTHEON_PROJECT is not None:
        base_name = ".opencode" if name in {"agents", "skills"} else ".pantheon"
        base = _PANTHEON_PROJECT / base_name
        local = _safe_root(base / name, base)
        if local is not None:
            roots.append(local)
    global_root = _safe_root(_PANTHEON_HOME / name, _PANTHEON_HOME)
    if global_root is not None:
        roots.append(global_root)
    return roots


def _safe_child(root: Path, relative: str) -> Path | None:
    """Resolve a relative resource path without leaving its safe root."""
    resolved = (root / relative).resolve()
    return resolved if _within(resolved, root.resolve()) else None


# ── FastMCP App ───────────────────────────────────────────────────────────────
mcp = FastMCP(
    "Pantheon Resources",
    instructions="MCP Resources for the Pantheon agent framework. "
    "Access agents, skills, routing configuration, deepwork plans, "
    "and memory-bank files via the pantheon:// URI scheme.",
)

# ── Helpers ───────────────────────────────────────────────────────────────────


def _parse_yaml_frontmatter(filepath: Path) -> dict[str, Any]:
    """Parse YAML frontmatter from a markdown file."""
    content = filepath.read_text(encoding="utf-8")
    match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return {}
    try:
        return dict(yaml.safe_load(match.group(1)) or {})
    except yaml.YAMLError:
        return {}


def _get_role_from_frontmatter(frontmatter: dict[str, Any]) -> str:
    """Extract the role/description string from agent frontmatter."""
    desc = frontmatter.get("description", "")
    if not isinstance(desc, str) or not desc:
        return "Pantheon agent"
    if "—" in desc:
        return desc.split("—")[0].strip()
    return desc


# ── Static Resources ──────────────────────────────────────────────────────────


@mcp.resource(
    "pantheon://agents",
    description="List of all Pantheon agents with roles from YAML frontmatter",
)
async def list_agents() -> str:
    """Return a markdown list of all agents with their roles."""
    agents_dirs = _resource_roots("agents")
    if not agents_dirs:
        return "Agents directory not found."

    agents: list[str] = []
    seen: set[str] = set()
    for agents_dir in agents_dirs:
        for f in sorted(agents_dir.iterdir()):
            if f.suffix == ".md" and f.stem.lower() != "readme" and f.name not in seen:
                seen.add(f.name)
                frontmatter = _parse_yaml_frontmatter(f)
                name = frontmatter.get("name", f.stem)
                role = _get_role_from_frontmatter(frontmatter)
                agents.append(f"- **{name}** — {role}")

    return "\n".join(agents) if agents else "No agents found."


@mcp.resource(
    "pantheon://skills",
    description="List of all Pantheon skills with descriptions",
)
async def list_skills() -> str:
    """Return a markdown list of all skills with descriptions."""
    skills_dirs = _resource_roots("skills")
    if not skills_dirs:
        return "Skills directory not found."

    skills: list[str] = []
    seen: set[str] = set()
    for skills_dir in skills_dirs:
        for f in sorted(skills_dir.iterdir()):
            if f.is_dir() and f.name not in seen:
                skill_file = f / "SKILL.md"
                if skill_file.exists():
                    seen.add(f.name)
                    frontmatter = _parse_yaml_frontmatter(skill_file)
                    name = frontmatter.get("name", f.name)
                    desc = frontmatter.get("description", "No description")
                    skills.append(f"- **{name}** — {desc}")

    return "\n".join(skills) if skills else "No skills found."


@mcp.resource(
    "pantheon://routing",
    description="Full content of routing.yml (canonical routing source)",
)
async def get_routing() -> str:
    """Return the full content of routing.yml."""
    routing_file = _safe_child(_PANTHEON_HOME, "routing.yml")
    if routing_file is None and _PANTHEON_PROJECT:
        routing_file = _safe_child(_PANTHEON_PROJECT / "src", "routing.yml")
    if routing_file is None or not routing_file.exists():
        return "routing.yml not found."
    return routing_file.read_text(encoding="utf-8")


# ── Template Resources ────────────────────────────────────────────────────────


@mcp.resource(
    "pantheon://agents/{agent_name}",
    description="Content of an agent file by name (case-insensitive lookup)",
)
async def get_agent(agent_name: str) -> str:
    """Return the full content of an agent file, case-insensitively."""
    name_lower = agent_name.lower()
    for agents_dir in _resource_roots("agents"):
        for f in agents_dir.iterdir():
            if f.suffix == ".md" and f.stem.lower() == name_lower:
                return f.read_text(encoding="utf-8")
    return f"Agent '{agent_name}' not found."


@mcp.resource(
    "pantheon://deepwork/{slug}",
    description="PLAN.md content for a deepwork task slug",
)
async def get_deepwork_plan(slug: str) -> str:
    """Return PLAN.md content for a deepwork slug."""
    deepwork_dir = _resource_root("deepwork")
    if deepwork_dir is None:
        return f"Deepwork '{slug}' not found. (PANTHEON_PROJECT not set)"
    plan_file = _safe_child(deepwork_dir, f"{slug}/PLAN.md")
    if plan_file is None or not plan_file.is_file():
        return f"Deepwork '{slug}' not found."
    return plan_file.read_text(encoding="utf-8")


@mcp.resource(
    "pantheon://deepwork/{slug}/status",
    description="STATUS.md content for a deepwork task slug "
    "(or default IN_PROGRESS message if missing)",
)
async def get_deepwork_status(slug: str) -> str:
    """Return STATUS.md content for a deepwork slug, or a default message."""
    deepwork_dir = _resource_root("deepwork")
    if deepwork_dir is None:
        return "STATUS.md not found. (PANTHEON_PROJECT not set)"
    status_file = _safe_child(deepwork_dir, f"{slug}/STATUS.md")
    if status_file is None or not status_file.is_file():
        return "STATUS.md not found. Current state: IN PROGRESS"
    return status_file.read_text(encoding="utf-8")


@mcp.resource(
    "pantheon://skills/{name}",
    description="Content of a skill's SKILL.md file by name",
)
async def get_skill(name: str) -> str:
    """Return SKILL.md content for a skill directory."""
    skills_dir = _resource_root("skills")
    skill_file = _safe_child(skills_dir, f"{name}/SKILL.md") if skills_dir else None
    if skill_file is None or not skill_file.is_file():
        return f"Skill '{name}' not found."
    return skill_file.read_text(encoding="utf-8")


@mcp.resource(
    "pantheon://memory-bank/{path}",
    description="Content of a .pantheon/memory-bank/ file by relative path "
    "(path traversal blocked).",
)
async def get_memory_bank(path: str) -> str:
    """Return content of a memory-bank file.

    Security: resolves absolute path and verifies it stays within
    .pantheon/memory-bank/ to prevent directory traversal attacks.
    """
    memory_dir = _resource_root("memory-bank")
    if memory_dir is None:
        return "Memory bank not available. (PANTHEON_PROJECT not set)"
    resolved = _safe_child(memory_dir, path)
    if resolved is None:
        return "Path traversal blocked: access denied."

    if not resolved.exists() or not resolved.is_file():
        return f"File '{path}' not found."

    return resolved.read_text(encoding="utf-8")


# ── Plugin Eval Resources ─────────────────────────────────────────────────────


def _valid_plugin_name(name: str) -> bool:
    """Validate a plugin name for the eval resource (no traversal)."""
    return bool(name) and "/" not in name and "\\" not in name and ".." not in name


@mcp.resource(
    "pantheon://eval",
    description="List of evaluated plugins/skills with their latest "
    "certification score (from the plugin_eval memory namespace)",
)
async def list_plugin_evals() -> str:
    """Return a markdown list of evaluated plugins with latest scores."""
    entries = list_evals()
    if not entries:
        return "No plugin evals recorded yet."

    lines = ["# Plugin Eval Certification", ""]
    for entry in entries:
        name = entry.get("name", "?")
        score = entry.get("metadata", {}).get("score", "?")
        created = entry.get("created_at", "")
        lines.append(f"- **{name}** — score {score} (evaluated {created})")
    return "\n".join(lines)


@mcp.resource(
    "pantheon://eval/{plugin}",
    description="Latest certification report for a plugin/skill "
    "(from the plugin_eval memory namespace)",
)
async def get_plugin_eval(plugin: str) -> str:
    """Return the latest eval certification report for a plugin.

    Security: plugin names containing path separators or traversal
    sequences are rejected before any lookup.
    """
    if not _valid_plugin_name(plugin):
        return "Invalid plugin name: blocked."

    entry = get_latest_eval(plugin)
    if entry is None:
        return f"No eval found for plugin '{plugin}'."

    score = entry.get("metadata", {}).get("score", "?")
    created = entry.get("created_at", "")
    value = entry.get("value", "{}")
    return (
        f"# Eval Report: {plugin}\n\n"
        f"**Score:** {score}\n"
        f"**Evaluated:** {created}\n\n"
        f"```json\n{value}\n```"
    )


# ── Main Entrypoint ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
