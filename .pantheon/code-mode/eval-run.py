#!/usr/bin/env python3
# ---
# description: plugin-eval orchestrator — runs static + LLM judge + Monte Carlo layers and emits one report JSON
# timeout: 300
# ---
"""Orchestrator for the plugin-eval certification pipeline (PR 3).

Runs the three layers in sequence (static → LLM judge → Monte Carlo) and
aggregates them into a single report JSON:

    {name, date, static, llm_judge, monte_carlo, overall_score, verdict}

Verdict thresholds: certified >= 75, needs_work 50-74, failed < 50. Layer
scripts may exit non-zero to signal a below-threshold score while still
printing a valid report; such layers are marked ``below_threshold`` and
their scores count toward the overall. Layers that fail outright (e.g. no
LLM available, invalid JSON) are recorded with an `error` field and
excluded from the overall score; the report still emits.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
STATIC_SCRIPT = SCRIPT_DIR / "eval-static.py"
JUDGE_SCRIPT = SCRIPT_DIR / "eval-llm-judge.py"
MONTE_SCRIPT = SCRIPT_DIR / "eval-monte-carlo.py"
LAYER_TIMEOUT = 240.0
SCORE_KEYS = ("score", "overall", "overall_score", "reliability", "total")


def _run_layer(script: Path, target: str, extra: list[str] | None = None) -> dict[str, Any]:
    """Run one layer script; return parsed JSON or an error dict.

    A non-zero exit is not fatal by itself: layer scripts print their report
    JSON before exiting non-zero to signal a below-threshold score (e.g.
    eval-monte-carlo.py exits 1 when reliability < 75). In that case the
    parsed report is returned with ``below_threshold`` set so its score
    still counts toward the overall verdict. Only when stdout holds no
    usable report does the layer degrade to an error dict.
    """
    cmd = [sys.executable, str(script), target, *(extra or [])]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=LAYER_TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        return {"error": f"{script.name} timed out"}
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        if proc.returncode != 0:
            return {"error": proc.stderr.strip() or f"{script.name} exited {proc.returncode}"}
        return {"error": f"{script.name} returned invalid JSON: {exc}"}
    if not isinstance(data, dict):
        if proc.returncode != 0:
            return {"error": proc.stderr.strip() or f"{script.name} exited {proc.returncode}"}
        return {"error": f"{script.name} returned non-object JSON"}
    if proc.returncode != 0:
        data["below_threshold"] = True
    return data


def _extract_score(data: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    """Find the first numeric score under any key, recursing into nested dicts."""
    for key in keys:
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    for value in data.values():
        if isinstance(value, dict):
            found = _extract_score(value, keys)
            if found is not None:
                return found
    return None


def _verdict(score: float) -> str:
    if score >= 75:
        return "certified"
    if score >= 50:
        return "needs_work"
    return "failed"


def _doc_name(path: Path) -> str:
    """Best-effort name from the doc frontmatter, falling back to the stem."""
    if path.is_file():
        doc = path
    else:
        skill = path / "SKILL.md"
        doc = skill if skill.is_file() else path
    try:
        text = doc.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return path.stem
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].splitlines():
                if line.startswith("name:"):
                    return line.split(":", 1)[1].strip().strip('"').strip("'")
    return path.stem


def _persist_report(report: dict[str, Any]) -> None:
    """Best-effort publish of the final report to the ``plugin_eval`` namespace.

    Reuses ``src/mcp/eval_store.py`` (stdlib-only, designed to be loaded from
    .pantheon/code-mode/ scripts via importlib) so DB path resolution
    (PANTHEON_HOME → XDG → ~/.config/opencode), schema and dedup stay in one
    place. Never raises: failures print a hint to stderr — the JSON report on
    stdout remains the single source of truth. No-op under pytest so tests
    never touch the real memory DB.
    """
    if "PYTEST_CURRENT_TEST" in os.environ:
        return
    try:
        store_path = SCRIPT_DIR.parent.parent / "src" / "mcp" / "eval_store.py"
        spec = importlib.util.spec_from_file_location("eval_store", str(store_path))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.store_eval(
            report["name"], report, int(report.get("overall_score", 0)), report["date"]
        )
        if "error" in result:
            print(f"eval_store: {result['error']}", file=sys.stderr)
    except Exception:  # noqa: BLE001
        print("To publish: use eval_store.store_eval() or the pantheon-memory MCP",
              file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: `python eval-run.py <path> [--runs N] [--skip-llm]`."""
    parser = argparse.ArgumentParser(
        description="plugin-eval orchestrator (static + LLM judge + Monte Carlo)."
    )
    parser.add_argument("path", help="Path to a skill/agent directory or doc file")
    parser.add_argument("--runs", type=int, default=20, help="Monte Carlo runs (default 20)")
    parser.add_argument("--skip-llm", action="store_true", help="Skip the LLM judge layer")
    parser.add_argument("--allow-external-llm", action="store_true", help="Permit the LLM judge to send skill content externally")
    args = parser.parse_args(argv)

    report: dict[str, Any] = {
        "name": _doc_name(Path(args.path)),
        "date": date.today().isoformat(),
        "static": {},
        "llm_judge": {},
        "monte_carlo": {},
    }
    scores: list[float] = []

    if STATIC_SCRIPT.exists():
        static = _run_layer(STATIC_SCRIPT, args.path)
        report["static"] = static
        score = _extract_score(static, SCORE_KEYS)
        if score is not None:
            scores.append(score)
    else:
        report["static"] = {"skipped": True, "reason": "eval-static.py not present yet"}

    if args.skip_llm:
        report["llm_judge"] = {"skipped": True}
    else:
        judge_extra = ["--allow-external-llm"] if args.allow_external_llm else []
        judge = _run_layer(JUDGE_SCRIPT, args.path, judge_extra)
        report["llm_judge"] = judge
        score = _extract_score(judge, ("overall", "score"))
        if score is not None:
            scores.append(score)

    monte = _run_layer(MONTE_SCRIPT, args.path, ["--runs", str(args.runs)])
    report["monte_carlo"] = monte
    score = _extract_score(monte, ("reliability", "score"))
    if score is not None:
        scores.append(score)

    overall = round(sum(scores) / len(scores), 1) if scores else 0.0
    report["overall_score"] = overall
    report["layers_scored"] = len(scores)
    if not scores:
        report["note"] = "no layer produced a score; overall_score is 0"
    report["verdict"] = _verdict(overall)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    _persist_report(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
