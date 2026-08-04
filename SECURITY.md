# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities **privately** via the GitHub Security
Advisory — do **not** open a public issue for security problems:

<https://github.com/ils15/pantheon-opencode/security/advisories/new>

When reporting, include if possible:

- Type of vulnerability and its impact
- Steps to reproduce (without exposing live secrets)
- Affected component and version
- Suggested remediation (optional)

We aim to acknowledge reports within 48 hours and to ship a fix as soon as
practicable. Please refrain from public disclosure until a fix is released or
the report is closed.

## Secret Handling

- Secrets must **never** be committed to this repository.
- CI enforces this with **fail-closed** gates (`.github/workflows/security.yml`):
  - **gitleaks** — full history on push to `main`, PR diff on `pull_request`,
    full repo scan on `workflow_dispatch` (config: `.gitleaks.toml`);
  - **custom scan** — Bifrost MCP credentials (`x-bf-vk` header, `sk-bf-*`
    tokens), literal API keys and bearer tokens (`scripts/secret-scan.mjs`);
  - **critical-pattern scan** — private key blocks, GitHub/npm/AWS/Google/
    Slack tokens, `sk-*` keys, and tracked `.env` files.
- **Any finding (any severity) fails the scan.** There is no `.gitleaksignore`
  exemption path.
- If a secret is ever detected, **rotate it immediately** and treat it as
  compromised — even if it is later removed from history, assume it was
  captured. Revoke the value, purge it from history (rewrite + force-push all
  refs/tags), and document the incident here.

## Incident History

### 2026-08-03 — Bifrost MCP credential leak

- A Bifrost MCP credential (`x-bf-vk` header value / `sk-bf-*` token) leaked
  into the public commit history and an npm package artifact.
- **Keys have been revoked and rotated.**
- The affected history was **purged on 2026-08-03**.
- Follow-up: fail-closed secret scan gates (`security.yml` + `.gitleaks.toml`)
  were added to this repository to prevent recurrence.
