"""Offline contract tests for the T1 B1-B6 baseline harness."""

from __future__ import annotations

import json
import subprocess
from contextlib import nullcontext
from pathlib import Path

import pytest

from . import executor as executor_module
from . import t1
from .metrics import usage_from_payload

REPO_ROOT = Path(__file__).resolve().parents[2]
THRESHOLDS_TOKENS = 20.0
THRESHOLDS_LATENCY = 10.0
THRESHOLDS_QUALITY = 5.0
EXPECTED_BLOCKS = 6


def _write_contract(tmp_path: Path, data: dict) -> Path:
    path = tmp_path / "contract.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def _minimal_contract(**overrides: object) -> dict:
    contract = {
        "schema_version": "pantheon.contract.b1-b6.v1",
        "frozen": True,
        "freeze_flag": "congela-pos-T1",
        "source": "test",
        "exclude_metrics": ["currency", "JEVS"],
        "thresholds": {"tokens_pct": 20, "latency_pct": 10, "quality_pp": 5},
        "snapshots": {"base": "aaaaaaa", "head": "bbbbbbb"},
        "repetitions": 5,
        "blocks": [
            {"id": "B1", "name": "one", "scope": "s1", "sources": ["a.txt"]},
            {"id": "B2", "name": "two", "scope": "s2", "sources": ["b.txt"]},
            {"id": "B3", "name": "three", "scope": "s3", "sources": ["c.txt"]},
            {"id": "B4", "name": "four", "scope": "s4", "sources": ["d.txt"]},
            {"id": "B5", "name": "five", "scope": "s5", "sources": ["e.txt"]},
            {"id": "B6", "name": "six", "scope": "s6", "sources": ["f.txt"]},
        ],
    }
    contract.update(overrides)
    return contract


def test_default_contract_loads_nominal_blocks() -> None:
    contract = t1.load_contract(t1.DEFAULT_CONTRACT)
    assert contract.frozen is True
    assert contract.freeze_flag == "congela-pos-T1"
    assert [block.block_id for block in contract.blocks] == list(t1.BLOCK_IDS)
    assert contract.thresholds.tokens_pct == THRESHOLDS_TOKENS
    assert contract.thresholds.latency_pct == THRESHOLDS_LATENCY
    assert contract.thresholds.quality_pp == THRESHOLDS_QUALITY
    assert contract.snapshots["base"] == "850191c"
    assert contract.snapshots["head"] == "18adb64"
    assert contract.exclude == ("currency", "JEVS")
    assert contract.repetitions == 5


def test_load_contract_rejects_wrong_block_ids(tmp_path: Path) -> None:
    data = _minimal_contract()
    data["blocks"][0]["id"] = "B9"
    with pytest.raises(t1.ContractError):
        t1.load_contract(_write_contract(tmp_path, data))


def test_load_contract_rejects_missing_thresholds(tmp_path: Path) -> None:
    data = _minimal_contract()
    data["thresholds"] = {"tokens_pct": 20}
    with pytest.raises(t1.ContractError):
        t1.load_contract(_write_contract(tmp_path, data))


def test_build_schedule_alternates_config_order() -> None:
    contract = t1.load_contract(t1.DEFAULT_CONTRACT)
    schedule = t1.build_schedule(contract, ("base", "head"), repetitions=2)
    assert len(schedule) == EXPECTED_BLOCKS * 2 * 2
    rep_zero = [plan.config for plan in schedule if plan.repetition == 0]
    rep_one = [plan.config for plan in schedule if plan.repetition == 1]
    assert rep_zero == ["base", "head"] * EXPECTED_BLOCKS
    assert rep_one == ["head", "base"] * EXPECTED_BLOCKS
    assert {plan.order_index for plan in schedule} == {0, 1}


def test_build_schedule_respects_repetition_override() -> None:
    contract = t1.load_contract(t1.DEFAULT_CONTRACT)
    schedule = t1.build_schedule(contract, ("base", "head"), repetitions=1)
    assert len(schedule) == EXPECTED_BLOCKS * 2


def test_expand_sources_matches_globs(tmp_path: Path) -> None:
    (tmp_path / "agents").mkdir()
    (tmp_path / "agents" / "a.md").write_text("a", encoding="utf-8")
    (tmp_path / "agents" / "b.md").write_text("bb", encoding="utf-8")
    matched = t1.expand_sources(tmp_path, ("agents/*.md", "missing/*.md"))
    assert [path.name for path in matched] == ["a.md", "b.md"]


def test_static_sample_estimates_tokens_and_fingerprint(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "routing.yml").write_text("abcdefgh", encoding="utf-8")
    block = t1.Block("B2", "Routing", "scope", ("src/routing.yml",))
    plan = t1.RunPlan("B2", "base", 0, 0)
    sample = t1.static_sample(block, plan, tmp_path)
    assert sample.tokens == 2  # ceil(8 / 4)
    assert sample.accepted is True
    assert sample.result == t1.output_fingerprint("abcdefgh")[:16]


def test_static_sample_flags_missing_sources(tmp_path: Path) -> None:
    block = t1.Block("B5", "Version", "scope", ("package.json",))
    plan = t1.RunPlan("B5", "head", 0, 0)
    sample = t1.static_sample(block, plan, tmp_path)
    assert sample.tokens == 0
    assert sample.accepted is False


def _sample(block_id: str, config: str, tokens: int, accepted: bool) -> t1.Sample:
    return t1.Sample(block_id, config, 0, tokens, 5, 1, "r" + config, accepted)


def test_aggregate_samples_medians_and_acceptance() -> None:
    samples = (
        _sample("B1", "base", 100, True),
        _sample("B1", "base", 120, True),
        _sample("B1", "head", 130, False),
    )
    aggregate = t1.aggregate_samples(samples)
    key = t1.aggregate_key("B1", "base")
    assert aggregate[key]["tokens_median"] == 110
    assert aggregate[key]["samples"] == 2
    assert aggregate[key]["acceptance_rate"] == 1.0
    assert aggregate[t1.aggregate_key("B1", "head")]["acceptance_rate"] == 0.0
    assert aggregate[key]["distinct_results"] == 1


def test_evaluate_parity_flags_breaches() -> None:
    samples = (
        _sample("B1", "base", 100, True),
        _sample("B1", "head", 130, False),
    )
    parity = t1.evaluate_parity(
        t1.aggregate_samples(samples),
        t1.Thresholds(THRESHOLDS_TOKENS, THRESHOLDS_LATENCY, THRESHOLDS_QUALITY),
    )
    assert parity["overall"] == "breach"
    assert "tokens" in parity["blocks"]["B1"]["breaches"]
    assert "quality" in parity["blocks"]["B1"]["breaches"]
    assert parity["blocks"]["B1"]["delta_tokens_pct"] == pytest.approx(30.0)


def test_evaluate_parity_within_thresholds() -> None:
    samples = (
        _sample("B1", "base", 100, True),
        _sample("B1", "head", 105, True),
    )
    parity = t1.evaluate_parity(
        t1.aggregate_samples(samples),
        t1.Thresholds(THRESHOLDS_TOKENS, THRESHOLDS_LATENCY, THRESHOLDS_QUALITY),
    )
    assert parity["overall"] == "within"
    assert parity["blocks"]["B1"]["breaches"] == []


def test_evaluate_parity_handles_zero_base() -> None:
    samples = (
        _sample("B1", "base", 0, True),
        _sample("B1", "head", 10, True),
    )
    parity = t1.evaluate_parity(
        t1.aggregate_samples(samples),
        t1.Thresholds(THRESHOLDS_TOKENS, THRESHOLDS_LATENCY, THRESHOLDS_QUALITY),
    )
    assert parity["blocks"]["B1"]["delta_tokens_pct"] is None
    assert "tokens" not in parity["blocks"]["B1"]["breaches"]


def test_contains_excluded_metrics_detects_forbidden_keys() -> None:
    assert t1.contains_excluded_metrics({"currency": 1}) is True
    assert t1.contains_excluded_metrics({"nested": {"JEVS": 2}}) is True
    assert t1.contains_excluded_metrics({"note": "cost in JEVS"}) is True
    assert t1.contains_excluded_metrics({"tokens": {"net_total": 4}}) is False
    assert (
        t1.contains_excluded_metrics(
            {"exclude_metrics": ["currency", "JEVS"], "net_total": 4}
        )
        is False
    )


def test_build_report_shape_and_offline_gate() -> None:
    contract = t1.load_contract(t1.DEFAULT_CONTRACT)
    samples = tuple(
        _sample(block_id, config, 100, True)
        for block_id in t1.BLOCK_IDS
        for config in ("base", "head")
    )
    aggregate = t1.aggregate_samples(samples)
    parity = t1.evaluate_parity(aggregate, contract.thresholds)
    report = t1.build_report(
        contract,
        t1.RunOptions(configs=("base", "head"), mode="offline"),
        samples,
        aggregate,
        parity,
    )
    assert report["schema_version"] == "pantheon.t1-baseline.v1"
    assert report["sample_count"] == EXPECTED_BLOCKS * 2
    assert report["comparison_gate"]["eligible"] is False
    assert report["contract"]["freeze_flag"] == "congela-pos-T1"
    assert t1.contains_excluded_metrics(report) is False


def test_render_markdown_lists_blocks() -> None:
    contract = t1.load_contract(t1.DEFAULT_CONTRACT)
    samples = tuple(
        _sample(block_id, config, 100, True)
        for block_id in t1.BLOCK_IDS
        for config in ("base", "head")
    )
    report = t1.build_report(
        contract,
        t1.RunOptions(configs=("base", "head")),
        samples,
        t1.aggregate_samples(samples),
        t1.evaluate_parity(t1.aggregate_samples(samples), contract.thresholds),
    )
    markdown = t1.render_markdown(report)
    assert markdown.startswith("# Pantheon T1 baseline")
    for block_id in t1.BLOCK_IDS:
        assert f"| {block_id} |" in markdown
    # Offline reports must state the source-size caveat, never a model saving.
    assert "## Caveats (offline static)" in markdown
    assert "*_API_KEY" in markdown
    shrunk_samples = tuple(
        _sample(
            block_id, config, 69 if (block_id, config) == ("B6", "head") else 100, True
        )
        for block_id in t1.BLOCK_IDS
        for config in ("base", "head")
    )
    shrunk_agg = t1.aggregate_samples(shrunk_samples)
    shrunk_report = t1.build_report(
        contract,
        t1.RunOptions(configs=("base", "head")),
        shrunk_samples,
        shrunk_agg,
        t1.evaluate_parity(shrunk_agg, contract.thresholds),
    )
    shrunk_markdown = t1.render_markdown(shrunk_report)
    assert "source shrink" in shrunk_markdown
    assert "B6" in shrunk_markdown


def test_materialize_snapshot_extracts_clean_tree(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    (repo / "a.txt").write_text("hello", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "x"], cwd=repo, check=True)
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    dest = tmp_path / "snap"
    t1.materialize_snapshot(repo, sha, dest)
    assert (dest / "a.txt").read_text(encoding="utf-8") == "hello"
    assert not (dest / ".git").exists()


def test_run_t1_end_to_end_with_fake_sampler(tmp_path: Path) -> None:
    contract = t1.load_contract(t1.DEFAULT_CONTRACT)

    def fake_sampler(block: t1.Block, plan: t1.RunPlan, workspace: Path) -> t1.Sample:
        tokens = 100 if plan.config == "base" else 130
        return t1.Sample(
            block.block_id, plan.config, plan.repetition, tokens, 5, 1, "r", True
        )

    report = t1.run_t1(
        contract,
        workspace_for=lambda _config: nullcontext(tmp_path),
        sampler=fake_sampler,
        options=t1.RunOptions(configs=("base", "head"), repetitions=2),
    )
    assert report["sample_count"] == EXPECTED_BLOCKS * 2 * 2
    assert report["parity"]["overall"] == "breach"
    assert report["configs"] == ["base", "head"]


def test_sample_from_execution_maps_usage_and_quality() -> None:
    block = t1.Block("B1", "one", "scope", ("src/agents/*.md",))
    plan = t1.RunPlan("B1", "base", 0, 0)
    usage = usage_from_payload({"usage": {"input": 10, "output": 5}}, "p", "o")
    execution = t1.Execution("out", {}, usage, 42, 1, 0, 3, 0, None)
    sample = t1.sample_from_execution(block, plan, execution, None)
    assert sample.tokens == execution.usage.net_tokens
    assert sample.latency_ms == 42
    assert sample.tool_calls == 3
    assert sample.accepted is False


def test_opencode_sampler_delegates_to_executor(monkeypatch, tmp_path: Path) -> None:
    block = t1.Block("B1", "one", "scope", ("src/routing.yml",))
    plan = t1.RunPlan("B1", "head", 0, 0)
    usage = usage_from_payload({"usage": {"input": 10, "output": 5}}, "p", "o")
    fake = t1.Execution("out", {}, usage, 7, 1, 0, 2, 0, None, False)
    monkeypatch.setattr(executor_module, "run_opencode", lambda *a, **k: fake)
    monkeypatch.setattr(executor_module, "evaluate_quality", lambda *a, **k: None)
    sample = t1.opencode_sampler("opencode")(block, plan, tmp_path)
    assert sample.latency_ms == 7
    assert sample.tool_calls == 2
    assert sample.config == "head"


def test_main_offline_writes_reports(tmp_path: Path) -> None:
    out_json = tmp_path / "report.json"
    out_md = tmp_path / "report.md"
    rc = t1.main(
        [
            "--repo",
            str(REPO_ROOT),
            "--repetitions",
            "1",
            "--output-json",
            str(out_json),
            "--output-markdown",
            str(out_md),
        ]
    )
    assert rc == 0
    report = json.loads(out_json.read_text(encoding="utf-8"))
    assert report["sample_count"] == EXPECTED_BLOCKS * 2
    assert report["mode"] == "offline"
    assert t1.contains_excluded_metrics(report) is False
    assert out_md.read_text(encoding="utf-8").startswith("# Pantheon T1 baseline")


def test_load_contract_rejects_non_numeric_threshold(tmp_path: Path) -> None:
    data = _minimal_contract()
    data["thresholds"]["tokens_pct"] = "20"
    with pytest.raises(t1.ContractError):
        t1.load_contract(_write_contract(tmp_path, data))


def test_load_contract_rejects_missing_snapshot(tmp_path: Path) -> None:
    data = _minimal_contract()
    del data["snapshots"]["base"]
    with pytest.raises(t1.ContractError):
        t1.load_contract(_write_contract(tmp_path, data))


def test_build_report_live_gate_is_eligible() -> None:
    contract = t1.load_contract(t1.DEFAULT_CONTRACT)
    report = t1.build_report(
        contract,
        t1.RunOptions(mode="live", measurement_source="opencode"),
        (),
        t1.aggregate_samples(()),
        t1.evaluate_parity({}, contract.thresholds),
    )
    assert report["comparison_gate"]["eligible"] is True


def test_main_prints_markdown_without_output_paths(capsys) -> None:
    rc = t1.main(["--repo", str(REPO_ROOT), "--repetitions", "1"])
    assert rc == 0
    assert capsys.readouterr().out.startswith("# Pantheon T1 baseline")
