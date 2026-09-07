"""Tests for the WS3 TOON codec (PR #94) — Python mirror.

TDD RED: ``src.mcp.toon_codec`` does not exist yet, so every test here
FAILS (collection error) before the implementation and PASSES after.

TOON (Token-Oriented Object Notation): minimal deterministic encoding for
board signals, checkpoints and KV payloads. Semantics identical to JSON;
per-class savings ~11% board-signal up to ~49% large-tabular (28%
checkpoint, 33% kv-list — see docs/ws3-token-opt-measurements.md);
JSON fallback when the parser is absent/fails.

Prohibited: external gateway, generative embedding — this module uses only
the standard library (``json`` + ``re``).
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

from src.mcp.toon_codec import (
    TOON_MAX_CHARS,
    TOON_MAX_DEPTH,
    _is_uniform_dict_list,
    _split_cells,
    toon_decode,
    toon_decode_auto,
    toon_encode,
    toon_size_report,
)


def _board_signal() -> dict[str, Any]:
    return {
        "taskID": "ses_child_1",
        "alias": "apo-1",
        "agent": "hermes",
        "state": "completed",
        "summary": "Done: auth router implemented, 12 tests green",
        "timestamp": 1787955800816,
    }


def _checkpoint() -> dict[str, Any]:
    # Realistic full checkpoint (WS2 shape): phase + tail + in-flight jobs
    # + pending todos + heartbeat nesting. Tabular sections encode as tables.
    return {
        "phase": 3,
        "agent": "hermes",
        "summary": "Delegate relaunch e2e green, monitor apo-2 and apo-3",
        "remaining": ["monitor", "reconcile", "verify"],
        "tail": "last action: reconcile apo-1 completed after 12 tests green, heartbeat refreshed",
        "jobs": [
            {"taskID": "ses_child_1", "agent": "hermes", "state": "completed"},
            {"taskID": "ses_child_2", "agent": "apollo", "state": "running"},
            {"taskID": "ses_child_3", "agent": "themis", "state": "running"},
            {"taskID": "ses_child_4", "agent": "demeter", "state": "running"},
            {"taskID": "ses_child_5", "agent": "aphrodite", "state": "error"},
        ],
        "todos": [
            {"id": "t1", "desc": "dispatch hermes", "status": "done"},
            {"id": "t2", "desc": "monitor board", "status": "active"},
            {"id": "t3", "desc": "reconcile signals", "status": "pending"},
            {"id": "t4", "desc": "verify e2e", "status": "pending"},
        ],
        "nested": {"retries": 1, "capped": False},
    }


def _kv_list() -> list[dict[str, Any]]:
    return [
        {
            "namespace": "checkpoint:auth:abc123",
            "key": "phase:3",
            "value": "relaunch green",
        },
        {
            "namespace": "checkpoint:auth:abc123",
            "key": "latest",
            "value": "relaunch green",
        },
        {"namespace": "checkpoint:auth:abc123", "key": "heartbeat", "value": "alive"},
    ]


def test_roundtrip_nested_dict_identical_semantics() -> None:
    value = _checkpoint()
    assert toon_decode(toon_encode(value)) == value


def test_roundtrip_list_of_dicts_kv_payload() -> None:
    assert toon_decode(toon_encode(_kv_list())) == _kv_list()


def test_roundtrip_scalar_types_string_123_stays_string() -> None:
    value = {
        "count": 123,
        "flag": True,
        "missing": None,
        "code": "123",
        "name": "apo-1",
    }
    assert toon_decode(toon_encode(value)) == value


def test_board_signal_smaller_than_json_flat_minimal_record() -> None:
    # Flat minimal records (PLAN: id, agente, estado, 1 linha) are
    # content-dominated: TOON wins on structure only (~11% board-signal).
    # The lever is still net-positive here (replaces JSON, zero overhead) —
    # structural payloads below save 28% checkpoint / 33% kv-list / ~49% large-tabular.

    report = toon_size_report(_board_signal())
    assert report["toon_chars"] < report["json_chars"], (
        f"expected strictly smaller, got {report}"
    )


def test_checkpoint_at_least_25_percent_smaller_than_json() -> None:
    report = toon_size_report(_checkpoint())
    assert report["toon_chars"] <= report["json_chars"] * 0.75, (
        f"expected >=25% smaller, got {report}"
    )


def test_kv_list_at_least_25_percent_smaller_than_json() -> None:
    report = toon_size_report(_kv_list())
    assert report["toon_chars"] <= report["json_chars"] * 0.75, (
        f"expected >=25% smaller, got {report}"
    )


def test_decode_auto_falls_back_to_json() -> None:
    value = _board_signal()
    assert toon_decode_auto(json.dumps(value)) == value
    assert toon_decode_auto(toon_encode(value)) == value


def test_decode_auto_raises_on_garbage() -> None:
    with pytest.raises(ValueError, match="neither TOON nor JSON"):
        toon_decode_auto(":::not-valid:::\n  \x00")


# --- Error-path / edge coverage (issue: 73% -> >=80% statements) ---


def test_encode_empty_and_whitespace_strings_are_quoted() -> None:
    assert toon_encode({"k": ""}) == 'k: ""'
    assert toon_decode(toon_encode({"k": ""})) == {"k": ""}
    assert toon_encode({"k": "  "}) == 'k: "  "'
    assert toon_decode(toon_encode({"k": "  "})) == {"k": "  "}


def test_encode_float_uses_repr() -> None:
    assert toon_encode(3.14) == "3.14"
    assert toon_encode({"f": 2.5}) == "f: 2.5"
    assert toon_decode(toon_encode({"f": 2.5})) == {"f": 2.5}


def test_encode_key_with_spaces_and_colon_is_quoted() -> None:
    assert toon_encode({"a b": 1}) == '"a b": 1'
    assert toon_decode('"a b": 1') == {"a b": 1}
    assert toon_encode({"a:b": 2}) == '"a:b": 2'
    assert toon_decode(toon_encode({"a:b": 2})) == {"a:b": 2}


def test_is_uniform_dict_list_rejects_edge_shapes() -> None:
    assert _is_uniform_dict_list("not-a-list") is False
    assert _is_uniform_dict_list([]) is False
    assert _is_uniform_dict_list([{}, {}]) is False
    assert _is_uniform_dict_list([{"a": 1}, {"b": 2}]) is False
    assert _is_uniform_dict_list([{"a": 1}, "x"]) is False
    assert _is_uniform_dict_list([{"a": 1}, {"a": 2}]) is True


def test_split_cells_respects_quoted_pipe() -> None:
    assert _split_cells('"a|b"|c') == ['"a|b"', "c"]
    assert _split_cells("a|b|c") == ["a", "b", "c"]


def test_split_cells_handles_escapes_inside_quotes() -> None:
    cells = _split_cells('"a\\"b|c"|d')
    assert cells == ['"a\\"b|c"', "d"]
    assert _split_cells("1|2") == ["1", "2"]


def test_encode_top_level_scalars() -> None:
    assert toon_encode("hello") == "hello"
    assert toon_encode(42) == "42"
    assert toon_encode(None) == "null"
    assert toon_encode(True) == "true"


def test_encode_unsupported_type_raises() -> None:
    with pytest.raises(TypeError, match="TOON cannot encode set"):
        toon_encode({"x": {1, 2}})


def test_encode_empty_dict_and_list() -> None:
    assert toon_encode({}) == "{}"
    assert toon_encode([]) == "[]"
    assert toon_decode("{}") == {}
    assert toon_decode("[]") == []


def test_encode_dict_with_empty_containers() -> None:
    value = {"a": {}, "b": []}
    assert toon_encode(value) == "a: {}\nb: []"
    assert toon_decode(toon_encode(value)) == value


def test_encode_list_with_empty_items() -> None:
    assert toon_encode([{}]) == "- {}"
    assert toon_decode("- {}") == [{}]
    assert toon_encode([[]]) == "- []"
    assert toon_decode("- []") == [[]]


def test_encode_list_nested_dict_items() -> None:
    value = [{"a": 1}, {"b": 2}]
    assert toon_encode(value) == "- a: 1\n- b: 2"
    assert toon_decode(toon_encode(value)) == value
    assert toon_decode("- a: 1\n- b: 2") == value


def test_parse_scalar_empty_containers() -> None:
    assert toon_decode("a: {}\nb: []") == {"a": {}, "b": []}


def test_decode_line_without_colon_raises() -> None:
    with pytest.raises(ValueError, match="without ':' separator"):
        toon_decode("hello world")


def test_decode_empty_key_raises() -> None:
    with pytest.raises(ValueError, match="empty key"):
        toon_decode(": 1")


def test_decode_empty_input_raises() -> None:
    with pytest.raises(ValueError, match="empty input"):
        toon_decode("")
    with pytest.raises(ValueError, match="empty input"):
        toon_decode("  \n  ")


def test_decode_json_fallback_valid() -> None:
    assert toon_decode('{"a": 1}') == {"a": 1}
    assert toon_decode("[1, 2]") == [1, 2]


def test_decode_json_fallback_invalid_raises() -> None:
    with pytest.raises(ValueError, match="invalid JSON fallback"):
        toon_decode("{bad json")


def test_decode_trailing_content_raises() -> None:
    with pytest.raises(ValueError, match="trailing content"):
        toon_decode("a: 1\n- foo")
    with pytest.raises(ValueError, match="trailing content"):
        toon_decode("- a\nb: 1")


def test_decode_bad_table_header_raises() -> None:
    with pytest.raises(ValueError, match="bad @table header"):
        toon_decode("@table a||b\n1|2|3")


def test_decode_table_stops_at_list_line() -> None:
    with pytest.raises(ValueError, match="trailing content"):
        toon_decode("@table a|b\n1|2\n- foo")


def test_decode_table_stops_at_dict_line() -> None:
    with pytest.raises(ValueError, match="trailing content"):
        toon_decode("@table a|b\n1|2\nx: 1")


def test_decode_table_row_width_mismatch_raises() -> None:
    with pytest.raises(ValueError, match="row width mismatch"):
        toon_decode("@table a|b\n1")


def test_decode_nested_dict_returns_to_parent() -> None:
    assert toon_decode("a:\n  b: 1\nc: 2") == {"a": {"b": 1}, "c": 2}


def test_decode_missing_nested_block_raises() -> None:
    with pytest.raises(ValueError, match="missing nested block"):
        toon_decode("a:")


def test_decode_list_dict_item_with_continuation() -> None:
    assert toon_decode("- a: 1\n  b: 2") == [{"a": 1, "b": 2}]
    assert toon_decode("- a: 1\n  b: 2\n- c: 3") == [
        {"a": 1, "b": 2},
        {"c": 3},
    ]


def test_decode_list_dict_item_nested_block() -> None:
    assert toon_decode("- a:\n    b: 1") == [{"a": {"b": 1}}]


def test_decode_list_continuation_nested_block() -> None:
    assert toon_decode("- a: 1\n  b:\n    c: 2") == [{"a": 1, "b": {"c": 2}}]


def test_decode_bare_dash_nested_block() -> None:
    assert toon_decode("-\n  a: 1") == [{"a": 1}]


def test_decode_bare_dash_missing_block_raises() -> None:
    with pytest.raises(ValueError, match="missing nested block in list"):
        toon_decode("-\n")


def test_decode_list_dict_item_missing_nested_raises() -> None:
    with pytest.raises(ValueError, match="missing nested block"):
        toon_decode("- a:")


def test_decode_list_continuation_missing_nested_raises() -> None:
    with pytest.raises(ValueError, match="missing nested block"):
        toon_decode("- a: 1\n  b:")


def test_decode_auto_falls_back_to_json_scalar() -> None:
    expected = 123
    assert toon_decode_auto("123") == expected


def test_numeric_lookalike_strings_stay_strings() -> None:
    assert toon_decode(toon_encode({"v": "1e10"})) == {"v": "1e10"}
    assert toon_encode({"v": "1e10"}) == 'v: "1e10"'


def test_decode_quoted_key_unterminated_raises() -> None:
    with pytest.raises(ValueError, match="without ':' separator"):
        toon_decode('"unterminated')


def test_decode_quoted_key_without_colon_raises() -> None:
    with pytest.raises(ValueError, match="without ':' separator"):
        toon_decode('"a" no-colon')


def test_decode_quoted_empty_key_raises() -> None:
    with pytest.raises(ValueError, match="empty key"):
        toon_decode('"": 1')


# --- WS3 completion: pipe-quoting, goldens, guards, garbage ---


def test_pipe_values_in_table_are_quoted_and_roundtrip() -> None:
    value = [{"a": "x|y", "b": "1"}]
    encoded = toon_encode(value)
    assert encoded == '@table a|b\n"x|y"|"1"'
    assert toon_decode(encoded) == value


def test_pipe_and_quote_in_table_roundtrip() -> None:
    value = [{"a": 'x|"y"', "b": "p|q|r"}]
    encoded = toon_encode(value)
    assert "|" in encoded
    assert toon_decode(encoded) == value


def test_quoted_colon_key_roundtrip() -> None:
    assert toon_encode({"a:b": 2}) == '"a:b": 2'
    assert toon_decode('"a:b": 2') == {"a:b": 2}


def test_golden_fixtures_parity() -> None:
    fixture_path = pathlib.Path(__file__).parent / "fixtures" / "toon-parity.json"
    payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    assert payload["fixtures"], "parity fixture must not be empty"
    for entry in payload["fixtures"]:
        name = entry["name"]
        assert toon_encode(entry["value"]) == entry["toon"], f"golden {name}"
        assert toon_decode(entry["toon"]) == entry["value"], f"golden {name}"


def test_max_depth_guard_raises_value_error() -> None:
    nested: dict[str, Any] = {"leaf": 1}
    for _ in range(TOON_MAX_DEPTH + 2):
        nested = {"nest": nested}
    encoded = toon_encode(nested)
    with pytest.raises(ValueError, match="max_depth"):
        toon_decode(encoded)
    with pytest.raises(ValueError, match="max_depth"):
        toon_decode(encoded, max_depth=2)


def test_max_chars_guard_raises_value_error() -> None:
    with pytest.raises(ValueError, match="too large"):
        toon_decode("a: 1", max_chars=2)
    big = "x" * (TOON_MAX_CHARS + 1)
    with pytest.raises(ValueError, match="too large"):
        toon_decode(big)


def test_decode_auto_garbage_message_is_neither_toon_nor_json() -> None:
    with pytest.raises(ValueError, match="neither TOON nor JSON"):
        toon_decode_auto(":::not-valid:::\n  \x00")
    with pytest.raises(ValueError, match="neither TOON nor JSON"):
        toon_decode_auto("not toon at all (((")
