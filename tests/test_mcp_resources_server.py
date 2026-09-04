"""Tests for the Pantheon MCP Resources server (scripts/mcp-resources-server.py).

Tests cover:
- Static resources: agents list, skills list, routing
- Template resources: agent by name, skill by name, deepwork slug, memory-bank path
- Error handling: missing files, binary content, path traversal
"""

from __future__ import annotations

import importlib
import os
from pathlib import Path
from unittest.mock import patch

import eval_store
import pytest
from mcp.server.fastmcp import FastMCP

# Module path — canonical source lives in src/mcp/
MODULE_PATH = "src.mcp.mcp_resources_server"
ROOT = Path(__file__).resolve().parent.parent


def _text(contents: list | str) -> str:
    """Extract text content from FastMCP read_resource result (list[ReadResourceContents]) or string."""
    if isinstance(contents, str):
        return contents
    if isinstance(contents, list) and len(contents) > 0:
        item = contents[0]
        # ReadResourceContents has .content attribute
        if hasattr(item, "content"):
            return item.content
        return str(item)
    return str(contents)


@pytest.fixture(scope="session")
def module():
    """Import and return the server module."""
    mod = importlib.import_module(MODULE_PATH)
    importlib.reload(mod)
    return mod


@pytest.fixture
def server(module) -> FastMCP:
    """Return the FastMCP server instance."""
    return module.mcp


# =============================================================================
# Static Resources
# =============================================================================


class TestStaticResources:
    """Tests for static (non-parameterized) resources."""

    async def test_agents_list_uri_registered(self, server: FastMCP) -> None:
        """The agents list URI pantheon://agents should be registered."""
        resources = await server.list_resources()
        uris = [str(r.uri) for r in resources]
        assert "pantheon://agents" in uris

    async def test_project_local_agents_take_precedence_over_global(
        self, module, tmp_path: Path
    ) -> None:
        """Project .opencode resources should override the global install."""
        project = tmp_path / "project"
        local = project / ".opencode" / "agents"
        global_dir = tmp_path / "global" / "agents"
        local.mkdir(parents=True)
        global_dir.mkdir(parents=True)
        (local / "local.md").write_text(
            "---\ndescription: Local agent\n---\n", encoding="utf-8"
        )
        (global_dir / "global.md").write_text(
            "---\ndescription: Global agent\n---\n", encoding="utf-8"
        )
        with (
            patch.object(module, "_PANTHEON_PROJECT", project),
            patch.object(module, "_PANTHEON_HOME", tmp_path / "global"),
        ):
            text = await module.list_agents()
        assert "Local agent" in text
        assert "Global agent" in text

    @pytest.mark.parametrize(
        "root_name", ["agents", "skills", "deepwork", "memory-bank"]
    )
    async def test_project_root_symlink_escape_is_rejected(
        self, module, tmp_path: Path, root_name: str
    ) -> None:
        """Unsafe project resource symlinks must not be followed."""
        project = tmp_path / "project"
        outside = tmp_path / "outside" / root_name
        project.mkdir()
        outside.mkdir(parents=True)
        base = project / (
            ".opencode" if root_name in {"agents", "skills"} else ".pantheon"
        )
        base.mkdir()
        (base / root_name).symlink_to(outside, target_is_directory=True)
        global_root = tmp_path / "global" / root_name
        global_root.mkdir(parents=True)
        with (
            patch.object(module, "_PANTHEON_PROJECT", project),
            patch.object(module, "_PANTHEON_HOME", tmp_path / "global"),
        ):
            assert module._resource_root(root_name) == global_root.resolve()

    async def test_symlinked_project_root_is_rejected(
        self, module, tmp_path: Path
    ) -> None:
        """A project reached through PANTHEON_PROJECT or cwd is untrusted."""
        target = tmp_path / "project"
        linked = tmp_path / "project-link"
        (target / ".opencode" / "agents").mkdir(parents=True)
        linked.symlink_to(target, target_is_directory=True)
        global_root = tmp_path / "global" / "agents"
        global_root.mkdir(parents=True)
        (global_root / "global.md").write_text("global", encoding="utf-8")

        with (
            patch.object(module, "_PANTHEON_PROJECT", linked),
            patch.object(module, "_PANTHEON_HOME", tmp_path / "global"),
        ):
            assert module._resource_root("agents") == global_root.resolve()

    @pytest.mark.parametrize("base_name", [".opencode", ".pantheon"])
    async def test_project_base_symlink_is_rejected(
        self, module, tmp_path: Path, base_name: str
    ) -> None:
        """A project resource base must not itself be a symlink."""
        project = tmp_path / "project"
        target = tmp_path / "target"
        project.mkdir()
        target.mkdir()
        (project / base_name).symlink_to(target, target_is_directory=True)
        with patch.object(module, "_PANTHEON_PROJECT", project):
            assert module._safe_root(project / base_name, project) is None

    async def test_internal_symlink_is_rejected_even_when_target_stays_inside(
        self, module, tmp_path: Path
    ) -> None:
        """Child symlinks are unsafe even when they resolve within the root."""
        root = tmp_path / "agents"
        target = root / "real"
        root.mkdir()
        target.write_text("agent", encoding="utf-8")
        link = root / "linked.md"
        link.symlink_to(target)

        assert module._safe_child(root, "linked.md") is None
        assert module._safe_child(root, "real") == target

    async def test_project_symlinked_ancestor_is_rejected(
        self, module, tmp_path: Path
    ) -> None:
        """A symlink in any project ancestor must disable local resources."""
        real_parent = tmp_path / "real-parent"
        project = real_parent / "project"
        (project / ".opencode" / "agents").mkdir(parents=True)
        linked_parent = tmp_path / "linked-parent"
        linked_parent.symlink_to(real_parent, target_is_directory=True)
        linked_project = linked_parent / "project"
        global_root = tmp_path / "global" / "agents"
        global_root.mkdir(parents=True)

        with (
            patch.object(module, "_PANTHEON_PROJECT", linked_project),
            patch.object(module, "_PANTHEON_HOME", tmp_path / "global"),
        ):
            assert module._resource_root("agents") == global_root

    async def test_symlinked_cwd_is_rejected_by_server(
        self, module, tmp_path: Path
    ) -> None:
        """The server applies the same ancestor check to its cwd project."""
        real_parent = tmp_path / "real-parent"
        project = real_parent / "project"
        (project / ".opencode" / "agents").mkdir(parents=True)
        linked_parent = tmp_path / "linked-parent"
        linked_parent.symlink_to(real_parent, target_is_directory=True)
        global_root = tmp_path / "global" / "agents"
        global_root.mkdir(parents=True)

        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(module, "_PANTHEON_PROJECT", None),
            patch.object(module, "_PANTHEON_HOME", tmp_path / "global"),
            patch(
                "src.mcp._pantheon_paths.os.getcwd",
                return_value=str(linked_parent / "project"),
            ),
        ):
            project_from_cwd = module.pantheon_project()
            assert project_from_cwd == linked_parent / "project"
            with patch.object(module, "_PANTHEON_PROJECT", project_from_cwd):
                assert module._resource_root("agents") == global_root

    async def test_symlinked_pantheon_home_is_rejected_by_server(
        self, module, tmp_path: Path
    ) -> None:
        """A symlinked PANTHEON_HOME cannot become a trusted resource root."""
        real_home = tmp_path / "real-home"
        (real_home / "agents").mkdir(parents=True)
        linked_home = tmp_path / "linked-home"
        linked_home.symlink_to(real_home, target_is_directory=True)

        with (
            patch.object(module, "_PANTHEON_PROJECT", None),
            patch.object(module, "_PANTHEON_HOME", linked_home),
        ):
            assert module._resource_root("agents") is None

    async def test_agents_list_rejects_symlink_file_escape(
        self, module, tmp_path: Path
    ) -> None:
        """Agent listings must ignore files resolved outside their safe root."""
        project = tmp_path / "project"
        agents = project / ".opencode" / "agents"
        outside = tmp_path / "outside.md"
        agents.mkdir(parents=True)
        outside.write_text("outside", encoding="utf-8")
        (agents / "escaped.md").symlink_to(outside)
        with (
            patch.object(module, "_PANTHEON_PROJECT", project),
            patch.object(module, "_PANTHEON_HOME", tmp_path / "missing-global"),
        ):
            assert await module.list_agents() == "No agents found."

    async def test_skills_list_rejects_symlink_directory_escape(
        self, module, tmp_path: Path
    ) -> None:
        """Skill listings must ignore directories resolved outside their root."""
        project = tmp_path / "project"
        skills = project / ".opencode" / "skills"
        outside = tmp_path / "outside-skill"
        skills.mkdir(parents=True)
        outside.mkdir()
        (outside / "SKILL.md").write_text("outside", encoding="utf-8")
        (skills / "escaped").symlink_to(outside, target_is_directory=True)
        with (
            patch.object(module, "_PANTHEON_PROJECT", project),
            patch.object(module, "_PANTHEON_HOME", tmp_path / "missing-global"),
        ):
            assert await module.list_skills() == "No skills found."

    async def test_agents_list_returns_markdown(self, server: FastMCP) -> None:
        """Reading pantheon://agents should return agent names and roles."""
        result = await server.read_resource("pantheon://agents")
        text = _text(result)
        assert len(text) > 0
        assert "zeus" in text
        assert "hermes" in text

    async def test_skills_list_uri_registered(self, server: FastMCP) -> None:
        """The skills list URI pantheon://skills should be registered."""
        resources = await server.list_resources()
        uris = [str(r.uri) for r in resources]
        assert "pantheon://skills" in uris

    async def test_skills_list_returns_skill_names(self, server: FastMCP) -> None:
        """Reading pantheon://skills should return skill names."""
        result = await server.read_resource("pantheon://skills")
        text = _text(result)
        assert len(text) > 0
        assert "tdd-with-agents" in text

    async def test_routing_uri_registered(self, server: FastMCP) -> None:
        """The routing URI pantheon://routing should be registered."""
        resources = await server.list_resources()
        uris = [str(r.uri) for r in resources]
        assert "pantheon://routing" in uris

    async def test_routing_returns_yaml_content(self, server: FastMCP) -> None:
        """Reading pantheon://routing should return routing.yml content."""
        result = await server.read_resource("pantheon://routing")
        text = _text(result)
        assert len(text) > 0
        assert "version:" in text
        assert "agents:" in text

    async def test_routing_missing_global_and_project_returns_message(
        self, module, tmp_path: Path
    ) -> None:
        """Missing global and project routing files must not raise an exception."""
        with (
            patch.object(module, "_PANTHEON_HOME", tmp_path / "global"),
            patch.object(module, "_PANTHEON_PROJECT", tmp_path / "project"),
        ):
            assert await module.get_routing() == "routing.yml not found."


# =============================================================================
# Resource Templates
# =============================================================================


class TestResourceTemplates:
    """Tests for parameterized resource templates."""

    async def test_agent_template_registered(self, server: FastMCP) -> None:
        """The agent template pantheon://agents/{name} should be registered."""
        templates = await server.list_resource_templates()
        uris = [str(t.uriTemplate) for t in templates]
        matches = [u for u in uris if "agents" in u and "{" in u]
        assert len(matches) > 0

    async def test_agent_by_name_returns_content(self, server: FastMCP) -> None:
        """Reading pantheon://agents/zeus should return zeus agent content."""
        result = await server.read_resource("pantheon://agents/zeus")
        text = _text(result)
        assert len(text) > 0
        # Should either find zeus or get a meaningful error
        assert "zeus" in text or "not found" in text

    async def test_agent_by_name_case_insensitive(self, server: FastMCP) -> None:
        """Agent names should be matched case-insensitively."""
        result = await server.read_resource("pantheon://agents/Zeus")
        text = _text(result)
        assert len(text) > 0

    async def test_get_agent_rejects_symlink_file_escape(
        self, module, tmp_path: Path
    ) -> None:
        """Agent lookup must not read a matching file outside its root."""
        project = tmp_path / "project"
        agents = project / ".opencode" / "agents"
        outside = tmp_path / "zeus.md"
        agents.mkdir(parents=True)
        outside.write_text("secret outside", encoding="utf-8")
        (agents / "zeus.md").symlink_to(outside)
        with (
            patch.object(module, "_PANTHEON_PROJECT", project),
            patch.object(module, "_PANTHEON_HOME", tmp_path / "missing-global"),
        ):
            result = await module.get_agent("zeus")
        assert "not found" in result.lower()

    async def test_get_agent_local_precedes_global(
        self, module, tmp_path: Path
    ) -> None:
        """A matching local agent must win over the global installation."""
        project = tmp_path / "project"
        local = project / ".opencode" / "agents"
        global_dir = tmp_path / "global" / "agents"
        local.mkdir(parents=True)
        global_dir.mkdir(parents=True)
        (local / "same.md").write_text("local", encoding="utf-8")
        (global_dir / "same.md").write_text("global", encoding="utf-8")
        with (
            patch.object(module, "_PANTHEON_PROJECT", project),
            patch.object(module, "_PANTHEON_HOME", tmp_path / "global"),
        ):
            assert await module.get_agent("SAME") == "local"

    async def test_agent_not_found_returns_error(self, server: FastMCP) -> None:
        """A non-existent agent should return a meaningful error."""
        result = await server.read_resource("pantheon://agents/nonexistent_agent_xyz")
        text = _text(result)
        assert "not found" in text.lower()

    async def test_deepwork_template_registered(self, server: FastMCP) -> None:
        """The deepwork template pantheon://deepwork/{slug} should be registered."""
        templates = await server.list_resource_templates()
        uris = [str(t.uriTemplate) for t in templates]
        matches = [u for u in uris if "deepwork" in u]
        assert len(matches) > 0

    async def test_deepwork_slug_not_found(self, server: FastMCP) -> None:
        """A non-existent deepwork slug should return a meaningful error."""
        result = await server.read_resource("pantheon://deepwork/nonexistent_slug_xyz")
        text = _text(result)
        assert "not found" in text.lower() or "no such" in text.lower()

    async def test_deepwork_status_template_registered(self, server: FastMCP) -> None:
        """The deepwork status template pantheon://deepwork/{slug}/status should be registered."""
        templates = await server.list_resource_templates()
        uris = [str(t.uriTemplate) for t in templates]
        matches = [u for u in uris if "deepwork" in u and "status" in u]
        assert len(matches) > 0

    async def test_deepwork_status_no_file(self, server: FastMCP) -> None:
        """deepwork/{slug}/status should return a default message when STATUS.md doesn't exist."""
        result = await server.read_resource(
            "pantheon://deepwork/nonexistent_slug_xyz/status"
        )
        text = _text(result)
        assert "no STATUS.md" in text.lower() or "in progress" in text.lower()

    async def test_skill_template_registered(self, server: FastMCP) -> None:
        """The skill template pantheon://skills/{name} should be registered."""
        templates = await server.list_resource_templates()
        uris = [str(t.uriTemplate) for t in templates]
        matches = [u for u in uris if "skills" in u and "{" in u]
        assert len(matches) > 0

    async def test_skill_by_name_returns_content(self, server: FastMCP) -> None:
        """Reading pantheon://skills/tdd-with-agents should return skill content."""
        result = await server.read_resource("pantheon://skills/tdd-with-agents")
        text = _text(result)
        assert len(text) > 0

    async def test_skill_not_found_returns_error(self, server: FastMCP) -> None:
        """A non-existent skill should return a meaningful error."""
        result = await server.read_resource("pantheon://skills/nonexistent_skill_xyz")
        text = _text(result)
        assert "not found" in text.lower()

    async def test_memory_bank_template_registered(self, server: FastMCP) -> None:
        """The memory-bank template should be registered."""
        templates = await server.list_resource_templates()
        uris = [str(t.uriTemplate) for t in templates]
        matches = [u for u in uris if "memory-bank" in u]
        assert len(matches) > 0

    async def test_memory_bank_reads_file(self, module) -> None:
        """Reading a memory-bank file should return file content."""
        content = await module.get_memory_bank("00-project.md")
        assert len(content) > 0

    async def test_memory_bank_not_found(self, module) -> None:
        """A non-existent memory-bank file should return a meaningful error."""
        content = await module.get_memory_bank("nonexistent_file_xyz.md")
        assert "not found" in content.lower() or "no such" in content.lower()

    async def test_memory_bank_path_traversal_blocked(self, module) -> None:
        """Path traversal attempts should be blocked."""
        content = await module.get_memory_bank("../../routing.yml")
        assert "traversal" in content.lower() or "blocked" in content.lower()

    async def test_safe_child_rejects_traversal_and_prefix_collision(
        self, module, tmp_path: Path
    ) -> None:
        """Containment must be path-aware, not a string-prefix comparison."""
        root = tmp_path / "root"
        sibling = tmp_path / "root-escape"
        root.mkdir()
        sibling.mkdir()
        assert module._safe_child(root, "../root-escape/file.md") is None
        assert module._safe_child(root, "../root-escape") is None

    async def test_memory_bank_nested_path(self, module) -> None:
        """Nested paths work when handler is called directly."""
        notes_dir = ROOT / "docs" / "memory-bank" / "_notes"
        if notes_dir.is_dir():
            note_files = list(notes_dir.iterdir())
            if note_files:
                nested = f"_notes/{note_files[0].name}"
                content = await module.get_memory_bank(nested)
                assert len(content) > 0


# =============================================================================
# Resource List — Complete URI Coverage
# =============================================================================


class TestResourceList:
    """Tests that all expected resources and templates are listed."""

    async def test_all_static_resources_listed(self, server: FastMCP) -> None:
        """All static resource URIs should appear in the resources list."""
        resources = await server.list_resources()
        uris = [str(r.uri) for r in resources]
        assert "pantheon://agents" in uris
        assert "pantheon://skills" in uris
        assert "pantheon://routing" in uris

    async def test_all_templates_listed(self, server: FastMCP) -> None:
        """All template URIs should appear in the resource templates list."""
        templates = await server.list_resource_templates()
        uris = [str(t.uriTemplate) for t in templates]
        assert "pantheon://agents/{agent_name}" in uris
        assert "pantheon://deepwork/{slug}" in uris
        assert "pantheon://deepwork/{slug}/status" in uris
        assert "pantheon://skills/{name}" in uris
        assert "pantheon://memory-bank/{path}" in uris

    async def test_templates_have_descriptions(self, server: FastMCP) -> None:
        """All templates should have meaningful descriptions."""
        templates = await server.list_resource_templates()
        for t in templates:
            assert t.description and len(t.description) > 0

    async def test_static_resources_have_descriptions(self, server: FastMCP) -> None:
        """All static resources should have descriptions."""
        resources = await server.list_resources()
        for r in resources:
            assert r.description and len(r.description) > 0


# =============================================================================
# Error Handling
# =============================================================================


class TestErrorHandling:
    """Tests for edge cases and error handling."""

    async def test_unknown_uri_returns_error(self, server: FastMCP) -> None:
        """An unknown URI should return a meaningful error, not crash."""
        with pytest.raises((ValueError, Exception)):
            result = await server.read_resource("pantheon://unknown_resource")
            text = _text(result)
            assert "unknown resource" in text.lower() or "not found" in text.lower()

    async def test_unknown_uri_prefix(self, server: FastMCP) -> None:
        """A URI with unknown scheme/prefix should return a meaningful error."""
        with pytest.raises((ValueError, Exception)):
            result = await server.read_resource("pantheon://nonexistent")
            text = _text(result)
            assert "unknown resource" in text.lower() or "not found" in text.lower()

    @pytest.mark.skip(reason="Deepwork directories are created ad-hoc")
    async def test_deepwork_plan_not_found(self, server: FastMCP) -> None:
        """Reading a deepwork PLAN.md that doesn't exist should return error."""
        result = await server.read_resource("pantheon://deepwork/ghost-slug")
        text = _text(result)
        assert "not found" in text.lower()


# =============================================================================
# Server Lifecycle
# =============================================================================


class TestServerLifecycle:
    """Tests for server configuration and lifecycle."""

    async def test_server_name(self, server: FastMCP) -> None:
        """Server should have a descriptive name."""
        assert "pantheon" in server.name.lower()

    async def test_server_instructions(self, server: FastMCP) -> None:
        """Server should have instructions set."""
        assert server.instructions is not None
        assert len(server.instructions) > 0


# =============================================================================
# Plugin Eval Resources (pantheon://eval)
# =============================================================================


@pytest.fixture
def eval_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Seed a temp plugin_eval DB and point eval_store at it."""
    db_path = tmp_path / "memory" / "memory.db"
    monkeypatch.setattr(eval_store, "_db_path", lambda: db_path)
    eval_store.store_eval(
        "tdd-with-agents",
        {"name": "tdd-with-agents", "score": 90, "checks": {}},
        90,
        when="2026-08-21",
    )
    eval_store.store_eval(
        "hermes",
        {"name": "hermes", "score": 85, "checks": {}},
        85,
        when="2026-08-21",
    )
    return eval_store


class TestEvalResources:
    """Tests for the plugin-eval certification resources."""

    async def test_eval_list_uri_registered(self, server: FastMCP) -> None:
        """The eval list URI pantheon://eval should be registered."""
        resources = await server.list_resources()
        uris = [str(r.uri) for r in resources]
        assert "pantheon://eval" in uris

    async def test_eval_template_registered(self, server: FastMCP) -> None:
        """The eval template pantheon://eval/{plugin} should be registered."""
        templates = await server.list_resource_templates()
        uris = [str(t.uriTemplate) for t in templates]
        matches = [u for u in uris if "eval" in u and "{" in u]
        assert len(matches) > 0

    async def test_eval_list_returns_plugins_with_scores(
        self, server: FastMCP, eval_db
    ) -> None:
        """Reading pantheon://eval should list plugins with their latest scores."""
        result = await server.read_resource("pantheon://eval")
        text = _text(result)
        assert "tdd-with-agents" in text
        assert "hermes" in text
        assert "90" in text
        assert "85" in text

    async def test_eval_list_empty_namespace(
        self, server: FastMCP, tmp_path, monkeypatch
    ) -> None:
        """An empty plugin_eval namespace yields a meaningful message."""
        monkeypatch.setattr(
            eval_store, "_db_path", lambda: tmp_path / "memory" / "memory.db"
        )
        result = await server.read_resource("pantheon://eval")
        text = _text(result)
        assert "no" in text.lower() or "none" in text.lower()

    async def test_eval_plugin_returns_report(self, server: FastMCP, eval_db) -> None:
        """Reading pantheon://eval/tdd-with-agents returns the certification report."""
        result = await server.read_resource("pantheon://eval/tdd-with-agents")
        text = _text(result)
        assert "tdd-with-agents" in text
        assert "90" in text

    async def test_eval_plugin_not_found(self, server: FastMCP, eval_db) -> None:
        """An unevaluated plugin returns a meaningful not-found message."""
        result = await server.read_resource("pantheon://eval/ghost-plugin")
        text = _text(result)
        assert "not found" in text.lower() or "no eval" in text.lower()

    async def test_eval_plugin_traversal_blocked(self, module, eval_db) -> None:
        """Path-traversal style plugin names should be blocked."""
        content = await module.get_plugin_eval("../../routing")
        assert "blocked" in content.lower() or "invalid" in content.lower()

    async def test_eval_plugin_underscore_not_wildcard(self, server, eval_db) -> None:
        """Underscores in plugin names must not act as SQL LIKE wildcards."""
        eval_store.store_eval(
            "code_review",
            {"name": "code_review", "score": 99, "checks": {}},
            99,
            when="2026-08-21",
        )
        # Decoy inserted last (highest id): matches 'eval:code_review:%'
        # under LIKE semantics because '_' matches any single character.
        eval_store.store_eval(
            "codexreview",
            {"name": "codexreview", "score": 1, "checks": {}},
            1,
            when="2026-08-21",
        )
        result = await server.read_resource("pantheon://eval/code_review")
        text = _text(result)
        assert "code_review" in text
        assert "99" in text
