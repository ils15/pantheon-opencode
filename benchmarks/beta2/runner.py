"""CLI and orchestration for the beta2 quality/token benchmark."""

from __future__ import annotations

import argparse
import json
import shutil
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

from .dataset import Dataset, DatasetError, Task, load_dataset
from .executor import (
    Execution,
    evaluate_quality,
    isolated_workspace,
    run_fixture,
    run_opencode,
)
from .metrics import output_fingerprint, redact_text

DEFAULT_DATASET = Path(__file__).with_name("dataset.json")
VARIANTS: Final[tuple[str, str]] = ("baseline", "candidate")


@dataclass(frozen=True)
class BenchmarkOptions:
    """Execution options kept together to avoid an argument-heavy API."""

    mode: str = "auto"
    candidate_prompts: dict[str, str] = field(default_factory=dict)
    fixture_responses: dict[str, dict[str, object]] = field(default_factory=dict)
    workspace: Path | None = None
    binary: str = "opencode"
    dry_run: bool = False

    @classmethod
    def from_kwargs(cls, values: Mapping[str, object]) -> BenchmarkOptions:
        """Build options for callers using the legacy keyword API."""
        allowed = {
            "mode",
            "candidate_prompts",
            "fixture_responses",
            "workspace",
            "binary",
            "dry_run",
        }
        unknown = set(values) - allowed
        if unknown:
            raise TypeError(f"unexpected benchmark option(s): {sorted(unknown)}")
        mode = values.get("mode", "auto")
        candidate_prompts = values.get("candidate_prompts")
        fixture_responses = values.get("fixture_responses")
        workspace = values.get("workspace")
        binary = values.get("binary", "opencode")
        dry_run = values.get("dry_run", False)
        if not isinstance(mode, str):
            raise TypeError("mode must be a string")
        if not isinstance(candidate_prompts, (dict, type(None))):
            raise TypeError("candidate_prompts must be a dictionary")
        if not isinstance(fixture_responses, (dict, type(None))):
            raise TypeError("fixture_responses must be a dictionary")
        if not isinstance(workspace, (Path, type(None))):
            raise TypeError("workspace must be a pathlib.Path or None")
        if not isinstance(binary, str):
            raise TypeError("binary must be a string")
        if not isinstance(dry_run, bool):
            raise TypeError("dry_run must be a boolean")
        return cls(
            mode=mode,
            candidate_prompts=candidate_prompts or {},
            fixture_responses=fixture_responses or {},
            workspace=workspace,
            binary=binary,
            dry_run=dry_run,
        )


def _load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DatasetError(f"cannot load JSON file {path}: {exc}") from exc


def _validate_variant(value: object) -> str:
    """Validate the two variants shared by datasets, fixtures, and reports."""
    if not isinstance(value, str) or value not in VARIANTS:
        raise ValueError(f"variant must be one of {', '.join(VARIANTS)}")
    return value


def _display_variants(row: Mapping[str, object]) -> str:
    """Render an execution variant or a dry-run variant manifest safely."""
    if "variant" in row:
        return _validate_variant(row["variant"])
    variants = row.get("variants")
    if variants is None:
        return "—"
    if not isinstance(variants, (list, tuple)):
        raise ValueError("variants must be a list")
    if not variants:
        return "—"
    return ", ".join(_validate_variant(variant) for variant in variants)


def load_candidate_prompts(path: Path | None) -> dict[str, str]:
    """Load task-id to candidate-prompt mappings."""
    if path is None:
        return {}
    raw = _load_json(path)
    if isinstance(raw, dict) and isinstance(raw.get("prompts"), dict):
        raw = raw["prompts"]
    if not isinstance(raw, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in raw.items()
    ):
        raise DatasetError(
            "candidate prompts must be a JSON object mapping task ids to strings"
        )
    return {key: value for key, value in raw.items()}


def load_fixture_responses(path: Path | None) -> dict[str, dict[str, object]]:
    """Load fixture responses keyed by task id and variant."""
    if path is None:
        return {}
    raw = _load_json(path)
    if not isinstance(raw, dict):
        raise DatasetError("fixture must be a JSON object")
    responses = raw.get("responses", raw)
    if not isinstance(responses, dict):
        raise DatasetError("fixture.responses must be an object")
    result: dict[str, dict[str, object]] = {}
    for task_id, variants in responses.items():
        if not isinstance(task_id, str) or not isinstance(variants, dict):
            raise DatasetError("fixture response entries must be objects")
        validated: dict[str, object] = {}
        for key, value in variants.items():
            try:
                variant = _validate_variant(key)
            except ValueError as exc:
                raise DatasetError(
                    f"fixture response variant must be one of {', '.join(VARIANTS)}"
                ) from exc
            validated[variant] = value
        result[task_id] = validated
    return result


def _preview(value: str, limit: int = 500) -> str:
    return redact_text(value).replace("\x00", "")[:limit]


def _execution_result(
    task: Task, variant: str, prompt: str, execution: Execution, sandbox: Path
) -> dict[str, object]:
    quality = (
        evaluate_quality(task, execution.output, sandbox)
        if execution.returncode == 0
        else None
    )
    tokens = execution.usage
    budget_ok = (
        tokens.total_tokens <= task.budget.max_total_tokens
        and execution.latency_ms <= task.budget.max_latency_ms
        and execution.retries <= task.budget.max_retries
    )
    quality_accepted = quality.accepted if quality is not None else False
    accepted = quality_accepted and budget_ok
    if execution.returncode != 0:
        status = "execution_error"
    elif not quality_accepted:
        status = "quality_failed"
    elif not budget_ok:
        status = "budget_failed"
    else:
        status = "accepted"
    return {
        "task_id": task.task_id,
        "agent": task.agent,
        "skill": task.skill,
        "split": task.split,
        "variant": variant,
        "status": status,
        "accepted": accepted,
        "quality_accepted": quality_accepted,
        "quality_score": quality.score if quality is not None else 0.0,
        "quality_checks": list(quality.checks) if quality is not None else [],
        "budget_ok": budget_ok,
        "budget": {
            "max_total_tokens": task.budget.max_total_tokens,
            "max_latency_ms": task.budget.max_latency_ms,
            "max_retries": task.budget.max_retries,
        },
        "tokens": {
            "input": tokens.input_tokens,
            "output": tokens.output_tokens,
            "tool_schema": tokens.tool_schema_tokens,
            "tool_output": tokens.tool_output_tokens,
            "retrieval": tokens.retrieval_tokens,
            "measurement": tokens.measurement_tokens,
            "total": tokens.total_tokens,
            "net_total": tokens.net_tokens,
            "estimated": tokens.estimated,
        },
        "latency_ms": execution.latency_ms,
        "calls": execution.calls,
        "tool_calls": execution.tool_calls,
        "retries": execution.retries,
        "returncode": execution.returncode,
        "error": redact_text(execution.error) if execution.error else None,
        "input_preview": _preview(prompt),
        "output_preview": _preview(execution.output),
        "output_sha256": output_fingerprint(execution.output),
    }


def _missing_fixture(task_id: str, variant: str, prompt: str) -> Execution:
    fixture = run_fixture({"output": ""}, prompt)
    return Execution(
        "",
        {},
        fixture.usage,
        0,
        0,
        0,
        0,
        66,
        f"missing fixture response for {task_id}/{variant}",
    )


def _aggregate(results: Iterable[dict[str, object]]) -> dict[str, object]:
    rows = list(results)
    accepted = sum(1 for row in rows if row.get("accepted") is True)
    quality_accepted = sum(1 for row in rows if row.get("quality_accepted") is True)
    total = sum(
        int(row["tokens"]["total"])
        for row in rows
        if isinstance(row.get("tokens"), dict)
    )
    net_total = sum(
        int(row["tokens"]["net_total"])
        for row in rows
        if isinstance(row.get("tokens"), dict)
    )
    efficiency = accepted / (net_total / 1000) if net_total else 0.0
    return {
        "tasks": len(rows),
        "accepted_tasks": accepted,
        "quality_accepted_tasks": quality_accepted,
        "total_tokens": total,
        "net_total_tokens": net_total,
        "efficiency_accepted_per_k_tokens": round(efficiency, 6),
    }


def _comparison(results: list[dict[str, object]]) -> dict[str, object]:
    baseline = _aggregate(row for row in results if row["variant"] == "baseline")
    candidate = _aggregate(row for row in results if row["variant"] == "candidate")
    baseline_quality = int(baseline["quality_accepted_tasks"])
    candidate_quality = int(candidate["quality_accepted_tasks"])
    if candidate_quality < baseline_quality:
        winner = "baseline"
    elif int(candidate["accepted_tasks"]) > int(baseline["accepted_tasks"]):
        winner = "candidate"
    elif int(candidate["accepted_tasks"]) < int(baseline["accepted_tasks"]):
        winner = "baseline"
    elif int(candidate["net_total_tokens"]) < int(baseline["net_total_tokens"]):
        winner = "candidate"
    elif int(candidate["net_total_tokens"]) > int(baseline["net_total_tokens"]):
        winner = "baseline"
    else:
        winner = "tie"
    return {
        "baseline": baseline,
        "candidate": candidate,
        "winner": winner,
        "quality_first": True,
        "delta": {
            "accepted_tasks": int(candidate["accepted_tasks"])
            - int(baseline["accepted_tasks"]),
            "quality_accepted_tasks": candidate_quality - baseline_quality,
            "net_tokens": int(candidate["net_total_tokens"])
            - int(baseline["net_total_tokens"]),
            "efficiency_accepted_per_k_tokens": round(
                float(candidate["efficiency_accepted_per_k_tokens"])
                - float(baseline["efficiency_accepted_per_k_tokens"]),
                6,
            ),
        },
        "net_delta_definition": "candidate net tokens minus baseline net tokens; retrieval and measurement are excluded",
    }


def _run_benchmark(dataset: Dataset, options: BenchmarkOptions) -> dict[str, object]:
    """Run one benchmark using validated options."""
    selected_mode = (
        "opencode"
        if options.mode == "auto" and shutil.which(options.binary)
        else "fixture"
        if options.mode == "auto"
        else options.mode
    )
    if selected_mode not in {"fixture", "opencode"}:
        raise ValueError("mode must be auto, fixture, or opencode")
    tasks = sorted(dataset.tasks, key=lambda task: task.task_id)
    if options.dry_run:
        return {
            "schema_version": "beta2.report.v1",
            "dataset_version": dataset.schema_version,
            "mode": selected_mode,
            "dry_run": True,
            "reproducible": True,
            "tasks": [
                {
                    "task_id": task.task_id,
                    "agent": task.agent,
                    "skill": task.skill,
                    "variants": list(VARIANTS),
                    "split": task.split,
                    "budget": {
                        "max_total_tokens": task.budget.max_total_tokens,
                        "max_latency_ms": task.budget.max_latency_ms,
                        "max_retries": task.budget.max_retries,
                    },
                }
                for task in tasks
            ],
            "results": [],
            "comparison": None,
        }
    if selected_mode == "opencode" and shutil.which(options.binary) is None:
        raise FileNotFoundError(f"OpenCode executable not found: {options.binary}")
    results: list[dict[str, object]] = []
    for task in tasks:
        for variant in ("baseline", "candidate"):
            prompt = (
                task.prompt
                if variant == "baseline"
                else options.candidate_prompts.get(task.task_id, task.prompt)
            )
            with isolated_workspace(options.workspace) as sandbox:
                if selected_mode == "fixture":
                    response = options.fixture_responses.get(task.task_id, {}).get(
                        variant
                    )
                    execution = (
                        run_fixture(response, prompt)
                        if response is not None
                        else _missing_fixture(task.task_id, variant, prompt)
                    )
                else:
                    execution = run_opencode(options.binary, prompt, task, sandbox)
                results.append(
                    _execution_result(task, variant, prompt, execution, sandbox)
                )
    return {
        "schema_version": "beta2.report.v1",
        "dataset_version": dataset.schema_version,
        "mode": selected_mode,
        "dry_run": False,
        "reproducible": True,
        "secret_storage": "redacted previews and output hashes only",
        "tasks": results,
        "comparison": _comparison(results),
    }


def run_benchmark(
    dataset: Dataset,
    options: BenchmarkOptions | None = None,
    **legacy_options: object,
) -> dict[str, object]:
    """Run baseline and candidate variants without changing the source workspace.

    ``legacy_options`` preserves the original keyword interface while the
    options object keeps the implementation below Ruff's argument limit.
    """
    if options is not None and legacy_options:
        raise TypeError("pass either options or benchmark keyword options, not both")
    return _run_benchmark(
        dataset, options or BenchmarkOptions.from_kwargs(legacy_options)
    )


def render_markdown(report: dict[str, object]) -> str:
    """Render a stable human-readable report."""
    lines = [
        "# Pantheon beta2 benchmark",
        "",
        f"- Mode: `{report['mode']}`",
        f"- Dry-run: `{report['dry_run']}`",
        f"- Secrets: `{report.get('secret_storage', 'not executed')}`",
        "",
    ]
    comparison = report.get("comparison")
    if isinstance(comparison, dict):
        baseline, candidate = comparison["baseline"], comparison["candidate"]
        lines += [
            "## Quality first",
            "",
            "| Variant | Accepted | Quality accepted | Net tokens | Accepted/kTokens |",
            "|---|---:|---:|---:|---:|",
            f"| baseline | {baseline['accepted_tasks']} | {baseline['quality_accepted_tasks']} | {baseline['net_total_tokens']} | {baseline['efficiency_accepted_per_k_tokens']} |",
            f"| candidate | {candidate['accepted_tasks']} | {candidate['quality_accepted_tasks']} | {candidate['net_total_tokens']} | {candidate['efficiency_accepted_per_k_tokens']} |",
            "",
            f"Winner (quality first): **{comparison['winner']}**",
            f"Net token delta: `{comparison['delta']['net_tokens']}` (candidate - baseline)",
            "",
        ]
    if report.get("dry_run") is True:
        lines += [
            "## Planned tasks",
            "",
            "| Task | Agent | Skill | Variants | Split | Budget (tokens / latency ms / retries) |",
            "|---|---|---|---|---|---|",
        ]
        for row in report.get("tasks", []):
            if isinstance(row, dict):
                budget = row.get("budget", {})
                if isinstance(budget, Mapping):
                    budget_text = (
                        f"{budget.get('max_total_tokens', '—')} / "
                        f"{budget.get('max_latency_ms', '—')} / "
                        f"{budget.get('max_retries', '—')}"
                    )
                else:
                    budget_text = "—"
                lines.append(
                    f"| {row.get('task_id', '—')} | {row.get('agent', '—')} | "
                    f"{row.get('skill', '—')} | {_display_variants(row)} | "
                    f"{row.get('split', '—')} | {budget_text} |"
                )
        return "\n".join(lines) + "\n"

    lines += [
        "## Task results",
        "",
        "| Task | Agent | Variant | Status | Quality | Net tokens | Latency ms | Retries |",
        "|---|---|---|---|---:|---:|---:|---:|",
    ]
    for row in report.get("tasks", []):
        if isinstance(row, dict):
            tokens = row.get("tokens", {})
            lines.append(
                f"| {row['task_id']} | {row['agent']} | {_display_variants(row)} | {row['status']} | {row['quality_score']} | {tokens.get('net_total', 0)} | {row['latency_ms']} | {row['retries']} |"
            )
    return "\n".join(lines) + "\n"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument(
        "--mode", choices=("auto", "fixture", "opencode"), default="auto"
    )
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--candidate-prompts", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--binary", default="opencode")
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--output-markdown", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the command-line benchmark."""
    args = _build_parser().parse_args(argv)
    try:
        report = run_benchmark(
            load_dataset(args.dataset),
            mode=args.mode,
            candidate_prompts=load_candidate_prompts(args.candidate_prompts),
            fixture_responses=load_fixture_responses(args.fixture),
            workspace=args.workspace,
            binary=args.binary,
            dry_run=args.dry_run,
        )
    except (DatasetError, FileNotFoundError, ValueError) as exc:
        print(f"beta2 benchmark error: {exc}")
        return 2
    markdown = render_markdown(report)
    if args.output_json:
        args.output_json.write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    if args.output_markdown:
        args.output_markdown.write_text(markdown, encoding="utf-8")
    if not args.output_json and not args.output_markdown:
        print(markdown, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
