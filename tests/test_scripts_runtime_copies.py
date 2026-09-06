"""Behavioral tests for the runtime copies shipped from scripts/.

The installer (scripts/install/opencode.mjs) copies mcp_resources_server.py,
_pantheon_paths.py and eval_store.py into the global install directory and
launches the resources server from there. conftest.py puts scripts/ first on
sys.path, so importing these modules by top-level name executes the shipped
runtime copies — not the canonical src/mcp sources. Each fixture asserts the
resolved __file__ so a sys.path regression fails loudly.
"""

from __future__ import annotations

import importlib
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import eval_store
import pytest

ROOT = Path(__file__).resolve().parent.parent
RESOURCES_MODULE = "mcp_resources_server"
PATHS_MODULE = "_pantheon_paths"
SCRIPTS_RESOURCES = ROOT / "scripts" / "mcp_resources_server.py"
SCRIPTS_PATHS = ROOT / "scripts" / "_pantheon_paths.py"


def _agent_md(name: str, description: str) -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n# {name}\n"


@pytest.fixture
def scripts_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Import the scripts/ resources copy under a hermetic environment."""
    home = tmp_path / "pantheon-home"
    project = tmp_path / "project"
    home.mkdir()
    project.mkdir()
    monkeypatch.setenv("PANTHEON_HOME", str(home))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.setenv("PANTHEON_PROJECT", str(project))
    monkeypatch.chdir(project)
    mod = importlib.import_module(RESOURCES_MODULE)
    importlib.reload(mod)
    assert Path(mod.__file__).resolve() == SCRIPTS_RESOURCES.resolve()
    return mod


@pytest.fixture
def scripts_paths():
    """Import the scripts/ path-resolution copy."""
    mod = importlib.import_module(PATHS_MODULE)
    assert Path(mod.__file__).resolve() == SCRIPTS_PATHS.resolve()
    return mod


# =============================================================================
# scripts/_pantheon_paths.py
# =============================================================================


class TestScriptsPantheonHome:
    """pantheon_home() resolution priority in the runtime copy."""

    def test_env_override_takes_priority(
        self, scripts_paths, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        home = tmp_path / "custom-home"
        monkeypatch.setenv("PANTHEON_HOME", str(home))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
        assert scripts_paths.pantheon_home() == home

    def test_xdg_config_fallback(
        self, scripts_paths, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("PANTHEON_HOME", raising=False)
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
        assert scripts_paths.pantheon_home() == tmp_path / "xdg" / "opencode"

    def test_posix_default_fallback(
        self, scripts_paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("PANTHEON_HOME", raising=False)
        monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
        assert scripts_paths.pantheon_home() == Path.home() / ".config" / "opencode"


class TestScriptsPantheonProject:
    """pantheon_project() resolution priority in the runtime copy."""

    def test_env_override(
        self, scripts_paths, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        project = tmp_path / "proj"
        project.mkdir()
        monkeypatch.setenv("PANTHEON_PROJECT", str(project))
        assert scripts_paths.pantheon_project() == project

    def test_valid_pwd_keeps_logical_symlink_spelling(
        self, scripts_paths, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        target = tmp_path / "project"
        linked = tmp_path / "project-link"
        target.mkdir()
        linked.symlink_to(target, target_is_directory=True)
        monkeypatch.delenv("PANTHEON_PROJECT", raising=False)
        monkeypatch.chdir(linked)
        monkeypatch.setenv("PWD", str(linked))
        result = scripts_paths.pantheon_project()
        assert result == linked.absolute()
        assert result.is_symlink()

    def test_unavailable_cwd_returns_none(
        self, scripts_paths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("PANTHEON_PROJECT", raising=False)
        monkeypatch.delenv("PWD", raising=False)
        with patch("os.getcwd", side_effect=OSError):
            assert scripts_paths.pantheon_project() is None

    def test_invalid_logical_cwd_falls_back_to_physical(
        self, scripts_paths, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("PANTHEON_PROJECT", raising=False)
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("PWD", "relative/nonexistent")
        assert scripts_paths.pantheon_project() == tmp_path

    def test_samefile_failure_rejects_logical_cwd(
        self, scripts_paths, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("PANTHEON_PROJECT", raising=False)
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("PWD", str(tmp_path))
        with patch("os.path.samefile", side_effect=OSError):
            assert scripts_paths.pantheon_project() == tmp_path

    def test_symlink_component_detection(
        self, scripts_paths, tmp_path: Path
    ) -> None:
        real_parent = tmp_path / "real-parent"
        normal = real_parent / "project"
        normal.mkdir(parents=True)
        linked_parent = tmp_path / "linked-parent"
        linked_parent.symlink_to(real_parent, target_is_directory=True)
        assert scripts_paths.has_symlink_component(linked_parent / "project")
        assert not scripts_paths.has_symlink_component(normal)


# =============================================================================
# scripts/mcp_resources_server.py — import-time resolution
# =============================================================================


class TestRuntimeImportResolution:
    """The runtime copy must resolve its globals from the isolated env."""

    def test_module_globals_come_from_hermetic_env(
        self, scripts_server, tmp_path: Path
    ) -> None:
        assert tmp_path / "pantheon-home" == scripts_server._PANTHEON_HOME
        assert tmp_path / "project" == scripts_server._PANTHEON_PROJECT

    def test_runtime_copy_imports_standalone(self, tmp_path: Path) -> None:
        """A fresh interpreter must import the copy like the launcher does."""
        home = tmp_path / "home"
        project = tmp_path / "project"
        home.mkdir()
        project.mkdir()
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in {"PANTHEON_HOME", "XDG_CONFIG_HOME", "PANTHEON_PROJECT", "PWD"}
        }
        env["PANTHEON_HOME"] = str(home)
        env["PANTHEON_PROJECT"] = str(project)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(ROOT / "scripts"), str(ROOT / "src" / "mcp")]
        )
        proc = subprocess.run(
            [
                sys.executable,
                "-c",
                "import mcp_resources_server as m; "
                "print(m._PANTHEON_HOME); print(m._PANTHEON_PROJECT)",
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(project),
            check=False,
        )
        assert proc.returncode == 0, proc.stderr
        lines = proc.stdout.splitlines()
        assert Path(lines[0]) == home
        assert Path(lines[1]) == project


# =============================================================================
# scripts/mcp_resources_server.py — root safety helpers
# =============================================================================


class TestScriptsRootSafety:
    """Symlink/traversal containment in the runtime copy."""

    def test_safe_root_rejects_symlinked_root(
        self, scripts_server, tmp_path: Path
    ) -> None:
        target = tmp_path / "target"
        target.mkdir()
        linked = tmp_path / "linked"
        linked.symlink_to(target, target_is_directory=True)
        assert scripts_server._safe_root(linked, tmp_path) is None

    def test_safe_root_rejects_missing_or_file_root(
        self, scripts_server, tmp_path: Path
    ) -> None:
        assert scripts_server._safe_root(tmp_path / "missing", tmp_path) is None
        plain_file = tmp_path / "plain.md"
        plain_file.write_text("x", encoding="utf-8")
        assert scripts_server._safe_root(plain_file, tmp_path) is None

    @pytest.mark.parametrize("base_name", [".opencode", ".pantheon"])
    def test_safe_root_rejects_symlinked_trust_boundary(
        self, scripts_server, tmp_path: Path, base_name: str
    ) -> None:
        proj = tmp_path / "boundary-project"
        target = tmp_path / "boundary-target"
        proj.mkdir()
        target.mkdir()
        base = proj / base_name
        base.symlink_to(target, target_is_directory=True)
        assert scripts_server._safe_root(base / "agents", base) is None

    def test_safe_root_rejects_symlinked_project_parent(
        self, scripts_server, tmp_path: Path
    ) -> None:
        target = tmp_path / "parent-target"
        target.mkdir()
        linked_project = tmp_path / "project-link"
        linked_project.symlink_to(target, target_is_directory=True)
        base = linked_project / ".opencode"
        base.mkdir()
        assert scripts_server._safe_root(base / "agents", base) is None

    def test_safe_root_rejects_root_resolving_outside_parent(
        self, scripts_server, tmp_path: Path
    ) -> None:
        """An intermediate symlink inside the root must fail containment."""
        parent = tmp_path / "base"
        parent.mkdir()
        outside = tmp_path / "outside"
        outside.mkdir()
        (parent / "sub").symlink_to(outside, target_is_directory=True)
        root = parent / "sub" / "agents"
        root.mkdir()
        assert scripts_server._safe_root(root, parent) is None

    def test_resource_root_prefers_local_and_falls_back_to_global(
        self, scripts_server, tmp_path: Path
    ) -> None:
        project = scripts_server._PANTHEON_PROJECT
        local = project / ".opencode" / "agents"
        global_dir = scripts_server._PANTHEON_HOME / "agents"
        local.mkdir(parents=True)
        global_dir.mkdir(parents=True)
        assert scripts_server._resource_root("agents") == local.resolve()

        outside = tmp_path / "outside" / "agents"
        outside.mkdir(parents=True)
        local.rmdir()
        local.symlink_to(outside, target_is_directory=True)
        assert scripts_server._resource_root("agents") == global_dir.resolve()

    def test_resource_root_returns_none_without_candidates(
        self, scripts_server
    ) -> None:
        assert scripts_server._resource_root("memory-bank") is None

    def test_resource_roots_local_first_precedence(
        self, scripts_server, tmp_path: Path
    ) -> None:
        project = tmp_path / "project"
        local = project / ".opencode" / "agents"
        global_dir = scripts_server._PANTHEON_HOME / "agents"
        local.mkdir(parents=True)
        global_dir.mkdir(parents=True)
        roots = scripts_server._resource_roots("agents")
        assert roots == [local.resolve(), global_dir.resolve()]

    def test_safe_child_blocks_traversal_and_prefix_collision(
        self, scripts_server, tmp_path: Path
    ) -> None:
        root = tmp_path / "root"
        sibling = tmp_path / "root-escape"
        root.mkdir()
        sibling.mkdir()
        assert scripts_server._safe_child(root, "../root-escape/file.md") is None
        assert scripts_server._safe_child(root, "../root-escape") is None
        inside = root / "ok.md"
        inside.write_text("x", encoding="utf-8")
        assert scripts_server._safe_child(root, "ok.md") == inside.resolve()


# =============================================================================
# scripts/mcp_resources_server.py — frontmatter helpers
# =============================================================================


class TestScriptsFrontmatter:
    def test_parse_yaml_frontmatter_variants(
        self, scripts_server, tmp_path: Path
    ) -> None:
        valid = tmp_path / "valid.md"
        valid.write_text("---\nname: zeus\n---\nbody\n", encoding="utf-8")
        assert scripts_server._parse_yaml_frontmatter(valid) == {"name": "zeus"}

        plain = tmp_path / "plain.md"
        plain.write_text("no frontmatter\n", encoding="utf-8")
        assert scripts_server._parse_yaml_frontmatter(plain) == {}

        broken = tmp_path / "broken.md"
        broken.write_text("---\n: :\nbroken: [this\n---\n", encoding="utf-8")
        assert scripts_server._parse_yaml_frontmatter(broken) == {}

    @pytest.mark.parametrize(
        ("description", "expected"),
        [
            ("Orchestrator — never implements", "Orchestrator"),
            ("Plain description", "Plain description"),
            ("", "Pantheon agent"),
            (None, "Pantheon agent"),
        ],
    )
    def test_get_role_from_frontmatter(
        self, scripts_server, description: str | None, expected: str
    ) -> None:
        frontmatter = {} if description is None else {"description": description}
        assert scripts_server._get_role_from_frontmatter(frontmatter) == expected


# =============================================================================
# scripts/mcp_resources_server.py — static resources
# =============================================================================


class TestScriptsStaticResources:
    def _make_home(self, scripts_server) -> tuple[Path, Path]:
        home = scripts_server._PANTHEON_HOME
        agents = home / "agents"
        agents.mkdir(parents=True)
        (agents / "zeus.md").write_text(
            _agent_md("zeus", "Orchestrator — delegates"), encoding="utf-8"
        )
        (agents / "hermes.md").write_text(
            _agent_md("hermes", "Backend — FastAPI"), encoding="utf-8"
        )
        (agents / "README.md").write_text("readme\n", encoding="utf-8")
        return home, agents

    async def test_list_agents_renders_markdown(self, scripts_server) -> None:
        self._make_home(scripts_server)
        text = await scripts_server.list_agents()
        assert "- **zeus** — Orchestrator" in text
        assert "- **hermes** — Backend" in text
        assert "README" not in text

    async def test_list_agents_dedups_local_over_global(
        self, scripts_server, tmp_path: Path
    ) -> None:
        project = scripts_server._PANTHEON_PROJECT
        local = project / ".opencode" / "agents"
        global_dir = scripts_server._PANTHEON_HOME / "agents"
        local.mkdir(parents=True)
        global_dir.mkdir(parents=True)
        (local / "same.md").write_text(
            _agent_md("same", "Local — wins"), encoding="utf-8"
        )
        (global_dir / "same.md").write_text(
            _agent_md("same", "Global — loses"), encoding="utf-8"
        )
        (global_dir / "other.md").write_text(
            _agent_md("other", "Global — kept"), encoding="utf-8"
        )
        text = await scripts_server.list_agents()
        assert text.count("- **same**") == 1
        assert "Local" in text
        assert "- **other** — Global" in text

    async def test_list_agents_empty_dir(self, scripts_server) -> None:
        (scripts_server._PANTHEON_HOME / "agents").mkdir(parents=True)
        assert await scripts_server.list_agents() == "No agents found."

    async def test_list_agents_missing_dirs(self, scripts_server) -> None:
        assert await scripts_server.list_agents() == "Agents directory not found."

    async def test_list_skills_renders_markdown(self, scripts_server) -> None:
        skill = scripts_server._PANTHEON_HOME / "skills" / "tdd"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: tdd\ndescription: Test-driven development\n---\n",
            encoding="utf-8",
        )
        text = await scripts_server.list_skills()
        assert "- **tdd** — Test-driven development" in text

    async def test_list_skills_empty_dir(self, scripts_server) -> None:
        (scripts_server._PANTHEON_HOME / "skills").mkdir(parents=True)
        assert await scripts_server.list_skills() == "No skills found."

    async def test_list_skills_missing_dirs(self, scripts_server) -> None:
        assert await scripts_server.list_skills() == "Skills directory not found."

    async def test_get_routing_from_global(self, scripts_server) -> None:
        routing = scripts_server._PANTHEON_HOME / "routing.yml"
        routing.write_text("version: 1\nagents:\n", encoding="utf-8")
        assert "version: 1" in await scripts_server.get_routing()

    async def test_get_routing_project_fallback(
        self, scripts_server, tmp_path: Path
    ) -> None:
        """The project fallback triggers when the global home is untrusted."""
        src = scripts_server._PANTHEON_PROJECT / "src"
        src.mkdir(parents=True)
        (src / "routing.yml").write_text("version: 2\n", encoding="utf-8")
        real_home = tmp_path / "real-home"
        real_home.mkdir()
        linked_home = tmp_path / "linked-home"
        linked_home.symlink_to(real_home, target_is_directory=True)
        with patch.object(scripts_server, "_PANTHEON_HOME", linked_home):
            assert "version: 2" in await scripts_server.get_routing()

    async def test_get_routing_missing(self, scripts_server) -> None:
        assert await scripts_server.get_routing() == "routing.yml not found."


# =============================================================================
# scripts/mcp_resources_server.py — template resources
# =============================================================================


class TestScriptsTemplateResources:
    def _make_agents(self, scripts_server) -> Path:
        agents = scripts_server._PANTHEON_HOME / "agents"
        agents.mkdir(parents=True)
        (agents / "zeus.md").write_text("# zeus content\n", encoding="utf-8")
        return agents

    async def test_get_agent_found_case_insensitive(self, scripts_server) -> None:
        self._make_agents(scripts_server)
        assert await scripts_server.get_agent("ZEUS") == "# zeus content\n"

    async def test_get_agent_not_found(self, scripts_server) -> None:
        self._make_agents(scripts_server)
        assert "not found" in await scripts_server.get_agent("ghost")

    def _make_deepwork(self, scripts_server, slug: str) -> None:
        base = scripts_server._PANTHEON_PROJECT / ".pantheon" / "deepwork" / slug
        base.mkdir(parents=True)
        (base / "PLAN.md").write_text(f"# Plan {slug}\n", encoding="utf-8")

    async def test_get_deepwork_plan_found(self, scripts_server) -> None:
        self._make_deepwork(scripts_server, "my-task")
        assert "Plan my-task" in await scripts_server.get_deepwork_plan("my-task")

    async def test_get_deepwork_plan_not_found(self, scripts_server) -> None:
        self._make_deepwork(scripts_server, "other")
        assert "not found" in await scripts_server.get_deepwork_plan("ghost")

    async def test_get_deepwork_plan_without_project(
        self, scripts_server, tmp_path: Path
    ) -> None:
        with patch.object(scripts_server, "_PANTHEON_PROJECT", None):
            assert "not found" in await scripts_server.get_deepwork_plan("ghost")

    async def test_get_deepwork_status_found(self, scripts_server) -> None:
        self._make_deepwork(scripts_server, "my-task")
        status = (
            scripts_server._PANTHEON_PROJECT
            / ".pantheon"
            / "deepwork"
            / "my-task"
            / "STATUS.md"
        )
        status.write_text("DONE\n", encoding="utf-8")
        assert await scripts_server.get_deepwork_status("my-task") == "DONE\n"

    async def test_get_deepwork_status_defaults_to_in_progress(
        self, scripts_server
    ) -> None:
        self._make_deepwork(scripts_server, "my-task")
        text = await scripts_server.get_deepwork_status("my-task")
        assert "IN PROGRESS" in text

    async def test_get_deepwork_status_without_project(
        self, scripts_server
    ) -> None:
        with patch.object(scripts_server, "_PANTHEON_PROJECT", None):
            text = await scripts_server.get_deepwork_status("ghost")
        assert "not found" in text.lower()

    async def test_get_skill_found(self, scripts_server) -> None:
        skill = scripts_server._PANTHEON_HOME / "skills" / "tdd"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("# tdd skill\n", encoding="utf-8")
        assert await scripts_server.get_skill("tdd") == "# tdd skill\n"

    async def test_get_skill_not_found(self, scripts_server) -> None:
        assert "not found" in await scripts_server.get_skill("ghost")

    async def test_get_memory_bank_found(self, scripts_server) -> None:
        bank = scripts_server._PANTHEON_PROJECT / ".pantheon" / "memory-bank"
        bank.mkdir(parents=True)
        (bank / "00-project.md").write_text("# Project\n", encoding="utf-8")
        assert await scripts_server.get_memory_bank("00-project.md") == "# Project\n"

    async def test_get_memory_bank_traversal_blocked(self, scripts_server) -> None:
        bank = scripts_server._PANTHEON_PROJECT / ".pantheon" / "memory-bank"
        bank.mkdir(parents=True)
        assert "blocked" in await scripts_server.get_memory_bank("../../etc/passwd")

    async def test_get_memory_bank_not_found(self, scripts_server) -> None:
        bank = scripts_server._PANTHEON_PROJECT / ".pantheon" / "memory-bank"
        bank.mkdir(parents=True)
        assert "not found" in await scripts_server.get_memory_bank("ghost.md")

    async def test_get_memory_bank_without_project(self, scripts_server) -> None:
        with patch.object(scripts_server, "_PANTHEON_PROJECT", None):
            text = await scripts_server.get_memory_bank("00-project.md")
        assert "not available" in text.lower()


# =============================================================================
# scripts/mcp_resources_server.py — plugin eval resources
# =============================================================================


@pytest.fixture
def scripts_eval_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Seed a temp plugin_eval DB and point eval_store at it."""
    db_path = tmp_path / "memory" / "memory.db"
    monkeypatch.setattr(eval_store, "_db_path", lambda: db_path)
    eval_store.store_eval(
        "tdd-with-agents",
        {"name": "tdd-with-agents", "score": 90, "checks": {}},
        90,
        when="2026-09-01",
    )
    return eval_store


class TestScriptsEvalResources:
    async def test_list_plugin_evals_with_entries(
        self, scripts_server, scripts_eval_db
    ) -> None:
        text = await scripts_server.list_plugin_evals()
        assert "tdd-with-agents" in text
        assert "90" in text

    async def test_list_plugin_evals_empty(self, scripts_server) -> None:
        assert "No plugin evals" in await scripts_server.list_plugin_evals()

    async def test_get_plugin_eval_found(
        self, scripts_server, scripts_eval_db
    ) -> None:
        text = await scripts_server.get_plugin_eval("tdd-with-agents")
        assert "# Eval Report: tdd-with-agents" in text
        assert "90" in text

    @pytest.mark.parametrize(
        "plugin", ["../escape", "back\\slash", "..", ""]
    )
    async def test_get_plugin_eval_invalid_names_blocked(
        self, scripts_server, plugin: str
    ) -> None:
        assert "blocked" in await scripts_server.get_plugin_eval(plugin)

    async def test_get_plugin_eval_not_found(
        self, scripts_server, scripts_eval_db
    ) -> None:
        text = await scripts_server.get_plugin_eval("ghost-plugin")
        assert "No eval found" in text
