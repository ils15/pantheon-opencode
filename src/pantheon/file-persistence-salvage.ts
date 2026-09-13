/**
 * Best-effort salvage of complete top-level JSON objects from a corrupt
 * `state.json`. The file is normally a JSON array; a torn write can leave a
 * truncated tail (or interleaved NUL bytes). We scan for balanced `{…}`
 * objects, parsing each independently, so every intact record survives.
 *
 * Extracted from file-persistence.ts to keep that module within the 300-line
 * ceiling. Exported for tests.
 */
import type { BackgroundJobRecord } from './background-job-board.ts'

export function salvageRecords(content: string): BackgroundJobRecord[] {
  const records: BackgroundJobRecord[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === '}') {
      if (depth > 0) depth--
      if (depth === 0 && start >= 0) {
        const candidate = content.slice(start, i + 1)
        try {
          const parsed: unknown = JSON.parse(candidate)
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as BackgroundJobRecord).taskID === 'string'
          ) {
            records.push(parsed as BackgroundJobRecord)
          }
        } catch {
          // Incomplete/partial object — skip it, keep scanning.
        }
        start = -1
      }
    }
  }

  return records
}
