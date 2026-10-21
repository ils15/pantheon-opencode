#!/usr/bin/env python3
"""Pantheon Persistence MCP Server.

Operational-state checkpoints and manual session-scoped goal tools. The server
exposes context_save/context_get for checkpoints and four manual goal tools.
Goal tools use OpenCode session metadata and do not trigger automatic continuation.

Usage:
    <venv>/bin/python3 scripts/mcp_persistence.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from _pantheon_paths import pantheon_home
from fastmcp import Context, FastMCP
from fastmcp.exceptions import ToolError
from pydantic import Field

# ── Schema ──────────────────────────────────────────────────────────────────────

CREATE_SQL: str = """
CREATE TABLE IF NOT EXISTS kv_store (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TEXT,        -- ISO 8601, NULL = forever
    deleted_at TEXT,        -- NULL = active; retained for legacy schema compatibility
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    revision INTEGER,        -- context monotonic revision; NULL = legacy row
    UNIQUE(namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_kv_namespace_expires
ON kv_store(namespace, expires_at);

CREATE VIRTUAL TABLE IF NOT EXISTS kv_store_fts USING fts5(
    namespace, key, value,
    content='kv_store', content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS kv_store_ai AFTER INSERT ON kv_store BEGIN
    INSERT INTO kv_store_fts(rowid, namespace, key, value)
    VALUES (new.id, new.namespace, new.key, new.value);
END;

CREATE TRIGGER IF NOT EXISTS kv_store_ad AFTER DELETE ON kv_store BEGIN
    INSERT INTO kv_store_fts(kv_store_fts, rowid, namespace, key, value)
    VALUES('delete', old.id, old.namespace, old.key, old.value);
END;

CREATE TRIGGER IF NOT EXISTS kv_store_softdelete_ad
AFTER UPDATE OF deleted_at ON kv_store
WHEN new.deleted_at IS NOT NULL AND old.deleted_at IS NULL
BEGIN
    INSERT INTO kv_store_fts(kv_store_fts, rowid)
    VALUES('delete', old.id);
END;

CREATE TRIGGER IF NOT EXISTS kv_store_au AFTER UPDATE ON kv_store BEGIN
    INSERT INTO kv_store_fts(kv_store_fts, rowid, namespace, key, value)
    VALUES('delete', old.id, old.namespace, old.key, old.value);
    INSERT INTO kv_store_fts(rowid, namespace, key, value)
    VALUES (new.id, new.namespace, new.key, new.value);
END;
"""

# ── FastMCP App ────────────────────────────────────────────────────────────────

mcp = FastMCP(
    "pantheon-persistence",
    instructions="Operational-state checkpoints through context_save/context_get "
    "and four manual session-scoped goal tools. Goal tools use OpenCode session "
    "metadata and do not trigger automatic continuation.",
)

# ── Database Initialization ─────────────────────────────────────────────────────

_global_db: sqlite3.Connection | None = None
_project_db: sqlite3.Connection | None = None


def _init_db(db_path: Path) -> sqlite3.Connection:
    """Initialize a SQLite database with WAL mode and schema."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    # ── FTS5 Availability Check ──────────────────────────────────────────
    # Check BEFORE schema creation. FTS5 is an optional internal index.
    row = conn.execute("PRAGMA compile_options").fetchall()
    if not any("ENABLE_FTS5" in r[0] for r in row):
        print(
            "WARNING: SQLite FTS5 unavailable; the internal full-text index "
            "was not initialized.",
            file=sys.stderr,
        )
        import re as _re  # noqa: PLC0415

        _no_fts = _re.sub(
            r"CREATE VIRTUAL TABLE IF NOT EXISTS kv_store_fts.*?;",
            "",
            CREATE_SQL,
            flags=_re.DOTALL,
        )
        conn.executescript(_no_fts)
    else:
        conn.executescript(CREATE_SQL)
    _ensure_revision_column(conn)
    conn.commit()

    return conn


# `revision` was added after `kv_store` shipped, so an existing database has the
# column only if it is added here. ADD COLUMN is additive and non-destructive:
# pre-existing rows get NULL, which every reader treats as "no revision yet"
# and resolves through the legacy `updated_at` path. No backfill is performed
# on purpose — the live store holds both formats and rewriting them in place
# would be unrecoverable if the mapping were ever wrong.
_ADD_REVISION_SQL: str = "ALTER TABLE kv_store ADD COLUMN revision INTEGER"


def _ensure_revision_column(conn: sqlite3.Connection) -> None:
    """Add the dedicated ``revision`` column if this database predates it."""
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(kv_store)")}
    except sqlite3.Error:
        return
    if "revision" in columns:
        return
    with suppress(sqlite3.OperationalError):
        conn.execute(_ADD_REVISION_SQL)


def _db(scope: str) -> sqlite3.Connection:
    """Resolve the connection for the given scope."""
    if scope == "global":
        if _global_db is None:
            raise RuntimeError("Global database not initialized")
        return _global_db
    if scope == "project":
        if _project_db is None:
            raise ValueError(
                "Project database not available. "
                "Set PANTHEON_PROJECT or use scope='global'"
            )
        return _project_db
    raise ValueError(f"Unknown scope: {scope!r}. Expected 'global' or 'project'.")


# ── Typed, session-scoped manual goal repository ────────────────────────────────

GOAL_SCHEMA_VERSION = 1
GOAL_SCHEMA_MIGRATION_COMMAND = "<venv-python> <installed-script> --migrate-goals"
GOAL_SCHEMA_MIGRATION_COMMAND_GUIDANCE = (
    "Global install: <runtime>/.venv/bin/python3 "
    "<runtime>/scripts/mcp_persistence.py --migrate-goals. "
    "Project install: <project>/.venv/bin/python3 "
    "<project>/.opencode/scripts/mcp_persistence.py --migrate-goals. "
    "The simplest reliable source of truth is command[0] in opencode.json "
    "for pantheon-persistence."
)
GOAL_TITLE_MAX_LENGTH = 512
GOAL_DESCRIPTION_MAX_LENGTH = 16_384
GOAL_SESSION_ID_MAX_LENGTH = 128
GOAL_ID_MAX_LENGTH = 64
GOAL_VERSION_MAX = 9_223_372_036_854_775_807
DELETE_CODEPOINT = 127
_DESCRIPTION_ALLOWED_CONTROLS = {"\t", "\n", "\r"}
GoalStatus = Literal["active", "done"]
_goal_write_lock = threading.RLock()


@dataclass(frozen=True, slots=True)
class GoalRecord:
    """A manual goal persisted in the Persistence deployment database."""

    goal_id: str
    session_id: str
    title: str
    description: str | None
    status: GoalStatus
    created_at: str
    updated_at: str
    version: int


class GoalStoreError(Exception):
    """Base error for the typed manual-goal repository API."""


class GoalSchemaNotInitializedError(GoalStoreError):
    """Raised when goal operations target a DB without the goal schema."""


class GoalSchemaVersionError(GoalStoreError):
    """Raised for an unsupported or inconsistent goal schema migration version."""


class GoalValidationError(GoalStoreError, ValueError):
    """Raised when a goal field or expected version is invalid."""


class ActiveGoalExistsError(GoalStoreError):
    """Raised when a session already has an active goal."""


class GoalNotFoundError(GoalStoreError, LookupError):
    """Raised when an update/done targets no goal owned by the session."""


class GoalVersionConflictError(GoalStoreError):
    """Raised when an optimistic update uses a stale version."""


class GoalStorageError(GoalStoreError):
    """Raised for SQLite errors or an invalid transaction state."""


class GoalBackupRetainedError(GoalStorageError):
    """Raised when an upgrade fails after its verified backup was retained."""

    def __init__(self, backup_path: Path, cause: Exception) -> None:
        self.backup_path = backup_path
        super().__init__(
            f"goal schema upgrade failed after backup verification: {cause}"
        )


class _GoalUnset:
    """Sentinel distinguishing an omitted field from clearing description."""


_GOAL_UNSET = _GoalUnset()


def _assert_project_goal_connection(
    conn: sqlite3.Connection,
    expected_path: str | Path | None,
    *,
    explicit_project_db: bool = False,
) -> None:
    """Reject connections outside this server's Persistence database."""
    if expected_path is None:
        raise GoalSchemaNotInitializedError(
            "goal operations require this server's Persistence database"
        )
    project_path = Path(expected_path).expanduser().resolve()
    if not explicit_project_db:
        server_path = _resolve_project_db_path()
        if project_path != server_path:
            raise GoalSchemaNotInitializedError(
                "migration target differs from the Persistence server database "
                f"({server_path}); stop the server and rerun with --project-db "
                "only when the explicitly selected database is intended"
            )
    try:
        with _goal_write_lock:
            databases = conn.execute("PRAGMA database_list").fetchall()
    except sqlite3.Error as exc:
        raise GoalStorageError("could not verify Persistence database") from exc
    main_path = next((row[2] for row in databases if row[1] == "main"), "")
    if not main_path or Path(main_path).resolve() != project_path:
        raise GoalSchemaNotInitializedError(
            "goal operations are restricted to this server's Persistence database"
        )
    try:
        has_kv_store = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store'"
        ).fetchone()
    except sqlite3.Error as exc:
        raise GoalStorageError("could not verify Persistence database schema") from exc
    if has_kv_store is None:
        raise GoalSchemaNotInitializedError(
            "goal operations require an existing Pantheon Persistence database; "
            "ask the user to start the server once first"
        )


def _project_goal_connection() -> sqlite3.Connection:
    conn = globals().get("_project_db")
    if conn is None:
        raise GoalSchemaNotInitializedError(
            "goal operations require this server's Persistence database"
        )
    _assert_project_goal_connection(
        conn,
        globals().get("_project_db_path"),
        explicit_project_db=globals().get("_project_db_explicit", False),
    )
    return conn


@contextmanager
def _goal_transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """Serialize same-process use and acquire SQLite's cross-process write lock."""
    with _goal_write_lock:
        if conn.in_transaction:
            raise GoalStorageError("goal connection already has an active transaction")
        try:
            conn.execute("BEGIN IMMEDIATE")
        except sqlite3.Error as exc:
            raise GoalStorageError("could not begin goal transaction") from exc
        try:
            yield
            conn.commit()
        except BaseException:
            with suppress(sqlite3.Error):
                conn.rollback()
            raise


def upgrade_goal_schema(
    conn: sqlite3.Connection,
    expected_path: str | Path | None = None,
    *,
    explicit_project_db: bool | None = None,
) -> None:
    """Apply goal schema upgrades to the explicitly supplied Persistence DB."""
    _assert_project_goal_connection(
        conn,
        expected_path or globals().get("_project_db_path"),
        explicit_project_db=(
            globals().get("_project_db_explicit", False)
            if explicit_project_db is None
            else explicit_project_db
        ),
    )
    try:
        with _goal_transaction(conn):
            current = _inspect_goal_schema_version(conn)
            if current == GOAL_SCHEMA_VERSION:
                return
            conn.execute(
                "CREATE TABLE IF NOT EXISTS pantheon_goal_schema_migrations ("
                "version INTEGER PRIMARY KEY CHECK (version > 0), "
                "applied_at TEXT NOT NULL)"
            )
            conn.execute(
                "CREATE TABLE pantheon_goals ("
                "goal_id TEXT PRIMARY KEY NOT NULL, "
                "session_id TEXT NOT NULL CHECK ("
                "length(trim(session_id)) BETWEEN 1 AND 128 AND "
                "session_id = trim(session_id)), "
                "title TEXT NOT NULL CHECK ("
                "length(title) BETWEEN 1 AND 512 AND length(trim(title)) > 0), "
                "description TEXT CHECK (description IS NULL OR "
                "length(description) <= 16384), "
                "status TEXT NOT NULL CHECK (status IN ('active', 'done')), "
                "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, "
                "version INTEGER NOT NULL CHECK (version > 0))"
            )
            conn.execute(
                "CREATE UNIQUE INDEX uq_pantheon_goals_active_session "
                "ON pantheon_goals(session_id) WHERE status = 'active'"
            )
            conn.execute(
                "CREATE INDEX idx_pantheon_goals_session_history "
                "ON pantheon_goals(session_id, created_at DESC, goal_id DESC)"
            )
            conn.execute(
                "INSERT INTO pantheon_goal_schema_migrations(version, applied_at) "
                "VALUES (?, ?)",
                (GOAL_SCHEMA_VERSION, _goal_timestamp()),
            )
    except sqlite3.Error as exc:
        raise GoalStorageError("could not upgrade Persistence goal schema") from exc


def downgrade_goal_schema(
    conn: sqlite3.Connection,
    target_version: int = 0,
    *,
    expected_path: str | Path | None = None,
    explicit_project_db: bool | None = None,
) -> None:
    """Drop an empty goal schema; refuse rollback when goal data would be lost.

    Populated goal schemas are intentionally irreversible through this helper:
    callers must preserve/export their data before using any external teardown.
    """
    _assert_project_goal_connection(
        conn,
        expected_path or globals().get("_project_db_path"),
        explicit_project_db=(
            globals().get("_project_db_explicit", False)
            if explicit_project_db is None
            else explicit_project_db
        ),
    )
    if (
        isinstance(target_version, bool)
        or not isinstance(target_version, int)
        or target_version != 0
    ):
        raise GoalSchemaVersionError(
            "only downgrade to goal schema version 0 is supported"
        )
    try:
        with _goal_transaction(conn):
            exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' "
                "AND name = 'pantheon_goal_schema_migrations'"
            ).fetchone()
            if exists is None:
                return
            row = conn.execute(
                "SELECT COALESCE(MAX(version), 0) FROM pantheon_goal_schema_migrations"
            ).fetchone()
            current = int(row[0])
            if current > GOAL_SCHEMA_VERSION:
                raise GoalSchemaVersionError(
                    f"cannot downgrade unsupported goal schema version {current}"
                )
            goals_exist = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' "
                "AND name = 'pantheon_goals'"
            ).fetchone()
            if (
                goals_exist is not None
                and conn.execute("SELECT 1 FROM pantheon_goals LIMIT 1").fetchone()
                is not None
            ):
                raise GoalSchemaVersionError(
                    "cannot downgrade goal schema while goal data exists; "
                    "preserve or export goals before removing the schema"
                )
            conn.execute("DROP INDEX IF EXISTS uq_pantheon_goals_active_session")
            conn.execute("DROP INDEX IF EXISTS idx_pantheon_goals_session_history")
            conn.execute("DROP TABLE IF EXISTS pantheon_goals")
            conn.execute("DROP TABLE pantheon_goal_schema_migrations")
    except sqlite3.Error as exc:
        raise GoalStorageError("could not downgrade goal schema") from exc


def _goal_timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


def _validate_goal_session_id(session_id: str) -> str:
    if not isinstance(session_id, str) or not session_id:
        raise GoalValidationError("session_id must be a non-empty string")
    if len(session_id) > GOAL_SESSION_ID_MAX_LENGTH:
        raise GoalValidationError(
            f"session_id exceeds the {GOAL_SESSION_ID_MAX_LENGTH}-character limit"
        )
    if session_id != session_id.strip() or any(
        ord(char) < MIN_PRINTABLE_CODEPOINT or char == chr(DELETE_CODEPOINT)
        for char in session_id
    ):
        raise GoalValidationError(
            "session_id contains whitespace or a control character"
        )
    return session_id


def _validate_goal_text(
    value: object, field: str, limit: int, *, allow_newlines: bool = False
) -> str:
    if not isinstance(value, str):
        raise GoalValidationError(f"{field} must be a string")
    if len(value) > limit:
        raise GoalValidationError(f"{field} exceeds the {limit}-character limit")
    if field == "title" and not value.strip():
        raise GoalValidationError("title must be a non-empty string")
    if any(
        (
            ord(char) < MIN_PRINTABLE_CODEPOINT
            and not (allow_newlines and char in _DESCRIPTION_ALLOWED_CONTROLS)
        )
        or char == chr(DELETE_CODEPOINT)
        for char in value
    ):
        raise GoalValidationError(f"{field} contains a control character")
    return value


def _validate_goal_version(version: int) -> int:
    if (
        isinstance(version, bool)
        or not isinstance(version, int)
        or version < 1
        or version > GOAL_VERSION_MAX
    ):
        raise GoalValidationError(
            f"expected_version must be an integer from 1 to {GOAL_VERSION_MAX}"
        )
    return version


def _validate_goal_id(goal_id: str) -> str:
    if (
        not isinstance(goal_id, str)
        or not goal_id
        or len(goal_id) > GOAL_ID_MAX_LENGTH
        or any(
            ord(char) < MIN_PRINTABLE_CODEPOINT or char == chr(DELETE_CODEPOINT)
            for char in goal_id
        )
    ):
        raise GoalValidationError(
            f"goal_id must be a valid string of at most {GOAL_ID_MAX_LENGTH} chars"
        )
    return goal_id


def _inspect_goal_schema_version(conn: sqlite3.Connection) -> int | None:
    """Read and validate the goal schema version without changing the DB."""
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' "
                "AND name IN ('pantheon_goals', 'pantheon_goal_schema_migrations')"
            )
        }
        has_goals = "pantheon_goals" in tables
        has_migrations = "pantheon_goal_schema_migrations" in tables
        if not has_migrations:
            if has_goals:
                raise GoalSchemaVersionError(
                    "pantheon_goals exists without goal schema migration history"
                )
            return None
        row = conn.execute(
            "SELECT MAX(version) FROM pantheon_goal_schema_migrations"
        ).fetchone()
        current = int(row[0] or 0)
        if current == 0:
            if has_goals:
                raise GoalSchemaVersionError(
                    "pantheon_goals exists without a recorded schema version"
                )
            return None
        if current > GOAL_SCHEMA_VERSION:
            raise GoalSchemaVersionError(
                f"goal schema version {current} is newer than supported "
                f"version {GOAL_SCHEMA_VERSION}"
            )
        if current < GOAL_SCHEMA_VERSION:
            raise GoalSchemaVersionError(
                f"goal schema version {current} is older than supported "
                f"version {GOAL_SCHEMA_VERSION}"
            )
        if not has_goals:
            raise GoalSchemaVersionError(
                "goal schema migration history exists but pantheon_goals is missing; "
                "this is a half-created schema. Ask the user to preserve the current "
                "database, restore a verified backup or recover the missing schema, "
                "then rerun the human-approved migration."
            )
        indexes = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index' "
                "AND tbl_name = 'pantheon_goals'"
            )
        }
        expected = {
            "uq_pantheon_goals_active_session",
            "idx_pantheon_goals_session_history",
        }
        if not expected.issubset(indexes):
            raise GoalSchemaVersionError(
                "goal schema migration history exists but required indexes are missing"
            )
        return current
    except sqlite3.Error as exc:
        raise GoalStorageError("could not inspect goal schema version") from exc


def _require_goal_schema(conn: sqlite3.Connection) -> None:
    current = _inspect_goal_schema_version(conn)
    if current is None:
        raise GoalSchemaNotInitializedError(
            "goal schema is not initialized. Ask the user to run "
            f"`{GOAL_SCHEMA_MIGRATION_COMMAND}`; goal schema migration is a "
            "human-approved operation. "
            f"{GOAL_SCHEMA_MIGRATION_COMMAND_GUIDANCE}"
        )


def _raw_goal_schema_version(conn: sqlite3.Connection) -> int:
    """Read the recorded version for backup verification, without validation."""
    try:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' "
            "AND name = 'pantheon_goal_schema_migrations'"
        ).fetchone()
    except sqlite3.Error as exc:
        raise GoalStorageError("could not inspect goal schema version") from exc
    if exists is None:
        return 0
    try:
        row = conn.execute(
            "SELECT MAX(version) FROM pantheon_goal_schema_migrations"
        ).fetchone()
    except sqlite3.Error as exc:
        raise GoalStorageError("could not read goal schema version") from exc
    return int(row[0] or 0)


def _resolve_project_db_path(project_db: str | Path | None = None) -> Path:
    """Resolve explicit CLI path, project override, then runtime target."""
    if project_db is not None:
        path = Path(project_db).expanduser()
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[1] / path
        return path.resolve()
    configured_project = os.environ.get("PANTHEON_PROJECT")
    if configured_project:
        project_root = Path(configured_project)
        if not project_root.is_absolute():
            raise GoalSchemaNotInitializedError(
                "PANTHEON_PROJECT must be an absolute path; set it to the "
                "absolute project root or unset it."
            )
        return (project_root / ".pantheon" / "persistence" / "project.db").resolve()
    project_root = Path(__file__).resolve().parents[1]
    return (project_root / ".pantheon" / "persistence" / "project.db").resolve()


def _goal_dry_run_file_metadata(
    db_path: Path,
) -> tuple[os.stat_result | None, os.stat_result | None, os.stat_result | None]:
    def optional_stat(path: Path) -> os.stat_result | None:
        try:
            return path.stat()
        except FileNotFoundError:
            return None

    return (
        optional_stat(db_path),
        optional_stat(db_path.with_name(db_path.name + "-wal")),
        optional_stat(db_path.with_name(db_path.name + "-shm")),
    )


def _print_goal_migration_dry_run(db_path: Path) -> int:
    db_path = db_path.resolve()

    # Snapshot all labels before opening SQLite: opening in plain read-only mode
    # can interact with existing WAL files, so its own effects must never alter
    # the sidecar or size report.
    try:
        db_stat, wal_stat, shm_stat = _goal_dry_run_file_metadata(db_path)
    except OSError as exc:
        print(f"Database: {db_path}")
        print("Exists: unknown")
        print("Size: unknown")
        print("Sidecars: unknown")
        print("Goal tables exist: unknown")
        print(
            f"Dry-run state is unknown ({exc}); stop and investigate before "
            "any migration.",
            file=sys.stderr,
        )
        return 2

    exists = db_stat is not None
    has_wal = wal_stat is not None
    has_shm = shm_stat is not None
    size = (db_stat.st_size if db_stat is not None else 0) + (
        wal_stat.st_size if wal_stat is not None else 0
    )
    size_description = " bytes (database + WAL)" if has_wal else " bytes"
    print(f"Database: {db_path}")
    print(f"Exists: {'yes' if exists else 'no'}")
    print(f"Size: {size}{size_description}")
    sidecar_description = (
        f"WAL={'yes' if has_wal else 'no'}, SHM={'yes' if has_shm else 'no'}"
    )
    print(f"Sidecars: {sidecar_description}")

    goal_tables = {"pantheon_goal_schema_migrations", "pantheon_goals"}
    table_result = "no"
    if exists:
        connection: sqlite3.Connection | None = None
        try:
            uri = f"{db_path.as_uri()}?mode=ro"
            if not has_wal and not has_shm:
                uri += "&immutable=1"
            connection = sqlite3.connect(uri, uri=True)
            present = goal_tables & {
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            table_result = "yes" if present else "no"
            if present:
                table_result += f" ({', '.join(sorted(present))})"
        except sqlite3.Error as exc:
            table_result = "unknown"
            print(
                f"Dry-run state is unknown ({exc}); stop and investigate before "
                "any migration.",
                file=sys.stderr,
            )
        finally:
            if connection is not None:
                connection.close()
    print(f"Goal tables exist: {table_result}")
    print(
        "Warning: stop the Persistence server for an authoritative check and "
        "keep it stopped for the whole migration."
    )
    return 2 if table_result == "unknown" else 0


def _warn_if_symlinked_launcher() -> None:
    lexical_path = Path(__file__).absolute()
    resolved_path = Path(__file__).resolve()
    if lexical_path != resolved_path:
        print(
            "Warning: this is a symlinked launcher; re-run from the installed script "
            f"at {resolved_path}.",
            file=sys.stderr,
        )


def _print_goal_migration_failure(
    error: GoalStoreError | OSError | sqlite3.Error,
) -> None:
    print(f"Goal schema migration failed: {error}", file=sys.stderr)
    if isinstance(error, GoalBackupRetainedError):
        print(
            f"Verified backup retained at: {error.backup_path}",
            file=sys.stderr,
        )


def _reserve_goal_backup_path(db_path: Path) -> Path:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
    backup_path = db_path.with_name(f"{db_path.name}.goal-backup-{timestamp}.sqlite3")
    try:
        descriptor = os.open(
            backup_path,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            0o600,
        )
    except OSError as exc:
        raise GoalStorageError(
            f"could not reserve unique goal schema backup {backup_path}"
        ) from exc
    os.close(descriptor)
    return backup_path


def _sqlite_object_names(conn: sqlite3.Connection) -> set[str]:
    return {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master")}


def _sqlite_table_row_counts(conn: sqlite3.Connection) -> dict[str, int]:
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).fetchall()
    row_counts: dict[str, int] = {}
    for (table_name,) in tables:
        quoted_name = '"' + str(table_name).replace('"', '""') + '"'
        row = conn.execute(f"SELECT COUNT(*) FROM {quoted_name}").fetchone()
        row_counts[str(table_name)] = int(row[0])
    return row_counts


def _verify_goal_backup(
    source: sqlite3.Connection, backup_path: Path, expected_version: int
) -> None:
    uri = f"{backup_path.as_uri()}?mode=ro&immutable=1"
    backup: sqlite3.Connection | None = None
    try:
        backup = sqlite3.connect(uri, uri=True)
        check = backup.execute("PRAGMA quick_check").fetchone()
        if check is None or check[0] != "ok":
            raise GoalStorageError("goal schema backup failed SQLite integrity check")
        source_page_count = int(source.execute("PRAGMA page_count").fetchone()[0])
        backup_page_count = int(backup.execute("PRAGMA page_count").fetchone()[0])
        if source_page_count < 1 or backup_page_count != source_page_count:
            raise GoalStorageError(
                "goal schema backup page-count verification failed: "
                f"expected {source_page_count}, found {backup_page_count}"
            )
        source_objects = _sqlite_object_names(source)
        backup_objects = _sqlite_object_names(backup)
        if source_objects != backup_objects:
            raise GoalStorageError(
                "goal schema backup SQLite object-name verification failed"
            )
        if "kv_store" not in source_objects or "kv_store" not in backup_objects:
            raise GoalSchemaNotInitializedError(
                "target is not a Pantheon Persistence database: kv_store is missing; "
                "ask the user to start the server once first"
            )
        if _sqlite_table_row_counts(source) != _sqlite_table_row_counts(backup):
            raise GoalStorageError(
                "goal schema backup row-count verification failed for kv_store "
                "or another sentinel table"
            )
        actual_version = _raw_goal_schema_version(backup)
        if actual_version != expected_version:
            raise GoalStorageError(
                "goal schema backup version verification failed: "
                f"expected {expected_version}, found {actual_version}"
            )
    except sqlite3.Error as exc:
        raise GoalStorageError("could not verify goal schema backup") from exc
    finally:
        if backup is not None:
            backup.close()


def _copy_goal_backup(source: sqlite3.Connection, backup_path: Path) -> None:
    """Write and durably flush the full SQLite backup before verification."""
    destination = sqlite3.connect(str(backup_path))
    try:
        source.backup(destination)
    finally:
        destination.close()
    os.chmod(backup_path, 0o600)
    with backup_path.open("rb") as backup_file:
        os.fsync(backup_file.fileno())
    directory_fd = os.open(
        backup_path.parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _remove_goal_backup_sidecars(backup_path: Path) -> None:
    for suffix in ("-wal", "-shm", "-journal"):
        with suppress(OSError):
            backup_path.with_name(backup_path.name + suffix).unlink(missing_ok=True)


def _cleanup_goal_backup(backup_path: Path) -> None:
    _remove_goal_backup_sidecars(backup_path)
    with suppress(OSError):
        backup_path.unlink(missing_ok=True)


def migrate_goal_schema_with_backup(
    project_db_path: str | Path,
    *,
    explicit_project_db: bool = True,
) -> tuple[Path, Path | None, int, bool]:
    """Back up an existing Persistence DB, then migrate its goal schema."""
    db_path = Path(project_db_path).expanduser().resolve()
    if not db_path.is_file():
        raise GoalSchemaNotInitializedError(
            f"Persistence database does not exist at {db_path}; "
            "ask the user to start the server once first"
        )
    try:
        source = sqlite3.connect(f"{db_path.as_uri()}?mode=rw", uri=True, timeout=5)
    except sqlite3.Error as exc:
        raise GoalStorageError("could not open Persistence database") from exc

    backup_path: Path | None = None
    try:
        has_kv_store = source.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store'"
        ).fetchone()
        if has_kv_store is None:
            raise GoalSchemaNotInitializedError(
                "target is not a Pantheon Persistence database: kv_store is missing; "
                "ask the user to start the server once first"
            )
        _assert_project_goal_connection(
            source,
            db_path,
            explicit_project_db=explicit_project_db,
        )
        current = _inspect_goal_schema_version(source)
        original_version = _raw_goal_schema_version(source)
        if current == GOAL_SCHEMA_VERSION:
            return db_path, None, original_version, True

        backup_path = _reserve_goal_backup_path(db_path)
        try:
            _copy_goal_backup(source, backup_path)
            _remove_goal_backup_sidecars(backup_path)
            _verify_goal_backup(source, backup_path, original_version)
        except (GoalStoreError, OSError, sqlite3.Error):
            _cleanup_goal_backup(backup_path)
            raise

        try:
            upgrade_goal_schema(
                source,
                db_path,
                explicit_project_db=explicit_project_db,
            )
            version = _raw_goal_schema_version(source)
        except Exception as exc:
            raise GoalBackupRetainedError(backup_path, exc) from exc
        return db_path, backup_path, version, False
    finally:
        source.close()


_GOAL_COLUMNS = (
    "goal_id, session_id, title, description, status, created_at, updated_at, version"
)


def _goal_from_row(row: sqlite3.Row | tuple[object, ...]) -> GoalRecord:
    return GoalRecord(
        goal_id=str(row[0]),
        session_id=str(row[1]),
        title=str(row[2]),
        description=row[3] if isinstance(row[3], str) else None,
        status=row[4],  # type: ignore[arg-type]
        created_at=str(row[5]),
        updated_at=str(row[6]),
        version=int(row[7]),
    )


def _goal_by_id(
    conn: sqlite3.Connection, session_id: str, goal_id: str
) -> GoalRecord | None:
    row = conn.execute(
        f"SELECT {_GOAL_COLUMNS} FROM pantheon_goals "
        "WHERE session_id = ? AND goal_id = ?",
        (session_id, goal_id),
    ).fetchone()
    return _goal_from_row(row) if row is not None else None


def _goal_database_error(exc: sqlite3.Error) -> GoalStoreError:
    if "no such table: pantheon_goals" in str(exc):
        return GoalSchemaNotInitializedError(
            "goal schema is not initialized. Ask the user to run "
            f"`{GOAL_SCHEMA_MIGRATION_COMMAND}`; goal schema migration is a "
            "human-approved operation. "
            f"{GOAL_SCHEMA_MIGRATION_COMMAND_GUIDANCE}"
        )
    return GoalStorageError("goal database operation failed")


def create_goal(
    *,
    session_id: str,
    title: str,
    description: str | None = None,
) -> GoalRecord:
    """Create one active goal; session identity must come from trusted host context.

    The session ID is a correlation/scope key, not authentication. Callers must
    supply it internally from OpenCode ``Context`` metadata; never accept it as
    a model-controlled tool argument.
    """
    conn = _project_goal_connection()
    session_id = _validate_goal_session_id(session_id)
    title = _validate_goal_text(title, "title", GOAL_TITLE_MAX_LENGTH)
    if description is not None:
        description = _validate_goal_text(
            description,
            "description",
            GOAL_DESCRIPTION_MAX_LENGTH,
            allow_newlines=True,
        )
    try:
        with _goal_transaction(conn):
            _require_goal_schema(conn)
            existing = conn.execute(
                f"SELECT {_GOAL_COLUMNS} FROM pantheon_goals "
                "WHERE session_id = ? AND status = 'active'",
                (session_id,),
            ).fetchone()
            if existing is not None:
                raise ActiveGoalExistsError(
                    "active goal already exists for this session"
                )
            now = _goal_timestamp()
            goal_id = uuid4().hex
            conn.execute(
                "INSERT INTO pantheon_goals(" + _GOAL_COLUMNS + ") "
                "VALUES (?, ?, ?, ?, 'active', ?, ?, 1)",
                (goal_id, session_id, title, description, now, now),
            )
            created = _goal_by_id(conn, session_id, goal_id)
            assert created is not None
            return created
    except sqlite3.IntegrityError as exc:
        try:
            with _goal_write_lock:
                _require_goal_schema(conn)
                existing = conn.execute(
                    "SELECT 1 FROM pantheon_goals "
                    "WHERE session_id = ? AND status = 'active'",
                    (session_id,),
                ).fetchone()
            if existing is not None:
                raise ActiveGoalExistsError(
                    "active goal already exists for this session"
                ) from exc
        except GoalStoreError:
            raise
        except sqlite3.Error as inspect_exc:
            raise _goal_database_error(inspect_exc) from exc
        raise GoalStorageError("goal insert violated a database constraint") from exc
    except sqlite3.Error as exc:
        raise _goal_database_error(exc) from exc


def get_goal(*, session_id: str, goal_id: str | None = None) -> GoalRecord | None:
    """Get a specific goal, or its active/latest history entry.

    SQLite rowid provides an insertion-order tie-break when creation timestamps
    are equal.
    """
    conn = _project_goal_connection()
    session_id = _validate_goal_session_id(session_id)
    if goal_id is not None:
        goal_id = _validate_goal_id(goal_id)
    try:
        with _goal_write_lock:
            _require_goal_schema(conn)
            if goal_id is not None:
                return _goal_by_id(conn, session_id, goal_id)
            row = conn.execute(
                f"SELECT {_GOAL_COLUMNS} FROM pantheon_goals "
                "WHERE session_id = ? AND status = 'active' LIMIT 1",
                (session_id,),
            ).fetchone()
            if row is None:
                row = conn.execute(
                    f"SELECT {_GOAL_COLUMNS} FROM pantheon_goals "
                    "WHERE session_id = ? ORDER BY created_at DESC, rowid DESC "
                    "LIMIT 1",
                    (session_id,),
                ).fetchone()
            return _goal_from_row(row) if row is not None else None
    except sqlite3.Error as exc:
        raise _goal_database_error(exc) from exc


def update_goal(
    *,
    session_id: str,
    goal_id: str,
    expected_version: int,
    title: str | None | _GoalUnset = _GOAL_UNSET,
    description: str | None | _GoalUnset = _GOAL_UNSET,
) -> GoalRecord:
    """CAS-update user fields only; status and version remain server-owned."""
    conn = _project_goal_connection()
    session_id = _validate_goal_session_id(session_id)
    goal_id = _validate_goal_id(goal_id)
    expected_version = _validate_goal_version(expected_version)
    if title is _GOAL_UNSET and description is _GOAL_UNSET:
        raise GoalValidationError("update must include title and/or description")
    if title is not _GOAL_UNSET:
        title = _validate_goal_text(title, "title", GOAL_TITLE_MAX_LENGTH)
    if description is not _GOAL_UNSET and description is not None:
        description = _validate_goal_text(
            description,
            "description",
            GOAL_DESCRIPTION_MAX_LENGTH,
            allow_newlines=True,
        )
    try:
        with _goal_transaction(conn):
            _require_goal_schema(conn)
            current = _goal_by_id(conn, session_id, goal_id)
            if current is None:
                raise GoalNotFoundError("goal not found for this session")
            if current.version != expected_version:
                raise GoalVersionConflictError(
                    f"goal version conflict: expected {expected_version}, "
                    f"current version is {current.version}"
                )
            new_title = current.title if title is _GOAL_UNSET else title
            new_description = (
                current.description if description is _GOAL_UNSET else description
            )
            conn.execute(
                "UPDATE pantheon_goals SET title = ?, description = ?, "
                "updated_at = ?, version = version + 1 "
                "WHERE goal_id = ? AND session_id = ? AND version = ?",
                (
                    new_title,
                    new_description,
                    _goal_timestamp(),
                    goal_id,
                    session_id,
                    expected_version,
                ),
            )
            updated = _goal_by_id(conn, session_id, goal_id)
            assert updated is not None
            if updated.version != expected_version + 1:
                raise GoalVersionConflictError(
                    f"goal version conflict: expected {expected_version}, "
                    f"current version is {updated.version}"
                )
            return updated
    except sqlite3.Error as exc:
        raise _goal_database_error(exc) from exc


def complete_goal(
    *,
    session_id: str,
    goal_id: str,
    expected_version: int,
) -> GoalRecord:
    """Mark a session-owned active goal done using CAS; repeated done is idempotent."""
    conn = _project_goal_connection()
    session_id = _validate_goal_session_id(session_id)
    goal_id = _validate_goal_id(goal_id)
    expected_version = _validate_goal_version(expected_version)
    try:
        with _goal_transaction(conn):
            _require_goal_schema(conn)
            current = _goal_by_id(conn, session_id, goal_id)
            if current is None:
                raise GoalNotFoundError("goal not found for this session")
            if current.status == "done":
                return current
            if current.version != expected_version:
                raise GoalVersionConflictError(
                    f"goal version conflict: expected {expected_version}, "
                    f"current version is {current.version}"
                )
            conn.execute(
                "UPDATE pantheon_goals SET status = 'done', updated_at = ?, "
                "version = version + 1 WHERE goal_id = ? AND session_id = ? "
                "AND status = 'active' AND version = ?",
                (_goal_timestamp(), goal_id, session_id, expected_version),
            )
            completed = _goal_by_id(conn, session_id, goal_id)
            assert completed is not None
            if completed.status != "done" or completed.version != expected_version + 1:
                raise GoalVersionConflictError(
                    f"goal version conflict: expected {expected_version}, "
                    f"current version is {completed.version}"
                )
            return completed
    except sqlite3.Error as exc:
        raise _goal_database_error(exc) from exc


# ── Resolve scope and init databases ────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--global-db", default=None)
parser.add_argument("--project-db", default=None)
parser.add_argument(
    "--migrate-goals",
    action="store_true",
    help="back up and explicitly migrate the Persistence goal schema, then exit",
)
parser.add_argument(
    "--dry-run",
    action="store_true",
    help="with --migrate-goals, report the resolved DB without changing it",
)
args = parser.parse_args()

if args.dry_run and not args.migrate_goals:
    parser.error("--dry-run requires --migrate-goals")

_project_db_path: Path | None = None
_project_db_explicit = args.project_db is not None
if args.migrate_goals:
    _warn_if_symlinked_launcher()
    try:
        migration_db_path = _resolve_project_db_path(args.project_db)
        if args.dry_run:
            raise SystemExit(_print_goal_migration_dry_run(migration_db_path))
        db_path, backup_path, version, already_current = (
            migrate_goal_schema_with_backup(
                migration_db_path,
                explicit_project_db=args.project_db is not None,
            )
        )
    except (GoalStoreError, OSError, sqlite3.Error) as exc:
        _print_goal_migration_failure(exc)
        raise SystemExit(1) from exc
    print(f"Database: {db_path}")
    if backup_path is not None:
        print(f"Backup: {backup_path}")
    print(f"Goal schema version: {version}")
    if already_current:
        print("Goal schema already current; no schema changes applied.")
    else:
        print("Goal schema migration applied.")
    raise SystemExit(0)

_global_root = (
    Path(args.global_db) if args.global_db else pantheon_home() / "persistence"
)
_global_db = _init_db(_global_root / "global.db")

_project_db_path = _resolve_project_db_path(args.project_db)
_project_db_instance = _init_db(_project_db_path)
_project_db = _project_db_instance


# ── Tools ───────────────────────────────────────────────────────────────────────

_OPENCODE_SESSION_META_KEY = "ai.opencode/sessionID"
_OPENCODE_SESSION_ID_PATTERN = re.compile(r"ses_[A-Za-z0-9_-]{1,124}\Z")


def _session_id_from_context(context: Context) -> str:
    """Read and validate the OpenCode session ID from FastMCP request metadata.

    This value is a correlation/scope key, not authentication. The supported
    boundary is OpenCode-mediated local stdio; clients able to bypass the host
    can forge metadata and are outside this check's security guarantee.
    """
    request_context = context.request_context
    if request_context is None:
        raise ToolError("Goal operations require OpenCode session metadata.")
    metadata = request_context.meta
    if not isinstance(metadata, Mapping):
        raise ToolError("Goal operations require OpenCode session metadata.")
    session_id = metadata.get(_OPENCODE_SESSION_META_KEY)
    if (
        not isinstance(session_id, str)
        or _OPENCODE_SESSION_ID_PATTERN.fullmatch(session_id) is None
    ):
        raise ToolError("Goal operations require a valid OpenCode session ID.")
    return session_id


def _public_goal(record: GoalRecord | None) -> dict[str, object] | None:
    """Expose only public goal fields; omit session scope and storage details."""
    if record is None:
        return None
    return {
        "goal_id": record.goal_id,
        "title": record.title,
        "description": record.description,
        "status": record.status,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "version": record.version,
    }


def _goal_tool_error(error: GoalStoreError) -> ToolError:
    """Translate repository errors to safe, actionable MCP tool errors."""
    if isinstance(error, ActiveGoalExistsError):
        message = "This session already has an active goal. Use goal_get or update it."
    elif isinstance(error, GoalNotFoundError):
        message = "No goal with that ID exists in this session."
    elif isinstance(error, GoalVersionConflictError):
        message = (
            "The goal changed since the supplied version. Call goal_get and retry "
            "with its current version."
        )
    elif isinstance(error, GoalValidationError):
        message = f"Invalid goal request: {error}"
    elif isinstance(error, GoalSchemaNotInitializedError | GoalSchemaVersionError):
        message = str(error)
    else:
        message = "Goal storage is unavailable; no database details were exposed."
    return ToolError(message)


@mcp.tool(
    name="goal_create",
    description=(
        "Create one active manual goal for the current OpenCode session in this "
        "Persistence deployment database. Session identity comes from "
        "host request metadata, not tool arguments. Completed goals remain in "
        "history and allow a new goal. This does not trigger continuation."
    ),
)
async def goal_create(
    title: Annotated[str, Field(min_length=1, max_length=GOAL_TITLE_MAX_LENGTH)],
    context: Context,
    description: Annotated[
        str | None, Field(max_length=GOAL_DESCRIPTION_MAX_LENGTH)
    ] = None,
) -> dict[str, object]:
    """Create the current session's single active manual goal."""
    try:
        record = create_goal(
            session_id=_session_id_from_context(context),
            title=title,
            description=description,
        )
    except GoalStoreError as exc:
        raise _goal_tool_error(exc) from None
    return {"goal": _public_goal(record)}


@mcp.tool(
    name="goal_get",
    description=(
        "Read a goal owned by the current OpenCode session. Omit goal_id to "
        "get its active goal, or its latest completed goal when none is active. "
        "The returned version is required for goal_update and goal_done."
    ),
)
async def goal_get(
    context: Context,
    goal_id: Annotated[str | None, Field(max_length=GOAL_ID_MAX_LENGTH)] = None,
) -> dict[str, object | None]:
    """Read the current session's active goal or retained history entry."""
    try:
        record = get_goal(session_id=_session_id_from_context(context), goal_id=goal_id)
    except GoalStoreError as exc:
        raise _goal_tool_error(exc) from None
    return {"goal": _public_goal(record)}


@mcp.tool(
    name="goal_update",
    description=(
        "Edit title and/or description of a goal owned by the current session. "
        "Supply the version returned by goal_get; stale writes conflict. Status "
        "and timestamps are server-owned, and a completed goal cannot be reopened. "
        "Set clear_description=true to remove its optional description."
    ),
)
async def goal_update(
    context: Context,
    goal_id: Annotated[str, Field(min_length=1, max_length=GOAL_ID_MAX_LENGTH)],
    expected_version: Annotated[int, Field(strict=True, ge=1, le=GOAL_VERSION_MAX)],
    title: Annotated[
        str | None, Field(min_length=1, max_length=GOAL_TITLE_MAX_LENGTH)
    ] = None,
    description: Annotated[
        str | None, Field(max_length=GOAL_DESCRIPTION_MAX_LENGTH)
    ] = None,
    clear_description: bool = False,
) -> dict[str, object]:
    """Update only user-editable fields using the returned optimistic version."""
    if clear_description and description is not None:
        raise ToolError("Provide description or clear_description, not both.")
    changes: dict[str, object] = {}
    if title is not None:
        changes["title"] = title
    if description is not None:
        changes["description"] = description
    elif clear_description:
        changes["description"] = None
    if not changes:
        raise ToolError("Provide a title, description, or clear_description change.")
    try:
        record = update_goal(
            session_id=_session_id_from_context(context),
            goal_id=goal_id,
            expected_version=expected_version,
            **changes,
        )
    except GoalStoreError as exc:
        raise _goal_tool_error(exc) from None
    return {"goal": _public_goal(record)}


@mcp.tool(
    name="goal_done",
    description=(
        "Mark a goal owned by the current session completed using its current "
        "version. Repeating done is idempotent. Completed history is retained, "
        "and a new active goal may then be created. This does not trigger continuation."
    ),
)
async def goal_done(
    context: Context,
    goal_id: Annotated[str, Field(min_length=1, max_length=GOAL_ID_MAX_LENGTH)],
    expected_version: Annotated[int, Field(strict=True, ge=1, le=GOAL_VERSION_MAX)],
) -> dict[str, object]:
    """Complete a current-session goal without changing its user fields."""
    try:
        record = complete_goal(
            session_id=_session_id_from_context(context),
            goal_id=goal_id,
            expected_version=expected_version,
        )
    except GoalStoreError as exc:
        raise _goal_tool_error(exc) from None
    return {"goal": _public_goal(record)}


# ── Context Checkpoint Tools ────────────────────────────────────────────────────
# Operational-state checkpoints for session goals, phases, and heartbeats.

DEFAULT_CONTEXT_TTL: int = 14400  # 4 hours
CONTEXT_HEARTBEAT_TTL: int = 300
MIN_TTL: int = 1
MAX_TTL: int = 31_536_000  # 365 days
CONTEXT_TTL_BY_KEY: dict[str, int] = {
    "heartbeat": CONTEXT_HEARTBEAT_TTL,
    "latest": DEFAULT_CONTEXT_TTL,
    "tail": DEFAULT_CONTEXT_TTL,
}
MAX_CONTEXT_SLUG_LENGTH: int = 128
MAX_CONTEXT_KEY_LENGTH: int = 128
MAX_CONTEXT_SESSION_ID_LENGTH: int = 128
MAX_CONTEXT_CONTENT_BYTES: int = 64 * 1024
MAX_GOAL_ID_LENGTH: int = 128
MAX_GOAL_OBJECTIVE_LENGTH: int = 4096
MAX_GOAL_STATUS_LENGTH: int = 64
MAX_PHASE_NAME_LENGTH: int = 256
MAX_DELEGATIONS: int = 100
MAX_DELEGATION_FIELD_LENGTH: int = 256
MAX_TAIL_ITEMS: int = 100
MAX_TAIL_LINE_LENGTH: int = 4096
MAX_REVISION: int = 9_223_372_036_854_775_807
MIN_PRINTABLE_CODEPOINT: int = 32
_context_write_lock = threading.RLock()

# ── Validation Reporting ────────────────────────────────────────────────────────
# One call must surface EVERY invalid argument, not just the first. Reporting a
# single field per round-trip costs the caller one failed tool call per field,
# which is exactly the failure mode this module previously had: ``goal`` and
# ``phase`` were discovered in two consecutive attempts.
#
# Every violation therefore keeps the historical wording, so anything matching
# on it still matches (``goal must be an object``,
# ``ttl must be between 1 and 31536000 seconds``, ``session_id``), and gains the
# argument path plus the received type. Shape: one line per violation, then at
# most one example block.
#
#   context_save: 2 invalid arguments
#   context_save: content.goal must be an object (got string)
#   context_save: content.phase must be an object (got number)
#   example: content.goal={"objective":"...","status":"active"}
#            content.phase={"current":1,"total":3,"name":"..."}
#
# Absent and wrong-typed are distinct outcomes with distinct wording: a
# ``required`` violation never reads like a ``must be an object`` violation.
# ``goal``/``phase`` are OPTIONAL sections — heartbeat and tail checkpoints
# legitimately omit them (see src/instructions/zeus-anti-stall.instructions.md),
# so an absent section is accepted and never reported.

_SCOPE_NAMES: tuple[str, ...] = ("global", "project")

# Minimal correct example per checkpoint section, surfaced only when that
# section is actually the thing that was rejected.
CHECKPOINT_EXAMPLES: dict[str, str] = {
    "goal": 'content.goal={"objective":"...","status":"active"}',
    "phase": 'content.phase={"current":1,"total":3,"name":"..."}',
    "delegations": (
        'content.delegations={"in_flight":[{"alias":"@hermes","agent":"hermes"}]}'
    ),
    "heartbeat": 'content.heartbeat={"status":"alive","turn_count":1}',
    "tail": 'content.tail=["phase:1 done"]',
}

TTL_EXAMPLE: str = "ttl=3600"
REVISION_EXAMPLE: str = "revision=1"
SCOPE_EXAMPLE: str = 'scope="project"'
SESSION_ID_EXAMPLE: str = 'session_id="ses_abc123"'


def _json_type_name(value: object) -> str:
    """Name a value's JSON type for error messages (ints read as ``number``)."""
    if value is None:
        type_name = "null"
    elif isinstance(value, bool):
        type_name = "boolean"
    elif isinstance(value, str):
        type_name = "string"
    elif isinstance(value, int | float):
        type_name = "number"
    elif isinstance(value, list):
        type_name = "array"
    elif isinstance(value, dict):
        type_name = "object"
    else:
        type_name = type(value).__name__
    return type_name


class _ArgErrors:
    """Accumulate argument violations so a single call reports all of them."""

    def __init__(self, tool: str) -> None:
        self._tool = tool
        self._violations: list[str] = []
        self._examples: list[str] = []

    def __bool__(self) -> bool:
        return bool(self._violations)

    def add(self, path: str, message: str, got: str | None = None) -> None:
        """Record one violation, optionally suffixing the received type/value."""
        suffix = f" (got {got})" if got is not None else ""
        self._violations.append(f"{path} {message}{suffix}")

    def report(self, message: str, got: str | None = None) -> None:
        """Record a validator message that already names its own argument.

        ``_validate_ttl`` raises ``ttl must be between 1 and 31536000 seconds``,
        so the field name is part of the message and must not be prepended
        again.
        """
        suffix = f" (got {got})" if got is not None else ""
        self._violations.append(f"{message}{suffix}")

    def reroot(self, prefix: str, message: str) -> None:
        """Re-root a self-qualified message under a container path.

        ``goal.objective exceeds its size limit`` becomes
        ``content.goal.objective exceeds its size limit``.
        """
        field, _, rest = message.partition(" ")
        self._violations.append(f"{prefix}.{field} {rest}".rstrip())

    def shape(
        self, path: str, expected: str, value: object, example: str | None = None
    ) -> None:
        """Record a type violation: ``<path> must be <expected> (got <type>)``."""
        self.add(path, f"must be {expected}", _json_type_name(value))
        self.example(example)

    def example(self, example: str | None) -> None:
        """Attach a minimal correct example for the field just recorded."""
        if example:
            self._examples.append(example)

    def message(self) -> str:
        """Render one line per violation plus at most one example block."""
        lines = [f"{self._tool}: {violation}" for violation in self._violations]
        examples = list(dict.fromkeys(self._examples))
        if examples:
            lines.append("example: " + "  ".join(examples))
        if len(self._violations) == 1:
            return "\n".join(lines)
        return f"{self._tool}: {len(self._violations)} invalid arguments\n" + "\n".join(
            lines
        )

    def raise_if_any(self) -> None:
        """Raise once, with every collected violation, if anything was invalid."""
        if self._violations:
            raise ValueError(self.message())


def _normalize_session_id(session_id: str | None) -> str | None:
    """Return a non-empty session ID, or ``None`` for an absent ID."""
    if session_id is None:
        return None
    normalized = session_id.strip()
    return normalized or None


def _validate_identifier(value: str, name: str, limit: int) -> str:
    """Validate a namespace component without rewriting caller data."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    if len(value) > limit:
        raise ValueError(f"{name} exceeds the {limit}-character limit")
    if any(ord(char) < MIN_PRINTABLE_CODEPOINT for char in value):
        raise ValueError(f"{name} contains a control character")
    return value


def _context_namespace(
    slug: str,
    session_id: str | None,
    *,
    legacy: bool = False,
) -> str | None:
    """Build a context namespace with explicit legacy opt-in only."""
    try:
        valid_slug = _validate_identifier(slug, "slug", MAX_CONTEXT_SLUG_LENGTH)
    except ValueError:
        return None
    if session_id is None:
        if legacy:
            return f"checkpoint:{valid_slug}"
        return None
    normalized = _normalize_session_id(session_id)
    if normalized is None:
        return None
    try:
        valid_session = _validate_identifier(
            normalized, "session_id", MAX_CONTEXT_SESSION_ID_LENGTH
        )
    except ValueError:
        return None
    return f"checkpoint:{valid_slug}:{valid_session}"


def _validate_ttl(ttl: object) -> int | None:
    """Validate an optional TTL before it reaches ``datetime.timedelta``."""
    if ttl is None:
        return None
    if isinstance(ttl, bool) or not isinstance(ttl, int):
        raise ValueError("ttl must be an integer or null")
    if ttl < MIN_TTL or ttl > MAX_TTL:
        raise ValueError(f"ttl must be between {MIN_TTL} and {MAX_TTL} seconds")
    return ttl


def _context_ttl(key: str, ttl: int | None) -> int:
    """Return a validated TTL or the explicit policy for a checkpoint key."""
    validated_ttl = _validate_ttl(ttl)
    return (
        validated_ttl
        if validated_ttl is not None
        else CONTEXT_TTL_BY_KEY.get(key, DEFAULT_CONTEXT_TTL)
    )


def _validate_revision(revision: int | None) -> int | None:
    """Validate an optional caller revision used for stale-write rejection."""
    if revision is None:
        return None
    if isinstance(revision, bool) or not isinstance(revision, int):
        raise ValueError("revision must be an integer")
    if revision < 1 or revision > MAX_REVISION:
        raise ValueError(f"revision must be between 1 and {MAX_REVISION}")
    return revision


def _should_update_latest(key: str) -> bool:
    """Keep operational metadata from clobbering the recovery checkpoint."""
    return key not in {"heartbeat", "tail"}


def _validate_tail(tail: object) -> list[str]:
    """Validate bounded serialized tail lines."""
    if not isinstance(tail, list):
        raise ValueError("tail must be an array")
    if len(tail) > MAX_TAIL_ITEMS:
        raise ValueError(
            f"tail has {len(tail)} items; maximum is {MAX_TAIL_ITEMS}; "
            "remove tail entries or omit tail"
        )
    for line in tail:
        if not isinstance(line, str):
            raise ValueError("tail entries must be strings")
        line_bytes = len(line.encode())
        if line_bytes > MAX_TAIL_LINE_LENGTH:
            raise ValueError(
                f"tail entries are {line_bytes:,} UTF-8 bytes; maximum is "
                f"{MAX_TAIL_LINE_LENGTH:,}; remove or shorten tail entries, "
                "or omit tail"
            )
    tail_bytes = sum(len(line.encode()) for line in tail)
    if tail_bytes > MAX_CONTEXT_CONTENT_BYTES:
        raise ValueError(
            f"tail contains {tail_bytes:,} UTF-8 bytes across strings; maximum "
            f"is {MAX_CONTEXT_CONTENT_BYTES:,} bytes; remove tail entries or "
            "omit tail"
        )
    return tail


def _validate_version_metadata(version: object) -> None:
    """Validate optional checkpoint ``version`` metadata leniently.

    ``version`` is opaque application metadata, not a persistence requirement.
    It may be a positive integer, a JSON float
    such as ``1.0``, or a version label like ``"1.5.0-beta.2"``. Absent/null
    versions and any non-empty string remain valid, preserving existing integer
    checkpoints while allowing forward-compatible labels. Only bools, empty
    strings, non-finite/zero/negative numbers, and structured values are
    rejected.
    """
    if version is None:
        return
    if isinstance(version, bool):
        raise ValueError("version must be a positive integer or version label")
    if isinstance(version, int | float):
        if not 1 <= version < float("inf"):
            raise ValueError("version must be a positive integer or version label")
        return
    if not isinstance(version, str) or not version.strip():
        raise ValueError("version must be a positive integer or version label")


def _validate_checkpoint_text_fields(
    section: Mapping[str, object],
    section_name: str,
    limits: tuple[tuple[str, int], ...],
) -> None:
    for field, limit in limits:
        value = section.get(field)
        if value is not None and (
            not isinstance(value, str) or len(value.encode()) > limit
        ):
            raise ValueError(f"{section_name}.{field} exceeds its size limit")


def _validate_checkpoint_integer_fields(
    section: Mapping[str, object], section_name: str, fields: tuple[str, ...]
) -> None:
    for field in fields:
        value = section.get(field)
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int) or value < 0
        ):
            raise ValueError(f"{section_name}.{field} must be a non-negative integer")


def _validate_checkpoint_delegations(section: dict) -> None:
    in_flight = section.get("in_flight")
    if in_flight is None:
        return
    if not isinstance(in_flight, list) or len(in_flight) > MAX_DELEGATIONS:
        raise ValueError("delegations.in_flight exceeds its size limit")
    for job in in_flight:
        if not isinstance(job, dict):
            raise ValueError("delegations.in_flight entries must be objects")
        _validate_checkpoint_text_fields(
            job,
            "delegations.in_flight",
            tuple(
                (field, MAX_DELEGATION_FIELD_LENGTH)
                for field in ("alias", "agent", "task_id")
            ),
        )


def _validate_checkpoint_section(field: str, value: object) -> None:
    if field == "goal":
        _validate_checkpoint_text_fields(
            value,
            field,
            (
                ("id", MAX_GOAL_ID_LENGTH),
                ("objective", MAX_GOAL_OBJECTIVE_LENGTH),
                ("status", MAX_GOAL_STATUS_LENGTH),
            ),
        )
    elif field == "phase":
        _validate_checkpoint_integer_fields(value, field, ("current", "total"))
        _validate_checkpoint_text_fields(
            value, field, (("name", MAX_PHASE_NAME_LENGTH),)
        )
    elif field == "delegations":
        _validate_checkpoint_delegations(value)
    elif field == "tail":
        _validate_tail(value)
    elif field == "heartbeat":
        _validate_checkpoint_text_fields(
            value, field, (("status", MAX_GOAL_STATUS_LENGTH),)
        )
        _validate_checkpoint_integer_fields(value, field, ("turn_count",))


def _collect_checkpoint_errors(errors: _ArgErrors, parsed: dict, prefix: str) -> None:
    """Accumulate every invalid section of one parsed checkpoint object."""
    try:
        _validate_version_metadata(parsed.get("version"))
    except ValueError as exc:
        errors.reroot(prefix, str(exc))

    sections = (
        ("goal", dict, "an object"),
        ("phase", dict, "an object"),
        ("delegations", dict, "an object"),
        ("tail", list, "an array"),
        ("heartbeat", dict, "an object"),
    )
    for field, expected_type, wording in sections:
        value = parsed.get(field)
        if value is None:
            continue
        if not isinstance(value, expected_type):
            errors.shape(
                f"{prefix}.{field}", wording, value, CHECKPOINT_EXAMPLES.get(field)
            )
            continue
        try:
            _validate_checkpoint_section(field, value)
        except ValueError as exc:
            errors.reroot(prefix, str(exc))


def _collect_context_content_errors(
    errors: _ArgErrors, content: str, key: str, prefix: str = "content"
) -> None:
    """Bound context content and accumulate every structured-field violation."""
    if not isinstance(content, str):
        errors.shape(prefix, "a string", content)
        return
    content_bytes = len(content.encode())
    if content_bytes > MAX_CONTEXT_CONTENT_BYTES:
        errors.add(
            prefix,
            f"is {content_bytes:,} UTF-8 bytes; maximum is "
            f"{MAX_CONTEXT_CONTENT_BYTES:,} bytes. Reduce content or omit "
            "optional tail if it contributes",
        )
        return
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError, ValueError):
        # Raw text remains a compatibility format. It is still bounded above.
        return
    if isinstance(parsed, list) and key == "tail":
        try:
            _validate_tail(parsed)
        except ValueError as exc:
            errors.reroot(prefix, str(exc))
        return
    if not isinstance(parsed, dict):
        # The message already names 'content': do not prepend the path again.
        errors.report(
            "structured context content must be a JSON object",
            _json_type_name(parsed),
        )
        return
    _collect_checkpoint_errors(errors, parsed, prefix)


def _collect_identifier(
    errors: _ArgErrors, value: str, name: str, limit: int
) -> str | None:
    """Validate one namespace component, recording the violation and continuing."""
    try:
        return _validate_identifier(value, name, limit)
    except ValueError as exc:
        errors.report(str(exc))
        return None


def _collect_scope_error(errors: _ArgErrors, scope: str) -> None:
    """Record an unknown scope name; DB resolution stays ``_db``'s job."""
    if scope not in _SCOPE_NAMES:
        errors.add(
            "scope",
            "must be 'global' or 'project'",
            repr(scope),
        )
        errors.example(SCOPE_EXAMPLE)


def _stored_revision(raw: object) -> int:
    """Parse a context revision; legacy datetime values are revision zero."""
    try:
        revision = int(str(raw))
    except (TypeError, ValueError):
        return 0
    return revision if 0 <= revision <= MAX_REVISION else 0


def _row_revision(row: object) -> int:
    """Resolve a row's context revision, tolerating the legacy layout.

    Rows written before the dedicated ``revision`` column existed carry the
    revision in ``updated_at`` and have ``revision IS NULL``. Reading the new
    column first and falling back keeps monotonicity intact across the
    transition: a writer that only looked at the new column would restart the
    counter at 1 and could hand out a revision an older row already used.
    """
    if row is None:
        return 0
    try:
        dedicated, legacy = row[0], row[1]
    except (IndexError, TypeError):
        return 0
    if dedicated is not None:
        return _stored_revision(dedicated)
    return _stored_revision(legacy)


_REVISION_SELECT = "SELECT revision, updated_at FROM kv_store WHERE namespace = ?"


def _current_context_revision(
    conn: sqlite3.Connection, namespace: str, key: str
) -> int:
    """Read the persisted revision for one context entry."""
    row = conn.execute(f"{_REVISION_SELECT} AND key = ?", (namespace, key)).fetchone()
    return _row_revision(row) if row else 0


def _next_context_revision(
    conn: sqlite3.Connection, namespace: str, key: str, latest_key: str | None = None
) -> int:
    """Choose a persisted monotonic revision while the write lock is held."""
    if latest_key is None:
        rows = conn.execute(
            f"{_REVISION_SELECT} AND key = ?",
            (namespace, key),
        ).fetchall()
    else:
        rows = conn.execute(
            f"{_REVISION_SELECT} AND key IN (?, ?)",
            (namespace, key, latest_key),
        ).fetchall()
    current = max((_row_revision(row) for row in rows), default=0)
    return min(MAX_REVISION, max(time.time_ns(), current + 1))


def _upsert_context_entry(
    conn: sqlite3.Connection,
    namespace: str,
    key: str,
    content: str,
    expires_at: str,
    revision: int,
) -> None:
    """Upsert one context row inside the caller's transaction."""
    conn.execute(
        "INSERT INTO kv_store (namespace, key, value, expires_at, "
        "created_at, updated_at, revision) "
        "VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?)"
        "ON CONFLICT(namespace, key) DO UPDATE SET "
        "  value = excluded.value, "
        "  expires_at = excluded.expires_at, "
        "  updated_at = excluded.updated_at, "
        "  revision = excluded.revision",
        (namespace, key, content, expires_at, revision),
    )


@mcp.tool(
    name="context_save",
    description="Save a context checkpoint for a session/phase. "
    "Stores structured operational-state checkpoint data with key-specific expiry. "
    "The serialized content is limited to 65,536 UTF-8 bytes. An included "
    "tail may contain at most 100 strings, each at most 4,096 UTF-8 bytes, "
    "with at most 65,536 UTF-8 bytes across all tail strings. Oversized "
    "content or tail is rejected, never truncated; remove or omit optional "
    "tail data when applicable. "
    "content is a JSON STRING; when it parses to an object, 'goal', 'phase', "
    "'delegations' and 'heartbeat' must each be JSON OBJECTS and 'tail' must "
    "be a JSON ARRAY. 'phase' is an object {current,total,name} — NOT a phase "
    "counter (pass phase.number for that). All sections are optional, so a "
    "heartbeat checkpoint may omit goal/phase. "
    'Example: content=\'{"goal": {"objective": "..."}, "phase": '
    '{"current": 1, "total": 3, "name": "..."}}\'. '
    "All invalid arguments are reported together in one message.",
)
async def context_save(
    slug: str,
    key: str,
    content: Annotated[
        str,
        Field(
            description=(
                "JSON checkpoint string, limited to 65,536 UTF-8 bytes. An "
                "included 'tail' may contain at most 100 strings, each at "
                "most 4,096 UTF-8 bytes, with at most 65,536 UTF-8 bytes "
                "across all tail strings. Oversized input is rejected, never "
                "truncated; remove or omit optional 'tail' when applicable. "
                "When it parses to an object, 'goal', "
                "'phase', 'delegations' and 'heartbeat' must be objects and "
                "'tail' must be an array; all are optional. 'phase' is an "
                "object {current,total,name}, not a counter. Example: "
                '\'{"goal": {"objective": "..."}, "phase": {"current": 1}}\''
            )
        ),
    ],
    session_id: str,
    ttl: int | None = None,
    scope: str = "project",
    revision: int | None = None,
) -> dict:
    """Save an operational-state checkpoint for the supplied session ID.

    The caller must supply the session ID; this function never generates one.

    Every argument is validated before any write, and all violations are
    reported in a single error so the caller fixes them in one round-trip.

    Args:
        slug: Session identifier (e.g. "auth-refactor").
        key: Checkpoint key (e.g. "phase:3", "latest", "heartbeat").
        content: JSON-serializable string or any text content.
        session_id: Required session ID associated with this checkpoint.
        ttl: TTL in seconds (defaults to the key-specific context policy).
        scope: 'project' (default) or 'global'.
        revision: Optional monotonic revision. Older/equal revisions are no-ops.

    Returns:
        Status dict with checkpoint key and session ID for subsequent calls.
    """
    errors = _ArgErrors("context_save")
    valid_slug = _collect_identifier(errors, slug, "slug", MAX_CONTEXT_SLUG_LENGTH)
    valid_key = _collect_identifier(errors, key, "key", MAX_CONTEXT_KEY_LENGTH)
    actual_session = _normalize_session_id(session_id)
    if actual_session is None:
        errors.add("session_id", "is required and must be non-empty")
        errors.example(SESSION_ID_EXAMPLE)
        valid_session = None
    else:
        valid_session = _collect_identifier(
            errors, actual_session, "session_id", MAX_CONTEXT_SESSION_ID_LENGTH
        )
    _collect_context_content_errors(errors, content, valid_key or key)
    try:
        requested_revision = _validate_revision(revision)
    except ValueError as exc:
        errors.report(str(exc), repr(revision))
        errors.example(REVISION_EXAMPLE)
        requested_revision = None
    _collect_scope_error(errors, scope)
    try:
        requested_ttl = _validate_ttl(ttl)
    except ValueError as exc:
        errors.report(str(exc), repr(ttl))
        errors.example(TTL_EXAMPLE)
        requested_ttl = None
    errors.raise_if_any()

    ns = f"checkpoint:{valid_slug}:{valid_session}"
    actual_ttl = _context_ttl(valid_key, requested_ttl)

    conn = _db(scope)
    expires_at = (datetime.now(UTC) + timedelta(seconds=actual_ttl)).isoformat()

    # BEGIN IMMEDIATE serializes writers in this process and across SQLite
    # connections. The checkpoint and raw-content latest pointer commit as one
    # unit; a crash or failed second write therefore cannot expose half a save.
    with _context_write_lock:
        try:
            conn.execute("BEGIN IMMEDIATE")
            latest_key = "latest" if _should_update_latest(valid_key) else None
            actual_revision = requested_revision or _next_context_revision(
                conn, ns, valid_key, latest_key
            )
            current_revision = _current_context_revision(conn, ns, valid_key)
            if actual_revision <= current_revision:
                conn.rollback()
                return {
                    "status": "stale",
                    "namespace": ns,
                    "key": valid_key,
                    "session_id": valid_session,
                    "ttl": actual_ttl,
                    "revision": current_revision,
                }
            _upsert_context_entry(
                conn, ns, valid_key, content, expires_at, actual_revision
            )
            if latest_key is not None and actual_revision > _current_context_revision(
                conn, ns, latest_key
            ):
                _upsert_context_entry(
                    conn, ns, latest_key, content, expires_at, actual_revision
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    return {
        "status": "stored",
        "namespace": ns,
        "key": valid_key,
        "session_id": valid_session,
        "ttl": actual_ttl,
        "revision": actual_revision,
    }


@mcp.tool(
    name="context_get",
    description="Retrieve a context checkpoint by session slug and key. "
    "Returns the raw content string or null if expired/not found.",
)
async def context_get(
    slug: str,
    key: str = "latest",
    session_id: str | None = None,
    legacy: bool = False,
    scope: str = "project",
) -> str | None:
    """Get an operational-state checkpoint by slug and key.

    Args:
        slug: Session identifier.
        key: Checkpoint key (default "latest").
        session_id: Required for session-scoped reads.
        legacy: Explicitly opt into reading the pre-session checkpoint format.
        scope: 'project' (default) or 'global'.

    Returns:
        Content string or None if not found/expired.
    """
    conn = _db(scope)
    try:
        _validate_identifier(key, "key", MAX_CONTEXT_KEY_LENGTH)
    except ValueError:
        return None
    ns = _context_namespace(slug, session_id, legacy=legacy)
    if ns is None:
        return None
    row = conn.execute(
        "SELECT value FROM kv_store "
        "WHERE namespace = ? AND key = ? "
        "AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')) "
        "AND deleted_at IS NULL",
        (ns, key),
    ).fetchone()
    return row[0] if row else None


# ── Main Entrypoint ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
