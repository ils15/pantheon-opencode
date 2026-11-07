---
name: agent-forge
description: "Forge a new OpenCode agent on demand. Use when the user asks for 'um agente que faça X', 'create an agent for X', or wants a specialist the roster lacks."
---

# Agent Forge

> **A new agent is a contract, not a vibe. Interview, draft against the canonical shape, confirm, forge — and never shadow an existing specialist.**

---

## When this fires

- The user asks for a dedicated agent ("cria um agente de reviews de PR", "I want an agent that watches deploys").
- A recurring task keeps being delegated with ad-hoc Briefs and would benefit from a standing definition.

Do NOT fire when an existing specialist covers the domain — route there instead (the 14 canonical agents + any agents already forged in this project).

---

## The interview (before any writing)

Ask AT MOST four questions, with your recommended default on each so silence proceeds:

1. **Gap** — what recurring task/domain should this agent own? (default: infer from the request)
2. **Surface** — which tools does it need? read-only, edit, shell, webfetch, MCP grants? (default: least privilege that can do the job)
3. **Scope** — project (`.opencode/agents/`) or user-global (`~/.config/opencode/agents/`)? (default: project)
4. **Model posture** — reasoning effort low/medium/high (default: medium; low for narrow mechanical agents).

Then present the draft definition for confirm-or-adjust BEFORE writing (the same contract discipline as prompt-refinery).

---

## The forged file (canonical shape)

```markdown
---
name: <kebab-id>                    # must NOT collide with the 14 canonical ids
description: "<what it owns> — <domain keywords for routing>. Use when <trigger>."
mode: subagent                      # or 'all' when it may also be invoked directly
reasoning_effort: low|medium|high
permission:
  read: allow
  grep: allow
  glob: allow
  edit: allow|deny                  # least privilege from the interview
  shell: allow|deny
  webfetch: allow|deny
  task: { "*": deny }               # forged agents do not dispatch by default
mcp_tools:                          # ONLY registered servers/tools; 'all' or exact lists
  pantheon-resources: all
skills: []                          # add only installed, reviewed skills
---

## MCP governance (identical ladder, grant-aware)
<copy the governance ladder block verbatim from any canonical agent — the
escalation order and cost rules are identical for every agent.>

## Role
<2-4 sentences: what it owns, what it NEVER does, and where it escalates.>
```

Rules that are NOT optional:

- **No collision** — the id must differ from every canonical agent and every already-forged agent in scope; on collision, propose a distinguishable name.
- **Grants must exist** — every `mcp_tools` entry names a server/tool that is actually registered; an exact list beats `all` whenever the role is narrow.
- **Governance identical** — the ladder block is byte-copied from a canonical agent; a forged agent never invents its own escalation rules.
- **Never overwrite** — if the target file exists, show it and ask before replacing.
- **Routing honesty** — project agents are picked up by the host automatically; do not claim they are in `routing.yml` or the decision catalogs (those are package-level and validated by tests).
- **Referência de fluxo**: o `skill-creator` da Anthropic (entender objetivo → quando ativa → formato → como testar → rascunho → iterar) é o precedentes do nosso interview → draft → confirm.

---

## After forging

Tell the user: restart OpenCode (or start a new session) for the host to load the new agent; invoke it with `@<name>`. If the agent should also appear in the local decision routing later, that is a package-level change — note it as a follow-up, never silently.
