"""T1 baseline — B1-B6 contract parity across two clean git snapshots.

Runs the frozen B1-B6 contract blocks against each configuration snapshot
with a fixed repetition count and an alternating configuration order,
recording tokens / latency / tool calls / result per run. Reports carry no
cost (currency) field and no JEVS metric — both are deliberately excluded
(see ``EXCLUDED_METRICS``). Live model runs require a provider; without one
the harness still produces a deterministic offline static baseline.
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import tempfile
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractContextManager, nullcontext
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Final

from . import executor
from .dataset import Acceptance, Budget, Task
from .executor import Execution
from .metrics import estimate_tokens, output_fingerprint

SCHEMA_VERSION: Final[str] = "pantheon.t1-baseline.v1"
BLOCK_IDS: Final[tuple[str, ...]] = ("B1", "B2", "B3", "B4", "B5", "B6")
EXCLUDED_METRICS: Final[tuple[str, ...]] = ("currency", "JEVS")
DEFAULT_CONTRACT: Final[Path] = (
    Path(__file__).with_name("fixtures") / "contract-b1-b6.json"
)

Sampler = Callable[["Block", "RunPlan", Path], "Sample"]
WorkspaceFor = Callable[[str], AbstractContextManager[Path]]


class T1Error(ValueError):
    """Raised when the T1 baseline cannot be produced."""


class ContractError(T1Error):
    """Raised when the frozen contract is malformed."""


@dataclass(frozen=True)
class Thresholds:
    """Gate tolerances frozen after the T1 milestone."""

    tokens_pct: float
    latency_pct: float
    quality_pp: float


@dataclass(frozen=True)
class Block:
    """One B1-B6 contract block and its canonical sources."""

    block_id: str
    name: str
    scope: str
    sources: tuple[str, ...]


@dataclass(frozen=True)
class Contract:
    """The frozen B1-B6 contract."""

    schema_version: str
    frozen: bool
    freeze_flag: str
    source: str
    thresholds: Thresholds
    snapshots: dict[str, str]
    exclude: tuple[str, ...]
    repetitions: int
    blocks: tuple[Block, ...]


@dataclass(frozen=True)
class RunPlan:
    """One scheduled run: a block against a configuration."""

    block_id: str
    config: str
    repetition: int
    order_index: int


@dataclass(frozen=True)
class Sample:
    """A single measured run."""

    block_id: str
    config: str
    repetition: int
    tokens: int
    latency_ms: int
    tool_calls: int
    result: str
    accepted: bool


@dataclass(frozen=True)
class RunOptions:
    """Execution options that are not part of the contract."""

    configs: tuple[str, ...] = ("base", "head")
    repetitions: int | None = None
    mode: str = "offline"
    measurement_source: str = "offline_static"
    binary: str = "opencode"


def _as_dict(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be an object")
    return {str(key): item for key, item in value.items()}


def _required_str(data: Mapping[str, object], key: str, label: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{label}.{key} must be a non-empty string")
    return value


def _required_number(data: Mapping[str, object], key: str, label: str) -> float:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ContractError(f"{label}.{key} must be a non-negative number")
    return float(value)


def _required_int(
    data: Mapping[str, object], key: str, label: str, minimum: int
) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ContractError(f"{label}.{key} must be an integer >= {minimum}")
    return value


def _string_list(value: object, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ContractError(f"{label} must be a list of strings")
    return tuple(value)


def validate_contract(data: object) -> Contract:
    """Validate raw contract JSON and return a typed contract."""
    root = _as_dict(data, "contract")
    thresholds_data = _as_dict(root.get("thresholds"), "contract.thresholds")
    snapshots_data = _as_dict(root.get("snapshots"), "contract.snapshots")
    blocks_value = root.get("blocks")
    if not isinstance(blocks_value, list):
        raise ContractError("contract.blocks must be a list")
    blocks: list[Block] = []
    for index, item in enumerate(blocks_value):
        label = f"contract.blocks[{index}]"
        block = _as_dict(item, label)
        blocks.append(
            Block(
                block_id=_required_str(block, "id", label),
                name=_required_str(block, "name", label),
                scope=_required_str(block, "scope", label),
                sources=_string_list(block.get("sources"), f"{label}.sources"),
            )
        )
    if tuple(block.block_id for block in blocks) != BLOCK_IDS:
        raise ContractError(f"contract block ids must be exactly {list(BLOCK_IDS)}")
    for name in ("base", "head"):
        if not snapshots_data.get(name):
            raise ContractError(f"contract.snapshots.{name} must be declared")
    snapshots = {
        key: _required_str(snapshots_data, key, "contract.snapshots")
        for key in ("base", "head")
    }
    return Contract(
        schema_version=_required_str(root, "schema_version", "contract"),
        frozen=bool(root.get("frozen")),
        freeze_flag=_required_str(root, "freeze_flag", "contract"),
        source=_required_str(root, "source", "contract"),
        thresholds=Thresholds(
            tokens_pct=_required_number(thresholds_data, "tokens_pct", "thresholds"),
            latency_pct=_required_number(thresholds_data, "latency_pct", "thresholds"),
            quality_pp=_required_number(thresholds_data, "quality_pp", "thresholds"),
        ),
        snapshots=snapshots,
        exclude=_string_list(root.get("exclude_metrics"), "contract.exclude_metrics"),
        repetitions=_required_int(root, "repetitions", "contract", 1),
        blocks=tuple(blocks),
    )


def load_contract(path: Path) -> Contract:
    """Load and validate the frozen contract JSON."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot load contract {path}: {exc}") from exc
    return validate_contract(data)


def build_schedule(
    contract: Contract, configs: Sequence[str], repetitions: int | None = None
) -> tuple[RunPlan, ...]:
    """Build the rep/alternating-order schedule for every block."""
    reps = contract.repetitions if repetitions is None else repetitions
    order_configs = tuple(configs)
    plans: list[RunPlan] = []
    for repetition in range(reps):
        order = order_configs if repetition % 2 == 0 else tuple(reversed(order_configs))
        for block in contract.blocks:
            for order_index, config in enumerate(order):
                plans.append(RunPlan(block.block_id, config, repetition, order_index))
    return tuple(plans)


def expand_sources(workspace: Path, sources: Sequence[str]) -> tuple[Path, ...]:
    """Return every existing file matched by the block's source patterns."""
    matched: set[Path] = set()
    for pattern in sources:
        matched.update(path for path in workspace.glob(pattern) if path.is_file())
    return tuple(sorted(matched))


def materialize_snapshot(
    repo_root: Path,
    commit: str,
    dest: Path,
    include_paths: Sequence[str] = (),
) -> Path:
    """Extract a clean (tracked-only) snapshot of ``commit`` into ``dest``."""
    target = Path(dest)
    target.mkdir(parents=True, exist_ok=True)
    command = ["git", "archive", "--format=tar", commit]
    if include_paths:
        command.extend(("--", *include_paths))
    archive = subprocess.run(
        command, cwd=str(repo_root), capture_output=True, check=True
    ).stdout
    subprocess.run(["tar", "-x", "-C", str(target)], input=archive, check=True)
    return target


def materialize_configs(
    repo_root: Path,
    contract: Contract,
    base_dir: Path,
    configs: Sequence[str],
) -> dict[str, Path]:
    """Materialize one clean workspace per configuration."""
    return {
        config: materialize_snapshot(
            repo_root, contract.snapshots[config], Path(base_dir) / config
        )
        for config in configs
    }


def static_sample(block: Block, plan: RunPlan, workspace: Path) -> Sample:
    """Deterministic offline sample from a block's canonical sources."""
    contents = [
        path.read_text(encoding="utf-8", errors="replace")
        for path in expand_sources(Path(workspace), block.sources)
    ]
    text = "".join(contents)
    return Sample(
        block_id=block.block_id,
        config=plan.config,
        repetition=plan.repetition,
        tokens=estimate_tokens(text),
        latency_ms=0,
        tool_calls=0,
        result=output_fingerprint(text)[:16],
        accepted=bool(contents),
    )


def sample_from_execution(
    block: Block, plan: RunPlan, execution: Execution, quality: object | None
) -> Sample:
    """Map a live execution (+ optional quality result) into a sample."""
    accepted = bool(getattr(quality, "accepted", False))
    return Sample(
        block_id=block.block_id,
        config=plan.config,
        repetition=plan.repetition,
        tokens=execution.usage.net_tokens,
        latency_ms=execution.latency_ms,
        tool_calls=execution.tool_calls,
        result=output_fingerprint(execution.output)[:16],
        accepted=accepted,
    )


def _block_prompt(block: Block) -> str:
    return (
        f"Contract {block.block_id} ({block.name}): {block.scope}. "
        "List the canonical source files that define this contract."
    )


def _literal_fragments(sources: Sequence[str]) -> tuple[str, ...]:
    return tuple(source.split("*")[0].rstrip("/") for source in sources)


def _block_task(block: Block) -> Task:
    return Task(
        task_id=block.block_id,
        agent="themis",
        skill="contract-baseline",
        prompt=_block_prompt(block),
        criteria=(),
        acceptance=Acceptance(
            required_fragments=_literal_fragments(block.sources), json_paths=()
        ),
        verification=(),
        budget=Budget(max_total_tokens=200_000, max_latency_ms=120_000, max_retries=0),
        split="train",
    )


def opencode_sampler(binary: str) -> Sampler:
    """Build a live sampler that runs OpenCode for one block."""

    def sampler(block: Block, plan: RunPlan, workspace: Path) -> Sample:
        task = _block_task(block)
        root = Path(workspace)
        execution = executor.run_opencode(binary, _block_prompt(block), task, root)
        quality = (
            executor.evaluate_quality(task, execution.output, root)
            if execution.returncode == 0
            else None
        )
        return sample_from_execution(block, plan, execution, quality)

    return sampler


def aggregate_key(block_id: str, config: str) -> str:
    """Return the stable aggregate row key for a block/config pair."""
    return f"{block_id}:{config}"


def aggregate_samples(samples: Sequence[Sample]) -> dict[str, dict[str, float]]:
    """Aggregate samples into per-(block, config) medians and rates."""
    groups: dict[str, list[Sample]] = {}
    for sample in samples:
        groups.setdefault(aggregate_key(sample.block_id, sample.config), []).append(
            sample
        )
    aggregate: dict[str, dict[str, float]] = {}
    for key, rows in sorted(groups.items()):
        tokens = [row.tokens for row in rows]
        latency = [row.latency_ms for row in rows]
        tools = [row.tool_calls for row in rows]
        aggregate[key] = {
            "samples": float(len(rows)),
            "tokens_median": float(statistics.median(tokens)),
            "tokens_min": float(min(tokens)),
            "tokens_max": float(max(tokens)),
            "latency_median": float(statistics.median(latency)),
            "tool_calls_median": float(statistics.median(tools)),
            "acceptance_rate": sum(1 for row in rows if row.accepted) / len(rows),
            "distinct_results": float(len({row.result for row in rows})),
        }
    return aggregate


def _pct_delta(base: float, head: float) -> float | None:
    if base <= 0:
        return None
    return round((head - base) / base * 100, 4)


def evaluate_parity(
    aggregate: Mapping[str, dict[str, float]], thresholds: Thresholds
) -> dict[str, object]:
    """Compare head against base per block using the frozen thresholds."""
    block_ids = sorted({key.split(":", 1)[0] for key in aggregate})
    blocks: dict[str, object] = {}
    overall = "within"
    for block_id in block_ids:
        base = aggregate.get(aggregate_key(block_id, "base"))
        head = aggregate.get(aggregate_key(block_id, "head"))
        if base is None or head is None:
            blocks[block_id] = {"verdict": "insufficient", "breaches": []}
            continue
        delta_tokens = _pct_delta(base["tokens_median"], head["tokens_median"])
        delta_latency = _pct_delta(base["latency_median"], head["latency_median"])
        delta_quality = round(
            (head["acceptance_rate"] - base["acceptance_rate"]) * 100, 4
        )
        breaches: list[str] = []
        if delta_tokens is not None and delta_tokens > thresholds.tokens_pct:
            breaches.append("tokens")
        if delta_latency is not None and delta_latency > thresholds.latency_pct:
            breaches.append("latency")
        if delta_quality < -thresholds.quality_pp:
            breaches.append("quality")
        if breaches:
            overall = "breach"
        blocks[block_id] = {
            "delta_tokens_pct": delta_tokens,
            "delta_latency_pct": delta_latency,
            "delta_quality_pp": delta_quality,
            "verdict": "breach" if breaches else "within",
            "breaches": breaches,
        }
    return {
        "blocks": blocks,
        "overall": overall,
        "thresholds": asdict(thresholds),
    }


def _excluded(text: str) -> bool:
    lowered = text.lower()
    return any(token.lower() in lowered for token in EXCLUDED_METRICS)


def contains_excluded_metrics(value: object) -> bool:
    """Return True if a currency or JEVS metric leaked into the report."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == "exclude_metrics":
                continue
            if _excluded(str(key)) or contains_excluded_metrics(item):
                return True
        return False
    if isinstance(value, (list, tuple)):
        return any(contains_excluded_metrics(item) for item in value)
    if isinstance(value, str):
        return _excluded(value)
    return False


def _comparison_gate(options: RunOptions) -> dict[str, object]:
    if options.mode == "live":
        return {"eligible": True, "reason": None}
    return {
        "eligible": False,
        "reason": "offline static baseline — no live model measurement",
    }


def build_report(
    contract: Contract,
    options: RunOptions,
    samples: Sequence[Sample],
    aggregate: Mapping[str, dict[str, float]],
    parity: Mapping[str, object],
) -> dict[str, object]:
    """Assemble the report, refusing to emit excluded metrics."""
    repetitions = (
        contract.repetitions if options.repetitions is None else options.repetitions
    )
    report: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "mode": options.mode,
        "measurement_source": options.measurement_source,
        "contract": {
            "schema_version": contract.schema_version,
            "frozen": contract.frozen,
            "freeze_flag": contract.freeze_flag,
            "source": contract.source,
            "thresholds": asdict(contract.thresholds),
            "snapshots": dict(contract.snapshots),
        },
        "exclude_metrics": list(contract.exclude),
        "configs": list(options.configs),
        "repetitions": repetitions,
        "sample_count": len(samples),
        "samples": [asdict(sample) for sample in samples],
        "aggregate": {key: dict(row) for key, row in aggregate.items()},
        "parity": dict(parity),
        "comparison_gate": _comparison_gate(options),
    }
    if contains_excluded_metrics(report):
        raise T1Error("report contains an excluded metric (currency/JEVS)")
    return report


def run_t1(
    contract: Contract,
    workspace_for: WorkspaceFor,
    sampler: Sampler,
    options: RunOptions | None = None,
) -> dict[str, object]:
    """Run the full B1-B6 schedule and return the baseline report."""
    resolved = options or RunOptions()
    plans = build_schedule(contract, resolved.configs, resolved.repetitions)
    blocks = {block.block_id: block for block in contract.blocks}
    samples: list[Sample] = []
    for plan in plans:
        with workspace_for(plan.config) as workspace:
            samples.append(sampler(blocks[plan.block_id], plan, Path(workspace)))
    collected = tuple(samples)
    aggregate = aggregate_samples(collected)
    parity = evaluate_parity(aggregate, contract.thresholds)
    return build_report(contract, resolved, collected, aggregate, parity)


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _cell(value: object, suffix: str = "") -> str:
    number = _number(value)
    return "n/a" if number is None else f"{number:g}{suffix}"


def _join_excluded(value: object) -> str:
    if isinstance(value, (list, tuple)):
        return ", ".join(str(item) for item in value)
    return ""


def _offline_caveats(report: Mapping[str, object]) -> list[str]:
    """Return the offline-static caveats; live reports carry none.

    Offline numbers estimate the canonical **source** size rather than live
    model usage, so a negative token delta is source shrinkage — never a
    model/token-cost saving.
    """
    if report.get("mode") != "offline":
        return []
    blocks = _mapping(_mapping(report.get("parity")).get("blocks"))
    shrunk = sorted(
        block_id
        for block_id, row in blocks.items()
        if (_number(_mapping(row).get("delta_tokens_pct")) or 0.0) < 0.0
    )
    lines = [
        "## Caveats (offline static)",
        "",
        "- Numbers estimate canonical **source** size (`estimate_tokens`), not "
        "live model usage.",
    ]
    if shrunk:
        lines.append(
            f"- Negative token delta ({', '.join(shrunk)}) is **source shrink**, "
            "not a model/token-cost saving."
        )
    lines += [
        "- The comparison gate stays **ineligible** until a live run "
        "(`--mode live`) with a provider (`*_API_KEY`) measures real usage.",
        "",
    ]
    return lines


def render_markdown(report: Mapping[str, object]) -> str:
    """Render a stable human-readable baseline report."""
    contract = _mapping(report.get("contract"))
    snapshots = _mapping(contract.get("snapshots"))
    gate = _mapping(report.get("comparison_gate"))
    parity = _mapping(report.get("parity"))
    lines = [
        "# Pantheon T1 baseline",
        "",
        f"- Mode: `{report.get('mode')}`",
        f"- Measurement source: `{report.get('measurement_source')}`",
        f"- Repetitions: `{report.get('repetitions')}`",
        f"- Frozen: `{contract.get('frozen')}` (`{contract.get('freeze_flag')}`)",
        f"- Snapshots: base `{snapshots.get('base')}` → head `{snapshots.get('head')}`",
        f"- Comparison gate: eligible `{gate.get('eligible')}` "
        f"({gate.get('reason') or 'live'})",
        f"- Excluded metrics: {_join_excluded(report.get('exclude_metrics'))}",
        "",
        "## Parity (higher tokens/latency and lower quality are regressions)",
        "",
        "| Block | Δ tokens % | Δ latency % | Δ quality pp | Verdict |",
        "|---|---:|---:|---:|---|",
    ]
    for block_id, row_value in sorted(_mapping(parity.get("blocks")).items()):
        row = _mapping(row_value)
        lines.append(
            f"| {block_id} | {_cell(row.get('delta_tokens_pct'))} | "
            f"{_cell(row.get('delta_latency_pct'))} | "
            f"{_cell(row.get('delta_quality_pp'))} | {row.get('verdict')} |"
        )
    lines += ["", f"Overall: **{parity.get('overall')}**", ""]
    lines += _offline_caveats(report)
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    """Build the T1 baseline CLI parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument(
        "--repo", type=Path, default=Path(__file__).resolve().parents[2]
    )
    parser.add_argument("--mode", choices=("offline", "live"), default="offline")
    parser.add_argument("--repetitions", type=int, default=None)
    parser.add_argument("--binary", default="opencode")
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--output-markdown", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the T1 baseline from the command line."""
    args = build_parser().parse_args(argv)
    try:
        contract = load_contract(args.contract)
    except (OSError, ContractError) as exc:
        print(f"t1 baseline error: {exc}")
        return 2
    configs = tuple(contract.snapshots)
    options = RunOptions(
        configs=configs,
        repetitions=args.repetitions,
        mode=args.mode,
        measurement_source="opencode" if args.mode == "live" else "offline_static",
        binary=args.binary,
    )
    sampler = opencode_sampler(args.binary) if args.mode == "live" else static_sample
    with tempfile.TemporaryDirectory(prefix="pantheon-t1-") as temp_dir:
        paths = materialize_configs(args.repo, contract, Path(temp_dir), configs)

        def workspace_for(config: str) -> AbstractContextManager[Path]:
            return nullcontext(paths[config])

        report = run_t1(contract, workspace_for, sampler, options)
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
