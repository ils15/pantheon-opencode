"""Reproducible source provenance and F0 comparison gates."""

from __future__ import annotations

import json
from pathlib import Path

from .provenance import collect_baseline_provenance, logical_line_count

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).with_name("fixtures") / "agent-baseline-provenance.json"
TWO_LINES = 2
HISTORICAL_938_LINES = 938
HISTORICAL_936_LINES = 936
CURRENT_F1_LINES = 585
HISTORICAL_ADDED_LINES = 14
HISTORICAL_REMOVED_LINES = 12


def test_logical_line_count_does_not_assume_a_trailing_newline():
    assert logical_line_count(b"one\ntwo\n") == TWO_LINES
    assert logical_line_count(b"one\ntwo") == TWO_LINES
    assert logical_line_count(b"one") == 1
    assert logical_line_count(b"") == 0


def test_historical_agent_baseline_provenance_is_reproducible():
    provenance = collect_baseline_provenance(REPO_ROOT)
    recorded = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    assert recorded == provenance
    snapshots = provenance["snapshots"]

    assert snapshots["historical_938"]["commit_sha"] == (
        "beecdd737adc69e6622815bfd40af5d2359e8376"
    )
    assert snapshots["historical_938"]["blob_sha"] == (
        "e377650adf9f5ad939e566a719b2cef04e04f27d"
    )
    assert snapshots["historical_938"]["content_sha256"] == (
        "89060e2282bc10ec801fc0d06bf3e4aefa7bb6f0630b99ae50804fd0b0c17521"
    )
    assert snapshots["historical_938"]["line_count"] == HISTORICAL_938_LINES

    assert snapshots["historical_936"]["commit_sha"] == (
        "1c2ddacabed8d441ed70d543e809aab919343ca4"
    )
    assert snapshots["historical_936"]["blob_sha"] == (
        "84e797234f7485af6d3d2a180c8562b0366b8ba1"
    )
    assert snapshots["historical_936"]["content_sha256"] == (
        "4920aa98f7aa7b4655fc86fd4f33a4cf09616f1ca767aa2788726c6ba13ad6c2"
    )
    assert snapshots["historical_936"]["line_count"] == HISTORICAL_936_LINES

    assert snapshots["current_f1"]["commit_sha"] == (
        "850191c2fffee112386cc16fd983e6073f7884d8"
    )
    assert snapshots["current_f1"]["blob_sha"] == (
        "ba032668dd3e5d0838f51a70bcad91cc8697fc72"
    )
    assert snapshots["current_f1"]["content_sha256"] == (
        "68fd0ca441b0cc3174e2c84a19b05aa3f5de8af796c5c40370daa27232c40fb0"
    )
    assert snapshots["current_f1"]["line_count"] == CURRENT_F1_LINES

    delta = provenance["historical_delta"]
    assert delta["line_delta"] == TWO_LINES
    assert delta["added_lines"] == HISTORICAL_ADDED_LINES
    assert delta["removed_lines"] == HISTORICAL_REMOVED_LINES
    assert delta["source_instruction"] == (
        "src/instructions/memory-protocol.instructions.md"
    )
    assert "tokens" not in provenance
    assert provenance["line_count_convention"] == (
        "LF-delimited logical lines; count a final unterminated line once; "
        "empty content has zero lines"
    )
