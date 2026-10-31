"""Concurrency regressions for the Memory MCP SQLite store.

The server caches a single ``sqlite3.Connection`` and FastMCP runs synchronous
tools in a threadpool, so parallel calls share one connection. ``commit()`` and
``rollback()`` are connection-scoped, not call-scoped: one caller's rollback
discards another caller's uncommitted write, and that other caller still
reports ``status: stored``. A write reported as durable but never persisted is
the failure this file exists to prevent from coming back.

The interleaving is forced with a thread barrier plus connection subclasses
that order the writes. The ordering is a scheduler, not a stand-in for the bug:
it makes an interleaving the threadpool reaches by chance happen in one run.
"""

from __future__ import annotations

import importlib
import sqlite3
import threading
import time
from pathlib import Path

import pytest

MODULE_PATH = "src.mcp.memory_mcp"

WRITER_COUNT = 5
# One duplicate-key writer plus distinct-key writers.
LOSER_COUNT = 1
WINNER_COUNT = WRITER_COUNT - LOSER_COUNT
READ_OPERATION_COUNT = 3
LOSER_MARKER = "LOSER-MARKER"

# Long enough that every writer has issued its INSERT before the first one
# resumes, short enough to keep the serialized run around a second.
WRITE_WINDOW_SECONDS = 0.2
# Bounded so the serialized implementation (where the losers' peers cannot run
# until the lock is released) does not deadlock on the scheduler.
ORDERING_TIMEOUT_SECONDS = 1.0


@pytest.fixture
def module(tmp_path: Path):
    """Import the memory MCP module bound to a fresh temporary database."""
    mod = importlib.import_module(MODULE_PATH)
    original_db_path = mod.DB_PATH
    mod._set_memory_dir(str(tmp_path / "memory"))
    try:
        yield mod
    finally:
        mod._reset_test_state()
        mod.DB_PATH = original_db_path


# ── Deterministic interleaving ────────────────────────────────────────────────


class _WriteCoordinator:
    """Orders one failing writer's rollback between the others' INSERT/COMMIT."""

    def __init__(self, winners: int, loser_wait: float, commit_delay: float) -> None:
        self._lock = threading.Lock()
        self._expected = winners
        self._inserted = 0
        self.winners_ready = threading.Event()
        self.loser_wait = loser_wait
        self.commit_delay = commit_delay

    def record_winner_insert(self) -> None:
        with self._lock:
            self._inserted += 1
            if self._inserted >= self._expected:
                self.winners_ready.set()

    def wait_for_winners(self) -> None:
        self.winners_ready.wait(timeout=self.loser_wait)


class _OrderedWriteConnection(sqlite3.Connection):
    """Pauses each writer at a point the production code cannot control.

    Winners keep their INSERT uncommitted for ``commit_delay``; the failing
    writer waits until every winner INSERT has been issued, so its rollback
    lands in the middle of their transactions. That is the interleaving the
    threadpool produces on its own when two calls overlap.
    """

    coordinator: _WriteCoordinator

    def execute(self, sql, parameters=(), /):
        coordinator = type(self).coordinator
        if "INSERT INTO memories" not in sql:
            return super().execute(sql, parameters)
        if LOSER_MARKER in parameters:
            coordinator.wait_for_winners()
            return super().execute(sql, parameters)
        cursor = super().execute(sql, parameters)
        coordinator.record_winner_insert()
        time.sleep(coordinator.commit_delay)
        return cursor


@pytest.fixture
def ordered_writes(module, monkeypatch: pytest.MonkeyPatch) -> None:
    """Install the ordering connection on the module's sqlite3.connect."""
    _OrderedWriteConnection.coordinator = _WriteCoordinator(
        winners=WINNER_COUNT,
        loser_wait=ORDERING_TIMEOUT_SECONDS,
        commit_delay=WRITE_WINDOW_SECONDS,
    )
    real_connect = sqlite3.connect

    def connect(*args, **kwargs):
        kwargs["factory"] = _OrderedWriteConnection
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(module.sqlite3, "connect", connect)


class _ReadOverlapCoordinator:
    """Release readers and a writer together inside an open transaction."""

    def __init__(self, reader_count: int) -> None:
        self.writer_inserted = threading.Event()
        self.enabled = threading.Event()
        self._readers_and_writer = threading.Barrier(reader_count + 1)

    def writer_wait_for_readers(self) -> None:
        self.enabled.clear()
        self.writer_inserted.set()
        self._readers_and_writer.wait(timeout=ORDERING_TIMEOUT_SECONDS * 10)

    def reader_wait_for_writer(self) -> None:
        if not self.writer_inserted.wait(timeout=ORDERING_TIMEOUT_SECONDS * 10):
            raise TimeoutError("no writer entered its transaction")
        self._readers_and_writer.wait(timeout=ORDERING_TIMEOUT_SECONDS * 10)


class _CoordinatedReadConnection(sqlite3.Connection):
    """Hold a writer inside INSERT until the read calls are ready to overlap."""

    coordinator: _ReadOverlapCoordinator

    def execute(self, sql, parameters=(), /):
        cursor = super().execute(sql, parameters)
        coordinator = type(self).coordinator
        if coordinator.enabled.is_set() and "INSERT INTO memories" in sql:
            coordinator.writer_wait_for_readers()
        return cursor


@pytest.fixture
def coordinated_reads(
    module, monkeypatch: pytest.MonkeyPatch
) -> _ReadOverlapCoordinator:
    """Install a transaction barrier for concurrent reader coverage."""
    coordinator = _ReadOverlapCoordinator(reader_count=READ_OPERATION_COUNT)
    real_connect = sqlite3.connect

    def connect(*args, **kwargs):
        kwargs["factory"] = _CoordinatedReadConnection
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(module.sqlite3, "connect", connect)
    monkeypatch.setattr(
        _CoordinatedReadConnection, "coordinator", coordinator, raising=False
    )
    return coordinator


@pytest.fixture
def counted_connects(module, monkeypatch: pytest.MonkeyPatch) -> list:
    """Count every connection construction, widened so races are observable."""
    real_connect = sqlite3.connect
    created: list = []

    def connect(*args, **kwargs):
        time.sleep(WRITE_WINDOW_SECONDS)
        conn = real_connect(*args, **kwargs)
        created.append(conn)
        return conn

    monkeypatch.setattr(module.sqlite3, "connect", connect)
    return created


def _run_concurrently(target, count: int) -> tuple[list, list]:
    """Run ``target(index)`` on ``count`` threads released by one barrier."""
    barrier = threading.Barrier(count)
    results: list = [None] * count
    errors: list = [None] * count

    def runner(index: int) -> None:
        try:
            barrier.wait(timeout=10)
            results[index] = target(index)
        except BaseException as exc:  # re-raised by the test
            errors[index] = exc

    threads = [
        threading.Thread(target=runner, args=(index,), daemon=True)
        for index in range(count)
    ]
    try:
        for thread in threads:
            thread.start()
        deadline = time.monotonic() + 30
        for thread in threads:
            thread.join(timeout=max(0, deadline - time.monotonic()))
    finally:
        barrier.abort()
        for thread in threads:
            if thread.is_alive():
                thread.join(timeout=ORDERING_TIMEOUT_SECONDS * 10)

    assert not any(thread.is_alive() for thread in threads), "a writer deadlocked"
    return results, errors


# ── Tests ─────────────────────────────────────────────────────────────────────


def test_parallel_store_never_reports_unpersisted_success(module, ordered_writes):
    """A concurrent rollback must not turn another call's success into a lie."""
    namespace = "parallel"
    seed = module.memory_store(value="seed", namespace=namespace, key="dup")
    assert seed["status"] == "stored"

    def write(index: int):
        if index == WINNER_COUNT:
            return module.memory_store(
                value=f"{LOSER_MARKER} duplicate key",
                namespace=namespace,
                key="dup",
            )
        return module.memory_store(
            value=f"entry {index}", namespace=namespace, key=f"k{index}"
        )

    results, errors = _run_concurrently(write, WRITER_COUNT)
    assert errors == [None] * WRITER_COUNT, f"a store call raised: {errors}"

    stored = [result for result in results if result.get("status") == "stored"]
    failed = [result for result in results if "error" in result]
    assert len(failed) == LOSER_COUNT, f"the duplicate write was not refused: {results}"
    assert len(stored) == WINNER_COUNT, f"a distinct write did not store: {results}"

    ids = [result["id"] for result in stored]
    assert len(set(ids)) == WINNER_COUNT, f"ids were shared between calls: {ids}"

    conn = sqlite3.connect(module.DB_PATH)
    try:
        rows = conn.execute(
            "SELECT id, key FROM memories WHERE namespace = ? ORDER BY id",
            [namespace],
        ).fetchall()
    finally:
        conn.close()

    assert len(rows) == len(stored) + 1, (
        f"{len(stored)} calls reported stored but {len(rows) - 1} rows exist "
        "(success reported for a write that was rolled back)"
    )
    assert {row[0] for row in rows[1:]} == set(ids)
    expected_keys = {f"k{index}" for index in range(WINNER_COUNT)}
    assert {row[1] for row in rows[1:]} == expected_keys


def test_concurrent_first_touch_opens_one_connection(module, counted_connects) -> None:
    """Concurrent first use constructs one connection, not one per thread."""
    connections, errors = _run_concurrently(lambda _index: module._get_db(), 5)
    assert errors == [None] * 5, f"connection setup raced: {errors}"

    assert len(counted_connects) == 1, (
        f"{len(counted_connects)} connections were constructed; the losers are "
        "orphaned and their PRAGMA journal_mode=WAL can fail with 'database is locked'"
    )
    assert all(conn is connections[0] for conn in connections)
    assert connections[0].execute("SELECT 1").fetchone()[0] == 1


def test_reset_test_state_closes_the_cached_connection(module) -> None:
    """Resetting state closes the previous singleton instead of leaking it."""
    previous = module._get_db()
    module._reset_test_state()

    with pytest.raises(sqlite3.ProgrammingError):
        previous.execute("SELECT 1")

    reopened = module._get_db()
    assert reopened is not previous
    assert reopened.execute("SELECT 1").fetchone()[0] == 1


def test_store_reports_open_failure_instead_of_success(
    module, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A connection that cannot be opened is a loud error, never a store."""

    def fail_to_open() -> sqlite3.Connection:
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(module, "_get_conn", fail_to_open)

    result = module.memory_store(value="entry", namespace="loud", key="k")

    assert "error" in result, result
    assert "status" not in result, f"a failed write reported success: {result}"
    assert result.get("id") is None


def test_memory_reads_stay_consistent_while_writes_are_in_flight(
    module, coordinated_reads
) -> None:
    """All read tools return valid results while a writer is in flight."""
    namespace = "reads"
    assert (
        module.memory_store(
            value="checkpoint threshold baseline", namespace=namespace, key="seed"
        )["status"]
        == "stored"
    )
    coordinated_reads.enabled.set()
    readers = (
        lambda: module.memory_search("checkpoint", namespace=namespace),
        lambda: module.memory_recall("seed", namespace=namespace),
        module.memory_stats,
    )

    def work(index: int):
        if index < WINNER_COUNT:
            return module.memory_store(
                value=f"checkpoint threshold {index}",
                namespace=namespace,
                key=f"k{index}",
            )
        coordinated_reads.reader_wait_for_writer()
        return readers[index - WINNER_COUNT]()

    results, errors = _run_concurrently(
        work, WINNER_COUNT + READ_OPERATION_COUNT
    )
    assert errors == [None] * len(results), f"a concurrent read/write raised: {errors}"

    stores = results[:WINNER_COUNT]
    search, recalled, stats = results[WINNER_COUNT:]
    assert all(isinstance(result, dict) for result in stores), stores
    assert all(
        result.get("status") == "stored" and "error" not in result
        for result in stores
    ), stores
    assert isinstance(search, list), search
    assert all(
        isinstance(hit, dict) and "error" not in hit for hit in search
    ), search
    assert {hit["key"] for hit in search} >= {"seed"}
    assert isinstance(recalled, dict) and "error" not in recalled, recalled
    assert recalled["key"] == "seed"
    assert isinstance(stats, dict) and stats.get("status") == "ok", stats
    assert isinstance(stats.get("total_entries"), int), stats
    assert isinstance(stats.get("namespaces"), list), stats

    conn = sqlite3.connect(module.DB_PATH)
    try:
        persisted = conn.execute(
            "SELECT COUNT(*) FROM memories WHERE namespace = ?", [namespace]
        ).fetchone()[0]
    finally:
        conn.close()
    assert persisted == len(stores) + 1  # the seed plus every reported store
