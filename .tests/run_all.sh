#!/bin/bash
set -e
PROJECT_DIR="$(dirname "$(cd "$(dirname "$0")" && pwd)")"
cd "$PROJECT_DIR"

pip3 install -q --break-system-packages -r .tests/requirements.txt 2>/dev/null

echo "=== Running Pantheon Scenario Tests ==="
python3 -m pytest .tests/scenarios/ -v --tb=long "$@"

echo "=== All scenarios complete ==="
