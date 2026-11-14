---
description: "Test economy — risk-based validation protocol and sub-10s test slicing."
name: "Test Economy"
---

Write one focused test per behavior; do not duplicate coverage.

- **Risk-Based Slicing**: Run narrowest slice (<10s) first; broaden only on cross-module, contract, auth, or DB risk.
- **Suite Escalation**: Full suites are for CI/release; state if execution is agent recommendation or mandatory gate.
- **Failure/Fix Loops**: Rerun ONLY failed checks; never repeat passing tests. Never delete tests to speed up checks.
- **Mapping Gaps & Receipts**: Missing tests use static check plus nearest slice; record command, duration, and pending gates.
- **CLI vs Code**: Run CLI binaries (`opencode-quota`, `git`, `npm`) via `shell`/`bash`, not eval; on failure, never glob `~/.config`.
- Test economy does NOT weaken stronger gates: auth, security, data-integrity, and required coverage.
