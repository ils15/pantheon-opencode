import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Hex digest length for every algorithm the Zenodo deposition API may report. */
const DIGEST_LENGTH = { md5: 32, sha256: 64 }

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function md5File(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex')
}

/**
 * Normalize a file checksum as returned by the Zenodo deposition files API.
 *
 * Zenodo computes an MD5 for every deposited file (developers.zenodo.org,
 * "Deposition File" representation: "MD5 checksum of file, computed by our
 * system"). The API emits it both as `md5:<hex>` and, because of a legacy
 * serialization bug kept for backward compatibility (zenodo/zenodo#628), as a
 * bare 32-character hex string without any algorithm prefix — the exact payload
 * that broke the v1.5.1 run (e.g. `d3359dca2f998da8461abb3b84a32b6c`).
 *
 * A bare 64-character digest is treated as SHA-256, so if the API ever upgrades
 * its algorithm the upload is still verified with a strong digest rather than
 * accepted blindly. Anything unrecognized fails closed.
 */
export function parseZenodoChecksum(value) {
  if (typeof value !== 'string') throw new Error('Zenodo file checksum is missing.')
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(?:(md5|sha256):)?([0-9a-f]+)$/)
  if (!match) throw new Error(`Unrecognized Zenodo checksum format: ${value}.`)
  const algorithm =
    match[1] ??
    (match[2].length === DIGEST_LENGTH.md5
      ? 'md5'
      : match[2].length === DIGEST_LENGTH.sha256
        ? 'sha256'
        : null)
  if (!algorithm) throw new Error(`Unrecognized Zenodo checksum length: ${value}.`)
  if (match[2].length !== DIGEST_LENGTH[algorithm])
    throw new Error(`Zenodo checksum length does not match ${algorithm}: ${value}.`)
  return { algorithm, digest: match[2] }
}

function expectedDigests(expected) {
  const provided = {}
  if (typeof expected === 'string') {
    const { algorithm, digest } = parseZenodoChecksum(expected)
    provided[algorithm] = digest
  } else if (expected && typeof expected === 'object') {
    for (const [algorithm, digest] of Object.entries(expected)) {
      if (digest === undefined || digest === null || digest === '') continue
      if (!(algorithm in DIGEST_LENGTH))
        throw new Error(`Unsupported local checksum algorithm: ${algorithm}.`)
      if (
        typeof digest !== 'string' ||
        !new RegExp(`^[0-9a-f]{${DIGEST_LENGTH[algorithm]}}$`, 'i').test(digest.trim())
      )
        throw new Error(`Invalid local ${algorithm} checksum for verification.`)
      provided[algorithm] = digest.trim().toLowerCase()
    }
  }
  if (Object.keys(provided).length === 0)
    throw new Error('A local checksum is required to verify the Zenodo upload.')
  return provided
}

export function findZenodoFile(record, filename, expected) {
  if (!record || typeof record !== 'object' || !Array.isArray(record.files)) {
    throw new Error('Zenodo record did not contain a files array.')
  }
  const matches = record.files.filter((file) => file?.filename === filename)
  if (matches.length > 1) throw new Error(`Zenodo record contains duplicate file: ${filename}.`)
  if (matches.length === 0) return null
  const file = matches[0]
  const { algorithm, digest } = parseZenodoChecksum(file.checksum)
  const provided = expectedDigests(expected)
  const reference = provided[algorithm]
  if (!reference) {
    throw new Error(
      `Zenodo reported a ${algorithm} checksum for ${filename} but no local ${algorithm} checksum was provided.`,
    )
  }
  if (digest !== reference) {
    throw new Error(
      `Zenodo ${algorithm} checksum mismatch for ${filename}: expected ${reference}, received ${digest}.`,
    )
  }
  return file
}
