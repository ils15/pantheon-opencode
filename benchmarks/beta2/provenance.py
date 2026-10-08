"""Reproduce source-file provenance from immutable Git revisions."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Final

SNAPSHOTS: Final[dict[str, str]] = {
    "historical_938": "beecdd737adc69e6622815bfd40af5d2359e8376",
    "historical_936": "1c2ddacabed8d441ed70d543e809aab919343ca4",
    "current_f1": "850191c2fffee112386cc16fd983e6073f7884d8",
}
AGENTS_PATH: Final[str] = "AGENTS.md"
DELTA_SOURCE: Final[str] = "src/instructions/memory-protocol.instructions.md"
LINE_COUNT_CONVENTION: Final[str] = (
    "LF-delimited logical lines; count a final unterminated line once; "
    "empty content has zero lines"
)


def logical_line_count(content: bytes) -> int:
    """Count LF-delimited lines without requiring a final newline."""
    if not content:
        return 0
    return content.count(b"\n") + (not content.endswith(b"\n"))


def _git(repo_root: Path, *args: str) -> bytes:
    completed = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        capture_output=True,
        check=True,
    )
    return completed.stdout


def _file_provenance(repo_root: Path, revision: str) -> dict[str, object]:
    commit_sha = _git(repo_root, "rev-parse", "--verify", f"{revision}^{{commit}}")
    commit = commit_sha.decode("ascii").strip()
    blob = _git(repo_root, "rev-parse", "--verify", f"{commit}:{AGENTS_PATH}")
    blob_sha = blob.decode("ascii").strip()
    content = _git(repo_root, "cat-file", "blob", blob_sha)
    return {
        "commit_sha": commit,
        "path": AGENTS_PATH,
        "blob_sha": blob_sha,
        "content_sha256": hashlib.sha256(content).hexdigest(),
        "bytes": len(content),
        "line_count": logical_line_count(content),
        "ends_with_lf": content.endswith(b"\n"),
    }


def _diff_counts(
    repo_root: Path, old_revision: str, new_revision: str
) -> tuple[int, int]:
    output = _git(
        repo_root,
        "diff",
        "--numstat",
        old_revision,
        new_revision,
        "--",
        AGENTS_PATH,
    )
    added, removed, _path = output.decode("utf-8").strip().split("\t", 2)
    return int(added), int(removed)


def collect_baseline_provenance(repo_root: Path) -> dict[str, object]:
    """Resolve the F0/F1 snapshots from Git and document their line delta."""
    snapshots = {
        name: _file_provenance(repo_root, revision)
        for name, revision in SNAPSHOTS.items()
    }
    added, removed = _diff_counts(
        repo_root, SNAPSHOTS["historical_936"], SNAPSHOTS["historical_938"]
    )
    line_delta = int(snapshots["historical_938"]["line_count"]) - int(
        snapshots["historical_936"]["line_count"]
    )
    return {
        "schema_version": "pantheon.agent-baseline-provenance.v1",
        "line_count_convention": LINE_COUNT_CONVENTION,
        "snapshots": snapshots,
        "historical_delta": {
            "from": "historical_936",
            "to": "historical_938",
            "line_delta": line_delta,
            "added_lines": added,
            "removed_lines": removed,
            "source_instruction": DELTA_SOURCE,
            "explanation": (
                "The later memory-protocol guidance has 14 added and 12 removed "
                "AGENTS.md lines, a net increase of two; the removed claimed "
                "token saving is not converted into a metric."
            ),
        },
    }


def main(argv: list[str] | None = None) -> int:
    """Print or write a reproducible baseline provenance manifest."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo", type=Path, default=Path(__file__).resolve().parents[2]
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    manifest = collect_baseline_provenance(args.repo)
    serialized = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(serialized, encoding="utf-8")
    else:
        print(serialized, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
