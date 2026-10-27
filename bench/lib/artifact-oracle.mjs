import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ARTIFACT_BYTES = 64 * 1024
const TOP_COUNTRIES = [
  /(?:^|\|)\s*(?:India|Índia)\s*(?:\||$)/i,
  /(?:^|\|)\s*China\s*(?:\||$)/i,
  /(?:^|\|)\s*(?:United States|Estados Unidos|USA|EUA)\s*(?:\||$)/i,
]

function unavailable(reason) {
  return { status: 'unavailable', reason }
}

/** Check the small, static artifact required by the built-in scenario B. */
export function assessScenarioArtifact({ scenario, runDir, customPrompt = false }) {
  if (scenario !== 'B' || customPrompt) {
    return unavailable('no artifact oracle is defined for this scenario/prompt')
  }

  const artifact = 'bench-run-B.md'
  const path = join(runDir, artifact)
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return { status: 'failed', artifact, reason: 'required artifact is missing' }
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { status: 'failed', artifact, reason: 'required artifact is not a regular file' }
  }
  if (stat.size === 0 || stat.size > MAX_ARTIFACT_BYTES) {
    return {
      status: 'failed',
      artifact,
      bytes: stat.size,
      reason: 'artifact size is outside the accepted bounds',
    }
  }

  let bytes
  try {
    bytes = readFileSync(path)
  } catch {
    return { status: 'failed', artifact, reason: 'required artifact could not be read' }
  }
  const content = bytes.toString('utf8')
  if (!Buffer.from(content, 'utf8').equals(bytes)) {
    return {
      status: 'failed',
      artifact,
      bytes: bytes.byteLength,
      reason: 'artifact is not valid UTF-8',
    }
  }

  const lines = content.split(/\r?\n/)
  const tableLines = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line))
  const markdownTable =
    tableLines.length >= 5 &&
    lines.some((line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
  const populationColumn = tableLines.some((line) =>
    /\b(?:population|popula(?:ção|cao))\b/i.test(line),
  )
  const dataRows = tableLines.filter((line) => /\d/.test(line))
  const topThreeCountries = TOP_COUNTRIES.filter((country) =>
    dataRows.some((line) => country.test(line)),
  ).length
  const checks = { markdownTable, populationColumn, topThreeCountries }
  const valid = markdownTable && populationColumn && topThreeCountries === TOP_COUNTRIES.length

  return valid
    ? { status: 'ok', artifact, bytes: bytes.byteLength, checks }
    : {
        status: 'failed',
        artifact,
        bytes: bytes.byteLength,
        checks,
        reason: 'artifact does not contain the required population table',
      }
}
