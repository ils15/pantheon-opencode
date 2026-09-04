import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function findZenodoFile(record, filename, checksum) {
  if (!record || typeof record !== 'object' || !Array.isArray(record.files)) {
    throw new Error('Zenodo record did not contain a files array.')
  }
  const matches = record.files.filter((file) => file?.filename === filename)
  if (matches.length > 1) throw new Error(`Zenodo record contains duplicate file: ${filename}.`)
  if (matches.length === 0) return null
  const file = matches[0]
  const expected = `sha256:${checksum}`
  if (file.checksum !== expected) {
    throw new Error(`Zenodo checksum mismatch for ${filename}.`)
  }
  return file
}
