# F3b — OpenCode V2 bounded read

Date: 2026-10-15

Runtime: OpenCode v2.0.29 from the isolated `~/pantheon-sandbox` install

Package candidate: `1.6.0-beta.10`

## Result

F3b is accepted with Themis **PASS_WITH_NOTES**. The V2 plugin registers the
dedicated `pantheon_bounded_read` tool only when the host exposes the required
location, session, tool, event, and native permission APIs. The tool requires a
fresh, exact `tool.execute.before` origin, an authoritative root Zeus session,
the active project identity, and an exact relative path. It requests native
`read` permission for that file on each call with `save: []`; it reads only
after approval and passes returned content through the existing fail-closed
secret scanner.

Limits are enforced before file I/O: two calls and two distinct files, at most
400 lines and 32 KiB per assistant message, with per-call reservations. Empty
files remain distinct from limits. The implementation rejects traversal,
absolute paths, URIs, symlinks, directories, sensitive scopes, recognized
binary/media formats, malformed UTF-8 in the inspected prefix, and scanner
failures. No persistent permission grant is created.

## Runtime evidence

The isolated OpenCode v2.0.29 canary exercised three successful bounded reads
in two root sessions. Each call produced a native `read` ask for exactly the
requested file; its permission source matched the session, message, and tool
call IDs from `tool.execute.before`. The host returned only the requested line
window. The saved-permission state was unchanged before and after the calls.
The deny profile returned `TOOL_DENIED` and exposed none of the fixture's
content. The run passed 16 checks, failed 0, and skipped 5 unrelated opt-in
profiles.

Focused unit coverage passed 14/14 cases, including root/child identity,
origin freshness and one-shot use, path validation, sensitive scopes, malformed
UTF-8, symlinks/directories, output budgets, concurrency, empty files, and
fail-closed scanning. Focused Biome and `npm run typecheck` passed.

## Limits and reviewer notes

Themis reviewed the implementation and host evidence: **PASS_WITH_NOTES**.

- Intermediate path components are checked, but a concurrent hostile workspace
  can still race a directory swap between checks and open. The supported scope
  is a local workspace without concurrent writers; this is not an adversarial
  filesystem isolation boundary.
- Binary rejection covers recognized extensions, control bytes, and malformed
  UTF-8 in the inspected prefix. A mislabeled file with binary bytes outside
  the requested window is not classified by scanning the whole file.
- The live canary proves root identity, source correlation, ask/reply,
  non-persistence, bounded output, and host denial. A direct live child-session
  bounded-read attempt was not added; child denial is covered by unit fixtures
  and the independent F4A host session-identity proof.

No latency or token reduction is claimed for F3b. It is a bounded V2 capability
whose permission and resource limits are verified.
