# Live J2 scorecard — 2026-11-04

Route: `openrouter/typesafe/jev-1.13`. Operator-run via `opencode api`
(consented route, billed to the user). 12 scenarios; agreement between the
live model and the expected pick is the metric — this measures the MODEL,
unlike the offline harness that measures the plumbing.

| state (truncated) | expect | live | cost |
| --- | --- | --- | --- |
| Investigate why the payment webhook drops events… | apollo | hermes | 0 |
| Plan the database migration for the new billing … | athena | demeter | 0 |
| Review the auth flow for security gaps before th… | themis | themis | 0 |
| Implement the retry queue endpoint for the notif… | hermes | hermes | 0 |
| Set up the CI pipeline for the new monorepo layo… | prometheus | prometheus | 0 |
| Audit the permissions matrix across all speciali… | themis | themis | 0 |
| Design the caching layer for the read-heavy dash… | athena | athena | 0 |
| none — greet the user and ask what they want | none | none | 0 |
| Write the SQL indexes and stored procedures for … | demeter | demeter | 0 |
| Process the satellite imagery tiles and classify… | gaia | gaia | 0 |
| Integrate the new LLM provider SDK and wire the … | hephaestus | hephaestus | 0 |
| Migrate the open issues to the new milestone lab… | iris | iris | 0 |
| Decide which stale session summaries are worth k… | mnemosyne | mnemosyne | 0 |
| Fuzz the input parser with malformed payloads to… | nyx | nyx | 0 |
| Verify the export module against the compliance … | talos | talos | 0 |
| Polish the onboarding screen layout and micro-in… | aphrodite | aphrodite | 0 |

Total cost: $0.000000. Honest caveat: one run is a smoke
measurement, not a calibration — a claim about model quality needs
repeated runs and a bigger scenario set.
