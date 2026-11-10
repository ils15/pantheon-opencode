# Live J2 scorecard — 2026-11-10

Route: `opencode/jev-1.13`. Operator-run via `opencode api`
(consented route, billed to the user). 16 scenarios; agreement between the
live model and the expected pick is the metric — this measures the MODEL,
unlike the offline harness that measures the plumbing.

| state (truncated) | expect | live | cost |
| --- | --- | --- | --- |
| Investigate why the payment webhook drops events… | apollo | nyx | 0.00002386 |
| Plan the database migration for the new billing … | athena | demeter | 0.00002373 |
| Review the auth flow for security gaps before th… | themis | themis | 0.00002377 |
| Implement the retry queue endpoint for the notif… | hermes | hermes | 0.00002373 |
| Set up the CI pipeline for the new monorepo layo… | prometheus | prometheus | 0.00002386 |
| Audit the permissions matrix across all speciali… | themis | themis | 0.00002365 |
| Design the caching layer for the read-heavy dash… | athena | athena | 0.00002373 |
| none — greet the user and ask what they want | none | none | 0.00002377 |
| Write the SQL indexes and stored procedures for … | demeter | demeter | 0.00002381 |
| Process the satellite imagery tiles and classify… | gaia | gaia | 0.00002373 |
| Integrate the new LLM provider SDK and wire the … | hephaestus | hephaestus | 0.00002394 |
| Migrate the open issues to the new milestone lab… | iris | iris | 0.00002394 |
| Decide which stale session summaries are worth k… | mnemosyne | mnemosyne | 0.00002373 |
| Fuzz the input parser with malformed payloads to… | nyx | themis | 0.0000239 |
| Fix the typo that makes the CLI parse --verbose … | talos | talos | 0.00002394 |
| Polish the onboarding screen layout and micro-in… | aphrodite | aphrodite | 0.00002398 |

Total cost: $0.000381 (sum of route-reported costs). Honest caveat: one run is a smoke
measurement, not a calibration — a claim about model quality needs
repeated runs and a bigger scenario set.
