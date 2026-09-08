"""Optional offline GEPA adapter for beta2 prompt proposals.

The module intentionally does not import or require GEPA. It exports a stable
metric contract, generates deterministic local prompt proposals, and only
marks a proposal approved after train and holdout quality-floor checks.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

from .dataset import Dataset, load_dataset


def gepa_available() -> bool:
    """Return whether an optional GEPA installation can be discovered."""
    return importlib.util.find_spec("gepa") is not None


def _task_payload(dataset: Dataset) -> list[dict[str, object]]:
    return [
        {
            "id": task.task_id,
            "agent": task.agent,
            "skill": task.skill,
            "prompt": task.prompt,
            "criteria": list(task.criteria),
            "acceptance": {
                "required_fragments": list(task.acceptance.required_fragments),
                "json_paths": list(task.acceptance.json_paths),
            },
            "split": task.split,
            "budget": {
                "max_total_tokens": task.budget.max_total_tokens,
                "max_latency_ms": task.budget.max_latency_ms,
                "max_retries": task.budget.max_retries,
            },
        }
        for task in dataset.tasks
    ]


def export_gepa_payload(
    dataset: Dataset, report: dict[str, object] | None = None
) -> dict[str, object]:
    """Create the optional-package-neutral GEPA dataset and metric payload."""
    return {
        "schema_version": "beta2.gepa.v1",
        "gepa_installed": gepa_available(),
        "dataset_version": dataset.schema_version,
        "dataset": _task_payload(dataset),
        "metric": {
            "name": "quality_first_net_token_efficiency",
            "quality_gate": "all deterministic acceptance and verification checks pass",
            "primary": "accepted tasks",
            "secondary": "net tokens = total - retrieval - measurement",
            "efficiency": "accepted tasks / (net tokens / 1000)",
            "holdout_required": True,
        },
        "report": report,
        "auto_apply": False,
    }


def generate_prompt_candidates(seed_prompt: str, count: int = 3) -> list[str]:
    """Generate deterministic, reviewable prompt candidates without an LLM."""
    if count < 1:
        raise ValueError("count must be at least 1")
    variants = [
        f"{seed_prompt}\nReturn only the requested result and keep the response concise.",
        f"{seed_prompt}\nFirst satisfy every acceptance criterion, then report verification evidence.",
        f"{seed_prompt}\nUse a deterministic, structured response with explicit assumptions and checks.",
        f"{seed_prompt}\nDo not expose secrets. Prefer the smallest correct change or answer.",
    ]
    return variants[:count]


def _split_stats(
    report: dict[str, object], variant: str, split: str
) -> tuple[int, int, int]:
    rows = [
        row
        for row in report.get("tasks", [])
        if isinstance(row, dict)
        and row.get("variant") == variant
        and row.get("split") == split
    ]
    quality = sum(1 for row in rows if row.get("quality_accepted") is True)
    net_tokens = sum(
        int(row.get("tokens", {}).get("net_total", 0))
        for row in rows
        if isinstance(row.get("tokens"), dict)
    )
    return quality, len(rows), net_tokens


def evaluate_candidate(
    baseline_report: dict[str, object],
    candidate_report: dict[str, object],
    *,
    quality_floor: float = 1.0,
) -> dict[str, object]:
    """Apply quality-floor and holdout gates; never writes source files."""
    if not 0.0 <= quality_floor <= 1.0:
        raise ValueError("quality_floor must be between 0 and 1")
    details: dict[str, object] = {}
    approved = True
    reasons: list[str] = []
    for split in ("train", "holdout"):
        baseline_quality, baseline_tasks, baseline_tokens = _split_stats(
            baseline_report, "baseline", split
        )
        candidate_quality, candidate_tasks, candidate_tokens = _split_stats(
            candidate_report, "candidate", split
        )
        candidate_ratio = (
            candidate_quality / candidate_tasks if candidate_tasks else 0.0
        )
        quality_not_regressed = candidate_quality >= baseline_quality
        floor_passed = candidate_tasks > 0 and candidate_ratio >= quality_floor
        if not floor_passed:
            approved = False
            reasons.append(f"{split} quality floor failed")
        if not quality_not_regressed:
            approved = False
            reasons.append(f"{split} quality regressed")
        details[split] = {
            "baseline_quality": baseline_quality,
            "baseline_tasks": baseline_tasks,
            "baseline_net_tokens": baseline_tokens,
            "candidate_quality": candidate_quality,
            "candidate_tasks": candidate_tasks,
            "candidate_net_tokens": candidate_tokens,
            "candidate_quality_ratio": round(candidate_ratio, 6),
            "quality_floor": quality_floor,
            "floor_passed": floor_passed,
            "quality_not_regressed": quality_not_regressed,
        }
    baseline_total = sum(
        int(item["baseline_net_tokens"])
        for item in details.values()
        if isinstance(item, dict)
    )
    candidate_total = sum(
        int(item["candidate_net_tokens"])
        for item in details.values()
        if isinstance(item, dict)
    )
    quality_improved = any(
        int(item["candidate_quality"]) > int(item["baseline_quality"])
        for item in details.values()
        if isinstance(item, dict)
    )
    token_improved = candidate_total < baseline_total
    if not quality_improved and not token_improved:
        approved = False
        reasons.append("candidate does not improve quality or net-token cost")
    return {
        "approved": approved,
        "reasons": reasons,
        "quality_first": True,
        "auto_apply": False,
        "details": details,
        "net_token_delta": candidate_total - baseline_total,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    export = subparsers.add_parser("export")
    export.add_argument("--dataset", type=Path, required=True)
    export.add_argument("--report", type=Path)
    export.add_argument("--output", type=Path, required=True)
    propose = subparsers.add_parser("propose")
    propose.add_argument("--prompt", required=True)
    propose.add_argument("--count", type=int, default=3)
    propose.add_argument("--output", type=Path, required=True)
    select = subparsers.add_parser("select")
    select.add_argument("--dataset", type=Path, required=True)
    select.add_argument("--baseline-report", type=Path, required=True)
    select.add_argument("--candidate-report", type=Path, required=True)
    select.add_argument("--quality-floor", type=float, default=1.0)
    select.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run an offline GEPA export/proposal/selection operation."""
    args = _parser().parse_args(argv)
    if args.command == "export":
        dataset = load_dataset(args.dataset)
        report = (
            json.loads(args.report.read_text(encoding="utf-8")) if args.report else None
        )
        payload = export_gepa_payload(dataset, report)
    elif args.command == "propose":
        payload = {
            "auto_apply": False,
            "candidates": generate_prompt_candidates(args.prompt, args.count),
        }
    else:
        dataset = load_dataset(args.dataset)
        del dataset  # Validate the dataset before accepting a report.
        baseline = json.loads(args.baseline_report.read_text(encoding="utf-8"))
        candidate = json.loads(args.candidate_report.read_text(encoding="utf-8"))
        payload = evaluate_candidate(
            baseline, candidate, quality_floor=args.quality_floor
        )
    args.output.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
