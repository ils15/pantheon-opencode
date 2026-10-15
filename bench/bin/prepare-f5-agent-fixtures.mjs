#!/usr/bin/env node
/** Materialize the frozen F5 Zeus control and current generated candidate. */
import { execFileSync } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparePairedAgentPromptFixtures } from '../lib/agent-prompt-fixtures.mjs'

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const outputRoot = process.argv[2] === undefined ? null : resolve(process.argv[2])

if (outputRoot === null || process.argv.length !== 3) {
  console.error('usage: node bench/bin/prepare-f5-agent-fixtures.mjs /tmp/f5-agents')
  process.exit(2)
}

const outputFromRepo = relative(REPO_ROOT, outputRoot)
if (outputFromRepo === '' || (outputFromRepo !== '..' && !outputFromRepo.startsWith(`..${sep}`))) {
  console.error('f5 fixtures must be written outside the repository')
  process.exit(2)
}

const fixtures = preparePairedAgentPromptFixtures({
  sourceAgentsDir: resolve(REPO_ROOT, 'src/agents'),
  controlZeusPromptPath: resolve(REPO_ROOT, 'bench/fixtures/f5-control-zeus.md'),
  outputRoot,
})
const sourceGitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).trim()
console.log(
  JSON.stringify(
    {
      sourceGitSha,
      control: fixtures.control,
      candidate: fixtures.candidate,
    },
    null,
    2,
  ),
)
