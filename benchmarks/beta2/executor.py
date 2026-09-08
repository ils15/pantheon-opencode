"""Safe fixture and optional OpenCode execution for beta2."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .dataset import Task, Verification
from .metrics import TokenUsage, redact_text, tool_call_count, usage_from_payload

ALLOWED_VERIFICATION_COMMANDS = frozenset({"python", "python3", "pytest"})
SAFE_ENV_NAMES = frozenset(
    {
        "CI",
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "PWD",
        "TMPDIR",
        "USER",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    }
)
PROVIDER_ENV_NAMES = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENAI_API_KEY",
        "OPENCODE_API_KEY",
        "PANTHEON_OPENCODE_API_KEY",
    }
)


@dataclass(frozen=True)
class Execution:
    """Sanitized execution result kept in memory for quality checks."""

    output: str
    payload: object
    usage: TokenUsage
    latency_ms: int
    calls: int
    retries: int
    tool_calls: int
    returncode: int
    error: str | None


@dataclass(frozen=True)
class QualityResult:
    """Deterministic acceptance result."""

    accepted: bool
    score: float
    checks: tuple[dict[str, object], ...]


def build_child_env(source: dict[str, str] | None = None) -> dict[str, str]:
    """Return an allowlist environment; provider values are never serialized."""
    source = source or dict(os.environ)
    result = {key: value for key, value in source.items() if key in SAFE_ENV_NAMES}
    result.update(
        {key: value for key, value in source.items() if key in PROVIDER_ENV_NAMES}
    )
    result.setdefault("PATH", "/usr/bin:/bin")
    return result


def _parse_json_output(stdout: str) -> object:
    stripped = stdout.strip()
    if not stripped:
        return {}
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        events: list[object] = []
        for line in stripped.splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return events if events else {"text": stdout}


def _text_from_payload(payload: object, fallback: str) -> str:
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        for key in ("output", "response", "content", "text", "message"):
            value = payload.get(key)
            if isinstance(value, str):
                return value
        chunks = [_text_from_payload(value, "") for value in payload.values()]
        return "\n".join(chunk for chunk in chunks if chunk)
    if isinstance(payload, list):
        chunks = [_text_from_payload(value, "") for value in payload]
        return "\n".join(chunk for chunk in chunks if chunk)
    return fallback


def _payload_int(payload: object, keys: tuple[str, ...], fallback: int) -> int:
    if isinstance(payload, dict):
        for key in keys:
            value = payload.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
    return fallback


def _run_opencode_once(
    binary: str, prompt: str, sandbox: Path, timeout_s: float
) -> Execution:
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            [binary, "run", "--format", "json", prompt],
            cwd=sandbox,
            env=build_child_env(),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
        stdout, stderr = completed.stdout, completed.stderr
        payload = _parse_json_output(stdout)
        output = _text_from_payload(payload, stdout or stderr)
        usage = usage_from_payload(payload, prompt, output)
        calls = _payload_int(
            payload, ("calls", "call_count", "model_calls", "requests"), 1
        )
        return Execution(
            output,
            payload,
            usage,
            max(0, int((time.perf_counter() - started) * 1000)),
            max(1, calls),
            0,
            tool_call_count(payload),
            completed.returncode,
            redact_text(stderr) if completed.returncode else None,
        )
    except subprocess.TimeoutExpired as exc:
        elapsed = max(0, int((time.perf_counter() - started) * 1000))
        output = redact_text(str(exc.stdout or ""))
        return Execution(
            output,
            {},
            usage_from_payload({}, prompt, output),
            elapsed,
            1,
            0,
            0,
            124,
            "timeout",
        )
    except OSError as exc:
        elapsed = max(0, int((time.perf_counter() - started) * 1000))
        return Execution(
            "",
            {},
            usage_from_payload({}, prompt, ""),
            elapsed,
            0,
            0,
            0,
            127,
            redact_text(str(exc)),
        )


def run_opencode(binary: str, prompt: str, task: Task, sandbox: Path) -> Execution:
    """Run OpenCode with bounded retries and no shell interpolation."""
    attempts: list[Execution] = []
    for _ in range(task.budget.max_retries + 1):
        result = _run_opencode_once(
            binary, prompt, sandbox, task.budget.max_latency_ms / 1000
        )
        attempts.append(result)
        if result.returncode == 0:
            break
    final = attempts[-1]
    return Execution(
        final.output,
        final.payload,
        final.usage,
        sum(item.latency_ms for item in attempts),
        sum(item.calls for item in attempts),
        len(attempts) - 1,
        sum(item.tool_calls for item in attempts),
        final.returncode,
        final.error,
    )


def run_fixture(response: object, prompt: str) -> Execution:
    """Convert a deterministic fixture into the same execution contract."""
    data = response if isinstance(response, dict) else {"output": str(response)}
    output = data.get("output", "")
    output_text = (
        output if isinstance(output, str) else json.dumps(output, sort_keys=True)
    )
    payload = data.get("payload", data)
    usage = usage_from_payload(payload, prompt, output_text)
    explicit_usage = data.get("usage")
    if isinstance(explicit_usage, dict):
        usage = usage_from_payload({"usage": explicit_usage}, prompt, output_text)
    latency = data.get("latency_ms", 0)
    calls = data.get("calls", 1)
    retries = data.get("retries", 0)
    return Execution(
        output_text,
        payload,
        usage,
        int(latency) if isinstance(latency, (int, float)) else 0,
        int(calls) if isinstance(calls, int) and calls >= 0 else 1,
        int(retries) if isinstance(retries, int) and retries >= 0 else 0,
        tool_call_count(payload),
        0,
        None,
    )


def _json_path(value: object, path: str) -> object:
    current = value
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            raise KeyError(path)
    return current


def _run_verification(command: Verification, sandbox: Path) -> dict[str, object]:
    executable = Path(command.argv[0]).name
    if executable not in ALLOWED_VERIFICATION_COMMANDS:
        return {"name": command.name, "passed": False, "error": "unsupported command"}
    try:
        completed = subprocess.run(
            list(command.argv),
            cwd=sandbox,
            env=build_child_env(),
            capture_output=True,
            text=True,
            timeout=command.timeout_s,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"name": command.name, "passed": False, "error": redact_text(str(exc))}
    return {
        "name": command.name,
        "passed": completed.returncode == 0,
        "returncode": completed.returncode,
        "stderr": redact_text(completed.stderr[-500:]),
    }


def evaluate_quality(task: Task, output: str, sandbox: Path) -> QualityResult:
    """Evaluate output checks and verification commands without an LLM judge."""
    checks: list[dict[str, object]] = []
    for fragment in task.acceptance.required_fragments:
        checks.append(
            {
                "type": "required_fragment",
                "value": fragment,
                "passed": fragment in output,
            }
        )
    parsed: object | None = None
    if task.acceptance.json_paths:
        try:
            parsed = json.loads(output)
        except json.JSONDecodeError:
            parsed = None
        for item in task.acceptance.json_paths:
            path, expected = item.get("path"), item.get("equals")
            passed, error = False, None
            if isinstance(path, str) and parsed is not None:
                try:
                    passed = _json_path(parsed, path) == expected
                except KeyError:
                    error = "missing json path"
            else:
                error = "output is not JSON" if parsed is None else "invalid json path"
            check: dict[str, object] = {
                "type": "json_path",
                "path": path,
                "equals": expected,
                "passed": passed,
            }
            if error:
                check["error"] = error
            checks.append(check)
    output_path = sandbox / "beta2_output.txt"
    output_path.write_text(redact_text(output)[:100_000], encoding="utf-8")
    for command in task.verification:
        checks.append({"type": "command", **_run_verification(command, sandbox)})
    passed = sum(1 for check in checks if check.get("passed") is True)
    score = passed / len(checks) if checks else 0.0
    return QualityResult(bool(checks) and passed == len(checks), score, tuple(checks))


@contextmanager
def isolated_workspace(workspace: Path | None) -> Iterator[Path]:
    """Yield a temporary workspace copy that cannot mutate the source tree."""
    with tempfile.TemporaryDirectory(prefix="pantheon-beta2-") as temp_dir:
        target = Path(temp_dir) / "workspace"
        if workspace is not None:
            if not workspace.is_dir():
                raise ValueError(f"workspace is not a directory: {workspace}")

            def ignore(directory: str, names: list[str]) -> set[str]:
                ignored = {
                    ".git",
                    "node_modules",
                    "dist",
                    "__pycache__",
                    ".pytest_cache",
                }
                ignored.update(
                    name for name in names if name == ".env" or name.startswith(".env.")
                )
                return ignored.intersection(names)

            shutil.copytree(workspace, target, ignore=ignore, symlinks=False)
        else:
            target.mkdir(parents=True)
        yield target
