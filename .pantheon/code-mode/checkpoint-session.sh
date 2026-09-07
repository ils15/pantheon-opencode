#!/bin/bash
# Wrapper for checkpoint_session.py
# Usage: ./checkpoint-session.sh <command> <slug>
#
# Commands: init, save, status, resume, list, health, archive, cleanup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 "$SCRIPT_DIR/checkpoint_session.py" "$@"
