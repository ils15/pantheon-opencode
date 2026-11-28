#!/usr/bin/env node
/**
 * verify-zenodo.mjs — assert that Zenodo's newest archived Pantheon version is
 * the version this checkout expects.
 *
 * Why this exists: the release gates compare version *strings* between the
 * committed manifests. Nothing in the pipeline ever asks Zenodo what it
 * actually archived, so an archive that silently stops (or deposits a stale
 * `.zenodo.json`) is invisible until someone reads the DOI. This script is the
 * missing check: it reads the concept DOI, resolves it against Zenodo's REST
 * API, and compares the latest archived `version` with the expected one.
 *
 * Usage:
 *   node scripts/verify-zenodo.mjs                  # expected = package.json version
 *   node scripts/verify-zenodo.mjs --expected 2.4.0
 *   node scripts/verify-zenodo.mjs --json
 *
 * Exit codes:
 *   0  latest archived version matches
 *   1  version mismatch (the concept lags or leads the expectation)
 *   2  usage error (bad flag / non-semver --expected)
 *   3  Zenodo API or network error
 *   4  malformed API payload (or a record outside the concept family)
 *
 * The HTTP client is injectable so the tests never touch the network.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ZENODO_CONCEPT_DOI,
  ZENODO_CONCEPT_RECID,
  ZENODO_CONCEPT_RECORD_URL,
} from './zenodo-record.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Zenodo's edge answers **403** to a bare Node `fetch` (no descriptive
 * User-Agent) while the same request from curl succeeds. The header is part of
 * the contract, not decoration: without it this check cannot see the API.
 */
const REQUEST_HEADERS = Object.freeze({
  accept: 'application/json',
  'user-agent': 'pantheon-zenodo-verify (+https://github.com/ils15/pantheon-opencode)',
})
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export { ZENODO_CONCEPT_DOI, ZENODO_CONCEPT_RECID, ZENODO_CONCEPT_RECORD_URL }

export const ZENODO_EXIT = Object.freeze({
  ok: 0,
  mismatch: 1,
  usage: 2,
  api: 3,
  payload: 4,
})

export class ZenodoVerifyError extends Error {
  constructor(message, exitCode) {
    super(message)
    this.name = 'ZenodoVerifyError'
    this.exitCode = exitCode
  }
}

function normalizeVersion(value) {
  return String(value ?? '')
    .trim()
    .replace(/^v/i, '')
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ZenodoVerifyError(
      `malformed Zenodo payload: ${label} is missing`,
      ZENODO_EXIT.payload,
    )
  }
  return value.trim()
}

function recordFileSize(files) {
  if (!Array.isArray(files) || files.length === 0) return 0
  return files.reduce((total, file) => {
    const size = Number(file?.size ?? file?.filesize ?? 0)
    return Number.isFinite(size) ? total + size : total
  }, 0)
}

/**
 * Reduce a Zenodo record payload to the fields this check reports, rejecting
 * anything that does not look like the concept's record. A malformed payload
 * must never be read as "version matched".
 */
export function summarizeRecord(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ZenodoVerifyError('malformed Zenodo payload: expected an object', ZENODO_EXIT.payload)
  }
  if (payload.hits !== undefined) {
    throw new ZenodoVerifyError(
      'malformed Zenodo payload: got a search result, expected a record',
      ZENODO_EXIT.payload,
    )
  }

  const recordId = Number(payload.id ?? payload.recid)
  if (!Number.isInteger(recordId) || recordId <= 0) {
    throw new ZenodoVerifyError(
      'malformed Zenodo payload: record id is missing',
      ZENODO_EXIT.payload,
    )
  }

  const conceptRecid = String(payload.conceptrecid ?? '').trim()
  if (conceptRecid.length === 0) {
    throw new ZenodoVerifyError(
      'malformed Zenodo payload: conceptrecid is missing',
      ZENODO_EXIT.payload,
    )
  }
  if (conceptRecid !== ZENODO_CONCEPT_RECID) {
    throw new ZenodoVerifyError(
      `record ${recordId} belongs to conceptrecid ${conceptRecid}, not ${ZENODO_CONCEPT_RECID} — the configured DOI is not Pantheon's concept DOI`,
      ZENODO_EXIT.payload,
    )
  }

  const metadata = payload.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new ZenodoVerifyError(
      'malformed Zenodo payload: metadata is missing',
      ZENODO_EXIT.payload,
    )
  }

  const version = normalizeVersion(requireString(metadata.version, 'metadata.version'))
  const publicationDate =
    typeof metadata.publication_date === 'string' ? metadata.publication_date.trim() : null
  const files = Array.isArray(payload.files) ? payload.files : null

  return {
    recordId,
    conceptRecid,
    doi: requireString(payload.doi, 'doi'),
    version,
    publicationDate,
    fileCount: files ? files.length : 0,
    fileSize: recordFileSize(files),
  }
}

const TRANSPORT_ATTEMPTS = 3

/**
 * Transport failures (DNS, connect timeouts — Zenodo's edge rotates addresses)
 * are retried a bounded number of times. A completed HTTP response is never
 * retried: a 403/404/5xx from Zenodo is an answer, not noise.
 */
async function readJson(fetchImpl, url, { attempts = TRANSPORT_ATTEMPTS } = {}) {
  let response
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetchImpl(url, { headers: { ...REQUEST_HEADERS } })
      break
    } catch (error) {
      if (attempt === attempts) {
        throw new ZenodoVerifyError(
          `Zenodo request failed after ${attempts} attempts: ${error?.message ?? String(error)}`,
          ZENODO_EXIT.api,
        )
      }
    }
  }
  if (response?.ok !== true) {
    const status = response?.status ?? 'unknown'
    throw new ZenodoVerifyError(`Zenodo API responded ${status} for ${url}`, ZENODO_EXIT.api)
  }
  try {
    return await response.json()
  } catch (error) {
    throw new ZenodoVerifyError(
      `malformed Zenodo payload: invalid JSON (${error?.message ?? String(error)})`,
      ZENODO_EXIT.payload,
    )
  }
}

/**
 * Resolve the concept DOI and compare its latest archived version.
 *
 * @returns {Promise<{ok: boolean, exitCode: number, expected: string,
 *   conceptDoi: string, conceptRecid: string, latest: object, reason: string|null}>}
 */
export async function verifyZenodo({
  expected,
  fetchImpl = globalThis.fetch,
  url = ZENODO_CONCEPT_RECORD_URL,
  root = ROOT,
} = {}) {
  const target = normalizeVersion(expected ?? readPackageVersion(root))
  if (!SEMVER_PATTERN.test(target)) {
    throw new ZenodoVerifyError(
      `expected version must be semver, got "${target}"`,
      ZENODO_EXIT.usage,
    )
  }
  if (typeof fetchImpl !== 'function') {
    throw new ZenodoVerifyError('no fetch implementation available', ZENODO_EXIT.api)
  }

  const latest = summarizeRecord(await readJson(fetchImpl, url))
  const ok = latest.version === target

  return {
    ok,
    exitCode: ok ? ZENODO_EXIT.ok : ZENODO_EXIT.mismatch,
    expected: target,
    conceptDoi: ZENODO_CONCEPT_DOI,
    conceptRecid: ZENODO_CONCEPT_RECID,
    latest,
    reason: ok
      ? null
      : `Zenodo's latest archived version is ${latest.version} (record ${latest.recordId}), expected ${target}`,
  }
}

export function readPackageVersion(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new ZenodoVerifyError('package.json has no version', ZENODO_EXIT.usage)
  }
  return manifest.version
}

function formatBytes(bytes) {
  if (!bytes) return '0 bytes'
  const mib = bytes / (1024 * 1024)
  return `${mib.toFixed(2)} MiB (${bytes} bytes)`
}

const HELP = `Usage: node scripts/verify-zenodo.mjs [--expected <version>] [--json]

Assert that Zenodo's latest archived Pantheon version equals the expected one.

Options:
  --expected <version>  Version to require (default: package.json's version)
  --json                Emit a machine-readable report on stdout
  -h, --help            Show this help

Exit codes:
  0  latest archived version matches
  1  version mismatch (concept lags or leads the expectation)
  2  usage error
  3  Zenodo API or network error
  4  malformed payload, or a record outside Pantheon's concept family
`

function humanReport(result) {
  const { latest } = result
  return [
    `Zenodo concept DOI ${result.conceptDoi} (conceptrecid ${result.conceptRecid})`,
    `Latest archived version ${latest.version} — record ${latest.recordId}`,
    `  version DOI ${latest.doi}`,
    `  published   ${latest.publicationDate ?? 'unknown'}`,
    `  archive     ${formatBytes(latest.fileSize)} (${latest.fileCount} file(s))`,
    `Expected version ${result.expected}`,
    result.ok
      ? "OK: the concept's latest archived version matches the expected version."
      : `MISMATCH: ${result.reason}`,
  ].join('\n')
}

/**
 * CLI entry point. Returns `{ exitCode, stdout, stderr }` so the exit-code
 * contract is testable without spawning a process or touching the network.
 */
export async function runCli({ argv = [], fetchImpl, root = ROOT } = {}) {
  let expected
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      return { exitCode: ZENODO_EXIT.ok, stdout: HELP, stderr: '' }
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--expected') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) {
        return {
          exitCode: ZENODO_EXIT.usage,
          stdout: '',
          stderr: '--expected requires a version argument',
        }
      }
      expected = value
      index += 1
      continue
    }
    return {
      exitCode: ZENODO_EXIT.usage,
      stdout: '',
      stderr: `unknown argument: ${arg}\n\n${HELP}`,
    }
  }

  if (expected !== undefined && !SEMVER_PATTERN.test(normalizeVersion(expected))) {
    return {
      exitCode: ZENODO_EXIT.usage,
      stdout: '',
      stderr: `--expected must be a semver version, got "${expected}"`,
    }
  }

  try {
    const result = await verifyZenodo({ expected, fetchImpl, root })
    if (json) {
      const { exitCode, ...report } = result
      return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' }
    }
    const output = `${humanReport(result)}\n`
    return result.ok
      ? { exitCode: result.exitCode, stdout: output, stderr: '' }
      : { exitCode: result.exitCode, stdout: '', stderr: output }
  } catch (error) {
    const exitCode = error instanceof ZenodoVerifyError ? error.exitCode : ZENODO_EXIT.api
    return { exitCode, stdout: '', stderr: `${error?.message ?? String(error)}\n` }
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const { exitCode, stdout, stderr } = await runCli({ argv: process.argv.slice(2) })
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  process.exitCode = exitCode
}
