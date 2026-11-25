import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  artifactKindLabel,
  formatArtifactLines,
  paginateArtifactLines,
  scanPantheonArtifacts,
} from '../src/plugins/tui/src/artifacts-state.ts'
import { handleMouseClick, stopMouseEvent } from '../src/plugins/tui/src/mouse-click.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('scanPantheonArtifacts finds plans, reports, and ADRs across main repo and worktrees', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pantheon-artifacts-'))
  try {
    const repo = join(tmp, 'main-repo')
    const wt = join(tmp, 'wt-feature')
    mkdirSync(join(repo, '.git', 'worktrees', 'wt-feature'), { recursive: true })
    mkdirSync(join(repo, '.pantheon', 'deepwork', 'auth-oauth'), { recursive: true })
    mkdirSync(join(repo, '.pantheon', 'reports'), { recursive: true })
    mkdirSync(join(repo, 'docs', 'adr'), { recursive: true })
    mkdirSync(wt, { recursive: true })

    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(repo, '.git', 'worktrees', 'wt-feature', 'commondir'), '../..\n')
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt-feature')}\n`)

    const planPath = join(repo, '.pantheon', 'deepwork', 'auth-oauth', 'PLAN.md')
    const reportPath = join(repo, '.pantheon', 'reports', '2026-11-19-security.md')
    const adrPath = join(repo, 'docs', 'adr', '001-native-tools.md')
    const adrReadme = join(repo, 'docs', 'adr', 'README.md')

    writeFileSync(planPath, '# Architectural Plan: OAuth2 PKCE\n\nDetails\n')
    writeFileSync(reportPath, '# Executive Report: Security Audit\n\nAll clean.\n')
    writeFileSync(adrPath, '# ADR-001: Native Tools\n\nAccepted.\n')
    writeFileSync(adrReadme, '# ADR Index\n')

    utimesSync(adrPath, new Date(1000), new Date(1000))
    utimesSync(reportPath, new Date(2000), new Date(2000))
    utimesSync(planPath, new Date(3000), new Date(3000))

    const fromWorktree = scanPantheonArtifacts(wt)
    assert.equal(
      fromWorktree.length,
      3,
      'worktree must see main repo artifacts and ignore README.md',
    )
    assert.deepEqual(
      fromWorktree.map((e) => [e.kind, e.title]),
      [
        ['plan', 'Architectural Plan: OAuth2 PKCE'],
        ['report', 'Executive Report: Security Audit'],
        ['adr', 'ADR-001: Native Tools'],
      ],
    )
    assert.equal(artifactKindLabel('plan', true), 'Plano')
    assert.equal(artifactKindLabel('report', false), 'Report')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('formatArtifactLines renders GFM alerts, Mermaid blocks, links, and paginates cleanly', () => {
  const md = [
    '# Plan Title',
    '',
    '> [!IMPORTANT]',
    '> Verify [`auth.ts`](file:///repo/src/auth.ts#L10-L20) before merge.',
    '',
    '```mermaid',
    'flowchart TD',
    '  A["Start"] --> B["Gate"]',
    '```',
    '',
    '- Bullet item one',
  ].join('\n')

  const lines = formatArtifactLines(md, 60)
  assert.ok(lines.includes('PLAN TITLE'))
  assert.ok(lines.includes('[IMPORTANT]'))
  assert.ok(lines.some((l) => l.includes('auth.ts#L10-L20')))
  assert.ok(lines.includes('[Diagram: Flowchart]'))
  assert.ok(lines.some((l) => l.includes('│ Start │')))
  assert.ok(lines.some((l) => l.includes('│ Gate │')))
  assert.ok(lines.some((l) => l.includes('▼')))
  assert.ok(lines.includes('• Bullet item one'))

  const pages = paginateArtifactLines(lines, 4)
  assert.ok(pages.length >= 2)
  assert.ok(pages.every((p) => p.length <= 4))
})

test('formatArtifactLines renders branching/converging DAG, sequenceDiagram, and stateDiagram as Unicode boxes', () => {
  const md = [
    '```mermaid',
    'flowchart TD',
    '  T1["T1: Schema & Migrations"] -->|ready| T2["T2: API"] & T3["T3: UI"]',
    '  T2 & T3 --> T4["T4: Audit"]',
    '```',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant Z as Zeus',
    '  participant A as Athena',
    '  Z->>A: plan task',
    '  A-->>Z: PLAN.md',
    '```',
    '',
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> Draft',
    '  Draft --> Approved : user confirm',
    '```',
  ].join('\n')

  const lines = formatArtifactLines(md, 76)
  assert.ok(lines.includes('[Diagram: Flowchart]'))
  assert.ok(lines.some((l) => l.includes('│ T1: Schema & Migrations │')))
  assert.ok(lines.some((l) => l.includes('├──► [ready] T2: API')))
  assert.ok(lines.some((l) => l.includes('│ T4: Audit │')))
  assert.ok(lines.includes('[Diagram: Sequence]'))
  assert.ok(lines.some((l) => l.includes('│ Zeus │') && l.includes('│ Athena │')))
  assert.ok(lines.some((l) => l.includes('├───────')))
  assert.ok(lines.includes('[Diagram: State]'))
  assert.ok(lines.some((l) => l.includes('user confirm')))
})

test('index.tsx wires /pantheon-artifacts command, Sidebar/Home artifact links, and initialArtifactId', () => {
  const indexSrc = readFileSync(join(root, 'src/plugins/tui/src/index.tsx'), 'utf8')
  const artifactsSrc = readFileSync(join(root, 'src/plugins/tui/src/artifacts.tsx'), 'utf8')
  const settingsSrc = readFileSync(join(root, 'src/plugins/tui/src/pantheon-settings.tsx'), 'utf8')
  assert.match(indexSrc, /import \{ openArtifactsDialog \} from '\.\/artifacts'/)
  assert.match(indexSrc, /id: 'pantheon\.artifacts\.open'/)
  assert.match(indexSrc, /name: 'pantheon-artifacts'/)
  assert.match(indexSrc, /useWorkspaceArtifacts/)
  assert.match(indexSrc, /initialArtifactId:\s*plan\(\)\.id/)
  assert.match(artifactsSrc, /initialArtifactId\?: string/)
  assert.match(artifactsSrc, /\(@iris\)/)
  assert.doesNotMatch(artifactsSrc, /@mnemosyne/)
  assert.match(settingsSrc, /\(viewMode === 'fullscreen' \|\| !sessionID\) && routerAvailable/)
})

test('TUI dialog shortcuts open on mouseUp with stopPropagation so mouse release does not dismiss the dialog', () => {
  const indexSrc = readFileSync(join(root, 'src/plugins/tui/src/index.tsx'), 'utf8')
  const artifactsSrc = readFileSync(join(root, 'src/plugins/tui/src/artifacts.tsx'), 'utf8')
  const cockpitSrc = readFileSync(join(root, 'src/plugins/tui/src/cockpit.tsx'), 'utf8')
  const whatsNewSrc = readFileSync(join(root, 'src/plugins/tui/src/whats-new.tsx'), 'utf8')

  // None of the dialog-opening shortcuts in index.tsx may fire inside onMouseDown
  for (const opener of ['openArtifactsDialog', 'openPantheonCockpit', 'openPantheonSettings']) {
    assert.equal(
      new RegExp(`onMouseDown=\\{[^}]*${opener}`).test(indexSrc),
      false,
      `${opener} must not open inside onMouseDown (mouseup hits newly mounted dialog backdrop)`,
    )
    assert.equal(
      new RegExp(`onMouseUp=\\{[\\s\\S]{0,160}${opener}`).test(indexSrc),
      true,
      `${opener} shortcut must open inside onMouseUp`,
    )
  }

  // Dialog buttons in artifacts/cockpit/whats-new must not close on bare onMouseDown
  assert.equal(/onMouseDown=\{[^}]*props\.onClose/.test(artifactsSrc), false)
  assert.equal(/onMouseDown=\{[^}]*props\.onClose/.test(cockpitSrc), false)
  assert.equal(/onMouseDown=\{[^}]*props\.onClose/.test(whatsNewSrc), false)

  // Runtime behavior: stopPropagation fires BEFORE action runs
  const trace = []
  const fakeEvent = {
    stopPropagation() {
      trace.push('stop')
    },
  }
  stopMouseEvent(fakeEvent)
  handleMouseClick(fakeEvent, () => trace.push('open'))
  assert.deepEqual(trace, ['stop', 'stop', 'open'])
  assert.doesNotThrow(() => handleMouseClick(null, () => {}))
})
