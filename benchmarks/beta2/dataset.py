"""Load and validate the declarative beta2 benchmark dataset."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Final

AGENT_IDS: Final[frozenset[str]] = frozenset(
    {
        "zeus",
        "athena",
        "apollo",
        "hermes",
        "aphrodite",
        "demeter",
        "prometheus",
        "hephaestus",
        "nyx",
        "gaia",
        "iris",
        "mnemosyne",
        "talos",
        "themis",
    }
)


class DatasetError(ValueError):
    """Raised when the benchmark contract is invalid."""


@dataclass(frozen=True)
class Budget:
    """Per-task resource limits."""

    max_total_tokens: int
    max_latency_ms: int
    max_retries: int


@dataclass(frozen=True)
class Verification:
    """An argv-only deterministic verification command."""

    name: str
    argv: tuple[str, ...]
    timeout_s: float


@dataclass(frozen=True)
class Acceptance:
    """Deterministic quality checks for a task output."""

    required_fragments: tuple[str, ...]
    json_paths: tuple[dict[str, object], ...]


@dataclass(frozen=True)
class Task:
    """One benchmark task."""

    task_id: str
    agent: str
    skill: str
    prompt: str
    criteria: tuple[str, ...]
    acceptance: Acceptance
    verification: tuple[Verification, ...]
    budget: Budget
    split: str


@dataclass(frozen=True)
class Dataset:
    """Validated benchmark dataset."""

    schema_version: str
    agents: tuple[dict[str, object], ...]
    skills: tuple[dict[str, object], ...]
    tasks: tuple[Task, ...]


def _as_dict(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise DatasetError(f"{label} must be an object")
    return {str(key): item for key, item in value.items()}


def _required_string(data: dict[str, object], key: str, label: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise DatasetError(f"{label}.{key} must be a non-empty string")
    return value


def _required_int(
    data: dict[str, object], key: str, label: str, minimum: int = 0
) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise DatasetError(f"{label}.{key} must be an integer >= {minimum}")
    return value


def _string_tuple(value: object, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise DatasetError(f"{label} must be a list of strings")
    return tuple(value)


def _parse_verification(value: object, label: str) -> tuple[Verification, ...]:
    if not isinstance(value, list):
        raise DatasetError(f"{label} must be a list")
    commands: list[Verification] = []
    for index, item in enumerate(value):
        command = _as_dict(item, f"{label}[{index}]")
        argv = command.get("argv")
        if (
            not isinstance(argv, list)
            or not argv
            or not all(isinstance(arg, str) for arg in argv)
        ):
            raise DatasetError(
                f"{label}[{index}].argv must be a non-empty list of strings"
            )
        timeout = command.get("timeout_s", 5)
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or timeout <= 0
        ):
            raise DatasetError(f"{label}[{index}].timeout_s must be positive")
        commands.append(
            Verification(
                name=_required_string(command, "name", f"{label}[{index}]"),
                argv=tuple(argv),
                timeout_s=float(timeout),
            )
        )
    return tuple(commands)


def _parse_task(item: object, index: int) -> Task:
    data = _as_dict(item, f"tasks[{index}]")
    label = f"tasks[{index}]"
    task_id = _required_string(data, "id", label)
    agent = _required_string(data, "agent", label)
    skill = _required_string(data, "skill", label)
    prompt = _required_string(data, "prompt", label)
    split = _required_string(data, "split", label)
    if split not in {"train", "holdout"}:
        raise DatasetError(f"{label}.split must be train or holdout")
    acceptance_data = _as_dict(data.get("acceptance"), f"{label}.acceptance")
    fragments = _string_tuple(
        acceptance_data.get("required_fragments", []),
        f"{label}.acceptance.required_fragments",
    )
    paths = acceptance_data.get("json_paths", [])
    if not isinstance(paths, list) or not all(isinstance(path, dict) for path in paths):
        raise DatasetError(f"{label}.acceptance.json_paths must be a list of objects")
    budget_data = _as_dict(data.get("budget"), f"{label}.budget")
    budget = Budget(
        max_total_tokens=_required_int(
            budget_data, "max_total_tokens", f"{label}.budget", 1
        ),
        max_latency_ms=_required_int(
            budget_data, "max_latency_ms", f"{label}.budget", 1
        ),
        max_retries=_required_int(budget_data, "max_retries", f"{label}.budget", 0),
    )
    return Task(
        task_id=task_id,
        agent=agent,
        skill=skill,
        prompt=prompt,
        criteria=_string_tuple(data.get("criteria", []), f"{label}.criteria"),
        acceptance=Acceptance(
            tuple(fragments),
            tuple({str(key): value for key, value in path.items()} for path in paths),
        ),
        verification=_parse_verification(
            data.get("verification", []), f"{label}.verification"
        ),
        budget=budget,
        split=split,
    )


def validate_dataset(data: object) -> Dataset:
    """Validate raw JSON and return a typed dataset."""
    root = _as_dict(data, "dataset")
    version = _required_string(root, "schema_version", "dataset")
    agents_value, skills_value, tasks_value = (
        root.get("agents"),
        root.get("skills"),
        root.get("tasks"),
    )
    if (
        not isinstance(agents_value, list)
        or not isinstance(skills_value, list)
        or not isinstance(tasks_value, list)
    ):
        raise DatasetError(
            "dataset.agents, dataset.skills and dataset.tasks must be lists"
        )
    agents = tuple(
        _as_dict(item, f"agents[{index}]") for index, item in enumerate(agents_value)
    )
    agent_ids = {item.get("id") for item in agents}
    present_agents = {item for item in agent_ids if isinstance(item, str)}
    missing = AGENT_IDS - present_agents
    if missing:
        raise DatasetError(
            f"dataset is missing agent manifest entries: {sorted(missing)}"
        )
    skills = tuple(
        _as_dict(item, f"skills[{index}") for index, item in enumerate(skills_value)
    )
    skill_ids = {item.get("id") for item in skills}
    tasks = tuple(_parse_task(item, index) for index, item in enumerate(tasks_value))
    if not tasks:
        raise DatasetError("dataset.tasks must not be empty")
    if len({task.task_id for task in tasks}) != len(tasks):
        raise DatasetError("dataset task ids must be unique")
    if any(task.agent not in AGENT_IDS for task in tasks):
        raise DatasetError("every task.agent must be one of the 14 Pantheon agents")
    if any(task.skill not in skill_ids for task in tasks):
        raise DatasetError("every task.skill must be present in dataset.skills")
    return Dataset(version, agents, skills, tasks)


def load_dataset(path: Path) -> Dataset:
    """Load and validate a UTF-8 JSON dataset."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DatasetError(f"cannot load dataset {path}: {exc}") from exc
    return validate_dataset(data)
