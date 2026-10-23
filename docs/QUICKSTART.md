# Quick Start

The first ten minutes: install, restart, dispatch, and read the first result.
Installer flags, exit codes, saved plans, backups, and uninstall have their own
home in [Installation](INSTALLATION.md).

## Before you start

You need OpenCode and a supported Node.js. The exact versions and the per-host
evidence are in [Compatibility](COMPATIBILITY.md). Python is only needed for the
optional MCP servers.

## 1. Install

From the project where you want to use Pantheon:

```bash
npx pantheon-opencode init
```

The interactive setup chooses components and a global or project location
before reviewing the apply. Canceling writes nothing.

## 2. Restart OpenCode

```bash
opencode
```

Restart is required after installing or changing the plugin generation. A
restart reloads the selected plugin; it is not an automatic resume of delegated
work.

## 3. Check the install

```bash
npx pantheon-opencode doctor
```

`doctor` validates the installed package, the plugin registration, the MCP
servers, and drift between the installed version and the running package. A
healthy install reports no warning.

## 4. Dispatch your first task

Describe the outcome, not the steps:

```text
/pantheon Add CSV export to the reports page, including tests and a review.
```

Or open the dispatch panel to watch delegated work:

```text
/dispatch
```

`/dispatch` opens the same delegation tree the sidebar summarizes, with one row
per child and detail for the selected child. It needs an open session.

## What you should see

- Zeus routes the request. Bounded work goes to one specialist; planning,
  discovery, and review are added when scope and risk call for them.
- When a plan is requested, Athena returns it to Zeus, who displays the full
  plan in the main conversation before asking for approval.
- Implementation agents return `## subtask_summary`; investigations return
  structured findings. A child that returns nothing is surfaced as an error,
  not as a silent success.

## Next steps

- [Installation](INSTALLATION.md) — flags, saved plans, backup, uninstall,
  reconcile, MCP pins.
- [OpenCode V2](opencode-v2.md) — sidebar block, `/dispatch` panel, context
  pruning, memory injection, session goals.
- [MCP](MCP.md) and [MCP Tools](mcp-tools.md) — servers and tool signatures.
- [Memory](MEMORY.md) — what is stored, for how long, and when to search.
