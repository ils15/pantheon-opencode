# Pantheon Scenario Test Suite

**Real implementation scenarios** that exercise the Pantheon ecosystem — not
unit tests of individual functions, but end-to-end workflow simulations.

## Purpose

Each scenario simulates a real development workflow:
implementing a feature, compressing context mid-session,
handling agent handoffs — and validates the pipeline.

## How to Run

```bash
cd /home/ils15/pantheon
bash .tests/run_all.sh
```

For a specific scenario:

```bash
bash .tests/run_all.sh scenarios/scenario_01_auth_endpoint.py -v
```

## Scenarios

(All scenarios have been removed. The `.tests/` framework is no longer active.)
