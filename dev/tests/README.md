# Pickleball host test harness

Development-only harness for typed decisions, the host skill registry, and a
local read-only MCP resource. It adds no browser UI, localhost bridge, or
production behavior. The package `files` allowlist omits `dev/`.

## Offline tests

```sh
node --test dev/tests/harness.test.mjs
```

The typed-decision sample is labeled `stub/offline`; it validates synthetic
choice, score, and predicate answers without a host or provider. The standalone
fixture test exercises its local MCP `resources/list` and `resources/read`
responses and confirms `tools/call` is rejected. Those checks are not host
evidence.

## Isolated OpenCode host test

```sh
PICKLEBALL_OPENCODE_BIN="$(command -v opencode)" \
PICKLEBALL_NODE_BIN="$(command -v node)" \
  ./dev/tests/run-host-runtime.sh
```

Requires OpenCode, Node.js, and `bubblewrap`. The wrapper uses a fixed trusted
system `PATH` for its pre-sandbox helpers; set `PICKLEBALL_NODE_BIN` explicitly
when Node.js is outside that path. It sanitizes the child environment
and runs the host, stub model, and stdio fixture MCP inside a private network
namespace. The harness creates temporary HOME/XDG/project roots and deletes
them in `finally`; it inherits no user MCP, memory, auth, or OpenCode config and
has no external network route. The provider endpoint and MCP process are local
fixtures only.

The host plugin feature-detects each runtime method before use. It seeds an
in-memory synthetic `pickleball-basics` skill through the host's
`ctx.skill.transform`, then measures and verifies `ctx.skill.list()`. This tests
the real host registry, not disk-based skill discovery. The runner calls the
host's official MCP resource-catalog endpoint and verifies that the local
fixture's synthetic resource was listed. OpenCode exposes catalog listing but
not a resource-content read operation in this host path; the runner records
`mcp.resources.read` as unsupported and does not claim a host read. The offline
fixture's direct `resources/read` test remains distinctly offline.

Each evidence entry includes host version, operation, `mode` (`host` or
`stub/offline`), status, and monotonic `durationMs`. Output contains only
synthetic fixture identifiers, counts, method names, and capability status;
resource/skill content and credentials are not logged. Durations are
observations only, with no pass/fail latency thresholds. Native Jev capability
is detected but never invoked by this command.

## Explicit live Jev command (not run by tests)

```sh
PICKLEBALL_LIVE_HOME=/path/to/private/prepared-home \
PICKLEBALL_LIVE_MODEL=provider/model \
node dev/tests/live-jev.mjs --live-jev
```

This separate command requires a private prepared HOME with an existing
`~/.config/pantheon/decision-router.json`, a host model, a TTY, and exact
interactive confirmation. It loads the unchanged production V2 plugin and
asks Zeus to invoke `pantheon_jev_decide` with synthetic pickleball questions.
It does not set egress consent, permission rules, or budget caps; the existing
decision-router and `decision.egress` gates remain authoritative. Provider
egress and charges are possible. Do not use a normal user HOME as
`PICKLEBALL_LIVE_HOME`.
