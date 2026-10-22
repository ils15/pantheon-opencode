"""Focused repository tests for session-scoped manual goals.

All SQLite files in this module are synthetic fixtures in pytest temporary
directories; never point this fixture at a user database.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from importlib.metadata import version as package_version
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError

EXPECTED_HISTORY_COUNT = 2
CONCURRENT_CREATE_COUNT = 6
FAST_MCP_PIN_FILE = "src/mcp/requirements-mcp.txt"
EXPECTED_BACKUP_MODE = 0o600
EXPECTED_UNKNOWN_DRY_RUN_STATUS = 2
POST_UPGRADE_VERSION_READ_CALL = 3


def _require_supported_fastmcp(installed_version: str | None = None) -> None:
    """Fail clearly when this suite is run outside its pinned MCP runtime."""
    installed = installed_version or package_version("fastmcp")
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", installed)
    if match is None or tuple(map(int, match.groups())) < (4, 0, 10):
        raise RuntimeError(
            "Persistence goal tests require fastmcp>=4.0.10 and mcp==2.2.0; "
            f"install the pinned dependencies from {FAST_MCP_PIN_FILE} "
            f"(installed fastmcp {installed})."
        )


def _seed_legacy_persistence_db(db_path: Path) -> None:
    """Create a populated, pre-goal Persistence DB using only synthetic data."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as seed:
        seed.execute(
            "CREATE TABLE kv_store (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
            "expires_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, "
            "updated_at TEXT NOT NULL, UNIQUE(namespace, key))"
        )
        seed.execute(
            "INSERT INTO kv_store(namespace, key, value, created_at, updated_at) "
            "VALUES ('legacy', 'keep', 'value', 'then', 'then')"
        )


_require_supported_fastmcp()


def _load_isolated_module(alias: str, global_db: Path, project_db: Path):
    source = Path(__file__).resolve().parents[1] / "src/mcp/mcp_persistence.py"
    spec = importlib.util.spec_from_file_location(alias, source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    with patch.object(
        sys,
        "argv",
        ["pytest", "--global-db", str(global_db), "--project-db", str(project_db)],
    ):
        spec.loader.exec_module(module)
    return module


def _run_isolated_cli(
    alias: str, global_db: Path, project_db: Path, *arguments: str
) -> int:
    """Execute the module CLI in-process so coverage observes its exit paths."""
    source = Path(__file__).resolve().parents[1] / "src/mcp/mcp_persistence.py"
    spec = importlib.util.spec_from_file_location(alias, source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    argv = [
        "mcp_persistence",
        "--global-db",
        str(global_db),
        "--project-db",
        str(project_db),
        *arguments,
    ]
    with patch.object(sys, "argv", argv), pytest.raises(SystemExit) as exit_info:
        spec.loader.exec_module(module)
    return int(exit_info.value.code)


@pytest.fixture
def persistence(tmp_path: Path) -> Iterator[tuple[ModuleType, Path]]:
    with tempfile.TemporaryDirectory(prefix="goal-db-", dir=tmp_path) as temp_dir:
        fixture_dir = Path(temp_dir)
        module_path = "src.mcp.mcp_persistence"
        previous = sys.modules.get(module_path)
        if previous is not None:
            for name in ("_project_db", "_global_db"):
                conn = getattr(previous, name, None)
                if conn is not None:
                    conn.close()

        argv = [
            "pytest",
            "--global-db",
            str(fixture_dir / "global.db"),
            "--project-db",
            str(fixture_dir / "project.db"),
        ]
        with patch.object(sys, "argv", argv):
            module = importlib.import_module(module_path)
            module = importlib.reload(module)
        project = module._project_db
        assert project is not None
        module.upgrade_goal_schema(project)
        try:
            yield module, fixture_dir
        finally:
            for name in ("_project_db", "_global_db"):
                conn = getattr(module, name, None)
                if conn is not None:
                    conn.close()


def test_project_schema_is_versioned_restartable_and_reversible(persistence) -> None:
    module, fixture_dir = persistence
    project = module._project_db
    assert project is not None
    version = project.execute(
        "SELECT MAX(version) FROM pantheon_goal_schema_migrations"
    ).fetchone()[0]
    assert version == module.GOAL_SCHEMA_VERSION
    assert (
        project.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name='pantheon_goals'"
        ).fetchone()
        is not None
    )
    assert (
        module._global_db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name='pantheon_goals'"
        ).fetchone()
        is None
    )
    active_plan = project.execute(
        "EXPLAIN QUERY PLAN SELECT goal_id, session_id, title, description, status, "
        "created_at, updated_at, version FROM pantheon_goals "
        "WHERE session_id = ? AND status = 'active' LIMIT 1",
        ("ses_plan",),
    ).fetchall()
    history_plan = project.execute(
        "EXPLAIN QUERY PLAN SELECT goal_id, session_id, title, description, status, "
        "created_at, updated_at, version FROM pantheon_goals WHERE session_id = ? "
        "ORDER BY created_at DESC, rowid DESC LIMIT 1",
        ("ses_plan",),
    ).fetchall()
    assert any("uq_pantheon_goals_active_session" in row[3] for row in active_plan)
    assert any("idx_pantheon_goals_session_history" in row[3] for row in history_plan)

    goal = module.create_goal(session_id="ses_restart", title="Persist")
    reopened = sqlite3.connect(fixture_dir / "project.db", timeout=5)
    reopened.row_factory = sqlite3.Row
    try:
        module.upgrade_goal_schema(reopened)
        assert module.get_goal(session_id="ses_restart") == goal
        assert (
            reopened.execute(
                "SELECT COUNT(*) FROM pantheon_goal_schema_migrations"
            ).fetchone()[0]
            == 1
        )

        reopened.execute(
            "DELETE FROM pantheon_goals WHERE goal_id = ?", (goal.goal_id,)
        )
        reopened.commit()
        module.downgrade_goal_schema(reopened)
        assert (
            reopened.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name='pantheon_goals'"
            ).fetchone()
            is None
        )
        assert (
            reopened.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name='pantheon_goal_schema_migrations'"
            ).fetchone()
            is None
        )

        module.upgrade_goal_schema(reopened)
        assert module.get_goal(session_id="ses_restart") is None
    finally:
        reopened.close()


def test_fastmcp_version_guard_names_pinned_requirements_file() -> None:
    with pytest.raises(RuntimeError, match=r"fastmcp>=4\.0\.10") as error:
        _require_supported_fastmcp("3.4.6")
    assert FAST_MCP_PIN_FILE in str(error.value)


def test_pristine_startup_creates_project_goals_and_keeps_global_kv_only(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "startup-pristine"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_startup_pristine",
        fixture_dir / "global.db",
        fixture_dir / "project.db",
    )
    project = module._project_db
    assert project is not None
    assert (
        project.execute(
            "SELECT MAX(version) FROM pantheon_goal_schema_migrations"
        ).fetchone()[0]
        == module.GOAL_SCHEMA_VERSION
    )
    assert {
        row[0]
        for row in project.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' "
            "AND tbl_name = 'pantheon_goals'"
        )
    } >= {
        "uq_pantheon_goals_active_session",
        "idx_pantheon_goals_session_history",
    }
    assert "revision" in {
        row[1] for row in project.execute("PRAGMA table_info(kv_store)")
    }
    assert (
        module._global_db.execute(
            "SELECT 1 FROM sqlite_master WHERE name GLOB 'pantheon_goal*'"
        ).fetchone()
        is None
    )

    async def verify_tools() -> None:
        await module.context_save(
            "startup", "key", "value", session_id="startup-session"
        )
        assert (
            await module.context_get("startup", "key", session_id="startup-session")
            == "value"
        )
        context = SimpleNamespace(
            request_context=SimpleNamespace(
                meta={"ai.opencode/sessionID": "ses_pristine"}
            )
        )
        created = await module.goal_create(title="Pristine goal", context=context)
        assert created["goal"]["title"] == "Pristine goal"

    asyncio.run(verify_tools())


def test_goal_schema_without_kv_fails_closed_without_changing_other_bootstrap(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "goal-schema-without-kv"
    fixture_dir.mkdir()
    seed_module = _load_isolated_module(
        "persistence_inconsistent_schema_seed",
        fixture_dir / "seed-global.db",
        fixture_dir / "seed-project.db",
    )
    seeded_db = fixture_dir / "seed-project.db"
    seed_connection = seed_module._project_db
    assert seed_connection is not None
    seed_connection.execute("DROP TABLE kv_store")
    seed_connection.commit()
    seed_connection.close()
    seed_module._project_db = None

    with pytest.raises(seed_module.GoalDatabaseInconsistentError) as migration_error:
        seed_module.migrate_goal_schema_with_backup(seeded_db)
    assert "KV schema is missing while goal schema is present" in str(
        migration_error.value
    )
    assert "repair is required" in str(migration_error.value)
    with sqlite3.connect(seeded_db) as seeded:
        assert seeded.execute("SELECT COUNT(*) FROM pantheon_goals").fetchone()[0] == 0
        assert (
            seeded.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'kv_store'"
            ).fetchone()
            is None
        )

    module = _load_isolated_module(
        "persistence_inconsistent_goal_schema",
        fixture_dir / "global.db",
        seeded_db,
    )
    project = module._project_db
    assert project is not None
    assert (
        project.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store'"
        ).fetchone()
        is None
    )

    expected_message = "KV schema is missing while goal schema is present"
    operations = (
        lambda: module.create_goal(session_id="ses_inconsistent", title="Blocked"),
        lambda: module.get_goal(session_id="ses_inconsistent"),
        lambda: module.update_goal(
            session_id="ses_inconsistent",
            goal_id="missing",
            expected_version=1,
            title="Blocked",
        ),
        lambda: module.complete_goal(
            session_id="ses_inconsistent",
            goal_id="missing",
            expected_version=1,
        ),
    )
    for operation in operations:
        with pytest.raises(
            module.GoalDatabaseInconsistentError, match=expected_message
        ) as error:
            operation()
        assert "repair is required" in str(error.value)

    with pytest.raises(module.GoalDatabaseInconsistentError, match=expected_message):
        module.upgrade_goal_schema(project, seeded_db, explicit_project_db=True)
    with pytest.raises(module.GoalDatabaseInconsistentError, match=expected_message):
        module.migrate_goal_schema_with_backup(seeded_db)
    assert project.execute("SELECT COUNT(*) FROM pantheon_goals").fetchone()[0] == 0

    context = SimpleNamespace(
        request_context=SimpleNamespace(
            meta={"ai.opencode/sessionID": "ses_inconsistent"}
        )
    )

    async def verify_goal_tools_fail_closed() -> None:
        tool_calls = (
            module.goal_create(title="Blocked", context=context),
            module.goal_get(context=context),
            module.goal_update(
                context=context,
                goal_id="missing",
                expected_version=1,
                title="Blocked",
            ),
            module.goal_done(context=context, goal_id="missing", expected_version=1),
        )
        for call in tool_calls:
            with pytest.raises(ToolError, match=expected_message):
                await call

    asyncio.run(verify_goal_tools_fail_closed())
    assert project.execute("SELECT COUNT(*) FROM pantheon_goals").fetchone()[0] == 0

    unrelated_db = fixture_dir / "unrelated-user-table.db"
    with sqlite3.connect(unrelated_db) as unrelated:
        unrelated.execute("CREATE TABLE user_data (value TEXT NOT NULL)")
        unrelated.execute("INSERT INTO user_data VALUES ('preserved')")
    unrelated_module = _load_isolated_module(
        "persistence_unrelated_table_bootstrap",
        fixture_dir / "unrelated-global.db",
        unrelated_db,
    )
    unrelated_connection = unrelated_module._project_db
    assert unrelated_connection is not None
    assert unrelated_connection.execute("SELECT value FROM user_data").fetchone() == (
        "preserved",
    )
    assert unrelated_connection.execute(
        "SELECT 1 FROM sqlite_master WHERE name = 'kv_store'"
    ).fetchone() == (1,)

    for connection in (
        project,
        module._global_db,
        unrelated_connection,
        unrelated_module._global_db,
        seed_module._global_db,
    ):
        if connection is not None:
            connection.close()


def test_inconsistent_goal_database_survives_restart_without_kv_bootstrap(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "inconsistent-restart"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    seed_module = _load_isolated_module(
        "persistence_restart_inconsistent_seed",
        fixture_dir / "global.db",
        project_db,
    )
    seed_project = seed_module._project_db
    assert seed_project is not None
    seed_project.execute("DROP TABLE kv_store")
    seed_project.commit()
    seed_project.close()
    assert seed_module._global_db is not None
    seed_module._global_db.close()

    first_start = _load_isolated_module(
        "persistence_restart_inconsistent_first",
        fixture_dir / "global.db",
        project_db,
    )
    first_project = first_start._project_db
    assert first_project is not None
    with pytest.raises(first_start.GoalDatabaseInconsistentError):
        first_start.create_goal(session_id="ses_restart", title="Blocked")
    first_project.close()
    assert first_start._global_db is not None
    first_start._global_db.close()

    restarted = _load_isolated_module(
        "persistence_restart_inconsistent_second",
        fixture_dir / "global.db",
        project_db,
    )
    restarted_project = restarted._project_db
    assert restarted_project is not None
    for operation in (
        lambda: restarted.create_goal(session_id="ses_restart", title="Blocked"),
        lambda: restarted.get_goal(session_id="ses_restart"),
    ):
        with pytest.raises(restarted.GoalDatabaseInconsistentError):
            operation()
    with sqlite3.connect(project_db) as conn:
        assert (
            conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store'"
            ).fetchone()
            is None
        )
    restarted_project.close()
    assert restarted._global_db is not None
    restarted._global_db.close()


def test_history_only_goal_database_remains_inconsistent_after_restart(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "history-only-inconsistent-restart"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    with sqlite3.connect(project_db) as seeded:
        seeded.execute(
            "CREATE TABLE pantheon_goal_schema_migrations ("
            "version INTEGER PRIMARY KEY CHECK (version > 0), "
            "applied_at TEXT NOT NULL)"
        )
        seeded.execute(
            "INSERT INTO pantheon_goal_schema_migrations VALUES (1, 'synthetic')"
        )

    first_start = _load_isolated_module(
        "persistence_history_only_first_start",
        fixture_dir / "global.db",
        project_db,
    )
    first_project = first_start._project_db
    assert first_project is not None
    assert (
        first_project.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store'"
        ).fetchone()
        is None
    )
    for operation in (
        lambda: first_start.create_goal(session_id="ses_history_only", title="Blocked"),
        lambda: first_start.get_goal(session_id="ses_history_only"),
    ):
        with pytest.raises(first_start.GoalDatabaseInconsistentError):
            operation()
    first_project.close()
    assert first_start._global_db is not None
    first_start._global_db.close()

    restarted = _load_isolated_module(
        "persistence_history_only_restart",
        fixture_dir / "global.db",
        project_db,
    )
    restarted_project = restarted._project_db
    assert restarted_project is not None
    assert (
        restarted_project.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store'"
        ).fetchone()
        is None
    )
    for operation in (
        lambda: restarted.create_goal(session_id="ses_history_only", title="Blocked"),
        lambda: restarted.get_goal(session_id="ses_history_only"),
    ):
        with pytest.raises(restarted.GoalDatabaseInconsistentError):
            operation()
    restarted_project.close()
    assert restarted._global_db is not None
    restarted._global_db.close()


def test_concurrent_startup_keeps_inconsistent_goal_database_unrepaired(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "concurrent-inconsistent-startup"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    seed_module = _load_isolated_module(
        "persistence_concurrent_inconsistent_seed",
        fixture_dir / "global.db",
        project_db,
    )
    seed_project = seed_module._project_db
    assert seed_project is not None
    seed_project.execute("DROP TABLE kv_store")
    seed_project.commit()
    seed_project.close()
    seed_module._project_db = None
    if seed_module._global_db is not None:
        seed_module._global_db.close()
        seed_module._global_db = None

    source = Path(__file__).resolve().parents[1] / "src/mcp/mcp_persistence.py"
    child_code = """
import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch

source, global_db, project_db = sys.argv[1:]
sys.path.insert(0, str(Path(source).parent))
spec = importlib.util.spec_from_file_location('concurrent_persistence', source)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
with patch.object(
    sys,
    'argv',
    ['test', '--global-db', global_db, '--project-db', project_db],
):
    spec.loader.exec_module(module)
try:
    module.create_goal(session_id='ses_concurrent', title='Must be blocked')
except module.GoalDatabaseInconsistentError as exc:
    print(f'REFUSED:{exc}')
else:
    print('ALLOWED')
    raise SystemExit(4)
"""
    processes = [
        subprocess.Popen(
            [
                sys.executable,
                "-c",
                child_code,
                str(source),
                str(fixture_dir / "global.db"),
                str(project_db),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(2)
    ]
    results = [process.communicate(timeout=30) for process in processes]
    assert [process.returncode for process in processes] == [0, 0], results
    assert all(
        "REFUSED:Persistence database is inconsistent" in stdout
        and "repair is required" in stdout
        for stdout, _stderr in results
    )
    with sqlite3.connect(project_db) as conn:
        assert (
            conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store'"
            ).fetchone()
            is None
        )


def test_startup_refuses_pristine_global_database_for_project_goal_ddl(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "pristine-global-goal-guard"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_pristine_global_guard",
        fixture_dir / "global-root",
        fixture_dir / "project.db",
    )
    pristine_global = fixture_dir / "separate-global.db"
    module._global_db_path = pristine_global.resolve()

    with pytest.raises(
        module.GoalSchemaNotInitializedError, match="global Persistence database"
    ):
        module._init_db(pristine_global, project_db=True)

    with sqlite3.connect(pristine_global) as conn:
        assert (
            conn.execute(
                "SELECT name FROM sqlite_master WHERE substr(name, 1, 7) != 'sqlite_'"
            ).fetchall()
            == []
        )


def test_existing_populated_persistence_database_is_not_goal_upgraded(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "populated-startup"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    with sqlite3.connect(project_db) as seed:
        seed.execute(
            "CREATE TABLE kv_store (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
            "expires_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, "
            "updated_at TEXT NOT NULL, UNIQUE(namespace, key))"
        )
        seed.execute(
            "INSERT INTO kv_store(namespace, key, value, created_at, updated_at) "
            "VALUES ('legacy', 'keep', 'value', 'then', 'then')"
        )

    module = _load_isolated_module(
        "persistence_populated_startup", fixture_dir / "global.db", project_db
    )
    project = module._project_db
    assert project is not None
    assert (
        project.execute(
            "SELECT value FROM kv_store WHERE namespace = 'legacy' AND key = 'keep'"
        ).fetchone()[0]
        == "value"
    )
    assert (
        project.execute(
            "SELECT 1 FROM sqlite_master WHERE name GLOB 'pantheon_goal*'"
        ).fetchone()
        is None
    )
    with pytest.raises(module.GoalSchemaNotInitializedError):
        module.create_goal(session_id="ses_legacy", title="Blocked")
    context = SimpleNamespace(
        request_context=SimpleNamespace(meta={"ai.opencode/sessionID": "ses_legacy"})
    )
    with pytest.raises(ToolError, match="Ask the user to run"):
        asyncio.run(module.goal_create(title="Blocked", context=context))


@pytest.mark.parametrize("kind", ["zero-byte", "user-version", "sqlite-only"])
def test_database_without_user_schema_objects_is_pristine(
    tmp_path: Path, kind: str
) -> None:
    fixture_dir = tmp_path / f"empty-schema-{kind}"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    if kind == "zero-byte":
        project_db.touch()
    elif kind == "user-version":
        with sqlite3.connect(project_db) as seed:
            seed.execute("PRAGMA user_version = 1")
    else:
        with sqlite3.connect(project_db) as seed:
            seed.execute(
                "CREATE TABLE discarded (id INTEGER PRIMARY KEY AUTOINCREMENT)"
            )
            seed.execute("DROP TABLE discarded")
            assert seed.execute("SELECT name FROM sqlite_master").fetchall() == [
                ("sqlite_sequence",)
            ]

    module = _load_isolated_module(
        f"persistence_empty_schema_{kind}", fixture_dir / "global-root", project_db
    )
    project = module._project_db
    assert project is not None
    assert project.execute(
        "SELECT 1 FROM sqlite_master WHERE name = 'pantheon_goals'"
    ).fetchone() == (1,)
    assert project.execute(
        "SELECT 1 FROM sqlite_master WHERE name = 'kv_store'"
    ).fetchone() == (1,)


@pytest.mark.parametrize(
    "kind",
    [
        "foreign-table",
        "copied-legacy",
        "malformed-goal-history",
    ],
)
def test_nonpristine_project_databases_never_get_automatic_goal_ddl(
    tmp_path: Path, kind: str
) -> None:
    fixture_dir = tmp_path / f"not-pristine-{kind}"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    if kind == "foreign-table":
        with sqlite3.connect(project_db) as seed:
            seed.execute("CREATE TABLE foreign_data (id INTEGER PRIMARY KEY)")
    elif kind == "copied-legacy":
        source = fixture_dir / "legacy-source.db"
        with sqlite3.connect(source) as seed:
            seed.execute(
                "CREATE TABLE kv_store (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, "
                "expires_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, "
                "updated_at TEXT NOT NULL, UNIQUE(namespace, key))"
            )
            seed.execute(
                "INSERT INTO kv_store(namespace, key, value, created_at, updated_at) "
                "VALUES ('old', 'key', 'value', 'then', 'then')"
            )
        shutil.copy2(source, project_db)
    else:
        with sqlite3.connect(project_db) as seed:
            seed.execute(
                "CREATE TABLE pantheon_goal_schema_migrations ("
                "version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            seed.execute(
                "INSERT INTO pantheon_goal_schema_migrations VALUES (1, 'old')"
            )

    module = _load_isolated_module(
        f"persistence_nonpristine_{kind}", fixture_dir / "global.db", project_db
    )
    project = module._project_db
    assert project is not None
    assert (
        project.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'pantheon_goals'"
        ).fetchone()
        is None
    )
    assert project.execute(
        "SELECT 1 FROM sqlite_master WHERE name = 'pantheon_goal_schema_migrations'"
    ).fetchone() == ((1,) if kind == "malformed-goal-history" else None)
    if kind == "malformed-goal-history":
        with pytest.raises(module.GoalDatabaseInconsistentError):
            module.create_goal(session_id="ses_bad_history", title="Blocked")
    else:
        with pytest.raises(module.GoalSchemaNotInitializedError):
            module.create_goal(session_id="ses_not_pristine", title="Blocked")


def test_failed_first_init_rolls_back_and_retry_completes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture_dir = tmp_path / "interrupted-first-init"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_interrupted_init",
        fixture_dir / "global.db",
        fixture_dir / "project.db",
    )
    retry_db = fixture_dir / "retry.db"
    module._project_db_path = retry_db
    module._project_db_explicit = True
    original_timestamp = module._goal_timestamp

    def fail_after_goal_ddl() -> str:
        raise RuntimeError("synthetic interrupted goal migration")

    monkeypatch.setattr(module, "_goal_timestamp", fail_after_goal_ddl)
    with pytest.raises(RuntimeError, match="synthetic interrupted"):
        module._init_db(retry_db, project_db=True)

    with sqlite3.connect(retry_db) as reopened:
        assert (
            reopened.execute(
                "SELECT name FROM sqlite_master WHERE substr(name, 1, 7) != 'sqlite_'"
            ).fetchall()
            == []
        )

    monkeypatch.setattr(module, "_goal_timestamp", original_timestamp)
    retried = module._init_db(retry_db, project_db=True)
    try:
        assert (
            retried.execute(
                "SELECT MAX(version) FROM pantheon_goal_schema_migrations"
            ).fetchone()[0]
            == module.GOAL_SCHEMA_VERSION
        )
        assert (
            retried.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'kv_store'"
            ).fetchone()
            is not None
        )
    finally:
        retried.close()


def test_concurrent_first_startup_is_serialized_and_complete(tmp_path: Path) -> None:
    fixture_dir = tmp_path / "concurrent-first-startup"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    global_root = fixture_dir / "global"
    source = Path(__file__).resolve().parents[1] / "src/mcp/mcp_persistence.py"
    command = [
        sys.executable,
        str(source),
        "--global-db",
        str(global_root),
        "--project-db",
        str(project_db),
    ]
    processes = [
        subprocess.Popen(
            command,
            cwd=source.parents[2],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for _ in range(2)
    ]
    for process in processes:
        stdout, stderr = process.communicate(timeout=30)
        assert process.returncode == 0, f"stdout={stdout}\nstderr={stderr}"

    with sqlite3.connect(project_db) as project:
        assert project.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert (
            project.execute(
                "SELECT COUNT(*) FROM pantheon_goal_schema_migrations"
            ).fetchone()[0]
            == 1
        )
        assert project.execute("SELECT 1 FROM kv_store").fetchone() is None
        assert project.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name IN "
            "('uq_pantheon_goals_active_session', "
            "'idx_pantheon_goals_session_history')"
        ).fetchall() == [(1,), (1,)]
    with sqlite3.connect(global_root / "global.db") as global_conn:
        assert (
            global_conn.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'pantheon_goals'"
            ).fetchone()
            is None
        )

    module = _load_isolated_module(
        "persistence_after_concurrent_startup",
        fixture_dir / "second-global.db",
        project_db,
    )
    assert module.create_goal(session_id="ses_after_concurrent", title="Ready")
    asyncio.run(
        module.context_save("concurrent", "key", "value", session_id="after-concurrent")
    )


def test_real_backup_verification_failure_cleans_backup_and_sidecars(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture_dir = tmp_path / "backup-failure"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    _seed_legacy_persistence_db(project_db)
    module = _load_isolated_module(
        "persistence_backup_failure",
        fixture_dir / "global.db",
        project_db,
    )

    copy_backup = module._copy_goal_backup

    def truncate_backup(source: sqlite3.Connection, backup_path: Path) -> None:
        copy_backup(source, backup_path)
        backup_path.write_bytes(b"")
        backup_path.with_name(backup_path.name + "-wal").write_bytes(b"orphan")
        backup_path.with_name(backup_path.name + "-shm").write_bytes(b"orphan")

    monkeypatch.setattr(module, "_copy_goal_backup", truncate_backup)
    with pytest.raises(module.GoalStorageError, match="backup"):
        module.migrate_goal_schema_with_backup(project_db)
    project = module._project_db
    assert project is not None
    assert (
        project.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' "
            "AND name='pantheon_goal_schema_migrations'"
        ).fetchone()
        is None
    )
    assert list(fixture_dir.glob("*.goal-backup-*.sqlite3*")) == []


def test_backup_verification_rejects_empty_foreign_and_truncated_files(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "backup-verification"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_backup_verification",
        fixture_dir / "global.db",
        fixture_dir / "project.db",
    )
    source = module._project_db
    assert source is not None
    version = module._raw_goal_schema_version(source)

    empty = fixture_dir / "empty.sqlite3"
    empty.touch()
    with pytest.raises(module.GoalStorageError):
        module._verify_goal_backup(source, empty, version)

    foreign = fixture_dir / "foreign.sqlite3"
    foreign_db = sqlite3.connect(foreign)
    foreign_db.execute("CREATE TABLE kv_store (value TEXT)")
    foreign_db.execute("CREATE TABLE sentinel (value TEXT)")
    foreign_db.commit()
    foreign_db.close()
    with pytest.raises(module.GoalStorageError):
        module._verify_goal_backup(source, foreign, version)

    truncated = fixture_dir / "truncated.sqlite3"
    truncated.write_bytes((fixture_dir / "project.db").read_bytes()[:64])
    with pytest.raises(module.GoalStorageError):
        module._verify_goal_backup(source, truncated, version)


def test_backup_verification_compares_kv_and_sentinel_row_counts(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "backup-row-counts"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_backup_row_counts",
        fixture_dir / "global.db",
        fixture_dir / "project.db",
    )
    source = module._project_db
    assert source is not None
    source.execute("CREATE TABLE sentinel (value TEXT NOT NULL)")
    source.execute("INSERT INTO sentinel VALUES ('source')")
    source.commit()
    version = module._raw_goal_schema_version(source)

    for table in ("kv_store", "sentinel"):
        backup_path = fixture_dir / f"{table}.sqlite3"
        module._copy_goal_backup(source, backup_path)
        backup = sqlite3.connect(backup_path)
        if table == "kv_store":
            backup.execute(
                "INSERT INTO kv_store(namespace, key, value) "
                "VALUES ('synthetic', 'extra', 'row')"
            )
        else:
            backup.execute("DELETE FROM sentinel")
        backup.commit()
        backup.close()

        with pytest.raises(module.GoalStorageError, match="row-count verification"):
            module._verify_goal_backup(source, backup_path, version)


def test_backup_verification_rejects_wrong_version_and_non_persistence_store(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "backup-version-guard"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    _seed_legacy_persistence_db(project_db)
    module = _load_isolated_module(
        "persistence_backup_version_guard",
        fixture_dir / "global.db",
        project_db,
    )
    source = module._project_db
    assert source is not None

    object_mismatch_path = fixture_dir / "object-mismatch.sqlite3"
    module._copy_goal_backup(source, object_mismatch_path)
    changed_backup = sqlite3.connect(object_mismatch_path)
    changed_backup.execute("ALTER TABLE kv_store RENAME TO renamed_kv_store")
    changed_backup.commit()
    changed_backup.close()
    with pytest.raises(module.GoalStorageError, match="object-name verification"):
        module._verify_goal_backup(source, object_mismatch_path, expected_version=0)

    backup_path = fixture_dir / "version-mismatch.sqlite3"
    module._copy_goal_backup(source, backup_path)
    with pytest.raises(module.GoalStorageError, match="version verification"):
        module._verify_goal_backup(source, backup_path, expected_version=1)

    plain_source_path = fixture_dir / "plain-source.sqlite3"
    plain_backup_path = fixture_dir / "plain-backup.sqlite3"
    plain_source = sqlite3.connect(plain_source_path)
    plain_source.execute("CREATE TABLE unrelated (value TEXT)")
    plain_source.commit()
    module._copy_goal_backup(plain_source, plain_backup_path)
    try:
        with pytest.raises(
            module.GoalSchemaNotInitializedError, match="kv_store is missing"
        ):
            module._verify_goal_backup(plain_source, plain_backup_path, 0)
    finally:
        plain_source.close()


@pytest.mark.parametrize(
    ("shape", "message"),
    [
        ("goals-without-history", "without goal schema migration history"),
        ("unrecorded-version", "without a recorded schema version"),
        ("missing-index", "required indexes are missing"),
        ("older-version", "older than supported"),
    ],
)
def test_goal_schema_version_guard_rejects_inconsistent_history(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: str,
    message: str,
) -> None:
    fixture_dir = tmp_path / f"schema-guard-{shape}"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        f"persistence_schema_guard_{shape}",
        fixture_dir / "global.db",
        fixture_dir / "project.db",
    )
    conn = sqlite3.connect(":memory:")
    if shape in {"goals-without-history", "unrecorded-version"}:
        conn.execute("CREATE TABLE pantheon_goals (goal_id TEXT)")
    if shape in {"unrecorded-version", "missing-index", "older-version"}:
        conn.execute("CREATE TABLE pantheon_goal_schema_migrations (version INTEGER)")
    if shape in {"missing-index", "older-version"}:
        conn.execute("INSERT INTO pantheon_goal_schema_migrations(version) VALUES (1)")
    if shape == "missing-index":
        conn.execute("CREATE TABLE pantheon_goals (goal_id TEXT)")
        conn.execute(
            "CREATE INDEX uq_pantheon_goals_active_session ON pantheon_goals(goal_id)"
        )
    if shape == "older-version":
        # Simulate a later binary that supports v2 while encountering a v1 DB.
        monkeypatch.setattr(module, "GOAL_SCHEMA_VERSION", 2)

    try:
        with pytest.raises(module.GoalSchemaVersionError, match=message):
            module._inspect_goal_schema_version(conn)
    finally:
        conn.close()


def test_migrate_goals_cli_exit_codes_cover_success_failure_and_dry_run(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    project_db = tmp_path / "synthetic-project.db"
    original = sqlite3.connect(project_db)
    original.execute("CREATE TABLE kv_store (value TEXT)")
    original.commit()
    original.close()

    success = _run_isolated_cli(
        "persistence_cli_success",
        tmp_path / "global.db",
        project_db,
        "--migrate-goals",
    )
    output = capsys.readouterr().out
    assert success == 0
    assert "Goal schema version: 1" in output
    assert "Backup:" in output

    missing_db = tmp_path / "not-created.db"
    dry_run = _run_isolated_cli(
        "persistence_cli_dry_run",
        tmp_path / "dry-run-global.db",
        missing_db,
        "--migrate-goals",
        "--dry-run",
    )
    dry_run_output = capsys.readouterr().out
    assert dry_run == 0
    assert "Exists: no" in dry_run_output
    assert not missing_db.exists()

    invalid_dry_run = _run_isolated_cli(
        "persistence_cli_invalid_dry_run",
        tmp_path / "invalid-global.db",
        missing_db,
        "--dry-run",
    )
    assert invalid_dry_run == EXPECTED_UNKNOWN_DRY_RUN_STATUS

    failed = _run_isolated_cli(
        "persistence_cli_missing_target",
        tmp_path / "failure-global.db",
        missing_db,
        "--migrate-goals",
    )
    failure_output = capsys.readouterr().err
    assert failed == 1
    assert "Goal schema migration failed" in failure_output
    assert not missing_db.exists()


def test_migrate_goals_cli_refuses_explicit_global_database(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    global_root = tmp_path / "global-root"
    global_root.mkdir()
    global_db = global_root / "global.db"
    _seed_legacy_persistence_db(global_db)
    before = global_db.read_bytes()

    exit_code = _run_isolated_cli(
        "persistence_cli_global_target",
        global_root,
        global_db,
        "--migrate-goals",
    )

    assert exit_code == 1
    assert "global Persistence database" in capsys.readouterr().err
    assert global_db.read_bytes() == before
    assert list(global_root.glob("*.goal-backup-*.sqlite3*")) == []


def test_dry_run_unknown_file_state_returns_status_two(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fixture_dir = tmp_path / "dry-run-unknown"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_dry_run_unknown",
        fixture_dir / "global.db",
        fixture_dir / "project.db",
    )

    def metadata_unavailable(_path: Path) -> tuple[None, None, None]:
        raise OSError("synthetic stat failure")

    monkeypatch.setattr(module, "_goal_dry_run_file_metadata", metadata_unavailable)

    assert (
        module._print_goal_migration_dry_run(fixture_dir / "project.db")
        == EXPECTED_UNKNOWN_DRY_RUN_STATUS
    )
    assert "Dry-run state is unknown" in capsys.readouterr().err


def test_goal_error_mapping_keeps_public_errors_actionable_and_storage_private(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "goal-error-mapping"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_goal_error_mapping",
        fixture_dir / "global.db",
        fixture_dir / "project.db",
    )

    cases = (
        (module.ActiveGoalExistsError("duplicate"), "already has an active goal"),
        (module.GoalNotFoundError("private query detail"), "No goal with that ID"),
        (
            module.GoalVersionConflictError("stale write"),
            "Call goal_get and retry",
        ),
        (module.GoalValidationError("bad title"), "Invalid goal request: bad title"),
        (
            module.GoalSchemaVersionError("schema 99"),
            "schema 99",
        ),
        (
            module.GoalStorageError("/private/project.db: locked"),
            "Goal storage is unavailable",
        ),
    )

    for error, expected in cases:
        message = str(module._goal_tool_error(error))
        assert expected in message
        if isinstance(error, module.GoalStorageError):
            assert "/private/project.db" not in message


def test_migrate_goals_cli_backs_up_wal_and_preserves_existing_rows(
    tmp_path: Path,
) -> None:
    project_db = tmp_path / "synthetic-project.db"
    original = sqlite3.connect(project_db)
    original.execute("PRAGMA journal_mode=WAL")
    original.execute("CREATE TABLE kv_store (value TEXT NOT NULL)")
    original.execute("CREATE TABLE sentinel (value TEXT NOT NULL)")
    original.execute("INSERT INTO kv_store VALUES ('preserve-me')")
    original.execute("INSERT INTO sentinel VALUES ('sentinel')")
    original.execute("CREATE TABLE existing_rows (value TEXT NOT NULL)")
    original.execute("INSERT INTO existing_rows VALUES ('preserve-me')")
    original.commit()

    script = Path(__file__).resolve().parents[1] / "scripts/mcp_persistence.py"

    def run_migration() -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["PANTHEON_PROJECT"] = str(tmp_path / "decoy-project")
        return subprocess.run(
            [
                sys.executable,
                str(script),
                "--project-db",
                str(project_db),
                "--migrate-goals",
            ],
            capture_output=True,
            check=False,
            text=True,
            env=environment,
            timeout=30,
        )

    first = run_migration()
    assert first.returncode == 0, first.stderr
    assert str(project_db) in first.stdout
    assert not (
        tmp_path / "decoy-project" / ".pantheon" / "persistence" / "project.db"
    ).exists()
    migrated = sqlite3.connect(project_db)
    try:
        recorded_version = migrated.execute(
            "SELECT MAX(version) FROM pantheon_goal_schema_migrations"
        ).fetchone()[0]
    finally:
        migrated.close()
    assert f"Goal schema version: {recorded_version}" in first.stdout
    backup_match = re.search(r"Backup: (.+)", first.stdout)
    assert backup_match is not None
    backup_path = Path(backup_match.group(1))
    assert backup_path.parent == project_db.parent
    assert backup_path != project_db
    assert backup_path.stat().st_mode & 0o777 == EXPECTED_BACKUP_MODE
    assert list(tmp_path.glob("*.goal-backup-*.sqlite3*")) == [backup_path]

    backup = sqlite3.connect(f"file:{backup_path}?mode=ro&immutable=1", uri=True)
    try:
        assert backup.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert (
            backup.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type='table' AND name='pantheon_goals'"
            ).fetchone()
            is None
        )
        assert backup.execute("SELECT value FROM existing_rows").fetchone() == (
            "preserve-me",
        )
    finally:
        backup.close()

    current = sqlite3.connect(project_db)
    try:
        assert current.execute("SELECT value FROM existing_rows").fetchone() == (
            "preserve-me",
        )
    finally:
        current.close()

    original.close()


def test_current_goal_schema_does_not_create_another_backup(tmp_path: Path) -> None:
    project_db = tmp_path / "already-current.db"
    connection = sqlite3.connect(project_db)
    connection.execute("CREATE TABLE kv_store (value TEXT)")
    connection.commit()
    connection.close()
    script = Path(__file__).resolve().parents[1] / "scripts/mcp_persistence.py"
    environment = os.environ.copy()
    environment.pop("PANTHEON_PROJECT", None)
    command = [
        sys.executable,
        str(script),
        "--project-db",
        str(project_db),
        "--migrate-goals",
    ]

    first = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        env=environment,
        timeout=30,
    )
    assert first.returncode == 0, first.stderr
    backups = list(tmp_path.glob("*.goal-backup-*.sqlite3*"))
    assert len(backups) == 1

    second = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
        env=environment,
        timeout=30,
    )
    assert second.returncode == 0, second.stderr
    assert "already current" in second.stdout.lower()
    assert "Backup:" not in second.stdout
    assert list(tmp_path.glob("*.goal-backup-*.sqlite3*")) == backups


def test_migrate_goals_resolution_matches_runtime_root_and_ignores_cwd(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture_dir = tmp_path / "resolution"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_runtime_resolution",
        fixture_dir / "global.db",
        fixture_dir / "project.db",
    )
    runtime_root = tmp_path / "runtime-target"
    script_location = runtime_root / "scripts" / "mcp_persistence.py"
    monkeypatch.setattr(module, "__file__", str(script_location))
    monkeypatch.delenv("PANTHEON_PROJECT", raising=False)
    runtime_root.mkdir()
    monkeypatch.chdir(runtime_root)
    operator_cwd = tmp_path / "operator-shell"
    operator_cwd.mkdir()
    monkeypatch.chdir(operator_cwd)

    server_equivalent_db = runtime_root / ".pantheon" / "persistence" / "project.db"
    assert module._resolve_project_db_path() == server_equivalent_db.resolve()

    env_project = tmp_path / "env-project"
    monkeypatch.setenv("PANTHEON_PROJECT", str(env_project))
    assert (
        module._resolve_project_db_path()
        == (env_project / ".pantheon" / "persistence" / "project.db").resolve()
    )


def test_server_project_db_flag_overrides_pantheon_project(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    explicit_project = tmp_path / "explicit-project" / "project.db"
    decoy_project = tmp_path / "decoy-project"
    decoy_project.mkdir()
    monkeypatch.setenv("PANTHEON_PROJECT", str(decoy_project))

    module = _load_isolated_module(
        "persistence_explicit_project_precedence",
        tmp_path / "global.db",
        explicit_project,
    )

    assert module._project_db_path == explicit_project.resolve()
    assert explicit_project.exists()
    assert not (decoy_project / ".pantheon" / "persistence" / "project.db").exists()


def test_migrate_goals_dry_run_reports_without_creating_or_changing_db(
    tmp_path: Path,
) -> None:
    project_root = tmp_path / "dry-run-project"
    project_root.mkdir()
    operator_cwd = tmp_path / "dry-run-operator"
    operator_cwd.mkdir()
    script = Path(__file__).resolve().parents[1] / "scripts/mcp_persistence.py"
    environment = {**os.environ, "PANTHEON_PROJECT": str(project_root)}

    missing = subprocess.run(
        [sys.executable, str(script), "--migrate-goals", "--dry-run"],
        cwd=operator_cwd,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
        timeout=30,
    )
    expected_db = project_root / ".pantheon" / "persistence" / "project.db"
    assert missing.returncode == 0, missing.stderr
    assert f"Database: {expected_db}" in missing.stdout
    assert "Exists: no" in missing.stdout
    assert "Size: 0 bytes" in missing.stdout
    assert "Sidecars: WAL=no, SHM=no" in missing.stdout
    assert "Goal tables exist: no" in missing.stdout
    assert not expected_db.exists()
    assert not expected_db.with_name(expected_db.name + "-wal").exists()
    assert not expected_db.with_name(expected_db.name + "-shm").exists()

    expected_db.parent.mkdir(parents=True)
    existing_db = sqlite3.connect(expected_db)
    existing_db.execute("CREATE TABLE kv_store (namespace TEXT, key TEXT, value TEXT)")
    existing_db.execute("INSERT INTO kv_store VALUES ('n', 'k', 'v')")
    existing_db.commit()
    existing_db.close()
    before = expected_db.read_bytes()
    existing = subprocess.run(
        [sys.executable, str(script), "--migrate-goals", "--dry-run"],
        cwd=operator_cwd,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
        timeout=30,
    )
    assert existing.returncode == 0, existing.stderr
    assert "Exists: yes" in existing.stdout
    assert f"Size: {len(before)} bytes" in existing.stdout
    assert "Sidecars: WAL=no, SHM=no" in existing.stdout
    assert "Goal tables exist: no" in existing.stdout
    assert expected_db.read_bytes() == before
    assert not expected_db.with_name(expected_db.name + "-wal").exists()
    assert not expected_db.with_name(expected_db.name + "-shm").exists()


def test_dry_run_reads_wal_state_and_warns_to_stop_server(tmp_path: Path) -> None:
    db_path = tmp_path / "wal-project.db"
    writer = sqlite3.connect(db_path)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("CREATE TABLE kv_store (value TEXT)")
    writer.commit()
    writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    writer.execute("CREATE TABLE pantheon_goals (goal_id TEXT)")
    writer.commit()
    wal_path = Path(f"{db_path}-wal")
    assert wal_path.is_file() and wal_path.stat().st_size > 0
    expected_size = db_path.stat().st_size + wal_path.stat().st_size

    script = Path(__file__).resolve().parents[1] / "scripts/mcp_persistence.py"
    environment = os.environ.copy()
    environment.pop("PANTHEON_PROJECT", None)
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--project-db",
                str(db_path),
                "--migrate-goals",
                "--dry-run",
            ],
            capture_output=True,
            check=False,
            text=True,
            env=environment,
            timeout=30,
        )

        assert result.returncode == 0, result.stderr
        assert "Goal tables exist: yes (pantheon_goals)" in result.stdout
        assert f"Size: {expected_size} bytes" in result.stdout
        assert "Sidecars: WAL=yes, SHM=yes" in result.stdout
        assert wal_path.is_file()
        assert Path(f"{db_path}-shm").is_file()
        assert "Warning:" in result.stdout
        assert "stop the Persistence server" in result.stdout
    finally:
        writer.close()


def test_dry_run_reads_clean_database_in_read_only_directory(tmp_path: Path) -> None:
    database_dir = tmp_path / "readonly"
    database_dir.mkdir()
    db_path = database_dir / "project.db"
    connection = sqlite3.connect(db_path)
    connection.execute("CREATE TABLE kv_store (value TEXT)")
    connection.execute("CREATE TABLE pantheon_goals (goal_id TEXT)")
    connection.commit()
    connection.close()
    db_path.chmod(0o444)
    database_dir.chmod(0o555)

    script = Path(__file__).resolve().parents[1] / "scripts/mcp_persistence.py"
    environment = os.environ.copy()
    environment.pop("PANTHEON_PROJECT", None)
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--project-db",
                str(db_path),
                "--migrate-goals",
                "--dry-run",
            ],
            capture_output=True,
            check=False,
            text=True,
            env=environment,
            timeout=30,
        )
    finally:
        database_dir.chmod(0o755)
        db_path.chmod(0o644)

    assert result.returncode == 0, result.stderr
    assert "Sidecars: WAL=no, SHM=no" in result.stdout
    assert "Goal tables exist: yes (pantheon_goals)" in result.stdout
    assert not Path(f"{db_path}-wal").exists()
    assert not Path(f"{db_path}-shm").exists()


def test_dry_run_unknown_schema_state_exits_distinctly(tmp_path: Path) -> None:
    db_path = tmp_path / "not-sqlite.db"
    db_path.write_bytes(b"synthetic invalid SQLite fixture")
    script = Path(__file__).resolve().parents[1] / "scripts/mcp_persistence.py"
    environment = os.environ.copy()
    environment.pop("PANTHEON_PROJECT", None)

    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--project-db",
            str(db_path),
            "--migrate-goals",
            "--dry-run",
        ],
        capture_output=True,
        check=False,
        text=True,
        env=environment,
        timeout=30,
    )

    assert result.returncode == EXPECTED_UNKNOWN_DRY_RUN_STATUS
    assert "Goal tables exist: unknown" in result.stdout
    assert "stop and investigate" in result.stderr.lower()


def test_relative_pantheon_project_is_rejected(tmp_path: Path, monkeypatch) -> None:
    fixture_dir = tmp_path / "relative-project"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_relative_project_override",
        fixture_dir / "global.db",
        fixture_dir / "project.db",
    )
    monkeypatch.setenv("PANTHEON_PROJECT", "relative/project")

    with pytest.raises(
        module.GoalSchemaNotInitializedError,
        match="PANTHEON_PROJECT must be an absolute path",
    ):
        module._resolve_project_db_path()


def test_runtime_cli_precedence_with_decoy_cwd_and_environment(
    tmp_path: Path,
) -> None:
    runtime = tmp_path / "runtime"
    runtime_scripts = runtime / "scripts"
    runtime_scripts.mkdir(parents=True)
    source_root = Path(__file__).resolve().parents[1]
    script = runtime_scripts / "mcp_persistence.py"
    script.write_bytes((source_root / "scripts/mcp_persistence.py").read_bytes())
    (runtime_scripts / "_pantheon_paths.py").write_bytes(
        (source_root / "scripts/_pantheon_paths.py").read_bytes()
    )
    interpreter = runtime / ".venv" / "bin" / "python3"
    interpreter.parent.mkdir(parents=True)
    interpreter.symlink_to(sys.executable)

    target_db = runtime / ".pantheon" / "persistence" / "project.db"
    target_db.parent.mkdir(parents=True)
    target = sqlite3.connect(target_db)
    target.execute("CREATE TABLE kv_store (value TEXT)")
    target.execute("CREATE TABLE pantheon_goals (goal_id TEXT)")
    target.commit()
    target.close()

    decoy_cwd = tmp_path / "decoy-cwd"
    decoy_cwd.mkdir()
    decoy_project = tmp_path / "decoy-project"
    decoy_project.mkdir()
    runtime_env = {
        **os.environ,
        "PANTHEON_PROJECT": str(decoy_project),
        "PYTHONPATH": os.pathsep.join(sys.path),
    }
    result = subprocess.run(
        [
            str(interpreter),
            str(script),
            "--project-db",
            ".pantheon/persistence/project.db",
            "--migrate-goals",
            "--dry-run",
        ],
        cwd=decoy_cwd,
        env=runtime_env,
        capture_output=True,
        check=False,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert f"Database: {target_db}" in result.stdout
    assert "Goal tables exist: yes (pantheon_goals)" in result.stdout
    assert "symlinked launcher" not in result.stdout.lower()
    assert "symlinked launcher" not in result.stderr.lower()
    assert not (decoy_project / ".pantheon" / "persistence" / "project.db").exists()

    symlinked_launcher = runtime_scripts / "launcher.py"
    symlinked_launcher.symlink_to(script)
    symlinked = subprocess.run(
        [
            str(interpreter),
            str(symlinked_launcher),
            "--project-db",
            ".pantheon/persistence/project.db",
            "--migrate-goals",
            "--dry-run",
        ],
        cwd=decoy_cwd,
        env=runtime_env,
        capture_output=True,
        check=False,
        text=True,
        timeout=30,
    )
    assert symlinked.returncode == 0, symlinked.stderr
    assert "symlinked launcher" in symlinked.stderr.lower()
    assert "re-run from the installed script" in symlinked.stderr.lower()


def test_migration_guard_rejects_programmatic_target_misuse(
    tmp_path: Path,
) -> None:
    fixture_dir = tmp_path / "guard"
    fixture_dir.mkdir()
    module = _load_isolated_module(
        "persistence_migration_guard",
        fixture_dir / "global.db",
        fixture_dir / "server-project.db",
    )
    target = fixture_dir / "different-target.db"
    connection = sqlite3.connect(target)
    connection.execute("CREATE TABLE kv_store (value TEXT)")
    connection.commit()
    connection.close()
    before = target.read_bytes()

    with pytest.raises(
        module.GoalSchemaNotInitializedError,
        match="differs from the Persistence server database",
    ):
        module.migrate_goal_schema_with_backup(
            target,
            explicit_project_db=False,
        )

    assert target.read_bytes() == before
    assert list(fixture_dir.glob("*.goal-backup-*.sqlite3*")) == []


def test_goal_schema_helpers_refuse_global_database_even_when_explicit(
    tmp_path: Path,
) -> None:
    global_root = tmp_path / "global-root"
    global_root.mkdir()
    global_db = global_root / "global.db"
    module = _load_isolated_module(
        "persistence_global_helper_guard",
        global_root,
        tmp_path / "project.db",
    )
    assert module._global_db is not None
    before = global_db.read_bytes()

    with pytest.raises(
        module.GoalSchemaNotInitializedError, match="global Persistence database"
    ):
        module.upgrade_goal_schema(
            module._global_db,
            expected_path=global_db,
            explicit_project_db=True,
        )
    with pytest.raises(
        module.GoalSchemaNotInitializedError, match="global Persistence database"
    ):
        module.migrate_goal_schema_with_backup(
            global_db,
            explicit_project_db=True,
        )

    assert global_db.read_bytes() == before
    assert list(global_root.glob("*.goal-backup-*.sqlite3*")) == []


def test_hard_link_alias_to_global_database_is_refused_by_all_goal_paths(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    global_root = tmp_path / "global-root"
    global_root.mkdir()
    global_db = global_root / "global.db"
    _seed_legacy_persistence_db(global_db)
    alias_root = tmp_path / "project-alias"
    alias_root.mkdir()
    alias_db = alias_root / "project.db"
    os.link(global_db, alias_db)

    module = _load_isolated_module(
        "persistence_global_hard_link_guard",
        global_root,
        tmp_path / "server-project.db",
    )
    assert module._project_db is not None

    normal_project_db = tmp_path / "normal-project.db"
    normal_project = module._init_db(normal_project_db, project_db=True)
    try:
        assert normal_project.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' "
            "AND name = 'pantheon_goals'"
        ).fetchone() == (1,)
    finally:
        normal_project.close()

    expected_error = "target resolves to the global database"
    with pytest.raises(module.GoalSchemaNotInitializedError, match=expected_error):
        module._init_db(alias_db, project_db=True)
    with pytest.raises(module.GoalSchemaNotInitializedError, match=expected_error):
        module.migrate_goal_schema_with_backup(
            alias_db,
            explicit_project_db=True,
        )

    exit_code = _run_isolated_cli(
        "persistence_cli_global_hard_link_guard",
        global_root,
        alias_db,
        "--migrate-goals",
    )
    assert exit_code == 1
    assert expected_error in capsys.readouterr().err
    assert list(alias_root.glob("*.goal-backup-*.sqlite3*")) == []
    assert list(global_root.glob("*.goal-backup-*.sqlite3*")) == []


def test_upgrade_failure_reports_verified_backup_retention(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fixture_dir = tmp_path / "upgrade-failure"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    _seed_legacy_persistence_db(project_db)
    module = _load_isolated_module(
        "persistence_upgrade_failure",
        fixture_dir / "global.db",
        project_db,
    )

    def fail_upgrade(*_args: object, **_kwargs: object) -> None:
        raise module.GoalStorageError("synthetic failure")

    monkeypatch.setattr(module, "upgrade_goal_schema", fail_upgrade)
    with pytest.raises(module.GoalBackupRetainedError) as error:
        module.migrate_goal_schema_with_backup(project_db)
    module._print_goal_migration_failure(error.value)

    backup_path = error.value.backup_path
    assert backup_path.exists()
    assert str(backup_path) in capsys.readouterr().err


def test_post_upgrade_version_read_failure_reports_retained_backup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fixture_dir = tmp_path / "post-upgrade-version-failure"
    fixture_dir.mkdir()
    project_db = fixture_dir / "project.db"
    _seed_legacy_persistence_db(project_db)
    module = _load_isolated_module(
        "persistence_post_upgrade_version_failure",
        fixture_dir / "global.db",
        project_db,
    )
    raw_version = module._raw_goal_schema_version
    calls = 0

    def fail_after_upgrade(connection: sqlite3.Connection) -> int:
        nonlocal calls
        calls += 1
        if calls == POST_UPGRADE_VERSION_READ_CALL:
            raise module.GoalStorageError("synthetic post-upgrade read failure")
        return raw_version(connection)

    monkeypatch.setattr(module, "_raw_goal_schema_version", fail_after_upgrade)
    with pytest.raises(module.GoalBackupRetainedError) as error:
        module.migrate_goal_schema_with_backup(project_db)
    module._print_goal_migration_failure(error.value)

    backup_path = error.value.backup_path
    assert backup_path.exists()
    assert str(backup_path) in capsys.readouterr().err


@pytest.mark.parametrize("target", ["missing", "without-kv-store"])
def test_migration_refuses_missing_or_non_persistence_target(
    tmp_path: Path,
    target: str,
) -> None:
    fixture_dir = tmp_path / f"invalid-target-{target}"
    fixture_dir.mkdir()
    project_db = fixture_dir / "target.db"
    module = _load_isolated_module(
        f"persistence_invalid_target_{target}",
        fixture_dir / "global.db",
        fixture_dir / "active-project.db",
    )
    if target == "without-kv-store":
        connection = sqlite3.connect(project_db)
        connection.execute("CREATE TABLE unrelated (value TEXT)")
        connection.commit()
        connection.close()
    else:
        project_db = fixture_dir / "does-not-exist" / "target.db"

    with pytest.raises(
        module.GoalSchemaNotInitializedError,
        match="start the server once",
    ):
        module.migrate_goal_schema_with_backup(project_db)
    if target == "missing":
        assert not project_db.exists()
    else:
        assert project_db.exists()
    assert list(fixture_dir.glob("*.goal-backup-*.sqlite3*")) == []


def test_populated_goal_schema_refuses_downgrade_without_data_loss(persistence) -> None:
    module, _ = persistence
    project = module._project_db
    goal = module.create_goal(session_id="ses_downgrade", title="Keep me")

    with pytest.raises(module.GoalSchemaVersionError, match="goal data"):
        module.downgrade_goal_schema(project)

    assert module.get_goal(session_id="ses_downgrade", goal_id=goal.goal_id) == goal
    assert (
        project.execute(
            "SELECT MAX(version) FROM pantheon_goal_schema_migrations"
        ).fetchone()[0]
        == module.GOAL_SCHEMA_VERSION
    )


def test_goal_operation_rejects_newer_schema_version(persistence) -> None:
    module, _ = persistence
    project = module._project_db
    project.execute(
        "UPDATE pantheon_goal_schema_migrations SET version = 2 WHERE version = 1"
    )
    project.commit()

    with pytest.raises(module.GoalSchemaVersionError, match="newer than supported"):
        module.get_goal(session_id="ses_newer_schema")


def test_half_created_goal_schema_reports_human_repair_path(persistence) -> None:
    module, _ = persistence
    project = module._project_db
    project.execute("DROP TABLE pantheon_goals")
    project.commit()

    with pytest.raises(
        module.GoalSchemaVersionError,
        match="half-created schema",
    ) as error:
        module.get_goal(session_id="ses_half_created")
    assert "restore a verified backup" in str(error.value)
    assert "Ask the user" in str(error.value)


def test_latest_completed_goal_uses_insertion_order_for_timestamp_ties(
    persistence,
) -> None:
    module, _ = persistence
    project = module._project_db
    timestamp = "2026-10-21T12:00:00.000000+00:00"
    for goal_id, title in (("z-first", "Inserted first"), ("a-last", "Inserted last")):
        project.execute(
            "INSERT INTO pantheon_goals(" + module._GOAL_COLUMNS + ") "
            "VALUES (?, ?, ?, NULL, 'done', ?, ?, 1)",
            (goal_id, "ses_tiebreak", title, timestamp, timestamp),
        )
    project.commit()

    latest = module.get_goal(session_id="ses_tiebreak")

    assert latest is not None
    assert latest.goal_id == "a-last"


def test_goal_records_are_partitioned_by_session_in_the_same_database(
    persistence,
) -> None:
    module, _ = persistence
    project = module._project_db
    assert project is not None
    first = module.create_goal(session_id="ses_one", title="First session")
    second = module.create_goal(session_id="ses_two", title="Other session")
    assert module.get_goal(session_id="ses_one") == first
    assert module.get_goal(session_id="ses_two") == second

    with pytest.raises(module.GoalSchemaNotInitializedError):
        module._assert_project_goal_connection(
            module._global_db,
            module._project_db_path,
            explicit_project_db=True,
        )
    with pytest.raises(module.GoalSchemaNotInitializedError):
        module.upgrade_goal_schema(module._global_db)
    with pytest.raises(TypeError):
        module.create_goal(
            session_id="ses_global", title="No scope selector", scope="global"
        )


def test_duplicate_and_concurrent_create_has_one_deterministic_winner(
    persistence,
) -> None:
    module, fixture_dir = persistence
    barrier = threading.Barrier(CONCURRENT_CREATE_COUNT)
    aliases: list[str] = []
    repositories = [module]
    for index in range(CONCURRENT_CREATE_COUNT - 1):
        alias = f"goal_test_racer_{index}"
        aliases.append(alias)
        repositories.append(
            _load_isolated_module(
                alias,
                fixture_dir / "global.db",
                fixture_dir / "project.db",
            )
        )

    def create_from_connection(index: int):
        repository = repositories[index]
        barrier.wait(timeout=5)
        try:
            goal = repository.create_goal(
                session_id="ses_race", title=f"Candidate {index}"
            )
            return ("created", goal)
        except repository.ActiveGoalExistsError as exc:
            return ("duplicate", str(exc))

    try:
        with ThreadPoolExecutor(max_workers=CONCURRENT_CREATE_COUNT) as pool:
            outcomes = list(
                pool.map(create_from_connection, range(CONCURRENT_CREATE_COUNT))
            )
    finally:
        for alias in aliases:
            repository = sys.modules[alias]
            repository._project_db.close()
            repository._global_db.close()
            sys.modules.pop(alias, None)
    created = [result[1] for result in outcomes if result[0] == "created"]
    rejected = [result[1] for result in outcomes if result[0] == "duplicate"]
    assert len(created) == 1
    assert len(rejected) == CONCURRENT_CREATE_COUNT - 1
    assert all("active goal already exists" in error for error in rejected)
    winner = created[0]
    independent = sqlite3.connect(fixture_dir / "project.db", timeout=5)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            independent.execute(
                "INSERT INTO pantheon_goals("
                "goal_id, session_id, title, description, status, created_at, "
                "updated_at, version) VALUES (?, ?, ?, NULL, 'active', ?, ?, 1)",
                (
                    "synthetic-second-active",
                    "ses_race",
                    "Should be constrained",
                    winner.created_at,
                    winner.updated_at,
                ),
            )
    finally:
        independent.close()
    with pytest.raises(module.ActiveGoalExistsError):
        module.create_goal(session_id="ses_race", title="Duplicate")


def test_update_uses_compare_and_swap_and_done_retains_history(persistence) -> None:
    module, _ = persistence
    project = module._project_db
    goal = module.create_goal(
        session_id="ses_lifecycle", title="Draft", description="Details"
    )
    updated = module.update_goal(
        session_id="ses_lifecycle",
        goal_id=goal.goal_id,
        expected_version=goal.version,
        title="Revised",
        description=None,
    )
    assert updated.title == "Revised"
    assert updated.description is None
    assert updated.version == goal.version + 1
    with pytest.raises(module.GoalVersionConflictError):
        module.update_goal(
            session_id="ses_lifecycle",
            goal_id=goal.goal_id,
            expected_version=goal.version,
            title="Stale write",
        )
    assert module.get_goal(session_id="ses_lifecycle") == updated

    done = module.complete_goal(
        session_id="ses_lifecycle",
        goal_id=goal.goal_id,
        expected_version=updated.version,
    )
    assert done.status == "done"
    repeated = module.complete_goal(
        session_id="ses_lifecycle",
        goal_id=goal.goal_id,
        expected_version=updated.version,
    )
    assert repeated == done

    replacement = module.create_goal(session_id="ses_lifecycle", title="Next goal")
    assert replacement.goal_id != done.goal_id
    assert module.get_goal(session_id="ses_lifecycle") == replacement
    assert module.get_goal(session_id="ses_lifecycle", goal_id=done.goal_id) == done
    assert (
        project.execute(
            "SELECT COUNT(*) FROM pantheon_goals WHERE session_id = ?",
            ("ses_lifecycle",),
        ).fetchone()[0]
        == EXPECTED_HISTORY_COUNT
    )


def test_failed_update_rolls_back_without_changing_goal(persistence) -> None:
    module, _ = persistence
    project = module._project_db
    goal = module.create_goal(session_id="ses_rollback", title="Stable")
    project.execute(
        "CREATE TRIGGER reject_goal_update BEFORE UPDATE ON pantheon_goals "
        "BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
    )
    project.commit()

    with pytest.raises(module.GoalStorageError):
        module.update_goal(
            session_id="ses_rollback",
            goal_id=goal.goal_id,
            expected_version=goal.version,
            title="Must roll back",
        )
    project.execute("DROP TRIGGER reject_goal_update")
    project.commit()
    assert module.get_goal(session_id="ses_rollback") == goal


def test_validation_and_not_found_failures_are_typed(persistence) -> None:
    module, _ = persistence
    for kwargs in (
        {"session_id": "ses_invalid", "title": "  "},
        {"session_id": "ses_invalid", "title": "valid", "description": 12},
        {"session_id": "ses_" + "x" * 129, "title": "valid"},
        {"session_id": "ses_invalid\n", "title": "valid"},
    ):
        with pytest.raises(module.GoalValidationError):
            module.create_goal(**kwargs)

    with pytest.raises(module.GoalNotFoundError):
        module.update_goal(
            session_id="ses_missing",
            goal_id="missing",
            expected_version=1,
            title="Cannot update",
        )
    with pytest.raises(module.GoalNotFoundError):
        module.complete_goal(
            session_id="ses_missing",
            goal_id="missing",
            expected_version=1,
        )

    goal = module.create_goal(session_id="ses_owned_fields", title="Server state")
    with pytest.raises(TypeError):
        module.update_goal(
            session_id="ses_owned_fields",
            goal_id=goal.goal_id,
            expected_version=goal.version,
            status="done",
        )
    with pytest.raises(module.GoalValidationError):
        module.update_goal(
            session_id="ses_owned_fields",
            goal_id=goal.goal_id,
            expected_version=True,
            title="Invalid version",
        )
    with pytest.raises(module.GoalValidationError):
        module.update_goal(
            session_id="ses_owned_fields",
            goal_id=goal.goal_id,
            expected_version=goal.version,
        )


def _tool_payload(result) -> dict[str, object]:
    for content in result.content:
        text = getattr(content, "text", None)
        if text:
            return json.loads(text)
    raise AssertionError("goal tool response did not include JSON content")


@pytest.mark.asyncio
async def test_goal_tool_schema_and_lifecycle_use_fastmcp_context_metadata(
    persistence,
) -> None:
    module, _ = persistence
    tools = {tool.name: tool for tool in await module.mcp.list_tools()}
    goal_tools = {name for name in tools if name.startswith("goal_")}
    assert goal_tools == {"goal_create", "goal_get", "goal_update", "goal_done"}

    schemas = {
        name: getattr(tool, "parameters", None) or getattr(tool, "inputSchema", {})
        for name, tool in tools.items()
        if name in goal_tools
    }
    assert set(schemas["goal_create"]["properties"]) == {"title", "description"}
    assert set(schemas["goal_get"]["properties"]) == {"goal_id"}
    assert set(schemas["goal_update"]["properties"]) == {
        "goal_id",
        "expected_version",
        "title",
        "description",
        "clear_description",
    }
    assert set(schemas["goal_done"]["properties"]) == {"goal_id", "expected_version"}
    forbidden_fields = {"session_id", "sessionID", "project_path", "project", "scope"}
    for schema in schemas.values():
        assert forbidden_fields.isdisjoint(schema["properties"])

    async with Client(module.mcp) as client:
        meta = {"ai.opencode/sessionID": "ses_transport_lifecycle"}
        created = _tool_payload(
            await client.call_tool(
                "goal_create",
                {"title": "Transport goal", "description": "Initial details"},
                meta=meta,
            )
        )["goal"]
        assert created["status"] == "active"
        assert set(created) == {
            "goal_id",
            "title",
            "description",
            "status",
            "created_at",
            "updated_at",
            "version",
        }

        duplicate = await client.call_tool(
            "goal_create",
            {"title": "Would violate active-goal uniqueness"},
            meta=meta,
            raise_on_error=False,
        )
        assert duplicate.is_error
        assert "already has an active goal" in duplicate.content[0].text.lower()

        invalid_version = await client.call_tool(
            "goal_done",
            {"goal_id": created["goal_id"], "expected_version": True},
            meta=meta,
            raise_on_error=False,
        )
        assert invalid_version.is_error

        updated = _tool_payload(
            await client.call_tool(
                "goal_update",
                {
                    "goal_id": created["goal_id"],
                    "expected_version": created["version"],
                    "title": "Revised title",
                    "description": None,
                    "clear_description": True,
                },
                meta=meta,
            )
        )["goal"]
        assert updated["title"] == "Revised title"
        assert updated["description"] is None
        assert updated["version"] == created["version"] + 1

        stale = await client.call_tool(
            "goal_update",
            {
                "goal_id": created["goal_id"],
                "expected_version": created["version"],
                "title": "Stale title",
            },
            meta=meta,
            raise_on_error=False,
        )
        assert stale.is_error
        assert "changed" in stale.content[0].text.lower()

        completed = _tool_payload(
            await client.call_tool(
                "goal_done",
                {"goal_id": created["goal_id"], "expected_version": updated["version"]},
                meta=meta,
            )
        )["goal"]
        assert completed["status"] == "done"
        assert completed["version"] == updated["version"] + 1
        repeated = _tool_payload(
            await client.call_tool(
                "goal_done",
                {"goal_id": created["goal_id"], "expected_version": 1},
                meta=meta,
            )
        )["goal"]
        assert repeated == completed
        latest = _tool_payload(await client.call_tool("goal_get", {}, meta=meta))
        assert latest["goal"] == completed

        replacement = _tool_payload(
            await client.call_tool("goal_create", {"title": "Replacement"}, meta=meta)
        )["goal"]
        assert replacement["goal_id"] != completed["goal_id"]
        latest = _tool_payload(await client.call_tool("goal_get", {}, meta=meta))
        assert latest["goal"] == replacement
        assert (
            _tool_payload(
                await client.call_tool(
                    "goal_get", {"goal_id": completed["goal_id"]}, meta=meta
                )
            )["goal"]
            == completed
        )

    assert "project.db" not in json.dumps(created)
    assert "SELECT" not in json.dumps(created)
    assert (
        module._global_db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name='pantheon_goals'"
        ).fetchone()
        is None
    )


@pytest.mark.asyncio
async def test_goal_context_metadata_fails_closed_for_missing_or_malformed_values(
    persistence,
) -> None:
    module, _ = persistence
    invalid_metadata = (
        None,
        {},
        {"session_id": "ses_other"},
        {"ai.opencode/sessionID": ""},
        {"ai.opencode/sessionID": " "},
        {"ai.opencode/sessionID": "not-a-session"},
        {"ai.opencode/sessionID": "ses_bad\nvalue"},
        {"ai.opencode/sessionID": "ses_" + "x" * 125},
        {"ai.opencode/sessionID": {"value": "ses_nested"}},
    )
    async with Client(module.mcp) as client:
        for meta in invalid_metadata:
            result = await client.call_tool(
                "goal_create",
                {"title": "Must not persist"},
                meta=meta,
                raise_on_error=False,
            )
            assert result.is_error
            assert "session" in result.content[0].text.lower()

        for forged_args in (
            {"title": "No session override", "session_id": "ses_victim"},
            {"title": "No project override", "project_path": "/tmp/another"},
            {"title": "No generic scope", "scope": "global"},
        ):
            result = await client.call_tool(
                "goal_create",
                forged_args,
                meta={"ai.opencode/sessionID": "ses_metadata_only"},
                raise_on_error=False,
            )
            assert result.is_error

    assert (
        module._project_db.execute("SELECT COUNT(*) FROM pantheon_goals").fetchone()[0]
        == 0
    )
    assert (
        module._global_db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name='pantheon_goals'"
        ).fetchone()
        is None
    )


@pytest.mark.asyncio
async def test_synthetic_forged_context_metadata_is_only_a_scope_key(
    persistence,
) -> None:
    module, _ = persistence
    async with Client(module.mcp) as client:
        # This is a synthetic direct-client probe, not authentication: the
        # documented deployment boundary is OpenCode-mediated local stdio.
        forged = {"ai.opencode/sessionID": "ses_synthetic_forged"}
        created = _tool_payload(
            await client.call_tool(
                "goal_create", {"title": "Synthetic scope"}, meta=forged
            )
        )["goal"]
        assert "session_id" not in created
        current = _tool_payload(await client.call_tool("goal_get", {}, meta=forged))
        assert current["goal"] == created
        assert (
            _tool_payload(
                await client.call_tool(
                    "goal_get",
                    {},
                    meta={"ai.opencode/sessionID": "ses_unrelated"},
                )
            )["goal"]
            is None
        )
        cross_session_update = await client.call_tool(
            "goal_update",
            {
                "goal_id": created["goal_id"],
                "expected_version": created["version"],
                "title": "Cannot target another session",
            },
            meta={"ai.opencode/sessionID": "ses_unrelated"},
            raise_on_error=False,
        )
        assert cross_session_update.is_error
        assert "this session" in cross_session_update.content[0].text.lower()
