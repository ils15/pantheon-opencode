"""Offline contract tests for the beta2 benchmark."""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from . import executor as executor_module
from . import gepa as gepa_module
from . import runner as runner_module
from .dataset import AGENT_IDS, Acceptance, DatasetError, Verification, load_dataset
from .executor import _parse_json_output, evaluate_quality, run_fixture
from .gepa import evaluate_candidate, export_gepa_payload, generate_prompt_candidates
from .metrics import redact_text, tool_call_count, usage_from_payload
from .runner import load_fixture_responses, run_benchmark

ROOT = Path(__file__).parent
DATASET_PATH = ROOT / "dataset.json"
RESPONSES_PATH = ROOT / "fixtures" / "responses.json"
RUN_PATH = ROOT / "fixtures" / "run.json"
AGENT_COUNT = 14
TASK_ROW_COUNT = 28
FIXTURE_TOTAL_TOKENS = 18
FIXTURE_NET_TOKENS = 14
USAGE_TOTAL_TOKENS = 25
USAGE_NET_TOKENS = 21
TOOL_CALLS = 2
CANDIDATE_COUNT = 2
SUCCESS_CALLS = 3
RETRY_ATTEMPTS = 1
OS_ERROR_RETURN_CODE = 127
CANDIDATE_VARIANT_COUNT = 4


@pytest.fixture
def dataset():
    """Load the checked-in dataset for each test that needs it."""
    return load_dataset(DATASET_PATH)


@pytest.fixture
def responses():
    """Load deterministic responses without contacting a provider."""
    return load_fixture_responses(RESPONSES_PATH)


def test_dataset_contains_all_fourteen_agents_and_both_splits(dataset):
    manifest = {entry["id"] for entry in dataset.agents}
    task_agents = {task.agent for task in dataset.tasks}

    assert manifest == AGENT_IDS
    assert task_agents == AGENT_IDS
    assert {task.split for task in dataset.tasks} == {"train", "holdout"}
    assert len(dataset.tasks) == AGENT_COUNT


def test_versioned_run_manifest_describes_the_offline_contract():
    run_manifest = json.loads(RUN_PATH.read_text(encoding="utf-8"))

    assert run_manifest["schema_version"] == "beta2.run.v1"
    assert run_manifest["mode"] == "fixture"
    assert run_manifest["dry_run"] is False
    assert run_manifest["expected"]["agents"] == AGENT_COUNT
    assert run_manifest["expected"]["rows"] == TASK_ROW_COUNT


def test_fixture_run_covers_every_task_and_never_calls_opencode(
    dataset, responses, monkeypatch
):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("fixture mode must not call OpenCode")

    monkeypatch.setattr("benchmarks.beta2.runner.run_opencode", fail_if_called)
    report = run_benchmark(
        dataset,
        mode="fixture",
        fixture_responses=responses,
    )

    assert report["mode"] == "fixture"
    assert report["dry_run"] is False
    assert len(report["tasks"]) == TASK_ROW_COUNT
    assert report["comparison"]["baseline"]["quality_accepted_tasks"] == AGENT_COUNT
    assert report["comparison"]["candidate"]["quality_accepted_tasks"] == AGENT_COUNT
    assert (
        report["comparison"]["candidate"]["net_total_tokens"]
        < report["comparison"]["baseline"]["net_total_tokens"]
    )


def test_dry_run_is_provider_free_even_when_binary_is_missing(dataset, monkeypatch):
    monkeypatch.setattr("benchmarks.beta2.runner.shutil.which", lambda _: None)

    report = run_benchmark(
        dataset,
        mode="opencode",
        binary="not-installed-in-ci",
        dry_run=True,
    )

    assert report["dry_run"] is True
    assert report["results"] == []
    assert len(report["tasks"]) == AGENT_COUNT


def test_dry_run_entrypoint_renders_default_and_fixture_manifests(tmp_path):
    for name, extra_args in (
        ("default", ()),
        (
            "fixture",
            (
                "--mode",
                "fixture",
                "--fixture",
                str(RESPONSES_PATH),
            ),
        ),
    ):
        markdown_path = tmp_path / f"{name}.md"
        report_path = tmp_path / f"{name}.json"
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "benchmarks.beta2.runner",
                "--dry-run",
                *extra_args,
                "--output-markdown",
                str(markdown_path),
                "--output-json",
                str(report_path),
            ],
            cwd=ROOT.parent.parent,
            capture_output=True,
            text=True,
            check=False,
        )

        assert completed.returncode == 0, completed.stderr
        markdown = markdown_path.read_text(encoding="utf-8")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        assert "variant" not in report["tasks"][0]
        assert report["tasks"][0]["variants"] == ["baseline", "candidate"]
        assert "baseline, candidate" in markdown
        assert "KeyError" not in completed.stderr


def test_render_markdown_accepts_an_explicit_variant():
    report = {
        "mode": "fixture",
        "dry_run": False,
        "tasks": [
            {
                "task_id": "explicit.variant",
                "agent": "zeus",
                "variant": "candidate",
                "status": "accepted",
                "quality_score": 1.0,
                "tokens": {"net_total": 1},
                "latency_ms": 1,
                "retries": 0,
            }
        ],
        "comparison": None,
    }

    assert "| explicit.variant | zeus | candidate |" in runner_module.render_markdown(
        report
    )


def test_output_parser_accepts_single_json_and_jsonl_events():
    assert _parse_json_output('{"output": "ZEUS_OK"}') == {"output": "ZEUS_OK"}

    events = _parse_json_output('noise\n{"output":"first"}\n{"output":"second"}')
    assert events == [{"output": "first"}, {"output": "second"}]


def test_fixture_execution_extracts_usage_and_quality(dataset, tmp_path):
    task = dataset.tasks[0]
    execution = run_fixture(
        {
            "output": "ZEUS_OK",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 4,
                "retrieval_tokens": 3,
                "measurement_tokens": 1,
            },
            "latency_ms": 2,
        },
        task.prompt,
    )
    quality = evaluate_quality(task, execution.output, tmp_path)

    assert execution.usage.total_tokens == FIXTURE_TOTAL_TOKENS
    assert execution.usage.net_tokens == FIXTURE_NET_TOKENS
    assert quality.accepted is True
    assert quality.score == 1.0


def test_token_metrics_count_tool_calls_and_estimate_missing_usage():
    payload = {
        "usage": {
            "input_tokens": 10,
            "output_tokens": 4,
            "tool_schema_tokens": 2,
            "tool_output_tokens": 5,
            "retrieval_tokens": 3,
            "measurement_tokens": 1,
        },
        "tool_calls": [{"name": "one"}, {"name": "two"}],
    }
    usage = usage_from_payload(payload, "prompt", "output")

    assert usage.total_tokens == USAGE_TOTAL_TOKENS
    assert usage.net_tokens == USAGE_NET_TOKENS
    assert usage.estimated is False
    assert tool_call_count(payload) == TOOL_CALLS
    assert usage_from_payload({}, "1234", "5678").estimated is True


def test_redaction_removes_credentials_from_reportable_text():
    secret_text = (
        "Bearer abcdefghijklmnop api_key=do-not-store-this and sk-test-token-value"
    )

    redacted = redact_text(secret_text)

    assert "[REDACTED]" in redacted
    assert "abcdefghijklmnop" not in redacted
    assert "do-not-store-this" not in redacted
    assert "sk-test-token-value" not in redacted


def test_optional_gepa_contract_has_no_required_dependency(dataset, responses):
    report = run_benchmark(dataset, mode="fixture", fixture_responses=responses)
    payload = export_gepa_payload(dataset, report)
    candidates = generate_prompt_candidates("Return a result", count=2)
    selection = evaluate_candidate(report, report, quality_floor=1.0)

    assert isinstance(payload["gepa_installed"], bool)
    assert payload["auto_apply"] is False
    assert payload["metric"]["holdout_required"] is True
    assert len(candidates) == CANDIDATE_COUNT
    assert selection["approved"] is True
    assert selection["quality_first"] is True
    assert selection["auto_apply"] is False


def test_executor_allowlist_and_payload_helpers():
    environment = executor_module.build_child_env(
        {
            "HOME": "/tmp/home",
            "UNSAFE": "not copied",
            "OPENAI_API_KEY": "provider value",
        }
    )

    assert environment["HOME"] == "/tmp/home"
    assert environment["OPENAI_API_KEY"] == "provider value"
    assert "UNSAFE" not in environment
    assert environment["PATH"] == "/usr/bin:/bin"
    assert _parse_json_output("") == {}
    assert _parse_json_output("not json") == {"text": "not json"}
    assert (
        executor_module._text_from_payload(
            {"nested": {"content": "one"}, "items": [{"text": "two"}]}, "fallback"
        )
        == "one\ntwo"
    )
    assert executor_module._text_from_payload(42, "fallback") == "fallback"
    assert (
        executor_module._payload_int({"calls": SUCCESS_CALLS}, ("calls",), 1)
        == SUCCESS_CALLS
    )
    assert executor_module._payload_int({}, ("calls",), 1) == 1


def test_opencode_execution_retries_timeout_then_succeeds(
    dataset, tmp_path, monkeypatch
):
    task = replace(
        dataset.tasks[0],
        budget=replace(dataset.tasks[0].budget, max_retries=1),
    )
    calls = iter(
        [
            subprocess.TimeoutExpired(["fake"], 1, output="partial"),
            subprocess.CompletedProcess(
                ["fake"],
                0,
                stdout=json.dumps(
                    {
                        "output": "OK",
                        "usage": {"input_tokens": 1, "output_tokens": 2},
                        "calls": 2,
                        "tool_calls": [{"name": "check"}],
                    }
                ),
                stderr="",
            ),
        ]
    )

    def flaky_run(*args, **kwargs):
        response = next(calls)
        if isinstance(response, BaseException):
            raise response
        return response

    monkeypatch.setattr(executor_module.subprocess, "run", flaky_run)

    execution = executor_module.run_opencode("fake", "prompt", task, tmp_path)

    assert execution.output == "OK"
    assert execution.returncode == 0
    assert execution.retries == RETRY_ATTEMPTS
    assert execution.calls == SUCCESS_CALLS
    assert execution.tool_calls == 1


def test_opencode_execution_reports_missing_binary(dataset, tmp_path, monkeypatch):
    task = replace(
        dataset.tasks[0], budget=replace(dataset.tasks[0].budget, max_retries=0)
    )

    def missing_binary(*args, **kwargs):
        raise OSError("binary not found")

    monkeypatch.setattr(executor_module.subprocess, "run", missing_binary)
    execution = executor_module.run_opencode("missing", "prompt", task, tmp_path)

    assert execution.returncode == OS_ERROR_RETURN_CODE
    assert execution.error == "binary not found"


def test_quality_checks_cover_json_and_verification_failures(tmp_path, dataset):
    task = replace(
        dataset.tasks[0],
        acceptance=Acceptance(
            ("needle",),
            ({"path": "ok", "equals": True}, {"path": "missing", "equals": 1}),
        ),
        verification=(
            Verification("unsupported", ("sh", "-c", "exit 1"), 1),
            Verification("failed", ("python3", "-c", "raise SystemExit(1)"), 1),
        ),
    )
    result = evaluate_quality(task, '{"ok": true}', tmp_path)

    assert result.accepted is False
    assert result.score < 1.0
    assert (tmp_path / "beta2_output.txt").read_text(encoding="utf-8")
    assert any(check.get("error") == "missing json path" for check in result.checks)
    assert any(check.get("error") == "unsupported command" for check in result.checks)
    assert any(check.get("returncode") == 1 for check in result.checks)

    invalid_json = replace(
        task, acceptance=Acceptance((), ({"path": "ok", "equals": True},))
    )
    invalid_result = evaluate_quality(invalid_json, "not json", tmp_path)
    assert invalid_result.checks[0]["error"] == "output is not JSON"

    invalid_path = replace(
        task, acceptance=Acceptance((), ({"path": None, "equals": True},))
    )
    invalid_path_result = evaluate_quality(invalid_path, '{"ok": true}', tmp_path)
    assert invalid_path_result.checks[0]["error"] == "invalid json path"


def test_isolated_workspace_copies_only_safe_files(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "visible.txt").write_text("visible", encoding="utf-8")
    (source / ".env").write_text("secret", encoding="utf-8")
    (source / ".git").mkdir()
    (source / "node_modules").mkdir()

    with executor_module.isolated_workspace(source) as copied:
        assert (copied / "visible.txt").read_text(encoding="utf-8") == "visible"
        assert not (copied / ".env").exists()
        assert not (copied / ".git").exists()
        assert not (copied / "node_modules").exists()
    with executor_module.isolated_workspace(None) as empty:
        assert empty.is_dir()
    with (
        pytest.raises(ValueError, match="not a directory"),
        executor_module.isolated_workspace(source / "missing"),
    ):
        pass


def test_gepa_rejects_quality_regression_and_no_improvement():
    def row(variant, split, quality, tokens):
        return {
            "variant": variant,
            "split": split,
            "quality_accepted": quality,
            "tokens": {"net_total": tokens},
        }

    baseline = {
        "tasks": [
            row("baseline", "train", True, 10),
            row("baseline", "holdout", True, 10),
        ]
    }
    candidate = {
        "tasks": [
            row("candidate", "train", False, 10),
            row("candidate", "holdout", False, 10),
        ]
    }

    selection = evaluate_candidate(baseline, candidate)

    assert selection["approved"] is False
    assert "train quality floor failed" in selection["reasons"]
    assert "train quality regressed" in selection["reasons"]
    assert (
        "candidate does not improve quality or net-token cost" in selection["reasons"]
    )
    with pytest.raises(ValueError, match="quality_floor"):
        evaluate_candidate(baseline, candidate, quality_floor=2.0)


def test_gepa_cli_exports_proposes_and_selects(dataset, tmp_path):
    dataset_path = tmp_path / "dataset.json"
    dataset_path.write_text(DATASET_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    export_path = tmp_path / "export.json"
    propose_path = tmp_path / "propose.json"
    select_path = tmp_path / "select.json"
    baseline_path = tmp_path / "baseline.json"
    candidate_path = tmp_path / "candidate.json"
    baseline_path.write_text(json.dumps({"tasks": []}), encoding="utf-8")
    candidate_path.write_text(json.dumps({"tasks": []}), encoding="utf-8")

    assert (
        gepa_module.main(
            ["export", "--dataset", str(dataset_path), "--output", str(export_path)]
        )
        == 0
    )
    assert (
        gepa_module.main(
            [
                "propose",
                "--prompt",
                "Return JSON",
                "--count",
                "5",
                "--output",
                str(propose_path),
            ]
        )
        == 0
    )
    assert (
        gepa_module.main(
            [
                "select",
                "--dataset",
                str(dataset_path),
                "--baseline-report",
                str(baseline_path),
                "--candidate-report",
                str(candidate_path),
                "--output",
                str(select_path),
            ]
        )
        == 0
    )
    assert (
        len(json.loads(propose_path.read_text(encoding="utf-8"))["candidates"])
        == CANDIDATE_VARIANT_COUNT
    )
    assert (
        json.loads(export_path.read_text(encoding="utf-8"))["dataset_version"]
        == dataset.schema_version
    )
    assert json.loads(select_path.read_text(encoding="utf-8"))["approved"] is False


def test_runner_options_and_loaders_validate_inputs(tmp_path):
    assert runner_module.BenchmarkOptions.from_kwargs({}).mode == "auto"
    with pytest.raises(TypeError, match="unexpected"):
        runner_module.BenchmarkOptions.from_kwargs({"unknown": True})
    with pytest.raises(TypeError, match="mode"):
        runner_module.BenchmarkOptions.from_kwargs({"mode": 1})
    with pytest.raises(TypeError, match="dry_run"):
        runner_module.BenchmarkOptions.from_kwargs({"dry_run": "yes"})

    prompts_path = tmp_path / "prompts.json"
    prompts_path.write_text(
        json.dumps({"prompts": {"task": "candidate"}}), encoding="utf-8"
    )
    assert runner_module.load_candidate_prompts(prompts_path) == {"task": "candidate"}
    assert runner_module.load_candidate_prompts(None) == {}
    with pytest.raises(DatasetError, match="candidate prompts"):
        invalid = tmp_path / "invalid-prompts.json"
        invalid.write_text(json.dumps(["bad"]), encoding="utf-8")
        runner_module.load_candidate_prompts(invalid)

    fixture_path = tmp_path / "fixture.json"
    fixture_path.write_text(
        json.dumps({"responses": {"task": {"baseline": {}}}}), encoding="utf-8"
    )
    assert "task" in runner_module.load_fixture_responses(fixture_path)
    assert runner_module.load_fixture_responses(None) == {}
    with pytest.raises(DatasetError, match="fixture"):
        invalid_fixture = tmp_path / "invalid-fixture.json"
        invalid_fixture.write_text(json.dumps([]), encoding="utf-8")
        runner_module.load_fixture_responses(invalid_fixture)
    invalid_variant = tmp_path / "invalid-variant.json"
    invalid_variant.write_text(
        json.dumps({"responses": {"task": {"experimental": {}}}}),
        encoding="utf-8",
    )
    with pytest.raises(DatasetError, match="variant"):
        runner_module.load_fixture_responses(invalid_variant)


def test_runner_missing_fixture_and_cli_outputs(dataset, responses, tmp_path):
    missing = run_benchmark(dataset, mode="fixture")
    assert all(row["status"] == "execution_error" for row in missing["tasks"])
    assert "execution_error" in runner_module.render_markdown(missing)

    prompts_path = tmp_path / "prompts.json"
    prompts_path.write_text(
        json.dumps({"prompts": {dataset.tasks[0].task_id: "candidate prompt"}}),
        encoding="utf-8",
    )
    fixture_path = tmp_path / "responses.json"
    fixture_path.write_text(json.dumps({"responses": responses}), encoding="utf-8")
    output_json = tmp_path / "report.json"
    output_markdown = tmp_path / "report.md"
    assert (
        runner_module.main(
            [
                "--dataset",
                str(DATASET_PATH),
                "--mode",
                "fixture",
                "--fixture",
                str(fixture_path),
                "--candidate-prompts",
                str(prompts_path),
                "--output-json",
                str(output_json),
                "--output-markdown",
                str(output_markdown),
            ]
        )
        == 0
    )
    assert json.loads(output_json.read_text(encoding="utf-8"))["mode"] == "fixture"
    assert "Pantheon beta2 benchmark" in output_markdown.read_text(encoding="utf-8")


def test_runner_execution_statuses(dataset, tmp_path):
    task = dataset.tasks[0]
    accepted = run_fixture({"output": "ZEUS_OK"}, task.prompt)
    accepted_row = runner_module._execution_result(
        task, "baseline", task.prompt, accepted, tmp_path
    )
    assert accepted_row["status"] == "accepted"

    failed = run_fixture({"output": "wrong"}, task.prompt)
    failed_row = runner_module._execution_result(
        task, "baseline", task.prompt, failed, tmp_path
    )
    assert failed_row["status"] == "quality_failed"

    budget_task = replace(task, budget=replace(task.budget, max_total_tokens=1))
    budget_row = runner_module._execution_result(
        budget_task,
        "baseline",
        task.prompt,
        accepted,
        tmp_path,
    )
    assert budget_row["status"] == "budget_failed"
