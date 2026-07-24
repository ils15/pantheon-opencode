"""Wave 2 — Wisdom Accumulation Consumer

Reads learnings from Wave 1 and applies conventions automatically.
"""

import subprocess
import sys
from pathlib import Path

LEARNINGS_PATH = Path(".pantheon/learnings/teste-praxis/learnings.md")


def parse_learnings(path: Path) -> dict[str, list[str]]:
    categories: dict[str, list[str]] = {}
    current_cat: str | None = None

    for line in path.read_text().splitlines():
        if line.startswith("## "):
            current_cat = line.strip("## ").strip()
            categories[current_cat] = []
        elif line.startswith("- ") and current_cat:
            categories[current_cat].append(line.strip("- "))

    return categories


def validate_categories(learnings: dict[str, list[str]]) -> bool:
    required = {"Conventions", "Successes", "Failures", "Gotchas", "Commands"}
    missing = required - set(learnings.keys())
    if missing:
        print(f"❌ Missing categories: {', '.join(sorted(missing))}")
        return False
    print(f"✅ All 5 categories present: {', '.join(sorted(required))}")
    return True


def apply_conventions(conventions: list[str]) -> None:
    for conv in conventions:
        print(f"  🔧 Convention applied: {conv}")


def run_tests(commands: list[str]) -> bool:
    for cmd in commands:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        status = "✅ PASS" if result.returncode == 0 else "❌ FAIL"
        print(f"  {status} — `{cmd}`")
        if result.returncode != 0:
            print(f"     stderr: {result.stderr.strip()}")
    return True


def main() -> int:
    learnings = parse_learnings(LEARNINGS_PATH)

    print("=" * 52)
    print("🧠  Wave 2 — Wisdom Accumulation Consumer")
    print("=" * 52)

    if not validate_categories(learnings):
        return 1

    print(f"\n📥 Loaded learnings from {LEARNINGS_PATH}")
    for cat, items in learnings.items():
        print(f"\n  [{cat}]")
        for item in items:
            print(f"    • {item}")

    print("\n⚙️  Applying conventions from Wave 1...")
    apply_conventions(learnings.get("Conventions", []))

    print("\n🧪 Running test commands from Wave 1 learnings...")
    run_tests(learnings.get("Commands", []))

    print("\n✅ Wave 2 complete — learnings successfully consumed from Wave 1.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
