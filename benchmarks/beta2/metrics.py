"""Token accounting, redaction, and stable report metrics for beta2."""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Final

SECRET_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"(?i)\b(?:sk|pk|ghp|github_pat|xox[baprs]-)[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)\b(?:AKIA|ASIA)[A-Z0-9]{12,}"),
    re.compile(r"(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+"),
    re.compile(r"(?i)(\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+"),
)


@dataclass(frozen=True)
class TokenUsage:
    """Token categories tracked by the benchmark."""

    input_tokens: int
    output_tokens: int
    tool_schema_tokens: int
    tool_output_tokens: int
    retrieval_tokens: int
    measurement_tokens: int
    estimated: bool = False

    @property
    def total_tokens(self) -> int:
        """Return all measured categories."""
        return sum(
            (
                self.input_tokens,
                self.output_tokens,
                self.tool_schema_tokens,
                self.tool_output_tokens,
                self.retrieval_tokens,
                self.measurement_tokens,
            )
        )

    @property
    def net_tokens(self) -> int:
        """Return tokens after retrieval and measurement accounting."""
        return max(
            0, self.total_tokens - self.retrieval_tokens - self.measurement_tokens
        )


def redact_text(value: str) -> str:
    """Remove common credential forms while preserving report structure."""
    result = value
    for pattern in SECRET_PATTERNS:
        result = pattern.sub(
            lambda match: f"{match.group(1) if match.lastindex else ''}[REDACTED]",
            result,
        )
    return result


def output_fingerprint(value: str) -> str:
    """Return a non-reversible identity for an output without storing it."""
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def estimate_tokens(value: str) -> int:
    """Use a deterministic conservative character-based estimate."""
    return math.ceil(len(value) / 4) if value else 0


def _number(data: dict[str, object], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = data.get(key)
        if (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and value >= 0
        ):
            return int(value)
    return None


def _usage_object(payload: object) -> dict[str, object] | None:
    if isinstance(payload, dict):
        for key in ("usage", "token_usage", "tokens"):
            value = payload.get(key)
            if isinstance(value, dict):
                return {str(k): item for k, item in value.items()}
        for value in payload.values():
            found = _usage_object(value)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _usage_object(value)
            if found is not None:
                return found
    return None


def _sum_named(payload: object, keys: tuple[str, ...]) -> int:
    if isinstance(payload, dict):
        return sum(
            (
                int(value)
                if key in keys
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and value >= 0
                else _sum_named(value, keys)
            )
            for key, value in payload.items()
        )
    if isinstance(payload, list):
        return sum(_sum_named(value, keys) for value in payload)
    return 0


def _count_tool_calls(payload: object) -> int:
    if isinstance(payload, dict):
        count = 0
        for key, value in payload.items():
            if key in {"tool_calls", "tool_call"}:
                count += len(value) if isinstance(value, list) else 1
            elif key == "role" and value == "tool":
                count += 1
            else:
                count += _count_tool_calls(value)
        return count
    if isinstance(payload, list):
        return sum(_count_tool_calls(value) for value in payload)
    return 0


def usage_from_payload(payload: object, prompt: str, output: str) -> TokenUsage:
    """Extract common OpenCode usage fields with deterministic fallback."""
    usage = _usage_object(payload) or {}
    input_tokens = _number(usage, ("input_tokens", "prompt_tokens", "input"))
    output_tokens = _number(usage, ("output_tokens", "completion_tokens", "output"))
    schema_tokens = _number(
        usage, ("tool_schema_tokens", "tools_schema_tokens", "tool_schema")
    )
    tool_output_tokens = _number(
        usage, ("tool_output_tokens", "tools_output_tokens", "tool_output")
    )
    retrieval_tokens = _number(usage, ("retrieval_tokens", "retrieval"))
    measurement_tokens = _number(usage, ("measurement_tokens", "measurement"))
    estimated = False
    if input_tokens is None:
        input_tokens, estimated = estimate_tokens(prompt), True
    if output_tokens is None:
        output_tokens, estimated = estimate_tokens(output), True
    if schema_tokens is None:
        schema_tokens = _sum_named(
            payload, ("tool_schema_tokens", "tools_schema_tokens")
        )
    if tool_output_tokens is None:
        tool_output_tokens = _sum_named(
            payload, ("tool_output_tokens", "tools_output_tokens")
        )
    if retrieval_tokens is None:
        retrieval_tokens = _sum_named(payload, ("retrieval_tokens",))
    if measurement_tokens is None:
        measurement_tokens = _sum_named(payload, ("measurement_tokens",))
    return TokenUsage(
        max(0, input_tokens),
        max(0, output_tokens),
        max(0, schema_tokens),
        max(0, tool_output_tokens),
        max(0, retrieval_tokens or 0),
        max(0, measurement_tokens or 0),
        estimated,
    )


def tool_call_count(payload: object) -> int:
    """Count tool-call events in common OpenCode event shapes."""
    return _count_tool_calls(payload)
